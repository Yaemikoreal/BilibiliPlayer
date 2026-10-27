# 2026-10-28 行为审计：概览页不实时 + 主动接话不落地

- 审计对象：`dsh-plugin`（host `index.js`、`lib/*.js`、`client.js`、`prompts/duty.md`）+ 本机真实运行时 `C:\Users\10369\.dsh\bili-fenshen\`
- 方式：**只读**。未改任何代码、未跑值班轮、未做任何 B站写操作。所有结论附 `file:line` 或运行时数据原文。
- 无法验证的一律标 **未查证**（不猜）。
- 说明：本轮审计**没有**调用 `buildDutyPrompt` 实测 prompt 长度 —— 该函数内有 `log()` 副作用（`index.js:609`），会写真实 `duty.log`。prompt 长度按可静态测量部分给出区间（见 §3.1）。

---

## 0. 结论摘要

| 编号 | 症状 | 首要根因（一句话） | 优先级 |
|---|---|---|---|
| A1 | 一轮跑着，概览配额/进度**整轮不动** | 概览唯一数据源是账本，而**账本是 agent 在轮末一次性批量写入**的（10-27 那轮 10 条事件 `t` 完全相同）；运行中的真实进度只存在于 `lib/live.js`，概览从不消费 | P0 |
| A2 | 「上次值班/上一轮结果」过期或自相矛盾 | `lastRunAt` 在轮**开始**和结束时各写一次（`index.js:773/778`），且 `lastDurationMs/lastCode` 属于上一轮 ⇒ 运行中出现「新开始时间 + 旧结果」组合 | P0 |
| A3 | 界面数据「停住」且无任何提示 | 概览**没有任何推送通道**，只有 3s 轮询；轮询失败时 `usePoll` 保留旧 state 且概览页**从不渲染 error**（`client.js:720-753`，`OverviewPage` 内 `error` 出现 0 次） | P0 |
| A4 | 各卡片互相错代（账号 60s / 活动 3-15s / 人设 30s 各拉各的） | 4 个独立 hook 各自轮询、无 seq/abort，慢响应会覆盖新响应（tearing） | P1 |
| A5 | 「存在感」永远 0 / 「被回复」永远 0 | `like-in` **全仓库没有任何写入方**；`reply-in` 5 条真实事件时间戳是 2026-04（早于 7 天窗）⇒ 恒被过滤 | P1 |
| B1 | 主动接话「从不发生」 | 章程把它写成**可选动作** + 全局「配额是上限不是任务」+ 工具调用 ≤20 预算竞争 ⇒ 模型合法跳过且**不留任何痕迹** | P0 |
| B2 | 宿主/UI 分不清「评估后不接」与「压根没想」 | 没有 `reply-scan` 类事件；`lib/report.js` 只解析 like/comment/dynamic，**接话完全不在解析面**；host 的 `round-end` 只有 code/duration | P0 |
| B3 | 第二轮评估了却写成「接话 0」 | 预算耗尽（已用 13 呼，剩 7）+ 章节白名单太窄（只许「提问/被逗到」，把「生日快乐」这类轻互动排除） | P0 |
| B4 | 接话在活动页被显示成「跟进回复」 | `client.js:1578` 把 `reply-out` 一律标「跟进回复」；`lib/activity.js:12` 把任何 `reply-out` 当成 `repliedBack` | P1 |

**对任务前提的一处修正（重要）**：账本 9 个 round 里只有 1 条 `kind=proactive`，但章程 v4（接话纪律）是 **2026-10-27 14:18 +0800** 才提交的（`git log ea073d9`）。10-22 / 10-25 的 7 个 round **根本没有接话纪律**。真正带 v4 章程跑的是 10-27 的 2 轮：**1 轮接了（15:25），1 轮明确写「接话 0」（15:45）**。所以准确口径是 **1/2**，而不是 1/9 —— 但「只有 1 条」仍然是真问题，因为第二轮连一句「评估了什么、为什么不接」都没留下。

---

## 1. 证据来源

| 类别 | 位置 | 用途 |
|---|---|---|
| host 源码 | `dsh-plugin/index.js`（1625 行）、`lib/{api,live,activity,report,ledger,replies,seen,account}.js` | 数据链路、配额、轮次生命周期 |
| 前端 | `dsh-plugin/client.js`（2897 行） | 轮询/SSE/渲染 |
| 章程 | `dsh-plugin/prompts/duty.md`（206 行 / 9,444 字符） | 接话授权与记账契约 |
| 工具层 | `mcp_server.py`（1763 行） | 白名单门禁、评论/回复语义 |
| 运行账本 | `ledger.jsonl`（76 行 / 25,997 B） | 唯一事实来源 |
| 报告 | `out/2026-10-22.md`、`out/2026-10-25.md`、`out/2026-10-27.md` | 接话在报告里的实际写法 |
| 日志 | `duty.log`（412,478 字符，UTF-8） | 模型推理原文（接话取舍） |
| 判重表 | `seen.md`（9,411 B） | 接话是否被记录 |
| 状态 | `state.json` | `lastRunAt/lastCode/seenNotifs` |

**账本事件盘点**（脚本统计，忽略编码）：`view 39 / like 40 / comment 10 / dynamic 4 / skip 16 / reply-in 5 / reply-out(proactive) 1 / note 3 / round-end 10`。`round-end` 10 条对应 **9 个不同 round id**（`10:39:11` 被 agent 和 host 各写了一次）。

---

## 2. 问题 A：概览页不实时

### 2.1 现状数据流（精确到行）

概览的全部数据来自 **4 个互不相干的轮询**，没有一条推送：

```
ConsolePage (client.js:2723)
├── useOverview()          client.js:756   GET /overview   固定 3000ms
├── useActivity(running)   client.js:758   GET /activity   running?3000:15000
├── useAccount()           client.js:760   GET /account    60000ms（每次真连 B站）
├── usePersona()           client.js:970   GET /persona    30000ms
└── useLive()              client.js:791   GET /live/stream (SSE) —— 只喂「实时」页
```

服务端：

| 路由 | 位置 | 每次请求做什么 |
|---|---|---|
| `GET /overview` | `lib/api.js:157-159` → `index.js:908-949` | `readJson(state.json)` + `dshCliCached(cfg)` + `quotaFromLedger()`（全量读+解析 ledger） |
| `GET /activity` | `lib/api.js:160-163` | `readEvents()` 取近 7 天 → `toActivities` + `groupByDay`（每次全量重算） |
| `GET /account` | `lib/api.js:164-166` | 真网络：`fetchAccount()` → `api.bilibili.com/x/web-interface/nav`（`lib/account.js:23-31`） |
| `GET /live/stream` | `lib/api.js:238-240` → `91-143` | 连上先 snapshot，之后 `live.subscribe`：**`kind:'event'` 发事件帧，其余发 snapshot**（`lib/api.js:130-135`） |
| `GET /live` | `lib/api.js:231-237` | `liveSnapshot(after)` + 今日配额（`index.js:1139-1158`） |

`/overview` 里**没有任何时间戳**，也没有 quota 的生成时刻。全文件搜索 `dataUpdatedAt`：**0 处命中**。

### 2.2 什么时候会刷（现状表）

| 触发 | 是否生效 | 证据 |
|---|---|---|
| 挂载 | ✅ 立即一次 | `client.js:736-745` `start()` 先 `run()` |
| 定时器 | ✅ 概览 3s / 活动 3-15s / 账号 60s / 人设 30s | 见 2.1 |
| 页面隐藏→回前台 | ✅ 立即补一次（仅 `visibilitychange`） | `client.js:741-746` |
| 窗口重新获得焦点（可见但失焦） | ❌ 无 `focus` 监听 | 全文件 `addEventListener('focus'` 0 处 |
| 跑一轮 / 中止 / 切开关后 | ✅ 手动 `ov.refresh()` | `client.js:2744-2755`、`2740-2743` |
| 登录成功后 | ✅ `refreshAll` | `client.js:2762-2766` |
| **SSE 事件 / 快照到达** | ❌ **概览完全不订阅** | `OverviewPage` 收到 `live` prop（`client.js:1296`）后**一次都没用过**（1296-1500 行内 `live` 仅出现在参数解构） |
| 轮次结束 | ⚠️ 只能等下一次 3s 轮询 | `index.js:761-778` 里没有任何通知前端的动作 |

**旁证：概览确实在跑 3s 轮询，且每 60s 付一次冷启动扫描。** `duty.log` 里 `dshBin 探测：… exists=true` 从 `15:27:34` 到 `16:08:38` **每分钟一条**——这是 `buildOverview` 每次调用 `dshCliCached`（`index.js:911`）命中 60s TTL 到期后重跑 `findDshCli` 的 `log()`（`index.js:357/364`）打出来的。副作用：日志被定时任务持续写肥（485 KB，`rotateLogIfBig` 阈值 512 KB，`index.js:283`）。

### 2.3 根因（每条带证据）

**A1 —— 唯一数据源是「轮末批量写入」的账本（P0，最硬的一条）**
`quotaFromLedger()`（`index.js:300-317`）只读 `ledger.jsonl`。而 agent 的记账是**动作全部做完后一次性批量写**：
10-27 那轮 `round=2026-10-27T15:25:07.924Z`，10 条事件的时间戳**全部相同**：

```
{"t":"2026-10-27T23:34:13+08:00",...,"type":"view","bvid":"BV1BFxu6sEVa"}
{"t":"2026-10-27T23:34:13+08:00",...,"type":"like","bvid":"BV1BFxu6sEVa"}
{"t":"2026-10-27T23:34:13+08:00",...,"type":"reply-out","parent":321560862800,"kind":"proactive"}
… 共 10 条，同一秒
```

该轮 `15:25:07Z` 开跑、`15:34:44Z` 结束，事件落在 `15:34:13Z` ⇒ **开跑 9 分钟后才有第一条账本记录**。同理 10-25 那轮 1,091,357 ms（18 分钟）期间账本完全静止。
⇒ 运行中的进度**只能**来自 `live`（工具/动作计数 `lib/live.js:156-161`、`stats`），但概览不消费它。这就是「跑着的时候配额不动」的全部原因。

**A2 —— `lastRunAt` 双写 + `lastCode/lastDurationMs` 属于上一轮（P0）**
`index.js:773`（exit 里：`{lastRunAt, lastWhy, lastCode, lastDurationMs}`）与 `index.js:778`（spawn 成功后：`{lastRunAt, lastWhy}`）。于是运行中 `state.json` 是「**本轮开始时间 + 上一轮的退出码/耗时**」，概览把它们拼成一行「上次值班 23:45 · 1m22s」（`client.js:1341`）——用户看到的必然是错的。
真实 `state.json`：`lastRunAt=2026-10-27T15:46:51.368Z, lastCode=0, lastDurationMs=82509`。

**A3 —— 没有推送 + 失败不显形（P0）**
`usePoll` 的 `catch` 只 `setError`（`client.js:728-730`），**不刷新数据**；而概览页从未读取 `ov.error`（`client.js:1296-1560` 内 `error` 关键字 0 命中）。⇒ HTTP 一挂，卡片就永久停在旧值且毫无提示。再叠加 `/account` 的降级：`fetchAccount` 网络异常时 `catch(()=>null)` → `normalizeAccount(null)` → `{loggedIn:false}`（`lib/account.js:27-30`），一次抖动就能把「已登录」翻成「未登录」，60s 内不会自愈（`client.js:760-763`）。

**A4 —— 4 路轮询无竞态防护（P1）**
`usePoll` 没有 `AbortController`、没有请求序号（`client.js:720-753`）：慢响应后到会覆盖新结果。`/overview` 本身就是可变耗时的（`dshCliCached` 冷启动会 `existsSync` + 目录扫描 `index.js:354-385`；`readEvents` 全量解析到 5 MB 轮转上限 `lib/ledger.js:7`）。四张卡各代混排，视觉上就是「一会儿新一会儿旧」。

**A5 —— 指标本身就是空的，看着像「不更新」（P1）**
- `like-in`：`client.js:1271/1278`、`activity.js`、demo 数据都引用，但 **host 侧没有任何写入方**（`index.js` 只写 `reply-in`，`index.js:807-835`）。⇒「收到点赞」恒为 0。
- `reply-in`：账本里 5 条真实事件时间是 `2026-04-03/06`，而 `presenceFrom` 只统计 7 天内（`client.js:1262-1266`）⇒「被回复」恒为 0，页面一直显示兜底文案「近 7 天没有收到点赞或回复」（`client.js:1396-1397`）。
- 跨时区口径：`presenceFrom` 用 `String(e.t).slice(0,10)`（`client.js:1268`）取日期，而趋势轴用本地 `dayKeyOf`（`client.js:1215`）——`+08:00` 事件与 host 写的 `Z` 事件在半夜会落到不同日期。

**A6 —— 配额卡把「每轮上限」和「今日累计」摆在同一行（P1）**
`client.js:1328-1329`：`['主动接话', quota.repliesProactive, limits.replyOthersPerRound, '每轮上限']`。左值是**今日累计**（`index.js:302-313` 按本地日累加），右值是**每轮上限** ⇒ 跑两轮就可能显示 `2/3` 甚至 `3/3` 而其实当天完全合规。语义混着显示，用户只能理解为「卡住/不对」。

**A7 —— 「今日轮次」与活动流有结构性缺口（P1）**
`roundsToday` 由 `/activity` 反推（`client.js:1304-1306`），而 `toActivities` 只按**带 bvid 的事件**分组（`lib/activity.js:31-37`）；`round-end`/`note` 无 bvid ⇒ 整轮没有 bvid 事件（例如 10-25 的两次 no-action 轮，账本只有 `note`）**不会出现在活动页**。同时 `bvid:"-"` 的跳过项会生成一个 `bvid='-'` 的伪视频卡。

**A8 —— 时间戳可信度异常（P1，原因未查证）**
`round=2026-10-27T15:45:28.824Z` 那轮：host 的 `round-end` 是 `t=15:46:51.356Z`（`durationMs=82509`），但同一轮 agent 写的 5 条事件 `t=2026-10-27T23:52:40+08:00`（= `15:52:40Z`），文件顺序上**排在 round-end 之前**。即 agent 写的时间比 host 记录的轮次结束还晚 5m49s。`readEvents` 按 `t` 字符串排序（`lib/ledger.js:84`）⇒ 这一轮的「最新事件/最后一轮」排序会被带偏。**根因未查证**，但足以说明「账本时间戳不能当排序权威」。

### 2.4 设计：单一实时数据契约

**原则**：一个信封、一条流、一个序号。所有「概览需要的数字」在服务端一次算完，客户端不做跨请求拼装。

#### (1) 服务端：新增 `lib/realtime.js`（新文件，纯逻辑 + 注入 IO）

```js
// 可复用现有基建：lib/live.js 的 subscribe/onPush 模式、lib/api.js 的 openSse/closeSse
export function createOverviewHub({ getOverview, watchPaths, now = Date.now,
                                    debounceMs = 250, minIntervalMs = 800 })
// 返回 { view(), publish(reason), close() }
//  - view() → { ok, seq, serverTime, dataUpdatedAt, data }
//  - seq 单调递增（照抄 lib/live.js:5-8 的理由：客户端只做「更大」判断）
//  - dataUpdatedAt 只在「一次完整重算完成」后写；解析失败保留上一次值并置 degraded:true
//  - 变更来源：fs.watch(HOME)（ledger.jsonl / state.json / config.json）+ 2s stat 兜底轮询
//  - 合并节流：debounce 250ms，最短间隔 800ms（防 agent 批量写 10 行触发 10 次重算）
```

配套抽取（都是纯函数，便于单测）：
- `lib/overview.js`（新）：把 `index.js:908-949` 的 `buildOverview` 抽成 `buildOverview({ cfg, state, events, liveSnap, now })` —— 现在它没法单测，因为依赖 `effCfg()`/`dshCliCached` 全局。
- `lib/schedule.js`（新）：`nextRunAt(cfg, now)` 从 `WINDOWS/inWindow`（`index.js:319-327`）与 `nextWindowLabel`（`index.js:892-906`）抽出，返回**绝对 epoch**，供 `tick()` 与概览共用同一套逻辑（避免两处算法漂移）。

#### (2) 概览信封要新增的字段（服务端）

```jsonc
{
  "ok": true,
  "seq": 1287,                       // 新增：单调序号
  "serverTime": "2026-10-28T00:30:00.000Z",  // 新增：响应生成时刻
  "dataUpdatedAt": "2026-10-28T00:29:59.870Z",// 新增：数据重算完成时刻
  "sources": { "ledgerAt": "…", "stateAt": "…", "liveAt": "…" }, // 新增：各源 mtime，便于诊断
  "quota": {
    "picked": 2, "comments": 1, "likes": 2, "dynamics": 1,
    "replies": 1, "repliesProactive": 1,
    "replyScans": 1, "proactiveSkipped": 0,     // 新增（见 §3）
    "limits": { "…": 0 },
    "perRound": {                                // 新增：本轮口径，别再和日累计混
      "roundId": "…", "picked": 2, "comments": 1, "proactive": 1, "scans": 1
    },
    "updatedAt": "2026-10-28T00:29:59.870Z"      // 新增
  },
  "round": {
    "running": true, "roundId": "…", "startedAt": "…",
    "elapsedMs": 512000,
    "phase": { "key": "act", "label": "发言" },   // 新增：直接借 live.snapshot().phase
    "stats": { "tools": {}, "actions": {}, "errors": 0 }, // 新增：运行中唯一可信进度
    "nextRunAt": 1761...,                         // 新增：绝对时刻，null=自动关
    "nextWindowLabel": "…",
    "lastRound": {                                // 新增：从账本按 roundId 聚合，不用 state.json
      "roundId": "…", "startedAt": "…", "endedAt": "…",
      "code": 0, "durationMs": 576600,
      "counts": { "views": 2, "likes": 2, "comments": 1, "replies": 0,
                  "proactive": 1, "dynamics": 1, "skips": 2, "scans": 1 }
    }
  },
  "inbox": { "pendingReply": 0, "lastPollAt": "…", "lastPollOk": true }, // 新增
  "presence": { "likes7d": 0, "replies7d": 0, "comments7d": 3,
                "trend": [], "latest": {} },      // 新增：搬到服务端算（现在在 client.js:1254-1284）
  "account": { "loggedIn": true, "…": "…", "stale": false,
               "checkedAt": "…" },                // 新增：/account 结果并入信封（5 min 缓存）
  "health": { "cli": "…", "cliCheckedAt": "…", "cred": true, "routeOk": true }
}
```

要点：
- `account` 并入信封（保留 `/account` 路由做冷启动/兼容），避免第 4 路轮询；网络失败时返回 `stale:true` + 上一次 good 值，**不把 `loggedIn` 翻成 false**。
- `presence` 搬到服务端：顺带修 A5 的两处口径（统一用 `dayKeyOf`；`like-in` 没有数据源就先返回 `available:false` 并在 UI 说明，别硬显示 0）。
- `round.stats` 直接取 `live.snapshot()`，运行中就有进度，不受账本写入时机影响（解 A1）。

#### (3) 一条流：`GET /api/bili-fenshen/stream`（SSE）

复用 `lib/api.js:91-143` 的 SSE 骨架（已有 `SSE_MAX_CLIENTS=4`、15s 心跳、`closeSse()` 卸载清理），把 payload 换成信封：

| 帧 | 何时推 |
|---|---|
| `{type:'hello', seq, serverTime}` | 连接建立 |
| `{type:'overview', seq, dataUpdatedAt, data}` | ① 连接建立；② 被 watch 的文件变化（debounce 250ms）；③ 轮次 start/end（在 `index.js:722`、`766` 处 `hub.publish()`）；④ `replyTick` 完成（`index.js:831` 之后）；⑤ 配置保存（`POST /config`、`POST /duty`） |
| `{type:'tick'}`（仅 running） | 运行中每 **1500ms** 一帧轻量帧（只带 `round.elapsedMs/phase/stats/quota.perRound`），保证秒表与动作计数连续 |
| `: ping` | 15s 心跳（保持不变） |

`/overview` 保留，但改成 `hub.view()` 的直接输出（同一份 seq / dataUpdatedAt），作为 SSE 不可用时的降级通道。

#### (4) 客户端：一个 `useRealtime()` 协调器替换 4 路 hook

```js
// client.js 新增，替换 useOverview/useActivity/useAccount（usePersona 保留独立，30s 够用）
function useRealtime() { /* 返回 { data, mode:'sse'|'poll', ageMs, error, refresh } */ }
```

- **主通道**：`new EventSource('/api/bili-fenshen/stream')`；`seq` 单调守卫 —— `if (msg.seq <= seqRef.current) return`（照抄 `useLive` 的 `mergeFrames` seq 去重思路，`client.js:824-839`）。
- **降级**：`onerror` → 关流、`mode='poll'`、自适应间隔 `running ? 2000 : 10000`。
- **请求竞态**：每次 fetch 用 `AbortController`，发新请求前先 abort 旧的；响应再按 `seq` 比较，小的直接丢（**双保险**，解 A4）。
- **刷新触发（明确清单）**：挂载 / `visibilitychange` 可见 / **`window.focus`（新增）**/ SSE 帧到达 / `onRun|onStop|onToggle|onLoggedIn` 后 `refresh()`（沿用现有调用点 `client.js:2744-2766`）/ 轮次结束帧。
- **数据年龄**：`ageMs = Date.now() - Date.parse(dataUpdatedAt)`（用 `serverTime` 校一次 clock skew），概览页头渲染 `<StalenessBadge>`：`>15s` 黄「数据 18s 前」，`>60s` 红「数据 2m 前，正在重连」；`error` 非空时同样显形（解 A3）。
- **口径拆分**：配额卡左值口径明确写出来 ——「今日」与「本轮」两块分开渲染（`quota` / `quota.perRound`），解 A6。

#### (5) 兼容与降级
- 新字段全部**追加**；老客户端不认识的字段直接忽略。
- SSE 连不上 → 轮询 `/overview`，行为与今天一致（但有了 seq/age/error）。
- `lib/live.js` 不改契约，只被 `buildOverview` 读取（`snapshot()` 已含 `phase/stats/running`，无需改动）。
- 单测友好：`createOverviewHub` 接受注入的 `getOverview`/时钟/`watchPaths`，不碰真 fs。

---

## 3. 问题 B：没有主动尝试去回复别人的评论

### 3.1 事实与证据

**账本（唯一事实来源）**

```json
{"t":"2026-10-27T23:34:13+08:00","round":"2026-10-27T15:25:07.924Z","type":"reply-out",
 "bvid":"BV1CqnW6oE8B","parent":321560862800,
 "text":"设计师：这不是bug，这是定向降温[doge]","rpid":318378624657,"kind":"proactive"}
```

全账本 `kind=proactive` 仅此 1 条；`reply-in` 5 条、`round-end` 10 条（9 轮）。
时间线：章程 v4 提交于 `2026-10-27 14:18 +0800`（`git log ea073d9`），此前 7 轮无接话纪律。v4 之后有 2 轮：`15:25:07Z`（接 1 条）、`15:45:28Z`（明确「接话 0」）。配置 `replyOthersPerRound`：`config.json` 现值 **3**（mtime `2026-10-27 23:45:22`，正好在第二轮开跑前 6 秒被改），zod 默认 **2**（`index.js:176`），设计文档写 **2**（`design §3.1`）。三轮数字不一致。

**报告（`out/2026-10-27.md`）**

```
L21  动作：点赞 + 评论（rpid 318378624417）：`…` + 接话（rpid 321560862800）：`设计师：…`
L27  小结：本轮挑中 2、点赞 2、评论 1、接话 1、动态 1、跟进回复 0。
L47  本轮挑中 2、点赞 2、评论 1、接话 0、动态 0（今日已达 1/1）、跟进回复 0。
```

即：报告里**有**接话结论（含「接话 0」），但 `lib/report.js` 一个字节都不解析它。

**判重表**：`seen.md` 仅 1 条 `接话过rpid`（10-27 那轮）。

**日志（`duty.log`，37 行提到「接话」）** —— 关键两轮原文：

第一轮（15:25，做了）：
```
Also 沉淀 (bili_persona_note) optional — skip to save budget… The 接话 quota is 2 — proactive replies…
Also possible 接话 in that comment section — budget dependent.
Trim options: skip 接话 (save 1), skip one like?…
Total action calls: like×2 + comment×1 + 接话×1 + dynamic×1 = 5 calls (16→21)… Over budget by 3.
```
第二轮（15:45，没做），两个候选都被否，且**原因是预算 + 白名单**：
```
Or a 接话 opportunity: … "牛肺串叫夫妻肺片，那老两口确实也是夫妻[doge]" — … But proa…
Let me also consider 接话: the hot comment "今天是我生日…" — … "生日快乐，明天记得给自己加个串[doge]"
   — … But 接话纪律 says 值得接的两类: 能答清的提问 + 被逗到/共鸣.
Budget check: used 13 calls. Remaining 7. Needs: like food (1), comment food (1), like 冬冰 (1) = 3 → 16…
```
⇒ 模型**确实在评估**，但（a）预算不够了就砍它，（b）「生日快乐」这种轻互动被章程的两类白名单挡住。

**prompt 长度**（静态测量，未实测：见文首说明）：章程 9,444 字符（`<家目录>` 替换后 ≈9,489），其中 `## 接话纪律` 从第 5,251 字符开始（**章程的 55.3%**，位于 评论纪律 1,769 字之后、动态纪律之前）；再叠加 intro (~50) + 人设前段 (≤3,000，`lib/persona/budget.js:16-19`) + 参数块 (≈2,500，含已看过清单：实测近 14 天合法 BV 32 条 / 415 字符) + 人设后段 (≤3,000) ⇒ **整轮 prompt ≈15,000–17,000 字符**，远低于软线 20,000 / 硬线 24,000（`budget.js:22-25`），`guardPrompt` 不会截断（`index.js:686-692` 只在 `over` 时丢人设后段）。结论：**接话纪律一定进得了 prompt，位置在正中间，不存在「被截断」问题**——问题不在可达性，在**约束力**。

### 3.2 端到端逐环诊断

**B1 章程措辞：明写「可选」，且被三条全局纪律盖住（P0）**
- `duty.md:120`「接话是**可选动作**：热评里没值得接的就不接，别为凑数硬接（跟「配额是上限不是任务」同款）」
- `duty.md:93`「**配额是上限，不是任务**：真有话说才评；宁可少评」
- `duty.md:118`「拿不准就不接」+ `duty.md:12-13`「拿不准就按"跳过"处理」
- `duty.md:99`「顺手看一眼**有没有值得接的话**…这是**可选动作**，到量就停」
⇒ 任何一轮只要说一句「没值得接的」，就完全合规。**没有任何一处要求留下「我评估过」的证据。**

**B2 优先级与预算竞争：接话排在动作序列第 4 位，且要抢 ≤20 的工具预算（P0）**
- `duty.md:22`「**工具调用 ≤ 20 次/轮**」是一条「纪律」；`duty.md:62-67` 动作顺序：点赞 → 评论 → 回复 → **接话** → 动态。接话排在评论纪律（30 行）之后，实操上总是在预算最紧的时候才轮到。
- 日志实证：第一轮为了腾预算，明确讨论「skip 接话 (save 1)」；第二轮 13 呼用完后直接不接。
- 注意：接话的**边际成本其实只有 1 次 `bili_reply`**（热评在评论流程里已经拉了），但章程没有这样告诉模型。

**B3 prompt 组装：配额只给「上限」，没有「必须评估」；也缺去重弹药（P0）**
`buildDutyPrompt`（`index.js:599-694`）里关于接话只有一行（`index.js:672`）：
```
+ `主动接话本轮最多 ${Math.max(0, Number(cfg?.replyOthersPerRound ?? 2))} 条（0 = 本轮不接）。\n`
```
- 词是「最多」，天然读成上限；
- 没有「本轮必须做一次接话扫描」；
- **没有注入「已接过的 target」**（对比：已看过清单 BV 有注入，`index.js:673-676`）⇒ 章程 `duty.md:119`「同一个人同一话题只接一次」宿主帮不上忙，只能靠 `seen.md` 自觉；
- 没有告诉模型 `bili_comments` 每条都带 rpid（只有章程 `duty.md:115` 说了一句）。

**B4 工具层：工具都在，能力够，但有摩擦（P1）**
- 白名单：`config.json.dutyTools` 含 `bili_comments`/`bili_reply`/`bili_received_replies`；overlay 把它写成 `BILI_MCP_TOOLS`（`index.js:570-596`），`mcp_server.py:39-53` 的 `_gated_tool` 只注册名单内的 → **接话所需工具 100% 可用**。
- `bili_comments` 返回 **rpid**（`mcp_server.py:437`），按点赞序（`order=LIKE`，`:426`），`num` 默认 30（`:466-477`）⇒ 拿得到回复目标。
- **摩擦 1**：子评论 `top_replies` 只给 `user/content/like`，**没有 rpid**（`mcp_server.py:446-453`）。UI/模型看到「楼里有人说话」却无法接，而章程 `duty.md:116` 又明令「不钻别人的子回复」——工具在诱导、章程在禁止，浪费推理。
- **摩擦 2**：热评是「点赞最高」的一批，天然以一句话抖机灵为主，可接性低；没有「只看有提问/有回复的评论」的过滤参数。

**B5 执行机制：rpid/root 语义正确，但结果不可验证（P1）**
`mcp_server.py:651-702`：`rpid=0` 发新评论；`rpid≠0` 时 `actual_root = root if root != 0 else rpid`（`:682`），再 `send_comment(root=actual_root, parent=rpid)`（`:683-690`）。⇒ **接一级评论只需传 `rpid`，`root` 留空**，语义正确。返回 `result.get("rpid") or data.rpid`（`:692-700`）。
但：
- 返回 `rpid` 可能为 `None`（`:692-694` 两个键都可能缺），为 `None` 时章程要求写 `null`（`duty.md:164`）；实际账本里另有 `"id":"待补"` 这种非法值（10-25 一条 dynamic），说明「不许编造」的约束并非不可违反。
- **没有任何发后核验**：`verifyRecentSafe`（`index.js:854-864`）是纯桩，只读 `state.commentsToVerify`，而这个键**从来没人写**；`index.js:775` 的 90s 复核因此永远空转。⇒ 接话发出去失败（风控/审核）宿主也不知道。

**B6 记账：接话有约定，但宿主不校验、不聚合（P0）**
`duty.md:122/163` 要求 `reply-out` 带 `"kind":"proactive"`；`quotaFromLedger`（`index.js:310-313`）确实统计 `repliesProactive`。**但**：
- 若 agent 忘了写账本、只写在报告里 ⇒ 宿主**永远补不回来**：`backfillFromReport`（`index.js:461-485`）走 `parseRoundReport`，而 `lib/report.js:87-92` 只产出 like/comment/dynamic 三种动作，**没有接话**。
- `round-end`（`index.js:768`）只写 `{code, durationMs}`；agent 自己在账本里写过更丰富的 `round-end`（10-25：`{"picked":5,"likes":6,"comments":2,"dynamic":1,"replies":0}`），但**没有任何消费方**（`quotaFromLedger` 忽略 round-end）。

**B7 报告契约：格式有，解析没有（P1）**
`duty.md:143` 定义了 `动作：评论（rpid …） + 接话（rpid 318143807425）：`正文``，报告也照写了（`out/2026-10-27.md:21`）。但 `parseCommentAction`（`lib/report.js:46-54`）取 `tail = act.slice(act.indexOf('评论'))` 后用**第一个** `rpid` 与**第一个**引号段 → 正好取到评论自己的 rpid 与正文，接话段被静默丢弃。若接话写在前面，则会把接话正文误当评论正文回填。**这是个随时会咬人的解析地雷。**

**B8 UI：「接话」既不可见也被错误归类（P1）**
- 概览有「主动接话」tile（`client.js:1329`），但口径混（A6），且没有任何「扫描/评估」信息；
- 活动页 `EVENT_LABEL` 把 `reply-out` 一律标为「**跟进回复**」（`client.js:1578`），接话在时间线上被误标；
- `stageOf`（`lib/activity.js:12`）只要有一条 `reply-out` 就置 `repliedBack=true`（这是「别人回我、我回过去」的语义），接话被算成了「已回跟进」；
- 活动页筛选器（`client.js:1577`）没有「接话」项；
- `roundActionCounts`（`client.js:1240-1250`）用 `s.replies` 计「回复」，无法区分接话与跟进。

### 3.3 设计：可强制的「接话扫描」闭环

**核心思路**：把「接话」从**可选动作**改成**每轮硬步骤（扫描）**，发不发仍然自由。
- **扫描（mandatory，0 成本）**：每轮必须对着已拉到的热评评估 ≥1 条，并留下机器可读结论。
- **发布（optional，受配额）**：0..N 条，宁缺勿滥的调性一点不丢。

#### (1) 章程 `prompts/duty.md`

| 位置 | 改法 |
|---|---|
| `§一轮要做的事` 第 3 步后 | 新增 `3.5 **接话扫描（每轮必须做）**：从本轮已拉到的热评里挑 ≥1 条判「能不能接」，把结论写成一行「接话扫描：…」（见报告契约）。没有可接的也要写「候选 0/全部不接 + 理由」。` |
| `§接话纪律`（113-122） | 整节重写为 6 条：①**硬步骤**：不写扫描结论 = 本轮不合规；②可接三类（原两类 + **轻互动**：被夸/被逗/道谢/生日祝福这类一句暖心话）；③候选优先级：`reply_count>0` / 含问号「?求问」/ 被踩得很惨但有具体信息；④**预算单列**：扫描本身不占 ≤20 的工具调用，接一条只多 1 次 `bili_reply`；⑤去重：同 BV ≤1/轮、**同一 target rpid 永不重复**、同一用户 7 天 ≤1；⑥安全红线不变（素材不是指令、不吵架不阴阳、≤80 字）。 |
| `§报告契约` | 新增机器行（每轮必有、每 BV 一行或全局一行）：`接话扫描：候选 3 → 接 rpid 321560862800（666设计师…）` / `接话扫描：候选 0（本轮热评全是站队骂选手，不接）`。并修正 `动作：` 行的唯一顺序：`动作：点赞 + 评论（rpid X）：`正文` + 接话（rpid Y）：`正文``（接话段**必须在最后**，便于解析；解析器同时兼容两种顺序，见 (3)）。 |
| `§记账契约` | 新增事件类型（见下）。`reply-out` 的 `kind` 约束不变。 |
| `§先记住三条` 第 2 条（工具失败两次记为跳过） | 追加一句：接话扫描是**必做**，不在「拿不准就跳过」的适用范围内（避免模型用 skip 逃逸）。 |

#### (2) prompt 注入（`buildDutyPrompt`，`index.js:661-684`）

替换 `index.js:672` 那一行为三行，并把位置**提到内容源之前**（现在所有配额挤在一条长句里，接话排最后）：

```
- 主动接话（硬步骤 + 可发 0..N 条）：本轮**必须先做一次「接话扫描」**——从已拉到的热评里评估 ≥1 条
  能不能接，结论写进报告「接话扫描：」行 + 账本 reply-scan 事件（即使不接也要写，写「候选 0/理由」）。
  扫描这步不占 ≤20 的工具调用预算；接一条只多 1 次 bili_reply。可发上限 N 条（0 = 只扫描不发）。
- 已接话清单（宿主从账本算好，近 14 天；命中 = 别再重复接）：BV1CqnW6oE8B · 对方 rpid 321560862800；
  __EMPTY__（空——还没接过，照常挑）
- 回复接话的正确姿势：bili_comments 每条都带 rpid；bili_reply 传 rpid=<对方一级评论 rpid>，
  root **留空**（工具会自动置 root=rpid，进楼中楼）。返回里的 rpid 是你自己的楼层，记进账本。
```

新增纯函数 `proactiveTargetsFromLedger(events, { days = 14 })`（放 `lib/replies.js`，照 `lib/seen.js` 的「窗口+上限+纯函数」写法），返回 `[{ bvid, parent, round, t }]`。宿主注入空态时给明确指引（别给空白）。

#### (3) 记账 / 报告：机器可读

**新账本事件**（`duty.md §记账契约`）

```jsonc
{"t":"…","round":"…","type":"reply-scan","bvid":"BV1CqnW6oE8B",
 "candidates":[{"rpid":321560862800,"user":"666设计师","like":396,"verdict":"接","why":"一句能答的吐槽"}],
 "decision":"posted","targetRpid":321560862800,"postedRpid":318378624657}
{"t":"…","round":"…","type":"reply-scan","bvid":"BV1RyxT61EHn",
 "candidates":[{"rpid":0,"user":"","like":0,"verdict":"不接","why":"评论区在吵'该不该较真'"}],
 "decision":"skipped","reason":"热评全是站队，接一句就是掺和"}
```

约束：`type=reply-scan` 必须每轮 ≥1 条；`decision ∈ {posted, skipped}`；`posted` 必须带 `targetRpid`（且同轮应有对应 `reply-out kind=proactive`）。

**报告解析**（`lib/report.js` 新增，纯函数、失败返回 null、绝不抛）

```js
export const parseProactiveScan = (text) => ({ scans: [...], proactive: [...] })
// scans:      匹配 /^接话扫描[：:]\s*(.+)$/m → { bvid?, candidates, decision, reason, targetRpid, postedRpid }
// proactive:  从 动作 行里抽 `接话（rpid N）：`正文`` → { bvid, parent, text, rpid }
// 硬要求：parseCommentAction 必须先「剥离」接话段再解析评论段（修 B7 地雷）
```

`backfillFromReport`（`index.js:461`）扩展：账本缺 `reply-out/proactive` 时用报告补（`source:'report'`），缺 `reply-scan` 时补 `reply-scan`。这样「agent 忘写账本」不再导致数据消失——这正是 10-25 那次「账本少 4 条导致配额算错」的同类事故。

#### (4) 宿主侧 attempt / skip 记账（`index.js`）

新增纯函数（建议放 `lib/round.js`，便于单测）：

```js
export function roundAccounting(events, roundId) → {
  scans, posted, skipped, views, likes, comments, dynamics, replies,
  proactiveMissing,            // true = 该轮读了内容但既没扫描也没接
  reason                       // 'no-scan' | 'scan-but-skip' | 'posted' | 'no-content'
}
```

- `index.js:767-771`（child exit）：`round-end` 事件追加 `{ replyScans, proactiveReplies, proactiveSkipped, proactiveMissing }`（**向后兼容：只增字段**）。
- 判定 `proactiveMissing`：该轮 `view` 事件 ≥1（说明真读了内容，理论上有热评可评估）且 `scans==0 && posted==0`。
- 缺失时：`log('本轮未做接话扫描（不合规）round=…')` + 追加 `{"type":"note","text":"round incomplete: no reply-scan"}`（沿用 `index.js:768` 的 appendEvents 通道），并让 §2 的信封里 `round.lastRound.proactiveMissing=true` 传到 UI。
- `quotaFromLedger`（`index.js:300-317`）增记 `replyScans`、`proactiveSkipped`；`liveSnapshot`（`index.js:1139-1158`）与 `/overview` 一并输出。
- 仅对**部署之后开始的轮次**生效：用 `state.json` 写一个 `replyScanSince`（首次启动时间），早于此的轮次不判违规（避免历史轮次全红）。

#### (5) 配额语义（写清楚，别再混口径）

| 字段 | 含义 | 默认 | 口径 |
|---|---|---|---|
| `replyOthersPerRound` | **可发**上限（0 = 只扫描不发） | 2（统一 zod/文档/配置，见 P2-3） | 每轮 |
| `replyScanPerRound`（新，可省） | 扫描次数下限，硬步骤 | 1 | 每轮 |
| `quota.repliesProactive` | 今日已发接话 | — | 日累计 |
| `quota.replyScans` | 今日扫描次数 | — | 日累计 |
| `quota.perRound.proactive/scans` | 本轮已发/已扫 | — | 本轮 |

UI 必须**分两栏**显示（今日 / 本轮），否则永远看不懂（解 A6）。

#### (6) 去重规则（三层，宿主兜前两层）

1. **宿主注入**（新增）：`proactiveTargetsFromLedger` 的近 14 天 `(bvid, parent)` 清单 → 模型一眼看到「已接过」；
2. **宿主硬拒**（可选 P2）：`roundAccounting` 若发现同 `(bvid,targetRpid)` 重复 `posted` → 记 `note` 警告（不阻断，但可见）；
3. **`seen.md`** 兜历史（`duty.md:175` 动作枚举已有「接话过rpid」）。

新增条数限制：同 BV 每轮 ≤1（章程已有）；同一用户 7 天 ≤1（`reply-scan.candidates[].user` 可用于校验）。

#### (7) UI 呈现（`client.js` + `lib/activity.js`）

| 位置 | 改动 |
|---|---|
| 概览配额卡 | 「主动接话」拆两行：`今日 1 / 上轮扫描 1 · 接 1`；不接时显示 `上轮扫描 1 · 不接（理由截断）` |
| 概览值班卡 | 新增「上轮接话」一行：`扫描 N · 接 M · 跳过原因`；`proactiveMissing` 时红色 chip「未扫描」 |
| 活动页 | `EVENT_LABEL['reply-out']` 按 `kind` 分「接话」/「跟进回复」；新增筛选 `['reply-scan','接话扫描']`；`roundActionCounts` 增加 `proactive`/`scan` |
| 实时页 | 轮次结束摘要显示 `接话：扫描 N / 接 M`（数据已在 `round-end`） |
| `lib/activity.js` | `stageOf` 增加 `scanned`、`proactive`；`repliedBack` 只看非 proactive 的 `reply-out`；`toActivities` 收 `security` 之外不新增分组（`reply-scan` 无 bvid 时不产生伪卡片） |

#### (8) 工具层（`mcp_server.py`，小改）

| 位置 | 改动 |
|---|---|
| `_fetch_comments:446-453` | 子评论补 `"rpid": sub.get("rpid")`（一行），或在章程明确「子回复不可接」时**直接删掉 `top_replies`**（二选一；推荐补 rpid，未来可接） |
| `bili_reply` docstring `:652-662` | 明确写出「主动接话：`rpid=对方一级评论 rpid`，`root` 留空」并给出示例 |
| `bili_comments` | 可选新增 `order: 'like'|'time'` 与 `questions_only: bool`（P2，先不做也行） |

#### (9) 向后兼容
- 账本新事件类型是**增量**；旧账本没有 `reply-scan`，`roundAccounting` 得 0 → 用 `replyScanSince` 开关避免历史误判。
- `round-end` 只加字段；`lib/report.js` 新解析器失败返回 `null`，`backfillFromReport` 用可选链兜住。
- 前端所有新字段用 `|| 0` / 可选链（现有代码风格如此，如 `client.js:1328`）。
- 配置新增项走 `lib/config.js` FIELDS（`config.js:18` 已有 `replyOthersPerRound: 'number'`），缺省不报错。

---

## 4. 优先级修复清单（含验收标准）

### P0（不做就等于没修）

| # | 项 | 改动文件/函数 | 验收标准 |
|---|---|---|---|
| P0-1 | 概览单一信封 + 推送（A1/A3/A4） | 新 `lib/realtime.js`、新 `lib/overview.js`、`lib/api.js`（新 `/stream`）、`index.js:722/766/831/1499-1525`（publish 挂钩） | ① 一轮运行中，概览「本轮工具/动作」计数在 **2s 内**反映真实工具调用；② 轮次结束 **1s 内**概览显示新 `lastRound`，无需手动刷新；③ 断开 `/stream` 自动降级轮询，页面出现「数据 Ns 前」徽标；④ `/overview` 响应含 `seq/serverTime/dataUpdatedAt`，且同一秒内多次请求 `seq` 不回退 |
| P0-2 | 对账口径修根（A2/A6） | `index.js:908-949` → `lib/overview.js`；`lib/schedule.js` 新 `nextRunAt`；`state.json` 不再双写 `lastRunAt`（改为 `lastStartedAt`/`lastEndedAt` 两键） | ① 运行中概览不再出现「本轮开始时间 + 上轮耗时」组合；② `nextRunAt` 是绝对时间戳，客户端能倒计时，且与 12:00/18:00 窗口/跨午夜/自动关 4 种情况单测一致；③ 配额卡「今日」与「本轮」两栏数值口径不混 |
| P0-3 | 接话改成硬步骤（B1/B2/B3） | `prompts/duty.md`（§一轮要做的事、§接话纪律、§报告契约、§记账契约）、`index.js:661-684`（三行注入 + 已接话清单） | ① 任一 v4 之后的轮次，报告里**必然**出现 `接话扫描：` 行（或账本 `reply-scan`）；② 连续 3 轮真实运行，`proactiveMissing=false` ≥3/3；③ prompt 里「接话」出现在「内容源」之前，且字数增量 <600（不挤压预算） |
| P0-4 | 宿主 attempt 记账 + 报告回填（B6/B7） | `lib/report.js`（`parseProactiveScan` + 剥离接话段）、`index.js:461-485`（backfill）、`index.js:768`（round-end 扩展）、`index.js:300-317`（quota） | ① 账本只写报告不写事件时，`/overview.quota.repliesProactive` 仍能 =1；② 动作行两种顺序（评论在前/接话在前）都解析成 `{comment, proactive}` 两条，不串正文（单测覆盖）；③ `round-end` 含 `{replyScans, proactiveReplies, proactiveSkipped, proactiveMissing}`；④ 无扫描的轮次出现 `round incomplete: no reply-scan` note |

### P1

| # | 项 | 改动 | 验收 |
|---|---|---|---|
| P1-1 | 指标数据源修根（A5） | `index.js` `replyTick` 增 `like-in` 拉取（`bili_received_at_and_likes` 需进 `dutyTools`，本机 config 未含）；`lib/account.js` 失败不翻 `loggedIn`；`presence` 搬到服务端 | ① 收到点赞真正入库（本机跑一轮后 `like-in` ≥1 或明确 `available:false`）；② 断网时「账号」卡显示「数据陈旧」而非「未登录」；③ 趋势轴统一按本地日 |
| P1-2 | 接话可见性（B4/B8） | `client.js:1240-1250/1577-1579`、`lib/activity.js:9-24` | ① 活动页出现「接话」chip 且与「跟进回复」分开；② 筛选器有「接话扫描」；③ `stageOf.stage.repliedBack` 对 proactive 为 false |
| P1-3 | 工具摩擦（B4） | `mcp_server.py:446-453/652-662` | ① 子评论带 rpid 或不出现在返回里；② `bili_reply` docstring 示例含主动接话 |
| P1-4 | 发后核验（B5） | `index.js:854-864` 实装为「发后 90s 用只读接口查该 rpid 是否可见」，把结论写 `verify` 事件 | ① 接话失败（风控）时账本/UI 能标「未可见」；② 不阻断轮次 |
| P1-5 | 错误显形 + 焦点刷新（A3） | `client.js:720-753`（abort + seq + `error` 透出）、`OverviewPage` 渲染 `error/ageMs` | ① 模拟 `/overview` 500 → 页面出现红色横幅；② 窗口重新聚焦立即刷新一次 |

### P2

| # | 项 | 说明 |
|---|---|---|
| P2-1 | `dshCliCached` 副作用 | `buildOverview` 每次触发 `findDshCli` 的 `log()`（每分钟一条，撑大 `duty.log`）。改为进程启动探一次 + 手动诊断触发；`health.cliCheckedAt` 输出到信封 |
| P2-2 | 活动流脏数据 | `bvid:"-"` 跳过项生成伪视频卡；`round-end` 由 agent/host 双写（10-25 一条）。`toActivities` 过滤非 BV bvid；宿主写 round-end 时 `isDuplicate` 幂等 |
| P2-3 | 配置默认值漂移 | `replyOthersPerRound`：zod 2 / 设计 2 / 真实配置 3 → 统一为 2 并写入 `lib/config.js` 注释 |
| P2-4 | 时间戳权威性 | agent 写的事件 `t` 可能晚于 host 的 round-end（10-27 15:45 轮差 5m49s，**根因未查证**）。建议宿主侧追加 `receivedAt`（写入时刻），排序/「最新」判断用 `receivedAt`，展示用 `t` |
| P2-5 | 报告小结口径 | 小结里的「接话 N」目前纯文本；改为解析后回填（P0-4 已含），并在 `reportLevel=brief` 时也强制保留该行 |

---

## 5. 测试计划

### 5.1 单元（`node --test`，现有 156 例基线）

| 文件 | 新增用例 |
|---|---|
| `test/report.test.js` | ①`接话扫描：候选 3 → 接 rpid X` 解析；②「候选 0（理由）」；③动作行「评论在前」→ 取到 comment rpid 321…/正文=A，proactive rpid=321…/正文=B（**不串**）；④动作行「接话在前」同断言；⑤`接话没做`/`未接话` 否定不产生事件；⑥无扫描行 → `scans: []`；⑦旧报告（10-22 格式）回归不变 |
| `test/replies.test.js` | ⑧`proactiveTargetsFromLedger` 14 天窗；⑨去重 `(bvid,parent)`；⑩无 parent 忽略；⑪空账本 → `[]` |
| `test/activity.test.js` | ⑫`kind=proactive` 的 `reply-out` 不再置 `repliedBack`；⑬`stage.proactive/scanned` 计数；⑭`reply-scan`（无 bvid）不产生视频卡；⑮`bvid:"-"` 被过滤 |
| `test/round.test.js`（新） | ⑯`roundAccounting` 四态（posted / scan-but-skip / no-scan / no-content）；⑰`proactiveMissing` 边界（`view=0` 不判违规） |
| `test/overview.test.js`（新） | ⑱`nextRunAt`：11:00→12:00、13:00→18:00、19:00→次日12:00（跨午夜）、`autoDuty:false`→null；⑲`lastRound` 从账本聚合（含 1 条 proactive → `counts.proactive=1`）；⑳`dataUpdatedAt` 只在重算后更新，解析失败保留旧值 + `degraded:true` |
| `test/realtime.test.js`（新） | ㉑hub debounce 合并（10 次 publish → ≤2 次重算）；㉒seq 严格单调；㉓`view()` 在 `getOverview` 抛错时返回上一份 + `degraded` |
| `test/config.test.js` | ㉔`replyOthersPerRound` 默认 2、负值拒绝 |

### 5.2 集成（`test/index.integration.mjs`，fixture 账本）

1. fixture 含 1 条 `reply-out kind=proactive` + 1 条 `reply-scan` → `GET /overview`：`quota.repliesProactive=1`、`quota.replyScans=1`、`round.lastRound.counts.proactive=1`、`seq` 为数字。
2. `GET /activity`：该 BV 的 `stage.proactive=1`、`repliedBack=false`，响应含 `EVENT_LABEL` 可区分的 `kind`。
3. 账本只有报告、没有 reply-out → 调 `backfillFromReport` 后账本出现 `reply-out kind=proactive`（幂等：连调两次不重复）。
4. `round-end` 断言新字段存在；无扫描轮次断言出现 `note: round incomplete`。

### 5.3 渲染冒烟（`test/client.render-smoke.mjs`）

- 注入信封 `{dataUpdatedAt: now-30_000}` → 断言出现「数据 30s 前」文案与 warn 样式类；
- 注入 `proactiveMissing: true` → 断言出现红色「未扫描」chip；
- 注入活动数据含 `reply-scan` 与 `reply-out kind=proactive` → 断言出现「接话」「接话扫描」文本；
- 缺字段（`dataUpdatedAt: undefined`、`quota.perRound` 缺失）→ 不抛、渲染 `—`。

### 5.4 端到端手测（1 轮真跑，需用户在场授权）

1. 开控制台 → 概览 → 点「跑一轮」→ 观察：运行中「工具/动作」计数每 1-2s 变化（P0-1）；
2. 轮次结束 1s 内：值班卡「上次值班」显示本轮结束时间 + 本轮耗时，「上轮接话：扫描 N · 接 M」；
3. 检查 `ledger.jsonl`：该 round 有 `reply-scan`（或 `note: round incomplete: no reply-scan`）；
4. 检查 `out/<date>.md`：含 `接话扫描：` 行；
5. 检查 `seen.md`：若有接话，含 `接话过rpid`；
6. 连续两轮针对同一 BV：第二轮 `reply-scan` 应显示该 BV 已在「已接话清单」中且不重复接。

---

## 6. 未查证 / 风险

| 项 | 状态 |
|---|---|
| `buildDutyPrompt` 真实字符数 | **未查证**（审计禁写：函数内 `log()` 会写真实 `duty.log`）。按静态分量估算 15k–17k，不影响结论（远低于 24k 硬线） |
| 10-27 `15:45` 轮「agent 事件晚于 host round-end 5m49s」的成因 | **未查证**。只陈述观测事实，修复建议用 `receivedAt` 规避 |
| 接话是否真的成功可见（未被风控/审核吞掉） | **未查证**。账本记 `rpid=318378624657` 只能证明接口返回成功，不能证明外显 |
| `B站 msgfeed.reply_time` 为何返回 2026-04 | **未查证**（可能是接口字段语义/时区分歧）。但「5 条 reply-in 全部落在 7 天窗外」是账本事实，A5 结论成立 |
| SSE 在 DSH Web 面板内（iframe/webview）的 `document.hidden` 行为 | **未查证**。若宿主为后台标签/遮挡窗口，轮询会整体暂停——这也是把主通道改为 SSE 的理由之一 |
| 真实配置 `dutyTools` 是否含 `bili_received_at_and_likes` | 已查：**不含**（`config.json`）。P1-1 需要加 |
