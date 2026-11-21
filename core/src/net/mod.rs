//! 网络层:一个出口(reqwest)、一套代理解析、一份目标地址策略。
//!
//! 分几块,各自能单测:
//!
//! - [`proxy`]:代理在哪(环境变量 → Windows 注册表 → 直连),带 5 秒缓存
//! - [`route`]:按域名选路 + 记忆(哪个 host 该直连、哪个该走代理,30 分钟内记住)
//! - [`http`]:客户端工厂,负责超时、重试、按选路接线
//! - [`policy`]:哪些目标允许连(本机/内网挡掉,FakeIP 放行)
//! - [`session`]:播放会话表,把"真实地址 + 请求头"换成短 id(反代用)

pub mod http;
pub mod policy;
pub mod proxy;
pub mod route;
pub mod session;

use std::sync::Mutex;

/// 宿主注入的日志出口。core 不认识 Tauri,也不该自己写文件:
/// src-tauri 启动时把 `logging::event` 接进来,代理换了、请求重试了都能进同一个日志。
static LOGGER: Mutex<Option<fn(&str)>> = Mutex::new(None);

pub fn set_logger(f: fn(&str)) {
    if let Ok(mut slot) = LOGGER.lock() {
        *slot = Some(f);
    }
}

/// 写一条日志。没接日志出口时静默(单测、CLI 场景)。
pub fn log(msg: &str) {
    let hook = LOGGER.lock().ok().and_then(|g| *g);
    if let Some(f) = hook {
        f(msg);
    }
}

/// 极简百分号解码。
/// 用途:Cookie 值里不能直接放空格/分号,所以人工校验窗口把 UA 编码进 `__rb_ua`
/// 回传,宿主取出来再解回去。
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::pct_decode;

    #[test]
    fn pct_decode_restores_spaces() {
        assert_eq!(
            pct_decode("Mozilla%2F5.0%20(Windows%20NT%2010.0%3B%20Win64)"),
            "Mozilla/5.0 (Windows NT 10.0; Win64)"
        );
    }

    #[test]
    fn pct_decode_keeps_plain_text_and_bad_escapes() {
        assert_eq!(pct_decode("plain"), "plain");
        assert_eq!(pct_decode("a%zzb"), "a%zzb");
        assert_eq!(pct_decode("tail%"), "tail%");
    }
}
