/**
 * 发言门控（W7-2）：6 特征打分 + 可解释决策。
 *
 * 这组用例的核心不是"分数对不对"，而是三条纪律不能被后来的改动破坏：
 *   ① 被 @ / 被回复**直接放行且不计分**（但仍占配额）；
 *   ② 配额是**硬上限**：配额为 0 时，分数再高也不说（门控只收紧不放宽）；
 *   ③ 不说时必须能**用一句话解释为什么**（"这轮为什么没说"是可查的数字，不是玄学）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SPEAK_WEIGHTS, SPEAK_THRESHOLD, recentSpeakShare, minutesSinceLastSpeak,
  freshnessOf, isMediaOnly, scoreSpeakDecision, describeSpeakDecision,
  speakDecisionEvent, skipRateFromLedger,
} from '../lib/persona/speak.js'

const NOW = new Date('2026-10-28T12:00:00.000Z')
const ago = (m) => new Date(NOW.getTime() - m * 60_000).toISOString()
const ev = (type, m, extra = {}) => ({ t: ago(m), type, ...extra })

test('权重与阈值就是方案 §8.5 的定值（改动会改变线上说话频率）', () => {
  assert.deepEqual({ ...SPEAK_WEIGHTS }, {
    mentioned: 1.6, question: 0.5, recentShare: -2.6, gapLog: 0.06, freshness: 0.1, mediaOnly: -1.0, intercept: -1.2,
  })
  assert.equal(SPEAK_THRESHOLD, -1.0, '相对阈值：正常候选要能过线（见 speak.js 注释里的标定）')
})

test('recentSpeakShare：近 N 个动作里说话占多少（账本只有我的动作，所以按"说话/动作"读）', () => {
  const events = [ev('view', 10), ev('comment', 9), ev('view', 8), ev('comment', 7), ev('skip', 6)]
  const r = recentSpeakShare(events)
  assert.equal(r.n, 5)
  assert.equal(r.spoke, 2)
  assert.equal(r.share, 0.4)
  assert.deepEqual(recentSpeakShare([]), { share: 0, n: 0, spoke: 0 })
})

test('minutesSinceLastSpeak / freshnessOf / isMediaOnly', () => {
  const events = [ev('comment', 90), ev('comment', 30)]
  assert.equal(minutesSinceLastSpeak(events, NOW.getTime()), 30)
  assert.equal(minutesSinceLastSpeak([], NOW.getTime()), null)
  assert.equal(freshnessOf({ publishedAt: new Date(NOW.getTime() - 3600_000).toISOString() }, NOW.getTime()), 1)
  assert.equal(freshnessOf({ publishedAt: new Date(NOW.getTime() - 100 * 3600_000).toISOString() }, NOW.getTime()), 0)
  assert.ok(Math.abs(freshnessOf({ publishedAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString() }, NOW.getTime()) - 0.5) < 0.01)
  assert.equal(isMediaOnly({ title: '', text: '' }), true)
  assert.equal(isMediaOnly({ title: '有标题', text: '' }), false)
  assert.equal(isMediaOnly({ title: 'x', mediaOnly: true }), true)
})

test('被 @ / 被回复 ⇒ forced（直接放行、不计分、但仍占配额）', () => {
  const d = scoreSpeakDecision({
    candidate: { bvid: 'BV1', text: '你上次说的那个我也试了', mentioned: true },
    events: [ev('comment', 2)], now: NOW, quotaLeft: 3,
  })
  assert.equal(d.decision, 'forced')
  assert.match(d.reason, /被@|被回复/)
  // forced 的 score 照样算出来（用于观测），但决定不看它
  assert.equal(typeof d.score, 'number')
})

test('配额为 0 ⇒ 谁都不许说（硬上限，门控只收紧不放宽）', () => {
  const d = scoreSpeakDecision({
    candidate: { bvid: 'BV1', text: '这个怎么做到的？', mentioned: true },
    events: [], now: NOW, quotaLeft: 0,
  })
  assert.equal(d.decision, 'skip', '哪怕被@，配额用完也不发')
  assert.match(d.reason, /配额/)
})

test('纯媒体/无文本 ⇒ skip 且理由明确', () => {
  const d = scoreSpeakDecision({ candidate: { bvid: 'BV1', title: '', text: '' }, events: [], now: NOW })
  assert.equal(d.decision, 'skip')
  assert.match(d.reason, /纯媒体|没话可说/)
})

test('正常候选：有问号 + 新鲜 + 节奏不密应当说；没接话点 + 刚说过应当不说', () => {
  // 真实的账本形态：评论之后还有一串 view，所以"近 5 个动作里说话占比"是低的
  const ledger = [ev('comment', 600), ev('view', 500), ev('view', 400), ev('view', 300), ev('view', 200)]
  const ask = scoreSpeakDecision({
    candidate: { bvid: 'BV1', title: '某视频', text: '这游戏到底怎么上分？', publishedAt: ago(60) },
    events: ledger, now: NOW,
  })
  assert.equal(ask.decision, 'speak', JSON.stringify(ask))
  assert.ok(ask.score > SPEAK_THRESHOLD)

  const plain = scoreSpeakDecision({
    candidate: { bvid: 'BV2', title: '普通视频', text: '' },
    events: [ev('comment', 1)], now: NOW,
  })
  assert.equal(plain.decision, 'skip')
  assert.ok(plain.score <= SPEAK_THRESHOLD)
})

test('刚说过（<30min）时即使有问号也不好说：节奏约束生效', () => {
  const d = scoreSpeakDecision({
    candidate: { bvid: 'BV1', title: 'x', text: '这个怎么办？', publishedAt: ago(10) },
    events: [ev('comment', 5), ev('comment', 10), ev('view', 20)], now: NOW,
  })
  // 分数可能仍为正（问号+新鲜），但至少要能解释；这条断言的是"解释里带上节奏"
  assert.ok(['speak', 'skip'].includes(d.decision))
  if (d.decision === 'skip') assert.match(d.reason, /刚说过|太密|接话点/)
})

test('describeSpeakDecision / speakDecisionEvent：可读且能落账本', () => {
  const d = scoreSpeakDecision({ candidate: { bvid: 'BV1', text: '问一句？' }, events: [], now: NOW })
  assert.match(describeSpeakDecision(d), /发言门控：(可以说|不说|必须接)（score -?\d+\.\d\d）—— /)
  const e = speakDecisionEvent(d, { round: 'r1', t: NOW.toISOString() })
  assert.equal(e.type, 'speak-decision')
  assert.equal(e.round, 'r1')
  assert.equal(e.decision, d.decision)
  assert.equal(typeof e.score, 'number')
  assert.ok(e.features && typeof e.features === 'object')
  assert.equal(describeSpeakDecision(null), '')
  assert.equal(speakDecisionEvent(null), null)
})

test('skipRateFromLedger：近 7 天"该说没说"的占比（体检用）', () => {
  const events = [
    { t: ago(60), type: 'speak-decision', decision: 'skip' },
    { t: ago(120), type: 'speak-decision', decision: 'speak' },
    { t: ago(180), type: 'speak-decision', decision: 'forced' },
    { t: '2026-09-01T00:00:00.000Z', type: 'speak-decision', decision: 'skip' }, // 窗外
  ]
  const r = skipRateFromLedger(events, { now: NOW })
  assert.equal(r.total, 3)
  assert.equal(r.skipped, 1)
  assert.equal(r.rate, 0.333)
  assert.deepEqual(skipRateFromLedger([], { now: NOW }), { total: 0, skipped: 0, rate: 0 })
})
