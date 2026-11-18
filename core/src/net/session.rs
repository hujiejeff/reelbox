//! 播放会话表:真实地址 + 请求头 → 一个短 id。
//!
//! 以前这两样就编码在 URL 里(`/p?u=&h=`,见 src-tauri 的兼容路径),后果是
//! Cookie/Authorization 会跟着地址进日志和播放器调试面板,地址还会随头的大小无限变长。
//! 现在地址里只有短 id,真东西躺在表里。
//!
//! 表不做成全局静态:持有者(反代服务)自己决定放哪、什么时候建。单测因此可以
//! 直接 `Sessions::new(...)`,不用管进程级状态,更不会互相干扰。

use std::collections::{HashMap, VecDeque};

/// 一个播放会话:真实地址 + 请求头。
struct Session {
    url: String,
    headers: String,
    /// 插入(或最近一次命中)的时间,给 TTL 用
    at: u64,
}

/// 会话表 + 插入顺序。两者必须一起改,所以由同一个结构体持有(外面再套一层锁)。
pub struct Sessions {
    map: HashMap<String, Session>,
    /// 淘汰按这个来。同一个 id 重插入不再记一次(见 [`Sessions::remember`])
    order: VecDeque<String>,
    /// 最多留这么多条,超了按插入顺序淘汰最老的
    max: usize,
    /// 超过这么多秒没被插入/命中过就清掉
    ttl: u64,
}

/// 会话 id:和 [`crate::source::id_for_url`] 同一套(FNV-1a 32 位 / 8 位十六进制),
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

impl Sessions {
    /// `max`:最多留几条;`ttl`:多少秒没碰过就清掉
    pub fn new(max: usize, ttl: u64) -> Self {
        Sessions {
            map: HashMap::new(),
            order: VecDeque::new(),
            max,
            ttl,
        }
    }

    /// 记住一个会话,返回它的 id。
    ///
    /// 同一个 `(url, headers)` 永远得到同一个 id —— 直播清单每次刷新都会重新 wrap,
    /// 每次都插一条的话表会无限膨胀。
    pub fn remember(&mut self, url: &str, headers: &str, now: u64) -> String {
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
        while self.map.len() > self.max {
            match self.order.pop_front() {
                Some(old) => {
                    self.map.remove(&old);
                }
                None => break,
            }
        }
        id
    }

    /// 按 id 取回 `(url, headers)`。取不到就是过期/被淘汰了。
    ///
    /// 命中要刷新 `at`:正在播的长片(两小时电影)每次请求分片都会命中,
    /// 不刷新的话播到一半就被 TTL 清掉,分片开始 404。
    pub fn recall(&mut self, id: &str, now: u64) -> Option<(String, String)> {
        self.purge_expired(now);
        let s = self.map.get_mut(id)?;
        s.at = now;
        Some((s.url.clone(), s.headers.clone()))
    }

    /// 表里当前有多少条(过期的还没清掉时也算在里面)
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// 表是不是空的
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// 清掉超过 TTL 的条目,并让 `order` 和 `map` 一一对应。
    ///
    /// `order` 得跟着一起对齐:只按时间清 `map` 的话,被清掉的 id 会一直躺在队列中间,
    /// 直到哪天被淘汰到队首 —— 长时间追剧下来队列只涨不落,属于慢漏。
    fn purge_expired(&mut self, now: u64) {
        let ttl = self.ttl;
        self.map.retain(|_, s| now.saturating_sub(s.at) < ttl);
        let map = &self.map;
        self.order.retain(|id| map.contains_key(id));
    }
}

#[cfg(test)]
mod tests {
    use super::Sessions;

    /// 和 src-tauri 那侧的取值一致:几千条也就几 MB,
    /// 足够覆盖"一部剧所有分集 + 直播清单反复刷新"的量
    const MAX_SESSIONS: usize = 4096;
    /// 6 小时前的会话不可能还有播放器在用
    const SESSION_TTL_SECS: u64 = 6 * 3600;

    fn table() -> Sessions {
        Sessions::new(MAX_SESSIONS, SESSION_TTL_SECS)
    }

    #[test]
    fn same_pair_always_gets_the_same_id() {
        let mut t = table();
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
        let mut t = table();
        let url = "https://v.example/a/index.m3u8?sig=2";
        let headers = "[[\"User-Agent\",\"Mozilla/5.0\"],[\"Cookie\",\"sid=1\"]]";
        let id = t.remember(url, headers, 1_000);
        assert_eq!(
            t.recall(&id, 1_000),
            Some((url.to_string(), headers.to_string()))
        );
    }

