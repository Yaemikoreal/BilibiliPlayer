/**
 * 故障注入（W3 验收要求 7 例）。
 *
 * 为什么需要：这个号是**无人值守**跑一整天的。正常路径测试再多，也不如"把文件弄坏再看它怎么办"
 * 这一句话有用 —— 真实事故全是这么来的（半截 JSON / 卡被改坏 / 规则文件丢了 / 进程秒退）。
 *
 * 纪律：**任何一处坏掉都不能让值班轮空跑或抛死**，而是
 *   ① 有明确降级（跳过坏数据、用缺省值、中性说话）；
 *   ② 有可读的错误留痕（写进 state/日志，主人能看见）。
 *
 * 本文件覆盖纯 lib 层的 5 例；涉及子进程/overlay/报告的 3 例在 W3 落地后追加（见文件末尾 TODO）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-fault-'))
process.env.BILI_FENSHEN_HOME = HOME   // store.js 的 homeDir() 是调用时读 env，所以这里设置有效

const { readEvents } = await import('../lib/ledger.js')
const { createLedgerReader } = await import('../lib/ledger-index.js')
const { loadCard, readActive } = await import('../lib/persona/store.js')
const { loadState, deriveState, saveState } = await import('../lib/persona/state.js')
const { parseRoundReport } = await import('../lib/report.js')

const P = (...xs) => join(HOME, ...xs)

/* ───────── ① 账本半截行：不能整批销掉 ───────── */

test('故障注入①：账本最后一行是半截 JSON ⇒ 丢弃半截、救回前面全部', () => {
  const f = P('ledger-half.jsonl')
  const good = [
    { t: '2026-10-28T00:00:00.000Z', round: 'r1', type: 'view', bvid: 'BV1' },
    { t: '2026-10-28T00:00:01.000Z', round: 'r1', type: 'comment', bvid: 'BV1', text: '难绷' },
  ]
  writeFileSync(f, good.map((e) => JSON.stringify(e)).join('\n') + '\n' + '{"t":"2026-10-28T00:00:02.000Z","type":"li', 'utf8')
  const events = readEvents(f)
  assert.equal(events.length, 2, '前面两条完整事件必须救回来')
  assert.ok(events.every((e) => typeof e.type === 'string'))
  // 增量读器口径必须一致（否则概览与轮末盘点会给出两个数）
  assert.deepEqual(createLedgerReader(f).read(), events)
})

test('故障注入①b：整行坏 JSON ⇒ 该行跳过，不抛', () => {
  const f = P('ledger-bad.jsonl')
  writeFileSync(f, [
    JSON.stringify({ t: '2026-10-28T00:00:00.000Z', type: 'view', bvid: 'BV1' }),
    'not json at all',
    JSON.stringify({ t: '2026-10-28T00:00:02.000Z', type: 'like', bvid: 'BV1' }),
  ].join('\n'), 'utf8')
  const events = readEvents(f)
  assert.equal(events.length, 2)
})

/* ───────── ② 卡 JSON 损坏 ⇒ 中性降级，不许把路径字符串当人设 ───────── */

test('故障注入②：人设卡 JSON 损坏 ⇒ loadCard 返回 error，不抛', () => {
  mkdirSync(P('persona'), { recursive: true })
  const broken = P('persona', 'card-broken.json')
  writeFileSync(broken, '{ "id": "whale", "version": "2.0.0", ', 'utf8') // 故意写一半
  const r = loadCard({ mode: 'file', path: broken })
  assert.equal(r.card, null)
  assert.equal(r.source, 'missing')
  assert.match(String(r.error), /读不到|不是合法 JSON/)
})

test('故障注入②b：卡文件被删 ⇒ source=missing，active 仍可读（降级不连锁）', () => {
  const gone = P('persona', 'card-gone.json')
  const r = loadCard({ mode: 'file', path: gone })
  assert.equal(r.card, null)
  assert.equal(r.source, 'missing')
  // active.json 缺失时 readActive 必须回落到默认预设，而不是返回 null
  const act = readActive()
  assert.equal(act.mode, 'preset')
  assert.ok(String(act.presetId).length > 0)
})

/* ───────── ③ state.json 半截 ⇒ 冷却表归零而不是崩 ───────── */

test('故障注入③：state.json 半截 ⇒ loadState 返回 {}（本期冷却表作废，但值班照跑）', () => {
  mkdirSync(P('persona'), { recursive: true })
  writeFileSync(P('persona', 'state.json'), '{"loreUsed": {"a": "2026-10-2', 'utf8')
  const st = loadState()
  assert.deepEqual(st, {})

  // deriveState 对空持久化必须照常工作
  const derived = deriveState({ events: [], persisted: st, now: new Date(2026, 9, 28, 12, 0) })
  assert.ok(derived.date)
  assert.deepEqual(derived.loreUsed, {})
  // 而且能重新写回一份好的
  assert.equal(saveState({ loreUsed: {} }), true)
  assert.deepEqual(loadState(), { loreUsed: {} })
})

/* ───────── ④ 报告缺失/坏文本 ⇒ 解析器不许抛 ───────── */

test('故障注入④：报告文件缺失 ⇒ parseRoundReport(空) 不抛、给空结构', () => {
  const r = parseRoundReport('')
  assert.equal(typeof r, 'object')
  assert.ok(r && typeof r === 'object')
})

test('故障注入④b：报告是半截/乱码文本 ⇒ 解析器不抛', () => {
  for (const text of ['### 本轮做了什么\n- 评论：', '\u0000\u0001 二进制坏字节 \uFFFD', 'a'.repeat(10_000)]) {
    assert.doesNotThrow(() => parseRoundReport(text))
  }
})

/* ───────── ⑤ 账本被清空（轮转）⇒ 增量读必须回退全量，不能返回旧缓存 ───────── */

test('故障注入⑤：账本被轮转清空 ⇒ 读到的就是空，不能返回上一份缓存', () => {
  const f = P('ledger-rot.jsonl')
  writeFileSync(f, JSON.stringify({ t: '2026-10-28T00:00:00.000Z', type: 'view', bvid: 'BV1' }) + '\n', 'utf8')
  const reader = createLedgerReader(f)
  assert.equal(reader.read().length, 1)
  writeFileSync(f, '', 'utf8')
  assert.deepEqual(reader.read(), [])
  assert.ok(reader.stats().fallbacks >= 1, '清空属于"变小"，要记一次 fallbacks')
  assert.equal(readFileSync(f, 'utf8'), '')
})

/* TODO（W3 落地后追加）：⑥ overlay 写失败 ⇒ 本轮中止并写 lastError；
 *                        ⑦ spawn 立即退出 ⇒ code≠0 + 不空跑；
 *                        ⑧ 规则文件缺失 ⇒ 放行 + 告警（等 W2-2 的 lint.js 落地）。 */
