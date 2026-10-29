/**
 * 设计定稿 2026-10-28 的新纯逻辑单测：轮次盘点 / 存在感 / 实时中枢 / 接话扫描解析 / 已接话清单。
 * 全部是纯函数或注入时钟的实现，不碰网络与真实文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { roundAccounting, lastRoundFrom, presenceFrom } from '../lib/round.js'
import { buildOverview, nextWindowLabel, nextWindow } from '../lib/overview.js'
import { createOverviewHub } from '../lib/realtime.js'
import { parseRoundReport, parseProactiveScan } from '../lib/report.js'
import { proactiveTargetsFromLedger, repliedTargetsFromLedger } from '../lib/replies.js'

const iso = (s) => new Date(s).toISOString()
const DAY = 86400_000

/* ───────── roundAccounting ───────── */

const RID = '2026-10-28T01:00:00.000Z'
const ev = (type, extra = {}) => ({ t: iso('2026-10-28T01:05:00Z'), round: RID, type, ...extra })

test('roundAccounting：接话扫描 + 接话 → posted', () => {
  const events = [
    ev('view', { bvid: 'BV1a' }),
    ev('like', { bvid: 'BV1a' }),
    ev('reply-scan', { bvid: 'BV1a', decision: 'posted', targetRpid: 222 }),
    ev('reply-out', { bvid: 'BV1a', parent: 222, kind: 'proactive', rpid: 333 }),
    ev('round-end', { code: 0, durationMs: 60000 }),
  ]
  const acc = roundAccounting(events, RID, { scanSince: Date.parse('2026-10-27T00:00:00Z') })
  assert.equal(acc.counts.views, 1)
  assert.equal(acc.counts.scans, 1)
  assert.equal(acc.counts.proactive, 1)
  assert.equal(acc.counts.replies, 0)
  assert.equal(acc.proactiveMissing, false)
  assert.equal(acc.reason, 'posted')
  assert.equal(acc.code, 0)
  assert.equal(acc.durationMs, 60000)
})

test('roundAccounting：扫描了但不接 → scan-but-skip，不算缺失', () => {
  const events = [
    ev('view', { bvid: 'BV1a' }),
    ev('reply-scan', { bvid: 'BV1a', decision: 'skipped', reason: '都在站队' }),
  ]
  const acc = roundAccounting(events, RID, { scanSince: 0 })
  assert.equal(acc.counts.scanSkips, 1)
  assert.equal(acc.proactiveMissing, false)
  assert.equal(acc.reason, 'scan-but-skip')
})

test('roundAccounting：读了内容但没扫描 → no-scan + proactiveMissing', () => {
  const events = [ev('view', { bvid: 'BV1a' }), ev('comment', { bvid: 'BV1a', rpid: 1 })]
  const acc = roundAccounting(events, RID, { scanSince: 0 })
  assert.equal(acc.proactiveMissing, true)
  assert.equal(acc.reason, 'no-scan')
})

test('roundAccounting：scanSince 之后才判违规（历史轮次不红）', () => {
  const events = [ev('view', { bvid: 'BV1a' })]
  const acc = roundAccounting(events, RID, { scanSince: Date.parse('2026-10-29T00:00:00Z') })
  assert.equal(acc.proactiveMissing, false)
  assert.equal(acc.proactiveJudged, false)
})

test('roundAccounting：只发动态/没读内容 → 不要求扫描', () => {
  const events = [ev('dynamic', { bvid: 'BV1a', id: 'x' })]
  const acc = roundAccounting(events, RID, { scanSince: 0 })
  assert.equal(acc.proactiveMissing, false)
  assert.equal(acc.reason, 'no-content')
})

test('lastRoundFrom：按 round-end 时间取最近一轮', () => {
  const events = [
    { t: iso('2026-10-27T10:00:00Z'), round: 'r-old', type: 'view', bvid: 'BV1a' },
    { t: iso('2026-10-27T10:10:00Z'), round: 'r-old', type: 'round-end', code: 0, durationMs: 1000 },
    { t: iso('2026-10-28T10:00:00Z'), round: 'r-new', type: 'view', bvid: 'BV1b' },
    { t: iso('2026-10-28T10:20:00Z'), round: 'r-new', type: 'reply-scan', bvid: 'BV1b', decision: 'posted', targetRpid: 1 },
    { t: iso('2026-10-28T10:30:00Z'), round: 'r-new', type: 'round-end', code: 0, durationMs: 2000 },
  ]
  const last = lastRoundFrom(events)
  assert.equal(last.roundId, 'r-new')
  assert.equal(last.counts.scans, 1)
  assert.equal(last.proactiveMissing, false)
  assert.equal(lastRoundFrom([]), null)
})

