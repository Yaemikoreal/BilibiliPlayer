/**
 * 人设用量闭环（G1）回归：编译期产出 used → 轮末转正 → 「同一天不重复」真的生效。
 *
 * 背景：recordUsage 此前**只有测试在调用**，于是 loreUsed/canonUsed/expressionUsed 永远是空对象，
 * usedToday() 永远 false —— 「今天用过了」这条纪律从未生效，同一条见闻会每天重复。
 * 这组用例把整条链路钉住：产出 → 落盘 → 下一轮不再算新鲜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-persona-usage-'))
process.env.BILI_FENSHEN_HOME = HOME

const { buildDutyPrompt, commitPendingUsage, getLastPersonaInject, getLastSpeakGate } = await import('../index.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')
const {
  compilePersona, recordUsage, loadState, saveState, deriveState, resolveLoreIndex,
} = await import('../lib/persona/index.js')
const dayKeyOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const bank = () => ({
  spec: 'bili-fenshen.expression-bank/v1',
  buckets: {
    reaction: [
      { id: 'r1', text: '难绷', status: 'active', heat: 0 },
      { id: 'r2', text: '好家伙', status: 'active', heat: 0 },
    ],
  },
})

test('编译期产出 used：见闻索引 / canon / 语料 都有据可查', () => {
  const out = compilePersona(smokeCard(), { state: {}, bank: bank(), roundId: 'R1' })
  assert.ok(out.used, 'compilePersona 必须返回 used')
  assert.deepEqual(out.used.loreIds, ['wuchang-ranked'])
  assert.deepEqual(out.used.canonKeys, ['问是不是 AI'])
  assert.ok(out.used.expressionIds.length > 0, 'P4 用了表达库就该记下来')
  assert.ok(out.used.expressionIds.length <= 4)
})

test('已经用过的见闻不再算"新鲜"（usedToday 生效）', () => {
  const state = {
    loreUsed: { 'wuchang-ranked': new Date().toISOString() },
    canonUsed: {},
    expressionUsed: {},
    recent: { comments: [], forms5: [], debt: {} },
  }
  const out = compilePersona(smokeCard(), { state, bank: bank(), roundId: 'R2' })
  assert.deepEqual(out.used.loreIds, [], '今天已用过的见闻不该再被记一次')
  assert.match(out.text, /今天用过了：wuchang-ranked/, 'P2 应把它挪到"今天用过了"')
})

test('recordUsage → saveState → 下一轮读到冷却表（端到端闭环）', () => {
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  const first = compilePersona(smokeCard(), { state: loadState(), bank: bank(), roundId: 'R3' })
  assert.deepEqual(first.used.loreIds, ['wuchang-ranked'], '首轮应视为新鲜')

  const saved = saveState(recordUsage(loadState(), first.used))
  assert.equal(saved, true)

  const persisted = loadState()
  assert.ok(persisted.loreUsed['wuchang-ranked'], '冷却表应写入时间戳')
  assert.equal(String(persisted.loreUsed['wuchang-ranked']).slice(0, 10), dayKeyOf())

  // 第二轮：deriveState 继承持久化冷却表 → usedToday 命中 → 不再新鲜
  const state2 = deriveState({ events: [], card: smokeCard(), now: new Date(), persisted })
  const idx = resolveLoreIndex(smokeCard(), state2)
  assert.equal(idx[0].usedToday, true, '本轮应看到"今天用过"')

  const second = compilePersona(smokeCard(), { state: state2, bank: bank(), roundId: 'R4' })
  assert.deepEqual(second.used.loreIds, [], '第二轮不该再把它算作新鲜')
})

test('buildDutyPrompt 落 pending-usage（供轮末转正，不在编译期污染冷却表）', () => {
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(smokeCard(), null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')
  const pendingFile = join(HOME, 'persona', 'pending-usage.json')
  try { writeFileSync(pendingFile, '', 'utf8') } catch { /* 首次没有 */ }
  // 复位冷却表：上一条用例已把它写成"今天用过"，这里要验证的是「新鲜时会被记进 pending」
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')

  const cfg = {
    perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
    keywords: [], followUids: [], avoidList: [], followAuto: false, followPerRound: 0, personaPrompt: '',
  }
  buildDutyPrompt(cfg, 'R-pending')

  assert.ok(existsSync(pendingFile), '应写出 pending-usage.json')
  const pending = JSON.parse(readFileSync(pendingFile, 'utf8'))
  assert.equal(pending.roundId, 'R-pending')
  assert.equal(pending.personaTag, 'smoke@2.0.0')
  assert.ok(Array.isArray(pending.used.loreIds))
  assert.ok(pending.used.loreIds.includes('wuchang-ranked'))
})

