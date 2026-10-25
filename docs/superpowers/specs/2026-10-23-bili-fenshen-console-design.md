# B站分身 · 控制台页面 设计文档

- 版本：v2（定稿，含静态预览校准）
- 日期：2026-10-23
- 插件：`dsh-bili-fenshen` 0.3.1 → 0.4.0
- 预览：`docs/demo/bili-fenshen-console.html`（截图 `docs/demo/shots/`）
- 配套：`docs/superpowers/plans/2026-10-23-bili-fenshen-console.md`（实施方案）
- 术语以 `CONTEXT.md` 为准

---

## 1. 目标

在 DSH 左侧栏新增一个**全宽的控制台页面「B站分身」**，取代当前「设置 → B站分身」的一节面板，成为账号主人的日常入口。

它同时承担两件事，用两个子页分开：

| 子页 | 职责 | 关键词 |
|---|---|---|
| **看板** | 只看：账号、值班、今日配额、**B站活动生命周期** | 一眼看懂现在是什么状态 |
| **操作台** | 操作：配置、日志、判重表、产物 | 改参数、排故障、查账 |

核心新增能力是**活动生命周期**：把「刷了什么视频 → 是否点赞 → 是否评论 → 评论了什么 → 有人回复吗 → 回了什么 → 我又回了什么」呈现为**一条连贯的活动线**，而不是散落在日报、判重表、日志三处的碎片。

### 非目标（本版不做）

- 视频封面图（后续再议）
- 7 天以前的历史归档浏览（去「产物」或日志看）
- 7 日趋势折线；压审复核可视化（复核逻辑仍是桩，等 V1.5 接入后挂到活动卡上）
- 多账号切换；私信、上传视频等写操作
- 界面多语言（中英）——见 §11 例外说明

---

## 2. 现状与落点

### 2.1 现状问题

| 问题 | 证据 |
|---|---|
| 只有 `settings.section` 一页，内容堆在一个滚动流里 | `dsh-plugin/client.js` |
| 样式引用的 `--dsh-*` **不是宿主 token**，实际渲染为裸样式 + 兜底灰边 | 宿主真实 token 为 `--dsw-alias-*` / `--dsw-specific-*` |
| 日报以 `<pre>` 原样输出，没有结构 | 同上 |
| `bili_reply` 不返回 rpid，导致报告出现「未取到 rpid」 | `mcp_server.py:651`，报告 `out/2026-10-22.md:106` |
| 日志把子进程 stdout（含模型推理原文）全量展示 | `duty.log` 69 KB 里大半是推理文本 |
| 同一 prefix 路由被注册两次 | `duty.log`：`duplicate prefix route "/api/bili-fenshen"` |

### 2.2 落点：槽位（已核实宿主源码写法）

左侧栏是 `sidebar.panellist`（list），每个条目 id 对应 `main`（keyed by sidebar entry id）里同 key 的面板。现有占用：

| 侧栏 id | 页面 | order | registrant |
|---|---|---|---|
| `plugins` | 插件 | 0 | Kb（宿主 shell） |
| `schedules` | 自动化任务 | 10 | Kb |
| `dsh-context` | 上下文 | 20 | dsh-context |

本插件注册两项（写法与宿主自带插件一致，已从安装包源码核实）：

```js
// client.js
const PANEL_ID = 'bili-fenshen'

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: PANEL_ID,
  order: 15,                       // 插件(0) < 自动化任务(10) < 本页(15) < 上下文(20)
  label: () => 'B站分身',           // thunk：每次投影重新读取，便于以后接 locale
}, PanelIcon))

ctx.slots.inject('main', function* () {
  yield ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    children: {},                  // 页面内部不声明子槽位（tab 自绘）
  }, ConsolePage)
})
```

- `main` 面板**不绑定 Session**，页面不得依赖 session props。
- 图标组件收到 ownerProps `{ size, active }`，需按 `size` 绘制。
- 注册一律包在 `ctx.slots.inject(...)` 里，返回的 disposer 由框架处理。

### 2.3 入口策略（已定）

侧栏独立图标为唯一入口。**设置 → B站分身**缩成一行「说明 + 打开控制台」按钮（`ctx.layout.selectPanel('bili-fenshen')`），删除重复的日报/日志展示，避免两套 UI 各自漂移。

---

## 3. 信息架构

