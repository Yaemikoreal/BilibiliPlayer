// 渲染冒烟测试：真 React 18 + react-dom/server 渲染 ConsolePage / SettingsEntry 的静态壳。
// 拦截 fetch 返回 fixture 数据；document/window 桩掉。捕获 h() 调用层的运行时错误。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)
// react 装在临时目录（bf-react-smoke）
const reactRequire = createRequire(join(tmpdir(), 'bf-react-smoke', 'package.json'))
const React = reactRequire('react')
const { renderToString } = reactRequire('react-dom/server')

// ── 环境桩 ──
const FIX = {
  '/api/bili-fenshen/overview': {
    ok: true, account: null,
    duty: { autoDuty: true, windows: { noon: true, night: true }, nextWindowLabel: '中午 12:00（2h54m 后）' },
    quota: { picked: 3, comments: 2, likes: 6, dynamics: 0, limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 } },
    round: { running: false, lastCode: 0, lastWhy: 'web' },
    health: { cli: 'D:/x/bin.js', cred: true, routeOk: true },
    home: 'C:/h', ledgerFile: 'C:/h/ledger.jsonl',
  },
  '/api/bili-fenshen/activity': {
    ok: true,
    days: [{
      date: '2026-10-23',
      rounds: [{
        id: 'r1', startedAt: '2026-10-23T08:26:00Z', sourceLabel: '热门',
        items: [
          {
            bvid: 'BV1xrnz6gEVD', title: '折1万次，会坏吗？iPhone Duo深度评测', author: '影视飓风',
            views: 3136000, duration: 1492, source: 'hot', grade: 'worth',
            events: [
              { t: '2026-10-23T08:26:11Z', round: 'r1', type: 'view' },
              { t: '2026-10-23T08:26:30Z', round: 'r1', type: 'like' },
              { t: '2026-10-23T08:27:00Z', round: 'r1', type: 'comment', text: '我的评论', rpid: 123456 },
              { t: '2026-10-23T09:00:00Z', round: 'r1', type: 'reply-in', parent: 123456, rpid: 999001, from: '张三', text: '回复我' },
              { t: '2026-10-23T09:10:00Z', round: 'r1', type: 'reply-out', parent: 999001, rpid: 999100, text: '我回答' },
            ],
            stage: { viewed: true, liked: true, commented: true, replies: 1, repliedBack: true, dynamic: false, pendingReply: 0 },
            flags: { fromReport: false },
          },
          {
            bvid: 'BV2skip', title: '跳过的视频',
            events: [{ t: '2026-10-23T08:29:00Z', round: 'r1', type: 'skip', bvid: 'BV2skip', title: '跳过的视频', reason: '无字幕' }],
            stage: { viewed: true, liked: false, commented: false, replies: 0, repliedBack: false, dynamic: false, pendingReply: 0 },
            skipped: { reason: '无字幕' }, flags: {},
          },
        ],
      }],
    }],
  },
  '/api/bili-fenshen/account': { ok: true, account: { loggedIn: true, uname: '蓝鱼小号', mid: '10000001', face: '', level: 6, coins: 1447.5, fans: 12, vip: false } },
  '/api/bili-fenshen/config': {
    ok: true,
    values: { autoDuty: true, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, keywords: ['AI 实测'], followUids: [10000001], personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [], modelProvider: '', modelName: '', modelReasoningEffort: '' },
    sources: { perDay: 'patch' },
    defaults: { autoDuty: false, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, keywords: [], followUids: [], personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [], modelProvider: '', modelName: '', modelReasoningEffort: '' },
  },
  // 模型配置：provider/model/推理强度目录 + 当前生效
  '/api/bili-fenshen/models': {
    ok: true,
    selection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    effective: { mode: 'config', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    config: { modelProvider: 'deepseek-account', modelName: 'deepseek-flash', modelReasoningEffort: 'high' },
    providers: [{ id: 'deepseek-account', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
    models: {
      'deepseek-account': [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-pro', name: 'deepseek-pro' }],
      openai: [{ id: 'gpt-x', name: 'gpt-x' }],
    },
    reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }],
    warnings: [],
  },
  // 实时运行：GET /live（空闲形态；SSE 不可用时降级轮询也走这里）
  '/api/bili-fenshen/live': {
    ok: true, running: false, roundId: '2026-10-25T01:00:00.000Z',
    startedAt: '2026-10-25T01:00:00.000Z', elapsedMs: 61234, why: 'web',
    lastCode: 0, lastDurationMs: 61234, phase: { key: 'watch', label: '看内容' },
    cursor: 0, events: [],
    stats: { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 },
    quota: { picked: 1, comments: 0, likes: 0, dynamics: 0, limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 } },
  },
  // 人设：生效卡健康度 + 内置预设 + 语料库统计（GET /persona）
  '/api/bili-fenshen/persona': {
    ok: true,
    active: { mode: 'preset', presetId: 'whale' },
    health: {
      mode: 'card', ok: true, detail: 'whale@2.0.0（preset，1733 字符）',
      path: 'D:/x/prompts/persona/whale.card.json', source: 'preset',
    },
    presets: [
      { id: 'whale', name: '蓝色大肥鱼', version: '2.0.0', oneLiner: 'DeepSeek 的民间拟人形象', license: 'CC BY-NC-SA 4.0', file: 'D:/x/whale.card.json' },
      { id: 'elaina', name: '灰之魔女', version: '2.0.0', oneLiner: '会飞的灰之魔女', license: 'CC BY-NC-SA 4.0', file: 'D:/x/elaina.card.json' },
      { id: 'generic', name: '普通网友', version: '2.0.0', oneLiner: '没有 IP 的普通网友', license: 'CC BY-NC-SA 4.0', file: 'D:/x/generic.card.json' },
    ],
    card: {
      spec: 'bili-fenshen.persona/v2', id: 'whale', version: '2.0.0', name: '蓝色大肥鱼', license: 'CC BY-NC-SA 4.0',
      identity: { oneLiner: 'DeepSeek 的民间拟人形象', background: '蓝白、圆滚滚、端着一碗白饭。' },
      voice: { register: ['逗句', '口语'], moves: ['纯情绪', '反问', '玩梗'] },
      mindset: { contradictions: ['摸鱼 vs 怕被认出来'] },
      taste: { watch: ['游戏实测'], avoid: ['引战'] },
      stance: [{ topic: 'AI 拉踩', attitude: '不站队', how: '只聊作品' }],
      redlines: [], canon: [], loreIndex: [], samples: { good: [] },
    },
    cardSource: { source: 'preset', path: 'D:/x/prompts/persona/whale.card.json', error: null },
    versions: [{ name: 'whale-2.0.0-2026-10-26.json', mtime: 1761400000000 }],
    bank: {
      total: 23, updatedAt: '2026-10-26T00:00:00Z',
      byBucket: {
        reaction: { total: 2, active: 2 }, question: { total: 5, active: 5 }, experience: { total: 3, active: 3 },
        meme: { total: 5, active: 5 }, detail: { total: 2, active: 2 }, rant: { total: 6, active: 6 },
      },
    },
    budget: { blocks: { core: 1500, lore: 300, state: 500, samples: 450, tail: 250 }, totalMax: 3000 },
  },
  // 人设编译预览（GET /persona/preview）：五块预算 / L0 六条 / 今日状态
  '/api/bili-fenshen/persona/preview': {
    ok: true,
    tag: 'whale@2.0.0',
    text: '===== 你是谁（按这个来）=====\nDeepSeek 的民间拟人形象\n===== 写之前，最后看三行 =====\n1) 别收在判断上。',
    stats: {
      total: 1733, totalMax: 3000, overTotal: false, over: [],
      per: [
        { name: 'core', len: 1052, max: 1500 }, { name: 'lore', len: 227, max: 300 },
        { name: 'state', len: 208, max: 500 }, { name: 'samples', len: 129, max: 450 },
        { name: 'tail', len: 117, max: 250 },
      ],
    },
    notes: ['P4 用表达库（question，4 条）'],
    errors: [], warnings: [],
    l0: {
      ok: true,
      checks: [
        { id: 'redline-triple', name: '红线三件套（不许+为什么+那要写成什么）', level: 'pass', pass: true, detail: '9 条全部有 instead' },
        { id: 'negative-ratio', name: '禁止句占比（≤25%）', level: 'pass', pass: true, detail: '7/141 = 5%' },
        { id: 'moves-table', name: '手段表（≥6 类可做的事）', level: 'pass', pass: true, detail: '6 类' },
        { id: 'word-freq', name: '词频（签名词 ≤3 次）', level: 'pass', pass: true, detail: '无超限词' },
        { id: 'contradiction', name: '矛盾写成 X vs Y', level: 'pass', pass: true, detail: '4 条，0 条是标签' },
        { id: 'sample-dup', name: '示例不重复且带来源', level: 'pass', pass: true, detail: '9 条互不重复' },
      ],
    },
    state: {
      date: '2026-10-26',
      mood: { label: '佛系', energy: 4, patience: 6 },
      timeOfDay: { key: 'late', label: '凌晨', maxChars: 40, note: '话更短，别写长经历' },
      skipStreak: 0, loreUsed: {}, canonUsed: {}, expressionUsed: {},
      recent: {
        comments: [
          { text: '原来不是打码，是他自己秒切的屏', form: 'detail' },
          { text: '拿个爆能机还要说「这个归我了」，欠得很', form: 'detail' },
        ],
        forms5: ['detail', 'detail', 'question'],
        debt: { question: true, reaction: false, emoji: false, experience: false, judgeHeavy: true },
      },
    },
  },
  // 一键诊断：9 pass / 1 warn / 0 fail
  '/api/bili-fenshen/diagnose': {
    ok: true, generatedAt: '2026-10-25T01:02:03.000Z', durationMs: 1234,
    summary: { pass: 9, warn: 1, fail: 0 },
    items: [
      { id: 'python', label: 'Python 解释器', status: 'pass', detail: 'Python 3.11.15', fix: '', durationMs: 42 },
      { id: 'deps', label: 'Python 依赖', status: 'pass', detail: 'mcp / bilibili_api / aiohttp 均已安装', fix: '', durationMs: 30 },
      { id: 'mcp-server', label: 'MCP Server 文件', status: 'pass', detail: 'mcp_server.py 可编译', fix: '', durationMs: 18 },
      { id: 'mcp-connection', label: 'MCP 连接', status: 'pass', detail: '已注册 28 个 bili 工具', fix: '', durationMs: 2 },
      { id: 'credential', label: 'B 站登录凭证', status: 'warn', detail: '未登录', fix: '到控制台重新扫码登录', durationMs: 10 },
      { id: 'dsh-cli', label: 'dsh CLI', status: 'pass', detail: '/usr/local/bin/dsh', fix: '', durationMs: 1 },
      { id: 'headless-profile', label: 'headless profile', status: 'pass', detail: '/home/x/.dsh/profiles/headless', fix: '', durationMs: 1 },
      { id: 'home', label: '家目录可写', status: 'pass', detail: '/home/x/.dsh/bili-fenshen', fix: '', durationMs: 3 },
      { id: 'model', label: '模型可用', status: 'pass', detail: 'deepseek-account / deepseek-flash（跟随默认）', fix: '', durationMs: 5 },
      { id: 'route', label: '控制台路由', status: 'pass', detail: '已挂载 /api/bili-fenshen', fix: '', durationMs: 1 },
    ],
  },
}

