//! 源快检:不开界面,用**应用自己的网络层**跑一遍 list / detail / play / search。
//!
//! 为什么放在 core 的 example 里:网络走的是同一套选路(系统代理 → 直连、按域名记忆),
//! 所以这里报"通",应用里就通;报不通就是真不通,不会因为脚本用了别的 HTTP 栈而误判。
//!
//! 用法:
//!   cargo run -p reelbox-core --example probe -- <index.json 路径或地址>
//!   cargo run -p reelbox-core --example probe -- <index.json> --only=ffzy,dytt
//!   cargo run -p reelbox-core --example probe -- <index.json> --json
//!   cargo run -p reelbox-core --example probe -- <index.json> --retry   # 失败的再跑一遍
//!
//! 只覆盖 `adapter: vod`(苹果 CMS)。iplayr / m3u / 自定义适配器要把 js 跑起来,
//! 那是沙箱的活,这里跳过并说明。

use reelbox_core::source::{Client, Source};
use reelbox_core::sub::Index;
use std::time::Instant;

/// 一次结果。字段都给人看,--json 时原样输出
#[derive(Default)]
struct Row {
    id: String,
    name: String,
    adapter: String,
    list: Option<usize>,
    detail: Option<usize>,
    play: Option<String>,
    search: Option<usize>,
    ms: u128,
    error: String,
    /// 跑了多少次 / 成功多少次 —— 这些站本身不稳,一次跑不出来不代表死了
    runs: usize,
    ok_runs: usize,
}

