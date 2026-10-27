#!/usr/bin/env node
/**
 * 控制台截图夹具：把真实 client.js 的页面渲染成静态 HTML，套上宿主真实的 --dsw-* 主题 CSS，
 * 再交给 Chrome 截图（见 scripts/shoot-console.ps1）。
 *
 * 为什么需要它：DSH 桌面版的 Web GUI 需要 dsh web 打印的带 token 的 URL 才能打开，
 * headless Chrome 直接访问 127.0.0.1:50587 会被 "authentication required" 拦掉。
 * 于是这里用真 React SSR + 真主题 CSS 在本地复现页面外观，用于设计评审与回归对比。
 *
 * 用法：
 *   node scripts/snapshot-console.mjs --out docs/demo/shots --theme dark --only overview,activity
 *   node scripts/snapshot-console.mjs --out docs/demo/shots --theme both
 *
 * 依赖：
 *   - React/react-dom 在 %TEMP%\bf-react-smoke（与 test/client.render-smoke.mjs 同口径）
 *   - 宿主主题 CSS 直接从安装包 app.asar 读（DSH_ASAR 可覆盖路径）
 */
import { mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

import { FIX, RUNNING_LIVE } from '../test/fixtures/console-fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)
const ASAR = process.env.DSH_ASAR || 'D:/tools/deepseek harness/resources/app.asar'

/* ───────── app.asar 读取（只读头部索引，不需要解包） ───────── */
function readAsar(relPath) {
  const fd = openSync(ASAR, 'r')
  try {
    const hb = Buffer.alloc(16)
    readSync(fd, hb, 0, 16, 0)
    const jsonSize = hb.readUInt32LE(12)
    const base = 8 + hb.readUInt32LE(4)
    const jb = Buffer.alloc(jsonSize)
    readSync(fd, jb, 0, jsonSize, 16)
    const header = JSON.parse(jb.toString('utf8'))
    const hit = (() => {
      let node = header
      for (const seg of relPath.split('/')) {
        node = node?.files?.[seg]
        if (!node) return null
      }
      return node
    })()
    if (!hit || hit.files) throw new Error(`asar 里找不到文件：${relPath}`)
    const buf = Buffer.alloc(hit.size)
    readSync(fd, buf, 0, hit.size, base + Number(hit.offset))
    return buf
  } finally {
    closeSync(fd)
  }
}

/* ───────── 宿主主题 CSS：把 dsh-client-ui-theme 里的 *css_default 字面量取出来 ───────── */
function hostCss() {
  const src = readAsar('dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js').toString('utf8')
  const re = /\bvar\s+([A-Za-z0-9_]+_css_default)\s*=\s*("(?:[^"\\]|\\.)*")\s*;/g
  const parts = []
  let m
  while ((m = re.exec(src))) {
    try { parts.push(`/* ${m[1]} */\n${JSON.parse(m[2])}`) } catch { /* 跳过解析不了的块 */ }
  }
  if (!parts.length) throw new Error('没有从宿主主题包里取到 CSS')
  return parts.join('\n')
}

/* ───────── 加载插件 client.js（与 render-smoke 同口径） ───────── */
const reactRequire = createRequire(join(tmpdir(), 'bf-react-smoke', 'package.json'))
const React = reactRequire('react')
const { renderToString } = reactRequire('react-dom/server')

const injectedStyles = []
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      globalThis.__plugin = def.factory((spec) => {
        if (spec === 'react') return React
        throw new Error(`unexpected require ${spec}`)
      })
    },
  },
  open: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  CustomEvent: class {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  location: { href: 'http://localhost/' },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const tag = { dataset: {}, style: {} }
    injectedStyles.push(tag)
    return tag
  },
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false,
  body: { dataset: {} },
}
globalThis.fetch = async (path) => {
  const key = String(path).replace(/^\/api\/bili-fenshen/, '').split('?')[0]
  return { json: async () => FIX[key] ?? {}, ok: true }
}
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => {} } }, configurable: true })

const sandbox = { window: globalThis.window, document: globalThis.document, console, fetch: globalThis.fetch, setInterval, clearInterval, setTimeout, clearTimeout, navigator: globalThis.navigator }
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(pluginDir, 'client.js'), 'utf8'), sandbox)
const plugin = globalThis.__plugin
if (!plugin) throw new Error('client.js 没有注册（__ModuleLoader__.load 未被调用）')

const components = {}
plugin.apply({
  slots: {
    inject(name, reg) {
      const r = reg()
      if (r && r.component) components[name] = r.component
      return () => {}
    },
    register(_def, comp) {
      return { hasComponent: !!comp, component: comp }
    },
  },
  get: () => null,
  effect: (fn) => { try { fn() } catch { /* 忽略 */ } },
})
const ConsolePage = components.main
const SettingsEntry = components['settings.section']
if (!ConsolePage) throw new Error('没有拿到 main 面板组件')
const PLUGIN_CSS = injectedStyles.map((t) => t.textContent || '').join('\n')
if (!PLUGIN_CSS) throw new Error('没有捕获到插件样式表')

/* ───────── 各页面的 props（数据来自共享 fixture，口径与冒烟测试一致） ───────── */
const DATA = {
  ov: FIX['/api/bili-fenshen/overview'],
  act: FIX['/api/bili-fenshen/activity'],
  acct: FIX['/api/bili-fenshen/account'],
  persona: FIX['/api/bili-fenshen/persona'],
  config: FIX['/api/bili-fenshen/config'],
}

