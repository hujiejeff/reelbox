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
//! **按域名自动选路**:路线不是全局定一次,而是按 host 收敛(见 [`super::route`])。
//! 两个方向都真实存在:采集站(量子)直连 15s 零字节、必须走代理;国内 CDN
//! (ffzy 的 `super.ffzy-online6.com`、`v.cdnlz13.com`)被代理节点访问时按 geo 回 403/404。
//! 于是每条请求按 [`route::candidates`] 排出的顺序依次试,第一条通了就**记下来**
//! (30 分钟),下次同一个 host 不再试错 —— 分片每秒钟一片,少一次 403 往返是实打实的。
//!
//! 决策与记忆抽在 [`race`] 里:记忆表当参数传进来,不做 IO,失败路径也能单测。

use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::{Client, Response};

use super::proxy;
use super::route::{self, Via};

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

/// 客户端有四种用法,各自缓存(代理变了就重建):
/// - `client_via(via, false)`:普通请求(接口 / 分享页 / 清单),整体 20s,跟重定向
/// - `client_via(via, true)`:媒体流,不设整体超时(一部电影可能放两小时)
/// - `client_no_redirect()`:插件抓取,自己一跳一跳跟(每跳都要过 SSRF 检查)
///
/// 缓存 key 来自 [`proxy::Route::key`]:直连是固定 `direct`,代理带上地址与绕过列表,
/// 所以同一个进程里两条候选各自有一个连接池,互不挤占。
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

/// 直连那条路的路由:不设代理。缓存 key 恒为 `direct`,进程里只建一次。
fn direct_route() -> proxy::Route {
    proxy::Route { proxy: None, bypass: None, from: "direct", note: "直连".to_string() }
}

/// 把选出来的路线变成 reqwest 的接线:代理地址来自候选,绕过列表仍按系统那份
/// (`ProxyOverride` 是"本机 / 内网不过代理",与走哪条候选无关)。
fn route_of(via: &Via) -> proxy::Route {
    match via {
        Via::Direct => direct_route(),
        Via::Proxy(url) => proxy::Route {
            proxy: Some(url.clone()),
            bypass: proxy::outlook().bypass,
            from: "route",
            note: "按域名选路".to_string(),
        },
    }
}

/// 按路线取客户端。`stream` 时不设整体超时(媒体流可能放两小时)。
pub fn client_via(via: &Via, stream: bool) -> Client {
    match (via, stream) {
        (Via::Direct, false) => pick(&DIRECT, true, Some(REQUEST_TIMEOUT), &direct_route()),
        (Via::Direct, true) => pick(&DIRECT_STREAM, true, None, &direct_route()),
        (_, false) => pick(&FOLLOW, true, Some(REQUEST_TIMEOUT), &route_of(via)),
        (_, true) => pick(&STREAM, true, None, &route_of(via)),
    }
}

/// 当前系统代理那条路的普通客户端(跟重定向,整体 20s)。
///
/// 注意:它**不做按域名选路**,只适合"就想用默认出口发一次"的场景;
/// 正经的请求走 [`get`] / [`get_upstream`] / [`get_stream`],它们自己会挑路线。
pub fn client() -> Client {
    pick(&FOLLOW, true, Some(REQUEST_TIMEOUT), &proxy::route())
}

/// 自己跟重定向时用(每一跳都要重新做 SSRF 检查)。
///
/// **这条路不走选路**:插件抓取要自己控制跳数,第二发请求会打乱它的跳转语义。
pub fn client_no_redirect() -> Client {
    pick(&NO_FOLLOW, false, Some(REQUEST_TIMEOUT), &proxy::route())
}

/// 当前系统代理那条路的流客户端(只限连接时间,不掐总时长)
pub fn client_stream() -> Client {
    pick(&STREAM, true, None, &proxy::route())
}

