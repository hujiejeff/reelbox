// 解析器链路的单元测试:node --test ui/parser-chain.test.mjs
// 这里只喂注入的假插件,不碰 DOM / tauri —— 正是抽到 parser-chain.js 的目的。

import test from "node:test";
import assert from "node:assert/strict";

import {
  PARSER_ONE_MS,
  PARSER_TOTAL_MS,
  parserMime,
  parserStreamsOf,
  runParserChain,
  withTimeout,
} from "./parser-chain.js";

const PAGE = "https://site.example/share/123";
const A = "https://cdn.example/a.m3u8";
const B = "https://cdn.example/b.m3u8";
const C = "https://cdn.example/c.m3u8";
const HANG = () => new Promise(() => {});

/**
 * 造一队解析器,并记录每个钩子被调了几次 / 白名单收到什么。
 * spec: [{ name?, match?, parse? }] —— match 可以是布尔,parse 可以是返回值。
 */
function harness(spec) {
  const calls = spec.map(() => ({ match: 0, parse: 0 }));
  const parsers = spec.map((s, i) => ({ name: s.name || "p" + i, url: "/p" + i + ".js" }));
  const allowed = [];
  const logs = [];
  const statuses = [];
  const call = async (path, hook, arg) => {
    const i = Number(String(path).match(/p(\d+)\.js$/)[1]);
    calls[i][hook] += 1;
    const s = spec[i];
    const v = s[hook];
    if (typeof v === "function") return await v(arg);
    return v;
  };
  return {
    parsers,
    calls,
    allowed,
    logs,
    statuses,
    call,
    allow: async (urls) => { allowed.push(urls); },
    log: (...a) => logs.push(a.map(String).join(" ")),
    status: (m) => statuses.push(m),
  };
}

/** 默认全注入:每页存活、无额外请求头、预算用默认值 */
function run(h, extra) {
  return runParserChain(Object.assign({
    parsers: h.parsers,
    pageUrl: PAGE,
    headers: {},
    call: h.call,
    allow: h.allow,
    isAlive: () => true,
    status: h.status,
    log: h.log,
  }, extra || {}));
}

test("1. match 返回 false 的解析器被跳过,用下一个", async () => {
  const h = harness([
    { name: "不认这站", match: () => false, parse: () => ({ url: A }) },
    { name: "认", match: () => true, parse: () => ({ url: B }) },
  ]);
  const out = await run(h);
  assert.equal(out.url, B);
  assert.equal(h.calls[0].parse, 0, "match=false 就不该再问 parse");
  assert.equal(h.calls[1].parse, 1);
  assert.ok(h.logs.some((l) => l.includes("parser skip") && l.includes("不认这站")));
});

test("1b. match 抛错也算不中,继续问下一个", async () => {
  const h = harness([
    { name: "报错", match: () => { throw new Error("boom"); }, parse: () => ({ url: A }) },
    { name: "认", match: () => true, parse: () => ({ url: B }) },
  ]);
  const out = await run(h);
  assert.equal(out.url, B);
  assert.equal(h.calls[0].parse, 0);
  assert.ok(h.logs.some((l) => l.includes("parser fail") && l.includes("boom")));
});

test("2. 第一个成功即止:后面的解析器一次都不调", async () => {
  const h = harness([
    { name: "一号", match: () => true, parse: () => ({ url: A }) },
    { name: "二号", match: () => true, parse: () => ({ url: B }) },
    { name: "三号", match: () => true, parse: () => ({ url: C }) },
  ]);
  const out = await run(h);
  assert.equal(out.url, A);
  assert.deepEqual(h.calls[0], { match: 1, parse: 1 });
  assert.deepEqual(h.calls[1], { match: 0, parse: 0 });
  assert.deepEqual(h.calls[2], { match: 0, parse: 0 }, "第三个解析器的 call 计数必须为 0");
});

test("3. 全部失败返回 null,且 allow 一次都没被调用", async () => {
  const h = harness([
    { name: "不认", match: () => false, parse: () => ({ url: A }) },
    { name: "空手", match: () => true, parse: () => ({ streams: [] }) },
    { name: "抛错", match: () => true, parse: () => { throw new Error("parse 失败"); } },
    { name: "怪地址", match: () => true, parse: () => ({ url: "ftp://nope/x.m3u8" }) },
  ]);
  const out = await run(h);
  assert.equal(out, null);
  assert.equal(h.allowed.length, 0);
  assert.ok(h.logs.some((l) => l.includes("全部失败")));
});

test("4. 单个解析器超时只跳过它,后面的照常成功", async () => {
  const h = harness([
    { name: "卡住", match: () => true, parse: HANG },
    { name: "正常", match: () => true, parse: () => ({ url: B }) },
  ]);
  const out = await run(h, { oneBudget: 20 });
  assert.equal(out.url, B);
  assert.equal(h.calls[0].parse, 1);
  assert.equal(h.calls[1].parse, 1);
  assert.ok(h.logs.some((l) => l.includes("parser fail") && l.includes("超时")));
});

test("5. 总预算耗尽后,剩下的解析器不再被调用", async () => {
  const h = harness([
    { name: "吃掉预算", match: () => { clock += 200; return false; } },
    { name: "不该到我这", match: () => true, parse: () => ({ url: B }) },
    { name: "也不该", match: () => true, parse: () => ({ url: C }) },
  ]);
  let clock = 0;
  const out = await run(h, { budget: 100, oneBudget: 10000, now: () => clock });
  assert.equal(out, null);
  assert.deepEqual(h.calls[1], { match: 0, parse: 0 }, "总预算没了就别再问下一个");
  assert.deepEqual(h.calls[2], { match: 0, parse: 0 });
  assert.equal(h.allowed.length, 0);
});

