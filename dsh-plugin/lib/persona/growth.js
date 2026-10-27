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
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { personaDir, readActive, loadCard, saveCard, saveBank, writeLoreBody, loadBank } from './store.js'
import { normalizeBank, BUCKETS } from './expression.js'
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
}

/** 元话语禁词：候选里出现即拒（与章程"永远不要提"同源）。 */
const META_WORDS = ['小号', '分身', '值班', '运营', '账号主人', '主人', '本鲸', 'prompt', '上下文']
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

const bannedHit = (text, card) => {
  const words = [...META_WORDS, ...((card?.voice?.avoid?.bannedWords) || [])]
  const low = String(text || '').toLowerCase()
  for (const w of words) {
    const s = String(w || '').trim().toLowerCase()
    if (s && low.includes(s)) return s
  }
  for (const w of POLITICS_WORDS) {
    if (low.includes(w)) return w
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

/**
 * 质检一条 corpus 候选。
 * @returns {{ok:boolean, reason?:string, entry?:object}}
 */
export const vetCorpus = (p, { bank, card, ownTexts }) => {
  const text = String(p.text ?? '').trim()
  const form = String(p.form ?? '')
  const origin = String(p.origin ?? 'self')

  if (!BUCKETS.includes(form)) return { ok: false, reason: `form 非法：${form || '空'}` }
  if (!text) return { ok: false, reason: 'text 为空' }
  if (charLen(text) > 100) return { ok: false, reason: `text 超长（${charLen(text)} > 100）` }

  if (origin === 'self') {
    // 防伪核心：self 必须对上账本里自己真的发过的文本（2-gram ≥0.8）
    if (maxOverlap(text, ownTexts) < 0.8) {
      return { ok: false, reason: 'origin=self 但账本里找不到这句（不许编造"我说过"）' }
    }
  } else if (origin === 'community') {
    if (charLen(text) > 30) return { ok: false, reason: `公共梗应 ≤30 字（当前 ${charLen(text)}）` }
    if (!String(p.source ?? '').trim()) return { ok: false, reason: '公共梗必须写 source（出处性质）' }
  } else {
    return { ok: false, reason: `origin 非法：${origin}（只允许 self / community）` }
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
      source: origin === 'self' ? `自沉淀：${String(p.source || '').trim() || '当轮自评'}` : `公共梗：${String(p.source).trim()}`,
      status: 'candidate',
      len: charLen(text),
      heat: Number(p.heat) || 0,
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
 * @param {{cfg?:object, events?:Array, now?:Date, limits?:object}} [opts]
 *   cfg: 插件配置（growthEnable / growthAutoPromote）；events: 账本事件（self 对账数据源）
 * @returns {{ok:boolean, stats:object, error?:string}}
 */
export const processGrowth = ({ cfg = {}, events = [], now = new Date(), limits = {} } = {}) => {
  const lim = { ...GROWTH_LIMITS, ...(limits || {}) }
  const stats = { received: 0, acceptedCorpus: 0, acceptedLore: 0, rejected: 0, expired: 0, promoted: 0, demoted: 0, removed: 0 }
  const processed = []

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
      const out = vetCorpus(p, { bank, card, ownTexts })
      if (!out.ok) {
        stats.rejected++
        processed.push({ t: now.toISOString(), kind, action: 'rejected', reason: out.reason, text: String(p.text || '').slice(0, 30) })
        continue
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
  if (bucketKeys.length) {
    for (const f of bucketKeys) bank.buckets[f] = [...(bank.buckets[f] || []), ...acceptedByBucket[f]]
    const saved = saveBank(bank)
    if (!saved.ok) {
      // 语料入库失败：从统计里撤回
      stats.acceptedCorpus = 0
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

  // 每日限量转正（FIFO：addedAt 最老的满分 candidate 先转）
  const autoN = Number(cfg?.growthAutoPromote ?? lim.promotePerDay)
  if (autoN > 0) {
    let quota = autoN - promotionToday()
    if (quota > 0) {
      const cur = normalizeBank(loadBank(readActive()) || {})
      const cands = []
      for (const f of BUCKETS) {
        for (const e of (cur.buckets[f] || [])) {
          if (e.status === 'candidate' && String(e.source || '').startsWith('自沉淀')) cands.push({ f, e })
        }
      }
      cands.sort((a, b) => String(a.e.addedAt || '').localeCompare(String(b.e.addedAt || '')))
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
