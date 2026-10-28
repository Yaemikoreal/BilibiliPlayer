/**
 * 人设模块门面：一个函数决定"这一轮喂什么人设"，以及"喂在哪"。
 *
 * 解析顺序（**兼容优先**）：
 *   1. `cfg.personaPrompt` 非空 → **legacy 直通**（行为与升级前完全一致，含文件路径/内联正文）；
 *   2. 否则 → v2 卡：`<家目录>/persona/active.json`（默认 `{mode:'preset',presetId:'whale'}`）；
 *   3. 卡读不到 → 中性降级（并在 notes 里说明原因，绝不让路径字符串当人设）。
 *
 * 注入位置（**位置即设计**）：
 *   - `before`：P1 常驻核心 + P2 见闻索引 —— 放在章程之前；
 *   - `after` ：P3 今日状态 + P4 语料样本 + P5 最后一公里 —— 放在整轮 prompt 的最末尾。
 *   这样"事实"在前、"行为"贴生成点，符合酒馆 depth 注入的结论。
 */
import { join } from 'node:path'
import { loadCard, readActive, writeActive, readAssetJson, assetDir, homeDir, PRESETS_DIR, listPresets, saveCard, seedIfEmpty, listVersions, readVersion, materializeUserCopy, saveBank, writeLoreBody, loadBank } from './store.js'
import { compilePersona, buildCore, renderPersonaText } from './compile.js'
import { buildLayers, resolvePosition } from './layers.js'
import { deriveState, loadState, saveState, recordUsage, debtLine, formOf, timeOfDayOf, hasEmoji } from './state.js'
import { loadLegacy, legacyBlock } from './legacy.js'
import { validateCard, l0Checks, migrateLegacyMarkdown, injectedText, SPEC } from './card.js'
import { normalizeBank, bankStats, BUCKETS } from './expression.js'
import { renderLoreIndex, resolveLoreIndex, lorePath, validateLoreEntry } from './lore.js'
import { charLen } from './text.js'
import { guardPrompt, resolveBudget, resolveModes, normalizeModes, effectiveModes, degradationPlan, FALLBACK_MODES } from './budget.js'
import { processGrowth, appendPending, vetCorpus, vetLore, pruneBucket, GROWTH_LIMITS } from './growth.js'
import { buildMemory, filterMemoryRelevant, renderMemory, MEMORY_C2_ENTRIES, MEMORY_C2_CHARS } from '../memory.js'
import { buildCheckup } from './checkup.js'
import { selfCorrectFromCheckup, describeCheckup } from './selfcorrect.js'

export {
  SPEC, validateCard, l0Checks, migrateLegacyMarkdown, injectedText,
  listPresets, saveCard, listVersions, readVersion, seedIfEmpty, readActive, writeActive, loadCard,
  deriveState, loadState, saveState, recordUsage, compilePersona, buildCore, normalizeBank, bankStats,
  resolveLoreIndex, lorePath, guardPrompt, debtLine, formOf, timeOfDayOf, hasEmoji,
  materializeUserCopy, saveBank, writeLoreBody, loadBank,
  processGrowth, appendPending, vetCorpus, vetLore, pruneBucket, GROWTH_LIMITS,
  // W1-0 / W1-2 / W1-3 / W1-5 的纯函数与常量（控制台 / W2 归因直接复用，别再各写一份）
  buildLayers, resolvePosition, renderPersonaText,
  resolveBudget, resolveModes, normalizeModes, effectiveModes, degradationPlan, FALLBACK_MODES,
  // W7-1 记忆（纯函数 + 注入上限常量）
  buildMemory, filterMemoryRelevant, renderMemory, MEMORY_C2_ENTRIES, MEMORY_C2_CHARS,
  // W7-3 体检自纠（W5-2 的控制台表现用 buildCheckup；这里同时导出，避免两边各写一份）
  buildCheckup, selfCorrectFromCheckup, describeCheckup,
}

/** 插件根（`<插件>/prompts/persona` 往上两级）：相对路径与 `preset:` 的解析基准。 */
const PLUGIN_ROOT = join(PRESETS_DIR, '..', '..')

/** `preset:whale` → `whale`；其它形态返回空串（W3-5 可移植表示法）。 */
const PRESET_REF = /^preset\s*:\s*([\w-]+)$/i
export const presetRefOf = (raw) => {
  const m = PRESET_REF.exec(String(raw ?? '').trim())
  return m ? m[1] : ''
}

/** 相对路径的解析根（按顺序尝试）：插件根 → 家目录 → 家目录/persona。 */
const legacyRoots = () => [PLUGIN_ROOT, homeDir(), join(homeDir(), 'persona')]

