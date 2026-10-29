/**
 * 自动值班排班（纯逻辑）：所有时间计算都可注入 now，不读全局、不做 IO。
 *
 * 三种排班方式：
 *  - windows（默认，向后兼容）：沿用旧版 noon(12:00–14:00) / night(18:00–次日 09:00) 谷时窗口，
 *    每天每窗一次；只额外叠加 dutyWeekdays 星期过滤（默认周一~周日 ⇒ 与旧版逐字节一致）。
 *  - interval：距上次运行（state.lastAutoRunAt || state.lastRunStartedAt）≥ 间隔分钟、
 *    在活跃时段内、且是允许的星期几 ⇒ 触发；从没跑过时活跃时段内立即到期。
 *  - daily：dutyDailyTimes 里每个 HH:MM 槽位每天一次；宿主睡过头超过宽限（20 分钟）就不补跑。
 *
 * 为什么单独一个文件：index.js 的 tick（要不要现在跑）与 lib/overview.js 的「下一轮」
 * 必须用同一套口径，否则会出现「概览说 3 小时后、调度器其实没到期」这种对不上的状态。
 * 旧版两处各写一份实现，已经踩过这种坑。
 */

const DAY_MS = 86400_000

/** 支持三种模式；非法值一律回落 windows（= 旧行为，绝不因为手改配置就不值班） */
export const SCHEDULE_MODES = Object.freeze(['windows', 'interval', 'daily'])
/** ISO 星期：周一 = 1 … 周日 = 7；空数组 = 每天 */
export const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7])
export const INTERVAL_MIN = 10
export const INTERVAL_MAX = 1440
export const DAILY_MAX = 8
/** daily 补跑宽限：晚到超过这么多分钟就不补（宿主休眠/关机后不该在半夜补一轮） */
export const DAILY_GRACE_MINUTES = 20

export const DEFAULT_INTERVAL_MINUTES = 180
export const DEFAULT_ACTIVE_START = '00:00'
export const DEFAULT_ACTIVE_END = '23:59'

/** 谷时窗口定义（与旧版 index.js / overview.js 完全一致；跨午夜用 end > 1440 表示） */
const WINDOWS = {
  noon: { start: 12 * 60, end: 14 * 60, label: '中午 12:00' },
  night: { start: 18 * 60, end: 33 * 60, label: '晚间 18:00' }, // 18:00–次日 09:00
}

/** 'HH:MM'（00:00–23:59）→ 当天分钟数；非法返回 null */
export const parseHHMM = (s) => {
  if (typeof s !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const fmtHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

const asDate = (now) => (now instanceof Date ? now : new Date(Number(now) || 0))

const dayKeyOfDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** ISO 星期：JS 的周日 = 0 ⇒ 7 */
const isoWeekdayOf = (d) => (d.getDay() === 0 ? 7 : d.getDay())

/** 旧版窗口判定用的口径：午夜前 12 小时内归前一天，方便跨午夜窗口比较 */
const minsOf = (d) => {
  const m = d.getHours() * 60 + d.getMinutes()
  return m < 12 * 60 ? m + 24 * 60 : m
}

/** 时长文案（与旧版 nextWindowLabel 完全同格式：`2h00m`） */
const durationText = (deltaMin) => {
  const safe = Math.max(0, Math.round(Number(deltaMin) || 0))
  const h = Math.floor(safe / 60)
  return `${h}h${String(safe % 60).padStart(2, '0')}m`
}

/** 间隔文案：180 ⇒ `3 小时`，90 ⇒ `1 小时 30 分钟`，45 ⇒ `45 分钟` */
const intervalText = (min) => {
  const total = Math.max(0, Math.round(Number(min) || 0))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h && m) return `${h} 小时 ${m} 分钟`
  if (h) return `${h} 小时`
  return `${m} 分钟`
}

/** dutyDailyTimes 归一化：只留合法 HH:MM，去重、升序、最多 8 个 */
const normalizeDailyTimes = (raw) => {
  if (!Array.isArray(raw)) return []
  const set = new Set()
  for (const x of raw) {
    const m = parseHHMM(x)
    if (m == null) continue
    set.add(fmtHHMM(m))
  }
  return [...set].sort().slice(0, DAILY_MAX)
}

/** dutyWeekdays 归一化：只留 1..7 的整数，去重升序；空/全非法 ⇒ 每天 */
const normalizeWeekdays = (raw) => {
  if (!Array.isArray(raw)) return [...DEFAULT_WEEKDAYS]
  const set = new Set()
  for (const x of raw) {
    const n = Number(x)
    if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n)
  }
  return set.size ? [...set].sort((a, b) => a - b) : [...DEFAULT_WEEKDAYS]
}

