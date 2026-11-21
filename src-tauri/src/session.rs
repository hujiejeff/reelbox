// 人工校验会话(Cloudflare / 登录 / 扫码)。
//
// 为什么不能在沙箱 iframe 里做:iframe 的 origin 是 `null`,既没有 cookie,
// 也过不了人机校验。所以校验必须发生在**真实的 WebView**里。
//
// 形态:它不是独立窗口,而是 app 窗口里的一个**子 WebView**(Tauri 的
// `add_child`),外面包着我们自己的顶栏/底栏 —— 用户看到的就是 app 里的
// 一个二级页面。移动端以后用同一份壳,把子 WebView 换成原生 WebView。
//
// cookie 永不出宿主:用户点「完成」时,宿主把 cookie 罐快照下来存进会话,
// 插件只拿到会话 id。

use crate::commands::{PluginResponse, FETCH_MAX_BYTES, FETCH_UA};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Webview, WebviewUrl};

/// 注入到页面里:把真实 UA 用 cookie 回传(不做假导航 —— 那会把页面清空)
const UA_JS: &str = r#"
(function () {
  try {
    if (window.__rb_ua) return;
    window.__rb_ua = 1;
    document.cookie = '__rb_ua=' + encodeURIComponent(navigator.userAgent) + ';path=/';
  } catch (e) {}
})();
"#;

#[derive(Clone, Copy, PartialEq)]
enum State {
    Open,
    Done,
    Cancelled,
}

#[derive(Clone)]
struct Sess {
    id: String,
    label: String,
    host: String,
    origin: String,
    url: String,
    reason: String,
    opened_at: u64,
    state: State,
    /// 点「完成」时的快照:窗口关掉也还能用
    cookies: Vec<(String, String)>,
    ua: String,
}

#[derive(serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub host: String,
    pub origin: String,
    pub url: String,
    pub reason: String,
    pub opened_at: u64,
    pub done: bool,
    pub cancelled: bool,
    /// 窗口还在(用户能继续操作)
    pub alive: bool,
    pub cookies: usize,
}

fn store() -> &'static Mutex<HashMap<String, Sess>> {
    static S: OnceLock<Mutex<HashMap<String, Sess>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn info(s: &Sess) -> SessionInfo {
    SessionInfo {
        id: s.id.clone(),
        host: s.host.clone(),
        origin: s.origin.clone(),
        url: s.url.clone(),
        reason: s.reason.clone(),
        opened_at: s.opened_at,
        done: s.state == State::Done,
        cancelled: s.state == State::Cancelled,
        alive: s.state == State::Open,
        cookies: s.cookies.len(),
    }
}

/// https://a.b.com/x?y → ("a.b.com", "https://a.b.com")
fn split_url(url: &str) -> (String, String) {
    let (scheme, rest) = match url.split_once("://") {
        Some(v) => v,
        None => return (String::new(), String::new()),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    (host.to_string(), format!("{scheme}://{authority}"))
}

fn next_id() -> String {
    let n = now_secs() as u32;
    let salt = std::process::id();
    let mut h: u32 = 0x811c_9dc5;
    for b in n.to_le_bytes().iter().chain(salt.to_le_bytes().iter()) {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{:08x}", h)
}

fn webview_of(app: &AppHandle, id: &str) -> Option<Webview> {
    let label = store()
        .lock()
        .ok()
        .and_then(|m| m.get(id).map(|s| s.label.clone()))?;
    app.get_webview(&label)
}

/// 取当前窗口里的 cookie + UA,快照进会话
fn snapshot(app: &AppHandle, id: &str) {
    let (origin, url) = match store().lock().ok().and_then(|m| m.get(id).map(|s| (s.origin.clone(), s.url.clone()))) {
        Some(v) => v,
        None => return,
    };
    let Some(wv) = webview_of(app, id) else { return };
    let Ok(parsed) = url.parse::<tauri::Url>() else { return };
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut ua = String::new();
    if let Ok(list) = wv.cookies_for_url(parsed) {
        for c in list {
            let name = c.name().to_string();
            if name == "__rb_ua" {
                ua = reelbox_core::net::pct_decode(c.value());
                continue;
            }
            if name.is_empty() || name.starts_with("__rb_") {
                continue;
            }
            pairs.push((name, c.value().to_string()));
        }
    }
    if let Ok(mut m) = store().lock() {
        if let Some(s) = m.get_mut(id) {
            s.cookies = pairs.clone();
            if !ua.is_empty() {
                s.ua = ua.clone();
            }
        }
    }
    crate::logging::event(&format!(
        "VERIFY snapshot id={id} origin={origin} cookies={} ua={}",
        pairs.len(),
        if ua.is_empty() { "default" } else { "browser" }
    ));
}

/// 关掉子 WebView 并把状态定下来
fn teardown(app: &AppHandle, id: &str, state: State) {
    let label = store().lock().ok().and_then(|m| {
        m.get(id)
            .filter(|s| s.state == State::Open)
            .map(|s| s.label.clone())
    });
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.close();
        }
    }
    if let Ok(mut m) = store().lock() {
        if let Some(s) = m.get_mut(id) {
            s.state = state;
        }
    }
    let _ = app.emit("verify:close", serde_json::json!({ "id": id }));
}

