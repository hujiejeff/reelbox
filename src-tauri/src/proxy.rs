//! 本地 HLS 反代。
//! WebView 里直接播 m3u8 有三个坑:桌面 Chromium 不认 HLS、跨域被拦、防盗链要带 UA/Referer。
//! 这里起一个 127.0.0.1 上的小服务,把 m3u8 和分片都代理一遍,顺手改写里面的地址。

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use tiny_http::{Header, Response, Server};

static PORT: OnceLock<u16> = OnceLock::new();
const MAX_BYTES: u64 = 96 << 20;
const AGENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
    let mut r = Response::from_data(data);
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

    let mut call = ureq::get(&target)
        .timeout(Duration::from_secs(20))
        .set("User-Agent", AGENT_UA);
    if let Ok(list) = serde_json::from_str::<Vec<Vec<String>>>(&headers) {
        for kv in list {
            if kv.len() == 2 {
                call = call.set(&kv[0], &kv[1]);
            }
        }
    }
    if !headers.is_empty() && headers.contains("Referer") {
        // 已经通过 headers 设置
    }

    let resp = match call.call() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("proxy: 取 {target} 失败: {e}");
            let _ = req.respond(Response::empty(502));
            return;
        }
    };
    let ct = resp
        .header("content-type")
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut body = Vec::new();
    if resp.into_reader().take(MAX_BYTES).read_to_end(&mut body).is_err() {
        let _ = req.respond(Response::empty(502));
        return;
    }

    let is_playlist = target.contains(".m3u8")
        || body.starts_with(b"#EXTM3U")
        || ct.contains("mpegurl");
    if is_playlist {
        let text = String::from_utf8_lossy(&body).to_string();
        let out = rewrite(&text, &target, &headers);
        send(req, out.into_bytes(), "application/vnd.apple.mpegurl");
    } else {
        send(req, body, &ct);
    }
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
