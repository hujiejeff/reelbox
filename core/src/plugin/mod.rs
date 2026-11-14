//! `.webox.js` 插件的第一步:把 `WeBox.define({...})` 里的元信息读出来。
//!
//! 真正执行 `filters/list/search/detail/play` 这些钩子需要 JS 运行时,
//! 但"这个插件叫什么、走哪个接口、有哪几个分类"这类信息全在 define() 的字面量里,
//! 不需要跑代码就能拿到 —— 先支持"只读清单"的插件。

pub mod adapt;
pub mod net;
pub mod runtime;

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 站点主页,没有就空
    pub api: String,
}

/// 从插件源码里抽 `reelbox.define({...})` 或 `WeBox.define({...})` 的字段
pub fn parse_meta(js: &str) -> Result<PluginMeta, String> {
    // 原生契约优先,其次兼容 WeBox
    const NATIVE: &str = "reelbox.define(";
    const LEGACY: &str = "WeBox.define(";
    let start = match js.find(NATIVE) {
        Some(i) => i,
        None => js
            .find(LEGACY)
            .ok_or_else(|| "找不到 reelbox.define( 或 WeBox.define(".to_string())?,
    };
    let prefix_len = if js[start..].starts_with(NATIVE) {
        NATIVE.len()
    } else {
        LEGACY.len()
    };
    let body = &js[start + prefix_len..];
    let obj_start = body.find('{').ok_or_else(|| "define() 里没有对象".to_string())?;
    let obj = &body[obj_start..];
    let map = parse_object(obj)?;

    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    let id = get("id");
    let name = get("name");
    if name.is_empty() {
        return Err("缺少 name".into());
    }
    Ok(PluginMeta {
        id: if id.is_empty() { name.clone() } else { id },
        name,
        version: get("version"),
        api: get("api"),
    })
}

/// 只解析"顶层键:字符串/数字/布尔"这种浅结构,够读元信息
fn parse_object(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let bytes = text.as_bytes();
    let mut i = 1usize; // 跳过开头的 {
    let mut depth = 1i32;

    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            123 => { depth += 1; i += 1; continue; }
            125 => { depth -= 1; i += 1; continue; }
            44 | 10 | 13 | 32 | 9 => { i += 1; continue; }
            _ => {}
        }
        // 读键:支持 'k': 和 k: 两种写法
        let key = if matches!(bytes[i], 39u8 | 34u8 | 96u8) {
            read_string(bytes, &mut i)?
        } else {
            let s0 = i;
            while i < bytes.len() && (bytes[i] as char).is_ascii_alphanumeric() { i += 1; }
            if i == s0 { i += 1; continue; }
            text[s0..i].to_string()
        };
        skip_ws(bytes, &mut i);
        if i >= bytes.len() || bytes[i] != 58 { continue; }
        i += 1;
        skip_ws(bytes, &mut i);
        if i >= bytes.len() { break; }
        if matches!(bytes[i], 39u8 | 34u8 | 96u8) {
            let v = read_string(bytes, &mut i)?;
            if depth == 1 { out.insert(key, v); }
        } else if matches!(bytes[i], 123u8 | 91u8) {
            // 嵌套对象/数组:整体跳过,不计入顶层
            let mut d = 0i32;
            while i < bytes.len() {
                match bytes[i] {
                    123 | 91 => d += 1,
                    125 | 93 => { d -= 1; if d == 0 { i += 1; break; } }
                    _ => {}
                }
                i += 1;
            }
        } else {
            let s0 = i;
            while i < bytes.len() && !matches!(bytes[i], 44u8 | 125u8 | 10u8) { i += 1; }
            let raw = text[s0..i].trim().to_string();
            if depth == 1 && !raw.is_empty() { out.insert(key, raw); }
        }
    }
    Ok(out)
}

fn skip_ws(bytes: &[u8], i: &mut usize) {
    while *i < bytes.len() && (bytes[*i] as char).is_whitespace() { *i += 1; }
}

