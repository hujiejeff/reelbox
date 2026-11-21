//! 源:把站点翻译成 model。
//!
//! 苹果 CMS(vod / xml)的运行时默认走随包的 JS 适配器(`examples/vod.reelbox.js`,
//! `adapter="vod"`);这里留下的 [`cms`] 是同一套逻辑的 Rust 实现,由 `adapter="vod-rs"`
//! 选中,只作回滚路径(见 `docs/ARCHITECTURE.md` P3)。

pub mod cms;

pub use cms::Client;

use serde::{Deserialize, Serialize};

/// 一条源的定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// vod | xml | live | webox
    ///
    /// **界面仍在用这个字段**(下拉里的徽标、源页的分段都按它判),所以它留着;
    /// 运行时走哪条路由 `adapter`,见 [架构](../docs/ARCHITECTURE.md)。
    #[serde(default, rename = "type")]
    pub kind: String,
    pub url: String,
    /// 用哪个适配器解析:`vod` | `vod-rs` | `iplayr` | `webox` | `reelbox`。
    ///
    /// `vod` 是随包安装的 JS 适配器(P3 从 Rust 迁过去的);`vod-rs` 是同一套逻辑的
    /// **Rust 实现**,只留作回滚 —— 两者输出应当逐字段一致(见 `docs/ARCHITECTURE.md` P3)。
    ///
    /// 导入时探测决定、落盘后运行时不改(见 `docs/ARCHITECTURE.md` 第 2 节)。
    /// 老配置没有这个字段:读到空串时用 [`Source::adapter`] 现推一个、由
    /// `load_sources` 落盘一次;空串不写进文件,免得污染没迁移过的老数据。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub adapter: String,
    /// 当初判定这个源能用的证据(导入探测时写入,P2 才有写入方)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<Probe>,
    /// 插件自己声明的版本号(普通源为空)。
    /// 空的时候不写进配置文件,老配置读进来也不受影响。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub version: String,
    /// 引擎插件要的站点配置(见 docs/ENGINE-PLUGINS.md):同一份插件 + 不同配置
    /// = 不同站点。空对象 / Null 都算「没有配置」,不落盘;老配置读进来是 Null。
    #[serde(default, skip_serializing_if = "options_is_empty")]
    pub options: serde_json::Value,
    /// 这个源要先让用户人工过校验(Cloudflare / 登录)。开起来以后,运行时
    /// 第一次取数据会自动弹校验页,拿到会话再继续(见 docs/ARCHITECTURE.md 4.1)。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub verify: bool,
    /// 校验页要打开的站点地址。iplayr 这类源的 `url` 是**配置地址**,
    /// 推不出站点域名,所以留一个字段显式指定;空着就按 `url` 的 origin 走。
    /// 落盘用 camelCase:前端只认 `verifyUrl`(和它的其它字段同名习惯一致)。
    #[serde(default, rename = "verifyUrl", skip_serializing_if = "String::is_empty")]
    pub verify_url: String,
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

/// 「导入时探测」留下来的证据:当初凭什么判定这个源能用。
///
/// 和 [`Health`] 不是一回事:`health` 是界面上的「测试连接」(可以反复测、只看当前),
/// `probe` 是**判定适配器时的那一次**证据,落盘后基本不动 —— 判定错了只能重新探测,
/// 不会自己变(见 `docs/ARCHITECTURE.md` 第 2 节)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Probe {
    /// UTC ISO8601,判定发生的时刻
    pub at: String,
    /// 那次判定成功了吗(`items == 0` 不算成功)
    pub ok: bool,
    /// 首次探测出的条目数
    pub items: u32,
    /// 首条标题,截断到 60 字:给用户一眼看出「抓的是不是这个站」
    pub sample: String,
    /// 失败时的错误摘要(四类码 `network` / `parse` / `auth` / `unsupported` + 一句话)
    #[serde(default)]
    pub error: String,
}

