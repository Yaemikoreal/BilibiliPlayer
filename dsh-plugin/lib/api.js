/**
 * 路由工厂：把依赖全部注入，方便在没有 DSH 的情况下单测（设计文档 §8）。
 * 返回的 handler 签名是 Node 原始风格 (req, res)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { effectiveConfig, validateFields, writeOverride } from './config.js'
import { toActivities, groupByDay } from './activity.js'

const PREFIX = '/api/bili-fenshen'
const HOST_LINE = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/

export function createApiHandler(deps) {
  const patchConfig = () => (typeof deps.patchConfig === 'function' ? deps.patchConfig() : deps.patchConfig)
  const sendJson = (res, status, data) => {
    try {
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

  return async function handler(req, res) {
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
        return sendJson(res, 200, deps.runDuty())
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
      return sendJson(res, 404, { ok: false, error: `unknown ${method} ${path}` })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  }
}
