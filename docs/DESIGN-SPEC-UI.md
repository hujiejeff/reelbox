# Reelbox UI 设计规格 · 设置二级页 / 源管理 / 直播

版本 v1.0 · 评审范围:`ui/index.html`、`ui/app.js`、`ui/theme.js`
底座:m3e(Material 3 Expressive)+ Material You 动态取色(`--m3e-sys-color-*`)
交付对象:开发(结构、数值、状态、动效一一可落)

文中所有数值单位是 dp,1dp = 1px(桌面 1x);所有颜色只写**角色令牌**,不写十六进制,以保证 8 个种子色 × 5 种风格 × 明/暗/纯黑全部可用。

---

## 0. 评审结论(先看这 8 条)

**必须改(与本次方向冲突 / 语义错)**

| # | 现状 | 问题 | 结论 |
|---|---|---|---|
| 1 | 设置 = 左锚点 sticky 导航 + 五张 `m3e-card` 分区卡,窄屏折成顶部横向 chip | 卡片套卡片、一屏内滚动五张卡,是"仪表盘"不是"设置";chip 横向滚动藏分区 | 按 §1 改为**入口列表 + 整屏二级页**;卡片只保留在"独立信息块"(关于页)内 |
| 2 | 源管理页顶部有「当前源」`<select>` | 与列表点击选源重复,两个入口同一动作 | 删掉 select。**行点击 = 设为当前源**,更多菜单里做编辑/停用/删除 |
| 3 | 当前源整行铺 `secondary-container` | 与"选中态/悬停态"争同一语义,多个源时整屏发亮 | 改为**图标容器着色 + 标题加粗**,行底不铺色(§2.4) |
| 4 | 首页小分类用 `m3e-filter-chip` + `<input type=checkbox>` 做**单选** | checkbox 语义是多选,读屏会报"复选框已选中",与"只能选一个"矛盾 | 单选一律用 `role=radio` 的 chip;见 §6.11 统一 `.chiprow--single` |
| 5 | `.seg` / `.set-tab` 用 `aria-selected` 但无 `role=tab/tablist` | 语义不成组,键盘 Tab 逐项跳 5 次 | 加 `role="tablist"` + `role="tab"` + `aria-selected`,并支持 ←/→ 移动焦点 |
| 6 | 播放器里同时存在两套控件(`.p-top/.p-bottom` 与 `.player-head/.pbtn/.pstate`) | 死代码,改规格时不知道该改哪套 | 保留 `.p-*` 一套,删除 `.player-head/.pbtn/.pstate` 及其 CSS |
| 7 | 顶栏源按钮 / 搜索框 44dp、播放器图标 38dp | 低于 48dp 最小可交互尺寸 | 视觉可 40,命中区补到 48(§7) |
| 8 | 骨架屏 1.8s 呼吸 | 与全站动效节奏不成体系 | 统一 1.6s,`cubic-bezier(.4,0,.6,1)`,透明度 1→.55(§7) |

**建议(不阻塞,但列入下一轮)**:把首页主搜索框 44 提到 56(`--m3e-comp-search-bar-container-height`);列表行间隙从 2 改 4 对齐 4dp 栅格;卡片 hover 抬升 3dp 收到 2dp。

---

## 1. 设置首页规格

### 1.1 结构

```
[Top app bar 56]  设置                                   ← 无返回(一级 tab)
[Scroll]
  ── 44 gap ──
  行:源        源管理 →      「星河影院 · 15 个源」  ›
  行:播放      播放与清晰度 →  「自动 · 连播开」      ›
  行:外观      主题与配色 →    「深色 · 紫 · 表现型」  ›
  ── 24 gap ──
  行:调试      日志与自检 →    「日志关闭」            ›
  行:关于      版本与致谢 →    「v0.4.2 · 11-14」      ›
  ── 24 gap ──
  [单行说明]  全部设置只作用于本机
```

分组规则:**源 / 播放 / 外观**(日常)× **调试 / 关于**(低频)两段,中间 24dp。分组本身不写标题(行数少),靠间距分段。

### 1.2 行规格(`.set-entry`)

| 项 | 数值 |
|---|---|
| 行高 | 72dp(两行文本,m3e `two-line-container-height`);标题单行 + 摘要单行,任一换行则 80dp 上限 |
| 行内边距 | 上下 10dp,左右 16dp(`padding-start/end = 16`) |
| 左图标容器 | 40×40dp,圆角 12dp(`corner-medium`),底 `surface-container-high`,图标 22dp、色 `on-surface-variant`;容器右间距 12dp(`between-space`) |
| 标题 | 16/24,字重 500,色 `on-surface`;两行封装 `title-medium` size/lh + 覆写 weight 600(CJK 惯例) |
| 摘要 | 14/20,字重 400,色 `on-surface-variant`,单行 `ellipsis`,与标题间距 2dp |
| 右侧值(可选) | 14/20,字重 400,`on-surface-variant`,最大宽度 40% 行宽,`ellipsis`;与 chevron 间距 8dp |
| Chevron | `chevron_right` 20dp,色 `on-surface-variant`,距行右边缘 12dp |
| 行间隙 | 4dp(同组) |
| 悬停/按压 | 底色 `surface-container-high`(120ms 渐入);按压再叠 `on-surface` 8% 状态层 |
| 焦点 | 3dp `secondary` 焦点环,外偏 2dp(`focus-indicator-*` 令牌) |

**"右图标容器"的用意**:容器 = "可进入的对象",与 §2.2 源列表项、§4 切源行形成同一套视觉语法(容器=入口,点/徽标=状态)。凡纯状态信息(状态点、徽标)**不许**加容器。

### 1.3 摘要文案规则(微文案)

一句话: **"当前值,不是功能名"**。最多 16 个汉字,超了截断,不换行。

