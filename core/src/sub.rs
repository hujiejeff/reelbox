//! 配置订阅:一份 `index.json` 里装着源和适配器。
//!
//! 「一条链接换全部配置」——用户在应用里粘一个地址,里面写什么就会被装什么。
//! 所以这里做两件事,都不碰 IO(可以单独测):
//!
//! 1. **解析**:把索引读成一个宽容的结构(字段都有缺省值),而不是直接
//!    反序列化成 [`Source`] —— 后者字段缺一个就只会抛 `missing field`,
//!    用户看不出是哪条源写坏了。
//! 2. **挑错**:[`problems`] 一次列全所有毛病,由调用方决定是拒绝还是仅提示。
//!
//! 真正的下载、写盘在 `src-tauri/src/sub.rs`。契约见 `docs/SUBSCRIPTIONS.md`。
//!
//! ## v2 的两条设计约束
//!
//! - **代码的元信息只存在代码里**:`define({ id, name, version })` 写在 js 里,
//!   索引不重复一遍,也就不会出现"文件里 1.0.0、索引里 1.1.0"这种对不上的事。
//! - **插件和适配器是一种东西**:都对源说"由这段代码解析",所以只有 `adapters[]`。

use crate::source::Source;
use serde::{Deserialize, Serialize};

/// 索引格式。**只有这一代**:v1 已经废弃,不做自动转换。
pub const SCHEMA: &str = "reelbox-index/2";

/// 上一代的格式标识:读到它要给一句人话,而不是一片字段错误。
pub const SCHEMA_V1: &str = "reelbox-index/1";

/// 随包安装的适配器。
///
/// 订阅里出现同名一律拒绝:内置的靠首行 `@builtin-version` 升级(见
/// `src-tauri/src/builtin.rs`),让订阅也能写同一个名字,就等于给同一份文件
/// 开了两套升级机制 —— 到底听谁的说不清。
pub const BUILTIN_ADAPTERS: &[&str] = &["vod", "vod-rs", "iplayr", "m3u", "reelbox"];

/// 源的类型(界面上的徽标、源页分段、直播模式都按它分)。
pub const SOURCE_TYPES: &[&str] = &["vod", "xml", "live", "webox"];

pub fn is_builtin_adapter(id: &str) -> bool {
    BUILTIN_ADAPTERS.contains(&id)
}

/// 一条自定义适配器(插件在这里也算适配器:对源来说角色相同)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Adapter {
    /// 源用 `adapter` 字段引用它
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 代码文件的位置:相对索引,或完整的 http(s) 地址
    #[serde(default)]
    pub url: String,
}

/// 索引里的一条源。字段全是缺省值,坏一条不连累整份索引的解析。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 站点地址(插件的源也一样:插件自己知道站点在哪)
    #[serde(default)]
    pub url: String,
    /// 用哪个适配器:内置名字,或 `adapters[].id`
    #[serde(default)]
    pub adapter: String,
    /// `vod` / `xml` / `live` / `webox`。必填 —— 靠猜的话直播插件必被猜成点播
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub verify: bool,
    #[serde(default, rename = "verifyUrl")]
    pub verify_url: String,
    #[serde(default, rename = "posterRatio")]
    pub poster_ratio: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub options: serde_json::Value,
}

impl SubSource {
    /// 变成应用里的源。`from` 由调用方填(订阅 id),这里不猜。
    pub fn to_source(&self) -> Source {
        Source {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            url: self.url.clone(),
            adapter: self.adapter.clone(),
            verify: self.verify,
            verify_url: self.verify_url.clone(),
            poster_ratio: self.poster_ratio.clone(),
            options: self.options.clone(),
            ..Default::default()
        }
    }
}

/// 一份索引。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Index {
    #[serde(default)]
    pub schema: String,
    #[serde(default)]
    pub name: String,
    /// 订阅自己的版本,`1.0.0` 这种 —— 应用靠它判断有没有更新
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub adapters: Vec<Adapter>,
    #[serde(default)]
    pub sources: Vec<SubSource>,
}

