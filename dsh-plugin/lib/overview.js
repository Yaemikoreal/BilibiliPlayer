/**
 * 概览信封（纯函数）。设计定稿：docs/analysis/2026-10-28-design-v4.md §2.1
 *
 * 过去这段逻辑在 index.js 里直接读全局（effCfg / dshCliCached / 全局 running），
 * 既没法单测，也没法把「运行中的真实进度」拼进来。现在：
 * - 所有输入注入（cfg/state/events/liveSnap/account/health/now）；
 * - round.stats/phase 直接取 live 快照 ⇒ 运行中不再依赖「轮末才写账本」的配额；
 * - round.lastRound 由账本按 roundId 聚合 ⇒ 不再出现「新开始时间 + 上一轮退出码」。
 */
import { dayKeyOf } from './activity.js'
import { roundAccounting, lastRoundFrom, presenceFrom } from './round.js'

const DAY_MS = 86400_000

const WINDOWS = {
  noon: { start: 12 * 60, end: 14 * 60, label: '中午 12:00' },
  night: { start: 18 * 60, end: 33 * 60, label: '晚间 18:00' },
}

// 与调度器同一套「跨午夜」口径：午夜前 12 小时内归前一天，方便窗口比较
const minsOf = (d) => {
  const m = d.getHours() * 60 + d.getMinutes()
  return m < 12 * 60 ? m + 24 * 60 : m
}

export const nextWindow = (cfg, now = new Date()) => {
  const x = minsOf(now)
  const out = []
  for (const [key, w] of Object.entries(WINDOWS)) {
    if (!cfg?.[key]) continue
    if (x >= w.start && x < w.end) continue // 已在窗口内：调度器此刻会触发，没有「下一轮」
    const deltaMin = ((w.start - x) + 2880) % 1440
    out.push({ key, label: w.label, at: now.getTime() + deltaMin * 60_000, deltaMin })
  }
  out.sort((a, b) => a.at - b.at)
  return out[0] || null
}

export const nextWindowLabel = (cfg, now = new Date()) => {
  const w = nextWindow(cfg, now)
  if (!w) return '—'
  const h = Math.floor(w.deltaMin / 60)
  const m = w.deltaMin % 60
  return `${w.label}（${h}h${String(m).padStart(2, '0')}m 后）`
}

/** 概览默认窗口：daily / presence / perRound 只在「近 N 天」子集上算（W4-2b） */
export const DEFAULT_WINDOW_DAYS = 14

const toMs = (iso) => {
  const ms = Date.parse(String(iso ?? ''))
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 窗口子集（W4-2b）：把「近 N 天」的事件切出来，后续聚合都在子集上跑。
 *
 * 为什么能只做一遍：`readEvents` / `ledgerReader` 返回的数组**按 t 升序**（ledger.js 的 sortEvents），
 * 所以按 ISO 字符串比较即可（字符串序 = 时间序），遇到超出上界就能提前 break。
 * 为什么留 1~2 天余量：账本里的 `t` 混着 `…+08:00` 与 `…Z` 两种写法，纯字符串比较在时区/格式
 * 边界上最多差 14h，留一天余量保证「真在窗口里的事件一定被收进子集」。**这里只做粗筛（超集）**，
 * 精确口径（本地日、7 天存在感）仍由下游 dayKeyOf / presenceFrom 负责，所以多收几条不会算错。
 *
 * @param {Array} events 按 t 升序的账本事件
 * @param {Date|number} [now]
 * @param {number} [windowDays] `<=0` 表示不切窗口（全量旧语义；对拍与排障用）
 */
export const windowPool = (events, now = new Date(), windowDays = DEFAULT_WINDOW_DAYS) => {
  const list = Array.isArray(events) ? events : []
  const days = Number(windowDays)
  if (!Number.isFinite(days) || days <= 0) return list
  const nowMs = now instanceof Date ? now.getTime() : (Number(now) || Date.now())
  const lower = new Date(nowMs - (days + 1) * DAY_MS).toISOString()
  const upper = new Date(nowMs + 2 * DAY_MS).toISOString()
  const out = []
  for (const e of list) {
    const t = typeof e?.t === 'string' ? e.t : ''
    // 没有 t 的事件不参与时间窗口：保留（与旧的全量路径一致，别因为窗口把它们丢掉）
    if (!t) { out.push(e); continue }
    if (t < lower) continue
    if (t > upper) break
    out.push(e)
  }
  return out
}

/** 本地日的 [起, 止) 毫秒区间；day 不是 `YYYY-MM-DD` 时返回 null（调用方退回旧口径）。 */
const localDayRange = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''))
  if (!m) return null
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1) // setDate 处理跨月/夏令时，比 +86400_000 稳
  return [start.getTime(), end.getTime()]
}

/**
 * ISO 字符串前 10 位 → YYYYMMDD 数字键（不做 Date 解析；格式不符返回 0）。
 * 为什么需要：countToday 只要「本地今天」那几条，但 10 万行里 99% 用 Date.parse 是白花钱。
 * 先按 UTC 日期粗筛（35ns/条）再对候选做精确判定，语义仍由本地日毫秒区间负责。
 */
