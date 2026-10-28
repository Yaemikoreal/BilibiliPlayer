/**
 * 账本/概览性能基准（W4-0）。
 *
 * 为什么先有它：方案给 W4 定了硬指标（10 万行概览 p95 ≤5ms、无变化时 0 次读盘），
 * 并明确「没有前后数字不许动 readEvents」。所以这个脚本只做两件事：
 *   1. **给出前后可比的数字**（同一台机器、同一份数据、同一轮迭代数）；
 *   2. 证明 lib/ledger-index.js 的增量读真的省了盘（bytesRead / fullReads / cacheHits）。
 *
 * 用法：
 *   node scripts/bench-ledger.mjs              # 1k / 10k / 100k
 *   node scripts/bench-ledger.mjs 10000        # 只跑单个规模
 *   node scripts/bench-ledger.mjs --out docs/analysis/bench.md
 *
 * 口径（别乱改，否则前后不可比）：
 *   - p95 = 第 95 百分位（对 200 次采样排序后取值），单位 ms，保留 2 位；
 *   - "冷读" = 每次换一个 reader 实例（等价于进程重启后的第一次概览）；
 *   - "稳态" = 同一实例连续 read()（等价于 SSE 每帧重算，文件没变）；
 *   - "增量" = 追加 100 条事件后再 read()（等价于一轮值班写了几条账之后重算）。
 */
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEvents } from '../lib/ledger.js'
import { createLedgerReader } from '../lib/ledger-index.js'
import { buildOverview } from '../lib/overview.js'

const NS = ['1k', '10k', '100k']
const SIZE_OF = { '1k': 1_000, '10k': 10_000, '100k': 100_000 }
/**
 * 采样数随规模自适应：1k 取 200（毫秒级，噪声要压住），10 万行取 20（单次就几十 ms）。
 * **前后对比必须用同一个公式**，否则数字不可比。
 */
const SAMPLES = 200
const samplesFor = (n) => Math.max(20, Math.min(SAMPLES, Math.round(400_000 / n)))

/** 生成一份形状真实的账本：一天内多轮、五种事件、带中文正文。 */
const makeEvents = (n, baseMs = Date.parse('2026-10-28T00:00:00.000Z')) => {
  const types = ['view', 'comment', 'like', 'reply-out', 'reply-in', 'reply-scan', 'round-end', 'dynamic']
  const out = []
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length]
    const at = new Date(baseMs + i * 37_000).toISOString()
    const e = { t: at, round: `r${Math.floor(i / 120)}`, type }
    if (type === 'view' || type === 'like' || type === 'comment') e.bvid = `BV1${(i % 5000).toString(36).toUpperCase()}`
    if (type === 'comment') { e.text = `第 ${i} 条评论：这玩意儿真的难绷，我上周也在白银反复横跳 [doge]`; e.rpid = i }
    if (type === 'dynamic') e.text = `分享一个视频，顺手说一句第 ${i} 天的感想`
    if (type === 'reply-out') { e.parent = i; e.rpid = i + 1; e.kind = i % 5 === 0 ? 'proactive' : 'follow' }
    if (type === 'reply-in') { e.rpid = i; e.text = '你也被这个卡住了？' }
    if (type === 'reply-scan') e.decision = i % 4 === 0 ? 'skipped' : 'posted'
    if (type === 'round-end') { e.code = 0; e.durationMs = 600_000 + (i % 7) * 1000 }
    out.push(e)
  }
  return out
}

const percentile = (arr, p) => {
  const list = [...arr].sort((a, b) => a - b)
  if (!list.length) return 0
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))
  return list[idx]
}
const p50p95 = (arr) => [percentile(arr, 50), percentile(arr, 95)]
const ms = (x) => Number(x.toFixed(2))

const bench = (label, fn, samples = SAMPLES) => {
  const n = Math.max(3, Math.floor(samples))
  // 预热：避免把 JIT 编译时间算进第一个采样
  fn()
  fn()
  const times = []
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint()
    fn()
    const t1 = process.hrtime.bigint()
    times.push(Number(t1 - t0) / 1e6)
  }
  const [p50, p95] = p50p95(times)
  return { label, p50: ms(p50), p95: ms(p95), samples: n }
}

const writeLedger = (dir, events) => {
  const f = join(dir, 'ledger.jsonl')
  writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return f
}

const cfg = {
  autoDuty: false, noon: true, night: true, perDay: 40, commentsPerDay: 15,
  likesPerDay: 5, dynamicsPerDay: 0, repliesPerRound: 5, replyOthersPerRound: 3,
}
const state = { replyScanSince: 0, lastRunAt: new Date().toISOString(), lastCode: 0 }

