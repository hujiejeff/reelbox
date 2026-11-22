//! 配置订阅的应用侧。
//!
//! 模型是**一个生效、其余挂着**:同一时刻只有一份配置在跑,切换 = 整体换一套源。
//! 每份订阅在本地都有一份快照(`subs/<id>.json`),切走/切回都不用联网。
//!
//! ```
//! subscriptions.json   { active: "s264642d9", items: [...] }
//! subs/local.json      ← "本地配置"的内容
//! subs/s264642d9.json  ← 远程订阅上次拉下来的内容
//! sources.json         ← 当前生效那一份(切换时被写)
//! ```
//!
//! 解析和挑错在 `reelbox_core::sub`(纯逻辑、能单测),这里只做 IO。

use crate::commands::FETCH_UA;
use reelbox_core::source::Source;
use reelbox_core::sub::{self, Index};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 订阅账本。和 `sources.json` 同一个数据目录。
const STORE: &str = "subscriptions.json";
/// 每份订阅的内容快照放这里
const SNAP_DIR: &str = "subs";
/// 单个文件不能超过这个大小。插件都是几十 KB,超过基本就是地址写错了。
const MAX_FILE: usize = 512 * 1024;
/// 内置的"本地配置":永远存在,删不掉
const LOCAL_ID: &str = "local";

const KIND_LOCAL: &str = "local";
const KIND_REMOTE: &str = "remote";

/// 一个装过的文件。`sha256` 是**装的时候**的指纹,之后一直不变 ——
/// 拿它和磁盘上现在的指纹比,就知道用户有没有动过。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstalledFile {
    pub id: String,
    /// `adapter` / `plugin`
    pub kind: String,
    /// `plugins/` 下的文件名
    pub file: String,
    pub sha256: String,
}

/// 一条订阅。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    /// `local`(内容在本地) / `remote`(有地址)
    pub kind: String,
    #[serde(default)]
    pub name: String,
    /// 远程订阅的索引地址
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// 本地订阅的来源文件(用户 `git clone` 下来的 json 之类);空 = 就是这条订阅自己
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
    /// 上次应用时的版本(`1.0.0`)
    #[serde(default)]
    pub version: String,
    /// 最近一次检查到的版本;比 `version` 新就是有更新
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub latest: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub checked_at: String,
    #[serde(default)]
    #[serde(skip_serializing_if = "String::is_empty")]
    pub applied_at: String,
    /// 这条订阅有多少条源
    /// 这条订阅有多少条源
    #[serde(default)]
    pub source_count: usize,
    /// 检查到的版本比装着的这份新(每次读账本时现算,不靠落盘)
    #[serde(default)]
    pub has_update: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<InstalledFile>,
}

impl Default for Item {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: KIND_LOCAL.to_string(),
            name: String::new(),
            url: String::new(),
            path: String::new(),
            version: String::new(),
            latest: String::new(),
            checked_at: String::new(),
            applied_at: String::new(),
            source_count: 0,
            has_update: false,
            files: Vec::new(),
        }
    }
}

impl Item {
    /// 检查到的新版本比装着的这份新?
    pub fn needs_update(&self) -> bool {
        !self.latest.is_empty() && sub::is_newer(&self.latest, &self.version)
    }
}

/// 账本。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub active: String,
    #[serde(default)]
    pub items: Vec<Item>,
    /// 当前 `sources.json` 和生效订阅的快照不一样 = 用户手改过。
    ///
    /// 每次读账本时现算,写盘的值只是"上次算出来的",不影响判断(见 `sub_state`)。
    #[serde(default)]
    pub dirty: bool,
}

/// 一次应用的结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 这条订阅有几条源
    pub sources: usize,
    /// 这次真正写盘的文件数
    pub files: usize,
    /// 没装成的,每条一句人话
    pub skipped: Vec<String>,
}

// ---------------------------------------------------------------- 路径与读写

fn base() -> PathBuf {
    crate::paths::base_dir()
}

fn store_path() -> PathBuf {
    base().join(STORE)
}

fn snap_dir() -> PathBuf {
    base().join(SNAP_DIR)
}

fn snap_path(id: &str) -> PathBuf {
    snap_dir().join(format!("{id}.json"))
}

fn now_iso() -> String {
    reelbox_core::source::now_iso()
}

