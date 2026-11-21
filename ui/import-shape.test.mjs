import test from "node:test";
import assert from "node:assert/strict";
import { splitCollection, usableApi, isTvboxSite } from "./import-shape.js";

test("TVBox:type 1 的 CMS 条目转成 vod 源", () => {
  const { sources, skipped } = splitCollection([
    { key: "ffzy", name: "非凡", type: 1, api: "https://cj.ffzyapi.com/api.php/provide/vod" },
  ]);
  assert.equal(skipped.length, 0);
  assert.deepEqual(sources[0], {
    name: "非凡",
    url: "https://cj.ffzyapi.com/api.php/provide/vod",
    type: "vod",
    adapter: "vod",
  });
});

test("TVBox:type 0 转成 xml", () => {
  const { sources } = splitCollection([{ key: "x", name: "XML 站", type: 0, api: "https://x/api.php/provide/vod/at/xml" }]);
  assert.equal(sources[0].type, "xml");
});

test("TVBox:type 3 的 jar 爬虫被跳过并说明原因", () => {
  const { sources, skipped } = splitCollection([{ key: "db", name: "豆瓣", type: 3, api: "csp_Douban" }]);
  assert.equal(sources.length, 0);
  assert.match(skipped[0].reason, /jar/);
});

test("TVBox:api 不是地址也跳过", () => {
  const { sources, skipped } = splitCollection([{ key: "a", name: "坏的", type: 1, api: "" }]);
  assert.equal(sources.length, 0);
  assert.equal(skipped[0].reason, "没有可用地址");
});

test("非 TVBox 条目原样通过", () => {
  const { sources } = splitCollection([{ name: "普通源", url: "https://x/api.php/provide/vod" }]);
  assert.equal(sources[0].name, "普通源");
});

test("usableApi / isTvboxSite 的边界", () => {
  assert.equal(usableApi("https://a/b"), true);
  assert.equal(usableApi("csp_X"), false);
  assert.equal(usableApi("/local/path"), false);
  assert.equal(isTvboxSite({ api: "https://a" }), true);
  assert.equal(isTvboxSite({ url: "https://a" }), false);
  assert.equal(isTvboxSite(null), false);
});