/**
 * 把配置（patch / config.json 覆盖层的合并结果）收敛成可计算的安全值。
 * 非法值一律回落默认：mode 回落 windows（老行为），间隔越界夹到 10..1440，
 * 时间/星期逐项过滤，绝不因为脏配置让调度器抛错或永不触发。
 *
 * @param {object} [cfg]
 * @returns {{mode:string, intervalMinutes:number, dailyTimes:string[], weekdays:number[],
 *            activeStart:string, activeEnd:string, noon:boolean, night:boolean}}
 */
export function normalizeSchedule(cfg = {}) {
  const src = cfg && typeof cfg === 'object' ? cfg : {}
  const mode = SCHEDULE_MODES.includes(src.dutyScheduleMode) ? src.dutyScheduleMode : 'windows'
  let intervalMinutes = Number(src.dutyIntervalMinutes)
  if (!Number.isFinite(intervalMinutes)) intervalMinutes = DEFAULT_INTERVAL_MINUTES
  intervalMinutes = Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(intervalMinutes)))
  const startMin = parseHHMM(src.dutyActiveStart)
  const endMin = parseHHMM(src.dutyActiveEnd)
  return {
    mode,
    intervalMinutes,
    dailyTimes: normalizeDailyTimes(src.dutyDailyTimes),
    weekdays: normalizeWeekdays(src.dutyWeekdays),
    activeStart: startMin == null ? DEFAULT_ACTIVE_START : fmtHHMM(startMin),
    activeEnd: endMin == null ? DEFAULT_ACTIVE_END : fmtHHMM(endMin),
    // 旧行为：窗口开关只认 true（undefined/false = 关）；真实配置由 schema 默认补 true
    noon: !!src.noon,
    night: !!src.night,
  }
}

const isActiveDayAt = (sched, d) => sched.weekdays.includes(isoWeekdayOf(d))

/** 是否允许的星期几（ISO：周一 = 1 … 周日 = 7；空 ⇒ 每天） */
export const isActiveDay = (cfg, now = new Date()) =>
  isActiveDayAt(normalizeSchedule(cfg), asDate(now))

const inActiveRangeAt = (sched, d) => {
  const start = parseHHMM(sched.activeStart) ?? 0
  const end = parseHHMM(sched.activeEnd) ?? 23 * 60 + 59
  // 起止相同视为全天：避免 '00:00'–'00:00' 变成永不触发（宁可多跑，也别静默失效）
  if (start === end) return true
  const m = d.getHours() * 60 + d.getMinutes()
  // start > end = 跨午夜（如 22:00–06:00）
  return start < end ? (m >= start && m <= end) : (m >= start || m <= end)
}

/** 是否落在活跃时段内（仅 interval 模式使用；支持跨午夜） */
export const inActiveRange = (cfg, now = new Date()) =>
  inActiveRangeAt(normalizeSchedule(cfg), asDate(now))

/** 上次运行时刻（自动优先；手动轮次也算「跑过」，避免刚跑完又按间隔再拉一轮） */
const lastRunMs = (state) => {
  const raw = state?.lastAutoRunAt || state?.lastRunStartedAt || ''
  const ms = Date.parse(String(raw ?? ''))
  return Number.isFinite(ms) ? ms : 0
}

/* ───────────────────────── 到期判定（index.js tick 用） ───────────────────────── */

const windowsDue = (sched, d, state) => {
  const x = minsOf(d)
  const today = dayKeyOfDate(d)
  for (const k of ['noon', 'night']) {
    if (!sched[k]) continue
    const w = WINDOWS[k]
    if (!(x >= w.start && x < w.end)) continue
    const slotKey = `${today}:${k}`
    // 旧字段 state.windows 读写兼容：老版本写过的标记仍然算数
    if (state?.windows?.[slotKey]) continue
    if (state?.scheduleRuns?.[slotKey]) continue
    return { reason: `window:${k}`, slotKey }
  }
  return null
}

const intervalDue = (sched, d, state) => {
  if (!inActiveRangeAt(sched, d)) return null
  const nowMs = d.getTime()
  const last = lastRunMs(state)
  // 从没跑过 ⇒ 活跃时段内立即到期（首轮不必干等一个间隔）
  if (last && nowMs - last < sched.intervalMinutes * 60_000) return null
  const slotKey = `interval:${Math.floor(nowMs / 60_000)}`
  if (state?.scheduleRuns?.[slotKey]) return null
  return { reason: 'interval', slotKey }
}

