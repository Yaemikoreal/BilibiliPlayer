// index.js 集成测试（离线）：真 import index.js → apply(fake ctx) → 捕获 prefix 路由 handler，
// 对组合分发逻辑（工厂端点 / legacy 端点 / 404 兜底）做逐项断言。
// ⭐ BILI_FENSHEN_HOME 必须在 import 前指向临时目录，避免污染真实家目录。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-idx-'))
const home = process.env.BILI_FENSHEN_HOME
mkdirSync(join(home, 'out'), { recursive: true })
mkdirSync(join(home, 'digest'), { recursive: true })
writeFileSync(join(home, 'out', '2026-10-23.md'), '## 测试日报\n')
writeFileSync(join(home, 'digest', '2026-10.md'), '# 归档\n')
writeFileSync(join(home, 'seen.md'), '2026-10-23 16:26 · BV1xrnz6gEVD · 赞过+评论过 · 折1万次\n')
writeFileSync(join(home, 'duty.log'), '[2026-10-23T01:00:00.000Z] host 已激活\n推理原文一行\n')
// 账本 fixture（/activity + 今日配额计数的数据源）：用相对时间，保证「本地今天」判定永远成立
const H = 3600_000
const isoAgo = (h) => new Date(Date.now() - h * H).toISOString()
writeFileSync(join(home, 'ledger.jsonl'), [
  JSON.stringify({ t: isoAgo(2), round: 'r1', type: 'view', bvid: 'BV1', title: 'A', grade: 'worth', source: 'hot' }),
  JSON.stringify({ t: isoAgo(2) , round: 'r1', type: 'comment', bvid: 'BV1', text: 'c', rpid: 1 }),
  JSON.stringify({ t: isoAgo(1.5), round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 1, rpid: 2, from: '张三', text: 'hi', notifId: 1 }),
  JSON.stringify({ t: isoAgo(9 * 24), round: 'old', type: 'view', bvid: 'BVold', title: '九天前', source: 'hot' }),
  '',
].join('\n'))

const { apply } = await import('../index.js')

// ── fake ctx ──
let routeHandler = null
let routeDef = null
const fakeWeb = { register: (def) => { routeDef = def; routeHandler = def.handler; return () => {} } }
const registeredTools = []
const fakeTools = { register: (def) => { registeredTools.push(def.name); return () => {} } }
const fakeCtx = { get: (k) => (k === 'webServer' ? fakeWeb : k === 'tools' ? fakeTools : null) }

const patchConfig = { autoDuty: false, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, keywords: [], followUids: [], personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [] }
const dispose = apply(fakeCtx, patchConfig)

