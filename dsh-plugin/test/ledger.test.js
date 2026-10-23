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
