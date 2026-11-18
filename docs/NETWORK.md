# 网络出口与代理

状态:已实现(提交 `3870301`),`cargo test -p reelbox-core` 覆盖。

## 为什么"开了系统代理还是连不上"

应用里有两条完全独立的网络路径:

| 谁在发请求 | 实现 | 跟系统代理 |
| --- | --- | --- |
| 播放器拉分片、页面里的 `<img>` | WebView2(Chromium) | 是 |
| 源接口、详情、取流、封面、插件里的 `http.get` | Rust + reqwest | **否**,要自己解析 |

所以代理开着、分片能拉,列表却超时 —— 那是 Rust 那侧没走代理。这正是换 reqwest 之前的状态。

## 解析顺序

每次请求前解析一次(结果缓存 5 秒),换端口不用重启:

1. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`(大小写都认),配了 `NO_PROXY` 就按它绕
2. Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
   - `ProxyEnable` = 1 才用
   - `ProxyServer`:`127.0.0.1:7890` 或 `http=…;https=…;socks=…` 两种写法都认
   - `ProxyOverride` 当绕过列表
3. 设置 → 网络 → 手动填地址(覆盖上面两条)
4. 都没有就直连

只配了 `AutoConfigURL`(PAC 脚本)而没有 `ProxyServer` 时:**不猜**,记一条日志后直连。PAC 是一段 JS,自己实现不划算;这种环境下请到设置里手填代理地址。

启动和切源时日志里会有一行,能直接看出走了哪条:

```
PROXY route=http://127.0.0.1:7890 note=系统代理(注册表)
```

## FakeIP 为什么必须放行

Clash / sing-box 的 FakeIP 模式把域名解析到 `198.18.0.0/15`。这块地址属于保留段,常规 SSRF 防护会当内网拒掉 —— 结果是**代理配得越对,请求越全被拦**。

所以 `core/src/net/policy.rs` 明确把这一段列为例外,同时保留其余黑名单(`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`169.254.*`、`100.64-127.*`、`::1`、`fe80:`、`fc00:`、`fd00:`)。另一个坑是 DNS 同时返回 IPv4 与 IPv6:FakeIP 只出现在 IPv4 上,若因为那条被拦的 IPv6 整个拒绝,同样会误伤 —— 只要有一条可用 IPv4,就把不该连的 IPv6 摘掉继续。

## 超时与重试

| 场景 | 连接 | 整体 |
| --- | --- | --- |
| 普通请求(接口 / 分享页 / 清单) | 10s | 20s |
| 媒体流(反代) | 10s | 不设(一部电影可能两小时) |

GET 失败重试一次,间隔 800ms;POST 不重试。

## 验证

```
cargo test -p reelbox-core        # 87 passed,其中 net::proxy / net::policy 覆盖代理与 FakeIP
```

手动:设置 → 网络,顶部会显示当前生效的出口;关掉代理再打开列表,日志里的报错会从
`NETWORK: 连不上(检查代理)` 变成能出数据。