| 行 | 摘要模板 | 示例 |
|---|---|---|
| 源 | `<当前源名> · <n> 个源` | 星河影院 · 15 个源 |
| 源(无源) | `未添加,点进去加一个` | — |
| 源(有直播源) | `<当前源名> · 15 源 · 直播 2` | 星河影院 · 15 源 · 直播 2 |
| 播放 | `<清晰度> · 连播<开/关>` | 自动 · 连播开 |
| 外观 | `<明暗> · <种子色名> · <风格>` | 深色 · 紫 · 表现型 |
| 调试 | `日志<开/关>` / `日志开 · 自检可用` | 日志关闭 |
| 关于 | `v<版本> · <MM-DD>` | v0.4.2 · 11-14 |

### 1.4 宽屏 master-detail

| 断点 | 布局 |
|---|---|
| < 600(compact) | 单列 push。设置首页 = 列表;点行**整屏推入**二级页,二级页左上 48dp 返回箭头(`arrow_back`),无 chevron 的行 |
| 600–839(medium) | 同 compact(push),但内容宽度 600dp 居中,左右各 24dp |
| ≥ 840(expanded) | master-detail 并置 |

expanded 具体数值:

- 左列(master)固定 **336dp**,内容上下 padding 16dp、左右 8dp;行 = 56dp 高、圆角 28dp(full)、左图标 24dp + 12dp + 14/20 标签;选中 = `secondary-container` 底 + `on-secondary-container` 字;行间隙 4dp。左列不显示摘要(摘要只在 compact/medium 的单列行里出现)。
- 分隔线:1dp `outline-variant`,沿整列高度(从 app bar 下沿到窗口底),位置在左列右边缘。
- 右列(detail):内容 `max-width: 720dp`,左对齐,`padding: 24dp 24dp 40dp`;顶部为二级页自己的 56dp 标题行(标题 + 该页操作),**不再有返回箭头**。
- 两列各自独立滚动,共用一条滚动条位置不联动。
- 从 A 页切到 B 页:右列内容 **150ms** 淡出淡入(`cubic-bezier(.31,.94,.34,1)`),不做位移;左列选中态指示器 **250ms** `cubic-bezier(.34,.88,.34,1)` 位移。
- 首次进入:左列默认选中「源」,右列直接渲染源管理页。

### 1.5 二级页外壳(`.set-page`)

| 区 | 数值 |
|---|---|
| Top app bar | 高 56dp;返回箭头 48×48dp 命中区(圆图标 40dp);标题 22/28 字重 600,与返回箭头间距 4dp;右侧最多 2 个 48dp 图标按钮,再多收进 `more_vert` |
| App bar 底色 | 滚动前透明(`surface`);滚动 > 8dp 后 `surface` + 1dp `outline-variant` 下边线,过渡 150ms |
| 内容区 | 左右 16dp(compact)/ 24dp(medium+);首块距 app bar 16dp;块与块(卡片 / 分组 / 说明文字)之间 24dp,由 `.set-page__body` 的 `gap` 统一给,元素自己不再叠 margin;底部为底栏留 88dp = 72 底栏 + 16 |
| 底栏(有主操作时) | 高 72dp,吸底,底 `surface`,顶 1dp `outline-variant`,左右 16dp,`safe-area-inset-bottom` 追加;主按钮 flex:1(最大 240dp),次按钮 auto,间距 8dp |
| push 转场 | 进入 300dp 位移(从右)+ 淡入,350ms `cubic-bezier(.38,1.21,.22,1)`;返回 250ms `cubic-bezier(.31,.94,.34,1)` |

---

## 2. 源管理页规格

### 2.1 页面骨架

```
[App bar 56]  ‹  源                     [全部测速][more_vert]
[分段 40]     ( 全部 15 )( 点播 11 )( 插件 2 )( 直播 2 )
[gap 12]
[列表 72/行]  容器|名称 徽标            ● ⋮
[gap 16]
[底栏 72]     [导入源(主,flex)] [批量导入(次)]
```

> 分段是 3 还是 4:产品定的是"三类源",但**列表默认要能看全**,所以实际给 4 段:`全部 / 点播 / 插件 / 直播`,首段叫「全部」而不是"点播",默认停在「全部」。理由:用户第一次进来最需要知道"我到底有几个源、都什么类型";默认停在点播会让插件/直播源像不存在。

### 2.2 分段控件(`.seg--count`)

| 项 | 数值 |
|---|---|
| 高 | 40dp(`--m3e-comp-segmented-button-min-height`),圆角 20dp(full) |
| 段间隙 | 2dp(m3e 令牌;唯一允许的非 4 倍数间距) |
| 段内边距 | 左右 12dp;label 与计数间 4dp |
| 文字 | 14/20 字重 500(`label-large`) |
| 计数 | 12/16 字重 500(`label-medium`),色 = 文字色 62% 不透明度(用 `color-mix` 或直接 `on-surface-variant`) |
| 未选中 | 1dp `outline-variant` 描边,底 transparent,字 `on-surface` |
| 选中 | 无描边,底 `secondary-container`,字 `on-secondary-container`,前置 `check` 18dp(与文字 6dp) |
| 为 0 的段 | 不隐藏、不禁用;计数写 `0`,点进去给空态 + 「添加直播源」CTA |
| 键盘 | `role=tablist`;←/→ 切段,**焦点跟随选中**(selection follows focus);`aria-controls` 指向列表 |
| compact(<600) | 四段等宽 `flex:1 1 0`,padding 收到 8dp;`check` 图标隐藏(等宽时挤),只靠底色区分 |
| ≥600 | 内容宽度自适应,左对齐,`check` 显示 |

计数数字口径:分段上的数字 = 该类型**源条目数**(含停用),不是频道数。停用源计入但标题旁用"已停用"标记(§2.5)。

### 2.3 源列表行(`.src-row`,基础 = m3e list-item 两行)

```
[容器40×40]  [名称 16/24 500]  [徽标]        [●状态点] [⋮ 40×40]
             [mono 11.5/16 地址单行截断]
```