/**
 * 解析本轮人设。
 * @param {object} opts
 * @param {object} [opts.cfg] 插件配置（只看 personaPrompt）
 * @param {Array}  [opts.events] 账本事件（派生今日状态）
 * @param {string} [opts.roundId]
 * @param {Date}   [opts.now]
 * @param {number} [opts.modeMax] 旧口径单一字数上限（评论 100 / 楼中楼 40）
 * @param {object|'card'|null} [opts.modes] 场域字数：'card' = 读生效卡 voice.modes；
 *        对象 = 直接指定；null = 退回旧口径 modeMax（默认，保持升级前字节）
 * @param {string[]} [opts.degrade] 降级动作（W1-5）
 * @returns {{mode:'legacy'|'card'|'missing', before:string, after:string, card:object|null,
 *            source:string, path:string, stats:object|null, notes:string[], state:object|null,
 *            personaTag:string, c3Hints?:object, degraded?:string[]}}
 */
export const resolvePersona = ({ cfg = {}, events = [], roundId = 'round', now = new Date(), modeMax = 100, modes = null, degrade = [], active = null } = {}) => {
  const rawPrompt = String(cfg?.personaPrompt ?? '').trim()
  // W3-5：`personaPrompt` 现在支持三种可移植写法（解析规则见下），旧行为完全兼容：
  //   ① `preset:whale`        → 直接走该预设的卡链路（换号/换卡不用改路径）
  //   ② 相对路径 `prompts/x.md` → 依次按「插件根 / 家目录 / 家目录/persona」解析
  //   ③ 绝对路径 / 内联正文    → 与升级前逐字节一致（legacy 直通）
  const presetReq = presetRefOf(rawPrompt)
  const warnings = []

  // 1) legacy 直通（内联正文 / 绝对路径 / 相对路径）
  if (rawPrompt && !presetReq) {
    const leg = loadLegacy(rawPrompt, { roots: legacyRoots() })
    if (leg.text) {
      return {
        mode: 'legacy', before: leg.block, after: '', card: null, source: leg.source,
        path: '', stats: null, notes: leg.note ? [leg.note] : [], state: null,
        personaTag: 'legacy',
      }
    }
    // ⭐ 解析失败不再"静默注入一段没人设的警告然后继续跑"：记警告并**回落卡链路**。
    //    旧行为（lib/persona/index.js:239 legacy 无条件 ok:true）会让主人以为人设在生效。
    warnings.push(`personaPrompt 解析失败（${leg.note || '读不到'}）→ 本轮回落卡链路`)
  }

  // 2) v2 卡（`preset:<id>` 时用配置指定的预设，否则读 active.json）
  const act = active || (presetReq ? { mode: 'preset', presetId: presetReq } : readActive())
  const { card, source, path, error } = loadCard(act)
  if (!card) {
    const note = `${error || '人设卡读不到'}（本轮按中性说话）`
    return {
      mode: 'missing', before: legacyBlock('', note), after: '', card: null, source: 'missing',
      path, stats: null, notes: [...warnings, note], state: null, personaTag: 'missing',
    }
  }

  const persisted = loadState()
  const state = deriveState({ events, card, now, persisted })
  const bank = loadBank(act)
  // 见闻索引里的"去读"路径必须是真实绝对路径（preset 模式指向插件包内）
  const loreDir = join(assetDir(act), 'lore')
  // 场域字数：生产链路读卡（W1-2）；显式传对象则直接生效；null 保持旧口径
  const effModes = modes === 'card' ? resolveModes(card) : modes
  // W7-1 记忆：账本聚合成"记得的事"，按相关性 + 7 天半衰期取 ≤2 条 ≤300 字（C2 通道）。
  //   相关性纪律（§8.4「与当前 UP/关键词相关时才注入」）：命中关键词 ⇒ 最多 2 条；
  //   一个都没命中时**只带最近 1 条**——不是放宽门槛，而是保住"讲过的别再讲"这条防重复底线；
  //   没配关键词（无处可过滤）⇒ 正常取 2 条。
  const keywords = Array.isArray(cfg?.keywords) ? cfg.keywords : []
  const mem = buildMemory({ events, now, max: MEMORY_C2_ENTRIES })
  const relevant = filterMemoryRelevant(mem.entries, { keywords })
  const memoryPicked = relevant.length
    ? relevant
    : (keywords.length ? mem.entries.slice(0, 1) : mem.entries)
  const memoryText = renderMemory(memoryPicked, { max: MEMORY_C2_ENTRIES, maxChars: MEMORY_C2_CHARS })
  // W7-3 体检自纠：用**上一轮之前**的发声事件体检（含本轮的会自己夸自己），超阈值就在这轮补一句动作。
  // 数据不足（n<5）时 checkup 自己会返回 ok，这里天然不会注入。
  const checkup = buildCheckup({ events, now, windowDays: 14, limit: 20, card })
  const selfCorrect = selfCorrectFromCheckup(checkup)
  // 编译器细节全在 layers.js（W1-0）：这里只取数 → 调纯函数
  const layer = buildLayers({ card, state, bank, now, modes: effModes, degrade, roundId, loreDir, memoryText, selfCorrect })

  return {
    mode: 'card', before: layer.c1, after: layer.c2, card, source, path,
    stats: layer.stats, notes: [...warnings, ...(layer.notes || [])], state, personaTag: layer.tag,
    blocks: layer.blocks, targetForm: layer.targetForm,
    // ⭐ 这一轮"摆到台面上"的见闻/canon/语料 ⇒ 宿主在轮末 recordUsage 回写冷却表。
    //    没有它，usedToday 永远 false，「同一天不重复」从未生效。
    used: layer.used || { loreIds: [], canonKeys: [], expressionIds: [] },
    // W1-0 / W1-5：给 W6 的每步通道结构 + 本轮实际执行的降级动作（W2-1 写 persona-inject.degraded）
    c3Hints: layer.c3Hints, degraded: layer.degraded, modes: effModes || null,
    // W7-1：本轮记忆（谁进了 prompt / 池子多大），给归因与"为什么这轮没说"的可解释性用
    memory: {
      injected: memoryPicked.map((e) => ({ id: e.id, title: e.title, importance: e.importance, decayed: e.decayed })),
      pool: mem.pool,
      relevant: relevant.length,
      fallbackToRecent: !relevant.length && mem.entries.length > 0 && keywords.length > 0,
    },
    // W7-3：本轮体检结论与自纠（level==='ok' 时 selfCorrect 为空串）
    checkup: {
      level: checkup.verdict?.level || 'ok',
      n: checkup.n,
      reasons: checkup.verdict?.reasons || [],
      selfCorrect,
      summary: describeCheckup(checkup),
    },
  }
}

