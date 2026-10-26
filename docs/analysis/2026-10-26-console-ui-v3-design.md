# 控制台全局 UI v3 · 设计稿说明（2026-10-26）

- **产物**：`dsh-plugin/console-demo-v3.html`（单文件，约 220 KB；7 页 + 人设工作室 8 页签；深/浅色；真实快照数据）
- **数据管线**：`dsh-plugin/scripts/lib/console-demo-data.mjs` + `inject-console-demo.mjs`（`npm run demo:console`）
- **校验**：`dsh-plugin/scripts/verify-console-demo.mjs`（`npm run demo:console:verify`，16 项）
- **前身**：`persona-studio-demo.html`（只有人设工作室一页，全局壳是占位）与 `docs/demo/bili-fenshen-console.html`（V2 设计预览）
- **状态**：设计稿，**尚未接入插件真实页面**；真实控制台仍是 `client.js` 的「看板 + 操作台（配置/实时/日志/判重表/产物 + 人设）」

---

## 1. 为什么需要一版"全局"设计稿

V2 的两个演示各自只解决了一半问题：

| 已有产物 | 覆盖 | 缺什么 |
|---|---|---|
| `docs/demo/bili-fenshen-console.html`（10-22） | 全局壳 + 看板 + 操作台静态排版 | 无真实数据、无交互、无浅色、无人设模块 |
| `persona-studio-demo.html`（10-26） | 人设工作室 8 页签、真实编译数据 | 侧栏/导航/账号/值班都是装饰；无法回答"放进控制台长什么样" |

同时真实控制台 `client.js` 的样式是从 V2 demo 移植的，存在几个只在"全页面"尺度才暴露的问题：

1. **视觉层级漂移**：页面标题 18px、卡片标题 13px、正文 12.5–13px、注释 11–12px 混用，同级元素在不同页字号不一致；
2. **色彩不是一套**：人设页的绿色预算条、看板的蓝色进度条、状态色各自为政；浅色/深色没有验证过；
3. **全局状态缺位**：账号、值班、下一轮、数据快照散落在各页，导航栏只有图标；
4. **空/错/降级状态缺失**：没有入站数据时仍然画一张全 0 图表，而不是解释"为什么是 0"；
5. **可移植性差**：V2 demo 的类名/token 与 `client.js` 不同名，设计通过后需要二次翻译。

V3 的目标：**一份能评审、也能按图施工的全局稿**——同一套 token/组件/页面结构，移植时只做"删演示数据 + 接端点"。

---

## 2. 设计决策（逐条）

### 2.1 Token：与宿主 DSH 同名

演示稿内部定义 `--dsw-*` 别名（与 `client.js` 完全相同的 26 个宿主 token），再映射到语义层：

```
--bg / --surface / --surface-2 / --sidebar / --line-2
--text / --text-2 / --text-3 / --text-4
--brand / --ok / --warn / --err / --info / --idle / --pink / --blue
--r1…--r4（4/8/12/16）、--shadow-1/2、--ease、--dur
```

- **浅色/深色各一套**：`html[data-theme="dark"]` 覆盖，默认深色；顶栏月亮/太阳可切换并记忆；
- **品牌色是单色**（浅色近黑/深色近白，跟 DSH 一致），蓝色只用于数据与链接，粉色/蓝色只用于 B 站品牌识别；
- 语义色只用于状态，不再拿"绿色"当进度条默认色。

### 2.2 排版与间距

| 层级 | 规格 |
|---|---|
| 页面标题 | 20 / 28，600 |
| 卡片标题 | 13 / 20，600 |
| 正文 | 13 / 21 |
| 注释 | 12 / 18 |
| 微元数据 | 11 / 16，tabular-nums |
| 指标数字 | 21–22 / 28–30，600，tabular-nums |
| 图标 | 统一 16×16（仅空状态 30、按钮 15） |

间距：4 的倍数；页面 24/28 padding，卡片 16，卡片间距 14，字段行 11 上下；中文行高 ≥1.6。

### 2.3 骨架

```
┌ 侧栏 216px（可折叠 64px） ┬ 顶栏 52px：面包屑 / 数据快照 / 值班+下一轮 / 账号 / 主题
│ 品牌 + 分组导航 + 收起    ├ 内容区（max 1320，24/28 padding）
└──────────────────────────┴ 页面头（标题 + 说明 + 页面动作）+ 页体 + 页脚（数据来源）
```

- 导航分三组：运营（概览/实时/活动）· 产出（日报/判重表）· 配置（人设工作室/设置）；
- 选中态：底色 + 左侧 2.5px 竖条 + `aria-current="page"`；
- <1180px 自动折叠为图标（保留 title 提示）；折叠状态记忆；
- 顶栏常驻"数据快照时间/自动值班/下一轮/账号/主题"，任一页都不需要回看板确认状态。

