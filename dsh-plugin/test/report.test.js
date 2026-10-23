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
