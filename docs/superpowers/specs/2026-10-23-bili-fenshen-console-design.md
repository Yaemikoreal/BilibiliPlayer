# B站分身 · 控制台页面 设计文档

- 日期：2026-10-23
- 插件：`dsh-bili-fenshen`（`dsh-plugin/`），版本 0.3.1 → 0.4.0
- 状态：待账号主人 review
- 相关：`CONTEXT.md`（术语）、`dsh-plugin/prompts/duty.md`（值班章程）、`mcp_server.py`（数据层）

## 1. 背景与目标

插件当前只有一个 UI：**设置 → B站分身**的一节面板（`settings.section`，order 35）。它把「状态 / 扫码登录 / 跑一轮 / 日报 / 日志」堆在一个滚动流里，用 `<pre>` 显示 markdown 原文，且样式引用的 `--dsh-*` CSS 变量在宿主中并不存在（真实 token 为 `--dsw-alias-*`），实际呈现为裸样式。

目标：在 DSH 左侧栏新增一个**独立的全宽控制台页面「B站分身」**，替代设置页成为日常入口。它既要能「看」（账号、值班、活动），也要能「操作」（配额、内容源、维护）。

核心新增能力是 **B站活动生命周期**：把「刷了什么视频 → 是否点赞 → 是否评论 → 评论了什么 → 有人回复吗 → 回了什么 → 我又回了什么」呈现为一条连贯的活动线，而不是散落在日报、判重表、日志三处的碎片。

**设计预览**（静态 HTML，仅用于确认观感，不是实现产物）：`docs/demo/bili-fenshen-console.html`，截图见 `docs/demo/shots/`。预览里的颜色、字体栈、圆角、边框细度全部取自宿主真实定义（`packages/client/ui-theme/src/styles/design-platform.css` 与 `base.css`：`body{…}` 为浅色、`body[data-ds-dark-theme]{…}` 为深色），不是估算值。打开方式：浏览器直接打开该文件，或用 `#console` / `#dark` / `#console,seen` 直达某个状态。

## 2. 落点：槽位与容器

DSH 的左侧栏是 `sidebar.panellist`（list，注册项 `id/order/label`），每个条目 id 对应 `main`（keyed by sidebar entry id）中同 key 的面板。现状占用：

| 侧栏 id | 页面 | order |
|---|---|---|
| `plugins` | 插件 | 0 |
| `schedules` | 自动化任务 | 10 |
| `dsh-context` | 上下文 | 20 |

本插件新增：

- `sidebar.panellist` 注册 `id: 'bili-fenshen'`、`order: 15`（位于「自动化任务」之后、「上下文」之前）、`label: 'B站分身'`。图标组件按 ownerProps `{ size, active }` 内联绘制（复用 `icon.svg` 的双电视造型，`currentColor` 为主、active 时用 B站粉/蓝点缀）。
- `main` 注册 `key: 'bili-fenshen'`，渲染控制台页面（`replaceRisk: shadows-shipped-ui`，仅在同 key 冲突时才会遮蔽宿主 UI；本 key 未被占用）。

`main` 面板不绑定 Session，是纯宿主页面，适合控制台。页面自行渲染标题行、子页切换与内容（宿主没有提供页面内的 tab 槽位）。

**入口策略**（已确认）：侧栏独立图标；同时把**设置 → B站分身**缩成一行说明 + 「打开控制台」按钮（调用 `ctx.layout.selectPanel('bili-fenshen')`），不保留两套完整 UI。

## 3. 信息架构

页面顶部一行子页切换：**看板** | **操作台**。

| 关注点 | 看板（看） | 操作台（操作） |
|---|---|---|
| 账号 | 头像、昵称、Lv、UID、硬币、粉丝；登录态徽标 | 重新扫码登录、过期提示 |
| 值班 | 自动值班开关、当前状态、下一窗口倒计时、本轮耗时 | 谷时窗口时段细项 |
| 活动 | **生命周期活动流**（主舞台） | — |
| 配额 | 今日消耗进度（已用/上限） | 配额上限编辑 |
| 内容源 | — | 关键词、订阅 UP 主、人设 |
| 维护 | `▷ 跑一轮`、`■ 中止本轮` | 运行日志、判重表、产物、恢复默认 |

边界原则：**只读的展示全部留在看板，任何会改变插件状态的控件都在操作台**；唯一的例外是「自动值班开关」和「跑一轮/中止」，它们高频且有状态语义，放在看板顶部。

