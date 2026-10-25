# B站分身控制台 实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「B站分身」从设置页里的一节面板升级为 DSH 左侧栏的全宽控制台（看板 + 操作台），并让「B站活动生命周期」由一本机器账本驱动。

**Architecture:** Host 侧把 `index.js` 里的纯逻辑拆成 `lib/*.js`（账本、报告解析、活动聚合、配置、回复拉取、路由工厂），用 `node --test` 覆盖；`index.js` 只做接线（调度、spawn、轮次生命周期、路由挂载）。Client 侧仍是单文件 `client.js`，注册 `sidebar.panellist` 图标 + `main` 页面，样式从 `docs/demo/bili-fenshen-console.html` 移植并把宿主 `--dsw-*` token 映射为局部变量。

**Tech Stack:** Node 22（`node --test`、ESM）、Cordis Host/Client 插件 API、React 18（浏览器模块表）、Python 3.12（`mcp_server.py`）。

**依据文档：**
- 设计：[`docs/superpowers/specs/2026-10-23-bili-fenshen-console-design.md`](../specs/2026-10-23-bili-fenshen-console-design.md)
- 视觉基准：[`docs/demo/bili-fenshen-console.html`](../../demo/bili-fenshen-console.html) + 截图 [`docs/demo/shots/`](../../demo/shots/)
- 术语：[`CONTEXT.md`](../../../CONTEXT.md)

> **已验证**：Task 1–6 里的 `ledger.js` / `report.js` / `activity.js` / `config.js` / `replies.js` / `account.js` / `api.js` 及其测试**已实跑通过**（`node --test`，共 31 个用例全绿）。实现时请照抄代码；若你改动逻辑，先让测试重新变绿。Task 7 之后是接线与 UI，无法离线单测，必须按各任务的「验证」步骤在真实 DSH 里走一遍。

---

## 环境事实（先读这段，能省很多试错）

| 事实 | 值 |
|---|---|
| 插件目录 | `E:\myproject\BilibiliPlayer\dsh-plugin`（junction 链接到 profile，**改文件后重启 DSH 即生效，无需重装**） |
| profile | `C:\Users\Administrator\.dsh\profiles\desktop` |
| 家目录（运行产物） | `C:\Users\Administrator\.dsh\bili-fenshen`（可用 `BILI_FENSHEN_HOME` 覆盖） |
| venv Python | `E:\myproject\BilibiliPlayer\.venv\Scripts\python.exe` |
| GUI | `http://127.0.0.1:57257`（直接 `Invoke-WebRequest` 会被 401 挡；接口测试用 `cordis_inspect_query` 或页面内 fetch） |
| Node | 系统 `node v22.21.0`，`node --test` 可用 |
| 现有端点 | `/api/bili-fenshen/{status,run,report,log,cred,login/*}` 已可用 |

**纪律**（来自既有事故，务必保持）：

- 定时器回调与所有文件写入必须 `try/catch` 兜死——插件再错也只能「这一轮没跑成」；
- 找不到 dsh CLI 明确报缺失，绝不裸 spawn `dsh`；
- 任何 `import` 失败不能让整条插件不激活（可选依赖一律优雅降级）；
- 子进程必须保存引用，供 `POST /stop`；`exit` 后清空。

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `dsh-plugin/lib/ledger.js` | 新建 | 账本 append / 读取 / 轮转 / 去重 |
| `dsh-plugin/lib/report.js` | 新建 | 报告 markdown → 兜底事件（纯函数） |
| `dsh-plugin/lib/activity.js` | 新建 | 事件 → 轮次/活动聚合 + 阶段计算（纯函数） |
| `dsh-plugin/lib/config.js` | 新建 | 默认值合并、`config.json` 覆盖层（纯 IO + 校验） |
| `dsh-plugin/lib/account.js` | 新建 | 账号信息（nav + relation/stat）拉取与归一 |
| `dsh-plugin/lib/replies.js` | 新建 | msgfeed 通知 → `reply-in` 事件（纯映射）+ 拉取 |
| `dsh-plugin/lib/api.js` | 新建 | 路由 handler 工厂（依赖注入，可单测） |
| `dsh-plugin/index.js` | 重写 | 只做接线：调度、spawn、轮次生命周期、路由挂载、工具注册 |
| `dsh-plugin/client.js` | 重写 | 单文件：注册 + 看板 + 操作台 + 设置页瘦身版 |
| `dsh-plugin/prompts/duty.md` | 修改 | 新增「记账契约」一节 |
| `dsh-plugin/package.json` | 修改 | `files` 加 `lib/*.js`；`scripts.test`；版本 0.4.0 |
| `dsh-plugin/README.md` | 修改 | 控制台说明、账本说明 |
| `mcp_server.py` | 修改 | `bili_reply` 回传 `rpid` |
| `CONTEXT.md` | 修改 | 补术语：活动、生命周期、账本 |
| `dsh-plugin/test/*.test.js` | 新建 | `node --test` 单测 |

---

## Task 0：基线确认

**Files:** 无改动

- [ ] **Step 1: 确认运行时**

Run:
```powershell
node -v
& "E:\myproject\BilibiliPlayer\.venv\Scripts\python.exe" -V
```
Expected: `v22.x` 与 `Python 3.12.x`。

- [ ] **Step 2: 确认插件是链接安装（改文件即生效）**

Run:
```powershell
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-bili-fenshen" | Select-Object LinkType,Target
```
Expected: `LinkType=Junction`，`Target=E:\myproject\BilibiliPlayer\dsh-plugin`。**若为拷贝安装，改完必须 `dsh plugin --profile desktop add link:E:\myproject\BilibiliPlayer\dsh-plugin`。**

- [ ] **Step 3: 记录现有家目录产物（后续对比用）**

Run:
```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\bili-fenshen" | Select-Object Name,Length
```
Expected: 至少 `duty.log`、`state.json`、`out\`、`seen.md`。

- [ ] **Step 4: 语法基线**

Run:
```powershell
cd E:\myproject\BilibiliPlayer\dsh-plugin; node --check index.js; node --check client.js
```
Expected: 无输出（退出码 0）。

---

## Task 1：账本 `lib/ledger.js`

**Files:**
- Create: `dsh-plugin/lib/ledger.js`
- Test: `dsh-plugin/test/ledger.test.js`

- [ ] **Step 1: 写失败测试**

```js
// dsh-plugin/test/ledger.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, readEvents, isDuplicate } from '../lib/ledger.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-ledger-'))

test('appendEvents 追加 JSONL，一行一个事件', () => {
  const file = join(dir(), 'ledger.jsonl')
  appendEvents(file, [
    { t: '2026-10-22T08:26:11Z', round: 'r1', type: 'view', bvid: 'BV1', title: 't' },
    { t: '2026-10-22T08:26:30Z', round: 'r1', type: 'like', bvid: 'BV1' },
  ])
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).type, 'like')
})

test('readEvents 跳过损坏行，并按时间正序返回', () => {
  const file = join(dir(), 'ledger.jsonl')
  writeFileSync(file, [
    '{"t":"2026-10-22T08:27:00Z","type":"comment","bvid":"BV1","text":"b","rpid":2}',
    '{ this is not json',
    '{"t":"2026-10-22T08:26:00Z","type":"view","bvid":"BV1","title":"a"}',
    '',
  ].join('\n'))
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'view')
  assert.equal(events[1].type, 'comment')
})

test('readEvents 文件不存在时返回空数组', () => {
  assert.deepEqual(readEvents(join(dir(), 'nope.jsonl')), [])
})

test('isDuplicate 对同 (bvid,type,text) 的兜底事件判重', () => {
  const existing = [{ bvid: 'BV1', type: 'comment', text: 'hi', source: 'agent' }]
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'comment', text: 'hi', source: 'report' }), true)
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'comment', text: 'other', source: 'report' }), false)
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'like', source: 'report' }), false)
})

test('appendEvents 在超过上限时轮转为 .old', () => {
  const file = join(dir(), 'ledger.jsonl')
  writeFileSync(file, 'x'.repeat(2048) + '\n')
  appendEvents(file, [{ t: '2026-10-22T09:00:00Z', type: 'like', bvid: 'BV1' }], { rotateBytes: 1024 })
  assert.ok(readFileSync(file + '.old', 'utf8').length > 0)
  assert.equal(readEvents(file).length, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd E:\myproject\BilibiliPlayer\dsh-plugin; node --test test/ledger.test.js`
Expected: FAIL，`Cannot find module '../lib/ledger.js'`。

- [ ] **Step 3: 实现**

```js
// dsh-plugin/lib/ledger.js
/**
 * 账本：append-only JSONL。一行一个事件，见设计文档 §4。
 * 所有 IO 都在 try/catch 里——账本写失败绝不能拖垮值班轮。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024

export function appendEvents(file, events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return 0
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES
  // ⭐ 先轮转、再追加：否则刚写入的事件会被一起卷进 .old，主文件变空
  try {
    if (existsSync(file) && statSync(file).size > rotateBytes) {
      renameSync(file, file + '.old')
    }
  } catch {
    /* 轮转失败不影响主流程 */
  }
  const line = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  try {
    appendFileSync(file, line, 'utf8')
  } catch {
    return 0
  }
  return events.length
}

export function readEvents(file) {
  let text = ''
  try {
    if (!existsSync(file)) return []
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') out.push(ev)
    } catch {
      /* 损坏行跳过 */
    }
  }
  out.sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')))
  return out
}