impl Index {
    /// 从一段文本解析索引。
    ///
    /// 比 `serde_json::from_str` 多两句人话:老配置把 `version` 写成数字、
    /// 或者还是 v1 的 schema —— 这两种都只会抛看不懂的类型错误。
    pub fn parse(text: &str) -> Result<Index, String> {
        match serde_json::from_str::<Index>(text) {
            Ok(idx) => {
                if idx.schema == SCHEMA_V1 {
                    return Err(
                        "这份配置是旧格式(schema reelbox-index/1),当前版本只认 reelbox-index/2 \
                         —— 让仓库作者升级一下"
                            .to_string(),
                    );
                }
                Ok(idx)
            }
            Err(e) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
                    if v.get("version").map(|x| x.is_number()).unwrap_or(false) {
                        return Err(format!(
                            "version 要写成字符串 \"1.0.0\"(老写法是数字 {}),改一下就能装",
                            &v["version"]
                        ));
                    }
                    if v.get("schema").and_then(|x| x.as_str()) == Some(SCHEMA_V1) {
                        return Err(
                            "这份配置是旧格式(schema reelbox-index/1),当前版本只认 \
                             reelbox-index/2 —— 让仓库作者升级一下"
                                .to_string(),
                        );
                    }
                }
                Err(format!("不是合法的 index.json: {e}"))
            }
        }
    }

    /// 某个 adapter id 对应的代码条目
    pub fn adapter_of(&self, id: &str) -> Option<&Adapter> {
        self.adapters.iter().find(|a| a.id == id)
    }
}

/// 把相对地址接成绝对地址。
///
/// `base` 是索引自己的地址(`https://host/a/b/index.json`),相对路径按它的
/// 目录拼。这样同一份索引放 raw、jsDelivr、Pages 都能用。
pub fn resolve(base: &str, path: &str) -> String {
    let p = path.trim();
    if p.is_empty() {
        return String::new();
    }
    if p.starts_with("http://") || p.starts_with("https://") {
        return p.to_string();
    }
    let dir = match base.rfind('/') {
        Some(i) => &base[..i + 1],
        None => "",
    };
    format!("{dir}{}", p.trim_start_matches("./"))
}

/// 这个文件装到本机叫什么名字。
///
/// 相对路径时 `url` 本身就是文件名;写成绝对地址时取 URL 最后一段
/// (去掉 `?xv=1` 这类查询串)。
pub fn local_name(url: &str) -> String {
    let p = url.trim();
    let no_query = p.split(['?', '#']).next().unwrap_or(p);
    no_query.rsplit('/').next().unwrap_or(no_query).to_string()
}

fn is_http(url: &str) -> bool {
    let s = url.trim().to_ascii_lowercase();
    s.starts_with("http://") || s.starts_with("https://")
}

