/**
 * dsh-bili-fenshen —— Host 半部
 *
 * 值班调度：定时/手动拉起 headless dsh 会话，按章程混迹B站（看/评/赞/动态）。
 * 设计移植自 dsh-bili-scroll 的成熟模式（详见各处注释），行为集按本项目章程适配。
 *
 * 纪律（全部来自参考项目的实测事故）：
 * - 任何 import 失败都不能让整条插件不激活 ⇒ schemastery 等可选依赖一律优雅降级；
 * - 定时器回调与所有文件写入必须 try/catch 兜死 ⇒ 插件再错也只该"这一轮没跑成"；
 * - 找不到 dsh CLI 就明确报缺失，绝不裸 spawn `dsh`。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pluginDir = dirname(fileURLToPath(import.meta.url))

/* ───────────────────────── 扫码登录（JS 直连 passport 接口，移植自 dsh-bili-scroll） ─────────────────────────
 * 为什么不用 MCP 的 bili_login：client UI 无法调 MCP 工具；且这里轮询响应的 Set-Cookie 里直接带凭证。
 * ① GET /x/passport-login/web/qrcode/generate → data.url + data.qrcode_key
 * ② 轮询 poll：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期；⭐ 凭证在成功响应的 Set-Cookie 里
 * ③ 补 buvid3：api.bilibili.com/x/frontend/finger/spi
 */
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const BILI_GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const biliPollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const BILI_SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
// 项目根 = 插件目录的上一级（本插件与 mcp_server.py 同仓存放；换机器 clone 到任意路径都成立）
const PROJECT_ROOT = dirname(pluginDir)
const BILI_CRED_FILE = join(PROJECT_ROOT, 'bili_credential.json')