/// 开一页校验。`rect` 是内容区(**物理像素**),由前端算好传进来。
/// 先建成 1×1,等前端把页面铺好再摆位置,避免闪一下盖住界面。
#[tauri::command]
pub async fn verify_start(
    app: AppHandle,
    url: String,
    reason: Option<String>,
    rect: Option<Vec<f64>>,
) -> Result<SessionInfo, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("校验地址必须以 http(s):// 开头".into());
    }
    if reelbox_core::plugin::net::is_private_url(&url) {
        return Err("拒绝为本机或内网地址打开校验窗口".into());
    }
    let (host, origin) = split_url(&url);
    if host.is_empty() {
        return Err("校验地址解析不出域名".into());
    }
    let id = next_id();
    let label = format!("verify-{id}");
    let reason = reason.unwrap_or_default();

    let (x, y, w, h) = match rect.as_deref() {
        Some([x, y, w, h]) => (*x, *y, (*w).max(1.0), (*h).max(1.0)),
        _ => (0.0, 0.0, 1.0, 1.0),
    };

    let window = app
        .get_window("main")
        .ok_or_else(|| "主窗口不见了".to_string())?;
    // 浏览器参数沿用主窗口:WebView2 的环境按参数建,不一致会 0x8007139F
    let mut builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(url.parse().map_err(|_| "地址格式不对".to_string())?),
    );
    if let Some(args) = app
        .config()
        .app
        .windows
        .first()
        .and_then(|w| w.additional_browser_args.clone())
    {
        builder = builder.additional_browser_args(&args);
    }
    let load_id = id.clone();
    builder = builder.on_page_load(move |wv, payload| {
        if matches!(payload.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
            let _ = wv.eval(UA_JS);
        }
        let _ = load_id;
    });

    window
        .add_child(
            builder,
            PhysicalPosition::new(x as i32, y as i32),
            PhysicalSize::new(w as u32, h as u32),
        )
        .map_err(|e| format!("校验页打不开: {e}"))?;

    let sess = Sess {
        id: id.clone(),
        label,
        host: host.clone(),
        origin,
        url,
        reason,
        opened_at: now_secs(),
        state: State::Open,
        cookies: Vec::new(),
        ua: String::new(),
    };
    let out = info(&sess);
    if let Ok(mut m) = store().lock() {
        m.insert(id.clone(), sess);
    }
    // 让前端把壳铺出来(壳由 app 自己画,不是这个 webview)
    let _ = app.emit(
        "verify:open",
        serde_json::json!({ "id": id, "host": host, "url": out.url, "reason": out.reason }),
    );
    crate::logging::event(&format!("VERIFY open id={id} host={host}"));
    Ok(out)
}

/// 壳算好内容区之后把子 WebView 摆过去(窗口缩放也要跟着调)
#[tauri::command]
pub fn verify_bounds(app: AppHandle, id: String, rect: Vec<f64>) -> Result<(), String> {
    if rect.len() != 4 {
        return Err("rect 需要 4 个数".into());
    }
    let Some(wv) = webview_of(&app, &id) else {
        return Err("校验页已经关了".into());
    };
    // 前端给的是物理像素(自己乘过 devicePixelRatio),这里不再做 DPI 换算 ——
    // 走 Logical 会被再乘一次,子 WebView 就会撑出内容区盖住底栏(实测)
    wv.set_position(PhysicalPosition::new(rect[0] as i32, rect[1] as i32))
        .and_then(|_| {
            wv.set_size(PhysicalSize::new(
                rect[2].max(1.0) as u32,
                rect[3].max(1.0) as u32,
            ))
        })
        .map_err(|e| e.to_string())
}

