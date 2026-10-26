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