const ymdNum = (s) => {
  if (typeof s !== 'string' || s.length < 10) return 0
  let n = 0
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i)
    if (i === 4 || i === 7) { if (c !== 45) return 0; continue }
    if (c < 48 || c > 57) return 0
    n = n * 10 + (c - 48)
  }
  return n
}

/** 本地日 [from,to) 覆盖到的 UTC 日期集合（精确两个：区间首毫秒与末毫秒所在 UTC 日）。 */
const ymdCandidates = (from, to) => {
  const a = ymdNum(new Date(from).toISOString())
  const b = ymdNum(new Date(to - 1).toISOString())
  return a === b ? [a] : [a, b]
}

/**
 * 今日计数。W4-2b：用「本地日毫秒区间」代替逐条 `dayKeyOf`（后者要构造 Date + 拼字符串，
 * 10 万条实测 32ms）；再叠一层 UTC 日期粗筛，只对候选条目做 Date.parse。
 * 语义与旧实现逐字段一致：只算「本地日 == day」的事件；非法/缺失 t 不计。
 */
export const countToday = (events, day) => {
  const acc = {
    picked: 0, comments: 0, likes: 0, dynamics: 0,
    replies: 0, repliesProactive: 0, replyScans: 0, proactiveSkipped: 0,
  }
  const list = Array.isArray(events) ? events : []
  const range = localDayRange(day)
  if (!range) {
    // 兜底：非标准 day（测试/异常调用）仍按旧口径逐条比较日键，绝不静默算成 0
    for (const e of list) {
      if (!e || dayKeyOf(e.t) !== day) continue
      addOne(acc, e)
    }
    return acc
  }
  const [from, to] = range
  const cands = ymdCandidates(from, to)
  for (const e of list) {
    if (!e) continue
    const t = e.t
    const y = ymdNum(t)
    // 非 ISO 头或 UTC 日期不在候选日内 ⇒ 不可能是本地今天（省一次 Date.parse）
    if (y && !cands.includes(y)) continue
    const ms = toMs(t)
    if (!(ms >= from && ms < to)) continue
    addOne(acc, e)
  }
  return acc
}

const addOne = (acc, e) => {
  if (e.type === 'view') acc.picked += 1
  else if (e.type === 'comment') acc.comments += 1
  else if (e.type === 'like') acc.likes += 1
  else if (e.type === 'dynamic') acc.dynamics += 1
  else if (e.type === 'reply-out') {
    acc.replies += 1
    if (e.kind === 'proactive') acc.repliesProactive += 1
  } else if (e.type === 'reply-scan') {
    acc.replyScans += 1
    if (e.decision === 'skipped') acc.proactiveSkipped += 1
  }
}

/** 待回复条数：一次收集 + 一次判定（旧实现是两次全量 filter，10 万条要多扫一遍）。 */
const pendingReplyCount = (events) => {
  const answered = new Set()
  const asked = []
  for (const e of events) {
    if (!e) continue
    if (e.type === 'reply-out') answered.add(e.parent)
    else if (e.type === 'reply-in' && e.rpid) asked.push(e.rpid)
  }
  let n = 0
  for (const rpid of asked) if (!answered.has(rpid)) n += 1
  return n
}

/**
 * @param {object} o
 * @param {object} o.cfg 生效配置
 * @param {object} o.state state.json
 * @param {Array} o.events 账本事件
 * @param {object} [o.liveSnap] lib/live snapshot（running/roundId/startedAt/elapsedMs/phase/stats）
 * @param {object|null} [o.account] 账号缓存（含 checkedAt/stale）
 * @param {object} [o.health] { cli, cliCheckedAt, cred, routeOk }
 * @param {object} [o.presence] 已算好的存在感（不传则内部算）
 * @param {number} [o.windowDays] 「近 N 天」窗口（默认 {@link DEFAULT_WINDOW_DAYS}；`<=0` = 全量旧口径）
 * @param {Date} [o.now]
 */
