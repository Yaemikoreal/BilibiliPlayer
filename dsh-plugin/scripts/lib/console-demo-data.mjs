/**
 * 全局控制台演示稿 v3 · 真实数据组装
 *
 * 只读真实快照，不发网络请求、不写任何状态：
 *   - <realHome>/config.json         运行时配置覆盖层（effectiveConfig：schema 默认 ← 覆盖层）
 *   - <realHome>/state.json          上一轮值班结果（lastCode/lastWhy/lastDurationMs/lastRunAt）
 *   - <realHome>/ledger.jsonl        机器账本（lib/ledger.js readEvents，脏行抢救）
 *   - <realHome>/seen.md             判重表（按 seen.md 的真实行格式解析）
 *   - <realHome>/out/*.md            日报原文（整份带上）
 *   - <realHome>/digest/*.md         归档摘要（只带文件名与字节数）
 *   - <realHome>/headless-overlay.yml 值班轮 overlay 原文
 *   - <plugin>/prompts/persona/whale.card.json  账号名（人设卡里的号名）
 *   - <repo>/bili_credential.json    只判断是否存在，**不读取内容**（cookie/token 绝不进 JSON）
 *
 * 活动聚合全部走 lib/activity.js（toActivities + groupByDay + stageOf）：
 *   events 的 text 截 80 字，保留 type/t/rpid/parent/user/reason/from/round。
 *
 * 拿不到的字段一律降级为空/null + 文案说明，绝不编造点赞数、等级、粉丝数这类
 * 无法从本地快照验证的数字。实时「运行中」是演示示例：事件由上一轮真实产物改写。
 *
 * @param {object} opts
 * @param {string} [opts.pluginDir] <repo>/dsh-plugin（默认由本文件位置推导）
 * @param {string} [opts.realHome]  真实家目录（默认 BILI_FENSHEN_HOME 或 ~/.dsh/bili-fenshen）
 * @returns {Promise<object>} 与 console-demo-v3.html 的 data 块同构
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPersonaDemoData, DEFAULT_PLUGIN_DIR, defaultRealHome, localStamp } from './persona-demo-data.mjs'

const fileUrl = (p) => pathToFileURL(p).href
const pad = (n) => String(n).padStart(2, '0')

/** 本地日期键 YYYY-MM-DD（不用 toISOString：那是 UTC） */
const dayKeyOfLocal = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())

const readText = (p) => {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}
const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}
const listDir = (p) => {
  try { return readdirSync(p) } catch { return [] }
}
const fileBytes = (p) => {
  try { return statSync(p).size } catch { return 0 }
}
const cut = (s, n = 80) => {
  const t = s == null ? '' : String(s)
  return t.length > n ? t.slice(0, n) : t
}

/**
 * 从 index.js 的 export const Config = z.object({...}) 里**现算**配置 schema 默认值，
 * 再交给 lib/config.js 的 effectiveConfig 当 patch 默认层（避免在演示脚本里抄一份默认值）。
 * 用 z 桩对象求值静态对象字面量；源码结构变了也不会抛，退回 {}。
 */
