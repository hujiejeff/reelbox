//! 代理解析链。
//!
//! 这台机器访问采集站必须走本机的 Clash(127.0.0.1:7890),否则直接 `os error 10060`。
//! 但"代理在哪"随时会变(换端口、开/关系统代理、改环境变量),
//! 所以**每次请求前都重新解析**,只缓存 5 秒 —— 换端口不用重启应用。
//!
//! 应用里没有「单独设置代理」的开关:普通用户不该被问这件事,出口一律跟着系统走。
//! 解析顺序:
//!
//! 1. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`(大写小写都认),配了 `NO_PROXY` 就按它绕
//! 2. Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
//!    的 `ProxyEnable` + `ProxyServer` + `ProxyOverride`
//! 3. 都没有就直连。只有 `AutoConfigURL`(PAC 脚本)而没有 `ProxyServer` 时:**不猜**,
//!    记一条日志后直连 —— 自己实现 PAC 解释器只会猜错(js 脚本、DNS、多级回退)。
//!
//! 除了"现在走哪"([`route`]),还要回答"**没启用**但配着的代理在哪"([`outlook`]):
//! 用户装了代理工具却没打开系统开关时,直连失败后还有第二手可试(见 [`super::route`])。

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 解析结果缓存多久。够挡住一页列表几十个请求,又能在换端口后 5 秒内跟上。
pub const CACHE_TTL: Duration = Duration::from_secs(5);

/// 一次解析的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    /// 要走的代理,None = 直连
    pub proxy: Option<String>,
    /// 绕过列表(注册表的 ProxyOverride / 环境变量的 NO_PROXY),
    /// `<local>` 这类也原样交给 reqwest 判
    pub bypass: Option<String>,
    /// 从哪来的:env / registry / pac / default
    pub from: &'static str,
    /// 写进日志的一句话
    pub note: String,
}

impl Route {
    fn direct(from: &'static str, note: impl Into<String>) -> Self {
        Self { proxy: None, bypass: None, from, note: note.into() }
    }

    /// 缓存键:代理地址或绕过列表变了就要重建 HTTP 客户端
    pub fn key(&self) -> String {
        match (&self.proxy, &self.bypass) {
            (None, _) => "direct".to_string(),
            (Some(u), None) => format!("proxy:{u}"),
            (Some(u), Some(b)) => format!("proxy:{u}|bypass:{b}"),
        }
    }
}

/* ---------- 解析 ---------- */

/// 系统里代理的现状,给「按域名选路」用(见 [`super::route`])。
///
/// 与 [`Route`] 的区别:[`Route`] 只回答"这一条请求现在走哪",这里还要回答
/// "**没启用**但配着的代理在哪" —— 用户装了 Clash / v2ray 却没打开系统开关时,
/// 直连失败后那条路还有救。
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Outlook {
    /// 系统代理已启用(环境变量有值 / 注册表 `ProxyEnable=1`):地址在这
    pub active: Option<String>,
    /// 未启用,但注册表里仍留着 `ProxyServer`:地址在这,只当第二手
    pub dormant: Option<String>,
    /// 绕过列表(`ProxyOverride` / `NO_PROXY`)
    pub bypass: Option<String>,
    /// 写进日志的一句话
    pub note: String,
}

