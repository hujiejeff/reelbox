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

## 怎么复现

```bash
npm run verify:arch          # 静态结构 + 两套测试
cargo test -p reelbox-core   # 119 条
npm run test:ui              # 19 条
```

实机部分需要 debug 构建 + 调试端口,步骤见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 9 节。
