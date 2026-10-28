/**
 * 发言门控（W7-2）：**打分决定"这条说不说"**，不是再加一道配额。
 *
 * 三条来自外部一手资料的纪律（方案 §8.5 / §6.6）：
 *   1. **配额仍是硬上限**：门控只在配额内收紧，**永不放宽**（麦麦教训：一波消息会抬高预期基数，
 *      导致系统性偏多）；
 *   2. **被 @ / 被回复直接放行且不计分，但仍占配额**；
 *   3. 记账本 `speak-decision {score, features, decision}` ⇒ 控制台能解释"这轮为什么没说"。
 *
 * 权重（§8.5 定值，别改）：
 *   被回复/被@ +1.6 ｜ 评论含问号 +0.5 ｜ 我近 5 条发言占比 −2.6 ｜ log(距上次发言) +0.06
 *   候选新鲜度 +0.1 ｜ 纯媒体/无文本 −1.0 ｜ 截距 −1.2
 *
 * 纯函数、确定性：同一 (candidate, events, now) 必得同一分数（事故可复现）。
 */

export const SPEAK_WEIGHTS = Object.freeze({
  mentioned: 1.6,
  question: 0.5,
  recentShare: -2.6,
  gapLog: 0.06,
  freshness: 0.1,
  mediaOnly: -1.0,
  intercept: -1.2,
})

/**
 * 判定阈值。
 *
 * **这是相对阈值，不是绝对门槛**——按 §8.5 的权重算，一个"典型候选"（没被点名、没问题、
 * 最近 5 个动作里 1 次说话、距上次发言约 1 天、投稿半新鲜）的分数 ≈ **-1.23**：
 *   -1.2（截距） -0.52（占比） +0.44（间距） +0.05（新鲜度） ≈ -1.23
 * 所以门槛定在 **-1.0**：正常候选过线，只有"节奏太密 / 没接话点 / 纯媒体"才被压到线下。
 *
 * 与配额的分工（§6.6）：**配额管总量**（硬上限），**门控管节奏**（只收紧不放宽）。
 * 接入纪律：先以 observe 模式只记 `speak-decision` 不拦，观察 3 天误杀率再决定是否 enforced
 * （与质量门先 warn 三天同一个方法论）。
 */
export const SPEAK_THRESHOLD = -1.0

/** "近 N 条发言占比"的 N（§8.5）。 */
export const RECENT_WINDOW = 5

/** 新鲜度：投稿 24h 内给满分，72h 外衰减到 0。 */
export const FRESH_FULL_HOURS = 24
export const FRESH_ZERO_HOURS = 72

const DAY_MS = 86400_000
const asArr = (v) => (Array.isArray(v) ? v : [])
const msOf = (v) => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Date.parse(String(v ?? ''))
  return Number.isFinite(n) ? n : NaN
}
const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

/** 账本里"我做过决定"的事件类型（决定最近 5 条里评论占多少）。 */
const DECISION_TYPES = new Set(['view', 'comment', 'skip', 'dynamic', 'reply-out', 'like'])

/**
 * 近 N 条决策里，评论/动态占的比例（0..1）。
 * 为什么这么定义：账本只记**我自己的动作**，没有"别人的发言"可比，
 * 所以"自身占比"的正确读法是"我最近几个动作里有多少是说话" —— 越高越像刷屏。
 */
export const recentSpeakShare = (events, window = RECENT_WINDOW) => {
  const list = asArr(events).filter((e) => e && DECISION_TYPES.has(e.type))
  const tail = list.slice(-Math.max(1, window))
  if (!tail.length) return { share: 0, n: 0, spoke: 0 }
  const spoke = tail.filter((e) => e.type === 'comment' || e.type === 'dynamic').length
  return { share: spoke / tail.length, n: tail.length, spoke }
}

/** 距上次发言的分钟数（没有发言记录 ⇒ null，按"很久"处理）。 */
export const minutesSinceLastSpeak = (events, nowMs) => {
  let last = NaN
  for (const e of asArr(events)) {
    if (!e || (e.type !== 'comment' && e.type !== 'dynamic')) continue
    const t = msOf(e.t)
    if (!Number.isFinite(t)) continue
    if (!Number.isFinite(last) || t > last) last = t
  }
  if (!Number.isFinite(last)) return null
  return Math.max(0, (nowMs - last) / 60_000)
}

/** 候选的新鲜度（0..1）：24h 内 1，72h 外 0，中间线性。 */
export const freshnessOf = (candidate, nowMs) => {
  const t = msOf(candidate?.publishedAt ?? candidate?.t)
  if (!Number.isFinite(t)) return 0.5 // 不知道投稿时间就给一半，别把新投稿判死
  const hours = Math.max(0, (nowMs - t) / 3_600_000)
  if (hours <= FRESH_FULL_HOURS) return 1
  if (hours >= FRESH_ZERO_HOURS) return 0
  return 1 - (hours - FRESH_FULL_HOURS) / (FRESH_ZERO_HOURS - FRESH_FULL_HOURS)
}

/** 纯媒体 / 无文本：标题或正文字段都为空，或明确标了 mediaOnly。 */
export const isMediaOnly = (candidate) =>
  candidate?.mediaOnly === true || (!String(candidate?.text ?? '').trim() && !String(candidate?.title ?? '').trim())

