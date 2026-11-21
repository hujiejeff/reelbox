//! 前端能调的全部能力。网络是阻塞的,统一丢到线程池里跑。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use reelbox_core::model::{Detail, Filter, Page, Stream};
use reelbox_core::plugin;
use reelbox_core::source::{cms::Client, fill_adapters, Source};
use tauri::ipc::Response;

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("TASK: {e}"))?
}

/// 源的持久化位置:桌面仍是 %APPDATA%/reelbox/sources.json,
/// 移动端是应用私有目录(见 `paths.rs`)
fn sources_path() -> std::path::PathBuf {
    crate::paths::sources_path()
}

/// 读源列表:**默认没有源**。文件不存在、读不出来、解析失败、里面是空数组,
/// 一律返回空列表 —— 首次启动不写任何内置源,由用户在界面上「导入源 / 批量导入」
/// (空态见 ui/app.js 的 showNoSources / renderSourceManager)。
pub fn load_sources() -> Vec<Source> {
    let path = sources_path();
    let Some(list) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Source>>(&text).ok())
    else {
        return Vec::new();
    };
    migrate_adapters(&path, list)
}

/// 老配置没有 `adapter`:按 `type` / 地址补一个(规则在 core 的 `fill_adapters`),
/// 补到了才写回文件。
///
/// 幂等:第二次读到已经填好的就一条也不补,文件不动。`type` 一个字都不动 ——
/// 界面还在用它(徽标、解析器分块);运行时只看 `adapter`。写回失败不影响这次加载:
/// 内存里已经补好了,下次启动再补。
fn migrate_adapters(path: &std::path::Path, mut list: Vec<Source>) -> Vec<Source> {
    if fill_adapters(&mut list) == 0 {
        return list;
    }
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(path, text);
    }
    list
}

#[tauri::command]
pub fn save_sources(list: Vec<Source>) -> Result<(), String> {
    let path = sources_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&list).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写文件失败: {e}"))
}

/// 插件里的网络请求:统一带 UA,并且和别处一样走代理解析链
fn boa_fetch() -> Box<dyn Fn(&str) -> Option<String>> {
    Box::new(|url: &str| {
        let headers = [("User-Agent", FETCH_UA.to_string())];
        reelbox_core::net::http::get(url, &headers)
            .ok()
            .and_then(|r| r.text().ok())
    })
}

/// 一条源该走哪条路。判定只看 `adapter`(见 `docs/ARCHITECTURE.md` 第 2 节):
/// 判定发生在导入,落盘后运行时不再重新猜格式,否则会出现「昨天能看、今天变成
/// 另一个适配器」这种查不出来的鬼故事。
#[derive(Debug, Clone, Copy)]
enum Route {
    /// `vod-rs`:苹果 CMS 接口(JSON / XML)的 **Rust 实现**,只留着回滚用。
    /// 默认的 `vod` 已经迁成内置 JS 适配器(见 docs/ARCHITECTURE.md P3)。
    Cms,
    /// `vod` / `reelbox` / `webox` / `iplayr`:都是 js 适配器,交前端沙箱(ui/plugin-host.js);
    /// 显式要求回退时才走 boa
    Plugin,
}

fn route(src: &Source) -> Result<Route, String> {
    match src.adapter() {
        // 回滚开关:把源的 adapter 改成 `vod-rs` 就回到原来那套 Rust 实现,
        // 代码先留着(迁移期两边都跑得动,见 P3 的验收)。
        "vod-rs" => Ok(Route::Cms),
        // 解析器不是源:它只把一张网页变成播放地址,没有列表 / 详情
        "parser" => Err(PARSER_IS_NOT_SOURCE.into()),
        // vod / iplayr / reelbox / webox 都是 js 适配器,交给沙箱;认不出的适配器也按插件试。
        // 它们的区别只在「插件文件从哪儿来」,见 plugin_path / plugin_options_json。
        _ => Ok(Route::Plugin),
    }
}

