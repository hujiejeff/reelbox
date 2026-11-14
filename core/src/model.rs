//! 各端共用的数据形状。界面只认这些类型,源负责把站点翻译成它们。

use serde::{Deserialize, Serialize};

/// 列表页的一条。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: String, // movie | series | unknown
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub subtitle: String,
}

/// 一页条目;next 为空表示没有下一页。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Page {
    pub items: Vec<Item>,
    #[serde(rename = "nextCursor", default)]
    pub next: String,
}

/// 一个可播放的条目。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub name: String,
}

/// 一条播放线路。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub episodes: Vec<Episode>,
}

/// 一部作品的详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Detail {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub summary: String,
    pub groups: Vec<Group>,
}

/// 最终交给播放器的地址。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stream {
    pub url: String,
    pub mime: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

/// 筛选项的一个取值;parent 非空表示它是某个一级分类下的二级分类。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Option_ {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub parent: String,
}

/// 一组筛选条件。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Filter {
    pub key: String,
    pub label: String,
    pub options: Vec<Option_>,
}
