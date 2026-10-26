// 门面与存储：播种、legacy 直通、卡模式、缺失降级、保存与版本、预算守卫
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'bf-persona-home-'))
process.env.BILI_FENSHEN_HOME = HOME

const {
  resolvePersona, previewPersona, personaHealth, seedIfEmpty, readActive, writeActive,
  loadCard, saveCard, listVersions, guardPrompt,
} = await import('../lib/persona/index.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')

const whalePath = fileURLToPath(new URL('../prompts/persona-whale.md', import.meta.url))

test('播种：空家目录 ⇒ 默认 preset:whale（开箱即用）', () => {
  const r = seedIfEmpty({ legacyPrompt: '' })
  assert.equal(r.seeded, true)
  assert.equal(readActive().mode, 'preset')
  assert.equal(readActive().presetId, 'whale')
  const again = seedIfEmpty({ legacyPrompt: '' })
  assert.equal(again.seeded, false)
  assert.equal(again.reason, 'already-configured')
})

test('播种：配置了旧 personaPrompt 就不覆盖（legacy 优先）', () => {
  const home2 = mkdtempSync(join(tmpdir(), 'bf-persona-home2-'))
  const old = process.env.BILI_FENSHEN_HOME
  process.env.BILI_FENSHEN_HOME = home2
  try {
    const r = seedIfEmpty({ legacyPrompt: whalePath })
    assert.equal(r.seeded, false)
    assert.equal(r.reason, 'legacy-inline')
  } finally {
    process.env.BILI_FENSHEN_HOME = old
  }
})

test('legacy 直通：行为与升级前一致（人设块 + 读自文件 note）', () => {
  const r = resolvePersona({ cfg: { personaPrompt: whalePath }, roundId: 'R1' })
  assert.equal(r.mode, 'legacy')
  assert.match(r.before, /===== 人设（读自文件）/)
  assert.match(r.before, /按这个来说话/)
  assert.equal(r.after, '', 'legacy 模式没有后段')
})

test('legacy 直通：路径不存在 ⇒ 中性降级并说明原因', () => {
  const r = resolvePersona({ cfg: { personaPrompt: join(HOME, 'nope.md') }, roundId: 'R1' })
  assert.equal(r.mode, 'legacy')
  assert.match(r.before, /不存在/)
  assert.match(r.before, /中性说话/)
})

test('卡模式：before 含身份与标签，after 含状态/手感/尾注', () => {
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeActive({ mode: 'file', path: cardFile })

  const r = resolvePersona({ cfg: {}, roundId: 'R1', now: new Date(2026, 9, 26, 15, 0) })
  assert.equal(r.mode, 'card')
  assert.match(r.before, /人设（smoke@2\.0\.0 · 按这个来说话）/)
  assert.match(r.before, /一个测试用的普通网友/)
  assert.match(r.before, /你的生活/)
  assert.match(r.after, /你这会儿的状态/)
  assert.match(r.after, /写之前，最后看三行/)
  assert.ok(r.stats.total <= 3000)
})

test('卡模式：预设不存在 ⇒ missing 且不把路径当人设', () => {
  writeActive({ mode: 'preset', presetId: 'no-such-preset' })
  const r = resolvePersona({ cfg: {}, roundId: 'R1' })
  assert.equal(r.mode, 'missing')
  assert.match(r.before, /中性说话/)
  assert.ok(r.notes.length > 0)
})

test('保存：非法卡被拒，合法卡写版本快照并切到 file 模式', () => {
  const bad = smokeCard()
  bad.voice.moves = []
  const r1 = saveCard(bad)
  assert.equal(r1.ok, false)
  assert.ok(r1.errors.length > 0)

  const good = smokeCard()
  good.version = '2.0.1'
  const r2 = saveCard(good)
  assert.equal(r2.ok, true, JSON.stringify(r2.errors || []))
  assert.equal(readActive().mode, 'file')
  const loaded = loadCard(readActive())
  assert.equal(loaded.card.version, '2.0.1')
  assert.ok(listVersions().length >= 1)
  assert.ok(existsSync(join(HOME, 'persona', 'versions')))
})

test('预览：不落盘，返回编译文本 + L0 + 预算', () => {
  const r = previewPersona({ card: smokeCard(), roundId: 'P1' })
  assert.equal(r.ok, true)
  assert.ok(r.text.length > 100)
  assert.equal(r.l0.checks.length, 6)
  assert.ok(r.stats.total > 0)
})

test('健康度：卡模式能报出版本与字符数', () => {
  const h = personaHealth({ cfg: {} })
  assert.equal(h.mode, 'card')
  assert.match(h.detail, /@2\.0\.1/)
})

test('prompt 预算守卫：ok / warn / over 三档', () => {
  assert.equal(guardPrompt('x'.repeat(100)).level, 'ok')
  assert.equal(guardPrompt('x'.repeat(20000)).level, 'ok')
  assert.equal(guardPrompt('x'.repeat(20001)).level, 'warn')
  assert.equal(guardPrompt('x'.repeat(24001)).level, 'over')
})
