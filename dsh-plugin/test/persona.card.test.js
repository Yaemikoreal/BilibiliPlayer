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
