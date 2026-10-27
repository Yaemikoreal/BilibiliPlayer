/**
 * dsh-bili-fenshen —— Host 半部
 *
 * 值班调度：定时/手动拉起 headless dsh 会话，按章程混迹B站（看/评/赞/动态）。
 * 设计移植自 dsh-bili-scroll 的成熟模式（详见各处注释），行为集按本项目章程适配。
 *
 * 本版（0.4.0）把纯逻辑拆到 lib/*.js（账本/报告兜底/活动聚合/配置/回复拉取/账号/路由工厂），
 * index.js 只做接线：调度、spawn、轮次生命周期、路由挂载、工具注册。
 *
 * 纪律（全部来自参考项目的实测事故）：
 * - 任何 import 失败都不能让整条插件不激活 ⇒ schemastery 等可选依赖一律优雅降级；
 * - 定时器回调与所有文件写入必须 try/catch 兜死 ⇒ 插件再错也只该"这一轮没跑成"；
 * - 找不到 dsh CLI 就明确报缺失，绝不裸 spawn `dsh`；
 * - 每条路由独立 try/catch；prefix 路由只注册一次（同进程守卫）；
 * - 子进程引用必须保存（供 POST /stop），exit 后清空。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ⭐ lib/* 是本插件的纯逻辑模块（package.json files 已带上）；任何加载失败都按可选依赖降级
import { appendEvents, readEvents, isDuplicate } from './lib/ledger.js'
import { parseRoundReport } from './lib/report.js'
import { createApiHandler } from './lib/api.js'
import { effectiveConfig, writeOverride, extractConfigBlock, pickReasoningEffort } from './lib/config.js'
import { fetchAccount } from './lib/account.js'
import { fetchReplyNotifs, toReplyIn, roundIdForReply } from './lib/replies.js'
import { seenListFromLedger } from './lib/seen.js'
import { loadPersona } from './lib/persona.js'
import {
  resolvePersona, seedIfEmpty, guardPrompt, personaHealth, previewPersona,
  listPresets, savePersonaCard, loadBank, bankStats, readActive, writeActive, l0Checks, SPEC,
  loadCard, listVersions, readVersion, normalizeBank, resolveLoreIndex, lorePath, loadState,
  editExpressionBank, editLoreIndex, writeLoreBody,
  processGrowth,
} from './lib/persona/index.js'
import { toActivities, dayKeyOf } from './lib/activity.js'
import { runDiagnose, formatDiagnoseText } from './lib/diagnose.js'
import { createLiveStream } from './lib/live.js'

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
// 跨平台 venv 解释器：Windows 在 .venv/Scripts/python.exe，macOS/Linux 在 .venv/bin/python；
// 按存在性择优，找不到时回退平台默认（保证 spawn 至少有明确报错路径）。
const VENV_PYTHON = (() => {
  const candidates = process.platform === 'win32'
    ? [join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'), join(PROJECT_ROOT, '.venv', 'bin', 'python')]
    : [join(PROJECT_ROOT, '.venv', 'bin', 'python'), join(PROJECT_ROOT, '.venv', 'bin', 'python3'), join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
})()

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
  /** 每轮最多主动接几条别人的话（楼中楼回复别人的评论；0 = 关） */
  replyOthersPerRound: z.natural().default(2),
  /** 关注关键词（空 = 用章程默认） */
  keywords: z.array(z.string()).default([]),
  /** 订阅 UP 主 UID 列表（指定优先，可留空） */
  followUids: z.array(z.natural()).default([]),
  /** 自动拉取「我关注的 UP 主」列表（bili_followings；免手填 UID） */
  followAuto: z.boolean().default(true),
  /** 每轮从关注列表随机抽查几个 UP 主的最新投稿（0 = 不抽查） */
  followPerRound: z.natural().default(8),
  /** 不看清单：BV号 / UP主 / 标题关键词（命中整条跳过） */
  avoidList: z.array(z.string()).default([]),
  /** 默认禁令开关（true=生效；都是用户在控制台里可改的） */
  banPrivacy: z.boolean().default(true),
  banImpersonation: z.boolean().default(true),
  banControversy: z.boolean().default(true),
  banRepeat: z.boolean().default(true),
  banReplyRefusal: z.boolean().default(true),
  /** 是否允许纯文本感想动态（false = 动态只发「分享视频 + 短评」） */
  dynamicPureText: z.boolean().default(true),
  /** 人设提示词（留空 = 中性说话；可填一段文字或一个文件路径） */
  personaPrompt: z.string().default(''),
  /** 人设自演化：值班轮沉淀候选（bili_persona_note）→ 宿主质检入库 */
  growthEnable: z.boolean().default(true),
  /** 每天自动转正的候选上限（FIFO；0 = 只收候选不自动转正） */
  growthAutoPromote: z.natural().default(3),
  /** 日报形态：full=完整 · brief=薄版 · off=不写 */
  reportLevel: z.string().default('full'),
  /** dsh 的 bin.js 路径（不填自动探测） */
  dshBin: z.string().default(''),
  /** headless 那一轮用哪个 profile（desktop 被 Electron 独占，必须用独立 profile） */
  headlessProfile: z.string().default('headless'),
  /** 值班轮模型 provider（留空 = 跟随当前会话默认模型） */
  modelProvider: z.string().default(''),
  /** 值班轮模型 id（留空 = 跟随当前会话默认模型） */
  modelName: z.string().default(''),
  /** 值班轮推理强度（留空 = 不覆盖） */
  modelReasoningEffort: z.string().default(''),
  /** MCP 白名单：值班轮可见的工具（BILI_MCP_TOOLS） */
  dutyTools: z.array(z.string()).default([
    'bili_search', 'bili_hot_videos', 'bili_weekly_hot', 'bili_rank',
    'bili_followings', 'bili_user_videos', 'bili_video_info', 'bili_subtitle', 'bili_comments',
    'bili_reply', 'bili_like', 'bili_send_dynamic', 'bili_check_credential',
    'bili_received_replies', 'bili_user_info',
    'bili_persona_note', // 人设自演化：沉淀候选（growthEnable=false 时 overlay 自动剔除）
  ]),
})

/* ───────────────────────── 路径与状态 ───────────────────────── */

// ⭐ 家目录可被 BILI_FENSHEN_HOME 覆盖（端到端验证时指向临时目录，不污染真实数据）
const HOME = process.env.BILI_FENSHEN_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'bili-fenshen')
const OUT_DIR = join(HOME, 'out')
const DIGEST_DIR = join(HOME, 'digest')
const PROMPTS_DIR = join(pluginDir, 'prompts')
const LOG_FILE = join(HOME, 'duty.log')
const STATE_FILE = join(HOME, 'state.json')
const OVERLAY_FILE = join(HOME, 'headless-overlay.yml')
const LEDGER_FILE = join(HOME, 'ledger.jsonl')   // 机器账本（设计文档 §4）
const CONFIG_FILE = join(HOME, 'config.json')    // 运行时配置覆盖层（§12.3）

// ⭐ 实时运行流：内存环形缓冲（值班轮 stdout/stderr + 宿主事件），供 /live 与 /live/stream 消费。
//    全局单例：跨轮保留最后一批事件，页面刷新后仍能看到上一轮尾部。
const live = createLiveStream()

// profile 根目录：桌面版由 DSH_PROFILE_DIR 指向 …/profiles/desktop，取其父目录；否则退回 ~/.dsh/profiles
const PROFILE_ROOT = (() => {
  try {
    if (process.env.DSH_PROFILE_DIR) return dirname(process.env.DSH_PROFILE_DIR)
    return join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'profiles')
  } catch { return '' }
})()
const headlessProfileDirOf = (cfg) => (PROFILE_ROOT
  ? join(PROFILE_ROOT, String(cfg?.headlessProfile || 'headless').trim() || 'headless')
  : '')

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
  // ⭐ 同时推进实时流：控制台「实时」页无需轮询日志文件即可看到宿主事件
  try { live.pushHost(msg) } catch { /* 实时流失败不能影响日志 */ }
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

/* ───────────────────────── 生效配置（patch ← config.json 覆盖层，设计文档 §12.3） ───────────────────────── */

// ⭐ 每次都重读覆盖层 ⇒ 操作台保存后，调度器与下一轮值班立即用新值（无需重启）
const effCfg = () => effectiveConfig(cfgSnapshot || {}, CONFIG_FILE).values