// 运行中的实时状态（注入 ConsolePage 的 props.live，SSR 不会执行 effect，故用 fixtures 顶替 useLive 的初始值）
const RUNNING_LIVE = {
  data: {
    running: true,
    roundId: '2026-10-25T01:00:00.000Z',
    startedAt: '2026-10-25T01:00:00.000Z',
    elapsedMs: 83000,
    why: 'web',
    phase: { key: 'watch', label: '看内容' },
    stats: { events: 3, tools: { bili_search: 1, bili_subtitle: 2 }, actions: { like: 1, comment: 1, dynamic: 0, reply: 0 }, errors: 0 },
    quota: { picked: 1, comments: 0, likes: 0, dynamics: 0, limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 } },
    events: [
      { seq: 101, t: '2026-10-25T01:00:12.000Z', kind: 'tool', tool: 'bili_search', text: '→ bili_search' },
      { seq: 102, t: '2026-10-25T01:00:20.000Z', kind: 'tool', tool: 'bili_subtitle', text: '→ bili_subtitle BV1xrnz6gEVD' },
      { seq: 103, t: '2026-10-25T01:00:30.000Z', kind: 'host', text: '正在读字幕' },
    ],
    lastCode: null,
    lastDurationMs: null,
  },
  mode: 'poll',
  error: '',
}

globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__plugin = def.factory((spec) => { if (spec === 'react') return React; throw new Error('unexpected require ' + spec) }) } },
  open: () => {},
  addEventListener: () => {},
  dispatchEvent: () => {},
  CustomEvent: class {},
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false,
}
globalThis.fetch = async (path) => {
  const key = String(path).replace(/^\/api\/bili-fenshen/, '').split('?')[0]
  const data = FIX[key]
  return { json: async () => data ?? {} }
}
// navigator 在 Node 22 是只读 getter —— 用 defineProperty 覆盖（client.js 只在 LogPane 里用到）
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => {} } }, configurable: true })

// ── 加载 client.js ──
const code = (await import('node:fs')).readFileSync(join(pluginDir, 'client.js'), 'utf8')
const sandbox = { window: globalThis.window, console, setInterval, clearInterval, setTimeout, clearTimeout }
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
const plugin = globalThis.__plugin
if (!plugin) { console.error('FAIL: client.js 未注册'); process.exit(1) }

// ── 捕获注册的组件 ──
const components = {}
const fakeSlots = {
  inject(name, reg) {
    const r = reg()
    const consume = (x) => { if (x && x.hasComponent) components[x.key || x.id || name] = x.component }
    if (r && typeof r.next === 'function') { for (const item of r) consume(item) } else consume(r)
  },
  register(def, comp) { return { ...def, hasComponent: !!comp, component: comp } },
}
plugin.apply({ slots: fakeSlots, get: () => null })

