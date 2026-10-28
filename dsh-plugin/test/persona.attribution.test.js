/**
 * 人设注入归因（W2-1）：persona-inject 事件 → 账本 → 轮末盘点 → 概览页头。
 *
 * 背景：`personaTag` 以前只在内存里返回，唯一落点是会被删掉的 pending-usage.json，
 * 于是「这轮吃了哪版人设、超没超预算、砍了谁」三处在任何地方都查不到。
 * 这组用例把这条链钉住：**编译结果 → 事件 → 聚合 → 概览字段**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PERSONA_EVENT, buildPersonaInjectEvent, layersFromStats, hitsFromUsed,
  personaInjectOf, lastPersonaInject, describePersonaInject,
} from '../lib/persona/attribution.js'
import { roundAccounting, lastRoundFrom } from '../lib/round.js'
import { buildOverview } from '../lib/overview.js'

/** 一份典型的人设编译结果（字段与 resolvePersona 的 card 分支一致）。 */
const cardPersona = (over = {}) => ({
  mode: 'card',
  personaTag: 'whale@2.0.0',
  stats: {
    total: 1551,
    totalMax: 3000,
    overTotal: false,
    over: [],
    per: [
      { name: 'core', len: 1010, max: 1500 },
      { name: 'lore', len: 195, max: 300 },
      { name: 'state', len: 157, max: 500 },
      { name: 'samples', len: 72, max: 450 },
      { name: 'tail', len: 117, max: 250 },
    ],
  },
  notes: [],
  used: { loreIds: ['night-owl'], canonKeys: ['问是不是 AI'], expressionIds: ['reaction#1'] },
  ...over,
})

test('legacy / missing 不产出事件（账本只记卡链路）', () => {
  assert.equal(buildPersonaInjectEvent({ round: 'r1', personaRes: { mode: 'legacy' } }), null)
  assert.equal(buildPersonaInjectEvent({ round: 'r1', personaRes: { mode: 'missing' } }), null)
  assert.equal(buildPersonaInjectEvent({ round: 'r1' }), null)
})

test('card 链路：事件带 tag / 五块 / 命中 / 降级 / 守卫', () => {
  const ev = buildPersonaInjectEvent({
    round: 'r1',
    t: '2026-10-28T01:00:00.000Z',
    personaRes: cardPersona(),
    guard: { level: 'warn', len: 21000, softMax: 20000, hardMax: 24000 },
    degraded: ['lore:shrink'],
  })
  assert.equal(ev.type, PERSONA_EVENT)
  assert.equal(ev.round, 'r1')
  assert.equal(ev.personaTag, 'whale@2.0.0')
  assert.equal(ev.channel, 'c1')
  assert.equal(ev.layers.length, 5)
  assert.equal(ev.layers[0].name, 'core')
  assert.equal(ev.layers[0].chars, 1010)
  assert.equal(ev.layers[0].max, 1500)
  assert.equal(ev.total, 1551)
  assert.deepEqual(ev.degraded, ['lore:shrink'])
  assert.equal(ev.guard.level, 'warn')
  assert.deepEqual(ev.hits.map((h) => `${h.kind}:${h.id}`), [
    'lore:night-owl', 'canon:问是不是 AI', 'expression:reaction#1',
  ])
  assert.equal(ev.t, '2026-10-28T01:00:00.000Z')
})

test('缺字段时给安全缺省（不抛、不产出 undefined 字段）', () => {
  const ev = buildPersonaInjectEvent({ round: 'r2', personaRes: { mode: 'card' } })
  assert.deepEqual(ev.layers, [])
  assert.deepEqual(ev.hits, [])
  assert.deepEqual(ev.degraded, [])
  assert.equal(ev.personaTag, '')
  assert.equal(ev.total, 0)
  assert.equal(ev.guard, null)
})

test('layersFromStats / hitsFromUsed：脏输入不炸', () => {
  assert.deepEqual(layersFromStats(null), [])
  assert.deepEqual(hitsFromUsed(null), [])
  assert.deepEqual(layersFromStats({ per: [{ name: 'core', len: '12', max: '20' }] }), [{ name: 'core', chars: 12, max: 20 }])
})

