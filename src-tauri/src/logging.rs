//! 诊断日志。
//!
//! 前端(`append_log`)、本地反代(proxy.rs)、自检摘要都写同一个文件
//! `<数据目录>/reelbox.log`(桌面是 `%APPDATA%/reelbox/reelbox.log`,见 `paths.rs`),
//! 这样一次失败的播放能在一处看全:
//! 插件 play 钩子给的原地址 → 反代抓 m3u8 的 HTTP 码/字节数 → hls.js 报的错。
//!
//! 时间戳用 UTC 的 `HH:MM:SS`,和前端 `toISOString().slice(11,19)` 对齐。

use std::io::Write as _;

/// 日志文件路径(目录解析见 `paths.rs`:移动端不能用 `%APPDATA%`)
pub fn log_path() -> std::path::PathBuf {
    crate::paths::log_path()
}

/// 原样写一行(调用方自己带时间戳)
pub fn append(line: &str) {
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            let _ = writeln!(f, "{line}");
        }
        Err(e) => eprintln!("log: 写 {} 失败: {e}", path.display()),
    }
}

/// 带 UTC 时间戳写一行,给 Rust 侧自己产生的事件用
pub fn event(msg: &str) {
    append(&format!("{} {}", stamp(), msg));
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    format!("{h:02}:{m:02}:{s:02}")
}

/// 把一段文本裁成一行、去掉控制字符,便于塞进日志
pub fn one_line(text: &str, max: usize) -> String {
    let mut out = String::with_capacity(max + 3);
    for ch in text.chars() {
        if out.chars().count() >= max {
            out.push('…');
            break;
        }
        if ch == '\n' || ch == '\r' || ch == '\t' {
            out.push(' ');
        } else if (ch as u32) < 0x20 {
            out.push('.');
        } else {
            out.push(ch);
        }
    }
    out
}
