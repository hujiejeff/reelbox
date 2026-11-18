//! 网络层:一个出口(reqwest)、一套代理解析、一份目标地址策略。
//!
//! 分三块,各自能单测:
//!
//! - [`proxy`]:代理在哪(环境变量 → Windows 注册表 → 设置页手动),带 5 秒缓存
//! - [`http`]:客户端工厂,负责超时、重试、代理接线
//! - [`policy`]:哪些目标允许连(本机/内网挡掉,FakeIP 放行)

pub mod http;
pub mod policy;
pub mod proxy;

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
