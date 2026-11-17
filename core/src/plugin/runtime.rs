//! 极简插件宿主:把 `.webox.js` 真的跑起来。
//!
//! 宿主只暴露一个能力:`ctx.http.get(url)`(真正的网络请求在 Rust 里做)。
//! 每次调用钩子返回 JSON 字符串,方便上层直接塞给前端。

use boa_engine::{js_string, Context as JsContext, JsValue, NativeFunction, Source};

use super::PluginMeta;

thread_local! {
    /// 当前线程的抓取函数(boa 与宿主同线程,足够用)
    static FETCHER: std::cell::RefCell<Option<std::rc::Rc<dyn Fn(&str) -> Option<String>>>> =
        const { std::cell::RefCell::new(None) };
}

pub struct Host {
    ctx: JsContext,
    meta: PluginMeta,
}

impl Host {
    pub fn load(source: &str, fetch: Box<dyn Fn(&str) -> Option<String>>) -> Result<Self, String> {
        let meta = super::parse_meta(source)?;
        let mut ctx = JsContext::default();

        FETCHER.with(|slot| {
            *slot.borrow_mut() = Some(std::rc::Rc::from(fetch));
        });

        // 宿主函数:抓文本(非捕获闭包,满足 Copy 要求)
        let fetch_fn = NativeFunction::from_copy_closure(|_this, args, context| {
            let url = match args.first() {
                Some(v) => match v.to_string(context) {
                    Ok(s) => s.to_std_string_escaped(),
                    Err(_) => return Ok(JsValue::null()),
                },
                None => return Ok(JsValue::null()),
            };
            let _ = context;
            let text = FETCHER.with(|slot| {
                let guard = slot.borrow();
                guard.as_ref().and_then(|f| f(&url))
            });
            match text {
                Some(t) => Ok(JsValue::from(js_string!(t.as_str()))),
                None => Ok(JsValue::null()),
            }
        });
        ctx.register_global_builtin_callable(js_string!("__fetch_text"), 1, fetch_fn)
            .map_err(|e| e.to_string())?;

        let shim = include_str!("shim.js");
        ctx.eval(Source::from_bytes(shim))
            .map_err(|e| format!("兼容层失败: {e}"))?;
        ctx.eval(Source::from_bytes(source))
            .map_err(|e| format!("插件执行失败: {e}"))?;

        if ctx
            .global_object()
            .get(js_string!("__DEFINE"), &mut ctx)
            .map(|v| v.is_undefined())
            .unwrap_or(true)
        {
            return Err("插件没有调用 define({...})".into());
        }
        Ok(Self { ctx, meta })
    }

    pub fn meta(&self) -> &PluginMeta {
        &self.meta
    }

    /// 调钩子:参数和返回值都走 JSON 文本
    pub fn call(&mut self, hook: &str, arg_json: &str) -> Result<String, String> {
        // 用一段 JS 包一层:兼容 async 钩子,结果写回全局变量
        let script = format!(
            r#"
globalThis.__R = undefined; globalThis.__E = undefined;
(function () {{
  try {{
    var f = globalThis.__DEFINE["{hook}"];
    if (typeof f !== "function") {{ globalThis.__E = "没有实现 {hook}"; return; }}
    var arg = Object.assign({{}}, ctx, {arg_json});
    Promise.resolve(f.call(globalThis.__DEFINE, arg, arg)).then(
      function (v) {{ try {{ globalThis.__R = JSON.stringify(v); }} catch (e) {{ globalThis.__R = String(v); }} }},
      function (e) {{ globalThis.__E = e && e.message ? String(e.message) : String(e); }}
    );
  }} catch (e) {{ globalThis.__E = e && e.message ? String(e.message) : String(e); }}
}})();
"#
        );
        self.ctx
            .eval(Source::from_bytes(script.as_bytes()))
            .map_err(|e| format!("调用 {hook} 失败: {e}"))?;
        let _ = self.ctx.run_jobs();

        let err = self
            .ctx
            .global_object()
            .get(js_string!("__E"), &mut self.ctx)
            .map(|v| v.to_string(&mut self.ctx).map(|s| s.to_std_string_escaped()).unwrap_or_default())
            .unwrap_or_default();
        if err != "undefined" && !err.is_empty() {
            return Err(format!("{hook}: {err}"));
        }
        let out = self
            .ctx
            .global_object()
            .get(js_string!("__R"), &mut self.ctx)
            .map_err(|e| e.to_string())?;
        if out.is_undefined() {
            return Ok("null".to_string());
        }
        let text = out.to_string(&mut self.ctx).map(|s| s.to_std_string_escaped()).unwrap_or_default();
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLUGIN: &str = r#"
WeBox.define({
  id: "t", name: "测试插件", version: "0.1",
  filters: async (ctx) => {
    const txt = await ctx.http.get("https://x/flags");
    return { got: txt, n: txt ? txt.length : 0 };
  }
});
"#;

    #[test]
    fn runs_hook_and_calls_host() {
        let mut h = Host::load(PLUGIN, Box::new(|url| {
            assert_eq!(url, "https://x/flags", "插件传来的地址不对");
            Some("abcdef".to_string())
        }))
        .unwrap();
        assert_eq!(h.meta().name, "测试插件");
        let out = h.call("filters", "{}").unwrap();
        assert!(out.contains("abcdef"), "实际输出: {out}");
    }


    const HTML_PLUGIN: &str = r#"
WeBox.define({
  id: "html-test", name: "解析测试",
  list: async (ctx) => {
    const page = await ctx.html.load("https://x/list");
    const out = [];
    page.$("li a[href]").each(function (i, el) {
      const a = page.$(el);
      out.push({ title: a.text(), url: a.attr("href") });
    });
    return { count: out.length, first: out[0] };
  }
});
"#;

    const LIST_HTML: &str = r#"<html><body><ul>
<li><a href="/v/1">第一个</a></li>
<li><a href="/v/2">第二个</a></li>
</ul></body></html>"#;

    #[test]
    fn parses_html_and_selects() {
        let mut h = Host::load(HTML_PLUGIN, Box::new(|url| {
            assert_eq!(url, "https://x/list");
            Some(LIST_HTML.to_string())
        }))
        .unwrap();
        let out = h.call("list", "{}").unwrap();
        assert!(out.contains("/v/1"), "实际输出: {out}");
        assert!(out.contains("/v/1"), "实际输出: {out}");
    }

    #[test]
    fn rejects_plugin_without_define() {
        assert!(Host::load("const a = 1;", Box::new(|_| None)).is_err());
    }
}
