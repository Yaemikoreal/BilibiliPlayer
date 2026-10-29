/**
 * 编译器：人设卡 → 五块注入文本（P1 常驻 / P2 见闻索引 / P3 今日状态 / P4 语料样本 / P5 最后一公里）。
 *
 * 位置即设计（酒馆规范 + 我们的日志实测）：
 *   - **事实常驻、行为末尾**：身份/口味/红线在 P1（缺了必错）；"别收在判断上"在 P5（越靠近生成点越强）。
 *   - **示例靠后、数量极少**：P4 只给同形态 3–5 条，多了会变模板、被逐字复读。
 *   - **末尾位是竞争性资源**：P5 只写约束、**不写具体句子**（给"标准收尾 5 选 1"会让 6 句里 5 句同格）。
 *   - **欠账是数据**："最近 5 条欠哪种形态"由宿主算，不让模型自己数。
 *   - **场域不同、字数不同**：评论 100 / 楼中楼 40 / 动态 60（W1-2），与时段上限取更严。
 *
 * 纯函数：同一 (card, state, bank, roundId, modes, degrade) 必得同一输出。
 */
import { fitBlock, summarize, resolveBudget, effectiveModes, MODE_LABELS } from './budget.js'
import { resolveLoreIndex, renderLoreIndex } from './lore.js'
import { debtLine, usedToday } from './state.js'
import { pickExpression, renderExpression } from './expression.js'
import { pickGoodSamples, pickBadSample, renderSamples } from './sample.js'
import { venuePlanOf } from './lint.js'

const wrap = (title, body) => (body ? `===== ${title} =====\n${body}\n` : '')

/**
 * 口吻事实（常驻）：只写"可机检的事实"，不写评语。
 *
 * 口径定论（W1-4）：`voice.jargon.quotaPerDay` / `cooldownRounds` 与 `mindset.judgement`
 * **不注入**，原因三条：
 *   1. 它们本来就不在 `injectedText` 的考察范围里（L0 从未把它们算作"已注入"）；
 *   2. quota/cooldown 是**宿主侧派发与冷却**数字（由账本 + `state.canonUsed` 执行），
 *      写进 prompt 只会让模型自己数数——日志证明它数不准；
 *   3. `judgement` 是卡作者的配比自述（对应 traits/samples 的落点），不是可机检约束；
 *      真要调低判断力，改 traits 与 samples，不要指望一个数字。
 * 低频词 `jargon.allow` 则必须注入（可用但少用），否则它只是卡里的死配置。
 */
const voiceFacts = (v = {}) => {
  const bits = []
  if (Array.isArray(v.register) && v.register.length) bits.push(`语感：${v.register.join('、')}`)
  const s = v.sentence || {}
  if (s.typical) bits.push(`多数 ${s.typical[0]}–${s.typical[1]} 字`)
  if (s.hardMax) bits.push(`硬上限 ${s.hardMax} 字`)
  const p = v.punctuation || {}
  const punct = []
  if (p.periodMaxPerComment !== undefined) {
    // 2026-10-29 核验 §2.4：periodMax=0 是本号的风格规定（非语料事实），提示语按"不使用句号"说
    punct.push(p.periodMaxPerComment === 0 ? '不使用句号（换行或表情结句）' : `句号一条最多 ${p.periodMaxPerComment} 个`)
  }
  if (p.semicolon === 'never') punct.push('不用分号')
  if (p.quoteMaxPerRound) punct.push(`引号整轮最多 ${p.quoteMaxPerRound} 次且只引台词`)
  if (punct.length) bits.push(punct.join('；'))
  const e = v.emoji || {}
  if (e.perComment) bits.push(`一条最多 ${e.perComment} 个表情`)
  if (e.atLeastPerRound) bits.push('一轮至少有一条带表情')
  // W1-4：低频词必须让人看见（否则 quotas/词表都是死配置）
  if (Array.isArray(v.jargon?.allow) && v.jargon.allow.length) {
    bits.push(`低频词可用但少用：${v.jargon.allow.join('、')}`)
  }
  return bits.join('；')
}

