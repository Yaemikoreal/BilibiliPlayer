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
 *
 * 2026-10-28 语料治理（统一方案 §8.3 W2-3）在这份文件里落四件：
 *   - 来源三分 `origin: self | community | blocked`（写入闸门在 growth.js；本文件负责归一与取用）；
 *   - 结构升级 `situation`（"当…时"）+ `style`（"可以…"），注入「当 S 时，可以 X」≤5 条 ≤300 字；
 *     **条目没有 situation/style 时回落旧格式**——seed 库与既有用户库的编译输出逐字节不变；
 *   - 反抄升级：除"草稿 vs 库内"（`looksCopied`）外，补"库条目 vs 原帖热评"（`rewriteCheck`）；
 *   - 写入闸门字段 `count` / `checked` / `aiReviewed` 在这里归一，闸门逻辑在 growth.js。
 */
import { jaccard, charLen, hash32 } from './text.js'

export const BANK_SPEC = 'bili-fenshen.expression-bank/v1'
export const BUCKETS = ['reaction', 'question', 'experience', 'meme', 'detail', 'rant']

/**
 * 来源三分（§8.3-1）。
 *   self：走账本对账，只收自己真发出去的（对账在 growth.js）；
 *   community：只收热评，且入库前跑"与原帖"改写检查（本文件 rewriteCheck）；
 *   blocked：永不入库，只做反例（growth.js 直接拒，处理日志留反例记录）。
 */
export const ORIGINS = ['self', 'community', 'blocked']

/** 结构升级与注入预算（§8.3-2）：情景→句式各 ≤20 字；注入 ≤5 条 ≤300 字。 */
export const EXPRESSION_LIMITS = {
  situationMax: 20,
  styleMax: 20,
  injectMaxItems: 5,
  injectMaxChars: 300,
  copyThreshold: 0.6, // 与"草稿 vs 库内"同一阈值（字符 2-gram Jaccard）
}

/**
 * 旧条目（seed 与 2026-10-28 之前入库的）没有 origin：
 * seed 全部逐字取自真人热评，按最严档 `community` 归档（参与反抄审计），
 * 但**不影响渲染**——渲染只认 situation/style 是否齐全。
 */
const originOf = (e) => (ORIGINS.includes(e?.origin) ? e.origin : 'community')

/** 容错：调用方把「当…时」整句塞进 situation 时剥掉前缀"当"/后缀"时"（渲染模板会补）。 */
export const normalizeSituation = (v) => {
  let s = String(v ?? '').trim()
  if (!s) return ''
  if (s.startsWith('当')) s = s.slice(1).trim()
  if (s.endsWith('时')) s = s.slice(0, -1).trim()
  return s
}

/** 容错：style 只存"可以"之后的部分（渲染模板会补"可以"）。 */
export const normalizeStyle = (v) => {
  let s = String(v ?? '').trim()
  if (!s) return ''
  if (s.startsWith('可以')) s = s.slice(2).trim()
  return s
}

/** 给每条补稳定 id（`form#index`），供冷却表使用；同时归一治理字段（origin/count/checked/situation/style）。 */
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
        origin: originOf(e),
        status: e.status || 'candidate',
        len: typeof e.len === 'number' ? e.len : charLen(e.text),
        heat: Number(e.heat) || 0,
        count: Number(e.count) > 0 ? Number(e.count) : 1, // count 加权：观察次数（重复提交只累加，不重复入库）
        situation: normalizeSituation(e.situation),
        style: normalizeStyle(e.style),
        checked: e.checked === true,       // 人工位：true = 人工确认过
        aiReviewed: e.aiReviewed === true, // AI 复核位：true = 写入前复核通过
        addedAt: e.addedAt || '', // 自演化管道用：转正 FIFO 与满额淘汰的排序键
      }))
    total += buckets[form].length
  }
  return { spec: bank?.spec || BANK_SPEC, updatedAt: bank?.updatedAt || '', buckets, total }
}

/** 可注入的条目：active 且不是 blocked（blocked 永不入库，这里再兜一层防御）。 */
export const activeOf = (bank, form) =>
  (normalizeBank(bank).buckets[form] || []).filter((e) => e.status === 'active' && e.origin !== 'blocked')

/** 库里 active 的全部文本（用于重合拦截）。 */
export const activeTexts = (bank) =>
  BUCKETS.flatMap((f) => (normalizeBank(bank).buckets[f] || []).filter((e) => e.status === 'active').map((e) => e.text))

/**
 * 抽样本：按 (1/(1+heat)) 加权、排除今天用过的。
 * 用 seed 做确定性排序，避免每轮都抽到同样 3 条（"越用越旧"）。
 * count 加权（§8.3-3）：观察次数多的条目权重略高；旧条目 count 缺省 1，
 * 与改动前 `1/(1+heat)` 的排序完全一致（同一常数因子不改变顺序）——seed 抽样结果不变。
 */
