//! 目标地址策略:哪些地址允许连。
//!
//! 插件是不可信代码,它发起的每一个请求都由宿主代发,所以本机和内网地址必须挡掉:
//! 否则一个恶意插件就能借宿主之手扫描 `127.0.0.1`、`192.168.*` 或云元数据。
//!
//! **唯一例外是 FakeIP**:Clash / sing-box 这类工具会把域名解析到 `198.18.0.0/15`
//! (RFC 2544 的基准测试网段),真实的 IP 由代理在出口处再换回来。把它当私网拦掉,
//! 走代理的采集站就一个都打不开 —— 这是"挡内网"和"能上网"之间的唯一冲突点。
//!
//! 另一个坑是 DNS 同时给出 IPv4 与 IPv6:代理的 FakeIP 是 IPv4,而系统 DNS 可能
//! 还回一条被拦的 IPv6(例如 `2001:2::`)。连接器会在这几条里挑,挑到被拦的那条
//! 就等于白挡 —— 所以只要有一条约可用的 IPv4,就把地址表收窄到"IPv4 或允许的地址"。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// 这个 IP 允不允许连。
///
/// IPv4:放行公网与 FakeIP(`198.18.0.0/15`),其余本机/私网/保留/组播一律挡。
/// IPv6:只放行全球单播;`::ffff:` 映射地址按其 IPv4 判断(这样 `::ffff:198.18.0.1`
/// 也能过,`::ffff:127.0.0.1` 照样被挡)。
pub fn allowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => allowed_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return allowed_v4(v4);
            }
            allowed_v6(v6)
        }
    }
}

/// IPv4:FakeIP 是明确例外,其余看黑名单
fn allowed_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    // FakeIP(Clash 的 fake-ip-range 默认 198.18.0.1/16,整段 198.18.0.0/15 都算)
    if a == 198 && (b == 18 || b == 19) {
        return true;
    }
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

/// IPv6:只认全球单播,排掉回环、ULA、链路本地、组播、NAT64 与 6to4/Teredo 这些能夹带私网 IPv4 的段
fn allowed_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    (s[0] & 0xe000) == 0x2000
        && s[0] != 0x2002
        && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
        && !(s[0] == 0x3fff && s[1] < 0x1000)
}

/// DNS 结果的整体判定。
///
/// 只要有一条约可用的 IPv4(FakeIP 就是 IPv4),就把 IPv6 里不该连的摘掉 ——
/// 绝不能因为"表里还有一条能用的"就放行会回退到私网的地址表。
pub fn validated_addresses(mut addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    if addrs.is_empty() {
        return Err("目标没有可用的 DNS 地址".into());
    }
    if addrs.iter().any(|a| a.is_ipv4() && allowed_ip(a.ip())) {
        addrs.retain(|a| a.is_ipv4() || allowed_ip(a.ip()));
    }
    for addr in &addrs {
        if !allowed_ip(addr.ip()) {
            return Err(format!("拒绝访问本机、内网或保留地址({})", addr.ip()));
        }
    }
    Ok(addrs)
}

/// 主机名是不是 IP 字面量(支持 `[::1]`、`::ffff:127.0.0.1`)
pub fn ip_literal(host: &str) -> Option<IpAddr> {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    h.parse::<IpAddr>().ok()
}

/// 这个主机名/字面量地址允不允许连。
pub fn allowed_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host == "localhost.localdomain" {
        return false;
    }
    if let Some(ip) = ip_literal(&host) {
        return allowed_ip(ip);
    }
    // 纯数字形式的地址(2130706433 == 127.0.0.1):别让插件绕过去
    if host.chars().all(|c| c.is_ascii_digit()) && host.len() >= 8 {
        return false;
    }
    // 单个 0x 形式的字面量(0x7f000001)
    if host.starts_with("0x") || host.starts_with("0X") {
        if is_hex_part(&host) {
            return false;
        }
    }
    // 十进制/八进制/十六进制的花式写法(`127.1`、`0x7f000001`、`017700000001`)一律不认:
    // 交给系统解析等于绕过检查
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 2 && parts.iter().all(|p| is_numeric_part(p)) {
        return false;
    }
    true
}