/// 一条源要跑的插件文件。
///
/// `reelbox` / `webox`:源的地址就是插件文件本身(规则全在里面)。
/// `iplayr` / `vod`:插件是**随包安装的适配器**,同一个适配器配不同站点 —— 所以
/// `url` 是站点配置 / 接口地址,插件文件得从 [`crate::builtin`] 拿
/// (见 `docs/ARCHITECTURE.md` 第 2 节)。
fn plugin_path(src: &Source) -> Result<std::path::PathBuf, String> {
    match src.adapter() {
        "iplayr" => crate::builtin::adapter_path("iplayr").ok_or_else(|| {
            "内置 iplayr 引擎没装上(插件目录里找不到 builtin/iplayr.adapter.js):重装或重编应用即可".to_string()
        }),
        "vod" => crate::builtin::adapter_path("vod").ok_or_else(|| {
            "内置 vod 适配器没装上(插件目录里找不到 builtin/vod.adapter.js):重装或重编应用即可".to_string()
        }),
        _ => Ok(std::path::PathBuf::from(&src.url)),
    }
}

/// 交给插件的 `options`。
///
/// 引擎类适配器的「解析哪个站」在 `url` 里(iplayr 的站点配置、vod 的接口地址),
/// 插件从 `options.config` 读;其余源的 `options` 是用户自己填的
/// (见 docs/ENGINE-PLUGINS.md)。`format` 交给适配器自己按地址判(`"auto"`)。
fn plugin_options_json(src: &Source) -> String {
    match src.adapter() {
        "iplayr" => serde_json::json!({ "config": src.url }).to_string(),
        "vod" => serde_json::json!({ "config": src.url, "format": "auto" }).to_string(),
        _ => {
            if src.options.is_null() {
                "{}".into()
            } else {
                serde_json::to_string(&src.options).unwrap_or_else(|_| "{}".into())
            }
        }
    }
}

const PARSER_IS_NOT_SOURCE: &str =
    "解析器不是源:它只把网页变成播放地址,不能取列表 / 详情 / 播放。请换一个源,或在「设置 → 源」里用它的站点";

/* ---------- 插件运行时:两套引擎 ---------- */

/// 默认引擎是 WebView 沙箱(前端 ui/plugin-host.js)。
/// 想把钩子重新丢回 Rust 的 boa,把环境变量设成 boa(或启动参数加 `--engine=boa`)。
const NO_BOA: &str = "插件源由前端沙箱执行(ui/plugin-host.js);若要回退 boa,请设置 REELBOX_PLUGIN_ENGINE=boa";

fn boa_engine() -> bool {
    std::env::var("REELBOX_PLUGIN_ENGINE")
        .map(|v| v.eq_ignore_ascii_case("boa"))
        .unwrap_or(false)
}

