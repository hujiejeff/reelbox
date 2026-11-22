//! 配置订阅的应用侧:拉索引、比对、装文件、合并源。
//!
//! 解析和挑错在 `reelbox_core::sub`(纯逻辑、能单测),这里只做 IO:
//!
//! 1. **拉**:`GET index.json`(走和插件同一套网络层,按域名选路)
//! 2. **比**:`sha256` 三方比对 —— 索引里的 / 本地文件的 / 上次装的时候记的
//! 3. **装**:先适配器、再插件、最后源(源的 `adapter` 可能指向这次刚装的适配器)
//! 4. **记**:`subscriptions.json` 存"这条路我装过什么",下次才能算增删改
//!
//! 安全边界只有一条:**只动自己装的东西**。`Source.from == 订阅 id` 才归它管,
//! 用户手加的源、手改过的文件,订阅碰不到(冲突会列进报告,不会静默覆盖)。

use crate::commands::FETCH_UA;
use reelbox_core::source::Source;
use reelbox_core::sub::{self, Index};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 订阅账本。和 `sources.json` 同一个数据目录。
const STORE: &str = "subscriptions.json";

/// 单个文件不能超过这个大小。插件都是几十 KB,超过基本就是地址写错了(拿到了网页)。
const MAX_FILE: usize = 512 * 1024;

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

/// 订阅装进去的一条源。
///
/// 两个 id 都要记:索引里的 id(`id`)是订阅认人的,**本地 id**(`local_id`)是用户
/// 那边真正的主键。两者不一样是因为订阅会「接管」用户自己已经加过的同地址源 ——
/// 接管时不改人家的 id(收藏和进度都按 id 存),但下次同步还得认得出它。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppliedSource {
    /// 索引里的 id
    pub id: String,
    /// 本地 `sources.json` 里的 id
    #[serde(default)]
    pub local_id: String,
}

/// 一条订阅。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stored {
    pub id: String,
    pub url: String,
    pub name: String,
    pub version: u32,
    pub updated: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub files: Vec<InstalledFile>,
    /// 上次装进去的源(整份留着:下次算增删改、订阅被移除时按它对账)
    #[serde(default)]
    pub sources: Vec<AppliedSource>,
    #[serde(default)]
    pub synced_at: String,
}

fn yes() -> bool {
    true
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            id: String::new(),
            url: String::new(),
            name: String::new(),
            version: 0,
            updated: String::new(),
            enabled: true,
            files: Vec::new(),
            sources: Vec::new(),
            synced_at: String::new(),
        }
    }
}

/// 一次同步干了什么。给人看的数字 + 没干成的理由。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub name: String,
    pub version: u32,
    /// 新增的源
    pub added: usize,
    /// 有更新的源
    pub updated: usize,
    /// 被索引删掉、本地跟着回收的源
    pub removed: usize,
    /// 这次真正写盘的文件数(适配器 + 插件)
    pub files: usize,
    /// 没装成的,每条一句人话(不阻断其它条目)
    pub skipped: Vec<String>,
}

fn store_path() -> PathBuf {
    crate::paths::base_dir().join(STORE)
}

pub fn load_store() -> Vec<Stored> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Stored>>(&t).ok())
        .unwrap_or_default()
}

fn save_store(list: &[Stored]) -> Result<(), String> {
    let path = store_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写文件失败: {e}"))
}

/// 订阅 id:地址的指纹取前 8 位。
///
/// 用地址而不是自增序号,是为了"同一个地址粘两次不会变成两条订阅";
/// 也不用名字 —— 名字改一次,历史就断了。
fn id_of(url: &str) -> String {
    let h = sub::sha256_hex(url.trim().as_bytes());
    format!("s{}", &h[..8])
}

/// 时间戳和源的健康检查用同一个实现(UTC ISO8601 秒精度),别处不用再引 chrono
fn now_iso() -> String {
    reelbox_core::source::now_iso()
}

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

/// 拉一份索引。`url` 是索引自己的地址,里面相对路径按它解析。
fn fetch_index(url: &str) -> Result<Index, String> {
    let headers = [("User-Agent", FETCH_UA.to_string())];
    let resp = reelbox_core::net::http::get(url, &headers).map_err(|e| format!("拉取失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取失败: HTTP {}", resp.status().as_u16()));
    }
    let text = resp.text().map_err(|e| format!("读取失败: {e}"))?;
    serde_json::from_str::<Index>(&text).map_err(|e| format!("不是合法的 index.json: {e}"))
}

