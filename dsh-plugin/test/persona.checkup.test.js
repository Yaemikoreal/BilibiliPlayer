/**
 * 人设体检 / 换卡对比（W5-2 + W5 客户端数据面）的纯函数测试。
 *
 * 这一组用例钉住三件事：
 *   ① 体检口径 = §8.2 的固定基线 + 最近窗口内自己的 comment/dynamic（数据不足不下结论）；
 *   ② 换卡对比 = 按 persona-inject 的 personaTag 分组、评论按所在 round 归属、likes 求和；
 *   ③ 两个模块都是纯函数：同样输入同样输出、不改入参、不读真实时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import {
  buildCheckup, avoidWordsOf, CHECKUP_BASELINE, CHECKUP_THRESHOLDS, CHECKUP_MIN_SAMPLES,
} from '../lib/persona/checkup.js'
import { buildTagStats } from '../lib/persona/tagstats.js'
import { PERSONA_EVENT } from '../lib/persona/attribution.js'

const NOW = '2026-10-28T12:00:00.000Z'
const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

const comment = (t, text, extra = {}) => ({ t, type: 'comment', bvid: 'BV1xrnz6gEVD', text, ...extra })

/** 8 条「贴着基线」的发言：中位 26.5 字 / 句号 0.125 / 表情 37.5% / 问号 12.5%。 */
const BASELINE_LIKE = [
  comment('2026-10-28T00:00:00.000Z', '一'.repeat(19) + '😀'),      // 20 字 · 表情
  comment('2026-10-28T00:10:00.000Z', '一'.repeat(21) + '😀'),      // 22 字 · 表情
  comment('2026-10-28T00:20:00.000Z', '一'.repeat(25) + '😀'),      // 26 字 · 表情
  comment('2026-10-28T00:30:00.000Z', '一'.repeat(26)),             // 26 字
  comment('2026-10-28T00:40:00.000Z', '一'.repeat(27)),             // 27 字
  comment('2026-10-28T00:50:00.000Z', '一'.repeat(28)),             // 28 字
  comment('2026-10-28T01:00:00.000Z', '一'.repeat(29) + '。'),      // 30 字 · 1 个句号
  comment('2026-10-28T01:10:00.000Z', '一'.repeat(31) + '？'),      // 32 字 · 问号
]

/* ══════════════════ ① buildCheckup：口径与两态 ══════════════════ */

test('checkup：基线是 §8.2 固定常量（27 / 0.109 / 0.417 / 0.126）', () => {
  assert.deepEqual({ ...CHECKUP_BASELINE }, {
    medianChars: 27, periodPerComment: 0.109, emojiRatio: 0.417, questionRatio: 0.126,
  })
  assert.equal(CHECKUP_MIN_SAMPLES, 5)
  // 阈值必须是「稳健」的：warn 阈值先于 bad 触发（warn 区间包住 bad 区间）
  assert.ok(CHECKUP_THRESHOLDS.medianChars.warnHigh < CHECKUP_THRESHOLDS.medianChars.badHigh)
  assert.ok(CHECKUP_THRESHOLDS.medianChars.warnLow > CHECKUP_THRESHOLDS.medianChars.badLow)
  for (const k of ['periodPerComment', 'emojiRatio', 'questionRatio']) {
    assert.ok(CHECKUP_THRESHOLDS[k].warnDelta < CHECKUP_THRESHOLDS[k].badDelta, k)
  }
})

test('checkup：空数据 → n=0、指标全 0、ok + 数据不足、samples 空', () => {
  const r = buildCheckup({ events: [], now: NOW })
  assert.equal(r.n, 0)
  assert.equal(r.windowDays, 14)
  assert.deepEqual(r.metrics, { medianChars: 0, periodPerComment: 0, emojiRatio: 0, questionRatio: 0, avoidHits: 0 })
  assert.equal(r.verdict.level, 'ok')
  assert.match(r.verdict.reasons.join(''), /数据不足/)
  assert.deepEqual(r.samples, [])
  assert.deepEqual({ ...r.baseline }, { ...CHECKUP_BASELINE })
  // events / now 都缺省也不能抛
  assert.equal(buildCheckup({}).n, 0)
  assert.equal(buildCheckup().verdict.level, 'ok')
})

test('checkup：数据不足（n<5）不下结论，只报数据不足', () => {
  const r = buildCheckup({
    events: [0, 1, 2].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(200))),
    now: NOW,
  })
  assert.equal(r.n, 3)
  assert.equal(r.verdict.level, 'ok')          // 哪怕中位字数 200 也不判 warn
  assert.match(r.verdict.reasons.join(''), /数据不足（最近 3 条/)
})