| 项 | 数值 |
|---|---|
| 行高 | 72dp(两行);徽标换行时允许涨到 80dp,再高就截断标题到 1 行 |
| 行内边距 | 上下 10dp,左右 16dp;图标容器 → 文本 12dp;文本 → trailing 8dp |
| 图标容器 | 40×40dp,圆角 12dp,颜色按类型(§3) |
| 名称 | 16/24 字重 500,色 `on-surface`,单行 `ellipsis`;与徽标 8dp |
| 地址 | `ui-monospace` 11.5/16,色 `on-surface-variant`,**单行** `ellipsis`;协议头保留,不隐藏 http 标记 |
| 状态点 | 8dp 标记放在 16×16 命中区里,距「更多」8dp,与名称行垂直居中(不是行垂直居中) |
| 更多 | `m3e-icon-button` 40dp,`more_vert` 20dp,右边缘对齐行 padding;点击开 `m3e-menu` |
| 行间隙 | 4dp |
| 行底色 | 常态 transparent;hover/press = `surface-container-high` 状态层;选中(当前源)见 §2.4 |
| 停用行 | 整行 55% 不透明度,状态点不显示,名称后追加 `label-small` 「已停用」 |
| 点击行(非图标区) | = 设为当前源,写 localStorage,顶部 toast「已切换到 星河影院」+ 3s 内可撤销 |
| 徽标显示 | **始终显示文字徽标**,即使分段已锁定单一类型(切换分段时行结构不跳) |
| compact | 名称与徽标允许换行(名称结束、徽标落到下一行);地址行仍单行;「更多」保持 40dp;状态点保持 8dp;地址最大宽度 = 行宽 − 40(容器) − 12 − 8 − 40(更多) − 8 − 32 = 100% 减去固定部分 |

### 2.4 当前源的三处标记(不铺行底)

1. 图标容器:底 = `primary`,图标 = `on-primary`(其他行为类型色容器);
2. 名称:字重 500 → **600**;
3. 更多菜单里首项变为「已设为当前源」(`check` 图标,禁用态)。

### 2.5 状态点四态(形状 + 颜色双通道)

健康检查口径:最近一次探测「列表接口」的**首字节时间**。
`< 800ms` = 正常,`800–2000ms` = 慢,失败/超时(>5s)/非 2xx/解析失败 = 失败,从未探测 = 未测。

| 状态 | 形状(8dp) | 颜色角色 | 额外 | 文案(aria / tooltip) |
|---|---|---|---|---|
| 正常 | **实心圆** | `primary` | 无 | `正常 · 320ms` |
| 慢 | **实心圆 + 外环 2dp,外径 14dp** | 内 `tertiary`,外环 `tertiary` @38% | 无 | `偏慢 · 1.4s` |
| 失败 | **圆角方块(圆角 1.5dp)** | `error` | 无 | `连接失败 · 超时` |
| 未测 | **空心圆环(描边 1.5dp)** | `outline` | 内部透明 | `未测速` |

规则:形状承载"好/慢/坏/未知",颜色只做强化 —— 色弱用户与纯黑主题下都能区分。状态点**不用**绿色(方案里没有语义"成功"色,`primary` 随种子色变化已是本应用的"正向"色)。
进行中(正在测速):状态点位置换成 16dp `m3e-circular-progress`(2dp 线宽),测完淡入最终状态 200ms。

### 2.6 底部操作区(按钮层级)

| 层级 | 控件 | 规格 |
|---|---|---|
| 主 | **导入源** | `m3e-button` filled(底 `primary`,字 `on-primary`),高 40dp,圆角 20dp,`file_upload` 18dp + 8dp + 文字;flex:1,最大 240dp。单个源:地址或本地文件,判型后加一条并设为当前 |
| 次 | **批量导入** | `m3e-button--outlined`,高 40dp,圆角 20dp,`playlist_add` 18dp;宽度按文案自适应(最小 96dp)。集合/索引:带 `sources` / `sites` 数组的 JSON,一次加入多条 |
| 共用表单 | **两个对话框** | 同一套字段:地址框 / 名称框 / 「选择文件」;只有标题、提示文案和落地逻辑不同 |
| 文本 | **全部测速** | `m3e-button--text`,高 40dp,放在 app bar 右侧或列表状态汇总行末尾;不要放进底栏(底栏只留 2 个) |
| 底栏容器 | 高 72dp,吸底,底 `surface`,顶部 1dp `outline-variant`;compact 时主按钮撑满、次按钮按文案自适应(最小 96dp) |
| 顺序 | LTR 主在左、次在右;不并排放两个 filled |

导入结果反馈:批量走 snackbar「新增 6 个,跳过 2 个,当前共 15 个源」;单条走「导入源」→ 设当前源 → 原有切换源提示。判型失败才出一次手选(只在插件 / XML / JSON 三项里选)。

---

## 3. 三类源徽标规范

### 3.1 类型 → 图标 / 颜色 / 文案

| 类型 | 图标(Material Symbols) | 图标容器(40×40, r12) | 徽标(高 24, r8) | 文字标签 |
|---|---|---|---|---|
| 点播 | `ondemand_video`(回退 `smart_display`) | 底 `secondary-container`,图标 `on-secondary-container` | 底 `secondary-container`,字 `on-secondary-container` | **点播** |
| 插件 | `extension` | 底 `tertiary-container`,图标 `on-tertiary-container` | 底 `tertiary-container`,字 `on-tertiary-container` | **插件** |
| 直播 | `live_tv`(回退 `sensors`) | 底 `error-container`,图标 `on-error-container` | 底 `error-container`,字 `on-error-container` | **直播** |

### 3.2 颜色分配的唯一原则

`primary` 已被占用为「当前源 + 主按钮 + 焦点」,**不能**再给类型。于是:

- 点播 → `secondary` 族(系统的第二色,量大、最中性)
- 插件 → `tertiary` 族(第三色,数量少、需要区分)
- 直播 → `error` 族(方案里唯一的高注意色;直播 = 不可回看、错过即失去,与"注意"同族)

直播用 error 族是**唯一一处语义借用**,必须两档:
- **列表/徽标**用 `error-container` + `on-error-container`(浅底,安静);
- **播放器内 LIVE 徽标**用 `error` 实底 + `on-error` 字(高对比,压在视频上)。
同一色族、两档明度,不新增颜色。

### 3.3 徽标形状与文字

- 高 24dp,左右 padding 8dp,圆角 8dp(`corner-small`),图标 14dp + 4dp + 文字 12/16 字重 500(`label-medium`),字距 `.02em`。
- **必须有文字**:中文字形信息密度高,"点播/插件/直播"两字 24dp 高放得下,且比纯图标少一次学习成本;纯图标只在 ≥840 的左列 nav 与切源面板的 leading 位使用(那里有成组语义)。
- 技术子类型(`JSON` / `XML` / `.webox.js`)不进徽标。放两处:编辑对话框的字段说明、更多菜单的「详细信息」。理由:徽标只回答"这源怎么播",技术协议不改变用户决策。
- 异常徽标:「取不到数据」(HTML 爬取配置)底色 `error-container`、字 `on-error-container`,与「直播」同色 —— 因此**两者不同时出现**(爬取配置不可能是直播源),不冲突。

---

## 4. 手机端切源 Bottom Sheet

### 4.1 触发与容器

- 触发:顶栏源按钮(`.src-btn`,视觉 40dp 高、命中区 48dp,内容 = 当前源名 16/24 600 + `arrow_drop_down` 20dp)。
- 容器:`m3e-bottom-sheet m3e-bottom-sheet--modal` + `__scrim` + `__sheet` + `__handle`/`__handle-bar`;点 scrim 关闭,`Esc` 关闭,焦点锁在 sheet 内,打开时 body 滚动锁死。
- 适用断点:**< 840 用 sheet;≥ 840 用左侧栏内联面板**(同一份 DOM 内容,只换宿主容器;桌面不做底部弹层)。
- scrim:`scrim` 色,不透明度 32%(m3e 令牌)。

### 4.2 尺寸

| 项 | 数值 |
|---|---|
| 宽度 | 100%,`max-width: 640dp` 居中(m3e 令牌) |
| 顶部圆角 | 28dp(左右两个上角,下角 0) |
| 初始高度 | `min(内容高, 60vh)`,下限 344dp(把手 48 + 标题 56 + 搜索 48 + 分组标题 32 + 2.5 行) |
| 展开高度 | `min(内容高, 90vh)`,超出内部滚动 |
| 内容不足时 | 高度 = 内容高 + 16dp 底 padding,不做最小高度撑满 |
| 底 padding | 16dp + `safe-area-inset-bottom` |
| 拖拽把手 | 32×4dp,圆角 full,色 `on-surface-variant`(m3e 令牌);上下 padding 22dp → 把手区总高 48dp |
| 关闭手势 | 位移 > 56dp 或速度 > 125(均来自 m3e 令牌) |
| 打开动效 | 475ms(`--m3e-comp-bottom-sheet-show-*`,弹簧 default spatial,`cubic-bezier(.38,1.21,.22,1)`);scrim 250ms 同步 |
| 关闭动效 | 149ms(`fast effects`,`cubic-bezier(.31,.94,.34,1)`);选中源后**立即**走关闭动效 |

### 4.3 内部顺序(自上而下)

1. 把手区 48dp
2. **标题行** 56dp:左「切换源」16/24 字重 600;右侧「管理」`m3e-button--text`(16dp 内边距,点它 = 关闭 sheet + 进源管理页)
3. **搜索框** 48dp(圆角 full,底 `surface-container-high`,`search` 20dp + 8 + input 15/20,占位「搜索源名称或地址」)。**源总数 < 8 时整块隐藏**(留白 8dp),搜索框的出现与否不改变下方分组的位置
4. 8dp
5. **点播** 分组标题 + 行
6. **插件** 分组标题 + 行
7. **直播** 分组标题 + 行(无直播源时整组不出现)
8. 空态:居中 `playlist_add` 40dp + 「还没有源」16/24 + 一句「点「导入源」加一个接口地址,也可以批量导入集合」14/20 + 「导入源」filled 按钮(点它 = 关闭 sheet + 打开「导入源」对话框)。有源但没有一个能用于当前功能时,空态换成「没有可用的源」+ 说明,按钮不变

> 分组只有**类型**这一种口径(点播 / 插件 / 直播)。不记「最近使用」,也没有 LRU 历史分组。

### 4.4 分组标题

12/16 字重 600,色 `on-surface-variant`,字距 `.03125rem`(label-medium 令牌),高 32dp,**不做**全大写 transform(中文无意义)。分组之间 8dp;第一组标题上方 4dp。分组标题是 sticky 的吗?**不是** —— sheet 高度有限,sticky 会吃掉两行空间。

### 4.5 行规格(切源面板行,比源管理页更轻)

| 项 | 数值 |
|---|---|
| 行高 | 56dp |
| 圆角 | 28dp(full),行间隙 2dp |
| 内边距 | 左右 16dp |
| Leading | 类型图标 **18dp**(不套容器,面板里 4 组并列时容器会显得噪) + 12dp |
| 名称 | 16/24 字重 500,单行 `ellipsis` |
| Trailing | 状态点 8dp + 8dp + `check` 20dp(`primary`,仅当前源) |
| 当前源 | 底 `secondary-container`,字 `on-secondary-container`,左侧 `check` 不用 `check_circle`(形状低调);同时**置顶到其所属分组第一行** |
| 停用源 | 不出现(停用源不可选);若当前源被停用,面板顶部显示一条 40dp 提示行「当前源已停用,选一个可用的」底 `error-container` |
| 空搜索 | 面板内显示「没找到 'xxx'」+ 「换个词」,不高亮 |