const dailyDue = (sched, d, state) => {
  if (!sched.dailyTimes.length) return null
  const nowMs = d.getTime()
  const candidates = []
  /* 槽位按「槽位所在日」判星期。除了今天的槽位，还要看昨天跨过午夜、仍在宽限内的槽位：
   * 23:59 的槽位在次日 00:10 仍要补跑（否则宿主就晚睡 10 分钟就永久错过这一轮）。 */
  const addDay = (base, dayKey) => {
    for (const t of sched.dailyTimes) {
      const start = parseHHMM(t)
      if (start == null) continue
      const at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(start / 60), start % 60)
      const late = (nowMs - at.getTime()) / 60_000
      if (late < 0 || late > DAILY_GRACE_MINUTES) continue
      const slotKey = `daily:${dayKey}:${t}`
      if (state?.scheduleRuns?.[slotKey]) continue
      if (!isActiveDayAt(sched, at)) continue
      candidates.push({ reason: `daily:${t}`, slotKey, at: at.getTime() })
    }
  }
  addDay(d, dayKeyOfDate(d))
  const yesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  addDay(yesterday, dayKeyOfDate(yesterday))
  if (!candidates.length) return null
  // 最早漏掉的槽位优先（一次 tick 只跑一轮，剩下的留给下一跳继续补）
  candidates.sort((a, b) => a.at - b.at)
  return { reason: candidates[0].reason, slotKey: candidates[0].slotKey }
}

/**
 * 现在是否该自动拉一轮。
 * @param {object} cfg 生效配置
 * @param {Date|number} [now]
 * @param {object} [state] state.json（读 scheduleRuns / windows / lastAutoRunAt / lastRunStartedAt）
 * @param {boolean} [running] 正在跑 ⇒ 一律不触发
 * @returns {null | {reason:string, slotKey:string}} reason 直接作为 runDuty 的 why（window:noon / interval / daily:HH:MM）
 */
export function dueNow(cfg, now = new Date(), state = {}, running = false) {
  if (running) return null
  const sched = normalizeSchedule(cfg)
  const d = asDate(now)
  if (sched.mode === 'interval') {
    // interval 看「现在」是星期几；daily 看「槽位所在日」（跨午夜补跑也按昨天算）
    if (!isActiveDayAt(sched, d)) return null
    return intervalDue(sched, d, state)
  }
  if (sched.mode === 'daily') return dailyDue(sched, d, state)
  if (!isActiveDayAt(sched, d)) return null
  return windowsDue(sched, d, state)
}

/* ───────────────────────── 下一轮（overview 用） ───────────────────────── */

const nextWindowsRun = (sched, d) => {
  const nowMs = d.getTime()
  const x = minsOf(d)
  const out = []
  for (const [key, w] of Object.entries(WINDOWS)) {
    if (!sched[key]) continue
    // 已在窗口内且今天允许触发：调度器此刻就会触发（或已跑过），没有「下一轮」（旧行为不变）
    if (x >= w.start && x < w.end && isActiveDayAt(sched, d)) continue
    let deltaMin = ((w.start - x) + 2880) % 1440
    // dutyWeekdays 过滤：非活跃星期就整天顺延（默认全选 ⇒ 与旧版逐字一致）
    for (let i = 0; i < 7 && !isActiveDayAt(sched, new Date(nowMs + deltaMin * 60_000)); i++) {
      deltaMin += 1440
    }
    out.push({ label: w.label, at: nowMs + deltaMin * 60_000, deltaMin })
  }
  out.sort((a, b) => a.at - b.at)
  const first = out[0]
  if (!first) return null
  return { at: first.at, label: `${first.label}（${durationText(first.deltaMin)} 后）`, mode: 'windows' }
}

/** 从 fromMs 起下一次落在「允许的星期 + 活跃时段」内的时刻；找不到返回 null */
const nextActiveMoment = (sched, fromMs) => {
  const from = new Date(fromMs)
  if (isActiveDayAt(sched, from) && inActiveRangeAt(sched, from)) return fromMs
  const startMin = parseHHMM(sched.activeStart) ?? 0
  for (let i = 0; i <= 8; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)
    const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMin / 60), startMin % 60)
    if (cand.getTime() < fromMs) continue // 今天的起点已过（且当前不在活跃时段）⇒ 看明天
    if (!isActiveDayAt(sched, cand)) continue
    return cand.getTime()
  }
  return null
}

