//! 本地 HLS 反代。
//! WebView 里直接播 m3u8 有三个坑:桌面 Chromium 不认 HLS、跨域被拦、防盗链要带 UA/Referer。
//! 这里起一个 127.0.0.1 上的小服务,把 m3u8 和分片都代理一遍,顺手改写里面的地址。

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use reelbox_core::net::http;
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

/// 只给测试用:构造一条老的 `/p?u=…&h=…` 地址,验证兼容路径还能解出来
#[cfg(test)]
fn enc(s: &str) -> String {
    B64.encode(s.as_bytes())
}

fn dec(s: &str) -> Option<String> {
    B64.decode(s.as_bytes())
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
}

/// 一个播放会话:真实地址 + 请求头。
///
/// 以前这两样就编码在 URL 里(`/p?u=&h=`),后果是 Cookie/Authorization 会跟着
/// 地址进日志和播放器调试面板,地址还会随头的大小无限变长。现在 URL 里只有短 id。
struct Session {
    url: String,
    headers: String,
    /// 插入(或最近一次命中)的 Unix 秒,给 TTL 用
    at: u64,
}

/// 会话表 + 插入顺序。两者必须一起改,所以放进同一个锁里
struct Sessions {
    map: HashMap<String, Session>,
    /// 淘汰按这个来。同一个 id 重插入不再记一次(见 `remember`)
    order: VecDeque<String>,
}

static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();

fn sessions() -> &'static Mutex<Sessions> {
    SESSIONS.get_or_init(|| Mutex::new(Sessions::new()))
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

