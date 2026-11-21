//! 苹果 CMS v10 的两种接口:JSON(vod)与 XML。

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::model::{Detail, Episode, Filter, Group, Item, Option_, Page, Stream};
use crate::source::Source;

/// 采集接口普遍接受的 UA。
pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

/// 一个苹果 CMS 源的客户端。
pub struct Client {
    src: Source,
}

impl Client {
    pub fn new(src: Source) -> Self {
        Self { src }
    }

    pub fn source(&self) -> &Source {
        &self.src
    }

    fn get(&self, query: &[(&str, String)]) -> Result<String, String> {
        let mut url = self.src.url.clone();
        let sep = if url.contains('?') { '&' } else { '?' };
        let mut qs = String::new();
        for (k, v) in query {
            if v.is_empty() {
                continue;
            }
            if !qs.is_empty() {
                qs.push('&');
            }
            qs.push_str(&format!("{}={}", k, urlencode(v)));
        }
        if !qs.is_empty() {
            url.push(sep);
            url.push_str(&qs);
        }
        // 代理由 net::proxy 每次解析,超时/重试在 net::http 里统一管
        let resp = crate::net::http::get(&url, &[("User-Agent", DEFAULT_UA.to_string())])?;
        resp.text().map_err(|e| format!("NETWORK: {e}"))
    }

    /// 取一页条目,page 从 1 开始。
    pub fn page(&self, page: u32, classify: &str) -> Result<Page, String> {
        if page < 1 {
            return Err("INVALID_RESPONSE: 分页游标无效".into());
        }
        let body = self.get(&[
            ("ac", "detail".into()),
            ("pg", page.to_string()),
            ("t", classify.to_string()),
        ])?;
        if self.src.format() == "xml" {
            page_xml(&body, page)
        } else {
            page_json(&body, page).map_err(|e| self.blame(e, &body))
        }
    }

    /// 把解析失败说清楚:哪个源、返回了什么
    fn blame(&self, e: String, body: &str) -> String {
        let head: String = body.trim().chars().take(60).collect();
        let looks_xml = head.starts_with("<");
        format!(
            "{e} | 源={} | 返回前 60 字={:?}{}",
            self.src.name,
            head,
            if looks_xml { "(看起来是 XML,把源的地址改成 .../at/xml 试试)" } else { "" }
        )
    }

    /// 用关键词查询。
    pub fn search(&self, keyword: &str, page: u32) -> Result<Page, String> {
        let page = page.max(1);
        let body = self.get(&[
            ("ac", "detail".into()),
            ("wd", keyword.to_string()),
            ("pg", page.to_string()),
        ])?;
        if self.src.format() == "xml" {
            page_xml(&body, page)
        } else {
            page_json(&body, page).map_err(|e| self.blame(e, &body))
        }
    }

