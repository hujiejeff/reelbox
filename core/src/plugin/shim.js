// 沙箱里的兼容层:WeBox / console / ctx。
// ctx.html.load(url) 用一个极简 DOM 实现,支持 $(sel) / text() / attr() / each()。

// 原生契约别名:reelbox.define 与 WeBox.define 等价
var reelbox = { define: function (o) { globalThis.__DEFINE = o; return o; } };
var WeBox = {
  define: function (o) {
    globalThis.__DEFINE = o;
    return o;
  },
};

var console = {
  log: function () {},
  warn: function () {},
  error: function () {},
};

/* ---------- 极简 DOM ---------- */
function makeEl(tag, attrs) {
  return { tag: tag, attrs: attrs || {}, children: [], text: "" };
}

function parseHTML(html) {
  var root = makeEl("#root", {});
  var stack = [root];
  var i = 0;
  function top() {
    return stack[stack.length - 1];
  }
  while (i < html.length) {
    var lt = html.indexOf("<", i);
    if (lt < 0) {
      top().text += html.slice(i);
      break;
    }
    if (lt > i) top().text += html.slice(i, lt);
    var gt = html.indexOf(">", lt);
    if (gt < 0) break;
    var raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.charAt(0) === "!") continue;
    if (raw.charAt(0) === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    var selfClose = raw.charAt(raw.length - 1) === "/";
    if (selfClose) raw = raw.slice(0, -1);
    var name = raw;
    var sp = raw.indexOf(" ");
    if (sp > 0) name = raw.slice(0, sp);
    var attrs = {};
    var rest = raw.slice(name.length);
    var k = 0;
    while (k < rest.length) {
      while (k < rest.length && (rest.charAt(k) === " " || rest.charAt(k) === "\n" || rest.charAt(k) === "\t")) k++;
      var eq = rest.indexOf("=", k);
      if (eq < 0) break;
      var key = rest.slice(k, eq).trim();
      var q = rest.charAt(eq + 1);
      var val = "";
      var endq = eq + 1;
      if (q === '"' || q === "'") {
        endq = rest.indexOf(q, eq + 2);
        if (endq < 0) endq = rest.length;
        val = rest.slice(eq + 2, endq);
        k = endq + 1;
      } else {
        endq = eq + 1;
        while (endq < rest.length && rest.charAt(endq) !== " " && rest.charAt(endq) !== "\n" && rest.charAt(endq) !== "\t") endq++;
        val = rest.slice(eq + 1, endq);
        k = endq;
      }
      if (key) attrs[key] = val;
    }
    var el = makeEl(name.toLowerCase(), attrs);
    el.parent = top();
    top().children.push(el);
    if (!selfClose && name !== "br" && name !== "img" && name !== "meta" && name !== "link" && name !== "input") stack.push(el);
  }
  return root;
}

function allText(el) {
  var s = el.text || "";
  for (var i = 0; i < el.children.length; i++) s += " " + allText(el.children[i]);
  return s;
}

function matches(el, sel) {
  if (!el || !el.tag) return false;
  var s = String(sel).trim();
  if (!s) return false;
  if (s === "*") return true;
  // 先把所有 [attr] / [attr=value] 摘出来
  var attrs = [], out = "", i = 0;
  while (i < s.length) {
    var c = s.charAt(i);
    if (c === "[") {
      var e = s.indexOf("]", i);
      if (e < 0) break;
      var body = s.slice(i + 1, e).trim();
      var eq = body.indexOf("=");
      if (eq < 0) {
        attrs.push({ k: body, v: null });
      } else {
        var kk = body.slice(0, eq).trim();
        var vv = body.slice(eq + 1).trim();
        if ((vv.charAt(0) === '"' && vv.charAt(vv.length - 1) === '"') ||
            (vv.charAt(0) === "'" && vv.charAt(vv.length - 1) === "'")) {
          vv = vv.slice(1, -1);
        }
        attrs.push({ k: kk, v: vv });
      }
      i = e + 1;
    } else {
      out += c;
      i++;
    }
  }
  var tag = "", classes = [], id = null, buf = "", kind = "tag";
  function flush() {
    if (!buf) return;
    if (kind === "cls") classes.push(buf);
    else if (kind === "id") id = buf;
    else tag = buf.toLowerCase();
    buf = "";
  }
  for (var j = 0; j < out.length; j++) {
    var ch = out.charAt(j);
    if (ch === "." || ch === "#") {
      flush();
      kind = ch === "." ? "cls" : "id";
    } else if (ch !== " " && ch !== "\n" && ch !== "\t") {
      buf += ch;
    }
  }
  flush();
  if (tag && tag !== "*" && el.tag !== tag) return false;
  if (id && el.attrs.id !== id) return false;
  if (classes.length) {
    var have = String(el.attrs["class"] || "").split(" ");
    for (var m = 0; m < classes.length; m++) {
      if (have.indexOf(classes[m]) < 0) return false;
    }
  }
  for (var n = 0; n < attrs.length; n++) {
    var v = el.attrs[attrs[n].k];
    if (v === undefined) return false;
    if (attrs[n].v !== null && String(v) !== attrs[n].v) return false;
  }
  return true;
}

function collect(el, sel, out) {
  for (var i = 0; i < el.children.length; i++) {
    var c = el.children[i];
    if (matches(c, sel)) out.push(c);
    collect(c, sel, out);
  }
  return out;
}

