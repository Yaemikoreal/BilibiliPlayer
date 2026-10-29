// index.js 集成测试（离线）：真 import index.js → apply(fake ctx) → 捕获 prefix 路由 handler，
// 对组合分发逻辑（工厂端点 / legacy 端点 / 404 兜底）做逐项断言。
// ⭐ BILI_FENSHEN_HOME 必须在 import 前指向临时目录，避免污染真实家目录。
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs'
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
// 账本 fixture（/activity + 今日配额计数的数据源）：固定在「本地今天 00:00–00:02」，
// 避免用 Date.now()-2h（凌晨跑测试会跨到昨天，导致"今日配额"时间炸弹）。
const todayAt = (minutes, seconds = 0) => {
  const d = new Date()
  d.setHours(0, minutes, seconds, 0)
  return d.toISOString()
}
const nineDaysAgo = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - 9)
  return d.toISOString()
}
writeFileSync(join(home, 'ledger.jsonl'), [
  JSON.stringify({ t: todayAt(0), round: 'r1', type: 'view', bvid: 'BV1', title: 'A', grade: 'worth', source: 'hot' }),
  JSON.stringify({ t: todayAt(0, 30), round: 'r1', type: 'comment', bvid: 'BV1', text: 'c', rpid: 1 }),
  JSON.stringify({ t: todayAt(1), round: 'r1', type: 'reply-in', bvid: 'BV1', parent: 1, rpid: 2, from: '张三', text: 'hi', notifId: 1 }),
  JSON.stringify({ t: nineDaysAgo(), round: 'old', type: 'view', bvid: 'BVold', title: '九天前', source: 'hot' }),
  '',
].join('\n'))

const { apply, getLedgerReaderStats } = await import('../index.js')
// W3-3：编译读口（与列表接口不同 —— 列表要能看到回收站，编译必须跳过 disabled）
const { resolveLoreIndex, loadCard } = await import('../lib/persona/index.js')

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

// ⭐ W4-2：11 处 `readEvents(LEDGER_FILE)` 收敛成一个 ledgerReader 实例 ——
//    重复请求同一个账本应该是「0 字节增量读盘 + 命中缓存」，而不是每次全量 readFileSync。
const rdr1 = getLedgerReaderStats()
await call('GET', '/api/bili-fenshen/status')
await call('GET', '/api/bili-fenshen/status')
const rdr2 = getLedgerReaderStats()
check('W4-2：账本读收敛到单 reader（重复请求 0 字节增量读盘、cacheHits 增长）',
  rdr2.bytesRead === rdr1.bytesRead && rdr2.cacheHits > rdr1.cacheHits,
  { bytesDelta: rdr2.bytesRead - rdr1.bytesRead, cacheHitsDelta: rdr2.cacheHits - rdr1.cacheHits })

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


// 人设工作室端点：卡片/语料/见闻/版本 + 保存/回滚（写临时 home）
const p1 = await call('GET', '/api/bili-fenshen/persona')
check('GET /persona 带 card + cardSource',
  p1.json?.card?.id === 'whale' && p1.json?.cardSource?.source === 'preset', p1.json?.cardSource)
const pe = await call('GET', '/api/bili-fenshen/persona/expression')
check('GET /persona/expression 分桶',
  pe.status === 200 && pe.json?.total > 0 && !!pe.json?.buckets?.question, { status: pe.status, total: pe.json?.total })
const pl = await call('GET', '/api/bili-fenshen/persona/lore')
check('GET /persona/lore 索引 + 正文',
  pl.status === 200 && (pl.json?.entries || []).length >= 1 && (pl.json.entries[0].body || '').length > 0,
  { status: pl.status, entries: pl.json?.entries?.length })
const pv0 = await call('GET', '/api/bili-fenshen/persona/versions')
check('GET /persona/versions 200', pv0.status === 200 && Array.isArray(pv0.json?.versions), pv0.json)
const putBad = await call('PUT', '/api/bili-fenshen/persona', { card: { ...p1.json.card, spec: 'wrong-spec' } })
check('PUT /persona 非法卡 400', putBad.status === 400 && (putBad.json?.errors || []).length > 0, { status: putBad.status })
const putOk = await call('PUT', '/api/bili-fenshen/persona', { card: { ...p1.json.card, version: '2.0.1' } })
check('PUT /persona 合法卡 200 + 快照', putOk.status === 200 && !!putOk.json?.snapshot, { status: putOk.status })
const p2 = await call('GET', '/api/bili-fenshen/persona')
check('/persona 保存后 source=file', p2.json?.cardSource?.source === 'file' && p2.json?.card?.version === '2.0.1', p2.json?.cardSource)
const pv1 = await call('GET', '/api/bili-fenshen/persona/versions')
check('版本快照出现', (pv1.json?.versions || []).length >= 1, { n: pv1.json?.versions?.length })
const restoreBad = await call('POST', '/api/bili-fenshen/persona/versions/restore', { name: '../evil.json' })
check('restore 拒绝路径穿越', restoreBad.status === 400, { status: restoreBad.status })
const snapName = (pv1.json?.versions || [])[0]?.name
const restore = await call('POST', '/api/bili-fenshen/persona/versions/restore', { name: snapName })
check('POST /persona/versions/restore 200', restore.status === 200 && restore.json?.ok === true, { status: restore.status })

