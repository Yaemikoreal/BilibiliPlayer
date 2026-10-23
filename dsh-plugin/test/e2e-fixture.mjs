// 端到端 fixture 验证（临时脚本）：用与 index.js 相同的依赖装配 createApiHandler，
// 对临时家目录灌账本/判重表/日志 fixture，验证 /activity /seen /log /reports 数据通路。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiHandler } from '../lib/api.js'
import { readEvents } from '../lib/ledger.js'
import { appendEvents } from '../lib/ledger.js'

const home = mkdtempSync(join(tmpdir(), 'bf-e2e-'))
mkdirSync(join(home, 'out'), { recursive: true })
mkdirSync(join(home, 'digest'), { recursive: true })

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const H = 3600_000
const round1 = iso(5 * H)
const round2 = iso(1 * H)

// 账本 fixture：r1（5 小时前，含回复对话）、r2（1 小时前）、一条 8 天前的旧事件（应被 7 天窗口滤掉）
appendEvents(join(home, 'ledger.jsonl'), [
  { t: iso(8 * 24 * H), round: 'old', type: 'view', bvid: 'BVold', title: '旧事件' },
  { t: iso(5 * H), round: round1, type: 'view', bvid: 'BV1xrnz6gEVD', title: '折1万次，会坏吗？iPhone Duo深度评测', author: '影视飓风', views: 3136000, duration: 1492, source: 'hot', grade: 'worth' },
  { t: iso(5 * H - 20_000), round: round1, type: 'like', bvid: 'BV1xrnz6gEVD' },
  { t: iso(5 * H - 60_000), round: round1, type: 'comment', bvid: 'BV1xrnz6gEVD', text: '用原子力显微镜查指纹为什么难擦…', rpid: 123456 },
  { t: iso(4 * H), round: round1, type: 'reply-in', bvid: 'BV1xrnz6gEVD', parent: 123456, rpid: 999001, from: '张三', text: '那个显微镜多少钱', notifId: 1 },
  { t: iso(4 * H - 30_000), round: round1, type: 'reply-in', bvid: 'BV1xrnz6gEVD', parent: 123456, rpid: 999002, from: '阿茶', text: '换屏8000是真的吗', notifId: 2 },
  { t: iso(3.9 * H), round: round1, type: 'reply-out', bvid: 'BV1xrnz6gEVD', parent: 999001, rpid: 999100, text: '三万左右吧' },
  { t: iso(5 * H - 90_000), round: round1, type: 'skip', bvid: 'BV1XynB6EEiM', title: '【何同学】能折！但代价呢？', reason: '同题重复' },
  { t: iso(1 * H), round: round2, type: 'view', bvid: 'BV1AHnB6NEhM', title: '《影之刃零》最终预告', author: '影之刃零', views: 1402000, duration: 191, source: 'search', grade: 'ok' },
  { t: iso(0.9 * H), round: round2, type: 'round-end', code: 0, durationMs: 127000 },
])

// 判重表 fixture
writeFileSync(join(home, 'seen.md'), [
  '# 判重表',
  '',
  '2026-10-22 14:10 · — · 本轮未登录 · —',
  '2026-10-23 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 折1万次，会坏吗？iPhone Duo深度评测',
  '',
].join('\n'))

// 日志 fixture：宿主事件 + 推理原文混杂
writeFileSync(join(home, 'duty.log'), [
  `[${iso(6 * H)}] dsh-bili-fenshen host 已激活`,
  'Let me check the subtitle first, then decide.',
  `[${iso(1 * H)}] 值班轮结束（web，code=0）`,
  '',
].join('\n'))

// 产物 fixture
writeFileSync(join(home, 'out', '2026-10-23.md'), '## 16:26 值班轮次\n\n### BV1xrnz6gEVD\n')
writeFileSync(join(home, 'digest', '2026-10.md'), '# 月度归档\n')