/* ───────── presence ───────── */

test('presenceFrom：只统计窗口内、按本地日分桶、收赞标记不可用', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  const events = [
    { t: new Date(now - 1 * DAY).toISOString(), type: 'reply-in', bvid: 'BV1a', rpid: 1 },
    { t: new Date(now - 2 * DAY).toISOString(), type: 'comment', bvid: 'BV1a', text: '我评的' },
    { t: new Date(now - 40 * DAY).toISOString(), type: 'reply-in', bvid: 'BV1b', rpid: 2 },
    { t: new Date(now - 1 * DAY).toISOString(), type: 'like-in', bvid: 'BV1a' },
  ]
  const p = presenceFrom(events, { now })
  assert.equal(p.replies7d, 1)
  assert.equal(p.comments7d, 1)
  assert.equal(p.likes7d, 1)
  assert.equal(p.likesAvailable, false)
  assert.equal(p.trend.length, 7)
  assert.equal(p.latest.text, '我评的')
  assert.ok(p.note.includes('收赞'))
})

/* ───────── 实时中枢 ───────── */

const mkHub = (compute) => {
  let pending = null
  const hub = createOverviewHub({
    compute,
    debounceMs: 0,
    minIntervalMs: 0,
    schedule: (fn) => { pending = fn; return 1 },
    cancel: () => { pending = null },
  })
  return { hub, flush: () => { const f = pending; pending = null; return f ? f() : null }, hasPending: () => !!pending }
}

test('hub：首读即算，seq 从 1 起单调递增', () => {
  const { hub, flush } = mkHub(() => ({ v: 1 }))
  const a = hub.view()
  assert.equal(a.seq, 1)
  assert.equal(a.v, 1)
  assert.ok(a.dataUpdatedAt)
  hub.publish('x')
  flush()
  const b = hub.view()
  assert.equal(b.seq, 2)
  assert.ok(b.seq > a.seq)
})

test('hub：多次 publish 合并成一次重算（防轮末批量写风暴）', () => {
  let calls = 0
  const { hub, flush, hasPending } = mkHub(() => { calls += 1; return { n: calls } })
  hub.view() // 1
  for (let i = 0; i < 10; i++) hub.publish('burst')
  assert.equal(hasPending(), true)
  flush()
  assert.equal(calls, 2) // 首读 + 合并后的一次
})

test('hub：compute 抛错时保留上一次数据并置 degraded', () => {
  let boom = false
  const { hub, flush } = mkHub(() => { if (boom) throw new Error('boom'); return { v: 7 } })
  const a = hub.view()
  assert.equal(a.degraded, false)
  boom = true
  hub.publish('x')
  const b = flush()
  assert.equal(b.degraded, true)
  assert.equal(b.v, 7)              // 旧数据保留
  assert.equal(b.dataUpdatedAt, a.dataUpdatedAt) // 新鲜度不跳
  assert.ok(b.seq > a.seq)
})

test('hub：bump 强制 +1 —— 建连首帧的 seq 必须严格大于 hello 的 seq', () => {
  const { hub } = mkHub(() => ({ v: 1 }))
  const a = hub.view()                      // seq=1（线上建连时数据往往已经算过）
  const helloSeq = hub.seq                  // hello 帧携带的 seq
  const b = hub.bump('stream-open')
  assert.equal(helloSeq, a.seq)
  assert.ok(b.seq > helloSeq, '首帧 seq 必须严格大于 hello，否则客户端会丢掉整份概览')
  assert.equal(b.v, 1)                      // 数据原样带上
  const c = hub.bump()
  assert.equal(c.seq, b.seq + 1)            // 继续单调 +1
})

test('hub：bump 吃掉待执行的重算（不重复算两次）', () => {
  let calls = 0
  const { hub, flush, hasPending } = mkHub(() => { calls += 1; return { n: calls } })
  hub.view()                                // 1 次
  hub.publish('x')
  assert.equal(hasPending(), true)
  const env = hub.bump('stream-open')
  assert.equal(hasPending(), false, 'bump 之后不应还留着待执行的重算')
  assert.equal(env.n, 2)
  assert.equal(calls, 2)
  assert.equal(flush(), null)
})

