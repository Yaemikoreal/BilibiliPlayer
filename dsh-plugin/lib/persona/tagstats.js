/**
 * 换卡对比（W5 的数据面）—— 纯函数，不读盘、不看真实时钟。
 *
 * 口径（方案 §5.5「换卡对比」）：按账本 `persona-inject` 事件的 `personaTag` 分组，
 * 每条 `comment` 事件按它**所在 round** 的 personaTag 归属；每组给出：
 *   - rounds：该 tag 出现过几次注入（按 round 去重）；
 *   - lastAt：该组最近一次活动时间（注入 / 评论都算）；
 *   - likes：该组评论事件的 `likes` 之和（字段缺失按 0）；
 *   - samples：最近 `limitPerTag` 条评论（近 → 远）。
 * 没被任何 `persona-inject` 覆盖的 round 里的评论**不计入**（没有归因就不猜归属）；
 * 无数据 ⇒ `{ tags: [] }`。
 *
 * 复用 `lib/persona/attribution.js` 的事件类型常量，别再写裸字符串。
 */
import { PERSONA_EVENT } from './attribution.js'

const asArr = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** ISO/日期字符串比较：能解析就按时间，不能解析就按字符串（都要确定性）。 */
const laterIso = (a, b) => {
  const sa = String(a || '')
  const sb = String(b || '')
  if (!sa) return sb
  if (!sb) return sa
  const ma = Date.parse(sa)
  const mb = Date.parse(sb)
  if (Number.isFinite(ma) && Number.isFinite(mb)) return ma >= mb ? sa : sb
  return sa >= sb ? sa : sb
}

const cmpIso = (a, b) => {
  const sa = String(a || '')
  const sb = String(b || '')
  const ma = Date.parse(sa)
  const mb = Date.parse(sb)
  if (Number.isFinite(ma) && Number.isFinite(mb)) return mb - ma
  return sb < sa ? -1 : sb > sa ? 1 : 0
}

/**
 * @param {object} o
 * @param {Array} [o.events] 账本事件（只读）
 * @param {number} [o.limitPerTag=3] 每组最多给几条评论样本
 * @param {number} [o.maxTags=8] 最多返回几组（按 lastAt 近 → 远）
 * @returns {{tags:Array<{personaTag:string,rounds:number,lastAt:string,likes:number,samples:Array}>}}
 */
export function buildTagStats(o = {}) {
  const list = asArr(o.events)
  const limitPerTag = Number.isFinite(Number(o.limitPerTag)) && Number(o.limitPerTag) >= 0
    ? Math.floor(Number(o.limitPerTag)) : 3
  const maxTags = Number.isFinite(Number(o.maxTags)) && Number(o.maxTags) >= 0
    ? Math.floor(Number(o.maxTags)) : 8

  /** round → 最新一次注入 { tag, t }：同一轮多条 persona-inject 取最新那条。 */
  const tagByRound = new Map()
  /** tag → 聚合桶 */
  const groups = new Map()
  const groupOf = (tag) => {
    if (!groups.has(tag)) {
      groups.set(tag, {
        personaTag: tag,
        rounds: new Set(),
        lastAt: '',
        likes: 0,
        comments: [],
      })
    }
    return groups.get(tag)
  }

  // ① 注入事件：建组、记 round、推进 lastAt
  for (const e of list) {
    if (!e || e.type !== PERSONA_EVENT) continue
    const tag = String(e.personaTag || '').trim()
    if (!tag) continue
    const round = String(e.round || '')
    const t = String(e.t || '')
    if (round) {
      const prev = tagByRound.get(round)
      if (!prev || cmpIso(t, prev.t) <= 0) tagByRound.set(round, { tag, t })
    }
    const g = groupOf(tag)
    if (round) g.rounds.add(round)
    g.lastAt = laterIso(g.lastAt, t)
  }

  // ② 评论事件：按所在 round 的 tag 归属
  for (const e of list) {
    if (!e || e.type !== 'comment') continue
    const r = String(e.round || '')
    const hit = r ? tagByRound.get(r) : null
    if (!hit) continue
    const g = groupOf(hit.tag)
    const t = String(e.t || '')
    g.lastAt = laterIso(g.lastAt, t)
    g.likes += num(e.likes)
    g.comments.push({
      bvid: String(e.bvid || ''),
      text: typeof e.text === 'string' ? e.text : '',
      t,
      likes: num(e.likes),
    })
  }

  // ③ 每组取最近 limitPerTag 条；组按 lastAt 近 → 远（同刻按 likes / tag 兜底，保证确定性）
  const tags = [...groups.values()]
    .map((g) => ({
      personaTag: g.personaTag,
      rounds: g.rounds.size,
      lastAt: g.lastAt,
      likes: g.likes,
      samples: [...g.comments]
        .sort((a, b) => cmpIso(a.t, b.t))
        .slice(0, limitPerTag),
    }))
    .sort((a, b) => cmpIso(a.lastAt, b.lastAt) || (b.likes - a.likes)
      || (a.personaTag < b.personaTag ? -1 : a.personaTag > b.personaTag ? 1 : 0))
    .slice(0, maxTags)

  return { tags }
}
