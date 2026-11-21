//! `.webox.js` 插件的第一步:把 `WeBox.define({...})` 里的元信息读出来。
//!
//! 真正执行 `filters/list/search/detail/play` 这些钩子需要 JS 运行时,
//! 但"这个插件叫什么、走哪个接口、有哪几个分类"这类信息全在 define() 的字面量里,
//! 不需要跑代码就能拿到 —— 先支持"只读清单"的插件。

pub mod adapt;
pub mod net;
pub mod runtime;

use std::collections::BTreeMap;

/// 插件类型:普通源插件(列 / 详情 / 播放钩子)
pub const KIND_VOD: &str = "vod";
/// 插件类型:解析器(把分享页变成可播地址,见 docs/PARSERS.md)
pub const KIND_PARSER: &str = "parser";
/// 插件类型:引擎(插件只管"怎么爬",站点在 `Source.options.config` 里,见 docs/ENGINE-PLUGINS.md)。
/// 引擎插件导入时会多问一句配置地址,没配置就不建源。
pub const KIND_ENGINE: &str = "engine";
/// 插件类型:适配器(把一种源格式翻成 `list/detail/play`,见 docs/ARCHITECTURE.md 第 4 节)。
///
/// 内置适配器随包安装(`plugins/builtin/`),用户也能自己写一个导入进来
/// (`plugins/*.adapter.js`)。**适配器不是源**:装的是文件,加源还得要一份配置地址。
pub const KIND_ADAPTER: &str = "adapter";

/// 适配器的入口前缀(`reelbox.adapter({...})`,对象形状与 `reelbox.define` 相同)
const ADAPTER_ENTRY: &str = "reelbox.adapter(";
/// 解析器的入口前缀(`reelbox.parser({...})`)
const PARSER_ENTRY: &str = "reelbox.parser(";
/// 原生源插件的入口前缀
const NATIVE_ENTRY: &str = "reelbox.define(";
/// 老插件(WeBox)的入口前缀,只做兼容
const LEGACY_ENTRY: &str = "WeBox.define(";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 站点主页,没有就空
    pub api: String,
    /// `vod`(源插件)、`parser`(解析器)、`adapter`(适配器)或 `engine`(引擎)
    pub kind: String,
}

/// 从插件源码里抽元信息。纯函数:不碰文件系统,也拿不到文件名。
///
/// 后缀这条判据(`.adapter.js` / `.parser.js`)只认文件名,所以要么用 `parse_meta_hinted` 传进来,
/// 要么由调用方自己再判一次 —— 别把路径塞进这个函数。
pub fn parse_meta(js: &str) -> Result<PluginMeta, String> {
    parse_meta_hinted(js, None)
}

/// 同 `parse_meta`,但允许调用方把文件名(或路径)当提示传进来:
/// `.adapter.js` / `.parser.js` 后缀同样算适配器 / 解析器(见 `detect_kind`)。
pub fn parse_meta_hinted(js: &str, path_hint: Option<&str>) -> Result<PluginMeta, String> {
    // 原生契约优先,其次解析器 / 适配器,最后兼容 WeBox
    let (start, prefix_len) = [NATIVE_ENTRY, PARSER_ENTRY, ADAPTER_ENTRY, LEGACY_ENTRY]
        .iter()
        .filter_map(|p| js.find(p).map(|i| (i, p.len())))
        .min_by_key(|(i, _)| *i)
        // 报错文案只提原生契约:老前缀照认(见 LEGACY_ENTRY),但那是兼容细节,不摆给用户
        .ok_or_else(|| "找不到插件入口 define({...}) 或 adapter({...})".to_string())?;
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
    let kind = detect_kind(js, map.get("kind").map(|s| s.as_str()).unwrap_or(""), path_hint);
    Ok(PluginMeta {
        id: if id.is_empty() { name.clone() } else { id },
        name,
        version: get("version"),
        api: get("api"),
        kind,
    })
}

