// P0/P1 关键回归：buildDutyPrompt 真的把（人设）拼进去了吗？
// 这是审计里 E1/E2 指出的空白 —— buildDutyPrompt 以前在 test/ 里 0 次调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'bf-persona-prompt-'))
process.env.BILI_FENSHEN_HOME = HOME

const { buildDutyPrompt } = await import('../index.js')
const { smokeCard } = await import('./fixtures/persona/smoke-card.js')

const whalePath = fileURLToPath(new URL('../prompts/persona-whale.md', import.meta.url))
const baseCfg = {
  perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
  keywords: [], followUids: [], avoidList: [], followAuto: false, followPerRound: 0,
}

test('legacy 人设：prompt 里有人设块（行为与升级前一致）', () => {
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: whalePath }, 'R-legacy')
  assert.match(p, /===== 人设（读自文件）/)
  assert.match(p, /值班章程/)
  assert.match(p, /本轮参数/)
  assert.ok(p.length < 24000, `prompt 过长：${p.length}`)
  // 注意：章程正文里也提到「你这会儿的状态」这个名字，所以要匹配**块标题**
  assert.doesNotMatch(p, /===== 你这会儿的状态 =====/, 'legacy 模式不该有 v2 后段')
})

test('v2 卡：prompt 有"前段（身份+生活）"和"后段（状态+手感+三行）"', () => {
  const card = smokeCard()
  const cardFile = join(HOME, 'persona', 'card.json')
  mkdirSync(join(HOME, 'persona'), { recursive: true })
  writeFileSync(cardFile, JSON.stringify(card, null, 2), 'utf8')
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'file', path: cardFile }), 'utf8')

  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '' }, 'R-card')
  assert.match(p, /===== 人设（smoke@2\.0\.0 · 按这个来说话） =====/)
  assert.match(p, /一个测试用的普通网友/)
  assert.match(p, /===== 你这会儿的状态 =====/)
  assert.match(p, /===== 写之前，最后看三行 =====/)
  // 位置纪律：身份在前段、尾注在整段最后
  assert.ok(p.indexOf('一个测试用的普通网友') < p.indexOf('值班章程'), '身份必须在章程之前')
  assert.ok(p.indexOf('写之前，最后看三行') > p.indexOf('本轮参数'), '尾注必须在参数之后')
  assert.ok(p.length < 24000, `prompt 过长：${p.length}`)
})

test('没有任何人设来源：降级为中性，不报错也不编人格', () => {
  // active 指向不存在的预设 ⇒ missing ⇒ 中性说明
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'preset', presetId: 'nope' }), 'utf8')
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '' }, 'R-none')
  assert.match(p, /中性说话|没有拿到人设/)
  assert.match(p, /值班章程/)
})

test('本轮参数：主动接话配额行 + 空账本的已看过清单行（空态）', () => {
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '', replyOthersPerRound: 2 }, 'R-seen-empty')
  assert.match(p, /主动接话本轮最多 2 条/, '接话配额要出现在本轮参数里')
  assert.match(p, /已看过清单（宿主从账本算好，最近 14 天，命中 = 之前看过\/评过\/赞过\/跳过过）：（空/, '空账本要明说清单为空')
  assert.match(p, /照常逐条判/, '空态要给出正常判重的指令')
})

test('本轮参数：账本里看过的 BV 注入清单，命中纪律完整', () => {
  // buildDutyPrompt 的账本事件由调用方传入（runDuty 传 readEvents(...)）——
  // 两条近 14 天、一条 20 天前（应被窗口滤掉）
  const day = 86400_000
  const ev = (type, bvid, daysAgo) => ({ t: new Date(Date.now() - daysAgo * day).toISOString(), round: 'r', type, bvid })
  const events = [ev('view', 'BV1SeEnA0001', 1), ev('skip', 'BV1SeEnA0002', 3), ev('view', 'BV1SeEnA0003', 20)]
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '' }, 'R-seen-filled', events)
  assert.match(p, /BV1SeEnA0001、BV1SeEnA0002/, '近 14 天的 BV 要按新→旧注入（跳过过的也算看过）')
  assert.doesNotMatch(p, /BV1SeEnA0003/, '20 天前的不注入（窗口外）')
  assert.match(p, /命中的候选\*\*直接丢\*\*：不读信息、不读字幕、不点赞不评论、不进报告、不记判重表/, '命中纪律要完整')
})
