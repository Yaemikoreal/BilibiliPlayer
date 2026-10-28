/**
 * W1 地基回归：layers 分层装配（W1-0）、场域字数（W1-2）、卡内预算/位置（W1-3）、降级接线（W1-5）。
 *
 * 字节级纪律：whale 在**默认参数**（不传 modes/degrade）下的 c1 / c2 / 编译文本必须与
 * `fixtures/persona/whale.compile.snapshot.json` 逐字节一致。卡内容或口径有意变更时才更新快照，
 * 并在汇报/PR 里逐条说明差异。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'bf-persona-layers-'))
process.env.BILI_FENSHEN_HOME = HOME

const { compilePersona, buildState, buildTail } = await import('../lib/persona/compile.js')
const { buildLayers, resolvePosition } = await import('../lib/persona/layers.js')
const { resolveBudget, resolveModes, effectiveModes, degradationPlan, BUDGET } = await import('../lib/persona/budget.js')
const { deriveState } = await import('../lib/persona/state.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')
const { resolvePersona, previewPersona } = await import('../lib/persona/index.js')

const whaleCard = () => JSON.parse(readFileSync(fileURLToPath(new URL('../prompts/persona/whale.card.json', import.meta.url)), 'utf8'))
const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/persona/whale.compile.snapshot.json', import.meta.url)), 'utf8'))
const stateAt = (card = smokeCard(), hour = 15, comments = []) => {
  const now = new Date(2026, 9, 26, hour, 10, 0)
  const events = comments.map((text, i) => ({
    t: new Date(now.getTime() - (comments.length - i) * 60_000).toISOString(),
    type: 'comment',
    text,
  }))
  return deriveState({ events, card, now })
}

/* ───────────────────────── W1-0：layers 分层 + 字节级快照 ───────────────────────── */

test('快照：默认参数下 whale 的 c1 / c2 / 编译文本逐字节锁定', () => {
  const card = whaleCard()
  const state = deriveState({ events: [], card, now: new Date(snapshot.meta.now) })
  const layer = buildLayers({ card, state, bank: null, roundId: snapshot.meta.roundId })
  assert.equal(layer.c1, snapshot.c1, 'C1（章程前段）字节变了')
  assert.equal(layer.c2, snapshot.c2, 'C2（整轮末尾）字节变了')
  assert.equal(layer.tag, snapshot.meta.card)
  const out = compilePersona(card, { state, bank: null, roundId: snapshot.meta.roundId })
  assert.equal(out.text, snapshot.compileText, '整份编译文本字节变了')
  assert.deepEqual(out.used, snapshot.used, '冷却表记录变了')
  assert.deepEqual(Object.fromEntries(Object.entries(out.blocks).map(([k, b]) => [k, b.len])),
    Object.fromEntries(Object.entries(snapshot.blocks).map(([k, b]) => [k, b.len])))
})

test('layers：c1 只放前段（core/lore + 结束标记），c2 只放后段（state/samples/tail）', () => {
  const card = whaleCard()
  const layer = buildLayers({ card, state: stateAt(card), bank: null, roundId: 'R1' })
  assert.ok(layer.c1.startsWith('\n\n===== 人设（whale@'), 'c1 以身份标题起头')
  assert.ok(layer.c1.endsWith('===== 人设结束 =====\n'), 'c1 以结束标记收尾')
  assert.ok(!layer.c1.includes('===== 你这会儿的状态 ====='), '状态不该进前段')
  assert.ok(layer.c2.startsWith('\n\n===== 你这会儿的状态 ====='), 'c2 以状态起头（贴生成点）')
  assert.ok(layer.c2.includes('===== 写之前，最后看几行 ====='), '尾注在最末尾段')
  assert.ok(!layer.c2.includes('===== 人设（'), '身份不该进后段')
})

test('layers：c3Hints 给 W6 留结构（interpolate:false / 预算 / 见闻索引）', () => {
  const layer = buildLayers({ card: whaleCard(), state: stateAt(whaleCard()), bank: null, roundId: 'R1' })
  assert.equal(layer.c3Hints.channel, 'generate-time')
  assert.equal(layer.c3Hints.target, 'systemPrompt.context')
  assert.equal(layer.c3Hints.interpolate, false)
  assert.ok(layer.c3Hints.maxChars <= 600)
  assert.ok(Array.isArray(layer.c3Hints.loreIndex) && layer.c3Hints.loreIndex.length > 0)
  assert.ok(layer.c3Hints.loreIndex.every((e) => e.id && Array.isArray(e.keys)))
})