/* ───────────────────────── 今日配额（账本是唯一事实来源，设计文档 §4.1） ─────────────────────────
 * 旧版按报告正则计数有两处硬伤：`^### BV` 无 m 标志只匹配文件起点（永远数 0）；
 * 「评论：已发 / 赞过 / 动态：已发」等标记与 Agent 实际报告格式（「动作：点赞；评论（rpid …）」）不符。
 * 全部废弃 —— 改按账本事件按本地日计数：view=挑中、comment=评论、like=点赞、dynamic=动态。
 */
const quotaFromLedger = () => {
  const day = dayKey()
  const acc = { picked: 0, comments: 0, likes: 0, dynamics: 0, replies: 0, repliesProactive: 0 }
  try {
    for (const e of readEvents(LEDGER_FILE)) {
      if (dayKeyOf(e.t) !== day) continue
      if (e.type === 'view') acc.picked++
      else if (e.type === 'comment') acc.comments++
      else if (e.type === 'like') acc.likes++
      else if (e.type === 'dynamic') acc.dynamics++
      else if (e.type === 'reply-out') {
        acc.replies++
        if (e.kind === 'proactive') acc.repliesProactive++
      }
    }
  } catch { /* 账本读不到 ⇒ 全 0，不拖垮调用方 */ }
  return acc
}

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

/* ───────────────────────── 值班轮（轮次生命周期，设计文档 §12.4） ───────────────────────── */

let running = false
let starting = false // 正在做 spawn 前的异步准备（模型能力查询），防并发重复触发
let applyCtx = null
let cfgSnapshot = {}
let currentChild = null
let currentRoundId = null
let currentRoundAt = 0
let routeRegistered = false   // prefix 路由同进程一次性守卫（§12.2）

const refreshCfg = () => {
  // cfgSnapshot 在 apply() 里已由 Loader 校验后的 config 赋值；这里只保证返回最新快照
  // （⭐ 不能把 ctx 展开成普通对象：ctx.get 等是原型方法，展开后会丢，导致 agentDefaultModel/llm 查不到）
  return cfgSnapshot
}

// ⭐ POST /stop：SIGTERM，2s 后补刀，等 exit 走同一收尾路径
const stopDuty = () => {
  if (!currentChild) return { ok: true, stopped: false }
  try {
    currentChild.kill('SIGTERM')
    setTimeout(() => { try { currentChild?.kill('SIGKILL') } catch { /* 已退出 */ } }, 2000).unref?.()
    log('收到中止请求：已发送 SIGTERM（2s 后未退出则强杀）')
  } catch (e) {
    log(`中止本轮失败：${e?.message ?? e}`)
  }
  return { ok: true, stopped: true }
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
    if (String(effCfg().reportLevel || 'full') === 'off') return
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

/* ───────────────────────── 报告兜底回填（设计文档 §4.3） ───────────────────────── */

const backfillFromReport = (roundId) => {
  try {
    const existing = readEvents(LEDGER_FILE)
    const day = dayKey()
    const f = join(OUT_DIR, `${day}.md`)
    if (!existsSync(f)) return
    const text = readFileSync(f, 'utf8')
    const { views, skips } = parseRoundReport(text, { round: roundId })
    const events = []
    for (const v of views) {
      events.push({ t: v.t, round: roundId, type: 'view', bvid: v.bvid, title: v.title, author: v.author, views: v.views, duration: v.duration, grade: v.grade, source: 'report' })
      for (const a of v.actions) {
        events.push({ t: v.t, round: roundId, ...a, bvid: v.bvid, source: 'report' })
      }
    }
    for (const s of skips) events.push({ ...s, round: roundId, type: 'skip' })
    const fresh = events.filter((e) => !isDuplicate(existing, e))
    if (fresh.length) {
      appendEvents(LEDGER_FILE, fresh)
      log(`报告兜底回填 ${fresh.length} 条事件（round=${roundId}）`)
    }
  } catch (e) {
    log(`报告兜底回填失败：${e?.message ?? e}`)
  }
}

/* ───────────────────────── 值班轮模型（插件配置优先，否则跟随当前会话默认） ───────────────────────── */

// ⭐ 三种选择途径：① 插件配置 modelProvider+modelName；② agentDefaultModel 当前选择；③ 都没有 ⇒ 空（headless 用内置行）
const currentSelectionSafe = () => {
  try { return applyCtx?.get?.('agentDefaultModel')?.currentSelection?.() ?? null } catch { return null }
}
const effectiveModel = (cfg) => {
  const provider = String(cfg?.modelProvider || '').trim()
  const model = String(cfg?.modelName || '').trim()
  if (provider && model) {
    return { mode: 'config', provider, model, reasoningEffort: String(cfg?.modelReasoningEffort || '').trim() }
  }
  const sel = currentSelectionSafe() || {}
  return {
    mode: 'default',
    provider: sel.provider ?? sel.providerId ?? '',
    model: sel.model ?? sel.modelId ?? '',
    reasoningEffort: sel.reasoningEffort ?? '',
  }
}

// ⭐ 模型能力（推理强度）查询：异步、失败返回 null（未知）。空数组 = 该模型没有推理强度。
//    为什么必须查：headless dsh 对不支持的显式强度直接报 UNSUPPORTED_REASONING_EFFORT 并退轮（2026-10-25 事故）。
const resolveModelEfforts = async (provider, model) => {
  try {
    if (!provider || !model) return null
    const llm = llmService()
    if (!llm?.resolveModelInfo) return null
    const info = await withTimeout(Promise.resolve(llm.resolveModelInfo(provider, model)), 5000)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts)) return []
    return efforts.map((x) => String(x?.id ?? x ?? '').trim()).filter(Boolean)
  } catch { return null }
}

// ⭐ 生效模型：模型不支持某个推理强度时就不设置它（不强行下发），其余原样。
const resolveEffectiveModel = async (cfg) => {
  const em = effectiveModel(cfg)
  if (!em.provider || !em.model || !em.reasoningEffort) return em
  const supported = await resolveModelEfforts(em.provider, em.model)
  const picked = pickReasoningEffort(em.reasoningEffort, supported)
  if (!picked.ignored) return em
  log(`overlay：模型 ${em.provider} / ${em.model} 不支持推理强度 ${picked.ignored}，本轮不设置该项`)
  return { ...em, reasoningEffort: '' }
}

