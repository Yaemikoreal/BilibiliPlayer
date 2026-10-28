/**
 * 发布前 lint（W2-2）：L1–L7 判据的**唯一事实来源**。
 *
 * 分工（计划 §6.3 / §8.1）：
 *   1. 本文件写死"判据怎么写、词表是什么、阈值取多少"，并把它整理成**声明式规则**（`buildLintRules`）；
 *   2. `scripts/export-lint-rules.mjs` 把这份声明导出成 `<家目录>/persona/lint-rules.json`；
 *   3. `mcp_server.py` 只做哑执行：读 JSON、按 `kind` 跑、按 `reasonTemplate` 拼理由——
 *      **不复制任何词表/阈值/判据文案**（跨语言唯一不漂移的做法：JS 出数据，对方只解释数据）。
 *   4. 本文件同时提供 `lintComment()` 给 JS 侧（控制台试写、回归测试）用；它跑的是同一批
 *      check 对象，所以 JS 与 Python 的判定不会各说各话。
 *
 * 为什么判据是数据而不是 if-else：
 *   同一套判据要在两种语言里执行（宿主 JS 能拿到 live 语料库，MCP Python 只有文件）。
 *   把判据写成数据，Python 侧就只有"解释器"没有"规则"；改判据只改这里，导出一遍即可。
 *
 * 阈值来源（§8.1）：247 条真人基线 + 当前卡 `voice` 事实 + 场域上限。
 *   - 场域上限：`card.voice.modes[form].maxChars`（评论 100 / 楼中楼 40 / 动态 60），缺省见 DEFAULT_LIMITS；
 *   - 句号/表情：`card.voice.punctuation.periodMaxPerComment`、`card.voice.emoji.perComment`；
 *   - 247 条基线（中位 27 字 / 句号 10.9% / 问号 12.6% / 表情 41.7%）进 `baseline` 段，
 *     当前用于把建议写成"人话"，后续 W5-2 体检直接复用这一段，不再抄第二份数字。
 */
import { jaccard, charLen, stripEmoji, countEmoji } from './text.js'
import { looksCopied, bankOverlap, activeTexts } from './expression.js'

export const LINT_SPEC = 'bili-fenshen.lint-rules/v1'

/** rollout 档位：off 一键回滚 / warn 先跑三天 / block 才真拦（§6.3）。 */
export const ROLLOUT_MODES = ['off', 'warn', 'block']
export const DEFAULT_ROLLOUT = 'warn'

/** 场域字数上限（W1 拍板 100/40/60）。**只是缺省值**：生效值从规则文件读。 */
export const DEFAULT_LIMITS = Object.freeze({ comment: 100, reply: 40, dynamic: 60 })
export const LINT_FORMS = ['comment', 'reply', 'dynamic']

/** 247 条真人热评基线（§1.3，固定常量；随版本号改，不许各自漂移）。 */
export const HUMAN_BASELINE = Object.freeze({
  comments: 247,
  medianChars: 27,
  periodRate: 0.109,
  questionRate: 0.126,
  emojiRate: 0.417,
  note: '247 条真人热评（10-25 语料统计）：中位 27 字 / 句号 10.9% / 问号 12.6% / 表情 41.7%；阈值取保守侧。',
})

/** L1 落点：收尾不得是空泛捧场（§8.1 词表原文）。 */
export const BLAND_CLOSINGS = Object.freeze(['不错', '学习了', '太强了', '牛', '爱了', '支持', '收藏了'])
/** L2 自足：首句不得以指代开手（§8.1 词表原文）。 */
export const LEAD_PRONOUNS = Object.freeze(['这个', '那句', '上面', '他', '它'])
/** L3 再创作：整句被引号包裹且达到这个字数 ⇒ 复述未加工信号。 */
export const QUOTED_MIN_CHARS = 8
/** L4 反抄：与 active 语料字符 2-gram Jaccard 上限（与 expression.js 的 looksCopied 同口径）。 */
export const COPY_NGRAM = 2
export const COPY_MAX = 0.6

/**
 * 卡里红线用符号名引用词表（如 `"lexicon": "policy:politics"`）。
 * 词表定义在这里——卡只写"挡什么"，词表由代码维护。
 * 注：`growth.js` 的 POLITICS_WORDS 与本表同源（语料质检位）；W2-3 统一词表时从这里提。
 */
export const REDLINE_LEXICONS = Object.freeze({
  'policy:politics': Object.freeze([
    '政治', '国家主席', '总统', '选举', '政权', '意识形态', '时评',
    '政治局', '政府', '两岸', '台独',
  ]),
})

/* ───────────────────────── 文本小工具（与 text.js 同口径） ───────────────────────── */