export function buildOverview(o = {}) {
  const cfg = o.cfg || {}
  const state = o.state || {}
  const events = Array.isArray(o.events) ? o.events : []
  const live = o.liveSnap || null
  const now = o.now instanceof Date ? o.now : new Date()
  const day = dayKeyOf(now.toISOString())
  const scanSince = Number(state.replyScanSince) || 0
  // ⭐ W4-2b：先切「近 N 天」子集（一次 O(n) 粗筛，排序数组可提前 break），
  //    随后 daily / presence / perRound / inbox 全部只在子集上算 —— 10 万行账本不再每帧全量扫。
  //    `windowDays<=0` 走全量（旧语义），供对拍与排障。
  const windowDays = o.windowDays === undefined ? DEFAULT_WINDOW_DAYS : Number(o.windowDays)
  const pool = windowPool(events, now, windowDays)
  // 存在感只要 7 天：从 pool 再切一次（纯字符串比较，单遍）⇒ presenceFrom 不必为 14 天窗口埋单。
  // 窗口本身是超集（多留余量），精确的 7 天判定仍在 presenceFrom 里做。
  const presencePool = windowDays > 7 ? windowPool(pool, now, 7) : pool

  const daily = countToday(pool, day)
  const running = !!live?.running
  const roundId = live?.roundId || null

  // 本轮口径：运行中按当前轮，空闲按上一轮（都从账本算，口径一致）
  const currentAcc = roundId ? roundAccounting(pool, roundId, { scanSince }) : null
  const lastRound = lastRoundFrom(pool, { scanSince })
  const perRound = currentAcc
    ? {
        roundId,
        picked: currentAcc.counts.views,
        comments: currentAcc.counts.comments,
        likes: currentAcc.counts.likes,
        dynamics: currentAcc.counts.dynamics,
        proactive: currentAcc.counts.proactive,
        scans: currentAcc.counts.scans,
        replies: currentAcc.counts.replies,
        personaTag: currentAcc.personaTag || '',
      }
    : lastRound
      ? {
          roundId: lastRound.roundId,
          picked: lastRound.counts.views,
          comments: lastRound.counts.comments,
          likes: lastRound.counts.likes,
          dynamics: lastRound.counts.dynamics,
          proactive: lastRound.counts.proactive,
          scans: lastRound.counts.scans,
          replies: lastRound.counts.replies,
          personaTag: lastRound.personaTag || '',
        }
      : { roundId: null, picked: 0, comments: 0, likes: 0, dynamics: 0, proactive: 0, scans: 0, replies: 0, personaTag: '' }

  const win = nextWindow(cfg, now)
  const presence = o.presence || presenceFrom(presencePool, { now: now.getTime() })
  const pendingReply = pendingReplyCount(pool)

  return {
    ok: true,
    account: o.account ?? null,
    duty: {
      autoDuty: !!cfg.autoDuty,
      windows: { noon: !!cfg.noon, night: !!cfg.night },
      nextWindowLabel: nextWindowLabel(cfg, now),
      nextRunAt: cfg.autoDuty && win ? win.at : null,
    },
    quota: {
      ...daily,
      limits: {
        perDay: cfg.perDay, commentsPerDay: cfg.commentsPerDay,
        likesPerDay: cfg.likesPerDay, dynamicsPerDay: cfg.dynamicsPerDay,
        repliesPerRound: cfg.repliesPerRound,
        replyOthersPerRound: cfg.replyOthersPerRound,
      },
      perRound,
      updatedAt: now.toISOString(),
    },
    round: {
      running,
      roundId,
      // W2-1：这轮实际注入的人设版本（控制台页头 / 人设页「本轮实际注入」都读它）
      personaTag: perRound.personaTag || '',
      personaInject: currentAcc?.personaInject || lastRound?.personaInject || null,
      startedAt: running ? String(live?.startedAt || state.lastRunStartedAt || '') : String(state.lastRunStartedAt || ''),
      elapsedMs: running ? Number(live?.elapsedMs) || 0 : 0,
      phase: live?.phase || { key: 'think', label: '思考' },
      stats: live?.stats || { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0, proactive: 0, scan: 0 }, errors: 0 },
      lastRunAt: state.lastRunAt || '',
      lastWhy: state.lastWhy || '',
      lastCode: state.lastCode ?? null,
      lastDurationMs: state.lastDurationMs ?? null,
      lastRound,
      nextRunAt: cfg.autoDuty && win ? win.at : null,
      nextWindowLabel: nextWindowLabel(cfg, now),
      scanSince,
    },
    inbox: {
      pendingReply,
      lastPollAt: state.lastReplyPollAt || '',
      lastPollOk: state.lastReplyPollOk !== false,
    },
    presence,
    health: o.health || { cli: '', cliCheckedAt: '', cred: false, routeOk: false },
    model: cfg.modelProvider && cfg.modelName
      ? { mode: 'config', provider: cfg.modelProvider, model: cfg.modelName }
      : { mode: 'default', provider: '', model: '' },
    home: o.home || '',
    ledgerFile: o.ledgerFile || '',
  }
}

/** 供 /stream 的 tick 帧用：只回「会变的那几个数」 */
export function overviewTick(o = {}) {
  const live = o.liveSnap || {}
  const now = o.now instanceof Date ? o.now : new Date()
  const acc = o.events ? countToday(o.events, dayKeyOf(now.toISOString())) : null
  return {
    round: {
      running: !!live.running,
      roundId: live.roundId ?? null,
      elapsedMs: Number(live.elapsedMs) || 0,
      phase: live.phase || { key: 'think', label: '思考' },
      stats: live.stats || { events: 0, tools: {}, actions: {}, errors: 0 },
    },
    quota: acc ? { perRound: null, today: acc } : { perRound: null },
  }
}

export { DAY_MS }