    /// 取一部作品的线路与剧集。
    pub fn detail(&self, id: &str) -> Result<Detail, String> {
        if id.is_empty() {
            return Err("NOT_FOUND: 缺少内容标识".into());
        }
        let body = self.get(&[("ac", "detail".into()), ("ids", id.to_string())])?;
        let raw = if self.src.format() == "xml" {
            detail_xml(&body)?
        } else {
            detail_json(&body).map_err(|e| self.blame(e, &body))?
        };
        let names: Vec<&str> = raw.from.split("$$$").collect();
        let mut groups = Vec::new();
        for (i, line) in raw.play_url.split("$$$").enumerate() {
            let name = names
                .get(i)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("线路 {}", i + 1));
            let mut g = Group {
                id: format!("line:{i}:{name}"),
                name: name.clone(),
                episodes: Vec::new(),
            };
            for (j, ep) in line.split('#').enumerate() {
                let ep = ep.trim();
                if ep.is_empty() {
                    continue;
                }
                let (ep_name, ep_url) = match ep.split_once('$') {
                    Some((n, u)) => (n, u),
                    None => (ep, ep),
                };
                if !ep_url.starts_with("http") {
                    continue;
                }
                g.episodes.push(Episode {
                    id: format!("{i}:{j}:{ep_url}"),
                    name: ep_name.to_string(),
                });
            }
            if !g.episodes.is_empty() {
                groups.push(g);
            }
        }
        if groups.is_empty() {
            return Err("NOT_FOUND: 没有可播放的剧集".into());
        }
        Ok(Detail {
            id: id.to_string(),
            title: raw.title,
            poster: raw.poster,
            summary: strip_tags(&raw.summary),
            groups,
        })
    }

    /// 从剧集标识里取出播放地址。
    ///
    /// 有的源给的是一张分享页(HTML),真正的 m3u8 藏在页面里:能抽出来就直接抽,
    /// 抽不出来就把 `page = true` 交出去 —— 播放链路据此明确报「只给了解析页」。
    pub fn stream(&self, episode_id: &str) -> Result<Stream, String> {
        let parts: Vec<&str> = episode_id.splitn(3, ':').collect();
        if parts.len() != 3 || !parts[2].starts_with("http") {
            return Err("INVALID_RESPONSE: 剧集标识无效".into());
        }
        let media = resolve_media(parts[2]);
        let mime = if media.url.to_lowercase().contains(".mp4") {
            "video/mp4"
        } else {
            "application/vnd.apple.mpegurl"
        };
        let mut headers = BTreeMap::new();
        headers.insert("User-Agent".to_string(), DEFAULT_UA.to_string());
        if let Some(r) = media.referer {
            headers.insert("Referer".to_string(), r);
        }
        Ok(Stream {
            url: media.url,
            mime: mime.to_string(),
            headers,
            options: Vec::new(),
            page: media.page,
        })
    }

    /// 把源的分类读回来。苹果 CMS 的 t= 只认二级分类,所以两级都要带上。
    pub fn filters(&self) -> Vec<Filter> {
        if self.src.format() != "vod" {
            return Vec::new();
        }
        let body = match self.get(&[("ac", "list".into())]) {
            Ok(b) => b,
            Err(_) => return Vec::new(),
        };
        let doc: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let mut opts = vec![Option_ {
            label: "全部".into(),
            value: String::new(),
            parent: String::new(),
        }];
        if let Some(class) = doc.get("class").and_then(|c| c.as_array()) {
            for c in class {
                let id = raw_string(c.get("type_id"));
                let name = c.get("type_name").and_then(|v| v.as_str()).unwrap_or("");
                if id.is_empty() || name.is_empty() {
                    continue;
                }
                let mut pid = raw_string(c.get("type_pid"));
                if pid == "0" {
                    pid.clear();
                }
                opts.push(Option_ {
                    label: name.to_string(),
                    value: id,
                    parent: pid,
                });
            }
        }
        if opts.len() < 2 {
            return Vec::new();
        }
        vec![Filter {
            key: "classify".into(),
            label: "分类".into(),
            options: opts,
        }]
    }
}

struct RawDetail {
    title: String,
    poster: String,
    summary: String,
    from: String,
    play_url: String,
}

fn raw_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn kind_of(type_name: &str) -> String {
    if type_name.contains('剧') || type_name.contains("动漫") || type_name.contains("综艺") {
        "series".into()
    } else if type_name.contains("电影") || type_name.contains('片') {
        "movie".into()
    } else {
        "unknown".into()
    }
}

