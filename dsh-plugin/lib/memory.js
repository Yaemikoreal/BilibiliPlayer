/**
 * 记忆（W7-1）：账本事件的**聚合视图**，不造第二套库（设计 §8.4）。
 *
 * 为什么不做向量库：
 *   1. 换 embedding 必须重建、且检索结果不可复现，与 `deriveState` 的"同一输入必得同一输出"哲学冲突；
 *   2. 单人号体量下，"关键词 + 时间窗 + 重要度"已经够用，且能被单测钉住。
 *
 * 三条纪律：
 *   - **事实源不变**：账本就是唯一来源，记忆只是它的一个投影；
 *   - **幂等**：条目 id = `bv`，同一 BV 的证据只累加不新建（external_id 幂等的等价物）；
 *   - **会衰减**：重要度按 **7 天半衰期** 衰减（麦麦用 24h 是群聊节奏；B 站内容寿命以天/周计）。
 *
 * 纯函数：同一 (events, now) 必得同一结果。
 */
import { charLen } from './persona/text.js'

/** 半衰期（天）：7 天前的证据权重减半。设计 §8.4 拍板值，别随意改。 */
export const MEMORY_HALF_LIFE_DAYS = 7

/** 重要度权重（**累加**后参与衰减）。 */
export const MEMORY_WEIGHTS = Object.freeze({
  replied: 3,   // 有人回了我（最该记住：这段对话还没完）
  liked: 2,     // 我的评论被赞 >5
  commented: 1, // 我评过（哪怕没人回）
  viewed: 0,    // 只是看过
})

/** 候选池时间窗（天）：比半衰期长，保证"衰减但没死"的条目还在池子里。 */
export const MEMORY_WINDOW_DAYS = 30

/** 注入上限（设计 §8.4：≤3 条 ≤600 字；C2 通道先用 ≤2 条 ≤300 字）。 */
export const MEMORY_MAX_ENTRIES = 3
export const MEMORY_MAX_CHARS = 600
export const MEMORY_C2_ENTRIES = 2
export const MEMORY_C2_CHARS = 300

const DAY_MS = 86400_000
const timeOf = (e) => {
  const t = Date.parse(String(e?.t || ''))
  return Number.isFinite(t) ? t : 0
}
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return charLen(t) > n ? t.slice(0, n) + '…' : t
}

/**
 * 从账本事件聚合记忆候选。
 *
 * @param {object} opts
 * @param {Array} [opts.events] 账本事件（任意顺序，内部按时间判断）
 * @param {Date}  [opts.now]
 * @param {number} [opts.days] 候选池时间窗（天），默认 30
 * @param {string[]} [opts.keywords] 相关性关键词（给了就只在相关时返回，见 `relevant`）
 * @param {number} [opts.max] 最多返回几条（默认 3）
 * @returns {{entries:Array, pool:number, note:string}}
 *   entries[i] = {id, bv, title, up, myText, replies, likes, at, importance, decayed, ageDays, viewed}
 */