function selectAll(root, sel) {
  var parts = [];
  var raw = sel.trim().split(" ");
  for (var i = 0; i < raw.length; i++) if (raw[i]) parts.push(raw[i]);
  if (!parts.length) return [];
  var current = [root];
  for (var p = 0; p < parts.length; p++) {
    var next = [];
    for (var c = 0; c < current.length; c++) {
      var hits = collect(current[c], parts[p], []);
      for (var h = 0; h < hits.length; h++) {
        if (next.indexOf(hits[h]) < 0) next.push(hits[h]);
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current;
}

function wrap(list) {
  var api = {
    length: list.length,
    each: function (fn) {
      for (var i = 0; i < list.length; i++) fn(i, list[i]);
      return api;
    },
    text: function () {
      return list.length ? allText(list[0]).replace(/[ \t\r\n]+/g, " ").trim() : "";
    },
    attr: function (n) {
      return list.length ? list[0].attrs[n] : undefined;
    },
    html: function () {
      return list.length ? allText(list[0]) : "";
    },
    eq: function (i) {
      return wrap(list[i] ? [list[i]] : []);
    },
    find: function (sel) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var hits = selectAll(list[i], sel);
        for (var h = 0; h < hits.length; h++) if (out.indexOf(hits[h]) < 0) out.push(hits[h]);
      }
      return wrap(out);
    },
    closest: function (sel) {
      var node = list[0];
      while (node && node.tag !== "#root") {
        if (matches(node, sel)) return wrap([node]);
        node = node.parent;
      }
      return wrap([]);
    },
    is: function (sel) {
      return !!(list[0] && matches(list[0], sel));
    },
    first: function () {
      return wrap(list.length ? [list[0]] : []);
    },
    last: function () {
      return wrap(list.length ? [list[list.length - 1]] : []);
    },
    parent: function () {
      var p = list[0] && list[0].parent;
      return wrap(p ? [p] : []);
    },
    children: function () {
      return wrap(list[0] ? list[0].children.slice() : []);
    },
    map: function (fn) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var r = fn(i, list[i]);
        if (r === null || r === undefined) continue;
        if (r instanceof Array) {
          for (var k = 0; k < r.length; k++) out.push(r[k]);
        } else {
          out.push(r);
        }
      }
      return wrap(out);
    },
    get: function (i) {
      return i === undefined ? list.slice() : list[i];
    },
  };
  api[0] = list[0];
  return api;
}

function makePage(html, url) {
  var root = parseHTML(html);
  function $(sel) {
    if (typeof sel !== "string") return wrap([sel]);
    return wrap(selectAll(root, sel));
  }
  return { $: $, url: url, html: html };
}



function __withQuery(u, query) {
  var s = String(u || "");
  if (!query) return s;
  var parts = [];
  for (var k in query) {
    if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
    if (query[k] === undefined || query[k] === null || query[k] === "") continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(query[k])));
  }
  if (!parts.length) return s;
  return s + (s.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
}

// URL 工具:boa 没有全局 URL,手写一个够用的
function __urlResolve(raw, base) {
  if (raw === null || raw === undefined) return "";
  var s = String(raw);
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(s)) return s;
  var b = String(base || "");
  var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)?\/\/([^\/?#]+)([^?#]*)/.exec(b);
  if (!m) return s;
  var scheme = m[1] || "https:";
  var host = m[2];
  if (s.indexOf("//") === 0) return scheme + s;
  if (s.charAt(0) === "/") return scheme + "//" + host + s;
  var path = m[3] || "/";
  var dir = path.replace(/[^\/]*$/, "");
  return scheme + "//" + host + dir + s;
}
function __urlOrigin(u) {
  var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)?\/\/([^\/?#]+)/.exec(String(u || ""));
  if (!m) return "";
  return (m[1] || "https:") + "//" + m[2];
}

var ctx = {
  http: {
    // 返回 String 对象(可以当字符串用),同时带 status / data / url,两种插件都兼容
    get: function (u, opts) {
      var url = __withQuery(u, opts && opts.query);
      var text = __fetch_text(url);
      if (text === null || text === undefined) {
        throw new Error("请求失败: " + url);
      }
      var body = String(text);
      var res = new String(body);
      res.status = 200;
      res.url = url;
      res.data = body;
      res.headers = {};
      return res;
    },
  },
  html: {
    // 传 HTML 文本就直接解析,传 URL 就去抓;返回的 $ 可以当函数调用
    load: function (input) {
      var raw = input === undefined || input === null ? "" : String(input);
      var html = raw, url = "";
      if (raw.indexOf("<") < 0) {
        url = __withQuery(raw, null);
        var body = __fetch_text(url);
        html = body === null || body === undefined ? "" : String(body);
      }
      var page = makePage(html, url);
      var $ = page.$;
      $.$ = $;
      $.url = url;
      $.html = html;
      return $;
    },
  },
  utils: {
    now: function () {
      return Date.now();
    },
  },
  // 插件常用的 URL 工具
  url: {
    resolve: function (raw, base) {
      return __urlResolve(raw, base);
    },
    origin: function (u) {
      return __urlOrigin(u);
    },
  },
  // 宿主没有取消机制,给个空实现,别让插件崩
  signal: {
    aborted: false,
    throwIfAborted: function () {},
    addEventListener: function () {},
    removeEventListener: function () {},
  },
  // 插件设置:暂不支持自定义,先给空对象
  settings: {},
};

// 分类错误:network / parse / auth / unsupported
ctx.fail = function (code, msg) {
  var e = new Error(msg || code);
  e.code = code;
  throw e;
};