/// 读账本。老格式(直接一个数组)顺手迁成新结构 —— 那时候还没有"切换"。
fn store_load() -> Store {
    let path = store_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.trim().is_empty() {
        if let Ok(mut s) = serde_json::from_str::<Store>(&text) {
            if s.items.is_empty() {
                s.items.push(local_item(0));
            }
            if s.active.is_empty() {
                s.active = s.items[0].id.clone();
            }
            return s;
        }
        if let Ok(old) = serde_json::from_str::<Vec<Item>>(&text) {
            // 老格式:每条都留着,默认生效第一条
            let mut items = old;
            if items.is_empty() {
                items.push(local_item(0));
            }
            let active = items[0].id.clone();
            return Store {
                active,
                items,
                dirty: false,
            };
        }
    }
    let mut s = Store::default();
    s.items.push(local_item(crate::commands::load_sources().len()));
    s.active = LOCAL_ID.to_string();
    s
}

fn store_save(s: &Store) -> Result<(), String> {
    let path = store_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(s).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写文件失败: {e}"))
}

fn local_item(count: usize) -> Item {
    Item {
        id: LOCAL_ID.to_string(),
        kind: KIND_LOCAL.to_string(),
        name: "本地配置".to_string(),
        version: "0.0.0".to_string(),
        source_count: count,
        ..Default::default()
    }
}

fn snap_read(id: &str) -> Vec<Source> {
    std::fs::read_to_string(snap_path(id))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Source>>(&t).ok())
        .unwrap_or_default()
}

fn snap_write(id: &str, list: &[Source]) -> Result<(), String> {
    let dir = snap_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(snap_path(id), text).map_err(|e| format!("写快照失败: {e}"))
}

/// 内容的指纹:只算"订阅管得着"的字段,`health`/`probe` 不参与 ——
/// 它们每测一次连接就变,算进去会让"有没有手改"永远为真。
fn fingerprint(list: &[Source]) -> String {
    let mut out = String::new();
    for s in list {
        out.push_str(&format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{2}",
            s.id, s.name, s.kind, s.url, s.adapter, s.verify, s.verify_url, s.poster_ratio
        ));
    }
    out
}

/// 同一个订阅 id:地址取指纹,本地订阅用内容取指纹
fn id_of_remote(url: &str) -> String {
    format!("s{}", &sub::sha256_hex(url.trim().as_bytes())[..8])
}

fn id_of_local(seed: &str) -> String {
    let salt = format!("{seed}\u{1}{}", now_iso());
    format!("f{}", &sub::sha256_hex(salt.as_bytes())[..8])
}

// ---------------------------------------------------------------- 网络

fn fetch_bytes(url: &str) -> Result<Vec<u8>, String> {
    let headers = [("User-Agent", FETCH_UA.to_string())];
    let resp = reelbox_core::net::http::get(url, &headers).map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("返回 {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().map_err(|e| format!("读取失败: {e}"))?;
    if bytes.len() > MAX_FILE {
        return Err(format!("文件太大({}KB),不像一份配置", bytes.len() / 1024));
    }
    Ok(bytes.to_vec())
}

fn fetch_index(url: &str) -> Result<Index, String> {
    let headers = [("User-Agent", FETCH_UA.to_string())];
    let resp = reelbox_core::net::http::get(url, &headers).map_err(|e| format!("拉取失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取失败: HTTP {}", resp.status().as_u16()));
    }
    let text = resp.text().map_err(|e| format!("读取失败: {e}"))?;
    Index::parse(&text)
}

/// 本地 json 文件当订阅:同一个格式,同一个体检
fn read_index_file(path: &str) -> Result<Index, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读不了这个文件: {e}"))?;
    Index::parse(&text)
}

// ---------------------------------------------------------------- 应用一份索引

