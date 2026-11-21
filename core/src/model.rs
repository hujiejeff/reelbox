//! 各端共用的数据形状。界面只认这些类型,源负责把站点翻译成它们。

use serde::{Deserialize, Serialize};

/// 列表页的一条。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: String, // movie | series | unknown
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub subtitle: String,
}

/// 一页条目;next 为空表示没有下一页。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Page {
    pub items: Vec<Item>,
    #[serde(rename = "nextCursor", default)]
    pub next: String,
}

/// 一个可播放的条目。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub name: String,
}

/// 一条播放线路。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub episodes: Vec<Episode>,
}

/// 一部作品的详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Detail {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub summary: String,
    pub groups: Vec<Group>,
}

/// 最终交给播放器的地址。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StreamOption {
    pub quality: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stream {
    pub url: String,
    pub mime: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// 多清晰度:`url` 是默认档,这里放全部可选档(含默认)
    #[serde(default)]
    pub options: Vec<StreamOption>,
    /// `url` 只是张网页(分享页 HTML),里面没有能直接播的地址。
    /// 老数据/老路径没有这个字段 → 反序列化成 false,播放链路一行不变。
    /// 现在没有谁能接手解析它:播放链路据此明确报「只给了解析页」。
    #[serde(default)]
    pub page: bool,
}

/// 筛选项的一个取值;parent 非空表示它是某个一级分类下的二级分类。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Option_ {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub parent: String,
}

/// 一组筛选条件。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Filter {
    pub key: String,
    pub label: String,
    pub options: Vec<Option_>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `page` 是后加的字段:老的 Stream(没有它)反序列化必须是 false,
    /// 否则播放链路会把普通地址当成"解析页"。
    #[test]
    fn stream_page_defaults_to_false() {
        let old = r#"{"url":"https://a/b.m3u8","mime":"application/vnd.apple.mpegurl"}"#;
        let st: Stream = serde_json::from_str(old).expect("老数据应能读");
        assert!(!st.page);
        assert_eq!(st.url, "https://a/b.m3u8");
        assert!(st.headers.is_empty());
        assert!(st.options.is_empty());

        let page: Stream = serde_json::from_str(
            r#"{"url":"https://a/share","mime":"text/html","page":true}"#,
        )
        .expect("解析页应能读");
        assert!(page.page);

        // 序列化时带上(前端只看 page === true)
        let text = serde_json::to_string(&page).expect("序列化失败");
        assert!(text.contains("\"page\":true"), "实际: {text}");
    }
}