```
侧栏图标「B站分身」
└── 控制台页（全宽，自带标题行）
    ├── 子页：看板
    │   ├── 账号条          头像 / 昵称 / LV / UID / 硬币 / 粉丝 / 登录态
    │   ├── 值班条          自动值班开关 · 下一窗 · 本轮状态 · 跑一轮 / 中止
    │   ├── 今日配额        挑中 / 评论 / 点赞 / 动态（已用 ÷ 上限 + 细进度条）
    │   ├── 活动流          ← 主舞台：按轮次分组的生命周期卡片
    │   ├── ▸ 跳过 N 条     默认折叠，展开为紧凑卡片
    │   └── ▸ 更早          最近 7 天按天折叠
    └── 子页：操作台
        ├── 配置   值班节奏 / 配额 / 内容源 / 人设 / 运行环境
        ├── 日志   宿主事件（默认显示）+ 子进程原文（折叠）
        ├── 判重表 seen.md → 表格（可搜索）
        └── 产物   日报 / 月度归档 / overlay（只读原文）
```

**边界原则**：所有会改变插件状态的控件在操作台。唯一例外是「自动值班开关」「跑一轮」「中止」——高频且有状态语义，放在看板值班条。

---

## 4. 数据模型

### 4.1 为什么必须有账本

现有两套产物都不足以支撑生命周期：

- `out/<YYYY-MM-DD>.md`：给人读的报告，按「段落」组织，格式由模型自由发挥；
- `seen.md`：判重账本，一行一条，只有动作标签。

二者都以「行/段」为单位，无法把「一条视频的整段经历」聚成一个对象。因此新增机器账本。

### 4.2 账本文件

`<家目录>/ledger.jsonl`，append-only，一行一个 JSON 事件。家目录默认 `~/.dsh/bili-fenshen`，可用 `BILI_FENSHEN_HOME` 覆盖（便于测试）。

公共字段：

```ts
type LedgerEvent = {
  t: string            // ISO 时间戳（事件发生时刻）
  round: string | null // 轮次 id = 该轮开始时刻的 ISO 串；reply-in 按 §4.4 归属，找不到则 null
  type: 'view' | 'like' | 'comment' | 'dynamic' | 'skip' | 'reply-out' | 'reply-in' | 'round-end'
  bvid?: string
  source?: 'agent' | 'report'   // 事件来源；缺省视为 agent
}
```

各类型字段：

| type | 字段 | 写入方 |
|---|---|---|
| `view` | `title, author, views, duration, source('hot'\|'search'\|'follow'), grade('worth'\|'ok'\|'meh')` | Agent |
| `like` | `bvid` | Agent |
| `comment` | `text, rpid: number \| null` | Agent |
| `dynamic` | `text, id` | Agent |
| `skip` | `title, author, reason` | Agent |
| `reply-out` | `parent: number, text, rpid: number \| null` | Agent |
| `reply-in` | `parent: number \| null, rpid, from, text, notifId` | 宿主 |
| `round-end` | `code, durationMs` | 宿主 |

示例：

```jsonl
{"t":"2026-10-22T08:26:11Z","round":"2026-10-22T08:26:00Z","type":"view","bvid":"BV1xrnz6gEVD","title":"折1万次，会坏吗？iPhone Duo 深度评测","author":"影视飓风","views":3136000,"duration":1492,"source":"hot","grade":"worth"}
{"t":"2026-10-22T08:26:30Z","round":"2026-10-22T08:26:00Z","type":"like","bvid":"BV1xrnz6gEVD"}
{"t":"2026-10-22T08:27:02Z","round":"2026-10-22T08:26:00Z","type":"comment","bvid":"BV1xrnz6gEVD","text":"用原子力显微镜查指纹为什么难擦…","rpid":123456}
{"t":"2026-10-22T10:41:00Z","round":"2026-10-22T08:26:00Z","type":"reply-in","bvid":"BV1xrnz6gEVD","parent":123456,"rpid":999001,"from":"张三","text":"那个显微镜多少钱","notifId":1185685105221638}
{"t":"2026-10-22T08:31:10Z","round":"2026-10-22T08:26:00Z","type":"round-end","code":0,"durationMs":192000}
```

**纪律**：`rpid` 取不到就写 `null`，界面上显示「未取到 rpid」，**绝不编造数字**。

### 4.3 兜底解析（防 Agent 漏记账）