let bad = 0
const check = (name, fn) => {
  try {
    const html = fn()
    if (typeof html !== 'string' || html.length < 10) throw new Error('empty render')
    console.log(`✓ ${name}（${html.length} chars）`)
    return html
  } catch (e) {
    console.log(`✗ FAIL ${name} —— ${e?.stack?.split('\n').slice(0, 3).join(' | ')}`)
    bad++
    return ''
  }
}

// ConsolePage 组件 key 是 main 面板的 'bili-fenshen'；settings 是 'bili-fenshen'（同名，后者覆盖）——分开收集
const collected = []
const fakeSlots2 = {
  inject(name, reg) {
    const r = reg()
    const consume = (x) => collected.push({ name, ...x })
    if (r && typeof r.next === 'function') { for (const item of r) consume(item) } else consume(r)
  },
  register(def, comp) { return { ...def, component: comp } },
}
plugin.apply({ slots: fakeSlots2, get: () => null })

const mainComp = collected.find((x) => x.name === 'main')?.component
const settingsComp = collected.find((x) => x.name === 'settings.section')?.component

const expectAll = (label, html, markers) => {
  for (const marker of markers) {
    if (!html.includes(marker)) { console.log(`✗ FAIL ${label}缺少「${marker}」`); bad++ }
  }
}

