// dsh-plugin/test/ledger.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvents, readEvents, isDuplicate } from '../lib/ledger.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-ledger-'))

test('appendEvents 追加 JSONL，一行一个事件', () => {
  const file = join(dir(), 'ledger.jsonl')
  appendEvents(file, [
    { t: '2026-10-22T08:26:11Z', round: 'r1', type: 'view', bvid: 'BV1', title: 't' },
    { t: '2026-10-22T08:26:30Z', round: 'r1', type: 'like', bvid: 'BV1' },
  ])
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).type, 'like')
})

test('readEvents 跳过损坏行，并按时间正序返回', () => {
  const file = join(dir(), 'ledger.jsonl')
  writeFileSync(file, [
    '{"t":"2026-10-22T08:27:00Z","type":"comment","bvid":"BV1","text":"b","rpid":2}',
    '{ this is not json',
    '{"t":"2026-10-22T08:26:00Z","type":"view","bvid":"BV1","title":"a"}',
    '',
  ].join('\n'))
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'view')
  assert.equal(events[1].type, 'comment')
})

test('readEvents 文件不存在时返回空数组', () => {
  assert.deepEqual(readEvents(join(dir(), 'nope.jsonl')), [])
})

test('一行塞多个对象时逐个救回（旧实现整行丢弃 ⇒ 评论/动态被销账）', () => {
  const file = join(dir(), 'ledger.jsonl')
  // 2026-10-25 真实账本形态：模型把一个物理行写成多个对象
  const a = { t: '2026-10-25T18:40:32+08:00', round: 'r', type: 'comment', bvid: 'BV1', text: '甲', rpid: 1 }
  const b = { t: '2026-10-25T18:40:32+08:00', round: 'r', type: 'dynamic', bvid: 'BV1', text: '乙', id: '9' }
  const c = { t: '2026-10-25T18:40:33+08:00', round: 'r', type: 'view', bvid: 'BV2', title: '丙' }
  writeFileSync(file, [JSON.stringify(a) + ' ' + JSON.stringify(b) + ' ' + JSON.stringify(c), ''].join('\n'))
  const events = readEvents(file)
  assert.equal(events.length, 3)
  assert.deepEqual(events.map((e) => e.type).sort(), ['comment', 'dynamic', 'view'])
  assert.equal(events.find((e) => e.type === 'comment').text, '甲')
})

test('一行多对象里若有坏片段，只丢坏的那段，好的照样救回', () => {
  const file = join(dir(), 'ledger.jsonl')
  const ok1 = { t: '2026-10-25T08:00:00Z', type: 'like', bvid: 'BV1' }
  const ok2 = { t: '2026-10-25T08:00:01Z', type: 'comment', bvid: 'BV1', text: '含"引号"和{括号}', rpid: 3 }
  writeFileSync(file, [JSON.stringify(ok1) + ' {broken} ' + JSON.stringify(ok2), ''].join('\n'))
  const events = readEvents(file)
  assert.equal(events.length, 2)
  assert.equal(events.find((e) => e.type === 'comment').text, '含"引号"和{括号}')
})

test('isDuplicate 对同 (bvid,type,text) 的兜底事件判重', () => {
  const existing = [{ bvid: 'BV1', type: 'comment', text: 'hi', source: 'agent' }]
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'comment', text: 'hi', source: 'report' }), true)
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'comment', text: 'other', source: 'report' }), false)
  assert.equal(isDuplicate(existing, { bvid: 'BV1', type: 'like', source: 'report' }), false)
})

test('appendEvents 在超过上限时轮转为 .old', () => {
  const file = join(dir(), 'ledger.jsonl')
  writeFileSync(file, 'x'.repeat(2048) + '\n')
  appendEvents(file, [{ t: '2026-10-22T09:00:00Z', type: 'like', bvid: 'BV1' }], { rotateBytes: 1024 })
  assert.ok(readFileSync(file + '.old', 'utf8').length > 0)
  assert.equal(readEvents(file).length, 1)
})
