/**
 * 表达库：按形态分桶的真实热评语料。
 *
 * 为什么需要它（而不是只写"该发疑问"）：
 *   "欠一个疑问"只给了形态名，模型会写出一条**书面疑问**；给 3–5 条**真人疑问长什么样**，
 *   它才能学到"这个场子的疑问是这么问的"（Pallas-Bot 的"什么场合常说什么"）。
 *
 * 三条护栏（缺一不可）：
 *   1. 只用 `status:'active'` 的条目；
 *   2. 草稿与库中 active 条目的字符 2-gram 重合 >60% ⇒ 拒绝（防抄热评＝水军特征）；
 *   3. 注入时明确"只学手感，不抄内容"（在 P4 的标题里）。
 */
import { jaccard, charLen, seededShuffle } from './text.js'

export const BANK_SPEC = 'bili-fenshen.expression-bank/v1'
export const BUCKETS = ['reaction', 'question', 'experience', 'meme', 'detail', 'rant']

/** 给每条补稳定 id（`form#index`），供冷却表使用。 */
export const normalizeBank = (bank) => {
  const buckets = {}
  let total = 0
  for (const form of BUCKETS) {
    const list = Array.isArray(bank?.buckets?.[form]) ? bank.buckets[form] : []
    buckets[form] = list
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .map((e, i) => ({
        id: e.id || `${form}#${i}`,
        text: String(e.text).trim(),
        form,
        source: e.source || '',
        status: e.status || 'candidate',
        len: typeof e.len === 'number' ? e.len : charLen(e.text),
        heat: Number(e.heat) || 0,
        addedAt: e.addedAt || '', // 自演化管道用：转正 FIFO 与满额淘汰的排序键
      }))
    total += buckets[form].length
  }
  return { spec: bank?.spec || BANK_SPEC, updatedAt: bank?.updatedAt || '', buckets, total }
}

export const activeOf = (bank, form) =>
  (normalizeBank(bank).buckets[form] || []).filter((e) => e.status === 'active')

/** 库里 active 的全部文本（用于重合拦截）。 */
export const activeTexts = (bank) =>
  BUCKETS.flatMap((f) => (normalizeBank(bank).buckets[f] || []).filter((e) => e.status === 'active').map((e) => e.text))

/**
 * 抽样本：按 (1/(1+heat)) 加权、排除今天用过的。
 * 用 seed 做确定性排序，避免每轮都抽到同样 3 条（"越用越旧"）。
 */
export const pickExpression = (bank, { form = 'reaction', seed = 'seed', count = 4, usedToday = {} } = {}) => {
  const list = activeOf(bank, form).filter((e) => !usedToday?.[e.id])
  const fallback = activeOf(bank, form)
  const pool = list.length ? list : fallback
  if (!pool.length) return []
  const ranked = seededShuffle(pool, seed)
    .map((e) => ({ e, w: 1 / (1 + (e.heat || 0)) }))
    .sort((a, b) => b.w - a.w) // 热度低的优先（反比加权）
    .map((x) => x.e)
  return ranked.slice(0, Math.max(0, count))
}

/** 草稿与库的最大重合（字符 2-gram Jaccard）。 */
export const bankOverlap = (text, bank) => {
  let max = 0
  let arg = ''
  for (const t of activeTexts(bank)) {
    const v = jaccard(text, t, 2)
    if (v > max) { max = v; arg = t }
  }
  return { max, arg }
}

/** 是否抄库（>60% 视为抄）。 */
export const looksCopied = (text, bank) => bankOverlap(text, bank).max > 0.6

/** 渲染 P4 的语料部分（与卡内样本合并前先各自渲染）。 */
export const renderExpression = (entries) => {
  const lines = []
  if (!entries.length) return ''
  lines.push('别人是这么说的：')
  for (const e of entries) lines.push(`· ${e.text}`)
  return lines.join('\n')
}

/** 库统计（控制台/报告用）。 */
export const bankStats = (bank) => {
  const b = normalizeBank(bank)
  const byBucket = {}
  for (const f of BUCKETS) {
    byBucket[f] = {
      total: b.buckets[f].length,
      active: b.buckets[f].filter((e) => e.status === 'active').length,
    }
  }
  return { total: b.total, byBucket, updatedAt: b.updatedAt }
}