// v3 壳：默认「概览」页（SSR 不执行 effect，所以只断言静态结构；数据态由真实浏览器验收）
const homeHtml = check('ConsolePage（v3 壳 · 概览）', () => renderToString(React.createElement(mainComp)))
expectAll('v3 概览', homeHtml, [
  'B站分身',
  '概览', '实时', '活动 · 生命周期', '日报', '判重表', '人设工作室', '设置',
  '值班状态', '当前账号', '存在感（近 7 天）', '最近活动', '当前人设', '本地检查',
])

// 「实时」页：状态/秒表/统计/自动滚动/降级轮询/事件流（props.live 注入运行中快照）
const liveHtml = check('ConsolePage（v3 · 实时页 · 运行中）', () => renderToString(React.createElement(mainComp, { initialTab: 'live', live: RUNNING_LIVE })))
expectAll('v3 实时页', liveHtml, ['实时', '运行中', '看内容', '自动滚动', '降级轮询', '中止', '事件流', '当前阶段', '工具调用', 'bili_search'])

// 实时页 · 空闲态：上一轮摘要 + 跑一轮入口
const liveIdle = { data: { ...RUNNING_LIVE.data, running: false, events: [], lastCode: 0, lastDurationMs: 61234, lastRunAt: '2026-10-25T01:00:00.000Z' }, mode: 'poll', error: '' }
const liveIdleHtml = check('ConsolePage（v3 · 实时页 · 空闲）', () => renderToString(React.createElement(mainComp, { initialTab: 'live', live: liveIdle })))
expectAll('v3 实时页空闲', liveIdleHtml, ['当前空闲', '上一轮退出码', '上一轮耗时', '跑一轮'])

// 「活动」页：按视频/时间线双视图 + 类型筛选 + 搜索（fixtures 通过 initialData.act 注入）
const actHtml = check('ConsolePage（v3 · 活动页）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'activity',
  initialData: { act: FIX['/api/bili-fenshen/activity'] },
})))
expectAll('v3 活动页', actHtml, ['按视频', '时间线', '全部 2', '折1万次', '跳过 1 条', '筛选后'])

// 「人设工作室」页：生效卡/五块预算/L0 六条/今日状态/编译预览（fixtures 通过 props.persona 注入）
const personaHtml = check('ConsolePage（v3 · 人设工作室）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona',
  persona: {
    persona: FIX['/api/bili-fenshen/persona'],
    preview: FIX['/api/bili-fenshen/persona/preview'],
  },
})))
expectAll('v3 人设页', personaHtml, [
  '人设工作室', '卡（生效）', '蓝色大肥鱼（生效）', '人设卡', '高级编辑（JSON）',
  '五块预算', 'P1 常驻核心', '1052/1500',
  '卡片', '编译预览', '质量 / L0', '语料库', '见闻库', '今日状态', '版本对比', '试写沙盒',
  'L0 6/6', '1733/3000',
])
const personaTabsHtml = check('ConsolePage（v3 · 人设工作室 · 质量页签）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona',
  initialPersonaTab: 'quality',
  initialData: { personaPage: { persona: FIX['/api/bili-fenshen/persona'], preview: FIX['/api/bili-fenshen/persona/preview'] } },
})))
expectAll('v3 人设页 · 质量', personaTabsHtml, ['L0 六条', '红线三件套', '试写沙盒'])