/// 插件源码交给前端沙箱执行:Rust 只负责把文件读出来。
#[tauri::command]
pub fn plugin_read(path: String) -> Result<String, String> {
    const MAX_PLUGIN_BYTES: u64 = 8 << 20;
    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读插件失败: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是文件: {path}"));
    }
    if meta.len() > MAX_PLUGIN_BYTES {
        return Err(format!("插件过大({} 字节): {path}", meta.len()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读插件失败: {e}"))
}

/// 导入时读本地文件(源配置 / 集合 / 插件源码都可能是本地文件)。
/// 前端只拿文本,判型在 ui/app.js 的 analyzeImport 里做。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_IMPORT_BYTES: u64 = 8 << 20;
    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读文件失败: {e}"))?;
    if !meta.is_file() {
        return Err(format!("不是文件: {path}"));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!("文件过大({} 字节): {path}", meta.len()));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读文件失败: {e}"))
}

#[derive(Debug, serde::Serialize)]
pub struct PluginResponse {
    pub status: u16,
    pub url: String,
    pub mime: String,
    pub body: String,
}

const FETCH_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_MAX_BYTES: u64 = 32 << 20;

/// 插件里 `ctx.http.get` 的真正出口:挡内网、跟重定向时每一跳都重新挡。
#[tauri::command]
pub async fn plugin_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<PluginResponse, String> {
    blocking(move || fetch_guarded(&url, headers.as_ref())).await
}

fn fetch_guarded(url: &str, headers: Option<&HashMap<String, String>>) -> Result<PluginResponse, String> {
    use std::io::Read as _;
    // 自己跟重定向:每一跳都要重新做一次"是不是内网"的检查
    let client = reelbox_core::net::http::client_no_redirect();
    let mut target = url.to_string();
    for _ in 0..6 {
        if reelbox_core::plugin::net::is_private_url(&target) {
            return Err(format!("拒绝访问本机或内网地址: {target}"));
        }
        let mut list: Vec<(&str, String)> = vec![("User-Agent", FETCH_UA.to_string())];
        if let Some(map) = headers {
            for (k, v) in map {
                match k.to_ascii_lowercase().as_str() {
                    // 别让插件改掉连接层面的关键头
                    "host" | "content-length" | "connection" | "transfer-encoding" => continue,
                    _ => list.push((k.as_str(), v.clone())),
                }
            }
        }
        let resp = reelbox_core::net::http::get_once(&client, &target, &list)
            .map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            let location = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            if let Some(loc) = location {
                target = absolute_url(&target, &loc);
                continue;
            }
        }
        let mime = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/html")
            .to_string();
        let mut body = Vec::new();
        let mut reader = resp;
        reader
            .by_ref()
            .take(FETCH_MAX_BYTES)
            .read_to_end(&mut body)
            .map_err(|e| format!("读响应失败: {e}"))?;
        let text = String::from_utf8_lossy(&body).to_string();
        return Ok(PluginResponse { status, url: target, mime, body: text });
    }
    Err(format!("重定向次数过多: {url}"))
}

/// 相对 Location 补成绝对地址(只处理 http/https,其余原样返回留给下一跳拒绝)
fn absolute_url(base: &str, loc: &str) -> String {
    let lower = loc.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return loc.to_string();
    }
    let (scheme, rest) = match base.split_once("://") {
        Some(v) => v,
        None => return loc.to_string(),
    };
    if loc.starts_with("//") {
        return format!("{scheme}:{loc}");
    }
    let host_end = rest.find('/').unwrap_or(rest.len());
    let origin = &base[..scheme.len() + 3 + host_end];
    if loc.starts_with('/') {
        return format!("{origin}{loc}");
    }
    let path = &rest[host_end..];
    let dir = match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "/",
    };
    format!("{origin}{dir}{loc}")
}

/// 本次会话里允许经本地反代播放的地址。
/// 只有 `play`(Rust 侧)和前端沙箱 `play` 钩子的结果能进来,
/// 沙箱 iframe 拿不到 Tauri IPC,所以插件没法自己往里塞地址。
fn allowed_streams() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn allow_stream(url: &str) {
    if url.is_empty() {
        return;
    }
    if let Ok(mut set) = allowed_streams().lock() {
        set.insert(url.to_string());
    }
}

/// 前端在沙箱里跑完 play 钩子后登记拿到的地址
#[tauri::command]
pub fn plugin_stream_allow(urls: Vec<String>) -> usize {
    for u in &urls {
        allow_stream(u);
    }
    allowed_streams().lock().map(|s| s.len()).unwrap_or(0)
}

#[tauri::command]
pub fn selftest_mode() -> bool {
    selftest_enabled()
}