test('setStats：五块体量 + 总长（与旧 summarize 口径一致）', () => {
  const layer = buildLayers({ card: whaleCard(), state: stateAt(whaleCard()), bank: null, roundId: 'R1' })
  assert.equal(layer.stats.per.length, 5)
  assert.equal(layer.stats.total, layer.stats.per.reduce((n, b) => n + b.len, 0))
  assert.equal(layer.stats.totalMax, 3000)
})

/* ───────────────────────── W1-2：场域字数 ───────────────────────── */

test('modes：卡里 voice.modes 读出 评论 100 / 楼中楼 40 / 动态 60', () => {
  assert.deepEqual(resolveModes(whaleCard()), { comment: 100, reply: 40, dynamic: 60 })
  // 卡里没写就回落缺省（不是 undefined）
  assert.deepEqual(resolveModes(smokeCard()), { comment: 100, reply: 40, dynamic: 60 })
  // 纯数字 / {maxChars} 两种写法都认
  assert.deepEqual(resolveModes({ voice: { modes: { comment: 120, reply: { maxChars: 30 }, dynamic: { chars: 50 } } } }),
    { comment: 120, reply: 30, dynamic: 50 })
})

test('P3 场域表：白天 100/40/60；凌晨与场域取更严（全 40，不把楼中楼放宽）', () => {
  const modes = resolveModes(whaleCard())
  const day = buildState(stateAt(whaleCard(), 15), { modes })
  assert.match(day, /评论 100 \/ 楼中楼 40 \/ 动态 60 字封顶/)
  assert.match(day, /现在最紧 40 字/)

  const night = buildState(stateAt(whaleCard(), 2), { modes })
  assert.match(night, /评论 40 \/ 楼中楼 40 \/ 动态 40 字封顶/, '凌晨必须按更严的 40')
  assert.ok(!/评论 100/.test(night), '凌晨不能把评论放宽到 100')

  // 旧口径（不传 modes）保持原样：单一上限 + 时段取更严
  assert.match(buildState(stateAt(whaleCard(), 15), { maxChars: 100 }), /这条按 100 字以内来。/)
  assert.match(buildState(stateAt(whaleCard(), 2), { maxChars: 100 }), /这条按 40 字以内来。/)
})

test('effectiveModes：时段上限与场域上限取 min，永不放宽', () => {
  assert.deepEqual(effectiveModes(resolveModes(whaleCard()), 40), { comment: 40, reply: 40, dynamic: 40 })
  assert.deepEqual(effectiveModes(resolveModes(whaleCard()), 60), { comment: 60, reply: 40, dynamic: 60 })
  assert.deepEqual(effectiveModes(resolveModes(whaleCard()), null), { comment: 100, reply: 40, dynamic: 60 })
})

test('P5 尾注：behaviorStyle 1 行 + 场域行（楼中楼 40 / 动态 60）', () => {
  const modes = resolveModes(whaleCard())
  const tail = buildTail(whaleCard(), { modes })
  const lines = tail.split('\n')
  assert.equal(lines.length, 5, '3 行约束 + 兴趣优先 + 场域字数')
  assert.match(lines[3], /^4\) 兴趣优先：不感兴趣的热门不凑/)
  assert.match(lines[4], /^5\) 楼中楼 40 字、动态 60 字封顶/)
  // 尾注不写具体句子，仍然成立
  for (const s of whaleCard().voice.samples.good) assert.ok(!tail.includes(s.text))
})

test('编译 modes：80 字楼中楼按 40 判超限（P3 与尾注都钉 40）', () => {
  const card = whaleCard()
  const out = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R-modes', modes: resolveModes(card) })
  assert.match(out.text, /楼中楼 40/)
  assert.match(out.text, /评论 100/)
  assert.match(out.text, /动态 60/)
  // 旧口径那行不该再出现（避免"口径两套"）
  assert.ok(!out.text.includes('这条按 100 字以内来'))
})

/* ───────────────────────── W1-3：卡内 render.budget / render.position ───────────────────────── */

