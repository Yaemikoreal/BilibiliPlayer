/**
 * 体检自纠（W7-3）：偏离判据 → 一句能照做的动作 → 下一轮 C2 注入。
 *
 * 为什么这层值得单测：`buildCheckup` 给的是数字，模型不会做那个算术；
 * 自纠必须是**动作**（"收短"）而不是**指标**（"中位 60 字"）。
 * 同时反过来也要钉住：体检正常时**一句都不许加**，否则每轮都多一行噪音。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-selfcorrect-'))
process.env.BILI_FENSHEN_HOME = HOME

const { selfCorrectFromCheckup, describeCheckup, SELF_CORRECT_MAX_CHARS } = await import('../lib/persona/selfcorrect.js')
const { buildCheckup, CHECKUP_BASELINE } = await import('../lib/persona/checkup.js')
const { resolvePersona } = await import('../lib/persona/index.js')
const { buildPersonaInjectEvent } = await import('../lib/persona/attribution.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')

const NOW = new Date('2026-10-28T12:00:00.000Z')
const at = (m) => new Date(NOW.getTime() - m * 60_000).toISOString()
const verdict = (level, reasons) => ({ verdict: { level, reasons }, metrics: {}, baseline: CHECKUP_BASELINE, n: 10 })

test('体检正常 / 数据不足 ⇒ 不产出自纠（一句都不加）', () => {
  assert.equal(selfCorrectFromCheckup(null), '')
  assert.equal(selfCorrectFromCheckup({ verdict: { level: 'ok', reasons: ['数据不足'] } }), '')
  assert.equal(selfCorrectFromCheckup(verdict('ok', [])), '')
})

test('中位字数偏高 ⇒ 收短；偏低 ⇒ 给细节', () => {
  const high = selfCorrectFromCheckup({
    ...verdict('warn', ['中位字数 60（基线 27，+122%）']),
    metrics: { medianChars: 60 },
  })
  assert.match(high, /话变长了/)
  assert.match(high, /收短/)
  assert.ok(!/\d+%/.test(high), '别把百分比丢给模型（它不会算，也只会照抄）')

  const low = selfCorrectFromCheckup({
    ...verdict('warn', ['中位字数 8（基线 27，-70%）']),
    metrics: { medianChars: 8 },
  })
  assert.match(low, /话太短了/)
  assert.match(low, /具体细节/)
})

test('句号 / 表情 / 问号 / 禁用词各自给不同动作', () => {
  // 2026-10-29 核验 §2.4 决策 ①：本号不使用句号（periodMax=0），自纠动作同步改
  assert.match(selfCorrectFromCheckup(verdict('warn', ['每条句号 0.8（基线 0.1704，偏多 0.63）'])), /一个句号都别用/)
  const lessEmoji = selfCorrectFromCheckup({ ...verdict('warn', ['表情占比 5%（基线 31%，偏离 -26%）']), metrics: { emojiRatio: 0.05 } })
  assert.match(lessEmoji, /带一个/)
  const moreEmoji = selfCorrectFromCheckup({ ...verdict('warn', ['表情占比 90%（基线 31%，偏离 +59%）']), metrics: { emojiRatio: 0.9 } })
  assert.match(moreEmoji, /别带/)
  assert.match(selfCorrectFromCheckup(verdict('warn', ['问号占比 0%（基线 7%）'])), /问一句/)
  assert.match(selfCorrectFromCheckup(verdict('bad', ['禁用词命中 3/10 条（30%）'])), /禁用/)
})

test('未知判据有兜底；任何一句话都不超过硬上限', () => {
  const fallback = selfCorrectFromCheckup(verdict('warn', ['某个未来才有的指标偏了']))
  assert.ok(fallback.length > 0)
  assert.match(fallback, /按真人随口一句/)
  const long = selfCorrectFromCheckup(verdict('warn', [`中位字数 ${'9'.repeat(80)}`]))
  assert.ok(long.length <= SELF_CORRECT_MAX_CHARS, `自纠不得超过 ${SELF_CORRECT_MAX_CHARS} 字，实际 ${long.length}`)
})

test('describeCheckup：给归因/控制台的一行摘要', () => {
  assert.equal(describeCheckup(null), '')
  assert.match(describeCheckup({ verdict: { level: 'ok', reasons: [] }, n: 12 }), /正常（近 12 条）/)
  assert.match(describeCheckup({ verdict: { level: 'warn', reasons: ['A', 'B'] }, n: 7 }), /轻微偏离（近 7 条）—— A；B/)
  assert.match(describeCheckup({ verdict: { level: 'bad', reasons: ['A'] }, n: 7 }), /明显偏离/)
})

/* ───────── 端到端：真实事件 → buildCheckup → 自纠 → 注入 C2 ───────── */

const longComment = (i) => ({
  // 60 字左右、句号多、无表情、无问号 ⇒ 中位字数/句号/表情/问号四项都会偏离
  t: at(i + 1),
  type: 'comment',
  bvid: `BVw${i}`,
  round: 'r1',
  text: '这条评论我写了很长的一段话，目的就是让中位字数明显高于基线，而且还塞了两个句号。第二个句子继续拖长，把整体字数顶上去。',
})

test('端到端：体检超阈值 ⇒ 下一轮 C2 里有一条自纠行', () => {
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')

  const events = Array.from({ length: 8 }, (_, i) => longComment(i))
  const checkup = buildCheckup({ events, now: NOW, card })
  assert.notEqual(checkup.verdict.level, 'ok', '前置：这组事件应当判偏离')

  const r = resolvePersona({ cfg: { personaPrompt: '' }, events, roundId: 'R', now: NOW })
  assert.equal(r.mode, 'card')
  assert.ok(r.checkup, '门面应回传体检结论')
  assert.notEqual(r.checkup.level, 'ok')
  assert.ok(r.checkup.selfCorrect.length > 0)
  assert.match(r.after, /⚠️ 你最近/, '自纠必须以 ⚠️ 起头且说的是"你"（与欠账行的 ⚠️ 区分开）')
  assert.ok(r.after.includes(r.checkup.selfCorrect), '自纠原文必须真的进 C2')
  // 位置纪律：自纠是"状态"，不能进 C1
  assert.ok(!r.before.includes(r.checkup.selfCorrect), '自纠不能进 C1')

  // 归因事件里要能查到（"为什么这轮被要求收短"）
  const ev = buildPersonaInjectEvent({ round: 'R', personaRes: r })
  assert.equal(ev.checkup.level, r.checkup.level)
  assert.equal(ev.checkup.selfCorrect, r.checkup.selfCorrect)
})

test('端到端：体检正常（数据不足）⇒ C2 里没有自纠行', () => {
  const card = smokeCard()
  const events = [longComment(0)]
  const r = resolvePersona({ cfg: { personaPrompt: '' }, events, roundId: 'R2', now: NOW })
  assert.equal(r.checkup.level, 'ok', '1 条数据不足，体检应判 ok')
  assert.equal(r.checkup.selfCorrect, '')
  // 注意：状态段本来就有「⚠️ 欠账提醒」，所以这里只断言**自纠那种句式**不出现
  assert.ok(!/⚠️ 你最近/.test(r.after), '正常时不许加自纠行')
})
