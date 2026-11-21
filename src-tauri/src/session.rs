// 人工校验会话(Cloudflare / 登录 / 扫码)。
//
// 思路:沙箱 iframe 的 origin 是 null,既没有 cookie 也过不了人机校验,
// 所以校验必须发生在**真实的顶层窗口**里。窗口由宿主创建,用户点完以后
// 宿主自己留着这个窗口的 cookie 罐;适配器只拿到一个会话 id,cookie 永不出宿主。
//
// 适配器侧:
//   const s = await ctx.human.verify({ url, reason });
//   const html = await ctx.http.get(url, { session: s.id });

use crate::commands::{PluginResponse, FETCH_MAX_BYTES, FETCH_UA};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 注入到页面里的小工具条 —— 用户点"我已完成"就是导航到这些假域名,
/// 由 on_navigation 拦下来(不真跳转),这样远程页面拿不到任何 IPC。
const DONE_HOST: &str = "done.verify.reelbox.invalid";
const CANCEL_HOST: &str = "cancel.verify.reelbox.invalid";

// 页面可能一直卡在 loading(Cloudflare 挑战就是这样),所以不能等"加载完成":
// 进页面就开始轮询 DOM,拿到 body 就把工具条挂上去,顺便把真实 UA 报回来。
const INJECT_JS: &str = r#"
(function () {
  if (window.__rb_inject) return;
  window.__rb_inject = 1;
  var tries = 0;
  var start = function () {
    try {
      if (!window.__rb_ua) {
        window.__rb_ua = 1;
        // UA 走 cookie 回传,不做假导航 —— 假导航会把当前页面清空(实测)
        try { document.cookie = '__rb_ua=' + encodeURIComponent(navigator.userAgent) + ';path=/'; } catch (e) {}
      }
      if (document.getElementById('__rb_bar')) return;
      var host = document.body || document.documentElement;
      if (!host) { if (tries++ < 150) setTimeout(start, 200); return; }
      var mk = function (tag, css, text) {
        var e = document.createElement(tag);
        e.style.cssText = css;
        if (text) e.textContent = text;
        return e;
      };
      var box = mk('div', 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:14px;background:rgba(18,18,22,.93);color:#fff;font:13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 10px 34px rgba(0,0,0,.5)', '');
      box.id = '__rb_bar';
      var txt = mk('span', 'opacity:.85', '完成校验后点这里');
      var ok = mk('button', 'border:0;border-radius:9px;padding:7px 14px;background:#4f8cff;color:#fff;font:600 13px system-ui;cursor:pointer', '我已完成');
      ok.onclick = function () { location.href = 'https://done.verify.reelbox.invalid/'; };
      box.appendChild(txt);
      box.appendChild(ok);
      host.appendChild(box);
    } catch (e) {
      if (tries++ < 150) setTimeout(start, 200);
    }
  };
  start();
})();
"#;

#[derive(Clone)]
struct Sess {
    id: String,
    label: String,
    host: String,
    origin: String,
    url: String,
    reason: String,
    opened_at: u64,
    done: bool,
    cancelled: bool,
    alive: bool,
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
    pub alive: bool,
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
        done: s.done,
        cancelled: s.cancelled,
        alive: s.alive,
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
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
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

fn set_flag(id: &str, done: bool, cancelled: bool) {
    if let Ok(mut m) = store().lock() {
        if let Some(s) = m.get_mut(id) {
            if done {
                s.done = true;
            }
            if cancelled {
                s.cancelled = true;
            }
        }
    }
}

/// 用户点"我已完成" → 记住状态并把窗口收起来(不销毁,cookie 罐要留着)
fn finish(app: &AppHandle, id: &str, done: bool) {
    set_flag(id, done, !done);
    let label = store()
        .lock()
        .ok()
        .and_then(|m| m.get(id).map(|s| s.label.clone()));
    if let (Some(label), Some(win)) = (label, label_window(app, id)) {
        let _ = win.hide();
        crate::logging::event(&format!(
            "VERIFY id={} host_label={} result={}",
            id,
            label,
            if done { "done" } else { "cancel" }
        ));
    }
}

fn label_window(app: &AppHandle, id: &str) -> Option<WebviewWindow> {
    let label = store()
        .lock()
        .ok()
        .and_then(|m| m.get(id).map(|s| s.label.clone()))?;
    app.get_webview_window(&label)
}

/// 开窗口必须回到主线程做 —— 在命令线程里直接 build 会把整个调用挂住(实测)。
#[tauri::command]
pub async fn session_open(
    app: AppHandle,
    url: String,
    reason: Option<String>,
) -> Result<SessionInfo, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(create(&handle, url, reason));
    })
    .map_err(|e| format!("开窗口失败: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "校验窗口没建起来".to_string())?
}

fn create(app: &AppHandle, url: String, reason: Option<String>) -> Result<SessionInfo, String> {
    let app = app.clone();
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

    let nav_id = id.clone();
    let nav_app = app.clone();
    // 注意:这里**不能**设 user_agent —— WebView2 的 UA 是环境级参数,
    // 和主窗口不一致会直接 0x8007139F 建不出来。所以改成从窗口里把真实 UA 问回来。
    // 浏览器参数必须和主窗口一致:WebView2 的环境是按数据目录 + 参数建的,
    // 参数不同会建不出第二个 webview(0x8007139F)。这里直接沿用主窗口那套。
    let extra_args = app
        .config()
        .app
        .windows
        .first()
        .and_then(|w| w.additional_browser_args.clone());
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External(url.parse().map_err(|_| "地址格式不对".to_string())?),
    )
    .title(format!("校验 · {host}"))
    .inner_size(1080.0, 780.0)
    .on_navigation(move |u| {
        let h = u.host_str().unwrap_or("");
        if h == DONE_HOST {
            finish(&nav_app, &nav_id, true);
            return false;
        }
        if h == CANCEL_HOST {
            finish(&nav_app, &nav_id, false);
            return false;
        }
        true
    })
    .on_page_load(move |wv, _payload| {
        // Started 就注入:Cloudflare 的挑战页会一直停在 loading,等 Finished 永远等不到
        let _ = wv.eval(INJECT_JS);
    });

    if let Some(args) = extra_args {
        builder = builder.additional_browser_args(&args);
    }

    let win = builder.build().map_err(|e| format!("校验窗口打不开: {e}"))?;
    let _ = win.set_focus();

    // 用户直接点窗口右上角关掉 → 会话失效(cookie 罐跟着窗口一起没了)
    let dead_id = id.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            if let Ok(mut m) = store().lock() {
                if let Some(s) = m.get_mut(&dead_id) {
                    s.alive = false;
                }
            }
        }
    });

    let sess = Sess {
        id: id.clone(),
        label,
        host: host.clone(),
        origin,
        url,
        reason,
        opened_at: now_secs(),
        done: false,
        cancelled: false,
        alive: true,
    };
    let out = info(&sess);
    if let Ok(mut m) = store().lock() {
        m.insert(id.clone(), sess);
    }
    crate::logging::event(&format!("VERIFY open id={id} host={host}"));
    Ok(out)
}