/**
 * 控制台预览：给定卡（缺省=生效卡）编译一次，返回文本与预算统计。
 * 不落盘、不注入、不发布。
 *
 * W1-2：预览默认走**和生产同一份场域字数**（读卡 voice.modes），消除"预览≠实际"；
 * 想回到旧口径看单一 modeMax 时传 `modes: null`。
 */
export const previewPersona = ({ card = null, events = [], roundId = 'preview', now = new Date(), modeMax = 100, modes = 'card', degrade = [] } = {}) => {
  const act = readActive()
  const picked = card || loadCard(act).card
  if (!picked) return { ok: false, error: '没有可预览的人设卡', text: '', stats: null }
  const state = deriveState({ events, card: picked, now, persisted: loadState() })
  const bank = loadBank(act)
  const effModes = modes === 'card' ? resolveModes(picked) : modes
  const layer = buildLayers({ card: picked, state, bank, now, modes: effModes, degrade, roundId })
  const compiled = { text: renderPersonaText(layer.blocks), stats: layer.stats, notes: layer.notes }
  const l0 = l0Checks(picked, { text: injectedText(picked) })
  const v = validateCard(picked)
  return {
    ok: true,
    text: compiled.text,
    stats: compiled.stats,
    notes: compiled.notes,
    state,
    l0,
    errors: v.errors,
    warnings: v.warnings,
    tag: `${picked.id}@${picked.version}`,
    // W1-2 / W1-3：预览也给出同一份场域字数与生效预算，控制台可直接展示
    modes: effModes || null,
    budget: layer.budget,
    c3Hints: layer.c3Hints,
    degraded: layer.degraded,
  }
}

/** 保存卡（校验 + 版本快照 + 切 active 到 file）。 */
export const savePersonaCard = (card) => saveCard(card)

/** 语料库条目的键（normalizeBank 的同一份桶表）。 */
const BANK_FORMS = BUCKETS

/**
 * 语料库编辑入口（控制台「语料库」页签的写路径）。
 * action：add（text 必填）/ edit（id + 可改 text/source/heat）/ remove（id，**软删除**：置 `disabled:true`）
 *        / restore（id，取消软删除）/ purge（id，物理删除，不可恢复）/ status（id + active|candidate）。
 * 写盘走 store.saveBank：preset 模式会先物化用户副本（卡+资产整体落家目录并切 file）。
 */
