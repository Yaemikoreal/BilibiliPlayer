/**
 * 配置：patch config 为默认值，<家目录>/config.json 为运行时覆盖层（设计文档 §12.3）。
 * 白名单 + 类型校验；原子写；脏数据静默忽略。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export const FIELDS = {
  autoDuty: 'boolean',
  noon: 'boolean',
  night: 'boolean',
  perDay: 'number',
  commentsPerDay: 'number',
  commentsPerRound: 'number',
  likesPerDay: 'number',
  dynamicsPerDay: 'number',
  repliesPerRound: 'number',
  keywords: 'array',
  followUids: 'array',
  personaPrompt: 'string',
  reportLevel: 'string',
  dshBin: 'string',
  headlessProfile: 'string',
  dutyTools: 'array',
}

const isType = (spec, v) =>
  spec === 'array' ? Array.isArray(v)
  : spec === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : typeof v === spec

export function defaultsOf(patchConfig) {
  const src = patchConfig && typeof patchConfig === 'object' ? patchConfig : {}
  const out = {}
  for (const [k, spec] of Object.entries(FIELDS)) {
    if (isType(spec, src[k])) out[k] = src[k]
  }
  return out
}

export function readOverride(file) {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (FIELDS[k] && isType(FIELDS[k], v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function writeOverride(file, fields) {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(fields, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

export function effectiveConfig(patchConfig, file) {
  const defaults = defaultsOf(patchConfig)
  const override = readOverride(file)
  const values = { ...defaults, ...override }
  const sources = {}
  for (const k of Object.keys(values)) sources[k] = k in override ? 'override' : 'patch'
  return { values, sources, defaults }
}

export function validateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, error: '请求体必须是对象' }
  }
  for (const [k, v] of Object.entries(fields)) {
    const spec = FIELDS[k]
    if (!spec) return { ok: false, error: `未知字段：${k}`, field: k }
    if (!isType(spec, v)) return { ok: false, error: `字段 ${k} 类型应为 ${spec}`, field: k }
  }
  return { ok: true }
}