每轮结束后（`round-end` 写入后），宿主解析本轮新增的报告片段，补齐缺失事件：

- `### BV…` 段 → 补 `view`（标题/UP/播放量/档位）；
- 段内「点赞」「评论（正文）」「动态」 → 补 `like` / `comment` / `dynamic`（`rpid: null`）；
- 「跳过记录」列表 → 补 `skip`（`reason` 取括号内文字）；
- 事件带 `source: 'report'`，界面标注「据报告回填」，并按 `(bvid, type, text)` 去重。

### 4.4 回复轮询器

`x/msgfeed/reply` 的通知项（已用真实凭证探针确认字段）：

| 字段 | 含义 |
|---|---|
| `item.uri` / `native_uri` | 视频链接 → BV 号 |
| `item.title` | 视频标题 |
| `item.source_content` | 我的原评论正文 |
| `item.target_reply_content` | 对方的回复正文 |
| `item.source_id` / `target_id` / `root_id` | 评论 id 链 |
| `user.nickname` / `avatar` | 谁回复的 |
| `reply_time` | 回复时间 |
| 通知 `id` | 幂等键 |

宿主每 **5 分钟**轮询一次，条件：凭证有效 **且** 账本近 7 天内存在 `comment` 事件。每次：

1. 拉通知；
2. 跳过已处理 `notifId`（存 `state.json#seenNotifs`，上限 500）；
3. 解析 BV；解析失败的通知丢弃并记日志（不猜）；
4. 归属轮次：`parent === 某条 comment.rpid` → 该条所在轮次；否则 `bvid + source_content === comment.text` → 该条轮次；否则该 bvid 最近一轮；否则 `null`；
5. append `reply-in`。

### 4.5 保留与清理

- 账本 5 MB 轮转为 `ledger.jsonl.old`（与 `duty.log` 同策略）。
- 控制台只读**最近 7 天**（含今天）。更早的看报告原文或日志。
- 损坏行跳过 + 记日志，不阻塞整个文件。

---

## 5. 生命周期呈现规范（核心）

### 5.1 活动的定义

一个**活动** = 一个 `bvid` 聚合出的事件串。由账本折叠而来，不在前端临时拼。

```ts
type Activity = {
  bvid: string
  title: string
  author: string
  views?: number
  duration?: number
  source?: 'hot' | 'search' | 'follow'
  grade?: 'worth' | 'ok' | 'meh'
  skipped?: { reason: string }
  events: LedgerEvent[]                       // 时间正序
  stage: { viewed: boolean; liked: boolean; commented: boolean; replies: number; repliedBack: boolean; dynamic: boolean }
  flags: { fromReport: boolean; pendingReply: number }   // pendingReply = 收到但未回的回复数
}
```

### 5.2 阶段条

六个节点，左到右：`刷到 → 看 → 赞 → 评 → 被回复 → 我回`。

- 已达成：实心点（业务蓝 `--dsw-alias-state-business-primary`）+ 时刻；
- 未达成：空心点（`--dsw-alias-state-idle-primary` 描边）+ `—`；
- 跳过：六节点不成型，卡片只用灰色「跳过」标签（见 5.4）。

### 5.3 卡片三段式

1. **头部**：`BV 号`（等宽小字，可点开视频页）+ 档位徽标 + 状态 chips（赞 / 评论 / N 回复 / N 未回）+ 标题 + `UP · 播放 · 时长 · 来源`。
2. **阶段条**（5.2）。
3. **主体**：
   - 评论原文：左侧 2px 竖线引文块，前缀 `我 · HH:MM`；
   - 回复线程：缩进在评论下，`└ 昵称 时刻「正文」`；我的回复用气泡底 + 蓝色名字；**收到但未回的**挂黄色「待跟进」chip（`--warn`）；
   - 动态（若有）：独立一行 `动态「…」`；
   - 底部：`打开视频` + `评论 rpid xxx` + `回复 rpid xxx`（缺则显示「未取到 rpid」）。

### 5.4 折叠策略（可读性的关键）

| 活动形态 | 默认 |
|---|---|
| 有对话（有 `reply-in` 或 `reply-out`） | **展开** |
| 只有赞/评、无对话 | 折叠成一行（BV + 徽标 + chips + 标题） |
| 纯浏览（只有 `view`） | 折叠 |
| 跳过（`skip`） | 收进「▸ 跳过 N 条」组，**整组默认折叠**；展开后每条一个紧凑卡（BV + 标题 + 理由），不再展开正文 |

