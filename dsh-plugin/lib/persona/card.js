/**
 * 人设卡 v2：schema 校验 + L0 静态判据 + 旧 markdown 迁移器。
 *
 * 为什么要有这一层（三条实证）：
 *   1. 红线只写"不许"会被注意力捕获（否定即粉红大象）→ 每条必须有 `instead`。
 *   2. 逐字口癖/梗清单会被"看到就用"→ 复读到腻 → 用词频上限 + 低频配额表。
 *   3. 示例里的"签名梗"会被逐字模仿 → 示例之间不许 3-gram 重合。
 * 这些都能纯字符串判定，所以放 L0（保存/CI 时跑，零运行时成本），不交给模型自觉。
 */
import { jaccard, sentences, stripEmoji } from './text.js'

export const SPEC = 'bili-fenshen.persona/v2'
export const FORMS = ['reaction', 'question', 'experience', 'meme', 'detail', 'rant']

/** 以否定开头的句子（用于"禁止句占比"与"instead 不能又是否定"）。 */
const NEG_START = /^(不|别|禁止|勿|不要|不能|不许|严禁|避免|切勿)/

/** 红线三件套里 `instead` 允许的开头（正向动作）。 */
const isPositiveInstead = (s) => {
  const t = String(s ?? '').trim()
  return t.length >= 4 && !NEG_START.test(t)
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0
const arr = (v) => (Array.isArray(v) ? v : [])

/* ───────────────────────── 注入文本（L0 判据的考察对象） ───────────────────────── */

/**
 * 把"会被注入 prompt 的字段"拼成一段纯文本（不含 creatorNotes）。
 * L0 的禁止句占比、词频、签名梗都在这段文本上算 —— 口径与真实注入一致。
 */
export const injectedText = (card = {}) => {
  const parts = []
  const id = card.identity || {}
  parts.push(id.oneLiner, id.background, id.selfAwareness, ...arr(id.boundaries))

  const v = card.voice || {}
  parts.push(...arr(v.register))
  parts.push(...arr(v.moves))
  if (v.jargon?.allow) parts.push(arr(v.jargon.allow).join(' '))
  if (v.intensity) parts.push(...Object.values(v.intensity).filter(isStr))
  if (v.avoid) {
    parts.push(...arr(v.avoid.aiCues), ...arr(v.avoid.bookish), ...arr(v.avoid.bannedWords))
  }
  parts.push(...arr(v.samples?.good).map((s) => s?.text), ...arr(v.samples?.bad).map((s) => s?.text))

  const m = card.mindset || {}
  for (const t of arr(m.traits)) {
    parts.push(t?.name, ...arr(t?.behaviors))
  }
  parts.push(...arr(m.contradictions))
  if (m.emotion) parts.push(m.emotion.breakingPoint)

  const taste = card.taste || {}
  parts.push(...arr(taste.watch), ...arr(taste.avoid), ...arr(taste.criteria))

  for (const s of arr(card.stance)) parts.push(s?.topic, s?.attitude, s?.how, s?.misread)

  for (const r of arr(card.redlines)) parts.push(r?.rule, r?.instead)

  for (const c of arr(card.canon)) parts.push(c?.when, c?.say)

  const b = card.behaviorStyle || {}
  parts.push(...arr(b.speakWhen), ...arr(b.stayQuiet), b.interestFirst)

  for (const l of arr(card.loreIndex)) parts.push(l?.oneLine)

  return parts.filter(isStr).join('\n')
}

/* ───────────────────────── schema 校验 ───────────────────────── */

/**
 * 校验一张卡。返回 {ok, errors, warnings}；errors 带 `path`，控制台可直接定位到字段。
 * 宽容原则：影响"能不能跑"的才 error；影响"好不好"的只 warn。
 */
export const validateCard = (card) => {
  const errors = []
  const warnings = []
  const err = (path, msg) => errors.push({ path, msg })
  const warn = (path, msg) => warnings.push({ path, msg })

  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: [{ path: '', msg: '人设卡必须是一个对象' }], warnings }
  }

  if (card.spec !== SPEC) err('spec', `spec 必须是 "${SPEC}"`)
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/i.test(String(card.id ?? ''))) err('id', 'id 必须是 2–40 位字母数字/连字符')
  if (!/^\d+\.\d+\.\d+$/.test(String(card.version ?? ''))) err('version', 'version 必须是 x.y.z')
  if (!isStr(card.name)) err('name', 'name 必填')

  const id = card.identity
  if (!id || typeof id !== 'object') err('identity', 'identity 必填')
  else {
    if (!isStr(id.oneLiner)) err('identity.oneLiner', '一句话身份必填')
    if (!isStr(id.background)) warn('identity.background', '建议写 1–3 句背景（≤200 字）')
    if (!isStr(id.selfAwareness)) warn('identity.selfAwareness', '建议写「被问是不是 AI 怎么答」')
    if (!arr(id.boundaries).length) warn('identity.boundaries', '建议写明边界（官方/商业/真人）')
  }

  const v = card.voice
  if (!v || typeof v !== 'object') err('voice', 'voice 必填')
  else {
    if (!arr(v.moves).length) err('voice.moves', '手段表不能为空（至少 6 类收法）')
    else if (arr(v.moves).length < 6) err('voice.moves', `手段表至少 6 类，当前 ${arr(v.moves).length} 类`)
    if (v.jargon?.allow && arr(v.jargon.allow).length > 6) {
      err('voice.jargon.allow', '低频词表最多 6 个（多了就会变成"常备清单"→ 复读）')
    }
    const good = arr(v.samples?.good)
    if (good.length < 4) err('voice.samples.good', `好示例至少 4 条，当前 ${good.length} 条`)
    good.forEach((s, i) => {
      const p = `voice.samples.good[${i}]`
      if (!isStr(s?.text)) err(p, '缺少 text')
      if (!FORMS.includes(s?.form)) err(`${p}.form`, `form 必须是 ${FORMS.join('/')}`)
      if (!isStr(s?.source)) err(`${p}.source`, '必须写真实出处（不许无来源）')
    })
    const bad = arr(v.samples?.bad)
    if (!bad.length) warn('voice.samples.bad', '建议留 ≥3 条反例（比只写规则有效）')
    bad.forEach((s, i) => {
      if (!isStr(s?.text)) err(`voice.samples.bad[${i}].text`, '缺少 text')
      if (!isStr(s?.reason)) err(`voice.samples.bad[${i}].reason`, '反例必须写"为什么不好"')
    })
  }

  const m = card.mindset || {}
  for (const [i, c] of arr(m.contradictions).entries()) {
    const t = String(c ?? '').trim()
    if (!/vs|VS|但|却|又.+又/.test(t)) err(`mindset.contradictions[${i}]`, '矛盾必须写成 "X vs Y"（写不成拉扯的就是标签）')
    else {
      const parts = t.split(/vs|VS|但|却|又/).map((x) => x.trim()).filter(Boolean)
      const tooShort = parts.some((x) => x.replace(/[，,。\s]/g, '').length < 1)
      if (parts.length < 2 || tooShort || t.replace(/\s/g, '').length < 6) {
        err(`mindset.contradictions[${i}]`, '矛盾两侧都要有内容（总长 ≥6 字），且能被拆开')
      }
    }
  }

  const redlines = arr(card.redlines)
  if (!redlines.length) err('redlines', '红线不能为空')
  redlines.forEach((r, i) => {
    const p = `redlines[${i}]`
    if (!isStr(r?.rule)) err(p, '缺少 rule')
    if (!isStr(r?.why)) err(`${p}.why`, '缺少 why（为什么禁止）')
    if (!isStr(r?.instead)) err(`${p}.instead`, '缺少 instead（那要写成什么）')
    else if (!isPositiveInstead(r.instead)) err(`${p}.instead`, 'instead 必须是正向动作，不能又以"不/别/禁止"开头')
    if (!['block', 'warn'].includes(r?.severity)) warn(`${p}.severity`, 'severity 建议 block 或 warn')
    if (!isStr(r?.regex) && !isStr(r?.lexicon)) warn(p, '没有 regex/lexicon：质量门无法自动拦，只能靠模型自觉')
  })

  if (card.behaviorStyle) {
    if (!arr(card.behaviorStyle.speakWhen).length) warn('behaviorStyle.speakWhen', '建议写 ≥1 条"什么场景才开口"')
    if (!arr(card.behaviorStyle.stayQuiet).length) warn('behaviorStyle.stayQuiet', '建议写 ≥1 条"什么场景闭嘴"')
  }

  for (const [i, l] of arr(card.loreIndex).entries()) {
    if (!isStr(l?.id)) err(`loreIndex[${i}].id`, '缺少 id')
    if (!arr(l?.keys).length) err(`loreIndex[${i}].keys`, '缺少 keys（触发词）')
    if (!isStr(l?.oneLine)) warn(`loreIndex[${i}].oneLine`, '建议写一行摘要（注入用）')
  }

  for (const [i, c] of arr(card.canon).entries()) {
    if (!isStr(c?.when) || !isStr(c?.say)) err(`canon[${i}]`, 'canon 每条要有 when + say')
  }

  return { ok: errors.length === 0, errors, warnings }
}