/// 等用户把校验点完。适配器 `await ctx.human.verify(...)` 就靠这个。
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
        if s.cancelled {
            return Err(format!("{} 的校验被取消", s.host));
        }
        if s.done || !s.alive {
            return Ok(info(&s));
        }
        if started.elapsed() > limit {
            return Err(format!("等 {} 的校验超时", s.host));
        }
        std::thread::sleep(Duration::from_millis(250));
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

/// 手动标记"校验完成"(注入的按钮走导航拦截,这里给外部/调试用)
#[tauri::command]
pub fn session_done(app: AppHandle, id: String) -> Result<(), String> {
    finish(&app, &id, true);
    Ok(())
}

#[tauri::command]
pub fn session_show(app: AppHandle, id: String) -> Result<(), String> {
    let win = label_window(&app, &id).ok_or("会话窗口已经关了")?;
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

#[tauri::command]
pub fn session_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(win) = label_window(&app, &id) {
        let _ = win.destroy();
    }
    if let Ok(mut m) = store().lock() {
        m.remove(&id);
    }
    crate::logging::event(&format!("VERIFY close id={id}"));
    Ok(())
}

/// 在会话窗口里取 cookie(WebView2 的 cookie 罐,含 HttpOnly)。
/// 注意:Windows 上在主线程调用会死锁,所以这里只在异步命令里用。
/// 从会话窗口的 cookie 罐里取真实 UA(注入脚本写进去的 __rb_ua)。
/// 为什么要用它:Cloudflare 的 cf_clearance 绑 UA,请求用的 UA 和浏览器不一样就白过。
fn ua_from(win: &WebviewWindow, url: &str) -> Option<String> {
    let u = url.parse::<tauri::Url>().ok()?;
    let list = win.cookies_for_url(u).ok()?;
    list.iter()
        .find(|c| c.name() == "__rb_ua" && !c.value().is_empty())
        .map(|c| reelbox_core::net::pct_decode(c.value()))
}

