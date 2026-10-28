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
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ⭐ lib/* 是本插件的纯逻辑模块（package.json files 已带上）；任何加载失败都按可选依赖降级
import { appendEvents, isDuplicate } from './lib/ledger.js'
// ⭐ W4-2：账本读收敛成**模块级单实例**（stat 未变 0 次读盘 / size 增长只读增量段 / 轮转自动全量回退）
import { ledgerReaderFor } from './lib/ledger-index.js'
import { createUtf8Decoder, keepTail, rotateIfBig, createProbeLogger } from './lib/logsink.js'
import { parseRoundReport, parseProactiveScan, roundSection, dedupeScans } from './lib/report.js'
import { createApiHandler } from './lib/api.js'
import { effectiveConfig, writeOverride, extractConfigBlock, pickReasoningEffort } from './lib/config.js'
import { fetchAccount } from './lib/account.js'
import { fetchReplyNotifs, toReplyIn, roundIdForReply, proactiveTargetsFromLedger } from './lib/replies.js'
import { seenListFromLedger } from './lib/seen.js'
import { buildOverview as buildOverviewData, countToday, windowPool } from './lib/overview.js'
import { createOverviewHub } from './lib/realtime.js'
import { roundAccounting } from './lib/round.js'
import { loadPersona } from './lib/persona.js'
import {
  resolvePersona, seedIfEmpty, guardPrompt, personaHealth, previewPersona,
  listPresets, savePersonaCard, loadBank, bankStats, readActive, writeActive, l0Checks, SPEC,
  loadCard, listVersions, readVersion, normalizeBank, resolveLoreIndex, lorePath, loadState, saveState, recordUsage,
  editExpressionBank, editLoreIndex, writeLoreBody,
  processGrowth, degradationPlan, resolveBudget,
} from './lib/persona/index.js'
import { buildPersonaInjectEvent, describePersonaInject } from './lib/persona/attribution.js'
import { buildRoundGate, describeRoundGate, roundGateEvent } from './lib/persona/speak.js'
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
  /** W2 收尾：人工位 —— true 时只转正「人工确认过（checked=true）」的候选（= 麦麦 checked_only） */
  growthCheckedOnly: z.boolean().default(false),
  /**
   * W7-2 发言门控档位：off=不门控（老行为）｜observe=只算只记不强制（默认）｜enforce=节奏太密时压上限。
   * 默认 observe：与质量门先 warn 三天同一个方法论 —— 先让数据跑出来，再谈拦。
   *
   * ⚠️ 这里必须用 `z.string()`，**不能用 `z.enum([...])`**：宿主注入的 `z` 是受限的 schema 构造器，
   * 没有 `.enum()`。用了会在**导入期**抛 `TypeError: z.enum is not a function`，
   * 后果是整个插件 entry 加载失败（fiberPhase=null，控制台显示"插件加载错误"），
   * 而单测因为不走宿主的 schema 校验仍然全绿 —— 所以另加了 `test/plugin-load.test.js` 兜这条。
   * 合法值由 `buildRoundGate` 在运行期收口（非法值回落 observe）。
   */
  speakGateMode: z.string().default('observe'),
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
    'bili_persona_lore', // W6-1：见闻正文按需读（C3 路径 A；Python 侧已实现，这里只开白名单）
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

// ⭐ W4-2：**一个账本一个 reader**。过去 11 处 `readLedger()` 各自全量 readFileSync + sort，
//    10 万行时单次几十 ms；现在全部走这个实例：
//      · 文件没变 ⇒ 0 次读盘（SSE 每帧重算不再碰盘）
//      · append 之后 ⇒ 只读增量段（appendEvents 轮转后 size 变小会自动全量回退）
//      · 语义与 readEvents 完全一致（同一套 parseLedgerText/sortEvents，有 12 例单测）
//    ⚠️ 不要每次调用都 invalidate：reader 靠 size+mtime 自己发现新事件，手动失效只会让缓存白丢。
//    ⚠️ 本模块的账本路径在加载时就固定了（HOME 由 BILI_FENSHEN_HOME 决定），所以单实例安全。
const ledgerReader = ledgerReaderFor(LEDGER_FILE)
/** 读全量事件（排序后）。所有需要账本的地方都用它，别再直接 readLedger()。 */
const readLedger = () => ledgerReader.read()
/** 账本读器的计数快照（诊断/汇报用：cacheHits / fullReads / bytesRead …）。 */
export const getLedgerReaderStats = () => ledgerReader.stats()

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
/**
 * 状态写盘（W3-4b）：先写 `<p>.tmp`，再 rename 覆盖 —— 同目录 rename 是原子替换。
 * 旧实现直接 writeFileSync：进程在写一半时被杀 / 磁盘满，state.json 就是半截 JSON，
 * 之后每次 readJson 都返回 {}（静默丢状态：窗口标记、seenNotifs、lastRunAt 全没了）。
 * ⚠️ 与 lib/persona/state.js 的 writeJsonAtomic 同一口径，但别合并：宿主状态与 persona 状态是两份文件。
 */
