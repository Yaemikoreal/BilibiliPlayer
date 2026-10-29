// 人设卡：schema 校验 + L0 六条格式判据 + 旧 markdown 迁移器
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { SPEC, validateCard, l0Checks, migrateLegacyMarkdown, injectedText } from '../lib/persona/card.js'
import { PRESETS_DIR } from '../lib/persona/store.js'
import { smokeCard } from './fixtures/persona/smoke-card.js'

const preset = (name) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url))

test('合规卡：schema 通过，L0 六条全过', () => {
  const card = smokeCard()
  const v = validateCard(card)
  assert.deepEqual(v.errors, [], `不应有错：${JSON.stringify(v.errors)}`)
  const l0 = l0Checks(card)
  assert.equal(l0.ok, true, JSON.stringify(l0.checks.filter((c) => c.level === 'fail')))
  assert.equal(l0.checks.length, 6)
})

test('schema：spec / id / version 必填且格式正确', () => {
  const card = smokeCard()
  delete card.spec
  card.id = '有 空格'
  card.version = 'v2'
  const v = validateCard(card)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.path === 'spec'))
  assert.ok(v.errors.some((e) => e.path === 'id'))
  assert.ok(v.errors.some((e) => e.path === 'version'))
})

test('schema：红线必须是三件套（不许 + 为什么 + 那要写成什么）', () => {
  const card = smokeCard()
  delete card.redlines[1].instead
  card.redlines[0].instead = '不要冒充真人' // 又以否定开头
  const v = validateCard(card)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.path === 'redlines[1].instead'))
  assert.ok(v.errors.some((e) => e.path === 'redlines[0].instead'))
})

test('schema：矛盾必须能写成 X vs Y（标签会被拒）', () => {
  const card = smokeCard()
  card.mindset.contradictions = ['傲娇']
  const v = validateCard(card)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.path.startsWith('mindset.contradictions')))
})

test('schema：手段表 <6 类、示例无来源、示例重复都要拦', () => {
  const card = smokeCard()
  card.voice.moves = ['纯情绪词', '反问']
  card.voice.samples.good[1].source = ''
  card.voice.samples.good[2].text = '难绷' // 与第 1 条重复
  const v = validateCard(card)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => e.path === 'voice.moves'))
  assert.ok(v.errors.some((e) => e.path.endsWith('.source')))
})

test('L0：词频超限会告警（签名词 >3 次）', () => {
  const card = smokeCard()
  card.signatureWords = ['测试']
  card.identity.background = '测试测试测试测试'
  const l0 = l0Checks(card)
  const freq = l0.checks.find((c) => c.id === 'word-freq')
  assert.equal(freq.level, 'warn')
  assert.match(freq.detail, /测试/)
})

test('L0：禁止句占比过高会告警/失败', () => {
  const card = smokeCard()
  const l0 = l0Checks(card, { text: '不要这样。不要那样。别这样写。不要发。不要评。' })
  const ratio = l0.checks.find((c) => c.id === 'negative-ratio')
  assert.equal(ratio.level, 'fail')
})

test('L0：示例重复会被拦', () => {
  const card = smokeCard()
  card.voice.samples.good.push({ ...card.voice.samples.good[0] })
  const l0 = l0Checks(card)
  const dup = l0.checks.find((c) => c.id === 'sample-dup')
  assert.equal(dup.level, 'fail')
})

test('injectedText 不含 creatorNotes（写给人看不烧 token）', () => {
  const card = smokeCard()
  assert.ok(!injectedText(card).includes('绝对不能被编译进 prompt'))
})

/**
 * W1-4 口径一致性：L0/injectedText 认作"已注入"的**单值字段**，其实必须真出现在编译文本里。
 *
 * 为什么只查单值字段：示例（samples）、traits/contradictions/canon/loreIndex 都是**抽样**注入
 * （3–5 条 / 前 N 条），要求逐条出现是错的；单值字段没有抽样空间，少一个就是口径分叉。
 * 这次修掉的 3 项正是：behaviorStyle.interestFirst、stance[].misread、voice.jargon.allow。
 */
