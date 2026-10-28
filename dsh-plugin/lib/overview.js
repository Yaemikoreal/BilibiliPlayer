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

const countToday = (events, day) => {
  const acc = {
    picked: 0, comments: 0, likes: 0, dynamics: 0,
    replies: 0, repliesProactive: 0, replyScans: 0, proactiveSkipped: 0,
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || dayKeyOf(e.t) !== day) continue
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
  return acc
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

  const daily = countToday(events, day)
  const running = !!live?.running
  const roundId = live?.roundId || null

  // 本轮口径：运行中按当前轮，空闲按上一轮（都从账本算，口径一致）
  const currentAcc = roundId ? roundAccounting(events, roundId, { scanSince }) : null
  const lastRound = lastRoundFrom(events, { scanSince })
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
  const presence = o.presence || presenceFrom(events, { now: now.getTime() })
  const pendingReply = (() => {
    const answered = new Set(events.filter((e) => e.type === 'reply-out').map((e) => e.parent))
    return events.filter((e) => e.type === 'reply-in' && e.rpid && !answered.has(e.rpid)).length
  })()

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
