/**
 * 人设体检（W5-2 / W7-3 的数据面）—— 纯函数，不读盘、不看真实时钟。
 *
 * 口径（方案 §8.2）：取最近 `windowDays` 天内**自己发出去的** `comment` / `dynamic` 事件，
 * 最多 `limit` 条，算五个指标：
 *   - 中位字数（句长分布）
 *   - 每条句号数
 *   - 表情占比（含表情的条数 / 总条数）
 *   - 问号占比
 *   - `card.voice.avoid.*` 命中率（没有卡 / 没有禁用词时恒为 0）
 * 基线是 247 条真人样本的**固定常量**（§8.2 拍板值，别改）：
 *   中位 27 字 / 句号 0.109 每条 / 表情 41.7% / 问号 12.6%。
 *
 * 阈值为什么这样定（稳健优先，宁漏报不误报）：
 *   样本只有 limit（≤20）条，中位数与占比的抖动都不小；体检的价值是「长期形态漂移」，
 *   不是「这一条写得不一样」。所以：
 *   - 中位字数按**倍数**判：>1.55× 或 <0.6× → warn；>2.1× 或 <0.4× → bad。
 *   - 三个占比按**绝对差**判：|Δ| > 0.18~0.22 → warn；|Δ| > 0.4~0.45 → bad。
 *     （问号基线 12.6%，低侧低于 0 不可达 ⇒ 实际是单边阈值，这是正常现象。）
 *   - 禁用词：任何一条命中即为 warn（基数是 0，「命中」本身就是信号）；命中率 ≥20% → bad。
 *   - n < 5 一律 ok + 「数据不足」，不拿 2 条评论下结论。
 */
/** 247 条真人基线（§8.2 拍板值；只读，测试会逐字段锁住）。 */
export const CHECKUP_BASELINE = Object.freeze({
  medianChars: 27,
  periodPerComment: 0.109,
  emojiRatio: 0.417,
  questionRatio: 0.126,
})

/** 少于这个条数不下结论（n<5 只报「数据不足」）。 */
export const CHECKUP_MIN_SAMPLES = 5

/** 阈值表（见文件头注释的定值理由）。ratio 类用绝对差，字数用倍数。 */
export const CHECKUP_THRESHOLDS = Object.freeze({
  medianChars: { warnHigh: 1.55, warnLow: 0.6, badHigh: 2.1, badLow: 0.4 },
  periodPerComment: { warnDelta: 0.18, badDelta: 0.4 },
  emojiRatio: { warnDelta: 0.22, badDelta: 0.45 },
  questionRatio: { warnDelta: 0.18, badDelta: 0.4 },
  avoidHits: { warnRatio: 0, badRatio: 0.2 },
})

const DAY_MS = 86400_000
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u20E3]/u

const asArr = (v) => (Array.isArray(v) ? v : [])
const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000
const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10

/** Date | ms | ISO → ms；无法解析返回 NaN（调用方按「不做时间窗过滤」处理）。 */
const toMs = (v) => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Date.parse(String(v ?? ''))
  return Number.isFinite(n) ? n : NaN
}

const median = (nums) => {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return round1(mid)
}

/** 把卡里的 `voice.avoid.*` 三组词拉平（与 lint.js L7 的字段口径一致）。 */
export const avoidWordsOf = (card) => {
  const avoid = card && card.voice && card.voice.avoid
  if (!avoid || typeof avoid !== 'object') return []
  const out = []
  for (const group of ['aiCues', 'bookish', 'bannedWords']) {
    for (const w of asArr(avoid[group])) {
      const s = String(w == null ? '' : w).trim()
      if (s) out.push(s)
    }
  }
  return out
}

/** 一条文本的字符数（按码点，emoji 算 1 个「字」而不是 2 个）。 */
const charsOf = (text) => Array.from(String(text)).length

const countOf = (text, re) => (String(text).match(re) || []).length

/**
 * 体检主函数。
 * @param {object} o
 * @param {Array} [o.events] 账本事件（只读）
 * @param {Date|number|string} [o.now] 体检基准时刻；缺省/非法 ⇒ 不做时间窗过滤（保持确定性）
 * @param {number} [o.windowDays=14] 时间窗天数
 * @param {number} [o.limit=20] 最多取多少条（近 → 远）
 * @param {object} [o.card] 当前人设卡（只用来取 voice.avoid.*）
 * @returns {{windowDays:number,n:number,metrics:object,baseline:object,verdict:{level:string,reasons:string[]},samples:Array}}
 */
