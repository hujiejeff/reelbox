// 插件宿主(父页一侧):一个 sandbox iframe + postMessage 桥。
//
// 为什么要 iframe:
//   * 插件是不可信代码(第三方 js 文件),不能让它直接拿到 Tauri 的 invoke
//   * `sandbox="allow-scripts"` 且 **不加** `allow-same-origin` → iframe 变成
//     unique origin,读不到父页的 localStorage / cookie,也拿不到 __TAURI_INTERNALS__
//   * 插件要联网时只能 postMessage 求父页,由父页调 `plugin_fetch`(Rust 侧还会挡内网)
//
// 协议:
//   iframe → 父页  {id, kind:"http.get", url, headers}
//    父页  → iframe  {id, kind:"rpc.result", ok, data|error}
//   iframe → 父页  {kind:"ready"} / {kind:"log", msg}
//   父页  → iframe  {id, kind:"run", path, source, hook, arg}
//   iframe → 父页  {id, kind:"run.result", ok, data|error}

import { sandboxMain } from "./plugin-sandbox.js";

const TAG = "reelbox-plugin";

let frame = null;
let readyPromise = null;
let markReady = null;
let readyFlag = false;
let callSeq = 0;
let invokeFn = null;
let logFn = function () {};

const calls = new Map(); // 父页发起的钩子调用
const rpcs = new Map(); // 沙箱发起的宿主调用(http.get)

// 插件身份只在这个文件里认:界面上统一叫「插件」,不出现老品牌名。
// 但用户机器上的老配置和老插件文件还带着那个名字(kind 值、文件后缀、
// 源码里的入口前缀),所以这里照着认 —— 技术兼容留着,只是不拿给用户看。

/** 配置里插件源的老 kind 值(新写进去的也用这个,后端 Source.kind 认它) */
export const PLUGIN_KIND = "webox";

/**
 * 解析器插件的 kind。解析器不是源:它把"分享页 HTML"变成"可播地址",
 * 由播放链路按需调用(见 docs/PARSERS.md),不进源下拉、不设为当前源。
 */
export const PARSER_KIND = "parser";

/**
 * 引擎插件的 kind:插件本身只是一套爬取规则("怎么爬"),站点在源配置的
 * `options.config` 里("爬哪个站")。导入时没填配置地址就不建源,
 * 见 docs/ENGINE-PLUGINS.md。
 */
export const ENGINE_KIND = "engine";

/**
 * 适配器的 kind:一个 js 文件,把「某种源格式」翻译成列表 / 详情 / 播放
 * (契约见 docs/ARCHITECTURE.md 第 4 节)。**适配器不是源** —— 装的是文件,
 * 加源还得要一份配置地址,所以导入时只落盘、不建源、不设当前源。
 */
export const ADAPTER_KIND = "adapter";

