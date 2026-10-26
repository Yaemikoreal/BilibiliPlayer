/**
 * 示例抽样：从卡里的 samples 抽 3–5 条"同形态"样本 + 1 条反例。
 *
 * 两条实证约束：
 *   1. 示例少而位置靠后时模仿效果最强（酒馆 `first_mes` 铁律）→ 每轮只给 1 个形态的样本；
 *   2. 示例之间若有相同"签名梗"，模型会逐字复读 → 抽样时跳过高相似条目。
 */
import { jaccard, pickSeeded } from './text.js'

/** 抽同形态的 good 样本；不足时用其它形态补，但保证彼此不重复。 */
export const pickGoodSamples = (card, { form = '', seed = 'seed', count = 4, avoidTexts = [] } = {}) => {
  const all = Array.isArray(card?.voice?.samples?.good) ? card.voice.samples.good : []
  const same = form ? all.filter((s) => s?.form === form) : []
  const pool = [...same, ...pickSeeded(all.filter((s) => s?.form !== form), `${seed}:rest`, all.length)]
  const picked = []
  for (const s of pool) {
    if (!s?.text) continue
    if (picked.length >= count) break
    const dupWithPicked = picked.some((p) => jaccard(p.text, s.text, 3) > 0.6)
    if (dupWithPicked) continue
    const dupWithRecent = (avoidTexts || []).some((t) => jaccard(t, s.text, 3) > 0.6)
    if (dupWithRecent) continue
    picked.push(s)
  }
  return picked
}

/** 抽 1 条反例（固定 seed 也会轮换，避免每轮同一条）。 */
export const pickBadSample = (card, seed = 'seed') => {
  const bad = Array.isArray(card?.voice?.samples?.bad) ? card.voice.samples.bad : []
  return pickSeeded(bad.filter((s) => s?.text), seed, 1)[0] || null
}

/**
 * 把样本渲染成注入文本（P4）。
 * @param {Array} samples
 * @param {object|null} bad
 */
export const renderSamples = (samples, bad) => {
  const lines = []
  if (samples.length) {
    lines.push('别人是这么说的：')
    for (const s of samples) lines.push(`· ${String(s.text).trim()}`)
  }
  if (bad?.text) {
    lines.push(`反例（别这样）：${String(bad.text).trim()}${bad.reason ? ` —— ${bad.reason}` : ''}`)
  }
  return lines.join('\n')
}