export const editExpressionBank = ({ action, form, id, text, source, heat, status } = {}) => {
  const act = readActive()
  const bank = normalizeBank(loadBank(act) || {})
  const f = String(form || '')
  if (!BANK_FORMS.includes(f)) return { ok: false, error: `form 必须是：${BANK_FORMS.join(' / ')}` }
  const list = bank.buckets[f] || []
  const sid = String(id || '').trim()
  const t = String(text ?? '').trim()

  if (action === 'add') {
    if (!t) return { ok: false, error: 'text 不能为空' }
    if (list.length >= 200) return { ok: false, error: `这个桶已满（200 条）：先删再加` }
    const entry = {
      id: sid || `${f}#${Date.now().toString(36)}`,
      text: t, form: f,
      source: String(source || ''),
      status: ['active', 'candidate'].includes(String(status)) ? String(status) : 'active',
      len: charLen(t),
      heat: Number(heat) || 0,
      addedAt: new Date().toISOString(),
    }
    // 同 id 再说一次：如果它只是被软删了，就**恢复并更新**（而不是又造一条重复条目）
    const dup = list.find((e) => e.id === entry.id)
    if (dup && dup.disabled) {
      bank.buckets[f] = list.map((e) => (e.id === entry.id
        ? { ...e, ...entry, disabled: false, disabledAt: '', count: (Number(e.count) || 1) + 1 }
        : e))
    } else {
      if (dup) entry.id = `${entry.id}#${Date.now().toString(36)}`
      bank.buckets[f] = [...list, entry]
    }
  } else if (action === 'edit') {
    const i = list.findIndex((e) => e.id === sid)
    if (i < 0) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    const next = { ...list[i] }
    if (t) { next.text = t; next.len = charLen(t) }
    if (source !== undefined) next.source = String(source)
    if (heat !== undefined) next.heat = Number(heat) || 0
    bank.buckets[f] = list.map((e, j) => (j === i ? next : e))
  } else if (action === 'remove') {
    // W3-3：软删除（`disabled:true`）——控制台看到的"删掉了"，但库里还能恢复。
    // 语料是稀缺资产，误删一条要重新攒；物理删除没有 undo。
    if (!list.some((e) => e.id === sid)) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    bank.buckets[f] = list.map((e) => (e.id === sid ? { ...e, disabled: true, disabledAt: new Date().toISOString() } : e))
  } else if (action === 'restore') {
    if (!list.some((e) => e.id === sid)) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    bank.buckets[f] = list.map((e) => (e.id === sid ? { ...e, disabled: false, disabledAt: '' } : e))
  } else if (action === 'purge') {
    // 真删（不可恢复）：只给"确实不要了"的场景用；控制台默认走 remove 软删。
    if (!list.some((e) => e.id === sid)) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    bank.buckets[f] = list.filter((e) => e.id !== sid)
  } else if (action === 'status') {
    const i = list.findIndex((e) => e.id === sid)
    if (i < 0) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    if (!['active', 'candidate'].includes(String(status))) return { ok: false, error: 'status 必须是 active 或 candidate' }
    bank.buckets[f] = list.map((e, j) => (j === i ? { ...e, status: String(status) } : e))
  } else {
    return { ok: false, error: 'action 必须是 add / edit / remove / restore / purge / status' }
  }

  const saved = saveBank(bank)
  if (!saved.ok) return { ok: false, error: saved.error || '语料库保存失败' }
  const norm = normalizeBank(bank)
  const disabled = BANK_FORMS.reduce((n, k) => n + (norm.buckets[k] || []).filter((e) => e.disabled).length, 0)
  return {
    ok: true, action, form: f,
    total: norm.total, buckets: norm.buckets, updatedAt: norm.updatedAt,
    // W3-3：remove 是**软删除**（可 restore / purge）；同时报禁用条数，控制台能显示"回收站里有几条"
    soft: action === 'remove', disabled,
    materialized: saved.materialized, active: saved.active,
  }
}

/**
 * 见闻索引编辑入口（控制台「见闻库」页签的写路径；索引住在卡里 → 走整卡保存，自动出版本快照）。
 * action：add（id/keys/oneLine）/ edit（id + 可改 keys/oneLine）/ remove（id，**软删除**）/ restore（id）/ purge（id）。
 */
