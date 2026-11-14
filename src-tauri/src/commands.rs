//! 前端能调的全部能力。网络是阻塞的,统一丢到线程池里跑。

use reelbox_core::model::{Detail, Filter, Page, Stream};
use reelbox_core::plugin;
use reelbox_core::source::{self, cms::Client, Source};
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

/// 源的持久化位置:%APPDATA%/reelbox/sources.json
fn sources_path() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("reelbox").join("sources.json")
}

/// 读源列表:文件不存在或解析失败时回落到内置三个
pub fn load_sources() -> Vec<Source> {
    let path = sources_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<Source>>(&text) {
            if !list.is_empty() {
                return list;
            }
        }
    }
    source::defaults()
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

/// 插件里的网络请求:统一带 UA
fn plugin_fetch() -> Box<dyn Fn(&str) -> Option<String>> {
    Box::new(|url: &str| {
        ureq::get(url)
            .timeout(std::time::Duration::from_secs(15))
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36")
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
    })
}

fn is_plugin(src: &Source) -> bool {
    src.kind == "webox"
}

#[tauri::command]
pub fn list_sources() -> Vec<Source> {
    load_sources()
}

#[tauri::command]
pub async fn list_items(source: Source, page: u32, classify: String) -> Result<Page, String> {
    if is_plugin(&source) {
        return blocking(move || {
            let path = std::path::PathBuf::from(&source.url);
            let arg = format!(
                "{{\"page\":{},\"classify\":\"{}\"}}",
                page,
                classify.replace('"', "")
            );
            let out = plugin::run_file(&path, "list", &arg, plugin_fetch())?;
            plugin::adapt::page_from_json(&out)
        })
        .await;
    }
    blocking(move || Client::new(source).page(page, &classify)).await
}

#[tauri::command]
pub async fn search(source: Source, keyword: String, page: u32) -> Result<Page, String> {
    blocking(move || Client::new(source).search(&keyword, page)).await
}

#[tauri::command]
pub async fn detail(source: Source, id: String) -> Result<Detail, String> {
    blocking(move || Client::new(source).detail(&id)).await
}

#[tauri::command]
pub async fn play(source: Source, episode_id: String) -> Result<Stream, String> {
    if is_plugin(&source) {
        return blocking(move || {
            let path = std::path::PathBuf::from(&source.url);
            let arg = format!("{{\"id\":\"{}\"}}", episode_id.replace('"', ""));
            let out = plugin::run_file(&path, "play", &arg, plugin_fetch())?;
            let v: serde_json::Value =
                serde_json::from_str(&out).map_err(|e| format!("play 返回值不是 JSON: {e}"))?;
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
            Ok(Stream {
                url,
                mime: "application/vnd.apple.mpegurl".into(),
                headers,
            })
        })
        .await;
    }
    blocking(move || Client::new(source).stream(&episode_id)).await
}

#[tauri::command]
pub async fn filters(source: Source) -> Vec<Filter> {
    tauri::async_runtime::spawn_blocking(move || Client::new(source).filters())
        .await
        .unwrap_or_default()
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

/// 把真实流地址包成本地代理地址(带 UA/Referer,并改写 m3u8 内部分片)
#[tauri::command]
pub fn player_url(stream: Stream) -> String {
    let list: Vec<Vec<String>> = stream
        .headers
        .iter()
        .map(|(k, v)| vec![k.clone(), v.clone()])
        .collect();
    let h = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
    crate::proxy::wrap(&stream.url, &h)
}

/// 前端日志落盘:写到临时目录下的 reelbox/reelbox.log
#[tauri::command]
pub fn append_log(line: String) {
    use std::io::Write as _;
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("reelbox");
    let path = dir.join("reelbox.log");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("log: 建目录失败 {e}");
        return;
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => { let _ = writeln!(f, "{line}"); }
        Err(e) => eprintln!("log: 写 {} 失败: {e}", path.display()),
    }
}