const pickCookies = (list) => {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

let loginSession = null // { key, url, at }
const loginStart = async () => {
  const r = await fetch(BILI_GEN, { headers: { 'User-Agent': BILI_UA } })
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  loginSession = { key: data.qrcode_key, url: data.url, at: Date.now() }
  return loginSession
}

const loginPoll = async () => {
  if (!loginSession) return { state: 'none', message: '没有进行中的登录，请先点「生成二维码」' }
  if (Date.now() - loginSession.at > 180_000) return { state: 'expired', message: '二维码已过期，请重新生成' }
  const res = await fetch(biliPollUrl(loginSession.key), { headers: { 'User-Agent': BILI_UA }, redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = pickCookies(setCookies)
    if (!jar.buvid3) {
      try {
        const r2 = await fetch(BILI_SPI, { headers: { 'User-Agent': BILI_UA } })
        const j2 = await r2.json()
        if (j2?.data?.b_3) jar.buvid3 = j2.data.b_3
      } catch { /* 拿不到就算了 */ }
    }
    if (!jar.sessdata) return { state: 'unknown', message: '登录成功但响应里没有 SESSDATA' }
    // 原子写入 MCP 读的凭证文件
    try {
      const tmp = BILI_CRED_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify({
        sessdata: jar.sessdata ?? '', bili_jct: jar.bili_jct ?? '',
        buvid3: jar.buvid3 || '', dedeuserid: jar.dedeuserid ?? '',
      }, null, 2), 'utf8')
      const { renameSync } = await import('node:fs')
      renameSync(tmp, BILI_CRED_FILE)
      loginSession = null
      log(`扫码登录成功，凭证已写入 ${BILI_CRED_FILE}`)
      return { state: 'ok', file: BILI_CRED_FILE }
    } catch (e) { return { state: 'unknown', message: '凭证写盘失败：' + String(e?.message ?? e) } }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', message: body?.message || '' }
}


/* ───────────────────────── 可选依赖：schemastery（优雅降级） ───────────────────────── */

let z = null
try {
  z = require('@deepseek-ai/schemastery')
} catch { /* 宿主树里继续找 */ }
if (!z && process.resourcesPath) {
  // ⭐ 桌面版：schemastery 在 app.asar 里（宿主自己的 node_modules）。运行中的宿主进程读 asar 没有问题，
  //    但 require.resolve 找不到它（不在插件目录的解析链上）⇒ 直接按已知路径构造一个解析器。
  for (const p of [
    join(process.resourcesPath, 'app.asar', 'node_modules', '@deepseek-ai', 'schemastery'),
    join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'schemastery'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'))
      const main = join(p, pkg.main || 'lib/index.js')
      if (existsSync(main)) { z = require(main); break }
    } catch { /* 下一个候选 */ }
  }
}
if (!z) {
  try { z = (await import('@deepseek-ai/schemastery')).default } catch { /* 设置页降级，插件照常加载 */ }
}

/* ───────────────────────── 配置 Schema（每个字段 volatile） ───────────────────────── */

export const Config = !z ? undefined : z.object({
  /** 峰谷自动刷总开关（默认关：桌面版自动轮可能卡，手动"现在跑一轮"是稳的） */
  autoDuty: z.boolean().default(false),
  /** 中午窗口 12:00–14:00 */
  noon: z.boolean().default(true),
  /** 晚间窗口 18:00–次日 09:00 */
  night: z.boolean().default(true),
  /** 每天最多挑几条（全天总量；0 = 只手动且不挑） */
  perDay: z.natural().default(5),
  /** 每天最多几条评论 */
  commentsPerDay: z.natural().default(5),
  /** 每轮最多几条评论 */
  commentsPerRound: z.natural().default(2),
  /** 每天最多几个赞 */
  likesPerDay: z.natural().default(10),
  /** 每天最多几条动态 */
  dynamicsPerDay: z.natural().default(1),
  /** 每轮最多跟进几条回复 */
  repliesPerRound: z.natural().default(2),
  /** 关注关键词（空 = 用章程默认） */
  keywords: z.array(z.string()).default([]),
  /** 订阅 UP 主 UID 列表 */
  followUids: z.array(z.natural()).default([]),
  /** 人设提示词（留空 = 中性说话；可填一段文字或一个文件路径） */
  personaPrompt: z.string().default(''),
  /** 日报形态：full=完整 · brief=薄版 · off=不写 */
  reportLevel: z.string().default('full'),
  /** dsh 的 bin.js 路径（不填自动探测） */
  dshBin: z.string().default(''),
  /** headless 那一轮用哪个 profile（desktop 被 Electron 独占，必须用独立 profile） */
  headlessProfile: z.string().default('headless'),
  /** MCP 白名单：值班轮可见的工具（BILI_MCP_TOOLS） */
  dutyTools: z.array(z.string()).default([
    'bili_search', 'bili_hot_videos', 'bili_weekly_hot', 'bili_rank',
    'bili_user_videos', 'bili_video_info', 'bili_subtitle', 'bili_comments',
    'bili_reply', 'bili_like', 'bili_send_dynamic', 'bili_check_credential',
    'bili_received_replies', 'bili_user_info',
  ]),
})

/* ───────────────────────── 路径与状态 ───────────────────────── */

const HOME = join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'bili-fenshen')
const OUT_DIR = join(HOME, 'out')
const DIGEST_DIR = join(HOME, 'digest')
const PROMPTS_DIR = join(pluginDir, 'prompts')
const LOG_FILE = join(HOME, 'duty.log')
const STATE_FILE = join(HOME, 'state.json')
const OVERLAY_FILE = join(HOME, 'headless-overlay.yml')

for (const d of [HOME, OUT_DIR, DIGEST_DIR]) {
  try { if (!existsSync(d)) mkdirSync(d, { recursive: true }) } catch { /* 让后续写入自己报 */ }
}

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}
const writeJsonSafe = (p, data) => {
  try { writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); return true } catch { return false }
}
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const bumpState = (patch) => {
  const st = readJson(STATE_FILE, {})
  const next = { ...st, ...patch }
  writeJsonSafe(STATE_FILE, next)
  return next
}