## 4. 数据模型：活动 ledger

现有产物不足以支撑生命周期：`out/YYYY-MM-DD.md` 是人读报告、`seen.md` 是判重账本，二者都以「行」为单位，无法把「一条视频的整段经历」聚起来。因此新增机器账本。

### 4.1 账本位置与格式

`~/.dsh/bili-fenshen/ledger.jsonl`，append-only，一行一个 JSON 事件。日期从事件自带的时间戳推导，不依赖文件。

公共字段：

```ts
{
  t: string,       // ISO 时间戳，事件发生时刻
  round: string | null, // 轮次 id：该轮开始时刻的 ISO 字符串。reply-in 归到：匹配到的 comment 所在轮次 → 否则该 bvid 最近一轮 → 否则 null
  type: 'view' | 'like' | 'comment' | 'dynamic' | 'skip' | 'reply-out' | 'reply-in' | 'round-end',
  bvid?: string,
}
```

各类型追加字段：

```jsonl
{"t":"2026-10-22T08:26:11Z","round":"2026-10-22T08:26:00Z","type":"view","bvid":"BV1xrnz6gEVD","title":"折1万次，会坏吗？iPhone Duo 深度评测","author":"影视飓风","views":3136000,"duration":1492,"source":"hot","grade":"worth"}
{"t":"2026-10-22T08:26:30Z","round":"2026-10-22T08:26:00Z","type":"like","bvid":"BV1xrnz6gEVD"}
{"t":"2026-10-22T08:27:02Z","round":"2026-10-22T08:26:00Z","type":"comment","bvid":"BV1xrnz6gEVD","text":"用原子力显微镜查指纹为什么难擦…","rpid":123456}
{"t":"2026-10-22T08:27:40Z","round":"2026-10-22T08:26:00Z","type":"dynamic","bvid":"BV1xrnz6gEVD","text":"今天看到的最硬核的一期","id":"1261944129867218948"}
{"t":"2026-10-22T08:28:10Z","round":"2026-10-22T08:26:00Z","type":"skip","bvid":"BV1GTnK6sE4Y","title":"为什么福利这么好，法国依然动荡不断？","author":"…","reason":"评论区立场争吵"}
{"t":"2026-10-22T10:41:00Z","round":"2026-10-22T08:26:00Z","type":"reply-in","bvid":"BV1xrnz6gEVD","parent":123456,"rpid":999001,"from":"张三","text":"那个显微镜多少钱","notifId":1185685105221638}
{"t":"2026-10-22T10:42:00Z","round":"2026-10-22T08:26:00Z","type":"reply-out","bvid":"BV1xrnz6gEVD","parent":999001,"text":"三万左右吧，主要是他们租的","rpid":999002}
{"t":"2026-10-22T08:31:10Z","round":"2026-10-22T08:26:00Z","type":"round-end","code":0,"durationMs":192000}
```

- `grade`：`worth | ok | meh`（对应章程的 `值得看 / 可以看 / 不值当`）。
- `source`：`hot | search | follow`（热门 / 关键词搜索 / 订阅 UP）。
- `rpid` 缺失时写 `null`，前端显示「未取到 rpid」，**不编造**。

### 4.2 三个写入方

| 写入方 | 事件 | 时机 |
|---|---|---|
| Agent（值班轮内） | `view` `skip` `like` `comment` `dynamic` `reply-out` | 每执行一个动作立即 append |
| 宿主 | `reply-in` | 回复轮询器（见 4.4） |
| 宿主 | `round-end`（以及轮次开始时的 `round` 标记由首条事件携带） | 子进程退出时 |

### 4.3 兜底解析（防 Agent 漏记账）

每轮 `round-end` 之后，宿主解析本轮新增的报告片段（`out/<day>.md` 中 `## <HH:MM>` 开始的那一段），补齐 ledger 缺失的条目：

- `### BV…` 段落 → 补 `view`（标题/UP/播放量/档位），以及段落里出现的「点赞」「评论（正文）」「动态」→ 补对应事件。
- 「跳过记录」列表 → 补 `skip`（reason 取括号内文字）。
- 补齐的事件带 `"source":"report"`，前端在事件旁标注「据报告回填」，不与 Agent 直写事件重复（按 `(bvid, type, 文本或 rpid)` 去重）。