/**
 * 打分。
 *
 * @param {object} o
 * @param {object} o.candidate 候选（{bvid, title, text, publishedAt|t, mentioned?, replied?, mediaOnly?}）
 * @param {Array}  [o.events] 账本事件（算"近 5 条占比"与"距上次发言"）
 * @param {Date|number|string} [o.now]
 * @param {number} [o.quotaLeft] 剩余配额（<=0 时无论多少分都不说：**配额是硬上限**）
 * @returns {{score:number, decision:'speak'|'skip'|'forced', reason:string, features:object}}
 */
export const scoreSpeakDecision = ({ candidate = {}, events = [], now = new Date(), quotaLeft = Infinity } = {}) => {
  const nowMs = Number.isFinite(msOf(now)) ? msOf(now) : Date.now()
  const mentioned = candidate.mentioned === true || candidate.replied === true
  const question = /[？?]/.test(String(candidate.text ?? ''))
  const recent = recentSpeakShare(events)
  const gapMin = minutesSinceLastSpeak(events, nowMs)
  const fresh = freshnessOf(candidate, nowMs)
  const mediaOnly = isMediaOnly(candidate)

  const features = {
    mentioned: mentioned ? 1 : 0,
    question: question ? 1 : 0,
    recentShare: round3(recent.share),
    recentWindow: recent.n,
    recentSpoke: recent.spoke,
    gapMinutes: gapMin === null ? null : Math.round(gapMin),
    // log1p(min) 让"1 分钟→1 小时→1 天"的边际收益递减；没有发言记录按 log1p(24h) 上限处理
    gapLog: round3(Math.log1p(gapMin === null ? 1440 : gapMin)),
    freshness: round3(fresh),
    mediaOnly: mediaOnly ? 1 : 0,
  }

  // 配额是硬上限：先判它，比分数优先级高（§6.6 只收紧不放宽）
  const quotaBlocked = Number.isFinite(Number(quotaLeft)) && Number(quotaLeft) <= 0

  const parts = {
    intercept: SPEAK_WEIGHTS.intercept,
    mentioned: features.mentioned * SPEAK_WEIGHTS.mentioned,
    question: features.question * SPEAK_WEIGHTS.question,
    recentShare: features.recentShare * SPEAK_WEIGHTS.recentShare,
    gapLog: features.gapLog * SPEAK_WEIGHTS.gapLog,
    freshness: features.freshness * SPEAK_WEIGHTS.freshness,
    mediaOnly: features.mediaOnly * SPEAK_WEIGHTS.mediaOnly,
  }
  const score = round3(Object.values(parts).reduce((a, b) => a + b, 0))

  // 被 @ / 被回复：直接放行且不计分（但仍占配额）
  if (mentioned && !quotaBlocked) {
    return { score, decision: 'forced', reason: '被@/被回复：直接接，不计分（仍占配额）', features, parts }
  }
  if (quotaBlocked) {
    return { score, decision: 'skip', reason: '配额已用完（配额是硬上限，门控只能收紧）', features, parts }
  }
  if (mediaOnly) {
    return { score, decision: 'skip', reason: '纯媒体/无文本：没话可说', features, parts }
  }
  if (score > SPEAK_THRESHOLD) {
    return { score, decision: 'speak', reason: '有可接的点，且最近的发言节奏不算密', features, parts }
  }
  return { score, decision: 'skip', reason: explainSkip(features), features, parts }
}

/** 为什么不说：优先归因到最负的那一项（控制台直接展示）。 */
const explainSkip = (f) => {
  if (f.recentShare >= 0.6) return `最近 ${f.recentWindow} 个动作里说了 ${f.recentSpoke} 次，太密了，先别刷`
  if (f.gapMinutes !== null && f.gapMinutes < 30) return `刚说过（${f.gapMinutes} 分钟前），这条先放过`
  if (f.mentioned === 0 && f.question === 0) return '没有明确的接话点（不是被点名、也没有可答的问题）'
  return '综合分不够（默认不发言）'
}

/** 一行可读解释（控制台「这轮为什么没说」用）。 */
export const describeSpeakDecision = (d) => {
  if (!d) return ''
  const tag = d.decision === 'forced' ? '必须接' : d.decision === 'speak' ? '可以说' : '不说'
  return `发言门控：${tag}（score ${Number(d.score).toFixed(2)}）—— ${d.reason}`
}

/** 账本事件（§8.5：`speak-decision {score, features, decision}`）。 */
export const speakDecisionEvent = (d, { round = '', t = null } = {}) => {
  if (!d) return null
  return {
    t: t ? String(t) : new Date().toISOString(),
    round: String(round || ''),
    type: 'speak-decision',
    score: Number(d.score) || 0,
    decision: d.decision,
    reason: d.reason,
    features: d.features,
  }
}

/** 供 W7-3/体检用：近 N 天"该说但没说"的占比（越低越健康）。 */
export const skipRateFromLedger = (events, { days = 7, now = new Date() } = {}) => {
  const nowMs = Number.isFinite(msOf(now)) ? msOf(now) : Date.now()
  const since = nowMs - days * DAY_MS
  let total = 0
  let skipped = 0
  for (const e of asArr(events)) {
    if (!e || e.type !== 'speak-decision') continue
    const t = msOf(e.t)
    if (Number.isFinite(t) && t < since) continue
    total++
    if (e.decision === 'skip') skipped++
  }
  return { total, skipped, rate: total ? round3(skipped / total) : 0 }
}