**只列有效的源**:面板只画「可用于当前功能」的源 —— 类型是已支持的三类(点播 JSON / 点播 XML / 插件 JS),且不是 HTML 爬取配置(那类 `.json` 里是爬虫规则,不是接口地址)。健康检查失败(`health.ok === false`)**不隐藏**,行尾照常给失败状态点:那是「现在坏了」,不是「不可用」,用户需要知道。判定收敛在 `ui/app.js` 的 `isUsableSource()` 一处,面板与别处不再各写一套;源管理页仍列出全部源。

---

## 5. 直播 tab 与 live 播放器

### 5.1 第 4 个 tab 的出现条件

- 条件:`启用中 && kind=live` 的源数量 ≥ 1。
- 顺序:**首页 · 直播 · 喜欢 · 设置**(内容类相邻,设置永远最后)。直播缺席时其余三项顺序不变。
- 出现在窄屏 `float-tabs`(floating toolbar 4 个图标,每组仍 40dp,整体宽度 4×48 + 内边距,`bottom: 18dp` 不变)、medium `m3e-navigation-rail`、expanded 左栏 nav 三处同步。
- 无入场动画(导航栏重排不做位移动画),但需防抖:源启用状态变化 → 下一次进入非直播视图时才重建 nav,避免正在看的页面抖动。
- 当前在直播 tab 且直播源被全部停用/删除 → 自动回首页 + snackbar「没有可用的直播源了」+「去添加」。
- 直播 tab 自身也支持"无频道"空态(源在但拉不到频道):`state` 卡片 + 「重试」+「换源」。

### 5.2 频道网格

**卡片比例:16:9 横版,不用 2:3 海报。** 理由:电视台标是方形/透明 PNG,直播内容本身是横画面;用竖版海报会逼设计去裁台标,而且直播 tab 与首页的海报墙形成正确的"气质区分"。

| 项 | 数值 |
|---|---|
| 卡片 | 16:9,圆角 16dp(`corner-large`),底 `surface-container-high`,内 padding 16dp |
| 台标 | `object-fit: contain`,最大高度 = 卡片高 56%,水平居中;不裁切、不加描边;加载失败降级为频道名首字(24/32 字重 600,`on-surface-variant`) |
| 角标 | 右上角 8dp `error` 圆点(距边 8dp),**不写 LIVE 字样**(在直播 tab 里是废话) |
| 名称 | 卡片下 8dp,14/20 字重 500,单行 `ellipsis`,居中 |
| 网格 | compact 2 列(gap 12);600–839 3 列(gap 16);≥840 `repeat(auto-fill, minmax(200dp,1fr))`(gap 16),最大 5 列,容器 `max-width: 1290dp` 居中 |
| hover(桌面) | 卡片 `elevation-level1` → `level2`,台标 `scale(1.03)`,180ms `cubic-bezier(.38,1.21,.22,1)` |
| 三态 | 加载 = 6 个 `.skel--tile`(16:9 + 一行 12dp 条);空 = `state` 卡片;错误 = `state--error` + 「重试」 |

### 5.3 分组 chip 行

- 单选,不是多选。**不要复用 `m3e-filter-chip`(它必须带 checkbox)**,改用 `m3e-assist-chip` 视觉 + `role=radio` 语义的 `.chiprow--single`(见 §6.11),同时把首页小分类迁移到同一组件(§0-4)。
- chip:高 32dp(compact 36dp 便于拇指),圆角 full,左右 padding 12dp,文字 14/20 字重 500;未选 1dp `outline-variant` 描边 + transparent;选中 `secondary-container` 底、无描边。
- 「全部」常驻最左;分组来自源返回的 group 字段,按返回顺序,不排序。
- 行:横向滚动,左右 padding 16dp,chip 间 8dp,行高 48dp(含上下 8dp);滚动边缘加 16dp 渐隐遮罩;首尾各留 16dp。
- 分组数量 ≤ 4 时禁用滚动,`flex-wrap: nowrap` 且自适应等分。

### 5.4 live 播放器

复用同一 `.player` 容器,`data-mode="live"` 走变体;差异如下。

| 区域 | 点播 | 直播 |
|---|---|---|
| 顶栏 | 返回 + 标题 + 画质 | 返回 + **LIVE 徽标** + 频道名(可截断) + 右侧:`refresh`(重连)/画质 |
| 进度条 | `.p-seek` 4dp(悬停 7dp)+ 时间码 | **整块移除**,`.p-bottom` 顶部 padding 从 40 降到 24(渐变仍从 96dp 起,保持视觉重心低) |
| 底部行 | 上/播放/下 + 时间 + 音量 + 全屏,高 48dp | 播放/暂停 40 + 10 + `LIVE` 小徽标(可选,顶栏已有时省略)+ 10 + 频道名(14/20 单行)+ flex + 画质 + 音量 + 「频道」(`view_list`)+ 全屏,高 48dp |
| 中央大按钮 | 78dp 圆,`rgba(0,0,0,.66)` | 同尺寸同底色;仅"暂停/播放"两态,无重播图标 |
| 自动隐藏 | 3s 无操作 | 3s 无操作;但**暂停时永久显示**(直播暂停一般就是缓冲暂停) |
| 断流 | 失败卡片(重试/换线路) | 中央 pill「重连中… 第 2 次」→ 连续 60s 未恢复换失败卡片(重试/换个频道) |
| 键盘 | ←/→ 快进退 | ←/→ **换频道**(不改播放进度,直播无进度);`PageUp/PageDown` 切分组 |

**LIVE 徽标的样式与位置**

