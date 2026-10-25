/**
 * 路由工厂：把依赖全部注入，方便在没有 DSH 的情况下单测（设计文档 §8）。
 * 返回的 handler 签名是 Node 原始风格 (req, res)；handler.closeSse() 供插件卸载时关掉所有实时流连接。
 */
import { existsSync, readFileSync } from 'node:fs'
import { effectiveConfig, validateFields, writeOverride } from './config.js'
import { toActivities, groupByDay } from './activity.js'

const PREFIX = '/api/bili-fenshen'
const HOST_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/
const SSE_MAX_CLIENTS = 4
const SSE_HEARTBEAT_MS = 15_000

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
      if (!path.startsWith(PREFIX)) return sendJson(res, 404, { ok: false, error: 'not found' })

      if (method === 'GET' && path === `${PREFIX}/overview`) {
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
        const body = await readBody(req)
        if (typeof body.autoDuty !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'autoDuty 必须是 boolean' })
        }
        return sendJson(res, 200, { ok: true, ...deps.setDuty(body.autoDuty) })
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
        const cur = effectiveConfig(patchConfig(), deps.configFile)
        const next = { ...cur.values, ...body }
        if (!writeOverride(deps.configFile, next)) {
          return sendJson(res, 500, { ok: false, error: '写覆盖层失败' })
        }
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
        const rows = []
        for (const line of raw.split('\n')) {
          // 真实账本行形如：`2026-10-22 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 标题`
          // 无 BV 的行（如「—」）也要能解析出来，只是 bvid 为空
          const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*·\s*(.*?)\s*·\s*(.*?)\s*·\s*(.*)$/.exec(line.trim())
          if (!m) continue
          const bv = /BV[0-9A-Za-z]+/.exec(m[3])
          rows.push({ date: m[1], time: m[2] || '', bvid: bv ? bv[0] : '', action: m[4], title: m[5] })
        }
        return sendJson(res, 200, { ok: true, rows, raw })
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
