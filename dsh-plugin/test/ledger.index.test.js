/**
 * lib/ledger-index.js 单测（W4-1）：增量读必须与全量读**语义完全一致**，否则概览数字会悄悄变。
 *
 * 这组用例钉住三件事：
 *   1. 没变化时 **0 次读盘**（bytesRead 不涨）——性能收益的唯一可信证据；
 *   2. 追加时**只读增量段**（读盘字节 ≈ 新增字节，不是整个文件）；
 *   3. 任何不确定（变小/原地重写/半截行）都**回退到全量**且事件不丢不重。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvents } from '../lib/ledger.js'
import { createLedgerReader, ledgerReaderFor } from '../lib/ledger-index.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-ledger-index-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ev = (t, type, extra = {}) => ({ t, type, ...extra })
const line = (e) => JSON.stringify(e) + '\n'

const sample = (n, startMs = Date.parse('2026-10-28T00:00:00.000Z')) =>
  Array.from({ length: n }, (_, i) => ({
    t: new Date(startMs + i * 1000).toISOString(),
    round: 'r1',
    type: i % 3 === 0 ? 'comment' : i % 3 === 1 ? 'view' : 'like',
    bvid: `BV${i}`,
    text: `第 ${i} 条`,
  }))

test('首次读 = 全量，且与 readEvents 完全等价', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  const events = sample(50)
  writeFileSync(f, events.map(line).join(''), 'utf8')

  const r = createLedgerReader(f)
  const got = r.read()
  assert.deepEqual(got, readEvents(f), '增量读的结果必须与全量读逐字段一致')
  const s = r.stats()
  assert.equal(s.fullReads, 1, '首次必须全量读一次')
  assert.equal(s.incrementalReads, 0)
  assert.equal(s.fallbacks, 0)
  assert.equal(s.events, 50)
})

test('没变化 ⇒ 0 次读盘（bytesRead 不涨、cacheHits 涨）', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  writeFileSync(f, sample(20).map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  const first = r.read()
  const afterFirst = r.stats().bytesRead
  assert.ok(afterFirst > 0)

  for (let i = 0; i < 10; i++) assert.deepEqual(r.read(), first)
  const s = r.stats()
  assert.equal(s.bytesRead, afterFirst, '文件没变就不能再读盘')
  assert.equal(s.cacheHits, 10)
  assert.equal(s.fullReads, 1)
})

test('追加事件 ⇒ 只读增量段（不是整个文件）', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  const head = sample(200)
  writeFileSync(f, head.map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  r.read()
  const before = r.stats().bytesRead

  const tail = [
    ev(new Date(Date.parse('2026-10-28T01:00:00.000Z')).toISOString(), 'comment', { bvid: 'BVnew', text: '新的一条' }),
    ev(new Date(Date.parse('2026-10-28T01:00:01.000Z')).toISOString(), 'like', { bvid: 'BVnew' }),
  ]
  appendFileSync(f, tail.map(line).join(''), 'utf8')
  const got = r.read()

  const s = r.stats()
  const addedBytes = r.stats().bytesRead - before
  const fileSize = Buffer.byteLength(head.map(line).join('') + tail.map(line).join(''), 'utf8')
  assert.equal(s.incrementalReads, 1, '应该走增量读')
  assert.equal(s.fullReads, 1, '不该再全量读')
  assert.ok(addedBytes < fileSize / 5, `增量字节应远小于全量（实际 ${addedBytes} / ${fileSize}）`)
  assert.equal(got.length, 202)
  assert.ok(got.some((e) => e.bvid === 'BVnew'))
  assert.deepEqual(got, readEvents(f))
})

test('半截行：本次不解析，补齐后只出现一次（不丢不重）', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  writeFileSync(f, sample(5).map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  assert.equal(r.read().length, 5)

  const pending = JSON.stringify(ev('2026-10-28T02:00:00.000Z', 'comment', { bvid: 'BVhalf', text: '半截' }))
  appendFileSync(f, pending.slice(0, 12), 'utf8') // 故意只写一半
  assert.equal(r.read().length, 5, '半截行不能被当成事件')
  assert.equal(r.stats().incrementalReads, 0, '没读到完整行就不该记增量')

  appendFileSync(f, pending.slice(12) + '\n', 'utf8')
  const got = r.read()
  const halves = got.filter((e) => e.bvid === 'BVhalf')
  assert.equal(halves.length, 1, '补齐后必须只出现一次')
  assert.equal(halves[0].text, '半截')
  assert.deepEqual(got, readEvents(f))
})

test('变小（轮转到 .old）⇒ 全量回退并记 fallbacks', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  writeFileSync(f, sample(100).map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  assert.equal(r.read().length, 100)

  const rotated = sample(7, Date.parse('2026-10-28T03:00:00.000Z'))
  writeFileSync(f, rotated.map(line).join(''), 'utf8')
  const got = r.read()

  assert.equal(got.length, 7, '变小后必须读到新文件的内容')
  assert.ok(r.stats().fallbacks >= 1, '轮转必须记一次 fallbacks')
  assert.deepEqual(got, readEvents(f))
})

test('原地重写（size 不变、内容换了）⇒ 不能返回旧缓存', async () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  const a = sample(3)
  writeFileSync(f, a.map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  assert.equal(r.read()[0].bvid, 'BV0')

  await sleep(20) // 让 mtime 明确变化（Windows 上时间戳粒度足够，但别在同一毫秒内赌）
  // 用**等长**的替换内容：BV0 → BVX，长度不变
  const b = a.map((e, i) => ({ ...e, bvid: `BVX` }))
  writeFileSync(f, b.map(line).join(''), 'utf8')
  const got = r.read()
  assert.equal(got.length, 3)
  assert.ok(got.every((e) => e.bvid === 'BVX'), '必须读到新内容，不能返回旧缓存')
  assert.deepEqual(got, readEvents(f))
})

test('原地重写且变长（非 append 写）⇒ 锚点核对拦下，走全量而不是误当追加', async () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  writeFileSync(f, sample(20).map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  assert.equal(r.read().length, 20)

  await sleep(20)
  // 整体换成 25 条：size 变大（长得像 append），但前缀已经变了 ⇒ 必须靠锚点识别
  const rewritten = sample(25).map((e) => ({ ...e, bvid: 'BVR' + String(e.bvid) }))
  writeFileSync(f, rewritten.map(line).join(''), 'utf8')
  const got = r.read()

  assert.equal(got.length, 25, '不能把重写当追加（否则事件数会错）')
  assert.ok(got.every((e) => String(e.bvid).startsWith('BVR')), '读到的必须是重写后的全文')
  assert.ok(r.stats().fallbacks >= 1, '非 append 写必须记一次 fallbacks')
  assert.deepEqual(got, readEvents(f))
})

test('文件不存在 ⇒ 空数组；出现后能读到', () => {
  const d = dir()
  const f = join(d, 'nope.jsonl')
  const r = createLedgerReader(f)
  assert.deepEqual(r.read(), [])

  writeFileSync(f, sample(4).map(line).join(''), 'utf8')
  assert.equal(r.read().length, 4)
})

test('一行多对象（脏账本）也能救回，且与 readEvents 等价', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  const a = { t: '2026-10-28T00:00:00.000Z', type: 'comment', bvid: 'BV1', text: 'a' }
  const b = { t: '2026-10-28T00:00:01.000Z', type: 'like', bvid: 'BV1' }
  writeFileSync(f, JSON.stringify(a) + JSON.stringify(b) + '\n', 'utf8')
  const r = createLedgerReader(f)
  const got = r.read()
  assert.equal(got.length, 2, '一行两个对象必须都救回来')
  assert.deepEqual(got, readEvents(f))
})

test('ledgerReaderFor：同路径复用实例，不同路径互不影响', () => {
  const d = dir()
  const f1 = join(d, 'a.jsonl')
  const f2 = join(d, 'b.jsonl')
  writeFileSync(f1, sample(2).map(line).join(''), 'utf8')
  writeFileSync(f2, sample(5).map(line).join(''), 'utf8')
  assert.equal(ledgerReaderFor(f1), ledgerReaderFor(f1))
  assert.notEqual(ledgerReaderFor(f1), ledgerReaderFor(f2))
  assert.equal(ledgerReaderFor(f1).read().length, 2)
  assert.equal(ledgerReaderFor(f2).read().length, 5)
})

test('invalidate：强制下一次全量重读', () => {
  const d = dir()
  const f = join(d, 'ledger.jsonl')
  writeFileSync(f, sample(6).map(line).join(''), 'utf8')
  const r = createLedgerReader(f)
  r.read()
  const before = r.stats().fullReads
  r.invalidate()
  r.read()
  assert.equal(r.stats().fullReads, before + 1)
})

test('空文件 / 只有换行：返回空数组，不抛', () => {
  const d = dir()
  const f = join(d, 'empty.jsonl')
  writeFileSync(f, '', 'utf8')
  const r = createLedgerReader(f)
  assert.deepEqual(r.read(), [])
  writeFileSync(f, '\n\n\n', 'utf8')
  assert.deepEqual(r.read(), [])
  assert.ok(existsSync(f))
})