/// 三段式版本号:`1` / `1.0` / `1.0.0-beta` 都不算 —— 订阅版本只认 `x.y.z`。
pub fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 4 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 比版本,按段比数字。认不出来的段算 0(所以 `1` 和 `1.0.0` 相等)。
pub fn ver_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .take(3)
            .map(|x| x.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (parse(a), parse(b));
    for i in 0..3 {
        let (x, y) = (
            va.get(i).copied().unwrap_or(0),
            vb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

/// `candidate` 比 `current` 新?—— 「检查更新」就靠这一句。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    ver_cmp(candidate, current) == std::cmp::Ordering::Greater
}

/// 文件指纹(小写十六进制)。
///
/// 索引里**不写** sha256:完整性靠 HTTPS + 地址由配置作者控制。
/// 这里算出来的值只存进本地账本,用来判断"用户手改过没有"。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 一次列出所有毛病。空 vec = 可以装。
pub fn problems(idx: &Index) -> Vec<String> {
    let mut out = Vec::new();

    if idx.schema != SCHEMA {
        out.push(format!(
            "schema 必须是 {SCHEMA},现在是 {:?}",
            if idx.schema.is_empty() { "(空)" } else { &idx.schema }
        ));
    }
    if idx.name.trim().is_empty() {
        out.push("缺 name(订阅列表里显示的就是它)".into());
    }
    if !is_semver(&idx.version) {
        out.push(format!(
            "version 要写成 1.0.0 这种三段式(semver),现在是 {:?}",
            idx.version
        ));
    }

    // ---- 适配器 ----
    let mut ids: Vec<(String, &'static str)> = Vec::new();
    for a in &idx.adapters {
        let who = if a.id.is_empty() { a.name.as_str() } else { &a.id };
        if a.id.is_empty() {
            out.push(format!("适配器 {who}:缺 id"));
        } else if is_builtin_adapter(&a.id) {
            out.push(format!(
                "适配器 \"{}\" 是内置名字,订阅里不能重名(内置靠 @builtin-version 升级)",
                a.id
            ));
        }
        if is_duplicate(&ids, &a.id) {
            out.push(format!("id \"{}\" 重复(适配器之间)", a.id));
        }
        if a.name.trim().is_empty() {
            out.push(format!("适配器 {who}:缺 name"));
        }
        if a.url.trim().is_empty() {
            out.push(format!("适配器 {who}:缺 url(代码文件在哪)"));
        }
        if !ids.iter().any(|(x, _)| x == &a.id) {
            ids.push((a.id.clone(), "adapter"));
        }
    }

    // ---- 源 ----
    let mut src_ids: Vec<(String, &'static str)> = Vec::new();
    for s in &idx.sources {
        let who = if s.id.is_empty() { s.name.as_str() } else { &s.id };
        if s.id.is_empty() {
            out.push(format!("源 {who}:缺 id(更新时靠它认人)"));
        }
        if is_duplicate(&src_ids, &s.id) {
            out.push(format!("id \"{}\" 重复(源之间)", s.id));
        } else {
            src_ids.push((s.id.clone(), "source"));
        }
        if s.name.trim().is_empty() {
            out.push(format!("源 {who}:缺 name"));
        }
        if s.url.trim().is_empty() {
            out.push(format!("源 {who}:缺 url"));
        } else if !is_http(&s.url) {
            // 指向本机文件的源不能进订阅:别人装了没有那个文件
            out.push(format!(
                "源 {who}:url 必须是 http(s)(本地插件请用 adapter + adapters 里的代码)"
            ));
        }
        if s.adapter.is_empty() {
            out.push(format!("源 {who}:缺 adapter"));
        } else if !is_builtin_adapter(&s.adapter) && idx.adapter_of(&s.adapter).is_none() {
            out.push(format!(
                "源 {who}:adapter \"{}\" 既不是内置的,也不在 adapters 里",
                s.adapter
            ));
        }
        if s.kind.is_empty() {
            // 必填是权衡过的:直播插件(url 是站点域名、不是 .m3u8)猜不出来
            out.push(format!(
                "源 {who}:缺 type({}),靠猜会把直播插件当成点播",
                SOURCE_TYPES.join(" / ")
            ));
        } else if !SOURCE_TYPES.contains(&s.kind.as_str()) {
            out.push(format!(
                "源 {who}:type 只能是 {},现在是 {:?}",
                SOURCE_TYPES.join(" / "),
                s.kind
            ));
        }
        if s.verify && s.verify_url.trim().is_empty() && !is_http(&s.url) {
            out.push(format!("源 {who}:开了 verify 但推不出站点地址,要显式写 verifyUrl"));
        }
        if !s.poster_ratio.is_empty() && !is_ratio(&s.poster_ratio) {
            out.push(format!("源 {who}:posterRatio 要写成 16:9 这种"));
        }
    }

    out
}

fn is_duplicate(ids: &[(String, &'static str)], id: &str) -> bool {
    !id.is_empty() && ids.iter().any(|(x, _)| x == id)
}

fn is_ratio(s: &str) -> bool {
    let Some((a, b)) = s.split_once(':') else {
        return false;
    };
    a.parse::<u32>().is_ok() && b.parse::<u32>().is_ok() && a.parse::<u32>().unwrap() > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(json: &str) -> Index {
        Index::parse(json).expect("解析失败")
    }

    fn good_sha() -> String {
        "a".repeat(64)
    }

    #[test]
    fn minimal_index_has_no_problems() {
        let i = idx(
            r#"{"schema":"reelbox-index/2","name":"t","version":"1.0.0",
                "sources":[{"id":"a","name":"A","url":"https://a.com/api","adapter":"vod","type":"vod"}]}"#,
        );
        assert_eq!(problems(&i), Vec::<String>::new());
        assert_eq!(i.sources[0].to_source().kind, "vod");
    }

    #[test]
    fn v1_schema_is_rejected_with_a_human_message() {
        let e = Index::parse(r#"{"schema":"reelbox-index/1","name":"t","version":"1.0.0"}"#)
            .expect_err("v1 应该被拒");
        assert!(e.contains("旧格式"), "{e}");
    }

    #[test]
    fn numeric_version_gets_a_hint() {
        let e = Index::parse(r#"{"schema":"reelbox-index/2","name":"t","version":3}"#)
            .expect_err("数字版本应该被拒");
        assert!(e.contains("要写成字符串"), "{e}");
    }

    #[test]
    fn catches_structural_mistakes() {
        let i = idx(
            r#"{"schema":"reelbox-index/2","name":"","version":"1",
                "adapters":[{"id":"m3u","name":"抢名字","url":"x.js"}],
                "sources":[
                  {"id":"dup","name":"A","url":"https://a.com","adapter":"vod"},
                  {"id":"dup","name":"B","url":"C:/x/c.js","adapter":"nope"},
                  {"id":"c","name":"C","url":"https://c.com","adapter":"vod","type":"movie"}
                ]}"#,
        );
        let p = problems(&i).join("\n");
        assert!(p.contains("缺 name"), "{p}");
        assert!(p.contains("version 要写成"), "{p}");
        assert!(p.contains("是内置名字"), "{p}");
        assert!(p.contains("重复"), "{p}");
        assert!(p.contains("不能是本地路径") || p.contains("必须是 http(s)"), "{p}");
        assert!(p.contains("既不是内置的"), "{p}");
        assert!(p.contains("缺 type"), "{p}");
    }

    #[test]
    fn adapter_reference_must_exist_and_is_not_a_source_id() {
        let i = idx(
            r#"{"schema":"reelbox-index/2","name":"t","version":"1.0.0",
                "adapters":[{"id":"4kvm","name":"4K","url":"plugins/4kvm.reelbox.js"}],
                "sources":[
                  {"id":"4kvm","name":"4K影视","url":"https://www.4kvm.net","adapter":"4kvm","type":"webox"},
                  {"id":"x","name":"X","url":"https://x.com","adapter":"ghost","type":"vod"}
                ]}"#,
        );
        let p = problems(&i).join("\n");
        // 源 id 和适配器 id 可以同名(两个命名空间),但 ghost 找不到
        assert!(!p.contains("\"4kvm\" 重复") || p.contains("ghost"), "{p}");
        assert!(p.contains("ghost"), "{p}");
    }

    #[test]
    fn absolute_adapter_url_is_allowed() {
        let i = idx(
            r#"{"schema":"reelbox-index/2","name":"t","version":"1.0.0",
                "adapters":[{"id":"a","name":"A","url":"https://cdn.x.com/a.reelbox.js"}],
                "sources":[{"id":"s","name":"S","url":"https://s.com","adapter":"a","type":"vod"}]}"#,
        );
        assert_eq!(problems(&i), Vec::<String>::new());
        assert_eq!(i.adapter_of("a").map(|x| x.url.as_str()), Some("https://cdn.x.com/a.reelbox.js"));
    }

    #[test]
    fn resolve_joins_relative_against_index_dir() {
        assert_eq!(
            resolve("https://raw.example.com/u/r/master/index.json", "plugins/a.js"),
            "https://raw.example.com/u/r/master/plugins/a.js"
        );
        assert_eq!(resolve("https://a.com/x/index.json", "https://b.com/y.js"), "https://b.com/y.js");
        assert_eq!(resolve("index.json", "a.js"), "a.js");
    }

    #[test]
    fn local_name_takes_the_last_segment() {
        assert_eq!(local_name("plugins/4kvm.reelbox.js"), "4kvm.reelbox.js");
        assert_eq!(local_name("https://cdn.x.com/p/4kvm.reelbox.js?v=2"), "4kvm.reelbox.js");
    }

    #[test]
    fn semver_shape_and_compare() {
        assert!(is_semver("1.0.0") && is_semver("0.2.10"));
        for bad in ["1", "1.0", "v1.0.0", "1.0.0-beta", "", "1..0"] {
            assert!(!is_semver(bad), "{bad} 不该算 semver");
        }
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.1.0", "1.0.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(good_sha().len(), 64);
    }
}