test('checkup：贴近基线 → ok 且没有偏离原因', () => {
  const r = buildCheckup({ events: BASELINE_LIKE, now: NOW })
  assert.equal(r.n, 8)
  assert.equal(r.metrics.medianChars, 26.5)
  assert.equal(r.metrics.periodPerComment, 0.125)
  assert.equal(r.metrics.emojiRatio, 0.375)
  assert.equal(r.metrics.questionRatio, 0.125)
  assert.equal(r.verdict.level, 'ok')
  assert.deepEqual(r.verdict.reasons, [])
})

test('checkup：单边阈值 —— 中位字数偏长 warn / 严重偏长 bad（低侧对称）', () => {
  const long = (n) => [0, 1, 2, 3, 4].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(n)))
  const warn = buildCheckup({ events: long(45), now: NOW })       // 45/27 = 1.67×
  assert.equal(warn.verdict.level, 'warn')
  assert.match(warn.verdict.reasons.join(''), /中位字数/)
  const bad = buildCheckup({ events: long(65), now: NOW })        // 65/27 = 2.41×
  assert.equal(bad.verdict.level, 'bad')
  const short = buildCheckup({ events: long(10), now: NOW })      // 10/27 = 0.37×
  assert.equal(short.verdict.level, 'bad')
  assert.match(short.verdict.reasons.join(''), /中位字数/)
})

test('checkup：表情占比单边拉满 → bad；只有一处轻微偏离 → warn', () => {
  const allEmoji = [0, 1, 2, 3, 4].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(26) + '😀'))
  const bad = buildCheckup({ events: allEmoji, now: NOW })
  assert.equal(bad.metrics.emojiRatio, 1)
  assert.equal(bad.verdict.level, 'bad')
  assert.match(bad.verdict.reasons.join(''), /表情占比/)

  // 只有 3/5 带表情（60% vs 41.7%，Δ=0.183 < 0.22）⇒ 不偏离；4/5=80%，Δ=0.383 > 0.22 ⇒ warn
  const mild = [0, 1, 2, 3, 4].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(26) + (i < 3 ? '😀' : '')))
  assert.equal(buildCheckup({ events: mild, now: NOW }).verdict.level, 'ok')
  const warn = [0, 1, 2, 3, 4].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(26) + (i < 4 ? '😀' : '')))
  const r = buildCheckup({ events: warn, now: NOW })
  assert.equal(r.verdict.level, 'warn')
  assert.match(r.verdict.reasons.join(''), /表情占比/)
})

test('checkup：voice.avoid.* 命中 —— 1 条 warn、命中率 ≥20% bad', () => {
  const card = { voice: { avoid: { aiCues: ['显然'], bookish: ['综上所述'], bannedWords: [] } } }
  assert.deepEqual(avoidWordsOf(card), ['显然', '综上所述'])
  assert.deepEqual(avoidWordsOf(null), [])
  const mk = (hits) => [0, 1, 2, 3, 4].map((i) => comment(
    `2026-10-28T0${i}:00:00.000Z`, '一'.repeat(26) + (i < hits ? '显然' : ''),
  ))
  const one = buildCheckup({ events: mk(1), now: NOW, card })
  assert.equal(one.metrics.avoidHits, 0.2)
  assert.equal(one.verdict.level, 'warn')
  assert.match(one.verdict.reasons.join(''), /禁用词命中 1\/5/)
  const two = buildCheckup({ events: mk(2), now: NOW, card })
  assert.equal(two.metrics.avoidHits, 0.4)
  assert.equal(two.verdict.level, 'bad')
  // 没有卡 ⇒ 禁用词恒 0，不误报
  assert.equal(buildCheckup({ events: mk(2), now: NOW }).metrics.avoidHits, 0)
})

test('checkup：时间窗 + limit 截断（近 20 条），旧事件不进指标/样本', () => {
  const recent = [0, 1, 2, 3].map((i) => comment(`2026-10-28T0${i}:00:00.000Z`, '一'.repeat(20)))
  const olds = [0, 1].map((i) => comment(`2026-09-01T0${i}:00:00.000Z`, 'OLD'.repeat(60)))
  const r = buildCheckup({ events: [...olds, ...recent], now: NOW, windowDays: 14 })
  assert.equal(r.n, 4)
  assert.equal(r.metrics.medianChars, 20)
  assert.ok(r.samples.every((s) => !s.text.startsWith('OLD')))
  // 窗口拉远：旧事件回来，且 limit 只留最近的 N 条
  const wide = buildCheckup({ events: [...olds, ...recent], now: NOW, windowDays: 90, limit: 3 })
  assert.equal(wide.n, 3)
  assert.equal(wide.samples.length, 3)
  assert.match(wide.samples[0].t, /2026-10-28/)
  // 窗口外全部出局
  const far = buildCheckup({ events: recent, now: '2027-06-01T00:00:00.000Z', windowDays: 14 })
  assert.equal(far.n, 0)
})