/** 说一下"我"的在场感（来自 intensity 三档，比抽象形容词有效）。 */
const selfPresence = (v = {}) =>
  v.intensity ? `情绪有档：轻「${v.intensity['轻'] || ''}」/ 中「${v.intensity['中'] || ''}」/ 重「${v.intensity['重'] || ''}」` : ''

/**
 * venues 三档音量段（2026-10-29 核验 §2.4 决策 A：接进 prompt + 质量门 + bili_reply venue 参数）。
 * 一行给出各档字数上限与选档动作，注入 P3 状态块；默认档排最前。没有 venues / 数值 max 的卡返回空串。
 */
const venueTextOf = (card = {}) => {
  const venues = card?.venues
  const list = venues && typeof venues === 'object' && venues.list && typeof venues.list === 'object' ? venues.list : {}
  const def = String(venues?.default || '').trim()
  const rows = []
  for (const [name, v] of Object.entries(list)) {
    const n = Number(v?.max)
    if (!String(name).trim() || !Number.isFinite(n) || n <= 0) continue
    const chars = String(v?.chars || '').trim()
    rows.push({
      name: String(name).trim(),
      text: `${name === def ? `${String(name).trim()}（默认）` : String(name).trim()}${chars ? ` ${chars} 字` : ''} 上限 ${n}`,
    })
  }
  if (!rows.length) return ''
  rows.sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : 0))
  return `剧场分层（评论先选档，发评论时给 bili_reply 传 venue=档名）：${rows.map((r) => r.text).join('；')}。`
}

/**
 * canon 的"今天用过了吗"判定。
 *
 * 冷却表里 canonUsed 存的是**日期**（`YYYY-MM-DD`，见 state.js recordUsage），与 lore 存时间戳不同。
 * 优先用 `state.date`（deriveState 派生，纯函数可复现）；拿不到就退回 usedToday 的当天口径。
 */
export const canonUsedOn = (state, key) => {
  const at = state?.canonUsed?.[key]
  if (typeof at !== 'string') return false
  const day = state?.date
  return day ? at.slice(0, 10) === day : usedToday(state?.canonUsed, key)
}

/**
 * 挑选本轮要注入的 canon（最多 6 条，且跳过今天已经讲过的）。
 *
 * 为什么必须有这一步：`state.js:167` 一直在写 `canonUsed`，但全仓没有读取方 ⇒
 * canon 的"同一天不重复讲同一个梗"是空转的（W0-1 T2）。
 * 为什么是 6 而不是 4：卡里 6 条 canon 各有触发场景（问 AI / 夸可爱 / 骂营销号 / 问运营 /
 * 求三连 / 问画师），截到 4 会把后两条（求三连、问画师）永远丢掉——这两条正是 md 里有的
 * （W1-6 diff B12）。core 预算 1500 装得下（实测 core 仍 <1300）。
 */
export const pickCanon = (card = {}, state = {}) =>
  (card?.canon || [])
    .filter((c) => c && c.when && c.say)
    .filter((c) => !canonUsedOn(state, c.when))
    .slice(0, 6)