/// 装文件 + 生成源列表。**不改** `sources.json` —— 由调用方决定要不要切过去。
///
/// 文件顺序:先适配器、再插件(源的 `adapter` 可能指向这次刚装的适配器)。
fn apply_index(
    id: &str,
    base_url: &str,
    idx: &Index,
    prev: &[InstalledFile],
    force: bool,
) -> Result<(Vec<InstalledFile>, Vec<Source>, Report), String> {
    let problems = sub::problems(idx, env!("CARGO_PKG_VERSION"));
    if !problems.is_empty() {
        return Err(format!(
            "这份配置有问题,没有安装:\n· {}",
            problems.join("\n· ")
        ));
    }

    let mut report = Report {
        id: id.to_string(),
        name: idx.name.clone(),
        version: idx.version.clone(),
        ..Default::default()
    };

    // ---- 文件 ----
    let dir = crate::paths::plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建插件目录失败: {e}"))?;
    let mut files: Vec<InstalledFile> = Vec::new();

    for (kind, e) in idx.code_entries() {
        let target = dir.join(&e.path);
        let want = e.sha256.to_lowercase();
        let prev_rec = prev.iter().find(|f| f.kind == kind && f.id == e.id).cloned();

        if target.exists() {
            let cur = std::fs::read(&target)
                .map(|b| sub::sha256_hex(&b))
                .unwrap_or_default();
            if cur == want {
                files.push(InstalledFile {
                    id: e.id.clone(),
                    kind: kind.into(),
                    file: e.path.clone(),
                    sha256: want,
                });
                continue;
            }
            // 用户改过的判据:磁盘现状 ≠ 我上次写下它的指纹
            let untouched = prev_rec.as_ref().map(|r| r.sha256 == cur).unwrap_or(false);
            if !untouched && !force {
                report
                    .skipped
                    .push(format!("{} {}:本地已改过,保留你的版本", kind, e.id));
                files.push(prev_rec.unwrap_or(InstalledFile {
                    id: e.id.clone(),
                    kind: kind.into(),
                    file: e.path.clone(),
                    sha256: cur,
                }));
                continue;
            }
        }

        let src = sub::code_url(base_url, &e.path);
        match fetch_bytes(&src) {
            Ok(bytes) => {
                let got = sub::sha256_hex(&bytes);
                if got != want {
                    report.skipped.push(format!(
                        "{} {}:下载到的内容和索引里的 sha256 对不上,没装",
                        kind, e.id
                    ));
                    continue;
                }
                std::fs::write(&target, &bytes)
                    .map_err(|err| format!("写 {} 失败: {err}", e.path))?;
                report.files += 1;
                files.push(InstalledFile {
                    id: e.id.clone(),
                    kind: kind.into(),
                    file: e.path.clone(),
                    sha256: want,
                });
            }
            Err(err) => report.skipped.push(format!("{} {}:{}", kind, e.id, err)),
        }
    }

    // ---- 源 ----
    // 切换模型下这里是**整份替换**,不再有"接管/跳过"的分支。
    // 唯一保留的温情:同 id 的源把上次的 health/probe 带过去,免得换一次订阅
    // 所有源的健康状态都变回"没测过"。
    let old = crate::commands::load_sources();
    let mut list: Vec<Source> = Vec::with_capacity(idx.sources.len());
    for s in &idx.sources {
        let mut src = s.to_source();
        src.from = id.to_string();
        if let Some(prev_src) = old.iter().find(|x| x.id == src.id && x.url == src.url) {
            src.health = prev_src.health.clone();
            src.probe = prev_src.probe.clone();
        }
        list.push(src);
    }
    report.sources = list.len();

    crate::logging::event(&format!(
        "SUB apply id={id} v{} sources={} files={} skip={}",
        report.version,
        report.sources,
        report.files,
        report.skipped.len()
    ));

    Ok((files, list, report))
}

// ---------------------------------------------------------------- 切换

/// 切到某条订阅:先把当前这份存回它的快照,再把目标的快照写进 `sources.json`。
fn do_switch(store: &mut Store, id: &str) -> Result<(), String> {
    if store.active == id {
        return Ok(());
    }
    let items: Vec<String> = store.items.iter().map(|i| i.id.clone()).collect();
    if !items.iter().any(|x| x == id) {
        return Err(format!("没有这条订阅: {id}"));
    }

    // 存当前(用户可能手改过,手改的也算这份订阅的内容)
    if !store.active.is_empty() {
        let cur = crate::commands::load_sources();
        snap_write(&store.active, &cur)?;
        if let Some(it) = store.items.iter_mut().find(|i| i.id == store.active) {
            it.source_count = cur.len();
        }
    }

    let target = snap_read(id);
    crate::commands::save_sources(target.clone())?;
    store.active = id.to_string();
    if let Some(it) = store.items.iter_mut().find(|i| i.id == id) {
        it.source_count = target.len();
        it.applied_at = now_iso();
    }
    crate::logging::event(&format!("SUB switch id={id} sources={}", target.len()));
    Ok(())
}

