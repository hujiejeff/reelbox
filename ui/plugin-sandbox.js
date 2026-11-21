// 插件真正运行的地方:sandbox iframe 内部的宿主桩。
//
// 这个文件里只有一个函数,parent 侧(ui/plugin-host.js)用
// `sandboxMain.toString()` 把它变成源码塞进 iframe 的 srcdoc。
// 所以它必须完全自包含:不能引用模块作用域里的任何东西。
//
// 提供的 ctx 契约与旧 boa 引擎一致(http / html / url / signal / settings / fail),
// 区别是 DOM 用浏览器原生 DOMParser + querySelectorAll,不用手写解析器。

export function sandboxMain() {
  const TAG = "reelbox-plugin";
  const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  // 这个 iframe 是 unique origin(没有 allow-same-origin),本来就碰不到父页的
  // localStorage 和 Tauri IPC。万一宿主把初始化脚本注进了子框架,先把入口删掉。
  // 这个 iframe 是 unique origin(没有 allow-same-origin),读不到父页的 localStorage。
  // 但 WebView2 的初始化脚本会注进**所有** frame,__TAURI_INTERNALS__ 可能就在这儿:
  // 先把宿主桥废掉再让插件跑。删不掉(不可配置)就改写对象里的入口。
  function blindHostBridge() {
    const deny = function () {
      throw new Error("sandbox: 宿主能力不可用");
    };
    try { delete window.__TAURI_INTERNALS__; } catch (e) {}
    try { delete window.__TAURI__; } catch (e) {}
    try { delete window.ipc; } catch (e) {}
    let bridge = null;
    try { bridge = window.__TAURI_INTERNALS__; } catch (e) {}
    if (bridge) {
      try {
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          value: undefined, writable: false, configurable: false,
        });
      } catch (e) {}
      try { bridge = window.__TAURI_INTERNALS__; } catch (e) { bridge = null; }
    }
    if (bridge) {
      ["invoke", "postMessage", "transformCallback", "callbacks", "metadata", "convertFileSrc"].forEach(function (k) {
        try { bridge[k] = deny; } catch (e) {}
        try { Object.defineProperty(bridge, k, { value: deny, writable: false, configurable: false }); } catch (e) {}
      });
    }
    // WebView2 的原始通道:插件直接 postMessage 也能绕
    try {
      if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage = deny;
    } catch (e) {}
  }
  blindHostBridge();

  const rpcPending = new Map();
  let rpcSeq = 0;

  function post(msg) {
    msg.__rb = TAG;
    parent.postMessage(msg, "*");
  }

  function rpc(kind, payload) {
    const id = ++rpcSeq;
    return new Promise(function (resolve, reject) {
      rpcPending.set(id, { resolve: resolve, reject: reject });
      post(Object.assign({ id: id, kind: kind }, payload));
    });
  }

  function note(text) {
    post({ kind: "log", msg: String(text) });
  }

  /* ---------- 二进制 ---------- */

  function bytesFromBase64(value) {
    const clean = String(value).replace(/[^A-Za-z0-9+/=]/g, "");
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function base64FromText(text) {
    const bytes = new TextEncoder().encode(String(text));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* ---------- 迷你 jQuery(底层是原生 querySelectorAll) ---------- */

  function trimText(s) {
    return String(s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
  }

  /* ---------- XPath(浏览器原生 document.evaluate) ---------- */

  // 属性节点在 XPath 里也是节点("//a/@href"),但插件要的是它的值:
  // 统一换成字符串,于是属性表达式给出字符串数组,节点集还是节点数组。
  function xpathItem(item) {
    if (item && item.nodeType === 2) {
      return String(item.nodeValue == null ? "" : item.nodeValue);
    }
    return item;
  }

  /**
   * 求一条 XPath,返回数组:
   *   节点集 → DOM 节点数组(属性节点换成它的字符串值)
   *   字符串 / 数字 / 布尔 → 单元素数组
   *
   * 求值失败(表达式写错、上下文节点不对)抛一个带表达式的错误 ——
   * 插件作者看到的第一句话就是哪条 XPath 坏了。
   */
  function xpathEval(expr, contextNode) {
    const text = String(expr == null ? "" : expr).trim();
    if (!text) return [];
    const node = contextNode && contextNode.nodeType ? contextNode : document;
    // document.evaluate 是 Document 上的方法;节点来自 DOMParser 的那份文档时
    // 要用那份文档的 evaluate(上下文节点必须属于求值器所在的文档)
    const owner = node.ownerDocument || node;
    const evaluator = owner && typeof owner.evaluate === "function" ? owner : document;
    let result;
    try {
      result = evaluator.evaluate(
        text,
        node,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
    } catch (e) {
      const err = new Error('xpath 求值失败("' + text + '"): ' + ((e && e.message) || e));
      err.expr = text;
      throw err;
    }
    if (result.resultType === XPathResult.STRING_TYPE) return [String(result.stringValue)];
    if (result.resultType === XPathResult.NUMBER_TYPE) return [result.numberValue];
    if (result.resultType === XPathResult.BOOLEAN_TYPE) return [result.booleanValue];
    const out = [];
    const n = typeof result.snapshotLength === "number" ? result.snapshotLength : 0;
    for (let i = 0; i < n; i += 1) out.push(xpathItem(result.snapshotItem(i)));
    return out;
  }

  function wrapAll(list, doc) {
    const api = {
      length: list.length,
      doc: doc || null,
      each: function (fn) {
        for (let i = 0; i < list.length; i += 1) {
          if (fn.call(list[i], i, list[i]) === false) break;
        }
        return api;
      },
      map: function (fn) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const r = fn.call(list[i], i, list[i]);
          if (r === null || r === undefined) continue;
          if (Array.isArray(r)) out.push.apply(out, r);
          else out.push(r);
        }
        return wrapAll(out, doc);
      },
      get: function (i) {
        return i === undefined ? list.slice() : list[i];
      },
      eq: function (i) {
        const j = i < 0 ? list.length + i : i;
        return wrapAll(j >= 0 && j < list.length ? [list[j]] : [], doc);
      },
      first: function () {
        return wrapAll(list.length ? [list[0]] : [], doc);
      },
      last: function () {
        return wrapAll(list.length ? [list[list.length - 1]] : [], doc);
      },
      find: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const el = list[i];
          if (!el || typeof el.querySelectorAll !== "function") continue;
          let hits;
          try { hits = el.querySelectorAll(sel); } catch (e) { continue; }
          for (let k = 0; k < hits.length; k += 1) {
            if (out.indexOf(hits[k]) < 0) out.push(hits[k]);
          }
        }
        return wrapAll(out, doc);
      },
      filter: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const el = list[i];
          let keep;
          if (typeof sel === "function") keep = !!sel.call(el, i, el);
          else if (typeof sel === "string") keep = !!(el && el.matches && el.matches(sel));
          else keep = false;
          if (keep) out.push(el);
        }
        return wrapAll(out, doc);
      },
      not: function (sel) {
        return wrapAll(list.filter(function (el, i) {
          if (typeof sel === "function") return !sel.call(el, i, el);
          return !(el && el.matches && el.matches(String(sel)));
        }), doc);
      },
      is: function (sel) {
        for (let i = 0; i < list.length; i += 1) {
          if (typeof sel === "function") { if (sel.call(list[i], i, list[i])) return true; }
          else if (list[i] && list[i].matches && list[i].matches(String(sel))) return true;
        }
        return false;
      },
      closest: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          let node = list[i];
          while (node && node.nodeType === 1) {
            if (node.matches && node.matches(sel)) {
              if (out.indexOf(node) < 0) out.push(node);
              break;
            }
            node = node.parentElement;
          }
        }
        return wrapAll(out, doc);
      },
      parent: function () {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const p = list[i] && list[i].parentElement;
          if (p && out.indexOf(p) < 0) out.push(p);
        }
        return wrapAll(out, doc);
      },
      children: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const kids = list[i] ? list[i].children : null;
          if (!kids) continue;
          for (let k = 0; k < kids.length; k += 1) {
            if (!sel || (kids[k].matches && kids[k].matches(sel))) out.push(kids[k]);
          }
        }
        return wrapAll(out, doc);
      },
      prev: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          let n = list[i] && list[i].previousElementSibling;
          while (n && sel && !(n.matches && n.matches(sel))) n = n.previousElementSibling;
          if (n) out.push(n);
        }
        return wrapAll(out, doc);
      },
      next: function (sel) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          let n = list[i] && list[i].nextElementSibling;
          while (n && sel && !(n.matches && n.matches(sel))) n = n.nextElementSibling;
          if (n) out.push(n);
        }
        return wrapAll(out, doc);
      },
      text: function () {
        let s = "";
        for (let i = 0; i < list.length; i += 1) {
          const el = list[i];
          s += el ? String(el.textContent == null ? "" : el.textContent) : "";
        }
        return trimText(s);
      },
      html: function () {
        return list.length && list[0] ? String(list[0].innerHTML) : "";
      },
      val: function () {
        return list.length && list[0] ? list[0].value : undefined;
      },
      attr: function (name) {
        if (!list.length || !list[0] || typeof list[0].getAttribute !== "function") return undefined;
        const v = list[0].getAttribute(name);
        return v === null ? undefined : v;
      },
      data: function (name) {
        if (!list.length || !list[0] || typeof list[0].getAttribute !== "function") return undefined;
        const v = list[0].getAttribute("data-" + name);
        return v === null ? undefined : v;
      },
      // 相对求值:每个节点各求一次,结果按顺序拼起来。
      // 注意 XPath 的 "//x" 是"从文档根开始",按节点求值要用 ".//x",
      // 插件里那层转换见 examples/…/relativeXPath;这里只认表达式。
      xpath: function (expr) {
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
          const hits = xpathEval(expr, list[i]);
          for (let k = 0; k < hits.length; k += 1) out.push(hits[k]);
        }
        return out;
      },
    };
    api[0] = list[0];
    return api;
  }

  function makePage(html, url) {
    const text = html === undefined || html === null ? "" : String(html);
    const doc = new DOMParser().parseFromString(text, "text/html");
    function q(sel) {
      if (sel === undefined || sel === null) return wrapAll([], doc);
      if (typeof sel !== "string") {
        if (sel.nodeType === 1 || sel.nodeType === 9) return wrapAll([sel], doc);
        const arr = Array.prototype.slice.call(sel).filter(function (n) {
          return n && n.nodeType === 1;
        });
        return wrapAll(arr, doc);
      }
      let hits;
      try { hits = doc.querySelectorAll(sel); } catch (e) { return wrapAll([], doc); }
      return wrapAll(Array.prototype.slice.call(hits), doc);
    }
    q.$ = q;
    q.url = url || "";
    q.html = text;
    q.doc = doc;
    // 整篇文档求值:"//ul//li" 这种从根开始的写法直接可用
    q.xpath = function (expr) {
      return xpathEval(expr, doc);
    };
    return q;
  }

  /* ---------- 请求 ---------- */

  function withQuery(url, query) {
    const base = String(url == null ? "" : url);
    if (!query) return base;
    const parts = [];
    Object.keys(query).forEach(function (k) {
      const v = query[k];
      if (v === undefined || v === null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
    if (!parts.length) return base;
    return base + (base.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
  }

  async function httpGet(input, opts) {
    const o = opts || {};
    const url = withQuery(String(input == null ? "" : input), o.query);
    const headers = Object.assign({}, o.headers || {});
    const hasUa = Object.keys(headers).some(function (k) {
      return k.toLowerCase() === "user-agent";
    });
    if (!hasUa) headers["User-Agent"] = DEFAULT_UA;
    const res = await rpc("http.get", { url: url, headers: headers });
    const body = res && res.body !== undefined && res.body !== null ? String(res.body) : "";
    const out = new String(body);
    out.status = res && res.status ? res.status : 0;
    out.data = o.responseType === "base64" ? base64FromText(body) : body;
    out.url = (res && res.url) || url;
    out.headers = (res && res.headers) || {};
    out.mime = (res && res.mime) || "";
    return out;
  }

  /* ---------- wasm 计算 ---------- */

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("compute.run 超时(" + ms + "ms)"));
      }, ms);
      promise.then(
        function (v) { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
        function (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
      );
    });
  }

  function elementStub() {
    const doc = {
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
    };
    return { document: doc, getElementById: function () { return null; }, querySelector: function () { return null; } };
  }

  async function computeRun(req) {
    const r = req || {};
    const code = String(r.code == null ? "" : r.code);
    if (!code.trim()) throw new Error("compute.run 需要 code");
    const binaries = Object.assign({}, r.binaries || {});
    // 宿主传进来的 wasm 是 base64:先还原成字节,WebAssembly.instantiate 才认
    if (typeof binaries.module === "string") binaries.module = bytesFromBase64(binaries.module);
    const scope = {
      module: binaries.module,
      binaries: binaries,
      input: r.input === undefined ? null : r.input,
      document: elementStub(),
      window: { document: elementStub() },
      console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} },
    };
    // 插件给的是整段函数源码(kvmBuildRequest.toString()),按 (input, binaries) 调它
    const named = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(code);
    const tail = named ? "\n;return await " + named[1] + "(input, binaries);" : "";
    const params = Object.keys(scope);
    const factory = new Function(params.join(","), "return (async function () {\n" + code + tail + "\n})()");
    const running = Promise.resolve(factory.apply(null, params.map(function (k) { return scope[k]; })));
    const ms = Number(r.timeoutMs) > 0 ? Number(r.timeoutMs) : 20000;
    return await withTimeout(running, ms);
  }

  /* ---------- ctx ---------- */

  function defaultSettings(def) {
    const out = {};
    const fields = def && def.settings && def.settings.fields;
    if (Array.isArray(fields)) {
      for (const f of fields) {
        if (!f || !f.key) continue;
        out[f.key] = f.default === undefined ? "" : f.default;
      }
    }
    return out;
  }

  function makeCtx(def) {
    const ctx = {
      http: { get: httpGet, post: httpGet },
      html: {
        // 传 HTML 文本 → 直接返回可调用的 $;传 URL → 返回 Promise(用 await 接)
        load: function (input) {
          const raw = input === undefined || input === null ? "" : String(input);
          const looksUrl = /^https?:\/\//i.test(raw.trim()) && raw.indexOf("<") < 0;
          if (!looksUrl) return makePage(raw, "");
          return httpGet(raw).then(function (res) {
            return makePage(String(res.data || ""), String(res.url || raw));
          });
        },
      },
      url: {
        resolve: function (raw, base) {
          if (raw === undefined || raw === null) return "";
          try {
            return new URL(String(raw), base || undefined).href;
          } catch (e) {
            return String(raw);
          }
        },
        origin: function (u) {
          try { return new URL(String(u)).origin; } catch (e) { return ""; }
        },
      },
      utils: {
        now: function () { return Date.now(); },
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      },
      signal: {
        aborted: false,
        throwIfAborted: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
      },
      settings: defaultSettings(def),
      compute: { run: computeRun },
      log: function () {
        note(Array.prototype.map.call(arguments, String).join(" "));
      },
    };
    ctx.fail = function (code, msg) {
      const e = new Error(msg || code || "插件失败");
      e.code = code || "FAILED";
      throw e;
    };
    return ctx;
  }

  /* ---------- 插件加载与执行 ---------- */

  const plugins = new Map(); // path -> { def, ctx }

  function compile(source) {
    // 插件的 define() 把对象写到 host.captured 上,函数体最后一行把它交出来。
    // parser() 是解析器插件的入口,交出的是同一形状的对象(match / parse 钩子)。
    const host = {
      captured: null,
      define: function (o) {
        host.captured = o;
        return o;
      },
      parser: function (o) {
        host.captured = o;
        return o;
      },
    };
    const quiet = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} };
    // 整份插件源码塞进一个函数体里跑一次:顶层的 const/function 留在闭包里,
    // 钩子函数挂住这个闭包,所以常量、辅助函数都还能用。
    // 第二个形参名不能改:老插件源码里写的就是那个前缀的 define(...),
    // 它在用户机器上运行,跟界面上叫什么是两回事。
    const factory = new Function(
      "__host",
      "WeBox",
      "reelbox",
      "console",
      String(source) + "\n;return __host.captured;"
    );
    const def = factory(host, host, host, quiet);
    if (!def || typeof def !== "object") {
      throw new Error("插件没有调用 reelbox.define({...}) 或 reelbox.parser({...})");
    }
    return def;
  }

  function pluginFor(path, source) {
    const hit = plugins.get(path);
    if (hit) return hit;
    const def = compile(source);
    const entry = { def: def, ctx: makeCtx(def) };
    plugins.set(path, entry);
    return entry;
  }

  function describeError(e) {
    if (!e) return "未知错误";
    const code = e.code ? String(e.code) + ": " : "";
    const msg = e.message ? String(e.message) : String(e);
    return code + msg;
  }

  function cloneable(v) {
    if (v === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return null;
    }
  }

  /* ---------- 解析器:match ---------- */

  /**
   * match 的各种写法都收:boolean、正则、正则源码字符串、数组(任一命中就算)。
   * 写成数组时每一项可以是 `/dytt/i` 这种正则,也可以是 "dytt" 这种子串。
   */
  function matchValue(v, url) {
    if (v === undefined || v === null) return true; // 没写就是不挑页面
    if (typeof v === "boolean") return v;
    if (v instanceof RegExp) return v.test(url);
    if (typeof v === "string") {
      const s = v.trim();
      const m = /^\/(.*)\/([a-z]*)$/.exec(s);
      if (m) {
        try { return new RegExp(m[1], m[2]).test(url); } catch (e) { /* 当子串处理 */ }
      }
      return s ? url.indexOf(s) >= 0 : true;
    }
    if (Array.isArray(v)) return v.some(function (x) { return matchValue(x, url); });
    return !!v;
  }

  /**
   * 解析器的 match 钩子:契约是 `match(url)`,只吃一个参数(页面地址)。
   * 可以没有(视为都匹配),也可以是函数或不带函数的正则/数组。
   */
  async function runMatch(entry, raw) {
    const url = typeof raw === "string" ? raw : String((raw && raw.url) || "");
    const spec = entry.def.match;
    if (spec === undefined || spec === null) return true;
    if (typeof spec !== "function") return matchValue(spec, url);
    return matchValue(await spec.call(entry.def, url), url);
  }

  async function runHook(d) {
    const reply = { kind: "run.result", id: d.id, ok: false, error: "" };
    try {
      const entry = pluginFor(d.path, d.source);
      let out;
      if (d.hook === "match") {
        out = await runMatch(entry, d.arg);
      } else {
        const fn = entry.def[d.hook];
        if (typeof fn !== "function") throw new Error("插件没有实现 " + d.hook + " 钩子");
        const arg = d.arg && typeof d.arg === "object" ? d.arg : {};
        out = await fn.call(entry.def, entry.ctx, arg);
      }
      reply.ok = true;
      reply.data = cloneable(out);
      reply.error = "";
    } catch (e) {
      reply.ok = false;
      reply.error = describeError(e);
      note(d.hook + " 失败: " + reply.error);
    }
    post(reply);
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== parent) return;
    const d = ev.data;
    if (!d || d.__rb !== TAG) return;
    if (d.kind === "rpc.result") {
      const waiter = rpcPending.get(d.id);
      if (!waiter) return;
      rpcPending.delete(d.id);
      if (d.ok) waiter.resolve(d.data);
      else waiter.reject(new Error(d.error || "宿主请求失败"));
      return;
    }
    if (d.kind === "run") runHook(d);
  });

  // ready 报文里带上实测结果:沙箱到底封没封住(自检和文档都靠它)
  (async function () {
    const probe = probeSandbox();
    // 真的调一次不存在的命令:能调到就说明宿主桥还活着
    try {
      const bridge = window.__TAURI_INTERNALS__;
      if (bridge && typeof bridge.invoke === "function") {
        await Promise.race([
          bridge.invoke("__rb_probe_should_not_exist__", {}),
          new Promise(function (r) { setTimeout(function () { r("timeout"); }, 1500); }),
        ]);
        probe.ipcReachable = "yes";
      } else {
        probe.ipcReachable = "no";
      }
    } catch (e) {
      probe.ipcReachable = "blocked:" + ((e && (e.name || e.message)) || "Error");
    }
    post({ kind: "ready", probe: probe });
  })();

  /** 自检用:把"沙箱到底有多封"的实测结果带出去 */
  function probeSandbox() {
    function probe(fn) {
      try {
        fn();
        return "ok";
      } catch (e) {
        return "blocked:" + ((e && e.name) || "Error");
      }
    }
    return {
      tauriIpc: typeof window.__TAURI_INTERNALS__,
      tauriGlobal: typeof window.__TAURI__,
      ipcInvoke: (function () { try { return typeof window.__TAURI_INTERNALS__.invoke; } catch (e) { return "err"; } })(),
      parentDoc: probe(function () {
        if (parent.document) throw new Error("parent.document 竟然可读");
      }),
      storage: probe(function () {
        localStorage.getItem("reelbox.debug");
      }),
      origin: String((function () { try { return window.origin; } catch (e) { return "blocked"; } })()),
    };
  }
}
