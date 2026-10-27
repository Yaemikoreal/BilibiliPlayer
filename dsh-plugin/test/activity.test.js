// dsh-plugin/test/activity.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toActivities, dayKeyOf, stageOf } from '../lib/activity.js'

const EV = [
  { t: '2026-10-22T08:26:11Z', round: 'r1', type: 'view', bvid: 'BV1', title: 'A', author: 'UP1', views: 100, grade: 'worth', source: 'hot' },
  { t: '2026-10-22T08:26:30Z', round: 'r1', type: 'like', bvid: 'BV1' },
  { t: '2026-10-22T08:27:00Z', round: 'r1', type: 'comment', bvid: 'BV1', text: '我的评论', rpid: 11 },
  { t: '2026-10-22T08:28:00Z', round: 'r1', type: 'dynamic', bvid: 'BV1', text: '动态' },
  { t: '2026-10-22T09:00:00Z', round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 11, rpid: 21, from: '张三', text: '回复我' },
  { t: '2026-10-22T09:05:00Z', round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 11, rpid: 22, from: '李四', text: '再问一句' },
  { t: '2026-10-22T09:10:00Z', round: 'r1', type: 'reply-out', bvid: 'BV1', parent: 21, rpid: 31, text: '我回答' },
  { t: '2026-10-22T08:29:00Z', round: 'r1', type: 'skip', bvid: 'BV2', title: 'B', reason: '无字幕' },
  { t: '2026-10-22T08:30:00Z', round: 'r1', type: 'view', bvid: 'BV3', title: 'C', author: 'UP3', grade: 'ok' },
]

test('按 bvid 聚合成活动，跳过项单独标记', () => {
  const { activities } = toActivities(EV)
  assert.equal(activities.length, 3)
  const a = activities.find((x) => x.bvid === 'BV1')
  assert.equal(a.stage.viewed, true)
  assert.equal(a.stage.liked, true)
  assert.equal(a.stage.commented, true)
  assert.equal(a.stage.dynamic, true)
  assert.equal(a.stage.replies, 2)
  assert.equal(a.stage.repliedBack, true)
  assert.equal(a.stage.pendingReply, 1)          // 2 条回复里只回了 1 条
  assert.equal(activities.find((x) => x.bvid === 'BV2').skipped.reason, '无字幕')
  assert.equal(activities.find((x) => x.bvid === 'BV3').events.length, 1)
})

test('按轮次分组，轮次倒序，轮内有对话的排前面', () => {
  const { rounds } = toActivities([
    ...EV,
    { t: '2026-10-22T12:00:00Z', round: 'r2', type: 'view', bvid: 'BV9', title: 'Z' },
  ])
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].id, 'r2')                 // 倒序：r2 在前
  const r1 = rounds.find((x) => x.id === 'r1')
  assert.equal(r1.items[0].bvid, 'BV1')            // 有对话的排最前
})

test('stageOf 对纯浏览给出最小阶段', () => {
  const s = stageOf([{ type: 'view' }])
  assert.deepEqual(s, { viewed: true, liked: false, commented: false, replies: 0, repliedBack: false, proactive: 0, scanned: false, dynamic: false, pendingReply: 0 })
})

test('dayKeyOf 从 ISO 时间取本地日期', () => {
  assert.match(dayKeyOf('2026-10-22T08:26:11Z'), /^2026-10-2[12]$/)
})