const handler = createApiHandler({
  home,
  ledgerFile: join(home, 'ledger.jsonl'),
  configFile: join(home, 'config.json'),
  seenFile: join(home, 'seen.md'),
  logFile: join(home, 'duty.log'),
  patchConfig: { autoDuty: false, perDay: 5 },
  readEvents: () => readEvents(join(home, 'ledger.jsonl')),
  overview: () => ({ duty: { autoDuty: false }, quota: { picked: 1 }, round: { running: false }, health: { cli: 'x', cred: true } }),
  setDuty: (v) => ({ autoDuty: v }),
  runDuty: () => ({ started: true }),
  stopDuty: () => ({ stopped: true }),
  fetchAccount: async () => ({ loggedIn: false }),
  listReports: () => ({ days: ['2026-10-23'], digests: ['2026-10'], overlay: true }),
})

const call = async (method, url, body) => {
  const chunks = []
  const res = {
    head: null, ended: false, out: '',
    writeHead(s, hh) { this.head = s },
    end(b) { this.ended = true; this.out = String(b || '') },
  }
  const req = { method, url, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)) } }
  await handler(req, res)
  return { status: res.head, json: res.out ? JSON.parse(res.out) : null }
}

let bad = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : ' —— ' + JSON.stringify(detail)}`)
  if (!cond) bad++
}

// 1) /activity：按天分组、阶段、未回数、7 天窗口
const act = await call('GET', '/api/bili-fenshen/activity')
const d0 = act.json.days[0]
const bv1 = d0.rounds.flatMap((r) => r.items).find((x) => x.bvid === 'BV1xrnz6gEVD')
check('/activity 200', act.status === 200, act.status)
check('旧事件被 7 天窗口滤掉', !act.json.days.flatMap((d) => d.rounds).flatMap((r) => r.items).some((x) => x.bvid === 'BVold'))
check('r2 倒序在前', d0.rounds[0].items[0].bvid === 'BV1AHnB6NEhM' || d0.rounds[0].id !== round1)
check('BV1 聚合 stage.replies === 2', bv1.stage.replies === 2, bv1.stage)
check('BV1 repliedBack === true', bv1.stage.repliedBack === true, bv1.stage)
check('BV1 pendingReply === 1（回了 1 条剩 1 条）', bv1.stage.pendingReply === 1, bv1.stage)
check('BV1 阶段 liked/commented', bv1.stage.liked && bv1.stage.commented)
check('跳过项归组', d0.rounds.flatMap((r) => r.items).find((x) => x.bvid === 'BV1XynB6EEiM')?.skipped?.reason === '同题重复')
check('轮次来源标签 热门', d0.rounds.find((r) => r.id === round1)?.sourceLabel === '热门')

// 2) /seen
const seen = await call('GET', '/api/bili-fenshen/seen')
check('/seen rows === 2', seen.json.rows.length === 2, seen.json.rows)
check('/seen 解析 BV 与标题', seen.json.rows[1].bvid === 'BV1xrnz6gEVD' && seen.json.rows[1].title.includes('iPhone Duo'))
check('/seen 无 BV 行 bvid 为空', seen.json.rows[0].bvid === '')

// 3) /log：宿主事件与原文分离
const lg = await call('GET', '/api/bili-fenshen/log?tail=50')
check('/log 宿主事件 2 条', lg.json.events.length === 2, lg.json.events)
check('/log 原文含推理行', /subtitle/.test(lg.json.raw), lg.json.raw)

// 4) /reports：days/digests/overlay
const rep = await call('GET', '/api/bili-fenshen/reports')
check('/reports days/digests/overlay', rep.json.days[0] === '2026-10-23' && rep.json.digests[0] === '2026-10' && rep.json.overlay === true, rep.json)

// 5) /config 往返
const c1 = await call('POST', '/api/bili-fenshen/config', { perDay: 7 })
const c2 = await call('GET', '/api/bili-fenshen/config')
check('/config 写入覆盖层并生效', c2.json.values.perDay === 7 && c2.json.sources.perDay === 'override', c2.json.values)

console.log(bad === 0 ? `\nE2E FIXTURE ALL GREEN` : `\n${bad} 项失败`)
try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
process.exit(bad === 0 ? 0 : 1)
