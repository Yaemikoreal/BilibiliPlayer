/**
 * 人设自演化管道：agent 值班轮里提交沉淀候选（bili_persona_note → growth-pending.jsonl），
 * 宿主在每轮值班启动前消化：质检 → 入库（candidate）→ 每日限量转正 → 容量淘汰。
 *
 * 职责单一（设计文档 §1）：
 *   - Python 工具只做结构预检 + 追加 pending（不做质检）；
 *   - 质检/查重/对账/入库/转正/淘汰全部在本模块（宿主 JS 单一实现，无双语漂移）；
 *   - agent 不直接碰库文件；本模块不碰 B 站接口。
 *
 * 四项已拍板决策（2026-10-27）：
 *   来源=只攒自产+公共梗（他人原句绝不入库）；把关=自动质检+限量转正+人工修剪；
 *   通道=薄 MCP 工具 + pending 管道；节奏=每轮每库 ≤5 / pending 14 天 / 桶 200 / 转正 3 条/天。
 *
 * 2026-10-28 W2-3 语料治理（统一方案 §8.3）在本模块落四件：
 *   来源三分 self / community / blocked；结构升级 situation+style（渲染在 expression.js）；
 *   写入闸门 count 加权 + AI 复核位（review 回调）+ 人工位（checked=false / checkedOnly）；
 *   反抄升级——community 必须附原帖原文并跑"与原帖"改写检查（rewriteCheck），否则拒。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { personaDir, readActive, loadCard, saveCard, saveBank, writeLoreBody, loadBank } from './store.js'
import { normalizeBank, BUCKETS, ORIGINS, EXPRESSION_LIMITS, normalizeSituation, normalizeStyle, rewriteCheck } from './expression.js'
import { validateLoreEntry } from './lore.js'
import { loadState, saveState } from './state.js'
import { jaccard, charLen } from './text.js'
import { readEvents } from '../ledger.js'

/* ───────────────────────── 常量（决策 B 的节奏容量） ───────────────────────── */

export const GROWTH_LIMITS = {
  perRoundPerKind: 5,     // agent 每轮每库最多提交（工具侧硬限的镜像；宿主侧兜底）
  pendingTtlDays: 14,     // pending 保存期
  activeCap: 200,         // 桶 active 上限
  candidateCap: 200,      // 桶 candidate 上限
  loreIndexCap: 12,       // 卡内见闻索引上限
  promotePerDay: 3,       // 每天自动转正条数（FIFO）
  processedKeep: 30,      // 处理日志保留条数（按天裁剪太贵，按条数兜底）
  // 写入闸门（§8.3-3）：
  minPromoteCount: 1,     // count 加权：观察次数（重复提交累加）低于此值不转正
  checkedOnly: false,     // 人工位：true 时只转正 checked===true 的候选（= 麦麦 checked_only）
}

/**
 * 元话语禁词：候选里出现即拒（与章程"永远不要提"同源）。
 * 2026-10-29 核验 §2.2-A：去掉裸「主人」——卡里把「主人是跟我一起用这个账号的捏」定为合法定案台词，
 * 裸子串包含会把自家台词一起拦掉（候选永不入库）；「本鲸」是 v3 遗留（v4 自称已改「本鱼」），一并去掉。
 * 「账号主人」是运营术语，显式保留拦截；「@主人汇报」收进来（卡 bannedWords 里那条失礼用法的具体形态）。
 */
const META_WORDS = ['小号', '分身', '值班', '运营', '账号主人', '@主人汇报', 'prompt', '上下文']
/** 政治词表（no-politics 红线的质检位；保守粗筛，人工兜底）。 */
const POLITICS_WORDS = ['政治', '国家主席', '总统', '选举', '政权', '意识形态', '时评', '政治局', '政府', '两岸', '台独']
/** 真实性红线（no-fabricate 延伸）：见闻正文/语料里不许出现的"可被当真的事实断言"。 */
const FABRICATE_WORDS = ['我认识', '我买了', '我朋友在', '新闻说', '据可靠消息', '我住在', '我的职业', '我公司', '我在哪上班', '我的真实姓名']

