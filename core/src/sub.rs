//! 配置订阅:一份 `index.json` 里装着源、源插件、适配器。
//!
//! 「一条链接换全部配置」——用户在应用里粘一个地址,里面写什么就会被装什么。
//! 所以这里做两件事,都不碰 IO(可以单独测):
//!
//! 1. **解析**:把索引读成一个宽容的结构(`SubSource` 每个字段都有缺省值),
//!    而不是直接反序列化成 [`Source`] —— 后者字段缺一个就只会抛一句
//!    "missing field",用户看不出是哪条源写坏了。
//! 2. **挑错**:[`problems`] 一次列全所有毛病,由调用方决定是拒绝还是仅提示。
//!
//! 真正的下载、比对 sha256、写盘在 `src-tauri/src/sub.rs`。

use crate::source::Source;
use serde::{Deserialize, Serialize};

/// 索引文件的格式标识。以后不兼容地改结构,就换成 `/2`。
pub const SCHEMA: &str = "reelbox-index/1";

/// 随包安装的适配器。
///
/// 订阅里出现同名一律拒绝:内置的靠首行 `@builtin-version` 升级(见
/// `src-tauri/src/builtin.rs`),让订阅也能写同一个名字,就等于给同一份文件
/// 开了两套升级机制 —— 到底听谁的说不清。
pub const BUILTIN_ADAPTERS: &[&str] = &["vod", "vod-rs", "iplayr", "m3u", "reelbox"];

/// 源的类型(界面上的徽标、源页分段都按它分)。
pub const SOURCE_TYPES: &[&str] = &["vod", "xml", "live", "webox"];

pub fn is_builtin_adapter(id: &str) -> bool {
    BUILTIN_ADAPTERS.contains(&id)
}

/// 索引里的一条代码文件(适配器或插件)。
///
/// `path` 只写文件名 —— 应用只扫描 `plugins/` 第一层,放子目录等于没装。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodeEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// 这个文件自己的版本(`1.2.0` 这种),便于人看变更;
    /// 应用判断"要不要重下"看 `sha256`,不看它。
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub sha256: String,
    /// 需要的最低应用版本(`x.y.z`)。新适配器用了旧应用没有的能力时,
    /// 安装前就该拒绝,而不是运行时抛一堆 undefined。
    #[serde(default, rename = "minApp")]
    pub min_app: String,
}

/// 索引里的一条源。字段全是缺省值,坏一条不连累整份索引的解析。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubSource {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub adapter: String,
    /// 这个源由包里的哪个插件解析(索引 `plugins[].id`)。
    ///
    /// 原生插件型的源,本机 `url` 存的就是插件文件路径;订阅里没法写死别人的路径,
    /// 所以这里存**插件 id**,装的时候换成插件装好后在本机的路径。
    #[serde(default)]
    pub plugin: String,
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
    ///
    /// `plugin_url` 是"这个源用的插件装在本机哪儿":给了就用它当 `url`
    /// (原生插件的源,url 本来就是插件文件路径),否则用索引里写的地址。
    pub fn to_source(&self, plugin_url: Option<&str>) -> Source {
        let url = plugin_url.map(str::to_string).unwrap_or_else(|| self.url.clone());
        Source {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            url,
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
    /// 订阅自己的版本,`1.0.0` 这种 —— 和软件包一致,能一眼看出"这是第几版改的"。
    /// 应用判断"有没有更新"只比它,不看时间。
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub adapters: Vec<CodeEntry>,
    #[serde(default)]
    pub plugins: Vec<CodeEntry>,
    #[serde(default)]
    pub sources: Vec<SubSource>,
}

impl Index {
    /// 从一段文本解析索引。
    ///
    /// 比 `serde_json::from_str` 多一句人话:老配置把 `version` 写成数字
    /// (`"version": 1`),直接反序列化只会抛 `invalid type: integer, expected a string`,
    /// 用户看不出该改哪儿。
    pub fn parse(text: &str) -> Result<Index, String> {
        match serde_json::from_str::<Index>(text) {
            Ok(idx) => Ok(idx),
            Err(e) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
                    if v.get("version").map(|x| x.is_number()).unwrap_or(false) {
                        return Err(format!(
                            "version 要写成字符串 \"1.0.0\"(老写法是数字 {}),改一下就能装",
                            &v["version"]
                        ));
                    }
                }
                Err(format!("不是合法的 index.json: {e}"))
            }
        }
    }

    pub fn code_entries(&self) -> impl Iterator<Item = (&'static str, &CodeEntry)> {
        self.adapters
            .iter()
            .map(|e| ("adapter", e))
            .chain(self.plugins.iter().map(|e| ("plugin", e)))
    }
}

