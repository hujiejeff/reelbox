//! 本地 HLS 反代。
//! WebView 里直接播 m3u8 有三个坑:桌面 Chromium 不认 HLS、跨域被拦、防盗链要带 UA/Referer。
//! 这里起一个 127.0.0.1 上的小服务,把 m3u8 和分片都代理一遍,顺手改写里面的地址。

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use reelbox_core::net::http;
use reelbox_core::net::session::Sessions;
use tiny_http::{Header, Method, Response, Server};

use crate::logging;

static PORT: OnceLock<u16> = OnceLock::new();
const MAX_BYTES: u64 = 96 << 20;

/// 表里最多留这么多条:一条 = 一个地址 + 一串头,几千条也就几 MB,
/// 但足够覆盖"一部剧所有分集 + 直播清单反复刷新"的量
const MAX_SESSIONS: usize = 4096;
/// 超过这么久的条目在插入时顺手清掉。直播清单每次刷新都会重新 wrap,
/// 6 小时前的会话不可能还有播放器在用
const SESSION_TTL_SECS: u64 = 6 * 3600;

fn dec(s: &str) -> Option<String> {
    B64.decode(s.as_bytes())
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
}

/// 一个播放会话就是"真实地址 + 请求头",存在 [`Sessions`] 里换成一个短 id。
/// 表本身在 core(那边能单测),这里只负责:全局放一份 + 提供当前时间。
static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();

fn sessions() -> &'static Mutex<Sessions> {
    SESSIONS.get_or_init(|| Mutex::new(Sessions::new(MAX_SESSIONS, SESSION_TTL_SECS)))
}

/// 中毒也要能用:反代线程 panic 过一次就不该让播放永久瘫痪
fn lock() -> std::sync::MutexGuard<'static, Sessions> {
    match sessions().lock() {
        Ok(g) => g,
        Err(poison) => poison.into_inner(),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 记住一个会话,返回它的 id(进程级会话表那颗锁的入口)
fn remember(url: &str, headers: &str) -> String {
    lock().remember(url, headers, now_secs())
}

/// 按 id 取回 (url, headers)。取不到就是过期/被淘汰了
fn recall(id: &str) -> Option<(String, String)> {
    lock().recall(id, now_secs())
}

/// 把绝对地址包成本地代理地址
pub fn wrap(url: &str, headers: &str) -> String {
    let port = ensure();
    let id = remember(url, headers);
    format!("http://127.0.0.1:{port}/s/{id}")
}

/// 起服务(只起一次),返回端口
/// 同时在处理的请求上限。到了上限就地处理(背压),不会无限开线程。
const MAX_INFLIGHT: usize = 48;
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// 每个请求一个线程。
///
/// **不能串行**:HLS 直播里播放器一边下几 MB 的分片、一边每几秒来取一次清单,
/// 串行时那个分片会把清单刷新堵在后头,播放器等到超时(实测 levelLoadTimeOut)。
fn serve(req: tiny_http::Request) {
    let n = INFLIGHT.fetch_add(1, Ordering::Relaxed);
    if n >= MAX_INFLIGHT {
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
        handle(req);
        return;
    }
    std::thread::spawn(move || {
        handle(req);
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    });
}

pub fn ensure() -> u16 {
    *PORT.get_or_init(|| {
        let server = Server::http("127.0.0.1:0").expect("proxy: 端口绑定失败");
        let port = server
            .server_addr()
            .to_ip()
            .expect("proxy: 非 IP 地址")
            .port();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                serve(req);
            }
        });
        port
    })
}

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return dec(v);
        }
    }
    None
}

fn send(req: tiny_http::Request, data: Vec<u8>, ct: &str) {
    send_status(req, 200, data, ct);
}

/// 带 CORS 的响应:状态码照抄源站,否则跨域下 hls.js 只能看到 CORS 错误
fn send_status(req: tiny_http::Request, status: u16, data: Vec<u8>, ct: &str) {
    let mut r = Response::from_data(data).with_status_code(status);
    for h in cors(ct) { r.add_header(h); }
    let _ = req.respond(r);
}

fn cors(ct: &str) -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap(),
    ]
}

/// 分片请求一集几十个,只把前几个写进日志;出错的全都写。
static SEG_LOGGED: AtomicUsize = AtomicUsize::new(0);
const SEG_LOG_FIRST: usize = 6;

