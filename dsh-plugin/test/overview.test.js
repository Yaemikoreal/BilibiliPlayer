// dsh-plugin/test/overview.test.js
// W4-2b：概览「近 N 天窗口」的口径单测。
//
// 为什么单独一个文件：窗口化是**性能优化**，但性能优化最容易偷改语义。
// 这里用「同一份账本 + windowDays:0（全量旧口径）」做对拍（oracle = 优化前的行为），
// 只要窗口内输出跟全量输出有任何字段不一致，就说明优化改了语义 —— 必须当场红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverview, windowPool, countToday, DEFAULT_WINDOW_DAYS, nextWindow, nextWindowLabel } from '../lib/overview.js'
import { dayKeyOf } from '../lib/activity.js'

const DAY = 86400_000
const NOW = new Date('2026-10-28T10:00:00')          // 固定基准：别让测试随真实时间漂
const at = (msOffset) => new Date(NOW.getTime() + msOffset).toISOString()
const daysAgo = (n) => at(-n * DAY)

// 一份「什么事件都有」的账本（都在近 14 天内）
const recentEvents = () => [
  { t: daysAgo(2), round: 'r1', type: 'view', bvid: 'BV1a', title: 'A' },
  { t: daysAgo(2), round: 'r1', type: 'like', bvid: 'BV1a' },
  { t: daysAgo(2), round: 'r1', type: 'comment', bvid: 'BV1a', text: '这个真难绷', rpid: 11 },
  { t: daysAgo(2.1), round: 'r1', type: 'reply-scan', bvid: 'BV1a', decision: 'skipped' },
  { t: daysAgo(2.2), round: 'r1', type: 'reply-out', bvid: 'BV1a', parent: 99, rpid: 12, kind: 'proactive' },
  { t: daysAgo(2.3), round: 'r1', type: 'reply-in', bvid: 'BV1a', parent: 12, rpid: 13, from: '张三' },
  { t: daysAgo(2.5), round: 'r1', type: 'round-end', code: 0, durationMs: 60_000 },
  { t: daysAgo(1), round: 'r2', type: 'view', bvid: 'BV1b', title: 'B' },
  { t: daysAgo(1), round: 'r2', type: 'dynamic', text: '分享一个视频' },
  { t: daysAgo(1.2), round: 'r2', type: 'round-end', code: 0, durationMs: 30_000 },
  { t: at(-1 * DAY + 3.6e6), round: 'r2', type: 'reply-in', bvid: 'BV1b', parent: 0, rpid: 21, from: '李四' },
].sort((a, b) => String(a.t).localeCompare(String(b.t)))

const cfg = { autoDuty: true, noon: true, night: true, perDay: 5, commentsPerDay: 3, likesPerDay: 5, dynamicsPerDay: 1, repliesPerRound: 2, replyOthersPerRound: 3 }

test('W4-2b：窗口足够大 / 事件全在窗口内时，输出与全量旧口径逐字段一致', () => {
  const events = recentEvents()
  const windowed = buildOverview({ cfg, state: {}, events, now: NOW })
  const full = buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 0 })
  assert.deepEqual(windowed, full, '窗口内数据必须与旧的全量实现完全对拍')
})

test('W4-2b：windowDays 默认 14；0/负数 = 不切窗口（旧语义逃生门）', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 14)
  const events = recentEvents()
  const a = buildOverview({ cfg, state: {}, events, now: NOW })
  const b = buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 14 })
  assert.deepEqual(a, b)
  assert.deepEqual(
    buildOverview({ cfg, state: {}, events, now: NOW, windowDays: -1 }),
    buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 0 }),
  )
})

test('W4-2b：14 天外的轮次不进 lastRound（窗口化后有意行为），全量口径仍能看到', () => {
  const events = [
    { t: daysAgo(20), round: 'r-old', type: 'view', bvid: 'BVold', title: '20 天前' },
    { t: daysAgo(20), round: 'r-old', type: 'comment', bvid: 'BVold', text: '老评论', rpid: 1 },
    { t: daysAgo(20.1), round: 'r-old', type: 'round-end', code: 0, durationMs: 1000 },
    { t: daysAgo(1), round: 'r-new', type: 'view', bvid: 'BVnew', title: '昨天' },
    { t: daysAgo(1), round: 'r-new', type: 'round-end', code: 0, durationMs: 2000 },
  ]
  const windowed = buildOverview({ cfg, state: {}, events, now: NOW })
  const full = buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 0 })
  assert.equal(full.round.lastRound.roundId, 'r-new', '全量口径：最近一轮是 r-new（本来就该）')
  assert.equal(windowed.round.lastRound.roundId, 'r-new', '窗口内也有 r-new，不该被裁掉')
  // 老轮次单独放：窗口化后 lastRound 只剩窗口内的轮
  const onlyOld = events.filter((e) => e.round === 'r-old')
  assert.equal(buildOverview({ cfg, state: {}, events: onlyOld, now: NOW, windowDays: 0 }).round.lastRound.roundId, 'r-old')
  assert.equal(buildOverview({ cfg, state: {}, events: onlyOld, now: NOW }).round.lastRound, null, '窗口外轮次不算 lastRound（有意语义）')
})

