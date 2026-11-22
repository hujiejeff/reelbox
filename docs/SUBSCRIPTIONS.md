# 配置订阅

一份 `index.json` 装齐**源 + 适配器**。同一条链接,谁装都是同一套。

## 两条设计约束

- **代码的元信息只存在代码里** —— `define({ id, name, version })` 写在 js 里,
  索引不重复一遍,就不会出现"文件里 1.0.0、索引里 1.1.0"这种对不上的事
- **插件和适配器是一种东西** —— 都对源说"由这段代码解析",所以只有 `adapters[]`

## 顶层

```jsonc
{
  "schema": "reelbox-index/2",
  "name": "reelbox 基础配置",
  "version": "2.0.0",
  "updated": "2026-11-22T14:15:00Z",
  "adapters": [],
  "sources": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | ✅ | 固定 `"reelbox-index/2"` |
| `name` | ✅ | 订阅列表里显示的名字 |
| `version` | ✅ | semver,只增不减;应用靠它判断有没有更新 |
| `updated` | ✅ | ISO8601 |
| `adapters` | | 自定义适配器;内置的不用写 |
| `sources` | | 源列表 |

## adapters

```jsonc
{ "id": "4kvm", "name": "4K影视", "url": "plugins/4kvm.reelbox.js" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 源用 `adapter` 引用它;不能和内置名(`vod` / `iplayr` / `m3u`)重复 |
| `name` | ✅ | 展示名 |
| `url` | ✅ | 代码文件的位置,相对或绝对 |

**不写 version / sha256 / type**:这些从代码自身的 `define({...})` 读。

## sources

```jsonc
{ "id": "ffzy", "name": "非凡资源",
  "url": "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8",
  "adapter": "vod", "type": "vod" }
```

### 必填

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识,更新时靠它认人,不要改 |
| `name` | 显示名 |
| `url` | 站点地址,必须是 http(s) |
| `adapter` | `vod` / `iplayr` / `m3u`,或 `adapters[]` 里的 id |
| `type` | `vod` / `xml` / `live` / `webox` |

`type` 必填是故意的:不写就得靠 adapter 和 url 猜,而**直播插件猜不出来**
(url 是站点域名、又不是 `.m3u8`,会被当成点播),猜错的表现是"能播但进度条一直在"。

### 可选

| 字段 | 说明 |
| --- | --- |
| `verify` | `true` = 运行时先让人工过一遍校验(Cloudflare / 登录) |
| `verifyUrl` | 校验页地址;`url` 推不出站点域名时必填 |
| `posterRatio` | 封面比例,如 `16:9`;不写按 2:3 |
| `options` | 交给插件的参数,比如 `{ "quality": "1080" }` |

## url 的两种写法

`adapters[].url` 和源的 `url` 都遵循同一条:

```
"plugins/4kvm.reelbox.js"        → 相对索引所在目录 → <index目录>/plugins/4kvm.reelbox.js
"https://cdn.x.com/4kvm.js"      → 绝对,原样用
```

留相对是为了同一份索引放 raw / jsDelivr / Pages 都能用,插件地址不用跟着改。
放别人仓库的代码写绝对地址 —— 代价是这份索引绑在那个域名上。

## 安装流程

```
1. 体检(schema / 版本 / 字段 / adapter 有没有出处)
2. 逐条源看 adapter:
     内置        → 直接用
     adapters[]  → 取它的 url,下载、落盘、记下来
     两边都没有  → 报错,整份不装
3. 同一个 adapter 被多条源引用 → 只装一次(按 id)
4. 装过的 adapter 记住:id → 本机文件 + 装的时候的 sha256
5. 源的 url 原样保留;adapter 不是内置的,运行时按 id 找本机文件
```

第 4 步的 sha256 **不来自索引**,是装完自己算的。唯一用途:判断用户有没有手改过
(改过就不覆盖,列进报告的 skipped)。

## 校验规则

| 检查 | 为什么 |
| --- | --- |
| `schema` 是 `reelbox-index/2` | 认得出这是哪一代 |
| `version` 是 semver、`updated` 不是未来 | 增量与排序 |
| 源 / 适配器的 `id` 各自唯一 | 更新时认得出谁是谁 |
| 适配器 id 不撞内置名 | 内置靠 `@builtin-version` 升级,不能被订阅顶掉 |
| `url` 是 http(s);相对路径按索引目录解析后也必须是 http(s) | 本地路径的源别人装了是坏的 |
| `adapter` 是内置的,或在 `adapters[]` 里 | 否则装了也跑不起来 |
| `type` 在四个值里 | 直播 / 点播的分派依据 |

## v1 → v2 迁移

纯机械,应用读到 `schema: "reelbox-index/1"` 时在内存里转一遍再走:

| v1 | v2 |
| --- | --- |
| `plugins[]` 的一条 `{id, name, path, ...}` | `adapters[]` 的 `{id, name, url: path}` |
| 源上的 `plugin: "4kvm"` | 源上的 `adapter: "4kvm"` |
| 源上缺 `type` | 按 adapter / url 推一个填上 |
| `plugins[].sha256` | 丢掉(本地装完自己算) |

磁盘上的 `index.json` 不重写 —— 仓库那份什么时候改由维护者决定。

## 和 v1 的差别

| | v1 | v2 |
| --- | --- | --- |
| 代码列表 | `plugins[]` | `adapters[]` |
| 源引用代码 | `plugin: "<id>"` | `adapter: "<id>"` |
| 代码元信息 | 索引里写 name/version/sha256 | 只写 `{id, name, url}` |
| `type` | 必填 | 必填(不变) |
| 插件源必须写 `adapter: "reelbox"` | 是 | 否,写自己的 adapter id |

## 还没做的

- **探测缓存**:v2 不做自动探测(所有字段都写全),所以没有"装一次要 10 秒"的问题
- **多线路同站**:用不同 `id` 加两条源即可
- **禁用而不删除**:不做了 —— 不需要的源不写进配置就行