const PENDING_FILE = () => join(personaDir(), 'growth-pending.jsonl')
const PROCESSED_FILE = () => join(personaDir(), 'growth-processed.jsonl')

const dayKeyLocal = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/* ───────────────────────── pending 文件 IO ───────────────────────── */

/** 追加一条候选（Python 工具的落点；也供测试直接喂）。 */
export const appendPending = (entry) => {
  try {
    const file = PENDING_FILE()
    mkdirSync(dirname(file), { recursive: true })
    const line = JSON.stringify({ pendingAt: new Date().toISOString(), ...entry }) + '\n'
    writeFileSync(file, line, { encoding: 'utf8', flag: 'a' })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const readPending = () => {
  const file = PENDING_FILE()
  if (!existsSync(file)) return []
  const out = []
  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object' && (obj.kind === 'corpus' || obj.kind === 'lore')) out.push(obj)
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 读不到当作空 */ }
  return out
}

const writePending = (entries) => {
  const file = PENDING_FILE()
  try {
    if (!entries.length) { try { unlinkSync(file) } catch { /* 本来就没有 */ } return true }
    const tmp = `${file}.${process.pid}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

const appendProcessed = (records) => {
  if (!records.length) return
  try {
    const file = PROCESSED_FILE()
    mkdirSync(dirname(file), { recursive: true })
    const prev = (() => {
      try {
        return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-GROWTH_LIMITS.processedKeep + records.length)
      } catch { return [] }
    })()
    const lines = [...prev, ...records.map((r) => JSON.stringify(r))].join('\n') + '\n'
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, lines, 'utf8')
    renameSync(tmp, file)
  } catch { /* 处理日志失败不影响主流程 */ }
}

/* ───────────────────────── 质检链 ───────────────────────── */

/** 定案台词豁免源：card.canon 的 say 文本（2026-10-29 核验 §2.2-A 推荐的 +20 行版）。 */
const canonSay = (card) => (Array.isArray(card?.canon) ? card.canon : [])
  .map((c) => String(c?.say || ''))
  .filter(Boolean)

const bannedHit = (text, card) => {
  const t = String(text || '')
  const low = t.toLowerCase()
  // ① 元话语词（小号 / 值班 / 账号主人 …）：整句就是已定案台词 ⇒ 放行（豁免只认「整句包含/被包含」）
  const exempt = canonSay(card).some((s) => s.includes(t) || t.includes(s))
  for (const w of META_WORDS) {
    const s = String(w || '').trim().toLowerCase()
    if (s && low.includes(s)) return exempt ? '' : s
  }
  // ② 卡禁词 + 政治红线：不豁免——否则「canon 台词 + 政治词」会连红线一起被放行
  for (const w of [...((card?.voice?.avoid?.bannedWords) || []), ...POLITICS_WORDS]) {
    const s = String(w || '').trim().toLowerCase()
    if (s && low.includes(s)) return s
  }
  return ''
}

const fabricateHit = (text) => {
  const low = String(text || '').toLowerCase()
  for (const w of FABRICATE_WORDS) {
    if (low.includes(w)) return w
  }
  return ''
}

/** 与一组既有文本的最大 2-gram 相似度。 */
const maxOverlap = (text, texts) => {
  let max = 0
  for (const t of texts) {
    const v = jaccard(String(text || ''), String(t || ''), 2)
    if (v > max) max = v
  }
  return max
}

/** community 候选的「原帖热评」原文：调用方随候选附 originalText，或由本轮评论区传入。 */
const communityOriginals = (p, originals) => {
  const out = []
  const own = p?.originalText ?? p?.originText ?? p?.original
  if (typeof own === 'string' && own.trim()) out.push(own.trim())
  else if (Array.isArray(own)) out.push(...own.map((x) => String(x ?? '').trim()).filter(Boolean))
  if (Array.isArray(originals)) out.push(...originals.map((x) => String(x ?? '').trim()).filter(Boolean))
  return out
}

/**
 * 质检一条 corpus 候选（§8.3 四件里的三件都在这条闸门上）：
 *   1. 来源三分：self 走账本对账 / community 只收热评且跑"与原帖"改写检查 / blocked 永不入库；
 *   2. 结构升级：situation + style 成对、各 ≤20 字；都不给则走旧格式（向下兼容 seed）；
 *   3. 写入闸门字段：count=1、checked=false（人工位）、aiReviewed 由 processGrowth 的复核回调置位。
 * @param {object} p pending 候选
 * @param {{bank:object, card:object|null, ownTexts:string[], originals?:string[]}} ctx
 * @returns {{ok:boolean, blocked?:boolean, reason?:string, entry?:object}}
 */
export const vetCorpus = (p, { bank, card, ownTexts, originals } = {}) => {
  const text = String(p.text ?? '').trim()
  const form = String(p.form ?? '')
  const origin = String(p.origin ?? 'self')

  if (!BUCKETS.includes(form)) return { ok: false, reason: `form 非法：${form || '空'}` }
  if (!text) return { ok: false, reason: 'text 为空' }
  if (charLen(text) > 100) return { ok: false, reason: `text 超长（${charLen(text)} > 100）` }

  if (!ORIGINS.includes(origin)) {
    return { ok: false, reason: `origin 非法：${origin}（只允许 ${ORIGINS.join(' / ')}）` }
  }
  if (origin === 'blocked') {
    // blocked 永不入库：只能做反例（processGrowth 会在处理日志里留一条反例记录）
    return { ok: false, blocked: true, reason: 'origin=blocked 永不入库，只做反例' }
  }

  if (origin === 'self') {
    // 防伪核心：self 必须对上账本里自己真的发过的文本（2-gram ≥0.8）
    if (maxOverlap(text, ownTexts) < 0.8) {
      return { ok: false, reason: 'origin=self 但账本里找不到这句（不许编造"我说过"）' }
    }
  } else {
    // community：只收热评，入库前跑"与原帖"改写检查（§8.3-1/4）
    if (charLen(text) > 30) return { ok: false, reason: `公共梗应 ≤30 字（当前 ${charLen(text)}）` }
    if (!String(p.source ?? '').trim()) return { ok: false, reason: '公共梗必须写 source（出处性质）' }
    const src = communityOriginals(p, originals)
    if (!src.length) {
      return { ok: false, reason: 'community 必须附原帖热评原文（originalText）：没有原文无法做"与原帖"改写检查' }
    }
    const rw = rewriteCheck(text, src, EXPRESSION_LIMITS.copyThreshold)
    if (rw.copied) {
      return { ok: false, reason: `与原帖热评重合 ${Math.round(rw.max * 100)}%（>${Math.round(EXPRESSION_LIMITS.copyThreshold * 100)}%）：community 条目须改写，不许逐字抄` }
    }
  }

  // 结构升级（§8.3-2）：situation/style 成对、各 ≤20 字；都不给则走旧格式（seed 兼容的关键）
  const situation = normalizeSituation(p.situation)
  const style = normalizeStyle(p.style)
  if (situation || style) {
    if (!situation || !style) return { ok: false, reason: 'situation 与 style 必须成对提供（缺一无法渲染「当 S 时，可以 X」）' }
    if (charLen(situation) > EXPRESSION_LIMITS.situationMax) {
      return { ok: false, reason: `situation 超长（${charLen(situation)} > ${EXPRESSION_LIMITS.situationMax}）` }
    }
    if (charLen(style) > EXPRESSION_LIMITS.styleMax) {
      return { ok: false, reason: `style 超长（${charLen(style)} > ${EXPRESSION_LIMITS.styleMax}）` }
    }
  }

  const banned = bannedHit(text, card)
  if (banned) return { ok: false, reason: `命中禁词/红线词：${banned}` }

  const existing = []
  for (const f of BUCKETS) for (const e of (bank.buckets[f] || [])) existing.push(e.text)
  if (maxOverlap(text, existing) > 0.6) return { ok: false, reason: '与库内已有条目高度重合（>60%）' }

  return {
    ok: true,
    entry: {
      id: `grow#${Date.now().toString(36)}#${Math.floor(Math.random() * 1e4).toString(36)}`,
      text, form,
      origin,
      situation, style, // 空串 = 旧格式条目（渲染走回落）
      source: origin === 'self' ? `自沉淀：${String(p.source || '').trim() || '当轮自评'}` : `公共梗：${String(p.source).trim()}`,
      status: 'candidate',
      len: charLen(text),
      heat: Number(p.heat) || 0,
      count: 1,            // count 加权：观察次数（重复提交只累加，不重复入库）
      checked: false,      // 人工位：AI 复核 ≠ 人工确认，默认 false
      aiReviewed: false,   // AI 复核位：processGrowth 的 review 回调通过后置 true
      addedAt: new Date().toISOString(),
    },
  }
}