const personaExtra = {
  persona: FIX['/api/bili-fenshen/persona'],
  preview: FIX['/api/bili-fenshen/persona/preview'],
  expression: { ok: true, total: 23, buckets: { question: [{ text: '封面能不能好好做？', source: 'comment-reception', len: 9, status: 'active', heat: 1 }] } },
  lore: { ok: true, entries: [{ id: 'wuchang-ranked', keys: ['无畏契约'], oneLine: '常年白银边缘', usedToday: false, chars: 12, body: '正文内容' }] },
  versions: { ok: true, versions: [{ name: 'whale-2.0.0-2026-10-26.json', mtime: 1761400000000 }] },
}
const personaBankHtml = check('ConsolePage（v3 · 人设工作室 · 语料库）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona', initialPersonaTab: 'bank', initialData: { personaPage: personaExtra },
})))
expectAll('v3 人设页 · 语料库', personaBankHtml, ['语料库', '桶：question', '封面能不能好好做？'])
const personaVersionHtml = check('ConsolePage（v3 · 人设工作室 · 版本）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona', initialPersonaTab: 'version', initialData: { personaPage: personaExtra },
})))
expectAll('v3 人设页 · 版本', personaVersionHtml, ['版本快照', 'whale-2.0.0-2026-10-26.json', '回滚'])
const personaLoreHtml = check('ConsolePage（v3 · 人设工作室 · 见闻库）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona', initialPersonaTab: 'lore', initialData: { personaPage: personaExtra },
})))
expectAll('v3 人设页 · 见闻库', personaLoreHtml, ['见闻库', '索引（常驻 prompt）', 'wuchang-ranked', '正文内容'])

// 人设页 · legacy：配置里的 personaPrompt 优先，卡明确标「未生效」
const legacyFixture = {
  ...FIX['/api/bili-fenshen/persona'],
  health: { mode: 'legacy', ok: true, detail: '旧格式人设（legacy 直通）', source: 'legacy' },
}
const personaLegacyHtml = check('ConsolePage（v3 · 人设工作室 · legacy）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'persona',
  persona: { persona: legacyFixture, preview: FIX['/api/bili-fenshen/persona/preview'] },
})))
expectAll('v3 人设页 · legacy', personaLegacyHtml, [
  'legacy 直通', '人设卡（当前未生效）', '本轮走 legacy 直通', '不会覆盖配置',
])

// 「判重表」页：真实行（有 BV / 动作 chips）+ 搜索框
const seenHtml = check('ConsolePage（v3 · 判重表）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'seen',
  initialData: { seen: { rows: [
    { date: '2026-10-23', time: '', bvid: 'BV1xrnz6gEVD', action: '看过+赞过+评论过', title: '测试视频标题' },
    { date: '2026-10-23', time: '', bvid: '', action: '第二轮值班开始（已登录）', title: '-' },
  ] } },
})))
expectAll('v3 判重表', seenHtml, ['判重表', '看过什么', 'BV1xrnz6gEVD', '测试视频标题', '看过', '评论', '已折叠 1 条值班备注'])

// 「日报」页：列表 + Markdown 渲染（标题/粗体/正文）
const reportsHtml = check('ConsolePage（v3 · 日报）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'reports',
  initialData: { reports: {
    list: { days: ['2026-10-23'], digests: [], overlay: false },
    day: '2026-10-23',
    text: '# 测试日报\n\n## 第一轮\n\n**粗体**与普通文字\n\n- 列表项一\n- 列表项二',
  } },
})))
expectAll('v3 日报', reportsHtml, ['日报', '2026-10-23.md', '测试日报', '第一轮', '粗体', '列表项一'])

// 「设置」页：配置 / 宿主日志 两个子页（SSR 下配置内容为加载态）
const settingsTabHtml = check('ConsolePage（v3 · 设置页）', () => renderToString(React.createElement(mainComp, {
  initialTab: 'settings',
  initialData: { config: FIX['/api/bili-fenshen/config'] },
})))
expectAll('v3 设置页', settingsTabHtml, [
  '配置', '宿主日志', '值班节奏', '配额', '内容源', '禁令', '人设', '运行环境',
  '保存并生效', '与持久化配置一致',
])

const settingsHtml = check('SettingsEntry 静态壳', () => renderToString(React.createElement(settingsComp)))
expectAll('设置页', settingsHtml, ['安装自检', '一键诊断', '打开控制台'])

console.log(bad === 0 ? 'RENDER SMOKE ALL GREEN' : `${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
