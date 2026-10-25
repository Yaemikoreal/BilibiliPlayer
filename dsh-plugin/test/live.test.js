// dsh-plugin/test/live.test.js —— 实时运行视图纯逻辑（契约 §1.4）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLiveStream, classifyLine, phaseOfTool } from '../lib/live.js'

const seqs = (live, after = 0) => live.snapshot(after).events.map((e) => e.seq)
const texts = (live, after = 0) => live.snapshot(after).events.map((e) => e.text)

/* ───────────────────────── classifyLine ───────────────────────── */

test('classifyLine：宿主日志行（[ISO] 前缀）→ host，且优先于错误词', () => {
  assert.deepEqual(classifyLine('[2026-10-25T01:00:12.000Z] 开跑'), {
    kind: 'host', text: '[2026-10-25T01:00:12.000Z] 开跑',
  })
  // host 规则先于 error：宿主日志里带「失败」也仍是 host
  assert.equal(classifyLine('[2026-10-25T01:00:12.000Z] 这一轮失败').kind, 'host')
})

test('classifyLine：reasoning 两种写法（带 dsh: 前缀 / 裸 reasoning:）', () => {
  assert.equal(classifyLine('dsh: reasoning: 先看看热门').kind, 'reasoning')
  assert.equal(classifyLine('reasoning: 想想怎么回').kind, 'reasoning')
  // 非行首不算 reasoning
  assert.equal(classifyLine('看看 reasoning: 是什么意思').kind, 'text')
})

test('classifyLine：含 bili_* → tool，tool 取第一个匹配（兼容 MCP 前缀）', () => {
  const a = classifyLine('→ 调用 bili_search 搜索 AI')
  assert.equal(a.kind, 'tool')
  assert.equal(a.tool, 'bili_search')
  const b = classifyLine('mcp__bili-fenshen__bili_like(BV1xx) 执行中')
  assert.equal(b.kind, 'tool')
  assert.equal(b.tool, 'bili_like')
  // tool 规则先于 error：工具行里带「失败」也仍是 tool
  assert.equal(classifyLine('bili_reply 失败').kind, 'tool')
})

test('classifyLine：错误词 → error；空行 → blank；其余 → text', () => {
  for (const s of ['这一步失败了', '出现错误', '抛异常了', 'Error: boom', 'error: xx']) {
    assert.equal(classifyLine(s).kind, 'error', s)
  }
  assert.equal(classifyLine('').kind, 'blank')
  assert.equal(classifyLine('   ').kind, 'blank')
  assert.equal(classifyLine('普通输出一行').kind, 'text')
  // CRLF 残留不会破坏分类
  assert.equal(classifyLine('普通输出\r').text, '普通输出')
})

test('classifyLine：任何脏输入都不抛异常', () => {
  assert.doesNotThrow(() => classifyLine(undefined))
  assert.equal(classifyLine(undefined).kind, 'blank')
  assert.equal(classifyLine(null).kind, 'blank')
  assert.equal(classifyLine(123).kind, 'text')
  assert.equal(classifyLine(123).text, '123')
  assert.equal(classifyLine({}).kind, 'text')
})

/* ───────────────────────── phaseOfTool ───────────────────────── */

test('phaseOfTool：找内容 / 看内容 / 发言 / 思考 四组映射', () => {
  const find = { key: 'find', label: '找内容' }
  const watch = { key: 'watch', label: '看内容' }
  const act = { key: 'act', label: '发言' }
  const think = { key: 'think', label: '思考' }
  for (const t of ['bili_search', 'bili_hot_videos', 'bili_weekly_hot', 'bili_rank', 'bili_user_videos', 'bili_video_info']) {
    assert.deepEqual(phaseOfTool(t), find, t)
  }
  for (const t of ['bili_subtitle', 'bili_comments']) assert.deepEqual(phaseOfTool(t), watch, t)
  for (const t of ['bili_like', 'bili_reply', 'bili_send_dynamic', 'bili_received_replies']) {
    assert.deepEqual(phaseOfTool(t), act, t)
  }
  for (const t of ['bili_login', 'bili_favorite_lists', 'foo', '', undefined, null]) {
    assert.deepEqual(phaseOfTool(t), think, String(t))
  }
  // 带 MCP 前缀也认得
  assert.deepEqual(phaseOfTool('mcp__bili-fenshen__bili_reply'), act)
})