这样即使某轮 Agent 忘记记账，控制台仍有内容；但精确的 `rpid` 只有 Agent 直写才有。

### 4.4 回复轮询器（reply-in）

`x/msgfeed/reply` 的通知项已由探针确认包含：`item.uri`（视频链接→BV）、`item.title`、`item.source_content`（我的原评论）、`item.target_reply_content`（对方回复正文）、`item.source_id` / `target_id` / `root_id`、`user.nickname` / `avatar`、`reply_time`、通知 `id`。

宿主每 **5 分钟** 轮询一次，条件：凭证有效，且 ledger 近 7 天内存在 `comment` 事件。每次：

1. 取回复通知列表；
2. 对每条未见过（`notifId` 不在 `state.json` 的 `seenNotifs`，上限 500）且能解析出 BV 的通知，append `reply-in`；
3. 匹配归属轮次：优先按 `parent == 某条 comment.rpid`，否则按 `bvid + source_content == comment.text` 精确匹配，再否则归到该 bvid 最近一轮；
4. 更新 `state.json#lastReplyPollAt`。

幂等键：通知 `id`。失败静默重试（下个周期），不打扰账号主人。

### 4.5 保留与清理

- 账本按 5MB 轮转（保留 `ledger.jsonl.old`），与 `duty.log` 同策略。
- 控制台只展示**最近 7 天**（含今天）。更早的数据不进 UI，需要时看 `out/` 下的日报原文（产物 tab）或 `duty.log`。
- 损坏行（JSON 解析失败）跳过并在日志记一笔，不阻塞整个文件。

## 5. 看板页面

### 5.1 布局

