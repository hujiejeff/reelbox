//! `.webox.js` 插件的第一步:把 `WeBox.define({...})` 里的元信息读出来。
//!
//! 真正执行 `filters/list/search/detail/play` 这些钩子需要 JS 运行时,
//! 但"这个插件叫什么、走哪个接口、有哪几个分类"这类信息全在 define() 的字面量里,
//! 不需要跑代码就能拿到 —— 先支持"只读清单"的插件。

pub mod adapt;
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

/// 从插件源码里抽 `WeBox.define({...})` 的字段
pub fn parse_meta(js: &str) -> Result<PluginMeta, String> {
    let start = js
        .find("WeBox.define(")
        .ok_or_else(|| "找不到 WeBox.define(".to_string())?;
    let body = &js[start + "WeBox.define(".len()..];
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
