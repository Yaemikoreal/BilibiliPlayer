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
import { loadCard, readActive, writeActive, readAssetJson, assetDir, homeDir, listPresets, saveCard, seedIfEmpty, listVersions, readVersion, materializeUserCopy, saveBank, writeLoreBody } from './store.js'
import { compilePersona, buildCore } from './compile.js'
import { deriveState, loadState, saveState, debtLine, formOf, timeOfDayOf, hasEmoji } from './state.js'
import { loadLegacy, legacyBlock } from './legacy.js'
import { validateCard, l0Checks, migrateLegacyMarkdown, injectedText, SPEC } from './card.js'
import { normalizeBank, bankStats, BUCKETS } from './expression.js'
import { renderLoreIndex, resolveLoreIndex, lorePath, validateLoreEntry } from './lore.js'
import { charLen } from './text.js'
import { guardPrompt } from './budget.js'

export {
  SPEC, validateCard, l0Checks, migrateLegacyMarkdown, injectedText,
  listPresets, saveCard, listVersions, readVersion, seedIfEmpty, readActive, writeActive, loadCard,
  deriveState, loadState, saveState, compilePersona, buildCore, normalizeBank, bankStats,
  resolveLoreIndex, lorePath, guardPrompt, debtLine, formOf, timeOfDayOf, hasEmoji,
  materializeUserCopy, saveBank, writeLoreBody,
}

/** 表达库：file 模式读用户库，preset 模式读内置种子；都没有则 null。 */
export const loadBank = (active = readActive()) => {
  const own = readAssetJson('expression-bank.json', active)
  if (own) return own
  return readAssetJson('expression-bank.seed.json', active)
}

const banner = (title) => `\n\n===== ${title} =====\n`
const END = '===== 人设结束 =====\n'

/**
 * 解析本轮人设。
 * @param {object} opts
 * @param {object} [opts.cfg] 插件配置（只看 personaPrompt）
 * @param {Array}  [opts.events] 账本事件（派生今日状态）
 * @param {string} [opts.roundId]
 * @param {Date}   [opts.now]
 * @param {number} [opts.modeMax] 该场域字数上限（评论 100 / 楼中楼 40）
 * @returns {{mode:'legacy'|'card'|'missing', before:string, after:string, card:object|null,
 *            source:string, path:string, stats:object|null, notes:string[], state:object|null,
 *            personaTag:string}}
 */
export const resolvePersona = ({ cfg = {}, events = [], roundId = 'round', now = new Date(), modeMax = 100, active = null } = {}) => {
  const legacyRaw = String(cfg?.personaPrompt ?? '').trim()

  // 1) legacy 直通
  if (legacyRaw) {
    const leg = loadLegacy(legacyRaw)
    return {
      mode: 'legacy', before: leg.block, after: '', card: null, source: leg.source,
      path: '', stats: null, notes: leg.note ? [leg.note] : [], state: null,
      personaTag: 'legacy',
    }
  }

  // 2) v2 卡
  const act = active || readActive()
  const { card, source, path, error } = loadCard(act)
  if (!card) {
    const note = `${error || '人设卡读不到'}（本轮按中性说话）`
    return {
      mode: 'missing', before: legacyBlock('', note), after: '', card: null, source: 'missing',
      path, stats: null, notes: [note], state: null, personaTag: 'missing',
    }
  }

  const persisted = loadState()
  const state = deriveState({ events, card, now, persisted })
  const bank = loadBank(act)
  // 见闻索引里的"去读"路径必须是真实绝对路径（preset 模式指向插件包内）
  const loreDir = join(assetDir(act), 'lore')
  const compiled = compilePersona(card, { state, bank, roundId, modeMax, loreDir })
  const tag = `${card.id}@${card.version}`

  const before = banner(`人设（${tag} · 按这个来说话）`)
    + compiled.blocks.core.text + '\n'
    + (compiled.blocks.lore.text ? `\n${banner('你的生活（相关时才用；要用先读正文）')}${compiled.blocks.lore.text}\n` : '')
    + END

  const after = [
    compiled.blocks.state.text ? banner('你这会儿的状态') + compiled.blocks.state.text + '\n' : '',
    compiled.blocks.samples.text ? banner('手感（看落点，别抄内容）') + compiled.blocks.samples.text + '\n' : '',
    compiled.blocks.tail.text ? banner('写之前，最后看三行') + compiled.blocks.tail.text + '\n' : '',
  ].join('')

  return {
    mode: 'card', before, after, card, source, path,
    stats: compiled.stats, notes: compiled.notes, state, personaTag: tag,
    blocks: compiled.blocks, targetForm: compiled.targetForm,
  }
}