test('口径一致性：L0 认作已注入的单值字段，片段必须真出现在 compilePersona().text', async () => {
  const { compilePersona } = await import('../lib/persona/compile.js')
  const { deriveState } = await import('../lib/persona/state.js')
  const now = new Date(2026, 9, 26, 15, 0)
  const card = smokeCard()
  const text = compilePersona(card, { state: deriveState({ events: [], card, now }), bank: null, roundId: 'L0' }).text

  const pairs = [
    ['identity.oneLiner', card.identity.oneLiner],
    ['identity.background', card.identity.background],
    ['identity.selfAwareness', card.identity.selfAwareness],
    ...card.identity.boundaries.map((x, i) => [`identity.boundaries[${i}]`, x]),
    ...card.voice.register.map((x, i) => [`voice.register[${i}]`, x]),
    ...card.voice.moves.map((x, i) => [`voice.moves[${i}]`, x]),
    ...card.voice.jargon.allow.map((x, i) => [`voice.jargon.allow[${i}]`, x]),
    ...Object.entries(card.voice.intensity).map(([k, x]) => [`voice.intensity.${k}`, x]),
    ...card.voice.avoid.aiCues.map((x, i) => [`voice.avoid.aiCues[${i}]`, x]),
    ...card.voice.avoid.bookish.map((x, i) => [`voice.avoid.bookish[${i}]`, x]),
    ...card.voice.avoid.bannedWords.map((x, i) => [`voice.avoid.bannedWords[${i}]`, x]),
    ['mindset.emotion.breakingPoint', card.mindset.emotion.breakingPoint],
    ...card.taste.watch.slice(0, 5).map((x, i) => [`taste.watch[${i}]`, x]),
    ...card.taste.avoid.slice(0, 5).map((x, i) => [`taste.avoid[${i}]`, x]),
    ...card.stance.slice(0, 3).flatMap((s, i) => [
      [`stance[${i}].topic`, s.topic], [`stance[${i}].attitude`, s.attitude],
      [`stance[${i}].how`, s.how], [`stance[${i}].misread`, s.misread],
    ]),
    ...card.redlines.slice(0, 4).flatMap((r, i) => [
      [`redlines[${i}].rule`, r.rule], [`redlines[${i}].instead`, r.instead],
    ]),
    ...card.canon.slice(0, 4).flatMap((c) => [['canon.when', c.when], ['canon.say', c.say]]),
    ['behaviorStyle.interestFirst', card.behaviorStyle.interestFirst],
    ['loreIndex[0].oneLine', card.loreIndex[0].oneLine],
  ]
  const missing = pairs.filter(([, frag]) => frag && !text.includes(frag)).map(([p]) => p)
  assert.deepEqual(missing, [], `L0 认作已注入、prompt 里却找不到：${missing.join('、')}`)
  // 反向：抽样字段不要求逐条（写清楚为什么，避免后人又把它改回"全量必须出现"）
  const whaleCard = JSON.parse(readFileSync(join(PRESETS_DIR, 'whale.card.json'), 'utf8'))
  assert.ok(whaleCard.voice.samples.good.length > 4, 'whale 卡样本 > 每轮注入上限，抽样注入是设计')

  // 真卡（whale）上再验一次三处真分叉
  const wtext = compilePersona(whaleCard, { state: deriveState({ events: [], card: whaleCard, now }), bank: null, roundId: 'L0' }).text
  assert.ok(wtext.includes(`低频词可用但少用：${whaleCard.voice.jargon.allow.join('、')}`), 'voice.jargon.allow 没进 P1')
  assert.ok(wtext.includes(`别误解成：${whaleCard.stance[0].misread}`), 'stance[0].misread 没进 P1 立场括号')
  assert.ok(wtext.includes(whaleCard.behaviorStyle.interestFirst), 'behaviorStyle 没进 P5 尾注')
})

test('迁移器：能拆 v1 markdown，且未识别段落进 creatorNotes + 标 needsReview', () => {
  const md = readFileSync(preset('persona-whale.md'), 'utf8')
  const { card, report } = migrateLegacyMarkdown(md, { id: 'migrated', name: '迁移测试' })
  assert.equal(card.spec, SPEC)
  assert.ok(report.mapped.length >= 5, `识别节数：${report.mapped.length}`)
  assert.ok(card.creatorNotes.length > 200, '未识别内容应进 creatorNotes')
  assert.ok(card.needsReview.includes('redlines.instead'))
  assert.ok(card.identity.oneLiner.length > 0)
})

test('内置预设卡（若已存在）必须过 schema + L0', { skip: !readdirSync(PRESETS_DIR).some((f) => f.endsWith('.card.json')) && '尚无预设卡' }, () => {
  const files = readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.card.json'))
  for (const f of files) {
    const card = JSON.parse(readFileSync(join(PRESETS_DIR, f), 'utf8'))
    const v = validateCard(card)
    assert.deepEqual(v.errors, [], `${f} schema 有错：${JSON.stringify(v.errors)}`)
    const l0 = l0Checks(card)
    assert.equal(l0.ok, true, `${f} L0 未过：${JSON.stringify(l0.checks.filter((c) => c.level === 'fail'))}`)
  }
})