export function isDuplicate(existing, candidate) {
  const key = (e) =>
    [e.bvid || '', e.type || '', e.type === 'like' ? '' : (e.text || '')].join('\u0000')
  return existing.some((e) => key(e) === key(candidate))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ledger.test.js`
Expected: `# pass 5`，`# fail 0`。

- [ ] **Step 5: 提交**

```powershell
cd E:\myproject\BilibiliPlayer
git add dsh-plugin/lib/ledger.js dsh-plugin/test/ledger.test.js
git commit -m "feat(ledger): 账本 JSONL 读写/轮转/去重 + 单测"
```

---

## Task 2：报告兜底解析 `lib/report.js`

**Files:**
- Create: `dsh-plugin/lib/report.js`
- Test: `dsh-plugin/test/report.test.js`

- [ ] **Step 1: 写失败测试**

```js
// dsh-plugin/test/report.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoundReport } from '../lib/report.js'

const REPORT = `## 16:26 值班轮次（登录已恢复）

### BV1xrnz6gEVD

- 标题：折1万次，会坏吗？iPhone Duo深度评测
- UP：影视飓风 · 播放 313.6 万 · 24:52
- **档位**：值得看
- 动作：点赞 + 评论（「用原子力显微镜查指纹为什么难擦…」）+ 发动态分享

### BV1AHnB6NEhM

- 标题：《影之刃零》最终预告
- UP：影之刃零 · 播放 140.2 万 · 3:11
- **档位**：可以看
- 动作：点赞

跳过记录（不计入挑中）：

- BV1XynB6EEiM（何同学 iPhone Duo）：与影视飓风同题重复，跳过。
`

test('解析出全部 pick 段与跳过项', () => {
  const { views, skips } = parseRoundReport(REPORT, { round: 'r1' })
  assert.equal(views.length, 2)
  assert.equal(skips.length, 1)
})

test('view 事件带标题/UP/档位/动作事件', () => {
  const { views } = parseRoundReport(REPORT, { round: 'r1' })
  const v = views.find((x) => x.bvid === 'BV1xrnz6gEVD')
  assert.equal(v.title, '折1万次，会坏吗？iPhone Duo深度评测')
  assert.equal(v.author, '影视飓风')
  assert.equal(v.views, 3136000)
  assert.equal(v.grade, 'worth')
  const actions = v.actions.map((a) => a.type)
  assert.deepEqual(actions.sort(), ['comment', 'dynamic', 'like'].sort())
  assert.equal(v.actions.find((a) => a.type === 'comment').text, '用原子力显微镜查指纹为什么难擦…')
})

test('跳过项取到 reason 与 bvid', () => {
  const { skips } = parseRoundReport(REPORT, { round: 'r1' })
  assert.equal(skips[0].bvid, 'BV1XynB6EEiM')
  assert.match(skips[0].reason, /同题重复/)
})

test('档位映射：可以看 → ok', () => {
  const { views } = parseRoundReport(REPORT, { round: 'r1' })
  assert.equal(views.find((x) => x.bvid === 'BV1AHnB6NEhM').grade, 'ok')
})

test('空报告返回空结果，不抛异常', () => {
  const r = parseRoundReport('', { round: 'r1' })
  assert.deepEqual(r.views, [])
  assert.deepEqual(r.skips, [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/report.test.js`
Expected: FAIL，`Cannot find module '../lib/report.js'`。

- [ ] **Step 3: 实现**

```js
// dsh-plugin/lib/report.js
/**
 * 报告 → 兜底事件（设计文档 §4.3）。
 * 只在账本缺该事件时使用，事件带 source:'report'，前端标注「据报告回填」。
 * 解析失败一律返回空结果，绝不抛。
 */
const GRADE = { 值得看: 'worth', 可以看: 'ok', 不值当: 'meh' }

const toViews = (s) => {
  const m = /([\d.]+)\s*万/.exec(s)
  if (m) return Math.round(parseFloat(m[1]) * 10000)
  const n = /(\d+)/.exec(s.replace(/,/g, ''))
  return n ? parseInt(n[1], 10) : undefined
}

const toDuration = (s) => {
  const m = /(\d+):(\d{2})/.exec(s)
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : undefined
}

export function parseRoundReport(text, opts = {}) {
  const round = opts.round ?? null
  const views = []
  const skips = []
  if (!text || typeof text !== 'string') return { views, skips }

  // 只取本轮区块：以 "## " 开头的最后一段（宿主传入的已是本轮新增片段时直接解析）
  const sections = text.split(/^### /m)
  for (const raw of sections.slice(1)) {
    const lines = raw.split('\n')
    const first = (lines[0] || '').trim()
    const bvid = (/^(BV[0-9A-Za-z]+)/.exec(first) || [])[1]
    if (!bvid) continue
    const body = lines.slice(1).join('\n')

    const title = (/标题[：:]\s*(.+)/.exec(body) || [])[1]?.trim()
    const upLine = (/UP[：:]\s*(.+)/.exec(body) || [])[1]?.trim() || ''
    const author = upLine.split('·')[0].trim()
    const gradeRaw = (/\*\*档位\*\*[：:]\s*(\S+)/.exec(body) || [])[1]
    const actLine = (/动作[：:]\s*(.+)/.exec(body) || [])[1]?.trim() || ''

    const actions = []
    if (/点赞|赞过/.test(actLine)) actions.push({ type: 'like' })
    const cmt = /评论（「([\s\S]*?)」）/.exec(actLine)
    if (cmt) actions.push({ type: 'comment', text: cmt[1].trim(), rpid: null })
    const dyn = /动态(?:分享|（「([\s\S]*?)」）)?/.exec(actLine)
    if (dyn && /发动态|动态分享/.test(actLine)) {
      actions.push({ type: 'dynamic', text: (dyn[1] || '').trim() })
    }

    views.push({
      bvid,
      title,
      author,
      views: toViews(upLine),
      duration: toDuration(upLine),
      grade: GRADE[gradeRaw] || undefined,
      actions,
    })
  }

  // 跳过记录：从「跳过记录」到该节结束（下一个 "## " 之前）
  const skipIdx = text.search(/跳过记录/)
  if (skipIdx >= 0) {
    const tail = text.slice(skipIdx)
    const stopAt = tail.search(/\n## /)
    const block = stopAt >= 0 ? tail.slice(0, stopAt) : tail
    for (const line of block.split('\n')) {
      const m = /^-\s*(BV[0-9A-Za-z]+)[（(]([^）)]*)[）)]\s*[：:]\s*(.+)$/.exec(line.trim())
      if (!m) continue
      skips.push({ bvid: m[1], title: m[2].trim(), reason: m[3].trim() })
    }
  }

  const stamp = opts.t || new Date().toISOString()
  return {
    views: views.map((v) => ({ ...v, round, t: stamp, source: 'report' })),
    skips: skips.map((s) => ({ ...s, round, t: stamp, source: 'report', type: 'skip' })),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/report.test.js`
Expected: `# pass 5`。若「动作」解析不符，按失败用例调整正则后再跑。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/lib/report.js dsh-plugin/test/report.test.js
git commit -m "feat(report): 报告 → 兜底事件解析 + 单测"
```

---

## Task 3：活动聚合 `lib/activity.js`

**Files:**
- Create: `dsh-plugin/lib/activity.js`
- Test: `dsh-plugin/test/activity.test.js`

- [ ] **Step 1: 写失败测试**

```js
// dsh-plugin/test/activity.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toActivities, dayKeyOf, stageOf } from '../lib/activity.js'

const EV = [
  { t: '2026-10-22T08:26:11Z', round: 'r1', type: 'view', bvid: 'BV1', title: 'A', author: 'UP1', views: 100, grade: 'worth', source: 'hot' },
  { t: '2026-10-22T08:26:30Z', round: 'r1', type: 'like', bvid: 'BV1' },
  { t: '2026-10-22T08:27:00Z', round: 'r1', type: 'comment', bvid: 'BV1', text: '我的评论', rpid: 11 },
  { t: '2026-10-22T08:28:00Z', round: 'r1', type: 'dynamic', bvid: 'BV1', text: '动态' },
  { t: '2026-10-22T09:00:00Z', round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 11, rpid: 21, from: '张三', text: '回复我' },
  { t: '2026-10-22T09:05:00Z', round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 11, rpid: 22, from: '李四', text: '再问一句' },
  { t: '2026-10-22T09:10:00Z', round: 'r1', type: 'reply-out', bvid: 'BV1', parent: 21, rpid: 31, text: '我回答' },
  { t: '2026-10-22T08:29:00Z', round: 'r1', type: 'skip', bvid: 'BV2', title: 'B', reason: '无字幕' },
  { t: '2026-10-22T08:30:00Z', round: 'r1', type: 'view', bvid: 'BV3', title: 'C', author: 'UP3', grade: 'ok' },
]

test('按 bvid 聚合成活动，跳过项单独标记', () => {
  const { activities } = toActivities(EV)
  assert.equal(activities.length, 3)
  const a = activities.find((x) => x.bvid === 'BV1')
  assert.equal(a.stage.viewed, true)
  assert.equal(a.stage.liked, true)
  assert.equal(a.stage.commented, true)
  assert.equal(a.stage.dynamic, true)
  assert.equal(a.stage.replies, 2)
  assert.equal(a.stage.repliedBack, true)
  assert.equal(a.stage.pendingReply, 1)          // 2 条回复里只回了 1 条
  assert.equal(activities.find((x) => x.bvid === 'BV2').skipped.reason, '无字幕')
  assert.equal(activities.find((x) => x.bvid === 'BV3').events.length, 1)
})

test('按轮次分组，轮次倒序，轮内有对话的排前面', () => {
  const { rounds } = toActivities([
    ...EV,
    { t: '2026-10-22T12:00:00Z', round: 'r2', type: 'view', bvid: 'BV9', title: 'Z' },
  ])
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].id, 'r2')                 // 倒序：r2 在前
  const r1 = rounds.find((x) => x.id === 'r1')
  assert.equal(r1.items[0].bvid, 'BV1')            // 有对话的排最前
})

test('stageOf 对纯浏览给出最小阶段', () => {
  const s = stageOf([{ type: 'view' }])
  assert.deepEqual(s, { viewed: true, liked: false, commented: false, replies: 0, repliedBack: false, dynamic: false, pendingReply: 0 })
})

