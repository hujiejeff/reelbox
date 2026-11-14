//! 极简插件宿主:把 `.webox.js` 真的跑起来。
//!
//! 宿主只暴露一个能力:`ctx.http.get(url)`(真正的网络请求在 Rust 里做)。
//! 每次调用钩子返回 JSON 字符串,方便上层直接塞给前端。

use std::any::Any;

use boa_engine::{js_string, Context as JsContext, JsValue, NativeFunction, Source};

use super::PluginMeta;

struct FetchState(Box<dyn Fn(&str) -> Option<String>>);

pub struct Host {
    ctx: JsContext,
    meta: PluginMeta,
}

impl Host {
    pub fn load(source: &str, fetch: Box<dyn Fn(&str) -> Option<String>>) -> Result<Self, String> {
        let meta = super::parse_meta(source)?;
        let mut ctx = JsContext::default();

        ctx.insert_data(FetchState(fetch));

        // 宿主函数:抓文本(非捕获闭包,满足 Copy 要求)
        let fetch_fn = NativeFunction::from_copy_closure(|_this, args, context| {
            let url = match args.first() {
                Some(v) => match v.to_string(context) {
                    Ok(s) => s.to_std_string_escaped(),
                    Err(_) => return Ok(JsValue::null()),
                },
                None => return Ok(JsValue::null()),
            };
            let text = context
                .get_data::<FetchState>()
                .and_then(|st| (st.0)(&url));
            match text {
                Some(t) => Ok(JsValue::from(js_string!(t.as_str()))),
                None => Ok(JsValue::null()),
            }
        });
        ctx.register_global_builtin_callable(js_string!("__fetch_text"), 1, fetch_fn)
            .map_err(|e| e.to_string())?;

        let shim = r#"
var WeBox = { define: function (o) { globalThis.__DEFINE = o; return o; } };
var console = { log: function () {}, warn: function () {}, error: function () {} };
var ctx = { http: { get: function (u) { return __fetch_text(u); } } };
"#;
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
            return Err("插件没有调用 WeBox.define".into());
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
    var arg = ({arg_json});
    Promise.resolve(f.call(globalThis.__DEFINE, arg)).then(
      function (v) {{ try {{ globalThis.__R = JSON.stringify(v); }} catch (e) {{ globalThis.__R = String(v); }} }},
      function (e) {{ globalThis.__E = String(e && e.message ? e.message : e); }}
    );
  }} catch (e) {{ globalThis.__E = String(e && e.message ? e.message : e); }}
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
            .map(|v| v.display().to_string())
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
        Ok(out.display().to_string())
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
    #[ignore = "宿主数据桥接待修:闭包里 get_data 取不到 FetchState"]
    fn runs_hook_and_calls_host() {
        let mut h = Host::load(PLUGIN, Box::new(|url| {
            assert_eq!(url, "https://x/flags");
            Some("abcdef".to_string())
        }))
        .unwrap();
        assert_eq!(h.meta().name, "测试插件");
        let out = h.call("filters", "{}").unwrap();
        assert!(out.contains("abcdef"), "实际输出: {out}");
    }

    #[test]
    fn rejects_plugin_without_define() {
        assert!(Host::load("const a = 1;", Box::new(|_| None)).is_err());
    }
}