- 位置:顶栏,紧贴返回按钮右侧(第 2 个元素),不放在底部、不浮在画面中央。
- 样式:高 20dp,左右 padding 8dp,圆角 6dp,底 `--m3e-sys-color-error`,字 `on-error`,`label-medium` 11/16 字重 700,字距 `.06em`,内容 = 6dp 圆点(白/`on-error`)+ 5dp + 文字 `LIVE`。
- 呼吸:圆点 opacity `.35 → 1`,周期 2000ms,`cubic-bezier(.4,0,.6,1)`,无限;`prefers-reduced-motion` 时静止在 1。文字不呼吸。
- 频道名换行时,徽标不换行(`flex:none`)。

**频道切换控件位置**

| 断点 | 形态 |
|---|---|
| < 840 | 底部「频道」按钮 → **bottom sheet**(60vh,复用 §4 的把手/标题/搜索结构,标题「频道」,分组 chip 行在 sheet 顶部横向,行 = 56dp,leading 24dp 台标(圆角 4dp,`contain`)+ 名称,当前频道 trailing `check`)。选中后自动关闭(149ms)并起播 |
| ≥ 840 | 右侧 `m3e-side-sheet`,宽 360dp,`elevation-level1`,顶部 56dp 标题「频道」+ 关闭;不遮挡画面主体(视频 `object-fit: contain` 居中,侧板在原画面区域内右对齐,不改变视频缩放) |

**与点播播放器的视觉差异度评估**

| 维度 | 差异 |
|---|---|
| 颜色体系 | 0 —— 全部沿用播放器现有的黑底 + `primary` 强调 |
| 顶栏结构 | +1 元素(LIVE 徽标),其余同 |
| 底部栏 | 结构差异显著:去掉 seek/时间码,加频道入口。**这是唯一的强差异** |
| 交互模型 | 无 seek、无上下集、无倍速(直播不需要),属于"减法差异",不需要新视觉 |
| 中央按钮 | 0 差异 |

结论:**整体差异度约 30%**,足以让用户"一眼知道这是直播"(LIVE 徽标 + 没有进度条 + 频道入口),但不构成第二套播放器视觉。刻意不做的:不换配色、不做"直播专属"控件外观、不加直播水印。

---

## 6. 组件清单

### 6.1 直接用 m3e(不改结构,只加类)

| 组件 | 用在哪 | 注意 |
|---|---|---|
| `m3e-list-item`(两行) | 设置首页行、源列表行 | 行高 72 来自令牌,不要自定义 |
| `m3e-icon-button`(standard) | 返回、更多、播放器图标 | 视觉 40,命中区补 48 |
| `m3e-switch` | 播放/外观设置项 | 已有 `__track/__handle` |
| `m3e-filter-chip` | 首页多选场景(暂留) | 单选场景按 §6.11 迁移 |
| `m3e-circular-progress` | 测速中状态点 | 16dp,2dp 线宽 |
| `m3e-linear-progress` | 列表翻页/批量导入进度 | 放 app bar 下 4dp 处,不占布局 |
| `m3e-dialog` + `m3e-button--text` | 添加/编辑/删除源 | 复用 `ui-dialog.js` |
| `m3e-snackbar` | 切换源、导入结果 | host z-index 320(已有) |
| `m3e-bottom-sheet`(--modal) | 切源、频道面板 | 只提供结构与过渡令牌,拖拽手势需自建(见 6.12) |
| `m3e-menu` | 行「更多」、导入菜单 | 容器圆角 12dp(令牌是 4dp,这里刻意覆写,与卡片族一致) |
| `m3e-badge` | 直播红点(卡角) | 用 8dp 圆点形态,不写数字 |
| `m3e-side-sheet` | ≥840 频道面板 | 宽 360dp |
| `m3e-card--outlined` | 仅"关于"页的信息块、空/错误态容器 | 二级页主体**不用卡** |

### 6.2 需要自建(结构 + 关键规则)

1. **`.set-entry`** 设置首页行
   结构:`[icon-box 40×40][text(title+summary)][value?][chevron 20]`;规则见 §1.2。可直接挂在 `m3e-list-item` 结构上,把 trailing 换成 value+chevron 组合。
2. **`.set-page`** 二级页外壳
   结构:`[app-bar(back?+title+actions)][scroll][footer?]`;滚动侦测 > 8dp 加下边线;push 转场由 `.set-page[data-enter]` 控制。
3. **`.seg--count`** 带计数的分段
   结构:`div[role=tablist] > button[role=tab][aria-selected] > span.seg__label + span.seg__count`;compact 下 `flex:1`,≥600 内容宽。**不要**用 `<input>`。
4. **`.src-row`** 源列表行
   结构:`[icon-box(类型色)][content(name+badge / url)][status-dot][icon-button(more)]`;行高 72,点击区排除 trailing。
5. **`.type-badge`** 类型徽标
   结构:`span.type-badge[data-type] > span.m3e-icon + span.label`;颜色映射见 §3.1,用 `[data-type]` 属性选择器,不写内联色。
6. **`.status-dot[data-state]`** 四态状态点
   结构:`span.status-dot[data-state=ok|slow|fail|untested][role=img][aria-label]`;四态形状见 §2.5;`::after` 做慢速外环。
7. **`.src-panel`** 切源面板内容(容器无关)
   结构:`header(title+manage) + search? + group×n(h + row×n)`;同一 DOM 分别挂进 `<dialog class="m3e-bottom-sheet">` 或侧栏弹出层。行样式 `.src-panel__row`。
8. **`.live-grid` / `.ch-card`** 频道网格与卡片
   结构:`a.ch-card > div.logo(img|span.fallback) + span.dot + span.name`;`aspect-ratio: 16/9` 在 logo 区,名称在卡外。
9. **`.live-badge`** LIVE 徽标
   结构:`span.live-badge > i.dot + span.text`;尺寸/颜色/呼吸见 §5.4。播放器内与顶栏注释共用同一类。
10. **`.p-live-bar`** 直播底栏
    结构:`button.p-icon(play) + span.live-badge(sm) + span.ch-name + span.gap + button(quality) + button(channels) + button(volume) + button(fullscreen)`;高 48dp,`.p-bottom` 变体去掉 seek 时顶部 padding 40 → 24。