const log = (msg) => {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
    rotateLogIfBig()
  } catch { /* 写日志绝不能抛 */ }
}
const rotateLogIfBig = () => {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < 512 * 1024) return
    const old = readFileSync(LOG_FILE, 'utf8').slice(-256 * 1024)
    writeFileSync(LOG_FILE + '.old', old, 'utf8')
    writeFileSync(LOG_FILE, '', 'utf8')
  } catch { /* 兜住 */ }
}

/* ───────────────────────── 今日配额账本（报告是事实来源） ───────────────────────── */

const countToday = (marker) => {
  try {
    const f = join(OUT_DIR, `${dayKey()}.md`)
    if (!existsSync(f)) return 0
    return (readFileSync(f, 'utf8').match(new RegExp(marker, 'g')) || []).length
  } catch { return 0 }
}
const countPickedToday = () => countToday('^### BV')
const countCommentsToday = () => countToday('评论：(\\[?已发|发出|rpid)')
const countLikesToday = () => countToday('赞过')
const countDynamicsToday = () => countToday('动态：(\\[?已发|发出)')

const WINDOWS = {
  noon: { start: 12 * 60, end: 14 * 60 },
  night: { start: 18 * 60, end: 33 * 60 }, // 跨午夜：18:00–次日 09:00
}
const inWindow = (d, w) => {
  const m = d.getHours() * 60 + d.getMinutes()
  const x = m < 12 * 60 ? m + 24 * 60 : m // 午夜前归前一天
  return x >= w.start && x < w.end
}

/* ───────────────────────── dsh CLI 探测（移植 resolveDsh/findDshCli） ───────────────────────── */

const scanForDsh = (dir, depth, budget) => {
  if (depth > 7 || budget.n > 4000) return ''
  // ⭐ 桌面版：app.asar 是文件不是目录；dsh 包在 asar 内部（/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js）。
  //    宿主进程（Electron）读 asar 是透明的，直接按已知路径探测（子进程用 ELECTRON_RUN_AS_NODE=1 跑它同样可行）。
  const asarHit = join(dir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(asarHit)) return asarHit
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const d of ents) {
    if (!d.isDirectory()) continue
    if (++budget.n > 4000) return ''
    const p = join(dir, d.name)
    if (d.name === 'dsh') {
      const bin = join(p, 'lib', 'bin.js')
      if (existsSync(bin)) return bin
    }
    const hit = scanForDsh(p, depth + 1, budget)
    if (hit) return hit
  }
  return ''
}

let dshCliCache = { v: null, at: 0 }
const findDshCli = (cfg) => {
  const explicit = String(cfg?.dshBin || '').trim()
  if (explicit) {
    log(`dshBin 探测：explicit=${explicit} exists=${existsSync(explicit)}`)
    if (existsSync(explicit)) return explicit
  }
  // ⭐ 桌面版主通道：asar 内的 bin.js（宿主进程读 asar 透明；探测路径与 schemastery 相同）
  if (process.resourcesPath) {
    const asarBin = join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const asarOk = existsSync(asarBin)
    log(`dshBin 探测：asarBin=${asarBin} exists=${asarOk}`)
    if (asarOk) return asarBin
  } else {
    log('dshBin 探测：process.resourcesPath 为空（非 Electron 宿主？）')
  }
  try {
    for (const spec of ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh']) {
      try { const p = require.resolve(spec); if (p && existsSync(p)) return p } catch { /* 下一个 */ }
    }
  } catch { /* 解析器不可用就跳过 */ }
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  try { roots.push(join(dirname(process.execPath), 'resources')) } catch { /* 没有就算了 */ }
  const tried = []
  for (const root of roots) {
    if (!root || tried.includes(root) || !existsSync(root)) continue
    tried.push(root)
    const hit = scanForDsh(root, 0, { n: 0 })
    if (hit) return hit
  }
  return ''
}
const dshCliCached = (cfg) => {
  const now = Date.now()
  if (dshCliCache.v !== null && now - dshCliCache.at < 60_000) return dshCliCache.v
  const v = findDshCli(cfg)
  dshCliCache = { v, at: now }
  return v
}