const buildOverlay = (cfg, em) => {
  const yml = []
  // ⭐ headless（0.2.1-rc.2）默认禁用三个服务 ⇒ overlay 是最后一层，把它们打开
  for (const id of ['credentials', 'authorization', 'deepseek-account']) {
    yml.push(`- id: ${id}`, '  disabled: false', '')
  }
  // ⭐ 值班轮模型：插件配置优先（操作台「模型」组可改），留空则跟随用户当前选择。
  //    provider 行定义仍需带进 headless（见下）：① headless profile（dsh-base+dsh-headless）只内置 deepseek 系
  //    provider 行，没有用户的自定义 provider；② 直接 insert dsh-llm-pi-ai 会撞 "provider already declared"；
  //    ③ 正确做法：对 **同名行 llm-pi-ai 做配置覆盖**（provider 定义随之激活）。
  //    em 由 runDuty 传入：已按模型能力净化过推理强度（不支持的不写，避免 headless 报 UNSUPPORTED_REASONING_EFFORT）。
  if (em.provider && em.model) {
    const lines = ['- id: agent-default-model', '  config:', `    provider: ${em.provider}`, `    model: ${em.model}`]
    if (em.reasoningEffort) lines.push(`    reasoningEffort: ${em.reasoningEffort}`)
    lines.push('')
    yml.push(...lines)
    log(`overlay：值班轮模型 = ${em.provider} / ${em.model}${em.reasoningEffort ? ` / ${em.reasoningEffort}` : ''}（${em.mode === 'config' ? '插件配置' : '跟随默认'}）`)
  } else {
    log('overlay：没有拿到可用模型（插件未配置且当前默认选择为空），headless 将用内置 deepseek 行')
  }
  // provider 行定义：从桌面版 profile 的 cordis.patch.yml 读 llm-pi-ai 配置（用户自己配的 key/模型），
  // 原样覆盖进 headless 的同名行。读不到就不覆盖（那时只能用 deepseek 系内置行）。
  try {
    // ⭐ 桌面版 profile 的 patch 路径：优先用 PROFILE_ROOT（由 DSH_PROFILE_DIR 推导，缺省 ~/.dsh/profiles）
    const profilePatchPath = join(PROFILE_ROOT || '.', 'desktop', 'cordis.patch.yml')
    const profilePatch = readFileSync(profilePatchPath, 'utf8')
    // ⭐ 不能用正则：旧正则在这份 patch 上会灾难性回溯，同步卡死宿主（2026-10-25 事故根因）。
    const providerCfg = extractConfigBlock(profilePatch, 'llm-pi-ai')
    if (providerCfg) {
      yml.push('- id: llm-pi-ai', '  config:', providerCfg, '')
      log('overlay：已把桌面版 llm-pi-ai provider 配置带入 headless')
    } else {
      log(`overlay：profile（${profilePatchPath}）里没找到 llm-pi-ai 段（headless 轮将依赖内置 deepseek 行）`)
    }
  } catch (e) {
    log(`overlay：读 profile provider 配置失败（不影响其余 overlay）：${e?.message ?? e}`)
  }
  // ⭐ 白名单收窄的 MCP（配合 mcp_server.py 的 BILI_MCP_TOOLS 门禁；凭证走独立 env 路径）
  const posix = (p) => String(p).replace(/\\/g, '/')
  const venvPython = VENV_PYTHON.replace(/\\/g, '/')
  const serverPy = join(PROJECT_ROOT, 'mcp_server.py').replace(/\\/g, '/')
  const tools = Array.isArray(cfg?.dutyTools) && cfg.dutyTools.length ? cfg.dutyTools.slice() : ['bili_search', 'bili_video_info']
  // ⭐ 自动拉关注依赖 bili_followings：开了 followAuto 就确保白名单里有它（老配置的 dutyTools 是旧的冻结列表）
  if (cfg?.followAuto !== false && !tools.includes('bili_followings')) tools.push('bili_followings')
  // ⭐ 人设自演化：开了 growth 管道才把沉淀工具给值班轮（老配置的冻结列表也要能拿到它）
  if (cfg?.growthEnable !== false && !tools.includes('bili_persona_note')) tools.push('bili_persona_note')
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
    `          BILI_FENSHEN_HOME: '${HOME.replace(/\\/g, "/")}'`,
    "          PYTHONUTF8: '1'",
    "          PYTHONIOENCODING: 'utf-8'",
    '',
  )
  try { writeFileSync(OVERLAY_FILE, yml.join('\n'), 'utf8'); return OVERLAY_FILE } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
}

export const buildDutyPrompt = (cfg, roundId, ledgerEvents = []) => {
  const charter = (() => {
    try { return readFileSync(join(PROMPTS_DIR, 'duty.md'), 'utf8').split('<家目录>').join(HOME) } catch { return '' }
  })()
  // 人设：唯一入口是 lib/persona/index.js 的 resolvePersona。
  //   - 配置里有 personaPrompt（正文/文件路径）⇒ **legacy 直通**，行为与升级前完全一致；
  //   - 否则读 <家目录>/persona/active.json（默认 preset:whale），编译成
  //     「前段（身份 + 见闻索引）」与「后段（今日状态 + 语料样本 + 最后一公里）」两部分：
  //     前段放章程之前（事实），后段放整轮 prompt 最末尾（行为贴生成点）。
  const personaRes = resolvePersona({ cfg, events: ledgerEvents, roundId, modeMax: 100 })
  if (personaRes.notes?.length) log(`人设：${personaRes.notes.join('；')}`)
  const personaBlock = personaRes.before
  const personaAfter = personaRes.after || ''

  const q = quotaFromLedger()
  const picked = q.picked
  const quota = Math.max(0, Number(cfg?.perDay) || 0)
  const left = Math.max(0, quota - picked)
  const kws = Array.isArray(cfg?.keywords) ? cfg.keywords.filter(Boolean) : []
  const uids = Array.isArray(cfg?.followUids) ? cfg.followUids.filter(Boolean) : []
  const avoid = Array.isArray(cfg?.avoidList) ? cfg.avoidList.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  // ⭐ 已看过清单：宿主从账本算好的硬判重（设计文档 2026-10-27-proactive-reply-dedup §4）
  const seenBvs = seenListFromLedger(ledgerEvents)
  const report = cfg?.reportLevel === 'off'
    ? '本轮不写日报文件，只把做过的动作记进判重表。'
    : cfg?.reportLevel === 'brief'
      ? `日报写到 ${join(OUT_DIR, dayKey() + '.md')}（薄版：每条一两行）。`
      : `报告写到 ${join(OUT_DIR, dayKey() + '.md')}（完整版；已有内容追加到末尾）。`

  // ⭐ 默认禁令开关：true=生效（不传 = 生效），false=本轮不执行。用户可在控制台改。
  const on = (v) => v !== false
  const flag = (v, onText, offText) => (on(v) ? `✅ ${onText}` : `⛔ ${offText}`)
  const switchLines = [
    `- 不透露隐私（账号 / 机器路径 / 用户名 / 聊天内容）：${flag(cfg?.banPrivacy, '生效', '已关闭 —— 本轮不做这条限制')}`,
    `- 不冒充任何真实存在的人：${flag(cfg?.banImpersonation, '生效', '已关闭 —— 本轮不做这条限制')}`,
    `- 不碰争议话题（立场 / 性别 / 地域 / 引战）：${flag(cfg?.banControversy, '生效', '已关闭 —— 本轮自行判断')}`,
    `- 同视频只评一次 / 不刷屏 / 动态不连发：${flag(cfg?.banRepeat, '生效', '已关闭 —— 仍受配额与质量要求约束')}`,
    `- 不接敏感请求（写代码 / 做作品 / 承诺任何事 / 贴隐私 / 与视频无关的请求）：${flag(cfg?.banReplyRefusal, '生效', '已关闭 —— 本轮自行判断')}`,
    `- 纯文本感想动态：${on(cfg?.dynamicPureText) ? '✅ 允许（全天最多一条）' : '⛔ 不允许 —— 动态只发「分享视频 + 一句短评」'}`,
  ]
  // ⭐ 关注 UP 主：手动 UID 优先；没指定（或额外）时按「最常访问」拉常看的 UP 主
  const followAuto = on(cfg?.followAuto)
  const followN = cfg?.followPerRound === undefined ? 8 : Math.max(0, Number(cfg.followPerRound) || 0)
  const followParts = []
  if (uids.length) followParts.push(`指定 UID：${uids.join('、')}（优先；用 bili_user_videos 逐个拉最新投稿，order=pubdate）`)
  if (followAuto && followN > 0) {
    followParts.push(`用 bili_followings 按「最常访问」排序（sort=attention，ps=50）拉我常看的 UP 主，取前 ${followN} 个`
      + '（这些的最新投稿都看过/没有新的，就按顺序往后顺延取），再用 bili_user_videos 逐个拉最新投稿（order=pubdate）')
  }
  const sourceLines = [
    `  1. 订阅 UP 主的新投稿（${followParts.length ? followParts.join('；') : '自动拉关注已关闭且没指定 UID，跳过这一档'}）`,
    `  2. 关键词搜索（${kws.length ? kws.join('、') + '，用 bili_search，近 7 天优先' : '未配置，跳过这一档'}）`,
    `  3. 热门榜兜底（bili_hot_videos）`,
  ]
  const avoidBlock = avoid.length
    ? '不看清单（命中任意一条就整条跳过：不读字幕、不点赞、不评论、不发动态；跳过理由写「不看清单：<命中条目>」）：\n'
      + avoid.map((x, i) => `  ${i + 1}. ${x}`).join('\n')
      + '\n  命中规则：BV 号完全相同 / UP 主名或 UID 命中 / 标题包含该词（不区分大小写）。'
    : '不看清单：（空）'

  const prompt = `你是这个账号的用户本人——一个独立、有自己判断的普通网友。现在按自己的兴趣刷一轮B站，看到值得的留下点痕迹。`
    + personaBlock
    + (charter
      ? `\n===== 值班章程（<家目录> 已替换为真实路径）—— 严格按它执行 =====\n\n${charter}\n===== 章程结束 =====\n\n`
      : `然后读章程 ${join(PROMPTS_DIR, 'duty.md')}（章程里的 <家目录> 指 ${HOME}），严格按它执行。\n\n`)
    + `本轮参数：\n`
    + `- 记账：本轮 round id = ${roundId}（账本 ${LEDGER_FILE} 事件的 round 字段用这个值）；账本绝对路径 = ${LEDGER_FILE}。\n`
    + `- 报告：${report}\n`
    + `- 配额（全天总量）：挑中 ${quota} 条（今天已挑 ${picked} ⇒ 本轮最多再挑 ${left} 条）；`
    + `评论 ${Math.max(0, Number(cfg?.commentsPerDay) || 0)} 条/天（今天已 ${q.comments}），本轮最多 ${Math.max(0, Number(cfg?.commentsPerRound) || 0)} 条；`
    + `点赞 ${Math.max(0, Number(cfg?.likesPerDay) || 0)} 个/天（今天已 ${q.likes}）；`
    + `动态 ${Math.max(0, Number(cfg?.dynamicsPerDay) || 0)} 条/天（今天已 ${q.dynamics}）；`
    + `跟进回复本轮最多 ${Math.max(0, Number(cfg?.repliesPerRound) || 0)} 条；`
    + `主动接话本轮最多 ${Math.max(0, Number(cfg?.replyOthersPerRound ?? 2))} 条（0 = 本轮不接）。\n`
    + `- 已看过清单（宿主从账本算好，最近 14 天，命中 = 之前看过/评过/赞过/跳过过）：`
    + (seenBvs.length ? `${seenBvs.join('、')}。\n`
        + `  命中的候选**直接丢**：不读信息、不读字幕、不点赞不评论、不进报告、不记判重表（账本里本来就有，别再花任何调用）。\n`
      : '（空——账本里还没有看过的记录，照常逐条判。）\n')
    + `- 内容源（按这个优先级拉；上一档挑够或没有可看的，再看下一档）：\n${sourceLines.join('\n')}\n`
    + `- ${avoidBlock}\n`
    + `- 本轮开关（与章程/人设冲突时以本节为准）：\n${switchLines.map((x) => '  ' + x).join('\n')}\n`
    + `- 评论口吻：像普通观众随口一句——短、口语、只抓一个点。**收在情绪/问题/梗上，不要收在判断上**（「…欠得很」「…一下就说死了」这种判断句没人能接）；「原来 A 是 B」改写成「我以为 A，结果 B」；复述视频里的点必须再创作一层（场景复现/类比/追问），写不出就不发；别为「像人」而扩写。不要提「小号 / 分身 / 值班 / 运营 / 账号主人」。\n`
    + `- 你的 MCP 工具带 bili- 前缀（如 bili_search / bili_subtitle / bili_reply / bili_like / bili_send_dynamic）。\n`
    + `- 判重表 = ${join(HOME, 'seen.md')}（绝对路径，别写错地方）；归档 = ${join(DIGEST_DIR, dayKey().slice(0, 7) + '.md')}。\n`
    + `- 完成后：报告（按章程契约）+ 判重表，最后用一句话汇报本轮做了什么。现在几点了自己看一眼系统时间。`
    + personaAfter

  // 预算守卫：prompt 走 argv（Windows 命令行上限 32,767 字符），超硬线直接丢弃人设后段
  const g = guardPrompt(prompt)
  if (g.level !== 'ok') log(`值班 prompt ${g.len} 字符（${g.level}；软线 ${g.softMax} / 硬线 ${g.hardMax}）`)
  if (g.level === 'over' && personaAfter) {
    log('值班 prompt 超硬线：本轮丢弃人设后段（今日状态/语料/最后一公里），保留身份与章程')
    return prompt.slice(0, prompt.length - personaAfter.length)
  }
  return prompt
}