test('dayKeyOf 从 ISO 时间取本地日期', () => {
  assert.match(dayKeyOf('2026-10-22T08:26:11Z'), /^2026-10-2[12]$/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/activity.test.js`
Expected: FAIL，`Cannot find module '../lib/activity.js'`。

- [ ] **Step 3: 实现**

```js
// dsh-plugin/lib/activity.js
/** 事件 → 活动/轮次（设计文档 §5）。纯函数，不碰 IO。 */

export function dayKeyOf(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function stageOf(events) {
  const types = new Set(events.map((e) => e.type))
  const repliesIn = events.filter((e) => e.type === 'reply-in')
  const repliedBack = types.has('reply-out')
  const answered = new Set(events.filter((e) => e.type === 'reply-out').map((e) => e.parent))
  const pendingReply = repliesIn.filter((e) => !answered.has(e.rpid)).length
  return {
    viewed: types.has('view') || types.has('skip'),
    liked: types.has('like'),
    commented: types.has('comment'),
    replies: repliesIn.length,
    repliedBack,
    dynamic: types.has('dynamic'),
    pendingReply,
  }
}

const convScore = (a) => (a.stage.replies > 0 || a.stage.repliedBack ? 0 : a.stage.liked || a.stage.commented ? 1 : 2)

export function toActivities(events) {
  const byBvid = new Map()
  const skipped = new Map()
  for (const e of events) {
    if (!e || typeof e.bvid !== 'string' || !e.bvid) continue
    if (!byBvid.has(e.bvid)) byBvid.set(e.bvid, [])
    byBvid.get(e.bvid).push(e)
    if (e.type === 'skip') skipped.set(e.bvid, e)
  }

  const activities = []
  for (const [bvid, evs] of byBvid) {
    const sorted = [...evs].sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')))
    const view = sorted.find((e) => e.type === 'view') || {}
    const stage = stageOf(sorted)
    activities.push({
      bvid,
      title: view.title || skipped.get(bvid)?.title || '',
      author: view.author || '',
      views: view.views,
      duration: view.duration,
      source: view.source,
      grade: view.grade,
      skipped: skipped.has(bvid) ? { reason: skipped.get(bvid).reason } : undefined,
      events: sorted,
      stage,
      flags: {
        fromReport: sorted.some((e) => e.source === 'report'),
      },
    })
  }

  const byRound = new Map()
  for (const a of activities) {
    const roundId = a.events[0]?.round || null
    if (!byRound.has(roundId)) byRound.set(roundId, [])
    byRound.get(roundId).push(a)
  }

  const rounds = [...byRound.entries()].map(([id, items]) => {
    const ordered = [...items].sort((a, b) => convScore(a) - convScore(b) ||
      String(a.events[0]?.t || '').localeCompare(String(b.events[0]?.t || '')))
    return {
      id: id || 'unknown',
      startedAt: ordered[0]?.events[0]?.t || '',
      sourceLabel: sourceLabelOf(ordered),
      items: ordered,
    }
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))

  return { activities, rounds }
}

function sourceLabelOf(items) {
  const sources = new Set(items.map((a) => a.source).filter(Boolean))
  if (sources.has('hot')) return '热门'
  if (sources.has('search')) return '搜索'
  if (sources.has('follow')) return '订阅'
  return ''
}

export function groupByDay(rounds, dayKeyOfEvent = dayKeyOf) {
  const days = new Map()
  for (const r of rounds) {
    const day = dayKeyOfEvent(r.startedAt) || 'unknown'
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(r)
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, rs]) => ({ date, rounds: rs }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/activity.test.js`
Expected: `# pass 4`。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/lib/activity.js dsh-plugin/test/activity.test.js
git commit -m "feat(activity): 事件 → 活动/轮次聚合 + 单测"
```

---

## Task 4：配置覆盖层 `lib/config.js`

**Files:**
- Create: `dsh-plugin/lib/config.js`
- Test: `dsh-plugin/test/config.test.js`

- [ ] **Step 1: 写失败测试**

```js
// dsh-plugin/test/config.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultsOf, readOverride, writeOverride, effectiveConfig, validateFields } from '../lib/config.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-cfg-'))

const PATCH = { autoDuty: false, perDay: 5, commentsPerDay: 5, keywords: ['AI'], rejectMe: 'x' }

test('defaultsOf 只取白名单字段', () => {
  const d = defaultsOf(PATCH)
  assert.equal(d.autoDuty, false)
  assert.equal(d.perDay, 5)
  assert.equal('rejectMe' in d, false)
})

test('writeOverride/readOverride 往返一致（缺省返回空对象）', () => {
  const file = join(dir(), 'config.json')
  assert.deepEqual(readOverride(file), {})
  writeOverride(file, { autoDuty: true })
  assert.deepEqual(readOverride(file), { autoDuty: true })
})

test('effectiveConfig 覆盖层优先，并给出每字段来源', () => {
  const file = join(dir(), 'config.json')
  writeOverride(file, { perDay: 9 })
  const { values, sources } = effectiveConfig(PATCH, file)
  assert.equal(values.perDay, 9)
  assert.equal(values.commentsPerDay, 5)
  assert.equal(sources.perDay, 'override')
  assert.equal(sources.commentsPerDay, 'patch')
})

test('validateFields 拒绝未知字段与错误类型', () => {
  assert.equal(validateFields({ nope: 1 }).ok, false)
  assert.equal(validateFields({ perDay: 'five' }).ok, false)
  assert.equal(validateFields({ perDay: 7 }).ok, true)
  assert.equal(validateFields({ autoDuty: true, keywords: ['a'] }).ok, true)
})

test('effectiveConfig 忽略覆盖层里的脏数据', () => {
  const file = join(dir(), 'config.json')
  writeOverride(file, { perDay: 9, bogus: 1 })
  const { values } = effectiveConfig(PATCH, file)
  assert.equal('bogus' in values, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL，`Cannot find module '../lib/config.js'`。

- [ ] **Step 3: 实现**

```js
// dsh-plugin/lib/config.js
/**
 * 配置：patch config 为默认值，<家目录>/config.json 为运行时覆盖层（设计文档 §12.3）。
 * 白名单 + 类型校验；原子写；脏数据静默忽略。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const FIELDS = {
  autoDuty: 'boolean',
  noon: 'boolean',
  night: 'boolean',
  perDay: 'number',
  commentsPerDay: 'number',
  commentsPerRound: 'number',
  likesPerDay: 'number',
  dynamicsPerDay: 'number',
  repliesPerRound: 'number',
  keywords: 'array',
  followUids: 'array',
  personaPrompt: 'string',
  reportLevel: 'string',
  dshBin: 'string',
  headlessProfile: 'string',
  dutyTools: 'array',
}

const isType = (spec, v) =>
  spec === 'array' ? Array.isArray(v)
  : spec === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : typeof v === spec

export function defaultsOf(patchConfig) {
  const src = patchConfig && typeof patchConfig === 'object' ? patchConfig : {}
  const out = {}
  for (const [k, spec] of Object.entries(FIELDS)) {
    if (isType(spec, src[k])) out[k] = src[k]
  }
  return out
}

export function readOverride(file) {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (FIELDS[k] && isType(FIELDS[k], v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function writeOverride(file, fields) {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(fields, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function effectiveConfig(patchConfig, file) {
  const defaults = defaultsOf(patchConfig)
  const override = readOverride(file)
  const values = { ...defaults, ...override }
  const sources = {}
  for (const k of Object.keys(values)) sources[k] = k in override ? 'override' : 'patch'
  return { values, sources, defaults }
}

export function validateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, error: '请求体必须是对象' }
  }
  for (const [k, v] of Object.entries(fields)) {
    const spec = FIELDS[k]
    if (!spec) return { ok: false, error: `未知字段：${k}`, field: k }
    if (!isType(spec, v)) return { ok: false, error: `字段 ${k} 类型应为 ${spec}`, field: k }
  }
  return { ok: true }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js`
Expected: `# pass 5`。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/lib/config.js dsh-plugin/test/config.test.js
git commit -m "feat(config): patch+覆盖层合并与校验 + 单测"
```

---

## Task 5：账号与回复 `lib/account.js`、`lib/replies.js`

**Files:**
- Create: `dsh-plugin/lib/account.js`, `dsh-plugin/lib/replies.js`
- Test: `dsh-plugin/test/replies.test.js`

- [ ] **Step 1: 写失败测试（只测纯映射，网络部分用注入的 fetch）**

```js
// dsh-plugin/test/replies.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toReplyIn, bvidOf } from '../lib/replies.js'
import { normalizeAccount } from '../lib/account.js'

test('bvidOf 从 uri / native_uri 提取 BV 号', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV192n66dEDQ'), 'BV192n66dEDQ')
  assert.equal(bvidOf('bilibili://video/12345'), '')
  assert.equal(bvidOf(undefined), '')
})

test('toReplyIn 映射通知为 reply-in 事件', () => {
  const notif = {
    id: 1185685105221638,
    reply_time: 1776800000,
    user: { nickname: '张三' },
    item: {
      uri: 'https://www.bilibili.com/video/BV192n66dEDQ',
      title: '某视频',
      source_content: '我的原评论',
      target_reply_content: '对方的回复',
      source_id: 11,
      target_id: 22,
      root_id: 11,
    },
  }
  const ev = toReplyIn(notif, { round: 'r1' })
  assert.equal(ev.type, 'reply-in')
  assert.equal(ev.bvid, 'BV192n66dEDQ')
  assert.equal(ev.parent, 11)
  assert.equal(ev.rpid, 22)
  assert.equal(ev.from, '张三')
  assert.equal(ev.text, '对方的回复')
  assert.equal(ev.notifId, 1185685105221638)
  assert.equal(ev.round, 'r1')
  assert.match(ev.t, /^\d{4}-\d{2}-\d{2}T/)
})

test('toReplyIn 对缺字段的通知返回 null（不猜）', () => {
  assert.equal(toReplyIn({ id: 1, item: {} }), null)
  assert.equal(toReplyIn({ id: 2, item: { uri: 'https://x/video/BV1' } }), null)
})

test('normalizeAccount 归一 nav + relation/stat', () => {
  const a = normalizeAccount(
    { code: 0, data: { isLogin: true, uname: '蓝鱼小号', mid: 10000001, face: 'https://f', level_info: { current_level: 6 }, money: 1447.5, vipStatus: 0 } },
    { code: 0, data: { follower: 12, following: 34 } },
  )
  assert.equal(a.loggedIn, true)
  assert.equal(a.uname, '蓝鱼小号')
  assert.equal(a.mid, '10000001')
  assert.equal(a.level, 6)
  assert.equal(a.coins, 1447.5)
  assert.equal(a.fans, 12)
  assert.equal(a.following, 34)
  assert.equal(a.vip, false)

  const out = normalizeAccount({ code: -101, data: { isLogin: false } }, null)
  assert.equal(out.loggedIn, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/replies.test.js`
Expected: FAIL，`Cannot find module '../lib/replies.js'`。

- [ ] **Step 3: 实现两个模块**

```js
// dsh-plugin/lib/replies.js
/** msgfeed 回复通知 → reply-in 事件（设计文档 §4.4）。纯映射 + 一个可注入 fetch 的拉取器。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REPLY_API = 'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web'

export function bvidOf(uri) {
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(String(uri || ''))
  return m ? m[1] : ''
}

export function toReplyIn(notif, opts = {}) {
  if (!notif || typeof notif !== 'object') return null
  const item = notif.item || {}
  const bvid = bvidOf(item.uri) || bvidOf(item.native_uri)
  const text = String(item.target_reply_content || '').trim()
  const parent = Number(item.source_id) || null
  const rpid = Number(item.target_id) || null
  if (!bvid || !text || !notif.id) return null
  return {
    t: notif.reply_time ? new Date(notif.reply_time * 1000).toISOString() : new Date().toISOString(),
    round: opts.round ?? null,
    type: 'reply-in',
    bvid,
    parent,
    rpid,
    from: String(notif.user?.nickname || ''),
    text,
    notifId: Number(notif.id),
    source: 'agent',
  }
}

export async function fetchReplyNotifs(cookieHeader, fetchImpl = fetch) {
  const res = await fetchImpl(REPLY_API, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader, Referer: 'https://www.bilibili.com/' },
  })
  const json = await res.json().catch(() => ({}))
  const items = json?.data?.items
  return Array.isArray(items) ? items : []
}
```

```js
// dsh-plugin/lib/account.js
/** 账号简况（设计文档 §8 /account）。宿主直连 B站只读接口，失败一律降级。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const REL = (uid) => `https://api.bilibili.com/x/relation/stat?vmid=${uid}`

export function normalizeAccount(nav, rel) {
  const d = nav?.data || {}
  const loggedIn = nav?.code === 0 && d.isLogin === true
  if (!loggedIn) return { loggedIn: false }
  return {
    loggedIn: true,
    uname: String(d.uname || ''),
    mid: String(d.mid || ''),
    face: String(d.face || ''),
    level: Number(d.level_info?.current_level) || 0,
    coins: Number(d.money) || 0,
    vip: d.vipStatus === 1,
    fans: Number(rel?.data?.follower) || 0,
    following: Number(rel?.data?.following) || 0,
  }
}

export async function fetchAccount(cred, fetchImpl = fetch) {
  if (!cred?.sessdata) return { loggedIn: false }
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
  const headers = { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' }
  const nav = await fetchImpl(NAV, { headers }).then((r) => r.json()).catch(() => null)
  const mid = nav?.data?.mid
  const rel = mid ? await fetchImpl(REL(mid), { headers }).then((r) => r.json()).catch(() => null) : null
  return normalizeAccount(nav, rel)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/replies.test.js`
Expected: `# pass 4`。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/lib/account.js dsh-plugin/lib/replies.js dsh-plugin/test/replies.test.js
git commit -m "feat(replies,account): 通知映射与账号归一 + 单测"
```

---

## Task 6：路由工厂 `lib/api.js`

**Files:**
- Create: `dsh-plugin/lib/api.js`
- Test: `dsh-plugin/test/api.test.js`

- [ ] **Step 1: 写失败测试（用伪 req/res，不需要 DSH）**

```js
// dsh-plugin/test/api.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiHandler } from '../lib/api.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-api-'))

function fakeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(s, h) { this.status = s; this.headers = h || {} },
    end(b) { this.body = String(b || '') },
  }
}

function deps(over = {}) {
  const home = dir()
  return {
    home,
    ledgerFile: join(home, 'ledger.jsonl'),
    configFile: join(home, 'config.json'),
    patchConfig: { autoDuty: false, perDay: 5 },
    readEvents: () => [
      // 用相对今天的时间，保证落在 7 天窗口内（写死日期会在几天后让测试误报）
      { t: new Date(Date.now() - 3600_000).toISOString(), round: 'r1', type: 'view', bvid: 'BV1', title: 'A', grade: 'worth' },
      { t: new Date(Date.now() - 3500_000).toISOString(), round: 'r1', type: 'comment', bvid: 'BV1', text: 'c', rpid: 1 },
    ],
    overview: () => ({ duty: { autoDuty: false }, quota: { picked: 1 }, round: { running: false }, health: { cred: true } }),
    setDuty: (v) => ({ ok: true, autoDuty: v }),
    runDuty: () => ({ started: true }),
    stopDuty: () => ({ ok: true, stopped: true }),
    fetchAccount: async () => ({ loggedIn: false }),
    ...over,
  }
}

async function call(handler, method, url, body) {
  const res = fakeRes()
  const req = { method, url, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)) } }
  await handler(req, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

test('GET /overview 返回 200 + JSON', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'GET', '/api/bili-fenshen/overview')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.duty.autoDuty, false)
})

test('GET /activity 返回按天分组', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'GET', '/api/bili-fenshen/activity')
  assert.equal(r.status, 200)
  assert.equal(r.json.days.length, 1)
  assert.equal(r.json.days[0].rounds[0].items[0].bvid, 'BV1')
})

test('POST /duty 切换开关', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'POST', '/api/bili-fenshen/duty', { autoDuty: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.autoDuty, true)
})

test('POST /stop 与 /run 透传', async () => {
  const h = createApiHandler(deps())
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/run')).json.started, true)
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/stop')).json.stopped, true)
})

test('未知路由 404', async () => {
  const h = createApiHandler(deps())
  assert.equal((await call(h, 'GET', '/api/bili-fenshen/nope')).status, 404)
})

test('POST /config 非法字段返回 400 且不落盘', async () => {
  const d = deps()
  const h = createApiHandler(d)
  const r = await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 'five' })
  assert.equal(r.status, 400)
  assert.equal(r.json.field, 'perDay')
})

test('POST /config 合法字段写入覆盖层', async () => {
  const d = deps()
  const h = createApiHandler(d)
  const r = await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 7 })
  assert.equal(r.status, 200)
  const again = await call(h, 'GET', '/api/bili-fenshen/config')
  assert.equal(again.json.values.perDay, 7)
  assert.equal(again.json.sources.perDay, 'override')
})

test('GET /log 把宿主事件与原文分开', async () => {
  const d = deps()
  const logFile = join(d.home, 'duty.log')
  writeFileSync(logFile, [
    '[2026-10-22T01:36:12.452Z] 注册工具失败（已兜住）',
    '模型推理原文一行',
    '[2026-10-22T01:40:54.039Z] host 已激活',
    '',
  ].join('\n'))
  const h = createApiHandler({ ...d, logFile })
  const r = await call(h, 'GET', '/api/bili-fenshen/log?tail=50')
  assert.equal(r.status, 200)
  assert.equal(r.json.events.length, 2)
  assert.match(r.json.raw, /模型推理原文/)
})

test('GET /seen 解析真实账本行（含时间与无 BV 行）', async () => {
  const d = deps()
  const seenFile = join(d.home, 'seen.md')
  writeFileSync(seenFile, [
    '# 判重表',
    '',
    '2026-10-22 14:10 · — · 本轮未登录 · —',
    '2026-10-22 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 折1万次，会坏吗？iPhone Duo深度评测',
    '',
  ].join('\n'))
  const h = createApiHandler({ ...d, seenFile })
  const r = await call(h, 'GET', '/api/bili-fenshen/seen')
  assert.equal(r.status, 200)
  assert.equal(r.json.rows.length, 2)
  assert.equal(r.json.rows[0].bvid, '')
  assert.equal(r.json.rows[1].bvid, 'BV1xrnz6gEVD')
  assert.equal(r.json.rows[1].title, '折1万次，会坏吗？iPhone Duo深度评测')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/api.test.js`
Expected: FAIL，`Cannot find module '../lib/api.js'`。

- [ ] **Step 3: 实现**

```js
// dsh-plugin/lib/api.js
/**
 * 路由工厂：把依赖全部注入，方便在没有 DSH 的情况下单测（设计文档 §8）。
 * 返回的 handler 签名是 Node 原始风格 (req, res)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { effectiveConfig, validateFields, writeOverride } from './config.js'
import { toActivities, groupByDay } from './activity.js'

const PREFIX = '/api/bili-fenshen'
const HOST_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/

export function createApiHandler(deps) {
  const patchConfig = () => (typeof deps.patchConfig === 'function' ? deps.patchConfig() : deps.patchConfig)
  const sendJson = (res, status, data) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data, null, 2))
    } catch { /* 客户端断开 */ }
  }

  const readBody = async (req) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return {}
    }
  }

  const recentEvents = () => {
    const days = 7
    const from = Date.now() - days * 86400_000
    return (deps.readEvents() || []).filter((e) => {
      const t = Date.parse(e?.t || '')
      return Number.isFinite(t) ? t >= from : true
    })
  }

  return async function handler(req, res) {
    let url = null
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }
    const path = url.pathname
    const method = req.method
    try {
      if (!path.startsWith(PREFIX)) return sendJson(res, 404, { ok: false, error: 'not found' })

      if (method === 'GET' && path === `${PREFIX}/overview`) {
        return sendJson(res, 200, { ok: true, ...deps.overview() })
      }
      if (method === 'GET' && path === `${PREFIX}/activity`) {
        const { rounds } = toActivities(recentEvents())
        return sendJson(res, 200, { ok: true, days: groupByDay(rounds) })
      }
      if (method === 'GET' && path === `${PREFIX}/account`) {
        return sendJson(res, 200, { ok: true, account: await deps.fetchAccount() })
      }
      if (method === 'POST' && path === `${PREFIX}/duty`) {
        const body = await readBody(req)
        if (typeof body.autoDuty !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'autoDuty 必须是 boolean' })
        }
        return sendJson(res, 200, { ok: true, ...deps.setDuty(body.autoDuty) })
      }
      if (method === 'POST' && path === `${PREFIX}/run`) {
        return sendJson(res, 200, deps.runDuty())
      }
      if (method === 'POST' && path === `${PREFIX}/stop`) {
        return sendJson(res, 200, deps.stopDuty())
      }
      if (method === 'GET' && path === `${PREFIX}/config`) {
        const cfg = effectiveConfig(patchConfig(), deps.configFile)
        return sendJson(res, 200, { ok: true, ...cfg })
      }
      if (method === 'POST' && path === `${PREFIX}/config`) {
        const body = await readBody(req)
        const check = validateFields(body)
        if (!check.ok) return sendJson(res, 400, { ok: false, error: check.error, field: check.field })
        const cur = effectiveConfig(patchConfig(), deps.configFile)
        const next = { ...cur.values, ...body }
        if (!writeOverride(deps.configFile, next)) {
          return sendJson(res, 500, { ok: false, error: '写覆盖层失败' })
        }
        return sendJson(res, 200, { ok: true, ...effectiveConfig(patchConfig(), deps.configFile) })
      }
      if (method === 'GET' && path === `${PREFIX}/log`) {
        const tail = Math.min(2000, Math.max(20, Number(url.searchParams.get('tail')) || 200))
        let raw = ''
        try {
          if (existsSync(deps.logFile)) raw = readFileSync(deps.logFile, 'utf8')
        } catch { /* 读不到就算了 */ }
        const lines = raw.split('\n').filter(Boolean)
        const hostEvents = lines.map((l) => l).filter((l) => HOST_LINE.test(l)).slice(-tail)
        return sendJson(res, 200, { ok: true, events: hostEvents, raw: lines.slice(-tail).join('\n'), path: deps.logFile })
      }
      if (method === 'GET' && path === `${PREFIX}/seen`) {
        let raw = ''
        try {
          if (existsSync(deps.seenFile)) raw = readFileSync(deps.seenFile, 'utf8')
        } catch { /* 同上 */ }
        const rows = []
        for (const line of raw.split('\n')) {
          // 真实账本行形如：`2026-10-22 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 标题`
          // 无 BV 的行（如「—」）也要能解析出来，只是 bvid 为空
          const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*·\s*(.*?)\s*·\s*(.*?)\s*·\s*(.*)$/.exec(line.trim())
          if (!m) continue
          const bv = /BV[0-9A-Za-z]+/.exec(m[3])
          rows.push({ date: m[1], time: m[2] || '', bvid: bv ? bv[0] : '', action: m[4], title: m[5] })
        }
        return sendJson(res, 200, { ok: true, rows, raw })
      }
      if (method === 'GET' && path === `${PREFIX}/reports`) {
        const r = deps.listReports ? deps.listReports() : { days: [], digests: [] }
        return sendJson(res, 200, { ok: true, days: r.days || [], digests: r.digests || [] })
      }
      return sendJson(res, 404, { ok: false, error: `unknown ${method} ${path}` })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  }
}
```

> 说明：`/status`、`/report`、`/cred`、`/login/*` 继续留在 `index.js` 里（它们依赖登录会话与本地状态），本工厂只接管新增的只读/配置类端点。`index.js` 里先问工厂、未命中再走旧逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/api.test.js`
Expected: `# pass 9`（overview / activity / duty / run+stop / 404 / config-400 / config-200 / log / seen）。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/lib/api.js dsh-plugin/test/api.test.js
git commit -m "feat(api): 可注入依赖的路由工厂 + 单测"
```

---

## Task 7：`index.js` 接线

**Files:**
- Modify: `dsh-plugin/index.js`（整体重写，保留已验证的调度/spawn/overlay 逻辑）

- [ ] **Step 1: 家目录可覆盖**

把第 165 行附近改为：

```js
const HOME = process.env.BILI_FENSHEN_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'bili-fenshen')
```

- [ ] **Step 2: 接入 lib（在文件头 import）**

```js
import { appendEvents, readEvents } from './lib/ledger.js'
import { parseRoundReport } from './lib/report.js'
import { createApiHandler } from './lib/api.js'
import { effectiveConfig, writeOverride } from './lib/config.js'
import { fetchAccount } from './lib/account.js'
import { fetchReplyNotifs, toReplyIn } from './lib/replies.js'
import { toActivities } from './lib/activity.js'
```

新增路径常量：

```js
const LEDGER_FILE = join(HOME, 'ledger.jsonl')
const CONFIG_FILE = join(HOME, 'config.json')
```

- [ ] **Step 3: 生效配置 + 轮次生命周期**

```js
const effCfg = () => effectiveConfig(cfgSnapshot || {}, CONFIG_FILE).values

let currentChild = null
let currentRoundId = null
let currentRoundAt = 0

const stopDuty = () => {
  if (!currentChild) return { ok: true, stopped: false }
  try {
    currentChild.kill('SIGTERM')
    setTimeout(() => { try { currentChild?.kill('SIGKILL') } catch { /* 已退出 */ } }, 2000).unref?.()
  } catch (e) {
    log(`中止本轮失败：${e?.message ?? e}`)
  }
  return { ok: true, stopped: true }
}
```

`runDuty` 里：spawn 成功后

```js
currentChild = child
currentRoundId = new Date().toISOString()
currentRoundAt = Date.now()
```

`exit` 回调里：

```js
child.on('exit', (code) => {
  running = false
  const durationMs = Date.now() - currentRoundAt
  currentChild = null
  log(`值班轮结束（${why}，code=${code}）`)
  try {
    appendEvents(LEDGER_FILE, [{ t: new Date().toISOString(), round: currentRoundId, type: 'round-end', code, durationMs }])
    backfillFromReport(currentRoundId, durationMs)
  } catch (e) { log(`写 round-end 失败：${e?.message ?? e}`) }
  stubReportIfMissing(code)
  rotateLogIfBig()
  const t = setTimeout(() => { verifyRecentSafe('round').catch(() => {}) }, 90_000)
  t.unref?.()
})
```

- [ ] **Step 4: 报告兜底回填**

```js
const backfillFromReport = (roundId) => {
  try {
    const existing = readEvents(LEDGER_FILE)
    const day = dayKey()
    const f = join(OUT_DIR, `${day}.md`)
    if (!existsSync(f)) return
    const text = readFileSync(f, 'utf8')
    const { views, skips } = parseRoundReport(text, { round: roundId })
    const events = []
    for (const v of views) {
      events.push({ t: v.t, round: roundId, type: 'view', bvid: v.bvid, title: v.title, author: v.author, views: v.views, duration: v.duration, grade: v.grade, source: 'report' })
      for (const a of v.actions) {
        events.push({ t: v.t, round: roundId, ...a, bvid: v.bvid, source: 'report' })
      }
    }
    for (const s of skips) events.push({ ...s, round: roundId, type: 'skip' })
    const fresh = events.filter((e) => !isDuplicate(existing, e))
    if (fresh.length) {
      appendEvents(LEDGER_FILE, fresh)
      log(`报告兜底回填 ${fresh.length} 条事件（round=${roundId}）`)
    }
  } catch (e) {
    log(`报告兜底回填失败：${e?.message ?? e}`)
  }
}
```

> `isDuplicate` 从 `./lib/ledger.js` 一并 import。

- [ ] **Step 5: 回复轮询器 + 心跳自愈**

```js
const readCred = () => {
  try {
    const raw = JSON.parse(readFileSync(BILI_CRED_FILE, 'utf8'))
    return raw?.sessdata ? raw : null
  } catch {
    return null
  }
}