export function buildCheckup(o = {}) {
  const windowDays = Number.isFinite(Number(o.windowDays)) && Number(o.windowDays) >= 0
    ? Number(o.windowDays) : 14
  const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0
    ? Math.floor(Number(o.limit)) : 20
  const nowMs = toMs(o.now)
  const since = Number.isFinite(nowMs) ? nowMs - windowDays * DAY_MS : null
  const avoidWords = avoidWordsOf(o.card)

  // ① 自己的发言（comment 顺带 dynamic；空文本不算，不算样本量）
  const picked = []
  let order = 0
  for (const e of asArr(o.events)) {
    if (!e || (e.type !== 'comment' && e.type !== 'dynamic')) continue
    const text = typeof e.text === 'string' ? e.text : ''
    if (!text.trim()) continue
    const t = String(e.t || '')
    const ms = toMs(t)
    if (since !== null && (!Number.isFinite(ms) || ms < since)) continue
    picked.push({
      bvid: String(e.bvid || ''),
      text,
      t,
      ms: Number.isFinite(ms) ? ms : 0,
      order: order++,
    })
  }
  // 近 → 远；同一时刻按账本顺序倒序（后写的更新），保证可复现
  picked.sort((a, b) => (b.ms - a.ms) || (b.order - a.order))
  const selected = picked.slice(0, limit)

  const n = selected.length
  const charList = selected.map((x) => charsOf(x.text))
  const periodPer = selected.map((x) => countOf(x.text, /。/g))
  const emojiHits = selected.filter((x) => EMOJI_RE.test(x.text)).length
  const questionHits = selected.filter((x) => /[？?]/.test(x.text)).length
  const avoidHits = avoidWords.length
    ? selected.filter((x) => avoidWords.some((w) => x.text.includes(w))).length
    : 0

  const metrics = {
    medianChars: n ? median(charList) : 0,
    periodPerComment: n ? round3(periodPer.reduce((a, b) => a + b, 0) / n) : 0,
    emojiRatio: n ? round3(emojiHits / n) : 0,
    questionRatio: n ? round3(questionHits / n) : 0,
    avoidHits: n ? round3(avoidHits / n) : 0,
  }

  const samples = selected.map((x) => ({ bvid: x.bvid, text: x.text, t: x.t }))
  return {
    windowDays,
    n,
    metrics,
    baseline: { ...CHECKUP_BASELINE },
    verdict: verdictOf(n, metrics, avoidHits),
    samples,
  }
}

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`
const signPct = (x) => {
  const v = Math.round((Number(x) || 0) * 100)
  return `${v > 0 ? '+' : ''}${v}%`
}

/** 偏离判定：level 只升不降（bad 吞掉 warn），每条偏离都给一句人话原因。 */
function verdictOf(n, metrics, avoidHitCount) {
  if (n < CHECKUP_MIN_SAMPLES) {
    return { level: 'ok', reasons: [`数据不足（最近 ${n} 条，至少 ${CHECKUP_MIN_SAMPLES} 条才体检）`] }
  }
  const reasons = []
  let level = 'ok'
  const raise = (l) => {
    if (l === 'bad') level = 'bad'
    else if (level !== 'bad') level = 'warn'
  }
  const b = CHECKUP_BASELINE

  // ① 中位字数：倍数偏离（双侧）
  {
    const th = CHECKUP_THRESHOLDS.medianChars
    const m = metrics.medianChars
    const ratio = b.medianChars ? m / b.medianChars : 1
    if (ratio > th.badHigh || ratio < th.badLow) {
      raise('bad')
      reasons.push(`中位字数 ${m}（基线 ${b.medianChars}，${signPct(ratio - 1)}，已严重偏离）`)
    } else if (ratio > th.warnHigh || ratio < th.warnLow) {
      raise('warn')
      reasons.push(`中位字数 ${m}（基线 ${b.medianChars}，${signPct(ratio - 1)}）`)
    }
  }

  // ② 句号/条：绝对差（只会偏高：基线 0.109，低侧不可达）
  {
    const th = CHECKUP_THRESHOLDS.periodPerComment
    const m = metrics.periodPerComment
    const d = m - b.periodPerComment
    if (Math.abs(d) > th.badDelta) {
      raise('bad')
      reasons.push(`每条句号 ${m}（基线 ${b.periodPerComment}，偏多 ${round1(d)}）`)
    } else if (Math.abs(d) > th.warnDelta) {
      raise('warn')
      reasons.push(`每条句号 ${m}（基线 ${b.periodPerComment}，偏多 ${round1(d)}）`)
    }
  }

  // ③ 表情占比：绝对差（双侧）
  {
    const th = CHECKUP_THRESHOLDS.emojiRatio
    const m = metrics.emojiRatio
    const d = m - b.emojiRatio
    if (Math.abs(d) > th.badDelta) {
      raise('bad')
      reasons.push(`表情占比 ${pct(m)}（基线 ${pct(b.emojiRatio)}，偏离 ${signPct(d)}）`)
    } else if (Math.abs(d) > th.warnDelta) {
      raise('warn')
      reasons.push(`表情占比 ${pct(m)}（基线 ${pct(b.emojiRatio)}，偏离 ${signPct(d)}）`)
    }
  }

  // ④ 问号占比：绝对差（低侧低于 0 不可达 ⇒ 实际单边）
  {
    const th = CHECKUP_THRESHOLDS.questionRatio
    const m = metrics.questionRatio
    const d = m - b.questionRatio
    if (Math.abs(d) > th.badDelta) {
      raise('bad')
      reasons.push(`问号占比 ${pct(m)}（基线 ${pct(b.questionRatio)}，偏离 ${signPct(d)}）`)
    } else if (Math.abs(d) > th.warnDelta) {
      raise('warn')
      reasons.push(`问号占比 ${pct(m)}（基线 ${pct(b.questionRatio)}，偏离 ${signPct(d)}）`)
    }
  }

  // ⑤ 禁用词：基数 0，任何命中都是信号；命中率 ≥20% 判 bad
  {
    const th = CHECKUP_THRESHOLDS.avoidHits
    const m = metrics.avoidHits
    if (m > th.badRatio) {
      raise('bad')
      reasons.push(`禁用词命中 ${avoidHitCount}/${n} 条（${pct(m)}）`)
    } else if (m > th.warnRatio) {
      raise('warn')
      reasons.push(`禁用词命中 ${avoidHitCount}/${n} 条（${pct(m)}）`)
    }
  }

  return { level, reasons }
}