const runDuty = async (why = 'manual') => {
  try {
    const cfg = effCfg()
    // ⭐ 首次运行播种：没有 active.json / 没有用户卡 / 也没配旧 personaPrompt ⇒ 默认鲸鱼娘
    try {
      const seeded = seedIfEmpty({ legacyPrompt: cfg?.personaPrompt })
      if (seeded.seeded) log('首次运行：已播种默认人设 whale（开箱即用）')
    } catch (e) { log(`人设播种失败：${e?.message ?? e}`) }
    // ⭐ 人设自演化：值班轮启动前先消化沉淀候选（质检→入库→限量转正）；失败绝不阻断值班
    try {
      const g = processGrowth({ cfg, events: readEvents(LEDGER_FILE) })
      const s = g?.stats
      if (s && (s.received || s.promoted || s.demoted)) {
        log(`自生长：候选 ${s.received} · 语料+${s.acceptedCorpus} · 见闻+${s.acceptedLore} · 拒 ${s.rejected} · 转正 ${s.promoted} · 降级 ${s.demoted} · 清理 ${s.removed} · 过期 ${s.expired}`)
      }
    } catch (e) { log(`自生长管道失败（不阻断值班）：${e?.message ?? e}`) }
    if (running || starting) return { started: false, why, error: '上一轮还没结束' }
    const cli = dshCliCached(cfg)
    if (!cli) {
      const msg = '这一轮没跑：找不到 dsh CLI（常见位置与应用目录都翻过了）。可在配置 dshBin 里手动填 …/@deepseek-ai/dsh/lib/bin.js'
      log(msg)
      stubReportIfMissing(1)
      return { started: false, why, error: msg }
    }
    const roundId = new Date().toISOString()
    // ⭐ 实时流先开：overlay 生成、spawn 调试、子进程输出都会进「实时」页
    try { live.start({ roundId, startedAt: roundId, why }) } catch { /* 实时流失败不阻断值班 */ }
    // ⭐ 模型能力查询是异步的（最多 5s）：期间标记 starting 防并发；冲突则按“上一轮还没结束”拒绝。
    starting = true
    const em = await resolveEffectiveModel(cfg)
    starting = false
    if (running) return { started: false, why, error: '上一轮还没结束' }
    const overlay = buildOverlay(cfg, em)
    const profile = String(cfg?.headlessProfile || 'headless').trim() || 'headless'
    const args = ['--profile', profile]
    if (overlay) args.push('--patch', overlay)
    args.push(buildDutyPrompt(cfg, roundId, readEvents(LEDGER_FILE)))
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
    // ⭐ 轮次生命周期：保存子进程引用（供 /stop），记录轮次 id 与开始时刻
    currentChild = child
    currentRoundId = roundId
    currentRoundAt = Date.now()
    child.stdout?.on('data', (buf) => { appendLogChunk(buf); try { live.pushChildChunk(buf) } catch { /* 实时流失败不影响日志 */ } })
    child.stderr?.on('data', (buf) => { appendLogChunk(buf); try { live.pushChildChunk(buf) } catch { /* 同上 */ } })
    child.on('error', (e) => {
      log(`值班轮起不来：${e?.message ?? e}`)
      running = false
      currentChild = null
      try { live.end({ code: null, durationMs: Date.now() - currentRoundAt }) } catch { /* 兜住 */ }
    })
    child.on('exit', (code) => {
      running = false
      const durationMs = Date.now() - currentRoundAt
      currentChild = null
      log(`值班轮结束（${why}，code=${code}）`)
      try { live.end({ code, durationMs }) } catch { /* 兜住 */ }
      try {
        appendEvents(LEDGER_FILE, [{ t: new Date().toISOString(), round: currentRoundId, type: 'round-end', code, durationMs }])
        backfillFromReport(currentRoundId)
      } catch (e) { log(`写 round-end 失败：${e?.message ?? e}`) }
      stubReportIfMissing(code)
      rotateLogIfBig()
      bumpState({ lastRunAt: new Date().toISOString(), lastWhy: why, lastCode: code, lastDurationMs: durationMs })
      // ⭐ 90 秒后复核（评论区压审对策）；不拖住宿主退出
      const t = setTimeout(() => { verifyRecentSafe('round').catch(() => {}) }, 90_000)
      t.unref?.()
    })
    bumpState({ lastRunAt: new Date().toISOString(), lastWhy: why })
    return {
      started: true, why, roundId, profile, cli, cwd: HOME, log: LOG_FILE,
      model: { provider: em.provider, model: em.model, reasoningEffort: em.reasoningEffort },
    }
  } catch (e) {
    starting = false
    running = false
    currentChild = null
    try { live.end({ code: null, durationMs: 0 }) } catch { /* 兜住 */ }
    log(`值班轮开跑失败（${why}）：${e?.stack ?? e}`)
    return { started: false, why, error: String(e?.message ?? e) }
  }
}

