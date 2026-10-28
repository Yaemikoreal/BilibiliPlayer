/**
 * lib/logsink.js 单测：流式解码 / 尾部截断 / 按字节轮转 / 探测降噪。
 *
 * 这几条都是 2026-10-28 实测事故的回归防线：
 *   - 多字节字符被 chunk 边界切开 ⇒ 中文不能毁；
 *   - `.old` 的真实大小必须 ≤ keepBytes（中文 3 字节，按字符切会超标 3 倍）；
 *   - 同一探测结论反复调用只记一次日志。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUtf8Decoder, keepTail, rotateIfBig, createProbeLogger } from '../lib/logsink.js'

const sandbox = mkdtempSync(join(tmpdir(), 'logsink-'))

test('流式解码：多字节字符被切成两半也能还原', () => {
  const dec = createUtf8Decoder()
  const full = Buffer.from('混迹B站：看完了这条视频', 'utf8')
  // 故意在第 2 个字符中间切（"混" 3 字节 ⇒ 切在 1）
  const a = dec.write(full.subarray(0, 1))
  const b = dec.write(full.subarray(1, 4))
  const c = dec.write(full.subarray(4))
  const out = a + b + c + dec.end()
  assert.equal(out, '混迹B站：看完了这条视频')
  assert.ok(!out.includes('\uFFFD'), '不得出现替换字符')
})

test('流式解码：逐字节喂也不产生 U+FFFD', () => {
  const dec = createUtf8Decoder()
  const full = Buffer.from('中文不能毁', 'utf8')
  let out = ''
  for (let i = 0; i < full.length; i++) out += dec.write(full.subarray(i, i + 1))
  assert.equal(out, '中文不能毁')
})

test('keepTail：不超限原样返回，超限给截断标记', () => {
  assert.equal(keepTail('abc', 10), 'abc')
  const long = 'x'.repeat(100)
  const out = keepTail(long, 10)
  assert.ok(out.endsWith('x'.repeat(10)))
  assert.ok(out.includes('已截断 90 字符'))
})

test('rotateIfBig：未达阈值不动', () => {
  const f = join(sandbox, 'small.log')
  writeFileSync(f, 'hello', 'utf8')
  assert.equal(rotateIfBig(f, { maxBytes: 1024 }), false)
  assert.equal(readFileSync(f, 'utf8'), 'hello')
})

test('rotateIfBig：中文按字节保留，.old 不超过 keepBytes', () => {
  const f = join(sandbox, 'big.log')
  const line = '混迹B站一轮日志，中文占三字节。\n'
  writeFileSync(f, line.repeat(200), 'utf8')
  const before = statSync(f).size
  assert.equal(rotateIfBig(f, { maxBytes: 1024, keepBytes: 2048 }), true)
  assert.equal(statSync(f).size, 0, '主文件应清空')
  assert.ok(existsSync(`${f}.old`), '.old 应存在')
  const kept = statSync(`${f}.old`).size
  assert.ok(kept <= 2048, `.old 应 ≤ keepBytes，实际 ${kept}`)
  // 保留的是完整的行（不切半个字符）
  const text = readFileSync(`${f}.old`, 'utf8')
  assert.ok(!text.includes('\uFFFD'), '不得从多字节字符中间切')
  assert.ok(text.endsWith('\n'), '应以整行结尾')
  assert.ok(before > kept)
})

test('rotateIfBig：连续两次轮转，两代归档都在（W0-1 T1）', () => {
  const f = join(sandbox, 'gen.log')
  const first = '第一轮日志，中文三字节。\n'
  const second = '第二轮日志，中文三字节。\n'
  writeFileSync(f, first.repeat(200), 'utf8')
  assert.equal(rotateIfBig(f, { maxBytes: 1024, keepBytes: 1024 }), true)
  writeFileSync(f, second.repeat(200), 'utf8')
  assert.equal(rotateIfBig(f, { maxBytes: 1024, keepBytes: 1024 }), true)

  assert.ok(existsSync(`${f}.old`), '第一代 .old 应存在')
  assert.ok(existsSync(`${f}.old.1`), '第二代 .old.1 应存在（旧实现只保一代）')
  assert.ok(!existsSync(`${f}.old.2`), '默认只保 2 代，不该有 .old.2')
  const newest = readFileSync(`${f}.old`, 'utf8')
  const older = readFileSync(`${f}.old.1`, 'utf8')
  assert.ok(newest.includes('第二轮日志'), '.old 应是最新一次轮转的内容')
  assert.ok(older.includes('第一轮日志'), '.old.1 应是上一次轮转的内容')
  assert.ok(!newest.includes('第一轮日志'), '两代不能是同一份')
})

test('rotateIfBig：第三次轮转淘汰最老的一代（仍只留 2 份）', () => {
  const f = join(sandbox, 'gen3.log')
  const rounds = ['A轮日志内容\n', 'B轮日志内容\n', 'C轮日志内容\n']
  for (const r of rounds) {
    writeFileSync(f, r.repeat(300), 'utf8')
    assert.equal(rotateIfBig(f, { maxBytes: 1024, keepBytes: 900 }), true)
  }
  assert.ok(readFileSync(`${f}.old`, 'utf8').includes('C轮'))
  assert.ok(readFileSync(`${f}.old.1`, 'utf8').includes('B轮'))
  assert.ok(!existsSync(`${f}.old.2`), '不该堆积第三代')
})

test('rotateIfBig：generations=1 时退回旧行为（只有 .old）', () => {
  const f = join(sandbox, 'gen1.log')
  writeFileSync(f, '混迹B站\n'.repeat(400), 'utf8')
  assert.equal(rotateIfBig(f, { maxBytes: 1024, keepBytes: 900, generations: 1 }), true)
  assert.ok(existsSync(`${f}.old`))
  assert.ok(!existsSync(`${f}.old.1`), 'generations=1 不滚动世代')
})

test('createProbeLogger：同结论只记一次，变化才记', () => {
  const lines = []
  const probe = createProbeLogger((m) => lines.push(m), { label: 'dshBin 探测' })
  assert.equal(probe('C:/a.js'), true)
  assert.equal(probe('C:/a.js'), false)
  assert.equal(probe('C:/a.js'), false)
  assert.equal(probe(''), true)
  assert.equal(probe(''), false)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('C:/a.js'))
  assert.ok(lines[1].includes('未找到'))
})
