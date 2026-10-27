/**
 * 人设存储：预设卡、用户卡、版本快照、首次播种、资产（见闻/语料库）定位。
 *
 * 目录约定：
 *   - 内置预设：`<插件>/prompts/persona/*.card.json`（随包分发，只读）
 *   - 运行时：  `<家目录>/persona/{active.json, card.json, state.json, lore/, expression-bank.json, versions/}`
 *   - `active.json`：`{mode:'preset'|'file', presetId?, path?}`，缺省 = `{mode:'preset',presetId:'whale'}`
 *
 * 为什么人设不塞进 config.json：config 是扁平标量白名单，而人设是多文件 + 要版本快照的东西。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEC, validateCard } from './card.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** <插件根>/prompts/persona/（lib/persona/ → ../../prompts/persona/） */
export const PRESETS_DIR = join(HERE, '..', '..', 'prompts', 'persona')

export const DEFAULT_PRESET = 'whale'
export const MAX_VERSIONS = 20

/** 家目录：与 index.js 的 HOME 同源（BILI_FENSHEN_HOME 优先）。 */
export const homeDir = () =>
  process.env.BILI_FENSHEN_HOME
  || join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'bili-fenshen')

export const personaDir = () => join(homeDir(), 'persona')
export const activeFile = () => join(personaDir(), 'active.json')
export const cardFile = () => join(personaDir(), 'card.json')
export const stateFile = () => join(personaDir(), 'state.json')
export const versionsDir = () => join(personaDir(), 'versions')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const writeJsonAtomic = (file, value) => {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/* ───────────────────────── 预设 ───────────────────────── */

/** 列出内置预设卡（跳过坏 JSON，不让一张坏卡拖垮整个列表）。 */
export const listPresets = () => {
  try {
    return readdirSync(PRESETS_DIR)
      .filter((f) => f.endsWith('.card.json'))
      .map((f) => {
        const card = readJson(join(PRESETS_DIR, f), null)
        if (!card) return null
        return {
          id: card.id || f.replace(/\.card\.json$/, ''),
          name: card.name || '',
          version: card.version || '',
          oneLiner: card.identity?.oneLiner || '',
          license: card.license || '',
          file: join(PRESETS_DIR, f),
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export const presetPath = (presetId) => join(PRESETS_DIR, `${presetId}.card.json`)

/* ───────────────────────── active.json ───────────────────────── */

export const readActive = () => {
  const raw = readJson(activeFile(), null)
  if (raw && (raw.mode === 'preset' || raw.mode === 'file')) return raw
  return { mode: 'preset', presetId: DEFAULT_PRESET }
}

export const writeActive = (active) => writeJsonAtomic(activeFile(), active)

/**
 * 首次播种：没有 active.json、没有用户卡、且配置里也没有旧 personaPrompt 时，
 * 写入 `{mode:'preset', presetId:'whale'}` —— 开箱即用就是鲸鱼娘。
 * @returns {{seeded:boolean, reason:string, active:object}}
 */
export const seedIfEmpty = ({ legacyPrompt = '' } = {}) => {
  const hasActive = existsSync(activeFile())
  const hasCard = existsSync(cardFile())
  if (hasActive || hasCard) return { seeded: false, reason: 'already-configured', active: readActive() }
  if (String(legacyPrompt || '').trim()) return { seeded: false, reason: 'legacy-inline', active: null }
  const active = { mode: 'preset', presetId: DEFAULT_PRESET }
  writeActive(active)
  return { seeded: true, reason: 'first-run', active }
}

/* ───────────────────────── 卡 ───────────────────────── */

/**
 * 读出生效的卡。
 * @returns {{card:object|null, source:'preset'|'file'|'missing', path:string, error?:string}}
 */
export const loadCard = (active = readActive()) => {
  if (active?.mode === 'file') {
    const p = String(active.path || cardFile())
    const card = readJson(p, null)
    if (!card) return { card: null, source: 'missing', path: p, error: `人设卡读不到或不是合法 JSON：${p}` }
    return { card, source: 'file', path: p }
  }
  const id = String(active?.presetId || DEFAULT_PRESET)
  const p = presetPath(id)
  const card = readJson(p, null)
  if (!card) return { card: null, source: 'missing', path: p, error: `内置预设卡不存在：${id}` }
  return { card, source: 'preset', path: p }
}

/** 保存用户卡：先校验 → 写版本快照 → 写 card.json → 切 active 到 file 模式。 */
export const saveCard = (card) => {
  const v = validateCard(card)
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings }
  try {
    mkdirSync(versionsDir(), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const snapshot = join(versionsDir(), `${card.id}-${card.version}-${stamp}.json`)
    writeJsonAtomic(snapshot, card)
    writeJsonAtomic(cardFile(), card)
    writeActive({ mode: 'file', path: cardFile() })
    pruneVersions()
    return { ok: true, warnings: v.warnings, snapshot }
  } catch (e) {
    return { ok: false, errors: [{ path: '', msg: `保存失败：${e?.message ?? e}` }], warnings: v.warnings }
  }
}

export const pruneVersions = (keep = MAX_VERSIONS) => {
  try {
    const dir = versionsDir()
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep)) {
      try { unlinkSync(join(dir, f)) } catch { /* 单个删不掉不影响其它 */ }
    }
    return true
  } catch {
    return false
  }
}

/** 读某一份版本快照（restore 用；只接受 versionsDir 内的文件名，防路径穿越）。 */
export const readVersion = (name) => {
  try {
    const safe = basename(String(name || ''))
    if (!/^[\w.-]+\.json$/.test(safe)) return null
    return readJson(join(versionsDir(), safe), null)
  } catch {
    return null
  }
}

export const listVersions = () => {
  try {
    const dir = versionsDir()
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: join(dir, f), name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

/* ───────────────────────── 资产定位（按 active 模式） ───────────────────────── */

/**
 * 资产根目录：preset 模式读内置包，file 模式读家目录（用户可改）。
 * 这样"开箱有见闻/语料"，用户改过的也不会被升级覆盖。
 */
export const assetDir = (active = readActive()) =>
  active?.mode === 'file' ? personaDir() : PRESETS_DIR

export const readAssetJson = (name, active = readActive()) =>
  readJson(join(assetDir(active), name), null)

export const readAssetText = (relPath, active = readActive()) => {
  try {
    return readFileSync(join(assetDir(active), relPath), 'utf8')
  } catch {
    return null
  }
}

export const assertSpec = (card) => (card?.spec === SPEC ? null : `不是 ${SPEC} 格式`)

/* ───────────────────────── 用户资产写路径（语料库 / 见闻正文） ───────────────────────── */

const writeTextAtomic = (file, text) => {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, String(text ?? ''), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 把当前生效卡与资产从预设落到家目录（preset → file 模式）。
 * 为什么用户改资产前必须先做这一步：assetDir 按 active.mode 整体切换
 * （preset = 插件包只读，file = 家目录可写）——preset 模式下写进家目录的
 * 语料/见闻根本不会被读到。物化之后的改动都落在用户自己的文件上，升级不覆盖。
 * @returns {{materialized:boolean, card:object|null, error?:string}}
 */
export const materializeUserCopy = () => {
  const act = readActive()
  if (act.mode === 'file') return { materialized: false, card: loadCard(act).card }
  const loaded = loadCard(act)
  if (!loaded.card) return { materialized: false, card: null, error: loaded.error || '预设卡读不到，无法落成用户副本' }
  try {
    writeJsonAtomic(cardFile(), loaded.card)
    const bank = readAssetJson('expression-bank.json', act) || readAssetJson('expression-bank.seed.json', act)
    if (bank) writeJsonAtomic(join(personaDir(), 'expression-bank.json'), bank)
    try {
      const srcLore = join(assetDir(act), 'lore')
      for (const f of readdirSync(srcLore)) {
        if (f.endsWith('.md')) writeTextAtomic(join(personaDir(), 'lore', f), readFileSync(join(srcLore, f), 'utf8'))
      }
    } catch { /* 预设没有 lore 目录就跳过 */ }
    writeActive({ mode: 'file', path: cardFile() })
    return { materialized: true, card: loaded.card }
  } catch (e) {
    return { materialized: false, card: loaded.card, error: `落用户副本失败：${e?.message ?? e}` }
  }
}

/** 保存语料库（写 <家目录>/persona/expression-bank.json；preset 模式先物化用户副本）。 */
export const saveBank = (bank) => {
  const mat = materializeUserCopy()
  if (mat.error) return { ok: false, error: mat.error }
  if (!writeJsonAtomic(join(personaDir(), 'expression-bank.json'), bank)) {
    return { ok: false, error: '语料库写盘失败' }
  }
  return { ok: true, materialized: mat.materialized, active: readActive() }
}

/** 见闻正文写盘（<家目录>/persona/lore/<id>.md；id 白名单防路径穿越；preset 模式先物化）。 */
export const writeLoreBody = (id, body) => {
  const safe = String(id || '').trim()
  if (!/^[\w-]{1,64}$/.test(safe)) return { ok: false, error: 'id 只允许字母、数字、下划线、连字符（≤64）' }
  const mat = materializeUserCopy()
  if (mat.error) return { ok: false, error: mat.error }
  const file = join(personaDir(), 'lore', `${safe}.md`)
  if (!writeTextAtomic(file, String(body ?? ''))) return { ok: false, error: '见闻正文写盘失败' }
  return { ok: true, file, materialized: mat.materialized, active: readActive() }
}