/* ───────────────────────── 回复轮询器（设计文档 §4.4，每 5 分钟） ───────────────────────── */

const readCred = () => {
  try {
    const raw = JSON.parse(readFileSync(BILI_CRED_FILE, 'utf8'))
    return raw?.sessdata ? raw : null
  } catch {
    return null
  }
}

// 归属轮次：roundIdForReply 已收口进 lib/replies.js（comment + reply-out 的 rpid 都能归属，
// 见设计文档 2026-10-27-proactive-reply-dedup §5）

const replyTick = async () => {
  try {
    const cred = readCred()
    if (!cred) return
    const events = readEvents(LEDGER_FILE)
    // 「我的话」= 近 7 天的评论 + 接话/回复；一样都没有就省掉这次 API 轮询
    const recentMine = events.filter((e) => (e.type === 'comment' || e.type === 'reply-out') && e.rpid && Date.now() - Date.parse(e.t) < 7 * 86400_000)
    if (!recentMine.length) return
    const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
    const notifs = await fetchReplyNotifs(cookie)
    const st = readJson(STATE_FILE, {})
    const seen = new Set(st.seenNotifs || [])
    const fresh = []
    for (const n of notifs) {
      if (seen.has(Number(n.id))) continue
      const ev = toReplyIn(n, { round: roundIdForReply(n, events) })
      if (!ev) continue
      fresh.push(ev)
      seen.add(Number(n.id))
    }
    if (fresh.length) {
      appendEvents(LEDGER_FILE, fresh)
      log(`收到 ${fresh.length} 条新回复通知`)
    }
    bumpState({ seenNotifs: [...seen].slice(-500), lastReplyPollAt: new Date().toISOString() })
  } catch (e) {
    log(`回复轮询失败（下个周期重试）：${e?.message ?? e}`)
  }
}

/* ───────────────────────── 心跳自愈（§12.4：running=true 但子进程已消失 ⇒ 纠正） ───────────────────────── */

const heartbeat = () => {
  try {
    if (running && !currentChild) {
      if (!heartbeat.missingSince) heartbeat.missingSince = Date.now()
      if (Date.now() - heartbeat.missingSince > 15_000) {
        running = false
        heartbeat.missingSince = 0
        log('心跳自愈：running=true 但子进程已消失，标记为空闲')
      }
    } else {
      heartbeat.missingSince = 0
    }
  } catch { /* 兜住 */ }
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
    const cfg = effCfg()
    if (!cfg?.autoDuty) return
    const now = new Date()
    const st = readJson(STATE_FILE, {})
    const today = dayKey(now)
    if (quotaFromLedger().picked >= Math.max(0, Number(cfg?.perDay) || 0)) return
    for (const k of ['noon', 'night']) {
      if (!cfg?.[k]) continue
      if (!inWindow(now, WINDOWS[k])) continue
      const key = `${today}:${k}`
      if (st.windows?.[key]) continue
      bumpState({ windows: { ...(st.windows || {}), [key]: true } })
      runDuty(`window:${k}`).catch((e) => log(`定时值班触发失败（已兜住）：${e?.message ?? e}`))
      return
    }
  } catch (e) {
    log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
  }
}

/* ───────────────────────── overview 组装（设计文档 §8） ───────────────────────── */

const nextWindowLabel = () => {
  try {
    const cfg = effCfg()
    const now = new Date()
    const m = now.getHours() * 60 + now.getMinutes()
    const candidates = []
    if (cfg.noon && !inWindow(now, WINDOWS.noon)) candidates.push(['中午 12:00', (12 * 60 - m + 1440) % 1440])
    if (cfg.night && !inWindow(now, WINDOWS.night)) candidates.push(['晚间 18:00', (18 * 60 - m + 1440) % 1440])
    if (!candidates.length) return '—'
    candidates.sort((a, b) => a[1] - b[1])
    return `${candidates[0][0]}（${Math.floor(candidates[0][1] / 60)}h${String(candidates[0][1] % 60).padStart(2, '0')}m 后）`
  } catch {
    return '—'
  }
}

const buildOverview = () => {
  const cfg = effCfg()
  const st = readJson(STATE_FILE, {})
  const cli = dshCliCached(cfg)
  const q = quotaFromLedger()
  return {
    account: null,                       // 由 /account 单独提供（需要网络，不阻塞 overview）
    duty: {
      autoDuty: !!cfg.autoDuty,
      windows: { noon: !!cfg.noon, night: !!cfg.night },
      nextWindowLabel: nextWindowLabel(),
    },
    quota: {
      picked: q.picked,
      comments: q.comments,
      likes: q.likes,
      dynamics: q.dynamics,
      replies: q.replies,
      repliesProactive: q.repliesProactive,
      limits: {
        perDay: cfg.perDay, commentsPerDay: cfg.commentsPerDay,
        likesPerDay: cfg.likesPerDay, dynamicsPerDay: cfg.dynamicsPerDay,
        repliesPerRound: cfg.repliesPerRound,
        replyOthersPerRound: cfg.replyOthersPerRound,
      },
    },
    round: {
      running,
      startedAt: running ? new Date(currentRoundAt).toISOString() : '',
      elapsedMs: running ? Date.now() - currentRoundAt : 0,
      lastRunAt: st.lastRunAt || '',
      lastWhy: st.lastWhy || '',
      lastCode: st.lastCode ?? null,
      lastDurationMs: st.lastDurationMs ?? null,
    },
    health: { cli: cli || '', cred: existsSync(BILI_CRED_FILE), routeOk: true },
    model: effectiveModel(cfg),
    lastReplyPollAt: st.lastReplyPollAt || '',
    home: HOME,
    ledgerFile: LEDGER_FILE,
  }
}

const listReports = () => {
  const days = []
  const digests = []
  try {
    for (const f of readdirSync(OUT_DIR)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) days.push(f.replace(/\.md$/, ''))
    }
  } catch { /* 目录不存在 */ }
  try {
    for (const f of readdirSync(DIGEST_DIR)) {
      if (/^\d{4}-\d{2}\.md$/.test(f)) digests.push(f.replace(/\.md$/, ''))
    }
  } catch { /* 同上 */ }
  return { days: days.sort().reverse(), digests: digests.sort().reverse(), overlay: existsSync(OVERLAY_FILE) }
}

/* ───────────────────────── 一键诊断 / 模型目录（依赖注入给 lib/diagnose.js 与 /models） ───────────────────────── */

let toolsService = null   // apply() 里捕获，供诊断检查 MCP 工具是否注册

const llmService = () => {
  try { return applyCtx?.get?.('llm') ?? null } catch { return null }
}

// 工具名列表：tools.schemas() 不保证有 scope，拿不到就退化为按名字探测
const mcpToolNames = () => {
  const out = []
  try {
    const svc = toolsService
    if (!svc) return out
    let list = []
    try { list = svc.schemas?.() || [] } catch { list = [] }
    for (const t of list) {
      const n = typeof t === 'string' ? t : t?.name
      if (n) out.push(n)
    }
    if (!out.length) {
      for (const n of ['mcp__bili-fenshen__bili_check_credential', 'mcp__bili-fenshen__bili_search']) {
        try { if (svc.get?.(n)) out.push(n) } catch { /* 兜住 */ }
      }
    }
  } catch { /* 兜住 */ }
  return out
}

// spawn 捕获（带超时；绝不抛）——诊断用
const captureRun = (cmd, args, opts = {}) => new Promise((resolve) => {
  let settled = false
  const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
  try {
    const timeoutMs = Math.max(1000, Math.min(Number(opts?.timeoutMs) || 10_000, 20_000))
    const child = spawn(cmd, Array.isArray(args) ? args : [], {
      cwd: opts?.cwd || HOME,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(opts?.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (b) => { try { stdout += toText(b) } catch { /* 兜住 */ } })
    child.stderr?.on('data', (b) => { try { stderr += toText(b) } catch { /* 兜住 */ } })
    child.on('error', (e) => finish({ code: null, stdout, stderr, error: String(e?.message ?? e) }))
    child.on('exit', (code, signal) => finish({ code, signal, stdout, stderr }))
    const t = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      finish({ code: null, stdout, stderr, error: 'timeout' })
    }, timeoutMs)
    t.unref?.()
  } catch (e) {
    finish({ code: null, stdout: '', stderr: '', error: String(e?.message ?? e) })
  }
})

