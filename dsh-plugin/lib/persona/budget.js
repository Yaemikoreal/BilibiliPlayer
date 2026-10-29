/**
 * 预算：人设五块的字符预算 + 整轮 prompt 的 argv 守卫 + 场域字数 + 渲染位置。
 *
 * 背景（实测）：
 *   - 旧人设 5,232 字符 = `PERSONA_MAX_CHARS` 6000 的 87.2%，只剩 768 余量；
 *     任何加规则都会触发静默腰斩。
 *   - 整轮 prompt 走 argv（`spawn(..., args)`），Windows `CreateProcess` 上限 32,767 字符；
 *     鲸鱼娘场景实测 14,214。v2 目标 ≈10,200。
 *
 * 所以这里不提供"无限长"的口子：每块有预算，超了按优先级整行丢；
 * prompt 超软线只告警（降级由 compiler 处理），超硬线直接拒绝（调用方降级为 legacy/中性）。
 *
 * 卡是编辑面（W1-3）：`card.render.budget` / `card.render.position` 读卡优先，
 * 这里的常量只作**缺省**。三张内置卡数值与缺省相同 ⇒ 读卡不改变现有行为，只把开关接上。
 */
import { fitText } from './text.js'

/** 五块预算（字符）。合计 3,000，见设计 §6.1。 */
export const BUDGET = Object.freeze({ core: 1500, lore: 300, state: 500, samples: 450, tail: 250 })

/** 人设编译结果总上限（字符）。 */
export const TOTAL_MAX = 3000

/** 整轮 prompt 软线：超过它就开始降级（砍见闻索引 / 示例减半）。 */
export const PROMPT_SOFT_MAX = 20000

/** 整轮 prompt 硬线：超过它不允许 spawn（argv 会炸），调用方必须降级。 */
export const PROMPT_HARD_MAX = 24000

/* ───────────────────────── 场域字数（W1-2） ───────────────────────── */

/**
 * 场域字数的缺省表：评论 100 / 楼中楼 40 / 动态 60。
 *
 * 以前 `index.js` 只硬编一个 `modeMax: 100`，楼中楼 40 与动态 60 从未生效
 * （卡里 `voice.modes` 一直写着，但没人读）。这里成为唯一缺省，卡可覆盖。
 */
export const FALLBACK_MODES = Object.freeze({ comment: 100, reply: 40, dynamic: 60 })

/** 场域的人话名（P3 场域表用）。 */
export const MODE_LABELS = Object.freeze({ comment: '评论', reply: '楼中楼', dynamic: '动态' })

/**
 * 把卡 `voice.modes`（对象或纯数字）归一成 `{comment, reply, dynamic}` 数字。
 * 认 `{maxChars}` / `{chars}` / 数字三种写法，缺项回落缺省。
 */
export const normalizeModes = (input = {}) => {
  const out = {}
  for (const k of Object.keys(FALLBACK_MODES)) {
    const v = input?.[k]
    const n = typeof v === 'number' ? v : Number(v?.maxChars ?? v?.chars)
    out[k] = Number.isFinite(n) && n > 0 ? Math.round(n) : FALLBACK_MODES[k]
  }
  return out
}

/** 生效卡 → 场域字数（读卡优先，缺省回落 FALLBACK_MODES）。 */
export const resolveModes = (card = {}) => normalizeModes(card?.voice?.modes)

/**
 * 场域上限与时段上限**取更严的**（W1-2）：凌晨/深夜 40 字时，
 * 评论 100→40、楼中楼 40→40、动态 60→40 —— 绝不能让时段把楼中楼放宽。
 * @param {{comment:number, reply:number, dynamic:number}} modes
 * @param {number|null} todMaxChars 时段上限（timeOfDayOf().maxChars）
 */
export const effectiveModes = (modes, todMaxChars = null) => {
  const base = normalizeModes(modes)
  const out = {}
  for (const k of Object.keys(FALLBACK_MODES)) {
    out[k] = todMaxChars ? Math.min(base[k], Number(todMaxChars) || base[k]) : base[k]
  }
  return out
}

/* ───────────────────────── 渲染位置（W1-3） ───────────────────────── */

/** 允许的注入位置：章程之前 / 整轮参数之后（正是现在硬编的两处）。 */
export const RENDER_POSITIONS = Object.freeze(['before-charter', 'after-params'])

/** 各块默认位置：core/lore 在前段，state/samples/tail 在末尾。 */
export const POSITION_DEFAULTS = Object.freeze({
  core: 'before-charter',
  lore: 'before-charter',
  state: 'after-params',
  samples: 'after-params',
  tail: 'after-params',
})

/** 生效五块预算：读卡优先（`card.render.budget`），缺项回落 BUDGET。 */
export const resolveBudget = (card = {}) => {
  const raw = card?.render?.budget
  const out = { ...BUDGET }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(BUDGET)) {
      const n = Number(raw[k])
      if (Number.isFinite(n) && n > 0) out[k] = Math.round(n)
    }
  }
  return Object.freeze(out)
}

/** 裁剪一个块并按预算记账。@param {object} [budget] 生效预算（默认缺省表） */
export const fitBlock = (name, text, budget = BUDGET) => {
  const max = budget[name] ?? TOTAL_MAX
  const { text: out, dropped, hardCut } = fitText(text, max)
  return {
    name,
    text: out,
    len: out.length,
    max,
    dropped,
    hardCut,
    over: dropped > 0 || hardCut,
  }
}

/** 汇总五个块：总长、超预算的块、是否超总上限。 */
export const summarize = (blocks) => {
  const list = Object.values(blocks || {})
  const total = list.reduce((n, b) => n + (b?.len || 0), 0)
  return {
    total,
    totalMax: TOTAL_MAX,
    overTotal: total > TOTAL_MAX,
    over: list.filter((b) => b?.over).map((b) => b.name),
    per: list.map((b) => ({ name: b?.name, len: b?.len || 0, max: b?.max || 0 })),
  }
}

/** 整轮 prompt 的守卫：ok / warn（可降级） / over（必须降级）。 */
export const guardPrompt = (prompt) => {
  const len = String(prompt ?? '').length
  const level = len > PROMPT_HARD_MAX ? 'over' : len > PROMPT_SOFT_MAX ? 'warn' : 'ok'
  return { len, level, softMax: PROMPT_SOFT_MAX, hardMax: PROMPT_HARD_MAX }
}

/**
 * 降级序列（prompt 超软线时按顺序做）。
 * 返回要跳过/压缩的块名，由 compiler 执行；这里只给策略，便于单测。
 *
 * 原则（设计 §2.4）：**按优先级砍，不整段丢** —— 先砍见闻索引与示例，
 * 再砍状态，**L0 尾注永远保留**（它是性价比最高的一段）。
 */
export const degradationPlan = (level) => {
  if (level !== 'warn' && level !== 'over') return []
  if (level === 'warn') return ['lore:shrink', 'samples:half']
  return ['lore:drop', 'samples:drop', 'state:shrink']
}