struct Cached {
    at: Instant,
    route: Route,
    outlook: Outlook,
    logged: String,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 当前该走哪条路。5 秒内复用上次结果,路由变化时记一条日志。
pub fn route() -> Route {
    snapshot().0
}

/// 系统代理的现状(与 [`route`] 共用同一份 5 秒缓存:一次解析同时喂两个问题,
/// 不会为了选路再 `reg query` 一遍)。
pub fn outlook() -> Outlook {
    snapshot().1
}

fn snapshot() -> (Route, Outlook) {
    let mut slot = match CACHE.lock() {
        Ok(s) => s,
        Err(poison) => poison.into_inner(),
    };
    if let Some(c) = slot.as_ref() {
        if c.at.elapsed() < CACHE_TTL {
            return (c.route.clone(), c.outlook.clone());
        }
    }
    let (route, outlook) = resolve();
    let key = route.key();
    let changed = slot.as_ref().map(|c| c.logged != key).unwrap_or(true);
    if changed {
        crate::net::log(&format!(
            "PROXY route={} note={}",
            route.proxy.as_deref().unwrap_or("direct"),
            route.note
        ));
    }
    *slot = Some(Cached {
        at: Instant::now(),
        route: route.clone(),
        outlook: outlook.clone(),
        logged: key,
    });
    (route, outlook)
}

/// 按系统的当前状态解析一次(不走缓存)
fn resolve() -> (Route, Outlook) {
    resolve_with(&env_proxy(), &read_registry(), &env_bypass())
}

/// 解析链的本体:环境变量 → 注册表 → 直连。
/// 两处输入从参数进来,单测才好按用例喂。
fn resolve_with(
    env: &Option<(&'static str, String)>,
    registry: &Option<RegistryProxy>,
    env_bypass: &Option<String>,
) -> (Route, Outlook) {
    if let Some((key, value)) = env {
        return match normalize_proxy(value) {
            Ok(url) => (
                Route {
                    proxy: Some(url.clone()),
                    bypass: env_bypass.clone(),
                    from: "env",
                    note: format!("环境变量 {key}"),
                },
                Outlook {
                    active: Some(url),
                    dormant: None,
                    bypass: env_bypass.clone(),
                    note: format!("环境变量 {key}"),
                },
            ),
            Err(e) => {
                // 环境变量写坏了:这一档不算"有代理",但注册表里若还留着地址,
                // 仍可以当第二手(直连都不行了,总比什么都不试强)
                let note = format!("环境变量 {key} 无效({e}),已直连");
                let (_, mut out) = registry_outlook(registry);
                // 注册表说"启用"的,退成第二手;本来就没启用的那份保持不动
                if let Some(active) = out.active.take() {
                    out.dormant = Some(active);
                }
                out.note = note.clone();
                (Route::direct("env", note), out)
            }
        };
    }
    registry_outlook(registry)
}

fn env_proxy() -> Option<(&'static str, String)> {
    // 大小写都认:Windows 上 `HTTP_PROXY` 常被别的程序写坏,所以小写也看
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some((key, value));
            }
        }
    }
    None
}

