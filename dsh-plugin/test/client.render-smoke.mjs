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

const dashHtml = check('ConsolePage 静态壳（看板）', () => renderToString(React.createElement(mainComp)))
const expectAll = (label, html, markers) => {
  for (const marker of markers) {
    if (!html.includes(marker)) { console.log(`✗ FAIL ${label}缺少「${marker}」`); bad++ }
  }
}
expectAll('看板', dashHtml, ['B站分身', '看板', '操作台', '自动值班', '今日配额', '还没有活动记录'])

// 操作台（初始 pane=config；Tabs 里必须有新「实时」tab）
const consoleHtml = check('ConsolePage 静态壳（操作台）', () => renderToString(React.createElement(mainComp, { initialView: 'console' })))
expectAll('操作台', consoleHtml, ['配置', '实时', '日志', '判重表', '产物'])

// 看板运行中：LiveCard（fixtures running:true 通过 props.live 注入初始状态）
const runningDashHtml = check('ConsolePage 静态壳（看板 · 运行中 LiveCard）', () => renderToString(React.createElement(mainComp, { live: RUNNING_LIVE })))
expectAll('运行中看板', runningDashHtml, ['运行中', '看内容', '打开实时', 'bili_subtitle'])

// 操作台「实时」tab：状态/秒表/统计/自动滚动/降级轮询/事件流
const liveHtml = check('ConsolePage 静态壳（操作台 · 实时 tab）', () => renderToString(React.createElement(mainComp, { initialView: 'console', initialPane: 'live', live: RUNNING_LIVE })))
expectAll('实时 tab', liveHtml, ['实时', '运行中', '看内容', '自动滚动', '降级轮询', '跑一轮', '中止', 'bili_search'])

const settingsHtml = check('SettingsEntry 静态壳', () => renderToString(React.createElement(settingsComp)))
expectAll('设置页', settingsHtml, ['安装自检', '一键诊断', '打开控制台'])

console.log(bad === 0 ? 'RENDER SMOKE ALL GREEN' : `${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