const nextIntervalRun = (sched, d, state) => {
  const nowMs = d.getTime()
  const intervalMs = sched.intervalMinutes * 60_000
  const last = lastRunMs(state)
  // 从没跑过 ⇒ 现在就是下一轮；否则 = max(现在, 上次 + 间隔)
  const base = last ? Math.max(nowMs, last + intervalMs) : nowMs
  const at = nextActiveMoment(sched, base)
  if (at == null) return null
  return {
    at,
    label: `每 ${intervalText(sched.intervalMinutes)}（${durationText((at - nowMs) / 60_000)} 后）`,
    mode: 'interval',
  }
}

const nextDailyRun = (sched, d, state) => {
  if (!sched.dailyTimes.length) return null
  const nowMs = d.getTime()
  const out = []
  for (let i = 0; i <= 8; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i)
    const dayKey = dayKeyOfDate(day)
    for (const t of sched.dailyTimes) {
      const m = parseHHMM(t)
      if (m == null) continue
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60).getTime()
      if (at <= nowMs) continue
      if (state?.scheduleRuns?.[`daily:${dayKey}:${t}`]) continue
      if (!isActiveDayAt(sched, new Date(at))) continue
      out.push({ at, t })
    }
    if (out.length) break // 当天的候选一定比后面几天更近
  }
  if (!out.length) return null
  out.sort((a, b) => a.at - b.at)
  const first = out[0]
  return {
    at: first.at,
    label: `每天 ${first.t}（${durationText((first.at - nowMs) / 60_000)} 后）`,
    mode: 'daily',
  }
}

/**
 * 下一轮触发的时刻与文案（概览「下一轮」用；与 dueNow 同一套口径）。
 * 注意：这里**不看 autoDuty**（旧 nextWindowLabel 也不看），调用方自己决定是否用 at。
 * @returns {null | {at:number, label:string, mode:string}}
 */
export function nextRunAt(cfg, now = new Date(), state = {}) {
  const sched = normalizeSchedule(cfg)
  const d = asDate(now)
  if (sched.mode === 'interval') return nextIntervalRun(sched, d, state)
  if (sched.mode === 'daily') return nextDailyRun(sched, d, state)
  return nextWindowsRun(sched, d)
}

/* ───────────────────────── 展示文案 / 状态清理 ───────────────────────── */

/** 排班方式的一句话（概览 duty.scheduleLabel）：`谷时窗口` / `间隔 3 小时` / `每天 12:30` */
export function scheduleLabel(cfg) {
  const sched = normalizeSchedule(cfg)
  if (sched.mode === 'interval') return `间隔 ${intervalText(sched.intervalMinutes)}`
  if (sched.mode === 'daily') {
    return sched.dailyTimes.length ? `每天 ${sched.dailyTimes.join('、')}` : '每天（未设时间）'
  }
  return '谷时窗口'
}

/** slotKey 的时间戳：interval:<epochMin> / daily:YYYY-MM-DD:HH:MM / YYYY-MM-DD:noon */
const slotKeyMs = (key) => {
  if (typeof key !== 'string') return null
  if (key.startsWith('interval:')) {
    const min = Number(key.slice('interval:'.length))
    return Number.isFinite(min) ? min * 60_000 : null
  }
  const date = key.startsWith('daily:') ? key.slice('daily:'.length, 'daily:'.length + 10) : key.slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * 清理 scheduleRuns：只保留最近 14 天、最多 30 项（保留最新的），认不出的键直接丢。
 * 放在这里是因为它是纯函数 —— 调度器只负责把结果写回 state。
 */
export function pruneScheduleRuns(runs, now = new Date(), { days = 14, max = 30 } = {}) {
  const src = runs && typeof runs === 'object' && !Array.isArray(runs) ? runs : {}
  const nowMs = asDate(now).getTime()
  const minMs = nowMs - Math.max(1, Number(days) || 14) * DAY_MS
  const entries = []
  for (const key of Object.keys(src)) {
    if (!src[key]) continue
    const ms = slotKeyMs(key)
    if (ms == null || ms < minMs) continue
    entries.push([key, ms])
  }
  entries.sort((a, b) => a[1] - b[1])
  const keep = entries.slice(-Math.max(1, Number(max) || 30))
  const out = {}
  for (const [key] of keep) out[key] = true
  return out
}