test('hub：subscribe 收到每帧，close 后不再推', () => {
  const seen = []
  const { hub, flush } = mkHub(() => ({ v: 1 }))
  hub.subscribe((env) => seen.push(env.seq))
  hub.view()
  hub.publish('x')
  flush()
  assert.deepEqual(seen, [1, 2])
  hub.close()
  hub.publish('y')
  assert.equal(seen.length, 2)
})

/* ───────── 概览信封 ───────── */

test('buildOverview：本轮口径取 live 轮次、lastRound 来自账本、nextRunAt 跟随自动值班', () => {
  const events = [
    { t: iso('2026-10-28T01:05:00Z'), round: RID, type: 'view', bvid: 'BV1a' },
    { t: iso('2026-10-28T01:06:00Z'), round: RID, type: 'reply-scan', bvid: 'BV1a', decision: 'skipped', reason: 'x' },
    { t: iso('2026-10-28T01:07:00Z'), round: RID, type: 'round-end', code: 0, durationMs: 1000 },
  ]
  const cfg = { autoDuty: true, noon: true, night: true, perDay: 5, commentsPerDay: 3, likesPerDay: 5, dynamicsPerDay: 1, repliesPerRound: 2, replyOthersPerRound: 3 }
  const out = buildOverview({
    cfg, state: {}, events,
    liveSnap: { running: false, roundId: null },
    now: new Date('2026-10-28T10:00:00'),
  })
  assert.equal(out.quota.perRound.scans, 1)
  assert.equal(out.quota.perRound.roundId, RID)
  assert.equal(out.quota.limits.replyOthersPerRound, 3)
  assert.equal(out.round.lastRound.roundId, RID)
  assert.equal(typeof out.duty.nextRunAt, 'number')
  assert.match(out.duty.nextWindowLabel, /中午 12:00（2h00m 后）/)
  assert.equal(out.health.routeOk, false) // 没传 health 时的兜底
})

test('nextWindow：窗口内没有「下一轮」，关掉窗口则为 null', () => {
  const noon = new Date('2026-10-28T12:30:00')
  assert.equal(nextWindow({ noon: true, night: false }, noon), null)
  assert.equal(nextWindowLabel({ noon: false, night: false }, noon), '—')
  const at10 = nextWindow({ noon: true, night: false }, new Date('2026-10-28T10:00:00'))
  assert.equal(at10.key, 'noon')
  assert.equal(at10.deltaMin, 120)
})

/* ───────── 接话解析 ───────── */

const REPORT = `## 第一轮（round id ${RID}）

### BV1xrnz6gEVD
标题：折1万次，会坏吗？
UP：影视飓风 · 313.6万播放 · 24:52
**档位**：值得看
动作：点赞 + 评论（rpid 111）：\`我的评论\` + 接话（rpid 222）：\`接一句\`
接话扫描：候选 3 → 接 rpid 222（某设计师）

### BV2skip
标题：没有可接的热评
UP：某人 · 1.2万播放 · 03:00
**档位**：可以看
动作：点赞 + 评论（rpid 333）：\`另一条\`
接话扫描：候选 0（热评全在站队，不接）
`

test('parseRoundReport：接话段被剥离，评论不会被接话的 rpid/正文污染', () => {
  const { views } = parseRoundReport(REPORT, { round: RID, t: iso('2026-10-28T02:00:00Z') })
  const first = views.find((v) => v.bvid === 'BV1xrnz6gEVD')
  const cmt = first.actions.find((a) => a.type === 'comment')
  const proactive = first.actions.find((a) => a.type === 'reply-out')
  assert.equal(cmt.rpid, 111)
  assert.equal(cmt.text, '我的评论')
  assert.equal(proactive.kind, 'proactive')
  assert.equal(proactive.parent, 222)
  assert.equal(proactive.text, '接一句')
})

test('parseProactiveScan：posted / skipped 两种机器行', () => {
  const { scans, proactive } = parseProactiveScan(REPORT, { round: RID, t: iso('2026-10-28T02:00:00Z') })
  assert.equal(scans.length, 2)
  const posted = scans.find((s) => s.bvid === 'BV1xrnz6gEVD')
  assert.equal(posted.decision, 'posted')
  assert.equal(posted.targetRpid, 222)
  assert.equal(posted.candidateCount, 3)
  const skipped = scans.find((s) => s.bvid === 'BV2skip')
  assert.equal(skipped.decision, 'skipped')
  assert.ok(skipped.reason.includes('站队'))
  assert.equal(proactive.length, 1)
  assert.equal(proactive[0].parent, 222)
})

