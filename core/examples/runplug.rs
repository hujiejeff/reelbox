//! 临时调试:在命令行里直接跑一个插件钩子
use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: runplug <插件路径> <钩子> [arg_json]");
        std::process::exit(2);
    }
    let path = std::path::PathBuf::from(&args[1]);
    let hook = args[2].clone();
    let arg = args.get(3).cloned().unwrap_or_else(|| "{}".into());

    let fetch = Box::new(|url: &str| -> Option<String> {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(15))
            .build();
        match agent
            .get(url)
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
            .call()
        {
            Ok(r) => {
                let mut s = String::new();
                let _ = r.into_reader().take(4_000_000).read_to_string(&mut s);
                eprintln!("[fetch] {} -> {} bytes", &url[..url.len().min(80)], s.len());
                Some(s)
            }
            Err(e) => {
                eprintln!("[fetch] {} -> ERR {e}", &url[..url.len().min(80)]);
                None
            }
        }
    });

    match reelbox_core::plugin::run_file(&path, &hook, &arg, fetch) {
        Ok(out) => {
            println!("{}", &out[..out.len().min(1500)]);
        }
        Err(e) => {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}
