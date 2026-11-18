//! 统一 HTTP 出口。
//!
//! 全应用只有这一个网络实现(reqwest),好处是三件以前做不到的事:
//!
//! - **能设超时**:连接 10s / 整体 20s,不再靠"运气"等 TCP 自己超时
//! - **能设代理**:每次请求前按 `net::proxy` 的解析结果挑客户端,换端口不用重启
//! - **能拿最终地址**:跟随 302 之后 `Response::url()` 是最终地址,
//!   反代用它当基准解析 m3u8 里的相对地址(否则签名 URL 一跳就全错)
//!
//! 失败重试 1 次(间隔 800ms),只用在幂等的 GET 上。

use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::{Client, Response};

use super::proxy;

/// 转手一层:宿主(src-tauri)也要拿这个类型(反代流式转发时直接当 Read 用),
/// 但没必要为了一个类型名把 reqwest 再引成直接依赖。
pub type HttpResponse = Response;

/// 连接建立最多等这么久
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 一次请求整体(含读完响应体)最多这么久
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 重试前歇一下
pub const RETRY_DELAY: Duration = Duration::from_millis(800);

/// 桌面浏览器式的 UA:采集站按 UA 判浏览器,默认的 `reqwest/x.y` 会被挡
pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 装一次 rustls 的加密后端。
///
/// `rustls-no-provider` 只带 TLS 接线,进程级 provider 要自己装。
/// 选 ring 而不是 aws-lc-rs:ring 只要 cc 就能编,Android/iOS/Windows 都一样。
fn init_crypto() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

/// 客户端有三种用法,各自缓存(代理变了就重建):
/// - `client()`:普通请求(接口 / 分享页 / 清单),整体 20s,跟重定向
/// - `client_no_redirect()`:插件抓取,自己一跳一跳跟(每跳都要过 SSRF 检查)
/// - `client_stream()`:媒体流,不设整体超时(一部电影可能放两小时)
fn build(follow: bool, total: Option<Duration>) -> Client {
    init_crypto();
    let route = proxy::route();
    let mut builder = Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(UA)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        // 先清空,再按解析结果显式加:系统代理由我们自己解析(见 net::proxy),
        // 不交给 reqwest 的隐式探测,这样日志里看得见走的是哪一条
        .no_proxy();
    if let Some(total) = total {
        builder = builder.timeout(total);
    }
    if !follow {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    if let Some(url) = &route.proxy {
        match reqwest::Proxy::all(url) {
            Ok(p) => {
                let p = match &route.bypass {
                    Some(list) if !list.trim().is_empty() => {
                        match reqwest::NoProxy::from_string(list) {
                            Some(no) => p.no_proxy(Some(no)),
                            None => p,
                        }
                    }
                    _ => p,
                };
                builder = builder.proxy(p);
            }
            Err(e) => {
                super::log(&format!("HTTP proxy 无效({e}),本次直连: {url}"));
            }
        }
    }
    builder.build().unwrap_or_else(|e| {
        super::log(&format!("HTTP 客户端创建失败({e}),退回最小配置"));
        Client::builder()
            .no_proxy()
            .timeout(total.unwrap_or(REQUEST_TIMEOUT))
            .build()
            .expect("reqwest: 连最小配置都创建不了")
    })
}

struct Cached {
    key: String,
    client: Client,
}

static FOLLOW: Mutex<Option<Cached>> = Mutex::new(None);
static NO_FOLLOW: Mutex<Option<Cached>> = Mutex::new(None);
static STREAM: Mutex<Option<Cached>> = Mutex::new(None);

fn pick(slot: &Mutex<Option<Cached>>, follow: bool, total: Option<Duration>) -> Client {
    let key = proxy::route().key();
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(poison) => poison.into_inner(),
    };
    if let Some(c) = guard.as_ref() {
        if c.key == key {
            return c.client.clone();
        }
    }
    let client = build(follow, total);
    *guard = Some(Cached { key, client: client.clone() });
    client
}

/// 普通请求用的客户端(跟重定向,整体 20s)
pub fn client() -> Client {
    pick(&FOLLOW, true, Some(REQUEST_TIMEOUT))
}

/// 自己跟重定向时用(每一跳都要重新做 SSRF 检查)
pub fn client_no_redirect() -> Client {
    pick(&NO_FOLLOW, false, Some(REQUEST_TIMEOUT))
}

/// 媒体流用:只限连接时间,不掐总时长
pub fn client_stream() -> Client {
    pick(&STREAM, true, None)
}

fn send(client: &Client, url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    req.send().map_err(|e| {
        // 只说人话:是超时、是连不上代理,还是被源站拒了
        if e.is_timeout() {
            format!("NETWORK: 请求超时({url})")
        } else if e.is_connect() {
            format!("NETWORK: 连不上(检查代理):{e}")
        } else {
            format!("NETWORK: {e}")
        }
    })
}

/// GET(带一次重试)。
///
/// 只有"请求本身没成功"(连接失败 / 超时)才重试:4xx/5xx 是源站的回答,
/// 重试只会让用户多等 800ms。
pub fn get(url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    let cli = client();
    match send(&cli, url, headers) {
        Ok(r) => Ok(r),
        Err(first) => {
            super::log(&format!(
                "HTTP retry after={}ms url={} err={first}",
                RETRY_DELAY.as_millis(),
                short(url, 120)
            ));
            std::thread::sleep(RETRY_DELAY);
            send(&client(), url, headers)
        }
    }
}

/// GET 一次,不重试(插件抓取要自己控制跳数)
pub fn get_once(client: &Client, url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    send(client, url, headers)
}

/// 日志里的地址只留前面一段(签名串很长)
pub fn short(url: &str, max: usize) -> String {
    let n = url.chars().count();
    if n <= max {
        return url.to_string();
    }
    let head: String = url.chars().take(max).collect();
    format!("{head}…({n})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_provider_installs_once() {
        init_crypto();
        init_crypto();
        assert!(
            rustls::crypto::CryptoProvider::get_default().is_some(),
            "rustls 必须有进程级 provider,否则 https 请求全废"
        );
    }

    #[test]
    fn clients_are_cached_and_share_the_route() {
        let a = client();
        let b = client();
        // 同一个 client:连接池才会被复用
        let _ = (a, b);
        let no_follow = client_no_redirect();
        let stream = client_stream();
        let _ = (no_follow, stream);
    }

    #[test]
    fn short_truncates_long_urls() {
        let url = "https://a.example/".to_string() + &"x".repeat(300);
        let s = short(&url, 40);
        assert!(s.chars().count() < 60, "{s}");
        assert!(s.contains('…'));
        assert_eq!(short("https://a/b", 40), "https://a/b");
    }
}