/// 源的 id:地址的 32 位短哈希(FNV-1a,8 位十六进制)。
///
/// id 只跟地址有关,和名字无关 —— 中文名不会再被压成一串 `-`(见
/// `docs/REVIEW-2026-11-14.md` A1)。和 `ui/app.js` 的 `shortHash` 是同一个算法
/// (按 UTF-16 码元算),所以两边算出来一样,迁移可以反复跑。
pub fn id_for_url(url: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for unit in url.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
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

    /// 运行时用哪个适配器(`vod` / `vod-rs` / `iplayr` / `webox` / `reelbox`)。
    ///
    /// 落过盘的源直接用自己的 `adapter` —— 判定只做一次,不每次加载重新猜;
    /// 老数据(没这个字段)现推一个,好让运行时不必关心迁移有没有跑过。
    pub fn adapter(&self) -> &str {
        if !self.adapter.is_empty() {
            return &self.adapter;
        }
        derive_adapter(&self.kind, &self.url)
    }
}

/// 老数据没有 `adapter` 时,按 `type` / 地址推断一个;推断不出来给 `"reelbox"`。
///
/// 顺序即优先级。返回 `&'static str` 是刻意的:适配器名是有限的几个,
/// 不需要为每条源各存一份字符串。规则见 `docs/ARCHITECTURE.md` 第 2 节。
pub fn derive_adapter(kind: &str, url: &str) -> &'static str {
    let k = kind.trim().to_ascii_lowercase();
    let u = url.trim().to_ascii_lowercase();
    // 去掉查询串 / 片段再看文件后缀:接口地址不会以 `.json` 收尾,
    // 而 iplayr 的规则文件会(iplayr 索引里那些 `crawl.json?raw=1` 也算)。
    let bare = u.split(|c| c == '?' || c == '#').next().unwrap_or("");
    match k.as_str() {
        // 现有插件源都还是 `type=webox` 的老写法
        "webox" => {
            if bare.ends_with(".reelbox.js") {
                // 新格式:入口是 reelbox.define
                "reelbox"
            } else {
                // `.webox.js` 与没有后缀区分的老文件,都走 WeBox 那套入口。
                // 两者运行时是同一个沙箱,但**名字要如实**:否则数据里看不出这插件
                // 到底是哪种格式,排查时得靠读文件。
                "webox"
            }
        }
        "xml" => "vod",
        "vod" => {
            if u.contains("api.php") || u.contains("ac=list") || u.contains("ac=detail") {
                "vod"
            } else if bare.ends_with(".json") {
                // 苹果 CMS 的外壳、iplayr 的 XPath 规则:拿它当接口只会把配置本身当响应体
                "iplayr"
            } else {
                // 判不出来:按插件试(插件路径认不出来时本来就是这个下场,
                // 报错文案也比走 CMS 的空响应好懂)
                "reelbox"
            }
        }
        // `type` 一个字都没有(很早的数据 / 手改过):只能按地址判 ——
        // 这类源今天就是靠地址走通的(`Source::format()` 同一个口径),
        // 直接给 reelbox 会把它们一次性迁坏,而迁移只做一次、写下去就不再改
        "" => derive_adapter_from_url(&u, bare),
        _ => "reelbox",
    }
}

/// 没有 `type` 可用时,只看地址:和 `Source::format()` 认得出的一样多。
fn derive_adapter_from_url(u: &str, bare: &str) -> &'static str {
    if u.contains("api.php")
        || u.contains("ac=list")
        || u.contains("ac=detail")
        || u.contains("/at/xml")
        || u.contains("ac=xml")
        || bare.ends_with(".xml")
    {
        "vod"
    } else if bare.ends_with(".json") {
        "iplayr"
    } else {
        "reelbox"
    }
}

/// 迁移:给没有 `adapter` 的源补上(见 `docs/ARCHITECTURE.md` P1)。
///
/// 只碰空的那个字段 —— `type` 一个字都不动(界面还在用它)。返回补了几条:
/// `0` 说明这条数据已经迁移过,调用方不必再写文件(`load_sources` 靠这个保持幂等)。
pub fn fill_adapters(list: &mut [Source]) -> usize {
    let mut filled = 0;
    for src in list.iter_mut() {
        if src.adapter.is_empty() {
            src.adapter = derive_adapter(&src.kind, &src.url).to_string();
            filled += 1;
        } else if src.adapter == "reelbox"
            && src.kind.eq_ignore_ascii_case("webox")
            && src.url.to_ascii_lowercase().split(|c| c == '?' || c == '#').next().unwrap_or("").ends_with(".webox.js")
        {
            // 早期迁移把 `.webox.js` 一律写成了 reelbox(那时两者还没分开)。
            // 这里只纠正这一种明确的情况,别的 adapter 一律不碰。
            src.adapter = "webox".to_string();
            filled += 1;
        }
    }
    filled
}