const writeJsonSafe = (p, data) => {
  const tmp = `${p}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, p)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    return false
  }
}
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const bumpState = (patch) => {
  const st = readJson(STATE_FILE, {})
  const next = { ...st, ...patch }
  writeJsonSafe(STATE_FILE, next)
  return next
}

/* ───────────────────────── 素材留痕 / 孤儿扫描（W3-3，端点层） ─────────────────────────
 * lib 层已经把「删除」改成软删除（`disabled:true`，可 restore / purge）。端点层补两件事：
 *   ① 删前留痕：把整份文件复制成 `<file>.bak-<ts>`，只保留最近 3 份 —— 软删也留，物理删（purge）更要留；
 *   ② 孤儿扫描：`persona/lore/*.md` 里不在 loreIndex 的（有正文没索引），以及 loreIndex 引用了不存在正文的。
 * 为什么在端点层做：lib 层是纯存取，不该知道"控制台点删除"的时间点；备份应该正好发生在删除动作之前。
 */

/** 备份文件的保留份数（超出按文件名时间戳倒序删最旧的）。 */
const BAK_KEEP = 3

const pruneBackups = (file, keep = BAK_KEEP) => {
  try {
    const dir = dirname(file)
    const base = basename(file)
    const baks = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`))
      .sort()          // 文件名里是紧凑时间戳（20261028T231200），字典序 = 时间序
      .reverse()
    for (const f of baks.slice(keep)) {
      try { unlinkSync(join(dir, f)) } catch { /* 删不掉就算了，别影响主流程 */ }
    }
  } catch { /* 目录不存在 / 读不到：没有备份可清 */ }
}

/**
 * 写一份 `<file>.bak-<ts>` 快照（文件不存在就跳过），并清理到只留最近 `keep` 份。
 * @returns {boolean} 是否真的产出了备份
 */
const backupFileKeep = (file, keep = BAK_KEEP) => {
  try {
    if (!existsSync(file)) return false
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '') // 20261028T231200
    const target = `${file}.bak-${stamp}`
    if (!existsSync(target)) copyFileSync(file, target)
    pruneBackups(file, keep)
    return true
  } catch { return false }
}

/** 当前用户素材目录（preset 模式没有用户副本，只有物化之后才有）。 */
const personaAssetPaths = () => {
  const dir = join(HOME, 'persona')
  return {
    dir,
    bankFile: join(dir, 'expression-bank.json'),
    cardFile: join(dir, 'card.json'),
    loreDir: join(dir, 'lore'),
  }
}

/**
 * 孤儿扫描（W3-3）：只读、不抛。
 *  - bodiesWithoutIndex：`<家目录>/persona/lore/*.md` 有正文，但当前 loreIndex 里没有这个 id（purge 后残留 / 手放的文件）
 *  - indexWithoutBody：loreIndex 条目（未软删）指向的正文文件不存在（迁移漏拷 / 误删）
 */
const scanPersonaLoreOrphans = () => {
  const out = { bodiesWithoutIndex: [], indexWithoutBody: [], scannedAt: new Date().toISOString() }
  try {
    const p = personaAssetPaths()
    let bodies = []
    try {
      bodies = readdirSync(p.loreDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
    } catch { /* 没有 lore 目录 = 没有用户正文 */ }
    const active = readActive()
    const loaded = loadCard(active)
    // 「有正文没索引」按**卡里的原始 loreIndex**（含软删 disabled 条目）判定：
    // 软删除只是"控制台里隐藏"，正文是故意留着的（restore 用），不能算孤儿。
    const rawIndex = Array.isArray(loaded.card?.loreIndex) ? loaded.card.loreIndex : []
    const rawIds = new Set(rawIndex.map((l) => String(l?.id || '')))
    out.bodiesWithoutIndex = bodies.filter((id) => !rawIds.has(id)).sort()
    // 「有索引没正文」只看**生效**条目（disabled 的不参与编译，正文缺失不算问题）
    const entries = resolveLoreIndex(loaded.card || {}, loadState()) || []
    for (const e of entries) {
      const id = String(e?.id || '')
      if (!id) continue
      if (!existsSync(lorePath(id, active))) out.indexWithoutBody.push(id)
    }
    out.indexWithoutBody.sort()
  } catch { /* 扫描失败不能 500，也不能挡住删除 */ }
  return out
}

/** 孤儿扫描结果的日志行（为空就不吵）。 */
const logLoreOrphans = (orphans, where = '') => {
  try {
    const a = orphans?.bodiesWithoutIndex || []
    const b = orphans?.indexWithoutBody || []
    if (!a.length && !b.length) return
    log(`人设素材孤儿${where ? `（${where}）` : ''}：有正文无索引 ${a.length ? a.join('、') : '无'}；有索引无正文 ${b.length ? b.join('、') : '无'}`)
  } catch { /* 兜住 */ }
}

const LOG_MAX_BYTES = 512 * 1024
const LOG_KEEP_BYTES = 256 * 1024
let lastRotateAt = 0

/**
 * 日志轮转：**按字节**保留尾部，而不是按字符（旧实现 `.slice(-256*1024)` 是字符串切片，
 * 中文 3 字节 ⇒ `.old` 实际可达 ~768KB，轮转后仍超阈值）。
 * 子进程输出会高频调用它，所以 5 秒节流，避免每个 chunk 都 stat 一次。
 */
const rotateLogIfBig = (force = false) => {
  const nowMs = Date.now()
  if (!force && nowMs - lastRotateAt < 5_000) return false
  lastRotateAt = nowMs
  return rotateIfBig(LOG_FILE, { maxBytes: LOG_MAX_BYTES, keepBytes: LOG_KEEP_BYTES })
}

const log = (msg) => {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
    rotateLogIfBig()
  } catch { /* 写日志绝不能抛 */ }
  // ⭐ 同时推进实时流：控制台「实时」页无需轮询日志文件即可看到宿主事件
  try { live.pushHost(msg) } catch { /* 实时流失败不能影响日志 */ }
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
  try {
    // ⭐ W4-2b：今日计数与概览共用 lib/overview.js 的 countToday（同日区间口径，10 万行 ~4ms，
    //    旧版逐条 dayKeyOf 是 32ms）。口径逐字段一致：view=挑中 / comment / like / dynamic / reply-out / reply-scan。
    return countToday(readLedger(), day)
  } catch {
    // 账本读不到 ⇒ 全 0，不拖垮调用方
    return { picked: 0, comments: 0, likes: 0, dynamics: 0, replies: 0, repliesProactive: 0, replyScans: 0, proactiveSkipped: 0 }
  }
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

// ⭐ 缓存 key 必须带上 dshBin：旧版不含配置，用户改了 dshBin 也照样返回旧值。
// ⭐ 探测细节不再每次 log：概览轮询会把它变成刷屏（duty.log 曾被顶到 485KB），
//    改为「结论变化才记一行」。
let dshCliCache = { v: null, at: 0, key: null }
const dshProbe = createProbeLogger((m) => log(m), { label: 'dshBin 探测' })

const findDshCliRaw = (cfg) => {
  const explicit = String(cfg?.dshBin || '').trim()
  if (explicit) {
    if (existsSync(explicit)) return explicit
  }
  // ⭐ 桌面版主通道：asar 内的 bin.js（宿主进程读 asar 透明；探测路径与 schemastery 相同）
  if (process.resourcesPath) {
    const asarBin = join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(asarBin)) return asarBin
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

/** 探测 + 降噪留痕（同结论不重复记）。 */
const findDshCli = (cfg) => {
  const v = findDshCliRaw(cfg)
  dshProbe(v)
  return v
}

const dshCliCached = (cfg) => {
  const now = Date.now()
  const key = String(cfg?.dshBin || '').trim()
  if (dshCliCache.v !== null && dshCliCache.key === key && now - dshCliCache.at < 60_000) return dshCliCache.v
  const v = findDshCli(cfg)
  dshCliCache = { v, at: now, key }
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
// ⭐ W3-6：spawn 硬超时（20 分钟）—— 挂死的一轮必须由宿主自己收掉，否则 running 永远 true、调度器再也不会触发。
//    数值可用环境变量覆盖（只给故障注入测试用；线上不设就是 20 分钟）。
// ⚠️ 在模块加载时读：测试必须在 import index.js **之前**设好 BILI_FENSHEN_ROUND_TIMEOUT_MS。
const ROUND_TIMEOUT_MS = (() => {
  const n = Number(process.env.BILI_FENSHEN_ROUND_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : 20 * 60_000
})()
let roundTimer = null
let roundTimedOut = false

const refreshCfg = () => {
  // cfgSnapshot 在 apply() 里已由 Loader 校验后的 config 赋值；这里只保证返回最新快照
  // （⭐ 不能把 ctx 展开成普通对象：ctx.get 等是原型方法，展开后会丢，导致 agentDefaultModel/llm 查不到）
  return cfgSnapshot
}

// ⭐ POST /stop：SIGTERM，2s 后补刀（进程树），等 exit 走同一收尾路径
const stopDuty = () => {
  if (!currentChild) return { ok: true, stopped: false }
  const child = currentChild
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      // 2s 还没退出 ⇒ 连 python MCP 子进程一起收掉（W3-6 的进程树口径）
      if (currentChild === child) killProcessTree(child)
    }, 2000).unref?.()
    log('收到中止请求：已发送 SIGTERM（2s 后未退出则强杀进程树）')
  } catch (e) {
    log(`中止本轮失败：${e?.message ?? e}`)
  }
  return { ok: true, stopped: true }
}

/**
 * 强杀整棵进程树（W3-6）：挂死的一轮不能只杀 node 父进程 —— headless 下面还挂着 python MCP，
 * 父进程被 SIGKILL 后 python 会成孤儿继续占着家目录/端口。
 * Windows 用 `taskkill /PID <pid> /T /F`；POSIX 走进程组（spawn 时已经 detached，见 runDuty）。
 */
const killProcessTree = (child) => {
  const pid = Number(child?.pid)
  try {
    if (!pid) { try { child?.kill?.('SIGKILL') } catch { /* 已退出 */ } return }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on?.('error', () => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })
      killer.unref?.()
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
    }
  } catch { /* 杀不动也不能把宿主带崩 */ }
}

/**
 * 外部输入的兜底解码（只在**真 GBK** 来源使用，例如 Windows 控制台回显）。
 * ⚠️ 子进程 stdout/stderr 绝不能走这里：它们是 UTF-8，而 Node 会在多字节字符中间切块，
 *    按块嗅探 U+FFFD 会把整块（可达 64KB）误判成 GBK，中文全毁、ASCII 完好
 *    （2026-10-28 实测：duty.log 15:46 之后整段乱码）。子进程用 createUtf8Decoder。
 */
const toText = (buf) => {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
    const u = b.toString('utf8')
    if (!u.includes('\uFFFD')) return u
    try { return new TextDecoder('gbk').decode(b) } catch { return u }
  } catch { return String(buf) }
}

/** 追加一段日志（接受字符串或 Buffer）；顺便触发按字节轮转。 */
const appendLogChunk = (chunk) => {
  try {
    appendFileSync(LOG_FILE, typeof chunk === 'string' ? chunk : toText(chunk), 'utf8')
    rotateLogIfBig()
  } catch { /* 兜住 */ }
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
    const existing = readLedger()
    const day = dayKey()
    const f = join(OUT_DIR, `${day}.md`)
    if (!existsSync(f)) return
    const full = readFileSync(f, 'utf8')
    // ⭐ 只解析**本轮那一块**：以前按整份日报解析，第二轮回填时把第一轮的「接话扫描」行又补了一遍，
    //    一轮扫描在账本里记成 2–4 条（概览「今日扫描」翻倍 + 活动页挂错视频，2026-10-29 两轮实测）。
    const scoped = roundSection(full, roundId)
    let text = scoped.text
    if (!scoped.found) {
      if (scoped.rounds > 1) {
        // 多个轮次却定位不到本轮 ⇒ 标题没带 round id；宁可这条不补，也别把别人的事件记到本轮头上
        log(`报告兜底回填跳过：日报里有 ${scoped.rounds} 个轮次，找不到 round=${roundId}（标题缺 round id？）`)
        return
      }
      text = full   // 老格式（整份日报 = 一个轮次）
    }
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
    // ⭐ 接话扫描/接话也从报告回填（设计定稿 §3.3）。
    //    去重按**语义**（posted 认 targetRpid / skipped 认 bvid），不再用 `t`：
    //    回填时间是"现在"、模型写的是轮内时刻，拿 `t` 比永远不相等 ⇒ 以前等于没去重。
    try {
      const scans = parseProactiveScan(text, { round: roundId })
      const scanEvents = dedupeScans(
        existing,
        scans.scans.map((sc) => ({ ...sc, round: roundId, type: 'reply-scan', source: 'report' })),
        roundId,
      )
      const proactiveEvents = scans.proactive
        .map((p) => ({ ...p, round: roundId, type: 'reply-out', kind: 'proactive', source: 'report' }))
        .filter((e) => !existing.some((x) => x && x.type === 'reply-out' && x.round === e.round
          && x.parent === e.parent && x.bvid === e.bvid))
      const extra = [...scanEvents, ...proactiveEvents]
      if (extra.length) {
        appendEvents(LEDGER_FILE, extra)
        log(`报告兜底回填接话事件 ${extra.length} 条（round=${roundId}）`)
      }
    } catch (e) { log(`接话事件回填失败（不影响主流程）：${e?.message ?? e}`) }
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
  // ⭐ W6-1 见闻正文按需读：同样补进老配置的冻结白名单（不给的话线上模型永远调不到这个工具）
  if (!tools.includes('bili_persona_lore')) tools.push('bili_persona_lore')
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

/* ───────────────────────── 人设用量：pending → 轮末转正（冷却表闭环） ─────────────────────────
 * 为什么两段式：人设编译发生在 spawn **之前**，此时代理还没真用这些素材；若编译时直接写冷却表，
 * 本轮即使 spawn 失败/中途崩，也会把这些条目记成「今天用过」，白丢一天素材。
 * 所以编译时只落 pending，`round-end` 确认本轮跑完之后再转正；过期 pending 直接忽略。
 * 这一步以前完全缺失（recordUsage 只有测试在调），导致 loreUsed/expressionUsed 永远为空、
 * 「同一天不重复讲同一件事」从未生效。
 */
const pendingUsagePath = () => join(HOME, 'persona', 'pending-usage.json')

const writePendingUsage = (roundId, personaRes) => {
  try {
    if (!personaRes || personaRes.mode !== 'card') return
    const used = personaRes.used || {}
    const n = (used.loreIds?.length || 0) + (used.canonKeys?.length || 0) + (used.expressionIds?.length || 0)
    if (!n) return
    writeJsonSafe(pendingUsagePath(), {
      roundId, at: new Date().toISOString(), personaTag: personaRes.personaTag || '', used,
    })
  } catch (e) { log(`写 pending-usage 失败（不影响本轮）：${e?.message ?? e}`) }
}

/** 轮末转正：把本轮用到的素材记进冷却表；只认本轮自己的 pending。 */
export const commitPendingUsage = (roundId) => {
  try {
    const p = pendingUsagePath()
    const pending = readJson(p, null)
    if (!pending || !pending.roundId) return false
    if (roundId && pending.roundId !== roundId) {
      log(`pending-usage 属于别的轮（${pending.roundId}），本轮忽略`)
      return false
    }
    const ageMs = Date.now() - Date.parse(pending.at || '')
    if (Number.isFinite(ageMs) && ageMs > 6 * 3600_000) {
      log(`pending-usage 已过期（${Math.round(ageMs / 60000)} 分钟），丢弃`)
      try { unlinkSync(p) } catch { /* 兜住 */ }
      return false
    }
    const ok = saveState(recordUsage(loadState(), pending.used || {}))
    if (ok) {
      const u = pending.used || {}
      log(`人设用量已转正（lore ${(u.loreIds || []).length} / canon ${(u.canonKeys || []).length} / 语料 ${(u.expressionIds || []).length}）`)
    }
    try { unlinkSync(p) } catch { /* 兜住 */ }
    return ok
  } catch (e) {
    log(`转正 pending-usage 失败（不影响报告）：${e?.message ?? e}`)
    return false
  }
}

/**
 * 人设自演化：**写入前复核位**（W2 收尾 / §8.3-3）。
 *
 * `processGrowth({ review })` 的契约：`review(entry, ctx) => { ok, reason? }`，返回 ok:false 的候选不入库
 * （记 `reviewRejected`）。这里是**同步硬规则代理** —— 宿主在 spawn 前没有同步 LLM 调用点，
 * 真正的 AI 复核要等生成期通道（W6）；先拦掉明显不该学的东西，将来换真复核只改这一个函数。
 */
const growthReview = (entry) => {
  try {
    const text = String(entry?.text ?? '').trim()
    if (text.length < 2) return { ok: false, reason: '太短，学不到东西' }
    if (text.length > 100) return { ok: false, reason: `太长（${text.length} 字），语料应是一句话` }
    if (/https?:\/\/|www\.|@[\w-]{2,}/i.test(text)) return { ok: false, reason: '含链接或 @ 提及，不入语料库' }
    if (/(?:\+?\d[\d\s-]{7,}\d)/.test(text)) return { ok: false, reason: '疑似联系方式，不入库' }
    return { ok: true }
  } catch { return { ok: false, reason: '复核异常（保守拒绝）' } }
}

/**
 * 最近一次 buildDutyPrompt 的人设注入元数据（W2-1 写 `persona-inject` 事件用）。
 *
 * 为什么用模块级记录：buildDutyPrompt 的返回值必须保持**字符串**（调用方直接当 prompt 用），
 * 而"这轮吃了哪版人设 / 超没超线 / 降级砍了什么"只有它自己知道。
 * `runDuty` 在 spawn 前用 `getLastPersonaInject()` 取，交给 lib/persona/attribution.js 落账本。
 */
let lastPersonaInjectRecord = null
export const getLastPersonaInject = () => lastPersonaInjectRecord

/**
 * 最近一次 buildDutyPrompt 的**轮级发言门控**（W7-2）。
 *
 * 与 `getLastPersonaInject` 同一个理由：buildDutyPrompt 的返回值必须是字符串，
 * 而"这轮节奏闸判了什么、有没有真的压上限"只有它自己知道；runDuty 取来落账本，
 * 控制台据此解释"这轮为什么只发了 1 条 / 为什么没被拦"。
 */
let lastSpeakGateRecord = null
export const getLastSpeakGate = () => lastSpeakGateRecord

export const buildDutyPrompt = (cfg, roundId, ledgerEvents = []) => {
  const charter = (() => {
    try { return readFileSync(join(PROMPTS_DIR, 'duty.md'), 'utf8').split('<家目录>').join(HOME) } catch { return '' }
  })()
  // 人设：**取数**（resolvePersona：读卡/派生状态/语料库）→ **纯函数装配**（lib/persona/layers.js）
  //       → **这里只拼装**。编译器细节（场域字数/预算/降级）都在 lib/persona 里，别在这层再写一遍。
  //   - 配置里有 personaPrompt（正文/文件路径）⇒ **legacy 直通**，行为与升级前完全一致；
  //   - 否则读 <家目录>/persona/active.json（默认 preset:whale），编译成
  //     「前段（身份 + 见闻索引）」与「后段（今日状态 + 语料样本 + 最后一公里）」两部分：
  //     前段放章程之前（事实），后段放整轮 prompt 最末尾（行为贴生成点）。
  //   - 场域字数走卡（W1-2）：评论 100 / 楼中楼 40 / 动态 60，与时段上限取更严。
  //   - `degrade` 非空 = 超软线后的**二次编译**（W1-5），只砍见闻/示例/状态，**L0 尾注永远保留**。
  // ⭐ W4-2b：人设编译链（状态 / 记忆 / 体检）只看近两周 —— 传全量账本进去等于每轮多一次 O(n) 扫描
  //    （Lead 的实现里 resolvePersona 会跑 buildCheckup，扫全量取近 14 天 ≤20 条）。
  //    ⚠️ 只裁「人设/体检」这一路；下面的「已看过清单 / 已接话清单」仍用**全量** ledgerEvents
  //       （判重需要更早历史，lib/seen.js 自己按 14 天窗口算，别在这里提前裁）。
  const personaEvents = windowPool(ledgerEvents, new Date(), 14)
  const personaOnce = (degrade = []) =>
    resolvePersona({ cfg, events: personaEvents, roundId, modes: 'card', degrade })

  const q = quotaFromLedger()
  const picked = q.picked
  const quota = Math.max(0, Number(cfg?.perDay) || 0)
  const left = Math.max(0, quota - picked)
  const kws = Array.isArray(cfg?.keywords) ? cfg.keywords.filter(Boolean) : []
  const uids = Array.isArray(cfg?.followUids) ? cfg.followUids.filter(Boolean) : []
  const avoid = Array.isArray(cfg?.avoidList) ? cfg.avoidList.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  // ⭐ 已看过清单：宿主从账本算好的硬判重（设计文档 2026-10-27-proactive-reply-dedup §4）
  const seenBvs = seenListFromLedger(ledgerEvents)
  // ⭐ 已接话清单：宿主从账本算好，命中就别再重复接（章程「同一 target 永不重复」只能靠它落地）
  const proactiveMine = proactiveTargetsFromLedger(ledgerEvents, { days: 14 })
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
  const followWant = cfg?.followPerRound === undefined ? 8 : Math.max(0, Number(cfg.followPerRound) || 0)
  // ⭐ 2026-10-29：「每轮抽查」是**想看多少**，不是「本轮必须逐个扫完多少」。
  //    实测配置写成 40 时，模型在「先扫哪几个 UP」上反复权衡，20 次工具预算里先烧掉一截
  //    （真实日志：40 个配置 → 只看了 4 个 UP，还多花了 2 次预算在纠结上）。
  //    所以注入时收口到 8，并把「配置写了几」明说，别让模型自己算「40 个要扫到什么时候」。
  const FOLLOW_PER_ROUND_MAX = 8
  const followN = Math.min(followWant, FOLLOW_PER_ROUND_MAX)
  const followParts = []
  if (uids.length) followParts.push(`指定 UID：${uids.join('、')}（优先；用 bili_user_videos 逐个拉最新投稿，order=pubdate）`)
  if (followAuto && followN > 0) {
    const clampNote = followWant > followN
      ? `（配置写的是 ${followWant}，但每轮工具预算只有 20 次 ⇒ 本轮就按前 ${followN} 个算，别试图扫完全部）`
      : ''
    followParts.push(`用 bili_followings 按「最常访问」排序（sort=attention，ps=50）拉我常看的 UP 主，取前 ${followN} 个${clampNote}`
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

  // ⭐ W7-2 发言门控（轮级节奏闸）
  //    宿主确定知道的只有「我最近说了多少 / 离上次多久 / 有没有人回我」——这三件恰好是 §8.5 里
  //    能"只收紧不放宽"的部分；候选级打分（问号/纯媒体/新鲜度）要等 C3 通道拿到候选再用。
  //    默认 observe：只算、只记、只提示，**不拦**（与质量门先 warn 三天同一个方法论）。
  const gateAt = new Date()
  const speakGate = buildRoundGate({ events: ledgerEvents, now: gateAt, cfg, quotaLeft: left })
  const cfgCommentCap = Math.max(0, Number(cfg?.commentsPerRound) || 0)
  // 只有 enforce 且判定 throttle 时才真的压上限；其余一律保持原上限（门控永不放宽）
  const commentCap = speakGate.enforced && speakGate.decision === 'throttle'
    ? Math.min(cfgCommentCap, Number(speakGate.suggestedMaxComments) || cfgCommentCap)
    : cfgCommentCap

  // 章程 + 本轮参数：与人设无关，先算好；人设降级后直接复用（不重算、不重读章程）
  const head = `你是这个账号的用户本人——一个独立、有自己判断的普通网友。现在按自己的兴趣刷一轮B站，看到值得的留下点痕迹。`
  const rest = (charter
    ? `\n===== 值班章程（<家目录> 已替换为真实路径）—— 严格按它执行 =====\n\n${charter}\n===== 章程结束 =====\n\n`
    : `然后读章程 ${join(PROMPTS_DIR, 'duty.md')}（章程里的 <家目录> 指 ${HOME}），严格按它执行。\n\n`)
    + `本轮参数：\n`
    + `- 记账：本轮 round id = ${roundId}（账本 ${LEDGER_FILE} 事件的 round 字段用这个值）；账本绝对路径 = ${LEDGER_FILE}。\n`
    + `- 报告：${report}\n`
    + `- 配额（全天总量）：挑中 ${quota} 条（今天已挑 ${picked} ⇒ 本轮最多再挑 ${left} 条）；`
    + `评论 ${Math.max(0, Number(cfg?.commentsPerDay) || 0)} 条/天（今天已 ${q.comments}），本轮最多 ${commentCap} 条${commentCap < cfgCommentCap ? `（门控压过：原 ${cfgCommentCap} → ${commentCap}）` : ''}；`
    + `点赞 ${Math.max(0, Number(cfg?.likesPerDay) || 0)} 个/天（今天已 ${q.likes}）；`
    + `动态 ${Math.max(0, Number(cfg?.dynamicsPerDay) || 0)} 条/天（今天已 ${q.dynamics}）；`
    + `跟进回复本轮最多 ${Math.max(0, Number(cfg?.repliesPerRound) || 0)} 条。\n`
    + `- 发言节奏（宿主算好、别自己数）：${describeRoundGate(speakGate)}\n`
    + `- ⭐ 主动接话（**每轮硬步骤** + 可发 0..${Math.max(0, Number(cfg?.replyOthersPerRound ?? 2))} 条）：`
    + `本轮**必须先做一次「接话扫描」**——从已拉到的热评里评估 ≥1 条能不能接，`
    + `把结论写进报告的一行「接话扫描：…」，并向账本追加一条 reply-scan 事件；`
    + `即使不接也要写（写「候选 0 / 全部不接 + 理由」），不写扫描 = 本轮不合规。`
    + `扫描这一步**不占**「工具调用 ≤20」的预算；真接一条只多 1 次 bili_reply。`
    + `可发上限 ${Math.max(0, Number(cfg?.replyOthersPerRound ?? 2))} 条（0 = 只扫描、不接）。\n`
    + `- 已看过清单（宿主从账本算好，最近 14 天，命中 = 之前看过/评过/赞过/跳过过）：`
    + (seenBvs.length ? `${seenBvs.join('、')}。\n`
        + `  命中的候选**直接丢**：不读信息、不读字幕、不点赞不评论、不进报告、不记判重表（账本里本来就有，别再花任何调用）。\n`
      : '（空——账本里还没有看过的记录，照常逐条判。）\n')
    + `- 已接话清单（宿主从账本算好，近 14 天；命中 = 别再重复接同一条/同一个人）：`
    + (proactiveMine.length
      ? `${proactiveMine.map((x) => `${x.bvid}→对方 rpid ${x.parent}`).join('、')}。\n`
      : '（空——还没接过，照常挑。）\n')
    + `- 接话正确姿势：bili_comments 返回的每条热评都带 rpid；接话时 bili_reply 传 rpid=<对方一级评论 rpid>、root 留空`
    + `（工具会自动把 root 置成 rpid、进楼中楼）；返回里的 rpid 是你自己的楼层，记进账本。\n`
    + `- 内容源（按这个优先级拉；上一档挑够或没有可看的，再看下一档）：\n${sourceLines.join('\n')}\n`
    + `- ${avoidBlock}\n`
    + `- 本轮开关（与章程/人设冲突时以本节为准）：\n${switchLines.map((x) => '  ' + x).join('\n')}\n`
    + `- 评论口吻：像普通观众随口一句——短、口语、只抓一个点。**收在情绪/问题/梗上，不要收在判断上**（「…欠得很」「…一下就说死了」这种判断句没人能接）；「原来 A 是 B」改写成「我以为 A，结果 B」；复述视频里的点必须再创作一层（场景复现/类比/追问），写不出就不发；别为「像人」而扩写。不要提「小号 / 分身 / 值班 / 运营 / 账号主人」。\n`
    + `- 你的 MCP 工具带 bili- 前缀（如 bili_search / bili_subtitle / bili_reply / bili_like / bili_send_dynamic）。\n`
    + `- 判重表 = ${join(HOME, 'seen.md')}（绝对路径，别写错地方）；归档 = ${join(DIGEST_DIR, dayKey().slice(0, 7) + '.md')}。\n`
    + `- 完成后：报告（按章程契约）+ 判重表，最后用一句话汇报本轮做了什么。现在几点了自己看一眼系统时间。`

  const assemble = (res) => head + (res.before || '') + rest + (res.after || '')
  const assembleNoBefore = (res) => head + rest + (res.after || '')

  let personaRes = personaOnce()
  let prompt = assemble(personaRes)
  let guard = guardPrompt(prompt)
  let degraded = []
  let droppedBefore = false

  // 预算守卫：prompt 走 argv（Windows 命令行上限 32,767 字符）。
  // W1-5：超软线不再"整段丢 after"（那会精确丢掉最有用的 L0 尾注），而是按 degradationPlan
  //       二次编译人设：先 lore:shrink / samples:half，再 lore:drop / samples:drop / state:shrink，
  //       **尾注不动**；实际降级动作记进 getLastPersonaInject() 供 W2-1 归因。
  if (guard.level !== 'ok') {
    const plan = degradationPlan(guard.level)
    if (plan.length) {
      const retry = personaOnce(plan)
      const p2 = assemble(retry)
      const g2 = guardPrompt(p2)
      if (g2.len < prompt.length) {
        personaRes = retry
        prompt = p2
        guard = g2
        degraded = retry.degraded || plan
      }
      // over 时再补一刀：state:shrink 只省几十字；仍超硬线就把状态整块砍掉（尾注依然不动）
      if (guard.level === 'over') {
        const drop = personaOnce([...plan, 'state:drop'])
        const p3 = assemble(drop)
        const g3 = guardPrompt(p3)
        if (g3.len < prompt.length) {
          personaRes = drop
          prompt = p3
          guard = g3
          degraded = drop.degraded || [...plan, 'state:drop']
        }
      }
      // 最后一道安全阀：仍超硬线时宁可砍**前段身份**，也保住 C2（状态+手感+尾注）
      if (guard.level === 'over' && personaRes.before) {
        const p4 = assembleNoBefore(personaRes)
        if (p4.length < prompt.length) {
          prompt = p4
          guard = guardPrompt(p4)
          droppedBefore = true
        }
      }
    }
    log(`值班 prompt ${guard.len} 字符（${guard.level}；软线 ${guard.softMax} / 硬线 ${guard.hardMax}）`
      + (degraded.length ? ` → 人设降级：${degraded.join('、')}` : '')
      + (droppedBefore ? ' → 已放弃前段身份（保尾注）' : ''))
    if (guard.level === 'over') log('⚠️ 降级后仍超硬线：本轮仍带尾注（不再整段丢 after），但 argv 可能被截断，请检查章程/参数段')
  }

  // ⭐ 只落 pending，不直接写冷却表（本轮可能根本起不来）；轮末 commitPendingUsage 转正。
  //    必须用**最终**（可能已降级）的人设：被砍掉的见闻/语料本来就没进 prompt，不该记成"用过"。
  writePendingUsage(roundId, personaRes)
  if (personaRes.notes?.length) log(`人设：${personaRes.notes.join('；')}`)

  // ⭐ W2-1：报告头一行「人设：whale@x（五块 · 合计；降级：…）」——宿主拼进「本轮参数」，模型照抄。
  //    放在**降级之后**：报告要写的是"这一轮实际吃了什么"，不是编译前的原版。
  const injectEvent = buildPersonaInjectEvent({
    round: roundId, personaRes, guard, degraded,
    notes: droppedBefore ? ['dropped-before：为过硬线放弃前段身份，保 L0 尾注'] : [],
  })
  if (injectEvent && prompt.includes('本轮参数：\n')) {
    prompt = prompt.replace('本轮参数：\n', `本轮参数：\n- 人设（报告头照抄这一行）：${describePersonaInject(injectEvent)}\n`)
    // 这一行也是 prompt 的一部分，重新过守卫（几十字符，超软线时也要被计入）
    const gLine = guardPrompt(prompt)
    if (gLine.level !== guard.level) log(`人设报告行把 prompt 推到 ${gLine.len} 字符（${gLine.level}）`)
    guard = gLine
  }

  // W2-1 归因的原始素材：这轮吃了哪版人设、块体量、守卫结果、降级动作
  lastPersonaInjectRecord = { roundId, personaRes, guard, degraded, droppedBefore, injectEvent, at: new Date().toISOString() }
  // W7-2：轮级节奏闸的原始素材（runDuty 在 spawn 前落一条 speak-decision 事件）
  lastSpeakGateRecord = { roundId, gate: speakGate, at: gateAt.toISOString() }
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
    //    W2 收尾接线：`review` = 写入前复核位；`originals` = 本轮评论区原文（宿主在 spawn 前还没拉到热评 ⇒ 空）。
    //    `cfg.growthCheckedOnly` 由 processGrowth 自己读（config schema 已补，人工位 = 只转正 checked 的）。
    try {
      const g = processGrowth({ cfg, events: readLedger(), review: growthReview, originals: [] })
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
    // ⭐ W3-1：overlay 写不出去 ⇒ **本轮不 spawn**。旧实现只是不 push `--patch`，
    //    结果用「残缺 overlay」起轮：三个服务没开、MCP 工具一个都没有，模型空转烧配额。
    //    宁可这一轮明确失败（lastError 进 state、控制台/诊断可见），也不烧一轮配额。
    if (!overlay) {
      const msg = 'overlay 写失败：headless-overlay.yml 落盘失败，本轮不 spawn（用残缺 overlay 起轮等于没有 MCP 工具）'
      log(msg)
      try { live.end({ code: null, durationMs: 0 }) } catch { /* 兜住 */ }
      bumpState({ lastError: msg, lastRunAt: new Date().toISOString(), lastWhy: why, lastCode: 'overlay-failed' })
      try { overviewHub.publish('round-failed') } catch { /* 兜住 */ }
      return { started: false, why, error: msg }
    }
    const profile = String(cfg?.headlessProfile || 'headless').trim() || 'headless'
    const args = ['--profile', profile, '--patch', overlay]
    const dutyPrompt = buildDutyPrompt(cfg, roundId, readLedger())
    // ⭐ W2-1 归因：人设注入**成功后**立刻落一条 persona-inject 事件（成本 0）。
    //    为什么在这里而不是 buildDutyPrompt 里：那是纯装配函数，不该产生 IO；
    //    而且此刻才确定"这一轮真的要跑了"——起不来的轮次不该在账本上留注入记录。
    try {
      const info = getLastPersonaInject()
      const ev = buildPersonaInjectEvent({
        round: roundId,
        personaRes: info?.personaRes,
        guard: info?.guard,
        degraded: info?.degraded || [],
        notes: info?.droppedBefore ? ['dropped-before：为过硬线放弃前段身份，保 L0 尾注'] : [],
      })
      if (ev) {
        appendEvents(LEDGER_FILE, [ev])
        log(`人设归因：${describePersonaInject(ev)}`)
      } else {
        const mode = info?.personaRes?.mode || 'unknown'
        log(`人设归因：本轮走 ${mode}，没有卡链路注入可记（legacy/missing 不落 persona-inject）`)
      }
    } catch (e) { log(`写 persona-inject 失败（不影响本轮）：${e?.message ?? e}`) }
    // ⭐ W7-2 归因：节奏闸的判定也落账本（`scope:'round'`）——控制台据此解释
    //    "这轮为什么只发 1 条 / 为什么没被拦"，而不是让主人猜。observe 档同样记（这就是它存在的意义）。
    try {
      const gateInfo = getLastSpeakGate()
      const gateEv = roundGateEvent(gateInfo?.gate, { round: roundId })
      if (gateEv) {
        appendEvents(LEDGER_FILE, [gateEv])
        log(describeRoundGate(gateInfo.gate))
      }
    } catch (e) { log(`写 speak-decision 失败（不影响本轮）：${e?.message ?? e}`) }
    args.push(dutyPrompt)
    log(`值班轮开跑（${why}）：profile=${profile} cli=${cli}`)
    log(`值班轮 spawn 调试：execPath=${process.execPath} resourcesPath=${process.resourcesPath || '（无）'}`)
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: HOME,
      windowsHide: true,
      // POSIX：独立进程组（W3-6 超时用 process.kill(-pid) 杀整棵树）；Windows 不需要
      detached: process.platform !== 'win32',
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
    // ⭐ W3-6：20 分钟硬超时。到点先记 lastError、再杀进程树；exit 收尾时按 `round-end code:'timeout'` 落账本，
    //    这样「挂死的一轮」在账本/概览/报告兜底里都是一条可查的失败，而不是永远 running。
    roundTimedOut = false
    if (roundTimer) { try { clearTimeout(roundTimer) } catch { /* 兜住 */ } }
    roundTimer = setTimeout(() => {
      roundTimedOut = true
      const msg = `值班轮硬超时：超过 ${Math.round(ROUND_TIMEOUT_MS / 60_000)} 分钟仍未退出 ⇒ 强杀进程树`
      log(msg)
      try { bumpState({ lastError: msg }) } catch { /* 兜住 */ }
      killProcessTree(child)
    }, ROUND_TIMEOUT_MS)
    roundTimer.unref?.()
    // ⭐ 每条流一个**持久**解码器：跨 chunk 的多字节字符不会被切坏（旧版按块嗅探编码，
    //    中文整段被当 GBK 二次解码 ⇒ duty.log 乱码）。
    //    stdout 只留尾部 4KB（里面主要是模型 reasoning，全量落盘既肥又敏感）；
    //    stderr 全量保留（诊断主要靠它）。完整原始流已由 live.pushChildChunk 进环形缓冲。
    const decOut = createUtf8Decoder()
    const decErr = createUtf8Decoder()
    child.stdout?.on('data', (buf) => {
      try { live.pushChildChunk(buf) } catch { /* 实时流失败不影响日志 */ }
      appendLogChunk(keepTail(decOut.write(buf), 4096))
    })
    child.stderr?.on('data', (buf) => {
      try { live.pushChildChunk(buf) } catch { /* 同上 */ }
      appendLogChunk(decErr.write(buf))
    })
    child.on('error', (e) => {
      log(`值班轮起不来：${e?.message ?? e}`)
      running = false
      currentChild = null
      if (roundTimer) { try { clearTimeout(roundTimer) } catch { /* 兜住 */ } roundTimer = null }
      try { live.end({ code: null, durationMs: Date.now() - currentRoundAt }) } catch { /* 兜住 */ }
      bumpState({ lastError: `值班轮起不来：${e?.message ?? e}` })
    })
    child.on('exit', (rawCode) => {
      if (roundTimer) { try { clearTimeout(roundTimer) } catch { /* 兜住 */ } roundTimer = null }
      // ⭐ W3-6：超时被杀的一轮在账本里必须是 code:'timeout'（不是 shell 的 1 / null）
      const code = roundTimedOut ? 'timeout' : rawCode
      running = false
      const durationMs = Date.now() - currentRoundAt
      currentChild = null
      log(`值班轮结束（${why}，code=${code}${roundTimedOut ? '（超时强杀）' : ''}）`)
      try { live.end({ code, durationMs }) } catch { /* 兜住 */ }
      try {
        const endedRound = currentRoundId
        // 先按报告兜底回填（agent 忘写账本时，接话/评论仍能从报告里找回来），再盘点本轮
        backfillFromReport(endedRound)
        const stNow = readJson(STATE_FILE, {})
        const acc = roundAccounting(readLedger(), endedRound, { scanSince: Number(stNow.replyScanSince) || 0 })
        appendEvents(LEDGER_FILE, [{
          t: new Date().toISOString(), round: endedRound, type: 'round-end', code, durationMs,
          replyScans: acc.counts.scans,
          proactiveReplies: acc.counts.proactive,
          proactiveSkipped: acc.counts.scanSkips,
          proactiveMissing: acc.proactiveMissing,
        }])
        if (acc.proactiveMissing) {
          // 「没接」可以是判断，「没扫描」不行：这一行让下一轮的模型与主人都能看见
          log(`本轮未做接话扫描（不合规）round=${endedRound}`)
          appendEvents(LEDGER_FILE, [{ t: new Date().toISOString(), round: endedRound, type: 'note', text: 'round incomplete: no reply-scan' }])
        }
        // ⭐ 人设用量转正：本轮确认跑完，才把"摆到台面上的见闻/语料"记进冷却表
        commitPendingUsage(endedRound)
      } catch (e) { log(`写 round-end 失败：${e?.message ?? e}`) }
      stubReportIfMissing(code)
      rotateLogIfBig()
      bumpState({
        lastRunAt: new Date().toISOString(), lastWhy: why, lastCode: code, lastDurationMs: durationMs,
        // 轮末刷新 lastError：成功清空；超时/非 0 退出留一条可读原因（控制台/诊断直接展示）
        lastError: roundTimedOut ? `本轮硬超时（${Math.round(ROUND_TIMEOUT_MS / 60_000)} 分钟）已被强杀`
          : (rawCode === 0 ? '' : `本轮退出码 ${rawCode}`),
      })
      try { overviewHub.publish('round-end') } catch { /* 兜住 */ }
      // ⭐ 90 秒后复核（评论区压审对策）；不拖住宿主退出
      const t = setTimeout(() => { verifyRecentSafe('round').catch(() => {}) }, 90_000)
      t.unref?.()
    })
    // ⭐ 只记「本轮开始时间」；lastRunAt/lastCode/lastDurationMs 是**上一轮的结果**，轮末才写。
    //    旧版两处都写 lastRunAt，于是运行中概览显示「本轮开始时间 + 上一轮退出码」。
    bumpState({ lastRunStartedAt: new Date().toISOString(), lastWhy: why, lastError: '' })
    try { overviewHub.publish('round-start') } catch { /* 兜住 */ }
    return {
      started: true, why, roundId, profile, cli, cwd: HOME, log: LOG_FILE,
      model: { provider: em.provider, model: em.model, reasoningEffort: em.reasoningEffort },
    }
  } catch (e) {
    starting = false
    running = false
    currentChild = null
    if (roundTimer) { try { clearTimeout(roundTimer) } catch { /* 兜住 */ } roundTimer = null }
    try { live.end({ code: null, durationMs: 0 }) } catch { /* 兜住 */ }
    const msg = `值班轮开跑失败（${why}）：${e?.stack ?? e}`
    log(msg)
    try { bumpState({ lastError: `值班轮开跑失败：${e?.message ?? e}` }) } catch { /* 兜住 */ }
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
    const events = readLedger()
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
    bumpState({ seenNotifs: [...seen].slice(-500), lastReplyPollAt: new Date().toISOString(), lastReplyPollOk: true })
    try { overviewHub.publish('reply-tick') } catch { /* 兜住 */ }
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

/* ───────────────────────── overview 组装（设计定稿 2026-10-28 §2.1） ───────────────────────── */
/* 纯计算搬进 lib/overview.js（可单测）；这里只负责「取真实输入」：
 *   - live.snapshot() ⇒ 运行中的真实进度（解 A1：账本是轮末批量写的，不能当进度源）
 *   - 账本按 roundId 聚合 ⇒ lastRound（解 A2：不再拼「新开始时间 + 上一轮退出码」）
 *   - 账号 5 分钟缓存 ⇒ 网络抖动不把「已登录」翻成「未登录」（解 A3）
 */

// 账号缓存：概览需要它，但 B站 nav 是网络请求 —— 5 分钟一次，失败保留上次 good 值
let accountCache = { at: 0, value: null }
const ACCOUNT_TTL = 5 * 60_000
const accountForOverview = async ({ force = false } = {}) => {
  const nowMs = Date.now()
  if (!force && accountCache.value && nowMs - accountCache.at < ACCOUNT_TTL) return accountCache.value
  try {
    const acc = await fetchAccount(readCred())
    accountCache = { at: nowMs, value: { ...(acc || { loggedIn: false }), checkedAt: new Date().toISOString(), stale: false } }
  } catch (e) {
    if (accountCache.value) accountCache = { ...accountCache, value: { ...accountCache.value, stale: true } }
    log(`拉账号失败（保留上次结果）：${e?.message ?? e}`)
  }
  return accountCache.value
}

// CLI 探测会扫目录：**命中缓存 10 分钟，未命中只缓存 60 秒**。
// 旧版两侧都是 10 分钟 —— 未命中时每次轮询都重探（duty.log 一分钟一条就是它），
// 命中时又让「刚填好的 dshBin」最多 10 分钟不生效。缓存 key 还带上 dshBin，改配置即重探。
let cliHealthCache = { at: 0, value: '', key: null }
const cliForHealth = () => {
  const nowMs = Date.now()
  const key = String(effCfg()?.dshBin || '').trim()
  const ttl = cliHealthCache.value ? 10 * 60_000 : 60_000
  if (cliHealthCache.key === key && nowMs - cliHealthCache.at < ttl) return cliHealthCache.value
  let value = ''
  try { value = dshCliCached(effCfg()) || '' } catch { /* 兜住 */ }
  cliHealthCache = { at: nowMs, value, key }
  return value
}

/** 保存配置后主动失效 CLI 探测缓存（由 lib/api.js 的 POST /config 调用，见 CONSOLE-ISSUES P1-4）。 */
export const resetCliCaches = () => {
  dshCliCache = { v: null, at: 0, key: null }
  cliHealthCache = { at: 0, value: '', key: null }
}

const overviewHealth = () => ({
  cli: cliForHealth(),
  cliCheckedAt: cliHealthCache.at ? new Date(cliHealthCache.at).toISOString() : '',
  cred: existsSync(BILI_CRED_FILE),
  routeOk: routeRegistered,
})

const buildOverview = () => {
  const cfg = effCfg()
  const st = readJson(STATE_FILE, {})
  const events = readLedger()
  let liveSnap = null
  try { liveSnap = live.snapshot(0) } catch { liveSnap = null }
  return buildOverviewData({
    cfg,
    state: st,
    events,
    liveSnap,
    account: accountCache.value,
    health: overviewHealth(),
    // ⭐ 存在感不再在这里对**全量**事件算：交给 buildOverviewData 在「近 N 天」窗口子集上算（W4-2b）。
    //    旧写法 `presenceFrom(events)` 会为了 7 天窗口把 10 万条全扫一遍，窗口优化等于白做。
    now: new Date(),
    home: HOME,
    ledgerFile: LEDGER_FILE,
  })
}

// ⭐ 实时中枢：/overview 与 /stream 共用同一份信封（seq / 新鲜度 / 运行中进度）
const overviewHub = createOverviewHub({ compute: () => buildOverview() })

// tick 帧用：本轮动作计数（不重算整封信，只算一次账本）
// ⭐ W4-2：账本没变（reader 命中缓存时返回**同一个数组引用**）就复用上次结果 ——
//    roundAccounting 是 O(事件数) 的全表过滤，10 万行 ~2.5ms；SSE tick 每 1.5s 一次，不该每次都重算。
let quotaPerRoundCache = { events: null, roundId: '', scanSince: -1, value: null }
const quotaPerRound = () => {
  try {
    const rid = currentRoundId
    if (!rid) return null
    const st = readJson(STATE_FILE, {})
    const scanSince = Number(st.replyScanSince) || 0
    const events = readLedger()
    const c = quotaPerRoundCache
    if (c.events === events && c.roundId === rid && c.scanSince === scanSince) return c.value
    const acc = roundAccounting(events, rid, { scanSince })
    const value = { roundId: rid, ...acc.counts }
    quotaPerRoundCache = { events, roundId: rid, scanSince, value }
    return value
  } catch { return null }
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
              // W1-3：预算面板也读卡（`card.render.budget` 优先，缺省回落 budget.js），否则"卡改了面板不变"
              budget: {
                blocks: loaded.card ? { ...resolveBudget(loaded.card) } : { core: 1500, lore: 300, state: 500, samples: 450, tail: 250 },
                totalMax: 3000,
              },
            })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/preview') {
          try { return sendJson(res, 200, previewPersona({ events: readLedger() })) }
          catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        // ── W5-3 服务端两个端点（体检 / 换卡对比）──
        // ⚠️ 纯函数由 lib/persona/{checkup,tagstats}.js 提供，**必须动态 import + try/catch**：
        //    顶层静态 import 会在模块还没落地时让整个 index.js 加载失败（全站测试一起红）。
        //    文件缺失 ⇒ 200 + ok:true + 空结构（绝不 500），文件一落地自动切真实现（import 有模块缓存）。
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/checkup') {
          const empty = { ok: true, windowDays: 14, n: 0, metrics: null, baseline: null, verdict: { level: 'ok', reasons: ['体检模块未就绪'] }, samples: [] }
          try {
            const mod = await import('./lib/persona/checkup.js').catch(() => null)
            if (!mod || typeof mod.buildCheckup !== 'function') return sendJson(res, 200, empty)
            const now = new Date()
            const out = mod.buildCheckup({
              // 体检只看近 14 天：先切窗口子集再算（10 万行账本不整扫）
              events: windowPool(readLedger(), now, 14),
              now,
              windowDays: 14,
              limit: 20,
              card: loadCard(readActive()).card,
            }) || {}
            return sendJson(res, 200, {
              ok: true,
              windowDays: Number.isFinite(Number(out.windowDays)) ? Number(out.windowDays) : 14,
              n: Number(out.n) || 0,
              metrics: out.metrics || null,
              baseline: out.baseline || null,
              verdict: out.verdict || { level: 'ok', reasons: [] },
              samples: Array.isArray(out.samples) ? out.samples : [],
            })
          } catch (e) {
            log(`体检端点失败（已降级为空结构）：${e?.message ?? e}`)
            return sendJson(res, 200, empty)
          }
        }
        if (req.method === 'GET' && path === '/api/bili-fenshen/persona/history') {
          const empty = { ok: true, tags: [] }
          try {
            const mod = await import('./lib/persona/tagstats.js').catch(() => null)
            if (!mod || typeof mod.buildTagStats !== 'function') return sendJson(res, 200, empty)
            const out = mod.buildTagStats({ events: readLedger(), limitPerTag: 3 }) || {}
            return sendJson(res, 200, { ok: true, tags: Array.isArray(out.tags) ? out.tags : [] })
          } catch (e) {
            log(`换卡对比端点失败（已降级为空结构）：${e?.message ?? e}`)
            return sendJson(res, 200, empty)
          }
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
            // W3-3：列表接口要能看到回收站里的条目（disabled:true），但**编译**永远用默认值（跳过）。
            const entries = resolveLoreIndex(loaded.card, loadState(), new Date(), { includeDisabled: true }).map((e) => {
              const p = lorePath(e.id, active)
              let body = ''
              try { body = readFileSync(p, 'utf8') } catch { /* 正文可缺，索引仍可用 */ }
              return { ...e, path: p, chars: body.length, body }
            })
            // W3-3：孤儿扫描结果随索引一起回（控制台可提示"有正文没索引 / 有索引没正文"），同时写日志
            const orphans = scanPersonaLoreOrphans()
            logLoreOrphans(orphans, 'GET persona/lore')
            return sendJson(res, 200, { ok: true, entries, orphans })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/expression') {
          try {
            const body = await readBody(req)
            // ⭐ W3-3：删除类动作（软删 remove / 物理删 purge）前先留痕 `<file>.bak-<ts>`（保留最近 3 份）。
            //    preset 模式先物化用户副本，否则备份到的是内置包里的只读资产、而且随后写的是家目录副本。
            const act = String(body?.action || '')
            if (act === 'remove' || act === 'purge') {
              try { materializeUserCopy() } catch { /* 兜住：物化失败后面 editExpressionBank 自己会报 */ }
              const bak = backupFileKeep(personaAssetPaths().bankFile)
              if (bak) log(`语料库${act === 'purge' ? '物理删除' : '软删除'}前已留痕（.bak-<ts>，保留 ${BAK_KEEP} 份）`)
            }
            const out = editExpressionBank(body || {})
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error || '语料库更新失败' })
            log(`语料库已更新（${out.action} / ${out.form}）：共 ${out.total} 条${out.soft ? `，回收站 ${out.disabled ?? 0} 条（可 restore）` : ''}`)
            // 语料库的 bank.active 是 L4 反抄快照的输入 ⇒ 改了库就重导规则文件（同样失败不拖垮）
            if (out.lintRules && out.lintRules.ok === false) log(`⚠️ 质量门规则重导失败（语料库已更新）：${out.lintRules.error}`)
            return sendJson(res, 200, {
              ok: true, action: out.action, form: out.form,
              total: out.total, buckets: out.buckets, updatedAt: out.updatedAt,
              // W3-3：remove = 软删除（客户端据此显示「已移入回收站（可恢复）」）；disabled = 回收站条数
              soft: out.soft === true, disabled: Number(out.disabled) || 0,
              materialized: out.materialized, active: out.active,
              lintRules: out.lintRules || null,
            })
          } catch (e) { return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
        }
        if (req.method === 'POST' && path === '/api/bili-fenshen/persona/lore') {
          try {
            const body = await readBody(req)
            const act = String(body?.action || '')
            const sid = String(body?.id || '').trim()
            // ⭐ W3-3：删前留痕。索引住在卡里 ⇒ 备份 card.json；purge 会物理丢索引，
            //    正文文件也一并挪成 .bak-<ts> 再删（软删除 remove 保留正文，restore 才有东西可恢复）。
            if (act === 'remove' || act === 'purge') {
              try { materializeUserCopy() } catch { /* 兜住 */ }
              const p = personaAssetPaths()
              if (backupFileKeep(p.cardFile)) log(`见闻索引${act === 'purge' ? '物理删除' : '软删除'}前已留痕（card.json.bak-<ts>）`)
              if (act === 'purge' && /^[\w-]{1,64}$/.test(sid)) {
                const bodyFile = join(p.loreDir, `${sid}.md`)
                if (backupFileKeep(bodyFile)) {
                  try { unlinkSync(bodyFile) } catch { /* 删不掉就留着，孤儿扫描会报出来 */ }
                  log(`见闻正文已归档为 .bak（${sid}），原文件移除`)
                }
              }
            }
            const out = editLoreIndex(body || {})
            if (!out.ok) return sendJson(res, 400, { ok: false, error: out.error || '见闻索引更新失败' })
            const orphans = scanPersonaLoreOrphans()
            logLoreOrphans(orphans, `POST persona/lore ${out.action}`)
            log(`见闻索引已更新（${out.action}）：共 ${out.count} 条`)
            return sendJson(res, 200, {
              ok: true, action: out.action, count: out.count, snapshot: out.snapshot || '',
              soft: out.action === 'remove', materialized: out.materialized, orphans,
            })
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
            // W2-2 收尾：保存卡会**顺带重导** lint-rules.json（§6.3「卡一改就重导」）。
            // 规则写失败绝不能拖垮保存，但必须留痕 —— 否则规则坏了是静默放行，没人知道。
            if (out.lintRules && out.lintRules.ok === false) log(`⚠️ 质量门规则重导失败（卡已保存，Python 侧仍用旧规则）：${out.lintRules.error}`)
            return sendJson(res, 200, {
              ok: true, warnings: out.warnings || [], snapshot: out.snapshot || '', active: readActive(),
              lintRules: out.lintRules || null,
            })
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
            if (out.lintRules && out.lintRules.ok === false) log(`⚠️ 质量门规则重导失败（版本已回滚，Python 侧仍用旧规则）：${out.lintRules.error}`)
            return sendJson(res, 200, { ok: true, snapshot: out.snapshot || '', active: readActive(), lintRules: out.lintRules || null })
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
        '/api/bili-fenshen/live', '/api/bili-fenshen/live/stream', '/api/bili-fenshen/stream',
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
        // W5-3：体检 / 换卡对比（纯函数在 lib/persona/{checkup,tagstats}.js，动态 import 降级）
        '/api/bili-fenshen/persona/checkup', '/api/bili-fenshen/persona/history',
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
          readEvents: () => readLedger(),
          overview: buildOverview,
          overviewHub,
          // ⭐ 保存配置后失效 CLI 探测缓存（否则改 dshBin 最长 10 分钟不生效）
          resetCliCaches,
          quotaPerRound,
          setDuty: (v) => {
            const cur = effectiveConfig(cfgSnapshot || {}, CONFIG_FILE)
            writeOverride(CONFIG_FILE, { ...cur.values, autoDuty: v })
            log(`自动值班 ${v ? '开启' : '关闭'}（操作台）`)
            try { overviewHub.publish('duty') } catch { /* 兜住 */ }
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
            // ⭐ W4-3：SSE tick 的**空闲短路**。纯内存布尔，不读账本/配置（snapshot 会读，见 liveSnapshot）。
            isRunning: () => running || live.isRunning(),
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

  // ── 概览实时中枢：2s 兜底轮询 + 账号 5 分钟预热（设计定稿 §2.2/§2.4）──
  //    没有 fs.watch 也能在 2s 内反映账本/state 变化；publish 自身有 debounce+最小间隔，不会打爆重算。
  try {
    const st0 = readJson(STATE_FILE, {})
    if (!st0.replyScanSince) bumpState({ replyScanSince: new Date().toISOString() })
    overviewHub.publish('startup')
    accountForOverview().catch(() => {})
    // ⭐ 2s 兜底：先比 mtime/大小，变了才 publish —— 账本最大 5 MB，每 2s 全量重解析会白烧 CPU
    let lastSig = ''
    const fileSig = () => {
      const one = (p) => { try { const s = statSync(p); return s.size + '@' + Math.floor(s.mtimeMs) } catch { return '-' } }
      return [one(LEDGER_FILE), one(STATE_FILE), one(CONFIG_FILE)].join('|')
    }
    const hubPoll = setInterval(() => {
      try {
        const sig = fileSig()
        if (sig === lastSig) return
        lastSig = sig
        overviewHub.publish('poll')
      } catch { /* 兜住 */ }
    }, 2000)
    hubPoll.unref?.()
    disposers.push(() => { try { clearInterval(hubPoll) } catch { /* 兜住 */ } })
    const acctTimer = setInterval(() => {
      accountForOverview({ force: true }).then(() => overviewHub.publish('account')).catch(() => {})
    }, 5 * 60_000)
    acctTimer.unref?.()
    disposers.push(() => { try { clearInterval(acctTimer) } catch { /* 兜住 */ } })
    disposers.push(() => { try { overviewHub.close() } catch { /* 兜住 */ } })
  } catch (e) { log(`实时中枢启动失败（已兜住）：${e?.message ?? e}`) }

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
    // W2 收尾：同样注入复核位与 originals（启动时没有「本轮评论区」，传空）
    const g = processGrowth({ cfg: effCfg(), events: readLedger(), review: growthReview, originals: [] })
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
