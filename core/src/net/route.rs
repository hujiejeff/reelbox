//! 按域名自动选路 + 记忆。
//!
//! 同一个应用里,两条路的要求是**相反**的(都是实测,不是猜的):
//!
//! | 域名 | 直连 | 走本地代理 |
//! | --- | --- | --- |
//! | `cj.lziapi.com`(量子) | 15s 零字节 | 200 / 503 KB / 6s |
//! | `super.ffzy-online6.com`(ffzy 的 CDN) | 200 | **403** |
//! | `v.cdnlz13.com`(分享页) | 200 | **404** |
//!
//! 所以路线不能全局定一次,得**按 host 收敛**:先按系统代理的现状排出候选,
//! 哪条通了就记下来,30 分钟内同一个 host 只用那一条 —— ffzy 每个分片都要先撞
//! 一次 403 再回退,白扔一次往返,记下来之后就没有这次往返了。
//!
//! 用户没有开关:代理开着 / 关着 / 装了工具却没开系统开关,应用自己判断(见
//! [`candidates`] 的三档)。没有代理的用户就是没有 —— 被墙的源救不了,只能换源。

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::proxy;

/* ---------- 路线 ---------- */

/// 一条出口路线
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    /// 直连(不经任何代理)
    Direct,
    /// 走这条代理(`scheme://host:port`)
    Proxy(String),
}

impl Via {
    /// 日志里的 `via=…` 片段(只有两档:直连 / 代理)
    pub fn name(&self) -> &'static str {
        match self {
            Via::Direct => "direct",
            Via::Proxy(_) => "proxy",
        }
    }

    /// 带地址的写法:`direct` / `proxy:http://127.0.0.1:7890`。
    /// 同一个 host 的两条候选都是代理时(理论上不会有),也得能分开写进错误串。
    pub fn describe(&self) -> String {
        match self {
            Via::Direct => "direct".to_string(),
            Via::Proxy(url) => format!("proxy:{url}"),
        }
    }
}

/* ---------- 记忆 ---------- */

/// 学到的路线多久作废。30 分钟:够覆盖一次浏览 / 一集剧,又不至于把换端口、
/// 换节点之后的旧结论钉太久。
pub const TTL_SECS: u64 = 30 * 60;

/// 最多记这么多个 host。一个源站通常只有 1~3 个域名(接口域名 + CDN 域名),
/// 256 足够一整个会话;超了淘汰最久没用的那条。
pub const CAPACITY: usize = 256;

/// 一条记忆
#[derive(Debug, Clone)]
struct Entry {
    via: Via,
    /// 学到的时刻:用来判过期
    at: u64,
    /// 最后一次**用到**的时刻:淘汰时挑最久的。用 `Cell` 是为了让 [`Learned::get`]
    /// 保持 `&self`(它只是个读操作,但对 LRU 来说是"用过一次")。
    used: Cell<u64>,
}

/// host → 路线 的小表。**纯数据结构**:时间从参数进来,不读时钟,能单测。
#[derive(Debug)]
pub struct Learned {
    map: HashMap<String, Entry>,
    ttl: u64,
    cap: usize,
}

impl Default for Learned {
    fn default() -> Self {
        Self::new()
    }
}

impl Learned {
    /// 默认配置:TTL 30 分钟、容量 256
    pub fn new() -> Self {
        Self::with_limits(CAPACITY, TTL_SECS)
    }

    /// 换掉容量与 TTL(单测要小参数才跑得动)
    pub fn with_limits(cap: usize, ttl: u64) -> Self {
        Self { map: HashMap::new(), ttl, cap: cap.max(1) }
    }

    /// 学过就用学的(`now` 秒),过期了当没学过。
    /// 命中时刷新一次"最后用到",淘汰才挑得到真正没人用的。
    pub fn get(&self, host: &str, now: u64) -> Option<Via> {
        let host = normalize(host)?;
        let entry = self.map.get(&host)?;
        if self.expired(entry, now) {
            return None;
        }
        entry.used.set(now);
        Some(entry.via.clone())
    }

    /// 记下来。同一个 host 再记一次就是覆盖(顺带续期)。
    pub fn put(&mut self, host: &str, via: Via, now: u64) {
        let Some(host) = normalize(host) else { return };
        self.prune(now);
        if !self.map.contains_key(&host) && self.map.len() >= self.cap {
            self.evict();
        }
        self.map.insert(host, Entry { via, at: now, used: Cell::new(now) });
    }

    /// 忘掉一个 host。学到的路线后来不通了(换了节点、代理工具关了)时用:
    /// 留着只会让这个域名在 TTL 内一直撞同一堵墙。
    pub fn forget(&mut self, host: &str) {
        if let Some(host) = normalize(host) {
            self.map.remove(&host);
        }
    }

    /// 现在记着多少个 host
    pub fn len(&self) -> usize {
        self.map.len()
    }