test("6. 三种返回形态都能解析成 options", async () => {
  const shapes = [
    { name: "单档", parse: () => ({ quality: "自动", url: A }), want: [{ quality: "自动", url: A }] },
    {
      name: "streams",
      parse: () => ({ streams: [{ quality: "1080P", url: A }, { quality: "720P", url: B }] }),
      want: [{ quality: "1080P", url: A }, { quality: "720P", url: B }],
    },
    {
      name: "数组",
      parse: () => [{ quality: "高清", url: A }, { quality: "流畅", url: B }],
      want: [{ quality: "高清", url: A }, { quality: "流畅", url: B }],
    },
  ];
  for (const s of shapes) {
    const h = harness([{ name: s.name, match: () => true, parse: s.parse }]);
    const out = await run(h);
    assert.deepEqual(out.options, s.want, s.name + " 的形态要能解析成 options");
    assert.equal(out.url, s.want[0].url, s.name + ":第一档就是起播档");
    assert.equal(out.page, false);
  }
  // 没写 quality 的档位给个兜底名字;非 http(s) 的地址一律不收
  assert.deepEqual(
    parserStreamsOf([{ url: A }, { url: "file:///x" }, { url: " " }]),
    [{ quality: "档 1", url: A }]
  );
});

test("7. Referer 缺失时补上;已有 referer(小写)时不覆盖", async () => {
  // 没带 referer:补成解析页地址
  const h1 = harness([{ match: () => true, parse: () => ({ url: A }) }]);
  const out1 = await run(h1);
  assert.equal(out1.headers.Referer, PAGE);

  // 已有小写 referer:原样保留,不再塞一个大写的
  const h2 = harness([{ match: () => true, parse: () => ({ url: A }) }]);
  const out2 = await run(h2, { headers: { referer: "https://ref.example/", "User-Agent": "UA" } });
  assert.equal(out2.headers.referer, "https://ref.example/");
  assert.equal(out2.headers.Referer, undefined, "大小写不敏感:已经有了就别再加一个");
  assert.equal(out2.headers["User-Agent"], "UA");

  // 已有大写 Referer 也一样
  const h3 = harness([{ match: () => true, parse: () => ({ url: A }) }]);
  const out3 = await run(h3, { headers: { Referer: "https://ref2.example/" } });
  assert.equal(out3.headers.Referer, "https://ref2.example/");

  // 页面地址不是 http(s)(比如本地文件):没得补,也别瞎补
  const h4 = harness([{ match: () => true, parse: () => ({ url: A }) }]);
  const out4 = await run(h4, { pageUrl: "" });
  assert.equal(out4.headers.Referer, undefined);
});

test("8. 解析途中 isAlive() 变 false → 返回 null,且不调用 allow", async () => {
  let alive = true;
  const h = harness([
    {
      name: "解析中切集",
      match: () => true,
      parse: () => { alive = false; return { streams: [{ quality: "1080P", url: A }] }; },
    },
  ]);
  const out = await run(h, { isAlive: () => alive });
  assert.equal(out, null);
  assert.equal(h.allowed.length, 0, "代际已经不对了,不该再登记白名单");
});

test("9. 成功时 allow 收到的是全部档位的地址", async () => {
  const h = harness([
    {
      name: "多档",
      match: () => true,
      parse: () => ({ streams: [{ quality: "1080P", url: A }, { quality: "720P", url: B }, { quality: "480P", url: C }] }),
    },
  ]);
  const out = await run(h);
  assert.equal(h.allowed.length, 1);
  assert.deepEqual(h.allowed[0], [A, B, C]);
  assert.equal(out.url, A);
  assert.equal(out.options.length, 3);
});

test("10. parserMime:mp4 认后缀,其余按 m3u8 清单", () => {
  assert.equal(parserMime("https://cdn.example/a.mp4"), "video/mp4");
  assert.equal(parserMime("https://cdn.example/a.MP4?sign=1"), "video/mp4");
  assert.equal(parserMime("https://cdn.example/a.m3u8"), "application/vnd.apple.mpegurl");
  assert.equal(parserMime("https://cdn.example/live"), "application/vnd.apple.mpegurl");
  assert.equal(parserMime(""), "application/vnd.apple.mpegurl");
});

test("11. 没有解析器就立刻返回 null,不外调任何钩子", async () => {
  let calls = 0;
  const out = await runParserChain({
    parsers: [],
    pageUrl: PAGE,
    headers: {},
    call: async () => { calls += 1; return true; },
    allow: async () => { throw new Error("不该登记白名单"); },
    isAlive: () => true,
    status: () => {},
    log: () => {},
  });
  assert.equal(out, null);
  assert.equal(calls, 0);
});

test("12. 预算常量与 withTimeout 的语义", async () => {
  assert.equal(PARSER_TOTAL_MS, 20000);
  assert.equal(PARSER_ONE_MS, 10000);
  await assert.rejects(() => withTimeout(HANG(), 20, "match"), /match 超时\(20ms\)/);
  await assert.rejects(() => withTimeout(Promise.resolve(1), 0, "parse"), /没有时间预算了/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 50, "parse"), "ok");
});
