/**
 * 路由工厂：把依赖全部注入，方便在没有 DSH 的情况下单测（设计文档 §8）。
 * 返回的 handler 签名是 Node 原始风格 (req, res)；handler.closeSse() 供插件卸载时关掉所有实时流连接。
 */
import { existsSync, readFileSync } from 'node:fs'
import { effectiveConfig, validateFields, writeOverride, normalizeScheduleFields } from './config.js'
import { toActivities, groupByDay } from './activity.js'

const PREFIX = '/api/bili-fenshen'
const HOST_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/
const SSE_MAX_CLIENTS = 4
const SSE_HEARTBEAT_MS = 15_000

/* ───────── 判重表解析（seen.md） ─────────
 * 真实账本是 markdown 列表，单元格分隔符是「空格 · 空格」（动作文本内部还有不带空格的 ·，不能一起切）：
 *   - 2026-10-22 · BV1xrnz6gEVD · 看过+赞过 · 折1万次，会坏吗？iPhone Duo深度评测
 *   - 2026-10-22 · 21:58 · 第二轮值班开始（已登录，凭证有效） · -
 * 时间可选（第二格是 HH:MM 才算时间，否则并入动作所在格）。没有 BV 的是备注行
 * （第 N 轮值班开始 / 本轮配额说明 / 搜索档跳过），按 console-demo-data.mjs 的口径保留：
 * bvid 为 ''，备注原文放 action，其余段拼进 title；占位符 - / — 视为空单元格，不落进字段。
 * 兼容旧账本格式「YYYY-MM-DD HH:MM · …」（时间写在日期格里），老文件和老测试不回归。
 */
const SEEN_CELL_SEP = /\s+·\s+/
const SEEN_DATE = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?$/
const SEEN_TIME = /^\d{1,2}:\d{2}$/
const SEEN_BV = /BV[0-9A-Za-z]+/
const SEEN_PLACEHOLDER = /^[—–-]$/

function parseSeenRows(raw) {
  const rows = []
  for (const line of String(raw || '').split('\n')) {
    const body = line.trim().replace(/^[-*]\s*/, '')
    if (!body) continue
    const parts = body.split(SEEN_CELL_SEP)
    const dm = SEEN_DATE.exec(parts[0] || '')
    if (!dm) continue
    const date = dm[1]
    let time = dm[2] || ''
    let rest = parts.slice(1)
    if (!time && rest[0] && SEEN_TIME.test(rest[0])) {
      time = rest[0]
      rest = rest.slice(1)
    }
    const bvAt = rest.findIndex((x) => SEEN_BV.test(x))
    if (bvAt >= 0) {
      const tail = rest.slice(bvAt + 1).filter((x) => x && !SEEN_PLACEHOLDER.test(x))
      rows.push({ date, time, bvid: SEEN_BV.exec(rest[bvAt])[0], action: tail[0] || '', title: tail.slice(1).join(' · ') })
    } else {
      const cells = rest.filter((x) => x && !SEEN_PLACEHOLDER.test(x))
      rows.push({ date, time, bvid: '', action: cells[0] || '', title: cells.slice(1).join(' · ') })
    }
  }
  return rows
}

/* ───────── 同源守卫（borrowed from dsh-agent-md 评审：本地 API 无鉴权是家族通病） ─────────
 * webServer 载体把原始 req/res 直接交给路由（无任何中间件），而这里的 POST 能 spawn
 * 值班轮（用真账号发帖）、写凭证与配置 ⇒ 浏览器跨站面必须关死。守卫只在「头存在且矛盾」
 * 时拒绝，无头客户端（curl / 单测探针 req.headers 缺失）不受影响：
 *   1) Sec-Fetch-Site: cross-site / same-site ⇒ 403（跨站 fetch/表单，no-cors 也带这个头）
 *   2) Origin: null ⇒ 403（沙箱 iframe / 某些跳转，正常 GUI 不会发）
 *   3) Origin 存在时必须与 Host 头同 host ⇒ 403（跨站请求的 Origin ≠ 本站）
 *   4) webOrigin 可解析时 Origin/Host 必须与其一致 ⇒ 顺带挡 DNS rebinding
 *   5) POST 只收 application/json（no-cors 的 text/plain 可带任意 body，不校验就是直通门）
 */