let replyPollTimer = null
const replyTick = async () => {
  try {
    const cred = readCred()
    if (!cred) return
    const events = readEvents(LEDGER_FILE)
    const recentComments = events.filter((e) => e.type === 'comment' && Date.now() - Date.parse(e.t) < 7 * 86400_000)
    if (!recentComments.length) return
    const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
    const notifs = await fetchReplyNotifs(cookie)
    const st = readJson(STATE_FILE, {})
    const seen = new Set(st.seenNotifs || [])
    const fresh = []
    for (const n of notifs) {
      if (seen.has(Number(n.id))) continue
      const ev = toReplyIn(n, { round: roundIdForReply(n, recentComments) })
      if (!ev) continue
      fresh.push(ev)
      seen.add(Number(n.id))
    }
    if (fresh.length) {
      appendEvents(LEDGER_FILE, fresh)
      log(`收到 ${fresh.length} 条新回复通知`)
    }
    bumpState({ seenNotifs: [...seen].slice(-500), lastReplyPollAt: new Date().toISOString() })
  } catch (e) {
    log(`回复轮询失败（下个周期重试）：${e?.message ?? e}`)
  }
}

const roundIdForReply = (notif, comments) => {
  const parent = Number(notif?.item?.source_id) || null
  if (parent) {
    const hit = comments.find((c) => c.rpid === parent)
    if (hit) return hit.round ?? null
  }
  const text = String(notif?.item?.source_content || '').trim()
  if (text) {
    const hit = comments.find((c) => c.text === text)
    if (hit) return hit.round ?? null
  }
  return null
}

const heartbeat = () => {
  try {
    if (running && !currentChild) {
      if (!heartbeat.missingSince) heartbeat.missingSince = Date.now()
      if (Date.now() - heartbeat.missingSince > 15_000) {
        running = false
        heartbeat.missingSince = 0
        log('心跳自愈：running=true 但子进程已消失，标记为空闲')
      }
    } else {
      heartbeat.missingSince = 0
    }
  } catch { /* 兜住 */ }
}
```

在 `apply()` 里启动：

```js
replyPollTimer = setInterval(() => { replyTick().catch(() => {}) }, 5 * 60_000)
replyPollTimer.unref?.()
```

- [ ] **Step 6: 路由挂载（含一次性守卫与 overview 组装）**

先把原有的 `handle(req,res,url)`（index.js 里现有的六个端点）改名为 `legacyHandle`，保留原实现。

新增 overview 组装：

```js
const nextWindowLabel = () => {
  try {
    const cfg = effCfg()
    const now = new Date()
    const m = now.getHours() * 60 + now.getMinutes()
    const candidates = []
    if (cfg.noon && !inWindow(now, WINDOWS.noon)) candidates.push(['中午 12:00', (12 * 60 - m + 1440) % 1440])
    if (cfg.night && !inWindow(now, WINDOWS.night)) candidates.push(['晚间 18:00', (18 * 60 - m + 1440) % 1440])
    if (!candidates.length) return '—'
    candidates.sort((a, b) => a[1] - b[1])
    return `${candidates[0][0]}（${Math.floor(candidates[0][1] / 60)}h${String(candidates[0][1] % 60).padStart(2, '0')}m 后）`
  } catch {
    return '—'
  }
}