fn read_string(bytes: &[u8], i: &mut usize) -> Result<String, String> {
    let quote = bytes[*i];
    *i += 1;
    let mut buf: Vec<u8> = Vec::new();
    while *i < bytes.len() {
        let c = bytes[*i];
        if c == 92 {
            *i += 1;
            if *i < bytes.len() { buf.push(bytes[*i]); *i += 1; }
            continue;
        }
        if c == quote {
            *i += 1;
            return Ok(String::from_utf8_lossy(&buf).to_string());
        }
        buf.push(c);
        *i += 1;
    }
    Err("字符串没有闭合".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
WeBox.define({
  id: 'demo-src',
  name: '示例源',
  version: '1.2.0',
  api: 'https://example.com',
  requires: ['html'],
  cache: true,
  filters: () => [],
});
"#;


    const REAL: &str = r#"
WeBox.define({
  api: "1.1", id: "user.4kvm", name: "4k影视", version: "1.0.0",
  requires: ["html", "compute"],
  cache: { list: 120, detail: 60 },
  async filters(ctx) { return []; }
});
"#;

    #[test]
    fn reads_real_plugin_header() {
        let m = parse_meta(REAL).unwrap();
        assert_eq!(m.id, "user.4kvm");
        assert_eq!(m.name, "4k影视");
        assert_eq!(m.version, "1.0.0");
        assert_eq!(m.api, "1.1");
    }

    #[test]
    fn reads_meta() {
        let m = parse_meta(SAMPLE).unwrap();
        assert_eq!(m.id, "demo-src");
        assert_eq!(m.name, "示例源");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.api, "https://example.com");
    }

    #[test]
    fn falls_back_to_name_as_id() {
        let js = "WeBox.define({ name: \"无名源\", version: '0.1' })";
        let m = parse_meta(js).unwrap();
        assert_eq!(m.id, "无名源");
        assert_eq!(m.version, "0.1");
    }

    #[test]
    fn errors_without_define() {
        assert!(parse_meta("const x = 1;").is_err());
    }

    #[test]
    fn ignores_nested_objects() {
        let js = r#"WeBox.define({ name: '嵌套', settings: { name: 'inner' }, version: '2' })"#;
        let m = parse_meta(js).unwrap();
        assert_eq!(m.name, "嵌套");
        assert_eq!(m.version, "2");
    }
}

/// 从插件文件跑一个钩子:读文件 → 建宿主 → 调用。
/// `fetch` 决定插件里的网络请求怎么做。
pub fn run_file(
    path: &std::path::Path,
    hook: &str,
    arg_json: &str,
    fetch: Box<dyn Fn(&str) -> Option<String>>,
) -> Result<String, String> {
    let src = std::fs::read_to_string(path).map_err(|e| format!("读插件失败: {e}"))?;
    let mut host = runtime::Host::load(&src, fetch)?;
    host.call(hook, arg_json)
}

/// 插件里声明的分类(没有就返回空)
pub fn plugin_filters(
    path: &std::path::Path,
    fetch: Box<dyn Fn(&str) -> Option<String>>,
) -> Vec<crate::model::Filter> {
    let out = match run_file(path, "filters", "{}", fetch) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&out) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for f in arr {
        let key = f.get("key").and_then(|x| x.as_str()).unwrap_or("");
        let label = f.get("label").and_then(|x| x.as_str()).unwrap_or(key);
        if key.is_empty() {
            continue;
        }
        let mut opts = Vec::new();
        if let Some(list) = f.get("options").and_then(|x| x.as_array()) {
            for o in list {
                let value = o.get("value").and_then(|x| x.as_str()).unwrap_or("");
                let lab = o.get("label").and_then(|x| x.as_str()).unwrap_or(value);
                opts.push(crate::model::Option_ {
                    label: lab.to_string(),
                    value: value.to_string(),
                    parent: String::new(),
                });
            }
        }
        out.push(crate::model::Filter {
            key: key.to_string(),
            label: label.to_string(),
            options: opts,
        });
    }
    out
}