test('checkup：dynamic 也计入；空文本忽略；纯函数且不改入参', () => {
  const events = [
    comment('2026-10-28T00:00:00.000Z', '一'.repeat(20)),
    { t: '2026-10-28T00:10:00.000Z', type: 'dynamic', bvid: 'BV1', text: '二'.repeat(30) },
    comment('2026-10-28T00:20:00.000Z', '   '),
    { t: '2026-10-28T00:30:00.000Z', type: 'view', bvid: 'BV1' },
  ]
  const before = JSON.stringify(events)
  const a = buildCheckup({ events, now: NOW })
  const b = buildCheckup({ events, now: NOW })
  assert.equal(a.n, 2)
  assert.equal(a.metrics.medianChars, 25)
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(events), before)
})

/* ══════════════════ ② buildTagStats：分组与归属 ══════════════════ */

test('tagstats：空账本 / 无注入 → tags: []', () => {
  assert.deepEqual(buildTagStats({ events: [] }), { tags: [] })
  assert.deepEqual(buildTagStats({}), { tags: [] })
  assert.deepEqual(buildTagStats({ events: [comment('2026-10-28T00:00:00.000Z', '没有归因')] }), { tags: [] })
})

test('tagstats：按 personaTag 分组的 rounds / lastAt / likes / samples', () => {
  const events = [
    { t: '2026-10-01T00:00:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'whale@2.0.0' },
    comment('2026-10-01T01:00:00.000Z', 'A', { round: 'r1', likes: 5 }),
    comment('2026-10-01T02:00:00.000Z', 'B', { round: 'r1', likes: 2 }),
    { t: '2026-10-02T00:00:00.000Z', round: 'r2', type: PERSONA_EVENT, personaTag: 'whale@2.0.0' },
    comment('2026-10-02T01:00:00.000Z', 'C', { round: 'r2' }),
    { t: '2026-10-03T00:00:00.000Z', round: 'r3', type: PERSONA_EVENT, personaTag: 'elaina@2.0.0' },
    comment('2026-10-03T01:00:00.000Z', 'D', { round: 'r3', likes: 7 }),
  ]
  const r = buildTagStats({ events })
  assert.equal(r.tags.length, 2)
  const elaina = r.tags[0]
  assert.equal(elaina.personaTag, 'elaina@2.0.0')         // lastAt 最近的在最前
  assert.deepEqual({ rounds: elaina.rounds, lastAt: elaina.lastAt, likes: elaina.likes },
    { rounds: 1, lastAt: '2026-10-03T01:00:00.000Z', likes: 7 })
  assert.deepEqual(elaina.samples.map((s) => s.text), ['D'])
  const whale = r.tags[1]
  assert.equal(whale.personaTag, 'whale@2.0.0')
  assert.equal(whale.rounds, 2)
  assert.equal(whale.likes, 7)                             // 5 + 2 + 0
  assert.deepEqual(whale.samples.map((s) => s.text), ['C', 'B', 'A'])  // 近 → 远
  assert.deepEqual(whale.samples[0], { bvid: 'BV1xrnz6gEVD', text: 'C', t: '2026-10-02T01:00:00.000Z', likes: 0 })
})

test('tagstats：没有 persona-inject 的 round 里的评论不猜归属', () => {
  const events = [
    { t: '2026-10-01T00:00:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'whale@2.0.0' },
    comment('2026-10-01T01:00:00.000Z', '有归属', { round: 'r1', likes: 3 }),
    comment('2026-10-02T01:00:00.000Z', '没归属', { round: 'rX', likes: 99 }),
  ]
  const r = buildTagStats({ events })
  assert.equal(r.tags.length, 1)
  assert.equal(r.tags[0].likes, 3)
  assert.deepEqual(r.tags[0].samples.map((s) => s.text), ['有归属'])
})

test('tagstats：同轮多条注入取最新 tag；limitPerTag / maxTags 截断', () => {
  const events = [
    { t: '2026-10-01T00:00:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'old@1.0.0' },
    { t: '2026-10-01T00:05:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'new@2.0.0' },
    comment('2026-10-01T01:00:00.000Z', '归到 new', { round: 'r1', likes: 4 }),
    // 另外两组，用于 maxTags
    { t: '2026-10-04T00:00:00.000Z', round: 'r4', type: PERSONA_EVENT, personaTag: 'tag-b@2.0.0' },
    { t: '2026-10-05T00:00:00.000Z', round: 'r5', type: PERSONA_EVENT, personaTag: 'tag-c@2.0.0' },
  ]
  const r = buildTagStats({ events, maxTags: 2 })
  assert.deepEqual(r.tags.map((x) => x.personaTag), ['tag-c@2.0.0', 'tag-b@2.0.0'])
  const full = buildTagStats({ events, maxTags: 8 })
  const newTag = full.tags.find((x) => x.personaTag === 'new@2.0.0')
  assert.equal(newTag.likes, 4)
  assert.equal(full.tags.find((x) => x.personaTag === 'old@1.0.0').samples.length, 0)

  // limitPerTag：同一组 4 条评论，默认 3 条、显式 2 条
  const many = [{ t: '2026-10-01T00:00:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'w@2.0.0' }]
  for (let i = 0; i < 4; i++) many.push(comment(`2026-10-01T0${i + 1}:00:00.000Z`, 'T' + i, { round: 'r1' }))
  assert.deepEqual(buildTagStats({ events: many }).tags[0].samples.map((s) => s.text), ['T3', 'T2', 'T1'])
  assert.deepEqual(buildTagStats({ events: many, limitPerTag: 2 }).tags[0].samples.map((s) => s.text), ['T3', 'T2'])
})

test('tagstats：纯函数 —— 两次调用同结果、不改入参', () => {
  const events = [
    { t: '2026-10-01T00:00:00.000Z', round: 'r1', type: PERSONA_EVENT, personaTag: 'whale@2.0.0' },
    comment('2026-10-01T01:00:00.000Z', 'A', { round: 'r1', likes: 1 }),
  ]
  const before = JSON.stringify(events)
  const a = buildTagStats({ events })
  const b = buildTagStats({ events })
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(events), before)
})

/* ══════════════════ ③ W4-4 客户端 GET 复用（client.js，vm 直载） ══════════════════ */

test('client.js：同一 GET key 30s 内不重复打请求，页面隐藏时暂停', async () => {
  const code = readFileSync(join(pluginDir, 'client.js'), 'utf8')
  const calls = []
  let def = null
  const sandbox = {
    // client.js 的测试钩子只在 __BF_TEST__ 沙箱里暴露（生产包不带这个全局面）
    __BF_TEST__: true,
    window: { __ModuleLoader__: { load: (d) => { def = d } } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { hidden: false },
    navigator: {},
    fetch: async (url) => {
      calls.push(String(url))
      return { json: async () => ({ ok: true, url: String(url) }) }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  assert.ok(def && typeof def.factory === 'function', 'client.js 未注册')
  const plugin = def.factory(() => ({}))          // 只取 __bfTest，不需要真 React
  const t = plugin.__bfTest
  assert.ok(t && typeof t.cachedGet === 'function', 'client.js 没暴露 __bfTest.cachedGet')

  t.resetGetCache()
  const c0 = calls.length
  await t.cachedGet('/persona')
  await t.cachedGet('/persona')
  await t.cachedGet('/persona/preview')
  await t.cachedGet('/persona')
  assert.deepEqual(calls.slice(c0), ['/api/bili-fenshen/persona', '/api/bili-fenshen/persona/preview'])

  // 过期（把 at 拨回 31s 前）后允许重打
  t.GET_CACHE.get('/persona').at = Date.now() - (t.GET_TTL_MS + 1000)
  await t.cachedGet('/persona')
  assert.equal(calls.length - c0, 3)

  // 页面隐藏：即使过期也不发新请求（复用旧 promise / 无缓存回 null）
  t.GET_CACHE.get('/persona').at = Date.now() - (t.GET_TTL_MS + 1000)
  sandbox.document.hidden = true
  const hiddenBefore = calls.length
  const stale = await t.cachedGet('/persona')
  assert.equal(stale.ok, true)                    // 复用旧值而不是空
  assert.equal(calls.length, hiddenBefore)
  const noCache = await t.cachedGet('/persona/never-fetched')
  assert.equal(noCache, null)
  assert.equal(calls.length, hiddenBefore)
  sandbox.document.hidden = false
})