/**
 * 控制台预览：给定卡（缺省=生效卡）编译一次，返回文本与预算统计。
 * 不落盘、不注入、不发布。
 */
export const previewPersona = ({ card = null, events = [], roundId = 'preview', now = new Date(), modeMax = 100 } = {}) => {
  const act = readActive()
  const picked = card || loadCard(act).card
  if (!picked) return { ok: false, error: '没有可预览的人设卡', text: '', stats: null }
  const state = deriveState({ events, card: picked, now, persisted: loadState() })
  const bank = loadBank(act)
  const compiled = compilePersona(picked, { state, bank, roundId, modeMax })
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
  }
}

/** 保存卡（校验 + 版本快照 + 切 active 到 file）。 */
export const savePersonaCard = (card) => saveCard(card)

/** 语料库条目的键（normalizeBank 的同一份桶表）。 */
const BANK_FORMS = BUCKETS

/**
 * 语料库编辑入口（控制台「语料库」页签的写路径）。
 * action：add（text 必填）/ edit（id + 可改 text/source/heat）/ remove（id）/ status（id + active|candidate）。
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
    }
    if (list.some((e) => e.id === entry.id)) entry.id = `${entry.id}#${Date.now().toString(36)}`
    bank.buckets[f] = [...list, entry]
  } else if (action === 'edit') {
    const i = list.findIndex((e) => e.id === sid)
    if (i < 0) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    const next = { ...list[i] }
    if (t) { next.text = t; next.len = charLen(t) }
    if (source !== undefined) next.source = String(source)
    if (heat !== undefined) next.heat = Number(heat) || 0
    bank.buckets[f] = list.map((e, j) => (j === i ? next : e))
  } else if (action === 'remove') {
    if (!list.some((e) => e.id === sid)) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    bank.buckets[f] = list.filter((e) => e.id !== sid)
  } else if (action === 'status') {
    const i = list.findIndex((e) => e.id === sid)
    if (i < 0) return { ok: false, error: `找不到条目：${sid || '（空 id）'}` }
    if (!['active', 'candidate'].includes(String(status))) return { ok: false, error: 'status 必须是 active 或 candidate' }
    bank.buckets[f] = list.map((e, j) => (j === i ? { ...e, status: String(status) } : e))
  } else {
    return { ok: false, error: 'action 必须是 add / edit / remove / status' }
  }

  const saved = saveBank(bank)
  if (!saved.ok) return { ok: false, error: saved.error || '语料库保存失败' }
  const norm = normalizeBank(bank)
  return {
    ok: true, action, form: f,
    total: norm.total, buckets: norm.buckets, updatedAt: norm.updatedAt,
    materialized: saved.materialized, active: saved.active,
  }
}

/**
 * 见闻索引编辑入口（控制台「见闻库」页签的写路径；索引住在卡里 → 走整卡保存，自动出版本快照）。
 * action：add（id/keys/oneLine）/ edit（id + 可改 keys/oneLine）/ remove（id）。
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
    if (!list.some((l) => l.id === sid)) return { ok: false, error: `找不到见闻：${sid || '（空 id）'}` }
    card.loreIndex = list.filter((l) => l.id !== sid)
  } else {
    return { ok: false, error: 'action 必须是 add / edit / remove' }
  }

  const saved = savePersonaCard(card)
  if (!saved.ok) {
    return { ok: false, error: (saved.errors || []).map((x) => (x.path ? x.path + '：' : '') + x.msg).join('；') || '卡片保存失败' }
  }
  return { ok: true, action, count: (card.loreIndex || []).length, snapshot: saved.snapshot || '', materialized: mat.materialized }
}

/** 人设健康状况：给诊断/控制台用的一行摘要。 */
export const personaHealth = ({ cfg = {} } = {}) => {
  const legacyRaw = String(cfg?.personaPrompt ?? '').trim()
  if (legacyRaw) return { mode: 'legacy', ok: true, detail: '旧格式人设（legacy 直通）' }
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
