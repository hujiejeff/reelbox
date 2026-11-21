//! 内置适配器:随包安装,用户不用导入(见 `docs/ARCHITECTURE.md` 第 3 节)。
//!
//! 一个适配器 = 一个 js 文件,内容是「某种源格式怎么翻译成 list/detail/play」。
//! 它们和用户自己导入的插件放在同一个目录下(`plugins/builtin/`),但有两个区别:
//!
//! * **文件已经存在就不覆盖** —— 用户想改规则,直接改这个文件就行,下次启动不会被打回去;
//! * **不进 `sources.json`**,也不出现在源列表里 —— 它不是"一个源",只是引擎。
//!   一条 iplayr 源是「内置引擎 + 一份站点配置(`Source.url`)」,见 `Source::adapter`。
//!
//! 前端的 `builtin_adapters()` 拿到的就是这里的绝对路径。

use std::collections::HashMap;
use std::path::PathBuf;

/// iplayr 引擎(XPath + 正则 + URL 模板的通用执行器)。
///
/// 源码在仓库的 `examples/iplayr.reelbox.js`:那一份就是开发时用的原件,
/// 打包时原样编进二进制,不再有多份副本要同步。
const IPLAYR: &str = include_str!("../../examples/iplayr.reelbox.js");

/// 内置适配器落地的子目录(`plugins/builtin/`),和用户导入的插件分开
const SUBDIR: &str = "builtin";

/// 内置适配器的清单:`名字 → 源码`。前端不用它,只给 [`install`] 用。
const ALL: [(&str, &str); 1] = [("iplayr", IPLAYR)];

/// 一个内置适配器的落地路径(`<数据目录>/plugins/builtin/<名字>.adapter.js`)。
fn path_of(name: &str) -> PathBuf {
    crate::paths::plugins_dir()
        .join(SUBDIR)
        .join(format!("{name}.adapter.js"))
}

/// 启动时调用一次(见 `lib.rs` 的 `setup`):把内置适配器写进插件目录。
///
/// **文件已存在就不动**:第一次装好之后,这个文件的作者就是用户了。
/// 失败只记日志,不拦住启动 —— 没有内置适配器时,`sources.json` 里那些
/// `adapter="iplayr"` 的源会在列表处报错,但应用本身照常能用。
pub fn install() {
    for (name, source) in ALL {
        let path = path_of(name);
        if path.exists() {
            if let Some(dir) = path.parent() {
                // 目录可能是被用户删了一半:补建一下,下次导入还能落在这里
                let _ = std::fs::create_dir_all(dir);
            }
            continue;
        }
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                crate::logging::event(&format!("BUILTIN {name} 建目录失败: {e}"));
                continue;
            }
        }
        match std::fs::write(&path, source) {
            Ok(()) => crate::logging::event(&format!(
                "BUILTIN {name} 已安装: {}",
                path.display()
            )),
            Err(e) => crate::logging::event(&format!(
                "BUILTIN {name} 写入失败: {}: {e}",
                path.display()
            )),
        }
    }
}

/// 已经落地的内置适配器清单:`{"iplayr": "绝对路径"}`。
///
/// 只返回**文件确实在**的那几个:返回一个读不到的路径,前端会得到一句
/// 「读插件失败」,而不说「内置引擎没装上」。
pub fn adapters() -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, _) in ALL {
        let path = path_of(name);
        if path.is_file() {
            out.insert(name.to_string(), path.to_string_lossy().to_string());
        }
    }
    out
}

/// 一个内置适配器的路径(运行时用:boa 回退引擎按名字找文件)
pub fn adapter_path(name: &str) -> Option<PathBuf> {
    let path = path_of(name);
    path.is_file().then_some(path)
}
