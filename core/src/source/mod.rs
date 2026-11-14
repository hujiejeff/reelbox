//! 源:把站点翻译成 model。现在只有声明式的苹果 CMS(vod / xml)。

pub mod cms;

pub use cms::Client;

use serde::{Deserialize, Serialize};

/// 一条源的定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// vod | xml
    #[serde(default, rename = "type")]
    pub kind: String,
    pub url: String,
}

impl Source {
    /// 归一化类型名。
    pub fn format(&self) -> &str {
        if !self.kind.is_empty() {
            return &self.kind;
        }
        // 手动加的源通常没填类型,地址能看出来就按地址判
        let u = self.url.to_lowercase();
        if u.contains("/at/xml") || u.contains("ac=xml") || u.ends_with(".xml") {
            "xml"
        } else {
            "vod"
        }
    }
}

/// 这个"源"其实是 HTML 爬取配置,不是接口地址吗?
///
/// iplayr 那类索引把爬虫配置也写成了 `{"type":"json","url":"...iplayr/xx.json"}`。
/// 拿它当 vod 接口去取列表,只会把配置 JSON 本身当成响应体 → 界面空屏。
/// 判据:不是 xml/插件、且是 http(s) 的 `.json` 文件,或落在 raw.githubusercontent.com 上。
/// `kind` 传归一化后的类型(`Source::format()` 的结果)。
pub fn is_crawl_config(kind: &str, url: &str) -> bool {
    if kind == "xml" || kind == "webox" {
        return false;
    }
    let u = url.trim().to_ascii_lowercase();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return false;
    }
    let host = u
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(|c| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    if host.contains("raw.githubusercontent.com") {
        return true;
    }
    // 去掉查询串再看后缀:接口地址通常是 /api.php/provide/vod,不会以 .json 收尾
    u.split(|c| c == '?' || c == '#')
        .next()
        .unwrap_or("")
        .ends_with(".json")
}

/// 首次启动时的源;之后以配置文件为准。
pub fn defaults() -> Vec<Source> {
    vec![
        Source {
            id: "dytt".into(),
            name: "电影天堂".into(),
            kind: "vod".into(),
            url: "https://caiji.dyttzyapi.com/api.php/provide/vod".into(),
        },
        Source {
            id: "lzzy".into(),
            name: "量子资源".into(),
            kind: "xml".into(),
            url: "https://cj.lziapi.com/api.php/provide/vod/at/xml".into(),
        },
        Source {
            id: "ffzy".into(),
            name: "非凡资源".into(),
            kind: "vod".into(),
            url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::is_crawl_config;

    #[test]
    fn skips_iplayr_crawl_configs() {
        assert!(is_crawl_config(
            "vod",
            "https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json"
        ));
        assert!(is_crawl_config("vod", "https://raw.githubusercontent.com/a/b/crawl"));
        assert!(is_crawl_config("vod", "https://example.com/crawl.json"));
        assert!(is_crawl_config("vod", "https://example.com/crawl.json?raw=1"));
    }

    #[test]
    fn keeps_real_api_sources() {
        assert!(!is_crawl_config("vod", "https://caiji.dyttzyapi.com/api.php/provide/vod"));
        assert!(!is_crawl_config("vod", "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8"));
        assert!(!is_crawl_config("vod", "https://api.wsyzy.net/api.php/provide/vod"));
        assert!(!is_crawl_config("xml", "https://cj.lziapi.com/api.php/provide/vod/at/xml"));
        assert!(!is_crawl_config("xml", "https://example.com/feed.xml"));
        assert!(!is_crawl_config("webox", "https://example.com/p.json"));
        assert!(!is_crawl_config("vod", "C:/Users/x/AppData/Roaming/reelbox/plugins/demo.webox.js"));
    }
}
