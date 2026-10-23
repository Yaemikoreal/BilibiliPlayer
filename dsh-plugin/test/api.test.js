// dsh-plugin/test/api.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiHandler } from '../lib/api.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-api-'))

function fakeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(s, h) { this.status = s; this.headers = h || {} },
    end(b) { this.body = String(b || '') },
  }
}

function deps(over = {}) {
  const home = dir()
  return {
    home,
    ledgerFile: join(home, 'ledger.jsonl'),
    configFile: join(home, 'config.json'),
    patchConfig: { autoDuty: false, perDay: 5 },
    readEvents: () => [
      // 用相对今天的时间，保证落在 7 天窗口内（写死日期会在几天后让测试误报）
      { t: new Date(Date.now() - 3600_000).toISOString(), round: 'r1', type: 'view', bvid: 'BV1', title: 'A', grade: 'worth' },
      { t: new Date(Date.now() - 3500_000).toISOString(), round: 'r1', type: 'comment', bvid: 'BV1', text: 'c', rpid: 1 },
    ],
    overview: () => ({ duty: { autoDuty: false }, quota: { picked: 1 }, round: { running: false }, health: { cred: true } }),
    setDuty: (v) => ({ ok: true, autoDuty: v }),
    runDuty: () => ({ started: true }),
    stopDuty: () => ({ ok: true, stopped: true }),
    fetchAccount: async () => ({ loggedIn: false }),
    ...over,
  }
}

async function call(handler, method, url, body) {
  const res = fakeRes()
  const req = { method, url, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)) } }
  await handler(req, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

test('GET /overview 返回 200 + JSON', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'GET', '/api/bili-fenshen/overview')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.duty.autoDuty, false)
})

test('GET /activity 返回按天分组', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'GET', '/api/bili-fenshen/activity')
  assert.equal(r.status, 200)
  assert.equal(r.json.days.length, 1)
  assert.equal(r.json.days[0].rounds[0].items[0].bvid, 'BV1')
})

test('POST /duty 切换开关', async () => {
  const h = createApiHandler(deps())
  const r = await call(h, 'POST', '/api/bili-fenshen/duty', { autoDuty: true })
  assert.equal(r.status, 200)
  assert.equal(r.json.autoDuty, true)
})

test('POST /stop 与 /run 透传', async () => {
  const h = createApiHandler(deps())
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/run')).json.started, true)
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/stop')).json.stopped, true)
})

test('未知路由 404', async () => {
  const h = createApiHandler(deps())
  assert.equal((await call(h, 'GET', '/api/bili-fenshen/nope')).status, 404)
})

test('POST /config 非法字段返回 400 且不落盘', async () => {
  const d = deps()
  const h = createApiHandler(d)
  const r = await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 'five' })
  assert.equal(r.status, 400)
  assert.equal(r.json.field, 'perDay')
})

test('POST /config 合法字段写入覆盖层', async () => {
  const d = deps()
  const h = createApiHandler(d)
  const r = await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 7 })
  assert.equal(r.status, 200)
  const again = await call(h, 'GET', '/api/bili-fenshen/config')
  assert.equal(again.json.values.perDay, 7)
  assert.equal(again.json.sources.perDay, 'override')
})

test('GET /log 把宿主事件与原文分开', async () => {
  const d = deps()
  const logFile = join(d.home, 'duty.log')
  writeFileSync(logFile, [
    '[2026-10-22T01:36:12.452Z] 注册工具失败（已兜住）',
    '模型推理原文一行',
    '[2026-10-22T01:40:54.039Z] host 已激活',
    '',
  ].join('\n'))
  const h = createApiHandler({ ...d, logFile })
  const r = await call(h, 'GET', '/api/bili-fenshen/log?tail=50')
  assert.equal(r.status, 200)
  assert.equal(r.json.events.length, 2)
  assert.match(r.json.raw, /模型推理原文/)
})

test('GET /seen 解析真实账本行（含时间与无 BV 行）', async () => {
  const d = deps()
  const seenFile = join(d.home, 'seen.md')
  writeFileSync(seenFile, [
    '# 判重表',
    '',
    '2026-10-22 14:10 · — · 本轮未登录 · —',
    '2026-10-22 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 折1万次，会坏吗？iPhone Duo深度评测',
    '',
  ].join('\n'))
  const h = createApiHandler({ ...d, seenFile })
  const r = await call(h, 'GET', '/api/bili-fenshen/seen')
  assert.equal(r.status, 200)
  assert.equal(r.json.rows.length, 2)
  assert.equal(r.json.rows[0].bvid, '')
  assert.equal(r.json.rows[1].bvid, 'BV1xrnz6gEVD')
  assert.equal(r.json.rows[1].title, '折1万次，会坏吗？iPhone Duo深度评测')
})
