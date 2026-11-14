//! 把插件钩子返回的 JSON 映射成我们的模型。
//!
//! 插件五花八门,这里只认最常见的字段名,并且做兜底。

use crate::model::{Item, Page};

fn pick<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s);
            }
        }
        if let Some(n) = v.get(*k).and_then(|x| x.as_i64()) {
            return Some(Box::leak(n.to_string().into_boxed_str()));
        }
    }
    None
}

/// 把 HTML 实体里最常见的两种还原
fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&#38;", "&")
}

/// 插件返回的列表:`{ list: [...] }`(WeBox)、`{ items: [...] }`(原生) 或直接数组
pub fn page_from_json(text: &str) -> Result<Page, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("不是 JSON: {e}"))?;
    let arr = if let Some(a) = v.as_array() {
        a.clone()
    } else if let Some(a) = ["list", "items", "data", "result"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_array()))
    {
        a.clone()
    } else {
        return Err("没有 list/items 数组".into());
    };

    let mut items = Vec::new();
    for it in arr.iter() {
        let title = pick(it, &["title", "name", "vod_name"]).unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let id = pick(it, &["id", "vod_id", "url", "link"]).unwrap_or(&title).to_string();
        items.push(Item {
            id,
            title,
            kind: pick(it, &["kind", "type", "vod_type"]).unwrap_or("").to_string(),
            poster: unescape(pick(it, &["poster", "pic", "cover", "vod_pic"]).unwrap_or("")),
            subtitle: pick(it, &["note", "subtitle", "remarks", "vod_remarks"]).unwrap_or("").to_string(),
        });
    }

    let next = ["next", "nextCursor", "cursor"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();
    Ok(Page { items, next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_common_list_shape() {
        let json = r#"{"list":[
            {"id":"1","title":"片子 A","pic":"http://p/1.jpg","note":"更新至 3 集"},
            {"title":"片子 B"}
        ]}"#;
        let page = page_from_json(json).unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].title, "片子 A");
        assert_eq!(page.items[0].poster, "http://p/1.jpg");
        assert_eq!(page.items[0].subtitle, "更新至 3 集");
        assert_eq!(page.items[1].id, "片子 B"); // 没 id 时退回标题
    }

    #[test]
    fn reads_plain_array() {
        let page = page_from_json(r#"[{"name":"X","vod_pic":"p.jpg"}]"#).unwrap();
        assert_eq!(page.items[0].title, "X");
        assert_eq!(page.items[0].poster, "p.jpg");
    }

    #[test]
    fn errors_on_garbage() {
        assert!(page_from_json("not json").is_err());
        assert!(page_from_json(r#"{"foo":1}"#).is_err());
    }
}
