/**
 * 实时运行视图（契约 §1.4）：轮次状态机 + 事件环形缓冲 + 子进程输出行分类。
 *
 * 纯逻辑：不 import 宿主、不碰 IO / 环境变量 / 网络，方便单测（§3）。
 *
 * 要点：
 * - seq 由内部计数器单调递增；start()/reset() 只清事件、不复位计数器 ⇒ 客户端「seq > after」过滤永远成立
 *   （客户端只做「更大」判断，一旦 seq 回退，after 过滤就会漏事件）。
 * - snapshot().cursor 取「缓冲里最新 seq」而不是「本次回传的最新 seq」：客户端 after 超前时回 0 会让它
 *   误以为要重拉，这里以缓冲实况为准（空缓冲才是 0）。
 * - 所有公共方法都 try/catch 兜死：子进程输出再脏（undefined / 非字符串 / 超长无换行）也不能把宿主带崩。
 * - 事件文本统一按 maxTextLen 截断，避免一条巨长的行撑爆 SSE 帧。
 */
const DEFAULT_MAX_EVENTS = 400
const DEFAULT_MAX_TEXT_LEN = 400
/** snapshot 单次最多回传的事件条数（契约 §1.2：最多 200 条，老的先丢） */
const SNAPSHOT_LIMIT = 200
/** 子进程行缓冲安全上限：长时间没有换行的输出强制当一行 flush，避免无限吃内存 */
const LINE_BUFFER_CAP = 64 * 1024

const HOST_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/
const REASONING_LINE = /^(?:dsh:\s*)?reasoning:/
const TOOL_NAME = /bili_[a-z_]+/
const ERROR_WORD = /失败|错误|异常|error|Error/

const EVENT_KINDS = new Set(['host', 'tool', 'reasoning', 'error', 'text', 'state'])

/** stats.actions 的严格映射（契约 §1.4）：动作名 ← 工具名 */
const ACTION_OF_TOOL = {
  bili_like: 'like',
  bili_reply: 'comment',
  bili_send_dynamic: 'dynamic',
  bili_received_replies: 'reply',
}

const PHASES = {
  find: { key: 'find', label: '找内容' },
  watch: { key: 'watch', label: '看内容' },
  act: { key: 'act', label: '发言' },
  think: { key: 'think', label: '思考' },
}
const TOOL_PHASE = new Map()
for (const t of ['bili_search', 'bili_hot_videos', 'bili_weekly_hot', 'bili_rank', 'bili_user_videos', 'bili_video_info']) {
  TOOL_PHASE.set(t, 'find')
}
for (const t of ['bili_subtitle', 'bili_comments']) TOOL_PHASE.set(t, 'watch')
for (const t of ['bili_like', 'bili_reply', 'bili_send_dynamic', 'bili_received_replies']) TOOL_PHASE.set(t, 'act')

const emptyActions = () => ({ like: 0, comment: 0, dynamic: 0, reply: 0 })

/** 正数取整；非法值退回默认（构造参数再脏也不能造出 0 容量缓冲） */
function toPositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

/** 从任意值里抠出第一个 bili_* 工具名；抠不到返回 ''（兼容 mcp__bili-fenshen__bili_like 前缀写法） */
function toolOf(value) {
  const s = value == null ? '' : String(value)
  const m = TOOL_NAME.exec(s)
  return m ? m[0] : ''
}

/**
 * 单行分类（契约 §1.4）：host → reasoning → tool → error → blank → text。
 * 纯函数，任何输入都不抛异常。
 */
export function classifyLine(line) {
  const s = line == null ? '' : String(line).replace(/\r$/, '')
  if (!s.trim()) return { kind: 'blank', text: '' }
  if (HOST_LINE.test(s)) return { kind: 'host', text: s }
  if (REASONING_LINE.test(s)) return { kind: 'reasoning', text: s }
  const tool = toolOf(s)
  if (tool) return { kind: 'tool', text: s, tool }
  if (ERROR_WORD.test(s)) return { kind: 'error', text: s }
  return { kind: 'text', text: s }
}

/** 工具名 → 阶段（契约 §1.4）。未知/缺失一律「思考」。 */
export function phaseOfTool(tool) {
  const key = TOOL_PHASE.get(toolOf(tool)) || 'think'
  return { ...PHASES[key] }
}