const buildOverview = () => {
  const cfg = effCfg()
  const st = readJson(STATE_FILE, {})
  const cli = dshCliCached(cfg)
  return {
    account: null,                       // 由 /account 单独提供（需要网络，不阻塞 overview）
    duty: {
      autoDuty: !!cfg.autoDuty,
      windows: { noon: !!cfg.noon, night: !!cfg.night },
      nextWindowLabel: nextWindowLabel(),
    },
    quota: {
      picked: countPickedToday(),
      comments: countCommentsToday(),
      likes: countLikesToday(),
      dynamics: countDynamicsToday(),
      limits: {
        perDay: cfg.perDay, commentsPerDay: cfg.commentsPerDay,
        likesPerDay: cfg.likesPerDay, dynamicsPerDay: cfg.dynamicsPerDay,
        repliesPerRound: cfg.repliesPerRound,
      },
    },
    round: {
      running,
      startedAt: running ? new Date(currentRoundAt).toISOString() : '',
      elapsedMs: running ? Date.now() - currentRoundAt : 0,
      lastRunAt: st.lastRunAt || '',
      lastWhy: st.lastWhy || '',
      lastCode: st.lastCode ?? null,
      lastDurationMs: st.lastDurationMs ?? null,
    },
    health: { cli: cli || '', cred: existsSync(BILI_CRED_FILE) },
    lastReplyPollAt: st.lastReplyPollAt || '',
  }
}

const listReports = () => {
  const days = []
  const digests = []
  try {
    for (const f of readdirSync(OUT_DIR)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) days.push(f.replace(/\.md$/, ''))
    }
  } catch { /* 目录不存在 */ }
  try {
    for (const f of readdirSync(DIGEST_DIR)) {
      if (/^\d{4}-\d{2}\.md$/.test(f)) digests.push(f.replace(/\.md$/, ''))
    }
  } catch { /* 同上 */ }
  return { days: days.sort().reverse(), digests: digests.sort().reverse() }
}

let routeRegistered = false
const mountRoutes = () => {
  const web = ctx.get?.('webServer') ?? ctx.webServer
  if (!web?.register) { log('webServer 不可用：HTTP 路由未挂'); return () => {} }
  if (routeRegistered) { log('webServer 路由已注册过，跳过重复注册'); return () => {} }
  routeRegistered = true

  const api = createApiHandler({
    home: HOME,
    ledgerFile: LEDGER_FILE,
    configFile: CONFIG_FILE,
    seenFile: join(HOME, 'seen.md'),
    logFile: LOG_FILE,
    patchConfig: () => cfgSnapshot,
    readEvents: () => readEvents(LEDGER_FILE),
    overview: buildOverview,
    setDuty: (v) => {
      const cur = effectiveConfig(cfgSnapshot || {}, CONFIG_FILE)
      writeOverride(CONFIG_FILE, { ...cur.values, autoDuty: v })
      log(`自动值班 ${v ? '开启' : '关闭'}（操作台）`)
      return { autoDuty: v }
    },
    runDuty: () => runDuty('web'),
    stopDuty,
    fetchAccount: () => fetchAccount(readCred()),
    listReports,
  })

  return web.register({
    kind: 'prefix',
    path: '/api/bili-fenshen',
    handler: async (req, res) => {
      try {
        await api(req, res)                                   // 新端点
        if (res.writableEnded) return
        await legacyHandle(req, res, new URL(req.url, 'http://127.0.0.1'))   // 旧端点
      } catch (e) {
        try { if (!res.writableEnded) { res.writeHead(500); res.end() } } catch { /* 兜住 */ }
      }
    },
  })
}
```

注意：`effCfg()` 每次重新读覆盖层，所以操作台保存后调度器与下一次值班立即用新值（无需重启）。

- [ ] **Step 7: 让旧 `/report` 支持月度归档**

`legacyHandle` 里 `/report` 分支改为先找日报、再找 digest：

```js
if (req.method === 'GET' && path === '/api/bili-fenshen/report') {
  try {
    const day = /^\d{4}-\d{2}(-\d{2})?$/.test(String(url.searchParams.get('day') || ''))
      ? url.searchParams.get('day') : dayKey()
    const f1 = join(OUT_DIR, `${day}.md`)
    const f2 = join(DIGEST_DIR, `${day}.md`)
    const f = existsSync(f1) ? f1 : existsSync(f2) ? f2 : null
    return sendJson(res, 200, { day, text: f ? readFileSync(f, 'utf8') : '' })
  } catch (e) { return sendJson(res, 500, { error: String(e?.message ?? e) }) }
}
```

（这样产物页点「digest/2026-10.md」也能读到内容。）

`exit` 回调里补写 `lastCode` / `lastDurationMs`：

```js
bumpState({ lastRunAt: new Date().toISOString(), lastWhy: why, lastCode: code, lastDurationMs: durationMs })
```

- [ ] **Step 8: 语法检查 + 重启验证**

Run:
```powershell
cd E:\myproject\BilibiliPlayer\dsh-plugin
node --check index.js
node --check lib/api.js
node --check lib/ledger.js
```
Expected: 无输出。

然后重启 DSH，用 inspect 确认插件仍激活：

```
cordis_inspect_query(host, Config, listConfigs, { name: "dsh-bili-fenshen" })
```
Expected: 目录里出现 `include:bili-fenshen`，`status: "schema"`。

- [ ] **Step 9: 提交**

```powershell
git add dsh-plugin/index.js
git commit -m "refactor(host): 账本/配置/轮询/路由接入，轮次生命周期与停止"
```

---

## Task 8：`bili_reply` 回传 rpid

**Files:**
- Modify: `mcp_server.py:651-694`

- [ ] **Step 1: 改返回体**

把成功分支改为：

```python
        rpid = None
        if isinstance(result, dict):
            rpid = result.get("rpid") or (result.get("data") or {}).get("rpid")
        return json.dumps({
            "success": True,
            "message": "评论发送成功",
            "bvid": bvid,
            "rpid": rpid,
        }, ensure_ascii=False)
```

失败分支补 `bvid`：

```python
    except Exception as e:
        return _err(f"评论发送失败: {e}", bvid=bvid)
```

（`_err` 已支持 kwargs，见文件内其它工具。）

- [ ] **Step 2: 语法检查**

Run: `cd E:\myproject\BilibiliPlayer; & .\.venv\Scripts\python.exe -m py_compile mcp_server.py`
Expected: 无输出。

- [ ] **Step 3: 断言返回字段存在**

Run:
```powershell
Select-String -Path E:\myproject\BilibiliPlayer\mcp_server.py -Pattern '"rpid": rpid' -SimpleMatch
```
Expected: 1 条匹配。

- [ ] **Step 4: 提交**

```powershell
git add mcp_server.py
git commit -m "fix(mcp): bili_reply 回传 rpid（生命周期串联的前置条件）"
```

---

## Task 9：章程记账契约

**Files:**
- Modify: `dsh-plugin/prompts/duty.md`（在「报告契约」之后插入）

- [ ] **Step 1: 插入新节**

```markdown
## 记账契约（控制台靠它对账）

- ⭐⭐ 每执行一个动作，**立即**向 `<家目录>/ledger.jsonl` **追加一行** JSON（一行一个，绝不覆盖、绝不重排）：
  - 看完一条：`{"t":"<ISO>","round":"<本轮开始时刻ISO>","type":"view","bvid":"BV…","title":"…","author":"…","views":123456,"duration":892,"source":"hot|search|follow","grade":"worth|ok|meh"}`
  - 点赞：`{"t":…,"round":…,"type":"like","bvid":"BV…"}`
  - 评论：`{"t":…,"round":…,"type":"comment","bvid":"BV…","text":"评论正文","rpid":123456}`
  - 发动态：`{"t":…,"round":…,"type":"dynamic","bvid":"BV…","text":"动态正文","id":"动态id"}`
  - 跳过：`{"t":…,"round":…,"type":"skip","bvid":"BV…","title":"…","author":"…","reason":"为什么跳过"}`
  - 回复别人：`{"t":…,"round":…,"type":"reply-out","bvid":"BV…","parent":<对方rpid>,"text":"回复正文","rpid":<自己rpid>}`
- `rpid` 取自 `bili_reply` 返回；**返回里没有就写 `null`，绝不自己编数字**。
- 同一个动作只记一次。记账写不进去，要在报告里**明说**（控制台会缺这条）。
- 顺序：**先记账，再写报告**。报告是给人看的摘要，账本是控制台的唯一事实来源。
- 账本路径是绝对路径 `<家目录>/ledger.jsonl`，别写错地方。
```

- [ ] **Step 2: 确认宿主会带上章程**

Run:
```powershell
Select-String -Path E:\myproject\BilibiliPlayer\dsh-plugin\index.js -Pattern "duty.md" -SimpleMatch
```
Expected: 命中（`buildDutyPrompt` 里读取 `prompts/duty.md`）。

- [ ] **Step 3: 提交**

```powershell
git add dsh-plugin/prompts/duty.md
git commit -m "docs(charter): 新增账本记账契约"
```

---

## Task 10：Client 骨架（注册 + token + 轮询）

**Files:**
- Rewrite: `dsh-plugin/client.js`（先只做骨架与空页面）

- [ ] **Step 1: 写注册与样式映射**

```js
/**
 * dsh-bili-fenshen —— Client 半部（单文件）
 * 注册：sidebar.panellist（图标）+ main（控制台页面）+ settings.section（瘦身版）
 * 样式：把宿主 --dsw-* token 映射为局部变量，其余 CSS 从 docs/demo 移植
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-fenshen',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'bili-fenshen'

    const STYLE = `
      .bf-console{
        --bg-base:var(--dsw-alias-bg-base);
        --bg-layer-1:var(--dsw-alias-bg-layer-1);
        --bg-module-platform:var(--dsw-alias-bg-module-platform);
        --border-l1:var(--dsw-alias-border-l1);
        --border-l2:var(--dsw-alias-border-l2);
        --border-l4:var(--dsw-alias-border-l4);
        --label-primary:var(--dsw-alias-label-primary);
        --label-secondary:var(--dsw-alias-label-secondary);
        --label-tertiary:var(--dsw-alias-label-tertiary);
        --label-caption:var(--dsw-alias-label-caption);
        --brand-primary:var(--dsw-alias-brand-primary);
        --brand-hover:var(--dsw-alias-button-primary-hover);
        --interactive-hover:var(--dsw-alias-interactive-bg-hover);
        --nav-active:var(--dsw-specific-sidebar-nav-item-active);
        --selector:var(--dsw-specific-selector);
        --success:var(--dsw-alias-state-success-primary);
        --success-3:var(--dsw-alias-state-success-tertiary);
        --warn:var(--dsw-alias-state-warn-primary);
        --warn-3:var(--dsw-alias-state-warn-tertiary);
        --error:var(--dsw-alias-state-error-primary);
        --idle:var(--dsw-alias-state-idle-primary);
        --business:var(--dsw-alias-state-business-primary);
        --bili-pink:#fb7299;
        --bili-blue:#23ade5;
        --r-xs:4px; --r-sm:8px; --r-md:12px; --r-lg:16px;
        --font-text:inherit;
        --font-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,monospace;
        --ease:cubic-bezier(.4,0,.2,1); --dur:.2s;
        color:var(--label-primary);
        background:var(--bg-base);
        min-height:100%;
        font-size:14px; line-height:22px;
      }
      /* ↓ 从这里开始，粘贴 docs/demo/bili-fenshen-console.html 的组件 CSS
         （去掉 :root 与 html[data-theme="dark"] 两块，类名统一加 bf- 前缀） */
    `

    const TAG_ID = 'dsh-bili-fenshen/console.css'
    const ensureStyle = () => {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-bili-fenshen'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = STYLE
      document.head.appendChild(tag)
    }

    /* ── 数据层 ── */
    const apiGet = (path) => fetch(`/api/bili-fenshen${path}`).then((r) => r.json())
    const apiPost = (path, body) => fetch(`/api/bili-fenshen${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }).then((r) => r.json())

    function usePoll(load, intervalMs) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const tick = React.useCallback(async () => {
        try {
          const v = await load()
          setState(v)
          setError('')
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [load])
      React.useEffect(() => {
        let alive = true
        let timer = null
        const run = async () => { if (alive) await tick() }
        const start = () => {
          run()
          if (timer) clearInterval(timer)
          timer = setInterval(run, intervalMs)
        }
        const onVis = () => {
          if (document.hidden) { if (timer) clearInterval(timer); timer = null }
          else start()
        }
        start()
        document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [tick, intervalMs])
      return { data: state, error, refresh: tick }
    }

    /* 图标：ownerProps { size, active } */
    function PanelIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
        h('rect', { x: 2.5, y: 5.5, width: 11, height: 9, rx: 2.4, fill: '#fb7299' }),
        h('rect', { x: 10.5, y: 9.5, width: 11, height: 9, rx: 2.4, fill: '#23ade5', fillOpacity: .92 }),
        h('path', { d: 'M5 3.2l2 1.8M11 3.2l-2 1.8', stroke: '#fb7299', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M13.6 7.2l2 1.8M19.6 7.2l-2 1.8', stroke: '#23ade5', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 6.2, cy: 9.6, r: .95, fill: '#fff' }),
        h('circle', { cx: 9.8, cy: 9.6, r: .95, fill: '#fff' }),
        h('circle', { cx: 14, cy: 13.6, r: .9, fill: '#fff' }),
        h('circle', { cx: 17.6, cy: 13.6, r: .9, fill: '#fff' }),
      )
    }

    function ConsolePage() {
      const [view, setView] = React.useState('dashboard')
      return h('div', { className: 'bf-console' },
        h('div', { className: 'bf-page' },
          h('header', { className: 'bf-page-head' },
            h('div', null,
              h('h1', { className: 'bf-page-title' }, 'B站分身'),
              h('p', { className: 'bf-page-sub' }, '让小号在B站保持存在感 · 先发后报，可随时接管'),
            ),
          ),
          h('div', { className: 'bf-segmented', role: 'tablist' },
            ['dashboard', 'console'].map((k) =>
              h('button', {
                key: k,
                role: 'tab',
                'aria-selected': String(view === k),
                onClick: () => setView(k),
              }, k === 'dashboard' ? '看板' : '操作台')),
          ),
          view === 'dashboard'
            ? h('div', null, '（Task 11 填充：账号条 / 值班条 / 配额 / 活动流）')
            : h('div', null, '（Task 12 填充：配置 / 日志 / 判重表 / 产物）'),
        ),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ensureStyle()
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 15,
          label: () => 'B站分身',
        }, PanelIcon))
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PANEL_ID, children: {} }, ConsolePage)
        })
      },
    }
  },
})
```

- [ ] **Step 2: 语法检查**

Run: `cd E:\myproject\BilibiliPlayer\dsh-plugin; node --check client.js`
Expected: 无输出。

- [ ] **Step 3: 重启 DSH，确认两个 occupant 注册成功**

```
cordis_inspect_query(client, Slots, listSubTree, { root: "sidebar.panellist" })
```
Expected: occupants 里出现 `{ registrant: "dsh-bili-fenshen", id: "bili-fenshen", order: 15, active: true }`。

```
cordis_inspect_query(client, Slots, listSubTree, { root: "main" })
```
Expected: occupants 里出现 `{ registrant: "dsh-bili-fenshen", key: "bili-fenshen", active: true }`。

- [ ] **Step 4: 打开 GUI 看骨架**

打开 `http://127.0.0.1:57257` → 侧栏第三个图标 → 页面显示标题行与「看板 / 操作台」两个子页。