fn handle(req: tiny_http::Request) {
    let url = req.url().to_string();
    // 新地址只带会话 id;老地址 `/p?u=&h=` 继续认(已缓存的页面、别人存的调试地址)
    let (target, headers) = match url.strip_prefix("/s/") {
        Some(id) => {
            let id = id.split(['?', '#']).next().unwrap_or(id);
            match recall(id) {
                Some(s) => s,
                None => {
                    logging::event(&format!("PROXY 会话不存在 id={}", short(id, 40)));
                    send_status(
                        req,
                        404,
                        "播放会话已过期，请重新点播".as_bytes().to_vec(),
                        "text/plain; charset=utf-8",
                    );
                    return;
                }
            }
        }
        None if url.starts_with("/p?") => {
            let (Some(target), headers) =
                (query(&url, "u"), query(&url, "h").unwrap_or_default())
            else {
                let _ = req.respond(Response::empty(400));
                return;
            };
            (target, headers)
        }
        None => {
            let _ = req.respond(Response::empty(404));
            return;
        }
    };
    // 头一次转成键值对:既要发给源站,也要写进日志
    let pairs: Vec<(String, String)> = serde_json::from_str::<Vec<Vec<String>>>(&headers)
        .unwrap_or_default()
        .into_iter()
        .filter(|kv| kv.len() == 2)
        .map(|kv| (kv[0].clone(), kv[1].clone()))
        .collect();
    let header_note = describe_headers(&pairs);

    // 播放器拖动进度条时会带 Range:必须原样透传,否则每次拖动都要从头下载整个文件
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    let is_head = req.method() == &Method::Head;

    // 媒体流不掐总时长(一部电影可能放两小时),普通清单/分片仍受 20s 约束
    let streaming = range.is_some() || is_media_path(&target);
    let mut headers_out: Vec<(&str, String)> = vec![
        // 明确要原始字节:压缩过的 m3u8 交给 hls.js 只会得到 manifestParsingError
        ("Accept-Encoding", "identity".to_string()),
    ];
    for (k, v) in &pairs {
        headers_out.push((k.as_str(), v.clone()));
    }
    if let Some(r) = &range {
        headers_out.push(("Range", r.clone()));
    }

    // 上游按域名自动选路:采集站(量子)直连超时、必须走代理;国内 CDN(ffzy)反过来,
    // 被代理节点访问时按 geo 回 403/404。core 那边按候选依次试,第一条通了就记住,
    // 这里只负责把结果和"是哪条路救回来的"记进日志。
    let upstream = if streaming {
        http::get_stream(&target, &headers_out)
    } else {
        http::get_upstream(&target, &headers_out)
    };
    let resp = match upstream {
        Ok(u) => {
            if let Some(why) = u.fallback {
                logging::event(&format!(
                    "PROXY route={} note=换路 reason={} target={}",
                    u.via.describe(),
                    why.reason(),
                    short(&target, 160)
                ));
            }
            u.resp
        }
        Err(e) => {
            logging::event(&format!(
                "PROXY ERR transport target={} {header_note} err={e}",
                short(&target, 160)
            ));
            let _ = req.respond(Response::empty(502));
            return;
        }
    };

    // 清单里的相对地址要相对**最终地址**才是对的:源站经常 302 到签名地址,
    // 一跳之后目录甚至主机都变了,按请求时的 target 拼出来的分片会整片 404。
    // 这里在任何 move 之前先取下来(reqwest 的 blocking 响应带着这个信息)。
    let base = {
        let u = resp.url().to_string();
        if u.is_empty() { target.clone() } else { u }
    };

    let status = resp.status().as_u16();
    let header_get = |name: &str| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let ct = header_get("content-type").unwrap_or_else(|| "application/octet-stream".to_string());
    let ce = header_get("content-encoding").unwrap_or_default();
    let len = resp.content_length().map(|n| n as usize);
    let content_range = header_get("content-range");
    let accept_ranges = header_get("accept-ranges");

    // 源站 4xx/5xx:原样回给播放器,别用 502 把它糊掉(否则日志里看不出真实状态码)
    if status >= 400 && !is_media_path(&target) {
        let (body, _) = read_body(resp);
        logging::event(&format!(
            "PROXY http status={status} ct={ct} target={}{} {header_note} body={}",
            short(&target, 160),
            hop_note(&target, &base),
            logging::one_line(&String::from_utf8_lossy(&body), 160)
        ));
        send_status(req, status, body, &ct);
        return;
    }

    // 真正的媒体文件(不是清单)直接流式转发:不占内存、不截断、支持 Range
    if range.is_some() || is_media_body(&ct, &target) {
        let n = SEG_LOGGED.fetch_add(1, Ordering::Relaxed);
        if n < SEG_LOG_FIRST || status >= 400 {
            logging::event(&format!(
                "PROXY media status={status} ct={ct} len={:?} range={:?} target={}{}",
                len,
                range,
                short(&target, 120),
                hop_note(&target, &base)
            ));
        }
        let mut headers = cors(&ct);
        headers.push(Header::from_bytes(&b"Accept-Ranges"[..], accept_ranges.as_deref().unwrap_or("bytes").as_bytes()).unwrap());
        if let Some(cr) = content_range {
            headers.push(Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()).unwrap());
        }
        if is_head {
            let _ = req.respond(Response::empty(status).with_status_code(status));
            return;
        }
        // reqwest 的 blocking 响应本身就是 Read:直接交给 tiny_http 边读边发
        let out = Response::new(tiny_http::StatusCode(status), headers, resp, len, None);
        let _ = req.respond(out);
        return;
    }

    // 剩下的按"可能是清单"处理:读进内存才能改写里面的相对地址
    let (body, _) = read_body(resp);
    if body.is_empty() {
        logging::event(&format!(
            "PROXY ERR empty status={status} ct={ct} target={}",
            short(&target, 160)
        ));
        let _ = req.respond(Response::empty(502));
        return;
    }

    if body.starts_with(b"#EXTM3U") {
        logging::event(&format!(
            "PROXY m3u8 status={status} bytes={} ct={ct} ce={ce} target={}{} {header_note}",
            body.len(),
            short(&target, 160),
            hop_note(&target, &base)
        ));
        let text = String::from_utf8_lossy(&body).to_string();
        let out = rewrite(&text, &base, &headers);
        send(req, out.into_bytes(), "application/vnd.apple.mpegurl");
    } else {
        // 不是清单:这就是 hls.js 报 manifestParsingError 的直接证据,原样回给播放器
        if ct.contains("mpegurl") || target.contains(".m3u8") {
            logging::event(&format!(
                "PROXY NOT-M3U8 status={status} ct={ct} bytes={} target={} head={}",
                body.len(),
                short(&target, 160),
                logging::one_line(&String::from_utf8_lossy(&body[..body.len().min(400)]), 160)
            ));
        }
        send_status(req, status, body, &ct);
    }
}

