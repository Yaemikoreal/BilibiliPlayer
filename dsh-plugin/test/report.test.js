// dsh-plugin/test/report.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRoundReport, parseProactiveScan, roundSection, dedupeScans,
} from '../lib/report.js'

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

// ↓ 2026-10-25 真实报告格式（见 docs/analysis/2026-10-25-log-findings.md §4.3/§4.6）
const REAL = `## 第三轮（round id 2026-10-25T11:07:49.738Z）

### BV1mJHA6kEiF
标题：新英雄遐思详细测试
UP：布锅锅
**档位**：值得看
动作：评论（rpid 318151262257）：\`拿个爆能机还要说「这个归我了」，欠得很\`。点赞没做（今日点赞已超日配额，不再加）。

### BV1sPHP6kE82
标题：传奇历史人物志——特斯拉
UP：抽象历史人物志
**档位**：值得看
动作：点赞 + 评论（rpid 318147743009）：\`摩根那句没电线装不上电表，一下就说死了\` + 分享成动态（动态 id 1263091599065219094）。
`

test('实际报告格式：评论取到正文与 rpid', () => {
  const { views } = parseRoundReport(REAL, { round: 'r' })
  const v = views.find((x) => x.bvid === 'BV1mJHA6kEiF')
  const cmt = v.actions.find((a) => a.type === 'comment')
  assert.equal(cmt.text, '拿个爆能机还要说「这个归我了」，欠得很')
  assert.equal(cmt.rpid, 318151262257)
})

test('「点赞没做」不再回填成幽灵点赞（2026-10-25 真实事故）', () => {
  const { views } = parseRoundReport(REAL, { round: 'r' })
  const v = views.find((x) => x.bvid === 'BV1mJHA6kEiF')
  assert.equal(v.actions.some((a) => a.type === 'like'), false, '写了"点赞没做"就不该有 like 事件')
})

test('「点赞 + 评论 + 分享成动态」三种动作都取到，动态带 id', () => {
  const { views } = parseRoundReport(REAL, { round: 'r' })
  const v = views.find((x) => x.bvid === 'BV1sPHP6kE82')
  assert.deepEqual(v.actions.map((a) => a.type).sort(), ['comment', 'dynamic', 'like'])
  assert.equal(v.actions.find((a) => a.type === 'dynamic').id, '1263091599065219094')
})

test('「评论没发」不产生 comment 事件', () => {
  const text = `### BV1zzzzzzzzz
标题：t
UP：u
**档位**：可以看
动作：点赞（评论没发——评论区吵成一团，不掺和）。
`
  const { views } = parseRoundReport(text, { round: 'r' })
  assert.deepEqual(views[0].actions.map((a) => a.type), ['like'])
})

/* ═════════ 2026-10-29 两轮真实日志的回归（回填串轮 + 重复 + 少读动作行） ═════════ */
const DAY = `# 2026-10-29

## 凌晨轮（round id 2026-10-28T16:07:49.108Z）

### BV1eDnd6MEQH
标题：A
UP：某UP · 52.3万播放 · 15:56
**档位**：值得看
动作：点赞 + 评论（rpid 1）：\`甲\` + 接话（rpid 2）：\`乙\`
接话扫描：候选 2 → 接 rpid 2（某人）

## 第三轮（round id 2026-10-28T16:12:43.505Z）

### BV1TisX6dEFS
标题：B
UP：另一个 · 1 播放 · 1:18
**档位**：值得看
动作：点赞没做（今日已 2/2 超配额）
动作：评论（rpid 3）：\`丙\`
接话扫描：候选 3（都在复读同一句）→ 全部不接
接话扫描：候选 0（BV1TisX6dEFS 评论区 0 条）
`
const R1 = '2026-10-28T16:07:49.108Z'
const R2 = '2026-10-28T16:12:43.505Z'

test('roundSection：只切出本轮那块（2026-10-29 回填串轮的根因）', () => {
  const s2 = roundSection(DAY, R2)
  assert.equal(s2.found, true)
  assert.equal(s2.rounds, 2)
  assert.ok(s2.text.includes('BV1TisX6dEFS'))
  assert.equal(s2.text.includes('BV1eDnd6MEQH'), false, '第二轮的块里不该有第一轮的视频')
  // 第一轮那块同理
  const s1 = roundSection(DAY, R1)
  assert.ok(s1.text.includes('BV1eDnd6MEQH'))
  assert.equal(s1.text.includes('BV1TisX6dEFS'), false)
  // 找不到（标题没带 round id）⇒ 明确告诉调用方，别退回整份去乱补
  const miss = roundSection(DAY, '2026-10-28T17:00:00.000Z')
  assert.equal(miss.found, false)
  assert.equal(miss.rounds, 2)
})

test('parseRoundReport：切块后只回填本轮的视频（不会把上一轮再补一遍）', () => {
  const { views } = parseRoundReport(roundSection(DAY, R2).text, { round: R2 })
  assert.deepEqual(views.map((v) => v.bvid), ['BV1TisX6dEFS'])
})

test('parseRoundReport：同一小节里两行 `动作：` 都要解析（评论不能被第一行的「点赞没做」吃掉）', () => {
  const { views } = parseRoundReport(roundSection(DAY, R2).text, { round: R2 })
  const types = views[0].actions.map((a) => a.type)
  assert.equal(types.includes('comment'), true, '第二行 `动作：评论（rpid 3）` 必须回填出来')
  assert.equal(types.includes('like'), false, '第一行写了「点赞没做」，不许有幽灵点赞')
  assert.equal(views[0].actions.find((a) => a.type === 'comment').rpid, 3)
})

test('parseProactiveScan：同一小节里的两行扫描都收，行内 BV 优先于小节标题', () => {
  const { scans } = parseProactiveScan(roundSection(DAY, R2).text, { round: R2, t: 'T' })
  assert.equal(scans.length, 2)
  assert.deepEqual(scans.map((s) => s.candidateCount), [3, 0])
  assert.deepEqual(scans.map((s) => s.bvid), ['BV1TisX6dEFS', 'BV1TisX6dEFS'])
})

test('dedupeScans：模型已经写过的扫描不再补（旧实现拿 `t` 比，等于没去重）', () => {
  const existing = [
    { type: 'reply-scan', round: R2, bvid: 'BV1eDnd6MEQH', decision: 'posted', targetRpid: 2 },
    { type: 'reply-scan', round: R2, bvid: 'BV1TisX6dEFS', decision: 'skipped' },
    { type: 'reply-scan', round: R1, bvid: 'BV1other', decision: 'skipped' },   // 别的轮次，不参与本轮去重
  ]
  const cands = [
    { round: R2, bvid: 'BV1ZDxL6CEko', decision: 'posted', targetRpid: 2 },     // 同一 target，bvid 挂错了也认
    { round: R2, bvid: 'BV1TisX6dEFS', decision: 'skipped' },                    // 同视频的跳过
    { round: R2, bvid: 'BV1new', decision: 'skipped' },                           // 真的缺 → 保留
  ]
  const out = dedupeScans(existing, cands, R2)
  assert.equal(out.length, 1)
  assert.equal(out[0].bvid, 'BV1new')
  // 同一批里重复的也只留一条
  const dup = dedupeScans([], [
    { decision: 'skipped', bvid: 'BV1same' },
    { decision: 'skipped', bvid: 'BV1same' },
  ], R2)
  assert.equal(dup.length, 1)
})

