# 引擎插件 + 站点配置

有些站点的爬取规则是可以**写出来**的:列表页取哪个节点、标题在第几个 XPath、
播放地址在正文里长什么样。iplayr 那类配置就是这种「声明式爬虫规则」——
一份 JSON,里面全是 XPath、正则和 URL 模板。

于是可以把它拆成两半:

| | 谁 | 装几次 |
| --- | --- | --- |
| **怎么爬** | 引擎插件 `.reelbox.js`,`kind: "engine"` | 一个文件,装一次 |
| **爬哪个站** | 站点配置 JSON(分类地址 + XPath + 正则) | 一份配置 = 一条源 |

同一个引擎插件配不同地址就是不同的源 —— 和「一个源插件 = 一个站」不一样。
示例见 [`examples/iplayr.reelbox.js`](../examples/iplayr.reelbox.js)。

## 怎么用

1. 设置 → 源 →「导入源」,选引擎插件的 js 文件;
2. 导入后会弹一个框问**站点配置地址**,填上那份 JSON 的地址,例如
   `https://raw.githubusercontent.com/m3u8playlist/dp/master/iplayr/dbk.json`;
3. 源列表里多出一条源,切过去就能看列表 / 详情 / 剧集。

第 2 步留空直接确定 = **只装插件、不建源**(插件文件在,但不知道该爬哪个站)。
以后想补配置:再导入一次同一个插件文件,填上地址即可 —— 它会更新那条源,
不会重复建一条。

配置地址也存在源里(`sources.json`):

```json
{
  "id": "3b9d1c07",
  "name": "iplayr 引擎",
  "type": "webox",
  "url": "C:/Users/x/AppData/Roaming/reelbox/plugins/iplayr.engine.reelbox.js",
  "options": { "config": "https://…/iplayr/dbk.json" }
}
```

`options` 就是引擎的站点配置。没有配置的源不写这个字段。

## 插件怎么写

引擎插件和普通源插件是**同一份契约**(`reelbox.define`,同一套钩子,同一个
sandbox),只多两点:

```js
reelbox.define({
  id: "iplayr.engine",
  name: "iplayr 引擎",
  version: "1.0.0",
  api: 1,
  kind: "engine",        // ① 声明自己是引擎:导入时会多问一句配置地址
  caps: ["http", "html"],

  // ② 钩子多收到一个 options —— 也就是源里的 options 字段
  async list(ctx, { page, filters, options }) {
    const cfg = await loadConfig(ctx, options);   // options.config 是配置地址
    …
  },
});
```

- `filters` / `list` / `search` / `detail` / `play` 都会收到 `options`
  (`{config: "https://…"}`);普通插件不用管它,收到的是空对象。
- `detail` / `play` 的 `id` 是**绝对地址**(由 `list` / `detail` 自己拼好交给宿主)。
- 站点配置里有 `cf_flag: true`(Cloudflare 校验)就 `ctx.fail("unsupported", …)`,
  别让它静默失败 —— 用户至少知道是站点挡了。

## `ctx.html.load().xpath()`

沙箱里除了 `$`(CSS 选择器),还有 XPath:

```js
const p = ctx.html.load(html);          // html:页面正文文本

p.xpath("//ul[@class='myui-vodlist clearfix']//li");   // → DOM 节点数组
p.xpath("//h1/text()");                                 // → 文本节点数组
p.xpath("//a/@href");                                   // → 字符串数组(属性=值)
p.xpath("count(//li)");                                 // → [数字](非节点集都是单元素数组)
p.xpath("//ul[@class='x'");                             // XPath 写错 → 抛错,信息里带这条表达式
```

按节点求值(取每张卡片自己的标题 / 链接):

```js
const cards = p.xpath(cfg.vod_node);
cards.forEach((node) => {
  // 相对求值:$ (node) 返回的包装对象上也有 xpath()
  const links = p(node).xpath(".//h4//a/@href");
  const title = p(node).xpath(".//h4//a")[0].textContent;
});
```

返回值规则:

| 表达式结果 | `xpath()` 返回 |
| --- | --- |
| 节点集 | DOM 节点数组(顺序同 `ORDERED_NODE_SNAPSHOT`) |
| 属性节点集 `//a/@href` | **字符串**数组(属性节点直接换成它的值) |
| 字符串 / 数字 / 布尔 | 单元素数组,如 `["…"]` / `[42]` / `[true]` |

