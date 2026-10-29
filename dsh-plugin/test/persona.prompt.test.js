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
  assert.match(p, /===== 写之前，最后看几行 =====/)
  // 位置纪律：身份在前段、尾注在整段最后
  assert.ok(p.indexOf('一个测试用的普通网友') < p.indexOf('值班章程'), '身份必须在章程之前')
  assert.ok(p.indexOf('写之前，最后看几行') > p.indexOf('本轮参数'), '尾注必须在参数之后')
  assert.ok(p.length < 24000, `prompt 过长：${p.length}`)
})

test('没有任何人设来源：降级为中性，不报错也不编人格', () => {
  // active 指向不存在的预设 ⇒ missing ⇒ 中性说明
  writeFileSync(join(HOME, 'persona', 'active.json'), JSON.stringify({ mode: 'preset', presetId: 'nope' }), 'utf8')
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '' }, 'R-none')
  assert.match(p, /中性说话|没有拿到人设/)
  assert.match(p, /值班章程/)
})

test('本轮参数：主动接话（硬步骤）+ 已回复清单 + 空账本的已看过清单行（空态）', () => {
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '', replyOthersPerRound: 2 }, 'R-seen-empty')
  // v5：接话不再是「最多 N 条」的可选动作，而是每轮必做的扫描（发不发另算）
  assert.match(p, /主动接话（\*\*每轮硬步骤\*\*/, '接话要写成每轮硬步骤')
  assert.match(p, /必须先做一次「接话扫描」/, '要明确要求扫描')
  assert.match(p, /可发上限 2 条/, '可发上限要出现在本轮参数里')
  // v6：已接话清单升级为已回复清单（接话+跟进统一目标判重）
  assert.match(p, /已回复清单（宿主从账本算好，近 14 天，接话\+跟进都在内/, '要注入已回复清单（去重弹药）')
  assert.match(p, /对方的 rpid 在清单里 = 我已经回过这条，永远不再回/, '目标级判重要写明命中后果')
  assert.match(p, /（空——最近没回复过任何人的评论，照常挑。）/, '空账本要明说清单为空并给出正常指令')
  assert.match(p, /已看过清单（宿主从账本算好，最近 14 天，命中 = 之前看过\/评过\/赞过\/跳过过）：（空/, '空账本要明说清单为空')
  assert.match(p, /照常逐条判/, '空态要给出正常判重的指令')
})

/* 2026-10-29 真实日志：配置 followPerRound=40，模型在「先扫哪几个 UP」上反复权衡，
 * 20 次工具预算先烧掉一截，最后只看了 4 个。注入时收口到 8，并把「配置写了几」明说。 */
test('本轮参数：每轮抽查 40 收口到 8，并说明是预算收口', () => {
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '', followAuto: true, followPerRound: 40 }, 'R-follow')
  assert.match(p, /取前 8 个/)
  assert.match(p, /配置写的是 40/)
  assert.doesNotMatch(p, /取前 40 个/)
  // 配置本身不超上限时不该出现收口说明
  const p8 = buildDutyPrompt({ ...baseCfg, personaPrompt: '', followAuto: true, followPerRound: 8 }, 'R-follow8')
  assert.doesNotMatch(p8, /配置写的是/)
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

test('本轮参数：跟进目标也要注入已回复清单（2026-10-29 Aria 楼连回 2 轮的回归）', () => {
  const day = 86400_000
  const iso = (d) => new Date(Date.now() - d * day).toISOString()
  const events = [
    { t: iso(1), round: 'r-a', type: 'reply-out', bvid: 'BV1TisX6dEFS', parent: 318480411329, text: '跟进话', rpid: 111 }, // 跟进
    { t: iso(1), round: 'r-a', type: 'reply-out', bvid: 'BV1Qsnt6HExf', parent: 318012908193, kind: 'proactive', text: '接话', rpid: 222 }, // 接话
  ]
  const p = buildDutyPrompt({ ...baseCfg, personaPrompt: '' }, 'R-followup-list', events)
  assert.match(p, /跟进（回过别人对我说的）：BV1TisX6dEFS→对方 rpid 318480411329/, '跟进目标必须进清单')
  assert.match(p, /接话（主动回过别人的评论）：BV1Qsnt6HExf→对方 rpid 318012908193/, '接话目标必须进清单')
})