Expected: 深浅色跟随宿主（切换宿主外观时页面颜色同步变化），无 `--dsh-*` 变量、无控制台报错。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/client.js
git commit -m "feat(client): 注册侧栏图标与 main 面板骨架"
```

---

## Task 11：看板实现

**Files:**
- Modify: `dsh-plugin/client.js`

- [ ] **Step 1: 移植 CSS**

从 `docs/demo/bili-fenshen-console.html` 的 `<style>` 里**逐块复制并加前缀**（去掉 `:root`、`html[data-theme="dark"]` 两块；把选择器 `.card` `.act` 等改成 `.bf-card` `.bf-act`）：

| demo 选择器 | 插件类名 |
|---|---|
| `.page` | `.bf-page`（`max-width:920px;padding:26px 32px 72px`） |
| `.page-head/.page-title/.page-sub` | `.bf-page-head/.bf-page-title/.bf-page-sub` |
| `.segmented` | `.bf-segmented` |
| `.card/.card-head/.card-title/.card-note` | `.bf-card/.bf-card-head/.bf-card-title/.bf-card-note` |
| `.account/.avatar/.account-name/.account-meta/.lv/.pill/.dot` | 同名加 `bf-` |
| `.btn/.btn.primary/.btn.ghost/.btn.small/.btn.danger` | `.bf-btn…` |
| `.switch` | `.bf-switch` |
| `.duty/.duty-item/.duty-actions` | 同名加 `bf-` |
| `.quota/.tile/.tile-label/.tile-value/.bar` | 同名加 `bf-` |
| `.round-head/.round-time/.round-src` | 同名加 `bf-` |
| `details.act/.sum-row/.bvid/.grade…/.chip…/.chev` | `.bf-act/.bf-sum-row/.bf-bvid…` |
| `.stages/.stage…` | `.bf-stages/.bf-stage…` |
| `.quote/.thread/.msg…` | `.bf-quote/.bf-thread/.bf-msg…` |
| `.act-foot/.link/.mono` | `.bf-act-foot/.bf-link/.bf-mono` |
| `details.group/.skip-list/.skip-item…` | `.bf-group/.bf-skip-list/.bf-skip-item…` |

深色补丁：demo 里 `html[data-theme="dark"] .grade.worth{…}` 那一条改成 `color-mix(in srgb, var(--bili-pink) 62%, var(--label-primary))`，其余深色差异由宿主 token 自动处理。

- [ ] **Step 2: 基础组件**

```js
const Btn = ({ variant = 'default', small, children, ...rest }) =>
  h('button', { className: `bf-btn${variant === 'primary' ? ' primary' : variant === 'ghost' ? ' ghost' : variant === 'danger' ? ' danger' : ''}${small ? ' small' : ''}`, ...rest }, children)

const Switch = ({ checked, onChange, label }) =>
  h('button', {
    className: 'bf-switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label,
    onClick: () => onChange(!checked),
  })

const Num = ({ value, onChange, min = 0, max = 99 }) =>
  h('div', { className: 'bf-num' },
    h('button', { onClick: () => onChange(Math.max(min, value - 1)), 'aria-label': '减少' }, '−'),
    h('input', { value, readOnly: true, 'aria-label': '数值' }),
    h('button', { onClick: () => onChange(Math.min(max, value + 1)), 'aria-label': '增加' }, '+'),
  )

const Chip = ({ kind = '', children }) => h('span', { className: `bf-chip ${kind}` }, children)
const Pill = ({ tone = '', children }) => h('span', { className: `bf-pill ${tone}` }, children)
const Card = ({ children, className = '' }) => h('div', { className: `bf-card ${className}` }, children)
```

- [ ] **Step 3: 数据 hook**

```js
const useOverview = () => usePoll(React.useCallback(() => apiGet('/overview'), []), 3000)
const useActivity = (running) =>
  usePoll(React.useCallback(() => apiGet('/activity'), []), running ? 3000 : 15000)
```

- [ ] **Step 4: 账号条 / 值班条 / 配额**

```js
function AccountBar({ data }) {
  const a = data?.account || {}
  const initial = (a.uname || 'B').slice(0, 1)
  return h(Card, null,
    h('div', { className: 'bf-account' },
      h('div', { className: 'bf-avatar' }, a.face
        ? h('img', { src: a.face, alt: '', onError: (e) => { e.currentTarget.style.display = 'none' } })
        : initial),
      h('div', null,
        h('div', { className: 'bf-account-name' }, a.uname || '未登录',
          a.level ? h('span', { className: 'bf-lv' }, `LV${a.level}`) : null,
          h(Pill, { tone: a.loggedIn ? 'ok' : 'warn' }, a.loggedIn ? '登录有效' : '未登录')),
        h('div', { className: 'bf-account-meta' },
          a.mid ? `UID ${a.mid} · 硬币 ${a.coins} · 粉丝 ${a.fans}${a.vip ? ' · 大会员' : ''}` : '登录后显示账号简况'),
      ),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
        h(Btn, { small: true, variant: 'ghost', onClick: () => window.open(`https://space.bilibili.com/${a.mid}`, '_blank') }, 'B站主页'),
        h(Btn, { small: true, onClick: () => window.dispatchEvent(new CustomEvent('bf-login')) }, '重新扫码'),
      ),
    ),
  )
}

function DutyBar({ data, onToggle, onRun, onStop }) {
  const d = data?.duty || {}
  const r = data?.round || {}
  return h(Card, null,
    h('div', { className: 'bf-duty' },
      h('div', { className: 'bf-duty-item' },
        h(Switch, { checked: d.autoDuty, label: '自动值班', onChange: onToggle }),
        h('span', null, '自动值班 ', h('b', null, d.autoDuty ? '已开' : '已关')),
      ),
      h('div', { className: 'bf-duty-item' }, '下一窗 ', h('b', null, d.nextWindowLabel || '—')),
      h('div', { className: 'bf-duty-item' }, '本轮 ', h('b', null, r.running ? '运行中' : '空闲'),
        r.running && r.elapsedMs ? h('span', { className: 'bf-note' }, ` ${fmtDur(r.elapsedMs)}`) : null),
      h('div', { className: 'bf-duty-actions' },
        h(Btn, { variant: 'danger', small: true, disabled: !r.running, onClick: onStop }, '中止'),
        h(Btn, { variant: 'primary', disabled: r.running, onClick: onRun }, '跑一轮'),
      ),
    ),
  )
}

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function QuotaTiles({ data }) {
  const q = data?.quota || {}
  const L = q.limits || {}
  const rows = [
    ['挑中', q.picked, L.perDay],
    ['评论', q.comments, L.commentsPerDay],
    ['点赞', q.likes, L.likesPerDay],
    ['动态', q.dynamics, L.dynamicsPerDay],
  ]
  return h(Card, null,
    h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '今日配额'),
      h('span', { className: 'bf-card-note' }, '按动作类型分别计数，到量即停')),
    h('div', { className: 'bf-quota' },
      rows.map(([label, used, limit]) => h('div', { className: 'bf-tile', key: label },
        h('div', { className: 'bf-tile-label' }, label),
        h('div', { className: 'bf-tile-value' }, `${used ?? 0} `, h('span', null, `/ ${limit ?? 0}`)),
        h('div', { className: 'bf-bar' }, h('i', { style: { width: pct(used, limit) } })),
      )),
    ),
  )
}

const pct = (u, l) => (l > 0 ? `${Math.min(100, Math.round(((u || 0) / l) * 100))}%` : '0%')
```

- [ ] **Step 5: 活动卡（生命周期）**

```js
const STAGES = [
  ['viewed', '刷到'], ['viewed', '看'], ['liked', '赞'],
  ['commented', '评'], ['replied', '被回复'], ['repliedBack', '我回'],
]

function StageRail({ activity }) {
  const s = activity.stage
  const flags = [s.viewed, s.viewed, s.liked, s.commented, s.replies > 0, s.repliedBack]
  const times = stampOf(activity, ['view', 'view', 'like', 'comment', 'reply-in', 'reply-out'])
  return h('div', { className: 'bf-stages' },
    STAGES.map(([key, label], i) => h('div', {
      key: label, className: `bf-stage${flags[i] ? ' done' : ''}`,
    },
      h('b'), h('span', null, label), h('em', null, times[i] || '—'))),
  )
}

const stampOf = (a, types) => types.map((t) => {
  const ev = a.events.find((e) => e.type === t)
  return ev ? hhmm(ev.t) : ''
})

const hhmm = (iso) => {
  try { return new Date(iso).toTimeString().slice(0, 5) } catch { return '' }
}

function ReplyThread({ activity }) {
  const items = []
  for (const e of activity.events) {
    if (e.type === 'reply-in') items.push({ mine: false, who: e.from, t: e.t, text: e.text, rpid: e.rpid, pending: true })
    if (e.type === 'reply-out') items.push({ mine: true, who: '我', t: e.t, text: e.text, rpid: e.rpid })
  }
  const answered = new Set(activity.events.filter((e) => e.type === 'reply-out').map((e) => e.parent))
  for (const it of items) if (it.pending && answered.has(it.rpid)) it.pending = false
  if (!items.length) return null
  return h('div', { className: 'bf-thread' },
    items.map((it, i) => h('div', { className: `bf-msg${it.mine ? ' mine' : ''}`, key: i },
      h('span', { className: 'bf-msg-name' }, it.who),
      h('span', { className: 'bf-msg-time' }, hhmm(it.t)),
      h('span', { className: 'bf-msg-text' }, it.text),
      it.pending ? h(Chip, { kind: 'warn' }, '待跟进') : null,
    )),
  )
}

