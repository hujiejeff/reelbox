// 自定义 Windows 资源清单:
// Tauri 默认那份不含 DPI 声明,导致高 DPI 下窗口按 100% 创建、
// 而 WebView2 按真实缩放渲染 → 界面看着像被放大、错位。
const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>"#;

fn main() {
    // Linux/Android/iOS 的 cdylib 是真正的产物,不能动导出表。
    // 只有 Windows + MinGW(GNU)需要特殊处理,原因见下。
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "gnu" {
        // Cargo.toml 里 crate-type 同时带着 mobile 要用的 cdylib,
        // 于是桌面构建也会顺带链接一个 dll。MinGW 的 ld 默认把所有符号都塞进导出表,
        // 这个体量的依赖直接撑爆上限:`export ordinal too large: 81152`。
        // 桌面根本不加载这个 dll,让 ld 不要导出任何符号即可(rlib 不受影响)。
        println!("cargo:rustc-cdylib-link-arg=-Wl,--exclude-all-symbols");
    }

    let attrs = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().app_manifest(MANIFEST));
    tauri_build::try_build(attrs).expect("tauri-build 失败");
}