/// 自检可以指定片名(`--selftest-title=折月亮` 或 `REELBOX_SELFTEST_TITLE`)。
/// 用来复现"某个具体片名播不了",默认空串表示按列表第一条。
#[tauri::command]
pub fn selftest_title() -> String {
    std::env::args()
        .find_map(|a| a.strip_prefix("--selftest-title=").map(|s| s.to_string()))
        .or_else(|| std::env::var("REELBOX_SELFTEST_TITLE").ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn selftest_enabled() -> bool {
    static FLAG: OnceLock<bool> = OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::args().any(|a| a == "--selftest")
            || std::env::var("REELBOX_SELFTEST").map(|v| v == "1").unwrap_or(false)
    })
}

/// 启动参数里开启 boa 引擎(`--engine=boa`),在 lib.rs 里调用
pub fn apply_engine_arg(args: &[String]) {
    if args.iter().any(|a| a == "--engine=boa") {
        std::env::set_var("REELBOX_PLUGIN_ENGINE", "boa");
    }
}

#[tauri::command]
pub fn list_sources() -> Vec<Source> {
    load_sources()
}

#[tauri::command]
pub async fn list_items(source: Source, page: u32, classify: String) -> Result<Page, String> {
    if let Route::Cms = route(&source)? {
        return blocking(move || Client::new(source).page(page, &classify)).await;
    }
    // 默认引擎是前端沙箱;只有显式要求回退时才走 boa
    if !boa_engine() {
        return Err(NO_BOA.into());
    }
    blocking(move || {
        let path = plugin_path(&source)?;
        // 两种契约都喂:page(WeBox) + cursor(filters 版本插件) + filters + options
        let c = classify.replace('"', "");
        let cursor = if page <= 1 { "null".to_string() } else { format!("\"{}\"", page) };
        let arg = format!(
            "{{\"page\":{},\"classify\":\"{}\",\"cursor\":{},\"filters\":{{\"classify\":\"{}\"}},\"options\":{}}}",
            page, c, cursor, c, plugin_options_json(&source)
        );
        let out = plugin::run_file(&path, "list", &arg, boa_fetch())?;
        plugin::adapt::page_from_json(&out)
    })
    .await
}

#[tauri::command]
pub async fn search(source: Source, keyword: String, page: u32) -> Result<Page, String> {
    blocking(move || Client::new(source).search(&keyword, page)).await
}

#[tauri::command]
pub async fn detail(source: Source, id: String) -> Result<Detail, String> {
    if let Route::Cms = route(&source)? {
        return blocking(move || Client::new(source).detail(&id)).await;
    }
    // 默认引擎是前端沙箱;只有显式要求回退时才走 boa
    if !boa_engine() {
        return Err(NO_BOA.into());
    }
    blocking(move || {
        use reelbox_core::model::{Detail, Episode, Group};
        let path = plugin_path(&source)?;
        let did = id.clone();
        let arg = format!(
            "{{\"id\":\"{}\",\"options\":{}}}",
            id.replace('"', ""),
            plugin_options_json(&source)
        );
        let out = plugin::run_file(&path, "detail", &arg, boa_fetch())?;
        let v: serde_json::Value =
            serde_json::from_str(&out).map_err(|e| format!("detail 返回值不是 JSON: {e}"))?;
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let mut groups = Vec::new();
        if let Some(gs) = v.get("groups").and_then(|x| x.as_array()) {
            for (i, g) in gs.iter().enumerate() {
                let mut eps = Vec::new();
                if let Some(es) = g.get("episodes").and_then(|x| x.as_array()) {
                    for (j, e) in es.iter().enumerate() {
                        let eid = e.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        if eid.is_empty() {
                            continue;
                        }
                        let name = e
                            .get("name")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("第 {} 集", j + 1));
                        eps.push(Episode { id: eid, name });
                    }
                }
                let gname = g
                    .get("name")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("线路 {}", i + 1));
                groups.push(Group { id: format!("g{}", i), name: gname, episodes: eps });
            }
        }
        Ok(Detail { id: did, title: s("title"), poster: s("poster"), summary: s("summary"), groups })
    })
    .await
}