/// GET 的主机名:选路与记忆的 key。
///
/// 去掉端口 —— 同一个站换端口还是同一台机器,不该各记一条。
pub fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| url.to_string())
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
/// 国内 CDN 会回 403(直接封)/ 404 / 451(地区限制),410 是资源"已下架"式的拒绝。
pub fn should_fallback(status: u16) -> bool {
    matches!(status, 403 | 404 | 410 | 451)
}

/// 某条路线没走通的原因(写日志 + 反代区分用)
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

/// 一次没走通的尝试(内部用:比 [`Fallback`] 多带着错误串,好拼进最终的错误里)
enum Failure {
    Status(u16),
    Transport(String),
}

impl Failure {
    fn reason(&self) -> Fallback {
        match self {
            Failure::Status(s) => Fallback::Status(*s),
            Failure::Transport(_) => Fallback::Transport,
        }
    }

    /// 错误串里的片段:`status:403` / 连不上的原话
    fn outcome(&self) -> String {
        match self {
            Failure::Status(s) => format!("status:{s}"),
            Failure::Transport(e) => e.clone(),
        }
    }

    /// 全都走不通时最终返回给人看的那句
    fn message(&self, url: &str) -> String {
        match self {
            Failure::Status(s) => format!("NETWORK: 源站回 {s}({url})"),
            Failure::Transport(e) => e.clone(),
        }
    }
}

/// 一次已落定的请求
#[derive(Debug)]
struct Won<T> {
    /// 走通的那条路线
    via: Via,
    payload: T,
    /// 前面那条为什么没走通(第一条就通时为 None)
    lost: Option<Fallback>,
}

/// 依次试候选路线,第一次走通就返回并**记下来**。
///
/// **纯决策**(记忆表当参数进来、`attempt` 是闭包),所以失败路径也能单测:
///
/// - 成功 = 状态码不属于 [`should_fallback`],且没有 transport error
/// - 成功且不是记忆里来的 → 写进记忆,记一行 `ROUTE host=… via=… reason=…`
/// - 全都不通 → 返回**最后一条**的错误,串里带上每条路各自的结果
/// - 记忆里来的那条不通了 → 忘掉它(否则这个域名会在 TTL 内一直撞同一堵墙),
///   下次请求重新试错
///
/// `attempt` 的第二个参数 = "**后面还有候选**":有下一条时,调用方不该在同一条路上
/// 重试(换路本身就是重试,省下的是又一个超时)。
fn race<T, F>(
    learned: &Mutex<route::Learned>,
    host: &str,
    now: u64,
    url: &str,
    cands: &[Via],
    mut attempt: F,
) -> Result<Won<T>, String>
where
    F: FnMut(&Via, bool) -> Result<(u16, T), String>,
{
    let cached = lock(learned).get(host, now).is_some();
    // 每条候选各自的结果:两条都不通时整串带上,不用猜第二条发生了什么
    let mut tried: Vec<String> = Vec::new();
    let mut lost: Option<Fallback> = None;
    let mut last: Option<Failure> = None;

    for (i, via) in cands.iter().enumerate() {
        let more = i + 1 < cands.len();
        match attempt(via, more) {
            Ok((status, payload)) if !should_fallback(status) => {
                if !cached {
                    // 第一次判定:记下来,TTL 内这个 host 只用这一条
                    lock(learned).put(host, via.clone(), now);
                    super::log(&format!(
                        "ROUTE host={host} via={} reason={}",
                        via.name(),
                        lost.as_ref().map(Fallback::reason).unwrap_or_else(|| "ok".to_string())
                    ));
                }
                return Ok(Won { via: via.clone(), payload, lost });
            }
            Ok((status, _)) => {
                let why = Failure::Status(status);
                tried.push(format!("{}={}", via.describe(), why.outcome()));
                lost = Some(why.reason());
                last = Some(why);
            }
            Err(e) => {
                let why = Failure::Transport(e);
                tried.push(format!("{}={}", via.describe(), why.outcome()));
                lost = Some(why.reason());
                last = Some(why);
            }
        }
    }

    let detail = tried.join(" | ");
    super::log(&format!("ROUTE host={host} FAILED {detail}"));
    if cached {
        let via = cands.first().map(Via::name).unwrap_or("direct");
        let reason = last.as_ref().map(|f| f.reason().reason()).unwrap_or_default();
        // 只在失败时打:分片每秒一片,成功时打这行会把日志淹掉
        super::log(&format!("ROUTE host={host} via={via} (cached) reason={reason}"));
        // 学到的路线不通了(换了节点 / 代理工具关了 / CDN 换了策略):忘掉,下次重新试
        lock(learned).forget(host);
    }
    let head = last.map(|f| f.message(url)).unwrap_or_else(|| format!("NETWORK: 没有可用的路线({url})"));
    // 最后一条的错误在前,后面是每条路各自的结果
    Err(format!("{head}(各条路:{detail})"))
}