fn read_target(target: &str) -> Result<String, String> {
    if target.starts_with("http://") || target.starts_with("https://") {
        let headers = [("User-Agent", "reelbox-probe".to_string())];
        let resp = reelbox_core::net::http::get(target, &headers)
            .map_err(|e| format!("拉取配置失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("拉取配置失败: HTTP {}", resp.status().as_u16()));
        }
        resp.text().map_err(|e| format!("读取失败: {e}"))
    } else {
        std::fs::read_to_string(target).map_err(|e| format!("读不了 {target}: {e}"))
    }
}

/// `Episode.id` 是 `线路:集数:地址`,第三段才是真正要播的东西
fn play_url_of(id: &str) -> Option<&str> {
    let mut it = id.splitn(3, ':');
    it.next()?;
    it.next()?;
    it.next().filter(|s| s.starts_with("http"))
}

/// 拉一下地址,看它到底是不是个能播的东西(只读前一点,别真把整部片子下下来)
fn probe_stream(url: &str) -> String {
    let headers = [("Range", "bytes=0-1023".to_string())];
    match reelbox_core::net::http::get(url, &headers) {
        Ok(r) => {
            let code = r.status().as_u16();
            let ctype = r
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let kind = if url.split('?').next().unwrap_or(url).ends_with(".mp4") {
                "mp4"
            } else if ctype.contains("mpegurl") || url.contains(".m3u8") {
                "hls"
            } else {
                "?"
            };
            format!("{code}/{kind}")
        }
        Err(e) => format!("×{}", e.chars().take(24).collect::<String>()),
    }
}

fn probe_one(src: &Source) -> Row {
    let mut row = Row {
        id: src.id.clone(),
        name: src.name.clone(),
        adapter: src.adapter().to_string(),
        runs: 1,
        ..Default::default()
    };
    let t0 = Instant::now();
    let client = Client::new(src.clone());

    // 1. 列表
    let page = match client.page(1, "") {
        Ok(p) => p,
        Err(e) => {
            row.error = format!("list: {e}");
            row.ms = t0.elapsed().as_millis();
            return row;
        }
    };
    row.list = Some(page.items.len());
    let first = match page.items.first() {
        Some(x) => x,
        None => {
            row.error = "list 是空的".into();
            row.ms = t0.elapsed().as_millis();
            return row;
        }
    };

    // 2. 详情
    let detail = match client.detail(&first.id) {
        Ok(d) => d,
        Err(e) => {
            row.error = format!("detail: {e}");
            row.ms = t0.elapsed().as_millis();
            return row;
        }
    };
    let eps: usize = detail.groups.iter().map(|g| g.episodes.len()).sum();
    row.detail = Some(eps);

    // 3. 播放地址(取第一条线路第一集)
    if let Some(url) = detail
        .groups
        .first()
        .and_then(|g| g.episodes.first())
        .and_then(|e| play_url_of(&e.id))
    {
        row.play = Some(probe_stream(url));
    }

    // 4. 搜索(拿片名前两个字试试,搜不到不算错)
    let kw: String = first.title.chars().take(2).collect();
    if !kw.is_empty() {
        row.search = client.search(&kw, 1).ok().map(|p| p.items.len());
    }

    row.ms = t0.elapsed().as_millis();
    row
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(target) = args.iter().find(|a| !a.starts_with("--")) else {
        eprintln!("用法: probe <index.json 路径或地址> [--only=id1,id2] [--json]");
        std::process::exit(2);
    };
    let only: Option<Vec<String>> = args
        .iter()
        .find_map(|a| a.strip_prefix("--only=").map(|s| s.split(',').map(|x| x.trim().to_string()).collect()));
    let as_json = args.iter().any(|a| a == "--json");

    let text = match read_target(target) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let idx = match Index::parse(&text) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let problems = reelbox_core::sub::problems(&idx);
    if !problems.is_empty() {
        eprintln!("配置本身有问题:");
        for p in &problems {
            eprintln!("  · {p}");
        }
        std::process::exit(1);
    }

    // 并发跑:失败的要等两条路都超时(20s+),串行跑 30 条要六分钟
    let jobs: usize = args
        .iter()
        .find_map(|a| a.strip_prefix("--jobs=").and_then(|n| n.parse().ok()))
        .unwrap_or(6)
        .clamp(1, 16);

    let times: usize = args
        .iter()
        .find_map(|a| a.strip_prefix("--times=").and_then(|n| n.parse().ok()))
        .unwrap_or(1)
        .clamp(1, 5);

    let pick: Vec<&reelbox_core::sub::SubSource> = idx
        .sources
        .iter()
        .filter(|s| match &only {
            Some(list) => list.iter().any(|x| x == &s.id),
            None => true,
        })
        .collect();
    let (cms, skipped): (Vec<_>, Vec<_>) = pick
        .into_iter()
        .partition(|s| matches!(s.to_source().adapter(), "vod" | "vod-rs"));

    let all: Vec<Source> = cms.iter().map(|s| s.to_source()).collect();
    let mut rows: Vec<Row> = Vec::with_capacity(all.len());
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        let chunk = (all.len() + jobs - 1) / jobs.max(1);
        for part in all.chunks(chunk.max(1)) {
            handles.push(scope.spawn(move || {
                part.iter()
                    .map(|s| {
                        let mut best = probe_one(s);
                        let mut ok = if best.error.is_empty() { 1 } else { 0 };
                        for _ in 1..times {
                            let r = probe_one(s);
                            if r.error.is_empty() {
                                ok += 1;
                                if best.error.is_empty() {
                                    best = r; // 已经通了就留最新一次的耗时
                                } else {
                                    best = r; // 这次通了,替换掉失败记录
                                }
                            }
                        }
                        best.runs = times;
                        best.ok_runs = ok;
                        best
                    })
                    .collect::<Vec<Row>>()
            }));
        }
        for h in handles {
            rows.extend(h.join().expect("探测线程挂了"));
        }
    });
    // 线程返回顺序不保证,按配置顺序排一下
    let order: Vec<String> = all.iter().map(|s| s.id.clone()).collect();
    rows.sort_by_key(|r| order.iter().position(|x| x == &r.id).unwrap_or(usize::MAX));

    // 失败的重跑一遍:第一遍常常是"选路记忆还没建立"(每个域名第一次要试两条路),
    // 第二遍走的是记住的那条,快得多,也更能反映真实可用性
    if args.iter().any(|a| a == "--retry") {
        for r in rows.iter_mut().filter(|r| !r.error.is_empty()) {
            if let Some(src) = all.iter().find(|s| s.id == r.id) {
                let again = probe_one(src);
                if again.error.is_empty() {
                    *r = again;
                }
            }
        }
    }

    let skip = skipped.len();
    for r in &rows {
        if as_json {
            continue;
        }
        let status = if r.error.is_empty() { "✓" } else { "✗" };
        println!(
            "{status} {:24} list={:>2} 详情={:>3}集 播放={:8} 搜索={:>2} {:>5}ms {}{}",
            format!("{} ({})", r.name, r.id),
            r.list.unwrap_or(0),
            r.detail.unwrap_or(0),
            r.play.clone().unwrap_or_else(|| "-".into()),
            r.search.unwrap_or(0),
            r.ms,
            if r.runs > 1 {
                format!("{}/{}次通 ", r.ok_runs, r.runs)
            } else {
                String::new()
            },
            r.error
        );
    }

    if as_json {
        let out: Vec<String> = rows
            .iter()
            .map(|r| {
                format!(
                    r#"{{"id":"{}","name":"{}","adapter":"{}","list":{},"detail":{},"play":"{}","search":{},"ms":{},"error":"{}"}}"#,
                    r.id,
                    r.name.replace('"', "'"),
                    r.adapter,
                    r.list.map(|x| x.to_string()).unwrap_or("null".into()),
                    r.detail.map(|x| x.to_string()).unwrap_or("null".into()),
                    r.play.clone().unwrap_or_default(),
                    r.search.map(|x| x.to_string()).unwrap_or("null".into()),
                    r.ms,
                    r.error.replace('"', "'")
                )
            })
            .collect();
        println!("[{}]", out.join(","));
    } else {
        let ok = rows.iter().filter(|r| r.error.is_empty()).count();
        println!(
            "\n{} 条:{} 通,{} 不通{}",
            rows.len(),
            ok,
            rows.len() - ok,
            if skip > 0 {
                format!(",{skip} 条需要沙箱没跑(iplayr / m3u / 自定义适配器)")
            } else {
                String::new()
            }
        );
    }

    if rows.iter().any(|r| !r.error.is_empty()) {
        std::process::exit(1);
    }
}
