//! 代理解析链。
//!
//! 这台机器访问采集站必须走本机的 Clash(127.0.0.1:7890),否则直接 `os error 10060`。
//! 但"代理在哪"有三个来源,而且随时会变(换端口、开/关系统代理、改环境变量),
//! 所以**每次请求前都重新解析**,只缓存 5 秒 —— 换端口不用重启应用。
//!
//! 解析顺序(`mode = system` 时):
//!
//! 1. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`(大写小写都认)
//! 2. Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
//!    的 `ProxyEnable` + `ProxyServer` + `ProxyOverride`
//! 3. 只有 `AutoConfigURL`(PAC 脚本)而没有 `ProxyServer` 时:**不猜**,记一条日志并直连。
//!    自己实现 PAC 解释器只会猜错(js 脚本、DNS、多级回退),不如把这件事交给用户。
//!
//! 设置页可以把模式钉成"手动填 host:port"或"不使用代理",存
//! `<数据目录>/settings.json`(桌面是 `%APPDATA%\reelbox\settings.json`)。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 解析结果缓存多久。够挡住一页列表几十个请求,又能在换端口后 5 秒内跟上。
pub const CACHE_TTL: Duration = Duration::from_secs(5);

/// 用户选的代理模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// 跟随系统(环境变量 → 注册表)
    System,
    /// 手动:用 `Settings::url`
    Manual,
    /// 不使用代理
    Off,
}

impl Default for Mode {
    fn default() -> Self {
        Self::System
    }
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Manual => "manual",
            Self::Off => "off",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "system" | "auto" | "" => Ok(Self::System),
            "manual" | "custom" => Ok(Self::Manual),
            "off" | "none" | "direct" => Ok(Self::Off),
            _ => Err("代理模式无效(只认 system / manual / off)".into()),
        }
    }
}

/// 设置页里的「网络」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub mode: Mode,
    /// 手动模式下的 `host:port`(规范化后带 scheme)
    #[serde(default)]
    pub url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { mode: Mode::System, url: String::new() }
    }
}

/// 一次解析的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Route {
    /// 要走的代理,None = 直连
    pub proxy: Option<String>,
    /// 绕过列表(注册表的 ProxyOverride),`<local>` 这类也原样交给 reqwest 判
    pub bypass: Option<String>,
    /// 从哪来的:env / registry / manual / off / pac / default
    pub from: &'static str,
    /// 写进日志与设置页的一句话
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

    /// 设置页/日志里的一行摘要
    pub fn describe(&self) -> String {
        match &self.proxy {
            Some(u) => format!("{u} · 来自 {}", self.from),
            None => format!("直连 · {}", self.note),
        }
    }
}

/* ---------- 设置文件 ---------- */

/// 设置文件路径。桌面是 `%APPDATA%/reelbox/settings.json`;
/// 移动端由宿主在启动时用 Tauri 解析出的目录覆盖(`bind_dir`)。
static SETTINGS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 宿主启动时把数据目录告诉 core(移动端 `%APPDATA%` 不存在,只有 Tauri 知道真目录)
pub fn bind_dir(dir: impl Into<PathBuf>) {
    if let Ok(mut slot) = SETTINGS_DIR.lock() {
        *slot = Some(dir.into());
    }
    invalidate();
}

fn settings_dir() -> PathBuf {
    if let Some(dir) = SETTINGS_DIR.lock().ok().and_then(|d| d.clone()) {
        return dir;
    }
    // 没绑过(单测、CLI)就按桌面惯例自己找
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir)
        .join("reelbox")
}

pub fn settings_path() -> PathBuf {
    settings_dir().join("settings.json")
}

/// 读设置。文件缺失、读不动、JSON 坏了都退回默认值(跟随系统),绝不报错。
pub fn settings() -> Settings {
    let text = match std::fs::read_to_string(settings_path()) {
        Ok(t) => t,
        Err(_) => return Settings::default(),
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Settings::default(),
    };
    Settings::decode(&value)
}

