// 今日状态：mood 稳定性、时段边界、形态判定、欠账、沉默计数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveState, timeOfDayOf, formOf, debtLine, MOODS, usedToday, recordUsage } from '../lib/persona/state.js'
import { smokeCard } from './fixtures/persona/smoke-card.js'

test('mood：同一天稳定，跨 30 天会变（不是常量）', () => {
  const card = smokeCard()
  const a = deriveState({ now: new Date(2026, 9, 26, 9, 0), card })
  const b = deriveState({ now: new Date(2026, 9, 26, 23, 0), card })
  assert.equal(a.mood.label, b.mood.label, '同一天内必须一致')
  const labels = new Set()
  for (let d = 1; d <= 30; d++) labels.add(deriveState({ now: new Date(2026, 9, d, 12, 0), card }).mood.label)
  assert.ok(labels.size >= 3, `30 天里至少 3 种心情，实际 ${labels.size}`)
  for (const l of labels) assert.ok(MOODS.some((m) => m.label === l))
})

test('时段边界：0–4 凌晨 / 5–10 早 / 11–13 午 / 14–21 晚 / 22–23 深夜', () => {
  const at = (h) => timeOfDayOf(new Date(2026, 9, 26, h, 0)).label
  assert.equal(at(4), '凌晨')
  assert.equal(at(5), '早')
  assert.equal(at(10), '早')
  assert.equal(at(11), '午')
  assert.equal(at(13), '午')
  assert.equal(at(14), '晚')
  assert.equal(at(21), '晚')
  assert.equal(at(22), '深夜')
  assert.equal(timeOfDayOf(new Date(2026, 9, 26, 23, 0)).maxChars, 40)
})

test('形态判定：判断句不算情绪，疑问/经历/纯反应各自正确', () => {
  assert.equal(formOf('难绷'), 'reaction')
  assert.equal(formOf('欠得很'), 'detail', '判断收尾必须算 detail，否则欠账永远不欠')
  assert.equal(formOf('一下就说死了'), 'detail')
  assert.equal(formOf('这英雄是不是还得削？'), 'question')
  assert.equal(formOf('我是广西人，第一次去东北同学家蹭婚宴，吃晕了[doge]'), 'experience')
  assert.equal(formOf('原来同向两车道，校车停下旁边那条道也得停啊'), 'detail')
})

test('欠账：连着 3 条判断收尾 ⇒ 欠疑问/纯反应/经历/表情，且标记 judgeHeavy', () => {
  const card = smokeCard()
  const events = ['欠得很', '原来是他自己切的屏', '我看完就记住这个了'].map((text, i) => ({
    t: new Date(2026, 9, 26, 10, i, 0).toISOString(), type: 'comment', text,
  }))
  const s = deriveState({ events, card, now: new Date(2026, 9, 26, 11, 0) })
  assert.equal(s.recent.forms5.length, 3)
  assert.equal(s.recent.debt.question, true)
  assert.equal(s.recent.debt.reaction, true)
  assert.equal(s.recent.debt.judgeHeavy, true)
  const line = debtLine(s)
  assert.match(line, /优先/)
  assert.match(line, /骨架/)
})

test('沉默退避：末尾连续 skip ≥3 计数正确，遇到评论就中断', () => {
  const card = smokeCard()
  const ev = (type, i) => ({ t: new Date(2026, 9, 26, 10, i, 0).toISOString(), type, text: type === 'comment' ? '难绷' : '' })
  const s3 = deriveState({ events: [ev('comment', 1), ev('skip', 2), ev('skip', 3), ev('skip', 4)], card, now: new Date(2026, 9, 26, 11, 0) })
  assert.equal(s3.skipStreak, 3)
  const s0 = deriveState({ events: [ev('skip', 1), ev('comment', 2)], card, now: new Date(2026, 9, 26, 11, 0) })
  assert.equal(s0.skipStreak, 0)
})

test('冷却表：usedToday 按自然日判断，recordUsage 只增不改', () => {
  const now = new Date(2026, 9, 26, 12, 0)
  const st = recordUsage({ loreUsed: {} }, { loreIds: ['a'], canonKeys: ['k'], expressionIds: ['q#1'] }, now)
  assert.equal(usedToday(st.loreUsed, 'a', now), true)
  assert.equal(usedToday(st.loreUsed, 'a', new Date(2026, 9, 27, 12, 0)), false)
  assert.equal(st.canonUsed.k, '2026-10-26')
  assert.ok(st.expressionUsed['q#1'])
})