/**
 * 质检一条 lore 候选。
 * @returns {{ok:boolean, reason?:string, entry?:object, body?:string}}
 */
export const vetLore = (p, { card, existingOneLines }) => {
  const id = String(p.id ?? '').trim() || `lore-${dayKeyLocal().replace(/-/g, '')}-${Date.now().toString(36)}`
  if (!/^[\w-]{1,64}$/.test(id)) return { ok: false, reason: `id 非法：${id}` }
  const keys = (Array.isArray(p.keys) ? p.keys : String(p.keys ?? '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean)
  const oneLine = String(p.oneLine ?? '').trim()
  const body = String(p.body ?? '').trim()

  const probe = { id, keys, oneLine }
  const v = validateLoreEntry(probe)
  if (!v.ok) return { ok: false, reason: v.errors.join('；') }
  if (body.length > 600) return { ok: false, reason: `正文超长（${body.length} > 600）` }

  const index = Array.isArray(card?.loreIndex) ? card.loreIndex : []
  if (index.some((l) => l.id === id)) return { ok: false, reason: `id 已存在：${id}` }
  if (index.length >= GROWTH_LIMITS.loreIndexCap) return { ok: false, reason: `见闻索引已满（${GROWTH_LIMITS.loreIndexCap} 条）` }

  if (maxOverlap(oneLine, existingOneLines) > 0.6) return { ok: false, reason: '与现有见闻高度重合（>60%）' }

  const banned = bannedHit(`${oneLine}\n${body}`, card)
  if (banned) return { ok: false, reason: `命中禁词/红线词：${banned}` }
  const fab = fabricateHit(`${oneLine}\n${body}`)
  if (fab) return { ok: false, reason: `命中真实性红线词：${fab}（见闻只能是角色生活碎片，不许编可当真的事实）` }

  return { ok: true, entry: { id, keys, oneLine }, body }
}

/* ───────────────────────── 淘汰与转正 ───────────────────────── */

/**
 * 桶容量治理：active 超 cap → 最旧低热降 candidate；candidate 超 cap → 删最旧。
 * 排序键：heat 升序、同 heat 按 addedAt 旧优先。
 */
export const pruneBucket = (entries, { activeCap = GROWTH_LIMITS.activeCap, candidateCap = GROWTH_LIMITS.candidateCap } = {}) => {
  const age = (e) => `${e.addedAt || ''}\u0000${e.id || ''}`
  const byOldLowHeat = (a, b) => (Number(a.heat) || 0) - (Number(b.heat) || 0) || String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
  let demoted = 0
  let removed = 0
  let list = entries.slice()

  const active = list.filter((e) => e.status === 'active')
  if (active.length > activeCap) {
    const demoteSet = new Set(active.slice().sort(byOldLowHeat).slice(0, active.length - activeCap).map((e) => e.id))
    list = list.map((e) => (demoteSet.has(e.id) ? { ...e, status: 'candidate' } : e))
    demoted = demoteSet.size
  }
  const cands = list.filter((e) => e.status === 'candidate')
  if (cands.length > candidateCap) {
    const removeSet = new Set(cands.slice().sort(byOldLowHeat).slice(0, cands.length - candidateCap).map((e) => e.id))
    list = list.filter((e) => !removeSet.has(e.id))
    removed = removeSet.size
  }
  return { list, demoted, removed }
}

/** 每日转正计数（存 persona/state.json，跨天重置）。 */
const promotionToday = () => {
  const st = loadState()
  const today = dayKeyLocal()
  if (st?.growthPromoted?.date === today) return Number(st.growthPromoted.count) || 0
  return 0
}

const bumpPromotion = (n) => {
  const today = dayKeyLocal()
  const st = loadState()
  const prev = st?.growthPromoted?.date === today ? (Number(st.growthPromoted.count) || 0) : 0
  saveState({ ...st, growthPromoted: { date: today, count: prev + n } })
}

/* ───────────────────────── 主流程 ───────────────────────── */

/**
 * 消化 pending：质检 → 入库 → 转正 → 淘汰 → 过期。
 *
 * 写入闸门（§8.3-3）：
 *   - `count` 加权：同一句重复提交不再重复入库，只给库内条目 count+1（观察次数）；
 *     转正按 count 降序、同 count 按 FIFO（最老先转），且 count 低于 minPromoteCount 不转；
 *   - 写入前 AI 复核位：调用方注入 `review(entry, ctx) => {ok:boolean, reason?}`，宿主 LLM 复核"减少学到奇怪内容"；
 *     未注入 = 该位空转（aiReviewed 保持 false，交给人工位）；
 *   - 人工位：新条目一律 `checked:false`；`checkedOnly:true`（= 麦麦 checked_only）时只转正人工确认过的。
 * @param {{cfg?:object, events?:Array, now?:Date, limits?:object, originals?:string[],
 *          review?:(entry:object, ctx:object)=>{ok:boolean, reason?:string}, checkedOnly?:boolean}} [opts]
 *   cfg: 插件配置（growthEnable / growthAutoPromote）；events: 账本事件（self 对账数据源）；
 *   originals: 本轮评论区原文（community 候选"与原帖"改写检查的补充来源）；
 *   review: 写入前 AI 复核回调；checkedOnly: 人工确认闸门（也可用 cfg.growthCheckedOnly / limits.checkedOnly）
 * @returns {{ok:boolean, stats:object, error?:string}}
 */
export const processGrowth = ({ cfg = {}, events = [], now = new Date(), limits = {}, originals = [], review = null, checkedOnly } = {}) => {
  const lim = { ...GROWTH_LIMITS, ...(limits || {}) }
  const stats = { received: 0, acceptedCorpus: 0, acceptedLore: 0, rejected: 0, expired: 0, promoted: 0, demoted: 0, removed: 0, counted: 0, blocked: 0, reviewRejected: 0 }
  const processed = []
  const requireChecked = checkedOnly === undefined
    ? (cfg?.growthCheckedOnly === true || lim.checkedOnly === true)
    : checkedOnly === true

  if (cfg?.growthEnable === false) {
    return { ok: true, stats, skipped: 'growthEnable=false' }
  }

  const pending = readPending()
  stats.received = pending.length

  const act = readActive()
  const { card } = loadCard(act)
  const bank = normalizeBank(loadBank(act) || {})
  const seenTexts = new Set()

  // self 对账数据源：账本里自己发过的 comment/dynamic/reply-out 文本
  const ownTexts = (events || [])
    .filter((e) => ['comment', 'dynamic', 'reply-out'].includes(e?.type) && e?.text)
    .map((e) => String(e.text))

  // count 加权（§8.3-3）：库内已有同一句 ⇒ 不重复入库，只给该条 count+1（观察次数）
  let bumpedAny = false
  const findBankEntry = (text) => {
    for (const f of BUCKETS) for (const e of (bank.buckets[f] || [])) if (e.text === text) return e
    return null
  }

  // 逐条质检；corpus 过审统一进 bank（一次 saveBank）；lore 过审逐条走卡保存
  if (pending.length) {
  const acceptedByBucket = {}
  for (const p of pending) {
    const kind = p.kind
    // 过期
    const at = Date.parse(p.pendingAt || '')
    if (Number.isFinite(at) && now.getTime() - at > lim.pendingTtlDays * 86400_000) {
      stats.expired++
      processed.push({ t: now.toISOString(), kind, action: 'expired', text: String(p.text || p.oneLine || '').slice(0, 30) })
      continue
    }
    const textProbe = String(p.text || p.oneLine || '').trim()
    if (textProbe && seenTexts.has(textProbe)) {
      stats.rejected++
      processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: '与 pending 内条目重复', text: textProbe.slice(0, 30) })
      continue
    }

    if (kind === 'corpus') {
      // 来源三分（§8.3-1）：blocked 永不入库，只做反例（先于重复计数，避免被"库内已有"洗白）
      if (String(p.origin ?? '') === 'blocked') {
        stats.rejected++
        stats.blocked++
        processed.push({ t: now.toISOString(), kind, action: 'blocked', reason: 'origin=blocked 永不入库，只做反例', text: String(p.text || '').slice(0, 30) })
        continue
      }
      const probe = String(p.text || '').trim()
      // count 加权：库内已有同一句 → 只累加观察次数（顺带补结构升级字段），不重复入库
      const dup = probe ? findBankEntry(probe) : null
      if (dup) {
        dup.count = (Number(dup.count) || 1) + 1
        const dSit = normalizeSituation(p.situation)
        const dStyle = normalizeStyle(p.style)
        if (!dup.situation && !dup.style && dSit && dStyle) { dup.situation = dSit; dup.style = dStyle }
        bumpedAny = true
        stats.counted++
        processed.push({ t: now.toISOString(), kind, action: 'counted', text: probe.slice(0, 30), count: dup.count })
        continue
      }
      const out = vetCorpus(p, { bank, card, ownTexts, originals })
      if (!out.ok) {
        stats.rejected++
        if (out.blocked) stats.blocked++
        processed.push({ t: now.toISOString(), kind, action: out.blocked ? 'blocked' : 'rejected', reason: out.reason, text: String(p.text || '').slice(0, 30) })
        continue
      }
      // 写入前 AI 复核位（§8.3-3）：调用方注入 review 才生效；未注入 = 位空转，aiReviewed 保持 false
      if (typeof review === 'function') {
        let verdict
        try { verdict = review(out.entry, { bank, card }) } catch (e) { verdict = { ok: false, reason: `AI 复核异常：${e?.message ?? e}` } }
        if (verdict && verdict.ok === false) {
          stats.rejected++
          stats.reviewRejected++
          processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: `AI复核未过：${verdict.reason || '未通过'}`, text: out.entry.text.slice(0, 30) })
          continue
        }
        out.entry.aiReviewed = verdict === true || verdict?.ok === true
      }
      const bucket = acceptedByBucket[out.entry.form] || []
      if (bucket.length >= lim.perRoundPerKind) {
        stats.rejected++
        processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: `本轮该桶候选已满（${lim.perRoundPerKind}）`, text: out.entry.text.slice(0, 30) })
        continue
      }
      bucket.push(out.entry)
      acceptedByBucket[out.entry.form] = bucket
      seenTexts.add(out.entry.text)
      stats.acceptedCorpus++
      processed.push({ t: now.toISOString(), kind, action: 'accepted', text: out.entry.text.slice(0, 30) })
    } else if (kind === 'lore') {
      const existingOneLines = (Array.isArray(card?.loreIndex) ? card.loreIndex : []).map((l) => l.oneLine || '')
      const out = vetLore(p, { card, existingOneLines })
      if (!out.ok) {
        stats.rejected++
        processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: out.reason, text: String(p.oneLine || '').slice(0, 30) })
        continue
      }
      const saved = saveCard({ ...card, loreIndex: [...(Array.isArray(card.loreIndex) ? card.loreIndex : []), out.entry] })
      if (!saved.ok) {
        stats.rejected++
        processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: '卡片保存失败：' + (saved.errors || []).map((x) => x.msg).join('；'), text: out.entry.id })
        continue
      }
      card.loreIndex = [...(Array.isArray(card.loreIndex) ? card.loreIndex : []), out.entry]
      if (out.body) writeLoreBody(out.entry.id, out.body)
      stats.acceptedLore++
      processed.push({ t: now.toISOString(), kind, action: 'accepted', text: out.entry.oneLine.slice(0, 30) })
    } else {
      stats.rejected++
      processed.push({ t: now.toISOString(), kind: String(kind || 'null'), action: 'rejected', reason: `kind 非法：${kind}` })
    }
  }

  // corpus 统一入库（一次 saveBank；preset 模式会先物化用户副本）
  const bucketKeys = Object.keys(acceptedByBucket)
  if (bucketKeys.length || bumpedAny) {
    for (const f of bucketKeys) bank.buckets[f] = [...(bank.buckets[f] || []), ...acceptedByBucket[f]]
    const saved = saveBank(bank)
    if (!saved.ok) {
      // 语料入库失败：从统计里撤回
      stats.acceptedCorpus = 0
      stats.counted = 0
      processed.push({ t: now.toISOString(), kind: 'corpus', action: 'rejected', reason: `语料库写盘失败：${saved.error}` })
    }
  }
  writePending([]) // 全量消化后清空（结果已进 processed 日志）
  }

  // 淘汰（对生效库跑一遍容量治理）
  const freshBank = normalizeBank(loadBank(readActive()) || {})
  let pruned = false
  for (const f of BUCKETS) {
    const out = pruneBucket(freshBank.buckets[f] || [], lim)
    if (out.demoted || out.removed) {
      freshBank.buckets[f] = out.list
      stats.demoted += out.demoted
      stats.removed += out.removed
      pruned = true
    }
  }
  if (pruned) saveBank(freshBank)

  // 每日限量转正（写入闸门：count 加权 + 人工位 checkedOnly）
  const autoN = Number(cfg?.growthAutoPromote ?? lim.promotePerDay)
  if (autoN > 0) {
    let quota = autoN - promotionToday()
    if (quota > 0) {
      const cur = normalizeBank(loadBank(readActive()) || {})
      const cands = []
      for (const f of BUCKETS) {
        for (const e of (cur.buckets[f] || [])) {
          if (e.status !== 'candidate' || !String(e.source || '').startsWith('自沉淀')) continue
          // count 加权：观察次数（重复提交累加）不足 minPromoteCount 不转正
          if ((Number(e.count) || 1) < Number(lim.minPromoteCount || 1)) continue
          // 人工位：checkedOnly=true 时 checked=false 的候选留在 candidate，等人工确认
          if (requireChecked && e.checked !== true) continue
          cands.push({ f, e })
        }
      }
      // count 加权排序：观察次数多的先转；同 count 按 FIFO（addedAt 最老先转）
      cands.sort((a, b) => (Number(b.e.count) || 1) - (Number(a.e.count) || 1) || String(a.e.addedAt || '').localeCompare(String(b.e.addedAt || '')))
      const promoteSet = new Map()
      for (const c of cands) {
        if (quota <= 0) break
        promoteSet.set(c.f + '\u0000' + c.e.id, c.f)
        quota--
      }
      if (promoteSet.size) {
        for (const f of BUCKETS) {
          cur.buckets[f] = (cur.buckets[f] || []).map((e) =>
            promoteSet.has(f + '\u0000' + e.id) ? { ...e, status: 'active' } : e)
        }
        saveBank(cur)
        stats.promoted = promoteSet.size
        bumpPromotion(promoteSet.size)
        processed.push({ t: now.toISOString(), kind: 'corpus', action: 'promoted', text: `×${promoteSet.size}` })
      }
    }
  }

  appendProcessed(processed)
  return { ok: true, stats }
}