/** 收尾要剥掉的标点（含收尾引号：`「太强了」` 也算空泛捧场收尾）。 */
const TAIL_STRIP_RE = /[\s。！!？?～~….,，、:：;；·）」』"”’）)】]+$/u
const SENTENCE_SPLIT_RE = /[。！？!?；;\n]+/
const QUOTE_PAIRS = Object.freeze([['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ['‘', '’']])

// 表情口径只有一份（text.js `EMOJI_RE`）：本文件只 re-export，别再自建第二份正则。
export { countEmoji }

/** 去掉收尾标点/表情后的尾巴，给 L1 判"最后一句落在哪个词上"。 */
const trimTail = (s) => stripEmoji(s).replace(TAIL_STRIP_RE, '').trim()

/** 第一句（用于 L2）：去表情后按句末标点切。 */
const firstSentence = (s) =>
  stripEmoji(s).trim().split(SENTENCE_SPLIT_RE).map((x) => x.trim()).filter(Boolean)[0] || ''

/** 整句被引号包裹时返回内文字数，否则 -1（用于 L3）。 */
const quotedInnerLen = (s) => {
  const t = String(s ?? '').trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.startsWith(open) && t.endsWith(close) && t.length > open.length + close.length) {
      return charLen(t.slice(open.length, t.length - close.length))
    }
  }
  return -1
}

/** 规则里的理由模板统一用 `{占位符}`，JS/Python 两边都按同一份模板渲染。 */
const renderTemplate = (template, vars) =>
  String(template ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))

const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [])
const finiteOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

export const normalizeForm = (mode) => (LINT_FORMS.includes(mode) ? mode : 'comment')

/** 未知/损坏的 rollout 值一律降级成 warn（宁可只告警，也不能因配置写错把发布全停掉）。 */
export const normalizeRollout = (mode) => {
  const m = String(mode ?? '').trim().toLowerCase()
  return ROLLOUT_MODES.includes(m) ? m : DEFAULT_ROLLOUT
}

/* ───────────────────────── 声明式规则（导出给 Python 的东西） ───────────────────────── */

const redlineChecks = (card) => {
  const out = []
  for (const [i, r] of (Array.isArray(card?.redlines) ? card.redlines : []).entries()) {
    if (!r || typeof r !== 'object') continue
    const id = String(r.id || `红线${i + 1}`)
    const level = r.severity === 'warn' ? 'warn' : 'block'
    const advice = r.instead ? `换成：${r.instead}` : '按卡里的反向动作走，别碰这条。'
    const words = asList(REDLINE_LEXICONS[String(r.lexicon || '')])
    if (words.length) {
      out.push({
        code: `L6:${id}`,
        name: `红线：${id}`,
        level,
        kind: 'containsAny',
        words,
        reasonTemplate: `命中红线「{hit}」（${id}）`,
        advice,
      })
    }
    if (typeof r.regex === 'string' && r.regex.trim()) {
      out.push({
        code: `L6:${id}:regex`,
        name: `红线：${id}（正则）`,
        level,
        kind: 'regexAny',
        pattern: r.regex.trim(),
        reasonTemplate: `命中红线「{hit}」（${id}）`,
        advice,
      })
    }
  }
  return out
}

const avoidChecks = (card) => {
  const avoid = card?.voice?.avoid || {}
  const out = []
  for (const group of ['aiCues', 'bookish', 'bannedWords']) {
    const words = asList(avoid[group])
    if (!words.length) continue
    out.push({
      code: `L7:${group}`,
      name: `禁用词：${group}`,
      level: 'block',
      kind: 'containsAny',
      words,
      reasonTemplate: `命中禁用词「{hit}」（${group}）`,
      advice: '这些是这张卡的禁用表达，换成自己的说法。',
    })
  }
  return out
}

/**
 * 把"当前卡 + 247 基线 + 场域上限"整理成声明式规则。
 * 导出的 JSON 就是它的序列化；`lintComment()` 不传 rules 时也用它现场生成。
 *
 * @param {object} [opts]
 * @param {object} [opts.card] 生效人设卡（决定场域上限、句号/表情上限、红线、禁用词）
 * @param {object} [opts.bank] 语料库（active 条目会写进 rules.bank.active，Python 侧反抄用）
 * @param {string} [opts.mode] rollout 档位（off/warn/block），缺省 warn
 * @param {object} [opts.baseline] 247 基线（体检/建议文案用）
 * @returns {object} 声明式规则对象（可直接 JSON.stringify 落盘）
 */