const readConfigSchemaDefaults = (pluginIndexText) => {
  const at = pluginIndexText.indexOf('export const Config =')
  if (at < 0) return {}
  // 先去注释（注释里的引号/括号会干扰平衡扫描；引号内内容原样保留）
  let clean = ''
  let i = 0
  let inStr = false
  let quote = ''
  let esc = false
  while (i < pluginIndexText.length) {
    const ch = pluginIndexText[i]
    if (inStr) {
      clean += ch
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === quote) inStr = false
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === '\u0060') { inStr = true; quote = ch; clean += ch; i++; continue }
    if (ch === '/' && pluginIndexText[i + 1] === '/') {
      while (i < pluginIndexText.length && pluginIndexText[i] !== '\n') i++
      continue
    }
    if (ch === '/' && pluginIndexText[i + 1] === '*') {
      i += 2
      while (i < pluginIndexText.length && !(pluginIndexText[i] === '*' && pluginIndexText[i + 1] === '/')) i++
      i += 2
      continue
    }
    clean += ch
    i++
  }
  const at2 = clean.indexOf('export const Config =')
  const objAt = at2 < 0 ? -1 : clean.indexOf('z.object(', at2)
  if (objAt < 0) return {}
  const start = objAt + 'z.object('.length
  let depth = 0
  let end = -1
  let inS = false
  let q = ''
  let e = false
  for (let k = start; k < clean.length; k++) {
    const ch = clean[k]
    if (inS) {
      if (e) e = false
      else if (ch === '\\') e = true
      else if (ch === q) inS = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '\u0060') { inS = true; q = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = k; break }
    }
  }
  if (end < 0) return {}
  const literal = clean.slice(start, end + 1)
  const zStub = {
    boolean: () => ({ default: (v) => v }),
    natural: () => ({ default: (v) => v }),
    string: () => ({ default: (v) => v }),
    array: () => ({ default: (v) => v }),
    object: () => ({}),
  }
  try {
    // 仅对插件源码里的静态字面量求值，不是用户输入
    const fn = new Function('z', 'return (' + literal + ')')
    const out = fn(zStub)
    return out && typeof out === 'object' ? out : {}
  } catch {
    return {}
  }
}

const WINDOWS = {
  noon: { start: 12 * 60, end: 14 * 60 },
  night: { start: 18 * 60, end: 33 * 60 },
}
const inWindow = (d, w) => {
  const m = d.getHours() * 60 + d.getMinutes()
  const x = m < 12 * 60 ? m + 24 * 60 : m
  return x >= w.start && x < w.end
}
/** 与 index.js nextWindowLabel() 同一算法 */
const nextWindowLabelOf = (cfg, now = new Date()) => {
  try {
    const m = now.getHours() * 60 + now.getMinutes()
    const candidates = []
    if (cfg.noon && !inWindow(now, WINDOWS.noon)) candidates.push(['中午 12:00', (12 * 60 - m + 1440) % 1440])
    if (cfg.night && !inWindow(now, WINDOWS.night)) candidates.push(['晚间 18:00', (18 * 60 - m + 1440) % 1440])
    if (!candidates.length) return '—'
    candidates.sort((a, b) => a[1] - b[1])
    return candidates[0][0] + '（' + Math.floor(candidates[0][1] / 60) + 'h' + pad(candidates[0][1] % 60) + 'm 后）'
  } catch {
    return '—'
  }
}

/* 账本事件类型 → 直播里的工具名（演示回放用；动作映射同 lib/live.js ACTION_OF_TOOL） */
const TOOL_OF_TYPE = {
  view: 'bili_video_info',
  like: 'bili_like',
  comment: 'bili_reply',
  dynamic: 'bili_send_dynamic',
  'reply-in': 'bili_received_replies',
  'reply-out': 'bili_reply',
}
const ACTION_OF_TOOL = {
  bili_like: 'like',
  bili_reply: 'comment',
  bili_send_dynamic: 'dynamic',
  bili_received_replies: 'reply',
}

/**
 * 判重表：seen.md 的真实行格式是 markdown 列表「- 日期[ · 时间] · BV[ · 动作] · 标题」；
 * api.js 的正则只认「日期 时间 · …」（无列表前缀、时间用空格），对当前文件实测 0 行。
 * 这里按**文件真实格式**解析（去掉列表前缀 + 按 · 分段），字段名与 /seen 响应一致。
 */