/// 把索引里的相对路径接成绝对地址。
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

/// 索引里的代码文件在仓库的 `plugins/` 下(`path` 只写文件名),这里拼出真实地址。
///
/// 单独一个函数是因为"索引里写文件名、地址里是多一级目录"这件事两边都要一致:
/// 校验脚本按 `plugins/<path>` 找文件,下载也必须按同一个位置找,否则 404 之后
/// 会被当成"网络问题",排查半天。
pub fn code_url(base: &str, path: &str) -> String {
    let p = path.trim();
    // 写死一个绝对地址也认:插件放在别的仓库 / 别的 CDN 时用得上。
    // 代价是这份索引就绑在那个域名上了 —— 换入口要改索引,不再是一份走天下。
    if is_http(p) {
        return p.to_string();
    }
    resolve(base, &format!("plugins/{}", p.trim_start_matches("./")))
}

/// 这个文件装到本机叫什么名字。
///
/// 相对路径时 `path` 本身就是文件名;写成绝对地址时取 URL 最后一段
/// (去掉 `?xv=1` 这类查询串)。
pub fn local_name(path: &str) -> String {
    let p = path.trim();
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

/// 应用版本够不够 `minApp`。任一边认不出来就不拦,免得误伤。
fn version_ok(app: &str, min: &str) -> bool {
    if !is_semver(app) || !is_semver(min) {
        return true;
    }
    ver_cmp(app, min) != std::cmp::Ordering::Less
}

/// 一次列出所有毛病。空 vec = 可以装。
///
/// `app_version` 用来判 `minApp`;传空串跳过这项检查。
pub fn problems(idx: &Index, app_version: &str) -> Vec<String> {
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

    let mut ids: Vec<(String, &'static str)> = Vec::new(); // 代码文件(插件 / 适配器)
    let mut src_ids: Vec<(String, &'static str)> = Vec::new(); // 源

    let mut plugin_ids: Vec<String> = Vec::new();
    for e in &idx.plugins {
        if !e.id.is_empty() {
            plugin_ids.push(e.id.clone());
        }
    }
    let mut adapter_ids: Vec<String> = Vec::new();
    for e in &idx.adapters {
        claim(&mut out, &mut ids, &e.id, "adapter");
        if is_builtin_adapter(&e.id) {
            out.push(format!(
                "适配器 \"{}\" 是内置名字,订阅里不能重名(内置靠 @builtin-version 升级)",
                e.id
            ));
        } else {
            adapter_ids.push(e.id.clone());
        }
        check_code(&mut out, "adapter", e, ".adapter.js", app_version);
    }
    for e in &idx.plugins {
        claim(&mut out, &mut ids, &e.id, "plugin");
        check_code(&mut out, "plugin", e, ".reelbox.js", app_version);
    }

    for s in &idx.sources {
        claim(&mut out, &mut src_ids, &s.id, "source");
        let who = if s.id.is_empty() { s.name.as_str() } else { &s.id };

        if s.id.is_empty() {
            out.push(format!("源 {who}:缺 id(更新时靠它认人)"));
        }
        if s.name.trim().is_empty() {
            out.push(format!("源 {who}:缺 name"));
        }
        if !SOURCE_TYPES.contains(&s.kind.as_str()) {
            out.push(format!(
                "源 {who}:type 只能是 {},现在是 {:?}",
                SOURCE_TYPES.join(" / "),
                s.kind
            ));
        }
        if !s.plugin.is_empty() {
            // 插件型的源:url 可以空着(url 会被换成插件路径),但插件得在包里
            if !plugin_ids.iter().any(|x| x == &s.plugin) {
                out.push(format!("源 {who}:引用了不在 plugins 里的插件 {:?}", s.plugin));
            }
        } else if s.url.trim().is_empty() {
            out.push(format!("源 {who}:缺 url"));
        } else if !is_http(&s.url) {
            // 指向本机文件的源不能进订阅:别人装了没有那个文件
            out.push(format!(
                "源 {who}:url 必须是 http(s),不能是本地路径 —— 本地插件的源请改成 adapter + plugin"
            ));
        }
        if s.adapter.is_empty() {
            out.push(format!("源 {who}:缺 adapter"));
        } else if !is_builtin_adapter(&s.adapter) && !adapter_ids.iter().any(|x| *x == s.adapter) {
            out.push(format!(
                "源 {who}:adapter \"{}\" 既不是内置的,也不在本索引的 adapters 里",
                s.adapter
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

/// 文件指纹(小写十六进制)。
///
/// 订阅靠它判断「这份文件还是我装的那份吗」:对不上 = 用户改过,不能闷头覆盖。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 一个命名空间里不重名:插件 / 适配器共用一套(都是装在 plugins/ 下的文件),
/// 源自己一套。所以"插件 4kvm + 源 4kvm"是合法的 —— 那是两件事。
fn claim(out: &mut Vec<String>, ids: &mut Vec<(String, &'static str)>, id: &str, what: &'static str) {
    if id.is_empty() {
        return;
    }
    if let Some((_, prev)) = ids.iter().find(|(x, _)| x == id) {
        out.push(format!("id \"{id}\" 重复({prev} 和 {what})"));
    } else {
        ids.push((id.to_string(), what));
    }
}

fn is_ratio(s: &str) -> bool {
    let Some((a, b)) = s.split_once(':') else {
        return false;
    };
    a.parse::<u32>().is_ok() && b.parse::<u32>().is_ok() && a.parse::<u32>().unwrap() > 0
}

fn check_code(out: &mut Vec<String>, kind: &str, e: &CodeEntry, suffix: &str, app_version: &str) {
    let who = if e.id.is_empty() { e.name.clone() } else { e.id.clone() };
    if e.id.is_empty() {
        out.push(format!("{kind} {who}:缺 id"));
    }
    if e.name.trim().is_empty() {
        out.push(format!("{kind} {who}:缺 name"));
    }
    if e.path.trim().is_empty() {
        out.push(format!("{kind} {who}:缺 path"));
        return;
    }
    // path 两种写法:plugins/ 下的文件名,或者一个完整的 http(s) 地址。
    // 前者要求不带目录 —— 应用只扫 plugins/ 一层,子目录等于没装。
    if !is_http(&e.path) && (e.path.contains('/') || e.path.contains('\\')) {
        out.push(format!(
            "{kind} {who}:path 要么是文件名(装在 plugins/ 下),要么是完整的 http(s) 地址"
        ));
    }
    if !local_name(&e.path).ends_with(suffix) {
        out.push(format!("{kind} {who}:文件名必须以 {suffix} 结尾"));
    }
    if e.sha256.len() != 64 || !e.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        out.push(format!("{kind} {who}:sha256 必须填 64 位十六进制(用 stamp 脚本生成)"));
    }
    if !e.min_app.is_empty() {
        let parts: Vec<&str> = e.min_app.split('.').collect();
        let shape_ok = parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok());
        if !shape_ok {
            out.push(format!("{kind} {who}:minApp 要写成 x.y.z"));
        } else if !app_version.is_empty() && !version_ok(app_version, &e.min_app) {
            out.push(format!(
                "{kind} {who}:需要应用 {} 以上,现在是 {}",
                e.min_app, app_version
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx_with_sources(json: &str) -> Index {
        serde_json::from_str(json).expect("解析失败")
    }

    #[test]
    fn sha256_matches_known_vectors() {
        // 空串和 "abc" 的 SHA-256 是公开测试向量,和 JS / 命令行对得上才算对
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn semver_shape_and_compare() {
        assert!(is_semver("1.0.0") && is_semver("0.2.10"));
        for bad in ["1", "1.0", "v1.0.0", "1.0.0-beta", "", "1..0"] {
            assert!(!is_semver(bad), "{bad} 不该算 semver");
        }
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.1.0", "1.0.9"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.1"));
        // 段数不齐时缺的算 0:1.0 == 1.0.0
        assert!(!is_newer("1.0", "1.0.0"));
    }

    #[test]
    fn resolve_joins_relative_against_index_dir() {
        assert_eq!(
            resolve("https://raw.example.com/u/r/main/index.json", "plugins/a.reelbox.js"),
            "https://raw.example.com/u/r/main/plugins/a.reelbox.js"
        );
        // 绝对地址原样返回
        assert_eq!(
            resolve("https://a.com/x/index.json", "https://b.com/y.js"),
            "https://b.com/y.js"
        );
        // 没有斜杠的 base 不 panic
        assert_eq!(resolve("index.json", "a.js"), "a.js");
        // 空路径
        assert_eq!(resolve("https://a.com/x/index.json", ""), "");
    }

    #[test]
    fn absolute_code_path_is_used_as_is() {
        // 写死绝对地址:原样用,不拼 plugins/
        assert_eq!(
            code_url("https://a.com/u/r/master/index.json", "https://cdn.x.com/p/4kvm.reelbox.js"),
            "https://cdn.x.com/p/4kvm.reelbox.js"
        );
        // 落盘用的名字:相对路径就是文件名,绝对地址取 URL 最后一段(去掉查询串)
        assert_eq!(local_name("4kvm.reelbox.js"), "4kvm.reelbox.js");
        assert_eq!(local_name("https://cdn.x.com/p/4kvm.reelbox.js?v=2"), "4kvm.reelbox.js");
        assert_eq!(local_name("./a/b/x.adapter.js"), "x.adapter.js");
    }

    #[test]
    fn problems_allows_absolute_path_but_not_subdirs() {
        let sha = "c".repeat(64);
        let ok = Index::parse(&format!(
            r#"{{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                 "plugins":[{{"id":"p","name":"P","path":"https://cdn.x.com/p/p.reelbox.js","sha256":"{sha}"}}]}}"#
        ))
        .unwrap();
        assert_eq!(problems(&ok, ""), Vec::<String>::new());

        let bad = Index::parse(&format!(
            r#"{{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                 "plugins":[{{"id":"q","name":"Q","path":"sub/q.reelbox.js","sha256":"{sha}"}}]}}"#
        ))
        .unwrap();
        assert!(problems(&bad, "").iter().any(|x| x.contains("要么是文件名")), "{:?}", problems(&bad, ""));
    }

    #[test]
    fn code_url_points_at_plugins_dir() {
        assert_eq!(
            code_url("https://a.com/u/r/main/index.json", "iplayr.adapter.js"),
            "https://a.com/u/r/main/plugins/iplayr.adapter.js"
        );
        assert_eq!(
            code_url("https://a.com/u/r/main/index.json", "./x.reelbox.js"),
            "https://a.com/u/r/main/plugins/x.reelbox.js"
        );
    }

    #[test]
    fn good_index_has_no_problems() {
        let idx = idx_with_sources(
            r#"{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                "sources":[{"id":"a","name":"A","type":"vod","url":"https://a.com","adapter":"vod"}]}"#,
        );
        assert_eq!(problems(&idx, "0.2.3"), Vec::<String>::new());
    }

    #[test]
    fn catches_structural_mistakes() {
        let idx = idx_with_sources(
            r#"{"schema":"reelbox-index/2","name":"","version":"1",
                "adapters":[{"id":"m3u","name":"抢名字","path":"m3u.adapter.js","sha256":"aa"}],
                "sources":[
                  {"id":"dup","name":"A","type":"vod","url":"https://a.com","adapter":"vod"},
                  {"id":"dup","name":"B","type":"movie","url":"C:/x/c.js","adapter":"nope"}
                ]}"#,
        );
        let p = problems(&idx, "").join("\n");
        assert!(p.contains("schema 必须是"), "{p}");
        assert!(p.contains("缺 name"), "{p}");
        assert!(p.contains("version 要写成"), "{p}");
        assert!(p.contains("是内置名字"), "{p}");
        assert!(p.contains("sha256 必须填"), "{p}");
        assert!(p.contains("重复"), "{p}");
        assert!(p.contains("type 只能是"), "{p}");
        assert!(p.contains("不能是本地路径"), "{p}");
        assert!(p.contains("既不是内置的"), "{p}");
    }

    #[test]
    fn min_app_blocks_old_client() {
        let sha = "a".repeat(64);
        let idx = idx_with_sources(&format!(
            r#"{{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                 "plugins":[{{"id":"p","name":"P","path":"p.reelbox.js","sha256":"{sha}","minApp":"0.3.0"}}]}}"#
        ));
        let p = problems(&idx, "0.2.9");
        assert!(p.iter().any(|x| x.contains("需要应用 0.3.0 以上")), "{p:?}");
        assert_eq!(problems(&idx, "0.3.1"), Vec::<String>::new());
    }

    #[test]
    fn plugin_source_needs_the_plugin_and_gets_local_url() {
        let sha = "b".repeat(64);
        // 引用了不存在的插件:拒绝
        let bad = Index::parse(&format!(
            r#"{{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                 "sources":[{{"id":"a","name":"A","type":"webox","adapter":"reelbox","plugin":"nope"}}]}}"#
        ))
        .unwrap();
        assert!(problems(&bad, "").iter().any(|x| x.contains("不在 plugins 里")), "{:?}", problems(&bad, ""));

        // 插件在包里:通过,且装的时候 url 换成插件路径
        let ok = Index::parse(&format!(
            r#"{{"schema":"reelbox-index/1","name":"t","version":"1.0.0",
                 "plugins":[{{"id":"4kvm","name":"4K","path":"4kvm.reelbox.js","sha256":"{sha}"}}],
                 "sources":[{{"id":"a","name":"A","type":"webox","adapter":"reelbox","plugin":"4kvm"}}]}}"#
        ))
        .unwrap();
        assert_eq!(problems(&ok, ""), Vec::<String>::new());
        let src = ok.sources[0].to_source(Some("C:/plugins/4kvm.reelbox.js"));
        assert_eq!(src.url, "C:/plugins/4kvm.reelbox.js");
        assert_eq!(src.adapter, "reelbox");
    }

    #[test]
    fn parse_accepts_semver_and_explains_numeric() {
        let ok = Index::parse(r#"{"schema":"reelbox-index/1","name":"t","version":"1.0.0"}"#)
            .expect("应该能解析");
        assert_eq!(ok.version, "1.0.0");
        // 老配置把版本写成数字:报错要说人话,而不是 "invalid type: integer"
        let bad = Index::parse(r#"{"schema":"reelbox-index/1","name":"t","version":3}"#)
            .expect_err("数字版本应该被拒");
        assert!(bad.contains("要写成字符串"), "{bad}");
    }

    #[test]
    fn sub_source_maps_camel_case_fields() {
        let s: SubSource = serde_json::from_str(
            r#"{"id":"x","name":"X","type":"live","url":"https://x.com/a.m3u","adapter":"m3u",
                "verify":true,"verifyUrl":"https://x.com","posterRatio":"16:9"}"#,
        )
        .unwrap();
        let src = s.to_source(None);
        assert_eq!(src.kind, "live");
        assert_eq!(src.verify_url, "https://x.com");
        assert_eq!(src.poster_ratio, "16:9");
        assert!(src.verify);
        assert!(src.from.is_empty());
    }
}