#[tauri::command]
pub async fn play(source: Source, episode_id: String) -> Result<Stream, String> {
    if let Route::Cms = route(&source)? {
        let st = blocking(move || Client::new(source).stream(&episode_id)).await?;
        allow_stream(&st.url);
        for o in &st.options {
            allow_stream(&o.url);
        }
        return Ok(st);
    }
    // 默认引擎是前端沙箱;只有显式要求回退时才走 boa
    if !boa_engine() {
        return Err(NO_BOA.into());
    }
    blocking(move || {
        let path = plugin_path(&source)?;
        let arg = format!(
            "{{\"id\":\"{}\",\"options\":{}}}",
            episode_id.replace('"', ""),
            plugin_options_json(&source)
        );
        let out = plugin::run_file(&path, "play", &arg, boa_fetch())?;
        let mut v: serde_json::Value =
            serde_json::from_str(&out).map_err(|e| format!("play 返回值不是 JSON: {e}"))?;
        // play 允许返回数组(多清晰度):url 取第一档,其余放进 options
        let mut options = Vec::new();
        if let Some(arr) = v.as_array() {
            for (i, one) in arr.iter().enumerate() {
                let u = one.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if u.is_empty() {
                    continue;
                }
                let q = one
                    .get("quality")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("档 {}", i + 1));
                options.push(reelbox_core::model::StreamOption { quality: q, url: u });
            }
            v = arr.first().cloned().unwrap_or(serde_json::Value::Null);
        }
        let url = v
            .get("url")
            .and_then(|x| x.as_str())
            .ok_or("play 没返回 url")?
            .to_string();
        let mut headers = std::collections::BTreeMap::new();
        if let Some(h) = v.get("headers").and_then(|x| x.as_object()) {
            for (k, val) in h {
                if let Some(sv) = val.as_str() {
                    headers.insert(k.clone(), sv.to_string());
                }
            }
        }
        let st = Stream {
            url,
            mime: "application/vnd.apple.mpegurl".into(),
            headers,
            options,
            // boa 回退引擎不发分享页请求:它给的地址就是播放地址
            page: false,
        };
        allow_stream(&st.url);
        for o in &st.options {
            allow_stream(&o.url);
        }
        Ok(st)
    })
    .await
}

#[tauri::command]
pub async fn filters(source: Source) -> Result<Vec<Filter>, String> {
    if let Route::Cms = route(&source)? {
        return Ok(tauri::async_runtime::spawn_blocking(move || Client::new(source).filters())
            .await
            .unwrap_or_default());
    }
    // 默认引擎是前端沙箱;只有显式要求回退时才走 boa
    if !boa_engine() {
        return Err(NO_BOA.into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let path = match plugin_path(&source) {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        let arg = format!("{{\"options\":{}}}", plugin_options_json(&source));
        plugin::plugin_filters_with(&path, &arg, boa_fetch())
    })
    .await
    .unwrap_or_default())
}

/// 取一张封面并转成 jpeg,直接以二进制回给前端(不占 JSON 体积)。
#[tauri::command]
pub async fn poster(url: String) -> Result<Response, String> {
    let bytes = blocking(move || {
        reelbox_core::image::poster(&url, reelbox_core::source::cms::DEFAULT_UA)
    })
    .await?;
    Ok(Response::new(bytes))
}

/// 把真实流地址包成本地代理地址(带 UA/Referer,并改写 m3u8 内部分片)。
/// 只认本次会话里由 play 拿到的地址:插件没法自己把任意 URL 塞进来。
#[tauri::command]
pub fn player_url(stream: Stream) -> Result<String, String> {
    let allowed = allowed_streams()
        .lock()
        .map(|s| s.contains(&stream.url))
        .unwrap_or(false);
    if !allowed {
        return Err("这个地址不在本次会话的播放白名单里".into());
    }
    let list: Vec<Vec<String>> = stream
        .headers
        .iter()
        .map(|(k, v)| vec![k.clone(), v.clone()])
        .collect();
    let h = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    Ok(crate::proxy::wrap(&stream.url, &h))
}

