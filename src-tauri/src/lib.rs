// Reelbox 的 Tauri 外壳:窗口 + 命令注册。

mod commands;
mod logging;
mod proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动参数:--selftest 跑插件验收流程,--engine=boa 回退到 Rust 里的引擎
    let args: Vec<String> = std::env::args().collect();
    commands::apply_engine_arg(&args);
    // 启动标记:用来区分"路径不可写"和"前端没调用"
    {
        let dir = logging::log_path()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(std::env::temp_dir);
        let _ = std::fs::create_dir_all(&dir);
        logging::append("---- boot ----");
        eprintln!("boot: log dir = {}", dir.display());
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
            commands::save_plugin,
            commands::plugin_read,
            commands::plugin_fetch,
            commands::plugin_stream_allow,
            commands::selftest_mode,
            commands::selftest_report,
        ])
        .run(tauri::generate_context!())
        .expect("reelbox: 启动失败");
}
