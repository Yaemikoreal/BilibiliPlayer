// 预设卡端到端：三张卡必须能编译进预算、L0 全过、creatorNotes 不泄漏
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRESETS_DIR } from '../lib/persona/store.js'
import { validateCard, l0Checks } from '../lib/persona/card.js'
import { compilePersona } from '../lib/persona/compile.js'
import { deriveState } from '../lib/persona/state.js'
import { TOTAL_MAX } from '../lib/persona/budget.js'
import { normalizeBank, bankStats } from '../lib/persona/expression.js'

const cards = () =>
  readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith('.card.json'))
    .map((f) => ({ file: f, card: JSON.parse(readFileSync(join(PRESETS_DIR, f), 'utf8')) }))

const hasPresets = () => cards().length > 0

test('三张预设卡：schema + L0 全过', { skip: !hasPresets() && '尚无预设卡' }, () => {
  const list = cards()
  assert.ok(list.length >= 1)
  for (const { file, card } of list) {
    assert.deepEqual(validateCard(card).errors, [], `${file} schema`)
    assert.equal(l0Checks(card).ok, true, `${file} L0`)
  }
})

test('三张预设卡：编译后不超总预算，且 creatorNotes 不泄漏', { skip: !hasPresets() && '尚无预设卡' }, () => {
  for (const { file, card } of cards()) {
    const state = deriveState({ events: [], card, now: new Date(2026, 9, 26, 15, 0) })
    const out = compilePersona(card, { state, bank: null, roundId: 'R1', modeMax: 100 })
    assert.ok(out.stats.total > 0, `${file} 编译结果为空`)
    assert.ok(out.stats.total <= TOTAL_MAX, `${file} 超预算：${out.stats.total} > ${TOTAL_MAX}`)
    if (card.creatorNotes) {
      const head = card.creatorNotes.slice(0, 30)
      assert.ok(!out.text.includes(head), `${file} 把 creatorNotes 编进 prompt 了`)
    }
  }
})

test('预设卡的红线都带正向替代（instead），且不是又一句"不要"', { skip: !hasPresets() && '尚无预设卡' }, () => {
  for (const { file, card } of cards()) {
    for (const r of card.redlines || []) {
      assert.ok(r.why, `${file} 红线 ${r.id} 缺 why`)
      assert.ok(r.instead, `${file} 红线 ${r.id} 缺 instead`)
      assert.ok(!/^(不|别|禁止|勿|不要|不能)/.test(r.instead), `${file} 红线 ${r.id} 的 instead 还是否定句`)
    }
  }
})

test('表达库种子：六桶都存在、条目都带 source、无 3-gram 重复', { skip: !readdirSync(PRESETS_DIR).includes('expression-bank.seed.json') && '尚无种子库' }, () => {
  const raw = JSON.parse(readFileSync(join(PRESETS_DIR, 'expression-bank.seed.json'), 'utf8'))
  const bank = normalizeBank(raw)
  const stats = bankStats(raw)
  for (const form of ['reaction', 'question', 'experience', 'meme', 'detail', 'rant']) {
    assert.ok(stats.byBucket[form].total > 0, `桶 ${form} 为空`)
    for (const e of bank.buckets[form]) {
      assert.ok(e.source, `${form} 有条目缺 source：${e.text}`)
      assert.ok(e.status === 'active' || e.status === 'candidate')
    }
  }
  const all = Object.values(bank.buckets).flat()
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      assert.notEqual(all[i].text, all[j].text, `重复条目：${all[i].text}`)
    }
  }
})