/* ───────────── W0-1 T2：canon 冷却真的生效（此前 canonUsed 只写不读） ───────────── */

test('canon 冷却：今天讲过的梗不再注入，也不重复记 used', () => {
  const today = dayKeyOf()
  const state = {
    date: today,
    canonUsed: { '问是不是 AI': today },
    loreUsed: {}, expressionUsed: {},
    recent: { comments: [], forms5: [], debt: {} },
  }
  const out = compilePersona(smokeCard(), { state, bank: null, roundId: 'R-canon' })
  // 断"canon 的渲染形态"而不是裸关键词：卡里 selfAwareness 也含「问是不是 AI」
  assert.ok(!out.text.includes('问是不是 AI →「'), '今天讲过的 canon 不该再出现在 P1')
  assert.deepEqual(out.used.canonKeys, [], '不该把它重复记进冷却表')
})

test('canon 冷却：冷却表是昨天的 ⇒ 今天照常注入', () => {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 3600_000)
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const out = compilePersona(smokeCard(), {
    state: {
      date: ymd(today),
      canonUsed: { '问是不是 AI': ymd(yesterday) },
      loreUsed: {}, expressionUsed: {},
      recent: { comments: [], forms5: [], debt: {} },
    },
    bank: null,
    roundId: 'R-canon2',
  })
  assert.ok(out.text.includes('问是不是 AI →「'), '昨天的冷却不该挡住今天')
  assert.deepEqual(out.used.canonKeys, ['问是不是 AI'])
})

/* ───────────── W0-1 T3：commitPendingUsage 三条边界（过期 / 串轮 / 正常转正） ───────────── */

const pendingFile = () => join(HOME, 'persona', 'pending-usage.json')
const seedPending = (roundId, at, used) => {
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(pendingFile(), JSON.stringify({ roundId, at, personaTag: 'smoke@2.0.0', used }), 'utf8')
}
const freshUsed = () => ({ loreIds: ['wuchang-ranked'], canonKeys: ['问是不是 AI'], expressionIds: [] })

test('commitPendingUsage：超过 6 小时直接丢弃，不污染冷却表', () => {
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')
  const old = new Date(Date.now() - 7 * 3600_000).toISOString()
  seedPending('R-expired', old, freshUsed())

  assert.equal(commitPendingUsage('R-expired'), false)
  assert.equal(existsSync(pendingFile()), false, '过期 pending 应被删除')
  const st = loadState()
  assert.ok(!st.loreUsed?.['wuchang-ranked'], '过期轮次不该写进冷却表')
})

test('commitPendingUsage：roundId 不符就忽略（别人的轮次不动）', () => {
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')
  seedPending('R-other', new Date().toISOString(), freshUsed())

  assert.equal(commitPendingUsage('R-mine'), false)
  assert.equal(existsSync(pendingFile()), true, '串轮的 pending 不该被删（下一轮还要用）')
  const st = loadState()
  assert.ok(!st.loreUsed?.['wuchang-ranked'], '不该把别人的用量记到自己头上')
})

test('commitPendingUsage：本轮正常转正 → 冷却表有记录 + pending 被删', () => {
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')
  seedPending('R-ok', new Date().toISOString(), freshUsed())

  assert.equal(commitPendingUsage('R-ok'), true)
  const st = loadState()
  assert.ok(st.loreUsed?.['wuchang-ranked'], 'lore 应进冷却表')
  assert.ok(st.canonUsed?.['问是不是 AI'], 'canon 应进冷却表')
  assert.equal(String(st.canonUsed['问是不是 AI']), dayKeyOf(), 'canon 冷却按日期记')
  assert.equal(existsSync(pendingFile()), false, '转正后 pending 应删除')
})

/* ───────── W2-1：注入归因（报告头一行 + getLastPersonaInject 素材） ───────── */

const cardCfg = () => ({
  perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
  keywords: [], followUids: [], avoidList: [], followAuto: false, followPerRound: 0, personaPrompt: '',
})

