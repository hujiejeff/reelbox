# 配置订阅

一条地址(`index.json`)装齐**源 + 源插件 + 适配器**。改仓库、点一次同步,只拉变了的文件。

```
用户在这一头                        仓库在那一头
┌──────────────────────┐          ┌──────────────────────────┐
│ sources.json         │          │ index.json               │
│  ├ 手加的源           │  同步     │  ├ sources[]   ← 源       │
│  └ 订阅装的源(from)   │ ◀──────▶ │  ├ plugins[]   ← 源插件    │
│ subscriptions.json   │          │  ├ adapters[]  ← 适配器    │
│  └ 这张账:装过什么     │          │  └ plugins/*.js          │
└──────────────────────┘          └──────────────────────────┘
```

代码:解析与挑错在 `core/src/sub.rs`(纯逻辑,有单测),下载写盘在 `src-tauri/src/sub.rs`。

## 为什么不是"切换订阅"

订阅是**叠加**的,不是"一次只有一个生效"。每条源带一个 `from` 字段记住自己是哪条订阅装的,同步时只动 `from == 自己` 的那些。

这样三个问题都不用回答:

- 切换订阅之后,原来那些源算谁的?
- 用户手改过的源,同步时覆盖还是不覆盖?
- 两条订阅给了同一条源,听谁的?

`from` 一填,答案都是"各管各的"。

## index.json

```jsonc
{
  "schema": "reelbox-index/1",
  "name": "reelbox 基础配置",     // 订阅列表里显示的就是它
  "version": 3,                  // 只增不减;应用靠它判断"要不要拉"
  "updated": "2026-11-22T06:30:00Z",
  "homepage": "https://github.com/…",

  "adapters": [ { "id": "hgpub", "name": "HGhub 适配器",
                  "path": "hgpub.adapter.js",     // 只写文件名
                  "version": 2, "sha256": "…", "minApp": "0.2.3" } ],
  "plugins":  [ { "id": "4k", "path": "4k.reelbox.js", "sha256": "…" } ],

  "sources":  [ { "id": "ffzy", "name": "非凡资源", "type": "vod",
                  "url": "https://…/provide/vod", "adapter": "vod" } ]
}
```

`path` 只写文件名:应用只扫描 `plugins/` 第一层,放子目录等于没装。真实地址是
`<index 所在目录>/plugins/<path>`,由 `core::sub::code_url` 拼。

源上的字段和 `sources.json` 完全一样(见 [SOURCES.md](SOURCES.md)):
`verify` / `verifyUrl`(人工校验)、`posterRatio`(封面比例)、`options`(引擎插件配置)。

## 安装时会发生什么

顺序是**适配器 → 插件 → 源**,因为源的 `adapter` 可能指向这次刚装上的适配器。

装之前先过一遍体检(`core::sub::problems`),有一条不合格就整份不装 ——
半装状态比不装更难收拾。体检项:

| 检查 | 为什么 |
| --- | --- |
| `schema` / `version` / `updated` | 这是不是一份索引、比不比手上新 |
| id 全局唯一 | 源、插件、适配器共用一个命名空间,重名之后更新认不出谁是谁 |
| 适配器名不是内置的 | `vod`/`iplayr`/`m3u`/`reelbox` 靠 `@builtin-version` 升级,订阅不能抢这个位置 |
| 源的 `url` 是 http(s) | 本地路径的源别人装了是坏的 |
| `adapter` 有出处 | 内置的,或本索引 `adapters` 里声明的 |
| `sha256` 是 64 位十六进制 | 少了它就没法判断文件被改过没有 |
| `minApp` | 新适配器用了旧应用没有的 `ctx` 能力时,装之前就拒绝 |

## 三种文件的处置

对每个 `plugins/` 下的文件,拿**三方**比对:索引里的 sha256、磁盘上现在的、上次装的时候记下的。

| 情况 | 动作 |
| --- | --- |
| 磁盘上就是索引要的那份 | 什么都不做 |
| 磁盘上的 ≠ 上次记的 | 用户改过 → **不覆盖**,写进报告的 `skipped` |
| 磁盘上的 = 上次记的 | 用户没动过 → 覆盖 |
| 文件不存在 | 下载,校验 sha256,写盘 |

`force = true`(界面上是二次确认)才会连"用户改过的"一起覆盖。

## 源的合并规则

按顺序匹配,先命中先算:

1. **上次装过的那条**(按 `local_id`)→ 更新字段
2. **同 id 且地址相同** → 接管
3. **同 id 但地址不同 / 已被别的订阅管着** → 不碰,写进 `skipped`
4. **没有同 id,但有一条同地址的本地源** → 接管(常见于"先把配置导进应用了,后来才做成订阅")
5. 都没有 → 新增,`from` = 本条订阅

**接管不改 id**。收藏和进度是按 `源id|片名` 存的,改 id 等于把用户的历史弄丢。
所以 `subscriptions.json` 里每条源记两个 id:索引里的 `id` 和本地的 `local_id`。

更新的字段只包括订阅管得着的那些(`name`/`type`/`url`/`adapter`/`verify`/`verifyUrl`/`posterRatio`/`options`);
`health` 和 `probe` 是本地观测结果,永远保留 —— 拿它们比会导致每次同步都"有更新"。

## 删除订阅

- 它装的源跟着走(`from == 自己` 的那些)
- **它装的文件留着**:可能别的订阅也在用,也可能用户已经拿去改成自己的源了
- 账本里这条记录删掉

## 网络与可达性

拉取走的是和插件同一套网络层(系统代理 → 直连,按域名记 30 分钟),所以:

- `raw.githubusercontent.com` 在国内经常连不上 → 换 jsDelivr:
  `https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/index.json`
- **环回地址永远直连**:`localhost` / `127.x` 不走系统代理(代理多半在别的机器上,
  让它去连 127.0.0.1 只会拿到 502,还会把这个错误记进选路记忆)

## 私有仓库

`raw.githubusercontent.com` 对私有仓库不生效(带 token 也拿不到)。要用私有仓库得走
`api.github.com/repos/{owner}/{repo}/contents/{path}` + fine-grained PAT(只给这一个仓库、
只读、设过期)。当前版本只支持公开仓库 —— 私有订阅要先决定 token 存在哪(见
[NETWORK.md](NETWORK.md) 的安全边界说明),还没做。

## 已知边界

- 只支持一个 `index.json`,不支持嵌套引用别的索引
- 没有 ETag 缓存:每次同步都完整拉一次索引(几 KB,可以接受)
- 订阅之间不共享文件:两条订阅带同一个适配器会各装一份,后装的覆盖先装的
- 不校验索引来源的可信度:装第三方订阅 = 运行别人的 JS(沙箱挡 DOM/IPC/文件,
  挡不住它发网络请求、读 `ctx.settings`)
