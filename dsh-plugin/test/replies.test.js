// dsh-plugin/test/replies.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toReplyIn, bvidOf, roundIdForReply,
  fetchReplyNotifs, nextPollDelay, POLL_TIMEOUT_MS, BACKOFF_STEPS_MS,
} from '../lib/replies.js'
import { normalizeAccount } from '../lib/account.js'

test('bvidOf 从 uri / native_uri 提取 BV 号', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV192n66dEDQ'), 'BV192n66dEDQ')
  assert.equal(bvidOf('bilibili://video/12345'), '')
  assert.equal(bvidOf(undefined), '')
})

test('toReplyIn 映射通知为 reply-in 事件（真实 msgfeed 语义：source_content 是对方那句）', () => {
  const notif = {
    id: 1185685105221638,
    reply_time: 1776800000,
    user: { nickname: '张三' },
    item: {
      uri: 'https://www.bilibili.com/video/BV192n66dEDQ',
      title: '某视频',
      source_content: '对方的回复',
      target_reply_content: '我的原评论',
      root_reply_content: '我的原评论',
      source_id: 11,
      target_id: 22,
      root_id: 22,
    },
  }
  const ev = toReplyIn(notif, { round: 'r1' })
  assert.equal(ev.type, 'reply-in')
  assert.equal(ev.bvid, 'BV192n66dEDQ')
  // rpid = 对方那条（reply-out.parent 对得上才算"已回"）；parent = 我那条（用来归属轮次）
  assert.equal(ev.rpid, 11)
  assert.equal(ev.parent, 22)
  assert.equal(ev.from, '张三')
  assert.equal(ev.text, '对方的回复')
  assert.equal(ev.notifId, 1185685105221638)
  assert.equal(ev.round, 'r1')
  assert.match(ev.t, /^\d{4}-\d{2}-\d{2}T/)
})

/* 2026-10-29 真实事故：Aria 回我的地铁字库评论，`target_reply_content` 是空字符串，
 * 旧实现取它 ⇒ 整条通知被判 null（回复永远不进账本）；而对方原话在 `source_content` 里。
 * 这段 JSON 是从真实 msgfeed 返回里裁出来的（只留相关字段）。 */
const ARIA = {
  id: 1190089720274948,
  reply_time: 1793204150,
  user: { nickname: 'Aria_凛酱门' },
  item: {
    uri: 'https://www.bilibili.com/video/BV1TisX6dEFS',
    title: '为了地铁牌上的字揉两套字库，这活儿得磨多久啊[doge]',
    root_reply_content: '为了地铁牌上的字揉两套字库，这活儿得磨多久啊[doge]',
    source_content: '大肥鱼怎么这么快喵！',
    target_reply_content: '',
    source_id: 318480411329,
    target_id: 318480352401,
    root_id: 318480352401,
    business_id: 1,
    type: 'reply',
  },
}

test('toReplyIn：楼中楼回复（target_reply_content 为空）也要记下来（Aria 真实通知）', () => {
  const ev = toReplyIn(ARIA, { round: 'r-aria' })
  assert.ok(ev, '不能返回 null —— 这是真实收到的一条回复')
  assert.equal(ev.text, '大肥鱼怎么这么快喵！', '对方说的是 source_content')
  assert.equal(ev.rpid, 318480411329, 'rpid 是对方那条')
  assert.equal(ev.parent, 318480352401, 'parent 是我那条评论')
  assert.equal(ev.from, 'Aria_凛酱门')
  assert.equal(ev.bvid, 'BV1TisX6dEFS')
  assert.equal(ev.round, 'r-aria')
})

test('roundIdForReply：按「我那条」target_id 归属到发评论的那一轮（Aria 真实通知）', () => {
  const events = [{ t: new Date().toISOString(), type: 'comment', bvid: 'BV1TisX6dEFS', text: '…', rpid: 318480352401, round: 'R-comment' }]
  assert.equal(roundIdForReply(ARIA, events), 'R-comment')
})

test('reply-in.rpid 与 reply-out.parent 对齐 ⇒ 回过之后不再算「待回复」', async () => {
  const { pendingReplyCount } = await import('../lib/persona/speak.js')
  const ev = toReplyIn(ARIA)
  assert.equal(pendingReplyCount([ev], { now: ev.t }), 1, '刚收到时算 1 条待回')
  const answered = { type: 'reply-out', bvid: 'BV1TisX6dEFS', parent: ev.rpid, text: '喵什么喵', t: ev.t }
  assert.equal(pendingReplyCount([ev, answered], { now: ev.t }), 0, '回过之后必须归零（门控靠这个判断节奏）')
})

test('toReplyIn 对缺字段的通知返回 null（不猜）', () => {
  assert.equal(toReplyIn({ id: 1, item: {} }), null)
  assert.equal(toReplyIn({ id: 2, item: { uri: 'https://x/video/BV1' } }), null)
})

/* ───────── roundIdForReply：comment + reply-out 两种「我的话」都能归属 ───────── */

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const iso = (h) => new Date(NOW - h * 3600_000).toISOString()
const notif = (targetId, myText) => ({ item: { target_id: targetId, target_reply_content: myText || '' } })

