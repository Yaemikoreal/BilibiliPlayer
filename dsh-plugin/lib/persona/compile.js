/**
 * 编译器：人设卡 → 五块注入文本（P1 常驻 / P2 见闻索引 / P3 今日状态 / P4 语料样本 / P5 最后一公里）。
 *
 * 位置即设计（酒馆规范 + 我们的日志实测）：
 *   - **事实常驻、行为末尾**：身份/口味/红线在 P1（缺了必错）；"别收在判断上"在 P5（越靠近生成点越强）。
 *   - **示例靠后、数量极少**：P4 只给同形态 3–5 条，多了会变模板、被逐字复读。
 *   - **末尾位是竞争性资源**：P5 固定 3 行，且**不写具体句子**（给"标准收尾 5 选 1"会让 6 句里 5 句同格）。
 *   - **欠账是数据**："最近 5 条欠哪种形态"由宿主算，不让模型自己数。
 *
 * 纯函数：同一 (card, state, bank, roundId) 必得同一输出。
 */
import { fitBlock, summarize } from './budget.js'
import { charLen } from './text.js'
import { resolveLoreIndex, renderLoreIndex } from './lore.js'
import { debtLine } from './state.js'
import { pickExpression, renderExpression } from './expression.js'
import { pickGoodSamples, pickBadSample, renderSamples } from './sample.js'

const wrap = (title, body) => (body ? `===== ${title} =====\n${body}\n` : '')

/** 口吻事实（常驻）：只写"可机检的事实"，不写评语。 */
const voiceFacts = (v = {}) => {
  const bits = []
  if (Array.isArray(v.register) && v.register.length) bits.push(`语感：${v.register.join('、')}`)
  const s = v.sentence || {}
  if (s.typical) bits.push(`多数 ${s.typical[0]}–${s.typical[1]} 字`)
  if (s.hardMax) bits.push(`硬上限 ${s.hardMax} 字`)
  const p = v.punctuation || {}
  const punct = []
  if (p.periodMaxPerComment !== undefined) punct.push(`句号一条最多 ${p.periodMaxPerComment} 个`)
  if (p.semicolon === 'never') punct.push('不用分号')
  if (p.quoteMaxPerRound) punct.push(`引号整轮最多 ${p.quoteMaxPerRound} 次且只引台词`)
  if (punct.length) bits.push(punct.join('；'))
  const e = v.emoji || {}
  if (e.perComment) bits.push(`一条最多 ${e.perComment} 个表情`)
  if (e.atLeastPerRound) bits.push('一轮至少有一条带表情')
  return bits.join('；')
}

/** 说一下"我"的在场感（来自 intensity 三档，比抽象形容词有效）。 */
const selfPresence = (v = {}) =>
  v.intensity ? `情绪有档：轻「${v.intensity['轻'] || ''}」/ 中「${v.intensity['中'] || ''}」/ 重「${v.intensity['重'] || ''}」` : ''