const diagnoseEnv = () => {
  const cfg = effCfg()
  const llm = llmService()
  return {
    platform: process.platform,
    paths: {
      projectRoot: PROJECT_ROOT,
      python: VENV_PYTHON,
      mcpServer: join(PROJECT_ROOT, 'mcp_server.py'),
      credential: BILI_CRED_FILE,
      home: HOME,
      logFile: LOG_FILE,
      ledgerFile: LEDGER_FILE,
      outDir: OUT_DIR,
      headlessProfileDir: headlessProfileDirOf(cfg),
      dshCli: dshCliCached(cfg) || '',
    },
    config: {
      modelProvider: cfg?.modelProvider || '',
      modelName: cfg?.modelName || '',
      modelReasoningEffort: cfg?.modelReasoningEffort || '',
      dutyTools: Array.isArray(cfg?.dutyTools) ? cfg.dutyTools : [],
      headlessProfile: cfg?.headlessProfile || 'headless',
    },
    exists: (p) => { try { return !!p && existsSync(p) } catch { return false } },
    readText: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    readJson: (p) => readJson(p, null),
    writeText: (p, text) => { try { writeFileSync(p, String(text), 'utf8'); return true } catch { return false } },
    removeFile: (p) => { try { unlinkSync(p) } catch { /* 兜住 */ } },
    run: captureRun,
    fetchJson: async (url, opts = {}) => {
      const r = await fetch(url, opts)
      let json = null
      try { json = await r.json() } catch { /* 非 JSON 响应 */ }
      return { status: r.status, json }
    },
    readCred,
    listProviders: async () => {
      try { return llm?.listProviders ? await llm.listProviders() : [] } catch { return [] }
    },
    listModels: async (provider) => {
      try { return llm?.listModels ? await llm.listModels(provider) : [] } catch { return [] }
    },
    selection: () => currentSelectionSafe(),
    mcpToolNames,
    routeOk: routeRegistered,
  }
}

const runDiagnoseSafely = async () => {
  try {
    return await runDiagnose(diagnoseEnv(), { timeoutMs: 8000 })
  } catch (e) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: 0,
      summary: { pass: 0, warn: 0, fail: 1 },
      items: [{ id: 'internal', label: '诊断未跑起来', status: 'fail', detail: String(e?.message ?? e), fix: '把这条错误反馈给插件作者', durationMs: 0 }],
    }
  }
}

// 模型目录：provider / models / 推理强度 / 当前选择 / 插件配置 + 生效模型（供控制台「模型」组）
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); t.unref?.() }),
])

const buildModelsInfo = async () => {
  const cfg = effCfg()
  const llm = llmService()
  const em = effectiveModel(cfg)
  const providers = []
  const models = {}
  const warnings = []
  try {
    const list = await withTimeout(llm?.listProviders ? llm.listProviders() : [], 5000)
    for (const p of list || []) if (p?.id) providers.push({ id: p.id, name: p.name || p.id })
  } catch (e) { warnings.push(`拉取 provider 失败：${e?.message ?? e}`) }
  await Promise.all(providers.map(async (p) => {
    try {
      const list = await withTimeout(llm?.listModels ? llm.listModels(p.id) : [], 5000)
      models[p.id] = (list || []).map((m) => ({ id: m.id, name: m.name || m.id })).filter((m) => m.id)
    } catch (e) {
      models[p.id] = []
      warnings.push(`${p.id} 拉取模型失败：${e?.message ?? e}`)
    }
  }))
  let reasoningEfforts = []
  if (em.provider && em.model) {
    try {
      const info = await withTimeout(llm?.resolveModelInfo ? llm.resolveModelInfo(em.provider, em.model) : null, 5000)
      reasoningEfforts = (info?.reasoning?.efforts || []).map((x) => ({
        id: x.id, name: x.name || x.id, description: x.description || '',
      }))
    } catch (e) { warnings.push(`拉取推理强度失败：${e?.message ?? e}`) }
  }
  return {
    ok: true,
    selection: currentSelectionSafe() || null,
    effective: em,
    config: {
      modelProvider: cfg?.modelProvider || '',
      modelName: cfg?.modelName || '',
      modelReasoningEffort: cfg?.modelReasoningEffort || '',
    },
    providers,
    models,
    reasoningEfforts,
    warnings,
  }
}

// 实时快照（契约 §1.2）：lib/live 的 snapshot + 今日配额
const liveSnapshot = (after = 0) => {
  let snap = { ok: true, running: false, events: [], cursor: 0, phase: { key: 'think', label: '思考' }, stats: { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 } }
  try { snap = live.snapshot(after) } catch { /* 兜住 */ }
  const q = quotaFromLedger()
  const cfg = effCfg()
  return {
    ok: true,
    ...snap,
    quota: {
      picked: q.picked, comments: q.comments, likes: q.likes, dynamics: q.dynamics,
      replies: q.replies, repliesProactive: q.repliesProactive,
      limits: {
        perDay: cfg.perDay, commentsPerDay: cfg.commentsPerDay,
        likesPerDay: cfg.likesPerDay, dynamicsPerDay: cfg.dynamicsPerDay,
        repliesPerRound: cfg.repliesPerRound,
        replyOthersPerRound: cfg.replyOthersPerRound,
      },
    },
  }
}

/* ───────────────────────── 路由残留自愈（HMR 开发期兜底） ─────────────────────────
 * ⚠️ webserver 的 exact/prefixes 是内部 Map（注册返回的 disposer 才会删除条目）。
 *    实测：插件行 toggle 或 HMR 重载时，若旧实例的 cleanup 没被调用，旧路由会残留，
 *    新实例再注册同名路径就抛 duplicate。这里在注册冲突时尽力删掉残留条目并重试一次；
 *    内部结构变化（字段改名）时静默失败，退回“跳过这条路由”的降级路径。
 *    正常情况下 cleanup 会注销路由，这段不会触发。
 */
const healStaleRoute = (web, kind, path) => {
  try {
    const table = kind === 'exact' ? web?.exact : web?.prefixes
    if (!table || typeof table.delete !== 'function' || typeof table.has !== 'function') return false
    if (!table.has(path)) return false
    table.delete(path)
    return true
  } catch { return false }
}

/* ───────────────────────── Host 插件入口 ───────────────────────── */

export const inject = ['webServer', 'tools']