fn env_bypass() -> Option<String> {
    for key in ["NO_PROXY", "no_proxy"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/* ---------- Windows 注册表 ---------- */

/// `Internet Settings` 里我们关心的几个值
#[derive(Debug, Default, Clone, PartialEq)]
pub struct RegistryProxy {
    /// `ProxyEnable`(DWORD):0 = 用户关掉了系统代理
    pub enable: Option<u32>,
    /// `ProxyServer`:`127.0.0.1:7890` 或 `http=...;https=...`
    pub server: Option<String>,
    /// `ProxyOverride`:绕过列表,`<local>` 表示本机不过代理
    pub over: Option<String>,
    /// `AutoConfigURL`:PAC 脚本地址(只有它时我们不猜)
    pub pac: Option<String>,
}

impl RegistryProxy {
    pub fn enabled(&self) -> bool {
        self.enable.unwrap_or(0) != 0
    }
}

/// 注册表那一路:`Route`(现在走哪)+ `Outlook`(还配着什么)。
fn registry_outlook(reg: &Option<RegistryProxy>) -> (Route, Outlook) {
    let Some(reg) = reg else {
        return (
            Route::direct("default", "没有代理设置"),
            Outlook { note: "没有代理设置".to_string(), ..Default::default() },
        );
    };
    let bypass = reg.over.clone().filter(|s| !s.trim().is_empty());
    // `ProxyServer` 可能是 `host:port`,也可能是 `http=…;https=…`,都要先挑出能用的那条
    let parsed = reg.server.as_deref().map(proxy_from_server_list);
    if !reg.enabled() {
        // ProxyEnable=0:系统代理关着,这一条请求当然直连。
        // 但地址留在 dormant 里:用户装了代理工具却没打开系统开关时,
        // 直连失败后还有第二手可试(见 net::route::candidates)。
        return (
            Route::direct("registry", "系统代理未启用"),
            Outlook { active: None, dormant: parsed.flatten(), bypass, note: "系统代理未启用".into() },
        );
    }
    match parsed {
        Some(Some(url)) => (
            Route {
                proxy: Some(url.clone()),
                bypass: bypass.clone(),
                from: "registry",
                note: "系统代理(注册表)".to_string(),
            },
            Outlook {
                active: Some(url),
                dormant: None,
                bypass,
                note: "系统代理(注册表)".to_string(),
            },
        ),
        Some(None) => {
            let note = "注册表里的 ProxyServer 为空,已直连".to_string();
            (Route::direct("registry", note.clone()), Outlook { note, ..Default::default() })
        }
        None => {
            // 只有 PAC:不猜(要跑 JS、要判 DNS、要多级回退),记一条日志然后直连
            let note = "只配了 AutoConfigURL(PAC),不猜,已直连".to_string();
            (Route::direct("pac", note.clone()), Outlook { note, ..Default::default() })
        }
    }
}

/// 从 `ProxyServer` 里挑一条能用的,拼成 `scheme://host:port`。
///
/// 支持的写法:
/// - `127.0.0.1:7890`
/// - `http=127.0.0.1:7890;https=127.0.0.1:7890`
/// - `socks=127.0.0.1:7891`
///
/// 同一个端口的 HTTP 代理既接普通请求也接 CONNECT,所以 https 优先、再 http、最后裸地址。
pub fn proxy_from_server_list(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut plain: Option<String> = None;
    let mut http: Option<String> = None;
    let mut https: Option<String> = None;
    let mut socks: Option<String> = None;
    for entry in raw.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        match entry.split_once('=') {
            Some((scheme, addr)) => {
                let addr = addr.trim();
                if addr.is_empty() {
                    continue;
                }
                match scheme.trim().to_ascii_lowercase().as_str() {
                    "https" => https = https.or_else(|| Some(addr.to_string())),
                    "http" => http = http.or_else(|| Some(addr.to_string())),
                    "socks" | "socks5" => socks = socks.or_else(|| Some(addr.to_string())),
                    // ftp= / 其他协议不用
                    _ => {}
                }
            }
            None => {
                if plain.is_none() {
                    plain = Some(entry.to_string());
                }
            }
        }
    }
    if let Some(addr) = https.or(http).or(plain) {
        return normalize_proxy(&addr).ok();
    }
    socks.and_then(|addr| normalize_proxy(&format!("socks5://{addr}")).ok())
}

/// 读注册表(只在 Windows 上真读)。用 `reg query` 而不是 FFI:
/// 没有 unsafe,也不挑 windows-sys 的 feature 组合。
#[cfg(windows)]
fn read_registry() -> Option<RegistryProxy> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let out = std::process::Command::new("reg")
        .args(["query", KEY])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_reg_output(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(windows))]
fn read_registry() -> Option<RegistryProxy> {
    // 其他平台没有这份注册表:代理只从环境变量来
    None
}

