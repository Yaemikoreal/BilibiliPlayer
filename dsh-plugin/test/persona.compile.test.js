// 编译器：五块预算、位置纪律、确定性、语料库接入
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compilePersona, buildCore, buildTail, buildState } from '../lib/persona/compile.js'
import { BUDGET, TOTAL_MAX } from '../lib/persona/budget.js'
import { deriveState } from '../lib/persona/state.js'
import { smokeCard } from './fixtures/persona/smoke-card.js'

const stateAt = (hour, comments = []) => {
  const now = new Date(2026, 9, 26, hour, 10, 0) // 本地时间 2026-10-26
  const events = comments.map((text, i) => ({
    t: new Date(now.getTime() - (comments.length - i) * 60_000).toISOString(),
    type: 'comment',
    text,
  }))
  return deriveState({ events, card: smokeCard(), now })
}

test('五块都在预算内，总长不超上限', () => {
  const card = smokeCard()
  const out = compilePersona(card, { state: stateAt(15), bank: null, roundId: 'R1' })
  for (const [name, block] of Object.entries(out.blocks)) {
    assert.ok(block.len <= BUDGET[name], `${name} 超预算：${block.len} > ${BUDGET[name]}`)
  }
  assert.ok(out.stats.total <= TOTAL_MAX, `总长 ${out.stats.total} > ${TOTAL_MAX}`)
})

test('核心块：含身份与边界，且绝不泄露 creatorNotes', () => {
  const card = smokeCard()
  const core = buildCore(card)
  assert.match(core, /一个测试用的普通网友/)
  assert.match(core, /不是官方/)
  assert.ok(!core.includes('绝对不能被编译进 prompt'))
  const out = compilePersona(card, { state: stateAt(15), roundId: 'R1' })
  assert.ok(!out.text.includes('绝对不能被编译进 prompt'))
})

test('P5 最后一公里：3 行约束 + behaviorStyle 1 行，只给分类不给具体句子', () => {
  const card = smokeCard()
  const tail = buildTail(card)
  const lines = tail.split('\n')
  assert.equal(lines.length, 4, '3 行约束 + W1-4 补的 behaviorStyle「兴趣优先」1 行')
  assert.match(lines[0], /别收在判断上/)
  assert.match(lines[0], /纯情绪词/)
  assert.match(lines[3], /^4\) 兴趣优先/)
  // 不许把卡里的示例句塞进尾注（"指出口"会让 6 句里 5 句收在同一格）
  for (const s of card.voice.samples.good) {
    assert.ok(!tail.includes(s.text), `尾注不该出现示例句：${s.text}`)
  }
})

test('P3 今日状态：凌晨压到 40 字；有欠账行；有沉默退避', () => {
  const card = smokeCard()
  const state = stateAt(2, ['欠得很', '原来是他自己切的屏', '我看完就记住这个了'])
  const block = buildState(state, { maxChars: 100 })
  assert.match(block, /40 字以内/)
  assert.match(block, /最近 3 条/)
  assert.match(block, /优先/)
})

test('编译确定性：同一 (card,state,roundId) 输出完全一致', () => {
  const card = smokeCard()
  const state = stateAt(15)
  const a = compilePersona(card, { state, roundId: 'R1' })
  const b = compilePersona(card, { state, roundId: 'R1' })
  assert.equal(a.text, b.text)
})

test('有表达库时用真实语料，并排除今天用过的', () => {
  const card = smokeCard()
  const state = stateAt(15) // 无历史评论 ⇒ 欠账全欠，targetForm = question
  state.expressionUsed = { 'question#0': new Date().toISOString() }
  const bank = {
    spec: 'bili-fenshen.expression-bank/v1',
    buckets: {
      question: [
        { text: '这个内阁是什么新英雄吗？', status: 'active', source: 't' },
        { text: '能隔空取奖杯吗？', status: 'active', source: 't' },
      ],
    },
  }
  const out = compilePersona(card, { state, bank, roundId: 'R1' })
  assert.match(out.blocks.samples.text, /能隔空取奖杯吗？/)
  assert.ok(!out.blocks.samples.text.includes('这个内阁是什么新英雄吗？'), '今天用过的应被排除')
  assert.ok(out.notes.some((n) => n.includes('表达库')))
})

test('表达库为空时退化到卡内样本（不报错）', () => {
  const out = compilePersona(smokeCard(), { state: stateAt(15), bank: { buckets: {} }, roundId: 'R1' })
  assert.ok(out.blocks.samples.len > 0)
  assert.ok(out.notes.some((n) => n.includes('卡内样本')))
})