test('personaInjectOf 只认本轮，lastPersonaInject 取最新', () => {
  const a = buildPersonaInjectEvent({ round: 'r1', t: '2026-10-28T01:00:00.000Z', personaRes: cardPersona() })
  const b = buildPersonaInjectEvent({ round: 'r2', t: '2026-10-28T02:00:00.000Z', personaRes: cardPersona({ personaTag: 'elaina@2.0.0' }) })
  const events = [a, { type: 'comment', round: 'r2', t: '2026-10-28T02:01:00.000Z' }, b]
  assert.equal(personaInjectOf(events, 'r1').personaTag, 'whale@2.0.0')
  assert.equal(personaInjectOf(events, 'r2').personaTag, 'elaina@2.0.0')
  assert.equal(personaInjectOf(events, 'r9'), null)
  assert.equal(lastPersonaInject(events).personaTag, 'elaina@2.0.0')
  assert.equal(lastPersonaInject([]), null)
})

test('describePersonaInject：一行说清"吃了什么 + 降级了没"', () => {
  const ev = buildPersonaInjectEvent({ round: 'r1', personaRes: cardPersona() })
  const line = describePersonaInject(ev)
  assert.match(line, /^人设：whale@2\.0\.0（core 1010 \/ lore 195 \/ state 157 \/ samples 72 \/ tail 117 · 合计 1551 \/ 3000；降级：无）$/)
  assert.match(describePersonaInject({ ...ev, degraded: ['lore:shrink', 'samples:half'] }), /降级：lore:shrink、samples:half/)
  assert.equal(describePersonaInject(null), '')
})

/* ───────── 端到端：事件进账本 ⇒ 轮末盘点 ⇒ 概览字段 ───────── */

test('roundAccounting：从账本认出本轮注入的人设', () => {
  const events = [
    { t: '2026-10-28T01:00:00.000Z', round: 'r1', type: 'view', bvid: 'BV1' },
    buildPersonaInjectEvent({ round: 'r1', t: '2026-10-28T01:00:01.000Z', personaRes: cardPersona() }),
    { t: '2026-10-28T01:05:00.000Z', round: 'r1', type: 'round-end', code: 0, durationMs: 300000 },
  ]
  const acc = roundAccounting(events, 'r1')
  assert.equal(acc.personaTag, 'whale@2.0.0')
  assert.equal(acc.personaInject.layers.length, 5)
  // 没有注入记录的轮次：空串，不抛
  assert.equal(roundAccounting(events, 'r-none').personaTag, '')
  assert.equal(roundAccounting(events, 'r-none').personaInject, null)
})

test('lastRoundFrom / buildOverview：概览页头能读到 personaTag', () => {
  const events = [
    { t: '2026-10-28T01:00:00.000Z', round: 'r1', type: 'view', bvid: 'BV1' },
    buildPersonaInjectEvent({ round: 'r1', t: '2026-10-28T01:00:01.000Z', personaRes: cardPersona() }),
    { t: '2026-10-28T01:05:00.000Z', round: 'r1', type: 'round-end', code: 0, durationMs: 300000 },
  ]
  const last = lastRoundFrom(events)
  assert.equal(last.personaTag, 'whale@2.0.0')

  const ov = buildOverview({ cfg: { perDay: 10 }, state: {}, events })
  assert.equal(ov.round.personaTag, 'whale@2.0.0', '概览 round 块必须有 personaTag')
  assert.equal(ov.quota.perRound.personaTag, 'whale@2.0.0')
  assert.ok(Array.isArray(ov.round.personaInject.layers))
})

test('概览：没有注入记录时 personaTag 是空串而不是 undefined（页面不用额外判空）', () => {
  const ov = buildOverview({ cfg: {}, state: {}, events: [{ t: '2026-10-28T01:00:00.000Z', round: 'r1', type: 'view', bvid: 'BV1' }] })
  assert.equal(ov.round.personaTag, '')
  assert.equal(ov.quota.perRound.personaTag, '')
  assert.equal(ov.round.personaInject, null)
  const empty = buildOverview({ cfg: {}, state: {}, events: [] })
  assert.equal(empty.round.personaTag, '')
})