/** P1 常驻核心：identity + 口吻事实 + 心态 + 品味 + 立场 + 红线摘要 + canon。 */
export const buildCore = (card = {}, { state = {} } = {}) => {
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

  // 立场：attitude 是"怎么做"，misread 是"别被误读成什么"（W1-4 把两稿都漏掉的 misread 补进来）
  for (const s of (card.stance || []).slice(0, 3)) {
    const extra = [s.how, s.misread ? `别误解成：${s.misread}` : ''].filter(Boolean).join('；')
    lines.push(`${s.topic}：${s.attitude}${extra ? `（${extra}）` : ''}`)
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

  for (const c of pickCanon(card, state)) {
    lines.push(`${c.when} →「${c.say}」`)
  }

  return lines.filter(Boolean).join('\n')
}

/**
 * P3 今日状态：mood/精力/时段 + 沉默 + 最近 3 条 + 欠账 + 冷却 + 场域字数。
 *
 * @param {object} state deriveState 的输出
 * @param {object} [opts]
 * @param {number} [opts.maxChars] 单一字数上限（旧口径：场域未知时的 modeMax）
 * @param {object} [opts.modes] 场域字数 `{comment,reply,dynamic}`（W1-2）；给了就输出一行场域表
 * @param {boolean} [opts.shrink] 降级动作 `state:shrink`：丢掉"最近说过"列表，保住状态/欠账/字数
 * @param {string} [opts.memoryText] W7-1 记忆段（已渲染好的人话；空串=不注入）
 * @param {string} [opts.selfCorrect] W7-3 体检自纠（一句动作提示；空串=不注入）
 * @param {string} [opts.venueText] venues 三档音量段（§2.4 决策 A；空串=卡里没有 venues）
 */
export const buildState = (state = {}, { maxChars = null, modes = null, shrink = false, memoryText = '', selfCorrect = '', venueText = '' } = {}) => {
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

  const recent = shrink ? [] : state.recent?.comments || []
  if (recent.length) {
    lines.push('最近说过：')
    for (const c of recent) lines.push(`· ${String(c.text).slice(0, 40)}`)
  }

  const d = debtLine(state)
  if (d) lines.push(`⚠️ ${d}`)
  // W7-1 记忆：放在状态块里（C2 通道）——它是"状态"不是"身份"，
  // 放 C1 会变成每一步都在付 token；降级 state:shrink 时也一起丢（先保尾注与字数口径）。
  if (memoryText && !shrink) lines.push(memoryText)
  // W7-3 体检自纠：上一轮体检超出阈值时，这一轮只补**一句**动作（不报数字——模型不会做那个算术）
  if (selfCorrect && !shrink) lines.push(`⚠️ ${selfCorrect}`)
  if (modes) {
    // W1-2：场域表 —— 各场域上限与时段上限取更严的那个，绝不因"凌晨"把楼中楼放宽
    const caps = effectiveModes(modes, tod.maxChars)
    const strict = Math.min(...Object.keys(MODE_LABELS).map((k) => caps[k]))
    lines.push(`字数：评论 ${caps.comment} / 楼中楼 ${caps.reply} / 动态 ${caps.dynamic} 字封顶（哪个场域用哪个数；现在最紧 ${strict} 字）。`)
    // §2.4 决策 A：venues 三档音量段跟在场域表后面（评论字数以档位为准）
    if (venueText && !shrink) lines.push(venueText)
  } else {
    // 时段会压上限（凌晨/深夜 40 字），与场域上限取更严的那个
    const hardMax = maxChars ? Math.min(Number(maxChars) || 100, Number(tod.maxChars) || 100) : tod.maxChars
    if (hardMax) lines.push(`这条按 ${hardMax} 字以内来。`)
  }
  lines.push('接不上就点赞，别凑数。')
  return lines.join('\n')
}

/**
 * P5 最后一公里：只写约束，不写具体句子；固定行数（默认 3 行 + 口径补齐行）。
 *
 * @param {object} card
 * @param {object} [opts]
 * @param {number} [opts.modeMax] 旧口径单一上限（与 modes 二选一）
 * @param {object} [opts.modes] 场域字数（W1-2）：给了就把"楼中楼/动态别铺开写"钉在末尾
 * @param {number|null} [opts.todMaxChars] 时段上限：与场域上限**取更严的**（凌晨/深夜 40），
 *        否则会出现「P3 说评论 40、P5 说动态 60」的两套口径（W1-4 要消灭的正是这种分叉）
 */
export const buildTail = (card = {}, { modeMax = 100, modes = null, todMaxChars = null } = {}) => {
  const moves = (card.voice?.moves || []).slice(0, 6)
  // 红线只取**短标签**：尾注是竞争性资源，整句抄进末尾会把行撑成一段。
  // 以前的 slice(0,10) 会把 "碰政治内容：政治新闻、…" 硬切成病句（实测输出 "红线：碰政治内容：政治新闻。"），
  // 改成取第一个分隔符（：/（/、）之前的标签；标签本身太长才退回卡里的 id。
  const shortRule = (r) => {
    const label = String(r?.rule || '').split(/[：:（(]/)[0].replace(/[，,。；;\s]/g, '').trim()
    return label.length >= 2 && label.length <= 14 ? label : String(r?.id || label).trim()
  }
  const rules = (card.redlines || [])
    .filter((r) => r.severity === 'block')
    .slice(0, 3)
    .map(shortRule)
    .filter(Boolean)
  const lines = []
  lines.push(`1) 别收在判断上。收法轮换着来：${moves.length ? moves.join(' / ') : '纯情绪 / 反问 / 玩梗'}。`)
  lines.push('2) 第一句单独拿出来，没看过视频的人能读懂吗？')
  lines.push(`3) 红线：${rules.length ? rules.join('；') : '不碰政治地域性别饭圈；不冒充真人'}。`)

  // W1-4：behaviorStyle 的"兴趣优先"进尾注（1 行）——它决定"这条值不值得开口"，
  // 而 injectedText 一直把它算作已注入却从不注入，是两稿都漏的口径分叉之一。
  const interestFirst = String(card.behaviorStyle?.interestFirst || '').trim()
  if (interestFirst) {
    lines.push(`${lines.length + 1}) ${interestFirst.replace(/[。.]$/, '')}。`)
  }

  if (modes) {
    // W1-2：buildTail 以前收了 modeMax 却没用；这里把"场域不同、长度不同"钉在最靠近生成点的位置。
    // 与 P3 用同一个 effectiveModes(modes, 时段上限)：**同一套数字**，不允许两处各说一套。
    const caps = effectiveModes(modes, todMaxChars)
    lines.push(`${lines.length + 1}) 楼中楼 ${caps.reply} 字、动态 ${caps.dynamic} 字封顶，别把评论 ${caps.comment} 字的长度带过去。`)
  }
  return lines.join('\n')
}

/**
 * 五块 → 单段文本（控制台预览 / 调试用；与 compilePersona(...).text 是同一份拼装）。
 * @param {object} blocks
 */
export const renderPersonaText = (blocks = {}) => [
  wrap('你是谁（按这个来）', blocks.core?.text),
  wrap('你的生活（相关时才用；要用先读正文）', blocks.lore?.text),
  wrap('你这会儿的状态', blocks.state?.text),
  wrap('手感（看落点，别抄内容）', blocks.samples?.text),
  wrap('写之前，最后看几行', blocks.tail?.text),
].filter(Boolean).join('\n')

/**
 * 编译整份人设。
 *
 * @param {object} card
 * @param {object} ctx
 * @param {object} ctx.state  deriveState 的结果
 * @param {object|null} ctx.bank 表达库（可能为 null）
 * @param {string} ctx.roundId 本轮 id（做抽样 seed）
 * @param {number} [ctx.modeMax] 该场域字数上限（评论 100 / 回复 40）——旧口径
 * @param {object} [ctx.modes] 场域字数 `{comment,reply,dynamic}`（W1-2；给了则取代 modeMax）
 * @param {object} [ctx.budget] 生效五块预算（缺省读卡 `render.budget`，再缺省 BUDGET）
 * @param {string[]} [ctx.degrade] 降级动作（W1-5）：lore:shrink / lore:drop / samples:half / samples:drop / state:shrink / state:drop
 * @returns {{text:string, blocks:object, stats:object, notes:string[], targetForm:string, used:object,
 *            budget:object, loreIndex:Array, degraded:string[]}}
 */
export const compilePersona = (card = {}, ctx = {}) => {
  const {
    state = {}, bank = null, roundId = 'round', modeMax = 100, modes = null,
    budget = null, degrade = [], loreDir = 'persona/lore', memoryText = '', selfCorrect = '',
  } = ctx
  const notes = []
  const actions = Array.isArray(degrade) ? degradesOnly(degrade) : []
  const has = (a) => actions.includes(a)
  const effBudget = budget || resolveBudget(card)
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
  const loreMax = has('lore:shrink') ? 5 : 8
  const loreText = renderLoreIndex(loreEntries, { dir: loreDir, maxItems: loreMax })
  const loreBlock = fitBlock('lore', has('lore:drop') ? '' : loreText, effBudget)

  // P4 语料样本：优先表达库（真实热评），空则退化到卡内 samples
  const sampleCount = has('samples:half') ? 2 : 4
  let p4 = ''
  const usedExpressionIds = []
  if (bank && !has('samples:drop')) {
    const picked = pickExpression(bank, {
      form: targetForm || 'reaction',
      seed: `${roundId}:${targetForm}`,
      count: sampleCount,
      usedToday: state?.expressionUsed || {},
    })
    p4 = renderExpression(picked)
    for (const e of picked) if (e?.id) usedExpressionIds.push(e.id)
    if (p4) notes.push(`P4 用表达库（${targetForm || 'reaction'}，${picked.length} 条）`)
  }
  if (!p4 && !has('samples:drop')) {
    const goods = pickGoodSamples(card, {
      form: targetForm,
      seed: `${roundId}:${targetForm}`,
      count: sampleCount,
      avoidTexts: (state?.recent?.comments || []).map((c) => c.text),
    })
    p4 = renderSamples(goods, pickBadSample(card, roundId))
    if (p4) notes.push(`P4 退化到卡内样本（${goods.length} 条）`)
  } else if (p4 && !has('samples:drop')) {
    const bad = pickBadSample(card, roundId)
    if (bad?.text) p4 += `\n反例（别这样）：${bad.text}${bad.reason ? ` —— ${bad.reason}` : ''}`
  }

  // venues 三档（§2.4 决策 A）：评论场域的提示上限按默认档取（质量门按现场档取，lint.js venuePlanOf 同源）；
  // 卡里没有 venues / 默认档不在表里时保持原 modes，一个字节都不动。
  const venue = venuePlanOf(card)
  const venueDefaultMax = venue.default ? Number(venue.limits[venue.default]) : NaN
  const effModesForPrompt = modes && typeof modes === 'object' && Number.isFinite(venueDefaultMax) && venueDefaultMax > 0
    ? { ...modes, comment: venueDefaultMax }
    : modes
  const venueText = venueTextOf(card)

  const stateText = buildState(state, { maxChars: modeMax, modes: effModesForPrompt, shrink: has('state:shrink'), memoryText, selfCorrect, venueText })
  const blocks = {
    core: fitBlock('core', buildCore(card, { state }), effBudget),
    lore: loreBlock,
    state: fitBlock('state', has('state:drop') ? '' : stateText, effBudget),
    samples: fitBlock('samples', p4, effBudget),
    tail: fitBlock('tail', buildTail(card, { modeMax, modes: effModesForPrompt, todMaxChars: state?.timeOfDay?.maxChars ?? null }), effBudget),
  }

  let text = renderPersonaText(blocks)

  const stats = summarize(blocks)
  // 整轮 prompt 的降级由宿主在拼完 prompt 后按 guardPrompt 决定（这里只报块级统计）
  if (stats.over.length) notes.push(`块超预算：${stats.over.join(', ')}`)
  if (stats.overTotal) notes.push(`人设总长 ${stats.total} > ${stats.totalMax}`)
  if (actions.length) notes.push(`人设降级：${actions.join('、')}`)

  // ⭐ 冷却表的事实来源：这一轮"摆到台面上"的见闻索引 / canon / 语料条目。
  //    宿主在轮末用 recordUsage 回写；否则 usedToday 永远判 false，「同一天不重复讲同一件事」
  //    从未生效（recordUsage 此前只有测试调用）。
  const used = {
    loreIds: has('lore:drop')
      ? []
      // 只记**真正摆出来的那几条里**还没用过的（索引被截断时，后面的本来就没注入）
      : loreEntries.slice(0, loreMax).filter((e) => !e.usedToday).map((e) => e.id),
    // 只记**实际注入**的 canon（已按冷却表过滤），否则今天讲过的会被重复记一遍
    canonKeys: pickCanon(card, state).map((c) => c.when),
    expressionIds: usedExpressionIds,
  }

  return {
    text, blocks, stats, notes, targetForm, used,
    budget: effBudget,
    loreIndex: loreEntries,       // W1-0 c3Hints 用：W6 生成期命中见闻正文的索引
    degraded: actions,            // W1-5：实际执行的降级动作（供 W2-1 写 persona-inject.degraded）
  }
}

/** 只保留已知降级动作（未知项忽略，避免脏输入把编译搞坏）。 */
const KNOWN_DEGRADE = ['lore:shrink', 'lore:drop', 'samples:half', 'samples:drop', 'state:shrink', 'state:drop']
const degradesOnly = (list) => list.map((x) => String(x)).filter((x) => KNOWN_DEGRADE.includes(x))
