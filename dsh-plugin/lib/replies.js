/** msgfeed 回复通知 → reply-in 事件（设计文档 §4.4）。纯映射 + 一个可注入 fetch 的拉取器。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REPLY_API = 'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web'

/** 单次拉取的硬超时（W3-2）：没有它，一次挂死的连接会把轮询循环永远吊住。 */
export const POLL_TIMEOUT_MS = 8000

/** 失败退避阶梯（1min → 5min → 15min，之后停在 15min）。断网时不要把日志刷成瀑布。 */
export const BACKOFF_STEPS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000])

/** 第 n 次连续失败后该等多久（n 从 1 开始；0 次失败 = 正常间隔，由调用方决定）。 */
export const nextPollDelay = (consecutiveFailures = 0) => {
  const n = Math.max(1, Math.floor(Number(consecutiveFailures) || 0))
  return BACKOFF_STEPS_MS[Math.min(n, BACKOFF_STEPS_MS.length) - 1]
}

export function bvidOf(uri) {
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(String(uri || ''))
  return m ? m[1] : ''
}

export function toReplyIn(notif, opts = {}) {
  if (!notif || typeof notif !== 'object') return null
  const item = notif.item || {}
  const bvid = bvidOf(item.uri) || bvidOf(item.native_uri)
  // ⭐ 2026-10-29 实测（真实 msgfeed 返回）：**对方说的那句在 `source_content`**，
  //    `target_reply_content` 是「我那条被回复的原话」（楼中楼里它是空的，只有 root_reply_content 有值）。
  //    旧实现取 target_reply_content ⇒ ①记录成我自己的话 ②楼中楼回复（空字符串）整条被丢掉：
  //    Aria 的真实回复「大肥鱼怎么这么快喵！」就是这样没进账本的（模型自己用工具看到才跟进了）。
  const incoming = String(item.source_content || '').trim()
  const mineText = String(item.target_reply_content || '').trim()
  const text = incoming || mineText
  if (!bvid || !text || !notif.id) return null
  // rpid 语义（与其他消费方对齐：overview / speak 都拿 `reply-out.parent === reply-in.rpid` 判"已回"）：
  //   rpid   = **对方那条**评论 rpid（= 我回复时的 parent）
  //   parent = **我那条**被回复的评论 rpid（用来把回复归属到"我哪一轮说的"）
  const theirRpid = Number(item.source_id) || null
  const myRpid = Number(item.target_id) || null
  return {
    t: notif.reply_time ? new Date(notif.reply_time * 1000).toISOString() : new Date().toISOString(),
    round: opts.round ?? null,
    type: 'reply-in',
    bvid,
    parent: myRpid,
    rpid: theirRpid,
    from: String(notif.user?.nickname || ''),
    text,
    notifId: Number(notif.id),
    source: 'agent',
  }
}

/**
 * 拉回复通知。
 *
 * W3-2：带 **硬超时 + 外部 signal**——旧实现没有 `signal`，一个卡住的 TCP 连接会让
 * 轮询循环永远等下去（页面显示"正在拉取"直到进程被杀）。
 * @param {string} cookieHeader
 * @param {Function} [fetchImpl]
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export async function fetchReplyNotifs(cookieHeader, fetchImpl = fetch, opts = {}) {
  const { timeoutMs = POLL_TIMEOUT_MS, signal } = opts || {}
  // 组合信号：外部取消（stop/轮次结束）与超时取先到者。
  // AbortSignal.any 在 Node ≥20 可用；老运行时退化为只用超时，绝不因组合失败而抛。
  let combined = signal
  try {
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
      const to = AbortSignal.timeout(timeoutMs)
      combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, to]) : (signal || to)
    }
  } catch {
    combined = signal
  }
  const res = await fetchImpl(REPLY_API, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader, Referer: 'https://www.bilibili.com/' },
    signal: combined,
  })
  const json = await res.json().catch(() => ({}))
  const items = json?.data?.items
  return Array.isArray(items) ? items : []
}

/* ───────── 已回复清单（2026-10-29：接话+跟进统一目标判重） ─────────
 * 「同一 target rpid 只回一次」这条纪律，宿主得帮模型算：把近 14 天**所有**回复别人的
 * reply-out（接话 kind=proactive + 跟进无 kind）按 (bvid, parent) 平铺出来注入值班 prompt。
 *
 * 为什么跟进也要进清单：2026-10-29 实测（账本 + duty.log），跟进目标不在任何判重数据里
 * （旧清单只认 kind=proactive；seen.md 的跟进行记的是自己楼层 rpid）⇒ 模型拿通知里的
 * 对方 rpid 查无记录，把"上一轮刚回过的评论"当新的又回了一遍（Aria 楼 318480411329
 * 被连回 2 次、12:25 轮还想回第 3 次，被 12022 挡住）。
 * 与 lib/seen.js 同款「窗口 + 上限 + 纯函数」写法，可单测。 */
export function repliedTargetsFromLedger(events, opts = {}) {
  const days = Math.max(1, Number(opts.days) || 14)
  const limit = Math.max(1, Number(opts.limit) || 100)
  const now = opts.now ?? Date.now()
  const cutoff = now - days * 86400_000
  const out = { proactive: [], followup: [] }
  const seen = { proactive: new Set(), followup: new Set() }
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    if (!e || e.type !== 'reply-out') continue
    const kind = e.kind === 'proactive' ? 'proactive' : 'followup'
    const t = Date.parse(String(e.t || ''))
    if (Number.isFinite(t) && t < cutoff) continue
    const parent = e.parent ?? null
    if (parent == null) continue // 没有目标 rpid 的残行没法判重，跳过
    const key = `${e.bvid || ''}\u0000${parent}`
    if (seen[kind].has(key)) continue
    seen[kind].add(key)
    out[kind].push({
      bvid: String(e.bvid || ''),
      parent,
      round: e.round ?? null,
      t: String(e.t || ''),
    })
    if (out.proactive.length >= limit && out.followup.length >= limit) break
  }
  return out
}

/** 旧名字保留：只取接话目标（兼容旧调用方/测试；新代码一律用 repliedTargetsFromLedger）。 */
export function proactiveTargetsFromLedger(events, opts = {}) {
  return repliedTargetsFromLedger(events, opts).proactive
}

/* ───────── 归属轮次（从 index.js 收口成纯函数；设计文档 2026-10-27 §5） ─────────
 * 「我的话」= 我发的评论（comment）+ 我的接话/回复（reply-out）——两种事件的 rpid 都拿来匹配
 * 通知的 parent（item.source_id），接话收到的回复才能正确归属到发接话的那一轮。 */
const MINE_WINDOW_MS = 7 * 86400_000

export function roundIdForReply(notif, events, { now = Date.now() } = {}) {
  // 归属看「**我那条**被回复的评论 rpid」（target_id）；source_id 是对方那条，永远对不上我的账本。
  // 2026-10-29 实测：用 source_id 会让每条回复都归属 null（跟进统计/归因全断）。
  const parent = Number(notif?.item?.target_id) || Number(notif?.item?.source_id) || null
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
  // parent 对不上时，退而求其次：拿我方原话（root/target 里那句）跟 comment 事件正文比对
  const text = String(notif?.item?.target_reply_content || notif?.item?.root_reply_content || '').trim()
  if (text) {
    for (const e of events) {
      if (e && e.type === 'comment' && e.text === text) return e.round ?? null
    }
  }
  return null
}