```
┌──────────────────────────────────────────────────────────────────┐
│ 不吃鱼的豆腐  Lv6 · 硬币 1447.5 · 粉丝 12 · UID 312299788         │  ← 账号条（头像 + 简况）
│                                          ● 登录有效               │
├──────────────────────────────────────────────────────────────────┤
│ 值班  自动 [开关]   下一窗 12:00（2h54m）   本轮 进行中 1m12s      │  ← 值班条
│                                  [▷ 跑一轮]  [■ 中止]             │
├──────────────────────────────────────────────────────────────────┤
│ 今日  挑中 3/5  评论 2/5  点赞 6/10  动态 0/1                     │  ← 配额进度（细进度条）
├──────────────────────────────────────────────────────────────────┤
│ 16:26 这一轮 · 热门 30 + 搜索「AI 实测」「大模型」                 │
│                                                                   │
│  ┌ BV1xrnz6gEVD  [值得看]  ●赞 ●评 ●2 回复 ────────────────┐     │
│  │ 折1万次，会坏吗？iPhone Duo 深度评测                      │     │
│  │ 影视飓风 · 313.6万播放 · 24:52 · 热门                     │     │
│  │  刷到 ── 看 ── 赞 ── 评 ── 被回复 ── 我回                  │     │
│  │  16:26  16:26 16:26 16:27   16:41    16:42               │     │
│  │  评论：「用原子力显微镜查指纹为什么难擦，这期是真舍得…」    │     │
│  │   └ 张三 16:41「这条我正好也在看，那个显微镜多少钱」        │     │
│  │   └ 我   16:42「三万左右吧，主要是他们租的」               │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                   │
│  ┌ BV1VHJ964EM7  [值得看]  ●赞                            ┐       │
│  ┌ BV1AHnB6NEhM  [可以看]  ●赞                            ┐       │
│  │ ▸ 跳过 3 条：无字幕 1 · 争议话题 1 · 同题重复 1              │   │
│  ▸ 更早：10-22 · 5 条活动    10-21 · 无记录                     │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 活动卡（生命周期的呈现）

一个「活动」= 一个 `bvid` 聚合出的事件串。卡片由三部分组成：

1. **头部**：`BV 号`（可点，跳 B站视频页）+ 档位徽标 + 状态点（赞/评/N 回复）+ 标题 + `UP · 播放量 · 时长 · 来源`。
2. **阶段条**：`刷到 → 看 → 赞 → 评 → 被回复 → 我回`。已达成的节点实心 + 时刻，未达成空心；**被「跳过」的活动只有「刷到」一个节点**，用灰色斜纹区分。
3. **主体**：
   - 评论正文（引号包裹，最多 3 行，超出折叠）。
   - 回复线程：缩进 `└ 昵称 时刻「正文」`，我方的回复用 `我` 标注并高亮；楼中楼再缩进一级。
   - 动态（若有）：单独一行 `动态「…」`，右侧给动态 id 的复制按钮。

**展开策略**（可读性的关键）：
- 有对话（`reply-in` 或 `reply-out`）的活动 → **默认展开**。
- 只有赞/评、无对话 → 默认折叠成一行（标题 + 状态点）。
- 纯浏览（只有 `view`，无动作）→ 默认折叠。
- **跳过**的活动 → 收进「▸ 跳过 N 条」折叠组，默认折叠；展开后每条一个紧凑卡片（标题 + 作者 + 跳过理由），可点开看详情但不再展开正文。

### 5.3 分组与时间

- 主分组：**轮次**（`round`），标题 `16:26 这一轮 · 热门 30 + 搜索「…」`，来源从该轮 `view` 事件的 `source` 与服务端配置推导。
- 轮次倒序；轮内活动按「有对话 → 有动作 → 纯浏览」排序，其次按时间。
- 页面底部「更早」：按天折叠（最近 7 天内），点开加载该天活动。

### 5.4 空态与异常态

| 场景 | 呈现 |
|---|---|
| 从未跑过 | 居中提示 + 「▷ 跑一轮」+ 「去扫码登录」两个按钮 |
| 未登录 | 顶部横幅：`未登录，动作会全部失败` + 「扫码登录」（抽屉） |
| dsh CLI 未找到 | 顶部横幅：`找不到 dsh CLI，值班无法启动` + 操作台里的 `dshBin` 填写入口 |
| 上一轮退出码 ≠ 0 | 顶部横幅（可展开看该轮日志尾部） |
| ledger 里该轮无事件但有报告 | 显示「本轮由报告回填，缺少精确 rpid」提示 |

## 6. 操作台页面

四个 tab（页面自绘）：**配置** | **日志** | **判重表** | **产物**。

### 6.1 配置

分四组，控件只有：开关、数字输入（带 ± 步进）、标签输入（chips，回车追加）、多行文本、下拉/纯文本。

- **值班**：自动值班开关、谷时窗口（中午 12:00–14:00 / 晚间 18:00–次日 09:00 两个独立开关，时段 V1 固定显示、不可改）。
- **配额**：`perDay`、`commentsPerDay`、`commentsPerRound`、`likesPerDay`、`dynamicsPerDay`、`repliesPerRound`。
- **内容源**：`keywords`（chips）、`followUids`（chips，数字校验）。
- **人设**：`personaPrompt` 多行文本（提示：留空=中性；也可填写文件路径）。
- **环境**（只读展示 + 可改 `dshBin`/`headlessProfile`）：dsh CLI 路径与探测结果、headless profile、家目录、账本路径。
- 底部：`恢复默认`（清空覆盖层）、`保存并生效`。

保存语义：写入 `~/.dsh/bili-fenshen/config.json`（运行时覆盖层，原子写），**不写用户的 `cordis.patch.yml`**。生效配置 = `patch config`（默认值）`←` `config.json`（覆盖）。保存后立即刷新调度器与下一次值班用的快照，无需重启。

### 6.2 日志

- 上半：**宿主事件**（结构化）。从 `duty.log` 中筛出 `^\[<ISO>\] ` 开头的行，按时间列出（开跑/结束/退出码/复核/异常），异常行标红。
- 下半：**子进程原文**默认折叠（当前日志里大半是模型的推理文本，不适合常驻视线）。展开后为等宽滚动区，自动滚到底，悬停暂停跟随。
- 右上：`复制路径`、`打开文件`。

### 6.3 判重表

`seen.md` 解析成表格：日期 / BV / 动作 / 标题。动作列用 chip 呈现（看过/赞过/评论过 rpid/分享过/跳过·理由）。顶部搜索框按 BV 或标题过滤。解析失败时降级为原文只读。

### 6.4 产物

- 日期列表（`out/*.md`，最近 30 天），点击在右侧/下方渲染 markdown 原文（等宽、只读）。
- `digest/*.md` 月度归档单独一组。
- `headless-overlay.yml` 只读预览（诊断用）。

## 7. Host API 契约

全部挂在已有的 `/api/bili-fenshen` prefix 路由下（`webServer` 原始 Node handler，风格与现状一致）。仅本机 127.0.0.1 可访问。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/overview` | 聚合：`{account, duty, quota, round, health, lastReplyPollAt}` |
| GET | `/activity?from=&to=&day=` | `{days:[{date, rounds:[{id, startedAt, source, items:[activity]}]}]}` |
| GET | `/account` | `{loggedIn, uname, face, mid, level, coins, fans, following, vip}`（宿主直连 nav + relation/stat，缓存 60s） |
| POST | `/duty` | `{autoDuty:boolean}` → 写覆盖层并立即生效 |
| POST | `/run` | 现有，改为一轮开始时写入轮次标记 |
| POST | `/stop` | 终止当前子进程（`SIGTERM`→2s 后 `kill`） |
| GET | `/config` / POST | 读取生效配置（含来源标注）/ 写入覆盖层（字段白名单 + 类型校验） |
| GET | `/log?tail=200` | `{events:[string], raw:string, path:string}` |
| GET | `/seen` | `{rows:[{date,bvid,action,title}], raw:string}` |
| GET | `/reports` | `{days:[string], digests:[string]}` |
| GET | `/report?day=` | 现有 |
| GET | `/cred`、`POST /login/start`、`GET /login/poll`、`GET /login/qr.png` | 现有 |

活动对象：

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
  events: Event[]        // 该 bvid 的所有事件，按时间正序
  stage: { viewed: boolean; liked: boolean; commented: boolean; replies: number; repliedBack: boolean; dynamic: boolean }
  flags: { fromReport: boolean }   // 是否含兜底回填事件
}
```

轮询节奏（页面打开期间）：`/overview` 3s；`/activity` 运行中 3s、空闲 15s；`/account` 60s。页面隐藏（`visibilitychange`）时暂停，回到前台立即刷新一次。

## 8. Client 实现约束

1. **单文件**：客户端产物是 `client.js` 一个文件（`window.__ModuleLoader__.load({ id, factory(require) })`），无法相对 import 其他文件。看板、操作台、基础控件全部写在这一个文件里，内部按注释分节。
2. **不得 require 宿主 Client 包**（primitives 等）：控件自己实现，样式与行为向宿主看齐（`role="switch"` + `aria-checked`、Escape 关闭抽屉、`disabled` 语义）。
3. **主题 token**：只用 `--dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / border-l1 / border-l2 / label-primary / label-secondary / brand-primary / state-success-primary / state-warn-primary / state-error-primary / state-idle-primary` 与 `--dsw-specific-sidebar-fill`。B站粉 `#fb7299` 仅用于图标/档位徽标这类「品牌点缀」，不作为可读文本色。**删除全部 `--dsh-*` 引用**。
4. **i18n**：本插件是单一中文产品（报告与B站内容本身即中文），V1 界面文案集中在文件顶部的 `T` 常量表，不接入 locale service；`locale/*.json` 继续只承载包的 meta。这是对「UI 文案走 locale」规则的有意例外，理由与范围写在此处，后续要做 i18n 时只需替换 `T` 的取值来源。
5. 组件内联样式随卸载移除；注册一律走 `ctx.slots.inject(...)` + 返回 disposer。
6. 注入的服务：`inject: ['slots', 'layout']`（`layout.selectPanel('bili-fenshen')` 供设置页的「打开控制台」按钮使用）。`main` 面板不绑定 Session，组件不得依赖 session 相关 props。
7. 数据获取走同源相对路径（`fetch('/api/bili-fenshen/…')`），与 `main`/`settings.section` 挂在哪个面板无关。

## 9. MCP 与章程改动

### 9.1 `mcp_server.py`：`bili_reply` 回传 rpid

```python
result = await comment.send_comment(...)
rpid = result.get("rpid") if isinstance(result, dict) else None
return json.dumps({"success": True, "message": "评论发送成功", "rpid": rpid, "bvid": bvid}, ensure_ascii=False)
```

失败分支同样带上 `bvid`。这是生命周期串联的**前置条件**（当前返回只有 `{"success": true}`，导致报告里出现「未取到 rpid」）。

### 9.2 `prompts/duty.md`：新增「记账契约」

在「报告契约」之后插入一节，要求：

- 每执行一个动作（看完/点赞/评论/发动态/跳过/回复别人），**立即**向 `<家目录>/ledger.jsonl` append **一行** JSON（字段见 4.1），用 `>` 重定向或追加写，**绝不覆盖**；
- 评论的 `rpid` 取自 `bili_reply` 返回；返回里没有就写 `null`，不编造；
- 同一动作只记一次；记账失败要在报告里明说；
- 顺序：**先记账，再写报告**（报告已经是人读摘要，账本是控制台的事实来源）。

## 10. 错误与降级

| 情况 | 行为 |
|---|---|
| ledger 行损坏 | 跳过该行，记日志，继续解析 |
| 报告解析失败 | 不补事件，活动卡显示「本轮无可解析报告」 |
| 未登录 / 凭证过期 | 看板横幅 + 登录抽屉；轮询器跳过 `reply-in`；值班轮照常失败但不崩 |
| 无 dsh CLI | 横幅 + 操作台可填 `dshBin` |
| `running` 但子进程已消失 | 15s 后自愈：`running=false`，记日志 |
| 保存配置时字段非法 | 返回 400 + 具体字段，前端保持原值 |
| `webServer` 路由重复注册 | 移除重复激活（见 11），注册失败只记日志不抛 |

## 11. 顺带修复

1. **`--dsh-*` → `--dsw-alias-*`**：设置页与新增页面统一。
2. **日志污染**：控制台区分宿主事件与子进程原文（见 6.2）。`duty.log` 仍全量落盘（诊断需要），只是默认不展示。
3. **`duplicate prefix route "/api/bili-fenshen"`**：`duty.log` 多次出现，说明 Host 插件被激活了两次（或 apply 被重复调用）。排查 `~/.dsh/profiles/desktop/cordis.patch.yml` 是否重复 include；宿主侧加一次性守卫（同一进程内 prefix 路由只注册一次）。
4. **家目录可覆盖**：`HOME` 改为 `process.env.BILI_FENSHEN_HOME || <默认>`，便于用临时目录做验证。
5. **设置页瘦身**：原设置面板改为「说明 + 打开控制台 + 登录态一行」，删除重复的日报/日志展示。

## 12. 非目标（本版不做）

- 视频封面图（已决定后置）。
- 7 天以前的历史归档浏览（去日志/产物看）。
- 7 日趋势折线、压审复核可视化（`verifyRecentSafe` 仍是桩，等 V1.5 真实复核接入后再挂到活动卡上）。
- 多账号切换、私信、上传视频等写操作。
- i18n。

## 13. 验证方案

1. `node --check client.js`、`node --check index.js`（语法）；`python -m py_compile mcp_server.py`。
2. 用 `BILI_FENSHEN_HOME` 指向临时目录，灌入 fixture ledger（含正常/缺 rpid/跳过/损坏行各一例）后启动，验证：`/overview`、`/activity`、`/seen`、`/config` 的 JSON 结构与降级行为。
3. `POST /run` 后用实际轮次产物验证：ledger 有事件、`round-end` 写入、报告兜底解析不重复。
4. 安装 bundle（`plugin_manager install_bundle`）后 `application: applied`；用 `cordis_inspect_query`（`Slots.listSubTree` root=`sidebar.panellist` 与 root=`main`）确认两个 `bili-fenshen` occupant 已注册且 active。
5. 打开 `http://127.0.0.1:57257`：确认侧栏出现第三个图标、点击进入看板、两个子页可切、3s 轮询正常、停止按钮生效、退出页面后不再轮询。
6. 账号条显示与探针结果一致（昵称/UID/Lv/硬币）；未登录时显示横幅而非报错。
7. 清理：验证用的临时家目录与 fixture 删除，真实 `ledger.jsonl` 不被污染。

## 14. 实现顺序

1. **数据层**：`bili_reply` 回传 rpid；ledger 读/写/轮转；reply 轮询器；报告兜底解析；`BILI_FENSHEN_HOME` 可覆盖。
2. **接口层**：`/overview` `/activity` `/account` `/duty` `/stop` `/config` `/log` `/seen` `/reports`。
3. **UI 骨架**：注册 `sidebar.panellist` + `main`，页面外壳（标题行、子页切换、主题 token、轮询 hook）。
4. **看板**：账号条、值班条、配额条、活动流（阶段条 + 回复线程 + 折叠策略）、空态/横幅。
5. **操作台**：配置（覆盖层读写）、日志、判重表、产物。
6. **设置页瘦身 + 顺带修复 + 版本 0.4.0 + 文档更新**（`dsh-plugin/README.md`、`CONTEXT.md` 补「账本」术语）。
