/**
 * 故障注入（W3 验收要求 7 例）。
 *
 * 为什么需要：这个号是**无人值守**跑一整天的。正常路径测试再多，也不如"把文件弄坏再看它怎么办"
 * 这一句话有用 —— 真实事故全是这么来的（半截 JSON / 卡被改坏 / 规则文件丢了 / 进程秒退）。
 *
 * 纪律：**任何一处坏掉都不能让值班轮空跑或抛死**，而是
 *   ① 有明确降级（跳过坏数据、用缺省值、中性说话）；
 *   ② 有可读的错误留痕（写进 state/日志，主人能看见）。
 *
 * 本文件覆盖纯 lib 层的 5 例；涉及子进程/overlay/报告的 3 例在 W3 落地后追加（见文件末尾 TODO）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-fault-'))
process.env.BILI_FENSHEN_HOME = HOME   // store.js 的 homeDir() 是调用时读 env，所以这里设置有效
// W3-6 硬超时是 20 分钟，测试等不起：在 import index.js **之前**用环境变量压到 1.2 秒。
process.env.BILI_FENSHEN_ROUND_TIMEOUT_MS = '1200'

const { readEvents } = await import('../lib/ledger.js')
const { createLedgerReader } = await import('../lib/ledger-index.js')
const { loadCard, readActive } = await import('../lib/persona/store.js')
const { loadState, deriveState, saveState } = await import('../lib/persona/state.js')
const { parseRoundReport } = await import('../lib/report.js')

const P = (...xs) => join(HOME, ...xs)

/* ───────── ① 账本半截行：不能整批销掉 ───────── */

test('故障注入①：账本最后一行是半截 JSON ⇒ 丢弃半截、救回前面全部', () => {
  const f = P('ledger-half.jsonl')
  const good = [
    { t: '2026-10-28T00:00:00.000Z', round: 'r1', type: 'view', bvid: 'BV1' },
    { t: '2026-10-28T00:00:01.000Z', round: 'r1', type: 'comment', bvid: 'BV1', text: '难绷' },
  ]
  writeFileSync(f, good.map((e) => JSON.stringify(e)).join('\n') + '\n' + '{"t":"2026-10-28T00:00:02.000Z","type":"li', 'utf8')
  const events = readEvents(f)
  assert.equal(events.length, 2, '前面两条完整事件必须救回来')
  assert.ok(events.every((e) => typeof e.type === 'string'))
  // 增量读器口径必须一致（否则概览与轮末盘点会给出两个数）
  assert.deepEqual(createLedgerReader(f).read(), events)
})

test('故障注入①b：整行坏 JSON ⇒ 该行跳过，不抛', () => {
  const f = P('ledger-bad.jsonl')
  writeFileSync(f, [
    JSON.stringify({ t: '2026-10-28T00:00:00.000Z', type: 'view', bvid: 'BV1' }),
    'not json at all',
    JSON.stringify({ t: '2026-10-28T00:00:02.000Z', type: 'like', bvid: 'BV1' }),
  ].join('\n'), 'utf8')
  const events = readEvents(f)
  assert.equal(events.length, 2)
})

/* ───────── ② 卡 JSON 损坏 ⇒ 中性降级，不许把路径字符串当人设 ───────── */

test('故障注入②：人设卡 JSON 损坏 ⇒ loadCard 返回 error，不抛', () => {
  mkdirSync(P('persona'), { recursive: true })
  const broken = P('persona', 'card-broken.json')
  writeFileSync(broken, '{ "id": "whale", "version": "2.0.0", ', 'utf8') // 故意写一半
  const r = loadCard({ mode: 'file', path: broken })
  assert.equal(r.card, null)
  assert.equal(r.source, 'missing')
  assert.match(String(r.error), /读不到|不是合法 JSON/)
})