const parseSeenRows = (raw) => {
  const rows = []
  const strict = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*·\s*(.*?)\s*·\s*(.*?)\s*·\s*(.*)$/
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const body = trimmed.replace(/^[-*]\s*/, '')
    // ⚠️ 分隔符是「空格·空格」；动作文本内部用的是不带空格的「跳过·无字幕」，不能一起切
    const parts = body.split(/\s+·\s+/)
    if (!parts.length || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) continue
    const date = parts[0]
    let idx = 1
    let time = ''
    if (parts[idx] && /^\d{1,2}:\d{2}$/.test(parts[idx])) { time = parts[idx]; idx++ }
    const rest = parts.slice(idx)
    const bvAt = rest.findIndex((x) => /BV[0-9A-Za-z]+/.test(x))
    let bvid = ''
    let action = ''
    let title = ''
    if (bvAt >= 0) {
      bvid = /BV[0-9A-Za-z]+/.exec(rest[bvAt])[0]
      const tail = rest.slice(bvAt + 1)
      action = tail[0] || ''
      title = tail.slice(1).join(' · ')
    } else {
      action = rest[0] || ''
      title = rest.slice(1).join(' · ').replace(/\s*·\s*-$/, '')
    }
    // 兜底：严格分支能匹配时优先用严格分支（与 api.js 口径一致的那几行）
    const m = strict.exec(trimmed)
    if (m && !time) { time = m[2] || time }
    rows.push({ date, time, bvid, action, title })
  }
  return rows
}