test('roundIdForReply：parent 命中 comment 事件 → 归属该轮', () => {
  const events = [{ t: iso(2), type: 'comment', bvid: 'BV1x', text: '原话', rpid: 111, round: 'r-comment' }]
  assert.equal(roundIdForReply(notif(111), events, { now: NOW }), 'r-comment')
})

test('roundIdForReply：parent 命中 reply-out（接话）→ 也归属该轮', () => {
  const events = [
    { t: iso(5), type: 'comment', bvid: 'BV1x', text: '顶楼', rpid: 100, round: 'r1' },
    { t: iso(1), type: 'reply-out', kind: 'proactive', bvid: 'BV1x', parent: 555, text: '接的话', rpid: 777, round: 'r2' },
  ]
  assert.equal(roundIdForReply(notif(777), events, { now: NOW }), 'r2')
})

test('roundIdForReply：comment / reply-out 都不中 → 我原话兜底 → 再不中 null', () => {
  const events = [{ t: iso(2), type: 'comment', bvid: 'BV1x', text: '我的原评论', rpid: 111, round: 'r-comment' }]
  assert.equal(roundIdForReply(notif(999, '我的原评论'), events, { now: NOW }), 'r-comment')
  assert.equal(roundIdForReply(notif(999, '对不上'), events, { now: NOW }), null)
  assert.equal(roundIdForReply(notif(0), events, { now: NOW }), null)
})

test('roundIdForReply：7 天窗外的 rpid 不算我的话', () => {
  const events = [{ t: iso(24 * 8), type: 'comment', bvid: 'BV1x', text: '很老', rpid: 111, round: 'r-old' }]
  assert.equal(roundIdForReply(notif(111), events, { now: NOW }), null)
})

test('roundIdForReply：事件缺 round → 返回 null 而不是抛错', () => {
  const events = [{ t: iso(2), type: 'comment', rpid: 111 }]
  assert.equal(roundIdForReply(notif(111), events, { now: NOW }), null)
  assert.equal(roundIdForReply(notif(111), undefined, { now: NOW }), null)
})

test('normalizeAccount 归一 nav + relation/stat', () => {
  const a = normalizeAccount(
    { code: 0, data: { isLogin: true, uname: '蓝鱼小号', mid: 10000001, face: 'https://f', level_info: { current_level: 6 }, money: 1447.5, vipStatus: 0 } },
    { code: 0, data: { follower: 12, following: 34 } },
  )
  assert.equal(a.loggedIn, true)
  assert.equal(a.uname, '蓝鱼小号')
  assert.equal(a.mid, '10000001')
  assert.equal(a.level, 6)
  assert.equal(a.coins, 1447.5)
  assert.equal(a.fans, 12)
  assert.equal(a.following, 34)
  assert.equal(a.vip, false)

  const out = normalizeAccount({ code: -101, data: { isLogin: false } }, null)
  assert.equal(out.loggedIn, false)
})

/* ───────── W3-2：回复轮询的超时与退避（旧实现没有 signal，挂死即永远吊住） ───────── */

test('nextPollDelay：1min → 5min → 15min 阶梯，之后停在 15min', () => {
  assert.deepEqual(BACKOFF_STEPS_MS, [60_000, 300_000, 900_000])
  assert.equal(nextPollDelay(1), 60_000)
  assert.equal(nextPollDelay(2), 300_000)
  assert.equal(nextPollDelay(3), 900_000)
  assert.equal(nextPollDelay(9), 900_000, '连续失败再多也不超过 15min')
  assert.equal(nextPollDelay(0), 60_000, '0 次失败按最小档（调用方不用它，但要确定）')
  assert.equal(nextPollDelay(-5), 60_000)
  assert.equal(nextPollDelay('2'), 300_000)
})

test('fetchReplyNotifs：带超时信号（默认 8s），能正常返回 items', async () => {
  let seen = null
  const fakeFetch = async (url, init) => {
    seen = init
    return { json: async () => ({ data: { items: [{ id: 1 }] } }) }
  }
  const items = await fetchReplyNotifs('SESSDATA=x', fakeFetch)
  assert.equal(items.length, 1)
  assert.ok(seen.signal, '必须把 signal 传下去，否则请求挂死没人管')
  assert.equal(POLL_TIMEOUT_MS, 8000)
})

test('fetchReplyNotifs：超时真的会 abort（不靠外部取消）', async () => {
  // 用 10ms 超时 + 永不 resolve 的假 fetch：验证超时信号确实被触发
  const hang = (url, init) => new Promise((resolve, reject) => {
    if (!init?.signal) return reject(new Error('no signal'))
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  await assert.rejects(() => fetchReplyNotifs('c', hang, { timeoutMs: 10 }), /aborted/)
})

test('fetchReplyNotifs：外部 signal 取消优先生效', async () => {
  const ctrl = new AbortController()
  const hang = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  })
  const p = fetchReplyNotifs('c', hang, { timeoutMs: 60_000, signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 5)
  await assert.rejects(() => p, /cancelled/)
})

test('fetchReplyNotifs：坏 JSON / 缺 items 时返回空数组，不抛', async () => {
  const bad = async () => ({ json: async () => { throw new Error('not json') } })
  assert.deepEqual(await fetchReplyNotifs('c', bad), [])
  const noItems = async () => ({ json: async () => ({ data: {} }) })
  assert.deepEqual(await fetchReplyNotifs('c', noItems), [])
})