/// 四条判据,命中任一即适配器 / 解析器;都不命中就是普通源插件(`vod`)。
///   适配器:1. 源码里有 `reelbox.adapter(` 入口;2. 入口对象里写了 `kind: "adapter"`;
///           3. 文件名以 `.adapter.js` 收尾(只有调用方传了 path_hint 才判得到)。
///   解析器:同上三条,换成 `reelbox.parser(` / `"parser"` / `.parser.js`。
/// 源码入口优先于后缀:文件被改了名也不至于认错格式。
fn detect_kind(js: &str, declared: &str, path_hint: Option<&str>) -> String {
    let declared = declared.trim().to_ascii_lowercase();
    if js.contains(ADAPTER_ENTRY) || declared == KIND_ADAPTER {
        return KIND_ADAPTER.to_string();
    }
    if js.contains(PARSER_ENTRY) || declared == KIND_PARSER {
        return KIND_PARSER.to_string();
    }
    if let Some(p) = path_hint {
        let p = p.trim().to_ascii_lowercase();
        if p.ends_with(".adapter.js") {
            return KIND_ADAPTER.to_string();
        }
        if p.ends_with(".parser.js") {
            return KIND_PARSER.to_string();
        }
    }
    if declared.is_empty() {
        KIND_VOD.to_string()
    } else {
        declared
    }
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
            read_string(bytes, &mut i)
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
            let v = read_string(bytes, &mut i);
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

/// 读一个引号字符串。
///
/// 这里是浅扫描器,不分"字符串"和"正则字面量":钩子体里写的
/// `/["']/` 这类正则,其中的引号会被当成字符串开头。所以读到文件尾时
/// 不当错误 —— 元信息(名字、版本、类型)通常写在最前面,已经读到了;
/// 为一个正则把整份插件判成"坏了"才是更糟的结果。
fn read_string(bytes: &[u8], i: &mut usize) -> String {
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
            break;
        }
        buf.push(c);
        *i += 1;
    }
    String::from_utf8_lossy(&buf).to_string()
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

    /// 判据 0:普通源插件默认就是 vod
    #[test]
    fn default_kind_is_vod() {
        assert_eq!(parse_meta(SAMPLE).unwrap().kind, KIND_VOD);
        assert_eq!(parse_meta(REAL).unwrap().kind, KIND_VOD);
        // 显式写 kind: "vod" 也还是 vod
        let js = r#"reelbox.define({ name: "写清楚的源", kind: "vod" })"#;
        assert_eq!(parse_meta(js).unwrap().kind, KIND_VOD);
    }

    /// 判据 1:源码里有 reelbox.parser( 入口
    #[test]
    fn parser_kind_from_entry() {
        let js = r#"
reelbox.parser({
  id: "dytt-share",
  name: "电影天堂分享页",
  version: "1",
  async parse(ctx, { url }) { return { quality: "自动", url: url }; }
});
"#;
        let m = parse_meta(js).unwrap();
        assert_eq!(m.kind, KIND_PARSER);
        assert_eq!(m.id, "dytt-share");
        assert_eq!(m.name, "电影天堂分享页");
        assert_eq!(m.version, "1");
    }

    /// 判据 2:入口对象里写了 kind: "parser"
    #[test]
    fn parser_kind_from_declared_field() {
        let js = r#"reelbox.define({ name: "声明式解析器", kind: "parser" })"#;
        assert_eq!(parse_meta(js).unwrap().kind, KIND_PARSER);
    }

    /// 钩子体里的正则会带引号(`/["']/`),浅扫描器不该因此判整个文件坏掉
    #[test]
    fn regex_with_quotes_does_not_break_meta() {
        let js = r#"reelbox.parser({
  id: "quoted-re",
  name: "带引号正则的解析器",
  version: "2",
  match(url) { return /[^"']/.test(url); }
});"#;
        let m = parse_meta(js).expect("正则里的引号不该让元信息读不出来");
        assert_eq!(m.name, "带引号正则的解析器");
        assert_eq!(m.version, "2");
        assert_eq!(m.kind, KIND_PARSER);
    }

    /// 仓库里那个示例解析器必须真的能被认出来(它是导入后开箱可用的样例)
    #[test]
    fn reads_example_parser_file() {
        let js = include_str!("../../../examples/share.reelbox.parser.js");
        let m = parse_meta(js).expect("示例解析器应能读出元信息");
        assert_eq!(m.kind, KIND_PARSER);
        assert_eq!(m.id, "share-page");
        assert_eq!(m.name, "分享页 m3u8");
        assert_eq!(m.version, "1");
        // 不传后缀提示也得靠源码入口认出来
        assert_eq!(parse_meta_hinted(js, Some("x.js")).unwrap().kind, KIND_PARSER);
    }

    /// 引擎插件:显式写 kind: "engine",元信息要原样带出来(导入流程靠它多问一句配置地址)
    #[test]
    fn engine_kind_from_declared_field() {
        let js = r#"reelbox.define({ id: "iplayr.engine", name: "iplayr 引擎", version: "1", api: 1, kind: "engine", caps: ["http", "html"] });"#;
        let m = parse_meta(js).expect("引擎插件元信息");
        assert_eq!(m.kind, KIND_ENGINE);
        assert_eq!(m.name, "iplayr 引擎");
        // 文件名是普通插件后缀,不影响 kind
        assert_eq!(
            parse_meta_hinted(js, Some("iplayr-engine.reelbox.js")).unwrap().kind,
            KIND_ENGINE
        );
    }

    /// 适配器:入口是 `reelbox.adapter({...})`,形状与 define 相同,只是 kind 记成 adapter
    #[test]
    fn adapter_kind_from_entry() {
        let js = r#"
reelbox.adapter({
  id: "my-adapter",
  name: "我的适配器",
  version: "1",
  accepts: { kind: "json", has: ["category", "vod_node"] },
  async list(ctx, { config, page }) { return { items: [], next: "" }; },
  async detail(ctx, { config, id }) { return { title: id, groups: [] }; },
  async play(ctx, { config, id }) { return { url: "https://example.com/x.m3u8" }; }
});
"#;
        let m = parse_meta(js).unwrap();
        assert_eq!(m.kind, KIND_ADAPTER);
        assert_eq!(m.id, "my-adapter");
        assert_eq!(m.name, "我的适配器");
        assert_eq!(m.version, "1");
        // 文件名随便:源码入口已经说明它是适配器
        assert_eq!(parse_meta_hinted(js, Some("x.js")).unwrap().kind, KIND_ADAPTER);
    }

    /// 判据 4:文件名 `.adapter.js` —— 只有调用方传了 hint 才判得到
    #[test]
    fn adapter_kind_from_file_suffix_hint() {
        let js = r#"reelbox.define({ id: "by-suffix", name: "只靠文件名的适配器" })"#;
        // 没传 hint:源码里是 define,算普通源插件
        assert_eq!(parse_meta(js).unwrap().kind, KIND_VOD);
        // 传了后缀:文件名说了算
        let m = parse_meta_hinted(js, Some("by-suffix.adapter.js")).unwrap();
        assert_eq!(m.kind, KIND_ADAPTER);
        // 别的后缀不受影响(解析器 / 普通插件各归各)
        assert_eq!(parse_meta_hinted(js, Some("x.reelbox.js")).unwrap().kind, KIND_VOD);
        assert_eq!(
            parse_meta_hinted(js, Some("x.reelbox.parser.js")).unwrap().kind,
            KIND_PARSER
        );
    }

    /// 入口对象里写 `kind: "adapter"` 也认(和 parser / engine 同一套写法)
    #[test]
    fn adapter_kind_from_declared_field() {
        let js = r#"reelbox.define({ id: "declared", name: "声明式适配器", kind: "adapter" })"#;
        let m = parse_meta(js).unwrap();
        assert_eq!(m.kind, KIND_ADAPTER);
        assert_eq!(m.name, "声明式适配器");
    }

    /// 仓库里的示例引擎插件必须真能被认出来,不然导入时会当成普通插件
    #[test]
    fn reads_example_engine_file() {
        let js = include_str!("../../../examples/iplayr.reelbox.js");
        let m = parse_meta(js).expect("示例引擎插件应能读出元信息");
        assert_eq!(m.kind, KIND_ENGINE);
        assert_eq!(m.id, "iplayr.engine");
        assert_eq!(m.name, "iplayr 引擎");
    }

    /// 判据 3:文件名 `.parser.js` —— 只有调用方传了 hint 才判得到
    #[test]
    fn parser_kind_from_file_suffix_hint() {
        let js = r#"reelbox.define({ id: "no-entry-hint", name: "只靠文件名的解析器" })"#;
        // 没传 hint:纯函数只认源码,是 vod
        assert_eq!(parse_meta(js).unwrap().kind, KIND_VOD);
        // 传了 hint:后缀说了算
        let m = parse_meta_hinted(js, Some("share.reelbox.parser.js")).unwrap();
        assert_eq!(m.kind, KIND_PARSER);
        // 普通插件后缀不受影响
        let m = parse_meta_hinted(js, Some("demo.reelbox.js")).unwrap();
        assert_eq!(m.kind, KIND_VOD);
        // 解析器入口 + 普通后缀:源码那条判据照样命中
        let m = parse_meta_hinted(
            r#"reelbox.parser({ name: "入口即解析器" })"#,
            Some("x.reelbox.js"),
        )
        .unwrap();
        assert_eq!(m.kind, KIND_PARSER);
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

/// 插件里声明的分类(没有就返回空)。不带任何参数:普通插件的分类写死在代码里。
pub fn plugin_filters(
    path: &std::path::Path,
    fetch: Box<dyn Fn(&str) -> Option<String>>,
) -> Vec<crate::model::Filter> {
    plugin_filters_with(path, "{}", fetch)
}

/// 同上,但把 `options` 之类的参数喂进去:引擎类插件(iplayr)的分类来自站点配置,
/// 不给它 `{"options":{"config":"…"}}` 它一个分类也说不出来。
pub fn plugin_filters_with(
    path: &std::path::Path,
    arg_json: &str,
    fetch: Box<dyn Fn(&str) -> Option<String>>,
) -> Vec<crate::model::Filter> {
    let out = match run_file(path, "filters", arg_json, fetch) {
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

    /// 每个测试用独立文件:多个测试并发写同一个文件名时,读到的可能是刚被截断的空文件
    fn write_temp(tag: &str, body: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join("reelbox-plugin-test");
        std::fs::create_dir_all(&dir).unwrap();
        let id = N.fetch_add(1, Ordering::Relaxed);
        let p = dir.join(format!("{tag}-{}-{id}.js", std::process::id()));
        std::fs::write(&p, body).unwrap();
        p
    }

    fn write_demo() -> std::path::PathBuf {
        write_temp("demo.webox", DEMO)
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
        write_temp("demo.reelbox", NATIVE_DEMO)
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