export const buildMemory = ({
  events = [], now = new Date(), days = MEMORY_WINDOW_DAYS, keywords = [], max = MEMORY_MAX_ENTRIES,
} = {}) => {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const cutoff = nowMs - Math.max(1, Number(days) || MEMORY_WINDOW_DAYS) * DAY_MS
  const list = Array.isArray(events) ? events : []

  /** bv → 聚合证据 */
  const pool = new Map()
  const ensure = (bv) => {
    if (!bv) return null
    let m = pool.get(bv)
    if (!m) {
      m = {
        id: bv, bv, title: '', up: '', myText: '', replies: 0, likes: 0,
        at: '', lastMs: 0, viewed: false, commented: false,
      }
      pool.set(bv, m)
    }
    return m
  }
  const touch = (m, e) => {
    const t = timeOf(e)
    if (!t) return
    if (t > m.lastMs) {
      m.lastMs = t
      m.at = String(e.t || '')
    }
  }

  // 我自己的评论 rpid → bv：判定"被回复"要能对上楼层
  const myRpidBv = new Map()

  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const t = timeOf(e)
    if (t && t < cutoff) continue
    const bv = String(e.bvid || '')
    if (e.type === 'view') {
      const m = ensure(bv)
      if (!m) continue
      m.viewed = true
      if (e.title) m.title = String(e.title)
      if (e.up || e.uname) m.up = String(e.up || e.uname)
      touch(m, e)
    } else if (e.type === 'comment') {
      const m = ensure(bv)
      if (!m) continue
      m.commented = true
      if (!m.myText) m.myText = String(e.text || '')
      if (Number(e.likes) > m.likes) m.likes = Number(e.likes) || 0
      if (e.rpid != null) myRpidBv.set(String(e.rpid), bv)
      if (e.title) m.title = m.title || String(e.title)
      touch(m, e)
    } else if (e.type === 'like') {
      const m = ensure(bv)
      if (!m) continue
      touch(m, e)
    } else if (e.type === 'reply-in') {
      // 优先按"回复的是我的哪条评论"定位；对不上再按 bvid 兜底（对方在同一视频下回我）
      const parent = e.parent != null ? String(e.parent) : ''
      const target = (parent && myRpidBv.get(parent)) || bv
      const m = ensure(target)
      if (!m) continue
      m.replies += 1
      touch(m, e)
    }
  }

  const entries = []
  for (const m of pool.values()) {
    const ageDays = m.lastMs ? Math.max(0, (nowMs - m.lastMs) / DAY_MS) : Infinity
    let importance = MEMORY_WEIGHTS.viewed
    if (m.viewed) importance += MEMORY_WEIGHTS.viewed
    if (m.commented) importance += MEMORY_WEIGHTS.commented
    if (m.likes > 5) importance += MEMORY_WEIGHTS.liked
    if (m.replies > 0) importance += MEMORY_WEIGHTS.replied
    const decayed = Number.isFinite(ageDays)
      ? importance * Math.pow(0.5, ageDays / MEMORY_HALF_LIFE_DAYS)
      : 0
    entries.push({
      id: m.id, bv: m.bv, title: m.title, up: m.up, myText: m.myText,
      replies: m.replies, likes: m.likes, at: m.at,
      importance, decayed: Math.round(decayed * 1000) / 1000, ageDays: Number.isFinite(ageDays) ? Math.round(ageDays * 10) / 10 : null,
      viewed: m.viewed,
    })
  }

  // 排序：衰减后的重要度 → 越新越前（同分时按时间倒序）
  entries.sort((a, b) => (b.decayed - a.decayed) || String(b.at).localeCompare(String(a.at)))

  // 只留"值得记"的：仅看过（importance===0）不进记忆池
  const worth = entries.filter((e) => e.importance > 0)
  const cap = Math.max(0, Number(max) || MEMORY_MAX_ENTRIES)
  return {
    entries: worth.slice(0, cap),
    pool: worth.length,
    note: worth.length
      ? `记忆池 ${worth.length} 条（半衰期 ${MEMORY_HALF_LIFE_DAYS} 天），本轮注入 ${Math.min(cap, worth.length)} 条`
      : '记忆池还是空的（还没评过 / 没人回过）',
  }
}

/**
 * 相关性过滤（设计 §8.4：≤3 条、与当前 UP/关键词相关时才注入）。
 * 关键词用**子串**匹配（中文没有词边界，与 W6-1 的见闻匹配同一纪律）。
 */
export const filterMemoryRelevant = (entries, { keywords = [], up = '' } = {}) => {
  const list = Array.isArray(entries) ? entries : []
  const kws = (Array.isArray(keywords) ? keywords : []).map((k) => String(k ?? '').trim().toLowerCase()).filter(Boolean)
  if (!kws.length && !up) return list
  const upNeedle = String(up || '').trim().toLowerCase()
  return list.filter((e) => {
    if (upNeedle && String(e.up || '').toLowerCase().includes(upNeedle)) return true
    const hay = `${e.title || ''}\u0000${e.myText || ''}`.toLowerCase()
    return kws.some((k) => hay.includes(k))
  })
}

/**
 * 渲染成 C2 里的一段人话（≤2 条 ≤300 字 / ≤3 条 ≤600 字，超了截断）。
 *
 * 位置纪律：记忆放 C2（整轮末尾），因为它是"状态"不是"身份"——放到 C1 会让每步都在付 token。
 */
export const renderMemory = (entries, { max = MEMORY_C2_ENTRIES, maxChars = MEMORY_C2_CHARS } = {}) => {
  const list = (Array.isArray(entries) ? entries : []).slice(0, Math.max(0, Number(max) || 0))
  if (!list.length) return ''
  const lines = ['记得的事（只在相关时提，别重复讲；讲过的别再讲）：']
  for (const e of list) {
    const what = clip(e.title || e.bv, 26)
    const mine = e.myText ? clip(e.myText, 22) : ''
    const tail = e.replies > 0 ? `有人回过我${e.replies}次` : e.likes > 5 ? `被赞了${e.likes}次` : ''
    const body = [mine ? `我说过「${mine}」` : '', tail].filter(Boolean).join('，')
    lines.push(`· ${what}${body ? ` —— ${body}` : ''}`)
  }
  const text = lines.join('\n')
  const limit = Math.max(0, Number(maxChars) || MEMORY_MAX_CHARS)
  if (charLen(text) <= limit) return text
  // 超限就按条丢（从最不重要的尾巴开始），绝不切半句
  let kept = lines
  while (kept.length > 1 && charLen(kept.join('\n')) > limit) kept = kept.slice(0, -1)
  const out = kept.join('\n')
  return charLen(out) > limit ? out.slice(0, limit) : out
}