### 2.4 组件（全部落在 `bf-` 命名空间，可平移）

card / metric（含 bar）/ pill / chip / tag / btn（primary·ghost·danger·icon·sm）/ seg / tabs / table（sticky head）/ field / switch / stepper / chips 输入 / banner（info·warn·err·muted）/ empty / toast / savebar / stage rail / timeline / live stream / markdown article。

状态：hover、active、focus-visible（2px 蓝环）、disabled（0.4 透明度 + 不响应）、aria-selected/current/checked 与视觉同步；`prefers-reduced-motion` 关闭动效。

### 2.5 七个页面各自回答什么

| 页面 | 核心问题 | 关键内容 |
|---|---|---|
| 概览 | 今天这个号什么状态？ | 值班卡（窗口/下一轮/上次/今日轮次）、账号卡、五项配额、存在感（7 日趋势；**无入站数据时解释原因**）、最近 3 轮活动、当前人设、本地检查 |
| 实时运行 | 这一轮跑到哪了？ | 空闲/运行中（演示回放）双态；与 `live.js` 对齐的 4 阶段轨（思考/找内容/看内容/发言）；秒表、工具/动作统计、本轮配额；事件流按 kind 筛选 |
| 活动 · 生命周期 | 每条视频走到哪一步？ | 按视频（6 步链路：看过→赞→评→收到回复→已跟进→动态）与时间线双视图；类型筛选 + 搜索；跳过原因；事件明细（评论原文/回复人/动态 id） |
| 日报 | 每轮到底做了什么？ | 左列表（日报/月度归档/overlay）+ 右 Markdown 渲染（标题/粗体/行内码/链接/引用/代码块/列表/分隔线） |
| 判重表 | 这个号看过什么？ | 只显示视频行（`值班开始` 等备注折叠计数）；sticky 表头；动作色彩 chips；搜索 |
| 人设工作室 | 人设现在长什么样？ | 卡片（预算+budget 条+分块折叠）/ 编译预览（前后段位置）/ 质量 L0 / 语料库（分桶+抽样）/ 见闻库 / 今日状态 / 版本对比 / 试写沙盒 |
| 设置 | 现在按什么规则跑？ | 值班调度/配额/内容源/禁令/人设来源/运行环境 + 本地检查；显式保存条（脏标记、恢复默认、保存）；legacy 来源明确提示 |

> 诚实性：页脚固定标注数据快照时间与来源；"没接"的功能（跑一轮/中止/保存/生成候选/一键诊断）点击只给 toast，并在文案里写明"真实实现需要桌面端/模型调用"。

---

## 3. 数据：真实快照与"不编造"

`npm run demo:console` 从本机真实文件组装 12 个顶层字段（详见 `scripts/lib/console-demo-data.mjs`）：

| 字段 | 来源 | 快照 |
|---|---|---|
| account | 凭证文件存在性 + 人设卡号名 | 联网字段 `level/coins/fans/vip = null` → 显示 `—`；不读 cookie |
| duty / quota | `config.json` + `state.json` + 账本 | 自动值班关、上一轮 18m11s、今日 0 轮（当天确实没跑） |
| presence | 账本最近 7 天 | 收赞/被回复均 0（inbound 事件为 0）；发出的评论 8 条 |
| activities | `lib/activity.js` 解析 `ledger.jsonl` | 2 天 / 5 轮 / 28 个视频 / 101 条事件 |
| live | `state.json` + 最新一轮真实产物改写为事件流 | **演示回放**，UI 标注"不发 B 站" |
| reports | `out/*.md` + `digest/*.md` + overlay | 2 份日报全文 + 1 份归档 |
| seen | `seen.md` | 57 行（39 视频 + 18 条值班备注） |
| persona | `buildPersonaDemoData()`（真实卡+编译+L0+账本状态） | whale@2.0.0，1733 字符，L0 6/6 |
| config | `config.json` 覆盖层 + schema 默认值 | 28 个覆盖字段 + 模型 huoshan/glm-5.3-flash |
| health | 本地可判定项 | 8 项：凭证/家目录/模型/账本/判重表/日报/overlay/pass + dsh CLI warn |

体积：数据 JSON 约 99 KB，单文件约 220 KB；注入可重复执行（`--dry` 只看摘要不写文件）。

---

## 4. 验证

`npm run demo:console:verify` 覆盖：无占位符、无外部资源、12 个顶层字段、关键子字段有值、generatedAt 本地时区、内联脚本 `node --check`、7 个页面渲染函数、3 组导航、人设 8 页签、主题 token/保存条、div 开合。

人工截图矩阵（无头 Chrome）：

