#!/usr/bin/env node
/**
 * 独立验证脚本（T4 verifier，只读实现、不改源码）：契约 §1.2 新增 HTTP 端点。
 *
 * 覆盖（直接 createApiHandler(fake deps)，不起宿主、不联网、不碰真实家目录）：
 *  - GET  /models        缺 deps.models → 503；正常 → 200 透传；抛错 → 500
 *  - POST /diagnose      缺 deps.diagnose → 503；正常 → 200 透传；抛错 → 500
 *  - GET  /live?after=N  把 after 透传给 deps.live.snapshot；缺 deps.live → 503；快照抛错 → 500
 *  - GET  /live/stream   首帧 snapshot / event 帧 / state→snapshot 帧 / 心跳不早于 15s /
 *                        closeSse 后 res.end 且退订 / req close 清理 / 连接上限 4 超出 503
 *  - 旧端点 /overview /log /config /run /duty 与 404 兜底不受影响
 *
 * 用法：node dsh-plugin/test/verify-new-api.mjs
 * 退出码：0 = 全过，1 = 有失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiHandler } from '../lib/api.js'

/* ───────────────────────── 小工具 ───────────────────────── */

const results = []
let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (e) {
    failed++
    results.push({ name, ok: false, error: e })
    console.log(`FAIL  ${name}`)
    const msg = String((e && (e.message || e)) ?? e)
    for (const line of msg.split('\n').slice(0, 8)) console.log(`      ${line}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const homes = []
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'bf-verify-'))
  homes.push(home)
  return home
}

/** 普通 JSON 响应的 fake res（对齐 test/api.test.js 的 fakeRes，但补齐 SSE 用字段） */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    ended: false,
    body: '',
    writeHead(s, h) {
      this.status = s
      this.headers = h || {}
      this.headersSent = true
    },
    end(b) {
      this.ended = true
      this.writableEnded = true
      this.body = b === undefined ? '' : String(b)
    },
  }
}

/** SSE 专用 fake res：记录每个 chunk，供帧解析 */
function sseRes() {
  return {
    status: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    ended: false,
    chunks: [],
    writeHead(s, h) {
      this.status = s
      this.headers = h || {}
      this.headersSent = true
    },
    flushHeaders() {},
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(b) {
      this.ended = true
      this.writableEnded = true
      this.body = b === undefined ? '' : String(b)
    },
    on() {},
  }
}

/** SSE 专用 fake req：记录 on('close') 等监听，便于模拟客户端断开 */
function sseReq() {
  const handlers = new Map()
  return {
    method: 'GET',
    url: '/api/bili-fenshen/live/stream',
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
    },
    emit(ev) {
      for (const fn of handlers.get(ev) || []) fn()
    },
    handlers,
  }
}

/** 从 SSE chunk 流里解出所有 data: 帧 */
function frames(res) {
  return res.chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)))
}

async function call(handler, method, path, body) {
  const res = fakeRes()
  const req = {
    method,
    url: path,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await handler(req, res)
  let json = null
  try {
    json = res.body ? JSON.parse(res.body) : null
  } catch {
    json = undefined // 非 JSON 响应（便于断言失败时看原始体）
  }
  return { status: res.status, json, raw: res.body, res }
}

/* ───────────────────────── fake deps ───────────────────────── */

const modelsPayload = {
  ok: true,
  selection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  effective: { mode: 'default', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
  config: { modelProvider: '', modelName: '', modelReasoningEffort: '' },
  providers: [{ id: 'deepseek-account', name: 'DeepSeek' }],
  models: { 'deepseek-account': [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
  reasoningEfforts: [{ id: 'high', name: 'High', description: '' }],
  warnings: [],
}

const CHECK_ORDER = ['python', 'deps', 'mcp-server', 'mcp-connection', 'credential', 'dsh-cli', 'headless-profile', 'home', 'model', 'route']
const diagnosePayload = {
  ok: true,
  generatedAt: '2026-10-25T01:02:03.000Z',
  durationMs: 1234,
  summary: { pass: 9, warn: 1, fail: 0 },
  items: CHECK_ORDER.map((id, i) => ({
    id,
    label: `label-${id}`,
    status: i === 4 ? 'warn' : 'pass',
    detail: `detail-${id}`,
    fix: i === 4 ? 'fix-cred' : '',
    durationMs: i,
  })),
}

const PATCH_CONFIG = {
  autoDuty: false,
  noon: true,
  night: true,
  perDay: 5,
  commentsPerDay: 5,
  commentsPerRound: 2,
  likesPerDay: 10,
  dynamicsPerDay: 1,
  repliesPerRound: 2,
  keywords: [],
  followUids: [],
  personaPrompt: '',
  reportLevel: 'full',
  dshBin: '',
  headlessProfile: 'headless',
  dutyTools: [],
  modelProvider: '',
  modelName: '',
  modelReasoningEffort: '',
}

function makeDeps(over = {}) {
  const home = makeHome()
  return {
    home,
    ledgerFile: join(home, 'ledger.jsonl'),
    configFile: join(home, 'config.json'),
    seenFile: join(home, 'seen.md'),
    logFile: join(home, 'duty.log'),
    patchConfig: { ...PATCH_CONFIG },
    readEvents: () => [],
    overview: () => ({
      duty: { autoDuty: false, windows: { noon: true, night: true }, nextWindowLabel: '—' },
      quota: { picked: 0, comments: 0, likes: 0, dynamics: 0, limits: { perDay: 5 } },
      round: { running: false, lastCode: null },
      health: { cred: false, routeOk: true },
      model: { mode: 'default', provider: '', model: '', reasoningEffort: '' },
    }),
    /* POST /duty 已升级为「排班 patch 对象」模式（lib/api.js:357 传 normalizeScheduleFields(body)），
     * 桩必须与生产同形：生产（index.js:2236）返回 { autoDuty: !!next.autoDuty, ...clean }，
     * 即 autoDuty 是**布尔**、排班字段回显。旧桩 `{ autoDuty: v }` 把整个对象塞进 autoDuty 字段，
     * 让「旧端点仍可用」的断言假红（2026-10-29 测试报告 §3.2）。 */
    setDuty: (v) => {
      const patch = v && typeof v === 'object' && !Array.isArray(v) ? v : { autoDuty: !!v }
      return { autoDuty: !!patch.autoDuty, ...patch }
    },
    runDuty: () => ({ started: true, why: 'web', roundId: 'r-1' }),
    stopDuty: () => ({ ok: true, stopped: false }),
    fetchAccount: async () => ({ loggedIn: false }),
    listReports: () => ({ days: [], digests: [], overlay: false }),
    ...over,
  }
}

/** live 依赖 stub：记录 after 入参 / 退订次数 / 当前 listener，snapshot 可注入 */
function makeLiveStub({ snapshotImpl } = {}) {
  const calls = { after: [], unsubs: 0 }
  const listeners = new Set()
  let n = 0
  const live = {
    snapshot(after) {
      calls.after.push(after)
      if (snapshotImpl) return snapshotImpl(after)
      n++
      return {
        ok: true,
        running: false,
        roundId: null,
        startedAt: null,
        elapsedMs: 0,
        why: null,
        lastCode: null,
        lastDurationMs: null,
        phase: { key: 'think', label: '思考' },
        cursor: after + n,
        events: [],
        stats: { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 },
        quota: {
          picked: 0, comments: 0, likes: 0, dynamics: 0,
          limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 },
        },
        marker: n,
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        calls.unsubs++
        listeners.delete(listener)
      }
    },
  }
  return { live, calls, listeners }
}

/* ───────────────────────── 1. GET /models ───────────────────────── */

await check('GET /models：deps.models 缺失 → 503（ok:false）', async () => {
  const h = createApiHandler(makeDeps())
  const r = await call(h, 'GET', '/api/bili-fenshen/models')
  assert.equal(r.status, 503)
  assert.equal(r.json?.ok, false)
  assert.ok(typeof r.json?.error === 'string' && r.json.error.length > 0)
})

await check('GET /models：正常 → 200 且原样透传（形状/字段值不变）', async () => {
  let calls = 0
  const payload = JSON.parse(JSON.stringify(modelsPayload))
  const h = createApiHandler(makeDeps({ models: async () => { calls++; return payload } }))
  const r = await call(h, 'GET', '/api/bili-fenshen/models')
  assert.equal(r.status, 200)
  assert.equal(calls, 1)
  assert.deepEqual(r.json, payload)
  // 契约 §1.2 关键字段
  assert.equal(r.json.ok, true)
  assert.ok(r.json.selection && r.json.effective && r.json.config)
  assert.ok(Array.isArray(r.json.providers) && r.json.providers[0].id === 'deepseek-account')
  assert.ok(r.json.models && Array.isArray(r.json.models['deepseek-account']))
  assert.ok(Array.isArray(r.json.reasoningEfforts) && Array.isArray(r.json.warnings))
  assert.ok(['config', 'default'].includes(r.json.effective.mode))
})

await check('GET /models：deps.models 抛错 → 500（不把异常泄漏成 200/503）', async () => {
  const h = createApiHandler(makeDeps({ models: async () => { throw new Error('provider 目录炸了') } }))
  const r = await call(h, 'GET', '/api/bili-fenshen/models')
  assert.equal(r.status, 500)
  assert.equal(r.json?.ok, false)
  assert.match(String(r.json?.error), /provider 目录炸了/)
})

/* ───────────────────────── 2. POST /diagnose ───────────────────────── */

await check('POST /diagnose：deps.diagnose 缺失 → 503', async () => {
  const h = createApiHandler(makeDeps())
  const r = await call(h, 'POST', '/api/bili-fenshen/diagnose')
  assert.equal(r.status, 503)
  assert.equal(r.json?.ok, false)
})

await check('POST /diagnose：正常 → 200 且原样透传（10 项顺序/summary/ok 规则）', async () => {
  const payload = JSON.parse(JSON.stringify(diagnosePayload))
  const h = createApiHandler(makeDeps({ diagnose: async () => payload }))
  const r = await call(h, 'POST', '/api/bili-fenshen/diagnose')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, payload)
  assert.equal(r.json.items.length, 10)
  assert.deepEqual(r.json.items.map((x) => x.id), CHECK_ORDER)
  assert.deepEqual(Object.keys(r.json.summary).sort(), ['fail', 'pass', 'warn'])
  assert.equal(r.json.summary.pass + r.json.summary.warn + r.json.summary.fail, 10)
  assert.equal(r.json.ok, r.json.summary.fail === 0)
})

await check('POST /diagnose：deps.diagnose 抛错 → 500', async () => {
  const h = createApiHandler(makeDeps({ diagnose: async () => { throw new Error('诊断炸了') } }))
  const r = await call(h, 'POST', '/api/bili-fenshen/diagnose')
  assert.equal(r.status, 500)
  assert.equal(r.json?.ok, false)
  assert.match(String(r.json?.error), /诊断炸了/)
})

/* ───────────────────────── 3. GET /live?after=N ───────────────────────── */

await check('GET /live：deps.live 缺失 → 503', async () => {
  const h = createApiHandler(makeDeps())
  const r = await call(h, 'GET', '/api/bili-fenshen/live')
  assert.equal(r.status, 503)
  assert.equal(r.json?.ok, false)
})

await check('GET /live：deps.live 无 snapshot 方法 → 503', async () => {
  const h = createApiHandler(makeDeps({ live: { subscribe: () => () => {} } }))
  const r = await call(h, 'GET', '/api/bili-fenshen/live')
  assert.equal(r.status, 503)
})

await check('GET /live?after=42：after 透传给 snapshot，响应 equals 快照', async () => {
  const snap = {
    ok: true, running: true, roundId: 'r-1', startedAt: '2026-10-25T01:00:00.000Z',
    elapsedMs: 61234, why: 'web', lastCode: null, lastDurationMs: null,
    phase: { key: 'watch', label: '看内容' }, cursor: 128,
    events: [{ seq: 101, t: '2026-10-25T01:00:12.000Z', kind: 'tool', tool: 'bili_subtitle', text: '→ bili_subtitle' }],
    stats: { events: 28, tools: { bili_search: 1 }, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 },
    quota: { picked: 1, comments: 0, likes: 0, dynamics: 0, limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 } },
  }
  const stub = makeLiveStub({ snapshotImpl: () => snap })
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const r = await call(h, 'GET', '/api/bili-fenshen/live?after=42')
  assert.equal(r.status, 200)
  assert.deepEqual(stub.calls.after, [42])
  assert.deepEqual(r.json, snap)
})

await check('GET /live：after 缺省/非法 → snapshot 收到 0（不收到 NaN/负数）', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  assert.equal((await call(h, 'GET', '/api/bili-fenshen/live')).status, 200)
  assert.equal((await call(h, 'GET', '/api/bili-fenshen/live?after=abc')).status, 200)
  assert.equal((await call(h, 'GET', '/api/bili-fenshen/live?after=-7')).status, 200)
  assert.deepEqual(stub.calls.after, [0, 0, 0])
})

await check('GET /live：snapshot 抛错 → 500', async () => {
  const h = createApiHandler(makeDeps({ live: { snapshot: () => { throw new Error('快照炸了') }, subscribe: () => () => {} } }))
  const r = await call(h, 'GET', '/api/bili-fenshen/live')
  assert.equal(r.status, 500)
  assert.match(String(r.json?.error), /快照炸了/)
})

/* ───────────────────────── 4. GET /live/stream（SSE） ───────────────────────── */

await check('GET /live/stream：deps.live 缺失 → 503 JSON（不是 SSE 头）', async () => {
  const h = createApiHandler(makeDeps())
  const res = sseRes()
  await h(sseReq(), res)
  assert.equal(res.status, 503)
  assert.match(String(res.headers['content-type']), /application\/json/)
  assert.equal(res.chunks.length, 0, '不应写 SSE 帧')
})

await check('GET /live/stream：首帧是 data:{"type":"snapshot",...}（含 quota）', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const res = sseRes()
  await h(sseReq(), res)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /^text\/event-stream/)
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform')
  assert.equal(res.chunks.length, 1, '连上应先且仅先发 1 个 snapshot 帧')
  assert.ok(res.chunks[0].startsWith('data: {"type":"snapshot"'), `首帧原文：${res.chunks[0].slice(0, 80)}`)
  const f = frames(res)
  assert.equal(f.length, 1)
  assert.equal(f[0].type, 'snapshot')
  assert.ok(f[0].snapshot && typeof f[0].snapshot.running === 'boolean')
  assert.ok(f[0].snapshot.quota && typeof f[0].snapshot.quota.limits.perDay === 'number')
  // 心跳 15s：刚连上不应有 : ping
  assert.equal(res.chunks[0].includes(': ping'), false)
  h.closeSse()
})

await check('GET /live/stream：{kind:"event",frame} → event 帧；{kind:"state"} → snapshot 帧', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const res = sseRes()
  await h(sseReq(), res)
  assert.equal(stub.listeners.size, 1, '连接后应订阅 live')
  const listener = [...stub.listeners][0]
  const firstMarker = frames(res)[0].snapshot.marker

  // 事件帧：一条 SSE data 行 + 两个换行，frame 原样
  const frame = { seq: 129, t: '2026-10-25T01:00:12.000Z', kind: 'tool', tool: 'bili_search', text: '→ bili_search' }
  listener({ kind: 'event', frame })
  const afterEvent = frames(res)
  assert.equal(afterEvent.length, 2)
  assert.deepEqual(afterEvent[1], { type: 'event', frame })
  assert.ok(res.chunks[1].endsWith('\n\n'), '每个 data 帧以两个换行结束')

  // 状态变化帧：应重新取 snapshot（比首帧更新），而不是复用旧快照
  listener({ kind: 'state' })
  const afterState = frames(res)
  assert.equal(afterState.length, 3)
  assert.equal(afterState[2].type, 'snapshot')
  assert.ok(afterState[2].snapshot.marker > firstMarker, `state 帧应重取 snapshot（${firstMarker} → ${afterState[2].snapshot.marker}）`)
  h.closeSse()
})

await check('GET /live/stream：closeSse() → res.end + 退订 + 之后不再推帧 + 幂等', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const res = sseRes()
  await h(sseReq(), res)
  const listener = [...stub.listeners][0]
  assert.equal(stub.calls.unsubs, 0)

  h.closeSse()
  assert.equal(res.ended, true, 'closeSse 后应 res.end')
  assert.equal(stub.calls.unsubs, 1, 'closeSse 后应退订 live listener')
  assert.equal(stub.listeners.size, 0)

  const chunksBefore = res.chunks.length
  listener({ kind: 'event', frame: { seq: 130, t: 'x', kind: 'text', text: 'close 之后' } })
  assert.equal(res.chunks.length, chunksBefore, 'close 之后不应再写 SSE 帧')

  h.closeSse() // 幂等：不应抛、不应重复退订
  assert.equal(stub.calls.unsubs, 1)
  assert.equal(res.ended, true)
})

await check('GET /live/stream：客户端断开 req.on("close") → 退订 + 释放连接名额', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const req = sseReq()
  const res = sseRes()
  await h(req, res)
  assert.equal(stub.listeners.size, 1)
  assert.equal(typeof req.handlers.get('close')?.[0], 'function', '应注册 req close 清理')

  req.emit('close')
  assert.equal(res.ended, true, '客户端断开后应 res.end')
  assert.equal(stub.calls.unsubs, 1)
  assert.equal(stub.listeners.size, 0)
  h.closeSse()
})

await check('GET /live/stream：连接数上限 4，第 5 个 → 503；断开后可重连', async () => {
  const stub = makeLiveStub()
  const h = createApiHandler(makeDeps({ live: stub.live }))
  const conns = []
  for (let i = 0; i < 4; i++) {
    const req = sseReq()
    const res = sseRes()
    await h(req, res)
    assert.equal(res.status, 200, `第 ${i + 1} 个连接应 200`)
    conns.push({ req, res })
  }
  assert.equal(stub.listeners.size, 4)

  const res5 = sseRes()
  await h(sseReq(), res5)
  assert.equal(res5.status, 503, '第 5 个连接应 503')
  assert.match(String(res5.headers['content-type']), /application\/json/)
  const body5 = JSON.parse(res5.body)
  assert.equal(body5.ok, false)
  assert.match(String(body5.error), /上限 4/)

  // 一个客户端断开 → 释放名额，新连接恢复 200
  conns[0].req.emit('close')
  assert.equal(conns[0].res.ended, true)
  const res6 = sseRes()
  await h(sseReq(), res6)
  assert.equal(res6.status, 200, '释放名额后新连接应 200')

  h.closeSse()
  for (const c of conns) assert.equal(c.res.ended, true)
  assert.equal(res6.ended, true)
  assert.equal(stub.listeners.size, 0)
})

await check('GET /live/stream：subscribe 抛错时仍保留首帧与心跳（不 500）', async () => {
  const h = createApiHandler(makeDeps({
    live: { snapshot: () => ({ ok: true, running: false, events: [], cursor: 0 }), subscribe: () => { throw new Error('订阅炸了') } },
  }))
  const res = sseRes()
  await h(sseReq(), res)
  assert.equal(res.status, 200)
  assert.equal(frames(res)[0].type, 'snapshot')
  h.closeSse()
})

/* ───────────────────────── 5. 旧端点不受影响 ───────────────────────── */

await check('旧端点 GET /overview → 200 且透传 deps.overview()', async () => {
  const h = createApiHandler(makeDeps())
  const r = await call(h, 'GET', '/api/bili-fenshen/overview')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.duty.autoDuty, false)
  assert.equal(r.json.round.running, false)
})

await check('旧端点 GET /log → 200 且分离宿主事件/原文', async () => {
  const d = makeDeps()
  writeFileSync(d.logFile, [
    '[2026-10-22T01:36:12.452Z] 注册工具失败（已兜住）',
    '模型推理原文一行',
    '[2026-10-22T01:40:54.039Z] host 已激活',
    '',
  ].join('\n'))
  const h = createApiHandler(d)
  const r = await call(h, 'GET', '/api/bili-fenshen/log?tail=50')
  assert.equal(r.status, 200)
  assert.equal(r.json.events.length, 2)
  assert.match(r.json.raw, /模型推理原文/)
})

await check('旧端点 GET/POST /config → 200（含模型三字段写回）', async () => {
  const h = createApiHandler(makeDeps())
  const g = await call(h, 'GET', '/api/bili-fenshen/config')
  assert.equal(g.status, 200)
  assert.equal(g.json.ok, true)
  assert.equal(g.json.values.perDay, 5)
  assert.equal(g.json.sources.perDay, 'patch')
  for (const k of ['modelProvider', 'modelName', 'modelReasoningEffort']) {
    assert.equal(g.json.values[k], '', `默认 ${k} 应为空`)
  }
  const p = await call(h, 'POST', '/api/bili-fenshen/config', {
    modelProvider: 'deepseek-account', modelName: 'deepseek-flash', modelReasoningEffort: 'high',
  })
  assert.equal(p.status, 200)
  assert.equal(p.json.values.modelProvider, 'deepseek-account')
  assert.equal(p.json.values.modelName, 'deepseek-flash')
  assert.equal(p.json.values.modelReasoningEffort, 'high')
  // 清空还原
  const q = await call(h, 'POST', '/api/bili-fenshen/config', { modelProvider: '', modelName: '', modelReasoningEffort: '' })
  assert.equal(q.status, 200)
  assert.equal(q.json.values.modelName, '')
})

await check('旧端点 POST /run、/duty 保持可用；非法 duty 仍 400', async () => {
  const h = createApiHandler(makeDeps())
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/run')).json.started, true)
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/duty', { autoDuty: true })).json.autoDuty, true)
  assert.equal((await call(h, 'POST', '/api/bili-fenshen/duty', { autoDuty: 'yes' })).status, 400)
})

await check('未知路径/非前缀路径仍 404（不被新端点吃掉）', async () => {
  const h = createApiHandler(makeDeps())
  const a = await call(h, 'GET', '/api/bili-fenshen/nope')
  assert.equal(a.status, 404)
  assert.equal(a.json?.ok, false)
  const b = await call(h, 'GET', '/api/other/thing')
  assert.equal(b.status, 404)
  // 方法不匹配：POST /models 不是契约端点 → 404（而不是误当 200/503）
  const c = await call(h, 'POST', '/api/bili-fenshen/models')
  assert.equal(c.status, 404)
})

/* ───────────────────────── 汇总 ───────────────────────── */

for (const home of homes) {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
}

const total = passed + failed
console.log('')
console.log(`结果：PASS ${passed}/${total}${failed ? `，FAIL ${failed}` : ''}`)
if (failed) {
  console.log('失败项：')
  for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name}`)
  process.exit(1)
}
console.log('VERIFY NEW API: ALL GREEN')
process.exit(0)
