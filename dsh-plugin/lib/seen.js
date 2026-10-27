/** 已看过清单（设计文档 2026-10-27-proactive-reply-dedup §4）。
 * 宿主从账本算「最近看过的 BV」注入本轮参数，命中即丢——判重从「agent 自觉读 seen.md」
 * 升级为「宿主硬判重」。纯函数，无 IO，方便单测。 */
export const SEEN_WINDOW_DAYS = 14
export const SEEN_CAP = 250

const BV_RE = /^BV[0-9A-Za-z]{8,12}$/

/** 从账本事件算已看过清单：带合法 BV 的事件（view/like/comment/dynamic/skip/reply-out/reply-in 都行）
 *  → 最近 windowDays 天内 → 按时间新→旧去重 → 最多 cap 条。非法 BV / 没有 t 的事件忽略。 */
export function seenListFromLedger(events, { now = Date.now(), windowDays = SEEN_WINDOW_DAYS, cap = SEEN_CAP } = {}) {
  const cutoff = now - windowDays * 86400_000
  const hits = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    const bv = String(e.bvid || '')
    if (!BV_RE.test(bv)) continue
    const t = Date.parse(e.t)
    if (!Number.isFinite(t)) continue
    if (t < cutoff) continue
    hits.push({ bv, t })
  }
  hits.sort((a, b) => b.t - a.t)
  const out = []
  const has = new Set()
  for (const h of hits) {
    if (has.has(h.bv)) continue
    has.add(h.bv)
    out.push(h.bv)
    if (out.length >= cap) break
  }
  return out
}