test('预算：读卡优先，缺项回落 budget.js 缺省；内置卡显式覆盖项生效', () => {
  assert.deepEqual({ ...resolveBudget(smokeCard()) }, { ...BUDGET })
  // v3「豆腐」卡：见闻从 3 条扩到 7 条，还要留下「调 bili_persona_lore 取正文」那行提示，
  // lore 预算显式提到 450（缺省仍是 300；其它块不变）。见 whale.card.json 的 render.budget。
  assert.deepEqual({ ...resolveBudget(whaleCard()) }, { ...BUDGET, lore: 450 })
  const custom = smokeCard()
  custom.render.budget = { ...custom.render.budget, core: 120 }
  const eff = resolveBudget(custom)
  assert.equal(eff.core, 120, '卡里的 core 预算生效')
  assert.equal(eff.tail, BUDGET.tail, '卡里没写的项回落缺省')
  const out = compilePersona(custom, { state: stateAt(custom), bank: null, roundId: 'R-budget' })
  assert.equal(out.blocks.core.max, 120, 'fitBlock 真用了卡内预算')
  assert.ok(out.blocks.core.len <= 120)
  assert.ok(out.blocks.core.over, '超了要标记，不能静默')
})

test('位置：render.position 决定 c1/c2 归属（core 挪后、tail 挪前）', () => {
  assert.deepEqual(resolvePosition(whaleCard()), { core: 'before-charter', lore: 'before-charter', state: 'after-params', samples: 'after-params', tail: 'after-params' })
  const card = smokeCard()
  card.render.position = { core: 'after-params', tail: 'before-charter' }
  const layer = buildLayers({ card, state: stateAt(card), bank: null, roundId: 'R-pos' })
  assert.ok(!layer.c1.includes('===== 人设（'), 'core 挪走后 c1 不再有身份标题')
  assert.ok(layer.c2.includes('===== 人设（'), 'core 出现在后段')
  assert.ok(layer.c1.includes('===== 写之前，最后看几行 ====='), 'tail 挪到前段')
  assert.ok(!layer.c2.includes('===== 写之前，最后看几行 ====='))
})

/* ───────────────────────── W1-5：降级接线 ───────────────────────── */

test('降级默认空数组 ⇒ 与不传完全相同（opt-in，回滚只需不传）', () => {
  const card = whaleCard()
  const a = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R' })
  const b = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R', degrade: [] })
  assert.equal(a.text, b.text)
  assert.deepEqual(b.degraded, [])
  assert.deepEqual(degradationPlan('ok'), [])
  assert.deepEqual(degradationPlan('warn'), ['lore:shrink', 'samples:half'])
  assert.deepEqual(degradationPlan('over'), ['lore:drop', 'samples:drop', 'state:shrink'])
})

test('warn 级降级：见闻索引 8→5、示例 4→2，尾注/身份不动', () => {
  const card = whaleCard()
  card.loreIndex = Array.from({ length: 8 }, (_, i) => ({ id: `wish-${i}`, keys: ['触动'], oneLine: `第 ${i + 1} 条见闻摘要` }))
  const full = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R' })
  const shrunk = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R', degrade: ['lore:shrink', 'samples:half'] })
  assert.equal(shrunk.degraded.length, 2)
  assert.ok(shrunk.blocks.lore.len < full.blocks.lore.len, '见闻索引应缩短')
  assert.ok(shrunk.blocks.samples.len < full.blocks.samples.len, '示例应减半')
  assert.equal(shrunk.blocks.tail.text, full.blocks.tail.text, 'L0 尾注一个字节都不能变')
  assert.ok(shrunk.used.loreIds.length <= 5, '冷却表只记真摆出来的 5 条')
})

test('over 级降级：lore/samples 丢掉、state 收缩，但尾注仍在（不再整段丢 after）', () => {
  const card = whaleCard()
  const recent = ['欠得很', '原来是他自己切的屏', '我看完就记住这个了']
  const state = stateAt(card, 15, recent)
  const full = compilePersona(card, { state, bank: null, roundId: 'R' })
  const cut = compilePersona(card, { state, bank: null, roundId: 'R', degrade: ['lore:drop', 'samples:drop', 'state:shrink'] })
  assert.equal(cut.blocks.lore.text, '')
  assert.equal(cut.blocks.samples.text, '')
  assert.ok(full.blocks.state.text.includes('最近说过：'))
  assert.ok(!cut.blocks.state.text.includes('最近说过：'), 'state:shrink 丢掉"最近说过"列表')
  assert.match(cut.blocks.state.text, /字封顶|这条按/, '状态主干（时段/欠账/字数）要保住')
  assert.equal(cut.blocks.tail.text, full.blocks.tail.text, '尾注必须保留')
  assert.deepEqual(cut.degraded, ['lore:drop', 'samples:drop', 'state:shrink'])
})