export function apply(ctx, config) {
  // ⭐ 保存真实 ctx（不要展开成普通对象：ctx.get 是原型方法，展开后会丢，
  //    agentDefaultModel / llm / tools 等服务就查不到，模型跟随与诊断模型项都会误报）
  applyCtx = ctx
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
    toolsService = tools || null
    if (tools?.register) {
      const defStatus = {
        name: 'bili_fenshen_status',
        description: '查询B站分身状态：值班配置、今日配额消耗、dsh CLI 是否可用、最近一轮结果。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        execute: async () => {
          const cfg = effCfg()
          const cli = dshCliCached(cfg)
          const st = readJson(STATE_FILE, {})
          const q = quotaFromLedger()
          return {
            home: HOME,
            autoDuty: !!cfg?.autoDuty,
            perDay: cfg?.perDay,
            today: { picked: q.picked, comments: q.comments, likes: q.likes, dynamics: q.dynamics },
            dutyCli: cli || '（未找到，可配置 dshBin）',
            running,
            lastRunAt: st.lastRunAt || '',
            lastWhy: st.lastWhy || '',
            lastCode: st.lastCode ?? null,
            reportToday: join(OUT_DIR, dayKey() + '.md'),
            ledger: LEDGER_FILE,
          }
        },
      }
      const defRun = {
        name: 'bili_fenshen_run',
        description: '让B站分身立刻跑一轮值班（拉内容源→读字幕→按章程评论/点赞/发动态→写报告）。'
          + '同轮进行中会拒绝重复触发。',
        parameters: { type: 'object', properties: { why: { type: 'string', description: '触发原因，默认 manual' } }, additionalProperties: false },
        output: textOutput,
        execute: async (args) => safe(await runDuty(String(args?.why || 'manual'))),
      }
      const defDiagnose = {
        name: 'bili_fenshen_diagnose',
        description: '一键诊断B站分身插件：Python 环境与依赖、MCP Server 与连接、B站登录凭证、dsh CLI、headless profile、'
          + '家目录可写、值班轮模型可用性、控制台路由。返回每项 pass/warn/fail 与修复建议。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput,
        execute: async () => {
          const report = await runDiagnoseSafely()
          return { report, text: formatDiagnoseText(report) }
        },
      }
      disposers.push(tools.register(defStatus))
      disposers.push(tools.register(defRun))
      disposers.push(tools.register(defDiagnose))
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
      // 旧端点（依赖登录会话与本地状态，留在 index.js）：/status /run /report /log /login/* /cred
      const legacyHandle = async (req, res, url) => {
        const path = url.pathname
        if (req.method === 'GET' && path === '/api/bili-fenshen/status') {
          const cfg = effCfg()
          const st = readJson(STATE_FILE, {})
          const cli = dshCliCached(cfg)
          const q = quotaFromLedger()
          return sendJson(res, 200, {
            ok: true, home: HOME, running,
            autoDuty: !!cfg?.autoDuty,
            quota: { perDay: cfg?.perDay, comments: cfg?.commentsPerDay, likes: cfg?.likesPerDay, dynamics: cfg?.dynamicsPerDay, replies: cfg?.repliesPerRound, replyOthers: cfg?.replyOthersPerRound },
            today: { picked: q.picked, comments: q.comments, likes: q.likes, dynamics: q.dynamics },
            lastRunAt: st.lastRunAt || '', lastWhy: st.lastWhy || '',
            dutyCli: cli || '',
            reportToday: join(OUT_DIR, dayKey() + '.md'),
            logFile: LOG_FILE,
          })
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/run') {
          return sendJson(res, 200, await runDuty('web'))
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/report') {
          try {
            // ⭐ day 支持 YYYY-MM-DD（日报）与 YYYY-MM（月度归档）；`overlay` 读 headless-overlay.yml（产物页诊断用）
            const raw = String(url.searchParams.get('day') || '')
            if (raw === 'overlay') {
              return sendJson(res, 200, { day: raw, text: existsSync(OVERLAY_FILE) ? readFileSync(OVERLAY_FILE, 'utf8') : '' })
            }
            const day = /^\d{4}-\d{2}(-\d{2})?$/.test(raw) ? raw : dayKey()
            const f1 = join(OUT_DIR, `${day}.md`)
            const f2 = join(DIGEST_DIR, `${day}.md`)
            const f = existsSync(f1) ? f1 : existsSync(f2) ? f2 : null
            return sendJson(res, 200, { day, text: f ? readFileSync(f, 'utf8') : '' })
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
                const child = spawn(VENV_PYTHON,
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
        // ── 人设工作室：读数据 + 预设切换 + 卡保存/版本回滚 + 语料库/见闻库人工编辑 ──
        //   （语料库编辑 = POST /persona/expression；见闻索引编辑 = POST /persona/lore（走整卡快照）；
        //     见闻正文写盘 = PUT /persona/lore。首次编辑自动物化用户副本：preset → file 模式。）
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona') {
          try {
            const cfg = effCfg()
            const active = readActive()
            const bank = loadBank(active)
            const loaded = loadCard(active)
            return sendJson(res, 200, {
              ok: true,
              active,
              card: loaded.card || null,
              cardSource: { source: loaded.source, path: loaded.path, error: loaded.error || null },
              health: personaHealth({ cfg }),
              presets: listPresets(),
              bank: bankStats(bank || {}),
              versions: listVersions().slice(0, 20).map((v) => ({ name: v.name, mtime: v.mtime })),
              budget: { blocks: { core: 1500, lore: 300, state: 500, samples: 450, tail: 250 }, totalMax: 3000 },
            })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/preview') {
          try { return sendJson(res, 200, previewPersona({ events: readEvents(LEDGER_FILE) })) }
          catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/expression') {
          try {
            const bank = loadBank(readActive())
            const norm = normalizeBank(bank || {})
            return sendJson(res, 200, { ok: true, total: norm.total, buckets: norm.buckets, updatedAt: norm.updatedAt })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/lore') {
          try {
            const active = readActive()
            const loaded = loadCard(active)
            if (!loaded.card) return sendJson(res, 404, { ok: false, error: loaded.error || '人设卡读不到' })
            const entries = resolveLoreIndex(loaded.card, loadState()).map((e) => {
              const p = lorePath(e.id, active)
              let body = ''
              try { body = readFileSync(p, 'utf8') } catch { /* 正文可缺，索引仍可用 */ }
              return { ...e, path: p, chars: body.length, body }
            })
            return sendJson(res, 200, { ok: true, entries })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/expression') {
          try {
            const body = await readBody(req)
            const out = editExpressionBank(body || {})
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error || '语料库更新失败' })
            log(`语料库已更新（${out.action} / ${out.form}）：共 ${out.total} 条`)
            return sendJson(res, 200, {
              ok: true, action: out.action, form: out.form,
              total: out.total, buckets: out.buckets, updatedAt: out.updatedAt,
              materialized: out.materialized, active: out.active,
            })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/lore') {
          try {
            const body = await readBody(req)
            const out = editLoreIndex(body || {})
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error || '见闻索引更新失败' })
            log(`见闻索引已更新（${out.action}）：共 ${out.count} 条`)
            return sendJson(res, 200, { ok: true, action: out.action, count: out.count, snapshot: out.snapshot || '', materialized: out.materialized })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'PUT' && path === '/api/bili-fenshen/persona/lore') {
          try {
            const body = await readBody(req)
            const out = writeLoreBody(String(body?.id || ''), body?.body ?? '')
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error })
            log(`见闻正文已保存：${String(body?.id || '')}`)
            return sendJson(res, 200, { ok: true, file: out.file, materialized: out.materialized })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/versions') {
          try {
            return sendJson(res, 200, { ok: true, versions: listVersions().map((v) => ({ name: v.name, mtime: v.mtime })) })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'PUT' && path === '/api/bili-fenshen/persona') {
          try {
            const body = await readBody(req)
            const card = body?.card || body
            const out = savePersonaCard(card)
            if (!out.ok) return sendJson(res, 400, { ok: false, errors: out.errors || [], warnings: out.warnings || [] })
            log('人设卡已保存（控制台）')
            return sendJson(res, 200, { ok: true, warnings: out.warnings || [], snapshot: out.snapshot || '', active: readActive() })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/versions/restore') {
          try {
            const body = await readBody(req)
            const snap = readVersion(body?.name)
            if (!snap) return sendJson(res, 400, { ok: false, error: '找不到这个版本快照' })
            const out = savePersonaCard(snap)
            if (!out.ok) return sendJson(res, 400, { ok: false, errors: out.errors || [] })
            log('人设版本已回滚：' + String(body?.name || ''))
            return sendJson(res, 200, { ok: true, snapshot: out.snapshot || '', active: readActive() })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/preset') {
          try {
            const id = String(url.searchParams.get('id') || '').trim()
            if (!listPresets().some((p) => p.id === id)) {
              return sendJson(res, 400, { ok: false, error: `没有这个预设：${id}` })
            }
            writeActive({ mode: 'preset', presetId: id })
            log(`人设已切换为预设 ${id}（操作台）`)
            return sendJson(res, 200, { ok: true, active: readActive(), health: personaHealth({ cfg: effCfg() }) })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
      }

      // ⭐ 路由工厂接管新增端点；工厂路径先认领、未命中再走 legacyHandle、最终 404 由 legacy 兜底。
      //    （工厂自身对未知路由也回 404——那是对「直连工厂」的契约；组合时按完整路径分发，避免吃掉旧端点。）
      const FACTORY_PATHS = new Set([
        '/api/bili-fenshen/overview', '/api/bili-fenshen/activity', '/api/bili-fenshen/account',
        '/api/bili-fenshen/config', '/api/bili-fenshen/log', '/api/bili-fenshen/seen', '/api/bili-fenshen/reports',
        '/api/bili-fenshen/duty', '/api/bili-fenshen/run', '/api/bili-fenshen/stop',
        // 新增：模型目录 / 一键诊断 / 实时运行流
        '/api/bili-fenshen/models', '/api/bili-fenshen/diagnose',
        '/api/bili-fenshen/live', '/api/bili-fenshen/live/stream',
      ])
      // ⭐ HMR 实测：插件行 toggle off/on 后，旧模块实例可能留下一个无法注销的 prefix 路由
      //    （旧 handler 继续应答，新实例再 register 同名 prefix 会抛 duplicate）。
      //    对策：按端点注册 exact 路由（webserver 匹配顺序 exact → 最长 prefix），新实例永远接管已知端点；
      //    prefix 只作未知路径的 404 兜底，注册失败就跳过（不阻断 exact）。app 重启后两者都正常注册。
      const ROUTE_PATHS = [
        ...FACTORY_PATHS,
        '/api/bili-fenshen/status', '/api/bili-fenshen/report',
        '/api/bili-fenshen/login/start', '/api/bili-fenshen/login/poll', '/api/bili-fenshen/login/qr.png',
        '/api/bili-fenshen/cred',
        // 人设模块（P1）
        '/api/bili-fenshen/persona', '/api/bili-fenshen/persona/preview', '/api/bili-fenshen/persona/preset',
        '/api/bili-fenshen/persona/expression', '/api/bili-fenshen/persona/lore',
        '/api/bili-fenshen/persona/versions', '/api/bili-fenshen/persona/versions/restore',
      ]
      const mountRoutes = () => {
        if (!web?.register) { log('webServer 不可用：HTTP 路由未挂'); return () => {} }
        if (routeRegistered) { log('webServer 路由已注册过，跳过重复注册'); return () => {} }
        routeRegistered = true
        const api = createApiHandler({
          home: HOME,
          ledgerFile: LEDGER_FILE,
          configFile: CONFIG_FILE,
          seenFile: join(HOME, 'seen.md'),
          logFile: LOG_FILE,
          patchConfig: () => cfgSnapshot,
          readEvents: () => readEvents(LEDGER_FILE),
          overview: buildOverview,
          setDuty: (v) => {
            const cur = effectiveConfig(cfgSnapshot || {}, CONFIG_FILE)
            writeOverride(CONFIG_FILE, { ...cur.values, autoDuty: v })
            log(`自动值班 ${v ? '开启' : '关闭'}（操作台）`)
            return { autoDuty: v }
          },
          runDuty: () => runDuty('web'),
          stopDuty,
          fetchAccount: () => fetchAccount(readCred()),
          listReports,
          // 新增端点依赖（api.js 里缺失时优雅降级）
          models: buildModelsInfo,
          diagnose: runDiagnoseSafely,
          live: {
            snapshot: (after) => liveSnapshot(after),
            subscribe: (listener) => live.onPush(listener),
          },
        })
        // ⭐ /live/stream 的 SSE 连接需要随插件卸载一起关掉，否则重载后旧连接还在推旧实例数据
        const closeSse = typeof api?.closeSse === 'function' ? () => { try { api.closeSse() } catch { /* 兜住 */ } } : null
        disposers.push(closeSse || (() => {}))

        const dispatch = async (req, res) => {
          try {
            const url = new URL(req.url, 'http://127.0.0.1')
            if (FACTORY_PATHS.has(url.pathname)) {
              await api(req, res)                                   // 新端点
              // ⭐ SSE（/live/stream）不会 end 响应，用 headersSent 判断是否已由工厂接管
              if (res.writableEnded || res.headersSent) return
            }
            await legacyHandle(req, res, url)                       // 旧端点 + 最终 404
          } catch (e) {
            try { if (!res.writableEnded && !res.headersSent) { res.writeHead(500); res.end() } } catch { /* 兜住 */ }
          }
        }

        const routeDisposers = []
        let failed = 0
        let exactCount = 0
        let healed = 0
        for (const path of ROUTE_PATHS) {
          try {
            routeDisposers.push(web.register({ kind: 'exact', path, handler: dispatch }))
            exactCount++
          } catch (e) {
            // 冲突时先尝试清掉旧实例残留（正常 cleanup 生效时不会走到这里）
            if (healStaleRoute(web, 'exact', path)) {
              try {
                routeDisposers.push(web.register({ kind: 'exact', path, handler: dispatch }))
                exactCount++
                healed++
                continue
              } catch { /* 还是不行，走失败计数 */ }
            }
            failed++
            log(`exact 路由注册跳过（${path}）：${e?.message ?? e}`)
          }
        }
        try {
          routeDisposers.push(web.register({ kind: 'prefix', path: '/api/bili-fenshen', handler: dispatch }))
        } catch (e) {
          if (healStaleRoute(web, 'prefix', '/api/bili-fenshen')) {
            try { routeDisposers.push(web.register({ kind: 'prefix', path: '/api/bili-fenshen', handler: dispatch })) }
            catch { /* 兜底路由失败不影响已知端点 */ }
          }
          // 历史实例残留的 prefix 无法注销：exact 已经能覆盖所有已知端点，这里只影响未知路径的 404 文案
          log(`prefix 兜底路由注册跳过（已知端点由 exact 路由接管）：${e?.message ?? e}`)
        }
        log(`webServer 路由已挂载：exact ${exactCount}/${ROUTE_PATHS.length} 条${failed ? `（失败 ${failed} 条）` : ''}${healed ? `（自愈 ${healed} 条残留）` : ''}`)
        return () => { for (const d of routeDisposers.reverse()) { try { d?.() } catch { /* 兜住 */ } } }
      }
      disposers.push(mountRoutes())
    } else {
      log('webServer 服务不可用：HTTP 路由未挂（仅影响 V2 页面，不影响调度）')
    }
  } catch (e) { log(`注册 webServer 路由失败（已兜住）：${e?.message ?? e}`) }

  // ── 调度器：60 秒巡窗 ──
  const timer = setInterval(tick, 60_000)
  timer.unref?.()
  disposers.push(() => { try { clearInterval(timer) } catch { /* 兜住 */ } })

  // ── 回复轮询器：5 分钟一次（凭证有效且近 7 天有评论才有网络动作） ──
  const replyPollTimer = setInterval(() => { replyTick().catch(() => {}) }, 5 * 60_000)
  replyPollTimer.unref?.()
  disposers.push(() => { try { clearInterval(replyPollTimer) } catch { /* 兜住 */ } })

  // ── 心跳自愈：15 秒一次 ──
  const hbTimer = setInterval(heartbeat, 15_000)
  hbTimer.unref?.()
  disposers.push(() => { try { clearInterval(hbTimer) } catch { /* 兜住 */ } })

  log(`dsh-bili-fenshen host 已激活（home=${HOME}，autoDuty=${!!effCfg().autoDuty}，profileRoot=${PROFILE_ROOT || '（无）'}）`)

  // ── 启动即消化一次沉淀候选（停用自动值班也不让候选积压） ──
  try {
    const g = processGrowth({ cfg: effCfg(), events: readEvents(LEDGER_FILE) })
    const s = g?.stats
    if (s && s.received) log(`自生长（启动消化）：候选 ${s.received} · 语料+${s.acceptedCorpus} · 见闻+${s.acceptedLore} · 拒 ${s.rejected} · 转正 ${s.promoted}`)
  } catch (e) { log(`自生长管道失败（不阻断启动）：${e?.message ?? e}`) }

  // ⭐ 正确的清理路径：Cordis 只保证 ctx.effect 的 disposer 在插件停止时执行；
  //    仅 return 一个函数在 HMR 重载/行 toggle 时实测不一定会被调用（旧路由/定时器会残留）。
  //    两种写法都保留，并用 once 守卫避免重复清理；集成测试的 fake ctx 没有 effect 时走返回值。
  let disposed = false
  const disposeAll = () => {
    if (disposed) return
    disposed = true
    for (const d of disposers.reverse()) {
      try { d?.() } catch { /* 卸载兜底 */ }
    }
    routeRegistered = false   // 允许下次激活重新注册路由
    applyCtx = null
    toolsService = null
  }
  try { if (typeof ctx.effect === 'function') ctx.effect(() => disposeAll) } catch { /* 老宿主没有 effect 或注册失败：退回返回值 */ }
  return disposeAll
}
