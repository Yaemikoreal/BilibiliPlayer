/**
 * 预算：人设五块的字符预算 + 整轮 prompt 的 argv 守卫。
 *
 * 背景（实测）：
 *   - 旧人设 5,232 字符 = `PERSONA_MAX_CHARS` 6000 的 87.2%，只剩 768 余量；
 *     任何加规则都会触发静默腰斩。
 *   - 整轮 prompt 走 argv（`spawn(..., args)`），Windows `CreateProcess` 上限 32,767 字符；
 *     鲸鱼娘场景实测 14,214。v2 目标 ≈10,200。
 *
 * 所以这里不提供"无限长"的口子：每块有预算，超了按优先级整行丢；
 * prompt 超软线只告警（降级由 compiler 处理），超硬线直接拒绝（调用方降级为 legacy/中性）。
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

/** 裁剪一个块并按预算记账。 */
export const fitBlock = (name, text) => {
  const max = BUDGET[name] ?? TOTAL_MAX
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
 */
export const degradationPlan = (level) => {
  if (level === 'ok') return []
  if (level === 'warn') return ['lore:shrink', 'samples:half']
  return ['lore:drop', 'samples:drop', 'state:shrink']
}