/* ───────────────────────── L0 六条格式判据 ───────────────────────── */

/**
 * L0：保存/CI 时跑，纯字符串判定。
 * @param {object} card
 * @param {{text?: string}} [opts] text 传编译后的注入文本；不传则用 injectedText(card)
 * @returns {{ok:boolean, checks:Array<{id,name,level,pass,detail}>}}
 */
export const l0Checks = (card, opts = {}) => {
  const text = typeof opts.text === 'string' ? opts.text : injectedText(card)
  const checks = []

  // 1 红线三件套
  const redlines = arr(card?.redlines)
  const badRed = redlines
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => !isStr(r?.rule) || !isStr(r?.why) || !isPositiveInstead(r?.instead))
  checks.push({
    id: 'redline-triple',
    name: '红线三件套（不许+为什么+那要写成什么）',
    pass: redlines.length > 0 && badRed.length === 0,
    level: redlines.length && badRed.length ? 'fail' : redlines.length ? 'pass' : 'fail',
    detail: badRed.length ? `有 ${badRed.length}/${redlines.length} 条不完整（第 ${badRed.map((x) => x.i + 1).join('、')} 条）` : `${redlines.length} 条全部有 instead`,
  })

  // 2 禁止句占比 ≤25%
  const all = sentences(text)
  const neg = all.filter((s) => NEG_START.test(s))
  const ratio = all.length ? neg.length / all.length : 0
  checks.push({
    id: 'negative-ratio',
    name: '禁止句占比（≤25%）',
    pass: ratio <= 0.35,
    level: ratio <= 0.25 ? 'pass' : ratio <= 0.35 ? 'warn' : 'fail',
    detail: `${neg.length}/${all.length} = ${(ratio * 100).toFixed(0)}%`,
  })

  // 3 手段表 ≥6 类
  const moves = arr(card?.voice?.moves)
  checks.push({
    id: 'moves-table',
    name: '手段表（≥6 类可做的事）',
    pass: moves.length >= 6,
    level: moves.length >= 6 ? 'pass' : 'fail',
    detail: `${moves.length} 类`,
  })

  // 4 词频：签名词 ≤3 次
  const sig = [
    ...arr(card?.signatureWords),
    ...arr(card?.voice?.jargon?.allow),
    String(card?.name ?? '').trim(),
  ].filter((x) => typeof x === 'string' && x.trim().length >= 2)
  const freq = sig.map((w) => ({ w, n: text.split(w).length - 1 })).filter((x) => x.n > 3)
  checks.push({
    id: 'word-freq',
    name: '词频（签名词 ≤3 次）',
    pass: freq.length === 0,
    level: freq.length ? 'warn' : 'pass',
    detail: freq.length ? freq.map((x) => `"${x.w}"×${x.n}`).join('、') : '无超限词',
  })

  // 5 矛盾格式
  const cons = arr(card?.mindset?.contradictions)
  const badCons = cons.filter((c) => !/vs|VS|但|却|又.+又/.test(String(c ?? '')))
  checks.push({
    id: 'contradiction',
    name: '矛盾写成 X vs Y',
    pass: cons.length > 0 && badCons.length === 0,
    level: badCons.length ? 'fail' : cons.length ? 'pass' : 'warn',
    detail: cons.length ? `${cons.length} 条，${badCons.length} 条是标签` : '未写矛盾',
  })

  // 6 示例不重复 + 有来源
  const good = arr(card?.voice?.samples?.good)
  const dups = []
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      const sim = jaccard(good[i]?.text, good[j]?.text, 3)
      if (sim > 0.6) dups.push(`#${i + 1}~#${j + 1}(${sim.toFixed(2)})`)
    }
  }
  const noSrc = good.filter((s) => !isStr(s?.source)).length
  checks.push({
    id: 'sample-dup',
    name: '示例不重复且带来源',
    pass: dups.length === 0 && noSrc === 0,
    level: dups.length || noSrc ? 'fail' : 'pass',
    detail: [dups.length ? `重复：${dups.join('、')}` : '', noSrc ? `${noSrc} 条无来源` : ''].filter(Boolean).join('；') || `${good.length} 条互不重复`,
  })

  return { ok: checks.every((c) => c.level !== 'fail'), checks }
}