test('故障注入②b：卡文件被删 ⇒ source=missing，active 仍可读（降级不连锁）', () => {
  const gone = P('persona', 'card-gone.json')
  const r = loadCard({ mode: 'file', path: gone })
  assert.equal(r.card, null)
  assert.equal(r.source, 'missing')
  // active.json 缺失时 readActive 必须回落到默认预设，而不是返回 null
  const act = readActive()
  assert.equal(act.mode, 'preset')
  assert.ok(String(act.presetId).length > 0)
})

/* ───────── ③ state.json 半截 ⇒ 冷却表归零而不是崩 ───────── */

test('故障注入③：state.json 半截 ⇒ loadState 返回 {}（本期冷却表作废，但值班照跑）', () => {
  mkdirSync(P('persona'), { recursive: true })
  writeFileSync(P('persona', 'state.json'), '{"loreUsed": {"a": "2026-10-2', 'utf8')
  const st = loadState()
  assert.deepEqual(st, {})

  // deriveState 对空持久化必须照常工作
  const derived = deriveState({ events: [], persisted: st, now: new Date(2026, 9, 28, 12, 0) })
  assert.ok(derived.date)
  assert.deepEqual(derived.loreUsed, {})
  // 而且能重新写回一份好的
  assert.equal(saveState({ loreUsed: {} }), true)
  assert.deepEqual(loadState(), { loreUsed: {} })
})

/* ───────── ④ 报告缺失/坏文本 ⇒ 解析器不许抛 ───────── */

test('故障注入④：报告文件缺失 ⇒ parseRoundReport(空) 不抛、给空结构', () => {
  const r = parseRoundReport('')
  assert.equal(typeof r, 'object')
  assert.ok(r && typeof r === 'object')
})

test('故障注入④b：报告是半截/乱码文本 ⇒ 解析器不抛', () => {
  for (const text of ['### 本轮做了什么\n- 评论：', '\u0000\u0001 二进制坏字节 \uFFFD', 'a'.repeat(10_000)]) {
    assert.doesNotThrow(() => parseRoundReport(text))
  }
})

/* ───────── ⑤ 账本被清空（轮转）⇒ 增量读必须回退全量，不能返回旧缓存 ───────── */

test('故障注入⑤：账本被轮转清空 ⇒ 读到的就是空，不能返回上一份缓存', () => {
  const f = P('ledger-rot.jsonl')
  writeFileSync(f, JSON.stringify({ t: '2026-10-28T00:00:00.000Z', type: 'view', bvid: 'BV1' }) + '\n', 'utf8')
  const reader = createLedgerReader(f)
  assert.equal(reader.read().length, 1)
  writeFileSync(f, '', 'utf8')
  assert.deepEqual(reader.read(), [])
  assert.ok(reader.stats().fallbacks >= 1, '清空属于"变小"，要记一次 fallbacks')
  assert.equal(readFileSync(f, 'utf8'), '')
})

/* ───────── ⑥ overlay 写失败 ⇒ 本轮中止并写 lastError（W3-1） ───────── */

/**
 * 起一个真实的插件实例（fake webServer/tools），返回 POST /run 的 HTTP 入口 + dispose。
 * 为什么要走 HTTP 而不是直调 runDuty：runDuty 不是导出（保持模块边界），
 * 而 /run 是控制台「跑一轮」按钮与工具共用的真实入口 —— 测它等于测线上路径。
 */
async function bootPlugin(patchConfig) {
  const { apply } = await import('../index.js')
  let runHandler = null
  const fakeWeb = {
    register: (def) => {
      if (def?.kind === 'exact' && def.path === '/api/bili-fenshen/run') runHandler = def.handler
      return () => {}
    },
  }
  const fakeTools = { register: () => () => {} }
  const ctx = { get: (k) => (k === 'webServer' ? fakeWeb : k === 'tools' ? fakeTools : null) }
  const dispose = apply(ctx, patchConfig)
  const postRun = async () => {
    const res = {
      status: 0, body: '', writableEnded: false,
      writeHead(s) { this.status = s; this.writableEnded = false },
      end(b) { this.writableEnded = true; this.body = String(b || '') },
    }
    const req = { method: 'POST', url: '/api/bili-fenshen/run', [Symbol.asyncIterator]: async function* () {} }
    await runHandler(req, res)
    return res.body ? JSON.parse(res.body) : null
  }
  return { dispose, postRun }
}