/* ───────────────────────── 行缓冲 / 事件流 ───────────────────────── */

test('pushChildChunk：跨 chunk 半行重组，最后残行留到 end 再 flush', () => {
  const live = createLiveStream()
  assert.equal(live.pushChildChunk('part'), 0)
  assert.equal(live.snapshot().events.length, 0)
  assert.equal(live.pushChildChunk('ial\n'), 1)
  assert.deepEqual(texts(live), ['partial'])
  assert.equal(live.snapshot().events[0].kind, 'text')
})

test('pushChildChunk：一次多行 + 行尾残行 + 空行不产生事件', () => {
  const live = createLiveStream()
  const n = live.pushChildChunk('第一行\n\n第二行\n  \n残行')
  assert.equal(n, 2)
  assert.deepEqual(texts(live), ['第一行', '第二行'])
  live.end({ code: 0, durationMs: 1 })
  assert.deepEqual(texts(live), ['第一行', '第二行', '残行'])
})

test('pushChildChunk：CRLF 去掉 \\r；Buffer 与 UTF-8 跨字节分片都能正确解码', () => {
  const live = createLiveStream()
  live.pushChildChunk('x\r\ny\r\n')
  assert.deepEqual(texts(live), ['x', 'y'])

  const buf = Buffer.from('中文\n', 'utf8')
  live.pushChildChunk(buf.subarray(0, 2)) // 「中」的前两个字节
  live.pushChildChunk(buf.subarray(2))
  assert.deepEqual(texts(live), ['x', 'y', '中文'])
})

test('pushChildChunk：分类直接生效（tool / error / host），并同步 stats', () => {
  const live = createLiveStream()
  live.start({ roundId: 'r', startedAt: new Date().toISOString(), why: 'test' })
  live.pushChildChunk('→ bili_subtitle\n')
  live.pushChildChunk('连接失败\n')
  live.pushChildChunk('[2026-10-25T01:00:12.000Z] hello\n')
  const snap = live.snapshot()
  assert.deepEqual(snap.events.map((e) => e.kind), ['tool', 'error', 'host'])
  assert.equal(snap.events[0].tool, 'bili_subtitle')
  assert.equal(snap.stats.errors, 1)
  assert.deepEqual(snap.stats.tools, { bili_subtitle: 1 })
  assert.deepEqual(snap.phase, { key: 'watch', label: '看内容' })
})

test('超长文本按 maxTextLen 截断（宿主事件与子进程行都截）', () => {
  const live = createLiveStream({ maxTextLen: 8 })
  live.pushHost('x'.repeat(100))
  live.pushChildChunk('y'.repeat(100) + '\n')
  const [a, b] = live.snapshot().events
  assert.equal(a.text, 'xxxxxxxx')
  assert.equal(b.text, 'yyyyyyyy')
})

test('环形缓冲裁剪到 maxEvents，stats.events 只数缓冲内事件', () => {
  const live = createLiveStream({ maxEvents: 3 })
  for (let i = 1; i <= 5; i++) live.push({ kind: 'text', text: `e${i}` })
  const snap = live.snapshot()
  assert.deepEqual(snap.events.map((e) => e.seq), [3, 4, 5])
  assert.deepEqual(snap.events.map((e) => e.text), ['e3', 'e4', 'e5'])
  assert.equal(snap.stats.events, 3)
  assert.equal(snap.cursor, 5)
})

/* ───────────────────────── snapshot(after) / cursor ───────────────────────── */

