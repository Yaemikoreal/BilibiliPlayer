/**
 * 人设模块的文本小工具：长度口径、n-gram 重合、句子切分、按预算裁剪、确定性抽样。
 *
 * 为什么单独一层：
 *   - 「字数」在人设/评论/预算三处口径必须一致。B 站评论里的 `[doge]` 是表情 token，
 *     不能算成 4 个字；Unicode emoji（🤓👆）也不该算。`charLen` 是唯一口径。
 *   - 「重复」用 3-gram Jaccard 判，而不是字符串包含——人设示例里的"签名梗"靠这个抓。
 *   - 「裁剪」必须整行丢，不能腰斩：截断点落在句子中间比没有更糟（旧 PERSONA_MAX_CHARS 的坑）。
 *   - 「抽样」必须确定性：同一 (roundId, date) 必得同一结果，事故才可复现。
 */

/** 去掉 B 站表情 token（[doge]）与 Unicode emoji，保留文字与标点。 */
export const stripEmoji = (s) =>
  String(s ?? '')
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')

/** 字数口径：去表情、去空白后的字符数（与 `corpus` 文档「去 [表情] 与空白」一致）。 */
export const charLen = (s) => [...stripEmoji(s).replace(/\s+/g, '')].length

/** 字符 n-gram 集合（默认 3-gram）。 */
export const ngrams = (s, n = 3) => {
  const t = [...stripEmoji(s).replace(/\s+/g, '')]
  const out = new Set()
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(''))
  return out
}

/** Jaccard 相似度；两边都太短（<n）时退化为"是否相同"。 */
export const jaccard = (a, b, n = 3) => {
  const A = ngrams(a, n)
  const B = ngrams(b, n)
  if (!A.size || !B.size) return String(a).trim() === String(b).trim() ? 1 : 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / (A.size + B.size - hit)
}

/** 与一组文本的最大相似度（用于"与最近 3 条重复吗"「示例之间重复吗」）。 */
export const maxJaccard = (text, list, n = 3) => {
  let max = 0
  let arg = ''
  for (const item of list || []) {
    const v = jaccard(text, item, n)
    if (v > max) { max = v; arg = String(item) }
  }
  return { max, arg }
}

/** 粗切句：句末标点 + 换行 + 分号（分号不当句子边界的话，禁止句占比会算低）。 */
export const sentences = (s) =>
  String(s ?? '')
    .split(/[。！？!?；;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * 按字符预算裁剪：**整行丢**，不腰斩。
 * @returns {{text:string, dropped:number, hardCut:boolean}}
 */
export const fitText = (text, max, { hardCut = true } = {}) => {
  const raw = String(text ?? '').trim()
  if (raw.length <= max) return { text: raw, dropped: 0, hardCut: false }
  const lines = raw.split('\n')
  const kept = []
  let len = 0
  for (const line of lines) {
    const add = kept.length ? line.length + 1 : line.length
    if (len + add > max) break
    kept.push(line)
    len += add
  }
  if (kept.length) {
    // 末尾可能是"小标题"（以 = 或 · 开头但没有正文），丢掉更干净
    while (kept.length && /^[·\-*=\[（(【]?\s*$/.test(kept[kept.length - 1])) kept.pop()
    return { text: kept.join('\n'), dropped: lines.length - kept.length, hardCut: false }
  }
  // 单行就超预算：只能硬切（并让调用方记 note）
  return hardCut
    ? { text: [...raw].slice(0, max).join(''), dropped: lines.length - 1, hardCut: true }
    : { text: '', dropped: lines.length, hardCut: false }
}

/** 32 位字符串 hash（FNV-1a），用于确定性抽样与状态播种。 */
export const hash32 = (s) => {
  let h = 0x811c9dc5
  const str = String(s ?? '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 确定性「洗牌」：按 hash(seed + 元素) 排序，不用 Math.random。 */
export const seededShuffle = (list, seed) =>
  [...(list || [])]
    .map((v, i) => ({ v, k: hash32(`${seed}#${i}#${typeof v === 'string' ? v : JSON.stringify(v)}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.v)

/** 从 list 里取 k 个（确定性）。 */
export const pickSeeded = (list, seed, k = 1) => seededShuffle(list, seed).slice(0, Math.max(0, k))

/** 正则转义（把词表拼成正则时用）。 */
export const escapeRe = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