test('W4-2b：窗口外的回复不计入 inbox.pendingReply（窗口化后有意行为）', () => {
  const events = [
    { t: daysAgo(30), round: 'r-old', type: 'reply-in', bvid: 'BVold', parent: 1, rpid: 9001, from: '很久以前' },
    { t: daysAgo(1), round: 'r-new', type: 'reply-in', bvid: 'BVnew', parent: 2, rpid: 9002, from: '昨天' },
  ]
  assert.equal(buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 0 }).inbox.pendingReply, 2)
  assert.equal(buildOverview({ cfg, state: {}, events, now: NOW }).inbox.pendingReply, 1, '14 天外的待回复不再计数')
})

test('W4-2b：countToday 与旧 dayKeyOf 口径逐条一致（含非法 t / 缺 t / 未来事件）', () => {
  const day = dayKeyOf(NOW.toISOString())
  const events = [
    ...recentEvents(),
    { t: at(-6 * 3600_000), round: 'r3', type: 'view', bvid: 'BVtoday' },      // 今天凌晨 04:00
    { t: 'not-a-date', round: 'r3', type: 'like', bvid: 'BVbad' },             // 非法时间
    { round: 'r3', type: 'comment', bvid: 'BVnotime', rpid: 2 },               // 没有 t
    { t: at(5 * 3600_000), round: 'r3', type: 'like', bvid: 'BVfuture' },      // 今天 15:00（未来）
    { t: at(2 * DAY), round: 'r3', type: 'view', bvid: 'BV2days' },            // 两天后（非今日）
  ]
  const old = (() => {
    const acc = { picked: 0, comments: 0, likes: 0, dynamics: 0, replies: 0, repliesProactive: 0, replyScans: 0, proactiveSkipped: 0 }
    for (const e of events) {
      if (!e || dayKeyOf(e.t) !== day) continue
      if (e.type === 'view') acc.picked += 1
      else if (e.type === 'comment') acc.comments += 1
      else if (e.type === 'like') acc.likes += 1
      else if (e.type === 'dynamic') acc.dynamics += 1
      else if (e.type === 'reply-out') { acc.replies += 1; if (e.kind === 'proactive') acc.repliesProactive += 1 }
      else if (e.type === 'reply-scan') { acc.replyScans += 1; if (e.decision === 'skipped') acc.proactiveSkipped += 1 }
    }
    return acc
  })()
  assert.deepEqual(countToday(events, day), old)
  assert.ok(old.picked >= 1 && old.likes >= 1, '今日事件要被算进去')
})

test('W4-2b：windowPool 保留窗口内与无 t 事件、按序裁掉过老事件、遇到超上界事件提前截止', () => {
  const sorted = [
    { t: daysAgo(40), type: 'view' },
    { t: daysAgo(20), type: 'view' },
    { t: daysAgo(3), type: 'view' },
    { t: at(-3600_000), type: 'view' },
    { type: 'view' },                             // 没有 t：不清除（旧全量口径也会看它）
    { t: at(1 * DAY), type: 'view' },             // 未来 1 天（窗口余量内）
    { t: at(30 * DAY), type: 'view' },            // 远超上界 ⇒ 从这里开始不该再收
    { t: at(31 * DAY), type: 'view' },
  ]
  const pool = windowPool(sorted, NOW, 14)
  const has = (e) => pool.includes(e)
  assert.equal(pool[0].t, sorted[2].t, '40/20 天前的不在窗口内')
  assert.ok(has(sorted[3]) && has(sorted[5]), '近 1 小时与未来 1 天都在窗口余量内')
  assert.ok(has(sorted[4]), '没有 t 的事件保留（不能因为窗口丢掉旧口径会看的事件）')
  assert.ok(!has(sorted[6]) && !has(sorted[7]), '超过上界的事件（含之后的）不再收')
  assert.equal(windowPool(sorted, NOW, 0), sorted, 'windowDays=0 直接返回原数组（旧语义）')
})