/// 会话 id:和 `source::id_for_url` 同一套(FNV-1a 32 位 / 8 位十六进制),
/// 界面上看到的短串风格就一致了。请求头也参与:同一地址换一套头是另一路流。
fn session_id(url: &str, headers: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    let sep = 0x1fu16; // 分隔符:避免 ("ab","c") 和 ("a","bc") 撞成同一个 id
    for unit in url
        .encode_utf16()
        .chain(std::iter::once(sep))
        .chain(headers.encode_utf16())
    {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// 记住一个会话,返回它的 id(进程级会话表那颗锁的入口)
fn remember(url: &str, headers: &str) -> String {
    lock().remember(url, headers, now_secs())
}

/// 按 id 取回 (url, headers)。取不到就是过期/被淘汰了
fn recall(id: &str) -> Option<(String, String)> {
    lock().recall(id)
}

impl Sessions {
    fn new() -> Self {
        Sessions {
            map: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    /// 记住一个会话,返回它的 id。
    /// 同一个 (url, headers) 永远得到同一个 id —— 直播清单每次刷新都会重新 wrap,
    /// 每次都插一条的话表会无限膨胀。
    fn remember(&mut self, url: &str, headers: &str, now: u64) -> String {
        let id = session_id(url, headers);
        self.purge_expired(now);
        if let Some(s) = self.map.get_mut(&id) {
            // 命中已有会话:只刷新时间。插入顺序不动,否则热门清单会一直把自己顶成
            // "最新",淘汰就永远淘汰不到它
            s.at = now;
            return id;
        }
        self.map.insert(
            id.clone(),
            Session {
                url: url.to_string(),
                headers: headers.to_string(),
                at: now,
            },
        );
        self.order.push_back(id.clone());
        while self.map.len() > MAX_SESSIONS {
            match self.order.pop_front() {
                Some(old) => {
                    self.map.remove(&old);
                }
                None => break,
            }
        }
        id
    }

    fn recall(&self, id: &str) -> Option<(String, String)> {
        self.map.get(id).map(|s| (s.url.clone(), s.headers.clone()))
    }

    /// 清掉超过 TTL 的条目,并让 `order` 和 `map` 一一对应。
    ///
    /// `order` 得跟着一起对齐:只按时间清 `map` 的话,被清掉的 id 会一直躺在队列中间,
    /// 直到哪天被淘汰到队首 —— 长时间追剧下来队列只涨不落,属于慢漏。
    fn purge_expired(&mut self, now: u64) {
        self.map
            .retain(|_, s| now.saturating_sub(s.at) < SESSION_TTL_SECS);
        let map = &self.map;
        self.order.retain(|id| map.contains_key(id));
    }
}

/// 把绝对地址包成本地代理地址
pub fn wrap(url: &str, headers: &str) -> String {
    let port = ensure();
    let id = remember(url, headers);
    format!("http://127.0.0.1:{port}/s/{id}")
}

/// 起服务(只起一次),返回端口
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
                handle(req);
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
    let client = if streaming { http::client_stream() } else { http::client() };
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

    let resp = match http::get_once(&client, &target, &headers_out) {
        Ok(r) => r,
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


/// 把 m3u8 里的分片、子清单、密钥地址都换成代理地址
fn rewrite(text: &str, base: &str, headers: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
            continue;
        }
        if let Some(rest) = t.strip_prefix('#') {
            out.push('#');
            out.push_str(&rewrite_attrs(rest, base, headers));
            out.push('\n');
        } else {
            out.push_str(&wrap(&resolve(base, t), headers));
            out.push('\n');
        }
    }
    out
}

/// 处理 #EXT-X-KEY/#EXT-X-MAP 里的 URI="..."
fn rewrite_attrs(line: &str, base: &str, headers: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(pos) = rest.find("URI=\"") {
        let (head, tail) = rest.split_at(pos + 5);
        out.push_str(head);
        match tail.find('"') {
            Some(end) => {
                let uri = &tail[..end];
                out.push_str(&wrap(&resolve(base, uri), headers));
                rest = &tail[end..];
            }
            None => {
                out.push_str(tail);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 相对地址补全成绝对地址。
///
/// 主路交给 `url` crate:它按 RFC 3986 处理 `../`、`?query`、协议相对地址,
/// 手写拼接在这些地方都踩过坑。base 本身不是合法绝对地址时才退回字符串逻辑
/// (`url` 对 `data:` 这类非层级地址会拒绝 join)。
fn resolve(base: &str, uri: &str) -> String {
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(joined) = b.join(uri) {
            return joined.to_string();
        }
    }
    resolve_manually(base, uri)
}

/// 兜底:按"最后一个 `/` 之前是目录"手工拼
fn resolve_manually(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    if uri.starts_with("//") {
        return format!("https:{uri}");
    }
    let origin_end = base.find("://").map(|i| i + 3).unwrap_or(0);
    let after_host = base[origin_end..].find('/').map(|i| i + origin_end);
    let dir = match after_host {
        Some(_) => match base.rfind('/') {
            Some(p) => &base[..=p],
            None => base,
        },
        None => return format!("{base}/{uri}"),
    };
    if let Some(stripped) = uri.strip_prefix('/') {
        let host_end = base[origin_end..].find('/').map(|i| i + origin_end).unwrap_or(base.len());
        return format!("{}{}", &base[..host_end], format!("/{stripped}"));
    }
    format!("{dir}{uri}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个"302 之后"的签名清单地址:sig 在查询串里,目录和请求时可能已经不一样
    const BASE: &str = "https://cdn.example/hls/abc/index.m3u8?sig=1";

    fn rewritten(line: &str) -> String {
        rewrite(line, BASE, "[]")
    }

    /// 改写后的地址 → 它指向的真实地址。
    /// 只认"表里能查回这个地址",不比对地址长什么样:id 怎么算、用不用编码都是实现细节。
    fn target_of(addr: &str) -> String {
        assert!(
            addr.starts_with("http://127.0.0.1:"),
            "应该被包成本地代理地址: {addr}"
        );
        let id = addr.rsplit('/').next().unwrap_or_default();
        recall(id)
            .unwrap_or_else(|| panic!("会话表里应该有这个 id: {addr}"))
            .0
    }

    /// 从 `#EXT-X-KEY:…,URI="…"` 这类属性行里取出 URI 的值
    fn uri_attr(line: &str) -> String {
        let tail = line
            .split_once("URI=\"")
            .unwrap_or_else(|| panic!("属性行里应该有 URI: {line}"))
            .1;
        tail[..tail.find('"').expect("URI 的引号应该成对")].to_string()
    }

    #[test]
    fn relative_segment_is_joined_with_base_dir() {
        let out = rewritten("seg-1.ts");
        assert_eq!(
            target_of(out.trim()),
            "https://cdn.example/hls/abc/seg-1.ts"
        );
    }

    #[test]
    fn absolute_segment_is_kept() {
        let out = rewritten("https://cdn2.example/x.ts");
        assert_eq!(target_of(out.trim()), "https://cdn2.example/x.ts");
    }

    #[test]
    fn protocol_relative_segment_takes_base_scheme() {
        let out = rewritten("//cdn3.example/x.ts");
        assert_eq!(target_of(out.trim()), "https://cdn3.example/x.ts");
    }

    #[test]
    fn key_uri_is_rewritten() {
        let out = rewritten("#EXT-X-KEY:METHOD=AES-128,URI=\"key.key\"");
        assert!(
            out.starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:"),
            "{out}"
        );
        assert_eq!(
            target_of(&uri_attr(out.trim())),
            "https://cdn.example/hls/abc/key.key"
        );
    }

    #[test]
    fn map_uri_is_rewritten() {
        let out = rewritten("#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"");
        assert_eq!(
            target_of(&uri_attr(out.trim())),
            "https://cdn.example/hls/abc/init.mp4"
        );
        // BYTERANGE 在 URI 后面,不能被一起吃掉
        assert!(out.contains("BYTERANGE=\"720@0\""), "{out}");
    }

    #[test]
    fn media_uri_is_rewritten() {
        let out = rewritten(
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"cn\",URI=\"audio.m3u8\"",
        );
        assert_eq!(
            target_of(&uri_attr(out.trim())),
            "https://cdn.example/hls/abc/audio.m3u8"
        );
        assert!(out.contains("GROUP-ID=\"aud\""), "{out}");
    }

    #[test]
    fn low_latency_part_uri_is_rewritten() {
        let out = rewritten("#EXT-X-PART:DURATION=0.5,URI=\"part0.ts\"");
        assert_eq!(
            target_of(&uri_attr(out.trim())),
            "https://cdn.example/hls/abc/part0.ts"
        );
    }

    #[test]
    fn query_string_is_preserved() {
        let out = rewritten("seg-1.ts?token=deadbeef&n=2");
        assert_eq!(
            target_of(out.trim()),
            "https://cdn.example/hls/abc/seg-1.ts?token=deadbeef&n=2"
        );
    }

    #[test]
    fn other_lines_pass_through() {
        let text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2";
        let out = rewrite(text, BASE, "[]");
        assert!(out.starts_with("#EXTM3U\n#EXT-X-VERSION:3\n"), "{out}");
        assert!(out.contains("#EXT-X-TARGETDURATION:2"), "{out}");
    }

    #[test]
    fn hop_note_only_when_redirected() {
        assert_eq!(hop_note("https://a/x", "https://a/x"), "");
        let note = hop_note("https://a/x", "https://b/y");
        assert!(note.contains("base=https://b/y"), "{note}");
    }

    // ---- 播放会话 ----

    #[test]
    fn same_pair_always_gets_the_same_id() {
        let mut t = Sessions::new();
        let url = "https://v.example/live/index.m3u8";
        let headers = "[[\"Referer\",\"https://v.example/\"]]";
        let a = t.remember(url, headers, 1_000);
        let b = t.remember(url, headers, 1_001);
        assert_eq!(a, b, "直播清单每次刷新都会重新 wrap,id 必须稳定");
        assert_eq!(a.len(), 8, "8 位十六进制,和 source 的 id 风格一致: {a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "{a}");
        // 同一地址换一套头就是另一路流,不能共用会话
        let other = t.remember(url, "[]", 1_002);
        assert_ne!(a, other);
    }

    #[test]
    fn recall_returns_the_registered_pair() {
        let mut t = Sessions::new();
        let url = "https://v.example/a/index.m3u8?sig=2";
        let headers = "[[\"User-Agent\",\"Mozilla/5.0\"],[\"Cookie\",\"sid=1\"]]";
        let id = t.remember(url, headers, 1_000);
        assert_eq!(t.recall(&id), Some((url.to_string(), headers.to_string())));
    }

    #[test]
    fn recall_unknown_id_is_none() {
        assert_eq!(Sessions::new().recall("不存在"), None);
        assert_eq!(recall("不存在"), None);
    }

    #[test]
    fn table_is_capped_and_drops_the_oldest() {
        let mut t = Sessions::new();
        let n = MAX_SESSIONS + 4;
        let ids: Vec<String> = (0..n)
            .map(|i| t.remember(&format!("https://v.example/seg-{i}.ts"), "[]", 1_000 + i as u64))
            .collect();
        assert_eq!(t.map.len(), MAX_SESSIONS, "表不能超过上限");
        assert!(
            t.recall(ids.first().unwrap()).is_none(),
            "最早的那条应该被淘汰"
        );
        assert!(
            t.recall(ids.last().unwrap()).is_some(),
            "最新的那条必须还在"
        );
    }

    #[test]
    fn expired_entries_do_not_pile_up_in_the_order_queue() {
        let mut t = Sessions::new();
        let t0 = 1_000_000u64;
        let a = t.remember("https://v.example/a.m3u8", "[]", t0);
        let b = t.remember("https://v.example/b.m3u8", "[]", t0 + 10);
        // 6 小时后 C 进来:A 过期被清掉,但它在队列中间(B 还没到期)
        t.remember("https://v.example/c.m3u8", "[]", t0 + SESSION_TTL_SECS + 1);
        assert!(t.recall(&a).is_none(), "超过 6 小时就该清掉");
        assert!(t.recall(&b).is_some(), "没到期的要留着");
        assert_eq!(
            t.order.len(),
            t.map.len(),
            "队列里不能留着已清掉的 id —— 长期追剧会只涨不落"
        );
    }

    #[test]
    fn wrap_keeps_headers_out_of_the_url() {
        let headers = "[[\"Cookie\",\"sid=secret-value\"]]";
        let addr = wrap("https://v.example/a/index.m3u8", headers);
        assert!(addr.contains("/s/"), "{addr}");
        assert!(!addr.contains('?'), "地址里不该再有查询串: {addr}");
        assert!(!addr.contains("secret"), "请求头不能进地址: {addr}");
        assert!(addr.len() < 40, "地址要短: {addr}");
        assert_eq!(target_of(&addr), "https://v.example/a/index.m3u8");
    }

    #[test]
    fn legacy_p_address_still_decodes() {
        // 老地址 `/p?u=<b64>&h=<b64>` 必须继续能用:已缓存的页面、存下来的调试地址
        let addr = format!(
            "/p?u={}&h={}",
            enc("https://v.example/a/index.m3u8"),
            enc("[[\"Referer\",\"https://v.example/\"]]")
        );
        assert_eq!(
            query(&addr, "u").as_deref(),
            Some("https://v.example/a/index.m3u8")
        );
        assert_eq!(
            query(&addr, "h").as_deref(),
            Some("[[\"Referer\",\"https://v.example/\"]]")
        );
    }
}
