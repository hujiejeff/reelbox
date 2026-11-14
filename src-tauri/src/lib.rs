// Reelbox 的 Tauri 外壳:窗口 + 命令注册。

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::list_items,
            commands::search,
            commands::detail,
            commands::play,
            commands::filters,
            commands::poster,
        ])
        .run(tauri::generate_context!())
        .expect("reelbox: 启动失败");
}
