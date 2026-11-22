// Reelbox 的 Tauri 外壳:窗口 + 命令注册。

mod builtin;
mod commands;
mod logging;
mod paths;
mod proxy;
mod session;
mod sub;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动参数:--selftest 跑插件验收流程,--engine=boa 回退到 Rust 里的引擎
    let args: Vec<String> = std::env::args().collect();
    commands::apply_engine_arg(&args);
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 数据目录必须在这里解析:Android/iOS 上只有 Tauri 起来之后才知道应用私有目录在哪。
            // 桌面解析结果仍然是 %APPDATA%/reelbox,老用户数据不受影响(见 paths.rs)。
            paths::init(app.handle());
            // 内置适配器随包安装:只在文件不存在时写一次,用户改过的不会被覆盖
            builtin::install();
            wire_network();
            boot_log();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::save_sources,
            commands::list_items,
            commands::search,
            commands::detail,
            commands::play,
            commands::player_url,
            commands::stream_kind,
            commands::filters,
            commands::poster,
            commands::append_log,
            commands::open_log,
            commands::app_info,
            commands::builtin_adapters,
            commands::list_adapters,
            commands::delete_adapter,
            commands::save_plugin,
            commands::read_text_file,
            commands::plugin_read,
            commands::plugin_fetch,
            commands::plugin_stream_allow,
            commands::selftest_mode,
            commands::selftest_title,
            commands::selftest_report,
            session::verify_start,
            session::verify_bounds,
            session::verify_ensure,
            session::verify_finish,
            session::verify_cancel,
            session::session_wait,
            session::session_list,
            session::session_close,
            session::session_fetch,
            sub::sub_state,
            sub::sub_add,
            sub::sub_add_file,
            sub::sub_add_text,
            sub::sub_switch,
            sub::sub_check,
            sub::sub_check_all,
            sub::sub_update,
            sub::sub_remove,
            sub::sub_clone,
            sub::sub_export,
            sub::sub_reset,
        ])
        .run(tauri::generate_context!())
        .expect("reelbox: 启动失败");
}

/// 把 core 的网络层接到宿主上:
/// - 日志出口:代理换了、请求重试了,都写进同一个日志文件
///
/// 代理不在这里配置:出口一律跟着系统走(环境变量 → Windows 注册表 → 直连,
/// 见 core::net::proxy)。这里只把解析结果记一条日志。
fn wire_network() {
    reelbox_core::net::set_logger(logging::event);
    // 启动就把解析结果记一条:出问题时第一时间能看出"走没走代理"
    let route = reelbox_core::net::proxy::route();
    logging::event(&format!(
        "NET proxy={} note={}",
        route.proxy.as_deref().unwrap_or("direct"),
        route.note
    ));
}

/// 启动标记:用来区分"路径不可写"和"前端没调用"。
/// 放在 setup 之后写,移动端才能落到真正的应用目录里。
fn boot_log() {
    let dir = logging::log_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&dir);
    logging::append("---- boot ----");
    eprintln!("boot: log dir = {}", dir.display());
}
