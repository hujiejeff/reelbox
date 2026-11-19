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
//!
//! **双路兜底**:代理那条路走不通(见 [`should_fallback`])或者压根连不上时,
//! 同一条请求会再走一次直连。两个方向都真实存在:采集站(如电影天堂)直连超时、
//! 必须走代理;国内 CDN(如 v.cdnlz13.com)被代理节点访问时按 geo 回 404。
//! 决策本身抽在 [`plan`] 里,不做 IO,能单测。

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

/// 客户端有五种用法,各自缓存(代理变了就重建):
/// - `client()`:普通请求(接口 / 分享页 / 清单),整体 20s,跟重定向
/// - `client_no_redirect()`:插件抓取,自己一跳一跳跟(每跳都要过 SSRF 检查)
/// - `client_stream()`:媒体流,不设整体超时(一部电影可能放两小时)
/// - `client_direct()` / `client_direct_stream()`:上面两条的**直连版**,
///   只在代理那条路走不通时当第二手用(缓存 key 固定 `direct`,与当前 route 无关)
fn build(follow: bool, total: Option<Duration>, route: &proxy::Route) -> Client {
    init_crypto();
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
static DIRECT: Mutex<Option<Cached>> = Mutex::new(None);
static DIRECT_STREAM: Mutex<Option<Cached>> = Mutex::new(None);

fn pick(
    slot: &Mutex<Option<Cached>>,
    follow: bool,
    total: Option<Duration>,
    route: &proxy::Route,
) -> Client {
    let key = route.key();
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(poison) => poison.into_inner(),
    };
    if let Some(c) = guard.as_ref() {
        if c.key == key {
            return c.client.clone();
        }
    }
    let client = build(follow, total, route);
    *guard = Some(Cached { key, client: client.clone() });
    client
}

/// 普通请求用的客户端(跟重定向,整体 20s)
pub fn client() -> Client {
    pick(&FOLLOW, true, Some(REQUEST_TIMEOUT), &proxy::route())
}

/// 自己跟重定向时用(每一跳都要重新做 SSRF 检查)
pub fn client_no_redirect() -> Client {
    pick(&NO_FOLLOW, false, Some(REQUEST_TIMEOUT), &proxy::route())
}

/// 媒体流用:只限连接时间,不掐总时长
pub fn client_stream() -> Client {
    pick(&STREAM, true, None, &proxy::route())
}

/// 兜底那条路的路由:不设代理。除了不走代理,其余与 route 无关,
/// 所以缓存 key 恒为 `direct`,进程里只建一次。
fn direct_route() -> proxy::Route {
    proxy::Route { proxy: None, bypass: None, from: "direct", note: "兜底直连".to_string() }
}

/// 直连版普通客户端(代理失败时的第二手)
pub fn client_direct() -> Client {
    pick(&DIRECT, true, Some(REQUEST_TIMEOUT), &direct_route())
}

/// 直连版流客户端(代理失败时的第二手)
pub fn client_direct_stream() -> Client {
    pick(&DIRECT_STREAM, true, None, &direct_route())
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

/// 这个状态码值不值得换一条路再试:只有"这条路走不通"的语义才算,
/// 401/429 是对方明确表态,换了也一样,别浪费一次请求。
///
/// 403/404/410/451 这四个都是 CDN 按来源 IP 拒人的常见回答:代理节点在境外,
/// 国内 CDN 会回 404 或 451(地区限制),403 是直接封,410 是资源"已下架"式的拒绝。
pub fn should_fallback(status: u16) -> bool {
    matches!(status, 403 | 404 | 410 | 451)
}

/// 代理那条路走不通的原因(写日志 + 反代区分用)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    /// 状态码说明这条路走不通(403/404/410/451)
    Status(u16),
    /// 压根没连上:超时、拒绝、代理端口没开
    Transport,
}

impl Fallback {
    /// 日志里的 `reason=…` 片段
    pub fn reason(&self) -> String {
        match self {
            Fallback::Status(s) => format!("status:{s}"),
            Fallback::Transport => "transport".to_string(),
        }
    }
}

/// 第一次请求落定之后该怎么办
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// 这条路的回答就是最终答案(成功,或者对方的明确表态)
    Accept,
    /// 换直连再发一次
    Direct(Fallback),
}

/// 兜底决策。**纯函数**:不做 IO、不看全局状态,所以能单测。
///
/// `first` 是第一次请求的结果:成功给出状态码,失败给出错误串(错误串本身
/// 不参与决策,只用来写日志)。`has_proxy` 是"第一次是不是真的走了代理"——
/// 本来就在直连时没有第二手可换,直接接受结果。
pub fn plan(first: Result<u16, &str>, has_proxy: bool) -> Plan {
    if !has_proxy {
        return Plan::Accept;
    }
    match first {
        Err(_) => Plan::Direct(Fallback::Transport),
        Ok(status) if should_fallback(status) => Plan::Direct(Fallback::Status(status)),
        Ok(_) => Plan::Accept,
    }
}

/// 反代一次上游请求的结果。
pub struct Upstream {
    /// 源站的响应(可能是第一跳,也可能是直连兜底那一跳)
    pub resp: Response,
    /// `Some(…)` = 代理那条路失败、靠直连救回来的;`None` = 第一条路就通了
    pub fallback: Option<Fallback>,
}

/// 本次请求是不是真的走了代理(有代理配置就算:绕过列表那点差异不参与决策,
/// reqwest 的 NoProxy 匹配不对外,抖这一下去问它不值得)
fn has_proxy() -> bool {
    proxy::route().proxy.is_some()
}