/// 解析 `reg query` 的输出:
///
/// ```text
/// HKEY_CURRENT_USER\...\Internet Settings
///     ProxyEnable    REG_DWORD    0x1
///     ProxyServer    REG_SZ    127.0.0.1:7890
///     ProxyOverride    REG_SZ    <local>
/// ```
pub fn parse_reg_output(text: &str) -> RegistryProxy {
    let mut reg = RegistryProxy::default();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(kind) = parts.next() else { continue };
        // 值本身可能带空格(ProxyOverride 常见),所以剩下的整体当一个值
        let value = parts.collect::<Vec<_>>().join(" ");
        let value = value.trim();
        match (name, kind.to_ascii_uppercase().as_str()) {
            ("ProxyEnable", _) => {
                let n = value.trim_start_matches("0x").trim_start_matches("0X");
                reg.enable = u32::from_str_radix(n, 16)
                    .ok()
                    .or_else(|| value.parse::<u32>().ok());
            }
            ("ProxyServer", _) => {
                if !value.is_empty() {
                    reg.server = Some(value.to_string());
                }
            }
            ("ProxyOverride", _) => {
                if !value.is_empty() {
                    reg.over = Some(value.to_string());
                }
            }
            ("AutoConfigURL", _) => {
                if !value.is_empty() {
                    reg.pac = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    reg
}

/* ---------- 地址规范化 ---------- */

/// 把系统给的代理地址整理成 `scheme://host:port`。
///
/// 只认 http/https/socks*(采集站走 HTTP 代理的 CONNECT 就够,但环境变量里给 socks 也照收)。
pub fn normalize_proxy(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("代理地址为空".into());
    }
    if raw.chars().any(char::is_control) {
        return Err("代理地址含控制字符".into());
    }
    // Windows 上常见的写法:环境变量里给 `"127.0.0.1:7890"`,也可能带引号
    let raw = raw.trim_matches('"').trim();
    let (scheme, rest) = match raw.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r.to_string()),
        None => ("http".to_string(), raw.to_string()),
    };
    if !matches!(scheme.as_str(), "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h")
    {
        return Err(format!("代理协议只支持 http / https / socks,不认 {scheme}"));
    }
    if rest.contains('/') || rest.contains('?') || rest.contains('#') {
        return Err("代理地址不要带路径、参数或片段".into());
    }
    let (auth, hostport) = match rest.rsplit_once('@') {
        Some((a, h)) => (Some(a.to_string()), h.to_string()),
        None => (None, rest),
    };
    if hostport.is_empty() {
        return Err("代理地址缺少主机名".into());
    }
    // [::1]:7890 / [::1] / 127.0.0.1:7890 / 127.0.0.1
    let host = if let Some(rest) = hostport.strip_prefix('[') {
        let close = rest.find(']').ok_or("IPv6 地址缺少右方括号")?;
        rest[..close].to_string()
    } else {
        hostport.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_else(|| hostport.clone())
    };
    if host.is_empty() {
        return Err("代理地址缺少主机名".into());
    }
    // 端口:有冒号就必须是 1–65535
    let port = if hostport.starts_with('[') {
        hostport.rfind(']').and_then(|i| hostport[i + 1..].strip_prefix(':').map(|p| p.to_string()))
    } else {
        hostport.rsplit_once(':').map(|(_, p)| p.to_string())
    };
    match port.as_deref() {
        Some(p) => {
            let n: u16 = p.parse().map_err(|_| "代理端口应为 1–65535".to_string())?;
            if n == 0 {
                return Err("代理端口应为 1–65535".into());
            }
        }
        None => {}
    }
    let host = if host.contains(':') { format!("[{host}]") } else { host };
    let auth = match auth.as_deref() {
        None => String::new(),
        Some(a) => {
            if a.is_empty() || a.starts_with(':') {
                return Err("代理认证缺少用户名".into());
            }
            format!("{a}@")
        }
    };
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    let normalized = format!("{scheme}://{auth}{host}{port}");
    // 再交给 reqwest 验一遍:拼得出来但不合法(带空格之类)的在这里就拒掉
    reqwest::Proxy::all(&normalized).map_err(|_| "代理地址格式无效".to_string())?;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(env: Option<(&'static str, &str)>, reg: Option<RegistryProxy>) -> Route {
        // 走真正的解析链,只把"环境变量/注册表"这两处输入换掉
        resolve_with(&env.map(|(k, v)| (k, v.to_string())), &reg, &None).0
    }

    fn outlook_of(env: Option<(&'static str, &str)>, reg: Option<RegistryProxy>) -> Outlook {
        resolve_with(&env.map(|(k, v)| (k, v.to_string())), &reg, &None).1
    }

    #[test]
    fn normalizes_common_proxy_spellings() {
        assert_eq!(normalize_proxy("127.0.0.1:7890").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy(" 127.0.0.1:7890 ").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy("\"127.0.0.1:7890\"").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(normalize_proxy("HTTP://127.0.0.1:7890").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(
            normalize_proxy("socks5h://name:p%40ss@[::1]:1080").unwrap(),
            "socks5h://name:p%40ss@[::1]:1080"
        );
        assert_eq!(normalize_proxy("https://proxy.example:443").unwrap(), "https://proxy.example:443");
        for bad in [
            "",
            "ftp://proxy.example",
            "http://proxy.example/path",
            "http://proxy.example?token=x",
            "http://proxy.example#frag",
            "http://proxy.example:0",
            "http://:pass@proxy.example",
            "http://proxy.example\nname",
            "127.0.0.1:700000",
        ] {
            assert!(normalize_proxy(bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn reads_proxy_server_list() {
        assert_eq!(proxy_from_server_list("127.0.0.1:7890").as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(
            proxy_from_server_list("http=127.0.0.1:7890;https=127.0.0.1:7891").as_deref(),
            Some("http://127.0.0.1:7891"),
            "https 优先:同一个端口也能 CONNECT"
        );
        assert_eq!(
            proxy_from_server_list("http=127.0.0.1:7890;socks=127.0.0.1:7891").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            proxy_from_server_list("socks=127.0.0.1:7891").as_deref(),
            Some("socks5://127.0.0.1:7891")
        );
        assert_eq!(proxy_from_server_list("   "), None);
        assert_eq!(proxy_from_server_list("ftp=a:1"), None);
    }

    #[test]
    fn parses_reg_query_output() {
        let text = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    \
            AutoConfigURL    REG_SZ    http://127.0.0.1:7890/pac\r\n    \
            ProxyEnable    REG_DWORD    0x1\r\n    \
            ProxyOverride    REG_SZ    <local>;*.internal\r\n    \
            ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890\r\n";
        let reg = parse_reg_output(text);
        assert_eq!(reg.enable, Some(1));
        assert!(reg.enabled());
        assert_eq!(reg.server.as_deref(), Some("http=127.0.0.1:7890;https=127.0.0.1:7890"));
        assert_eq!(reg.over.as_deref(), Some("<local>;*.internal"));
        assert_eq!(reg.pac.as_deref(), Some("http://127.0.0.1:7890/pac"));
    }

    #[test]
    fn registry_disabled_or_pac_only_goes_direct() {
        // 关掉了:这条请求直连,但地址留着当第二手(装了工具没开系统开关)
        let off = RegistryProxy {
            enable: Some(0),
            server: Some("127.0.0.1:7890".into()),
            ..Default::default()
        };
        let (r, out) = registry_outlook(&Some(off));
        assert!(r.proxy.is_none());
        assert_eq!(r.from, "registry");
        assert_eq!(out.active, None);
        assert_eq!(out.dormant.as_deref(), Some("http://127.0.0.1:7890"));

        // 只有 PAC:不猜,直连,并说明原因
        let pac = RegistryProxy {
            enable: Some(1),
            server: None,
            over: None,
            pac: Some("http://127.0.0.1:7890/proxy.pac".into()),
        };
        let (r, out) = registry_outlook(&Some(pac));
        assert!(r.proxy.is_none());
        assert_eq!(r.from, "pac");
        assert!(r.note.contains("PAC"), "要说清为什么不走代理: {}", r.note);
        assert_eq!((out.active, out.dormant), (None, None), "PAC 不给地址:没得试,别猜");

        // 开了且给了 host:port:走它,并带上绕过列表
        let on = RegistryProxy {
            enable: Some(1),
            server: Some("127.0.0.1:7890".into()),
            over: Some("<local>".into()),
            pac: None,
        };
        let (r, out) = registry_outlook(&Some(on));
        assert_eq!(r.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(r.bypass.as_deref(), Some("<local>"));
        assert_eq!(r.from, "registry");
        assert_eq!(r.note, "系统代理(注册表)");
        assert_eq!(out.active.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(out.dormant, None);
        assert_eq!(out.bypass.as_deref(), Some("<local>"));

        // 注册表读不到(非 Windows / 没有这个键)
        let (r, out) = registry_outlook(&None);
        assert!(r.proxy.is_none());
        assert_eq!((out.active, out.dormant), (None, None));
    }

    #[test]
    fn outlook_carries_the_dormant_proxy() {
        // 系统开关关着、注册表里还留着地址 → 直连优先,那条地址是第二手
        let reg = RegistryProxy {
            enable: Some(0),
            server: Some("http=127.0.0.1:7890;https=127.0.0.1:7891".into()),
            over: Some("<local>".into()),
            pac: None,
        };
        let out = outlook_of(None, Some(reg));
        assert_eq!(out.active, None);
        assert_eq!(out.dormant.as_deref(), Some("http://127.0.0.1:7891"), "挑得出真正能用的那条");
        assert_eq!(out.bypass.as_deref(), Some("<local>"));

        // 环境变量有值 = 已启用
        let out = outlook_of(Some(("HTTPS_PROXY", "127.0.0.1:7890")), None);
        assert_eq!(out.active.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(out.dormant, None);

        // 完全没有代理配置:两个都是 None(选路就只剩直连一条)
        let out = outlook_of(None, None);
        assert_eq!((out.active, out.dormant), (None, None));
        assert!(out.note.contains("没有代理设置"), "{}", out.note);

        // 环境变量写坏了、注册表里有地址:那条退成第二手,不会凭空变成第一手
        let reg = RegistryProxy {
            enable: Some(1),
            server: Some("127.0.0.1:7890".into()),
            ..Default::default()
        };
        let out = outlook_of(Some(("HTTPS_PROXY", "not a proxy")), Some(reg));
        assert_eq!(out.active, None);
        assert_eq!(out.dormant.as_deref(), Some("http://127.0.0.1:7890"));
        assert!(out.note.contains("无效"), "{}", out.note);

        // 环境变量写坏了、注册表里本来就没启用:那条第二手照样留着,不能丢
        let reg = RegistryProxy {
            enable: Some(0),
            server: Some("127.0.0.1:7890".into()),
            ..Default::default()
        };
        let out = outlook_of(Some(("HTTPS_PROXY", "not a proxy")), Some(reg));
        assert_eq!((out.active, out.dormant.as_deref()), (None, Some("http://127.0.0.1:7890")));
    }

    #[test]
    fn env_wins_over_registry_then_direct() {
        let reg = Some(RegistryProxy {
            enable: Some(1),
            server: Some("10.0.0.9:8888".into()),
            ..Default::default()
        });
        // 环境变量盖过注册表
        let r = chain(Some(("HTTPS_PROXY", "127.0.0.1:7890")), reg.clone());
        assert_eq!(r.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(r.from, "env");

        // 环境变量写坏了:不猜,直连 + 说明
        let bad = chain(Some(("HTTPS_PROXY", "not a proxy")), None);
        assert!(bad.proxy.is_none());
        assert_eq!(bad.from, "env");
        assert!(bad.note.contains("无效"), "{}", bad.note);

        // 两处都没有:直连
        let none = chain(None, None);
        assert!(none.proxy.is_none());
        assert_eq!(none.from, "default");
    }

    #[test]
    fn route_key_splits_clients() {
        let r = Route::direct("default", "无");
        assert_eq!(r.key(), "direct");
        let r = Route {
            proxy: Some("http://127.0.0.1:7890".into()),
            bypass: None,
            from: "env",
            note: "x".into(),
        };
        assert_eq!(r.key(), "proxy:http://127.0.0.1:7890");
        let r = Route {
            proxy: Some("http://127.0.0.1:7890".into()),
            bypass: Some("<local>".into()),
            from: "registry",
            note: "x".into(),
        };
        assert_eq!(r.key(), "proxy:http://127.0.0.1:7890|bypass:<local>");
    }
}
