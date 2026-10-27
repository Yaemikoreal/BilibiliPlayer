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
  // 自动拉取「我关注的 UP 主」列表（bili_followings），免手填 UID
  followAuto: 'boolean',
  followPerRound: 'number',
  // 不看清单：BV号 / UP主 / 标题关键词，命中就整条跳过（内容源设置）
  avoidList: 'array',
  // 原本写死在章程里的默认禁令：true = 生效，false = 本轮不执行（均由用户在控制台设置）
  banPrivacy: 'boolean',
  banImpersonation: 'boolean',
  banControversy: 'boolean',
  banRepeat: 'boolean',
  banReplyRefusal: 'boolean',
  // 动态形式：是否允许「纯文本感想」动态（false = 只发「分享视频 + 短评」）
  dynamicPureText: 'boolean',
  personaPrompt: 'string',
  // 人设自演化管道：值班轮沉淀候选（bili_persona_note）→ 宿主质检入库
  growthEnable: 'boolean',
  growthAutoPromote: 'number',
  reportLevel: 'string',
  dshBin: 'string',
  headlessProfile: 'string',
  dutyTools: 'array',
  // 值班轮（headless 子进程）用的模型：三个都留空 = 跟随当前会话默认模型（契约 §1.1）
  modelProvider: 'string',
  modelName: 'string',
  modelReasoningEffort: 'string',
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

/**
 * 从 profile patch 文本里抽出某个 `- id: <id>` 条目的 config 块（供 headless overlay 原样覆盖）。
 *
 * 为什么不用正则：旧实现是
 *   /- id: llm-pi-ai\r?\n(?:[^\n]*\n)?\s*config:\r?\n((?:[ \t]+.*\r?\n)+?)(?=- id:|\z)/
 * 在真实的 desktop/cordis.patch.yml（providers 下嵌套 `- id:` 列表项、块尾还有空行）上
 * 会灾难性回溯：主线程同步卡死、CPU 100%、宿主 HTTP 端口不再应答（2026-10-25 事故：
 * 值班轮一开跑宿主就假死，会话永远停在「工具调用」那一步）。这里改成线性行扫描。
 *
 * 返回：块内各行（保留原缩进、去掉尾部空行）；条目不存在 / 没有 config 块时返回 null。
 */
export function extractConfigBlock(text, id) {
  const lines = String(text ?? '').split(/\r?\n/)
  const target = `- id: ${id}`
  let at = -1
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() === target) { at = k; break }
  }
  if (at < 0) return null
  let i = at + 1
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === 'config:') break
    if (t.startsWith('- id:')) return null // 下一个条目先到了 ⇒ 本条没有 config 块
  }
  if (i >= lines.length) return null
  const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length
  const body = []
  for (i += 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); continue } // 块内空行先留着，尾部再统一裁掉
    const indent = (line.match(/^\s*/) || [''])[0].length
    if (indent <= baseIndent) break // 退回 config 同级 ⇒ 块结束
    body.push(line)
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  return body.length ? body.join('\n') : null
}

/**
 * 推理强度取舍：模型不支持该强度时，就不把它写进 overlay（不强行下发）。
 *
 * 背景（2026-10-25 事故）：headless dsh 的 pi-ai 适配器在派发前校验显式强度，
 * 模型没有该能力时直接抛 `dsh: UNSUPPORTED_REASONING_EFFORT`，整轮 1.5 秒就退出。
 * 典型：huoshan / glm-5-3-flash-260828 的 `reasoning.efforts` 是空数组（无推理强度），
 * 而配置里可能残留上一模型的 `high`。规则只有一条：支持就原样传，不支持就不设置。
 *
 * @param {string} effort 配置/选择里的强度
 * @param {string[]|null} supported 该模型支持的强度 id 列表；null = 查询失败（未知，保持原样不猜）
 * @returns {{effort: string, ignored: string}} ignored 非空表示该项不会被设置（调用方记日志）
 */
export function pickReasoningEffort(effort, supported) {
  const want = String(effort ?? '').trim()
  if (!want) return { effort: '', ignored: '' }
  if (!Array.isArray(supported)) return { effort: want, ignored: '' } // 未知：不猜，保持原样
  const list = supported.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (list.includes(want)) return { effort: want, ignored: '' }
  return { effort: '', ignored: want }
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
