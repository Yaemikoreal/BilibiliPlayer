// dsh-plugin/test/persona.assets.test.js
// 语料库 / 见闻库人工编辑闭环：物化用户副本 → 编辑 → 落盘 → 回读。
// 全部走临时家目录（BILI_FENSHEN_HOME），不碰真实数据。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-assets-'))

const {
  readActive, loadCard, loadBank, saveBank, materializeUserCopy, savePersonaCard,
  editExpressionBank, editLoreIndex, writeLoreBody, listVersions, normalizeBank,
  resolveLoreIndex,
} = await import('../lib/persona/index.js')
import { personaDir } from '../lib/persona/store.js'

const home = () => process.env.BILI_FENSHEN_HOME

after(() => {
  try { rmSync(home(), { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
})

test('语料库 add：preset 模式下自动物化用户副本并切 file，条目可回读', () => {
  assert.equal(readActive().mode, 'preset') // 前提：临时家目录是干净的 preset 状态
  const out = editExpressionBank({ action: 'add', form: 'question', text: '能不能分析一下为什么坏在同一个位置？', source: '测试语料', status: 'active' })
  assert.equal(out.ok, true, out.error)
  assert.equal(out.materialized, true)
  assert.equal(readActive().mode, 'file') // 已切用户副本
  assert.ok(existsSync(join(personaDir(), 'card.json')), '物化应写出 card.json')
  assert.ok(existsSync(join(personaDir(), 'expression-bank.json')), '物化应写出语料库')
  const bank = loadBank()
  const hit = (bank.buckets.question || []).find((e) => e.source === '测试语料')
  assert.ok(hit, '新增条目应可回读')
  assert.equal(hit.status, 'active')
  assert.equal(hit.len, hit.text.length)
})

test('语料库 status / edit / remove', () => {
  const bank0 = normalizeBank(loadBank())
  const entry = bank0.buckets.question.find((e) => e.source === '测试语料')
  assert.ok(entry, '前置：上一条已加进去')

  const st = editExpressionBank({ action: 'status', form: 'question', id: entry.id, status: 'candidate' })
  assert.equal(st.ok, true, st.error)
  assert.equal(normalizeBank(loadBank()).buckets.question.find((e) => e.id === entry.id).status, 'candidate')

  const ed = editExpressionBank({ action: 'edit', form: 'question', id: entry.id, text: '改过的语料文本', source: '改过来源', heat: 3 })
  assert.equal(ed.ok, true, ed.error)
  const got = normalizeBank(loadBank()).buckets.question.find((e) => e.id === entry.id)
  assert.equal(got.text, '改过的语料文本')
  assert.equal(got.source, '改过来源')
  assert.equal(got.heat, 3)
  assert.equal(got.len, '改过的语料文本'.length)

  const rm = editExpressionBank({ action: 'remove', form: 'question', id: entry.id })
  assert.equal(rm.ok, true, rm.error)
  assert.ok(!normalizeBank(loadBank()).buckets.question.some((e) => e.id === entry.id))
})

test('语料库非法输入被拒', () => {
  assert.equal(editExpressionBank({ action: 'add', form: 'nope', text: 'x' }).ok, false)
  assert.equal(editExpressionBank({ action: 'add', form: 'meme', text: '  ' }).ok, false)
  assert.equal(editExpressionBank({ action: 'edit', form: 'meme', id: 'ghost#0', text: 'x' }).ok, false)
  assert.equal(editExpressionBank({ action: 'wat', form: 'meme' }).ok, false)
})

test('物化幂等：第二次不再物化', () => {
  const out = materializeUserCopy()
  assert.equal(out.materialized, false)
  assert.ok(out.card)
})

test('见闻索引 add → 走整卡保存并出版本快照；edit / remove 正常', () => {
  const before = listVersions().length
  const add = editLoreIndex({ action: 'add', id: 'test-entry', keys: '测试, 关键词', oneLine: '一句话摘要' })
  assert.equal(add.ok, true, add.error)
  assert.ok(add.snapshot, '索引编辑应出版本快照')
  assert.equal(listVersions().length, before + 1)

  const card = loadCard().card
  const hit = (card.loreIndex || []).find((l) => l.id === 'test-entry')
  assert.ok(hit, '索引应已写进卡')
  assert.deepEqual(hit.keys, ['测试', '关键词'])

  const ed = editLoreIndex({ action: 'edit', id: 'test-entry', keys: '新触发词', oneLine: '改过的摘要' })
  assert.equal(ed.ok, true, ed.error)
  assert.deepEqual(loadCard().card.loreIndex.find((l) => l.id === 'test-entry').keys, ['新触发词'])

  const rm = editLoreIndex({ action: 'remove', id: 'test-entry' })
  assert.equal(rm.ok, true, rm.error)
  assert.ok(!loadCard().card.loreIndex.some((l) => l.id === 'test-entry'))
})

test('见闻索引非法输入被拒（坏 id / 重复 id / 缺 keys）', () => {
  assert.equal(editLoreIndex({ action: 'add', id: '../evil', keys: 'x', oneLine: 'y' }).ok, false)
  assert.equal(editLoreIndex({ action: 'add', id: 'no-keys', keys: '', oneLine: 'y' }).ok, false)
  const dup = editLoreIndex({ action: 'add', id: 'wuchang-ranked', keys: '无畏契约', oneLine: '重复 id' })
  assert.equal(dup.ok, false)
})

test('见闻正文写读回环；路径穿越被拒', () => {
  const w = writeLoreBody('test-entry', '# 测试见闻\n\n正文内容第一段。')
  assert.equal(w.ok, true, w.error)
  assert.ok(w.file.startsWith(personaDir()), '正文必须落在家目录')
  assert.match(readFileSync(w.file, 'utf8'), /正文内容第一段/)

  const bad = writeLoreBody('../evil', 'x')
  assert.equal(bad.ok, false)
})

test('预设卡（whale 2.1.0）本身可过整卡校验且内容符合主人决策', async () => {
  const { validateCard, SPEC } = await import('../lib/persona/card.js')
  const { presetPath } = await import('../lib/persona/store.js')
  const whale = JSON.parse(readFileSync(presetPath('whale'), 'utf8'))
  assert.equal(whale.spec, SPEC)
  assert.equal(whale.version, '2.1.0')
  const v = validateCard(whale)
  assert.deepEqual(v.errors, [], 'whale 预设卡应通过校验：' + JSON.stringify(v.errors))

  // 主人决策：话题红线只有政治一条；活动范围不再有"绕开"清单
  assert.equal(whale.redlines.length, 1)
  assert.equal(whale.redlines[0].id, 'no-politics')
  assert.ok(whale.redlines[0].instead && !/^(不|别|禁止)/.test(whale.redlines[0].instead), 'instead 必须是正向动作')
  assert.ok(!Array.isArray(whale.taste.avoid) || whale.taste.avoid.length === 0, 'taste.avoid 应删除或为空')
  assert.ok(Array.isArray(whale.taste.watch) && whale.taste.watch.length > 0, '初始口味保留')
})

test('resolveLoreIndex 对编辑后的卡照常工作（正文可缺，索引仍可用）', () => {
  const { card } = loadCard()
  const entries = resolveLoreIndex(card, {})
  assert.ok(Array.isArray(entries))
  for (const e of entries) {
    assert.ok(e.id)
    assert.ok(Array.isArray(e.keys))
  }
})
