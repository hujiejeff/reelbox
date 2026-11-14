// Reelbox 的 Tauri 外壳:窗口 + 命令注册。

mod commands;
mod proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动标记:用来区分"路径不可写"和"前端没调用"
    {
        use std::io::Write as _;
        let base = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join("reelbox");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("reelbox.log")) {
            let _ = writeln!(f, "---- boot ----");
        }
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
            commands::filters,
            commands::poster,
            commands::append_log,
            commands::save_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("reelbox: 启动失败");
}