export function createLiveStream(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const maxEvents = toPositiveInt(options.maxEvents, DEFAULT_MAX_EVENTS)
  const maxTextLen = toPositiveInt(options.maxTextLen, DEFAULT_MAX_TEXT_LEN)

  /* ── 轮次状态 ── */
  let running = false
  let roundId = null
  let startedAt = null
  let startedAtMs = 0
  let why = null
  let lastCode = null // 上一轮的退出码（轮次中保留，供 UI 显示最近一次结果）
  let lastDurationMs = null // 上一轮耗时
  let events = [] // 环形缓冲（裁剪后始终 ≤ maxEvents）
  let seqCounter = 0 // 内部递增计数：start/reset 都不复位
  let tools = {} // 本轮工具调用计数（不随 ring 裁剪回退）
  let lastTool = null // 本轮最近一个工具名（独立于 ring 裁剪，避免阶段被冲掉）
  let actions = emptyActions()
  let errors = 0
  const listeners = new Set()

  /* ── 子进程输出行缓冲 ──
   * stdout/stderr 在 index.js 都走 pushChildChunk（同一根管道语义），半行统一缓冲。
   * Buffer 用流式 TextDecoder 解码，避免一个汉字被 chunk 边界劈开时出现乱码；
   * 字符串输入则先吐出解码器残字节再拼接，保证顺序不错乱。
   */
  let lineBuf = ''
  let decoder = new globalThis.TextDecoder('utf-8')
  let decoderPending = false

  const nowIso = () => new Date().toISOString()

  const clip = (value) => {
    const s = value == null ? '' : String(value)
    return s.length > maxTextLen ? s.slice(0, maxTextLen) : s
  }

  /** 通知订阅方（Lead 定义的形状）：事件 { kind:'event', frame } / 状态变化 { kind:'state' }；异常一律吞掉 */
  const notify = (message) => {
    for (const fn of [...listeners]) {
      try { fn(message) } catch { /* 监听器抛异常绝不能影响推流 */ }
    }
  }
  const notifyState = () => notify({ kind: 'state' })

  const statsOf = () => ({
    events: events.length,
    tools: { ...tools },
    actions: { ...actions },
    errors,
  })

  /** 阶段取「本轮最近一个 tool 事件」推导；没有则「思考」 */
  const currentPhase = () => phaseOfTool(lastTool || '')

  /** 造一个事件入缓冲（含 seq/t/截断/统计/通知）。kind 非法按 text；blank 不入。 */
  const addEvent = (kind, text, tool) => {
    try {
      if (kind === 'blank') return null
      const k = EVENT_KINDS.has(kind) ? kind : 'text'
      const ev = { seq: 0, t: nowIso(), kind: k }
      if (k === 'tool') {
        const name = tool ? String(tool) : toolOf(text)
        if (name) ev.tool = name
      }
      ev.text = clip(text)
      if (!ev.text && !ev.tool) return null
      ev.seq = ++seqCounter
      events.push(ev)
      if (events.length > maxEvents) events = events.slice(events.length - maxEvents)
      if (k === 'tool' && ev.tool) {
        tools[ev.tool] = (tools[ev.tool] || 0) + 1
        lastTool = ev.tool
        const action = ACTION_OF_TOOL[ev.tool]
        if (action) actions[action] += 1
      }
      if (k === 'error') errors += 1
      notify({ kind: 'event', frame: ev })
      return ev
    } catch {
      return null
    }
  }

  /** 吐出解码器里残留的半个多字节字符（轮次开始/结束时清账） */
  const flushDecoder = () => {
    if (!decoderPending) return ''
    decoderPending = false
    try { return decoder.decode() } catch { return '' }
  }

  /** 子进程原始块 → 字符串（Buffer 走流式解码，其余 String()） */
  const takeChunkText = (chunk) => {
    try {
      if (chunk == null) return ''
      if (typeof chunk === 'string') {
        const pending = flushDecoder()
        return pending + chunk
      }
      if (chunk instanceof ArrayBuffer) {
        decoderPending = true
        return decoder.decode(chunk, { stream: true })
      }
      if (ArrayBuffer.isView(chunk)) {
        decoderPending = true
        return decoder.decode(chunk, { stream: true })
      }
      const pending = flushDecoder()
      return pending + String(chunk)
    } catch {
      try { return String(chunk) } catch { return '' }
    }
  }

  /** 一行 → 事件；blank 不产生事件 */
  const emitLine = (line) => {
    const cls = classifyLine(line)
    if (cls.kind === 'blank') return null
    return addEvent(cls.kind, cls.text, cls.tool)
  }

  /** 把残留半行 flush 成事件（end/start 用），返回是否产出了事件 */
  const flushLineBuffer = () => {
    try {
      lineBuf += flushDecoder()
      if (!lineBuf) return 0
      const line = lineBuf
      lineBuf = ''
      return emitLine(line) ? 1 : 0
    } catch {
      lineBuf = ''
      return 0
    }
  }

  const toStartedAt = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { iso: new Date(value).toISOString(), ms: value }
    }
    const s = value == null ? '' : String(value)
    const ms = Date.parse(s)
    if (Number.isFinite(ms)) return { iso: s, ms }
    const now = Date.now()
    return { iso: new Date(now).toISOString(), ms: now }
  }

  /* ── snapshot：GET /live 的响应体（不含 quota/ok，由 index.js 补） ── */
  const buildSnapshot = (after = 0) => {
    try {
      const raw = Number(after)
      const afterSeq = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
      const seen = events.filter((e) => e.seq > afterSeq)
      const recent = seen.length > SNAPSHOT_LIMIT ? seen.slice(seen.length - SNAPSHOT_LIMIT) : seen
      return {
        running,
        roundId,
        startedAt,
        elapsedMs: running ? Math.max(0, Date.now() - startedAtMs) : (lastDurationMs ?? 0),
        why,
        lastCode,
        lastDurationMs,
        phase: currentPhase(),
        cursor: events.length ? events[events.length - 1].seq : 0,
        events: recent.map((e) => ({ ...e })),
        stats: statsOf(),
      }
    } catch {
      return {
        running: false,
        roundId: null,
        startedAt: null,
        elapsedMs: 0,
        why: null,
        lastCode: null,
        lastDurationMs: null,
        phase: phaseOfTool(''),
        cursor: 0,
        events: [],
        stats: { events: 0, tools: {}, actions: emptyActions(), errors: 0 },
      }
    }
  }

  const api = {
    /** 轮次开始：flush 上一轮残行 → 清空事件与统计 → 记录轮次元信息 */
    start(info) {
      try {
        const it = info && typeof info === 'object' ? info : {}
        flushLineBuffer()
        running = true
        roundId = it.roundId == null ? null : String(it.roundId)
        why = it.why == null ? null : String(it.why)
        const at = toStartedAt(it.startedAt)
        startedAt = at.iso
        startedAtMs = at.ms
        events = []
        tools = {}
        lastTool = null
        actions = emptyActions()
        errors = 0
        lineBuf = ''
        decoder = new globalThis.TextDecoder('utf-8')
        decoderPending = false
        notifyState()
      } catch { /* 兜住 */ }
    },

    /** 轮次结束：flush 残行 → 记录退出码与耗时（事件保留供回看） */
    end(info) {
      try {
        const it = info && typeof info === 'object' ? info : {}
        flushLineBuffer()
        running = false
        lastCode = it.code === undefined ? null : it.code
        const dur = Number(it.durationMs)
        lastDurationMs = Number.isFinite(dur) && dur >= 0 ? dur : 0
        notifyState()
      } catch { /* 兜住 */ }
    },

    /** 宿主事件（index.js 的 log() 用） */
    pushHost(text) {
      try {
        const s = text == null ? '' : String(text)
        if (!s.trim()) return null
        return addEvent('host', s)
      } catch {
        return null
      }
    },

    /** 子进程 stdout/stderr 原始块：按行切、分类、入缓冲；半行留到下次 */
    pushChildChunk(chunk) {
      try {
        const text = takeChunkText(chunk)
        if (!text) return 0
        lineBuf += text
        let count = 0
        let idx = lineBuf.indexOf('\n')
        while (idx !== -1) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, '')
          lineBuf = lineBuf.slice(idx + 1)
          if (emitLine(line)) count++
          idx = lineBuf.indexOf('\n')
        }
        // 一直没有换行的超长输出：强制作一行（截断后）入缓冲，防内存失控
        if (lineBuf.length > LINE_BUFFER_CAP) {
          const line = lineBuf
          lineBuf = ''
          if (emitLine(line)) count++
        }
        return count
      } catch {
        return 0
      }
    },

    /** 直接入事件（自动 seq/t）；任何入参都不抛 */
    push(frame) {
      try {
        const f = frame && typeof frame === 'object' ? frame : {}
        const kind = typeof f.kind === 'string' && f.kind ? f.kind : 'text'
        if (kind === 'blank') return null
        const tool = kind === 'tool'
          ? (f.tool == null || String(f.tool) === '' ? toolOf(f.text) : String(f.tool))
          : ''
        return addEvent(kind, f.text, tool)
      } catch {
        return null
      }
    },

    /** 见契约 §1.2 GET /live（不含 quota/ok）；after 过滤 seq > after，最多回 200 条 */
    snapshot(after = 0) {
      return buildSnapshot(after)
    },

    /**
     * 订阅推流：listener 只收两种消息对象（Lead 2026-10-25 补充）：
     *   新事件 { kind:'event', frame:{seq,t,kind,tool?,text} }
     *   状态变化 { kind:'state' } —— 订阅方自己调 snapshot() 取整体状态
     * 返回幂等 unsubscribe；listener 抛异常一律吞掉。
     */
    onPush(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => {
        try { listeners.delete(listener) } catch { /* 兜住 */ }
      }
    },

    /** 全量复位（seq 计数器不复位，保持客户端「更大」判断成立） */
    reset() {
      try {
        running = false
        roundId = null
        startedAt = null
        startedAtMs = 0
        why = null
        lastCode = null
        lastDurationMs = null
        events = []
        tools = {}
        lastTool = null
        actions = emptyActions()
        errors = 0
        lineBuf = ''
        decoder = new globalThis.TextDecoder('utf-8')
        decoderPending = false
        notifyState()
      } catch { /* 兜住 */ }
    },
  }

  return api
}
