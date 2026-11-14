//! 源:把站点翻译成 model。现在只有声明式的苹果 CMS(vod / xml)。

pub mod cms;

pub use cms::Client;

use serde::{Deserialize, Serialize};

/// 一条源的定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// vod | xml | live | webox
    #[serde(default, rename = "type")]
    pub kind: String,
    pub url: String,
    /// 最近一次「测试连接」的结果;None = 从没测过(界面上是空心圆)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<Health>,
}

/// 一次健康检查。(`ms` 是这次探测的耗时:列表接口的首字节到读完;
/// 插件源是读文件 + 解析元信息;直播源是取 m3u 头部。)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub ms: u64,
    /// UTC ISO8601,秒精度
    pub checked_at: String,
    /// 失败原因 / 备注;成功时为空
    #[serde(default)]
    pub note: String,
}

/// 当前时间的 UTC ISO8601(`2026-11-14T13:45:07Z`)。
/// 只为了写进 health.checked_at,不值得引 chrono。
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days:1970-01-01 起的天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
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
            health: None,
        },
        Source {
            id: "lzzy".into(),
            name: "量子资源".into(),
            kind: "xml".into(),
            url: "https://cj.lziapi.com/api.php/provide/vod/at/xml".into(),
            health: None,
        },
        Source {
            id: "ffzy".into(),
            name: "非凡资源".into(),
            kind: "vod".into(),
            url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8".into(),
            health: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, is_crawl_config, now_iso, Health, Source};

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

    #[test]
    fn civil_dates_match_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29)); // 闰日
        assert_eq!(civil_from_days(20_454), (2026, 1, 1));
    }

    #[test]
    fn now_iso_is_utc_iso8601() {
        let s = now_iso();
        assert_eq!(s.len(), 20, "长度应为 2026-11-14T13:45:07Z: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
        let year: i32 = s[..4].parse().expect("年份");
        assert!(year >= 2024, "年份不合理: {s}");
    }

    #[test]
    fn health_round_trips_and_older_files_still_load() {
        // 有 health 的源
        let src: Source = serde_json::from_str(
            r#"{"id":"a","name":"A","type":"xml","url":"https://x/y","health":{"ok":true,"ms":320,"checked_at":"2026-11-14T13:45:07Z","note":""}}"#,
        )
        .expect("解析失败");
        assert_eq!(src.format(), "xml");
        assert!(src.health.as_ref().map(|h| h.ok).unwrap_or(false));
        assert_eq!(src.health.as_ref().map(|h| h.ms).unwrap_or(0), 320);

        // 老配置文件没有 health 字段:照样能读,health = None
        let old: Source =
            serde_json::from_str(r#"{"id":"b","name":"B","type":"vod","url":"https://x/z"}"#)
                .expect("老配置解析失败");
        assert!(old.health.is_none());

        // 从没测过时不写这个字段,免得配置文件里多一堆 null
        let text = serde_json::to_string(&old).expect("序列化失败");
        assert!(!text.contains("health"), "不该序列化 None: {text}");

        // 失败的探测带得上原因
        let bad = Health { ok: false, ms: 5001, checked_at: now_iso(), note: "超时".into() };
        let text = serde_json::to_string(&bad).expect("序列化失败");
        assert!(text.contains("\"ok\":false"));
        assert!(text.contains("超时"));
    }
}