/// `options` 算不算「没有配置」:Null(老配置 / 没填)和空对象都算。
fn options_is_empty(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::Object(map) => map.is_empty(),
        _ => false,
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

// 这里刻意没有 `defaults()`:**默认不带任何内置源**。`sources.json` 不存在时
// `load_sources`(src-tauri)返回空列表,首次启动由用户自己「导入源 / 批量导入」。
// 不留一个返回空 vec 的同名函数 —— 那种"看起来还有默认值"的死代码比没有更糟。

#[cfg(test)]
mod tests {
    use super::{
        civil_from_days, derive_adapter, id_for_url, is_crawl_config, now_iso, Health, Probe, Source,
    };

    #[test]
    fn source_id_depends_on_url_not_name() {
        let a = id_for_url("https://example.com/api.php/provide/vod");
        assert_eq!(a.len(), 8, "8 位十六进制: {a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "只该有十六进制: {a}");
        // 同一地址永远同一个 id(迁移幂等的前提)
        assert_eq!(a, id_for_url("https://example.com/api.php/provide/vod"));
        // 不同地址不同 id
        assert_ne!(a, id_for_url("https://example.com/other"));
        // 中文名不再参与:两个中文名源的 id 各自独立,不会塌成 "-3"
        let dbk = id_for_url("https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json");
        let cz = id_for_url("https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/cz.json");
        assert_ne!(dbk, cz);
        assert!(!dbk.starts_with('-'), "不该是名字塌出来的样子: {dbk}");
    }

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

    /// `options` 是引擎插件加的字段:老配置没有它要能读,没有配置时不落盘,
    /// 有配置时原样存回去(界面把整条 Source 交回后端)。
    #[test]
    fn source_options_round_trip() {
        let old: Source = serde_json::from_str(
            r#"{"id":"e1","name":"引擎源","type":"webox","url":"D:/x/iplayr.reelbox.js"}"#,
        )
        .expect("老配置解析失败");
        assert!(old.options.is_null());
        let text = serde_json::to_string(&old).expect("序列化失败");
        assert!(!text.contains("options"), "没有配置时不该落盘: {text}");

        // 空对象同样算「没有配置」
        let empty: Source = serde_json::from_str(
            r#"{"id":"e2","name":"E","type":"webox","url":"D:/x.js","options":{}}"#,
        )
        .expect("空 options 解析失败");
        assert!(!serde_json::to_string(&empty).unwrap().contains("options"));

        // 有配置:存回去还是同一份
        let with: Source = serde_json::from_str(
            r#"{"id":"e3","name":"E","type":"webox","url":"D:/x.js","options":{"config":"https://a/b.json"}}"#,
        )
        .expect("options 解析失败");
        assert_eq!(
            with.options.get("config").and_then(|v| v.as_str()),
            Some("https://a/b.json")
        );
        let text = serde_json::to_string(&with).unwrap();
        assert!(text.contains(r#""options":{"config":"https://a/b.json"}"#), "实际: {text}");
    }

    /// 老数据没有 `adapter`:按 type / 地址推断,顺序即优先级
    #[test]
    fn derives_adapter_from_type_and_url() {
        // 苹果 CMS 的 JSON 接口
        assert_eq!(derive_adapter("vod", "https://caiji.dyttzyapi.com/api.php/provide/vod"), "vod");
        assert_eq!(derive_adapter("vod", "https://cj.ffzyapi.com/api.php?ac=list"), "vod");
        assert_eq!(derive_adapter("vod", "https://x.com/api.php/provide/vod?ac=detail"), "vod");
        // XML 变体:老配置是 type=xml,新写法常常只是地址带 /at/xml
        assert_eq!(derive_adapter("xml", "https://cj.lziapi.com/api.php/provide/vod/at/xml"), "vod");
        assert_eq!(derive_adapter("xml", "https://example.com/feed.xml"), "vod");
        // `type` 一个字都没有:只能按地址判(和 Source::format() 同一个口径),
        // 否则这些源会被一次性迁成插件
        assert_eq!(derive_adapter("", "https://cj.lziapi.com/api.php/provide/vod/at/xml"), "vod");
        assert_eq!(derive_adapter("", "https://example.com/feed.xml"), "vod");
        // iplayr:接口外壳里的 `.json` 规则文件(查询串不算后缀)
        assert_eq!(
            derive_adapter("vod", "https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json"),
            "iplayr"
        );
        assert_eq!(derive_adapter("vod", "https://example.com/crawl.json?raw=1"), "iplayr");
        assert_eq!(derive_adapter("", "https://example.com/crawl.json#top"), "iplayr");
        // 现有插件源都是 type=webox
        assert_eq!(
            derive_adapter("webox", "C:/Users/x/AppData/Roaming/reelbox/plugins/4k.webox.js"),
            "webox"
        );
        // 老插件没有后缀区分:仍按 WeBox 入口,但名字就是 webox
        assert_eq!(derive_adapter("webox", "D:/x/legacy.js"), "webox");
        assert_eq!(derive_adapter("webox", "D:/x/iplayr.reelbox.js"), "reelbox");
        // 大小写不该影响判断
        assert_eq!(derive_adapter("XML", "https://X.com/API.PHP/provide/vod"), "vod");
        // 认不出来:给 reelbox
        assert_eq!(derive_adapter("", ""), "reelbox");
        assert_eq!(derive_adapter("", "https://example.com/list"), "reelbox");
        assert_eq!(derive_adapter("vod", "https://example.com/list"), "reelbox");
        assert_eq!(derive_adapter("live", "https://example.com/a.m3u8"), "reelbox");
        // 地址说了,`type` 说了别的:先听 `type`(顺序即优先级)
        assert_eq!(derive_adapter("xml", "https://example.com/crawl.json"), "vod");
    }

    /// 迁移只补空的 `adapter`;已经有值的一个字都不改(判定一旦落盘就不再变)
    #[test]
    fn adapter_uses_stored_value_before_derivation() {
        let stored = Source {
            kind: "webox".into(),
            url: "D:/x/4k.webox.js".into(),
            adapter: "reelbox".into(),
            ..Default::default()
        };
        assert_eq!(stored.adapter(), "reelbox");

        // 存着的值和推断结果不同:以存着的为准
        let mut odd = Source {
            kind: "xml".into(),
            url: "https://x/api.php/provide/vod/at/xml".into(),
            ..Default::default()
        };
        assert_eq!(odd.adapter(), "vod", "没填时按 type / 地址推");
        odd.adapter = "iplayr".into();
        assert_eq!(odd.adapter(), "iplayr", "有值时必须用它");

        // 老配置(没有 adapter)现推一个,推出来和迁移写进去的一致
        let old: Source = serde_json::from_str(
            r#"{"id":"a","name":"A","type":"webox","url":"D:/x/4k.webox.js"}"#,
        )
        .expect("老配置解析失败");
        assert!(old.adapter.is_empty());
        assert_eq!(old.adapter(), derive_adapter(&old.kind, &old.url));
    }

    /// `adapter` / `probe` 没值时不该落盘:不然老文件被无端改写一遍
    #[test]
    fn adapter_and_probe_round_trip() {
        let bare = Source {
            id: "a".into(),
            name: "A".into(),
            kind: "vod".into(),
            url: "https://x/api.php/provide/vod".into(),
            ..Default::default()
        };
        let text = serde_json::to_string(&bare).expect("序列化失败");
        assert!(!text.contains("adapter"), "空适配器不该落盘: {text}");
        assert!(!text.contains("probe"), "没探测过不该落盘: {text}");

        let with = Source {
            id: "b".into(),
            name: "独播库".into(),
            kind: "webox".into(),
            url: "D:/x/iplayr.reelbox.js".into(),
            adapter: "iplayr".into(),
            probe: Some(Probe {
                at: "2026-11-21T07:30:00Z".into(),
                ok: true,
                items: 48,
                sample: "极限逃生".into(),
                error: String::new(),
            }),
            options: serde_json::json!({ "config": "https://a/dbk.json" }),
            ..Default::default()
        };
        let text = serde_json::to_string(&with).expect("序列化失败");
        assert!(text.contains(r#""adapter":"iplayr""#), "实际: {text}");
        assert!(text.contains(r#""items":48"#), "实际: {text}");
        assert!(text.contains("极限逃生"), "实际: {text}");

        let back: Source = serde_json::from_str(&text).expect("往返解析失败");
        assert_eq!(back.adapter, "iplayr");
        assert_eq!(back.adapter(), "iplayr");
        let probe = back.probe.expect("probe 丢了");
        assert!(probe.ok);
        assert_eq!(probe.items, 48);
        assert_eq!(probe.sample, "极限逃生");
        assert_eq!(probe.at, "2026-11-21T07:30:00Z");
        // `type` 还在,界面照旧能用
        assert_eq!(back.kind, "webox");

        // 失败的探测带得上错误摘要
        let bad = Probe {
            at: now_iso(),
            ok: false,
            items: 0,
            sample: String::new(),
            error: "network: 超时".into(),
        };
        let text = serde_json::to_string(&bad).expect("序列化失败");
        assert!(text.contains(r#""ok":false"#));
        assert!(text.contains("network: 超时"));
    }

    /// 缺 `adapter` / `probe` 的老 JSON 必须照样能读(迁移靠这一步)
    #[test]
    fn old_json_without_adapter_or_probe_still_loads() {
        let old: Vec<Source> = serde_json::from_str(
            r#"[
              {"id":"dytt","name":"电影天堂","type":"xml","url":"https://cj.lziapi.com/api.php/provide/vod/at/xml",
               "health":{"ok":true,"ms":320,"checked_at":"2026-11-14T13:45:07Z","note":""}},
              {"id":"4kvm","name":"4K影视","type":"webox","url":"D:/x/4k.webox.js"},
              {"id":"dbk","name":"独播库","type":"vod","url":"https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json"}
            ]"#,
        )
        .expect("老配置解析失败");
        assert_eq!(old.len(), 3);
        // `type` 原样保留(界面还在用),adapter 各自按规则补上
        assert_eq!(old[0].kind, "xml");
        assert_eq!(old[0].adapter(), "vod");
        assert_eq!(old[1].adapter(), "webox");
        assert_eq!(old[2].adapter(), "iplayr");
        assert!(old.iter().all(|s| s.adapter.is_empty() && s.probe.is_none()));
        // 迁移后写回去:只多出 adapter,`type` 没被动过
        let mut migrated = old.clone();
        for s in &mut migrated {
            s.adapter = derive_adapter(&s.kind, &s.url).to_string();
        }
        let text = serde_json::to_string(&migrated).expect("序列化失败");
        assert!(text.contains(r#""adapter":"iplayr""#), "实际: {text}");
        assert!(text.contains(r#""type":"xml""#), "type 不该被改: {text}");
        let back: Vec<Source> = serde_json::from_str(&text).expect("迁移后解析失败");
        assert_eq!(back[0].kind, "xml");
        assert_eq!(back[0].adapter(), "vod");
    }

    /// 迁移:只补空的 `adapter`,补完第二次一条也不补(`load_sources` 靠它决定写不写文件),
    /// `type` 一个字都不动。
    #[test]
    fn fill_adapters_is_idempotent() {
        let mut list: Vec<Source> = serde_json::from_str(
            r#"[
              {"id":"dytt","name":"电影天堂","type":"xml","url":"https://cj.lziapi.com/api.php/provide/vod/at/xml"},
              {"id":"dbk","name":"独播库","type":"vod","url":"https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json","adapter":"iplayr"},
              {"id":"4kvm","name":"4K影视","type":"webox","url":"D:/x/4k.webox.js"}
            ]"#,
        )
        .expect("解析失败");

        assert_eq!(super::fill_adapters(&mut list), 2, "只有两条缺 adapter");
        assert_eq!(list[0].adapter, "vod");
        assert_eq!(list[1].adapter, "iplayr", "已有值的不能被改");
        assert_eq!(list[2].adapter, "webox", "`.webox.js` 就是 WeBox 入口");
        // `type` 不动
        assert_eq!(list[0].kind, "xml");
        assert_eq!(list[2].kind, "webox");

        // 再跑一遍:没什么可补的 → 调用方不该再写文件
        assert_eq!(super::fill_adapters(&mut list), 0);

        // 早期迁移把 `.webox.js` 写成了 reelbox:这一条要纠正回来,别的 adapter 不碰
        let mut legacy: Vec<Source> = serde_json::from_str(
            r#"[
              {"id":"a","name":"老插件","type":"webox","url":"D:/x/a.webox.js","adapter":"reelbox"},
              {"id":"b","name":"新插件","type":"webox","url":"D:/x/b.reelbox.js","adapter":"reelbox"},
              {"id":"c","name":"CMS","type":"vod","url":"https://x/api.php/provide/vod","adapter":"vod"}
            ]"#,
        )
        .expect("解析失败");
        assert_eq!(super::fill_adapters(&mut legacy), 1, "只纠正那条 .webox.js");
        assert_eq!(legacy[0].adapter, "webox");
        assert_eq!(legacy[1].adapter, "reelbox");
        assert_eq!(legacy[2].adapter, "vod");
        assert_eq!(super::fill_adapters(&mut legacy), 0, "纠正后不再写文件");
        assert_eq!(list[0].adapter, "vod");

        // 已经迁移过的数据(空列表也算)同样返回 0
        let mut none: Vec<Source> = Vec::new();
        assert_eq!(super::fill_adapters(&mut none), 0);
    }

    /// 迁移的验收口径:本机现有的 9 个源,补完 `adapter` 之后走的路和今天一样
    /// (`vod` / `xml` → CMS;插件 → 插件;iplayr 的 `.json` → 插件)。
    #[test]
    fn existing_sources_keep_their_route() {
        // (type, url, 迁移后该得到的 adapter)
        let real = [
            ("vod", "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8", "vod"),
            (
                "vod",
                "https://raw.githubusercontent.com/m3u8playlist/dp/refs/heads/master/iplayr/libvio2.json",
                "iplayr",
            ),
            ("vod", "https://caiji.dyttzyapi.com/api.php/provide/vod", "vod"),
            ("vod", "https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json", "iplayr"),
            ("xml", "https://cj.lziapi.com/api.php/provide/vod/at/xml", "vod"),
            ("vod", "https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/cz.json", "iplayr"),
            (
                "vod",
                "https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/olevod.json",
                "iplayr",
            ),
            ("vod", "https://api.wsyzy.net/api.php/provide/vod", "vod"),
            (
                "webox",
                r"C:\Users\hujie\AppData\Roaming\reelbox\plugins\user-4kvm.reelbox.js",
                "reelbox",
            ),
        ];
        for (kind, url, want) in real {
            assert_eq!(derive_adapter(kind, url), want, "type={kind} url={url}");
        }
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
        // 版本:普通源空着,也不写进配置文件;有值的时候能存能读
        assert!(old.version.is_empty());
        assert!(!text.contains("version"), "空版本不该落盘: {text}");

        let ver: Source = serde_json::from_str(
            r#"{"id":"d1","name":"带版本的源","type":"webox","url":"D:/x/demo.reelbox.js","version":"1"}"#,
        )
        .expect("带版本的源解析失败");
        assert_eq!(ver.version, "1");
        assert!(serde_json::to_string(&ver).unwrap().contains("\"version\":\"1\""));

        // 失败的探测带得上原因
        let bad = Health { ok: false, ms: 5001, checked_at: now_iso(), note: "超时".into() };
        let text = serde_json::to_string(&bad).expect("序列化失败");
        assert!(text.contains("\"ok\":false"));
        assert!(text.contains("超时"));
    }
}