test('故障注入⑥（W3-1）：overlay 写失败 ⇒ 本轮不 spawn、lastError 有痕、返回 started:false', async () => {
  // 把 overlay 路径占成一个**目录** ⇒ buildOverlay 的 writeFileSync 必失败
  const overlayPath = P('headless-overlay.yml')
  try { rmSync(overlayPath, { recursive: true, force: true }) } catch { /* 不存在 */ }
  mkdirSync(overlayPath, { recursive: true })
  const fakeBin = P('fake-dsh-bin.js')
  writeFileSync(fakeBin, 'setInterval(() => {}, 1000)\n', 'utf8')

  const { dispose, postRun } = await bootPlugin({ autoDuty: false, dshBin: fakeBin, perDay: 5 })
  try {
    const out = await postRun()
    assert.equal(out?.started, false, 'overlay 写失败必须返回 started:false（不许用残缺 overlay 起轮）')
    assert.match(String(out?.error), /overlay/, '错误里要能看出是 overlay')
    const st = JSON.parse(readFileSync(P('state.json'), 'utf8'))
    assert.match(String(st.lastError), /overlay/, 'state.lastError 要留下可读原因')
    assert.equal(st.lastCode, 'overlay-failed')
    // W3-4b：state 写盘是 tmp+rename ⇒ 正常路径不该留下 .tmp 残骸
    assert.equal(existsSync(P('state.json.tmp')), false, '原子写不允许留下 .tmp')
    assert.match(readFileSync(P('duty.log'), 'utf8'), /overlay 写失败/, 'duty.log 要留一行')
  } finally {
    dispose()
    try { rmSync(overlayPath, { recursive: true, force: true }) } catch { /* 兜住 */ }
  }
})

/* ───────── ⑦ spawn 后挂死 ⇒ 20 分钟硬超时 + 进程树 kill（W3-6） ───────── */

test('故障注入⑦（W3-6）：spawn 后挂死 ⇒ 硬超时强杀、round-end code=timeout、lastError 有痕', async () => {
  try { rmSync(P('headless-overlay.yml'), { recursive: true, force: true }) } catch { /* 上个用例的残骸 */ }
  const fakeBin = P('fake-dsh-hang.js')
  // 挂死的假 dsh：一直不退出（真 dsh 挂死时也长这样：父进程在、子进程 python 也还在）
  writeFileSync(fakeBin, 'setInterval(() => {}, 1000)\n', 'utf8')

  const { dispose, postRun } = await bootPlugin({ autoDuty: false, dshBin: fakeBin, perDay: 5 })
  try {
    const out = await postRun()
    assert.equal(out?.started, true, '这一轮应该真的起来了（overlay 正常）')
    // 等硬超时（测试把 env 压到 1.2s）+ 收尾写盘
    const deadline = Date.now() + 10_000
    let st = {}
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      try { st = JSON.parse(readFileSync(P('state.json'), 'utf8')) } catch { st = {} }
      if (st.lastCode === 'timeout') break
    }
    assert.equal(st.lastCode, 'timeout', '超时被杀的一轮必须记 code=timeout（不是 1/null）')
    assert.match(String(st.lastError), /超时/, 'state.lastError 要写明硬超时')
    const ledger = readEvents(P('ledger.jsonl'))
    assert.ok(
      ledger.some((e) => e.type === 'round-end' && e.code === 'timeout'),
      '账本里要有一条 round-end code=timeout（概览/复盘可查）',
    )
    assert.match(readFileSync(P('duty.log'), 'utf8'), /硬超时/, 'duty.log 要留一行')
  } finally {
    dispose()
  }
})