function ActivityCard({ item }) {
  const c = item.events.find((e) => e.type === 'comment')
  const dyn = item.events.find((e) => e.type === 'dynamic')
  const commentRpid = c?.rpid
  const replyRpid = item.events.find((e) => e.type === 'reply-in')?.rpid
  const open = item.stage.replies > 0 || item.stage.repliedBack
  return h('details', { className: 'bf-act', open },
    h('summary', null,
      h('div', { className: 'bf-sum-row' },
        h('span', { className: 'bf-bvid' }, item.bvid),
        item.grade ? h(GradeBadge, { grade: item.grade }) : null,
        item.stage.liked ? h(Chip, null, '赞') : null,
        item.stage.commented ? h(Chip, { kind: 'cmt' }, '评论') : null,
        item.stage.replies ? h(Chip, { kind: 'rep' }, `${item.stage.replies} 回复`) : null,
        item.stage.pendingReply ? h(Chip, { kind: 'warn' }, `${item.stage.pendingReply} 未回`) : null,
        h('span', { className: 'bf-chev' }, '›'),
      ),
      h('div', { className: 'bf-sum-title' }, item.title || item.bvid),
      h('div', { className: 'bf-sum-meta' },
        [item.author, item.views ? `${fmtNum(item.views)} 播放` : '', item.duration ? fmtClock(item.duration) : '', item.sourceLabel || '']
          .filter(Boolean).join(' · ')),
    ),
    h('div', { className: 'bf-act-body' },
      h(StageRail, { activity: item }),
      c ? h('p', { className: 'bf-quote' }, h('span', { className: 'bf-who' }, `我 · ${hhmm(c.t)}`), c.text) : null,
      h(ReplyThread, { activity: item }),
      dyn ? h('div', { className: 'bf-dyn' }, `动态「${dyn.text || ''}」`) : null,
      h('div', { className: 'bf-act-foot' },
        h('a', { className: 'bf-link', href: `https://www.bilibili.com/video/${item.bvid}`, target: '_blank', rel: 'noreferrer' }, '打开视频'),
        h('span', { className: 'bf-mono' }, `评论 rpid ${commentRpid ?? '未取到'}`),
        replyRpid ? h('span', { className: 'bf-mono' }, `回复 rpid ${replyRpid}`) : null,
        item.flags.fromReport ? h('span', { className: 'bf-note' }, '部分事件据报告回填') : null,
      ),
    ),
  )
}
```

辅助组件与格式化（放在 Task 11 Step 5 代码块之后）：

```js
const GRADE_TEXT = { worth: '值得看', ok: '可以看', meh: '不值当' }

const GradeBadge = ({ grade }) =>
  h('span', { className: `bf-grade ${grade}` }, GRADE_TEXT[grade] || grade)

const fmtNum = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))

const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
```

（`fmtClock` 的入参是视频时长「秒」；`fmtDur` 的入参是毫秒耗时——两个函数不要混用。）

- [ ] **Step 6: 活动流与分组**

```js
function ActivityFeed({ data }) {
  const days = data?.days || []
  if (!days.length) return EmptyState
  return days.map((day) => h('div', { key: day.date },
    day.rounds.map((round) => h('div', { key: round.id },
      h('div', { className: 'bf-round-head' },
        h('span', { className: 'bf-round-time' }, `${hhmm(round.startedAt)} 这一轮`),
        h('span', { className: 'bf-round-src' }, round.sourceLabel ? `来源：${round.sourceLabel}` : ''),
      ),
      groupItems(round.items),
    )),
  ))
}
```

`groupItems`：把带 `skipped` 的收进折叠组，其余按顺序渲染 `ActivityCard`。

```js
function groupItems(items) {
  const skipped = items.filter((x) => x.skipped)
  const normal = items.filter((x) => !x.skipped)
  const reasonCount = {}
  for (const s of skipped) {
    const key = s.skipped.reason || '其他'
    reasonCount[key] = (reasonCount[key] || 0) + 1
  }
  const summary = skipped.length
    ? `跳过 ${skipped.length} 条：${Object.entries(reasonCount).map(([k, v]) => `${k} ${v}`).join(' · ')}`
    : ''
  return h(React.Fragment, null,
    normal.map((item) => h(ActivityCard, { key: item.bvid, item })),
    skipped.length
      ? h('details', { className: 'bf-group' },
          h('summary', null, summary),
          h('ul', { className: 'bf-skip-list' },
            skipped.map((s) => h('li', { className: 'bf-skip-item', key: s.bvid },
              h('span', { className: 'bf-bvid' }, s.bvid),
              h('span', { className: 'bf-skip-title' }, s.title || s.bvid),
              h('span', { className: 'bf-skip-reason' }, s.skipped.reason || ''),
            )),
          ),
        )
      : null,
  )
}
```

> 纯浏览与无对话的卡默认折叠由 `ActivityCard` 的 `open` 计算保证（`stage.replies > 0 || stage.repliedBack`），不需要额外开关。

- [ ] **Step 7: 组装看板 + 横幅**

```js
function Dashboard() {
  const ov = useOverview()
  const running = !!ov.data?.round?.running
  const act = useActivity(running)
  const onToggle = async (v) => { await apiPost('/duty', { autoDuty: v }); ov.refresh() }
  const onRun = async () => { await apiPost('/run'); ov.refresh() }
  const onStop = async () => { await apiPost('/stop'); ov.refresh() }
  return h('div', null,
    h(Banner, { health: ov.data?.health, account: ov.data?.account }),
    h(AccountBar, { data: ov.data }),
    h(DutyBar, { data: ov.data, onToggle, onRun, onStop }),
    h(QuotaTiles, { data: ov.data }),
    h(ActivityFeed, { data: act.data }),
  )
}
```

`Banner` 只在三种情况渲染：未登录、无 dsh CLI、上一轮 `lastCode !== 0`。

- [ ] **Step 8: 视觉核对（对照 demo）**

重启 DSH → 侧栏图标 → 看板：

- 账号条、值班条、配额、活动流四块顺序与间距对齐 `docs/demo/shots/01-dashboard-light.png`；
- 第一条活动卡默认展开，显示阶段条 + 评论引文 + 回复线程（真实数据若还没回复，则显示「还没有人回复」）；
- 宿主切深色后，颜色与 `02-dashboard-dark.png` 一致，无刺眼差异。

- [ ] **Step 9: 提交**

```powershell
git add dsh-plugin/client.js
git commit -m "feat(client): 看板（账号/值班/配额/活动生命周期流）"
```

---

## Task 12：操作台实现

**Files:**
- Modify: `dsh-plugin/client.js`

- [ ] **Step 1: 下划线 tab**

```js
function Tabs({ items, value, onChange }) {
  return h('div', { className: 'bf-ctabs', role: 'tablist' },
    items.map(([k, label]) => h('button', {
      key: k, role: 'tab', 'aria-selected': String(value === k), onClick: () => onChange(k),
    }, label)))
}
```

- [ ] **Step 2: 配置页**

```js
function ConfigPane({ onSaved }) {
  const cfg = usePoll(React.useCallback(() => apiGet('/config'), []), 30000)
  const [draft, setDraft] = React.useState(null)
  React.useEffect(() => { if (cfg.data && !draft) setDraft({ ...cfg.data.values }) }, [cfg.data, draft])
  const [msg, setMsg] = React.useState('')
  if (!draft) return h('div', { className: 'bf-note' }, '加载中…')

  const set = (k, v) => setDraft({ ...draft, [k]: v })
  const save = async () => {
    const patch = {}
    for (const k of Object.keys(draft)) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(cfg.data?.values?.[k])) patch[k] = draft[k]
    }
    const r = await apiPost('/config', patch)
    setMsg(r.ok ? '已保存并生效' : `保存失败：${r.error}`)
    cfg.refresh()
    onSaved?.()
  }
  return h(Card, null,
    h(Group, { title: '值班节奏' },
      h(Row, { label: '自动值班' }, h(Switch, { checked: !!draft.autoDuty, onChange: (v) => set('autoDuty', v) }),
        h('span', { className: 'bf-note' }, '开启后在谷时窗口自动拉起一轮')),
      h(Row, { label: '中午窗口' }, h(Switch, { checked: !!draft.noon, onChange: (v) => set('noon', v) }), h('span', { className: 'bf-note' }, '12:00 – 14:00')),
      h(Row, { label: '晚间窗口' }, h(Switch, { checked: !!draft.night, onChange: (v) => set('night', v) }), h('span', { className: 'bf-note' }, '18:00 – 次日 09:00')),
    ),
    h(Group, { title: '配额' },
      [['perDay', '每天挑中'], ['commentsPerDay', '每天评论'], ['commentsPerRound', '每轮评论'],
       ['likesPerDay', '每天点赞'], ['dynamicsPerDay', '每天动态'], ['repliesPerRound', '每轮跟进回复']]
        .map(([k, label]) => h(Row, { key: k, label },
          h(Num, { value: Number(draft[k] ?? 0), onChange: (v) => set(k, v) }))),
    ),
    h(Group, { title: '内容源' },
      h(Row, { label: '关键词' }, h(ChipsInput, { values: draft.keywords || [], onChange: (v) => set('keywords', v) })),
      h(Row, { label: '订阅 UP 主' }, h(ChipsInput, { values: (draft.followUids || []).map(String), onChange: (v) => set('followUids', v.map((x) => Number(x)).filter(Boolean)) })),
    ),
    h(Group, { title: '人设' },
      h(Row, { label: '人设提示词' },
        h('textarea', { className: 'bf-textarea', value: draft.personaPrompt || '', placeholder: '留空＝中性说话', onChange: (e) => set('personaPrompt', e.target.value) }))),
    h(Group, { title: '运行环境' },
      h(Row, { label: 'dsh CLI' }, h(Pill, { tone: 'ok' }, '已探测'), h('span', { className: 'bf-mono' }, draft.dshBin || '自动探测')),
      h(Row, { label: 'headless profile' }, h('span', { className: 'bf-note' }, draft.headlessProfile || 'headless')),
    ),
    h('div', { className: 'bf-form-foot' },
      msg ? h('span', { className: 'bf-note' }, msg) : null,
      h(Btn, { variant: 'ghost', onClick: () => setDraft({ ...cfg.data.defaults }) }, '恢复默认'),
      h(Btn, { variant: 'primary', onClick: save }, '保存并生效'),
    ),
  )
}
```

`Group`/`Row`/`ChipsInput` 是薄封装（放在 ConfigPane 之前）：

```js
const Group = ({ title, children }) =>
  h('div', { className: 'bf-form-group' },
    h('h3', { className: 'bf-group-title' }, title), children)

const Row = ({ label, children }) =>
  h('div', { className: 'bf-row' },
    h('span', { className: 'bf-row-label' }, label),
    h('div', { className: 'bf-row-body' }, children))

