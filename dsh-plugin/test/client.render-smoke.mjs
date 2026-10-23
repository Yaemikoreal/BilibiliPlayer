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
  '/api/bili-fenshen/account': { ok: true, account: { loggedIn: true, uname: '不吃鱼的豆腐', mid: '312299788', face: '', level: 6, coins: 1447.5, fans: 12, vip: false } },
  '/api/bili-fenshen/config': {
    ok: true,
    values: { autoDuty: true, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, keywords: ['AI 实测'], followUids: [312299788], personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [] },
    sources: { perDay: 'patch' },
    defaults: { autoDuty: false, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, keywords: [], followUids: [], personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [] },
  },
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
for (const marker of ['B站分身', '看板', '操作台', '自动值班', '今日配额', '还没有活动记录']) {
  if (!dashHtml.includes(marker)) { console.log(`✗ FAIL 看板缺少「${marker}」`); bad++ }
}
const settingsHtml = check('SettingsEntry 静态壳', () => renderToString(React.createElement(settingsComp)))
if (!settingsHtml.includes('打开控制台')) { console.log('✗ FAIL 设置页缺少「打开控制台」'); bad++ }

console.log(bad === 0 ? 'RENDER SMOKE ALL GREEN' : `${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
