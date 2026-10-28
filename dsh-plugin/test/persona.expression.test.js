// dsh-plugin/test/persona.expression.test.js
// W2-3 语料治理（统一方案 §8.3）的表达库侧：旧格式回落字节级不变 / situation+style 渲染 /
// 注入预算（≤5 条 ≤300 字）/ origin 归一 / 反抄升级（库条目 vs 原帖热评）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BUCKETS, ORIGINS, EXPRESSION_LIMITS, normalizeBank, activeOf, pickExpression,
  renderExpression, renderExpressionEntry, normalizeSituation, normalizeStyle,
  looksCopied, rewriteCheck, auditBankAgainstOriginals, bankStats,
} from '../lib/persona/expression.js'

const seed = JSON.parse(readFileSync(fileURLToPath(new URL('../prompts/persona/expression-bank.seed.json', import.meta.url)), 'utf8'))
const seedBank = normalizeBank(seed)

// 2026-10-28 改动前实测的 seed 渲染输出（逐字节基线）：
// 「旧格式回落」一旦破坏，这份字面量会先红。另一个 writer 的快照锁的是 whale 编译字节，这里是它的 P4 源。
const OLD_RENDER = {
  reaction: '别人是这么说的：\n· 怎么会这样\n· 难绷',
  question: '别人是这么说的：\n· 能隔空取奖杯吗？[星星眼]\n· 这个内阁是什么新英雄吗？[思考]\n· 原来中国也有这种校车吗，我还没在现实里见过\n· 封面能不能好好做？',
  experience: '别人是这么说的：\n· 我操，真到我家了，我在宽甸县宽甸镇\n· 我以为这是怕吓到我们打的码，结果居然是雨哥自己切的。。咋反应这么快。我不行了\n· 我是广西人，第一次去东北同学家里蹭婚宴，三天吃了这辈子最多的馒头，每天都有随便喝的大窑汽水，吃晕了[doge]',
  meme: '别人是这么说的：\n· 无世凯依旧窃取猛攻果实（）\n· 史味的巧克力\n· 69：（拿起对面水晶）这个归我啦🤓👆\n· 我单三，我怯战，我飞升，跑路了兄弟！',
  detail: '别人是这么说的：\n· magpie是版本答案\n· 可以底层代码都是一样的，以中心点向四周扩散有障碍物就没用的大招[吃瓜]',
  rant: '别人是这么说的：\n· 苹果是我爹，不许你们这么说它[大哭]\n· 就这半斤重的雷霆手机买的人这辈子有了。\n· 引领者？推动者？我没看错吧？\n· 最后一队真区啊，开透还打不过',
}

test('seed 库旧条目渲染：与改动前逐字节一致（没有 situation/style 必须回落旧格式）', () => {
  for (const form of BUCKETS) {
    const picked = pickExpression(seedBank, { form, seed: `R1:${form}`, count: 4 })
    assert.ok(picked.length > 0, `${form} 桶为空`)
    assert.equal(renderExpression(picked), OLD_RENDER[form], `${form} 桶渲染必须与 2026-10-28 前逐字节一致`)
  }
  for (const form of BUCKETS) {
    for (const e of seedBank.buckets[form]) {
      assert.equal(renderExpressionEntry(e), e.text, '旧条目必须回落 `· 原文`')
      assert.equal(e.situation, '')
      assert.equal(e.style, '')
    }
  }
})

test('结构升级渲染：situation+style 齐全 ⇒「当 S 时，可以 X」；「当/时/可以」前缀容错', () => {
  const text = renderExpression([
    { text: '难绷', situation: '看到离谱操作', style: '发一句短感叹' },
    { text: '怎么会这样', situation: '当看到离谱操作时', style: '可以发一句短感叹' },
  ])
  const line = '· 当看到离谱操作时，可以发一句短感叹'
  assert.equal(text, `别人是这么说的：\n${line}\n${line}`)
})

test('结构升级：同一批里新旧格式混排，旧条目仍回落原文', () => {
  const text = renderExpression([
    { text: '难绷' },
    { text: '示例原文', situation: '看到离谱操作', style: '发一句短感叹' },
  ])
  assert.equal(text, '别人是这么说的：\n· 难绷\n· 当看到离谱操作时，可以发一句短感叹')
})

test('结构升级：normalizeSituation / normalizeStyle 只剥模板前后缀', () => {
  assert.equal(normalizeSituation('当看到离谱操作时'), '看到离谱操作')
  assert.equal(normalizeSituation('看到离谱操作'), '看到离谱操作')
  assert.equal(normalizeSituation(''), '')
  assert.equal(normalizeStyle('可以发一句短感叹'), '发一句短感叹')
  assert.equal(normalizeStyle('发一句短感叹'), '发一句短感叹')
  assert.equal(EXPRESSION_LIMITS.situationMax, 20)
  assert.equal(EXPRESSION_LIMITS.styleMax, 20)
})