test('W4-2b：窗口化不改 daily / presence 的窗口内结果', () => {
  const events = recentEvents()
  const windowed = buildOverview({ cfg, state: {}, events, now: NOW })
  const full = buildOverview({ cfg, state: {}, events, now: NOW, windowDays: 0 })
  assert.deepEqual(windowed.quota.picked, full.quota.picked)
  assert.deepEqual(windowed.quota.comments, full.quota.comments)
  assert.deepEqual(windowed.presence, full.presence)
  assert.deepEqual(windowed.quota.perRound, full.quota.perRound)
})

/* ───────── 排班模式：windows 与旧实现逐字对拍 + interval / daily 的「下一轮」 ───────── */

test('buildOverview · duty：windows 模式的 nextWindowLabel/nextRunAt 与旧 nextWindow 逐字对拍', () => {
  const cfgW = { ...cfg } // 无排班字段 = 默认 windows（老配置/老测试的形状）
  const times = [
    '2026-10-28T10:00:00', '2026-10-28T12:30:00', '2026-10-28T13:59:00',
    '2026-10-28T14:00:00', '2026-10-28T15:00:00', '2026-10-28T17:30:00',
    '2026-10-28T18:00:00', '2026-10-29T02:00:00', '2026-10-29T09:00:00',
  ]
  for (const t of times) {
    const now = new Date(t)
    const out = buildOverview({ cfg: cfgW, state: {}, events: [], now })
    assert.equal(out.duty.nextWindowLabel, nextWindowLabel(cfgW, now), t)
    const old = nextWindow(cfgW, now)
    assert.equal(out.duty.nextRunAt, old ? old.at : null, t)
    // round 与 duty 同步（客户端状态条两个字段都可能读）
    assert.equal(out.round.nextWindowLabel, out.duty.nextWindowLabel, t)
    assert.equal(out.round.nextRunAt, out.duty.nextRunAt, t)
    assert.equal(out.duty.scheduleMode, 'windows')
    assert.equal(out.duty.scheduleLabel, '谷时窗口')
  }
})

test('buildOverview · duty：interval 模式按上次运行算「下一轮」，autoDuty 关只影响 nextRunAt', () => {
  const now = new Date('2026-10-28T10:00:00')
  const cfgI = {
    ...cfg, dutyScheduleMode: 'interval', dutyIntervalMinutes: 180,
    dutyActiveStart: '09:00', dutyActiveEnd: '23:00',
  }
  const state = { lastAutoRunAt: new Date(now.getTime() - 100 * 60_000).toISOString() }
  const out = buildOverview({ cfg: cfgI, state, events: [], now })
  assert.equal(out.duty.scheduleMode, 'interval')
  assert.equal(out.duty.scheduleLabel, '间隔 3 小时')
  assert.equal(out.duty.nextWindowLabel, '每 3 小时（1h20m 后）')
  assert.equal(out.duty.nextRunAt, now.getTime() + 80 * 60_000)
  assert.equal(out.round.nextWindowLabel, '每 3 小时（1h20m 后）')
  assert.equal(out.round.nextRunAt, out.duty.nextRunAt)
  // 旧行为：标签照给（排班方式与总开关无关），nextRunAt 跟随 autoDuty
  const off = buildOverview({ cfg: { ...cfgI, autoDuty: false }, state, events: [], now })
  assert.equal(off.duty.nextRunAt, null)
  assert.equal(off.duty.nextWindowLabel, '每 3 小时（1h20m 后）')
})

test('buildOverview · duty：daily 模式多槽位，跑过的槽位顺延到明天', () => {
  const now = new Date('2026-10-28T10:00:00')
  const cfgD = { ...cfg, dutyScheduleMode: 'daily', dutyDailyTimes: ['08:30', '12:30'] }
  const out = buildOverview({ cfg: cfgD, state: {}, events: [], now })
  assert.equal(out.duty.scheduleMode, 'daily')
  assert.equal(out.duty.scheduleLabel, '每天 08:30、12:30')
  assert.equal(out.duty.nextWindowLabel, '每天 12:30（2h30m 后）')
  assert.equal(out.duty.nextRunAt, new Date('2026-10-28T12:30:00').getTime())
  // 今天 12:30 已跑 ⇒ 明天 08:30
  const used = { scheduleRuns: { 'daily:2026-10-28:12:30': true } }
  const next = buildOverview({ cfg: cfgD, state: used, events: [], now })
  assert.equal(next.duty.nextWindowLabel, '每天 08:30（22h30m 后）')
  assert.equal(next.duty.scheduleMode, 'daily')
})