fn cookie_header(win: &WebviewWindow, url: &str) -> String {
    let Ok(u) = url.parse::<tauri::Url>() else {
        return String::new();
    };
    match win.cookies_for_url(u) {
        Ok(list) => list
            .iter()
            // __rb_* 是我们自己回传 UA 用的,不能带给对方站点
            .filter(|c| !c.name().starts_with("__rb_"))
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; "),
        Err(e) => {
            crate::logging::event(&format!("VERIFY cookie 读取失败: {e}"));
            String::new()
        }
    }
}

/// 带会话 cookie 的请求。适配器 `ctx.http.get(url, {session})` 走这条。
///
/// 为什么不导出 cookie:cookie 一旦进了插件,插件就能拿去干别的;
/// 这里每次请求现取,插件永远只看到 HTTP 结果。
#[tauri::command]
pub async fn session_fetch(
    app: AppHandle,
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<PluginResponse, String> {
    let win = label_window(&app, &id).ok_or("会话窗口已经关了,请重新校验")?;
    let alive = store()
        .lock()
        .ok()
        .and_then(|m| m.get(&id).map(|s| s.alive && !s.cancelled))
        .unwrap_or(false);
    if !alive {
        return Err("会话不可用".into());
    }
    tauri::async_runtime::spawn_blocking(move || fetch_with(&win, &url, headers.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_with(
    win: &WebviewWindow,
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> Result<PluginResponse, String> {
    use std::io::Read as _;
    // UA 跟浏览器保持一致(CF 会绑),取不到才退回默认值
    let browser_ua = ua_from(win, url);
    let agent = browser_ua.clone().unwrap_or_else(|| FETCH_UA.to_string());
    let mut target = url.to_string();
    for _ in 0..6 {
        if reelbox_core::plugin::net::is_private_url(&target) {
            return Err(format!("拒绝访问本机或内网地址: {target}"));
        }
        let mut list: Vec<(&str, String)> = vec![
            ("User-Agent", agent.clone()),
            // 有 cookie 就必须带 referer,不少站会查
            ("Referer", target.clone()),
        ];
        let cookies = cookie_header(win, &target);
        crate::logging::event(&format!(
            "VERIFY fetch host={} cookies={} ua={}",
            target.split('/').nth(2).unwrap_or("-"),
            if cookies.is_empty() { 0 } else { cookies.split("; ").count() },
            if browser_ua.is_some() { "browser" } else { "default" }
        ));
        if !cookies.is_empty() {
            list.push(("Cookie", cookies));
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