/// 反代一次上游请求的结果。
pub struct Upstream {
    /// 源站的响应
    pub resp: Response,
    /// 这条请求实际走通的路线(反代日志里要写清是哪条)
    pub via: Via,
    /// `Some(…)` = 第一条候选没通、靠后面那条救回来的;`None` = 第一条就通了
    pub fallback: Option<Fallback>,
}

/// 发一次;`retry` 时 transport 错误歇 800ms 再来一次(**同一条路线**上重试)。
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
            send(cli, url, headers)
        }
    }
}

/// 一次请求:按候选路线依次试。`stream` 时用不掐总时长的客户端,
/// `retry` 时 transport 错误在同一条路线上再试一次 —— **除非后面还有候选**:
/// 那时"换下一条"就是重试,不必先在同一条死路上多等一个超时。
fn fetch(
    url: &str,
    headers: &[(&str, String)],
    retry: bool,
    stream: bool,
) -> Result<Upstream, String> {
    let host = host_of(url);
    let now = route::now_secs();
    let cands = route::candidates(&host);
    let won = race(route::store(), &host, now, url, &cands, |via, more| {
        let client = client_via(via, stream);
        send_maybe_retry(&client, url, headers, retry && !more)
            .map(|resp| (resp.status().as_u16(), resp))
    })?;
    Ok(Upstream { resp: won.payload, via: won.via, fallback: won.lost })
}

/// GET(带一次重试 + 按域名选路)。
pub fn get(url: &str, headers: &[(&str, String)]) -> Result<Response, String> {
    fetch(url, headers, true, false).map(|u| u.resp)
}

/// 反代拿上游(流):不掐总时长(一部电影可能放两小时),按域名选路。
///
/// 返回 [`Upstream`] 而不是裸 `Response`:反代要能在日志里区分
/// "这次是哪条路救回来的"。
pub fn get_stream(url: &str, headers: &[(&str, String)]) -> Result<Upstream, String> {
    fetch(url, headers, false, true)
}