/* ───────────────────────── 旧 markdown → v2 卡（迁移器） ───────────────────────── */

const SECTION_MAP = [
  { re: /身份|你是谁|名字|设定/, to: 'identity' },
  { re: /语气样本|这样说|这样写|例句/, to: 'samples' },
  { re: /别这样|反例|写错了/, to: 'samplesBad' },
  { re: /红线|禁区|禁止|不能碰/, to: 'redlines' },
  { re: /被问|有人问|问答/, to: 'canon' },
  { re: /偏好|看什么|会看|绕开/, to: 'taste' },
  { re: /性格|性格.*五条|traits/, to: 'mindset' },
]

/**
 * 把 v1 的 markdown 人设机械拆成 v2 卡（不做语义改写，**结果标记 needsReview**）。
 * 用途：控制台"迁移预览"；绝不自动用于注入（注入仍走 legacy 直通）。
 * @returns {{card: object, report: {mapped: string[], unmapped: string[], notes: string[]}}}
 */
export const migrateLegacyMarkdown = (md, { id = 'migrated', name = '未命名人设', version = '2.0.0' } = {}) => {
  const raw = String(md ?? '')
  const sections = []
  const chunks = raw.split(/^##\s+/m)
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    const [head, ...rest] = chunk.split('\n')
    sections.push({ title: head.trim(), body: rest.join('\n').trim() })
  }

  const card = {
    spec: SPEC,
    id,
    version,
    name,
    language: 'zh-CN',
    license: 'UNKNOWN',
    source: 'migrated from markdown',
    updatedAt: new Date().toISOString(),
    needsReview: ['redlines.instead', 'mindset.contradictions', 'voice.samples.source', 'voice.moves'],
    creatorNotes: '由旧 markdown 人设机械迁移。未识别的段落已放入本字段（不注入 prompt）。\n须人工补齐：红线 instead、矛盾 X vs Y、示例来源、手段表。',
    identity: { oneLiner: '', background: '', selfAwareness: '', boundaries: [] },
    voice: {
      register: [], sentence: {}, punctuation: {}, emoji: {}, jargon: { allow: [], quotaPerDay: 1, cooldownRounds: 3 },
      moves: [], modes: {}, intensity: {}, avoid: { aiCues: [], bookish: [], bannedWords: [] },
      samples: { good: [], bad: [] },
    },
    mindset: { traits: [], contradictions: [], emotion: {}, judgement: 3 },
    taste: { watch: [], avoid: [], criteria: [] },
    stance: [],
    redlines: [],
    canon: [],
    loreIndex: [],
    behaviorStyle: { speakWhen: [], stayQuiet: [], interestFirst: '' },
  }

  const report = { mapped: [], unmapped: [], notes: [] }
  for (const { title, body } of sections) {
    const hit = SECTION_MAP.find((m) => m.re.test(title))
    if (!hit) {
      report.unmapped.push(title)
      card.creatorNotes += `\n\n## ${title}\n${body}`
      continue
    }
    report.mapped.push(`${title} → ${hit.to}`)
    if (hit.to === 'identity') card.identity.background += (card.identity.background ? '\n' : '') + body
    else if (hit.to === 'samples') {
      for (const line of body.split('\n')) {
        const t = line.replace(/^\s*[-*·]\s*/, '').trim()
        if (t.length >= 4 && t.length <= 80 && !NEG_START.test(t)) {
          card.voice.samples.good.push({ text: t, form: 'reaction', source: 'migrated', weight: 1 })
        }
      }
    } else if (hit.to === 'samplesBad') {
      for (const line of body.split('\n')) {
        const t = line.replace(/^\s*[-*·]\s*/, '').trim()
        if (t.length >= 4) card.voice.samples.bad.push({ text: t, reason: '旧人设列为反例' })
      }
    } else if (hit.to === 'redlines') {
      for (const line of body.split('\n')) {
        const t = line.replace(/^\s*[-*·🔴⚠️]\s*/u, '').trim()
        if (t.length >= 4) card.redlines.push({ id: `legacy-${card.redlines.length + 1}`, rule: t, why: '', instead: '', severity: 'warn' })
      }
    } else if (hit.to === 'canon') {
      for (const line of body.split('\n')) {
        const t = line.replace(/^\s*[-*·]\s*/, '').trim()
        if (t.length >= 4) card.canon.push({ when: t, say: '', cooldown: '1/day' })
      }
    } else if (hit.to === 'taste') {
      card.taste.watch.push(...body.split('\n').map((x) => x.replace(/^\s*[-*·]\s*/, '').trim()).filter((x) => x.length >= 2 && x.length <= 30))
    } else if (hit.to === 'mindset') {
      for (const line of body.split('\n')) {
        const t = line.replace(/^\s*[-*·\d.]+\s*/, '').trim()
        if (t) card.mindset.traits.push({ name: t.slice(0, 20), level: 5, behaviors: [] })
      }
    }
  }

  // 名字兜底：第一行 `# 标题` 里取
  const h1 = /^#\s+(.+)$/m.exec(raw)
  if (!card.identity.oneLiner && h1) card.identity.oneLiner = h1[1].trim().slice(0, 60)

  report.notes.push(`识别 ${report.mapped.length} 节，未识别 ${report.unmapped.length} 节（已进 creatorNotes）`)
  return { card, report }
}