11. **`.chiprow--single`** 单选 chip 行
    结构:`div[role=radiogroup] > button[role=radio][aria-checked]`;视觉同 assist-chip;单选语义。首页小分类与直播分组共用。
12. **sheet 拖拽手势**(约 80 行 JS)
    m3e 的 bottom-sheet 只提供 `--_m3e-bs-translate`、`[data-dragging]`、阈值令牌;需自建:pointerdown 在把手区或内容顶部 8dp 内启用,跟手位移,rubber-band 用 `boundary-dampening-zone: 125px`,释放时按 56dp / 125 速度判定。
13. **骨架屏扩展**
    `.skel--row`(72dp 行:40×40 圆 + 2 条 12dp 线)、`.skel--tile`(16:9 + 12dp 条)、`.skel--chip`(32dp 圆角条)。共用 1.6s 脉冲。

### 6.3 建议删除 / 合并

- `.player-head`、`.pbtn`、`.ptitle`、`.pstate` 全组(死代码,与 `.p-*` 重复)。
- `.set-tab` 与 `.set-nav`(被 `.set-entry` + 二级页替代)。
- `.srcmenu` 自绘弹层(< 840 用 sheet;≥840 用 `.src-panel` 挂载在侧栏),不再维护第三套弹层样式。
- `.srcmgr-bar` 里 4 个并排 `.btn-soft`(收成 主+次 两个)。
- 源管理页顶部 `#curSource` 的 `<select>`(见 §0-2)。

---

## 7. 视觉一致性检查表

### 7.1 字号层级(6 级 + 2 例外,全部对应 m3e typescale 令牌)

| 用途 | 尺寸/行高 | 字重 | 字距 | 令牌 |
|---|---|---|---|---|
| 二级页标题 / 空态标题 | 22 / 28 | 600 | 0 | `title-large` |
| 行标题、频道名、sheet 标题 | 16 / 24 | 500(当前源 600) | 0 | `body-large` |
| 行摘要、地址说明、正文 | 14 / 20 | 400 | 0 | `body-medium` |
| 按钮文字、chip、分段文字、更多菜单 | 14 / 20 | 500 | 0 | `label-large` |
| 徽标文字、状态文案、分组计数 | 12 / 16 | 500 | .02em | `label-medium` |
| 分组小标题 / overline | 11 / 16 | 600 | .04em | `label-small` |
| 例外 1:URL / 路径 / 日志 | 11.5 / 16 | 400 | 0 | 自建 `ui-monospace` |
| 例外 2:LIVE 徽标 | 11 / 16 | 700 | .06em | `label-small` + 覆写 |

规则:中文 `letter-spacing: 0`(只有 overline 与 LIVE 徽标例外);行高必须是 m3e 令牌值,不手写 `1.4`;`clamp` 行数用 `-webkit-line-clamp`,最多 2 行。

### 7.2 间距节奏(4dp 基准)

允许值:**4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64**。
唯一例外:**2dp**(分段控件段间隙、切源面板行间隙,来自 m3e 令牌)。

| 位置 | 数值 |
|---|---|
| 页面左右内边距 | 16(compact)/ 24(medium+) |
| 行与行 | 4 |
| 行内 leading→文本 | 12 |
| 文本→徽标 | 8 |
| 分组之间 | 24 |
| 分组标题→首行 | 8 |
| 卡片内边距 | 20(≥600)/ 16(compact) |
| 网格 gap | 12(compact)/ 16(中/宽) |
| 底栏高 | 72(主操作区)/ 56(仅文本操作) |
| 顶部 app bar 高 | 56 |
| 触摸最小尺寸 | 48 × 48(视觉可 40) |

### 7.3 圆角

| 用途 | 值 | 令牌 |
|---|---|---|
| 徽标 / chip(小) | 8 | `corner-small` |
| 图标容器 / 输入框 / 菜单 | 12 | `corner-medium` |
| 源列表行 / 卡片 / 频道卡 / 分组块 | 16 | `corner-large` |
| 按钮(40dp 高)、分段、导航 pill | 20 = full(h/2) | `corner-full` |
| 按钮(56dp 高)、导航行(56dp) | 28 = full | `corner-full` |
| 弹层(bottom sheet 顶角)、dialog | 28 | `corner-extra-large` |
| 台标小图 | 4 | `corner-extra-small` |
| 行内小方块(失败状态点) | 1.5 | — |

禁止:同一屏出现 4dp 圆角的容器(除台标缩略);圆角不得为奇数(1.5 只用于 8dp 状态点内部)。

### 7.4 状态色

| 语义 | 颜色角色 | 用在哪 |
|---|---|---|
| 正常 / 当前 / 主操作 | `primary` | 正常状态点、当前源容器、主按钮、焦点、选中 check |
| 选中容器 / 当前行 | `secondary-container` + `on-secondary-container` | 分段选中、导航选中、sheet 当前源 |
| 类型-点播 | `secondary-container` / `on-secondary-container` | 徽标、图标容器 |
| 类型-插件 | `tertiary-container` / `on-tertiary-container` | 徽标、图标容器 |
| 类型-直播 / 直播徽标 | `error-container` / `on-error-container`;播放器内 `error` / `on-error` | 徽标、LIVE 徽标 |
| 失败 / 错误 | `error` | 状态点、错误文案、危险按钮文字 |
| 未测 / 次要 | `outline` / `on-surface-variant` | 空心状态点、摘要、地址 |
| 禁用 | 内容 38% 不透明(`state-disabled-alpha`) | 禁用行、禁用按钮 |
| 底色层 | `surface` → `-container-low/-high/-highest` | 页面 / 侧栏 / hover / 徽标底 |
| 分隔 | `outline-variant` 1dp | 列分隔、底栏上边、app bar 下边 |

规则:**不许出现语义外的十六进制色**(现有 `.badge` 的 `rgba(0,0,0,.58)`、`.p-fail__head` 的 `#ffb4ab` 属例外,原因是压在视频上;需在代码里加注释说明理由)。