/// 写设置(只动 `network.proxy` 这一段,别的设置原样保留)
pub fn save_settings(next: &Settings) -> Result<Settings, String> {
    let normalized = normalize_settings(next)?;
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let mut doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    doc["network"] = serde_json::json!({
        "proxy": { "mode": normalized.mode.as_str(), "url": normalized.url }
    });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化失败: {e}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("写设置失败: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("写设置失败: {e}"))?;
    invalidate();
    crate::net::log(&format!(
        "SETTINGS proxy mode={} url={}",
        normalized.mode.as_str(),
        if normalized.url.is_empty() { "—" } else { &normalized.url }
    ));
    Ok(normalized)
}

impl Settings {
    fn decode(doc: &serde_json::Value) -> Self {
        let proxy = doc.get("network").and_then(|n| n.get("proxy"));
        let Some(proxy) = proxy else {
            return Self::default();
        };
        let mode = proxy
            .get("mode")
            .and_then(|m| m.as_str())
            .and_then(|m| Mode::parse(m).ok())
            .unwrap_or_default();
        let url = proxy.get("url").and_then(|u| u.as_str()).unwrap_or("").trim().to_string();
        Self { mode, url }
    }
}

fn normalize_settings(s: &Settings) -> Result<Settings, String> {
    match s.mode {
        Mode::Manual => {
            let url = normalize_proxy(&s.url)?;
            Ok(Settings { mode: Mode::Manual, url })
        }
        // 切到别的模式时保留已填的手动地址,免得来回切要重填
        other => Ok(Settings { mode: other, url: s.url.trim().to_string() }),
    }
}

/* ---------- 解析 ---------- */

struct Cached {
    at: Instant,
    route: Route,
    logged: String,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// 丢掉缓存(设置改了、或者宿主想立刻生效)
pub fn invalidate() {
    if let Ok(mut slot) = CACHE.lock() {
        *slot = None;
    }
}

/// 当前该走哪条路。5 秒内复用上次结果,路由变化时记一条日志。
pub fn route() -> Route {
    let mut slot = match CACHE.lock() {
        Ok(s) => s,
        Err(poison) => poison.into_inner(),
    };
    if let Some(c) = slot.as_ref() {
        if c.at.elapsed() < CACHE_TTL {
            return c.route.clone();
        }
    }
    let route = resolve(&settings());
    let key = route.key();
    let changed = slot.as_ref().map(|c| c.logged != key).unwrap_or(true);
    if changed {
        crate::net::log(&format!(
            "PROXY route={} note={}",
            route.proxy.as_deref().unwrap_or("direct"),
            route.note
        ));
    }
    *slot = Some(Cached { at: Instant::now(), route: route.clone(), logged: key });
    route
}

/// 按设置解析一次(不走缓存,设置页/测试用)
pub fn resolve(settings: &Settings) -> Route {
    resolve_with(settings, &env_proxy(), &read_registry(), &env_bypass())
}

/// 解析链的本体。环境变量与注册表从参数进来,单测才好按用例喂。
fn resolve_with(
    settings: &Settings,
    env: &Option<(&'static str, String)>,
    registry: &Option<RegistryProxy>,
    env_bypass: &Option<String>,
) -> Route {
    match settings.mode {
        Mode::Off => Route::direct("off", "设置:不使用代理"),
        Mode::Manual => match normalize_proxy(&settings.url) {
            Ok(url) => Route {
                proxy: Some(url.clone()),
                bypass: None,
                from: "manual",
                note: format!("设置:手动 {url}"),
            },
            Err(e) => Route::direct("manual", format!("设置:手动地址无效({e}),已直连")),
        },
        Mode::System => {
            if let Some((key, value)) = env {
                return match normalize_proxy(value) {
                    Ok(url) => Route {
                        proxy: Some(url),
                        bypass: env_bypass.clone(),
                        from: "env",
                        note: format!("环境变量 {key}"),
                    },
                    Err(e) => {
                        Route::direct("env", format!("环境变量 {key} 无效({e}),已直连"))
                    }
                };
            }
            registry_route(registry)
        }
    }
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

fn registry_route(reg: &Option<RegistryProxy>) -> Route {
    let Some(reg) = reg else {
        return Route::direct("default", "没有代理设置");
    };
    if !reg.enabled() {
        // ProxyEnable=0:系统代理关着,但 PAC 还留着。这时直连是对的,不用提示。
        return Route::direct("registry", "系统代理未启用");
    }
    match reg.server.as_deref().map(proxy_from_server_list) {
        Some(Some(url)) => Route {
            proxy: Some(url),
            bypass: reg.over.clone().filter(|s| !s.trim().is_empty()),
            from: "registry",
            note: "系统代理(注册表)".to_string(),
        },
        Some(None) => Route::direct("registry", "注册表里的 ProxyServer 为空,已直连"),
        None => {
            // 只有 PAC:不猜(要跑 JS、要判 DNS、要多级回退),记一条日志然后直连
            if reg.pac.is_some() || reg.server.is_none() {
                Route::direct("pac", "只配了 AutoConfigURL(PAC),不猜,已直连")
            } else {
                Route::direct("registry", "注册表里没有 ProxyServer,已直连")
            }
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

/// 把用户/系统给的代理地址整理成 `scheme://host:port`。
///
/// 只认 http/https/socks*(采集站走 HTTP 代理的 CONNECT 就够,但环境变量里给 socks 也照收)。
pub fn normalize_proxy(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("请填代理地址(例:127.0.0.1:7890)".into());
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

    fn system(env: Option<(&'static str, &str)>, reg: Option<RegistryProxy>) -> Route {
        // 走真正的解析链,只把"环境变量/注册表"这两处输入换掉
        resolve_with(
            &Settings::default(),
            &env.map(|(k, v)| (k, v.to_string())),
            &reg,
            &None,
        )
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
        // 关掉了:直连
        let off = RegistryProxy {
            enable: Some(0),
            server: Some("127.0.0.1:7890".into()),
            ..Default::default()
        };
        let r = registry_route(&Some(off));
        assert!(r.proxy.is_none());
        assert_eq!(r.from, "registry");

        // 只有 PAC:不猜,直连,并说明原因
        let pac = RegistryProxy {
            enable: Some(1),
            server: None,
            over: None,
            pac: Some("http://127.0.0.1:7890/proxy.pac".into()),
        };
        let r = registry_route(&Some(pac));
        assert!(r.proxy.is_none());
        assert_eq!(r.from, "pac");
        assert!(r.note.contains("PAC"), "要说清为什么不走代理: {}", r.note);

        // 开了且给了 host:port:走它,并带上绕过列表
        let on = RegistryProxy {
            enable: Some(1),
            server: Some("127.0.0.1:7890".into()),
            over: Some("<local>".into()),
            pac: None,
        };
        let r = registry_route(&Some(on));
        assert_eq!(r.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(r.bypass.as_deref(), Some("<local>"));
        assert_eq!(r.from, "registry");

        // 注册表读不到(非 Windows / 没有这个键)
        assert!(registry_route(&None).proxy.is_none());
    }

    #[test]
    fn env_wins_over_registry_and_off_wins_over_both() {
        let reg = Some(RegistryProxy {
            enable: Some(1),
            server: Some("10.0.0.9:8888".into()),
            ..Default::default()
        });
        let r = system(Some(("HTTPS_PROXY", "127.0.0.1:7890")), reg.clone());
        assert_eq!(r.proxy.as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(r.from, "env");

        let off = resolve(&Settings { mode: Mode::Off, url: "127.0.0.1:7890".into() });
        assert!(off.proxy.is_none());
        assert_eq!(off.from, "off");

        let manual = resolve(&Settings { mode: Mode::Manual, url: "127.0.0.1:7891".into() });
        assert_eq!(manual.proxy.as_deref(), Some("http://127.0.0.1:7891"));
        assert_eq!(manual.from, "manual");

        // 手动填了坏地址:不猜,直连 + 说明
        let bad = resolve(&Settings { mode: Mode::Manual, url: "not a proxy".into() });
        assert!(bad.proxy.is_none());
        assert!(bad.note.contains("无效"));
    }

    #[test]
    fn settings_round_trip_keeps_other_keys() {
        let dir = std::env::temp_dir().join(format!("reelbox-proxy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"playback":{"quality":"high"},"network":{"proxy":{"mode":"off","url":""}}}"#,
        )
        .unwrap();
        bind_dir(&dir);

        assert_eq!(settings().mode, Mode::Off);
        let saved = save_settings(&Settings { mode: Mode::Manual, url: "127.0.0.1:7890".into() })
            .expect("保存失败");
        assert_eq!(saved.mode, Mode::Manual);
        assert_eq!(saved.url, "http://127.0.0.1:7890");

        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(text.contains("playback"), "别的设置不能丢: {text}");
        assert!(text.contains("\"mode\": \"manual\""), "{text}");
        assert_eq!(settings().url, "http://127.0.0.1:7890");

        // 坏文件:退回默认(跟随系统),不 panic
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert_eq!(settings().mode, Mode::System);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mode_parsing_and_route_key() {
        assert_eq!(Mode::parse("SYSTEM").unwrap(), Mode::System);
        assert_eq!(Mode::parse("").unwrap(), Mode::System);
        assert_eq!(Mode::parse("manual").unwrap(), Mode::Manual);
        assert_eq!(Mode::parse("direct").unwrap(), Mode::Off);
        assert!(Mode::parse("sneaky").is_err());

        let r = Route::direct("off", "无");
        assert_eq!(r.key(), "direct");
        let r = Route {
            proxy: Some("http://127.0.0.1:7890".into()),
            bypass: None,
            from: "env",
            note: "x".into(),
        };
        assert_eq!(r.key(), "proxy:http://127.0.0.1:7890");
        assert!(r.describe().contains("127.0.0.1:7890"));
    }
}