    #[test]
    fn recall_unknown_id_is_none() {
        assert_eq!(table().recall("不存在", 1_000), None);
    }

    #[test]
    fn table_is_capped_and_drops_the_oldest() {
        let mut t = table();
        let n = MAX_SESSIONS + 4;
        let ids: Vec<String> = (0..n)
            .map(|i| {
                t.remember(
                    &format!("https://v.example/seg-{i}.ts"),
                    "[]",
                    1_000 + i as u64,
                )
            })
            .collect();
        assert_eq!(t.len(), MAX_SESSIONS, "表不能超过上限");
        assert!(
            t.recall(ids.first().unwrap(), 1_000 + n as u64).is_none(),
            "最早的那条应该被淘汰"
        );
        assert!(
            t.recall(ids.last().unwrap(), 1_000 + n as u64).is_some(),
            "最新的那条必须还在"
        );
    }

    #[test]
    fn expired_entries_do_not_pile_up_in_the_order_queue() {
        let mut t = table();
        let t0 = 1_000_000u64;
        let a = t.remember("https://v.example/a.m3u8", "[]", t0);
        let b = t.remember("https://v.example/b.m3u8", "[]", t0 + 10);
        // 6 小时后 C 进来:A 过期被清掉,但它在队列中间(B 还没到期)
        t.remember("https://v.example/c.m3u8", "[]", t0 + SESSION_TTL_SECS + 1);
        assert!(t.recall(&a, t0 + SESSION_TTL_SECS + 2).is_none(), "超过 6 小时就该清掉");
        assert!(t.recall(&b, t0 + SESSION_TTL_SECS + 2).is_some(), "没到期的要留着");
        assert_eq!(
            t.order.len(),
            t.map.len(),
            "队列里不能留着已清掉的 id —— 长期追剧会只涨不落"
        );
    }

    #[test]
    fn remember_is_idempotent() {
        let mut t = table();
        let url = "https://v.example/live/index.m3u8";
        let headers = "[[\"Referer\",\"https://v.example/\"]]";
        let ids: Vec<String> = (0..5).map(|i| t.remember(url, headers, 1_000 + i)).collect();
        assert!(
            ids.iter().all(|id| *id == ids[0]),
            "同一对 (url, headers) 每次都得是同一个 id: {ids:?}"
        );
        assert_eq!(t.len(), 1, "重复插入不能再占一条");
        assert_eq!(t.order.len(), 1, "也不能在淘汰队列里排两次");
    }

    #[test]
    fn id_does_not_carry_the_headers() {
        // id 进日志、进播放器调试面板:请求头(尤其 Cookie/令牌)不能出现在里面
        let headers = "[[\"Cookie\",\"sid=secret-value\"]]";
        let mut t = table();
        let id = t.remember("https://v.example/a/index.m3u8", headers, 1_000);
        assert!(!id.contains("secret"), "请求头不能拼进 id: {id}");
        assert!(!id.contains('/'), "id 要能直接放进路径: {id}");
        assert_eq!(id.len(), 8, "地址要短: {id}");
        // 真东西还是拿得回来的
        assert_eq!(
            t.recall(&id, 1_000).map(|s| s.1),
            Some(headers.to_string())
        );
    }

    #[test]
    fn recall_refreshes_the_timestamp() {
        let mut t = table();
        let t0 = 1_000_000u64;
        let playing = t.remember("https://v.example/movie/index.m3u8", "[]", t0);
        let idle = t.remember("https://v.example/other/index.m3u8", "[]", t0);

        // 播到 TTL 快到点时命中一次(分片请求),时间被刷新
        assert!(t.recall(&playing, t0 + SESSION_TTL_SECS - 1).is_some());
        // 再过 100 秒:因为上面那次命中,它不该被清掉
        assert!(
            t.recall(&playing, t0 + SESSION_TTL_SECS + 100).is_some(),
            "recall 命中要刷新时间,否则长片播到一半会 404"
        );
        // 对照组:同样时刻没被碰过的条目,该过期就过期
        assert!(t.recall(&idle, t0 + SESSION_TTL_SECS + 100).is_none());
    }
}
