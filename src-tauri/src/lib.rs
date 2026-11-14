// Reelbox 的 Tauri 外壳。
//
// 现在的形态:窗口指向本地 UI;等后端定下来再改成
// 指向 127.0.0.1:8787(Go 边车)或直接用 Rust 实现。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("reelbox: 启动失败");
}