/** 插件源码的入口:原生是 reelbox.define;老插件写的是另一个前缀,一并认 */
const DEFINE_RE = /(?:WeBox|reelbox)\.define\s*\(/;

/** 解析器源码的入口:reelbox.parser({...}) */
const PARSER_RE = /reelbox\.parser\s*\(/;

/** 适配器源码的入口:reelbox.adapter({...})(形状与 define 相同,只是 kind 不同) */
const ADAPTER_RE = /reelbox\.adapter\s*\(/;

/** 这段文本是不是插件源码(源插件 / 解析器 / 适配器都算) */
export function looksLikePluginSource(text) {
  const s = String(text == null ? "" : text);
  return DEFINE_RE.test(s) || PARSER_RE.test(s) || ADAPTER_RE.test(s);
}

/** 这段文本是不是解析器源码 */
export function looksLikeParserSource(text) {
  return PARSER_RE.test(String(text == null ? "" : text));
}

/** 这段文本是不是适配器源码(入口是 reelbox.adapter) */
export function looksLikeAdapterSource(text) {
  return ADAPTER_RE.test(String(text == null ? "" : text));
}

/** 类型值是不是插件(历史值 / 新写法 plugin / js) */
export function isPluginKind(kind) {
  const k = String(kind == null ? "" : kind).toLowerCase();
  return k === PLUGIN_KIND || k === "plugin" || k === "js";
}

/** 类型值是不是解析器 */
export function isParserKind(kind) {
  return String(kind == null ? "" : kind).toLowerCase() === PARSER_KIND;
}

/** 地址/路径是不是插件文件:插件就是 js 文件 */
function isPluginPath(url) {
  return /\.js$/i.test(String(url == null ? "" : url).split(/[?#]/)[0]);
}

/** 这个源是不是解析器(kind 或文件后缀任一命中) */
export function isParserSource(src) {
  if (!src) return false;
  if (isParserKind(src.kind || src.type)) return true;
  return /\.parser\.js$/i.test(String(src.url == null ? "" : src.url).split(/[?#]/)[0]);
}

/** 这个源是不是插件源(kind 或路径任一命中;解析器不算) */
export function isPluginSource(src) {
  if (!src) return false;
  if (isParserSource(src)) return false;
  return isPluginKind(src.kind || src.type) || isPluginPath(src.url);
}

/** 建宿主 iframe。app.js 在 init() 里调一次即可。 */
export function initPluginHost(opts) {
  const options = opts || {};
  if (options.invoke) invokeFn = options.invoke;
  if (options.log) logFn = options.log;
  if (frame) return readyPromise;
  if (!invokeFn) throw new Error("initPluginHost 需要 invoke");

  readyPromise = new Promise(function (resolve) {
    markReady = resolve;
  });

  const box = document.createElement("iframe");
  // 关键:属性值只给 allow-scripts,绝对不要加 allow-same-origin
  box.setAttribute("sandbox", "allow-scripts");
  box.setAttribute("aria-hidden", "true");
  box.setAttribute("tabindex", "-1");
  box.title = "plugin sandbox";
  box.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  const boot = "(" + sandboxMain.toString() + ")();";
  box.srcdoc =
    '<!doctype html><meta charset="utf-8"><body><script>' + boot + "<\/script>";
  window.addEventListener("message", onMessage);
  document.body.appendChild(box);
  frame = box;

  // 兜底:10 秒还没 ready 就别让界面一直转圈
  setTimeout(function () {
    if (!readyFlag) {
      readyFlag = true;
      logFn("sandbox: 没有收到 ready,继续尝试调用");
      if (markReady) { markReady(); markReady = null; }
    }
  }, 10000);

  return readyPromise;
}

function onMessage(ev) {
  if (!frame || ev.source !== frame.contentWindow) return;
  const d = ev.data;
  if (!d || d.__rb !== TAG) return;
  if (d.kind === "ready") {
    readyFlag = true;
    logFn("sandbox ready " + (d.probe ? JSON.stringify(d.probe) : ""));
    if (markReady) { markReady(); markReady = null; }
    return;
  }
  if (d.kind === "log") {
    logFn("sandbox| " + d.msg);
    return;
  }
  if (d.kind === "http.get") {
    handleHttp(d);
    return;
  }
  if (d.kind === "run.result") {
    const job = calls.get(d.id);
    if (!job) return;
    calls.delete(d.id);
    clearTimeout(job.timer);
    if (d.ok) job.resolve(d.data);
    else job.reject(new Error(d.error || "插件调用失败"));
    return;
  }
  if (d.kind === "rpc.result") {
    const job = rpcs.get(d.id);
    if (!job) return;
    rpcs.delete(d.id);
    clearTimeout(job.timer);
    if (d.ok) job.resolve(d.data);
    else job.reject(new Error(d.error || "宿主请求失败"));
  }
}

function postToSandbox(msg) {
  msg.__rb = TAG;
  if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, "*");
}

async function handleHttp(d) {
  const id = d.id;
  const reply = { kind: "rpc.result", id: id, ok: false, error: "" };
  try {
    const res = await invokeFn("plugin_fetch", {
      url: d.url,
      headers: d.headers || null,
    });
    reply.ok = true;
    reply.data = res;
  } catch (e) {
    reply.ok = false;
    reply.error = String(e && e.message ? e.message : e);
    logFn("http.get 失败 " + String(d.url).slice(0, 80) + " → " + reply.error);
  }
  postToSandbox(reply);
}

function timeoutFor(hook) {
  // 解析器的两个钩子都短:整条解析链最多 20 秒(ui/parser-chain.js 里另有总预算),
  // 单个解析器 10 秒 —— 卡住的站点不能把播放一直吊着。
  if (hook === "parse" || hook === "match") return 10000;
  return hook === "play" ? 60000 : 30000;
}

/**
 * 在沙箱里跑一个插件钩子。
 * @param {string} path 插件文件路径(同时做插件实例的缓存键)
 * @param {string} hook filters / list / search / detail / play,解析器是 match / parse
 * @param {object|string} arg 钩子参数;`match` 传页面地址(字符串)
 */
export async function callPlugin(path, hook, arg) {
  if (!frame) throw new Error("插件宿主还没初始化");
  await readyPromise;
  let source = sourceCache.get(path);
  if (!source) {
    source = await invokeFn("plugin_read", { path: path });
    sourceCache.set(path, source);
  }
  const id = "c" + (callSeq += 1);
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      calls.delete(id);
      reject(new Error("插件 " + hook + " 超时"));
    }, timeoutFor(hook));
    calls.set(id, { resolve: resolve, reject: reject, timer: timer });
    postToSandbox({ kind: "run", id: id, path: path, source: source, hook: hook, arg: arg || {} });
  });
}

const sourceCache = new Map();

/** 插件文件被重新导入后,丢掉旧源码缓存 */
export function forgetPlugin(path) {
  sourceCache.delete(path);
}