export function sameOriginGuard(req, webOrigin) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return { ok: true }
  const site = String(headers['sec-fetch-site'] || '')
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `跨站请求被拒（Sec-Fetch-Site: ${site}）` }
  }
  const expected = (() => {
    try { return typeof webOrigin === 'function' ? (webOrigin() || '') : (webOrigin || '') } catch { return '' }
  })()
  const host = String(headers.host || '')
  if (expected) {
    try {
      const expectHost = new URL(expected).host
      if (host && host !== expectHost) return { ok: false, reason: `Host 与本机服务不符（${host} ≠ ${expectHost}）` }
    } catch { /* expected 不是合法 URL：跳过这项，其余检查照做 */ }
  }
  const origin = String(headers.origin || '')
  if (origin) {
    if (origin === 'null') return { ok: false, reason: 'Origin: null 被拒' }
    if (expected && origin !== expected) return { ok: false, reason: `跨站 Origin 被拒（${origin}）` }
    try {
      if (host && new URL(origin).host !== host) return { ok: false, reason: `跨站 Origin 被拒（${origin}）` }
    } catch { return { ok: false, reason: `无法解析的 Origin（${origin}）` } }
  }
  if (String(req.method || '').toUpperCase() === 'POST') {
    const ct = String(headers['content-type'] || '')
    if (ct && !ct.toLowerCase().startsWith('application/json')) {
      return { ok: false, status: 415, reason: `POST 只收 application/json（收到 ${ct}）` }
    }
  }
  return { ok: true }
}

