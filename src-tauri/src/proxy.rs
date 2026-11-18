//! 本地 HLS 反代。
//! WebView 里直接播 m3u8 有三个坑:桌面 Chromium 不认 HLS、跨域被拦、防盗链要带 UA/Referer。
//! 这里起一个 127.0.0.1 上的小服务,把 m3u8 和分片都代理一遍,顺手改写里面的地址。

use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use reelbox_core::net::http;
use tiny_http::{Header, Method, Response, Server};

use crate::logging;

static PORT: OnceLock<u16> = OnceLock::new();
const MAX_BYTES: u64 = 96 << 20;

fn enc(s: &str) -> String {
    B64.encode(s.as_bytes())
}

fn dec(s: &str) -> Option<String> {
    B64.decode(s.as_bytes())
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
}

/// 把绝对地址包成本地代理地址
pub fn wrap(url: &str, headers: &str) -> String {
    let port = ensure();
    format!(
        "http://127.0.0.1:{port}/p?u={}&h={}",
        enc(url),
        enc(headers)
    )
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
    if !url.starts_with("/p?") {
        let _ = req.respond(Response::empty(404));
        return;
    }
    let (Some(target), headers) = (query(&url, "u"), query(&url, "h").unwrap_or_default()) else {
        let _ = req.respond(Response::empty(400));
        return;
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
            "PROXY http status={status} ct={ct} target={} {header_note} body={}",
            short(&target, 160),
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
                "PROXY media status={status} ct={ct} len={:?} range={:?} target={}",
                len,
                range,
                short(&target, 120)
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
            "PROXY m3u8 status={status} bytes={} ct={ct} ce={ce} target={} {header_note}",
            body.len(),
            short(&target, 160)
        ));
        let text = String::from_utf8_lossy(&body).to_string();
        let out = rewrite(&text, &target, &headers);
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

/// 相对地址补全成绝对地址
fn resolve(base: &str, uri: &str) -> String {
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
