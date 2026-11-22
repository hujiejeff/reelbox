# 写一份 iplayr 配置

> iplayr 配置 = 一份 JSON,用 **XPath + 正则 + URL 模板** 描述"怎么从一个站点抓片"。
> 不用写代码,内置引擎(`examples/iplayr.reelbox.js`)负责执行。

一条 iplayr 源 = 内置引擎 + 你这份配置:

```
源 { adapter: "iplayr", url: "https://…/my-site.json" }
                ↑ 引擎(随包安装)          ↑ 配置(你写的)
```

## 最小可用配置

```json
{
  "uuid": "my-site",
  "title": "我的站点",
  "referer": "https://www.example.com/",

  "category": [
    { "title": "电影", "url0": "https://www.example.com/movie/", "url1": "https://www.example.com/movie/page/{pg}/" }
  ],

  "vod_node": "//div[@class='list']//li",
  "vod_title": "//h3/a",
  "vod_link_id": "//h3/a/@href",
  "vod_link_url": "{id}",
  "vod_image_id": "//img/@data-original",
  "vod_image_url": "{id}",

  "playlist_group_node": "//div[@class='play-list']",
  "playlist_title": "//a",
  "playlist_link_id": "//a/@href",
  "playlist_link_url": "{id}",

  "play_regex": "aHR0cHM6Ly9bXiJdK1wubTN1OA==",

  "search_url_first_page": "https://www.example.com/search?q={wd}",
  "search_url_other_page": "https://www.example.com/search?q={wd}&p={pg}",
  "search_vod_node": "//div[@class='search-list']//li",
  "search_vod_title": "//h3/a",
  "search_vod_link_id": "//h3/a/@href",
  "search_vod_link_url": "{id}",
  "search_vod_image_id": "//img/@src",
  "search_vod_image_url": "{id}"
}
```

## 字段速查

### 基本

| 字段 | 说明 |
| --- | --- |
| `uuid` / `title` | 标识和显示名。`title` 会作为源名 |
| `referer` | 请求头里的 Referer。不填就用第一个分类的站点 origin |
| `category` | 分类数组,**至少要有一项**,否则导入会被判"没有 category" |
| `category[].title` | 侧栏上显示的分类名 |
| `category[].url0` | 第 1 页地址 |
| `category[].url1` | 第 N 页地址,用 `{pg}` 占位;**没有它就只能看第 1 页** |
| `cf_flag` | 站点是否挂了 Cloudflare。填 `true` 会被引擎直接拒绝(见文末限制) |

### 列表

| 字段 | 说明 |
| --- | --- |
| `vod_node` | 一条卡片对应的节点 XPath,例如 `//div[@class='list']//li` |
| `vod_title` | 卡片里的标题 |
| `vod_link_id` | 卡片里的详情链接(取**值**) |
| `vod_link_url` | 链接模板,`{id}` 会被上一项的值替换;没有 `{id}` 就原样用 |
| `vod_image_id` | 封面地址(取**值**) |
| `vod_image_url` | 封面模板,同上 |

取值的字段(`*_id`)可以写属性(`//a/@href`、`//img/@data-original`),也可以写节点(取文本)。

### 详情 / 剧集

| 字段 | 说明 |
| --- | --- |
| `playlist_group_node` | 一组剧集的外层节点(多条线路就是多个外层节点);**不填就整页当一组** |
| `playlist_title` | 集名(节点或属性) |
| `playlist_link_id` | 剧集页地址 |
| `playlist_link_url` | 模板,`{id}` 替换 |

详情页的标题不需要字段:引擎先取 `//h1`,没有就取 `//title`。

### 播放

| 字段 | 说明 |
| --- | --- |
| `play_regex` | 从剧集页正文里提取播放地址的正则,**取第一个捕获组**。多数配置里是 base64,引擎会先解码再当正则用 |

引擎拿到捕获值后还会做两步兜底:像 base64 就解码,含 `%` 就 `decodeURIComponent`。
所以配置里**不用写解码逻辑**。

> `play_url` 字段:iplayr 原版有此字段,我们的引擎**不用它** —— 取流只认 `play_regex`。

### 搜索

`search_` 前缀 + 下面这些:

| 字段 | 说明 |
| --- | --- |
| `search_url_first_page` | 第 1 页,`{wd}` 会被替换成 URL 编码后的关键词 |
| `search_url_other_page` | 第 N 页,额外支持 `{pg}`;不填就搜不了第 2 页 |
| `search_vod_node` / `_title` / `_link_id` / `_link_url` / `_image_id` / `_image_url` | 同列表那套 |

### 引擎忽略的字段

`vod_info`、`vod_score`、`vod_image_regex`、`play_url`、`uuid` 以外的元信息 —— 写不写都行,
不影响结果。留着是为了和 iplayr 生态里的配置互通。

## XPath 怎么写

配置里的 XPath **一律从文档根开始**(`//div`),引擎在单个卡片上求值时会自动转成相对写法
(`.//div`)—— 你不需要关心这件事,照网页结构写就行。

在浏览器 DevTools 的控制台里可以先验证:

```js
$x("//div[@class='list']//li").length     // 卡片数量对不对
$x("//div[@class='list']//li")[0].querySelector("h3 a").href
```

**属性要写成 `/@attr`**:`//img/@data-original`(不是 `//img/@src`,很多站是懒加载)。

## 从零写一份:五步

1. **找列表页**:打开站点某个分类,记下第 1 页和翻页后的地址,得出 `url0` / `url1`
2. **写 `vod_node`**:对着卡片写 XPath,确认条数和页面一致
3. **填四个字段**:标题、链接、封面(各一对 `*_id` / `*_url`)
4. **详情页**:打开一部片子,找剧集所在的容器;有"线路一/线路二"就是一个容器一组
5. **播放页**:打开任意一集,`view-source` 找播放地址的规律,写成正则;
   如果配置生态里是 base64 的,直接粘那份即可

写好之后: **导入源 → 粘配置地址(或选本地 json 文件)**,导入时会试跑一次
`list` 的第 1 页 —— 出条目才算过。

## 验证与排查

| 现象 | 先看什么 |
| --- | --- |
| 导入说"没有 category" | `category` 是数组且至少一项 |
| 列表 0 条 | `vod_node` 是否和当前页面结构一致(站点改版最常见) |
| 有列表,点进去报错 | `vod_link_url` 拼出来的地址能不能在浏览器直接打开 |
| 详情没有剧集 | `playlist_group_node` / `playlist_link_*`;先不填 group,用整页当一组试试 |
| 播放报"没有匹配 play_regex" | 正则不对(base64 解出来的那份要能匹配当前页面) |
| 播放地址对但播不了 | 可能不是 m3u8/mp4;看[播放文档](PLAYBACK.md)的编码支持表 |

日志在 **设置 → 调试 → 日志文件**,`PROBE` 行会写出试了哪个适配器、返回了什么。

## 限制

- **`cf_flag: true` 直接拒绝**:引擎明确报"有 Cloudflare 校验"。这类站点请改用
  [源插件](AUTHORING-PLUGIN.md) + `ctx.human.verify()`,或者等 iplayr 引擎接上校验会话
- 只支持一层分组(线路),不支持二级分类树
- 配置是明文 JSON,里面不要放 cookie / 账号
- 站点改版就得改配置 —— 这是这类格式的固有代价,也是它"不用发版"的另一面