test('降级动作白名单：未知动作忽略，不污染 degraded', () => {
  const card = whaleCard()
  const out = compilePersona(card, { state: stateAt(card), bank: null, roundId: 'R', degrade: ['lore:drop', 'bogus:action'] })
  assert.deepEqual(out.degraded, ['lore:drop'])
  assert.equal(out.blocks.lore.text, '')
})

/* ───────────────────────── 生产链路：预览 = 实际（同一份 modes） ───────────────────────── */

test('预览=实际：previewPersona 默认与 resolvePersona(modes:card) 用同一份场域表', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')

  const now = new Date(2026, 9, 26, 15, 0)
  const res = resolvePersona({ cfg: {}, roundId: 'R-eq', modes: 'card', now })
  assert.equal(res.mode, 'card')
  assert.match(res.before + res.after, /评论 100 \/ 楼中楼 40 \/ 动态 60 字封顶/)
  assert.deepEqual(res.modes, resolveModes(card))
  assert.ok(res.c3Hints && res.c3Hints.interpolate === false, '卡模式要带 c3 结构')

  const pre = previewPersona({ card, events: [], roundId: 'R-eq', now })
  assert.match(pre.text, /评论 100 \/ 楼中楼 40 \/ 动态 60 字封顶/, '预览必须和实际同一份场域表')
  assert.deepEqual(pre.modes, res.modes)
  assert.deepEqual(pre.budget, resolveBudget(card))

  // 旧口径（显式 modes:null）仍可复现升级前行为
  const legacy = resolvePersona({ cfg: {}, roundId: 'R-eq', now })
  assert.match(legacy.before + legacy.after, /这条按 100 字以内来/)
})

/* ───────────────────────── buildDutyPrompt：超软线二次编译（W1-5 接线） ───────────────────────── */

test('buildDutyPrompt：正常长度不降级，归因记录可用', async () => {
  const { buildDutyPrompt, getLastPersonaInject } = await import('../index.js')
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')

  const cfg = {
    perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
    keywords: [], followUids: [], avoidList: [], followAuto: false, followPerRound: 0, personaPrompt: '',
  }
  const p = buildDutyPrompt(cfg, 'R-ok')
  const info = getLastPersonaInject()
  assert.equal(info.roundId, 'R-ok')
  assert.equal(info.guard.level, 'ok')
  assert.deepEqual(info.degraded, [])
  assert.equal(info.personaRes.mode, 'card')
  assert.match(p, /===== 写之前，最后看几行 =====/, '尾注在')
  // buildDutyPrompt 用真实时钟 ⇒ 时段会把上限压到 40，所以这里只锁"场域表存在且三场域齐全"
  assert.match(p, /字数：评论 \d+ \/ 楼中楼 40 \/ 动态 \d+ 字封顶/, '生产链路走卡内场域字数')
})

test('buildDutyPrompt：超软线 → 二次编译降级，但尾注仍随 prompt 下发', async () => {
  const { buildDutyPrompt, getLastPersonaInject } = await import('../index.js')
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')

  // 用超长不看清单把 prompt 顶过软线（1000 条 × ~15 字 ≈ +16k）
  const avoidList = Array.from({ length: 1000 }, (_, i) => `不看条目-${String(i).padStart(4, '0')}-标题党`)
  const cfg = {
    perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
    keywords: [], followUids: [], avoidList, followAuto: false, followPerRound: 0, personaPrompt: '',
  }
  const p = buildDutyPrompt(cfg, 'R-warn')
  const info = getLastPersonaInject()
  assert.ok(info.guard.level === 'warn' || info.guard.level === 'over', `应触发降级，实际 ${info.guard.level}`)
  assert.ok(info.degraded.length > 0, '降级动作要记进返回值（W2-1 用）')
  assert.ok(info.degraded.every((a) => ['lore:shrink', 'samples:half', 'lore:drop', 'samples:drop', 'state:shrink', 'state:drop'].includes(a)))
  assert.match(p, /===== 写之前，最后看几行 =====/, '降级不许丢尾注（旧实现正是丢它）')
  assert.match(p, /别收在判断上/, '尾注正文还在')
  // 身份（C1）不一定保留（hard 线的最后安全阀），但章程/参数必须完整
  assert.match(p, /值班章程/)
  assert.match(p, /本轮参数：/)
  assert.ok(p.length > 20000)
})