- 7 页 × 深色；7 页 × 浅色（`?theme=light`）；
- 人设 8 页签逐页；
- 1100 / 900 宽（侧栏自动折叠）；
- 运行中/空闲、按视频/时间线、各筛选与数据空态。

发现并修掉的问题：SVG 无尺寸导致筛选栏放大镜撑满、spark 图日期与评论重叠、live 阶段键与 `live.js` 不一致、事件流工具名重复、配额用了全局而非本轮、未知 round 的展示、判重表非视频行混入、空值显示 0。

### 4.1 独立评审（ui-reviewer）与修复

另起一名只读评审员做了独立走查：深/浅色各 7 页 + 人设 8 页签、1100/900 宽、补充状态（设置改动后、归档、筛选空态、滚动到底），并用注入探针量了溢出/截断/卡片内边距/对比度/ARIA/遮挡。修掉的阻塞与重要项：

| # | 问题 | 修复 |
|---|---|---|
| B1 | 设置页 switch/步进/标签点击后控件不回显（只有保存条变脏） | `setCfg()` 改为整页 `render({keepScroll})`，保留滚动位置 |
| B2 | 质量 L0 卡与沙盒候选卡 padding=0，文字压边框 | 两处补 12/14 内边距 |
| B3 | 同屏出现「101 条事件」与「112 条事件」两个口径 | 健康检查文案改为「112 条事件（其中 101 条归到视频）」，活动统计写「归到视频的账本事件」 |
| I1 | 人设页顶部仍写「生效」，但配置走 legacy | 状态 pill 改「预设 whale@2.0.0（未生效）」+ warn banner |
| I2/I3 | 深浅色 caption/chip 对比度低（深 3.5:1，浅 2.4–3.7:1） | 深色 caption → #8b9099；浅色 tertiary/caption/ok/warn/info 全部提亮到 ≥4.5:1 |
| I4 | 判重表时间列 39 行全空、动作长文案把列撑到 243px | 无时间时整列隐藏；动作改为短 chips（原文进 title） |
| I5 | flush 卡表格与卡头 6/10px 不对齐、表后说明贴边 | flush 表格首尾列 16px、卡内说明补 16px |
| I6 | 网格把卡片拉高产生大块空洞 | 全局 `.grid{align-items:start}` |
| I7 | sticky 保存条滚动中压住内容 | 未修改时保存条改为静态（仅 dirty 时 sticky） |
| I8 | 活动标题在 1100/900 被裁 | 标题最多两行折行 + title 兜底 |
| I9 | 活动筛选「全部 28」与「看过 35 次」口径混用 | 全部标「个视频」、其余标「次」，统计条说明口径 |
| I10 | 月度归档 1.9 KB 却显示「没有正文」 | 空态改为「快照未包含归档正文（桌面端打开 digest/…）」 |
| I11 | 人设分区「N 字」合计 3325 与注入 1733 打架 | 分区改「N 字原文」+ 脚注说明原文≠注入；creatorNotes 标注不注入 |
| I12 | 报告 H1 与页面标题同字号 | `.md h1` 降为 18px 并加分隔线 |
| I13 | 表单缺 label、chip 缺 aria-pressed、tab 无 tabpanel 关系 | 补 aria-label / aria-pressed / tabpanel-aria-controls / roving tabindex + 方向键切换 |

另有 S 类小修：900 宽配额卡 3+2、自动值班关闭时「下一轮」改「自动已关，不触发」、判重表导航徽标改 39（视频行）、账号说明去掉 `(null)`、跟进回复标「每轮上限」、设置 900 宽保持两列、`<meta name="color-scheme">`、`.act-b/.pf-pre` 长 token 换行等。

**仍未处理（已记录）**：读屏软件实测、<720 移动端、125%/150% 系统缩放、Safari/Firefox 差异；页面内表单仍未用 `<label for>`（用的是 aria-label）；这些属于接入真实控制台时的浏览器矩阵工作。

---

## 5. 移植到真实控制台（进行中）

**关键修正：真实宿主已经有左侧 rail，插件页面不要再自绘侧栏。** 演示稿里的 216px 侧栏是"整台控制台"的评审壳；放进 DSH 后只保留：

- 页面顶栏：标题/说明 + 登录状态 + 刷新 + 跑一轮/中止；
- 一行 7 页签：概览 / 实时 / 活动 · 生命周期 / 日报 / 判重表 / 人设工作室 / 设置（设置内部再分「配置 / 宿主日志」两个子页）；
- 内容区：**max-width 960**、padding `28px clamp(24px,4vw,48px) 48px`（照抄宿主 PluginManagerPage 的标准插件页容器），滚动由页面自己承担。

### 5.1 落地进度（2026-10-27 第 1 轮）

