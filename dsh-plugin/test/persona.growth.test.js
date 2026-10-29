// dsh-plugin/test/persona.growth.test.js
// 人设自演化管道：质检链逐闸 / 入库 / 转正限额 / 过期 / 淘汰。全部走临时家目录。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-growth-'))

const {
  processGrowth, appendPending, vetCorpus, vetLore, pruneBucket, GROWTH_LIMITS,
  loadBank, loadCard, readActive, loadState, normalizeBank,
} = await import('../lib/persona/index.js')
import { personaDir } from '../lib/persona/store.js'

const home = () => process.env.BILI_FENSHEN_HOME
const ledgerFile = () => join(home(), 'ledger.jsonl')
const pendingFile = () => join(personaDir(), 'growth-pending.jsonl')

// 测试用的账本：两条自己发过的评论（self 对账数据源）
const OWN1 = '这英雄是不是还得削？'
const OWN2 = '看得我直接煮了碗面'

const seedLedger = () => {
  mkdirSync(home(), { recursive: true })
  writeFileSync(ledgerFile(), [
    JSON.stringify({ t: '2026-10-27T02:00:00.000Z', round: 'r1', type: 'comment', bvid: 'BV1', text: OWN1, rpid: 1 }),
    JSON.stringify({ t: '2026-10-27T02:05:00.000Z', round: 'r1', type: 'comment', bvid: 'BV2', text: OWN2, rpid: 2 }),
  ].join('\n'), 'utf8')
}

const dayOffset = (days) => new Date(Date.now() + days * 86400_000).toISOString()

after(() => { try { rmSync(home(), { recursive: true, force: true }) } catch { /* 兜住 */ } })

test('质检链：self 对账失败 → 拒（不许编造"我说过"）', () => {
  const out = vetCorpus({ kind: 'corpus', form: 'reaction', text: '这句话我没说过但假装说过', origin: 'self' }, { bank: normalizeBank({}), card: null, ownTexts: [OWN1] })
  assert.equal(out.ok, false)
  assert.match(out.reason, /账本|对账|编造/)
})

test('质检链：self 对账成功（2-gram ≥0.8）→ 过', () => {
  const out = vetCorpus({ kind: 'corpus', form: 'question', text: OWN1, origin: 'self' }, { bank: normalizeBank({}), card: null, ownTexts: [OWN1] })
  assert.equal(out.ok, true, out.reason)
  assert.equal(out.entry.status, 'candidate')
  assert.match(out.entry.source, /自沉淀/)
  assert.ok(out.entry.addedAt, 'candidate 需要 addedAt（转正 FIFO 排序键）')
})

