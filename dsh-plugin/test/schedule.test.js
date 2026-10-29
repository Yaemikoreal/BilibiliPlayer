// dsh-plugin/test/schedule.test.js
// 自动值班排班纯逻辑：windows（旧行为）/ interval / daily 三种模式 + state 记账口径。
// 时间全部写死并注入，不依赖真实时钟（否则跨午夜/星期的用例会在不同日子红绿乱跳）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHHMM, normalizeSchedule, isActiveDay, inActiveRange, dueNow, nextRunAt,
  scheduleLabel, pruneScheduleRuns, DAILY_GRACE_MINUTES, DEFAULT_WEEKDAYS,
} from '../lib/schedule.js'

const at = (s) => new Date(s)
// 固定基准：2026-10-28（周三）12:10，2026-11-01 是周日
const WED = '2026-10-28'
const iso = (d) => d.toISOString()

/* ───────── 基础解析 ───────── */

test('parseHHMM：只认 00:00–23:59 的两位小时格式', () => {
  assert.equal(parseHHMM('00:00'), 0)
  assert.equal(parseHHMM('12:30'), 750)
  assert.equal(parseHHMM('23:59'), 1439)
  assert.equal(parseHHMM(' 08:05 '), 485) // 容忍首尾空格
  for (const bad of ['9:30', '24:00', '12:60', '12:3', '1230', '', null, undefined, 1230]) {
    assert.equal(parseHHMM(bad), null, `${String(bad)} 应非法`)
  }
})

/* ───────── 配置归一化（脏配置绝不抛错 / 绝不静默降级成「永不触发」） ───────── */

test('normalizeSchedule：空配置 = 旧行为（windows / 180 分钟 / 每天 / 全天活跃）', () => {
  const s = normalizeSchedule({})
  assert.equal(s.mode, 'windows')
  assert.equal(s.intervalMinutes, 180)
  assert.deepEqual(s.dailyTimes, [])
  assert.deepEqual(s.weekdays, [...DEFAULT_WEEKDAYS])
  assert.equal(s.activeStart, '00:00')
  assert.equal(s.activeEnd, '23:59')
  assert.equal(s.noon, false) // 旧行为：窗口开关只看 true
  assert.equal(s.night, false)
  const withWin = normalizeSchedule({ noon: true, night: true })
  assert.equal(withWin.noon, true)
  assert.equal(withWin.night, true)
})