/// 把一条订阅的内容取出来(远程/文件订阅都要过一遍体检)
fn load_item(item: &Item, force: bool) -> Result<(Vec<InstalledFile>, Vec<Source>, Report), String> {
    let (base_url, idx) = if item.kind == KIND_REMOTE {
        (item.url.clone(), fetch_index(&item.url)?)
    } else if !item.path.is_empty() {
        // 本地文件订阅:相对路径按文件所在目录解析
        let abs = std::fs::canonicalize(&item.path).unwrap_or_else(|_| PathBuf::from(&item.path));
        let dir = abs
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        (format!("{dir}/index.json"), read_index_file(&item.path)?)
    } else {
        // "本地配置"这种没有外部来源,只有快照
        return Ok((item.files.clone(), snap_read(&item.id), Report {
            id: item.id.clone(),
            name: item.name.clone(),
            version: item.version.clone(),
            sources: item.source_count,
            files: 0,
            skipped: vec![],
        }));
    };
    apply_index(&item.id, &base_url, &idx, &item.files, force)
}

// ---------------------------------------------------------------- 命令

/// 账本 + 每条的"有更新/手改过"状态
#[tauri::command]
pub fn sub_state() -> Store {
    let mut s = store_load();
    let cur = crate::commands::load_sources();
    if !s.active.is_empty() {
        s.dirty = fingerprint(&cur) != fingerprint(&snap_read(&s.active));
    }
    if let Some(it) = s.items.iter_mut().find(|i| i.id == s.active) {
        it.source_count = cur.len();
    }
    for it in s.items.iter_mut() {
        it.has_update = it.needs_update();
    }
    s
}

/// 添加远程订阅(地址就是身份,同一个地址再粘一次 = 重新拉一遍)
#[tauri::command]
pub async fn sub_add(url: String) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim().to_string();
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err("地址要以 http(s):// 开头".to_string());
        }
        let id = id_of_remote(&url);
        let mut store = store_load();
        let prev_files = store
            .items
            .iter()
            .find(|i| i.id == id)
            .map(|i| i.files.clone())
            .unwrap_or_default();

        let idx = fetch_index(&url)?;
        let (files, list, report) = apply_index(&id, &url, &idx, &prev_files, false)?;

        snap_write(&id, &list)?;
        let item = Item {
            id: id.clone(),
            kind: KIND_REMOTE.to_string(),
            name: idx.name.clone(),
            url: url.clone(),
            path: String::new(),
            version: idx.version.clone(),
            latest: String::new(),
            checked_at: now_iso(),
            applied_at: now_iso(),
            source_count: list.len(),
            has_update: false,
            files,
        };
        match store.items.iter_mut().find(|i| i.id == id) {
            Some(it) => *it = item,
            None => store.items.push(item),
        }
        do_switch(&mut store, &id)?;
        store_save(&store)?;
        Ok(report)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 添加本地订阅:指向一个 json 文件(和 index.json 一个格式)
#[tauri::command]
pub async fn sub_add_file(path: String) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err("没有选中文件".to_string());
        }
        let id = id_of_local(&path);
        let mut store = store_load();
        let idx = read_index_file(&path)?;
        let abs = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
        let dir = abs
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let base_url = format!("{dir}/index.json");

        let (files, list, report) = apply_index(&id, &base_url, &idx, &[], false)?;

        snap_write(&id, &list)?;
        store.items.push(Item {
            id: id.clone(),
            kind: KIND_LOCAL.to_string(),
            name: idx.name.clone(),
            url: String::new(),
            path: path.clone(),
            version: idx.version.clone(),
            latest: String::new(),
            checked_at: now_iso(),
            applied_at: now_iso(),
            source_count: list.len(),
            has_update: false,
            files,
        });
        do_switch(&mut store, &id)?;
        store_save(&store)?;
        Ok(report)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 从一段 json 文本建一条本地订阅(文件选择器读出来的内容)。