test('W2-1：卡链路 ⇒ 报告「本轮参数」里带人设归因行，且 getLastPersonaInject 有素材', () => {
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(smokeCard(), null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')

  const prompt = buildDutyPrompt(cardCfg(), 'R-attrib')
  assert.match(prompt, /- 人设（报告头照抄这一行）：人设：smoke@2\.0\.0（/, '报告头必须有可照抄的人设行')
  assert.match(prompt, /合计 \d+/, '归因行要带总字符数')

  const info = getLastPersonaInject()
  assert.equal(info.roundId, 'R-attrib')
  assert.equal(info.personaRes.mode, 'card')
  assert.ok(info.guard && typeof info.guard.len === 'number')
  assert.ok(info.injectEvent, '卡链路必须产出 persona-inject 事件')
  assert.equal(info.injectEvent.type, 'persona-inject')
  assert.equal(info.injectEvent.personaTag, 'smoke@2.0.0')
  assert.deepEqual(info.injectEvent.degraded, [], '正常长度不该有降级')
  assert.ok(info.injectEvent.layers.length >= 4, '五块体量要在事件里')
})

test('W2-1：legacy 直通 ⇒ 不产出 persona-inject 事件、也不加报告行', () => {
  const legacyFile = join(HOME, 'legacy-persona.md')
  writeFileSync(legacyFile, '# 旧人设\n\n随便说两句就好。\n', 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: join(HOME, 'persona', 'card.json') }), 'utf8')

  const prompt = buildDutyPrompt({ ...cardCfg(), personaPrompt: legacyFile }, 'R-legacy')
  assert.ok(!prompt.includes('人设（报告头照抄这一行）'), 'legacy 不该有卡链路归因行')
  const info = getLastPersonaInject()
  assert.equal(info.personaRes.mode, 'legacy')
  assert.equal(info.injectEvent, null, 'legacy 不落 persona-inject')
})

/* ───────── W7-2：轮级发言门控接进 buildDutyPrompt（observe 只提示、enforce 才压上限） ───────── */

// 用真实的「现在」构造事件：门控按 now 算"距上次发言多少分钟"，写死日期会让阈值失效
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()
const denseEvents = () => [
  { t: minsAgo(40), type: 'view', bvid: 'BV1' },
  { t: minsAgo(3), type: 'comment', bvid: 'BV1', text: 'a' },
  { t: minsAgo(2), type: 'comment', bvid: 'BV1', text: 'b' },
  { t: minsAgo(1), type: 'comment', bvid: 'BV1', text: 'c' },
]
const quietEvents = () => [
  { t: minsAgo(180), type: 'comment', bvid: 'BV1', text: 'a' },
  { t: minsAgo(120), type: 'view', bvid: 'BV2' },
  { t: minsAgo(90), type: 'view', bvid: 'BV3' },
  { t: minsAgo(60), type: 'view', bvid: 'BV4' },
  { t: minsAgo(30), type: 'view', bvid: 'BV5' },
]

const ensureCard = () => {
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(smokeCard(), null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')
  writeFileSync(join(HOME, 'persona', 'state.json'), '{}', 'utf8')
}

test('W7-2 observe（默认）：节奏太密只在 prompt 里提示，**不**压评论上限', () => {
  ensureCard()
  const prompt = buildDutyPrompt({ ...cardCfg(), commentsPerRound: 2 }, 'R-gate-obs', denseEvents())
  assert.match(prompt, /- 发言节奏（宿主算好、别自己数）：发言门控：观察中（不拦） · 收紧 —— /)
  assert.match(prompt, /本轮最多 2 条/, 'observe 不改上限')
  assert.ok(!/门控压过/.test(prompt), 'observe 不该出现"压过"字样')
  const info = getLastSpeakGate()
  assert.equal(info.roundId, 'R-gate-obs')
  assert.equal(info.gate.mode, 'observe')
  assert.equal(info.gate.decision, 'throttle')
  assert.equal(info.gate.enforced, false)
})

test('W7-2 enforce：节奏太密时真的把本轮评论上限压到 1 条（且写明压过）', () => {
  ensureCard()
  const prompt = buildDutyPrompt({ ...cardCfg(), commentsPerRound: 2, speakGateMode: 'enforce' }, 'R-gate-enf', denseEvents())
  assert.match(prompt, /本轮最多 1 条（门控压过：原 2 → 1）/)
  assert.match(prompt, /已把本轮评论上限压到 1 条/)
  assert.equal(getLastSpeakGate().gate.enforced, true)
})

test('W7-2 节奏正常 / off 档：上限与文案都按原样', () => {
  ensureCard()
  const normal = buildDutyPrompt({ ...cardCfg(), commentsPerRound: 2 }, 'R-gate-ok', quietEvents())
  assert.match(normal, /发言门控：观察中（不拦） · 正常/)
  assert.match(normal, /本轮最多 2 条/)
  assert.ok(!/门控压过/.test(normal))

  const off = buildDutyPrompt({ ...cardCfg(), commentsPerRound: 2, speakGateMode: 'off' }, 'R-gate-off', denseEvents())
  assert.match(off, /发言门控：关闭 · 正常/)
  assert.match(off, /本轮最多 2 条/)
  assert.equal(getLastSpeakGate().gate.mode, 'off')
})