/* ───────── ⑧ spawn 立即退出：不许空跑无声（W3-6 / 同时验 W2-1、W7-2 的落账） ─────────
 * 方案里第 7 例就是「spawn 立即退出」：模型进程一起就 404/崩溃时，宿主最容易"什么都没发生"地过一轮。
 * 这里同时钉住两件归因：卡链路成功 ⇒ `persona-inject` 必落；轮级门控 ⇒ `speak-decision` 必落
 * （observe 档也要记，否则"观察三天"根本观察不到东西）。
 */

test('故障注入⑧（W2-1/W7-2）：spawn 立即退出 ⇒ round-end 如实记退出码，归因与门控事件仍落账本', async () => {
  try { rmSync(P('headless-overlay.yml'), { recursive: true, force: true }) } catch { /* 上个用例的残骸 */ }
  const { smokeCard } = await import('./fixtures/persona/smoke-card.js')
  mkdirSync(P('persona'), { recursive: true })
  writeFileSync(P('persona', 'card.json'), JSON.stringify(smokeCard(), null, 2), 'utf8')
  writeFileSync(P('persona', 'active.json'), JSON.stringify({ mode: 'file', path: P('persona', 'card.json') }), 'utf8')
  const fakeBin = P('fake-dsh-exit.js')
  writeFileSync(fakeBin, 'process.exit(3)\n', 'utf8')

  const { dispose, postRun } = await bootPlugin({
    autoDuty: false, dshBin: fakeBin, perDay: 5, commentsPerRound: 2, speakGateMode: 'observe',
  })
  try {
    const out = await postRun()
    assert.equal(out?.started, true, '假 dsh 存在 ⇒ 这一轮应该真的起来')

    const deadline = Date.now() + 15_000
    let ledger = []
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      ledger = readEvents(P('ledger.jsonl'))
      // 这个 HOME 里前一个用例（⑦ 挂死超时）也落过 round-end，所以要**按本轮 roundId** 取
      if (ledger.some((e) => e.type === 'round-end' && e.round === out.roundId)) break
    }

    const end = ledger.find((e) => e.type === 'round-end' && e.round === out.roundId)
    assert.ok(end, 'spawn 立即退出也要落 round-end（不許空跑无声）')
    assert.equal(end.code, 3, '退出码要如实记录（不许记成 0/null）')

    const inject = ledger.find((e) => e.type === 'persona-inject' && e.round === out.roundId)
    assert.ok(inject, '卡链路走到 spawn ⇒ persona-inject 必须落账本')
    assert.equal(inject.personaTag, 'smoke@2.0.0')

    const gate = ledger.find((e) => e.type === 'speak-decision' && e.scope === 'round' && e.round === out.roundId)
    assert.ok(gate, '轮级门控事件必须落账本（observe 档也要记）')
    assert.equal(gate.mode, 'observe')
    assert.ok(['normal', 'throttle', 'forced'].includes(gate.decision), gate.decision)
    assert.equal(typeof gate.features?.recentShare, 'number', 'features 要可解释')

    // 概览要能读到（控制台展示的就是这一份）
    const { buildOverview } = await import('../lib/overview.js')
    const ov = buildOverview({ cfg: {}, state: {}, events: ledger })
    assert.ok(ov.round.speakGate, '概览 round.speakGate 要能读到门控')
    assert.equal(ov.round.speakGate.mode, 'observe')
    assert.ok(ov.round.personaInject, '概览 round.personaInject 要能读到归因')
  } finally {
    dispose()
  }
})

/* TODO（剩余验收）：规则文件缺失 ⇒ 放行 + 告警（W2-2 lint.js 的 Python 侧，见 mcp_server.py 测试）。 */
