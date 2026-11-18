# 解析器插件契约(`reelbox.parser`)

有些源不给播放地址,只给一张网页 —— 比如站点的"分享页""播放页"。真正的 m3u8
藏在页面 HTML 里,得取一次页面、把它抠出来。

**解析器就是干这件事的插件**:它只回答两个问题 —— "这个页面你认识吗"和
"那播放地址是什么"。它不是一个源:没有列表、没有详情、不会出现在源下拉里,
也不会被设为当前源。它只在播放链路发现"这个地址是解析页"时才被调用。

示例见 [`examples/share.reelbox.parser.js`](../examples/share.reelbox.parser.js),
导入方式:设置 → 源 → 「导入解析器」。

## 长什么样

```js
reelbox.parser({
  id: "dytt-share",              // 全局唯一,做文件名
  name: "电影天堂分享页",
  version: "1",                  // 源页里显示成 "v1"

  // 只认自己认识的页面;返回 false 就跳过,不拖慢别的源
  match(url) { return /dytt/i.test(url); },

  // 把分享页变成可播地址
  async parse(ctx, { url, headers }) {
    const html = (await ctx.http.get(url, { headers })).data;
    const m = html.match(/https?:\/\/[^"']+?\.m3u8[^"']*/);
    if (!m) return ctx.fail("parse", "页面上没找到 m3u8");
    return { quality: "自动", url: m[0] };
  },
});
```

入口是 `reelbox.parser({...})`(和源插件的 `reelbox.define({...})` 是两个入口)。
一个文件只写一个入口;写成 `reelbox.define` 就是源插件,不是解析器。

## `match(url)`

入参就是那个页面地址(字符串),返回值决定"这次要不要用我这个解析器"。

| 写法 | 含义 |
| --- | --- |
| 没有 `match` | 视为都匹配(万能解析器;能写就写,不然它会挡在别人前面) |
| `match(url) { return true/false }` | 函数返回布尔 |
| `match: [/dytt/i, "share"]` | 数组:任一命中即算(正则或子串都能写) |
| `match: /dytt/i` | 单个正则 |

`match` 必须**快**:它只做判断,不要在里面发网络请求。它同步执行,超时按 10 秒算。

## `parse(ctx, { url, headers })`

- `url`:要解析的页面地址;
- `headers`:播放链路带过来的请求头(`User-Agent`,有时有 `Referer`),转发给
  `ctx.http.get` 更容易过站点的防盗链。

返回值**三种形态都收**(不用猜):

```js
return { quality: "自动", url: "https://…/index.m3u8" };            // 单档
return { streams: [{ quality: "1080P", url: "…" }, { … }] };         // 多档
return [{ quality: "1080P", url: "…" }, { quality: "720P", url: "…" }]; // 直接给数组
```

第一档就是默认起播的那一档(多档会出现在播放器的画质菜单里)。地址必须是
`http://` 或 `https://` 开头;相对地址请自己用 `ctx.url.resolve(raw, url)` 补全。

解析出来的地址会先登记进本地播放白名单,再走和普通源一样的
`player_url` → `stream_kind` 链路 —— 也就是说,解析器给出的地址同样只能在本进程
这一次会话里播放,不会被写进任何配置文件。

## 失败:`ctx.fail(code, msg)`

和源插件同一套错误码,**不要新造**:

| code | 什么时候用 |
| --- | --- |
| `network` | 页面取不到、超时、被墙 |
| `parse` | 取到了,但页面上没有 m3u8(站点改版最常见) |
| `auth` | 需要登录/Cookie/会员 |
| `unsupported` | 这个页面我解不了 |

抛出去就是一个解析器失败:**链路会继续问下一个解析器**,不会整个播不了。
也可以直接 `return null` / 返回空数组表示"我解不出来"。

## 时序与预算

```
playEpisode → 源给的地址是解析页(page = true)
      ↓
  解析器列表(设置 → 源 → 解析器),按导入顺序
      ↓ 每个:match(url)  ← false 就跳到下一个
      ↓ 命中:parse(ctx, {url, headers})   ← 失败/超时也跳到下一个
      ↓ 第一个拿到地址的 → plugin_stream_allow → player_url → 起播
```

- 单个解析器最多 **10 秒**(match + parse 合计);
- 整条链最多 **20 秒**;
- 串行,不并行(并行会把站点打爆,也看不出是谁解的);
- 切集、关播放器会立刻中断整条链,不需要插件配合。

全部失败时播放器会说"这个源只给了解析页,没有可播地址",并给一个「去设置」,
不会静默转圈。

## 安全

- 解析器和源插件跑在**同一个 sandbox iframe** (`sandbox="allow-scripts"`,
  unique origin)里:读不到 localStorage / Cookie,也拿不到 Tauri IPC。
- 它**能发网络请求**:请求从 `plugin_fetch` 出去,会挡掉本机和内网地址
  (`127.0.0.1`、`10.*`、`192.168.*`、`*.local` 等),但**挡不住它把页面内容发到公网**。
  装之前看清来源,别装来路不明的解析器。
- 解析器只能让播放器去播一个地址,不能改源列表、不能删收藏、不能读你的进度。

## 和 `docs/PLUGIN.md` 的关系

| | 源插件 `reelbox.define` | 解析器插件 `reelbox.parser` |
| --- | --- | --- |
| 身份 | 一个源 | 一个工具,不是源 |
| 存放 | 源列表,可选择、设为当前源 | 「设置 → 源 → 解析器」块 |
| 钩子 | `filters` / `list` / `search` / `detail` / `play` | `match` / `parse` |
| 何时被调用 | 当前源就是它 | 播放时发现地址是解析页 |
| `ctx` | 完全相同(`http` / `html` / `url` / `fail` / `log`) | 完全相同 |

两者共用 sandbox、`ctx`、错误码和导入流程;区别只在"谁在什么时候调它"。
源插件里的 `play` 也可以直接返回分享页地址 —— 那条路会走 `Stream.page`,
同样落到解析器链上。
