// dsh-plugin/test/replies.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toReplyIn, bvidOf } from '../lib/replies.js'
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

test('normalizeAccount 归一 nav + relation/stat', () => {
  const a = normalizeAccount(
    { code: 0, data: { isLogin: true, uname: '不吃鱼的豆腐', mid: 312299788, face: 'https://f', level_info: { current_level: 6 }, money: 1447.5, vipStatus: 0 } },
    { code: 0, data: { follower: 12, following: 34 } },
  )
  assert.equal(a.loggedIn, true)
  assert.equal(a.uname, '不吃鱼的豆腐')
  assert.equal(a.mid, '312299788')
  assert.equal(a.level, 6)
  assert.equal(a.coins, 1447.5)
  assert.equal(a.fans, 12)
  assert.equal(a.following, 34)
  assert.equal(a.vip, false)

  const out = normalizeAccount({ code: -101, data: { isLogin: false } }, null)
  assert.equal(out.loggedIn, false)
})
