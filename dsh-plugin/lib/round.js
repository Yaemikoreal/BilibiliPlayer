/**
 * 轮次与存在感聚合（纯函数，不碰 IO）。设计定稿：docs/analysis/2026-10-28-design-v4.md §2.1/§3.3
 *
 * 为什么单独成文件：
 * - 轮次「做了什么」过去只存在 state.json 的一对字段里（开始时间与上一轮退出码混写），
 *   导致概览显示「新开始时间 + 旧结果」；这里改成**按 roundId 从账本聚合**，账本才是事实来源。
 * - 接话扫描是否发生，也必须能从账本算出来（proactiveMissing），否则「没接」和「没想」分不清。
 */
import { dayKeyOf } from './activity.js'

const DAY_MS = 86400_000

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

const timeOf = (e) => {
  const t = Date.parse(String(e?.t || ''))
  return Number.isFinite(t) ? t : 0
}

const roundStartOf = (roundId) => {
  const t = Date.parse(String(roundId || ''))
  return Number.isFinite(t) ? t : 0
}

/**
 * 单轮账本盘点。
 * @param {Array} events 全量账本事件
 * @param {string} roundId 轮次 id（宿主 spawn 时刻 ISO）
 * @param {{scanSince?:number}} opts scanSince = 该版本部署时刻；早于它的历史轮次不判「未扫描」
 */
export function roundAccounting(events, roundId, opts = {}) {
  const scanSince = Number(opts.scanSince) || 0
  const mine = (Array.isArray(events) ? events : []).filter((e) => e && e.round === roundId)
  const counts = {
    views: 0, likes: 0, comments: 0, replies: 0, proactive: 0,
    dynamics: 0, skips: 0, scans: 0, scanSkips: 0,
  }
  let endedAt = ''
  let code = null
  let durationMs = null
  let startedAt = ''
  for (const e of mine) {
    const t = String(e.t || '')
    if (t && (!startedAt || t < startedAt)) startedAt = t
    if (e.type === 'view') counts.views += 1
    else if (e.type === 'like') counts.likes += 1
    else if (e.type === 'comment') counts.comments += 1
    else if (e.type === 'dynamic') counts.dynamics += 1
    else if (e.type === 'skip') counts.skips += 1
    else if (e.type === 'reply-out') {
      if (e.kind === 'proactive') counts.proactive += 1
      else counts.replies += 1
    } else if (e.type === 'reply-scan') {
      counts.scans += 1
      if (e.decision === 'skipped') counts.scanSkips += 1
    } else if (e.type === 'round-end') {
      endedAt = t
      code = e.code ?? null
      durationMs = e.durationMs ?? null
    }
  }
  const startMs = roundStartOf(roundId) || Date.parse(startedAt) || 0
  // 只有在「真读过内容」（有 view）时才要求扫描——整轮只发动态/什么都拉不到的不算违规
  const missing = counts.views > 0 && counts.scans === 0 && counts.proactive === 0
  const judged = startMs >= scanSince
  const proactiveMissing = missing && judged
  const reason = counts.proactive > 0 ? 'posted'
    : counts.scans > 0 ? 'scan-but-skip'
      : counts.views > 0 ? 'no-scan' : 'no-content'
  return {
    roundId,
    counts,
    startedAt,
    endedAt,
    code,
    durationMs,
    startMs,
    proactiveMissing,
    proactiveJudged: judged,
    reason,
  }
}

/** 最近一轮（按 round-end 时间，其次按 round id）。没有任何轮次返回 null。 */
export function lastRoundFrom(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const ids = []
  const seen = new Set()
  for (const e of list) {
    if (!e || !e.round || typeof e.round !== 'string') continue
    if (seen.has(e.round)) continue
    seen.add(e.round)
    ids.push(e.round)
  }
  if (!ids.length) return null
  const scored = ids.map((id) => {
    const acc = roundAccounting(list, id, opts)
    const endMs = Date.parse(acc.endedAt) || 0
    const startMs = acc.startMs || 0
    return { acc, sort: endMs || startMs }
  })
  scored.sort((a, b) => b.sort - a.sort)
  const best = scored[0].acc
  return {
    roundId: best.roundId,
    startedAt: best.startedAt || (best.startMs ? new Date(best.startMs).toISOString() : ''),
    endedAt: best.endedAt,
    code: best.code,
    durationMs: best.durationMs,
    counts: best.counts,
    proactiveMissing: best.proactiveMissing,
  }
}

/**
 * 存在感（近 7 天，按「本地日」口径，与账本判定同源）。
 * ⚠️ like-in 至今没有任何写入方（B站接口不给我方点赞通知）⇒ likesAvailable:false，
 *    页面应显示「暂不统计」而不是一个永远 0 的假数字。
 */
export function presenceFrom(events, opts = {}) {
  const now = opts.now ?? Date.now()
  const days = Math.max(1, Number(opts.days) || 7)
  const cutoff = now - days * DAY_MS
  const list = Array.isArray(events) ? events.filter((e) => e && e.type) : []
  const inWindow = (e) => {
    const t = timeOf(e)
    return t >= cutoff && t <= now + DAY_MS
  }
  const replies = list.filter((e) => e.type === 'reply-in' && inWindow(e))
  const likes = list.filter((e) => e.type === 'like-in' && inWindow(e))
  const comments = list.filter((e) => e.type === 'comment' && inWindow(e))
  const byDay = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKeyOf(new Date(now - i * DAY_MS).toISOString())
    byDay.set(d, 0)
  }
  for (const e of [...replies, ...comments]) {
    const d = dayKeyOf(e.t)
    if (byDay.has(d)) byDay.set(d, byDay.get(d) + 1)
  }
  const latestComment = [...comments].sort((a, b) => timeOf(b) - timeOf(a))[0] || null
  return {
    available: true,
    likesAvailable: false,
    likes7d: likes.length,
    replies7d: replies.length,
    comments7d: comments.length,
    trend: [...byDay.entries()].map(([date, count]) => ({ date, count })),
    latest: latestComment
      ? { text: String(latestComment.text || ''), bvid: String(latestComment.bvid || ''), t: String(latestComment.t || '') }
      : null,
    note: 'B站没有「收到的赞」通知接口，收赞一栏暂不统计；被回复与发出的评论来自账本。',
  }
}