export function createApiHandler(deps) {
  const patchConfig = () => (typeof deps.patchConfig === 'function' ? deps.patchConfig() : deps.patchConfig)
  const sendJson = (res, status, data) => {
    try {
      if (res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data, null, 2))
    } catch { /* 客户端断开 */ }
  }

  const readBody = async (req) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return {}
    }
  }

  const recentEvents = () => {
    const days = 7
    const from = Date.now() - days * 86400_000
    return (deps.readEvents() || []).filter((e) => {
      const t = Date.parse(e?.t || '')
      return Number.isFinite(t) ? t >= from : true
    })
  }

  /* ───────── 实时运行流（SSE） ─────────
   * GET /live/stream：连上先发一个 snapshot，之后有事件发 event、轮次起止发 snapshot、每 15s 心跳。
   * 连接集合保存在闭包里，handler.closeSse() 在插件卸载时统一关闭（避免重载后旧实例继续推流）。
   */
  const sseClients = new Set()

  const openSse = (req, res) => {
    if (!deps.live || typeof deps.live.snapshot !== 'function' || typeof deps.live.subscribe !== 'function') {
      return sendJson(res, 503, { ok: false, error: '实时流不可用（live 依赖缺失）' })
    }
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      return sendJson(res, 503, { ok: false, error: `实时连接过多（上限 ${SSE_MAX_CLIENTS}），刷新页面后重试` })
    }
    const snapshot = () => {
      try { return deps.live.snapshot(0) } catch (e) {
        return { ok: false, error: String(e?.message ?? e), running: false, events: [], cursor: 0 }
      }
    }
    let closed = false
    let heartbeat = null
    let unsub = null
    const write = (obj) => {
      if (closed) return
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { cleanup() }
    }
    const cleanup = () => {
      if (closed) return
      closed = true
      try { if (typeof unsub === 'function') unsub() } catch { /* 兜住 */ }
      try { if (heartbeat) clearInterval(heartbeat) } catch { /* 兜住 */ }
      sseClients.delete(cleanup)
      try { res.end() } catch { /* 兜住 */ }
    }
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
    } catch { return undefined }
    sseClients.add(cleanup)
    try { req.on?.('close', cleanup); req.on?.('error', cleanup) } catch { /* 兜住 */ }
    try { res.on?.('close', cleanup); res.on?.('error', cleanup) } catch { /* 兜住 */ }
    write({ type: 'snapshot', snapshot: snapshot() })
    try {
      unsub = deps.live.subscribe((msg) => {
        if (msg?.kind === 'event' && msg.frame) write({ type: 'event', frame: msg.frame })
        else write({ type: 'snapshot', snapshot: snapshot() })
      })
    } catch { /* 订阅失败：至少保留心跳与首帧 */ }
    heartbeat = setInterval(() => {
      if (closed) return
      try { res.write(': ping\n\n') } catch { cleanup() }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    return undefined
  }

  /* ───────── 概览实时流（SSE）：一封信封 + 运行中轻量 tick ─────────
   * 设计定稿 2026-10-28 §2.2。与 /live/stream 分开：
   *   /live/stream  = 一轮里的工具/输出事件流（给「运行详情」）
   *   /stream       = 概览数字（配额/轮次/存在感/健康），文件一变就推
   * 两者共用同一个连接上限与卸载清理口径。
   *
   * W4-3（空闲不推 tick 帧）：旧实现每 1.5s 无条件算一次 `deps.live.snapshot(0)`；
   * index.js 的 snapshot 会读账本 + config.json ⇒ 空闲挂一天就是一天的空转盘。
   * 现在：
   *   ① 先用**廉价的** `deps.live.isRunning()` 短路 —— 本轮没在跑就一个字节都不算；
   *      连接活性由 15s 的 `: ping` 注释心跳保证（EventSource 不靠 data 帧保活）。
   *   ② 运行中按「关键字段签名」去重：轮次/阶段/工具计数/动作计数/本轮配额变化 ⇒ 立刻推；
   *      都没变化时最长 `TICK_HEARTBEAT_MS` 补一帧（撑住前端「数据 Ns 前」，否则会误报 warn）。
   *      秒表不靠 tick 的 elapsedMs：客户端 useElapsed 用 startedAt 本地推算（见 client.js:1130）。
   */
  const TICK_MS = 1500
  /** 运行中「状态没变化」时最长多少毫秒补一帧（前端 >15s 会显示 warn，留 5s 余量） */
  const TICK_HEARTBEAT_MS = 10_000

  /** tick 帧的「有变化」签名：只含会变的关键字段（不含 elapsedMs —— 秒表由 startedAt 本地推） */
  const tickSignatureOf = (round, perRound) => {
    const stats = round?.stats || {}
    const pr = perRound || null
    return JSON.stringify([
      round?.roundId ?? null,
      round?.phase?.key ?? null,
      stats.tools || null,
      stats.actions || null,
      stats.errors ?? 0,
      pr ? [pr.roundId, pr.picked, pr.comments, pr.likes, pr.dynamics, pr.proactive, pr.scans, pr.replies] : null,
    ])
  }

  const openStream = (req, res) => {
    const hub = deps.overviewHub
    if (!hub || typeof hub.view !== 'function' || typeof hub.subscribe !== 'function') {
      return sendJson(res, 503, { ok: false, error: '实时流不可用（overviewHub 缺失）' })
    }
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      return sendJson(res, 503, { ok: false, error: `实时连接过多（上限 ${SSE_MAX_CLIENTS}），刷新页面后重试` })
    }
    let closed = false
    let heartbeat = null
    let tickTimer = null
    let unsub = null
    const cleanup = () => {
      if (closed) return
      closed = true
      try { if (unsub) unsub() } catch { /* 兜住 */ }
      try { if (heartbeat) clearInterval(heartbeat) } catch { /* 兜住 */ }
      try { if (tickTimer) clearInterval(tickTimer) } catch { /* 兜住 */ }
      sseClients.delete(cleanup)
      try { res.end() } catch { /* 兜住 */ }
    }
    const write = (obj) => {
      if (closed) return
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { cleanup() }
    }
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
    } catch { return undefined }
    sseClients.add(cleanup)
    try { req.on?.('close', cleanup); req.on?.('error', cleanup) } catch { /* 兜住 */ }
    try { res.on?.('close', cleanup); res.on?.('error', cleanup) } catch { /* 兜住 */ }

    // ⭐ hello 只做「连接已建立」确认，**不带 seq**：
    //    hub 已有数据且不脏时 view() 不自增，首帧 overview 的 seq 与 hub.seq 相同；
    //    若 hello 把 seq 交给客户端做单调起点，首帧就会被客户端的 seq 守卫丢掉，
    //    空闲期又没有后续 publish，页面会永远停在空数据态。
    write({ type: 'hello', serverTime: new Date().toISOString() })
    let env = null
    // ⭐ 建连必须出一版**新**信封：首帧 seq 严格大于 hello 的 seq。
    //    否则（数据已算过、不脏时 view() 返回同一个 seq）客户端的 seq 单调守卫
    //    会把首帧丢掉，整份概览永远到不了页面。
    try { env = typeof hub.bump === 'function' ? hub.bump('stream-open') : hub.view('stream-open') } catch { env = null }
    if (env) write({ type: 'overview', data: env })
    try { unsub = hub.subscribe((next) => write({ type: 'overview', data: next })) } catch { /* 至少保留首帧 */ }

    // 运行中按「有变化才推」：见本段头部 W4-3 说明。
    let lastTickSig = ''
    let lastTickAt = 0
    tickTimer = setInterval(() => {
      if (closed) return
      try {
        // ① 空闲短路（W4-3）：先问廉价的 isRunning，没在跑就**不算 snapshot**（不读账本/配置），也不推帧。
        if (typeof deps.live?.isRunning === 'function' && deps.live.isRunning() === false) return
        const snap = deps.live?.snapshot ? deps.live.snapshot(0) : null
        if (!snap?.running) return
        const perRound = typeof deps.quotaPerRound === 'function' ? deps.quotaPerRound() : null
        const round = {
          running: true,
          roundId: snap.roundId ?? null,
          startedAt: snap.startedAt ?? null,
          elapsedMs: Number(snap.elapsedMs) || 0,
          phase: snap.phase || null,
          stats: snap.stats || null,
        }
        // ② 关键字段没变且离上一帧不到心跳上限 ⇒ 不重复推
        const sig = tickSignatureOf(round, perRound)
        const at = Date.now()
        if (sig === lastTickSig && at - lastTickAt < TICK_HEARTBEAT_MS) return
        lastTickSig = sig
        lastTickAt = at
        write({ type: 'tick', seq: hub.seq, round, quota: { perRound } })
      } catch { /* 兜住 */ }
    }, TICK_MS)
    tickTimer.unref?.()

    heartbeat = setInterval(() => {
      if (closed) return
      try { res.write(': ping\n\n') } catch { cleanup() }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    return undefined
  }

  const handler = async function handler(req, res) {
    let url = null
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }
    const path = url.pathname
    const method = req.method
    try {
      // 同源守卫（覆盖工厂全部端点，含两个 SSE；老端点由 index.js 的 dispatch 统一守）
      const guard = sameOriginGuard(req, deps.webOrigin)
      if (!guard.ok) return sendJson(res, guard.status || 403, { ok: false, error: guard.reason })
      if (!path.startsWith(PREFIX)) return sendJson(res, 404, { ok: false, error: 'not found' })

      if (method === 'GET' && path === `${PREFIX}/overview`) {
        // 优先走实时中枢（seq/新鲜度/运行中进度都在里面）；没有中枢（老测试）退回裸组装
        const hub = deps.overviewHub
        if (hub && typeof hub.view === 'function') {
          try { return sendJson(res, 200, hub.view('http')) } catch { /* 落到下面兜底 */ }
        }
        return sendJson(res, 200, { ok: true, ...deps.overview() })
      }
      if (method === 'GET' && path === `${PREFIX}/activity`) {
        const { rounds } = toActivities(recentEvents())
        return sendJson(res, 200, { ok: true, days: groupByDay(rounds) })
      }
      if (method === 'GET' && path === `${PREFIX}/account`) {
        return sendJson(res, 200, { ok: true, account: await deps.fetchAccount() })
      }
      if (method === 'POST' && path === `${PREFIX}/duty`) {
        /* 旧用法：{autoDuty: boolean}；新用法：排班字段一起传（只传排班字段也可以）。
         * 校验口径与 POST /config 一致（validateFields），未知字段/非法值 400，不静默回落。
         * 兼容策略：不带排班字段时仍按旧错误文案「autoDuty 必须是 boolean」返回。 */
        const body = await readBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: '请求体必须是对象' })
        }
        const keys = Object.keys(body)
        if (!keys.length) return sendJson(res, 400, { ok: false, error: 'autoDuty 必须是 boolean' })
        const hasSchedule = keys.some((k) => k !== 'autoDuty')
        if (!hasSchedule && typeof body.autoDuty !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'autoDuty 必须是 boolean' })
        }
        const check = validateFields(body)
        if (!check.ok) return sendJson(res, 400, { ok: false, error: check.error, field: check.field })
        return sendJson(res, 200, { ok: true, ...deps.setDuty(normalizeScheduleFields(body)) })
      }
      if (method === 'POST' && path === `${PREFIX}/run`) {
        // runDuty 现在可能返回 Promise（spawn 前要异步校验模型推理强度），统一 await 后再回包
        return sendJson(res, 200, await deps.runDuty())
      }
      if (method === 'POST' && path === `${PREFIX}/stop`) {
        return sendJson(res, 200, deps.stopDuty())
      }
      if (method === 'GET' && path === `${PREFIX}/config`) {
        const cfg = effectiveConfig(patchConfig(), deps.configFile)
        return sendJson(res, 200, { ok: true, ...cfg })
      }
      if (method === 'POST' && path === `${PREFIX}/config`) {
        const body = await readBody(req)
        const check = validateFields(body)
        if (!check.ok) return sendJson(res, 400, { ok: false, error: check.error, field: check.field })
        // 排班字段落盘前归一化（时间/星期去重排序），其余字段原样
        const patch = normalizeScheduleFields(body)
        const cur = effectiveConfig(patchConfig(), deps.configFile)
        const next = { ...cur.values, ...patch }
        if (!writeOverride(deps.configFile, next)) {
          return sendJson(res, 500, { ok: false, error: '写覆盖层失败' })
        }
        // 配置一改，概览信封里的 limits/nextRunAt 就变了：立刻推一帧，别等 2s 轮询
        // ⭐ 保存配置后必须失效 CLI 探测缓存：dshBin/模型这类字段若被缓存挡住，
        //    用户改完最长要等 10 分钟才生效（详见 CONSOLE-ISSUES P1-4）。
        try { deps.resetCliCaches?.() } catch { /* 兜住 */ }
        try { deps.overviewHub?.publish?.('config') } catch { /* 兜住 */ }
        return sendJson(res, 200, { ok: true, ...effectiveConfig(patchConfig(), deps.configFile) })
      }
      if (method === 'GET' && path === `${PREFIX}/log`) {
        const tail = Math.min(2000, Math.max(20, Number(url.searchParams.get('tail')) || 200))
        let raw = ''
        try {
          if (existsSync(deps.logFile)) raw = readFileSync(deps.logFile, 'utf8')
        } catch { /* 读不到就算了 */ }
        const lines = raw.split('\n').filter(Boolean)
        const hostEvents = lines.map((l) => l).filter((l) => HOST_LINE.test(l)).slice(-tail)
        return sendJson(res, 200, { ok: true, events: hostEvents, raw: lines.slice(-tail).join('\n'), path: deps.logFile })
      }
      if (method === 'GET' && path === `${PREFIX}/seen`) {
        let raw = ''
        try {
          if (existsSync(deps.seenFile)) raw = readFileSync(deps.seenFile, 'utf8')
        } catch { /* 同上 */ }
        return sendJson(res, 200, { ok: true, rows: parseSeenRows(raw), raw })
      }
      if (method === 'GET' && path === `${PREFIX}/reports`) {
        const r = deps.listReports ? deps.listReports() : { days: [], digests: [], overlay: false }
        return sendJson(res, 200, { ok: true, days: r.days || [], digests: r.digests || [], overlay: !!r.overlay })
      }

      /* ── 新增：模型目录 ── */
      if (method === 'GET' && path === `${PREFIX}/models`) {
        if (typeof deps.models !== 'function') return sendJson(res, 503, { ok: false, error: '模型目录不可用' })
        return sendJson(res, 200, await deps.models())
      }

      /* ── 新增：一键诊断 ── */
      if (method === 'POST' && path === `${PREFIX}/diagnose`) {
        if (typeof deps.diagnose !== 'function') return sendJson(res, 503, { ok: false, error: '诊断不可用' })
        return sendJson(res, 200, await deps.diagnose())
      }

      /* ── 新增：实时运行流（JSON 增量 + SSE） ── */
      if (method === 'GET' && path === `${PREFIX}/live`) {
        if (!deps.live || typeof deps.live.snapshot !== 'function') {
          return sendJson(res, 503, { ok: false, error: '实时流不可用' })
        }
        const after = Math.max(0, Number(url.searchParams.get('after')) || 0)
        return sendJson(res, 200, deps.live.snapshot(after))
      }
      if (method === 'GET' && path === `${PREFIX}/live/stream`) {
        return openSse(req, res)
      }
      if (method === 'GET' && path === `${PREFIX}/stream`) {
        return openStream(req, res)
      }

      return sendJson(res, 404, { ok: false, error: `unknown ${method} ${path}` })
    } catch (e) {
      try {
        if (!res.writableEnded && !res.headersSent) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
        } else {
          res.end()
        }
      } catch { /* 兜住 */ }
      return undefined
    }
  }

  // 插件卸载 / 重载时关掉所有 SSE 连接（否则旧实例的连接会一直挂着）
  handler.closeSse = () => {
    for (const cleanup of [...sseClients]) {
      try { cleanup() } catch { /* 兜住 */ }
    }
    sseClients.clear()
  }

  return handler
}