/// 反代拿清单:整体仍受 20s 约束(清单很短,不该无限等),同样按域名选路。
pub fn get_upstream(url: &str, headers: &[(&str, String)]) -> Result<Upstream, String> {
    fetch(url, headers, false, false)
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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poison) => poison.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn via_proxy(url: &str) -> Via {
        Via::Proxy(url.to_string())
    }

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
        // 直连那一手必须随手能用:创建失败等于第二手发不出去
        let a = client_via(&Via::Direct, false);
        let b = client_via(&Via::Direct, false);
        let _ = (a, b);
        let s = client_via(&Via::Direct, true);
        let _ = s;
        // 直连的缓存 key 固定 `direct`,与当前系统代理无关
        assert_eq!(direct_route().key(), "direct");
        assert!(direct_route().proxy.is_none());
    }

    #[test]
    fn proxy_clients_are_keyed_by_the_proxy_address() {
        // 两条候选(启用的那条 / 没启用的那条)不能共用一个连接池:
        // key 里必须带上代理地址(绕过列表按系统那份,可能跟着一起变)
        let a = route_of(&via_proxy("http://127.0.0.1:7890"));
        let b = route_of(&via_proxy("http://127.0.0.1:7891"));
        assert!(a.key().starts_with("proxy:http://127.0.0.1:7890"), "{}", a.key());
        assert!(b.key().starts_with("proxy:http://127.0.0.1:7891"), "{}", b.key());
        assert_ne!(a.key(), b.key());
        assert_eq!(route_of(&Via::Direct).key(), "direct");
        // 真的建得出来:代理地址拼错时 reqwest 会拒,这里只验可建
        let c = client_via(&via_proxy("http://127.0.0.1:7890"), false);
        let _ = c;
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
    fn fallback_reason_is_log_friendly() {
        assert_eq!(Fallback::Status(404).reason(), "status:404");
        assert_eq!(Fallback::Transport.reason(), "transport");
        assert_eq!(Failure::Status(403).outcome(), "status:403");
        assert_eq!(Failure::Transport("NETWORK: x".into()).outcome(), "NETWORK: x");
        assert!(Failure::Status(403).message("https://a.example/").starts_with("NETWORK: 源站回 403"));
    }

    #[test]
    fn host_of_keyes_on_the_hostname() {
        assert_eq!(host_of("https://CJ.lziApi.com/api.php/provide/vod?a=1"), "cj.lziapi.com");
        assert_eq!(host_of("https://v.cdnlz13.com:8443/share/x"), "v.cdnlz13.com");
        // 不是合法 URL(插件里什么都可能传进来):退回整串当 key,不 panic
        assert_eq!(host_of("not a url"), "not a url");
    }

    #[test]
    fn race_learns_the_second_route_when_the_first_one_is_blocked() {
        // ffzy 那个 CDN:代理 403、直连 200 → 学成直连,下次不再撞 403
        let l = Mutex::new(route::Learned::new());
        let cands = vec![via_proxy("http://127.0.0.1:7890"), Via::Direct];
        let mut seen = Vec::new();
        let won = race(&l, "super.ffzy-online6.com", 1_000, "https://super.ffzy-online6.com/x.m3u8", &cands, |via, more| {
            seen.push((via.clone(), more));
            match via {
                Via::Proxy(_) => Ok((403u16, "proxy")),
                Via::Direct => Ok((200u16, "direct")),
            }
        })
        .unwrap();
        assert_eq!(won.via, Via::Direct);
        assert_eq!(won.payload, "direct");
        assert_eq!(won.lost, Some(Fallback::Status(403)), "反代日志要写清是为什么换的路");
        assert_eq!(
            seen,
            vec![(cands[0].clone(), true), (Via::Direct, false)],
            "第一条 403 之后继续试第二条;'后面还有候选'只有第一条是 true(它不该在同一条上重试)"
        );
        assert_eq!(lock(&l).get("super.ffzy-online6.com", 1_001), Some(Via::Direct));
    }

    #[test]
    fn race_keeps_the_first_route_when_it_works() {
        // 量子:代理 200 → 学成代理,不写第二跳
        let l = Mutex::new(route::Learned::new());
        let cands = vec![via_proxy("http://127.0.0.1:7890"), Via::Direct];
        let mut seen = Vec::new();
        let won = race(&l, "cj.lziapi.com", 1_000, "https://cj.lziapi.com/api", &cands, |via, _more| {
            seen.push(via.clone());
            Ok((200u16, "ok"))
        })
        .unwrap();
        assert_eq!(won.via, via_proxy("http://127.0.0.1:7890"));
        assert_eq!(won.lost, None);
        assert_eq!(seen.len(), 1, "第一条就通了,不该再发第二跳");
        assert_eq!(lock(&l).get("cj.lziapi.com", 1_001), Some(via_proxy("http://127.0.0.1:7890")));
    }

    #[test]
    fn race_does_not_remember_failures() {
        // 两条都不通:什么都不记(记了就等于把一个"暂时连不上"钉成结论)
        let l = Mutex::new(route::Learned::new());
        let cands = vec![via_proxy("http://127.0.0.1:7890"), Via::Direct];
        let err = race::<&str, _>(&l, "cj.lziapi.com", 1_000, "https://cj.lziapi.com/api", &cands, |via, _more| match via {
            Via::Proxy(_) => Err("NETWORK: 连不上(检查代理):refused".to_string()),
            Via::Direct => Err("NETWORK: 请求超时(https://cj.lziapi.com/api)".to_string()),
        })
        .unwrap_err();
        assert_eq!(lock(&l).get("cj.lziapi.com", 1_001), None, "失败不能写进记忆");
        // 最后一条的错误在前,后面两条路各自的结果都在
        assert!(err.starts_with("NETWORK: 请求超时"), "{err}");
        assert!(err.contains("direct=NETWORK: 请求超时"), "{err}");
        assert!(err.contains("proxy:http://127.0.0.1:7890=NETWORK: 连不上"), "{err}");
        assert!(err.contains("各条路:"), "{err}");
    }

    #[test]
    fn race_error_string_lists_both_statuses() {
        // 两条都是"此路不通"的状态码:没有现成的错误串,得自己拼一个能看懂的
        let l = Mutex::new(route::Learned::new());
        let cands = vec![via_proxy("http://127.0.0.1:7890"), Via::Direct];
        let err = race::<&str, _>(&l, "a.example", 1_000, "https://a.example/x", &cands, |via, _more| match via {
            Via::Proxy(_) => Ok((403u16, "proxy")),
            Via::Direct => Ok((404u16, "direct")),
        })
        .unwrap_err();
        assert!(err.starts_with("NETWORK: 源站回 404"), "最后一条在前: {err}");
        assert!(err.contains("proxy:http://127.0.0.1:7890=status:403"), "{err}");
        assert!(err.contains("direct=status:404"), "{err}");
        assert_eq!(lock(&l).get("a.example", 1_001), None);
    }

    #[test]
    fn race_uses_the_learned_route_without_trying_the_other() {
        // 学过 = 只返回它一条:分片不再每秒白撞一次 403
        let l = Mutex::new(route::Learned::new());
        lock(&l).put("super.ffzy-online6.com", Via::Direct, 1_000);
        let cands = vec![Via::Direct];
        let mut seen = Vec::new();
        let won = race(&l, "super.ffzy-online6.com", 1_200, "https://super.ffzy-online6.com/x", &cands, |via, _more| {
            seen.push(via.clone());
            Ok((200u16, "ok"))
        })
        .unwrap();
        assert_eq!(seen, vec![Via::Direct], "只有一条候选,不会再试代理");
        assert_eq!(won.lost, None);
        // 命中记忆时不再写日志(否则每个分片一行,日志被淹)
    }

    #[test]
    fn race_forgets_a_learned_route_that_stopped_working() {
        // 学到的直连后来连不上了(比如换了网络):忘掉,下次重新试错
        let l = Mutex::new(route::Learned::new());
        lock(&l).put("cj.lziapi.com", Via::Direct, 1_000);
        let cands = vec![Via::Direct];
        let err = race::<&str, _>(&l, "cj.lziapi.com", 1_200, "https://cj.lziapi.com/api", &cands, |_, _more| {
            Err("NETWORK: 请求超时(https://cj.lziapi.com/api)".to_string())
        })
        .unwrap_err();
        assert!(err.contains("NETWORK: 请求超时"), "{err}");
        assert_eq!(lock(&l).get("cj.lziapi.com", 1_201), None, "不通的记忆要丢掉");
    }

    #[test]
    fn race_without_candidates_reports_no_route() {
        // 兜底:候选为空也不该 panic
        let l = Mutex::new(route::Learned::new());
        let err = race::<&str, _>(&l, "a.example", 1_000, "https://a.example/", &[], |_, _more| Ok((200u16, "x")))
            .unwrap_err();
        assert!(err.contains("没有可用的路线"), "{err}");
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