/* ───────────────────────── 值班轮（移植 runDuty，行为集适配） ───────────────────────── */

let running = false
let applyCtx = null
let cfgSnapshot = {}

const refreshCfg = () => {
  try { cfgSnapshot = applyCtx?.config || cfgSnapshot } catch { /* 快照过期就过期 */ }
  return cfgSnapshot
}

const toText = (buf) => {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
    const u = b.toString('utf8')
    if (!u.includes('\uFFFD')) return u
    try { return new TextDecoder('gbk').decode(b) } catch { return u }
  } catch { return String(buf) }
}

const appendLogChunk = (buf) => {
  try { appendFileSync(LOG_FILE, toText(buf), 'utf8') } catch { /* 兜住 */ }
}

const stubReportIfMissing = (code) => {
  try {
    if (String(cfgSnapshot?.reportLevel || 'full') === 'off') return
    const f = join(OUT_DIR, `${dayKey()}.md`)
    if (existsSync(f)) return
    let tail = ''
    try { tail = readFileSync(LOG_FILE, 'utf8').slice(-1500) } catch { /* 读不到就算了 */ }
    writeFileSync(f, [
      `# 混迹B站 · ${dayKey()} —— 这一轮没写出报告`,
      '',
      `> ⚠️ 那一轮结束了，但没有生成正常报告（退出码 ${code}）。下一轮会重来。`,
      '> 下面附日志尾部，方便定位。',
      '',
      '```',
      String(tail).trim(),
      '```',
      '',
    ].join('\n'), 'utf8')
    log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
  } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
}

