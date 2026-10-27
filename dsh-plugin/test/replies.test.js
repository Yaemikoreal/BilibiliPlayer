// dsh-plugin/test/replies.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toReplyIn, bvidOf, roundIdForReply } from '../lib/replies.js'
import { normalizeAccount } from '../lib/account.js'

test('bvidOf 从 uri / native_uri 提取 BV 号', () => {
  assert.equal(bvidOf('https://www.bilibili.com/video/BV192n66dEDQ'), 'BV192n66dEDQ')
  assert.equal(bvidOf('bilibili://video/12345'), '')
  assert.equal(bvidOf(undefined), '')
})

test('toReplyIn 映射通知为 reply-in 事件', () => {
  const notif = {
    id: 1185685105221638,
    reply_time: 1776800000,
    user: { nickname: '张三' },
    item: {
      uri: 'https://www.bilibili.com/video/BV192n66dEDQ',
      title: '某视频',
      source_content: '我的原评论',
      target_reply_content: '对方的回复',
      source_id: 11,
      target_id: 22,
      root_id: 11,
    },
  }
  const ev = toReplyIn(notif, { round: 'r1' })
  assert.equal(ev.type, 'reply-in')
  assert.equal(ev.bvid, 'BV192n66dEDQ')
  assert.equal(ev.parent, 11)
  assert.equal(ev.rpid, 22)
  assert.equal(ev.from, '张三')
  assert.equal(ev.text, '对方的回复')
  assert.equal(ev.notifId, 1185685105221638)
  assert.equal(ev.round, 'r1')
  assert.match(ev.t, /^\d{4}-\d{2}-\d{2}T/)
})

test('toReplyIn 对缺字段的通知返回 null（不猜）', () => {
  assert.equal(toReplyIn({ id: 1, item: {} }), null)
  assert.equal(toReplyIn({ id: 2, item: { uri: 'https://x/video/BV1' } }), null)
})

/* ───────── roundIdForReply：comment + reply-out 两种「我的话」都能归属 ───────── */

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const iso = (h) => new Date(NOW - h * 3600_000).toISOString()
const notif = (sourceId, sourceContent) => ({ item: { source_id: sourceId, source_content: sourceContent || '' } })

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

test('roundIdForReply：comment / reply-out 都不中 → source_content 兜底 → 再不中 null', () => {
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
