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
  // 只支持:tag / .cls / #id / tag.cls / tag[attr]
  var s = sel.trim();
  if (!s) return false;
  var attr = null;
  var br = s.indexOf("[");
  if (br >= 0) {
    var brEnd = s.indexOf("]", br);
    attr = s.slice(br + 1, brEnd).trim();
    s = s.slice(0, br) + s.slice(brEnd + 1);
  }
  var cls = null;
  var dot = s.indexOf(".");
  if (dot >= 0) {
    cls = s.slice(dot + 1).trim();
    s = s.slice(0, dot);
  }
  var id = null;
  var hash = s.indexOf("#");
  if (hash >= 0) {
    id = s.slice(hash + 1).trim();
    s = s.slice(0, hash);
  }
  var tag = s.trim().toLowerCase();
  if (tag && el.tag !== tag) return false;
  if (id && el.attrs.id !== id) return false;
  if (cls && (el.attrs["class"] || "").split(" ").indexOf(cls) < 0) return false;
  if (attr && el.attrs[attr] === undefined) return false;
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
      return wrap([list[i]]);
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

ctx.fail = function (code, msg) {
  var e = new Error(msg || code);
  e.code = code;
  throw e;
};

var ctx = {
  http: {
    get: function (u) {
      return __fetch_text(u);
    },
  },
  html: {
    load: function (u) {
      var body = __fetch_text(u);
      var html = body === null || body === undefined ? "" : String(body);
      return Promise.resolve(makePage(html, u));
    },
  },
  utils: {
    now: function () {
      return Date.now();
    },
  },
};