export const buildLintRules = ({ card = null, bank = null, mode = DEFAULT_ROLLOUT, baseline = HUMAN_BASELINE } = {}) => {
  const c = card && typeof card === 'object' ? card : {}
  const base = baseline && typeof baseline === 'object' ? baseline : HUMAN_BASELINE

  // 场域上限：卡优先、缺省用 W1 的 100/40/60（不在这儿另写一套数）
  const limits = {}
  for (const form of LINT_FORMS) {
    const fromCard = c?.voice?.modes?.[form]?.maxChars
    limits[form] = finiteOr(fromCard, DEFAULT_LIMITS[form])
  }
  const emojiMax = finiteOr(c?.voice?.emoji?.perComment, 1)
  const periodMax = finiteOr(c?.voice?.punctuation?.periodMaxPerComment, 1)

  const checks = [
    {
      code: 'L1',
      name: '落点：收尾不得是空泛捧场',
      level: 'block',
      kind: 'endsWithAny',
      words: [...BLAND_CLOSINGS],
      reasonTemplate: '结尾是空泛捧场「{hit}」，没人能接',
      advice: '把收尾换成一句只有看过的人才说得出的具体细节（画面/操作/台词）。',
    },
    {
      code: 'L2',
      name: '自足：首句不得以指代开手',
      level: 'warn',
      kind: 'startsWithAny',
      words: [...LEAD_PRONOUNS],
      reasonTemplate: '首句以指代「{hit}」开手，前面没有名词可指',
      advice: '首句先给指代对象（视频里的谁 / 什么画面），别用「这个 / 那句 / 他」起手。',
    },
    {
      code: 'L3',
      name: '再创作：整句被引号包裹',
      level: 'warn',
      kind: 'quotedOnly',
      minChars: QUOTED_MIN_CHARS,
      reasonTemplate: '整句被引号包裹（{len} 字）：像把原句端上来，没加工',
      advice: '复述不算评论：换成自己的反应或疑问，别整句加引号。',
    },
    {
      code: 'L4',
      name: '反抄：与 active 语料重合',
      level: 'block',
      kind: 'maxJaccard',
      ngram: COPY_NGRAM,
      threshold: COPY_MAX,
      reasonTemplate: '与语料库 active 条目 {overlap} 重合（上限 {threshold}）：像在抄模板',
      advice: '这句和库里已有条目太像：改说这一条自己的观察。',
    },
    {
      code: 'L5a',
      name: '形态：场域字数',
      level: 'warn',
      kind: 'maxChars',
      reasonTemplate: '超场域字数（{len} > {mode} 上限 {limit}）',
      advice: `真人中位 ${base.medianChars} 字，砍到一句就说完。`,
    },
    {
      code: 'L5b',
      name: '形态：句号过多',
      level: 'warn',
      kind: 'maxCount',
      char: '。',
      max: periodMax,
      reasonTemplate: '句号 {count} 个（上限 {max}），像在写小作文',
      advice: `真人句号率 ${(base.periodRate * 100).toFixed(1)}%，一句话一口气说完，句号留一个。`,
    },
    {
      code: 'L5c',
      name: '形态：表情过多',
      level: 'warn',
      kind: 'maxCountEmoji',
      max: emojiMax,
      reasonTemplate: '表情 {count} 个（上限 {max}），冲淡了话本身',
      advice: '表情留一个就够，多出来的用字说。',
    },
    ...redlineChecks(c),
    ...avoidChecks(c),
  ]

  const active = bank ? activeTexts(bank) : []
  return {
    spec: LINT_SPEC,
    generatedAt: new Date().toISOString(),
    mode: normalizeRollout(mode),
    card: { id: String(c.id ?? ''), version: String(c.version ?? ''), name: String(c.name ?? '') },
    limits,
    baseline: { ...base },
    checks,
    bank: { count: active.length, active },
  }
}

/* ───────────────────────── 单条判据的执行（JS 侧解释器） ───────────────────────── */

/**
 * 跑一条 check；命中返回 {code, level, reason, advice}，否则 null。
 * 未知 kind / 坏正则一律跳过（规则文件升级或写坏时，宁可漏判也不误杀）。
 */