/* ───────── W5-3 服务端端点：无数据也必须 200 + ok:true + 空结构 ───────── */

const ck0 = await call('GET', '/api/bili-fenshen/persona/checkup')
check('GET /persona/checkup 200 + 契约字段齐全（空/少数据不 500）',
  ck0.status === 200 && ck0.json?.ok === true && ck0.json?.windowDays === 14
  && typeof ck0.json?.n === 'number' && ck0.json?.verdict && typeof ck0.json.verdict.level === 'string'
  && Array.isArray(ck0.json?.verdict?.reasons) && Array.isArray(ck0.json?.samples)
  && ck0.json?.baseline && typeof ck0.json.baseline.medianChars === 'number', ck0.json)
const hs0 = await call('GET', '/api/bili-fenshen/persona/history')
check('GET /persona/history 200 + tags 数组', hs0.status === 200 && hs0.json?.ok === true && Array.isArray(hs0.json?.tags), hs0.json)

// 造「有数据」态：账本追加一条 persona-inject + 两条带 likes 的评论（落近 14 天窗口）
appendFileSync(join(home, 'ledger.jsonl'), [
  JSON.stringify({ t: todayAt(2), round: 'rhist', type: 'persona-inject', personaTag: 'whale@2.2.0', mode: 'card', channel: 'after', layers: [], hits: [], degraded: [], notes: [] }),
  JSON.stringify({ t: todayAt(2, 10), round: 'rhist', type: 'comment', bvid: 'BVhist1', text: '这句是我自己写的，够口语了吧', rpid: 501 }),
  JSON.stringify({ t: todayAt(2, 20), round: 'rhist', type: 'comment', bvid: 'BVhist2', text: '第二个样本：短一点', rpid: 502, likes: 7 }),
  '',
].join('\n'))
const ck1 = await call('GET', '/api/bili-fenshen/persona/checkup')
check('GET /persona/checkup 有数据：n 增加、samples 带 bvid/text/t、metrics 齐全',
  ck1.status === 200 && ck1.json?.n >= 3 && ck1.json?.samples?.length >= 3
  && ck1.json.samples.every((x) => typeof x.bvid === 'string' && typeof x.text === 'string' && typeof x.t === 'string')
  && ck1.json?.metrics && typeof ck1.json.metrics.medianChars === 'number', ck1.json)
const hs1 = await call('GET', '/api/bili-fenshen/persona/history')
check('GET /persona/history 有数据：按 personaTag 分组、每组 ≤3 条、likes 聚合',
  hs1.status === 200 && hs1.json?.tags?.[0]?.personaTag === 'whale@2.2.0'
  && hs1.json.tags[0].rounds >= 1 && hs1.json.tags[0].likes === 7
  && hs1.json.tags[0].samples.length >= 1 && hs1.json.tags[0].samples.length <= 3
  && typeof hs1.json.tags[0].samples[0].bvid === 'string', hs1.json?.tags)

/* ───────── W3-3 素材删除留痕 / 软删除可恢复 / purge / 孤儿扫描 ───────── */

const FORM = 'question'
const addC = await call('POST', '/api/bili-fenshen/persona/expression', { action: 'add', form: FORM, text: '测试语料：这句够短吧' })
check('W3-3 前置：语料 add 200', addC.status === 200 && addC.json?.ok === true, addC.json)
const addedId = (addC.json?.buckets?.[FORM] || []).find((e) => String(e.text || '').includes('测试语料'))?.id
const remC = await call('POST', '/api/bili-fenshen/persona/expression', { action: 'remove', form: FORM, id: addedId })
const removedEntry = (remC.json?.buckets?.[FORM] || []).find((e) => e.id === addedId)
check('W3-3 语料 remove = 软删除（soft:true / disabled≥1 / 条目留在库里但标记 disabled）',
  remC.status === 200 && remC.json?.soft === true && remC.json?.disabled >= 1
  && removedEntry?.disabled === true, { soft: remC.json?.soft, disabled: remC.json?.disabled, entry: removedEntry })
