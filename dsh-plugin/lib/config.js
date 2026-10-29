/**
 * 配置：patch config 为默认值，<家目录>/config.json 为运行时覆盖层（设计文档 §12.3）。
 * 白名单 + 类型校验；原子写；脏数据静默忽略。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseHHMM } from './schedule.js'

export const FIELDS = {
  autoDuty: 'boolean',
  noon: 'boolean',
  night: 'boolean',
  // 自动值班排班方式：windows=谷时窗口（默认，老配置行为不变）/ interval=固定间隔 / daily=指定时间
  dutyScheduleMode: 'string',
  // interval 模式的间隔分钟（10..1440）
  dutyIntervalMinutes: 'number',
  // daily 模式的槽位时间列表（'HH:MM'，最多 8 个，去重排序）
  dutyDailyTimes: 'array',
  // 允许触发的星期几（ISO：周一=1…周日=7；空数组 = 每天）
  dutyWeekdays: 'array',
  // interval 模式的活跃时段（支持跨午夜：start > end 表示跨夜）
  dutyActiveStart: 'string',
  dutyActiveEnd: 'string',
  perDay: 'number',
  commentsPerDay: 'number',
  commentsPerRound: 'number',
  likesPerDay: 'number',
  dynamicsPerDay: 'number',
  repliesPerRound: 'number',
  // 每轮主动接话（楼中楼回复别人的评论）；0 = 关
  replyOthersPerRound: 'number',
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
  // W2 收尾：人工位（只转正人工确认过的候选；= 麦麦 checked_only）
  growthCheckedOnly: 'boolean',
  // W7-2 发言门控档位（off / observe / enforce；默认 observe = 只记不拦）
  speakGateMode: 'string',
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

/**
 * 值域受限的字符串字段：类型是 string，但只接受这几个值。
 *
 * 为什么单独列：宿主的 zod schema 用不了 `z.enum`（见 index.js 的 speakGateMode 注释），
 * 所以枚举值在这里手工收口 —— 写错立刻 400，而不是静默回落到默认档位（后者最难排查）。
 */
export const ENUM_FIELDS = Object.freeze({
  speakGateMode: ['off', 'observe', 'enforce'],
  dutyScheduleMode: ['windows', 'interval', 'daily'],
})

/* 排班字段的值域校验（类型校验通过后逐个收口；写错立刻 400，不做静默 clamp） */
const HHMM_TEXT = /^([01]\d|2[0-3]):([0-5]\d)$/
const SCHEDULE_RULES = {
  dutyIntervalMinutes(v) {
    if (!Number.isFinite(v) || v < 10 || v > 1440) {
      return '字段 dutyIntervalMinutes 必须在 10..1440 分钟之间'
    }
    return ''
  },
  dutyDailyTimes(v) {
    if (v.length > 8) return '字段 dutyDailyTimes 最多 8 个时间'
    for (const x of v) {
      if (!HHMM_TEXT.test(String(x))) {
        return `字段 dutyDailyTimes 的元素必须是 HH:MM（00:00–23:59）：${String(x)}`
      }
    }
    return ''
  },
  dutyWeekdays(v) {
    for (const x of v) {
      const n = Number(x)
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        return `字段 dutyWeekdays 的元素必须是 1..7（周一=1…周日=7）：${String(x)}`
      }
    }
    return ''
  },
  dutyActiveStart(v) {
    return HHMM_TEXT.test(String(v)) ? '' : `字段 dutyActiveStart 必须是 HH:MM（00:00–23:59）：${String(v)}`
  },
  dutyActiveEnd(v) {
    return HHMM_TEXT.test(String(v)) ? '' : `字段 dutyActiveEnd 必须是 HH:MM（00:00–23:59）：${String(v)}`
  },
}

export function validateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, error: '请求体必须是对象' }
  }
  for (const [k, v] of Object.entries(fields)) {
    const spec = FIELDS[k]
    if (!spec) return { ok: false, error: `未知字段：${k}`, field: k }
    if (!isType(spec, v)) return { ok: false, error: `字段 ${k} 类型应为 ${spec}`, field: k }
    const allowed = ENUM_FIELDS[k]
    if (allowed && !allowed.includes(String(v))) {
      return { ok: false, error: `字段 ${k} 只能是：${allowed.join(' / ')}`, field: k }
    }
    const rule = SCHEDULE_RULES[k]
    const bad = rule ? rule(v) : ''
    if (bad) return { ok: false, error: bad, field: k }
  }
  return { ok: true }
}

/**
 * 排班字段落盘前归一化：dutyDailyTimes 去重 + 升序 + 最多 8 个，dutyWeekdays 去重 + 升序。
 * 只动这两个字段，其他字段原样返回（保持「保存即写入用户原值」的旧语义）。
 */
export function normalizeScheduleFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fields
  const out = { ...fields }
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  if (Array.isArray(out.dutyDailyTimes)) {
    const set = new Set()
    for (const x of out.dutyDailyTimes) {
      const m = parseHHMM(x)
      if (m != null) set.add(m)
    }
    out.dutyDailyTimes = [...set].sort((a, b) => a - b).slice(0, 8).map(fmt)
  }
  if (Array.isArray(out.dutyWeekdays)) {
    const set = new Set()
    for (const x of out.dutyWeekdays) {
      const n = Number(x)
      if (Number.isInteger(n) && n >= 1 && n <= 7) set.add(n)
    }
    out.dutyWeekdays = [...set].sort((a, b) => a - b)
  }
  return out
}