const buildOverlay = (cfg) => {
  const yml = []
  // ⭐ headless（0.2.1-rc.2）默认禁用三个服务 ⇒ overlay 是最后一层，把它们打开
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    yml.push(`- id: ${id}`, '  disabled: false', '')
  }
  // ⭐ 跟随用户当前模型 + **把 provider 行带进 headless**（0.2.1 实测冒烟结论）：
  //    ① headless profile（dsh-base+dsh-headless）只内置 deepseek 系 provider 行，没有用户的自定义 provider；
  //    ② 直接 insert dsh-llm-pi-ai 会撞 "provider already declared"（dsh-base 已插过，dormant）；
  //    ③ 正确做法：对 **同名行 llm-pi-ai 做配置覆盖**（provider 定义随之激活），模型跟随用户当前选择。
  let sel = null
  try { sel = applyCtx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null } catch { /* 老版本没有这个服务 */ }
  const provider = sel?.provider ?? sel?.providerId
  const model = sel?.model ?? sel?.modelId
  if (provider && model) {
    yml.push('- id: agent-default-model', '  config:', `    provider: ${provider}`, `    model: ${model}`, '')
  }
  // provider 行定义：从桌面版 profile 的 cordis.patch.yml 读 llm-pi-ai 配置（用户自己配的 key/模型），
  // 原样覆盖进 headless 的同名行。读不到就不覆盖（那时只能用 deepseek 系内置行）。
  try {
    const profilePatch = readFileSync(join(process.env.DSH_PROFILE_DIR || join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop'), 'cordis.patch.yml'), 'utf8')
    const m = /- id: llm-pi-ai\r?\n(?:[^\n]*\n)?\s*config:\r?\n((?:[ \t]+.*\r?\n)+?)(?=- id:|\z)/.exec(profilePatch)
    if (m) {
      yml.push('- id: llm-pi-ai', '  config:', m[1].replace(/\r?\n$/, ''), '')
      log('overlay：已把桌面版 llm-pi-ai provider 配置带入 headless')
    } else {
      log('overlay：profile 里没找到 llm-pi-ai 段（headless 轮将依赖内置 deepseek 行）')
    }
  } catch (e) { log(`overlay：读 profile provider 配置失败（不影响其余 overlay）：${e?.message ?? e}`) }
  // ⭐ 白名单收窄的 MCP（配合 mcp_server.py 的 BILI_MCP_TOOLS 门禁；凭证走独立 env 路径）
  const posix = (p) => String(p).replace(/\\/g, '/')
  const venvPython = join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe').replace(/\\/g, '/')
  const serverPy = join(PROJECT_ROOT, 'mcp_server.py').replace(/\\/g, '/')
  const tools = Array.isArray(cfg?.dutyTools) && cfg.dutyTools.length ? cfg.dutyTools : ['bili_search', 'bili_video_info']
  yml.push(
    '- insert:',
    '    - id: bili-fenshen-duty-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: bili-fenshen-duty',
    '        transport: stdio',
    `        command: '${venvPython.replace(/'/g, "''")}'`,
    '        args:',
    `          - '${serverPy.replace(/'/g, "''")}'`,
    '        env:',
    `          BILI_MCP_TOOLS: '${tools.join(',')}'`,
    "          PYTHONUTF8: '1'",
    "          PYTHONIOENCODING: 'utf-8'",
    '',
  )
  try { writeFileSync(OVERLAY_FILE, yml.join('\n'), 'utf8'); return OVERLAY_FILE } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
}

const buildDutyPrompt = (cfg) => {
  const charter = (() => {
    try { return readFileSync(join(PROMPTS_DIR, 'duty.md'), 'utf8').split('<家目录>').join(HOME) } catch { return '' }
  })()
  // 人设：文字或文件路径；留空 = 中性
  let persona = String(cfg?.personaPrompt || '').trim()
  let personaNote = ''
  if (persona && !persona.includes('\n')) {
    const looksPath = /^[A-Za-z]:[\\/]/.test(persona) || persona.startsWith('~/')
    if (looksPath) {
      try {
        let f = persona.replace(/^~\//, (process.env.USERPROFILE || '') + '/')
        if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'AGENTS.md')
        if (existsSync(f)) { persona = readFileSync(f, 'utf8'); personaNote = `（读自文件）` }
      } catch { /* 读不到就当普通文字 */ }
    }
  }
  const personaBlock = persona
    ? `\n\n===== 小号人设${personaNote}（**按这个来说话**）=====\n${persona.slice(0, 6000)}\n===== 人设结束 =====\n`
    : '\n\n⭐ 本轮没有拿到人设 ⇒ 按中性、礼貌、有点好奇心的普通人说话，别编人格。\n'

  const picked = countPickedToday()
  const quota = Math.max(0, Number(cfg?.perDay) || 0)
  const left = Math.max(0, quota - picked)
  const kws = Array.isArray(cfg?.keywords) ? cfg.keywords.filter(Boolean) : []
  const uids = Array.isArray(cfg?.followUids) ? cfg.followUids.filter(Boolean) : []
  const report = cfg?.reportLevel === 'off'
    ? '本轮不写日报文件，只把做过的动作记进判重表。'
    : cfg?.reportLevel === 'brief'
      ? `日报写到 ${join(OUT_DIR, dayKey() + '.md')}（薄版：每条一两行）。`
      : `报告写到 ${join(OUT_DIR, dayKey() + '.md')}（完整版；已有内容追加到末尾）。`

  return `你是B站小号的分身，现在执行一轮值班。`
    + personaBlock
    + (charter
      ? `\n===== 值班章程（<家目录> 已替换为真实路径）—— 严格按它执行 =====\n\n${charter}\n===== 章程结束 =====\n\n`
      : `然后读章程 ${join(PROMPTS_DIR, 'duty.md')}（章程里的 <家目录> 指 ${HOME}），严格按它执行。\n\n`)
    + `本轮参数：\n`
    + `- 报告：${report}\n`
    + `- 配额（全天总量）：挑中 ${quota} 条（今天已挑 ${picked} ⇒ 本轮最多再挑 ${left} 条）；`
    + `评论 ${Math.max(0, Number(cfg?.commentsPerDay) || 0)} 条/天（今天已 ${countCommentsToday()}），本轮最多 ${Math.max(0, Number(cfg?.commentsPerRound) || 0)} 条；`
    + `点赞 ${Math.max(0, Number(cfg?.likesPerDay) || 0)} 个/天（今天已 ${countLikesToday()}）；`
    + `动态 ${Math.max(0, Number(cfg?.dynamicsPerDay) || 0)} 条/天（今天已 ${countDynamicsToday()}）；`
    + `跟进回复本轮最多 ${Math.max(0, Number(cfg?.repliesPerRound) || 0)} 条。\n`
    + `- 内容源：热门 + ${kws.length ? `关键词搜索（${kws.join('、')}）` : '章程默认关键词'}`
    + `${uids.length ? ` + 订阅 UP 主（UID：${uids.join('、')}，用 bili_user_videos 逐个拉最新投稿）` : ''}。\n`
    + `- 你的 MCP 工具带 bili- 前缀（如 bili_search / bili_subtitle / bili_reply / bili_like / bili_send_dynamic）。\n`
    + `- 判重表 = ${join(HOME, 'seen.md')}（绝对路径，别写错地方）；归档 = ${join(DIGEST_DIR, dayKey().slice(0, 7) + '.md')}。\n`
    + `- 完成后：报告（按章程契约）+ 判重表，最后用一句话汇报本轮做了什么。现在几点了自己看一眼系统时间。`
}

const runDuty = (why = 'manual') => {
  try {
    const cfg = refreshCfg()
    if (running) return { started: false, why, error: '上一轮还没结束' }
    const cli = dshCliCached(cfg)
    if (!cli) {
      const msg = '这一轮没跑：找不到 dsh CLI（常见位置与应用目录都翻过了）。可在配置 dshBin 里手动填 …/@deepseek-ai/dsh/lib/bin.js'
      log(msg)
      stubReportIfMissing(1)
      return { started: false, why, error: msg }
    }
    const overlay = buildOverlay(cfg)
    const profile = String(cfg?.headlessProfile || 'headless').trim() || 'headless'
    const args = ['--profile', profile]
    if (overlay) args.push('--patch', overlay)
    args.push(buildDutyPrompt(cfg))
    log(`值班轮开跑（${why}）：profile=${profile} cli=${cli}`)
    log(`值班轮 spawn 调试：execPath=${process.execPath} resourcesPath=${process.resourcesPath || '（无）'}`)
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: HOME,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // ⭐ ELECTRON_RUN_AS_NODE：桌面版里 spawn 出去的 node 必须带，否则当 Electron 应用空退出
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BILI_FENSHEN_HOME: HOME,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    })
    running = true
    child.stdout?.on('data', appendLogChunk)
    child.stderr?.on('data', appendLogChunk)
    child.on('error', (e) => { log(`值班轮起不来：${e?.message ?? e}`); running = false })
    child.on('exit', (code) => {
      running = false
      log(`值班轮结束（${why}，code=${code}）`)
      stubReportIfMissing(code)
      rotateLogIfBig()
      // ⭐ 90 秒后复核（评论区压审对策）；不拖住宿主退出
      const t = setTimeout(() => { verifyRecentSafe('round').catch(() => {}) }, 90_000)
      t.unref?.()
    })
    bumpState({ lastRunAt: new Date().toISOString(), lastWhy: why })
    return { started: true, why, profile, cli, cwd: HOME, log: LOG_FILE }
  } catch (e) {
    running = false
    log(`值班轮开跑失败（${why}）：${e?.stack ?? e}`)
    return { started: false, why, error: String(e?.message ?? e) }
  }
}