### 5.5 分组与排序

- 主分组：轮次，标题 `16:26 这一轮 · 热门 30 · 搜索「AI 实测」「大模型」· 订阅 0`；
- 轮次倒序；
- 轮内顺序：有对话 → 有动作 → 纯浏览，其次按时间；
- 页面底部「更早」：最近 7 天按天折叠，点开加载该天。

### 5.6 空态与异常横幅

| 场景 | 呈现 |
|---|---|
| 从未跑过 | 居中提示 + 「跑一轮」+ 「扫码登录」 |
| 未登录 | 横幅：`未登录，点赞/评论/动态都会失败` + 登录抽屉 |
| 找不到 dsh CLI | 横幅 + 指向操作台 `dshBin` |
| 上一轮退出码 ≠ 0 | 横幅（可展开该轮日志尾部） |
| 该轮只有报告回填事件 | 卡内提示「据报告回填，缺少精确 rpid」 |

---

## 6. 看板布局规格

```
┌ 页面标题行 ─────────────────────────────────────────────┐
│ B站分身                                    ●值班就绪 [刷新]│
│ 让小号在B站保持存在感 · 先发后报，可随时接管                │
├ 子页切换 ───────────────────────────────────────────────┤
│ [看板] 操作台                                            │
├ 账号条 ─────────────────────────────────────────────────┤
│ (头像) 蓝鱼小号 LV6 ●登录有效        [B站主页][重新扫码]│
│        UID 10000001 · 硬币 1447.5 · 粉丝 12 · 大会员未开通│
├ 值班条 ─────────────────────────────────────────────────┤
│ [开关]自动值班 已开  下一窗 12:00（2h54m）本轮 运行中 1m12s│
│                                            [中止][跑一轮] │
├ 今日配额 ───────────────────────────────────────────────┤
│  挑中 3/5    评论 2/5    点赞 6/10    动态 0/1            │
│  ▁▁▁▁▁       ▁▁▁▁▁       ▁▁▁▁▁        ▁▁▁▁▁              │
├ 活动流 ─────────────────────────────────────────────────┤
│ 16:26 这一轮 · 来源：热门 30 · 搜索「AI 实测」「大模型」    │
│ ┌ BV1xr… 值得看 赞 评论 3回复 1未回 ────────────────────┐│
│ │ 折1万次，会坏吗？iPhone Duo 深度评测                    ││
│ │ 影视飓风 · 313.6万播放 · 24:52 · 热门                   ││
│ │ ●刷到 ●看 ●赞 ●评 ●被回复 ●我回                        ││
│ │ 「我 · 16:27 用原子力显微镜查指纹为什么难擦…」          ││
│ │  └ 张三 16:41「这条我正好也在看，那个显微镜多少钱」      ││
│ │  └ 我   16:42「三万左右吧，主要是他们租的」             ││
│ │  └ 阿茶 17:08「换屏8000是真的吗…」 [待跟进]             ││
│ │ 动态「…」 打开视频 评论 rpid 123456 回复 rpid 999001   ││
│ └───────────────────────────────────────────────────────┘│
│ ▸ 跳过 3 条：同题重复 1 · 争议话题 1 · 信息密度低 1        │
│ ▸ 更早：10-22 · 5 条活动    10-21 · 无记录                │
└─────────────────────────────────────────────────────────┘
```

页面容器：`max-width: 920px`，`padding: 26px 32px 72px`。

---

## 7. 操作台布局规格

四个 tab（页面自绘下划线式）：**配置 | 日志 | 判重表 | 产物**。

### 7.1 配置

分组与控件：

| 组 | 内容 | 控件 |
|---|---|---|
| 值班节奏 | 自动值班；中午窗口（12:00–14:00）；晚间窗口（18:00–次日 09:00） | 3 个开关 |
| 配额 | `perDay` `commentsPerDay` `commentsPerRound` `likesPerDay` `dynamicsPerDay` `repliesPerRound` | 数字步进（−/+） |
| 内容源 | `keywords`、`followUids` | chips（可删、可加） |
| 人设 | `personaPrompt`（留空＝中性；也可填文件路径） | 多行文本 |
| 运行环境 | dsh CLI 探测结果、`headlessProfile`、家目录、账本路径、`dshBin` | 只读展示 + 可编辑 `dshBin` |
| 底部 | `恢复默认` / `保存并生效` | 按钮 |

