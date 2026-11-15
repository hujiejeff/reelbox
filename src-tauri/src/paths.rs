//! 数据目录:源配置、插件、日志都放在同一个地方。
//!
//! 老版本用 `%APPDATA%/reelbox`(Windows),而 Android/iOS 没有 `APPDATA` 这个变量,
//! 会一路落到临时目录(重启就没了)。现在改成向 Tauri 要 `app_config_dir()`,
//! 配合 `tauri.conf.json` 里的
//!
//! ```json
//! "appDirectoriesOverride": { "config": "$CONFIG/reelbox" }
//! ```
//!
//! 桌面拿到的仍然是 `%APPDATA%/reelbox`(`$CONFIG` = Windows 的 FOLDERID_RoamingAppData),
//! 移动端拿到平台私有的可写目录,老用户的数据一个字节都不用搬。
//!
//! 解析顺序(任何一步拿不到就退回下一步,绝不 panic):
//!   1. Tauri 的 `app_config_dir()`(启动时在 `setup` 里取,存进 OnceLock)
//!   2. 旧逻辑:`%APPDATA%/reelbox`,再不行 `temp_dir()/reelbox`
//!   3. 桌面:如果 1 和 2 指向不同目录,而 1 还不存在、2 已经存在,就继续用 2
//!      (兜底:万一 override 没生效,老用户也照样能看到自己的源列表)

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::Manager as _;

/// `setup` 里解析一次,之后只读。None = 没拿到(或 Tauri 还没起来)。
static APP_CONFIG: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 旧版的固定位置。Android/iOS 上 `APPDATA` 不存在,这里会落到临时目录。
fn legacy_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("reelbox")
}

/// 桌面兜底:新目录还没建出来、旧目录已经在用,就别把用户抛下。
fn adopt(dir: PathBuf) -> PathBuf {
    let old = legacy_dir();
    if dir != old && !dir.exists() && old.exists() {
        return old;
    }
    dir
}

/// 启动时调用一次(见 `lib.rs` 的 `setup`)。重复调用只有第一次生效。
pub fn init(app: &tauri::AppHandle) {
    let resolved = match app.path().app_config_dir() {
        Ok(dir) => Some(adopt(dir)),
        // 拿不到就走旧逻辑
        Err(_) => None,
    };
    // 已经初始化过就别再动
    let _ = APP_CONFIG.set(resolved);
}

/// 数据目录。Tauri 没起来之前(比如启动早期打日志)走旧逻辑。
pub fn base_dir() -> PathBuf {
    match APP_CONFIG.get() {
        Some(Some(dir)) => dir.clone(),
        _ => legacy_dir(),
    }
}

/// 源列表:`<数据目录>/sources.json`
pub fn sources_path() -> PathBuf {
    base_dir().join("sources.json")
}

/// 导入的插件:`<数据目录>/plugins/`
pub fn plugins_dir() -> PathBuf {
    base_dir().join("plugins")
}

/// 诊断日志:`<数据目录>/reelbox.log`(反代、前端、自检都写这一个文件)
pub fn log_path() -> PathBuf {
    base_dir().join("reelbox.log")
}