/* ───────────────────────── 发后复核（占位：V1.5 用只读接口核对可见性） ───────────────────────── */

const verifyRecentSafe = async (why) => {
  // v1 先落日志桩：真正用 /x/v2/reply/main 复核在 V1.5 接入（需要 JS 直连 B站 + 凭证）
  try {
    const st = readJson(STATE_FILE, {})
    const lastComments = st.commentsToVerify || []
    if (!lastComments.length) return
    log(`复核桩（${why}）：待核 ${lastComments.length} 条（V1.5 接入真实复核）`)
  } catch { /* 兜住 */ }
}

/* ───────────────────────── 调度器（谷时窗口；全部兜死） ───────────────────────── */

const tick = () => {
  try {
    const cfg = refreshCfg()
    if (!cfg?.autoDuty) return
    const now = new Date()
    const st = readJson(STATE_FILE, {})
    const today = dayKey(now)
    if (countPickedToday() >= Math.max(0, Number(cfg?.perDay) || 0)) return
    for (const k of ['noon', 'night']) {
      if (!cfg?.[k]) continue
      if (!inWindow(now, WINDOWS[k])) continue
      const key = `${today}:${k}`
      if (st.windows?.[key]) continue
      bumpState({ windows: { ...(st.windows || {}), [key]: true } })
      runDuty(`window:${k}`)
      return
    }
  } catch (e) {
    log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
  }
}