const PERSONA_PAGE = {
  ...DATA,
  personaPage: {
    persona: FIX['/api/bili-fenshen/persona'],
    preview: FIX['/api/bili-fenshen/persona/preview'],
  },
}

const PAGES = {
  overview: { label: '概览', props: { initialTab: 'overview', initialData: DATA } },
  'overview-running': {
    label: '概览（运行中）',
    props: { initialTab: 'overview', live: RUNNING_LIVE, initialData: DATA },
  },
  activity: { label: '活动 · 生命周期', props: { initialTab: 'activity', initialView: 'life', initialData: DATA } },
  'activity-timeline': { label: '活动 · 时间线', props: { initialTab: 'activity', initialView: 'timeline', initialData: DATA } },
  'activity-seen': {
    label: '活动 · 判重表',
    props: { initialTab: 'activity', initialView: 'seen', initialData: { ...DATA, seen: FIX['/api/bili-fenshen/seen'] } },
  },
  reports: {
    label: '日报',
    props: {
      initialTab: 'reports',
      initialData: {
        ...DATA,
        reports: {
          list: FIX['/api/bili-fenshen/reports'],
          day: '2026-10-23',
          text: FIX['/api/bili-fenshen/report'].text,
        },
      },
    },
  },
  persona: { label: '人设 · 人设卡', props: { initialTab: 'persona', initialData: PERSONA_PAGE } },
  'persona-materials': {
    label: '人设 · 素材库',
    props: {
      initialTab: 'persona',
      initialPersonaTab: 'bank',
      initialData: {
        ...PERSONA_PAGE,
        personaPage: {
          ...PERSONA_PAGE.personaPage,
          expression: FIX['/api/bili-fenshen/persona/expression'],
          lore: FIX['/api/bili-fenshen/persona/lore'],
          versions: FIX['/api/bili-fenshen/persona/versions'],
        },
      },
    },
  },
  settings: { label: '设置 · 节奏与配额', props: { initialTab: 'settings', initialData: DATA } },
  'settings-entry': { label: '设置页入口（settings.section）', entry: true },
}

/* ───────── 宿主外框：rail 56 + 侧栏 264 + 中列（页面自己滚） ───────── */
const FRAME_CSS = `
  html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
    font-family:var(--dsh-font-family-text-default,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);
    font-size:14px;line-height:22px}
  #frame{display:flex;height:100vh;min-height:0}
  .rail{flex:none;width:56px;border-right:.5px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;
    align-items:center;gap:10px;padding:14px 0;background:var(--dsw-alias-bg-base)}
  .rail .dot{width:28px;height:28px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
  .rail .dot.on{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,var(--dsw-alias-bg-layer-2))}
  .side{flex:none;width:264px;border-right:.5px solid var(--dsw-alias-border-l1);padding:16px 12px;
    display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-base)}
  .side .h{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);padding:4px 8px 6px;letter-spacing:.04em}
  .side .row{font-size:13px;line-height:20px;padding:6px 8px;border-radius:8px;color:var(--dsw-alias-label-secondary)}
  .side .row.on{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-weight:500}
  .main{flex:1;min-width:0;height:100vh;display:flex}
  .main>*{flex:1;min-width:0}
`
function frame(pageHtml, { entry = false } = {}) {
  return `
    <div class="rail">
      <div class="dot"></div><div class="dot on"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>
    <div class="side">
      <div class="h">会话</div>
      <div class="row">今晚把值班跑起来</div>
      <div class="row">人设卡怎么调</div>
      <div class="h" style="margin-top:12px">插件</div>
      <div class="row on">B站分身</div>
      <div class="row">插件管理</div>
    </div>
    <div class="main">${entry ? `<div style="padding:24px;overflow-y:auto">${pageHtml}</div>` : pageHtml}</div>`
}

function doc({ css, body, theme }) {
  return `<!doctype html>
<html lang="zh-CN" data-platform="win32">
<head>
<meta charset="utf-8">
<title>bili-fenshen console snapshot</title>
<meta name="color-scheme" content="light dark">
<style>${css}</style>
<style>${FRAME_CSS}</style>
</head>
<body${theme === 'dark' ? ' data-ds-dark-theme' : ''}>
<div id="frame">${body}</div>
</body>
</html>`
}

/* ───────── CLI ───────── */
const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const outDir = resolve(pluginDir, argOf('out', 'docs/demo/shots'))
const themes = argOf('theme', 'dark') === 'both' ? ['dark', 'light'] : [argOf('theme', 'dark')]
const only = argOf('only', '').split(',').filter(Boolean)
mkdirSync(outDir, { recursive: true })

const host = hostCss()
const written = []
for (const theme of themes) {
  for (const [key, page] of Object.entries(PAGES)) {
    if (only.length && !only.includes(key)) continue
    let html
    if (page.entry) {
      if (!SettingsEntry) throw new Error('没有拿到 settings.section 组件')
      html = renderToString(React.createElement(SettingsEntry))
    } else {
      html = renderToString(React.createElement(ConsolePage, page.props))
    }
    const file = join(outDir, `${key}.${theme}.html`)
    writeFileSync(file, doc({ css: host + '\n' + PLUGIN_CSS, body: frame(html, { entry: !!page.entry }), theme }))
    written.push(file)
  }
}
console.log(`写好了 ${written.length} 个 HTML：`)
for (const f of written) console.log('  ' + f)