    fn expired(&self, entry: &Entry, now: u64) -> bool {
        // 满 TTL 那一刻还能用,过了就作废
        now.saturating_sub(entry.at) > self.ttl
    }

    /// 清掉过期的:它们占着容量却没用了
    fn prune(&mut self, now: u64) {
        let ttl = self.ttl;
        self.map.retain(|_, e| now.saturating_sub(e.at) <= ttl);
    }

    /// 容量满了:淘汰最久没用的(并列时挑更早学到的,再并列按 host 名,保证可测)
    fn evict(&mut self) {
        let victim = self
            .map
            .iter()
            .min_by(|(ha, a), (hb, b)| {
                a.used.get().cmp(&b.used.get()).then(a.at.cmp(&b.at)).then(ha.cmp(hb))
            })
            .map(|(h, _)| h.clone());
        if let Some(h) = victim {
            self.map.remove(&h);
        }
    }
}

/// host 统一成小写、去掉多余空白:同一个站不能因为大小写记成两条
fn normalize(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

static LEARNED: OnceLock<Mutex<Learned>> = OnceLock::new();

/// 全局那份记忆。`http` 的请求流程直接拿它当参数进来(单测换成自己的一份,
/// 免得并行跑测试时互相踩)。
pub fn store() -> &'static Mutex<Learned> {
    LEARNED.get_or_init(|| Mutex::new(Learned::new()))
}

fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poison) => poison.into_inner(),
    }
}

/// 学过的那条(没有就是没学过)
pub fn recall(host: &str) -> Option<Via> {
    let now = now_secs();
    lock(store()).get(host, now)
}

/// 记下这个 host 走这条
pub fn remember(host: &str, via: &Via) {
    let now = now_secs();
    lock(store()).put(host, via.clone(), now);
}

/// 忘掉这个 host(学到的路线后来不通了)
pub fn forget(host: &str) {
    lock(store()).forget(host);
}

/* ---------- 候选 ---------- */

/// 这个 host 现在按什么顺序试,**最多两条**。
///
/// 1. 学过的:只返回它一条,不再试错(没有第二跳,也就没有白扔的往返)
/// 2. 没学过、系统代理已启用(环境变量有值 / 注册表 `ProxyEnable=1`):
///    `[代理, 直连]` —— 采集站直连超时,代理优先才对
/// 3. 没学过、系统代理**未**启用、但注册表里仍留着 `ProxyServer`:
///    `[直连, 代理(那个地址)]` —— 用户装了代理工具却没开系统开关。
///    只有直连失败才试它,日志里会写清"第二个候选是没启用的代理"
/// 4. 完全没有代理配置:`[直连]` 一条
pub fn candidates(host: &str) -> Vec<Via> {
    candidates_with(recall(host), &proxy::outlook())
}

/// [`candidates`] 的纯函数版:学过的 + 系统代理现状 → 候选顺序(单测走这条)
pub fn candidates_with(learned: Option<Via>, outlook: &proxy::Outlook) -> Vec<Via> {
    if let Some(via) = learned {
        return vec![via];
    }
    match (&outlook.active, &outlook.dormant) {
        (Some(url), _) => vec![Via::Proxy(url.clone()), Via::Direct],
        (None, Some(url)) => vec![Via::Direct, Via::Proxy(url.clone())],
        (None, None) => vec![Via::Direct],
    }
}