/// 源里"订阅该管"的字段有没有变。
///
/// `health` / `probe` 是本地观测结果,永远不比 —— 拿它们比会让每次同步都"有更新"。
fn same_source(a: &Source, b: &Source) -> bool {
    a.name == b.name
        && a.kind == b.kind
        && a.url == b.url
        && a.adapter == b.adapter
        && a.verify == b.verify
        && a.verify_url == b.verify_url
        && a.poster_ratio == b.poster_ratio
        && a.options == b.options
}

/// 更新一条已存在的源:换掉订阅管的字段,保留本地观测(健康、探测证据)。
fn merge_into(old: Source, mut new: Source) -> Source {
    new.health = old.health;
    new.probe = old.probe;
    if new.url != old.url {
        // 地址换了,旧的探测结论不再成立
        new.health = None;
        new.probe = None;
    }
    new
}

/// 装一份索引。`prev` 是上次的记录(首次安装传 None)。
///
/// `force = true` 时连"用户改过的文件"也覆盖(界面上是二次确认之后才传)。
fn apply(
    url: &str,
    idx: &Index,
    prev: Option<&Stored>,
    force: bool,
) -> Result<(Stored, Report), String> {
    let problems = sub::problems(idx, env!("CARGO_PKG_VERSION"));
    if !problems.is_empty() {
        return Err(format!(
            "这份配置有问题,没有安装:\n· {}",
            problems.join("\n· ")
        ));
    }

    let id = id_of(url);
    let mut report = Report {
        id: id.clone(),
        name: idx.name.clone(),
        version: idx.version,
        ..Default::default()
    };

    // ---- 1. 适配器 + 插件 ----
    let dir = crate::paths::plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建插件目录失败: {e}"))?;
    let mut files: Vec<InstalledFile> = Vec::new();

    for (kind, e) in idx.code_entries() {
        let target = dir.join(&e.path);
        let want = e.sha256.to_lowercase();
        let prev_rec = prev.and_then(|p| {
            p.files
                .iter()
                .find(|f| f.kind == kind && f.id == e.id)
                .cloned()
        });

        if target.exists() {
            let cur = std::fs::read(&target)
                .map(|b| sub::sha256_hex(&b))
                .unwrap_or_default();
            if cur == want {
                // 已经是这份了
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

        let src = sub::code_url(url, &e.path);
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
            Err(err) => report
                .skipped
                .push(format!("{} {}:{}", kind, e.id, err)),
        }
    }

    // ---- 2. 源 ----
    //
    // 三条规则,顺序不能换:
    //   1. 上次装过的那条(按 local_id 认)→ 直接更新
    //   2. 用户自己加过、地址完全一样的 → **接管**,不重复加一条
    //      (常见于"我先把配置导进应用了,后来才做成订阅")
    //   3. 同 id 但地址不同的 → 不碰,报冲突(用户可能故意的)
    let mut list = crate::commands::load_sources();
    let mut kept: Vec<AppliedSource> = Vec::new();

    for s in &idx.sources {
        let mut src = s.to_source();
        src.from = id.clone();

        let remembered = prev.and_then(|p| p.sources.iter().find(|a| a.id == s.id)).cloned();
        let hit = remembered
            .as_ref()
            .and_then(|a| {
                list.iter()
                    .position(|x| !a.local_id.is_empty() && x.id == a.local_id && x.from == id)
            })
            .or_else(|| list.iter().position(|x| x.id == s.id));

        match hit {
            Some(i) if list[i].from == id => {
                if !same_source(&list[i], &src) {
                    src.id = list[i].id.clone();
                    list[i] = merge_into(list[i].clone(), src);
                    report.updated += 1;
                }
                kept.push(AppliedSource {
                    id: s.id.clone(),
                    local_id: list[i].id.clone(),
                });
            }
            Some(i) if list[i].from.is_empty() && list[i].url == src.url && list[i].adapter == src.adapter => {
                // 同一条源,只是用户先自己加过了:接管过来,id 保持用户原来那个
                src.id = list[i].id.clone();
                list[i] = merge_into(list[i].clone(), src);
                list[i].from = id.clone();
                report.updated += 1;
                kept.push(AppliedSource {
                    id: s.id.clone(),
                    local_id: list[i].id.clone(),
                });
            }
            Some(_) => {
                // 同 id 不同地址,或者已经被别的订阅管着:不碰,但要说清楚
                report.skipped.push(format!(
                    "源 {}:本地已有同 id 的源(地址不同或来自别的订阅),没有覆盖",
                    src.id
                ));
            }
            None => {
                // 没有同 id 的,再看有没有「同一个地址」的本地源 —— 用户先把配置
                // 导进过应用的话,id 是随机的,靠地址才认得出来
                let same_url = list.iter().position(|x| {
                    x.from.is_empty() && x.url == src.url && x.adapter == src.adapter
                });
                match same_url {
                    Some(i) => {
                        src.id = list[i].id.clone();
                        list[i] = merge_into(list[i].clone(), src);
                        list[i].from = id.clone();
                        report.updated += 1;
                        kept.push(AppliedSource {
                            id: s.id.clone(),
                            local_id: list[i].id.clone(),
                        });
                    }
                    None => {
                        let local_id = src.id.clone();
                        list.push(src);
                        report.added += 1;
                        kept.push(AppliedSource {
                            id: s.id.clone(),
                            local_id,
                        });
                    }
                }
            }
        }
    }

    // 索引里删掉的,本地跟着回收 —— 只回收自己装的那些
    if let Some(p) = prev {
        let alive: Vec<&str> = idx.sources.iter().map(|s| s.id.as_str()).collect();
        for old in &p.sources {
            if alive.contains(&old.id.as_str()) {
                continue;
            }
            let lid = if old.local_id.is_empty() { &old.id } else { &old.local_id };
            if let Some(i) = list.iter().position(|x| x.id == *lid && x.from == id) {
                list.remove(i);
                report.removed += 1;
            }
        }
    }

    crate::commands::save_sources(list)?;

    let stored = Stored {
        id,
        url: url.to_string(),
        name: idx.name.clone(),
        version: idx.version,
        updated: idx.updated.clone(),
        enabled: true,
        files,
        sources: kept,
        synced_at: now_iso(),
    };

    crate::logging::event(&format!(
        "SUB sync id={} v{} +{} ~{} -{} files={} skip={}",
        stored.id,
        stored.version,
        report.added,
        report.updated,
        report.removed,
        report.files,
        report.skipped.len()
    ));

    Ok((stored, report))
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn sub_list() -> Vec<Stored> {
    load_store()
}

/// 添加 / 更新一条订阅(地址就是 id,同一个地址再粘一次 = 同步)。
#[tauri::command]
pub async fn sub_add(url: String, force: bool) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("没有地址".to_string());
        }
        let idx = fetch_index(&url)?;
        let prev = load_store().into_iter().find(|s| s.id == id_of(&url));
        let (stored, report) = apply(&url, &idx, prev.as_ref(), force)?;

        let mut list = load_store();
        match list.iter().position(|s| s.id == stored.id) {
            Some(i) => list[i] = stored,
            None => list.push(stored),
        }
        save_store(&list)?;
        Ok(report)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 重新拉一次某条订阅。`force` 时连用户改过的文件也覆盖。
#[tauri::command]
pub async fn sub_sync(id: String, force: bool) -> Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = load_store();
        let prev = list
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| format!("没有这条订阅: {id}"))?;
        let idx = fetch_index(&prev.url)?;
        let (stored, report) = apply(&prev.url, &idx, Some(&prev), force)?;

        let mut list = load_store();
        if let Some(i) = list.iter().position(|s| s.id == stored.id) {
            list[i] = stored;
        }
        save_store(&list)?;
        Ok(report)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 删除一条订阅:回收它装的源,**不动**它装的文件。
///
/// 文件可能是别的订阅也在用的同一个,也可能用户拿去改成了自己的源 ——
/// 删文件比删源危险得多,所以留给用户自己决定。
#[tauri::command]
pub fn sub_remove(id: String) -> Result<Report, String> {
    let list = load_store();
    let prev = list
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| format!("没有这条订阅: {id}"))?;

    let mut sources = crate::commands::load_sources();
    let before = sources.len();
    sources.retain(|s| s.from != id);
    let removed = before - sources.len();
    if removed > 0 {
        crate::commands::save_sources(sources)?;
    }

    let rest: Vec<Stored> = list.into_iter().filter(|s| s.id != id).collect();
    save_store(&rest)?;

    crate::logging::event(&format!("SUB remove id={id} sources={removed}"));
    Ok(Report {
        id,
        name: prev.name,
        version: prev.version,
        removed,
        ..Default::default()
    })
}