/// 源站给的就是媒体本体(不是 m3u8 清单)时,直接透传
fn is_media_body(ct: &str, target: &str) -> bool {
    let c = ct.to_ascii_lowercase();
    if c.starts_with("video/") || c.starts_with("audio/") || c.starts_with("image/") {
        return true;
    }
    is_media_path(target)
}

/// 只看地址后缀:还没拿到 content-type 时(选客户端之前)也要能判
fn is_media_path(target: &str) -> bool {
    let path = target.split('?').next().unwrap_or(target).to_ascii_lowercase();
    [".mp4", ".m4v", ".ts", ".m4s", ".flv", ".mkv", ".mp3", ".m4a", ".aac"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

fn read_body(resp: http::HttpResponse) -> (Vec<u8>, String) {
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut body = Vec::new();
    let mut reader = resp;
    let _ = reader.by_ref().take(MAX_BYTES).read_to_end(&mut body);
    (body, ct)
}

/// 请求带的头写进日志,但令牌类的一律打码
fn describe_headers(pairs: &[(String, String)]) -> String {
    if pairs.is_empty() {
        return "h=none".into();
    }
    let mut out = String::from("h=");
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let lk = k.to_ascii_lowercase();
        let secret = lk.contains("cookie")
            || lk.contains("auth")
            || lk.contains("token")
            || lk.contains("key");
        out.push_str(k);
        out.push('=');
        if secret {
            out.push_str("***");
        } else {
            out.push_str(&logging::one_line(v, 60));
        }
    }
    out
}

/// 跟过跳转就把最终地址一起写进日志。
/// 清单解析用的是 base,排查时只看到 target 会以为"地址没错却全 404"。
fn hop_note(target: &str, base: &str) -> String {
    if base == target {
        return String::new();
    }
    format!(" base={}", short(base, 160))
}

/// 日志里的地址只留前 160 字符(签名串很长)
fn short(url: &str, max: usize) -> String {
    let n = url.chars().count();
    if n <= max {
        return url.to_string();
    }
    let head: String = url.chars().take(max).collect();
    format!("{head}…({n})")
}

/// 把 m3u8 里的分片、子清单、密钥地址都换成代理地址。
///
/// 改写逻辑本身在 core(`reelbox_core::playlist`),那边不碰 tiny_http/请求头,
/// 所以能单测;这里只把请求头塞进 wrap 闭包。
fn rewrite(text: &str, base: &str, headers: &str) -> String {
    reelbox_core::playlist::rewrite(text, base, &|uri| wrap(uri, headers))
}
