# 架构验收快照(2026-11-21)

> 这份文件不是计划,是**结果**。计划在 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 任何时候重跑 `npm run verify:arch` 都能复现下面这段。

## 自检输出

```
OK    adapter vod                 examples/vod.reelbox.js hooks=list/detail/play
OK    adapter iplayr              examples/iplayr.reelbox.js hooks=list/detail/play
OK    内核                          src-tauri/src/proxy.rs
OK    适配器运行时                      ui/plugin-sandbox.js
OK    解析器链                        ui/parser-chain.js
OK    适配器注册(内置)                   src-tauri/src/builtin.rs
OK    Source.adapter              
OK    Source.probe                
OK    derive_adapter              
OK    cargo test -p reelbox-core  119 passed
OK    npm run test:ui             19 passed

11/11 通过
```

## 实机验证(本机,2026-11-21)

| 适配器 | 源 | 结果 |
| --- | --- | --- |
| `vod`(JS) | 非凡资源 | 20 张卡片,首条「已完结诺森伯兰谜案」,无报错 |
| `reelbox`(插件) | 4k影视 | 30 张卡片,首条「更新至9集宝珠」,无报错 |
| `iplayr`(配置) | 独播库 | 48 条,首条「极限逃生」;点播 `readyState=4` / 1920 宽 / `PROXY m3u8 status=200` |

导入链路(粘地址 → 自动建源):

```
粘 https://…/iplayr/dbk.json
  → adapter=iplayr
  → 名字取自配置 title「独播库」
  → probe={ok:true, items:48, sample:"极限逃生"}
```

## 性能基线

沙箱内解析 `cj.lziapi.com` 的 165 KB XML:

| 步骤 | 耗时 |
| --- | --- |
| 网络取回 | 1031 ms |
| DOMParser 解析 | 6 ms |
| 抽取 20 条 | 0 ms |
| XPath 20 个节点 | 8 ms |

## 一致性(P3)

`非凡资源`(JSON)、`量子资源`(XML)、`电影天堂`(JSON):JS 与 Rust 两份实现,
列表条数/`next`/前 3 条五字段、详情线路与集数、前 3 集、分类、播放地址与 `page` 标记 —— 逐字段一致。

注意:采集站返回顺序会轮换,比对必须按 `id` 对齐。

## 人工校验会话(Cloudflare)

目标站:`https://nopecha.com/demo/cloudflare`(不带你自己的 cookies 时返回 403「Just a moment」)。

| 步骤 | 结果 |
| --- | --- |
| `session_open` | 真实顶层窗口打开,页面里注入「我已完成」工具条 |
| 挑战页自身 | 窗口里几秒内自动过掉,标题变成 `NopeCHA - CAPTCHA Demo` |
| 点「我已完成」 | 记录 `done=true`,窗口隐藏(不销毁,cookie 罐留着) |
| `session_fetch` | `HTTP 200 / 142880 字`,正文是真实页面,不是挑战页 |

日志里的证据:

```
VERIFY open id=8193457d host=nopecha.com
VERIFY id=8193457d host_label=verify-8193457d result=done
VERIFY fetch host=nopecha.com cookies=1 ua=browser
```

同一个目标站用 curl 直连/走代理都是 403,说明 200 是**会话 cookie 起了作用**,
而不是站点放行。适配器侧(沙箱 → `ctx.human.verify` → `ctx.http.get({session})`)
跑同一条链路,返回 `HTTP 200 / 142880 字`。

## 怎么复现

```bash
npm run verify:arch          # 静态结构 + 两套测试
cargo test -p reelbox-core   # 119 条
npm run test:ui              # 6 条
```

实机部分需要 debug 构建 + 调试端口,步骤见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 9 节。