/* ───────────────────────── Host 插件入口 ───────────────────────── */

export const inject = ['webServer', 'tools']

export function apply(ctx, config) {
  applyCtx = { ...ctx, config }
  cfgSnapshot = config || {}
  const disposers = []

  // ── Agent 工具：手动触发 + 状态查询 ──
  // ⭐ 工具必须声明 output { schema, render }（0.2.1 校验），且返回值必须无损 JSON。
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  try {
    const tools = ctx.get?.('tools') ?? ctx.tools
    if (tools?.register) {
      const defStatus = {
        name: 'bili_fenshen_status',
        description: '查询B站分身状态：值班配置、今日配额消耗、dsh CLI 是否可用、最近一轮结果。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        execute: async () => {
          const cfg = refreshCfg()
          const cli = dshCliCached(cfg)
          const st = readJson(STATE_FILE, {})
          return {
            home: HOME,
            autoDuty: !!cfg?.autoDuty,
            perDay: cfg?.perDay,
            today: { picked: countPickedToday(), comments: countCommentsToday(), likes: countLikesToday(), dynamics: countDynamicsToday() },
            dutyCli: cli || '（未找到，可配置 dshBin）',
            running,
            lastRunAt: st.lastRunAt || '',
            lastWhy: st.lastWhy || '',
            reportToday: join(OUT_DIR, dayKey() + '.md'),
          }
        },
      }
      const defRun = {
        name: 'bili_fenshen_run',
        description: '让B站分身立刻跑一轮值班（拉内容源→读字幕→按章程评论/点赞/发动态→写报告）。'
          + '同轮进行中会拒绝重复触发。',
        parameters: { type: 'object', properties: { why: { type: 'string', description: '触发原因，默认 manual' } }, additionalProperties: false },
        output: textOutput,
        execute: async (args) => safe(runDuty(String(args?.why || 'manual'))),
      }
      disposers.push(tools.register(defStatus))
      disposers.push(tools.register(defRun))
    } else {
      log('tools 服务不可用：手动触发工具未注册（仅影响工具入口，不影响调度）')
    }
  } catch (e) { log(`注册工具失败（已兜住）：${e?.message ?? e}`) }

  // ── webServer 路由（V2 页面的数据源）：单条 prefix 路由，内部按 method+path 分发 ──
  // ⭐ 0.2.1 的 register 语义：{ kind:'prefix', path, handler(req,res) } —— Node 原始风格（非 fetch 风格）。
  try {
    const web = ctx.get?.('webServer') ?? ctx.webServer
    if (web?.register) {
      const sendJson = (res, status, data) => {
        try {
          const body = JSON.stringify(data, null, 2)
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(body)
        } catch { /* 客户端断开等，兜住 */ }
      }
      const readBody = async (req) => {
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch { return {} }
      }
      const handle = async (req, res, url) => {
        const path = url.pathname
        if (req.method === 'GET' && path === '/api/bili-fenshen/status') {
          const cfg = refreshCfg()
          const st = readJson(STATE_FILE, {})
          const cli = dshCliCached(cfg)
          return sendJson(res, 200, {
            ok: true, home: HOME, running,
            autoDuty: !!cfg?.autoDuty,
            quota: { perDay: cfg?.perDay, comments: cfg?.commentsPerDay, likes: cfg?.likesPerDay, dynamics: cfg?.dynamicsPerDay, replies: cfg?.repliesPerRound },
            today: { picked: countPickedToday(), comments: countCommentsToday(), likes: countLikesToday(), dynamics: countDynamicsToday() },
            lastRunAt: st.lastRunAt || '', lastWhy: st.lastWhy || '',
            dutyCli: cli || '',
            reportToday: join(OUT_DIR, dayKey() + '.md'),
            logFile: LOG_FILE,
          })
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/run') {
          return sendJson(res, 200, runDuty('web'))
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/report') {
          try {
            const day = /^\d{4}-\d{2}-\d{2}$/.test(String(url.searchParams.get('day') || '')) ? url.searchParams.get('day') : dayKey()
            const f = join(OUT_DIR, `${day}.md`)
            return sendJson(res, 200, { day, text: existsSync(f) ? readFileSync(f, 'utf8') : '' })
          } catch (e) { return sendJson(res, 500, { error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/log') {
          try { return sendJson(res, 200, { text: existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').slice(-8000) : '' }) }
          catch (e) { return sendJson(res, 500, { error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/login/start') {
          try {
            const s = await loginStart()
            // 本地画码：venv 的 Python qrcode 库（bili-scroll 同款思路），存到插件家目录
            let qrImage = ''
            try {
              const png = join(HOME, 'login-qr.png')
              await new Promise((resolve) => {
                const child = spawn(join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'),
                  ['-c', 'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])', s.url, png],
                  { cwd: HOME, windowsHide: true })
                child.on('exit', (c) => resolve(c === 0))
                child.on('error', () => resolve(false))
              })
              if (existsSync(png)) qrImage = '/api/bili-fenshen/login/qr.png'
            } catch { /* 画码失败，前端退回外链渲染 */ }
            return sendJson(res, 200, { ok: true, key: s.key, url: s.url, qrImage })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/login/qr.png') {
          try {
            const png = join(HOME, 'login-qr.png')
            if (!existsSync(png)) { res.writeHead(404); res.end('no qr'); return }
            const data = readFileSync(png)
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
            res.end(data)
          } catch { try { res.writeHead(500); res.end() } catch { /* 兜住 */ } }
          return
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/login/poll') {
          try { return sendJson(res, 200, await loginPoll()) }
          catch (e) { return sendJson(res, 500, { state: 'unknown', message: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/cred') {
          try { return sendJson(res, 200, { exists: existsSync(BILI_CRED_FILE) }) }
          catch { return sendJson(res, 200, { exists: false }) }
        }
        return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
      }
      disposers.push(web.register({
        kind: 'prefix',
        path: '/api/bili-fenshen',
        handler: async (req, res) => {
          try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
            sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
          }
        },
      }))
    } else {
      log('webServer 服务不可用：HTTP 路由未挂（仅影响 V2 页面，不影响调度）')
    }
  } catch (e) { log(`注册 webServer 路由失败（已兜住）：${e?.message ?? e}`) }

  // ── 调度器：60 秒巡窗 ──
  const timer = setInterval(tick, 60_000)
  timer.unref?.()
  disposers.push(() => { try { clearInterval(timer) } catch { /* 兜住 */ } })

  log(`dsh-bili-fenshen host 已激活（home=${HOME}，autoDuty=${!!cfgSnapshot?.autoDuty}）`)

  return () => {
    for (const d of disposers.reverse()) {
      try { d?.() } catch { /* 卸载兜底 */ }
    }
    applyCtx = null
  }
}