/** P1 常驻核心：identity + 口吻事实 + 心态 + 品味 + 立场 + 红线摘要 + canon。 */
export const buildCore = (card = {}) => {
  const id = card.identity || {}
  const v = card.voice || {}
  const m = card.mindset || {}
  const t = card.taste || {}
  const lines = []

  if (id.oneLiner) lines.push(id.oneLiner)
  if (Array.isArray(id.boundaries) && id.boundaries.length) lines.push(id.boundaries.join(' / '))
  if (id.selfAwareness) lines.push(id.selfAwareness)
  if (id.background) lines.push(id.background)

  const vf = voiceFacts(v)
  if (vf) lines.push(vf)
  const sp = selfPresence(v)
  if (sp) lines.push(sp)

  const traits = (m.traits || [])
    .slice(0, 3)
    .map((x) => (x?.behaviors?.length ? `${x.name}（${String(x.behaviors[0])}）` : x?.name))
    .filter(Boolean)
  if (traits.length) lines.push(`性格：${traits.join('；')}`)
  if (m.contradictions?.length) lines.push(`矛盾：${m.contradictions.slice(0, 2).join('；')}`)
  if (m.emotion?.breakingPoint) lines.push(`破防：${m.emotion.breakingPoint}`)

  const watch = (t.watch || []).slice(0, 5)
  const avoid = (t.avoid || []).slice(0, 5)
  if (watch.length || avoid.length) {
    lines.push([watch.length ? `会看：${watch.join('、')}` : '', avoid.length ? `绕开：${avoid.join('、')}` : ''].filter(Boolean).join('；'))
  }
  if (t.criteria?.length) lines.push(`标准：${t.criteria.slice(0, 2).join('；')}`)

  for (const s of (card.stance || []).slice(0, 3)) {
    lines.push(`${s.topic}：${s.attitude}${s.how ? `（${s.how}）` : ''}`)
  }

  const avoidWords = [
    ...(v.avoid?.aiCues || []),
    ...(v.avoid?.bookish || []),
    ...(v.avoid?.bannedWords || []),
  ].slice(0, 14)
  if (avoidWords.length) lines.push(`禁用：${avoidWords.join(' / ')}`)

  // 红线：只压摘要（rule → instead），完整红线在卡里，质量门按卡判
  const red = (card.redlines || []).slice(0, 4).map((r) => `${r.rule}${r.instead ? ` → ${r.instead}` : ''}`)
  if (red.length) lines.push(`红线：${red.join('；')}`)

  for (const c of (card.canon || []).slice(0, 4)) {
    if (c.when && c.say) lines.push(`${c.when} →「${c.say}」`)
  }

  return lines.filter(Boolean).join('\n')
}

/** P3 今日状态：mood/精力/时段 + 沉默 + 最近 3 条 + 欠账 + 冷却。 */
export const buildState = (state = {}, { maxChars = null } = {}) => {
  if (!state) return ''
  const lines = []
  const mood = state.mood || {}
  const tod = state.timeOfDay || {}
  const head = [
    mood.label ? `今天${mood.label}` : '',
    mood.energy ? `精力 ${mood.energy}` : '',
    mood.patience ? `耐心 ${mood.patience}` : '',
    tod.label ? `时段：${tod.label}` : '',
    tod.note && tod.key && (tod.key === 'late' || tod.key === 'deep') ? tod.note : '',
  ].filter(Boolean)
  if (head.length) lines.push(head.join('，') + '。')

  if (state.skipStreak >= 3) lines.push(`连续 ${state.skipStreak} 条都没说上话，有点蔫；这条还接不上就只点赞。`)

  const recent = state.recent?.comments || []
  if (recent.length) {
    lines.push('最近说过：')
    for (const c of recent) lines.push(`· ${String(c.text).slice(0, 40)}`)
  }

  const d = debtLine(state)
  if (d) lines.push(`⚠️ ${d}`)
  // 时段会压上限（凌晨/深夜 40 字），与场域上限取更严的那个
  const hardMax = maxChars ? Math.min(Number(maxChars) || 100, Number(tod.maxChars) || 100) : tod.maxChars
  if (hardMax) lines.push(`这条按 ${hardMax} 字以内来。`)
  lines.push('接不上就点赞，别凑数。')
  return lines.join('\n')
}

/** P5 最后一公里：固定三行，只写约束，不写具体句子。 */
export const buildTail = (card = {}, { modeMax = 100 } = {}) => {
  const moves = (card.voice?.moves || []).slice(0, 6)
  // 红线只取短标签：尾注是竞争性资源，整句抄进末尾会把 3 行撑成一段
  const rules = (card.redlines || [])
    .filter((r) => r.severity === 'block')
    .slice(0, 3)
    .map((r) => String(r.rule || '').replace(/[（(].*?[）)]/g, '').slice(0, 10).trim())
    .filter(Boolean)
  const line1 = `1) 别收在判断上。收法轮换着来：${moves.length ? moves.join(' / ') : '纯情绪 / 反问 / 玩梗'}。`
  const line2 = '2) 第一句单独拿出来，没看过视频的人能读懂吗？'
  const line3 = `3) 红线：${rules.length ? rules.join('；') : '不碰政治地域性别饭圈；不冒充真人'}。`
  return [line1, line2, line3].join('\n')
}

