//! 插件网络出口的白名单检查。
//!
//! 插件跑在 WebView 的沙箱 iframe 里,但它的每一个请求最终都由 Rust 的
//! `plugin_fetch` 发出。插件是不可信代码,所以这里必须挡掉指向本机和内网的地址:
//! 否则一个恶意插件就能借宿主之手扫描 `127.0.0.1`、`192.168.*` 这些地址。
//!
//! 「哪些地址算内网」的判定在 [`crate::net::policy`]:那边还处理了 FakeIP
//! (`198.18.0.0/15`,走 Clash 时必须放行)和 `::ffff:` 映射地址。

use std::net::IpAddr;

/// 从 URL 里取出主机名(小写,去掉 IPv6 的方括号),取不到返回 None
pub fn host_of(url: &str) -> Option<String> {
    let rest = match url.split_once("://") {
        Some((scheme, rest)) => {
            let s = scheme.trim().to_ascii_lowercase();
            if s != "http" && s != "https" {
                return None;
            }
            rest
        }
        // 没有 scheme 的一律不认
        None => return None,
    };
    // 去掉 userinfo:`user:pass@host`
    let rest = match rest.rfind('@') {
        Some(i) => &rest[i + 1..],
        None => rest,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() {
        return None;
    }
    let host = if authority.starts_with('[') {
        // [::1]:8080
        let close = authority.find(']')?;
        &authority[1..close]
    } else {
        match authority.rfind(':') {
            Some(i) => &authority[..i],
            None => authority,
        }
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// 这个地址是不是只属于本机/内网(以及非 http(s) 协议)
pub fn is_private_url(url: &str) -> bool {
    match host_of(url) {
        Some(host) => !crate::net::policy::allowed_host(&host),
        None => true,
    }
}

/// 主机名里的字面量 IP(给 DNS 之后的二次检查用)
pub fn literal_ip(host: &str) -> Option<IpAddr> {
    crate::net::policy::ip_literal(host)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_host() {
        assert_eq!(host_of("https://www.4kvm.net/play/abc?x=1").as_deref(), Some("www.4kvm.net"));
        assert_eq!(host_of("http://User:pw@Host.Example.com:8080/a").as_deref(), Some("host.example.com"));
        assert_eq!(host_of("https://[::1]:9000/x").as_deref(), Some("::1"));
        assert_eq!(host_of("ftp://example.com/x"), None);
        assert_eq!(host_of("no-scheme/x"), None);
    }

    #[test]
    fn rejects_loopback() {
        for u in [
            "http://127.0.0.1:8080/x",
            "http://127.5.5.5/",
            "http://localhost/x",
            "http://LOCALHOST:1234/",
            "https://[::1]/x",
            "http://0.0.0.0/",
        ] {
            assert!(is_private_url(u), "{u} 应该被拒");
        }
    }

    #[test]
    fn rejects_private_ranges() {
        for u in [
            "http://10.1.2.3/x",
            "http://192.168.1.1/x",
            "http://172.16.0.9/x",
            "http://172.31.255.1/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/x",
        ] {
            assert!(is_private_url(u), "{u} 应该被拒");
        }
    }

    #[test]
    fn allows_public_hosts() {
        for u in [
            "https://www.4kvm.net/play/abc",
            "https://example.com/a.m3u8",
            "http://172.32.0.1/x",
        ] {
            assert!(!is_private_url(u), "{u} 应该放行");
        }
    }

    #[test]
    fn allows_fakeip_but_still_rejects_mapped_private() {
        // Clash 的 FakeIP 段必须放行,否则挂代理时所有采集站都打不开
        for u in [
            "http://198.18.0.7/api.php/provide/vod",
            "https://198.19.3.9/x",
            "http://[::ffff:198.18.0.7]/x",
        ] {
            assert!(!is_private_url(u), "{u} 是 FakeIP,应放行");
        }
        // 映射写法不能成为后门
        for u in ["http://[::ffff:127.0.0.1]/x", "http://[::ffff:192.168.1.1]/x"] {
            assert!(is_private_url(u), "{u} 应被挡");
        }
        assert_eq!(literal_ip("[::ffff:198.18.0.7]").map(|i| i.to_string()).as_deref(), Some("::ffff:198.18.0.7"));
        assert!(literal_ip("example.com").is_none());
    }

    #[test]
    fn rejects_non_http_and_garbage() {
        assert!(is_private_url("file:///C:/Windows/win.ini"));
        assert!(is_private_url("data:text/html,hi"));
        assert!(is_private_url(""));
    }
}