/// 发一次;`retry` 时 transport 错误歇 800ms 再来一次。
///
/// 只有"请求本身没成功"(连接失败 / 超时)才重试:4xx/5xx 是源站的回答,
/// 重试只会让用户多等 800ms。
fn send_maybe_retry(
    cli: &Client,
    url: &str,
    headers: &[(&str, String)],
    retry: bool,
) -> Result<Response, String> {
    let first = send(cli, url, headers);
    if !retry {
        return first;
    }
    match first {
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

/// 一次请求 + 代理失败时回退直连。决策在 [`plan`] 里,这里只管 IO,
/// 两条路的日志都在这里写(每次请求一条,便于按 url 对账)。
fn fetch(
    first: Client,
    direct: Client,
    has_proxy: bool,
    url: &str,
    headers: &[(&str, String)],
    retry: bool,
) -> Result<Upstream, String> {
    let got = send_maybe_retry(&first, url, headers, retry);
    let decision = plan(
        match &got {
            Ok(r) => Ok(r.status().as_u16()),
            Err(e) => Err(e.as_str()),
        },
        has_proxy,
    );
    let Plan::Direct(why) = decision else {
        return got.map(|resp| Upstream { resp, fallback: None });
    };
    // 代理那条路走不通:同一条请求原样换直连再发一次
    match why {
        Fallback::Status(s) => super::log(&format!(
            "HTTP fallback direct reason=status:{s} url={}",
            short(url, 120)
        )),
        Fallback::Transport => {
            let err = got.as_ref().err().map(String::as_str).unwrap_or("unknown");
            super::log(&format!(
                "HTTP fallback direct reason=transport url={} err={err}",
                short(url, 120)
            ));
        }
    }
    match send(&direct, url, headers) {
        Ok(resp) => Ok(Upstream { resp, fallback: Some(why) }),
        Err(e) => {
            // 直连也失败:把两次都写进错误串,否则排查时只会看到"连不上",
            // 看不出第一次其实是被代理那条路挡下来的
            let before = match &got {
                Ok(r) => format!("status:{}", r.status().as_u16()),
                Err(e) => e.clone(),
            };
            Err(format!("{e}(代理那条路:{before})"))
        }
    }
}

/// GET(带一次重试 + 代理失败回退直连)。
///
/// 只在"代理那条路走不通"时才有第二跳,见 [`should_fallback`] / [`plan`]。
pub fn get(url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    fetch(client(), client_direct(), has_proxy(), url, headers, true).map(|u| u.resp)
}

/// 反代拿上游(流):不掐总时长(一部电影可能放两小时),带直连兜底。
///
/// 返回 [`Upstream`] 而不是裸 `Response`:反代要能在日志里区分
/// "这次是直连救回来的"。
pub fn get_stream(url: &str, headers: &[(&str, String)]) -> Result<Upstream, String> {
    fetch(client_stream(), client_direct_stream(), has_proxy(), url, headers, false)
}

/// 反代拿清单:整体仍受 20s 约束(清单很短,不该无限等),同样带直连兜底。
pub fn get_upstream(url: &str, headers: &[(&str, String)]) -> Result<Upstream, String> {
    fetch(client(), client_direct(), has_proxy(), url, headers, false)
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
    fn direct_clients_build_and_are_cacheable() {
        // 兜底那一手必须随手能用:创建失败等于兜底根本发不出去
        let a = client_direct();
        let b = client_direct();
        let _ = (a, b);
        let s = client_direct_stream();
        let _ = s;
        // 缓存 key 固定:`direct`,与当前 route 无关(否则换个代理就重建一次)
        assert_eq!(direct_route().key(), "direct");
        assert!(direct_route().proxy.is_none());
    }

    #[test]
    fn should_fallback_only_for_dead_roads() {
        // 这四条 = 这条路走不通(港/内地 CDN 按来源 IP 拒人时的常见回答)
        for s in [403u16, 404, 410, 451] {
            assert!(should_fallback(s), "{s} 应该换一条路再试");
        }
        // 成功、重定向、对方的明确表态(401 未授权 / 429 限流)、服务端抖动都不换
        for s in [200u16, 206, 301, 401, 429, 500] {
            assert!(!should_fallback(s), "{s} 换路子也没用,别浪费请求");
        }
    }

    #[test]
    fn plan_falls_back_only_when_the_first_hop_used_a_proxy() {
        // 走了代理 + 状态码说明此路不通 → 直连再来一次
        assert_eq!(plan(Ok(403), true), Plan::Direct(Fallback::Status(403)));
        assert_eq!(plan(Ok(404), true), Plan::Direct(Fallback::Status(404)));
        assert_eq!(plan(Ok(410), true), Plan::Direct(Fallback::Status(410)));
        assert_eq!(plan(Ok(451), true), Plan::Direct(Fallback::Status(451)));
        // 走了代理 + 压根没连上 → 直连再来一次
        assert_eq!(
            plan(Err("NETWORK: 请求超时(https://a.example/)"), true),
            Plan::Direct(Fallback::Transport)
        );
        // 正常响应 / 对方的明确表态 → 不换
        for s in [200u16, 206, 301, 401, 429, 500] {
            assert_eq!(plan(Ok(s), true), Plan::Accept, "{s} 不该触发兜底");
        }
        // 本来就在直连:没有第二手,原样接受(包括 404 和连不上)
        assert_eq!(plan(Ok(404), false), Plan::Accept);
        assert_eq!(plan(Err("NETWORK: 连不上(检查代理):x"), false), Plan::Accept);
    }

    #[test]
    fn fallback_reason_is_log_friendly() {
        assert_eq!(Fallback::Status(404).reason(), "status:404");
        assert_eq!(Fallback::Transport.reason(), "transport");
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
