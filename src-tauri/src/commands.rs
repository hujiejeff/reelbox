//! 前端能调的全部能力。网络是阻塞的,统一丢到线程池里跑。

use reelbox_core::model::{Detail, Filter, Page, Stream};
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

#[tauri::command]
pub fn list_sources() -> Vec<Source> {
    source::defaults()
}

#[tauri::command]
pub async fn list_items(source: Source, page: u32, classify: String) -> Result<Page, String> {
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