### 7.5 动效

| 场景 | 时长 | 缓动 |
|---|---|---|
| 状态层(hover/press)渐入 | 120ms | `cubic-bezier(.2,0,0,1)` |
| 状态层渐出 | 100ms | `linear` |
| 分段/导航选中指示位移 | 250ms | `cubic-bezier(.34,.88,.34,1)`(slow effects) |
| master-detail 内容切换 | 150ms | `cubic-bezier(.31,.94,.34,1)`(fast effects) |
| 二级页 push 进入 | 350ms | `cubic-bezier(.38,1.21,.22,1)`(fast spatial) |
| 二级页返回 | 250ms | `cubic-bezier(.31,.94,.34,1)` |
| Bottom sheet 打开 | 475ms | `cubic-bezier(.38,1.21,.22,1)`(m3e `show-*` 令牌) |
| Bottom sheet 关闭 | 149ms | `cubic-bezier(.31,.94,.34,1)`(m3e `hide-*` 令牌) |
| scrim 淡入淡出 | 250ms | `cubic-bezier(.2,0,0,1)` |
| 卡片 hover 抬升 | 180ms | `cubic-bezier(.38,1.21,.22,1)`,位移 2dp,阴影 level1→level2 |
| 台标 hover 缩放 | 180ms | 同上,`scale(1.03)` |
| 骨架屏脉冲 | 1600ms 循环 | `cubic-bezier(.4,0,.6,1)`,opacity 1 → .55 |
| LIVE 圆点呼吸 | 2000ms 循环 | `cubic-bezier(.4,0,.6,1)`,opacity .35 → 1 |
| 状态点切换(测速完成) | 200ms | `cubic-bezier(.2,0,0,1)` |
| 播放器控件淡出 | 250ms | `cubic-bezier(.2,0,0,1)`;3s 无操作触发 |
| Snackbar 进出 | 300 / 200ms | `cubic-bezier(.2,0,0,1)` |

`prefers-reduced-motion: reduce` 时:所有位移动画 → 0ms,只保留 ≤ 150ms 的透明度过渡;呼吸/脉冲动画改为静态最明显状态(透明度 1)。

### 7.6 断点收起表(必查)

| 元素 | < 600 | 600–839 | ≥ 840 |
|---|---|---|---|
| 设置导航 | 入口列表 push(返回箭头) | 入口列表 push(内容宽 600 居中) | master-detail(左 336 / 右 720) |
| 行摘要 | 显示,单行截断 | 显示 | 左列不显示,右列内部显示 |
| 分段控件 | 4 段等宽,隐藏 check | 内容宽,显示 check | 同中屏 |
| 源行徽标文字 | 保留(允许换行) | 保留 | 保留 |
| 源行状态点 | 保留 8dp | 保留 | 保留 + tooltip |
| 底栏按钮 | 主 flex:1 + 次 96dp | 主 240 + 次 auto | 右对齐,主 240 |
| 切源 | Bottom sheet | Bottom sheet | 侧栏内联面板 |
| 频道切换 | Bottom sheet 60vh | Bottom sheet 60vh | side-sheet 360dp |
| 频道网格 | 2 列 / gap 12 | 3 列 / gap 16 | auto-fill minmax(200,1fr) ≤ 5 列 |
| 分组 chip 高 | 36 | 32 | 32 |
| 播放器底部栏 | 高 48,只留 5 个控件,音量收进静音长按 | 同 | 同 + hover 音量浮层 |
| 主导航 | floating toolbar(4 icon) | navigation-rail(4 item) | 左栏 nav(4 行) |

---

## 附 A. 代码落点(给开发的对照表)

| 规格 | 文件 / 位置 |
|---|---|
| 设置首页 + 二级页外壳 | `index.html` `#v-settings` 重写;`app.js` `setSettingsSection` → `openSetPage(key)` + `SET_PAGES` 注册表 |
| 源管理 | `app.js` `renderSourceManager` 重写为 `renderSrcPage()`;新增 `srcHealth` 内存表(测速结果) |
| 分段/筛选态 | 新增 `S.srcFilter`(默认 `all`),不持久化到磁盘,持久化到 localStorage |
| 切源 sheet | 新增 `ui/src-panel.js`(内容)+ `ui/sheet.js`(拖拽 + 焦点锁),容器无关 |
| 直播 tab | `app.js` `showView` 增 `live`;nav 构建函数抽 `renderNav()` 供三端复用;`S.hasLive` 由源列表派生 |
| live 播放器 | `index.html` `.player[data-mode=live]` 变体 + `app.js` `bindPlayerLive()` |
| 令牌 | 全部走 `theme.js` 已注入的 `--m3e-sys-color-*`;不要在 CSS 里写死颜色 |

## 附 B. 验收清单

1. 8 个种子色 × 5 种风格 × {亮, 暗, 纯黑} 下,§7.4 的每一行都只看角色令牌 —— 无硬编码色残留在新增区域。
2. 三类徽标在纯黑 + 单色(mono)风格下仍然可辨(靠文字标签)。
3. 状态点四态在灰度截图下仍可区分(形状差异)。
4. 360×640 视口:设置首页 5 行不滚动即见;源管理页分段 4 段不换行;切源 sheet 默认高度内可见 ≥ 2.5 行;频道网格 2 列不溢出。
5. 键盘:Tab 顺序 = app bar → 分段 → 列表 → 底栏;←/→ 在分段与 chip 行内移动;Esc 关 sheet/dialog。
6. 触摸目标全部 ≥ 48dp(用 `getBoundingClientRect` 抽查播放器图标、状态点、更多按钮)。
7. `prefers-reduced-motion` 下无位移动画、无呼吸动画。
8. 无直播源时:nav 只有 3 项,无「直播」残留空白;启用一个直播源后 4 项出现且顺序正确。