/// 用户点「完成」:快照 cookie → 关子 WebView → 会话留着给请求用
#[tauri::command]
pub async fn verify_finish(app: AppHandle, id: String) -> Result<SessionInfo, String> {
    snapshot(&app, &id);
    teardown(&app, &id, State::Done);
    let out = store()
        .lock()
        .ok()
        .and_then(|m| m.get(&id).map(info))
        .ok_or_else(|| "会话不存在".to_string())?;
    crate::logging::event(&format!(
        "VERIFY done id={id} host={} cookies={}",
        out.host, out.cookies
    ));
    Ok(out)
}

/// 用户返回/取消
#[tauri::command]
pub fn verify_cancel(app: AppHandle, id: String) -> Result<(), String> {
    teardown(&app, &id, State::Cancelled);
    crate::logging::event(&format!("VERIFY cancel id={id}"));
    Ok(())
}

/// 等用户把校验点完(适配器 `await ctx.human.verify(...)` 靠这个)
#[tauri::command]
pub async fn session_wait(id: String, timeout_sec: Option<u64>) -> Result<SessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || wait_blocking(&id, timeout_sec))
        .await
        .map_err(|e| e.to_string())?
}

fn wait_blocking(id: &str, timeout_sec: Option<u64>) -> Result<SessionInfo, String> {
    let limit = Duration::from_secs(timeout_sec.unwrap_or(180).clamp(10, 900));
    let started = std::time::Instant::now();
    loop {
        let cur = {
            let m = store().lock().map_err(|_| "会话表坏了".to_string())?;
            m.get(id).cloned()
        };
        let Some(s) = cur else {
            return Err("会话不存在或已撤销".into());
        };
        if s.state == State::Cancelled {
            return Err(format!("{} 的校验被取消", s.host));
        }
        if s.state == State::Done {
            return Ok(info(&s));
        }
        if started.elapsed() > limit {
            return Err(format!("等 {} 的校验超时", s.host));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[tauri::command]
pub fn session_list() -> Vec<SessionInfo> {
    let mut v: Vec<SessionInfo> = store()
        .lock()
        .map(|m| m.values().map(info).collect())
        .unwrap_or_default();
    v.sort_by_key(|s| s.opened_at);
    v
}

#[tauri::command]
pub fn session_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(wv) = webview_of(&app, &id) {
        let _ = wv.close();
    }
    if let Ok(mut m) = store().lock() {
        m.remove(&id);
    }
    let _ = app.emit("verify:close", serde_json::json!({ "id": id }));
    crate::logging::event(&format!("VERIFY close id={id}"));
    Ok(())
}

/// 带会话 cookie 的请求。适配器 `ctx.http.get(url, {session})` 走这条。
#[tauri::command]
pub async fn session_fetch(
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<PluginResponse, String> {
    let snap = store()
        .lock()
        .ok()
        .and_then(|m| {
            m.get(&id)
                .filter(|s| s.state == State::Done)
                .map(|s| (s.cookies.clone(), s.ua.clone()))
        })
        .ok_or_else(|| "会话不可用(没完成校验或已撤销)".to_string())?;
    let (cookies, ua) = snap;
    let agent = if ua.is_empty() { FETCH_UA.to_string() } else { ua };
    tauri::async_runtime::spawn_blocking(move || fetch_with(&url, &agent, &cookies, headers.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_with(
    url: &str,
    agent: &str,
    cookies: &[(String, String)],
    headers: Option<&HashMap<String, String>>,
) -> Result<PluginResponse, String> {
    use std::io::Read as _;
    let started = std::time::Instant::now();
    let _ = started;
    let mut target = url.to_string();
    for _ in 0..6 {
        if reelbox_core::plugin::net::is_private_url(&target) {
            return Err(format!("拒绝访问本机或内网地址: {target}"));
        }
        let mut list: Vec<(&str, String)> = vec![
            ("User-Agent", agent.to_string()),
            ("Referer", target.clone()),
        ];
        if !cookies.is_empty() {
            let jar = cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            list.push(("Cookie", jar));
        }
        if let Some(map) = headers {
            for (k, v) in map {
                match k.to_ascii_lowercase().as_str() {
                    "host" | "content-length" | "connection" | "transfer-encoding" | "cookie" => {
                        continue
                    }
                    _ => list.push((k.as_str(), v.clone())),
                }
            }
        }
        let resp = reelbox_core::net::http::get_no_redirect(&target, &list)
            .map(|u| u.resp)
            .map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status().as_u16();
        if (300..400).contains(&status) {
            if let Some(loc) = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
            {
                target = crate::commands::absolute_url(&target, &loc);
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
        return Ok(PluginResponse {
            status,
            url: target,
            mime,
            body: String::from_utf8_lossy(&body).to_string(),
        });
    }
    Err(format!("重定向次数过多: {url}"))
}
