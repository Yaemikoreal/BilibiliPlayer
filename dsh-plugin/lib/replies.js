/** msgfeed 回复通知 → reply-in 事件（设计文档 §4.4）。纯映射 + 一个可注入 fetch 的拉取器。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REPLY_API = 'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web'

export function bvidOf(uri) {
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(String(uri || ''))
  return m ? m[1] : ''
}

export function toReplyIn(notif, opts = {}) {
  if (!notif || typeof notif !== 'object') return null
  const item = notif.item || {}
  const bvid = bvidOf(item.uri) || bvidOf(item.native_uri)
  const text = String(item.target_reply_content || '').trim()
  const parent = Number(item.source_id) || null
  const rpid = Number(item.target_id) || null
  if (!bvid || !text || !notif.id) return null
  return {
    t: notif.reply_time ? new Date(notif.reply_time * 1000).toISOString() : new Date().toISOString(),
    round: opts.round ?? null,
    type: 'reply-in',
    bvid,
    parent,
    rpid,
    from: String(notif.user?.nickname || ''),
    text,
    notifId: Number(notif.id),
    source: 'agent',
  }
}

export async function fetchReplyNotifs(cookieHeader, fetchImpl = fetch) {
  const res = await fetchImpl(REPLY_API, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader, Referer: 'https://www.bilibili.com/' },
  })
  const json = await res.json().catch(() => ({}))
  const items = json?.data?.items
  return Array.isArray(items) ? items : []
}

/* ───────── 已接话清单（设计定稿 2026-10-28 §3.3(6)） ─────────
 * 「同一 target rpid 永不重复接」这条纪律，宿主得帮模型算：把近 14 天的接话 (bvid, parent)
 * 平铺出来注入值班 prompt。与 lib/seen.js 同款「窗口 + 上限 + 纯函数」写法，可单测。 */
export function proactiveTargetsFromLedger(events, opts = {}) {
  const days = Math.max(1, Number(opts.days) || 14)
  const limit = Math.max(1, Number(opts.limit) || 100)
  const now = opts.now ?? Date.now()
  const cutoff = now - days * 86400_000
  const out = []
  const seen = new Set()
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (!e || e.type !== 'reply-out' || e.kind !== 'proactive') continue
    const t = Date.parse(String(e.t || ''))
    if (Number.isFinite(t) && t < cutoff) continue
    const key = `${e.bvid || ''}\u0000${e.parent ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      bvid: String(e.bvid || ''),
      parent: e.parent ?? null,
      round: e.round ?? null,
      t: String(e.t || ''),
    })
    if (out.length >= limit) break
  }
  return out
}

/* ───────── 归属轮次（从 index.js 收口成纯函数；设计文档 2026-10-27 §5） ─────────
 * 「我的话」= 我发的评论（comment）+ 我的接话/回复（reply-out）——两种事件的 rpid 都拿来匹配
 * 通知的 parent（item.source_id），接话收到的回复才能正确归属到发接话的那一轮。 */
const MINE_WINDOW_MS = 7 * 86400_000

export function roundIdForReply(notif, events, { now = Date.now() } = {}) {
  const parent = Number(notif?.item?.source_id) || null
  if (!parent) return null
  const cutoff = now - MINE_WINDOW_MS
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if (e.type !== 'comment' && e.type !== 'reply-out') continue
    if (Number(e.rpid) !== parent) continue
    const t = Date.parse(e.t)
    if (Number.isFinite(t) && t < cutoff) continue
    return e.round ?? null
  }
  // parent 对不上时，退而求其次：拿我方原话（source_content）跟 comment 事件正文比对
  const text = String(notif?.item?.source_content || '').trim()
  if (text) {
    for (const e of events) {
      if (e && e.type === 'comment' && e.text === text) return e.round ?? null
    }
  }
  return null
}
