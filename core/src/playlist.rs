//! HLS 清单(m3u8)改写:纯字符串逻辑。
//!
//! 这里不认识 Tauri、不认识 tiny_http、也不认识请求头。"把这个地址换成本地代理地址"
//! 这件事由调用方以闭包形式传进来(`wrap`),所以本模块可以直接单测 ——
//! 反代服务那套 staticlib/cdylib 产物在本机跑不了测试(见 src-tauri/Cargo.toml
//! 的 crate-type 说明),逻辑留在这里才有证据。

/// 把 m3u8 里的分片、子清单、密钥地址都交给 `wrap` 换成代理地址。
///
/// - 非 `#` 开头的行(分片、子清单)先 [`resolve`] 补全,再交给 `wrap`
/// - 属性行里的 `URI="…"`(`#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` /
///   `#EXT-X-PART` / `#EXT-X-PRELOAD-HINT`)同样补全再 wrap;
///   这里保持"通用扫描 `URI=`"的做法,新的属性行不用再改一遍
/// - 其余行(#EXTM3U、#EXT-X-VERSION、#EXTINF …)原样透传
///
/// 每个 URI 恰好 wrap 一次:漏了播放器会直连源站(跨域/防盗链全挂),
/// 重复包会让地址套娃。
pub fn rewrite(text: &str, base: &str, wrap: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
            continue;
        }
        if let Some(rest) = t.strip_prefix('#') {
            out.push('#');
            out.push_str(&rewrite_attrs(rest, base, wrap));
            out.push('\n');
        } else {
            out.push_str(&wrap(&resolve(base, t)));
            out.push('\n');
        }
    }
    out
}

/// 处理属性行里的 `URI="..."`(`#EXT-X-KEY:METHOD=AES-128,URI="key.key"`)
fn rewrite_attrs(line: &str, base: &str, wrap: &dyn Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(pos) = rest.find("URI=\"") {
        let (head, tail) = rest.split_at(pos + 5);
        out.push_str(head);
        match tail.find('"') {
            Some(end) => {
                let uri = &tail[..end];
                out.push_str(&wrap(&resolve(base, uri)));
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
pub fn resolve(base: &str, uri: &str) -> String {
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
    use std::cell::RefCell;

    use super::{resolve, rewrite};

    /// 一个"302 之后"的签名清单地址:sig 在查询串里,目录和请求时可能已经不一样
    const BASE: &str = "https://cdn.example/hls/abc/index.m3u8?sig=1";

    /// 假 wrap:把目标地址缀在 `local:` 后面当占位地址。
    /// 真实现(localhost 端口 + 会话 id)在 src-tauri 那侧,这里只关心"给了什么地址";
    /// 要记账的版本见 `every_uri_is_wrapped_exactly_once` 里的闭包。
    fn fake(uri: &str) -> String {
        format!("local:{uri}")
    }

    /// 改写后的地址 → 它指向的真实地址(去掉假 wrap 的前缀)
    fn target_of(addr: &str) -> String {
        assert!(
            addr.starts_with("local:"),
            "应该被 wrap 成代理地址: {addr}"
        );
        addr.trim_start_matches("local:").to_string()
    }

    /// 从 `#EXT-X-KEY:…,URI="…"` 这类属性行里取出 URI 的值
    fn uri_attr(line: &str) -> String {
        let tail = line
            .split_once("URI=\"")
            .unwrap_or_else(|| panic!("属性行里应该有 URI: {line}"))
            .1;
        tail[..tail.find('"').expect("URI 的引号应该成对")].to_string()
    }

    /// 单行改写(多半是分片地址,也可能是一条属性行)
    fn rewritten(line: &str) -> String {
        rewrite(line, BASE, &fake)
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
        assert!(out.starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"local:"), "{out}");
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
        let out = rewrite(text, BASE, &fake);
        assert!(out.starts_with("#EXTM3U\n#EXT-X-VERSION:3\n"), "{out}");
        assert!(out.contains("#EXT-X-TARGETDURATION:2"), "{out}");
    }

    #[test]
    fn redirected_base_moves_the_directory() {
        // base 必须是**跳转后的最终地址**:源站 302 到另一台主机、另一个目录之后,
        // 按请求时的地址拼出来的分片会整片 404
        let base = "https://cdn2.example/other/dir/index.m3u8";
        let out = rewrite("seg-1.ts", base, &fake);
        assert_eq!(
            target_of(out.trim()),
            "https://cdn2.example/other/dir/seg-1.ts"
        );
        // resolve 本身也照这个走
        assert_eq!(
            resolve(base, "seg-1.ts"),
            "https://cdn2.example/other/dir/seg-1.ts"
        );
    }

    #[test]
    fn every_uri_is_wrapped_exactly_once() {
        let text = "\
#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI=\"key.key\"
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"cn\",URI=\"audio.m3u8\"
#EXT-X-PART:DURATION=0.5,URI=\"part0.ts\"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"part1.ts\"
#EXTINF:2.0,
seg-1.ts
#EXTINF:2.0,
seg-2.ts
";
        let seen: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let out = rewrite(text, BASE, &|u: &str| {
            seen.borrow_mut().push(u.to_string());
            format!("local:{u}")
        });
        let seen = seen.into_inner();

        // 漏了、乱了:逐条比对期望的绝对地址与顺序
        assert_eq!(
            seen,
            vec![
                "https://cdn.example/hls/abc/key.key".to_string(),
                "https://cdn.example/hls/abc/init.mp4".to_string(),
                "https://cdn.example/hls/abc/audio.m3u8".to_string(),
                "https://cdn.example/hls/abc/part0.ts".to_string(),
                "https://cdn.example/hls/abc/part1.ts".to_string(),
                "https://cdn.example/hls/abc/seg-1.ts".to_string(),
                "https://cdn.example/hls/abc/seg-2.ts".to_string(),
            ],
            "每个 URI 都该被 wrap 一次"
        );
        // 重复包会让地址套娃:输出里每个占位地址只能出现一次
        for u in &seen {
            assert_eq!(
                out.matches(&format!("local:{u}")).count(),
                1,
                "{} 应该恰好出现一次:\n{out}",
                u
            );
        }
    }
}