test('注入预算：≤5 条、≤300 字（第 2 条起受预算约束；单条不腰斩）', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `第${i}条` }))
  assert.equal(renderExpression(many).split('\n').length, 1 + EXPRESSION_LIMITS.injectMaxItems, '最多 5 条')

  const long = Array.from({ length: 6 }, (_, i) => ({ text: '长'.repeat(80) + i }))
  const out = renderExpression(long)
  const lines = out.split('\n')
  assert.ok(lines.length >= 2 && lines.length - 1 <= 5)
  let used = 0
  for (let i = 1; i < lines.length; i++) used += lines[i].length + (i > 1 ? 1 : 0)
  assert.ok(used <= EXPRESSION_LIMITS.injectMaxChars, `注入正文 ${used} 字应 ≤300`)

  const single = renderExpression([{ text: '长'.repeat(400) }])
  assert.ok(single.includes('长'.repeat(400)), '单条超预算仍保留（不改变旧行为）')
})

test('normalizeBank：origin 三分归一（旧条目按 community）+ count/checked/aiReviewed/situation/style', () => {
  const bank = normalizeBank({
    buckets: {
      meme: [
        { text: '旧条目', status: 'active' },
        { text: '自产', status: 'candidate', origin: 'self' },
        { text: '反例', status: 'active', origin: 'blocked' },
        { text: '新格式', status: 'active', situation: '当看到离谱操作时', style: '可以发一句短感叹', count: 3, checked: true, aiReviewed: true },
      ],
    },
  })
  const byText = Object.fromEntries(bank.buckets.meme.map((e) => [e.text, e]))
  assert.deepEqual(ORIGINS, ['self', 'community', 'blocked'])
  assert.equal(byText['旧条目'].origin, 'community', 'seed/旧条目按最严档 community 归档')
  assert.equal(byText['旧条目'].count, 1)
  assert.equal(byText['旧条目'].checked, false)
  assert.equal(byText['自产'].origin, 'self')
  assert.equal(byText['反例'].origin, 'blocked')
  assert.equal(byText['新格式'].situation, '看到离谱操作')
  assert.equal(byText['新格式'].style, '发一句短感叹')
  assert.equal(byText['新格式'].count, 3)
  assert.equal(byText['新格式'].checked, true)
  assert.equal(byText['新格式'].aiReviewed, true)

  // blocked 永不参与注入（防御层）
  assert.ok(!activeOf(bank, 'meme').some((e) => e.origin === 'blocked'))
  const stats = bankStats(bank)
  assert.equal(stats.byOrigin.self, 1)
  assert.equal(stats.byOrigin.community, 2, '旧条目与新格式条目（未标 origin）都按 community 归档')
  assert.equal(stats.byOrigin.blocked, 1)
})

test('反抄护栏：草稿 vs 库内（looksCopied）>60% 判抄（B1-5 的既有护栏补测试）', () => {
  const bank = normalizeBank({ buckets: { meme: [{ text: '史味的巧克力', status: 'active' }] } })
  assert.equal(looksCopied('史味的巧克力', bank), true)
  assert.equal(looksCopied('今天天气真好', bank), false)
})

test('反抄升级：库条目 vs 原帖热评（rewriteCheck >60% 判逐字抄）', () => {
  const original = '这巧克力怎么一股史味啊兄弟们'
  const copied = rewriteCheck(original, [original])
  assert.equal(copied.copied, true)
  assert.ok(copied.max > 0.6)

  const rewritten = rewriteCheck('史味巧克力', [original])
  assert.equal(rewritten.copied, false)
  assert.ok(rewritten.max < 0.6)

  // 空原帖 = 无法检查（调用方必须拒绝 community，别静默放行）
  assert.equal(rewriteCheck('随便一句', []).copied, false)
  assert.equal(rewriteCheck('随便一句', []).max, 0)
})

test('反抄升级：存量审计——seed 的 source 此前无校验，用原文回灌可逐条标出', () => {
  const originalsByText = {}
  for (const form of BUCKETS) {
    for (const e of (seed.buckets[form] || [])) originalsByText[e.text] = [e.text]
  }
  const audit = auditBankAgainstOriginals(seed, originalsByText)
  assert.equal(audit.checked, audit.total, '有原文的条目都参与审计')
  assert.ok(audit.flagged.length > 0, '逐字取自热评的 seed 条目必须被标出')
  assert.ok(audit.flagged.every((f) => f.max > 0.6 && f.id && f.form))
})