/// 播放前探一眼真实内容。
/// 插件按地址后缀猜 mime,可签名地址没有后缀:4k影视 有些集给的是 mp4 却写成
/// `application/vnd.apple.mpegurl`,丢给 hls.js 就是 manifestParsingError。
/// 这里只看头几个字节,让前端按事实选 hls.js 还是原生 <video>。
#[derive(Debug, serde::Serialize)]
pub struct StreamProbe {
    /// hls / file / unknown
    pub kind: String,
    pub status: u16,
    pub mime: String,
    pub bytes: usize,
    pub head: String,
}

#[tauri::command]
pub async fn stream_kind(stream: Stream) -> Result<StreamProbe, String> {
    let allowed = allowed_streams()
        .lock()
        .map(|s| s.contains(&stream.url))
        .unwrap_or(false);
    if !allowed {
        return Err("这个地址不在本次会话的播放白名单里".into());
    }
    blocking(move || probe_stream(&stream)).await
}

fn probe_stream(stream: &Stream) -> Result<StreamProbe, String> {
    use std::io::Read as _;
    let mut list: Vec<(&str, String)> = vec![
        ("User-Agent", FETCH_UA.to_string()),
        ("Accept-Encoding", "identity".to_string()),
        ("Range", "bytes=0-4095".to_string()),
    ];
    for (k, v) in &stream.headers {
        if k.eq_ignore_ascii_case("host") || k.eq_ignore_ascii_case("range") {
            continue;
        }
        list.push((k.as_str(), v.clone()));
    }
    let resp = reelbox_core::net::http::get(&stream.url, &list)
        .map_err(|e| format!("探测播放地址失败: {e}"))?;
    let status = resp.status().as_u16();
    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut head = Vec::new();
    let mut reader = resp;
    let _ = reader.by_ref().take(4096).read_to_end(&mut head);
    let kind = classify_stream(&mime, &head).to_string();
    crate::logging::event(&format!(
        "PROBE kind={kind} status={status} mime={mime} bytes={} url={}",
        head.len(),
        stream.url.chars().take(120).collect::<String>()
    ));
    Ok(StreamProbe {
        kind,
        status,
        mime,
        bytes: head.len(),
        head: crate::logging::one_line(&String::from_utf8_lossy(&head[..head.len().min(120)]), 120),
    })
}

/// 按实际字节判断:hls 清单 / 媒体文件本体 / 看不出来
fn classify_stream(mime: &str, head: &[u8]) -> &'static str {
    if head.starts_with(b"#EXTM3U") {
        return "hls";
    }
    if let Some(text) = std::str::from_utf8(head).ok() {
        let s = text.trim_start_matches('\u{feff}').trim_start();
        if s.starts_with("#EXTM3U") {
            return "hls";
        }
    }
    if head.len() >= 8 {
        // ISO BMFF: [size][ftyp|moov|mdat|free|skip|wide|styp]
        let tag = &head[4..8];
        let boxes: [&[u8]; 7] = [b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"styp"];
        if boxes.iter().any(|b| tag == *b) {
            return "file";
        }
    }
    let m = mime.to_ascii_lowercase();
    if m.starts_with("video/") || m.starts_with("audio/") {
        return "file";
    }
    // MPEG-TS 的同步字节
    if !head.is_empty() && head[0] == 0x47 && !m.contains("text") {
        return "file";
    }
    if m.contains("mpegurl") {
        return "hls";
    }
    "unknown"
}

/// 前端日志落盘:写到 %APPDATA%/reelbox/reelbox.log(和反代日志同一个文件)
#[tauri::command]
pub fn append_log(line: String) {
    crate::logging::append(&line);
}