/// 现在(秒)。记忆的 TTL 用秒就够,不引入 `Instant` 是为了能喂假时钟单测。
pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::proxy::Outlook;

    fn proxy_via(url: &str) -> Via {
        Via::Proxy(url.to_string())
    }

    fn enabled(url: &str) -> Outlook {
        Outlook {
            active: Some(url.to_string()),
            dormant: None,
            bypass: None,
            note: "系统代理(注册表)".to_string(),
        }
    }

    fn dormant(url: &str) -> Outlook {
        Outlook {
            active: None,
            dormant: Some(url.to_string()),
            bypass: Some("<local>".to_string()),
            note: "系统代理未启用".to_string(),
        }
    }

    fn noney() -> Outlook {
        Outlook { active: None, dormant: None, bypass: None, note: "没有代理设置".to_string() }
    }

    #[test]
    fn keeps_what_it_learned() {
        let mut l = Learned::new();
        // 没学过:None(调用方据此去试错)
        assert_eq!(l.get("cj.lziapi.com", 1_000), None);
        l.put("cj.lziapi.com", proxy_via("http://127.0.0.1:7890"), 1_000);
        assert_eq!(l.get("cj.lziapi.com", 1_001), Some(proxy_via("http://127.0.0.1:7890")));
        l.put("cj.lziapi.com", Via::Direct, 1_002);
        // 同一个 host 再学一次是覆盖(顺带续期)
        assert_eq!(l.get("cj.lziapi.com", 1_003), Some(Via::Direct));
        assert_eq!(l.len(), 1);
    }

    #[test]
    fn host_is_matched_case_insensitively() {
        let mut l = Learned::new();
        l.put("  CJ.LziApi.com. ", Via::Direct, 100);
        // DNS 不分大小写,记忆也不该分;末尾的点是同一个名字
        assert_eq!(l.get("cj.lziapi.com", 101), Some(Via::Direct));
        assert_eq!(l.get("CJ.LZIAPI.COM", 101), Some(Via::Direct));
        // 空 host 不记也不查(插件里拿到的怪地址别把表塞满)
        l.put("   ", Via::Direct, 102);
        assert_eq!(l.len(), 1);
        assert_eq!(l.get("", 102), None);
    }

    #[test]
    fn forgets_after_ttl() {
        let mut l = Learned::new();
        l.put("super.ffzy-online6.com", Via::Direct, 5_000);
        // 满 TTL 那一刻还算数
        assert_eq!(l.get("super.ffzy-online6.com", 5_000 + TTL_SECS), Some(Via::Direct));
        // 过 1 秒就作废,当成没学过
        assert_eq!(l.get("super.ffzy-online6.com", 5_001 + TTL_SECS), None);
        // 过期项顺手被清掉,不占容量
        l.put("a.example", Via::Direct, 5_002 + TTL_SECS);
        assert_eq!(l.len(), 1);
    }

    #[test]
    fn evicts_the_least_recently_used() {
        let mut l = Learned::with_limits(2, TTL_SECS);
        l.put("a.example", Via::Direct, 100);
        l.put("b.example", proxy_via("http://127.0.0.1:7890"), 200);
        // 用一次 a:a 变成"最近用过",该被淘汰的是 b
        assert_eq!(l.get("a.example", 300), Some(Via::Direct));
        l.put("c.example", Via::Direct, 400);
        assert_eq!(l.len(), 2);
        assert!(l.get("b.example", 401).is_none(), "最久没用的 b 应该被淘汰");
        assert_eq!(l.get("a.example", 401), Some(Via::Direct));
        assert_eq!(l.get("c.example", 401), Some(Via::Direct));
    }

    #[test]
    fn capacity_is_capped() {
        let mut l = Learned::with_limits(3, TTL_SECS);
        for i in 0..3 {
            l.put(&format!("h{i}.example"), Via::Direct, 100 + i);
        }
        assert_eq!(l.len(), 3);
        l.put("h3.example", Via::Direct, 200);
        assert_eq!(l.len(), 3, "容量是上限,不是会一直长");
        assert!(l.get("h0.example", 201).is_none(), "最老那条先走");
    }

    #[test]
    fn candidates_when_system_proxy_is_enabled() {
        // 采集站(量子)直连 15s 零字节、经代理 200:代理优先,直连当第二手
        let c = candidates_with(None, &enabled("http://127.0.0.1:7890"));
        assert_eq!(c, vec![proxy_via("http://127.0.0.1:7890"), Via::Direct]);
    }

    #[test]
    fn candidates_when_proxy_is_configured_but_not_enabled() {
        // 装了代理工具却没开系统开关:直连优先,那个地址只在直连失败后才试
        let c = candidates_with(None, &dormant("http://127.0.0.1:7890"));
        assert_eq!(c, vec![Via::Direct, proxy_via("http://127.0.0.1:7890")]);
    }

    #[test]
    fn candidates_without_any_proxy_config() {
        // 没有代理配置:只有直连,不编一条不存在的路出来
        assert_eq!(candidates_with(None, &noney()), vec![Via::Direct]);
    }

    #[test]
    fn candidates_use_what_is_learned_and_stop_exploring() {
        // 学过的直接一条:哪怕系统代理开着,ffzy 那个域名也只走学到的直连,
        // 不再"先撞 403 再回退"
        let c = candidates_with(Some(Via::Direct), &enabled("http://127.0.0.1:7890"));
        assert_eq!(c, vec![Via::Direct]);
        let c = candidates_with(Some(proxy_via("http://127.0.0.1:7890")), &noney());
        assert_eq!(c, vec![proxy_via("http://127.0.0.1:7890")]);
    }

    #[test]
    fn via_names_are_log_friendly() {
        assert_eq!(Via::Direct.name(), "direct");
        assert_eq!(proxy_via("http://127.0.0.1:7890").name(), "proxy");
        assert_eq!(Via::Direct.describe(), "direct");
        assert_eq!(proxy_via("http://127.0.0.1:7890").describe(), "proxy:http://127.0.0.1:7890");
    }

    #[test]
    fn remember_and_recall_round_trip() {
        // 全局那份记忆(线上走的就是它):写进去能读回来,host 大小写不影响
        let host = "remember-recall.example";
        forget(host);
        assert_eq!(recall(host), None);
        remember(host, &Via::Direct);
        assert_eq!(recall("REMEMBER-RECALL.example"), Some(Via::Direct));
        assert_eq!(candidates(host), vec![Via::Direct]);
        forget(host);
        assert_eq!(recall(host), None);
    }
}