const evalCheck = (check, ctx) => {
  const kind = String(check?.kind ?? '')
  const vars = {}

  switch (kind) {
    case 'endsWithAny': {
      const tail = trimTail(ctx.raw)
      const hit = (check.words || []).find((w) => typeof w === 'string' && w && tail.endsWith(w))
      if (!hit) return null
      vars.hit = hit
      break
    }
    case 'startsWithAny': {
      const head = firstSentence(ctx.raw)
      const hit = (check.words || []).find((w) => typeof w === 'string' && w && head.startsWith(w))
      if (!hit) return null
      vars.hit = hit
      break
    }
    case 'quotedOnly': {
      const minChars = finiteOr(check.minChars, QUOTED_MIN_CHARS)
      const len = quotedInnerLen(ctx.raw)
      if (len < 0 || len < minChars) return null
      vars.len = len
      vars.min = minChars
      break
    }
    case 'maxJaccard': {
      const threshold = finiteOr(check.threshold, COPY_MAX)
      // 有 live 语料库时真接 expression.js 的 looksCopied（>0.6 判抄）
      if (ctx.bank) {
        if (!looksCopied(ctx.raw, ctx.bank)) return null
        const { max, arg } = bankOverlap(ctx.raw, ctx.bank)
        vars.overlap = max.toFixed(2)
        vars.threshold = threshold.toFixed(2)
        vars.text = String(arg || '').slice(0, 12)
        break
      }
      // 只有导出的规则文件时（离线试写）：按同一 2-gram 口径自己比
      const texts = ctx.rules?.bank?.active
      if (!Array.isArray(texts) || !texts.length) return null
      let best = 0
      let arg = ''
      for (const t of texts) {
        const v = jaccard(ctx.raw, t, finiteOr(check.ngram, COPY_NGRAM))
        if (v > best) { best = v; arg = String(t) }
      }
      if (!(best > threshold)) return null
      vars.overlap = best.toFixed(2)
      vars.threshold = threshold.toFixed(2)
      vars.text = arg.slice(0, 12)
      break
    }
    case 'maxChars': {
      const limit = ctx.limits[ctx.form]
      if (!Number.isFinite(limit)) return null
      const len = charLen(ctx.raw)
      if (len <= limit) return null
      vars.len = len
      vars.limit = limit
      vars.mode = ctx.form
      break
    }
    case 'maxCount': {
      const char = String(check.char || '。')
      const count = char ? (ctx.raw.split(char).length - 1) : 0
      const max = finiteOr(check.max, 1)
      if (count <= max) return null
      vars.count = count
      vars.max = max
      vars.char = char
      break
    }
    case 'maxCountEmoji': {
      const count = countEmoji(ctx.raw)
      const max = finiteOr(check.max, 1)
      if (count <= max) return null
      vars.count = count
      vars.max = max
      break
    }
    case 'containsAny': {
      const hit = (check.words || []).find((w) => typeof w === 'string' && w && ctx.raw.includes(w))
      if (!hit) return null
      vars.hit = hit
      break
    }
    case 'regexAny': {
      if (typeof check.pattern !== 'string' || !check.pattern) return null
      let re
      try {
        re = new RegExp(check.pattern, 'u')
      } catch {
        return null // 卡里写坏的正则：跳过，不拦发布
      }
      const m = re.exec(ctx.raw)
      if (!m) return null
      vars.hit = String(m[0]).slice(0, 20)
      break
    }
    default:
      return null
  }

  return {
    code: String(check.code || kind),
    level: check.level === 'block' ? 'block' : 'warn',
    reason: renderTemplate(check.reasonTemplate, vars) || `${String(check.code || kind)} 未通过`,
    advice: String(check.advice || ''),
  }
}

/**
 * 发布前 lint（纯函数）。
 *
 * @param {object} opts
 * @param {string} opts.text 待发布正文
 * @param {'comment'|'reply'|'dynamic'} [opts.mode] 场域（决定字数上限；缺省 comment）
 * @param {object} [opts.card] 生效人设卡（rules 缺省时用来现场生成规则）
 * @param {object} [opts.rules] 规则对象（导出 JSON 的内容）；传了就以它为准
 * @param {object} [opts.bank] live 语料库（传了就真接 looksCopied；否则用 rules.bank.active）
 * @returns {{ok:boolean, level:'block'|'warn', codes:string[], reasons:string[], advice:string}}
 *   通过时 ok=true、codes=[]；level 只在未通过时有意义（block=硬判据，warn=软判据）。
 */
export const lintComment = ({ text, mode = 'comment', card = null, rules = null, bank = null } = {}) => {
  const raw = String(text ?? '')
  const form = normalizeForm(mode)
  const rs = rules && typeof rules === 'object' ? rules : buildLintRules({ card, bank })
  const checks = Array.isArray(rs.checks) && rs.checks.length ? rs.checks : buildLintRules({ card, bank }).checks
  // 上限从规则读，缺省才用 W1 的 100/40/60
  const limits = { ...DEFAULT_LIMITS, ...(rs.limits && typeof rs.limits === 'object' ? rs.limits : {}) }
  for (const f of LINT_FORMS) limits[f] = finiteOr(limits[f], DEFAULT_LIMITS[f])

  const ctx = { raw, form, limits, rules: rs, bank }
  const hits = []
  for (const check of checks) {
    if (!check || typeof check !== 'object') continue
    const hit = evalCheck(check, ctx)
    if (hit) hits.push(hit)
  }

  const block = hits.some((h) => h.level === 'block')
  const reasons = [...new Set(hits.map((h) => h.reason).filter(Boolean))]
  const advice = [...new Set(hits.map((h) => h.advice).filter(Boolean))].join('；')
  return {
    ok: hits.length === 0,
    level: block ? 'block' : 'warn',
    codes: hits.map((h) => h.code),
    reasons,
    advice,
  }
}
