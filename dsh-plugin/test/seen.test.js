// lib/seen.js：已看过清单（宿主硬判重）——窗口/去重/上限/健壮性
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seenListFromLedger, SEEN_WINDOW_DAYS, SEEN_CAP } from '../lib/seen.js'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const iso = (h) => new Date(NOW - h * 3600_000).toISOString()
const ev = (bvid, t) => ({ t, bvid, type: 'view' })
// 真 BV 号 = BV + 10 个字符
const bv = (s) => 'BV1' + String(s).padStart(7, '0') + 'ZZ'

test('最近 14 天内的事件都算看过，按新→旧排', () => {
  const list = seenListFromLedger([ev(bv('old'), iso(24 * 13)), ev(bv('new'), iso(1))], { now: NOW })
  assert.deepEqual(list, [bv('new'), bv('old')])
})

test('窗口外（默认 14 天前）不算', () => {
  const list = seenListFromLedger([ev(bv('ancient'), iso(24 * 15)), ev(bv('fresh'), iso(2))], { now: NOW })
  assert.deepEqual(list, [bv('fresh')])
})

test('同一 BV 多次事件去重，取最新时间的位置', () => {
  const list = seenListFromLedger([
    ev(bv('a'), iso(1)),
    ev(bv('b'), iso(2)),
    ev(bv('a'), iso(3)),
  ], { now: NOW })
  assert.deepEqual(list, [bv('a'), bv('b')])
})

test('cap 截断，保留最新的', () => {
  const events = []
  for (let i = 0; i < SEEN_CAP + 10; i++) events.push(ev('BV1' + String(i).padStart(9, '0') + 'Z', iso(1 + i)))
  const list = seenListFromLedger(events, { now: NOW })
  assert.equal(list.length, SEEN_CAP)
  assert.equal(list[0], 'BV1000000000Z')
})

test('非法 BV / 缺 t / 非对象事件忽略；空账本返回空', () => {
  const list = seenListFromLedger([
    { t: iso(1), bvid: 'av12345', type: 'view' },
    { bvid: 'BV1notime0000Z' },
    null,
    'junk',
    ev(bv('ok'), iso(1)),
  ], { now: NOW })
  assert.deepEqual(list, [bv('ok')])
  assert.deepEqual(seenListFromLedger([], { now: NOW }), [])
  assert.deepEqual(seenListFromLedger(undefined), [])
})

test('windowDays 可注入：0 天窗口 = 全不算', () => {
  const list = seenListFromLedger([ev(bv('a'), iso(1))], { now: NOW, windowDays: 0 })
  assert.deepEqual(list, [])
})

test('常量：窗口 14 天、上限 250（设计文档拍板值）', () => {
  assert.equal(SEEN_WINDOW_DAYS, 14)
  assert.equal(SEEN_CAP, 250)
})
