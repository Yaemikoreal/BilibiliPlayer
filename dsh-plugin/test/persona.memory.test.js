/**
 * 记忆（W7-1）：账本聚合 → 重要度/半衰期 → 相关性过滤 → 渲染 → 注入 C2。
 *
 * 为什么必须有这些用例：记忆是"会改说话内容"的东西，一旦聚合口径错了，
 * 模型会拿"我评过但其实是别人说的"当自己的经历（正是 W1-6 diff A9 那类事故）。
 * 所以这里把**每条纪律**都钉住：幂等、只看过不进池、半衰期 7 天、中文子串相关、≤2 条 ≤300 字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-memory-'))
process.env.BILI_FENSHEN_HOME = HOME

const {
  buildMemory, filterMemoryRelevant, renderMemory,
  MEMORY_HALF_LIFE_DAYS, MEMORY_WEIGHTS, MEMORY_C2_ENTRIES, MEMORY_C2_CHARS,
} = await import('../lib/memory.js')
const { charLen } = await import('../lib/persona/text.js')
const { resolvePersona } = await import('../lib/persona/index.js')
const { compilePersona } = await import('../lib/persona/compile.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')

const NOW = new Date('2026-10-28T12:00:00.000Z')
const at = (daysAgo, h = 0) => new Date(NOW.getTime() - daysAgo * 86400_000 + h * 60_000).toISOString()
const ev = (o) => ({ t: o.t, type: o.type, ...o })

test('常量：半衰期 7 天、权重按设计 §8.4、C2 上限 2 条 300 字', () => {
  assert.equal(MEMORY_HALF_LIFE_DAYS, 7)
  assert.deepEqual({ ...MEMORY_WEIGHTS }, { replied: 3, liked: 2, commented: 1, viewed: 0 })
  assert.equal(MEMORY_C2_ENTRIES, 2)
  assert.equal(MEMORY_C2_CHARS, 300)
})

test('空账本 / 只看过：记忆池为空（importance=0 不进记忆）', () => {
  const empty = buildMemory({ events: [], now: NOW })
  assert.deepEqual(empty.entries, [])
  assert.match(empty.note, /空/)

  const viewed = buildMemory({
    events: [ev({ t: at(1), type: 'view', bvid: 'BV1', title: '只是看过' })],
    now: NOW,
  })
  assert.deepEqual(viewed.entries, [], '仅仅看过不值得记住')
  assert.equal(viewed.pool, 0)
})

test('重要度累加：评过 +1 / 被回复 +3 / 被赞 >5 +2', () => {
  const events = [
    ev({ t: at(2), type: 'view', bvid: 'BV1', title: '被回复的' }),
    ev({ t: at(2), type: 'comment', bvid: 'BV1', text: '我说过一句', rpid: 111 }),
    ev({ t: at(1), type: 'reply-in', bvid: 'BV1', parent: 111, text: '有人回我' }),
    ev({ t: at(2), type: 'comment', bvid: 'BV2', text: '没人理我', rpid: 222 }),
    ev({ t: at(2), type: 'comment', bvid: 'BV3', text: '被赞了', rpid: 333, likes: 9 }),
  ]
  const m = buildMemory({ events, now: NOW, max: 5 })
  const byBv = Object.fromEntries(m.entries.map((e) => [e.bv, e]))
  assert.equal(byBv.BV1.importance, 4, '评过 1 + 被回复 3')
  assert.equal(byBv.BV1.replies, 1)
  assert.equal(byBv.BV2.importance, 1, '只是评过')
  assert.equal(byBv.BV3.importance, 3, '评过 1 + 被赞 2')
})

test('同一 BV 多条事件只聚合成一条（幂等，不新建）', () => {
  const events = [
    ev({ t: at(3), type: 'view', bvid: 'BVX', title: '第一次看见' }),
    ev({ t: at(2), type: 'comment', bvid: 'BVX', text: '留下评论', rpid: 1 }),
    ev({ t: at(1), type: 'like', bvid: 'BVX' }),
    ev({ t: at(1), type: 'reply-in', bvid: 'BVX', parent: 1 }),
  ]
  const m = buildMemory({ events, now: NOW })
  assert.equal(m.entries.length, 1)
  assert.equal(m.entries[0].bv, 'BVX')
  assert.equal(m.entries[0].id, 'BVX')
})

test('7 天半衰期：7 天前的证据权重减半，越旧越靠后', () => {
  const events = [
    ev({ t: at(0.1), type: 'comment', bvid: 'BVnew', text: '刚评的' }),
    ev({ t: at(7), type: 'comment', bvid: 'BVold', text: '一周前评的' }),
    ev({ t: at(14), type: 'comment', bvid: 'BVolder', text: '两周前评的' }),
  ]
  const m = buildMemory({ events, now: NOW, max: 3 })
  const by = Object.fromEntries(m.entries.map((e) => [e.bv, e]))
  assert.ok(by.BVnew.decayed > by.BVold.decayed, '新的应当更靠前')
  assert.ok(by.BVold.decayed > by.BVolder.decayed)
  // 7 天整：权重 × 0.5（importance 1 ⇒ ≈0.5）
  assert.ok(Math.abs(by.BVold.decayed - 0.5) < 0.02, `7 天应 ≈0.5，实际 ${by.BVold.decayed}`)
  assert.equal(Math.round(by.BVold.ageDays), 7)
  assert.equal(m.entries[0].bv, 'BVnew')
})

test('窗口外的老事件不进候选池', () => {
  const events = [ev({ t: at(40), type: 'comment', bvid: 'BVvery old', text: '很久以前' })]
  const m = buildMemory({ events, now: NOW, days: 30 })
  assert.deepEqual(m.entries, [])
})

test('相关性过滤：中文子串命中标题/我的原话；给了 UP 就按 UP 命中', () => {
  const events = [
    ev({ t: at(1), type: 'view', bvid: 'BV1', title: '无畏契约上分实录', up: '某UP' }),
    ev({ t: at(1), type: 'comment', bvid: 'BV1', text: '难绷', rpid: 1 }),
    ev({ t: at(1), type: 'view', bvid: 'BV2', title: '做菜视频', up: '厨子' }),
    ev({ t: at(1), type: 'comment', bvid: 'BV2', text: '饿了', rpid: 2 }),
  ]
  const m = buildMemory({ events, now: NOW, max: 5 })
  const hit = filterMemoryRelevant(m.entries, { keywords: ['契约'] })
  assert.deepEqual(hit.map((e) => e.bv), ['BV1'], '中文子串即可命中（不做整词匹配）')
  assert.deepEqual(filterMemoryRelevant(m.entries, { keywords: ['不存在的词'] }), [])
  assert.deepEqual(filterMemoryRelevant(m.entries, { up: '厨子' }).map((e) => e.bv), ['BV2'])
  // 没给任何条件时原样返回（调用方可自行决定是否限制）
  assert.equal(filterMemoryRelevant(m.entries, {}).length, m.entries.length)
})

test('renderMemory：≤2 条、≤300 字，超了按条丢（不切半句）', () => {
  const entries = [
    { bv: 'BV1', title: '无畏契约上分', myText: '难绷', replies: 1, likes: 0 },
    { bv: 'BV2', title: '做菜', myText: '饿了', replies: 0, likes: 7 },
    { bv: 'BV3', title: '第三条不该出现', myText: 'x', replies: 0, likes: 0 },
  ]
  const text = renderMemory(entries, { max: 2, maxChars: 300 })
  assert.match(text, /记得的事/)
  assert.match(text, /无畏契约上分/)
  assert.match(text, /有人回过我1次/)
  assert.ok(!text.includes('第三条不该出现'), '超过 max 的条目不该出现')
  // 预算口径是项目统一的 charLen（去表情/去空白后的字数），不是 utf-16 长度
  assert.ok(charLen(text) <= 300, `不得超过 300 字，实际 ${charLen(text)}`)

  const long = Array.from({ length: 6 }, (_, i) => ({
    bv: `BV${i}`, title: '很长的标题'.repeat(6), myText: '很长的原话'.repeat(6), replies: 1, likes: 0,
  }))
  const clipped = renderMemory(long, { max: 6, maxChars: 300 })
  assert.ok(charLen(clipped) <= 300, `超限必须按条丢到 300 字内，实际 ${charLen(clipped)}`)
  assert.ok(clipped.startsWith('记得的事'), '至少保留标题行，不能切出半句')
  assert.equal(renderMemory([], {}), '', '空输入返回空串')
})

test('注入：卡链路把记忆放进 C2 的「你这会儿的状态」段', () => {
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')

  const events = [
    ev({ t: at(1), type: 'view', bvid: 'BV1', title: '无畏契约上分实录' }),
    ev({ t: at(1), type: 'comment', bvid: 'BV1', text: '难绷，这也能输', rpid: 11 }),
    ev({ t: at(0.5), type: 'reply-in', bvid: 'BV1', parent: 11, text: '确实' }),
  ]
  const r = resolvePersona({ cfg: { personaPrompt: '', keywords: ['无畏契约'] }, events, roundId: 'R', now: NOW })
  assert.equal(r.mode, 'card')
  assert.match(r.after, /记得的事/, '记忆必须注入 C2')
  assert.ok(r.after.includes('无畏契约上分实录'), '记忆条目要带标题')
  // 位置纪律：记忆不许出现在 C1（每一步都在付 token）
  assert.ok(!r.before.includes('记得的事'), '记忆不能进 C1')
})

test('注入：没有值得记的事件时，编译文本与快照口径一致（不多一行）', () => {
  const card = smokeCard()
  const state = { mood: {}, timeOfDay: {}, recent: { comments: [], forms5: [], debt: {} } }
  const withoutMemory = compilePersona(card, { state, bank: null, roundId: 'R', modes: null })
  const withEmpty = compilePersona(card, { state, bank: null, roundId: 'R', modes: null, memoryText: '' })
  assert.equal(withEmpty.text, withoutMemory.text)
})

test('注入：降级 state:shrink 时记忆让位（先保状态与尾注）', () => {
  const card = smokeCard()
  const state = { mood: {}, timeOfDay: {}, recent: { comments: [], forms5: [], debt: {} } }
  const memoryText = '记得的事（只在相关时提）：\n· XX —— 我说过「YY」'
  const normal = compilePersona(card, { state, bank: null, roundId: 'R', memoryText })
  assert.match(normal.blocks.state.text, /记得的事/)
  const shrunk = compilePersona(card, { state, bank: null, roundId: 'R', memoryText, degrade: ['state:shrink'] })
  assert.ok(!shrunk.blocks.state.text.includes('记得的事'), 'shrink 时记忆必须让位')
})