const bankBaks = readdirSync(join(home, 'persona')).filter((f) => f.startsWith('expression-bank.json.bak-'))
check('W3-3 语料删除留痕：<file>.bak-<ts> 存在且 ≤3 份', bankBaks.length >= 1 && bankBaks.length <= 3, bankBaks)
const resC = await call('POST', '/api/bili-fenshen/persona/expression', { action: 'restore', form: FORM, id: addedId })
const bankAfter = await call('GET', '/api/bili-fenshen/persona/expression')
check('W3-3 语料 restore 可恢复（total 回到 add 之后）',
  resC.status === 200 && resC.json?.ok === true && bankAfter.json?.total === addC.json.total, { total: bankAfter.json?.total })
const purC = await call('POST', '/api/bili-fenshen/persona/expression', { action: 'purge', form: FORM, id: addedId })
check('W3-3 语料 purge 物理删除（soft≠true / total 减 1）',
  purC.status === 200 && purC.json?.ok === true && purC.json?.soft !== true && purC.json?.total === addC.json.total - 1, purC.json)

// 见闻：add → 写正文 → 软删除（回收站可见但编译跳过、正文保留、孤儿扫描不误报）→ restore → purge
const loreAdd = await call('POST', '/api/bili-fenshen/persona/lore', { action: 'add', id: 'integration-lore', keys: ['测试'], oneLine: '一行测试见闻' })
check('W3-3 前置：见闻 add 200', loreAdd.status === 200 && loreAdd.json?.ok === true, loreAdd.json)
const loreBody = await call('PUT', '/api/bili-fenshen/persona/lore', { id: 'integration-lore', body: '测试见闻正文：那天我把锅烧糊了。' })
check('W3-3 前置：见闻正文写盘 200', loreBody.status === 200 && loreBody.json?.ok === true, loreBody.json)
const loreRem = await call('POST', '/api/bili-fenshen/persona/lore', { action: 'remove', id: 'integration-lore' })
const loreAfterRem = await call('GET', '/api/bili-fenshen/persona/lore')
const cardBaks = readdirSync(join(home, 'persona')).filter((f) => f.startsWith('card.json.bak-'))
const loreBinEntry = (loreAfterRem.json?.entries || []).find((e) => e.id === 'integration-lore')
check('W3-3 见闻 remove = 软删除（列表里标记 disabled、card.json 留痕、不当孤儿）',
  loreRem.status === 200 && loreRem.json?.soft === true
  // 列表接口要能看到回收站条目（否则控制台没法"恢复"），但要带 disabled 标记
  && loreBinEntry?.disabled === true
  && cardBaks.length >= 1 && cardBaks.length <= 3
  && !(loreAfterRem.json?.orphans?.bodiesWithoutIndex || []).includes('integration-lore'),
  { cardBaks, orphans: loreAfterRem.json?.orphans, binEntry: loreBinEntry })
check('W3-3 见闻软删除后**编译**跳过（索引里不再出现）',
  !resolveLoreIndex(loadCard().card, {}).some((e) => e.id === 'integration-lore'),
  resolveLoreIndex(loadCard().card, {}).map((e) => e.id))
const loreRes = await call('POST', '/api/bili-fenshen/persona/lore', { action: 'restore', id: 'integration-lore' })
const loreAfterRes = await call('GET', '/api/bili-fenshen/persona/lore')
check('W3-3 见闻 restore 可恢复（正文仍在、disabled 清掉）',
  loreRes.status === 200 && loreRes.json?.ok === true
  && (loreAfterRes.json?.entries || []).some((e) => e.id === 'integration-lore' && e.disabled !== true && String(e.body || '').length > 0), loreRes.json)
// 孤儿扫描两种都能报：手放一个正文（无索引）、加一个只有索引没正文的
writeFileSync(join(home, 'persona', 'lore', 'stray-orphan.md'), '没人认领的正文\n', 'utf8')
await call('POST', '/api/bili-fenshen/persona/lore', { action: 'add', id: 'index-no-body', keys: ['缺'], oneLine: '只有索引没有正文' })
const loreOrphans = await call('GET', '/api/bili-fenshen/persona/lore')
check('W3-3 孤儿扫描：有正文无索引 / 有索引无正文 都能报出来',
  (loreOrphans.json?.orphans?.bodiesWithoutIndex || []).includes('stray-orphan')
  && (loreOrphans.json?.orphans?.indexWithoutBody || []).includes('index-no-body'),
  loreOrphans.json?.orphans)
const lorePur = await call('POST', '/api/bili-fenshen/persona/lore', { action: 'purge', id: 'integration-lore' })
const loreBaks = readdirSync(join(home, 'persona', 'lore')).filter((f) => f.startsWith('integration-lore.md.bak-'))
check('W3-3 见闻 purge：正文归档 .bak-<ts> 后移除原文件',
  lorePur.status === 200 && lorePur.json?.ok === true && loreBaks.length >= 1
  && !readdirSync(join(home, 'persona', 'lore')).includes('integration-lore.md'), { loreBaks })

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