test('snapshot(after)：只回 seq > after；after 超前时 events 空但 cursor 不回 0；脏 after 按 0 处理', () => {
  const live = createLiveStream()
  for (let i = 1; i <= 6; i++) live.push({ kind: 'text', text: `e${i}` })
  assert.deepEqual(seqs(live, 4), [5, 6])
  assert.equal(live.snapshot(4).cursor, 6)

  const ahead = live.snapshot(100)
  assert.deepEqual(ahead.events, [])
  assert.equal(ahead.cursor, 6) // 缓冲里最新 seq，不能回 0

  assert.deepEqual(seqs(live, 'bad'), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(seqs(live, -3), [1, 2, 3, 4, 5, 6])
  assert.deepEqual(seqs(live, 2.7), [3, 4, 5, 6]) // 取整
})

test('snapshot：空缓冲 cursor=0；单次最多回 200 条（老的先丢）', () => {
  const live = createLiveStream()
  const empty = live.snapshot()
  assert.equal(empty.cursor, 0)
  assert.deepEqual(empty.events, [])

  for (let i = 1; i <= 250; i++) live.push({ kind: 'text', text: `t${i}` })
  const snap = live.snapshot(0)
  assert.equal(snap.events.length, 200)
  assert.equal(snap.events[0].seq, 51)
  assert.equal(snap.events.at(-1).seq, 250)
  assert.equal(snap.cursor, 250)
})

test('snapshot 返回的是副本，外部改动不会污染缓冲', () => {
  const live = createLiveStream()
  live.push({ kind: 'text', text: '原始' })
  const s1 = live.snapshot()
  s1.events[0].text = '被改'
  s1.stats.actions.like = 99
  assert.equal(live.snapshot().events[0].text, '原始')
  assert.equal(live.snapshot().stats.actions.like, 0)
})

/* ───────────────────────── stats / phase ───────────────────────── */

test('stats.actions 严格映射：like/comment/dynamic/reply；errors 计 error 事件', () => {
  const live = createLiveStream()
  live.start({ roundId: 'r1' })
  live.push({ kind: 'tool', tool: 'bili_like' })
  live.push({ kind: 'tool', tool: 'bili_like' })
  live.push({ kind: 'tool', tool: 'bili_reply' })
  live.push({ kind: 'tool', tool: 'bili_send_dynamic' })
  live.push({ kind: 'tool', tool: 'bili_received_replies' })
  live.push({ kind: 'error', text: 'boom' })
  live.push({ kind: 'text', text: '普通' })
  const st = live.snapshot().stats
  assert.deepEqual(st.actions, { like: 2, comment: 1, dynamic: 1, reply: 1 })
  assert.deepEqual(st.tools, {
    bili_like: 2, bili_reply: 1, bili_send_dynamic: 1, bili_received_replies: 1,
  })
  assert.equal(st.errors, 1)
  assert.equal(st.events, 7)
})

test('phase 取最近一个 tool 事件；后续 text 不改阶段；无 tool = think', () => {
  const live = createLiveStream()
  assert.deepEqual(live.snapshot().phase, { key: 'think', label: '思考' })
  live.push({ kind: 'tool', tool: 'bili_search' })
  assert.deepEqual(live.snapshot().phase, { key: 'find', label: '找内容' })
  live.push({ kind: 'text', text: '继续思考' })
  assert.deepEqual(live.snapshot().phase, { key: 'find', label: '找内容' })
  live.push({ kind: 'tool', tool: 'bili_subtitle' })
  assert.deepEqual(live.snapshot().phase, { key: 'watch', label: '看内容' })
  live.push({ kind: 'tool', tool: 'bili_like' })
  assert.deepEqual(live.snapshot().phase, { key: 'act', label: '发言' })
  live.push({ kind: 'tool', tool: 'bili_login' }) // 未知工具 → 思考
  assert.deepEqual(live.snapshot().phase, { key: 'think', label: '思考' })
})

test('phase 不受 ring 裁剪影响：工具事件被挤出缓冲后阶段仍是最近工具', () => {
  const live = createLiveStream({ maxEvents: 2 })
  live.push({ kind: 'tool', tool: 'bili_like' })
  live.push({ kind: 'text', text: 'a' })
  live.push({ kind: 'text', text: 'b' })
  const snap = live.snapshot()
  assert.equal(snap.events.length, 2)
  assert.deepEqual(snap.phase, { key: 'act', label: '发言' })
})

test('push({kind:"tool"}) 没给 tool 时从文本里抠工具名；无工具名的 tool 事件不计 stats.tools', () => {
  const live = createLiveStream()
  live.push({ kind: 'tool', text: '调用 bili_hot_videos' })
  live.push({ kind: 'tool', text: '没有工具名' })
  const snap = live.snapshot()
  assert.equal(snap.events[0].tool, 'bili_hot_videos')
  assert.deepEqual(snap.stats.tools, { bili_hot_videos: 1 })
  assert.deepEqual(snap.phase, { key: 'find', label: '找内容' })
})

/* ───────────────────────── start / end / reset ───────────────────────── */

test('start 清空事件与统计，但 seq 不复位（客户端 after 过滤不错乱）', () => {
  const live = createLiveStream()
  live.push({ kind: 'text', text: 'a' })
  live.push({ kind: 'tool', tool: 'bili_like' })
  live.start({ roundId: 'r2', startedAt: new Date().toISOString(), why: 'web' })
  const snap = live.snapshot()
  assert.equal(snap.events.length, 0)
  assert.equal(snap.stats.events, 0)
  assert.deepEqual(snap.stats.tools, {})
  assert.deepEqual(snap.stats.actions, { like: 0, comment: 0, dynamic: 0, reply: 0 })
  assert.equal(snap.running, true)
  assert.equal(snap.roundId, 'r2')
  assert.equal(snap.why, 'web')
  live.push({ kind: 'text', text: 'b' })
  assert.equal(live.snapshot().events[0].seq, 3) // 前两条是 1、2
})

test('elapsedMs：running 用 now-startedAt；end 后用 durationMs；end 未给时长记 0', () => {
  const live = createLiveStream()
  live.start({ roundId: 'r', startedAt: new Date(Date.now() - 5000).toISOString(), why: 'manual' })
  assert.ok(live.snapshot().elapsedMs >= 4000, 'running 时按开始时刻推算')
  live.end({ code: 0, durationMs: 4321 })
  const done = live.snapshot()
  assert.equal(done.running, false)
  assert.equal(done.lastCode, 0)
  assert.equal(done.lastDurationMs, 4321)
  assert.equal(done.elapsedMs, 4321)
  // 第二轮开始：lastCode/lastDurationMs 保留上一轮结果
  live.start({ roundId: 'r2' })
  assert.equal(live.snapshot().lastCode, 0)
  assert.equal(live.snapshot().lastDurationMs, 4321)
  // end 不给 durationMs ⇒ 记 0（契约：没有则 0）
  live.end({ code: 1 })
  assert.equal(live.snapshot().lastCode, 1)
  assert.equal(live.snapshot().lastDurationMs, 0)
  assert.equal(live.snapshot().elapsedMs, 0)
})

test('start 缺 startedAt / 脏参数不抛，仍给出 ISO 开始时间', () => {
  const live = createLiveStream()
  assert.doesNotThrow(() => live.start())
  assert.doesNotThrow(() => live.start(null))
  assert.doesNotThrow(() => live.start({ roundId: 123, startedAt: '不是时间', why: 9 }))
  const snap = live.snapshot()
  assert.equal(snap.roundId, '123')
  assert.equal(snap.why, '9')
  assert.ok(Number.isFinite(Date.parse(snap.startedAt)))
  assert.equal(snap.running, true)
})

test('end 的残行 flush 先于状态通知；事件保留供回看', () => {
  const live = createLiveStream()
  const msgs = []
  live.onPush((m) => msgs.push(m))
  live.start({ roundId: 'r' })
  live.pushChildChunk('没换行的尾巴')
  live.end({ code: 0, durationMs: 10 })
  const kinds = msgs.map((m) => m.kind)
  assert.deepEqual(kinds, ['state', 'event', 'state'])
  assert.equal(msgs[1].frame.text, '没换行的尾巴')
  assert.deepEqual(texts(live), ['没换行的尾巴']) // end 后事件仍在
  assert.equal(live.snapshot().running, false)
})

test('reset 全量清空；seq 继续单调', () => {
  const live = createLiveStream()
  live.start({ roundId: 'r', why: 'x' })
  live.push({ kind: 'text', text: 'a' })
  live.end({ code: 0, durationMs: 5 })
  live.reset()
  const snap = live.snapshot()
  assert.equal(snap.running, false)
  assert.equal(snap.roundId, null)
  assert.equal(snap.startedAt, null)
  assert.equal(snap.why, null)
  assert.equal(snap.lastCode, null)
  assert.equal(snap.lastDurationMs, null)
  assert.equal(snap.elapsedMs, 0)
  assert.equal(snap.cursor, 0)
  assert.deepEqual(snap.events, [])
  assert.deepEqual(snap.stats, { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 })
  live.push({ kind: 'text', text: 'b' })
  assert.equal(live.snapshot().events[0].seq, 2) // reset 前已有 1
})

/* ───────────────────────── onPush / 健壮性 ───────────────────────── */

test('onPush：事件收 {kind:"event",frame}，start/end 收 {kind:"state"}', () => {
  const live = createLiveStream()
  const msgs = []
  const off = live.onPush((m) => msgs.push(m))
  live.start({ roundId: 'r' })
  live.pushHost('宿主日志')
  live.push({ kind: 'text', text: 'hello' })
  live.end({ code: 0, durationMs: 1 })
  assert.deepEqual(msgs.map((m) => m.kind), ['state', 'event', 'event', 'state'])
  assert.equal(msgs[1].frame.kind, 'host')
  assert.equal(msgs[1].frame.text, '宿主日志')
  assert.equal(msgs[2].frame.seq, 2)
  assert.equal('snapshot' in msgs[0], false) // 状态变化不带 snapshot，订阅方自己调
  off()
  live.push({ kind: 'text', text: '退订后' })
  assert.equal(msgs.length, 4)
})

test('onPush：退订幂等、非函数入参不抛、listener 抛异常被吞掉且不影响其他人', () => {
  const live = createLiveStream()
  live.onPush(() => { throw new Error('listener 炸了') })
  let good = 0
  const off = live.onPush(() => { good++ })
  assert.doesNotThrow(() => live.pushHost('x'))
  assert.equal(good, 1)
  assert.doesNotThrow(() => off())
  assert.doesNotThrow(() => off())
  live.pushHost('y')
  assert.equal(good, 1)
  const offBadArg = live.onPush('不是函数')
  assert.equal(typeof offBadArg, 'function')
  assert.doesNotThrow(() => offBadArg())
  assert.doesNotThrow(() => live.pushChildChunk('z\n'))
})

test('任意脏输入都不抛异常：push / pushHost / pushChildChunk / snapshot', () => {
  const live = createLiveStream()
  assert.doesNotThrow(() => {
    live.push(undefined)
    live.push(null)
    live.push({})
    live.push({ kind: 'blank', text: '空' })
    live.pushHost(undefined)
    live.pushHost(null)
    live.pushChildChunk(undefined)
    live.pushChildChunk(null)
    live.pushChildChunk(12345)
    live.pushChildChunk(Buffer.alloc(0))
    live.snapshot(undefined)
    live.snapshot(null)
    live.snapshot('x')
  })
  // 脏输入不产生空事件；12345 变成残行，end 时 flush 成文本事件
  assert.equal(live.snapshot().events.length, 0)
  live.end({ code: 0 })
  assert.deepEqual(texts(live), ['12345'])
})

test('pushHost 空文本不产生事件；init 参数再脏也不崩', () => {
  const live = createLiveStream({ maxEvents: 0, maxTextLen: -1 })
  assert.doesNotThrow(() => live.pushHost(''))
  assert.equal(live.snapshot().events.length, 0)
  live.pushHost('x'.repeat(1000))
  assert.ok(live.snapshot().events[0].text.length > 0)
  assert.doesNotThrow(() => createLiveStream(null))
  assert.doesNotThrow(() => createLiveStream('bad'))
})