test('质检链：community 超 30 字 / 缺 source → 拒；合规公共梗 → 过', () => {
  const long = vetCorpus({ kind: 'corpus', form: 'meme', text: '这一句故意写得很长很长很长已经超过三十个字的限制了吧你看真的超过了吧', origin: 'community', source: '社区' }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(long.ok, false)
  assert.match(long.reason, /30/)

  const noSrc = vetCorpus({ kind: 'corpus', form: 'meme', text: '电子榨菜', origin: 'community' }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(noSrc.ok, false)
  assert.match(noSrc.reason, /source/)

  const ok = vetCorpus({ kind: 'corpus', form: 'meme', text: '电子榨菜', origin: 'community', source: '社区通用梗', originalText: '今天又是靠这个视频当电子榨菜的一天' }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(ok.ok, true, ok.reason)
  assert.match(ok.entry.source, /公共梗/)
})

test('质检链：禁词 / 政治词表 / 查重 → 拒', () => {
  const meta = vetCorpus({ kind: 'corpus', form: 'reaction', text: OWN1, origin: 'self' }, { bank: normalizeBank({}), card: { voice: { avoid: { bannedWords: [] } } }, ownTexts: [] })
  void meta
  // 元话语（用 self 文本绕过对账：直接测 bannedHit 逻辑组合——这里用 processGrowth 全链覆盖，见下）

  const politics = vetCorpus({ kind: 'corpus', form: 'reaction', text: '这个时评写得真好', origin: 'self' }, { bank: normalizeBank({}), card: null, ownTexts: ['这个时评写得真好'] })
  assert.equal(politics.ok, false)
  assert.match(politics.reason, /时评|政治/)

  const bank1 = { buckets: { meme: [{ id: 'a', text: '史味的巧克力', form: 'meme', status: 'active', len: 6, heat: 0, source: '' }] } }
  const dup = vetCorpus({ kind: 'corpus', form: 'meme', text: '史味的巧克力！', origin: 'community', source: '梗', originalText: '原帖是另一句跟巧克力完全无关的热评' }, { bank: normalizeBank(bank1), card: null, ownTexts: [] })
  assert.equal(dup.ok, false)
  assert.match(dup.reason, /重合/)
})

/* ───────────── 2026-10-29 核验 §2.2-A：词表收窄 + 定案台词豁免 ───────────── */

// 与 whale 卡同形的卡：canon 定案台词 + 收窄后的 bannedWords
const canonCard = {
  canon: [{ when: '被问是谁家的鱼 / 你主人是谁', say: '主人是跟我一起用这个账号的捏', cooldown: '1/day' }],
  voice: { avoid: { bannedWords: ['@主人汇报'] } },
}

test('§2.2-A 三例①：定案台词「主人是跟我一起用这个账号的捏」→ 通过（裸「主人」已出词表）', () => {
  const out = vetCorpus(
    { kind: 'corpus', form: 'reaction', text: '主人是跟我一起用这个账号的捏', origin: 'self' },
    { bank: normalizeBank({}), card: canonCard, ownTexts: ['主人是跟我一起用这个账号的捏'] },
  )
  assert.equal(out.ok, true, out.reason)
})

test('§2.2-A 三例②：「@主人汇报」→ 拒（卡禁词 + 元话语双闸，永不豁免）', () => {
  const out = vetCorpus(
    { kind: 'corpus', form: 'reaction', text: '@主人汇报今天的饭钱', origin: 'self' },
    { bank: normalizeBank({}), card: canonCard, ownTexts: ['@主人汇报今天的饭钱'] },
  )
  assert.equal(out.ok, false)
  assert.match(out.reason, /禁词|红线词/)
})

test('§2.2-A 三例③：含「值班 / 小号 / 账号主人」→ 拒（元话语闸保留）', () => {
  for (const [text, hit] of [['今天我值班到凌晨', '值班'], ['这号是不是小号啊', '小号'], ['账号主人今天不在家', '账号主人']]) {
    const out = vetCorpus(
      { kind: 'corpus', form: 'reaction', text, origin: 'self' },
      { bank: normalizeBank({}), card: canonCard, ownTexts: [text] },
    )
    assert.equal(out.ok, false, `${text} 应被拒`)
    assert.match(out.reason, new RegExp(hit))
  }
})

test('§2.2-A 豁免边界：整句是 canon 台词才放行元话语词；canon + 政治词照拒', () => {
  // canon 台词本身含元话语词「值班」→ 整句豁免 → 通过
  const exemptCard = { canon: [{ say: '值班结束记得喂鱼' }], voice: { avoid: { bannedWords: [] } } }
  const exempt = vetCorpus(
    { kind: 'corpus', form: 'reaction', text: '值班结束记得喂鱼', origin: 'self' },
    { bank: normalizeBank({}), card: exemptCard, ownTexts: ['值班结束记得喂鱼'] },
  )
  assert.equal(exempt.ok, true, exempt.reason)

  // 不是 canon 的句子含「值班」→ 拒
  const notCanon = vetCorpus(
    { kind: 'corpus', form: 'reaction', text: '值班结束聊聊选举', origin: 'self' },
    { bank: normalizeBank({}), card: exemptCard, ownTexts: ['值班结束聊聊选举'] },
  )
  assert.equal(notCanon.ok, false)
  assert.match(notCanon.reason, /选举|值班/)
})

test('processGrowth 全链：self 过审入库为 candidate + 拒绝原因落 processed', async () => {
  seedLedger()
  const ledgerEvents = [
    { t: '2026-10-27T02:00:00.000Z', round: 'r1', type: 'comment', bvid: 'BV1', text: OWN1, rpid: 1 },
    { t: '2026-10-27T02:05:00.000Z', round: 'r1', type: 'comment', bvid: 'BV2', text: OWN2, rpid: 2 },
  ]
  appendPending({ kind: 'corpus', form: 'question', text: OWN1, origin: 'self', source: '被赞 3 次' })
  appendPending({ kind: 'corpus', form: 'reaction', text: '这句话我没说过', origin: 'self' })
  const out = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: ledgerEvents })
  assert.equal(out.ok, true)
  assert.equal(out.stats.received, 2)
  assert.equal(out.stats.acceptedCorpus, 1)
  assert.equal(out.stats.rejected, 1)

  const bank = loadBank()
  const hit = (bank.buckets.question || []).find((e) => e.text === OWN1)
  assert.ok(hit, '过审候选应已入库')
  assert.equal(hit.status, 'candidate')
  assert.ok(!existsSync(pendingFile()), '消化完 pending 应清空')
  assert.ok(existsSync(join(personaDir(), 'growth-processed.jsonl')), '处理日志应存在')
})

test('每日转正限额：4 条满分 candidate 只转 3（FIFO），跨天重置', async () => {
  const bank = loadBank()
  // 清掉上一条测试的 candidate，铺 4 条干净的
  for (const f of Object.keys(bank.buckets)) bank.buckets[f] = bank.buckets[f].filter((e) => e.source !== '自沉淀：被赞 3 次')
  for (let i = 0; i < 4; i++) {
    bank.buckets.question.push({
      id: `fifo#${i}`, text: `测试候选第${i}条`, form: 'question',
      source: '自沉淀：测试', status: 'candidate', len: 8, heat: 0,
      addedAt: new Date(Date.now() - (100 - i) * 60000).toISOString(), // i 越大越新
    })
  }
  const { saveBank } = await import('../lib/persona/store.js')
  saveBank(bank)

  // 模拟"今天还没转正过"：清掉计数
  const { saveState } = await import('../lib/persona/state.js')
  saveState({ growthPromoted: { date: '2000-01-01', count: 99 } })

  const out = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 3 }, events: [] })
  assert.equal(out.stats.promoted, 3, '只转 3 条')
  const after = loadBank()
  const activeQ = after.buckets.question.filter((e) => e.source === '自沉淀：测试' && e.status === 'active')
  const candQ = after.buckets.question.filter((e) => e.source === '自沉淀：测试' && e.status === 'candidate')
  assert.equal(activeQ.length, 3)
  assert.equal(candQ.length, 1)
  assert.equal(activeQ[0].id, 'fifo#0', 'FIFO：最老的先转正')
  const st = loadState()
  assert.equal(st.growthPromoted.count, 3)
  // ⭐ 期望值必须用「本地日」算：实现走 dayKeyLocal，而在 UTC+8 的 00:00–08:00 之间
  //    toISOString() 还是前一天（跨午夜必挂的历史时间炸弹）
  const nowD = new Date()
  const localDay = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`
  assert.equal(st.growthPromoted.date, localDay, '本地日')

  // 当天再跑：额度已用完，不转
  const out2 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 3 }, events: [] })
  assert.equal(out2.stats.promoted, 0)
})

test('pending 过期：超 14 天的候选丢弃并记录', () => {
  const stale = { kind: 'corpus', form: 'meme', text: '过期的一条', origin: 'community', source: '梗', originalText: '原帖热评原文甲', pendingAt: dayOffset(-15) }
  const fresh = { kind: 'corpus', form: 'meme', text: '新鲜的一条', origin: 'community', source: '梗', originalText: '原帖热评原文乙', pendingAt: new Date().toISOString() }
  appendPending(stale)
  appendPending(fresh)
  const out = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: [] })
  assert.equal(out.stats.expired, 1)
  assert.equal(out.stats.acceptedCorpus, 1)
  const bank = loadBank()
  assert.ok((bank.buckets.meme || []).some((e) => e.text === '新鲜的一条'))
  assert.ok(!(bank.buckets.meme || []).some((e) => e.text === '过期的一条'))
})

test('lore 过审：索引进卡（出版本快照）+ 正文落盘；id 冲突与真实性词表被拒', async () => {
  const add1 = appendPending({ kind: 'lore', id: 'test-growth', keys: ['测试', '生长'], oneLine: '照着视频煮饭翻车了', body: '照着三分钟的教程煮饭，糊了。' })
  assert.equal(add1.ok, true)
  const out = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: [] })
  assert.equal(out.stats.acceptedLore, 1)
  const card = loadCard().card
  const hit = (card.loreIndex || []).find((l) => l.id === 'test-growth')
  assert.ok(hit, '见闻索引应进卡')
  assert.ok(existsSync(join(personaDir(), 'lore', 'test-growth.md')), '正文应落盘')

  const dupId = appendPending({ kind: 'lore', id: 'test-growth', keys: ['测试'], oneLine: '另一条摘要' })
  assert.equal(dupId.ok, true) // 工具层收（它不知道卡内容），宿主质检拒
  const out2 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: [] })
  assert.equal(out2.stats.rejected, 1)

  const fab = appendPending({ kind: 'lore', id: 'fab-entry', keys: ['朋友'], oneLine: '我朋友在字节上班', body: '吹牛' })
  assert.equal(fab.ok, true)
  const out3 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: [] })
  assert.equal(out3.stats.acceptedLore, 0)
  assert.ok(out3.stats.rejected >= 1)
})

test('pruneBucket：active 满额降最旧低热；candidate 满额删最旧', () => {
  const mk = (i, status, heat) => ({ id: `e${i}`, text: `t${i}`, form: 'meme', status, len: 2, heat, source: '', addedAt: new Date(Date.now() - i * 1000).toISOString() })
  const entries = []
  for (let i = 0; i < 6; i++) entries.push(mk(i, 'active', 0))
  const out = pruneBucket(entries, { activeCap: 4, candidateCap: 10 })
  assert.equal(out.list.filter((e) => e.status === 'active').length, 4)
  assert.equal(out.demoted, 2)
  // 降级的是最旧（addedAt 最老 = i 大）
  assert.equal(out.list.filter((e) => e.status === 'candidate').map((e) => e.id).sort().join(','), ['e4', 'e5'].sort().join(','))

  const cands = []
  for (let i = 0; i < 5; i++) cands.push(mk(i, 'candidate', 0))
  const out2 = pruneBucket(cands, { activeCap: 2, candidateCap: 3 })
  assert.equal(out2.removed, 2)
  assert.equal(out2.list.length, 3)
})

test('growthEnable=false：不消化 pending', () => {
  appendPending({ kind: 'corpus', form: 'meme', text: '停用期间的一条', origin: 'community', source: '梗' })
  const out = processGrowth({ cfg: { growthEnable: false }, events: [] })
  assert.equal(out.skipped, 'growthEnable=false')
  assert.equal(out.stats.received, 0)
  assert.ok(existsSync(pendingFile()), 'pending 保留到重新开启')
  // 清理：手动清空 pending，别影响后续
  try { rmSync(pendingFile(), { force: true }) } catch { /* 兜住 */ }
})

test('GROWTH_LIMITS 决策 B 常量', () => {
  assert.equal(GROWTH_LIMITS.perRoundPerKind, 5)
  assert.equal(GROWTH_LIMITS.pendingTtlDays, 14)
  assert.equal(GROWTH_LIMITS.activeCap, 200)
  assert.equal(GROWTH_LIMITS.promotePerDay, 3)
})

/* ───────────── W2-3 语料治理（统一方案 §8.3）新增四件的逐条覆盖 ───────────── */

test('W2-3 origin 三分①：blocked 永不入库，只做反例（vetCorpus 拒 + processGrowth 留反例记录）', () => {
  const out = vetCorpus({ kind: 'corpus', form: 'meme', text: '这是一个不该入库的反例', origin: 'blocked' }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(out.ok, false)
  assert.equal(out.blocked, true, 'blocked 要带 blocked 标记，供处理日志记反例')
  assert.match(out.reason, /blocked|反例/)

  appendPending({ kind: 'corpus', form: 'meme', text: '另一条反例', origin: 'blocked' })
  const g = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: [] })
  assert.equal(g.stats.blocked, 1)
  assert.ok(!Object.values(loadBank().buckets).flat().some((e) => e.text === '另一条反例'), 'blocked 不得入库')
})

test('W2-3 origin 三分②：community 必须附原帖原文，且与原帖 >60% 判抄；改写后才过', () => {
  // 缺"与原帖"原文 → 无法做改写检查 → 拒（否则 community 条目本身就是抄来的）
  const noOriginal = vetCorpus({ kind: 'corpus', form: 'meme', text: '电子榨菜', origin: 'community', source: '梗' }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(noOriginal.ok, false)
  assert.match(noOriginal.reason, /originalText|原帖/)

  // 逐字抄原帖 → 拒
  const original = '这巧克力怎么一股史味啊兄弟们'
  const copied = vetCorpus({ kind: 'corpus', form: 'meme', text: original, origin: 'community', source: '热评', originalText: original }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(copied.ok, false)
  assert.match(copied.reason, /重合|改写/)

  // 改写过（与原帖重合低）→ 过，origin 落库为 community
  const rewritten = vetCorpus({ kind: 'corpus', form: 'meme', text: '史味巧克力', origin: 'community', source: '热评', originalText: original }, { bank: normalizeBank({}), card: null, ownTexts: [] })
  assert.equal(rewritten.ok, true, rewritten.reason)
  assert.equal(rewritten.entry.origin, 'community')
})

test('W2-3 结构升级：situation/style 成对、各 ≤20 字；落库带字段，前缀「当/时/可以」被归一', () => {
  const base = { kind: 'corpus', form: 'reaction', text: OWN1, origin: 'self' }
  const onlySituation = vetCorpus({ ...base, situation: '看到离谱操作' }, { bank: normalizeBank({}), card: null, ownTexts: [OWN1] })
  assert.equal(onlySituation.ok, false)
  assert.match(onlySituation.reason, /成对|style/)

  const tooLong = vetCorpus({ ...base, situation: '第一次看到这种完全超出常识又没法解释的操作', style: '发一句短感叹' }, { bank: normalizeBank({}), card: null, ownTexts: [OWN1] })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.reason, /situation 超长/)

  const ok = vetCorpus({ ...base, situation: '当看到离谱操作时', style: '可以发一句短感叹' }, { bank: normalizeBank({}), card: null, ownTexts: [OWN1] })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(ok.entry.situation, '看到离谱操作', '「当…时」的前后缀由渲染模板补，不入库')
  assert.equal(ok.entry.style, '发一句短感叹', '「可以」前缀由渲染模板补，不入库')
})

test('W2-3 写入闸门①：count 加权——同一句重复提交只累加 count，不重复入库', () => {
  const ev = [{ t: new Date().toISOString(), round: 'r1', type: 'comment', bvid: 'BV1', text: OWN1 }]
  appendPending({ kind: 'corpus', form: 'question', text: OWN1, origin: 'self' })
  const g1 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: ev })
  assert.equal(g1.stats.acceptedCorpus, 1)
  const before = loadBank().buckets.question.filter((e) => e.text === OWN1)
  assert.equal(before.length, 1)
  assert.equal(before[0].count, 1)

  appendPending({ kind: 'corpus', form: 'question', text: OWN1, origin: 'self' })
  const g2 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: ev })
  assert.equal(g2.stats.counted, 1, '重复提交应计为 count 加权，而不是又入库一条')
  const after = loadBank().buckets.question.filter((e) => e.text === OWN1)
  assert.equal(after.length, 1)
  assert.equal(after[0].count, 2)
})

test('W2-3 写入闸门②：AI 复核位（review 回调）未过不入库，过了标 aiReviewed', () => {
  const ev = [{ t: new Date().toISOString(), round: 'r1', type: 'comment', bvid: 'BV2', text: OWN2 }]
  appendPending({ kind: 'corpus', form: 'experience', text: OWN2, origin: 'self' })
  const rejected = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: ev, review: () => ({ ok: false, reason: '太像 AI 写的' }) })
  assert.equal(rejected.stats.reviewRejected, 1)
  assert.ok(!loadBank().buckets.experience.some((e) => e.text === OWN2), 'AI 复核未过不得入库')

  appendPending({ kind: 'corpus', form: 'experience', text: OWN2, origin: 'self' })
  const ok = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 0 }, events: ev, review: () => ({ ok: true }) })
  assert.equal(ok.stats.acceptedCorpus, 1)
  const hit = loadBank().buckets.experience.find((e) => e.text === OWN2)
  assert.ok(hit, '复核通过应入库')
  assert.equal(hit.aiReviewed, true)
  assert.equal(hit.checked, false, 'AI 复核 ≠ 人工确认')
})

test('W2-3 写入闸门③：人工位 checked=false，checkedOnly=true 时不自动转正；人工置 true 后可转', async () => {
  const text = '这个细节我还真没注意过'
  const ev = [{ t: new Date().toISOString(), round: 'r1', type: 'comment', bvid: 'BV3', text }]
  appendPending({ kind: 'corpus', form: 'detail', text, origin: 'self' })
  const g1 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 99 }, events: ev, checkedOnly: true })
  assert.equal(g1.stats.acceptedCorpus, 1)
  const hit = loadBank().buckets.detail.find((e) => e.text === text)
  assert.ok(hit)
  assert.equal(hit.checked, false)
  assert.equal(hit.status, 'candidate', 'checked=false 在 checkedOnly 下不得自动转正')

  // 人工确认（控制台/人工修剪置 checked=true）→ 下一轮可转正
  const { saveBank } = await import('../lib/persona/store.js')
  const bank = loadBank()
  bank.buckets.detail.find((e) => e.text === text).checked = true
  saveBank(bank)
  const g2 = processGrowth({ cfg: { growthEnable: true, growthAutoPromote: 99 }, events: [], checkedOnly: true })
  assert.equal(g2.stats.promoted, 1)
  assert.equal(loadBank().buckets.detail.find((e) => e.text === text).status, 'active')
})