test('parseProactiveScan：没有 ### 分节时兜底收全局扫描行', () => {
  const { scans } = parseProactiveScan('本轮总结\n接话扫描：候选 1 → 接 rpid 999（某人）\n', { round: RID })
  assert.equal(scans.length, 1)
  assert.equal(scans[0].decision, 'posted')
  assert.equal(scans[0].targetRpid, 999)
})

test('parseProactiveScan：空文本不抛、返回空', () => {
  assert.deepEqual(parseProactiveScan(''), { scans: [], proactive: [] })
  assert.deepEqual(parseProactiveScan(null), { scans: [], proactive: [] })
})

/* ───────── 已回复清单（2026-10-29：接话+跟进统一目标判重） ───────── */

test('repliedTargetsFromLedger：接话+跟进都进清单，窗口过滤 + 去重 + 残行(parent=null)跳过', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const events = [
    { t: new Date(now - 1 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1a', parent: 111, kind: 'proactive' },
    { t: new Date(now - 1 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1a', parent: 111, kind: 'proactive' }, // 同轮重复记账
    { t: new Date(now - 1 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1a', parent: 111, kind: 'proactive', rpid: null, source: 'report' }, // 回填重复行
    { t: new Date(now - 2 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1b', parent: 222 }, // 跟进（无 kind）也要进清单
    { t: new Date(now - 30 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1c', parent: 333, kind: 'proactive' }, // 窗外
    { t: new Date(now - 2 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1d', parent: null, kind: 'proactive' }, // 残行
    { t: new Date(now - 2 * DAY).toISOString(), type: 'comment', bvid: 'BV1e', rpid: 444 }, // 不是 reply-out
  ]
  const out = repliedTargetsFromLedger(events, { days: 14, now })
  assert.equal(out.proactive.length, 1)
  assert.equal(out.proactive[0].bvid, 'BV1a')
  assert.equal(out.proactive[0].parent, 111)
  assert.equal(out.followup.length, 1)
  assert.equal(out.followup[0].bvid, 'BV1b')
  assert.equal(out.followup[0].parent, 222)
})

test('repliedTargetsFromLedger：跟进目标必须在清单里（Aria 楼 318480411329 被连回 2 轮的回归用例）', () => {
  // 2026-10-29 真实事故：01:13 轮跟进 Aria 的 rpid 318480411329，03:14 轮又跟了一遍——
  // 旧清单只认 kind=proactive，跟进目标查无记录 ⇒ 模型判"新鲜"再回一次。
  const now = Date.parse('2026-10-29T03:14:16Z')
  const events = [
    { t: '2026-10-29T01:18:26.000Z', round: 'r-0914', type: 'reply-out', bvid: 'BV1TisX6dEFS', parent: 318480411329, text: '刚盛好饭，手快有[doge]', rpid: 318499873361 },
    { t: '2026-10-29T01:18:26.000Z', round: 'r-0914', type: 'reply-out', bvid: 'BV192n66dEDQ', parent: 317852573329, text: '好家伙，补仓还带自助的[doge]', rpid: 318499756881 },
  ]
  const out = repliedTargetsFromLedger(events, { days: 14, now })
  const all = [...out.proactive, ...out.followup].map((x) => `${x.bvid}→${x.parent}`)
  assert.ok(all.includes('BV1TisX6dEFS→318480411329'), 'Aria 的跟进目标必须出现在清单里')
  assert.ok(all.includes('BV192n66dEDQ→317852573329'), '究极无敌路由器的跟进目标必须出现在清单里')
  assert.equal(out.followup.length, 2)
  assert.equal(out.proactive.length, 0)
})

test('proactiveTargetsFromLedger：旧接口保留，只返回接话目标', () => {
  const now = Date.parse('2026-10-28T00:00:00Z')
  const events = [
    { t: new Date(now - 1 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1a', parent: 111, kind: 'proactive' },
    { t: new Date(now - 2 * DAY).toISOString(), type: 'reply-out', bvid: 'BV1b', parent: 222 },
  ]
  const out = proactiveTargetsFromLedger(events, { days: 14, now })
  assert.equal(out.length, 1)
  assert.equal(out[0].parent, 111)
})