底层就是浏览器原生的 `document.evaluate(expr, contextNode, null,
XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)`,求值失败抛
`xpath 求值失败("<表达式>"): <原因>`,错误对象上还带 `err.expr`。

### `//` 和 `.//` 的区别(踩过)

XPath 1.0 里 `//x` 是「从**文档根**开始找」,给它一个上下文节点也不会变成
「从这个节点往下找」。配置里写的 `//h4//a` 是从根开始的写法,按卡片节点求值时
必须先改成 `.//h4//a`,否则每张卡片都会抓到**同一批**节点(整页的标题)。
引擎插件里的 `relativeXPath()` 干的就是这件事。

## iplayr 字段对照

`examples/iplayr.reelbox.js` 用到的字段与用法:

| iplayr 字段 | 引擎里怎么用 |
| --- | --- |
| `title` / `uuid` | 只做参考,源名字用插件名(或导入时自己填) |
| `referer` | 请求头 `Referer`;空则用站点 origin |
| `cf_flag` | `true` → `ctx.fail("unsupported", "有 Cloudflare 校验")` |
| `category[]` | `filters` 的「分类」选项(`value` = 数组序号);选中项决定下面两个地址 |
| `category[].url0` | 第 1 页地址 |
| `category[].url1` | 第 2 页起,`{pg}` 换成页码(没有就只取第 1 页) |
| `vod_node` | 列表卡片节点集(`list`) |
| `vod_title` | 卡片里的标题(取节点文本) |
| `vod_link_id` | 卡片里的详情链接(取属性值) |
| `vod_link_url` | 详情页模板,`{id}` = 上面取到的链接 |
| `vod_image_id` | 封面地址属性 |
| `vod_image_url` | 封面模板,`{id}` = 上面取到的值 |
| `playlist_group_node` | 详情页的线路分组节点(没有就整页当一组) |
| `playlist_title` | 组内剧集名 |
| `playlist_link_id` | 组内剧集链接(属性) |
| `playlist_link_url` | 剧集页模板,`{id}` = 上面取到的链接 |
| `play_regex` | **base64** 的正则源码;在剧集页正文里取第一个捕获组 |
| `play_url` | 目前不用(剧集页地址第 3 步已经拿到了) |
| `search_flag` / `search_url_first_page` / `search_url_other_page` | `search` 钩子:`{wd}` 换关键词,`{pg}` 换页码 |
| `search_vod_*` | 搜索结果那一套列表字段(前缀 `search_`) |

几点实现细节(配置里看不出来的):

- **模板没有 `{id}` 时直接用取到的值** —— 有的配置的链接本来就是绝对地址;
- **正则字段是 base64**:`play_regex` 解出来才是正则源码(`InVybCI6IihbXiJdKyk=`
  → `url":"([^"]+)`);配置里直接写正则也认;
- **捕获值可能套两层编码**:先看像不像 base64(`/^[A-Za-z0-9+/=]+$/` 且长度 > 32)
  是就解一次,再 `decodeURIComponent`,得到 `https://…/chunklist.m3u8`;
- **配置只取一次**:同一份配置在插件实例里缓存(翻页不会每页重取);
- **请求头**:桌面 UA + `Referer`(配上播放时给出的 `headers`,这类 CDN 的防盗链
  才过得去)。

## 和别的东西的关系

| | 源插件 | 引擎插件 | 适配器 `reelbox.adapter` |
| --- | --- | --- | --- |
| 入口 | `reelbox.define` | `reelbox.define` + `kind: "engine"` | `reelbox.adapter` |
| 身份 | 一个源 | 一个源(站点由 `options.config` 决定) | 一种格式的翻译器,不是源 |
| 导入时 | 直接建源 | 还要填配置地址,填了才建源 | 只装文件,不建源 |
| 钩子 | 全部 | 全部 | `accepts` / `list` / `detail` / `play` |

> 早先还有一个 `reelbox.parser`(用"解析器"单独做取流),这个概念已经移除:
> 取流逻辑归到源自己的适配器里。见到旧文件会明确提示「解析器已移除」。

引擎插件同样是不可信代码:跑在 `sandbox="allow-scripts"` 的 iframe 里,
只能通过 `plugin_fetch` 发请求(挡内网),读不到 localStorage / Cookie,
也拿不到 Tauri IPC。装之前看清来源。