///
/// 不带插件/适配器:相对地址是相对"索引所在的仓库"的,手里只有一段文本时
/// 推不出仓库在哪,与其装半个不如说清楚。
#[tauri::command]
pub fn sub_add_text(text: String) -> Result<Report, String> {
    let idx = Index::parse(&text)?;
    if !idx.plugins.is_empty() || !idx.adapters.is_empty() {
        return Err("这份配置带了插件或适配器,从文件导入装不了 —— 请把它放到仓库里用地址订阅".to_string());
    }
    let problems = sub::problems(&idx, env!("CARGO_PKG_VERSION"));
    if !problems.is_empty() {
        return Err(format!("这份配置有问题,没有安装:
· {}", problems.join("
· ")));
    }

    let mut store = store_load();
    let id = id_of_local(&format!("{}{}", idx.name, idx.version));
    let list: Vec<Source> = idx
        .sources
        .iter()
        .map(|s| {
            let mut src = s.to_source();
            src.from = id.clone();
            src
        })
        .collect();
    snap_write(&id, &list)?;

    let report = Report {
        id: id.clone(),
        name: idx.name.clone(),
        version: idx.version.clone(),
        sources: list.len(),
        files: 0,
        skipped: Vec::new(),
    };
    store.items.push(Item {
        id: id.clone(),
        kind: KIND_LOCAL.to_string(),
        name: idx.name.clone(),
        version: idx.version.clone(),
        latest: String::new(),
        checked_at: now_iso(),
        applied_at: now_iso(),
        source_count: list.len(),
        has_update: false,
        files: Vec::new(),
        ..Default::default()
    });
    do_switch(&mut store, &id)?;
    store_save(&store)?;
    Ok(report)
}

/// 切换订阅(整体换一套源)
#[tauri::command]
pub fn sub_switch(id: String) -> Result<Store, String> {
    let mut store = store_load();
    do_switch(&mut store, &id)?;
    store_save(&store)?;
    Ok(sub_state())
}

/// 检查一条订阅有没有新版本(只比版本号,不改任何东西)
#[tauri::command]
pub async fn sub_check(id: String) -> Result<Item, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = store_load();
        let item = store
            .items
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| format!("没有这条订阅: {id}"))?;

        let latest = if item.kind == KIND_REMOTE {
            fetch_index(&item.url)?.version
        } else if !item.path.is_empty() {
            read_index_file(&item.path)?.version
        } else {
            item.version.clone()
        };

        if let Some(it) = store.items.iter_mut().find(|i| i.id == id) {
            it.latest = latest;
            it.checked_at = now_iso();
            // 返回值要带"有没有更新" —— 这里不现算,前端就只能看到上一次的结论
            it.has_update = it.needs_update();
        }
        store_save(&store)?;
        Ok(store
            .items
            .into_iter()
            .find(|i| i.id == id)
            .unwrap_or(item))
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 全部检查一遍
#[tauri::command]
pub async fn sub_check_all() -> Result<Store, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = store_load();
        for i in 0..store.items.len() {
            let item = store.items[i].clone();
            let got = if item.kind == KIND_REMOTE && !item.url.is_empty() {
                fetch_index(&item.url).map(|x| x.version)
            } else if !item.path.is_empty() {
                read_index_file(&item.path).map(|x| x.version)
            } else {
                continue;
            };
            match got {
                Ok(v) => {
                    store.items[i].latest = v;
                    store.items[i].checked_at = now_iso();
                }
                Err(e) => {
                    crate::logging::event(&format!("SUB check fail id={} {e}", item.id));
                }
            }
        }
        store_save(&store)?;
        drop(store);
        Ok(sub_state())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 应用某条订阅的最新内容(远程会重新拉)
#[tauri::command]
pub async fn sub_update(id: String) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = store_load();
        let item = store
            .items
            .iter()
            .find(|i| i.id == id)
            .cloned()
            .ok_or_else(|| format!("没有这条订阅: {id}"))?;

        let (files, list, report) = load_item(&item, false)?;
        snap_write(&id, &list)?;

        if let Some(it) = store.items.iter_mut().find(|i| i.id == id) {
            it.files = files;
            it.version = report.version.clone();
            it.latest = String::new();
            it.checked_at = now_iso();
            it.source_count = list.len();
        }
        // 正在用它:切一次让 sources.json 跟上
        if store.active == id {
            let target = snap_read(&id);
            crate::commands::save_sources(target)?;
            if let Some(it) = store.items.iter_mut().find(|i| i.id == id) {
                it.applied_at = now_iso();
            }
        }
        store_save(&store)?;
        Ok(report)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 删除订阅。删的是正在用的那条时,回到"本地配置"。
#[tauri::command]
pub fn sub_remove(id: String) -> Result<Store, String> {
    if id == LOCAL_ID {
        return Err("「本地配置」删不掉".to_string());
    }
    let mut store = store_load();
    store.items.retain(|i| i.id != id);
    let _ = std::fs::remove_file(snap_path(&id));
    if store.active == id {
        store.active = String::new();
        if !store.items.iter().any(|i| i.id == LOCAL_ID) {
            store.items.insert(0, local_item(0));
        }
        do_switch(&mut store, LOCAL_ID)?;
    }
    store_save(&store)?;
    crate::logging::event(&format!("SUB remove id={id}"));
    Ok(sub_state())
}

/// 把当前这套源另存一份新订阅(「复制」),并切过去。
///
/// 用户在远程订阅下改了源,又不想丢改动时走这条:改动变成一份独立的本地订阅。
#[tauri::command]
pub fn sub_clone(name: String) -> Result<Store, String> {
    let mut store = store_load();
    let cur = crate::commands::load_sources();
    let id = id_of_local(&format!("clone{name}{}", cur.len()));
    snap_write(&id, &cur)?;

    let base_name = if name.trim().is_empty() {
        store
            .items
            .iter()
            .find(|i| i.id == store.active)
            .map(|i| format!("{} 副本", i.name))
            .unwrap_or_else(|| "新的本地订阅".to_string())
    } else {
        name.trim().to_string()
    };

    store.items.push(Item {
        id: id.clone(),
        kind: KIND_LOCAL.to_string(),
        name: base_name,
        version: "0.0.0".to_string(),
        applied_at: now_iso(),
        source_count: cur.len(),
        ..Default::default()
    });
    store.active = id;
    store_save(&store)?;
    Ok(sub_state())
}

/// 导出某条订阅的内容成一个 json 文件(备份 / 分享给别人)
#[tauri::command]
pub fn sub_export(id: String) -> Result<String, String> {
    let store = store_load();
    let item = store
        .items
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("没有这条订阅: {id}"))?;

    // 正在用的那条以 sources.json 为准(可能刚手改过)
    let list = if store.active == id {
        crate::commands::load_sources()
    } else {
        snap_read(&id)
    };

    let slug: String = item
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let stamp = now_iso().replace([':', '-'], "").replace('T', "-");
    let stamp = stamp.trim_end_matches('Z').to_string();
    let dir = base().join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    let path = dir.join(format!("{slug}-{stamp}.json"));

    let idx = serde_json::json!({
        "schema": sub::SCHEMA,
        "name": item.name,
        "version": if sub::is_semver(&item.version) { item.version.clone() } else { "0.0.0".to_string() },
        "updated": now_iso(),
        "sources": list.iter().map(|s| serde_json::json!({
            "id": s.id, "name": s.name, "type": s.kind, "url": s.url,
            "adapter": s.adapter,
            "verify": s.verify,
            "verifyUrl": s.verify_url,
            "posterRatio": s.poster_ratio,
        })).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&idx).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 整体重置:清空所有订阅和源,回到初始的空白「本地配置」。
///
/// 原来的 `sources.json` 会备份成 `sources.bak-<时间>.json`,不直接毁掉。
#[tauri::command]
pub fn sub_reset() -> Result<Store, String> {
    let dir = base();
    let src = crate::paths::sources_path();
    if src.exists() {
        let stamp = now_iso().replace([':', '-'], "").replace('T', "-");
        let bak = dir.join(format!("sources.bak-{}.json", stamp.trim_end_matches('Z')));
        let _ = std::fs::copy(&src, &bak);
    }
    crate::commands::save_sources(Vec::new())?;
    let _ = std::fs::remove_dir_all(snap_dir());
    let _ = std::fs::remove_file(store_path());

    let mut s = Store::default();
    s.items.push(local_item(0));
    s.active = LOCAL_ID.to_string();
    store_save(&s)?;
    crate::logging::event("SUB reset");
    Ok(s)
}