/// 设置页「调试 → 打开日志」:定位到日志文件(Windows 资源管理器 /select)。
#[tauri::command]
pub fn open_log() -> Result<String, String> {
    let path = crate::logging::log_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    if !path.exists() {
        // 还没写过日志:先落一个空文件,否则"定位到文件"会落到目录上
        std::fs::write(&path, b"").map_err(|e| format!("建日志文件失败: {e}"))?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("打开日志失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开日志失败: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(&path).to_path_buf();
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开日志失败: {e}"))?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// 设置页「关于」用的构建信息。
#[derive(Debug, serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    /// release / debug · os · arch
    pub build: String,
    pub log_path: String,
    pub sources_path: String,
    /// 插件钩子现在跑在哪套引擎里
    pub plugin_engine: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build: format!("{} · {} {}", profile, std::env::consts::OS, std::env::consts::ARCH),
        log_path: crate::logging::log_path().to_string_lossy().to_string(),
        sources_path: sources_path().to_string_lossy().to_string(),
        plugin_engine: if boa_engine() { "Boa(Rust)".to_string() } else { "WebView 沙箱".to_string() },
    }
}

/// 内置适配器清单:`{"iplayr": "…/plugins/builtin/iplayr.adapter.js"}`。
///
/// 前端拿它做两件事:导入时探测 iplayr 格式要跑这个文件;建出来的源(`adapter=iplayr`)
/// 运行时也调它 —— 源的 `url` 是站点配置,插件文件不进 `url`(见 docs/ARCHITECTURE.md 第 2 节)。
#[tauri::command]
pub fn builtin_adapters() -> HashMap<String, String> {
    crate::builtin::adapters()
}

/// 自检摘要落盘:`docs/selftest-report.json`(找不到就退回 %APPDATA%/reelbox/)。
/// 返回实际写入的路径,前端会把它写进日志。
#[tauri::command]
pub fn selftest_report(json: String) -> Result<String, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut dir = cwd;
    // 从当前目录往上找带 docs/ 的那一层(Start-Process 的 WorkingDirectory 是仓库根)
    let mut target = None;
    for _ in 0..4 {
        if dir.join("docs").is_dir() {
            target = Some(dir.join("docs").join("selftest-report.json"));
            break;
        }
        if !dir.pop() {
            break;
        }
    }
    let path = target.unwrap_or_else(|| {
        crate::logging::log_path()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(std::env::temp_dir)
            .join("selftest-report.json")
    });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    std::fs::write(&path, json).map_err(|e| format!("写报告失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 保存一个导入的插件文件,返回 (路径, 名称, id, 类型)
///
/// `kind` 是 `vod`(源插件)或 `parser`(解析器):前端按它决定是进源下拉还是进
/// 「设置 → 源」的解析器块。判据见 `plugin::parse_meta_hinted` —— 用户选文件时的
/// 文件名后缀 `.parser.js` 也参与判断,所以这里把 `file_name` 当提示传进去。
#[tauri::command]
pub fn save_plugin(file_name: String, text: String) -> Result<serde_json::Value, String> {
    let meta = plugin::parse_meta_hinted(&text, Some(&file_name))?;
    // 和源配置同一个数据目录(移动端没有 %APPDATA%,见 paths.rs)
    let dir = crate::paths::plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;

    let safe: String = meta
        .id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    // 新导入的插件写原生后缀;老的 `.webox.js` 文件照样认(plugin_read / `derive_adapter`)。
    // 解析器单独一个后缀,重新导入时不用再读源码也能认出来。
    let suffix = if meta.kind == plugin::KIND_PARSER {
        ".reelbox.parser.js"
    } else {
        ".reelbox.js"
    };
    let path = dir.join(format!("{safe}{suffix}"));
    std::fs::write(&path, &text).map_err(|e| format!("写插件失败: {e}"))?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "name": if meta.name.is_empty() { file_name } else { meta.name },
        "id": safe,
        "kind": meta.kind,
        "version": meta.version,
    }))
}