fn page_json(body: &str, page: u32) -> Result<Page, String> {
    let doc: Value = serde_json::from_str(body).map_err(|_| "INVALID_RESPONSE: 不是合法 JSON")?;
    let mut items = Vec::new();
    if let Some(list) = doc.get("list").and_then(|l| l.as_array()) {
        for v in list {
            items.push(Item {
                id: raw_string(v.get("vod_id")),
                title: v.get("vod_name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                kind: kind_of(v.get("type_name").and_then(|x| x.as_str()).unwrap_or("")),
                poster: v.get("vod_pic").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                subtitle: v.get("vod_remarks").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    let total: u32 = raw_string(doc.get("pagecount")).parse().unwrap_or(0);
    Ok(Page {
        items,
        next: if total > page { (page + 1).to_string() } else { String::new() },
    })
}

fn detail_json(body: &str) -> Result<RawDetail, String> {
    let doc: Value = serde_json::from_str(body).map_err(|_| "INVALID_RESPONSE: 不是合法 JSON")?;
    let first = doc
        .get("list")
        .and_then(|l| l.as_array())
        .and_then(|l| l.first())
        .ok_or("NOT_FOUND: 没有这个内容")?;
    Ok(RawDetail {
        title: first.get("vod_name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        poster: first.get("vod_pic").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        summary: first.get("vod_content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        from: first.get("vod_play_from").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        play_url: first.get("vod_play_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct XmlRss {
    #[serde(rename = "list", default)]
    list: Option<XmlList>,
}

#[derive(Debug, Default, Deserialize)]
struct XmlList {
    #[serde(rename = "@pagecount", default)]
    pagecount: String,
    #[serde(rename = "video", default)]
    videos: Vec<XmlVideo>,
}

#[derive(Debug, Default, Deserialize)]
struct XmlVideo {
    #[serde(rename = "id", default)]
    id: String,
    #[serde(rename = "name", default)]
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(rename = "note", default)]
    note: String,
    #[serde(rename = "pic", default)]
    pic: String,
    #[serde(rename = "des", default)]
    des: String,
    #[serde(rename = "dl", default)]
    dl: Option<XmlDl>,
}

#[derive(Debug, Default, Deserialize)]
struct XmlDl {
    #[serde(rename = "dd", default)]
    dds: Vec<XmlDd>,
}

#[derive(Debug, Default, Deserialize)]
struct XmlDd {
    #[serde(rename = "@flag", default)]
    flag: String,
    #[serde(rename = "$text", default)]
    text: String,
}

fn xml_list(body: &str) -> Result<XmlList, String> {
    let rss: XmlRss = quick_xml::de::from_str(body).map_err(|_| "INVALID_RESPONSE: 不是合法 XML")?;
    Ok(rss.list.unwrap_or_default())
}

fn page_xml(body: &str, page: u32) -> Result<Page, String> {
    let list = xml_list(body)?;
    let items = list
        .videos
        .iter()
        .map(|v| Item {
            id: v.id.clone(),
            title: v.name.clone(),
            kind: kind_of(&v.kind),
            poster: v.pic.clone(),
            subtitle: v.note.clone(),
        })
        .collect();
    let total: u32 = list.pagecount.parse().unwrap_or(0);
    Ok(Page {
        items,
        next: if total > page { (page + 1).to_string() } else { String::new() },
    })
}

fn detail_xml(body: &str) -> Result<RawDetail, String> {
    let list = xml_list(body)?;
    let v = list.videos.first().ok_or("NOT_FOUND: 没有这个内容")?;
    let dl = v.dl.as_ref().ok_or("NOT_FOUND: 没有可播放的剧集")?;
    let from = dl.dds.iter().map(|d| d.flag.clone()).collect::<Vec<_>>().join("$$$");
    let urls = dl.dds.iter().map(|d| d.text.clone()).collect::<Vec<_>>().join("$$$");
    Ok(RawDetail {
        title: v.name.clone(),
        poster: v.pic.clone(),
        summary: v.des.clone(),
        from,
        play_url: urls,
    })
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => {
                if depth > 0 {
                    depth -= 1
                }
            }
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ").trim().to_string()
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_page_reads_covers() {
        let body = r#"{"pagecount":3,"list":[{"vod_id":12,"vod_name":"测试","vod_pic":"http://a/b.jpg","vod_remarks":"更新至第4集","type_name":"动作片"}]}"#;
        let p = page_json(body, 1).unwrap();
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].id, "12");
        assert_eq!(p.items[0].kind, "movie");
        assert_eq!(p.items[0].poster, "http://a/b.jpg");
        assert_eq!(p.next, "2");
    }

    #[test]
    fn json_detail_splits_lines() {
        let body = r#"{"list":[{"vod_name":"测试","vod_pic":"p","vod_content":"<p>简介</p>","vod_play_from":"ffm3u8$$$kuaikan","vod_play_url":"第01集$http://a/1.m3u8#第02集$http://a/2.m3u8$$$第01集$http://b/1.m3u8"}]}"#;
        let raw = detail_json(body).unwrap();
        assert_eq!(raw.from, "ffm3u8$$$kuaikan");
        assert!(raw.play_url.contains("http://b/1.m3u8"));
    }

    #[test]
    fn xml_page_parses() {
        let body = r#"<rss><list pagecount="5"><video><id>7</id><name>片子</name><type>国产剧</type><note>更新</note><pic>http://x/y.jpg</pic></video></list></rss>"#;
        let p = page_xml(body, 1).unwrap();
        assert_eq!(p.items[0].title, "片子");
        assert_eq!(p.items[0].kind, "series");
        assert_eq!(p.next, "2");
    }

    #[test]
    fn stream_parses_episode_id() {
        let c = Client::new(Source::default());
        let st = c.stream("0:1:https://cdn.example.com/a.m3u8").unwrap();
        assert_eq!(st.url, "https://cdn.example.com/a.m3u8");
        assert!(st.mime.contains("mpegurl"));
        // 媒体地址自己就是播放地址:不走解析页那条路(不发请求)
        assert!(!st.page, "m3u8 不该被标成解析页");
        assert!(c.stream("bad").is_err());
    }

    #[test]
    fn strip_tags_removes_markup() {
        assert_eq!(strip_tags("<p>你好&nbsp;世界</p>"), "你好 世界");
    }

    // REELBOX_NET=1 cargo test -p reelbox-core live -- --nocapture
    #[test]
    fn live_page_and_detail() {
        if std::env::var("REELBOX_NET").as_deref() != Ok("1") {
            return;
        }
        // 其余字段(version / options / adapter / probe / health)都用缺省值
        let c = Client::new(Source {
            id: "ffzy".into(),
            name: "非凡资源".into(),
            kind: "vod".into(),
            url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8".into(),
            ..Default::default()
        });
        let p = c.page(1, "").expect("列表失败");
        assert!(!p.items.is_empty(), "列表为空");
        let with_pic = p.items.iter().filter(|i| !i.poster.is_empty()).count();
        println!("列表 {} 条,{} 张封面,首条 {:?}", p.items.len(), with_pic, p.items[0].title);
        assert!(with_pic > 0, "没有封面");

        let d = c.detail(&p.items[0].id).expect("详情失败");
        println!("详情 {:?}:{} 条线路,第一集 {:?}", d.title, d.groups.len(), d.groups[0].episodes[0].name);
        let st = c.stream(&d.groups[0].episodes[0].id).expect("取流失败");
        println!("播放地址 {}", st.url);

        let filters = c.filters();
        assert!(!filters.is_empty(), "没读到分类");
        println!("分类 {} 个", filters[0].options.len());
    }
}

/// 一次取流的结果:交给播放器的地址、要带的 Referer、以及"这是不是只是一张网页"。
struct Media {
    url: String,
    referer: Option<String>,
    page: bool,
}

impl Media {
    fn played(url: &str) -> Self {
        Self { url: url.to_string(), referer: None, page: false }
    }
}

/// 地址本身看着就是媒体文件(`.m3u8` / `.mp4`)吗?
fn is_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains(".m3u8") || lower.contains(".mp4")
}

/// 有些源给的是一张分享页(HTML),真正的 m3u8 藏在页面里。
/// 取一次页面把地址抽出来,同时把页面地址当 Referer 带回去。
///
/// 网络那一半在这里,判断那一半在 `media_from_page`(纯函数,好测)。
fn resolve_media(url: &str) -> Media {
    if is_media_url(url) {
        return Media::played(url);
    }
    let headers = [
        ("User-Agent", DEFAULT_UA.to_string()),
        ("Referer", url.to_string()),
    ];
    let resp = match crate::net::http::get(url, &headers) {
        Ok(r) => r,
        // 连不上就照旧把地址交出去:让播放阶段报"网络没通",别谎称"只给了解析页"
        Err(_) => return Media::played(url),
    };
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let status = resp.status().as_u16();
    if ct.to_lowercase().contains("mpegurl") || ct.to_lowercase().contains("video/") {
        return Media::played(url);
    }
    let Ok(body) = resp.text() else {
        return Media::played(url);
    };
    media_from_page(url, status, &ct, &body)
}

/// 拿到响应之后怎么判(纯函数,单测直接喂 body):
///   1. 页面里能抽出 .m3u8 → 用它,原页面地址留作 Referer;
///   2. 抽不到、且响应确实是 HTML → 这是个解析页,`page = true` 交给播放链路报错;
///   3. 其余情况(404、二进制、奇怪的地址)原样交出去,别抢走播放链路。
fn media_from_page(url: &str, status: u16, content_type: &str, body: &str) -> Media {
    if status >= 400 {
        return Media::played(url);
    }
    if let Some(media) = extract_m3u8(body, url) {
        return Media { url: media, referer: Some(url.to_string()), page: false };
    }
    if looks_like_html(content_type, body) {
        return Media { url: url.to_string(), referer: None, page: true };
    }
    Media::played(url)
}

/// 响应像不像一张网页:content-type 说了算,没说就看正文开头。
fn looks_like_html(content_type: &str, body: &str) -> bool {
    if content_type.to_lowercase().contains("html") {
        return true;
    }
    let head: String = body.chars().take(400).collect::<String>().to_lowercase();
    head.contains("<html") || head.contains("<!doctype")
}

fn extract_m3u8(body: &str, base: &str) -> Option<String> {
    let bs = char::from_u32(92).unwrap();
    let text = body.replace(&format!("{bs}/"), "/");
    let lower = text.to_lowercase();
    let bytes = text.as_bytes();
    let idx = lower.find(".m3u8")?;
    let mut l = idx;
    while l > 0 && !is_boundary(bytes[l - 1]) {
        l -= 1;
    }
    let mut r = idx + 5;
    while r < bytes.len() && !is_boundary(bytes[r]) {
        r += 1;
    }
    Some(absolute(&text[l..r], base))
}

fn is_boundary(c: u8) -> bool {
    let ch = c as char;
    ch == '\'' || ch == '"' || ch == '<' || ch == '>' || ch == ')' || ch == '(' || ch == ',' || ch == ';'
        || ch.is_whitespace()
}

/// 把相对地址补成绝对地址
fn absolute(u: &str, base: &str) -> String {
    if u.starts_with("http") {
        return u.to_string();
    }
    if u.starts_with("//") {
        return format!("https:{u}");
    }
    let Some(p) = base.find("://") else {
        return u.to_string();
    };
    let rest = &base[p + 3..];
    let host_end = rest.find('/').map(|i| p + 3 + i).unwrap_or(base.len());
    let origin = &base[..host_end];
    if u.starts_with('/') {
        return format!("{origin}{u}");
    }
    let dir = match base.rfind('/') {
        Some(i) if i > host_end => &base[..=i],
        _ => return format!("{origin}/{u}"),
    };
    format!("{dir}{u}")
}

#[cfg(test)]
mod extract_tests {
    use super::*;

    #[test]
    fn finds_relative_m3u8() {
        let html = r#"<script>const url = "/20251222/65250_ab09f628/index.m3u8?sign=abc";</script>"#;
        let got = extract_m3u8(html, "https://vip.dytt-cine.com/share/xyz").unwrap();
        assert_eq!(
            got,
            "https://vip.dytt-cine.com/20251222/65250_ab09f628/index.m3u8?sign=abc"
        );
    }

    #[test]
    fn finds_absolute_m3u8() {
        let html = r#"var u = "https://a.example/x/index.m3u8?t=1";"#;
        assert_eq!(
            extract_m3u8(html, "https://a.example/p").unwrap(),
            "https://a.example/x/index.m3u8?t=1"
        );
    }

    #[test]
    fn none_when_absent() {
        assert!(extract_m3u8("<html>no video here</html>", "https://a.example/").is_none());
    }

    /// 分享页:页面上捞不到 m3u8,但响应确实是 HTML → 标成解析页(`page = true`)
    #[test]
    fn share_page_is_flagged() {
        let html = "<!doctype html><html><body><h1>电影天堂</h1><p>请下载客户端</p></body></html>";
        let got = media_from_page("https://vip.dytt-cine.com/share/xyz", 200, "text/html", html);
        assert!(got.page, "HTML 分享页应置 page=true");
        assert_eq!(got.url, "https://vip.dytt-cine.com/share/xyz");
        assert!(got.referer.is_none());
    }

    /// 页面上有 m3u8:直接抽出来,并把页面地址留作 Referer(不算解析页)
    #[test]
    fn page_with_stream_is_not_flagged() {
        let html = r#"<script>src="/20251222/a/index.m3u8?sign=1"</script>"#;
        let got = media_from_page("https://a.example/p/1", 200, "text/html", html);
        assert!(!got.page);
        assert_eq!(got.url, "https://a.example/20251222/a/index.m3u8?sign=1");
        assert_eq!(got.referer.as_deref(), Some("https://a.example/p/1"));
    }

    /// 不是 HTML 又没有 m3u8(没有后缀的二进制):照旧原样交出去,不抢播放链路
    #[test]
    fn non_html_without_stream_is_played_as_is() {
        let got = media_from_page(
            "https://cdn.example.com/play/abc",
            200,
            "application/octet-stream",
            "not html at all",
        );
        assert!(!got.page, "不是网页就别当成解析页");
        assert_eq!(got.url, "https://cdn.example.com/play/abc");
    }

    /// 错误页(403 之类)不当解析页:让播放阶段报出真实的失败
    #[test]
    fn error_response_is_not_a_parse_page() {
        let got = media_from_page("https://a.example/x", 403, "text/html", "<html>403</html>");
        assert!(!got.page);
        assert_eq!(got.url, "https://a.example/x");
    }

    /// content-type 缺失时靠正文开头认网页
    #[test]
    fn detects_html_by_body_when_type_missing() {
        let got = media_from_page(
            "https://a.example/share",
            200,
            "",
            "\n  <html><head><title>x</title></head></html>",
        );
        assert!(got.page);
    }
}