保存语义见 §12.3。

### 7.2 日志

- 上半：**宿主事件**（从 `duty.log` 筛 `^\[<ISO>\]` 行），异常红字。
- 下半：**子进程原文**默认折叠（含模型推理文本，只作诊断）。
- 工具：复制路径 / 打开文件夹。

### 7.3 判重表

`seen.md` → 表格：日期 / BV / 动作（chip）/ 标题；顶部搜索框过滤 BV 或标题；解析失败降级为原文只读。

### 7.4 产物

左侧文件列表（`out/*.md` 最近 30 天、`digest/*.md`、`headless-overlay.yml`），右侧原文只读（等宽）。

---

## 8. 接口契约

全部挂在 `/api/bili-fenshen` prefix 路由下（`webServer` 原生 Node handler，仅本机 127.0.0.1）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/overview` | — | `{ account, duty, quota, round, health, lastReplyPollAt }` |
| GET | `/activity` | `?from=&to=`（YYYY-MM-DD，默认近 7 天） | `{ days: [{ date, rounds: [{ id, startedAt, sourceLabel, items: Activity[] }] }] }` |
| GET | `/account` | — | `{ loggedIn, uname, face, mid, level, coins, fans, following, vip }`（宿主直连 nav + relation/stat，缓存 60s） |
| POST | `/duty` | `{ autoDuty: boolean }` | `{ ok, config }` |
| POST | `/run` | — | 现有 `{ started, why, error? }` |
| POST | `/stop` | — | `{ ok, stopped: boolean }` |
| GET | `/config` | — | `{ values, sources: { field: 'patch' \| 'override' }, defaults }` |
| POST | `/config` | `{ fields }` | `{ ok, values }` / 400 `{ error, field }` |
| GET | `/log` | `?tail=200` | `{ events: string[], raw: string, path }` |
| GET | `/seen` | — | `{ rows: [{ date, bvid, action, title }], raw }` |
| GET | `/reports` | — | `{ days: string[], digests: string[] }` |
| GET | `/report` | `?day=` | 现有 `{ day, text }` |
| GET/POST | `/cred`、`/login/*` | — | 现有 |

`/overview` 形状：

```json
{
  "account": { "loggedIn": true, "uname": "蓝鱼小号", "mid": "10000001", "level": 6, "coins": 1447.5, "fans": 12, "face": "https://…" },
  "duty": { "autoDuty": true, "windows": { "noon": true, "night": true }, "nextWindowAt": "2026-10-23T12:00:00+08:00" },
  "quota": { "picked": 3, "comments": 2, "likes": 6, "dynamics": 0,
             "limits": { "perDay": 5, "comments": 5, "likes": 10, "dynamics": 1, "repliesPerRound": 2 } },
  "round": { "running": true, "startedAt": "...", "elapsedMs": 72000,
             "lastRunAt": "...", "lastWhy": "web", "lastCode": 0, "lastDurationMs": 127000 },
  "health": { "cli": "/…/bin.js", "cred": true, "routeOk": true },
  "lastReplyPollAt": "..."
}
```

**轮询节奏**（页面打开期间）：`/overview` 3s；`/activity` 运行中 3s、空闲 15s；`/account` 60s。页面隐藏时暂停，回到前台立即刷新一次。

---

## 9. 视觉规范

### 9.1 Token（取自宿主 `design-platform.css` / `base.css`，浅 `body{}` / 深 `body[data-ds-dark-theme]{}`）

| token | 浅 | 深 |
|---|---|---|
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1/2/3` | `#fff` | `#232324` / `#2c2c2e` / `#353638` |
| `--dsw-alias-bg-module-platform` | `#f9fafb` | `#353638` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-border-l1/l2/l4` | `#0000000a` / `#0000001a` / `#00000029` | `#ffffff0f` / `#ffffff1f` / `#fff3` |
| `--dsw-alias-label-primary/secondary/tertiary/caption` | `#0f1115` / `#61666b` / `#81858c` / `#adb2b8` | `#f9fafb` / `#cfd3d6` / `#adb2b8` / `#81858c` |
| `--dsw-alias-brand-primary` | `#0f1115`（主按钮近黑） | `#f9fafb` |
| `--dsw-alias-button-primary-hover` | `#43454a` | `#ebeef2` |
| `--dsw-alias-interactive-bg-hover` / `-hover-solid` / `-active` | `#2631480f` / `#f1f3f5` / `#2631481a` | `#ffffff14` / `#353638` / `#ffffff24` |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| `--dsw-specific-sidebar-nav-item-active` | `#ebeef2` | `#43454a` |
| `--dsw-specific-selector` | `#f5f6f7` | `#353638` |
| `--dsw-alias-state-success-primary` / `-tertiary` | `#22c55e` / `#e6faed` | 同 / `#233c2c` |
| `--dsw-alias-state-warn-primary` / `-tertiary` | `#f59e0b` / `#fef5e7` | 同 / `#27241f` |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` |
| `--dsw-alias-state-business-primary` | `#4176e6` | 同 |

**禁止**：任何 `--dsh-*` 颜色引用（现存 `client.js` 全部是错的）；禁区文字色只在「跳过/不值当」。

### 9.2 度量

- 圆角：`--dsw-radius-xs 4 / sm 8 / md 12 / lg 16 / xl 20`；面板 28。
- 边框：**.5px**（宿主统一细线），颜色用 `border-l1/l2/l4`。
- 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", …`；等宽 `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, …`。
- 字号：正文 14/22；次文 13/20；小字 12/18；标签 11/16；页标题 18/26。
- 过渡：`.2s cubic-bezier(.4,0,.2,1)`。
- 开关 34×20，主按钮高 30、圆角 8。

### 9.3 B站品牌色

`#fb7299`（粉）/ `#23ade5`（蓝）**只用于**：侧栏图标、「值得看」徽标、头像占位渐变。不作正文色、不作控件主色。

---

## 10. 前端组件结构（单文件约束）

客户端产物是**一个** `client.js`（`window.__ModuleLoader__.load({ id, factory(require) })`），不支持相对 import。因此按注释分节，内部结构：

```
client.js
├── §0 常量：PANEL_ID、T（中文文案表）、轮询间隔
├── §1 CSS：宿主 token 的本地化别名 + 组件样式（字符串注入 <style>，随 apply 清理）
├── §2 数据层：fetchJson、usePoll（3s/15s 可变间隔 + visibility 暂停）、api.{overview,activity,account,duty,run,stop,config,log,seen,reports,report,login}
├── §3 基础组件：Button、Switch、NumStepper、Chips、Tabs(下划线)、Segmented、Card、Banner、Pill、Chip、Avatar
├── §4 看板：AccountBar、DutyBar、QuotaTiles、RoundHeader、ActivityCard、StageRail、ReplyThread、SkipGroup、EarlierGroup
├── §5 操作台：ConfigPane、LogPane、SeenPane、ArtifactsPane
├── §6 页面：ConsolePage（标题行 + 子页切换 + 两个子页）
└── §7 注册：apply(ctx) → panellist 图标 + main 页面 + settings.section 瘦身版
```

约定：

- 不得 `require` 任何 `@deepseek-ai/dsh-client-*` 包（宿主 primitives 会变、无类型检查）。控件自己实现，行为对齐宿主：`role="switch"`+`aria-checked`、Escape 关闭抽屉、`disabled` 语义。
- 组件内联样式随卸载移除；样式表用 `document.querySelector('style[data-plugin-css=...]')` 去重注入。
- 文案集中在 `T` 常量表（见 §11 例外）。

---

## 11. i18n 例外（有意偏差）

宿主规则是「UI 文案走 Client locale service」。本插件 V1 **不接 locale**：

- 产品是单一中文场景（报告、B站内容、章程都是中文）；
- `locale/*.json` 继续只承载包的 `meta`（标题/描述）；
- 全部界面文案集中在 `client.js` 的 `T` 表，以后接 locale 只需替换取值来源。

此例外记录在此，供后续维护者判断。

---

## 12. Host 实现约束

### 12.1 文件结构（拆分理由）

现有 `index.js` 715 行，纯逻辑与调度混在一起，无法单测。改为：

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：`apply()`、调度器、spawn、路由分发、轮次生命周期 |
| `lib/ledger.js` | 账本 append / 读取 / 轮转 / 去重 |
| `lib/report.js` | 报告 markdown → 兜底事件（纯函数） |
| `lib/activity.js` | 事件 → 轮次/活动聚合 + 阶段计算（纯函数） |
| `lib/config.js` | 默认值合并、`config.json` 覆盖层读写（纯 IO + 校验） |
| `lib/replies.js` | msgfeed 通知 → `reply-in` 事件（纯映射）+ 拉取 |
| `lib/account.js` | nav / relation-stat 拉取与字段归一 |
| `test/*.test.js` | `node --test` 单测（纯函数为主） |

`package.json` 的 `files` 增加 `lib/*.js`；`scripts.test = "node --test test/"`。

### 12.2 纪律（沿用现有注释里的血泪教训）

- 定时器回调、所有文件写入 `try/catch` 兜死：插件再错也只能「这一轮没跑成」；
- 找不到 dsh CLI 明确报缺失，绝不裸 spawn `dsh`；
- 每条路由独立 try/catch；prefix 路由只注册一次（同进程守卫）；
- 子进程引用必须保存（供 `POST /stop`），`exit` 后清空。

### 12.3 配置来源与写回

- 默认值 = `cordis.patch.yml` 里的 config（`Config` schema）。
- 覆盖层 = `<家目录>/config.json`，操作台写这里，**不碰用户的 patch**。
- 生效值 = `patch ← config.json`（逐字段覆盖）；`/config` 返回每个字段的来源。
- 保存时按字段白名单 + 类型校验；非法返回 400 且不落盘；原子写（tmp + rename）。
- 保存后热更新：调度器与下一轮快照立即使用新值，无需重启。

### 12.4 轮次生命周期

1. `runDuty()`：生成 overlay → spawn → 记录 `running=true`、`startedAt`、`child`；
2. 子进程退出：写 `round-end`（code、durationMs）→ 兜底解析报告 → `running=false`、清 `child` → 90s 后触发复核桩；
3. 15s 心跳检查：若 `running` 但 `child` 已消失超过 15s → 自愈为 `false` 并记日志；
4. `POST /stop`：`SIGTERM`，2s 后 `kill`，等 `exit` 走同一收尾路径。

### 12.5 安全

- 账本、日志、报告不含凭证；凭证只在 `bili_credential.json`。
- `/account` 的 face URL 原样透传，前端 `<img>` 失败回退为首字头像。
- 路由仅本机可用（沿用现状，不做鉴权）。

---

## 13. 验证方案

| # | 验证项 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | 语法 | `node --check index.js lib/*.js client.js`；`python -m py_compile mcp_server.py` | 无输出 |
| 2 | 纯函数单测 | `node --test test/` | 全绿 |
| 3 | 账本与聚合 | 用 fixture（正常/缺 rpid/跳过/损坏行）跑 `node -e` 或测试 | 损坏行被跳过、活动数正确 |
| 4 | 接口 | `Invoke-WebRequest http://127.0.0.1:57257/api/bili-fenshen/overview` | 200 + 结构符合 §8 |
| 5 | 槽位注册 | `cordis_inspect_query` client `Slots.listSubTree` root=`sidebar.panellist` / `main` | 出现 `bili-fenshen` occupant 且 `active:true` |
| 6 | 页面 | 打开 GUI 点侧栏图标 | 看板与操作台可切换、3s 轮询、停止生效 |
| 7 | 实跑 | `POST /run` 或让 Agent 跑一轮 | 账本新增事件、`round-end` 写入、报告兜底不重复 |
| 8 | 降级 | 临时改坏 `bili_credential.json` 或 `config.json` | 横幅提示，不白屏 |
| 9 | 清理 | 用 `BILI_FENSHEN_HOME` 指向临时目录做 3/7/8 | 真实家目录未被污染 |

---

## 14. 决策记录

| 日期 | 决策 | 结论 |
|---|---|---|
| 10-23 | 控制台定位 | 看板 + 操作台，两个子页 |
| 10-23 | 入口 | 侧栏独立图标（order 15），设置页降级为跳转 |
| 10-23 | 活动流范围 | 最近 7 天；更早去产物/日志 |
| 10-23 | 跳过项 | 可铺成卡片，整组默认折叠 |
| 10-23 | 封面图 | 本版不做 |
| 10-23 | 配置写回 | 插件自有 `config.json` 覆盖层，不改用户 patch |
| 10-23 | 实时性 | 3 秒轮询，够用（不上 SSE） |
| 10-23 | 账本 vs 解析报告 | 以账本为准；报告仅作兜底回填 |
| 10-23 | rpid | 修 `bili_reply` 回传；取不到写 null，不编造 |