const runSize = (ns, dir) => {
  const n = SIZE_OF[ns]
  const S = samplesFor(n)
  const all = makeEvents(n)
  const file = writeLedger(dir, all)
  const bytes = statSync(file).size
  const rows = []

  // ── 现状：全量读 + 概览 ──
  rows.push({ ...bench(`${ns} · readEvents（全量读，现状）`, () => readEvents(file), S), group: '现状' })
  const fullEvents = readEvents(file)
  rows.push({ ...bench(`${ns} · buildOverview（已是数组，纯计算）`, () => buildOverview({ cfg, state, events: fullEvents }), S), group: '现状' })
  rows.push({
    ...bench(`${ns} · readEvents + buildOverview（一次概览的现状全流程）`, () => buildOverview({ cfg, state, events: readEvents(file) }), S),
    group: '现状',
  })

  // ── 方案：增量读 ──
  rows.push({ ...bench(`${ns} · reader 冷读（新实例首读，等价进程重启）`, () => createLedgerReader(file).read(), S), group: '方案' })
  const warmReader = createLedgerReader(file)
  warmReader.read()
  rows.push({ ...bench(`${ns} · reader 稳态读（文件没变 ⇒ 0 次读盘）`, () => warmReader.read(), S), group: '方案' })
  rows.push({
    ...bench(`${ns} · reader 稳态读 + buildOverview（每帧重算的全流程）`, () => buildOverview({ cfg, state, events: warmReader.read() }), S),
    group: '方案',
  })

  // 增量：每次追加 100 条后再读（模拟一轮值班写入后重算）
  const tail = makeEvents(100, Date.parse('2026-10-29T00:00:00.000Z')).map((e) => ({ ...e, bvid: 'BVINC' }))
  let k = 0
  const incReader = createLedgerReader(file)
  incReader.read()
  rows.push({
    ...bench(`${ns} · reader 增量读（追加 100 条后）`, () => {
      if (k < 100) { appendFileSync(file, tail.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'); k++ }
      return incReader.read()
    }, Math.min(100, S)),
    group: '方案',
  })

  // 读盘账：证明「没变化时 0 次读盘」
  const reader = createLedgerReader(file)
  reader.read()
  const before = reader.stats()
  for (let i = 0; i < 500; i++) reader.read()
  const after = reader.stats()

  return {
    size: ns, events: n, bytes,
    rows,
    proof: {
      cacheHits: after.cacheHits - before.cacheHits,
      calls: after.calls - before.calls,
      bytesRead: after.bytesRead - before.bytesRead,
      fullReads: after.fullReads,
      incrementalReads: after.incrementalReads,
      fallbacks: after.fallbacks,
    },
  }
}

const outIdx = process.argv.indexOf('--out')
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : ''
const only = process.argv.slice(2).find((a) => /^\d+$/.test(a))
const targets = only ? [`${Number(only) / 1000}k`] : NS
const dir = mkdtempSync(join(tmpdir(), 'bf-bench-'))

const results = []
try {
  for (const ns of targets) {
    if (!SIZE_OF[ns]) { console.error(`未知规模：${ns}（只支持 ${NS.join(' / ')}）`); process.exit(2) }
    results.push(runSize(ns, dir))
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉无所谓 */ }
}

const lines = []
lines.push(`# 账本/概览性能基准（node ${process.version}，${SAMPLES} 次采样 p95）`)
lines.push('')
lines.push('> 由 `node scripts/bench-ledger.mjs` 生成，口径见脚本头部注释。')
lines.push('')
for (const r of results) {
  lines.push(`## ${r.size} 行（${r.events} 事件 / ${(r.bytes / 1024).toFixed(0)} KB）`)
  lines.push('')
  lines.push('| 组 | 场景 | p50 (ms) | p95 (ms) |')
  lines.push('|---|---|---:|---:|')
  for (const row of r.rows) lines.push(`| ${row.group} | ${row.label.replace(`${r.size} · `, '')} | ${row.p50} | ${row.p95} |`)
  lines.push('')
  lines.push(`读盘账：500 次稳态 read() ⇒ cacheHits ${r.proof.cacheHits} / bytesRead +${r.proof.bytesRead} B`
    + `（累计 fullReads ${r.proof.fullReads} / incrementalReads ${r.proof.incrementalReads} / fallbacks ${r.proof.fallbacks}）`)
  lines.push('')
}
const report = lines.join('\n')
console.log(report)
if (outFile) {
  writeFileSync(outFile, report, 'utf8')
  console.log(`\n已写入 ${outFile}`)
}