| 模块 | 状态 | 说明 |
|---|---|---|
| 壳 / 页签 / 顶栏 | ✅ 已接入 `client.js` | `ConsolePage` 改为 7 页签；旧「看板/操作台」不再挂载（代码暂留待清理）；
| 概览页 | ✅ 新实现（`OverviewPage`） | 值班状态、账号、5 项配额、存在感（7 日/无入站解释）、最近 3 轮、当前人设、本地检查；数据全来自 `/overview /activity /account /persona`；
| 活动页 | ✅ 新实现（`ActivityPage`） | 按视频/时间线、类型筛选、搜索；复用生命周期卡与阶段轨；
| 实时页 | ✅ 新实现（`LivePage`） | 空闲/运行双态；4 阶段轨（与 `lib/live.js` 的 think/find/watch/act 对齐）；已运行时钟/工具/动作/本轮配额；事件流按 kind 筛选 + 自动滚动；旧 LivePane 不再挂载；
| 日报页 | ✅ 新实现（`ReportsPage`） | 左列表（日报/归档/overlay）+ 右 Markdown；自写 React Markdown 渲染器（标题/粗体/行内码/链接/引用/列表/代码块/分隔线），不用 dangerouslySetInnerHTML；
| 判重表页 | ✅ 新实现（`SeenPage`） | 复用 /seen（修好后的 57 行）；只看视频行、值班备注折叠计数；搜索 + 动作 chips + 无时间时隐藏时间列；
| 设置页 | ✅ 改造（`ConfigPane`） | 宿主设置卡（settings-card 材质 / radius 20）+ 字段 stacked；显式保存条（脏计数 / 恢复默认 / 保存并生效）；配置 / 宿主日志两个子页；
| 人设工作室 | ✅ 新实现（`PersonaPage`） | 8 页签：卡片（字段折叠 + 五块预算 + JSON 编辑/保存）、编译预览、质量/L0、语料库、见闻库、今日状态、版本对比（快照/回滚）、试写沙盒（标注未接）；新增 `GET /persona/expression|lore|versions`、`PUT /persona`、`POST /persona/versions/restore`；legacy 模式继续明示；
| `/seen` 解析 BUG | ✅ 已修 | `lib/api.js` 换 `parseSeenRows`，真实 `seen.md` 从 0 行 → 57 行（39 视频 + 18 备注），新增 3 条测试；
| 测试时间炸弹 | ✅ 已修 | `index.integration.mjs` 的「今日配额」fixture 改为固定当天 00:00–00:02，凌晨跑不再失败；
| 回归 | ✅ 绿 | `npm test` 156 pass、render smoke 7 项、client smoke、e2e-fixture、index.integration 全绿；
| DSH UI 规范对齐 | ✅ 第 1 批已应用 | 规范来自宿主源码（`2026-10-27-dsh-ui-conformance.md`）：页面容器 960/clamp/页头 28；按钮 32/28、radius 12/8、l3 边框、primary 文字用 label-primary-foreground；输入族 34/radius12/l4/layer-3 + focus-visible 蓝边；开关 36×20/位移16/switch-thumb；pill 24 无边框、chip 11-17 radius 999、过滤 chip 宿主 active；下划线页签 22/7-1-9/2px；segmented 4px 容器 + 28 高指示块；卡 radius 16、标题 14；空态去虚线；banner 去边框；弹窗 380/radius20/layer-2；全局 focus-visible 2px 环 + reduced-motion + corner-shape:round；字号吸附 12.5/11.5/10.5→13/12/11；拆分 `.bf-root`（滚动）与 `.bf-console`（token），SettingsEntry 改 `.bf-settings-section`（max 760、去掉双重滚动）；
| 清理旧 UI / 文档 / 版本 / 提交推送 | ⏳ 后续轮次 | 全部页面迁完后删除 `Dashboard/ConsoleView/segmented` 旧壳与死代码。 |

**第 2 轮已完成**：实时 / 日报 / 判重表 / 设置 四页迁移，render smoke 新增 4 组断言（实时运行中/空闲、日报、判重表、设置）。

**剩余**：人设工作室 8 页签重做 → 删除旧 `Dashboard/ConsoleView/ArtifactsPane/SeenPane/LivePane` 与死 CSS → README/截图/版本号 → 最终提交并推送。

## 6. 已知限制 / 后续

- 实时页与沙盒是**回放/示意**，不产生任何 B 站请求；真实实现走 SSE + 模型调用；
- 账号资料、粉丝/硬币、入站点赞需要联网，演示稿显示 `—`；
- `lib/api.js` 的 `GET /seen` 正则与真实 `seen.md` 格式不匹配（实测返回 0 行）——v3 演示用独立解析绕过，**真实控制台需要修这个 bug**（另开任务）；
- 设置页保存、人设编辑/版本/回滚、A/B 属 P4 未接；
- 移动端只做到 900px（侧栏折叠 + 单列），未做手机布局。
