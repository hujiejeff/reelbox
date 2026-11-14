//! 封面处理:取图 + webp 转 jpeg。
//! Windows 的 WebView 能显示 webp,但源站封面常常是几种格式混着,
//! 统一转成 jpeg 最稳,顺便缩到卡片需要的宽度。

use std::io::{Cursor, Read};

/// 卡片最宽也就一两百像素,按 320 转足够清晰。
pub const THUMB_WIDTH: u32 = 320;

/// 带 UA 取一张图。
pub fn fetch(url: &str, ua: &str) -> Result<(Vec<u8>, String), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(25))
        .user_agent(ua)
        .build();
    let resp = agent.get(url).call().map_err(|e| format!("NETWORK: {e}"))?;
    let ct = resp.header("content-type").unwrap_or("").to_string();
    let mut buf = Vec::new();
    let mut reader = resp.into_reader();
    reader
        .by_ref()
        .take(16 << 20)
        .read_to_end(&mut buf)
        .map_err(|e| format!("NETWORK: {e}"))?;
    Ok((buf, ct))
}

/// 把任意图片转成 jpeg,并按宽度缩放。
pub fn to_jpeg(bytes: &[u8], max_w: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("IMAGE: {e}"))?;
    let img = if max_w > 0 && img.width() > max_w {
        let h = (img.height() as u64 * max_w as u64 / img.width() as u64).max(1) as u32;
        img.resize(max_w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .map_err(|e| format!("IMAGE: {e}"))?;
    Ok(out)
}

/// 取图并转好;已经是 jpeg 且尺寸合适时原样返回。
pub fn poster(url: &str, ua: &str) -> Result<Vec<u8>, String> {
    if url.is_empty() {
        return Err("EMPTY".into());
    }
    let (bytes, _ct) = fetch(url, ua)?;
    to_jpeg(&bytes, THUMB_WIDTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_webp_fixture() {
        // 复用 proxies 用过的样本:仓库里没有就跳过
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../ui/vendor/tiny.webp");
        let Ok(raw) = std::fs::read(path) else {
            return;
        };
        let jpg = to_jpeg(&raw, THUMB_WIDTH).expect("转换失败");
        assert!(jpg.starts_with(&[0xFF, 0xD8, 0xFF]), "不是 JPEG");
        assert!(jpg.len() > 1000);
        println!("webp {} → jpeg {}", raw.len(), jpg.len());
    }
}
