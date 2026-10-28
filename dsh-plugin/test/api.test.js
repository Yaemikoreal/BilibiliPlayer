// dsh-plugin/test/api.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiHandler } from '../lib/api.js'
import { createOverviewHub } from '../lib/realtime.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-api-'))
// 真实 seen.md 的逐字副本（2026-10-25 快照：59 行文件 = 标题 + 空行 + 57 条账本行）
const realSeen = () => readFileSync(fileURLToPath(new URL('./fixtures/seen-real-sample.md', import.meta.url)), 'utf8')

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

/* ⭐ W0-1 便宜断言①：保存配置必须失效 CLI 探测缓存。
 * 否则 dshBin/模型改完最长要等 10 分钟才生效（CONSOLE-ISSUES P1-4）。
 * 这条以前只有代码没有断言，回归时谁删掉 resetCliCaches 都没人发现。 */
test('POST /config 成功后调用 resetCliCaches（缓存失效）', async () => {
  let reset = 0
  let published = 0
  const d = deps({
    resetCliCaches: () => { reset++ },
    overviewHub: { publish: () => { published++ } },
  })
  const h = createApiHandler(d)
  const ok = await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 7 })
  assert.equal(ok.status, 200)
  assert.equal(reset, 1, '保存配置后必须掉一次 CLI 缓存')
  assert.equal(published, 1, '保存配置后立刻推一帧概览')
  // 非法请求不该顺手清缓存（清了也无害，但断言住"只在该清时清"）
  await call(h, 'POST', '/api/bili-fenshen/config', { perDay: 'five' })
  assert.equal(reset, 1)
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

test('GET /seen 解析真实 seen.md：57 行全部解析（markdown 列表前缀不再吃掉整行）', async () => {
  const d = deps()
  const seenFile = join(d.home, 'seen.md')
  writeFileSync(seenFile, realSeen())
  const r = await call(createApiHandler({ ...d, seenFile }), 'GET', '/api/bili-fenshen/seen')
  assert.equal(r.status, 200)
  assert.equal(r.json.rows.length, 57)
  assert.equal(r.json.rows.filter((x) => x.bvid).length, 39)
  assert.equal(r.json.rows.filter((x) => !x.bvid).length, 18)
  // 标题行 / 空行不是账本行，不能算进去
  assert.ok(r.json.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)))
  assert.ok(r.json.rows.every((x) => x.time === '' || /^\d{1,2}:\d{2}$/.test(x.time)))
  // raw 原样回传，前端解析失败时能看原文
  assert.equal(r.json.raw, realSeen())
})

test('GET /seen 真实行字段：日期 / 可选时间 / BV / 动作 / 标题', async () => {
  const d = deps()
  const seenFile = join(d.home, 'seen.md')
  writeFileSync(seenFile, realSeen())
  const r = await call(createApiHandler({ ...d, seenFile }), 'GET', '/api/bili-fenshen/seen')
  // 首行是「值班开始」备注行：没有 BV，日期格没有时间，备注在 action、说明在 title
  assert.deepEqual(r.json.rows[0], {
    date: '2026-10-22', time: '', bvid: '', action: '值班开始', title: '初始化判重表（此前无记录）',
  })
  // 第二行是真实视频行：『- 日期 · BV 号 · 动作 · 标题』
  assert.deepEqual(r.json.rows[1], {
    date: '2026-10-22',
    time: '',
    bvid: 'BV1xrnz6gEVD',
    action: '跳过·未登录读不到详情/字幕/评论',
    title: '折1万次，会坏吗？iPhone Duo深度评测',
  })
  // 第二个字段是 HH:MM 时才算时间；不存在「时间拼进动作」的行
  const timed = r.json.rows.filter((x) => x.time)
  assert.equal(timed.length, 9)
  // 时间被抽走，不再以 HH:MM 开头留在动作里（动作正文里出现时间戳是正常的）
  assert.ok(timed.every((x) => !/^\d{1,2}:\d{2}/.test(x.action)))
})

test('GET /seen 备注行（无 BV）保留为 bvid 空 + action 原文，占位符 - / — 不落字段', async () => {
  const d = deps()
  const seenFile = join(d.home, 'seen.md')
  writeFileSync(seenFile, realSeen())
  const r = await call(createApiHandler({ ...d, seenFile }), 'GET', '/api/bili-fenshen/seen')
  const notes = r.json.rows.filter((x) => !x.bvid)
  assert.equal(notes.length, 18)
  // 「第 N 轮值班开始（…）」：带时间的备注行，时间进 time，备注原样留在 action
  assert.deepEqual(r.json.rows.find((x) => x.time === '21:58'), {
    date: '2026-10-22', time: '21:58', bvid: '', action: '第二轮值班开始（已登录，凭证有效）', title: '',
  })
  // 动作文本内部「跳过·无字幕」用的是不带空格的 ·，不能被当分隔符切开
  assert.deepEqual(notes.find((x) => x.action.startsWith('跳过·旧回复')), {
    date: '2026-10-22',
    time: '',
    bvid: '',
    action: '跳过·旧回复·无对应本轮话题（goldenzihang / 谨unknown_sama 等 2～4 月旧帖）',
    title: '',
  })
  // 「本轮 0 动作…」这类配额说明同样保留为备注行
  assert.ok(notes.some((x) => x.action.startsWith('本轮 0 新挑中')))
  // 所有备注行都有内容，且不残留 list 分隔用的 - / — 占位符
  assert.ok(notes.every((x) => x.action && x.action !== '-' && x.action !== '—'))
  assert.ok(notes.every((x) => x.title !== '-' && x.title !== '—'))
})

/* ───────── SSE 概览流：首帧必须能被客户端接受（2026-10-28 空数据态事故的回归） ───────── */

function sseRes() {
  const chunks = []
  return {
    chunks,
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true },
    flushHeaders() {},
    write(c) { chunks.push(String(c)); return true },
    end() { this.writableEnded = true },
    on() {},
  }
}

test('GET /stream：hub 已有数据时，hello 不得带 seq 把客户端单调起点抬到首帧之上', async () => {
  const hub = createOverviewHub({ compute: () => ({ duty: { autoDuty: false }, health: { cli: '/x/bin.js' } }) })
  hub.view()                                    // ← 先算一次：data 已就绪且不脏
  const h = createApiHandler(deps({ overviewHub: hub }))
  const res = sseRes()
  const req = { method: 'GET', url: '/api/bili-fenshen/stream', headers: {}, on() {} }
  try {
    await h(req, res)
    const frames = res.chunks
      .join('').split('\n\n').filter(Boolean)
      .map((raw) => { const line = raw.split('\n').find((l) => l.startsWith('data: ')); return line ? JSON.parse(line.slice(6)) : null })
      .filter(Boolean)
    const hello = frames.find((f) => f.type === 'hello')
    const first = frames.find((f) => f.type === 'overview')
    assert.ok(hello, '必须发 hello 帧')
    assert.ok(first, '必须立刻推首帧 overview（不能等下一次 publish）')
    const helloSeq = Number(hello.seq)
    const firstSeq = Number(first.data?.seq)
    // 客户端 accept(): 已有数据才严格单调。若 hello 带了 seq ≤ 首帧 seq，
    // 首帧就会被丢 —— 这正是「空闲页面永远空数据」的成因。
    assert.ok(
      !Number.isFinite(helloSeq) || firstSeq > helloSeq,
      `hello.seq=${helloSeq} 首帧 seq=${firstSeq}：相等/更大会让客户端丢弃首帧`,
    )
  } finally {
    h.closeSse()                                 // 关掉订阅与心跳，别吊住测试进程
  }
})

