//! 源:把站点翻译成 model。现在只有声明式的苹果 CMS(vod / xml)。

pub mod cms;

pub use cms::Client;

use serde::{Deserialize, Serialize};

/// 一条源的定义。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    /// vod | xml
    #[serde(default, rename = "type")]
    pub kind: String,
    pub url: String,
}

impl Source {
    /// 归一化类型名。
    pub fn format(&self) -> &str {
        if self.kind.is_empty() {
            "vod"
        } else {
            &self.kind
        }
    }
}

/// 首次启动时的源;之后以配置文件为准。
pub fn defaults() -> Vec<Source> {
    vec![
        Source {
            id: "dytt".into(),
            name: "电影天堂".into(),
            kind: "vod".into(),
            url: "https://caiji.dyttzyapi.com/api.php/provide/vod".into(),
        },
        Source {
            id: "lzzy".into(),
            name: "量子资源".into(),
            kind: "xml".into(),
            url: "https://cj.lziapi.com/api.php/provide/vod/at/xml".into(),
        },
        Source {
            id: "ffzy".into(),
            name: "非凡资源".into(),
            kind: "vod".into(),
            url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8".into(),
        },
    ]
}