#[cfg(test)]
mod file_tests {
    use super::*;

    const DEMO: &str = r#"
WeBox.define({
  id: "demo.local", name: "本地插件源", version: "0.0.1",
  async filters(ctx) {
    return [{ key: "classify", label: "分类", options: [
      { label: "全部", value: "" }, { label: "电影", value: "movie" } ] }];
  },
  async list(ctx) {
    return { list: [
      { id: "a1", title: "插件来的第一条", note: "第 1 集" },
      { id: "a2", title: "插件来的第二条", note: "完结" }
    ], next: "" };
  },
  async play(ctx) { return { url: "https://example.com/x.m3u8" }; }
});
"#;

    fn write_demo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("reelbox-plugin-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("demo.webox.js");
        std::fs::write(&p, DEMO).unwrap();
        p
    }

    #[test]
    fn runs_list_from_file() {
        let p = write_demo();
        let out = run_file(&p, "list", "{}", Box::new(|_| None)).unwrap();
        let page = crate::plugin::adapt::page_from_json(&out).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].title, "插件来的第一条");
        assert_eq!(page.items[1].subtitle, "完结");
    }

    #[test]
    fn runs_filters_from_file() {
        let p = write_demo();
        let fs = plugin_filters(&p, Box::new(|_| None));
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].key, "classify");
        assert_eq!(fs[0].options.len(), 2);
    }

    /// 原生契约样例:reelbox.define + ctx.fail + play 返回多档数组
    const NATIVE_DEMO: &str = r#"reelbox.define({
  id: "test.native",
  name: "原生样例",
  version: "1.0.0",
  api: 1,
  caps: ["http"],
  filters: async function (ctx) {
    return [{ key: "c", label: "分类", options: [{ label: "全部", value: "" }] }];
  },
  list: async function (ctx, args) {
    return { items: [{ id: "n1", title: "原生第一条" }], next: "2" };
  },
  play: async function (ctx, args) {
    if (!args.id) ctx.fail("parse", "缺 id");
    return [
      { quality: "1080P", url: "https://x/1080.m3u8" },
      { quality: "720P", url: "https://x/720.m3u8" }
    ];
  }
});"#;

    fn write_native() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("reelbox-plugin-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("demo.reelbox.js");
        std::fs::write(&p, NATIVE_DEMO).unwrap();
        p
    }


    #[test]
    fn parses_native_reelbox_define() {
        let m = parse_meta(NATIVE_DEMO).unwrap();
        assert_eq!(m.id, "test.native");
        assert_eq!(m.name, "原生样例");
        assert_eq!(m.version, "1.0.0");
    }

    #[test]
    fn native_meta_still_accepts_webox() {
        assert_eq!(parse_meta(DEMO).unwrap().name, "本地插件源");
    }

    #[test]
    fn runs_native_list_from_file() {
        let p = write_native();
        let out = run_file(&p, "list", "{}", Box::new(|_| None)).unwrap();
        let page = crate::plugin::adapt::page_from_json(&out).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].title, "原生第一条");
    }

    #[test]
    fn runs_native_play_returns_array() {
        let p = write_native();
        let out = run_file(&p, "play", r#"{"id":"n1"}"#, Box::new(|_| None)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let arr = v.as_array().expect("play 应返回数组");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["quality"], "1080P");
        assert_eq!(arr[1]["url"], "https://x/720.m3u8");
    }

    #[test]
    fn native_fail_reports_message() {
        let p = write_native();
        let err = run_file(&p, "play", r#"{"id":""}"#, Box::new(|_| None)).unwrap_err();
        assert!(err.contains("缺 id"), "实际: {err}");
    }

    #[test]
    fn runs_play_from_file() {
        let p = write_demo();
        let out = run_file(&p, "play", r#"{"id":"a1"}"#, Box::new(|_| None)).unwrap();
        assert!(out.contains("x.m3u8"), "实际: {out}");
    }
}