let bad = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : ' —— ' + JSON.stringify(detail)?.slice(0, 300)}`)
  if (!cond) bad++
}

check('webServer prefix 路由已注册', routeDef?.kind === 'prefix' && routeDef?.path === '/api/bili-fenshen', routeDef)
check('Agent 工具已注册', registeredTools.join(',') === 'bili_fenshen_status,bili_fenshen_run,bili_fenshen_diagnose', registeredTools)

const call = async (method, url, body) => {
  const res = {
    head: null, ended: false, out: '',
    writeHead(s) { this.head = s; this.writableEnded = false },
    end(b) { this.ended = true; this.writableEnded = true; this.out = String(b || '') },
  }
  const req = { method, url, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)) } }
  await routeHandler(req, res)
  return { status: res.head, json: res.out ? JSON.parse(res.out) : null, res }
}

// 工厂端点（组合分发后应可达）
const ov = await call('GET', '/api/bili-fenshen/overview')
check('GET /overview 200', ov.status === 200 && ov.json?.ok === true, { status: ov.status })
check('/overview 形状（duty/quota/round/health）', !!(ov.json?.duty && ov.json?.quota && ov.json?.round && ov.json?.health), ov.json)
check('/overview home 指向临时目录', ov.json?.home === home, ov.json?.home)
// ⭐ 今日配额按账本计数：fixture 今天 1 view + 1 comment（9 天前的 view 不计）
check('/overview 配额按账本计数（picked=1 comments=1 likes=0 dynamics=0）',
  ov.json?.quota?.picked === 1 && ov.json?.quota?.comments === 1 && ov.json?.quota?.likes === 0 && ov.json?.quota?.dynamics === 0,
  ov.json?.quota)

const act = await call('GET', '/api/bili-fenshen/activity')
check('GET /activity 200 且 days[0] 含 BV1', act.status === 200 && act.json?.days?.[0]?.rounds?.[0]?.items?.some((x) => x.bvid === 'BV1'), act.json)

const seen = await call('GET', '/api/bili-fenshen/seen')
check('GET /seen 解析判重行', seen.status === 200 && seen.json?.rows?.[0]?.bvid === 'BV1xrnz6gEVD', seen.json)

const lg = await call('GET', '/api/bili-fenshen/log?tail=50')
check('GET /log 宿主事件≥1 且原文含推理行（事件不含推理行）',
  lg.status === 200 && lg.json?.events?.length >= 1 && /推理原文/.test(lg.json?.raw || '')
  && lg.json.events.every((l) => !/推理原文/.test(l)), lg.json)

const rep = await call('GET', '/api/bili-fenshen/reports')
check('GET /reports days/digests', rep.status === 200 && rep.json?.days?.[0] === '2026-10-23' && rep.json?.digests?.[0] === '2026-10', rep.json)

// ── 新增端点：模型目录 / 实时流 / 一键诊断 ──
const mdl = await call('GET', '/api/bili-fenshen/models')
check('GET /models 200 且形状完整',
  mdl.status === 200 && mdl.json?.ok === true
  && Array.isArray(mdl.json?.providers) && typeof mdl.json?.models === 'object'
  && typeof mdl.json?.effective?.mode === 'string'
  && 'modelProvider' in (mdl.json?.config || {})
  && Array.isArray(mdl.json?.reasoningEfforts) && Array.isArray(mdl.json?.warnings), mdl.json?.status || mdl.json)
check('/models 无 llm 服务时降级为空目录（不 500）',
  mdl.json?.providers?.length === 0 && mdl.json?.effective?.mode === 'default', mdl.json?.effective)

const lv = await call('GET', '/api/bili-fenshen/live')
check('GET /live 200 且空闲形状完整',
  lv.status === 200 && lv.json?.ok === true && lv.json?.running === false
  && Array.isArray(lv.json?.events)
  && lv.json.events.every((e) => typeof e.seq === 'number' && typeof e.kind === 'string' && typeof e.t === 'string')
  && typeof lv.json?.cursor === 'number' && lv.json?.cursor >= 0
  && lv.json?.stats?.actions?.like === 0 && typeof lv.json?.phase?.label === 'string'
  && typeof lv.json?.quota?.picked === 'number', lv.json?.status || lv.json)

// SSE：连上先收 snapshot 帧，插件卸载时由 closeSse 关掉
let sseOut = ''
const sseRes = {
  headersSent: false, writableEnded: false,
  writeHead() { this.headersSent = true },
  flushHeaders() {},
  write(chunk) { sseOut += String(chunk) },
  end() { this.writableEnded = true },
  on() {},
}
await routeHandler({ method: 'GET', url: '/api/bili-fenshen/live/stream' }, sseRes)
check('GET /live/stream 首帧是 snapshot（SSE）',
  sseRes.headersSent === true && /data: \{"type":"snapshot"/.test(sseOut) && /"running":false/.test(sseOut), sseOut.slice(0, 200))

// 诊断：offline（fetch 抛错 → 凭证项 warn），仍应返回 10 项报告
const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('offline-test') }
const dg = await call('POST', '/api/bili-fenshen/diagnose')
globalThis.fetch = realFetch
check('POST /diagnose 200 且 10 项齐全',
  dg.status === 200 && dg.json?.items?.length === 10
  && dg.json.items.map((x) => x.id).join(',') === 'python,deps,mcp-server,mcp-connection,credential,dsh-cli,headless-profile,home,model,route'
  && dg.json.items.every((x) => ['pass', 'warn', 'fail'].includes(x.status)), dg.json)
check('/diagnose summary 与 ok 规则一致',
  dg.json?.summary?.pass + dg.json?.summary?.warn + dg.json?.summary?.fail === 10
  && dg.json?.ok === (dg.json?.summary?.fail === 0), dg.json?.summary)
check('/diagnose offline 时凭证项不 fail（warn）',
  ['pass', 'warn'].includes(dg.json?.items?.find((x) => x.id === 'credential')?.status),
  dg.json?.items?.find((x) => x.id === 'credential'))

// legacy 端点（不被工厂吃掉）
const st = await call('GET', '/api/bili-fenshen/status')
check('GET /status 200（legacy 保留）', st.status === 200 && st.json?.ok === true, { status: st.status })

const rp = await call('GET', '/api/bili-fenshen/report?day=2026-10')
check('GET /report?day=YYYY-MM 读归档', rp.status === 200 && /归档/.test(rp.json?.text || ''), rp.json)

const cred = await call('GET', '/api/bili-fenshen/cred')
check('GET /cred 200（legacy 保留）', cred.status === 200 && typeof cred.json?.exists === 'boolean', cred.json)

const poll = await call('GET', '/api/bili-fenshen/login/poll')
check('GET /login/poll 无会话态', poll.status === 200 && poll.json?.state === 'none', poll.json)

// 404 兜底
const nf = await call('GET', '/api/bili-fenshen/nope')
check('未知路径 404', nf.status === 404, { status: nf.status })

// 配置写回（写入临时 config.json，不碰真实家目录）
const c1 = await call('POST', '/api/bili-fenshen/config', { perDay: 7 })
check('POST /config 合法字段 200', c1.status === 200, { status: c1.status, body: c1.json })
const c2 = await call('GET', '/api/bili-fenshen/config')
check('GET /config 生效值与来源', c2.json?.values?.perDay === 7 && c2.json?.sources?.perDay === 'override', c2.json)
const c3 = await call('POST', '/api/bili-fenshen/config', { bogus: 1 })
check('POST /config 非法字段 400', c3.status === 400, { status: c3.status })
const du1 = await call('POST', '/api/bili-fenshen/duty', { autoDuty: true })
check('POST /duty 切换开关', du1.status === 200 && du1.json?.autoDuty === true, du1.json)
const du2 = await call('POST', '/api/bili-fenshen/duty', {})
check('POST /duty 缺 boolean 400', du2.status === 400, { status: du2.status })

// 模型配置写回 + /models 反映生效模型
const mc = await call('POST', '/api/bili-fenshen/config', { modelProvider: 'deepseek-account', modelName: 'deepseek-flash', modelReasoningEffort: 'high' })
check('POST /config 模型字段 200', mc.status === 200 && mc.json?.values?.modelName === 'deepseek-flash', mc.json)
const mdl2 = await call('GET', '/api/bili-fenshen/models')
check('/models 生效模型=插件配置', mdl2.json?.effective?.mode === 'config'
  && mdl2.json?.effective?.provider === 'deepseek-account'
  && mdl2.json?.effective?.model === 'deepseek-flash'
  && mdl2.json?.effective?.reasoningEffort === 'high', mdl2.json?.effective)
// 还原成「跟随默认」，别把临时覆盖层带到后续断言
await call('POST', '/api/bili-fenshen/config', { modelProvider: '', modelName: '', modelReasoningEffort: '' })

// stop（无子进程 → stopped:false，不应抛）
const sp = await call('POST', '/api/bili-fenshen/stop')
check('POST /stop 空闲时 stopped:false', sp.status === 200 && sp.json?.stopped === false, sp.json)

// 工具直调（status 工具应可用且指向临时 home）
const statusTool = null
check('工具名正确', registeredTools.includes('bili_fenshen_status'))

// 卸载 → 再激活：路由一次性守卫应允许重新注册；SSE 连接应被关闭
dispose()
check('卸载时 SSE 连接被关闭', sseRes.writableEnded === true)
let reRegistered = false
const fakeWeb2 = { register: (def) => { reRegistered = true; routeHandler = def.handler; return () => {} } }
const dispose2 = apply({ get: (k) => (k === 'webServer' ? fakeWeb2 : k === 'tools' ? fakeTools : null) }, patchConfig)
check('卸载后重新激活可再注册路由', reRegistered, reRegistered)
const ov2 = await call('GET', '/api/bili-fenshen/overview')
check('重新激活后 /overview 仍 200', ov2.status === 200, { status: ov2.status })
dispose2()

console.log(bad === 0 ? '\nINDEX INTEGRATION ALL GREEN' : `\n${bad} 项失败`)
const { rmSync } = await import('node:fs')
try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
process.exit(bad === 0 ? 0 : 1)