fn is_numeric_part(part: &str) -> bool {
    if part.is_empty() {
        return false;
    }
    if part.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    is_hex_part(part)
}

fn is_hex_part(part: &str) -> bool {
    let p = part.trim_start_matches("0x").trim_start_matches("0X");
    !p.is_empty() && p.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(list: &[&str]) -> Vec<SocketAddr> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn fakeip_is_allowed() {
        for ip in [
            "198.18.0.0",
            "198.18.0.1",
            "198.18.255.255",
            "198.19.0.1",
            "198.19.255.255",
            "::ffff:198.18.0.1",
        ] {
            assert!(allowed_ip(ip.parse().unwrap()), "{ip} 是 FakeIP,应放行");
        }
        // 紧挨着的 198.17 / 198.20 是普通公网地址,本来就放行 —— 这里只是确认
        // FakeIP 例外没有把整段 198/8 都放开(198.51.100.0/24 是文档保留段,必须挡)
        assert!(allowed_ip("198.17.255.255".parse().unwrap()));
        assert!(!allowed_ip("198.51.100.1".parse().unwrap()));
    }

    #[test]
    fn public_addresses_are_allowed() {
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "104.244.43.231",
            "172.32.0.1",
            "2606:4700:4700::1111",
            "::ffff:1.1.1.1",
        ] {
            assert!(allowed_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn private_and_special_addresses_are_blocked() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "192.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "64:ff9b::c0a8:101",
            "2002:c0a8:101::1",
            "2001::1",
            "2001:db8::1",
            "3fff::1",
        ] {
            assert!(!allowed_ip(ip.parse().unwrap()), "{ip} 应被挡");
        }
    }

    #[test]
    fn fakeip_survives_a_blocked_ipv6_in_the_same_dns_answer() {
        // 代理的 FakeIP(IPv4)+ 系统 DNS 顺带回的一条被拦 IPv6:
        // 收窄成 IPv4 之后可以连,绝不能回退到那条 IPv6。
        let kept = validated_addresses(addrs(&["[2001:2::65]:443", "198.18.0.71:443"])).unwrap();
        assert_eq!(kept, addrs(&["198.18.0.71:443"]));

        // 只有被拦的 IPv6:整张表拒掉
        assert!(validated_addresses(addrs(&["[2001:2::65]:443"])).is_err());

        // 公网 IPv4 + 可用 IPv6 都在:两条都留
        let kept = validated_addresses(addrs(&["[2606:4700:4700::1111]:443", "1.1.1.1:443"])).unwrap();
        assert_eq!(kept.len(), 2, "允许的地址不该被误删: {kept:?}");

        // 私网 IPv4 与被拦 IPv6 混在一起:拒
        assert!(validated_addresses(addrs(&["127.0.0.1:443", "[::1]:443"])).is_err());
        // 空表:拒
        assert!(validated_addresses(Vec::new()).is_err());
    }

    #[test]
    fn host_names_are_judged_too() {
        assert!(!allowed_host("localhost"));
        assert!(!allowed_host("LOCALHOST."));
        assert!(!allowed_host("nas.localhost"));
        assert!(!allowed_host("127.0.0.1"));
        assert!(!allowed_host("[::1]"));
        assert!(!allowed_host("10.1.2.3"));
        assert!(!allowed_host("2130706433"));
        assert!(!allowed_host("0x7f000001"));
        assert!(!allowed_host("127.1"));
        assert!(allowed_host("www.4kvm.net"));
        assert!(allowed_host("198.18.0.7"));
        assert!(allowed_host("[::ffff:198.18.0.7]"));
        assert!(allowed_host("example.com"));
    }
}