function ChipsInput({ values, onChange }) {
  const [draft, setDraft] = React.useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (!values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return h('div', { className: 'bf-chips' },
    values.map((v) => h('span', { className: 'bf-tag', key: v }, v,
      h('button', { 'aria-label': `删除 ${v}`, onClick: () => onChange(values.filter((x) => x !== v)) }, '×'),
    )),
    h('input', {
      className: 'bf-tag-add',
      value: draft,
      placeholder: '+ 添加',
      style: { width: 84 },
      onChange: (e) => setDraft(e.target.value),
      onKeyDown: (e) => { if (e.key === 'Enter') add() },
      onBlur: add,
    }),
  )
}
```

- [ ] **Step 3: 日志页**

```js
function LogPane() {
  const log = usePoll(React.useCallback(() => apiGet('/log?tail=200'), []), 5000)
  const [openRaw, setOpenRaw] = React.useState(false)
  const events = log.data?.events || []
  return h('div', null,
    h('div', { className: 'bf-panel-tools' },
      h(Btn, { small: true, onClick: () => navigator.clipboard?.writeText(log.data?.path || '') }, '复制路径')),
    h(Card, null,
      h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '宿主事件'),
        h('span', { className: 'bf-card-note' }, '结构化，异常标红')),
      h('div', { className: 'bf-log-events' },
        events.slice(-40).map((line, i) => {
          const t = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line)
          const msg = t ? line.slice(t[0].length) : line
          const err = /失败|错误|异常|error/i.test(msg)
          return h('div', { className: `bf-log-line${err ? ' err' : ''}`, key: i },
            h('span', { className: 'bf-log-t' }, t ? hhmm(t[1]) + ':' + new Date(t[1]).toTimeString().slice(6, 8) : ''),
            h('span', { className: 'bf-log-msg' }, msg),
          )
        }),
      ),
    ),
    h('details', { className: 'bf-group', open: openRaw, onToggle: (e) => setOpenRaw(e.currentTarget.open) },
      h('summary', null, '子进程原文（含模型推理文本，默认收起）'),
      h('pre', { className: 'bf-raw' }, log.data?.raw || ''),
    ),
  )
}
```

- [ ] **Step 4: 判重表 + 产物**

```js
function SeenPane() {
  const seen = usePoll(React.useCallback(() => apiGet('/seen'), []), 30000)
  const [q, setQ] = React.useState('')
  const rows = (seen.data?.rows || []).filter((r) =>
    !q || r.bvid.includes(q) || (r.title || '').includes(q))
  return h('div', null,
    h('div', { className: 'bf-panel-tools' },
      h('input', { className: 'bf-search', placeholder: '搜索 BV 号或标题', value: q, onChange: (e) => setQ(e.target.value) }),
      h('span', { className: 'bf-card-note', style: { alignSelf: 'center' } }, `共 ${rows.length} 条 · 这是「这个号看过什么」的唯一账本`)),
    h(Card, null, rows.length
      ? h('table', { className: 'bf-grid' },
          h('thead', null, h('tr', null, ['日期', 'BV 号', '动作', '标题'].map((t) => h('th', { key: t }, t)))),
          h('tbody', null, rows.map((r, i) => h('tr', { key: i },
            h('td', null, r.date), h('td', { className: 'bv' }, r.bvid),
            h('td', null, r.action), h('td', null, r.title)))))
      : h('div', { className: 'bf-note' }, seen.data?.raw ? '解析失败，见原文' : '还没有账本记录')),
  )
}

function ArtifactsPane() {
  const list = usePoll(React.useCallback(() => apiGet('/reports'), []), 60000)
  const [day, setDay] = React.useState('')
  const doc = usePoll(React.useCallback(() => apiGet(`/report?day=${day}`), [day]), 60000)
  const days = list.data?.days || []
  const digests = list.data?.digests || []
  React.useEffect(() => { if (!day && days.length) setDay(days[0]) }, [days, day])
  return h('div', { className: 'bf-split' },
    h(Card, { className: 'bf-artifacts' },
      h('div', { className: 'bf-card-note', style: { padding: '0 10px 6px' } }, '日报'),
      days.map((d) => h('button', {
        key: d, className: 'bf-artifact-item', 'aria-selected': String(d === day), onClick: () => setDay(d),
      }, h('span', { className: 'name' }, `${d}.md`))),
      digests.length ? h('div', { className: 'bf-card-note', style: { padding: '10px 10px 6px' } }, '月度归档') : null,
      digests.map((d) => h('button', {
        key: d, className: 'bf-artifact-item', 'aria-selected': String(d === day), onClick: () => setDay(d),
      }, h('span', { className: 'name' }, `digest/${d}.md`))),
    ),
    h('pre', { className: 'bf-doc' }, doc.data?.text || '（空）'),
  )
}
```

- [ ] **Step 5: 组装**

```js
function ConsoleView() {
  const [pane, setPane] = React.useState('config')
  return h('div', null,
    h(Tabs, { items: [['config', '配置'], ['log', '日志'], ['seen', '判重表'], ['artifacts', '产物']], value: pane, onChange: setPane }),
    pane === 'config' ? h(ConfigPane, null)
      : pane === 'log' ? h(LogPane, null)
      : pane === 'seen' ? h(SeenPane, null)
      : h(ArtifactsPane, null),
  )
}
```

把 `ConsolePage` 的子页内容替换为 `Dashboard` / `ConsoleView`。

- [ ] **Step 6: 视觉核对**

对照 `docs/demo/shots/03-console-config.png`、`04-console-seen.png`：开关与数字步进对齐、chips 可删、tab 下划线位置正确、深色下不发灰。

- [ ] **Step 7: 提交**

```powershell
git add dsh-plugin/client.js
git commit -m "feat(client): 操作台（配置/日志/判重表/产物）"
```

---

## Task 13：设置页瘦身 + 元数据

**Files:**
- Modify: `dsh-plugin/client.js`（`settings.section` 部分）
- Modify: `dsh-plugin/package.json`、`dsh-plugin/README.md`、`CONTEXT.md`

- [ ] **Step 1: 设置页降级为跳转**

```js
function SettingsEntry() {
  const ov = usePoll(React.useCallback(() => apiGet('/overview'), []), 15000)
  const a = ov.data?.account || {}
  return h('div', { className: 'bf-console', style: { padding: 16 } },
    h('p', null, 'B站分身已经把控制台搬到左侧栏：账号、值班、配额与每条视频的活动生命周期都在那里。'),
    h('p', { className: 'bf-note' }, a.loggedIn ? `当前账号：${a.uname}（UID ${a.mid}）` : '当前未登录'),
    h(Btn, { variant: 'primary', onClick: () => ctxLayout?.selectPanel(PANEL_ID) }, '打开控制台'),
  )
}
```

`ctxLayout` 在 `apply(ctx)` 里赋值，供组件内的「打开控制台」按钮调用：

```js
let ctxLayout = null

// apply(ctx) 内第一行：
ctxLayout = ctx.get?.('layout') ?? ctx.layout
```

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'bili-fenshen', order: 35, label: 'B站分身',
}, SettingsEntry))
```

- [ ] **Step 2: 元数据与版本**

`package.json`：`version` → `0.4.0`；`files` 增加 `"lib/*.js"`；新增：

```json
"scripts": { "test": "node --test test/" }
```

`README.md` 增加两节：

```markdown
## 控制台

装好后左侧栏出现「B站分身」图标（插件 / 自动化任务 旁边）：

- **看板**：账号简况、自动值班开关、今日配额、**每条视频的活动生命周期**（刷到→看→赞→评→被回复→我回）。
- **操作台**：配置（值班节奏/配额/内容源/人设）、日志、判重表、产物。

设置 → B站分身 现在只保留一行入口说明。

## 账本

控制台的事实来源是 `<家目录>/ledger.jsonl`（一行一个事件，append-only）。
值班轮按章程「记账契约」写入动作；宿主每 5 分钟拉一次回复通知补 `reply-in`；
报告 `out/<日期>.md` 仍保留，用于人读与兜底回填。
```

- [ ] **Step 3: CONTEXT.md 补术语**

在「核心机制」下追加：

```markdown
**活动**: 一条视频在本插件里的一段完整经历，由账本事件按 BV 号聚合而成；一个活动从「刷到」开始，可能经历看/赞/评/被回复/我回。
_Avoid_: 记录、条目

**生命周期**: 活动的阶段序列（刷到 → 看 → 赞 → 评 → 被回复 → 我回），控制台以阶段条呈现。
_Avoid_: 时间线、流程

**账本（ledger）**: `<家目录>/ledger.jsonl`，一行一个 JSON 事件，是控制台的事实来源；报告是给人读的摘要。
_Avoid_: 日志（指 `duty.log`）、数据库
```

- [ ] **Step 4: 语法与测试**

Run:
```powershell
cd E:\myproject\BilibiliPlayer\dsh-plugin
node --check client.js
npm test
```
Expected: `node --check` 无输出；测试全绿（`# fail 0`）。

- [ ] **Step 5: 提交**

```powershell
git add dsh-plugin/client.js dsh-plugin/package.json dsh-plugin/README.md CONTEXT.md
git commit -m "feat: 控制台入口收口 + 版本 0.4.0 + 文档与术语"
```

---

## Task 14：端到端验证与清理

**Files:** 无新增

- [ ] **Step 1: 纯函数测试全绿**

Run: `cd E:\myproject\BilibiliPlayer\dsh-plugin; npm test`
Expected: 所有 test 文件 `# fail 0`。

- [ ] **Step 2: 用临时家目录验证接口（不污染真实数据）**

```powershell
$tmp = Join-Path $env:TEMP ("bfhome_" + [guid]::NewGuid().ToString("N").Substring(0,6))
New-Item -ItemType Directory -Force $tmp | Out-Null
# 灌 fixture 账本
@'
{"t":"2026-10-22T08:26:11Z","round":"2026-10-22T08:26:00Z","type":"view","bvid":"BV1xrnz6gEVD","title":"测试","author":"UP","views":1000,"grade":"worth"}
{"t":"2026-10-22T08:27:00Z","round":"2026-10-22T08:26:00Z","type":"comment","bvid":"BV1xrnz6gEVD","text":"测试评论","rpid":11}
{"t":"2026-10-22T09:00:00Z","round":"2026-10-22T08:26:00Z","type":"reply-in","bvid":"BV1xrnz6gEVD","parent":11,"rpid":21,"from":"张三","text":"回复我","notifId":1}
'@ | Set-Content -Path "$tmp\ledger.jsonl" -Encoding UTF8
Write-Host "fixture ready: $tmp"
```
然后用 DSH 重启（`BILI_FENSHEN_HOME` 需在启动 DSH 前设置）验证 `/overview` 与 `/activity` 返回结构。**验证后删掉该临时目录。**

Expected: `days[0].rounds[0].items[0].stage.replies === 1`、`stage.pendingReply === 1`。

- [ ] **Step 3: 实跑一轮**

在 DSH 会话里调用 `bili_fenshen_run`（或页面点「跑一轮」），等待结束，检查：

```powershell
Get-Content "$env:USERPROFILE\.dsh\bili-fenshen\ledger.jsonl" -Tail 5
```
Expected: 出现 `round-end`；若 Agent 按章程记账，还能看到 `view`/`comment` 等；否则应有 `source:"report"` 的兜底事件且不重复。

- [ ] **Step 4: 页面三处走查**

- 看板：账号条有真实昵称/UID/Lv；配额数字与报告一致；活动卡阶段条与折叠状态符合 §5.4。
- 操作台：改一个配额 → 保存 → 刷新后仍生效（说明写进了 `config.json`）；恢复默认可回退。
- 停止：开跑后点「中止」，日志出现结束行且「本轮」回到空闲。

- [ ] **Step 5: 清理临时产物**

```powershell
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Remove-Item "E:\myproject\BilibiliPlayer\dsh-plugin\test\.tmp" -Recurse -Force -ErrorAction SilentlyContinue
git status --porcelain
```
Expected: 只剩预期改动的文件。

- [ ] **Step 6: 最终提交**

```powershell
git add -A
git commit -m "test: 控制台端到端验证与清理"
```

---

## 覆盖对照（写完自查）

| 设计文档章节 | 对应任务 |
|---|---|
| §2 落点与注册 | Task 10 |
| §4 账本/兜底/轮询 | Task 1、2、5、7 |
| §5 生命周期呈现 | Task 3、11 |
| §6 看板 | Task 11 |
| §7 操作台 | Task 12 |
| §8 接口契约 | Task 6、7 |
| §9 视觉规范 | Task 10、11、12 |
| §10 单文件结构 | Task 10–12 |
| §11 i18n 例外 | Task 13（T 表即文案） |
| §12 Host 约束（拆分/配置/轮次/停止） | Task 4、7 |
| §12.5 安全 | Task 5、6 |
| §13 验证 | Task 14 |
| 顺带修复（token / 日志 / 重复路由 / 家目录） | Task 7、10 |
| `bili_reply` rpid | Task 8 |
| 章程记账 | Task 9 |

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| Agent 不按章程记账 | 宿主报告兜底回填（Task 7 Step 4），前端标「据报告回填」 |
| 宿主插件改动后启动失败 | 所有 `import` 与注册都在 try/catch；`lib/*` 纯函数不碰宿主 API；`node --check` + 单测先过 |
| 路由重复注册 | `routeRegistered` 一次性守卫 + 日志 |
| 配置写坏 | 白名单 + 类型校验 + 原子写；`恢复默认` 清空覆盖层 |
| 视觉与 demo 漂移 | 以 demo 的 CSS 为唯一来源复制，Task 11/12 各有对照检查步骤 |
| 误伤真实数据 | 验证用 `BILI_FENSHEN_HOME` 临时目录；Task 14 明确清理 |

**回滚**：`git revert` 对应 commit；账本与配置在用户家目录，删除 `ledger.jsonl` / `config.json` 即回到初始行为（patch config 仍是默认值）。