export async function buildConsoleDemoData({ pluginDir, realHome } = {}) {
  const PD = pluginDir ? resolve(pluginDir) : DEFAULT_PLUGIN_DIR
  const HOME = realHome ? resolve(realHome) : defaultRealHome()

  const { effectiveConfig } = await import(fileUrl(join(PD, 'lib', 'config.js')))
  const { readEvents } = await import(fileUrl(join(PD, 'lib', 'ledger.js')))
  const { toActivities, groupByDay } = await import(fileUrl(join(PD, 'lib', 'activity.js')))
  const { phaseOfTool } = await import(fileUrl(join(PD, 'lib', 'live.js')))

  /* ── 读真实快照（全部只读） ── */
  const state = readJson(join(HOME, 'state.json'), {})
  const events = readEvents(join(HOME, 'ledger.jsonl')) || []
  const patchConfig = readConfigSchemaDefaults(readText(join(PD, 'index.js')))
  const cfg = effectiveConfig(patchConfig, join(HOME, 'config.json'))
  const values = cfg.values || {}
  const now = new Date()
  const today = dayKeyOfLocal(now)

  const seenRaw = readText(join(HOME, 'seen.md'))
  const seenRows = parseSeenRows(seenRaw)

  const outDir = join(HOME, 'out')
  const digestDir = join(HOME, 'digest')
  const reportFiles = listDir(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
  const digestFiles = listDir(digestDir).filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
  const reportDays = reportFiles
    .map((f) => ({ date: f.replace(/\.md$/, ''), bytes: fileBytes(join(outDir, f)) }))
    .sort((a, b) => b.date.localeCompare(a.date))
  const reportContents = {}
  for (const d of reportDays) {
    reportContents[d.date] = readText(join(outDir, d.date + '.md')).replace(/\r\n/g, '\n')
  }
  const digests = digestFiles
    .map((f) => ({ name: f, bytes: fileBytes(join(digestDir, f)) }))
    .sort((a, b) => b.name.localeCompare(a.name))
  const overlayName = 'headless-overlay.yml'
  const overlayText = readText(join(HOME, overlayName))

  /* ── 账号：只判断凭证文件存在，不读取内容；号名取自人设卡 ── */
  const credentialFile = join(dirname(PD), 'bili_credential.json')
  const loggedIn = existsSync(credentialFile)
  const card = readJson(join(PD, 'prompts', 'persona', 'whale.card.json'), {})
  const nameHit = /号叫「([^」]+)」/.exec(String(card?.identity?.background || ''))
  const account = {
    loggedIn,
    name: nameHit ? nameHit[1] : '',
    midMasked: loggedIn ? 'UID 未读取' : '',
    level: null,
    coins: null,
    fans: null,
    vip: null,
    note: '账号名取自人设卡 identity.background；登录状态只看凭证文件是否存在；等级/硬币/粉丝/大会员需要联网，未拉取（null），不编造；UID 也不读凭证内容',
  }

  /* ── 配置 ── */
  const model = {
    provider: values.modelProvider || '',
    name: values.modelName || '',
    reasoningEffort: values.modelReasoningEffort || '',
  }

  /* ── 今日配额（账本是唯一事实来源，口径同 index.js quotaFromLedger） ── */
  const todayEvents = events.filter((e) => dayKeyOfLocal(new Date(e.t)) === today)
  const quota = {
    picked: todayEvents.filter((e) => e.type === 'view').length,
    comments: todayEvents.filter((e) => e.type === 'comment').length,
    likes: todayEvents.filter((e) => e.type === 'like').length,
    dynamics: todayEvents.filter((e) => e.type === 'dynamic').length,
    replies: todayEvents.filter((e) => e.type === 'reply-out').length,
    limits: {
      perDay: values.perDay,
      commentsPerDay: values.commentsPerDay,
      likesPerDay: values.likesPerDay,
      dynamicsPerDay: values.dynamicsPerDay,
      repliesPerRound: values.repliesPerRound,
    },
  }

  /* ── 值班：state.json 的上一轮 + 今日轮数（账本 round-end 现数） ── */
  const roundsToday = new Set(
    events
      .filter((e) => e.type === 'round-end' && dayKeyOfLocal(new Date(e.t)) === today)
      .map((e) => e.round || e.t),
  ).size
  const duty = {
    autoDuty: !!values.autoDuty,
    noon: !!values.noon,
    night: !!values.night,
    nextWindowLabel: nextWindowLabelOf(values, now),
    running: false,
    lastCode: state.lastCode ?? null,
    lastWhy: state.lastWhy || '',
    lastDurationMs: state.lastDurationMs ?? null,
    lastRunAt: state.lastRunAt || '',
    roundsToday,
  }

  /* ── 存在感：最近 7 天 inbound（reply-in / like-in）+ 最近一条真实评论 ── */
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)
  const startTs = startOfWeek.getTime()
  const endTs = now.getTime()
  const in7d = events.filter((e) => {
    const ts = new Date(e.t).getTime()
    return Number.isFinite(ts) && ts >= startTs && ts <= endTs
  })
  const inbound = in7d.filter((e) => /-in$/.test(String(e.type)))
  const trend = []
  for (let back = 6; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const key = dayKeyOfLocal(d)
    const dayIn = inbound.filter((e) => dayKeyOfLocal(new Date(e.t)) === key)
    trend.push({
      date: key,
      likes: dayIn.filter((e) => e.type === 'like-in').length,
      replies: dayIn.filter((e) => e.type === 'reply-in').length,
    })
  }
  const comments = events.filter((e) => e.type === 'comment')
  const latestCommentEvent = comments.length ? comments[comments.length - 1] : null
  const titleOfBvid = (bvid) => {
    if (!bvid) return ''
    const hit = events.find((e) => e.bvid === bvid && e.type === 'view' && e.title)
      || events.find((e) => e.bvid === bvid && e.title)
    return hit ? hit.title : ''
  }
  const presence = {
    likes7d: inbound.filter((e) => e.type === 'like-in').length,
    replies7d: inbound.filter((e) => e.type === 'reply-in').length,
    comments7d: in7d.filter((e) => e.type === 'comment').length,
    trend,
    latestComment: latestCommentEvent
      ? {
          text: latestCommentEvent.text || '',
          bvid: latestCommentEvent.bvid || '',
          title: titleOfBvid(latestCommentEvent.bvid),
          round: latestCommentEvent.round || '',
          time: latestCommentEvent.t || '',
        }
      : null,
  }

  /* ── 活动：lib/activity.js 聚合后整形（events.text 截 80 字） ── */
  const { activities, rounds } = toActivities(events)
  const eventOut = (e) => {
    const o = { t: e.t || '', type: e.type, text: cut(e.text, 80) }
    if (e.parent !== undefined) o.parent = e.parent
    if (e.rpid !== undefined) o.rpid = e.rpid
    if (e.user !== undefined) o.user = e.user
    if (e.from !== undefined) o.from = e.from
    if (e.reason !== undefined) o.reason = e.reason
    if (e.round !== undefined) o.round = e.round
    return o
  }
  const itemOut = (a) => ({
    bvid: a.bvid,
    title: a.title || '',
    author: a.author || '',
    views: a.views ?? null,
    duration: a.duration ?? null,
    source: a.source || '',
    grade: a.grade || '',
    stage: a.stage,
    skipped: a.skipped ? { reason: a.skipped.reason || '' } : null,
    flags: a.flags,
    events: (a.events || []).map(eventOut),
  })
  const days = groupByDay(rounds).map((day) => ({
    date: day.date,
    rounds: day.rounds.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      sourceLabel: r.sourceLabel,
      items: r.items.map(itemOut),
    })),
  }))
  const activitiesBlock = {
    days,
    totalEvents: activities.reduce((n, a) => n + (a.events || []).length, 0),
    bvidCount: activities.length,
  }

  /* ── 实时：idle 用真实 state；demo 用上一轮真实产物改写（不发 B 站） ── */
  const latestRound = rounds.length ? rounds[0] : null
  const demoEvents = []
  let seq = 0
  const pushDemo = (frame) => {
    seq += 1
    demoEvents.push({ seq, ...frame })
  }
  if (latestRound) {
    pushDemo({ t: latestRound.startedAt || '', kind: 'host', text: '轮次开始（演示回放：上一轮真实产物；不发 B 站）' })
    for (const item of latestRound.items) {
      const evs = (item.events || []).slice().sort((x, y) => String(x.t || '').localeCompare(String(y.t || '')))
      const firstT = evs[0]?.t || latestRound.startedAt || ''
      pushDemo({
        t: firstT,
        kind: 'reasoning',
        text: '研判：' + cut(item.title || item.bvid, 40) + (item.grade ? '（' + item.grade + '）' : ''),
      })
      for (const e of evs) {
        if (e.type === 'skip') {
          pushDemo({ t: e.t || firstT, kind: 'reasoning', text: '跳过：' + cut(e.reason, 80) })
          continue
        }
        if (e.type === 'note') {
          pushDemo({ t: e.t || firstT, kind: 'host', text: cut(e.text, 120) })
          continue
        }
        const tool = TOOL_OF_TYPE[e.type]
        if (!tool) continue
        const line = e.type === 'comment'
          ? '→ bili_reply  ' + cut(e.text, 60)
          : e.type === 'dynamic'
            ? '→ bili_send_dynamic  ' + cut(e.text, 60)
            : e.type === 'reply-in'
              ? '→ bili_received_replies  ' + cut(e.from || e.user || '', 20) + '：' + cut(e.text, 40)
              : e.type === 'view'
                ? '→ bili_video_info  ' + cut(item.title || e.bvid, 60)
                : '→ ' + tool
        pushDemo({ t: e.t || firstT, kind: 'tool', tool, text: line })
      }
    }
  }
  const demoRoundEnd = latestRound
    ? events.find((e) => e.type === 'round-end' && e.round === latestRound.id && typeof e.durationMs === 'number')
    : null
  const elapsedMs = demoRoundEnd
    ? demoRoundEnd.durationMs
    : (latestRound && latestRound.startedAt
        ? Math.max(0, endTs - new Date(latestRound.startedAt).getTime())
        : 0)
  const lastToolEvent = [...demoEvents].reverse().find((f) => f.kind === 'tool')
  const phase = lastToolEvent ? phaseOfTool(lastToolEvent.tool) : { key: 'think', label: '思考' }
  const toolCounts = {}
  for (const f of demoEvents) {
    if (f.kind === 'tool' && f.tool) toolCounts[f.tool] = (toolCounts[f.tool] || 0) + 1
  }
  const actions = { like: 0, comment: 0, dynamic: 0, reply: 0 }
  for (const f of demoEvents) {
    if (f.kind !== 'tool') continue
    const act = ACTION_OF_TOOL[f.tool]
    if (act) actions[act] += 1
  }
  const demoRoundEvents = latestRound ? latestRound.items.flatMap((a) => a.events || []) : []
  const demo = {
    note: '运行中状态为演示示例，事件由上一轮真实产物改写；不发 B 站',
    elapsedMs,
    phase,
    stats: {
      events: demoEvents.length,
      tools: toolCounts,
      actions,
      errors: demoEvents.filter((f) => f.kind === 'error').length,
    },
    quota: {
      picked: demoRoundEvents.filter((e) => e.type === 'view').length,
      comments: demoRoundEvents.filter((e) => e.type === 'comment').length,
      likes: demoRoundEvents.filter((e) => e.type === 'like').length,
      dynamics: demoRoundEvents.filter((e) => e.type === 'dynamic').length,
      limits: quota.limits,
    },
    events: demoEvents,
  }
  const live = {
    idle: {
      lastCode: duty.lastCode,
      lastWhy: duty.lastWhy,
      lastDurationMs: duty.lastDurationMs,
      lastRunAt: duty.lastRunAt,
    },
    demo,
  }

  /* ── 健康度：只做本地可判定的检查 ── */
  let homeWritable = false
  try { accessSync(HOME, constants.W_OK); homeWritable = true } catch { homeWritable = false }
  const health = {
    items: [
      {
        id: 'cred',
        label: 'B站登录凭证',
        status: loggedIn ? 'pass' : 'fail',
        detail: loggedIn ? '凭证文件存在（未联网校验）' : '凭证文件不存在（未联网校验；需重新扫码登录）',
      },
      {
        id: 'home',
        label: '家目录可写',
        status: homeWritable ? 'pass' : 'fail',
        detail: homeWritable ? '家目录 W_OK 探测通过（未实际写入）' : '家目录不可写（W_OK 探测失败）',
      },
      {
        id: 'model',
        label: '值班模型',
        status: values.modelProvider && values.modelName ? 'pass' : 'warn',
        detail: values.modelProvider && values.modelName
          ? '已配置 ' + values.modelProvider + ' / ' + values.modelName + (values.modelReasoningEffort ? ' · 强度 ' + values.modelReasoningEffort : ' · 强度留空（跟随会话默认）') + '（未联网校验）'
          : '未配置值班模型（留空 = 跟随会话默认模型）',
      },
      {
        id: 'cli',
        label: 'dsh CLI',
        status: values.dshBin ? 'pass' : 'warn',
        detail: values.dshBin ? '已配置 dshBin（未实跑校验）' : 'dshBin 留空（自动探测；未实跑校验）',
      },
      {
        id: 'ledger',
        label: '账本',
        status: events.length ? 'pass' : 'warn',
        detail: events.length + ' 条事件（readEvents 容错解析）',
      },
      {
        id: 'seen',
        label: '判重表',
        status: seenRows.length ? 'pass' : 'warn',
        detail: seenRows.length + ' 行（' + Buffer.byteLength(seenRaw, 'utf8') + ' 字节）',
      },
      {
        id: 'reports',
        label: '日报产物',
        status: reportDays.length ? 'pass' : 'warn',
        detail: reportDays.length + ' 天日报 · ' + digests.length + ' 份月度归档',
      },
      {
        id: 'overlay',
        label: 'headless overlay',
        status: overlayText ? 'pass' : 'warn',
        detail: overlayText ? overlayName + ' 存在（未联网校验）' : overlayName + ' 不存在（下一轮值班会重新生成）',
      },
    ],
  }

  /* ── 人设工作室：复用单页稿的组装函数（临时家目录隔离） ── */
  const persona = await buildPersonaDemoData({ pluginDir: PD, realHome: HOME })

  const pkg = readJson(join(PD, 'package.json'), {})

  return {
    meta: {
      generatedAt: localStamp(),
      appVersion: pkg.version || '',
      dataNote: '真实快照：config/state/ledger/seen/日报/人设卡；账号与实时事件为示例',
    },
    account,
    duty,
    quota,
    presence,
    activities: activitiesBlock,
    live,
    reports: {
      days: reportDays,
      contents: reportContents,
      digests,
      overlay: { name: overlayName, text: overlayText },
    },
    seen: {
      rows: seenRows,
      total: seenRows.length,
      rawBytes: Buffer.byteLength(seenRaw, 'utf8'),
    },
    persona,
    config: {
      values,
      defaults: cfg.defaults || {},
      sources: cfg.sources || {},
      model,
      windows: { noon: '12:00 – 14:00', night: '18:00 – 次日 09:00' },
    },
    health,
  }
}