/**
 * 编译整份人设。
 * @param {object} card
 * @param {object} ctx
 * @param {object} ctx.state  deriveState 的结果
 * @param {object|null} ctx.bank 表达库（可能为 null）
 * @param {string} ctx.roundId 本轮 id（做抽样 seed）
 * @param {number} [ctx.modeMax] 该场域字数上限（评论 100 / 回复 40）
 * @returns {{text:string, blocks:object, stats:object, notes:string[]}}
 */
export const compilePersona = (card = {}, ctx = {}) => {
  const { state = {}, bank = null, roundId = 'round', modeMax = 100, loreDir = 'persona/lore' } = ctx
  const notes = []
  const debt = state?.recent?.debt || {}

  // 欠账 → 目标形态（决定 P4 抽哪个桶 / 哪类卡内样本）
  const owed = []
  if (debt.question) owed.push('question')
  if (debt.reaction) owed.push('reaction')
  if (debt.experience) owed.push('experience')
  if (debt.emoji) owed.push('meme')
  const targetForm = owed[0] || (state?.recent?.forms5?.length ? '' : 'reaction')

  // P2 见闻索引（正文按需读，这里只放索引 + 绝对路径提示）
  const loreEntries = resolveLoreIndex(card, state)
  const loreBlock = fitBlock('lore', renderLoreIndex(loreEntries, { dir: loreDir }))

  // P4 语料样本：优先表达库（真实热评），空则退化到卡内 samples
  let p4 = ''
  if (bank) {
    const picked = pickExpression(bank, {
      form: targetForm || 'reaction',
      seed: `${roundId}:${targetForm}`,
      count: 4,
      usedToday: state?.expressionUsed || {},
    })
    p4 = renderExpression(picked)
    if (p4) notes.push(`P4 用表达库（${targetForm || 'reaction'}，${picked.length} 条）`)
  }
  if (!p4) {
    const goods = pickGoodSamples(card, {
      form: targetForm,
      seed: `${roundId}:${targetForm}`,
      count: 4,
      avoidTexts: (state?.recent?.comments || []).map((c) => c.text),
    })
    p4 = renderSamples(goods, pickBadSample(card, roundId))
    if (p4) notes.push(`P4 退化到卡内样本（${goods.length} 条）`)
  } else {
    const bad = pickBadSample(card, roundId)
    if (bad?.text) p4 += `\n反例（别这样）：${bad.text}${bad.reason ? ` —— ${bad.reason}` : ''}`
  }

  const blocks = {
    core: fitBlock('core', buildCore(card)),
    lore: loreBlock,
    state: fitBlock('state', buildState(state, { maxChars: modeMax })),
    samples: fitBlock('samples', p4),
    tail: fitBlock('tail', buildTail(card, { modeMax })),
  }

  let text = [
    wrap('你是谁（按这个来）', blocks.core.text),
    wrap('你的生活（相关时才用；要用先读正文）', blocks.lore.text),
    wrap('你这会儿的状态', blocks.state.text),
    wrap('手感（看落点，别抄内容）', blocks.samples.text),
    wrap('写之前，最后看三行', blocks.tail.text),
  ].filter(Boolean).join('\n')

  const stats = summarize(blocks)
  // 整轮 prompt 的降级由宿主在拼完 prompt 后按 guardPrompt 决定（这里只报块级统计）
  if (stats.over.length) notes.push(`块超预算：${stats.over.join(', ')}`)
  if (stats.overTotal) notes.push(`人设总长 ${stats.total} > ${stats.totalMax}`)

  return { text, blocks, stats, notes, targetForm }
}