export const pickExpression = (bank, { form = 'reaction', seed = 'seed', count = 4, usedToday = {} } = {}) => {
  const list = activeOf(bank, form).filter((e) => !usedToday?.[e.id])
  const fallback = activeOf(bank, form)
  const pool = list.length ? list : fallback
  if (!pool.length) return []
  // 确定性排序键必须沿用旧版 normalizeBank 的条目投影：seededShuffle 对对象做 JSON.stringify，
  // 新增治理字段（origin/count/situation/…）会改 hash → 抽样顺序漂移。
  // 这里只哈希旧字段投影 + 列表下标（与旧 seededShuffle 的 `${seed}#${i}#${JSON.stringify(e)}` 逐字节同源），
  // 保证 seed 库的抽样结果与改动前完全一致。
  const legacyKey = (e) => JSON.stringify({
    id: e.id, text: e.text, form: e.form, source: e.source, status: e.status,
    len: e.len, heat: e.heat, addedAt: e.addedAt,
  })
  const ranked = pool
    .map((e, i) => ({
      e,
      k: hash32(`${seed}#${i}#${legacyKey(e)}`),
      w: (1 + 0.1 * (Number(e.count) || 1)) / (1 + (e.heat || 0)),
    }))
    .sort((a, b) => b.w - a.w || a.k - b.k) // 热度低的优先（反比加权），同权按确定性洗牌顺序
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

/**
 * 反抄升级（§8.3-4）：库条目 vs 原帖热评。
 * community 条目必须是热评的**改写**；与原文 2-gram 重合 >60% 视为逐字抄（水军特征）。
 * 与 `looksCopied` 方向相反：那是"草稿别抄库"，这是"库别抄原帖"。
 * @param {string} text 待入库的 community 文本
 * @param {string[]|string} originals 原帖热评原文（候选随附 originalText，或本轮评论区原文）
 * @returns {{max:number, arg:string, copied:boolean}}
 */
export const rewriteCheck = (text, originals, threshold = EXPRESSION_LIMITS.copyThreshold) => {
  const list = Array.isArray(originals) ? originals : [originals]
  let max = 0
  let arg = ''
  for (const o of list) {
    const t = String(o ?? '').trim()
    if (!t) continue
    const v = jaccard(text, t, 2)
    if (v > max) { max = v; arg = t }
  }
  return { max, arg, copied: max > threshold }
}

/**
 * 存量审计（§8.3-4 的"库条目 vs 原帖热评"回溯版）：把库里条目逐条和原帖原文比一遍，
 * 返回被怀疑"逐字抄"的条目清单（只报告，不删——seed 的 source 字段此前无校验，只能先审计后人工修剪）。
 * @param {object} bank
 * @param {string[]|Record<string, string[]>} originalsByText 原帖原文数组，或 {条目 id 或 text: 原文[]}
 */
export const auditBankAgainstOriginals = (bank, originalsByText = {}) => {
  const b = normalizeBank(bank)
  const flagged = []
  let checked = 0
  for (const f of BUCKETS) {
    for (const e of b.buckets[f]) {
      const list = Array.isArray(originalsByText)
        ? originalsByText
        : (originalsByText[e.id] || originalsByText[e.text] || [])
      const r = rewriteCheck(e.text, list)
      const hasOriginals = (Array.isArray(list) ? list : [list]).some((x) => String(x ?? '').trim())
      if (!hasOriginals) continue
      checked++
      if (r.copied) flagged.push({ id: e.id, form: f, text: e.text, max: r.max, arg: r.arg })
    }
  }
  return { total: b.total, checked, flagged }
}

/** 单条渲染：situation+style 都有 ⇒「当 S 时，可以 X」；缺任一 ⇒ 回落旧格式（seed 字节级不变的关键）。 */
export const renderExpressionEntry = (e) => {
  const situation = normalizeSituation(e?.situation)
  const style = normalizeStyle(e?.style)
  if (situation && style) return `当${situation}时，可以${style}`
  return String(e?.text ?? '')
}

/**
 * 渲染 P4 的语料部分（与卡内样本合并前先各自渲染）。
 * 结构升级：有 situation/style 的条目按「当 S 时，可以 X」渲染；**没有的回落到旧的 `· 原文`**
 * ——现有 seed 库（全部旧条目）的输出与改动前逐字节一致（2026-10-28 W2-3 硬约束）。
 * 注入预算：≤5 条、≤300 字（至少保留 1 条，避免全空退化）；预算按渲染后字符计。
 */
export const renderExpression = (entries) => {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return ''
  const lines = ['别人是这么说的：']
  let used = 0
  for (const e of list) {
    if (lines.length - 1 >= EXPRESSION_LIMITS.injectMaxItems) break
    const body = renderExpressionEntry(e)
    if (!body) continue
    const line = `· ${body}`
    const next = used + charLen(line) + (lines.length > 1 ? 1 : 0)
    // 至少保留 1 条：单条就超预算时也照旧注入（不改变旧行为），只有第 2 条起才受预算约束
    if (lines.length > 1 && next > EXPRESSION_LIMITS.injectMaxChars) break
    lines.push(line)
    used = next
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

/** 库统计（控制台/报告用）。 */
export const bankStats = (bank) => {
  const b = normalizeBank(bank)
  const byBucket = {}
  const byOrigin = { self: 0, community: 0, blocked: 0 }
  for (const f of BUCKETS) {
    byBucket[f] = {
      total: b.buckets[f].length,
      active: b.buckets[f].filter((e) => e.status === 'active').length,
    }
    for (const e of b.buckets[f]) byOrigin[e.origin] = (byOrigin[e.origin] || 0) + 1
  }
  return { total: b.total, byBucket, byOrigin, updatedAt: b.updatedAt }
}