test('normalizeSchedule：非法 mode / 间隔越界 / 非法时间 / 非法星期都回落安全值', () => {
  assert.equal(normalizeSchedule({ dutyScheduleMode: 'hourly' }).mode, 'windows')
  assert.equal(normalizeSchedule({ dutyIntervalMinutes: 'abc' }).intervalMinutes, 180)
  assert.equal(normalizeSchedule({ dutyIntervalMinutes: 5 }).intervalMinutes, 10) // 夹到下限，别变成每分钟跑
  assert.equal(normalizeSchedule({ dutyIntervalMinutes: 99999 }).intervalMinutes, 1440)
  assert.deepEqual(normalizeSchedule({ dutyDailyTimes: ['12:30', '08:05', '12:30', 'bad', '25:00'] }).dailyTimes, ['08:05', '12:30'])
  assert.deepEqual(
    normalizeSchedule({ dutyDailyTimes: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00'] }).dailyTimes.length,
    8,
  )
  assert.deepEqual(normalizeSchedule({ dutyWeekdays: [7, 1, 7, 8, 0, 'x'] }).weekdays, [1, 7])
  assert.deepEqual(normalizeSchedule({ dutyWeekdays: [] }).weekdays, [...DEFAULT_WEEKDAYS])
  assert.deepEqual(normalizeSchedule({ dutyWeekdays: [99] }).weekdays, [...DEFAULT_WEEKDAYS])
  assert.equal(normalizeSchedule({ dutyActiveStart: '25:00', dutyActiveEnd: 'bad' }).activeStart, '00:00')
  assert.equal(normalizeSchedule({ dutyActiveStart: '25:00', dutyActiveEnd: 'bad' }).activeEnd, '23:59')
})

/* ───────── 星期 / 活跃时段 ───────── */

test('isActiveDay：ISO 周一 = 1 … 周日 = 7；空数组 = 每天', () => {
  assert.equal(isActiveDay({ dutyWeekdays: [3] }, at(`${WED}T10:00:00`)), true) // 周三
  assert.equal(isActiveDay({ dutyWeekdays: [1] }, at(`${WED}T10:00:00`)), false)
  assert.equal(isActiveDay({ dutyWeekdays: [7] }, at('2026-11-01T10:00:00')), true) // 周日
  assert.equal(isActiveDay({ dutyWeekdays: [1] }, at('2026-11-01T10:00:00')), false) // JS 的 getDay()=0 不能当 0 点用
  assert.equal(isActiveDay({ dutyWeekdays: [] }, at('2026-11-01T10:00:00')), true)
})

test('inActiveRange：普通时段 / 跨午夜 / 起止相同 = 全天', () => {
  const day = { dutyActiveStart: '09:00', dutyActiveEnd: '18:00' }
  assert.equal(inActiveRange(day, at(`${WED}T08:59:00`)), false)
  assert.equal(inActiveRange(day, at(`${WED}T09:00:00`)), true) // 起点含
  assert.equal(inActiveRange(day, at(`${WED}T18:00:00`)), true) // 终点含
  assert.equal(inActiveRange(day, at(`${WED}T18:01:00`)), false)
  // 跨午夜：22:00–06:00
  const night = { dutyActiveStart: '22:00', dutyActiveEnd: '06:00' }
  assert.equal(inActiveRange(night, at(`${WED}T23:30:00`)), true)
  assert.equal(inActiveRange(night, at(`${WED}T02:00:00`)), true)
  assert.equal(inActiveRange(night, at(`${WED}T12:00:00`)), false)
  // 起止相同：按全天处理（宁可多跑，也不能因手滑配置永不触发）
  assert.equal(inActiveRange({ dutyActiveStart: '00:00', dutyActiveEnd: '00:00' }, at(`${WED}T13:00:00`)), true)
  // 默认 00:00–23:59 覆盖全天
  assert.equal(inActiveRange({}, at(`${WED}T23:59:00`)), true)
})

/* ───────── windows：与旧版逐字一致 + 星期过滤 ───────── */

const CFG_W = { autoDuty: true, noon: true, night: true }

test('dueNow · windows：中午/晚间窗口各一次，已跑/运行中/窗口外都不触发', () => {
  assert.deepEqual(dueNow(CFG_W, at(`${WED}T12:10:00`), {}), { reason: 'window:noon', slotKey: `${WED}:noon` })
  assert.deepEqual(dueNow(CFG_W, at(`${WED}T13:59:00`), {}), { reason: 'window:noon', slotKey: `${WED}:noon` })
  assert.equal(dueNow(CFG_W, at(`${WED}T14:00:00`), {}), null) // 窗口右开
  assert.deepEqual(dueNow(CFG_W, at(`${WED}T18:00:00`), {}), { reason: 'window:night', slotKey: `${WED}:night` })
  // 晚间窗口跨午夜：次日 02:00 仍属 18:00–09:00 这一窗（槽位按「当前日历日」记，与旧版一致）
  assert.deepEqual(dueNow(CFG_W, at('2026-10-29T02:00:00'), {}), { reason: 'window:night', slotKey: '2026-10-29:night' })
  // 已跑过（旧 state.windows 字段也要认）
  assert.equal(dueNow(CFG_W, at(`${WED}T12:10:00`), { windows: { [`${WED}:noon`]: true } }), null)
  // 已跑过（新 state.scheduleRuns）
  assert.equal(dueNow(CFG_W, at(`${WED}T12:10:00`), { scheduleRuns: { [`${WED}:noon`]: true } }), null)
  // running=true：任何模式都不触发
  assert.equal(dueNow(CFG_W, at(`${WED}T12:10:00`), {}, true), null)
  // 窗口开关
  assert.equal(dueNow({ autoDuty: true, noon: false, night: true }, at(`${WED}T12:10:00`), {}), null)
})

test('dueNow · windows：dutyWeekdays 过滤（默认全选 = 旧行为）', () => {
  assert.equal(dueNow({ ...CFG_W, dutyWeekdays: [1] }, at(`${WED}T12:10:00`), {}), null) // 周三不在 [周一]
  assert.deepEqual(
    dueNow({ ...CFG_W, dutyWeekdays: [3] }, at(`${WED}T12:10:00`), {}),
    { reason: 'window:noon', slotKey: `${WED}:noon` },
  )
})

/* ───────── interval：间隔 / 活跃时段 / 星期 ───────── */

const CFG_I = {
  autoDuty: true, dutyScheduleMode: 'interval', dutyIntervalMinutes: 180,
  dutyActiveStart: '09:00', dutyActiveEnd: '23:00', dutyWeekdays: [1, 2, 3, 4, 5, 6, 7],
}

test('dueNow · interval：没跑过就在活跃时段内立即到期；距上次不足间隔不触发', () => {
  assert.deepEqual(dueNow(CFG_I, at(`${WED}T10:00:00`), {}), {
    reason: 'interval', slotKey: `interval:${Math.floor(at(`${WED}T10:00:00`).getTime() / 60_000)}`,
  })
  assert.equal(dueNow(CFG_I, at(`${WED}T10:00:00`), { lastAutoRunAt: iso(at(`${WED}T09:00:00`)) }), null)
  assert.deepEqual(dueNow(CFG_I, at(`${WED}T12:00:00`), { lastAutoRunAt: iso(at(`${WED}T09:00:00`)) }), { reason: 'interval', slotKey: `interval:${Math.floor(at(`${WED}T12:00:00`).getTime() / 60_000)}` })
  // 没有 lastAutoRunAt 时回落到 lastRunStartedAt（手动轮次也算「刚跑过」）
  assert.equal(dueNow(CFG_I, at(`${WED}T10:00:00`), { lastRunStartedAt: iso(at(`${WED}T09:30:00`)) }), null)
  // 活跃时段外不触发
  assert.equal(dueNow(CFG_I, at(`${WED}T08:30:00`), {}), null)
  assert.equal(dueNow(CFG_I, at(`${WED}T23:30:00`), {}), null)
  // 同一分钟已记账 ⇒ 不重复触发
  const ms = at(`${WED}T10:00:00`).getTime()
  const state = { scheduleRuns: { [`interval:${Math.floor(ms / 60_000)}`]: true } }
  assert.equal(dueNow(CFG_I, at(`${WED}T10:00:00`), state), null)
})

test('dueNow · interval：活跃时段可跨午夜；星期过滤按「现在」算', () => {
  const cross = { ...CFG_I, dutyActiveStart: '22:00', dutyActiveEnd: '06:00' }
  assert.equal(dueNow(cross, at(`${WED}T23:30:00`), {}).reason, 'interval')
  assert.equal(dueNow(cross, at('2026-10-29T02:00:00'), {}).reason, 'interval')
  assert.equal(dueNow(cross, at(`${WED}T12:00:00`), {}), null)
  assert.equal(dueNow({ ...CFG_I, dutyWeekdays: [2] }, at(`${WED}T10:00:00`), {}), null)
  assert.equal(dueNow({ ...CFG_I, dutyWeekdays: [3] }, at(`${WED}T10:00:00`), {}).reason, 'interval')
})

/* ───────── daily：多槽位 / 宽限 / 跨天 / 星期 ───────── */

const CFG_D = { autoDuty: true, dutyScheduleMode: 'daily', dutyDailyTimes: ['08:30', '12:30', '20:00'], dutyWeekdays: [1, 2, 3, 4, 5, 6, 7] }

test('dueNow · daily：每个槽位每天一次，宽限 20 分钟内补跑、超时不补', () => {
  assert.equal(DAILY_GRACE_MINUTES, 20)
  assert.deepEqual(dueNow(CFG_D, at(`${WED}T12:30:00`), {}), { reason: 'daily:12:30', slotKey: `daily:${WED}:12:30` })
  assert.deepEqual(dueNow(CFG_D, at(`${WED}T12:50:00`), {}), { reason: 'daily:12:30', slotKey: `daily:${WED}:12:30` }) // 晚 20 分钟仍补
  assert.equal(dueNow(CFG_D, at(`${WED}T12:51:00`), {}), null) // 晚 21 分钟不补
  assert.equal(dueNow(CFG_D, at(`${WED}T12:00:00`), {}), null) // 还没到点
  assert.deepEqual(dueNow(CFG_D, at(`${WED}T20:05:00`), {}), { reason: 'daily:20:00', slotKey: `daily:${WED}:20:00` })
  // 跑过的槽位跳过；剩下的槽位不在宽限内就等到明天
  assert.equal(dueNow(CFG_D, at(`${WED}T12:35:00`), { scheduleRuns: { [`daily:${WED}:12:30`]: true } }), null)
  // 没配时间 ⇒ 永远不触发（不是「每分钟触发」）
  assert.equal(dueNow({ autoDuty: true, dutyScheduleMode: 'daily', dutyDailyTimes: [] }, at(`${WED}T12:30:00`), {}), null)
})

test('dueNow · daily：跨午夜补跑按「槽位所在日」记账；星期按槽位日过滤', () => {
  const late = { autoDuty: true, dutyScheduleMode: 'daily', dutyDailyTimes: ['23:59'], dutyWeekdays: [1, 2, 3, 4, 5, 6, 7] }
  // 周三 23:59 的槽位，周四 00:05 仍要补跑（键仍是周三）
  assert.deepEqual(dueNow(late, at('2026-10-29T00:05:00'), {}), { reason: 'daily:23:59', slotKey: `daily:${WED}:23:59` })
  // 周四 00:30 超过宽限 ⇒ 不补
  assert.equal(dueNow(late, at('2026-10-29T00:30:00'), {}), null)
  // 槽位日（周三）允许、今天（周四）不允许 ⇒ 跨午夜这次补跑仍要发生
  const onlyWed = { ...late, dutyWeekdays: [3] }
  assert.deepEqual(dueNow(onlyWed, at('2026-10-29T00:05:00'), {}), { reason: 'daily:23:59', slotKey: `daily:${WED}:23:59` })
  // 周四白天：周三不在允许内 ⇒ 不触发
  assert.equal(dueNow({ ...CFG_D, dutyWeekdays: [1] }, at(`${WED}T12:30:00`), {}), null)
  assert.equal(dueNow({ ...CFG_D, dutyWeekdays: [3] }, at(`${WED}T12:30:00`), {}).reason, 'daily:12:30')
})

/* ───────── nextRunAt 文案 ───────── */

test('nextRunAt · windows：与旧版 nextWindowLabel 同格式（中午 12:00（2h00m 后））', () => {
  assert.deepEqual(nextRunAt(CFG_W, at(`${WED}T10:00:00`)), {
    at: at(`${WED}T12:00:00`).getTime(),
    label: '中午 12:00（2h00m 后）',
    mode: 'windows',
  })
  assert.equal(nextRunAt(CFG_W, at(`${WED}T13:00:00`)).label, '晚间 18:00（5h00m 后）') // 已在中午窗口内 = 只剩晚间
  // 中午窗口内没有「中午下一轮」，但晚间窗口仍然有下一轮（与旧版 nextWindow 一致）
  assert.equal(nextRunAt(CFG_W, at(`${WED}T12:30:00`)).label, '晚间 18:00（5h30m 后）')
  assert.equal(nextRunAt({ autoDuty: true, noon: true, night: false }, at(`${WED}T12:30:00`)), null)
  assert.deepEqual(nextRunAt({ autoDuty: true, noon: false, night: false }, at(`${WED}T10:00:00`)), null)
})

test('nextRunAt · interval：每 3 小时（1h20m 后）/ 从没跑过就是现在 / 活跃时段外顺延', () => {
  const now = at(`${WED}T10:00:00`)
  const last = new Date(now.getTime() - 100 * 60_000) // 1h40m 前跑过，间隔 3h ⇒ 还差 1h20m
  const next = nextRunAt(CFG_I, now, { lastAutoRunAt: iso(last) })
  assert.equal(next.mode, 'interval')
  assert.equal(next.label, '每 3 小时（1h20m 后）')
  assert.equal(next.at, now.getTime() + 80 * 60_000)
  // 从没跑过 ⇒ 现在到期
  assert.equal(nextRunAt(CFG_I, now, {}).at, now.getTime())
  // 活跃时段 09:00 开始，08:00 时下一轮 = 09:00（1h 后）
  assert.equal(nextRunAt(CFG_I, at(`${WED}T08:00:00`), { lastAutoRunAt: iso(at(`${WED}T06:00:00`)) }).label, '每 3 小时（1h00m 后）')
  // 星期过滤：周三是允许的，周四不在允许内则顺延到下一个周一?（这里只配 [3]，下周三）
  const onlyWed = { ...CFG_I, dutyWeekdays: [3] }
  const nextWed = nextRunAt(onlyWed, at(`${WED}T23:59:00`), {})
  assert.equal(nextWed.mode, 'interval')
  assert.equal(nextWed.at > at(`${WED}T23:59:00`).getTime(), true)
})

test('nextRunAt · daily：每天 12:30（2h30m 后）/ 跨天 / 跑过的槽位顺延到明天', () => {
  assert.deepEqual(nextRunAt(CFG_D, at(`${WED}T10:00:00`)), {
    at: at(`${WED}T12:30:00`).getTime(),
    label: '每天 12:30（2h30m 后）',
    mode: 'daily',
  })
  // 今天最后一个槽位也过了 ⇒ 明天 08:30
  assert.equal(nextRunAt(CFG_D, at(`${WED}T21:00:00`)).label, '每天 08:30（11h30m 后）')
  // 今天 12:30 已跑 ⇒ 下一个 20:00
  assert.equal(
    nextRunAt(CFG_D, at(`${WED}T13:00:00`), { scheduleRuns: { [`daily:${WED}:12:30`]: true } }).label,
    '每天 20:00（7h00m 后）',
  )
  // 没配时间 ⇒ null（概览显示「—」）
  assert.equal(nextRunAt({ autoDuty: true, dutyScheduleMode: 'daily', dutyDailyTimes: [] }, at(`${WED}T10:00:00`)), null)
  // 星期过滤：只允许周一 ⇒ 周三的下一次在周一 08:30（跨 5 天）
  const onlyMon = { ...CFG_D, dutyWeekdays: [1] }
  const n = nextRunAt(onlyMon, at(`${WED}T10:00:00`))
  assert.equal(n.mode, 'daily')
  assert.equal(new Date(n.at).getDay(), 1)
})

test('scheduleLabel：谷时窗口 / 间隔 3 小时 / 每天 12:30', () => {
  assert.equal(scheduleLabel(CFG_W), '谷时窗口')
  assert.equal(scheduleLabel(CFG_I), '间隔 3 小时')
  assert.equal(scheduleLabel({ dutyScheduleMode: 'interval', dutyIntervalMinutes: 90 }), '间隔 1 小时 30 分钟')
  assert.equal(scheduleLabel(CFG_D), '每天 08:30、12:30、20:00')
  assert.equal(scheduleLabel({ dutyScheduleMode: 'daily', dutyDailyTimes: [] }), '每天（未设时间）')
})

/* ───────── state 记账清理 ───────── */

test('pruneScheduleRuns：只留最近 14 天 / 最多 30 项 / 认不出的键丢掉', () => {
  const now = at(`${WED}T12:00:00`)
  const oldDay = new Date(now.getTime() - 15 * 86400_000)
  const oldKey = `${oldDay.getFullYear()}-${String(oldDay.getMonth() + 1).padStart(2, '0')}-${String(oldDay.getDate()).padStart(2, '0')}:noon`
  const runs = {
    [`${WED}:noon`]: true,
    [`${WED}:night`]: true,
    'interval:29900000': true,
    'daily:2026-10-27:08:30': true,
    [oldKey]: true, // 15 天前：丢
    bogus: true, // 认不出：丢
    'daily:not-a-date:08:30': true, // 坏日期：丢
  }
  const out = pruneScheduleRuns(runs, now)
  assert.deepEqual(Object.keys(out).sort(), [
    `${WED}:noon`, `${WED}:night`, 'daily:2026-10-27:08:30', 'interval:29900000',
  ].sort())
  // 最多 30 项：保留最新的 30 个
  const many = {}
  for (let i = 0; i < 40; i++) {
    const d = new Date(now.getTime() - i * 60_000)
    many[`interval:${Math.floor(d.getTime() / 60_000)}`] = true
  }
  const kept = pruneScheduleRuns(many, now)
  assert.equal(Object.keys(kept).length, 30)
  // 空/非法输入不抛错
  assert.deepEqual(pruneScheduleRuns(null, now), {})
  assert.deepEqual(pruneScheduleRuns({}, now), {})
})