export const editLoreIndex = ({ action, id, keys, oneLine } = {}) => {
  const mat = materializeUserCopy()
  if (mat.error) return { ok: false, error: mat.error }
  const { card, error } = loadCard(readActive())
  if (!card) return { ok: false, error: error || '人设卡读不到' }
  const list = Array.isArray(card.loreIndex) ? card.loreIndex : []
  const sid = String(id || '').trim()
  const toKeys = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean)

  if (action === 'add') {
    if (!/^[\w-]{1,64}$/.test(sid)) return { ok: false, error: 'id 只允许字母、数字、下划线、连字符（≤64）' }
    if (list.some((l) => l.id === sid)) return { ok: false, error: `id 已存在：${sid}` }
    const entry = { id: sid, keys: toKeys(keys), oneLine: String(oneLine || '').trim() }
    const v = validateLoreEntry(entry)
    if (!v.ok) return { ok: false, error: v.errors.join('；') }
    card.loreIndex = [...list, entry]
  } else if (action === 'edit') {
    const i = list.findIndex((l) => l.id === sid)
    if (i < 0) return { ok: false, error: `找不到见闻：${sid || '（空 id）'}` }
    const next = { ...list[i] }
    if (keys !== undefined) next.keys = toKeys(keys)
    if (oneLine !== undefined) next.oneLine = String(oneLine).trim()
    const v = validateLoreEntry(next)
    if (!v.ok) return { ok: false, error: v.errors.join('；') }
    card.loreIndex = list.map((l, j) => (j === i ? next : l))
  } else if (action === 'remove') {
    // W3-3：软删除。控制台"删掉了"，但卡里仍留着这条（能恢复），编译时由 resolveLoreIndex 跳过。
    if (!list.some((l) => l.id === sid)) return { ok: false, error: `找不到见闻：${sid || '（空 id）'}` }
    card.loreIndex = list.map((l) => (l.id === sid ? { ...l, disabled: true, disabledAt: new Date().toISOString() } : l))
  } else if (action === 'restore') {
    if (!list.some((l) => l.id === sid)) return { ok: false, error: `找不到见闻：${sid || '（空 id）'}` }
    card.loreIndex = list.map((l) => (l.id === sid ? { ...l, disabled: false, disabledAt: '' } : l))
  } else if (action === 'purge') {
    if (!list.some((l) => l.id === sid)) return { ok: false, error: `找不到见闻：${sid || '（空 id）'}` }
    card.loreIndex = list.filter((l) => l.id !== sid)
  } else {
    return { ok: false, error: 'action 必须是 add / edit / remove / restore / purge' }
  }

  const saved = savePersonaCard(card)
  if (!saved.ok) {
    return { ok: false, error: (saved.errors || []).map((x) => (x.path ? x.path + '：' : '') + x.msg).join('；') || '卡片保存失败' }
  }
  return { ok: true, action, count: (card.loreIndex || []).length, snapshot: saved.snapshot || '', materialized: mat.materialized }
}

/** 人设健康状况：给诊断/控制台用的一行摘要。 */
export const personaHealth = ({ cfg = {} } = {}) => {
  const raw = String(cfg?.personaPrompt ?? '').trim()
  // W3-5 / B2-9：legacy **不再无条件 ok:true**。
  // 旧实现只要 personaPrompt 非空就返回 ok，于是「路径写错 / 文件被删」在控制台永远是绿的。
  if (raw) {
    const presetReq = presetRefOf(raw)
    if (presetReq) {
      const { card, path, error } = loadCard({ mode: 'preset', presetId: presetReq })
      if (!card) return { mode: 'missing', ok: false, detail: `personaPrompt=preset:${presetReq} 读不到（${error || '预设缺失'}）`, path: path || '' }
      const v = validateCard(card)
      return {
        mode: 'card', ok: v.ok,
        detail: `${card.id}@${card.version}（personaPrompt=preset:${presetReq} → 卡链路，${injectedText(card).length} 字符）`,
        path, source: 'preset', errors: v.errors, warnings: v.warnings,
      }
    }
    const leg = loadLegacy(raw, { roots: legacyRoots() })
    if (leg.text) {
      return {
        mode: 'legacy', ok: true, source: leg.source,
        detail: `旧格式人设（${leg.source === 'file' ? '读自文件' : '内联正文'}，${leg.text.length} 字符）`,
      }
    }
    return {
      mode: 'missing', ok: false, source: leg.source,
      detail: `${leg.note || 'personaPrompt 解析失败'} —— 值班时会回落卡链路`,
    }
  }
  const act = readActive()
  const { card, source, path, error } = loadCard(act)
  if (!card) return { mode: 'missing', ok: false, detail: error || '人设卡读不到', path }
  const v = validateCard(card)
  const l0 = l0Checks(card)
  return {
    mode: 'card',
    ok: v.ok && l0.ok,
    detail: `${card.id}@${card.version}（${source}，${injectedText(card).length} 字符）`,
    path,
    source,
    errors: v.errors,
    warnings: v.warnings,
    l0,
  }
}
