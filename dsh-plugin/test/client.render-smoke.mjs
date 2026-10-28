// 渲染冒烟测试：真 React 18 + react-dom/server 渲染 ConsolePage / SettingsEntry 的静态壳。
// 拦截 fetch 返回 fixture 数据；document/window 桩掉。捕获 h() 调用层的运行时错误。
//
// v4：断言按 5 页签（概览/活动/日报/人设/设置）重写；每个页面至少断言
//     ①唯一 h1 页标题 ②页头 intro ③主操作按钮 ④首屏关键块。
// 另加两条：概览「今日产出」块、活动页「接话」标签/筛选。
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { FIX, RUNNING_LIVE, RUNNING_OVERVIEW, MISSING_PROACTIVE_OVERVIEW } from './fixtures/console-fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)
// react 装在临时目录（bf-react-smoke）
const reactRequire = createRequire(join(tmpdir(), 'bf-react-smoke', 'package.json'))
const React = reactRequire('react')
const { renderToString } = reactRequire('react-dom/server')

globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__plugin = def.factory((spec) => { if (spec === 'react') return React; throw new Error('unexpected require ' + spec) }) } },
  open: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
  CustomEvent: class {},
}
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {} }),
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false,
  body: { style: {} },
  activeElement: null,
}
globalThis.fetch = async (path) => {
  const key = String(path).replace(/^\/api\/bili-fenshen/, '').split('?')[0]
  const data = FIX[key]
  return { json: async () => data ?? {}, ok: true }
}
// navigator 在 Node 22 是只读 getter —— 用 defineProperty 覆盖（client.js 只在 LogPane 里用到）
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => {} } }, configurable: true })

// ── 加载 client.js ──
const code = (await import('node:fs')).readFileSync(join(pluginDir, 'client.js'), 'utf8')
const sandbox = { window: globalThis.window, console, setInterval, clearInterval, setTimeout, clearTimeout, fetch: globalThis.fetch, navigator: globalThis.navigator }
vm.createContext(sandbox)
vm.runInContext(code, sandbox)
const plugin = globalThis.__plugin
if (!plugin) { console.error('FAIL: client.js 未注册'); process.exit(1) }

// ── 捕获注册的组件（同名 key 会覆盖，所以按槽位名分开收集） ──
const collected = []
const fakeSlots = {
  inject(name, reg) {
    const r = reg()
    const consume = (x) => collected.push({ name, ...x })
    if (r && typeof r.next === 'function') { for (const item of r) consume(item) } else consume(r)
  },
  register(def, comp) { return { ...def, component: comp } },
}
plugin.apply({ slots: fakeSlots, get: () => null })

const mainComp = collected.find((x) => x.name === 'main')?.component
const settingsComp = collected.find((x) => x.name === 'settings.section')?.component

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
const expectAll = (label, html, markers) => {
  for (const marker of markers) {
    if (!html.includes(marker)) { console.log(`✗ FAIL ${label}缺少「${marker}」`); bad++ }
  }
}
const count = (html, re) => (html.match(re) || []).length
/** 每页结构断言：唯一 h1 页标题 + intro + 页头主操作 + 指定首屏块 */
const expectPage = (label, html, markers) => {
  const pages = count(html, /class="bf-page-title"/g)
  if (pages !== 1) { console.log(`✗ FAIL ${label}页标题数量应为 1，实际 ${pages}`); bad++ }
  const h1n = count(html, /<h1/g)
  if (h1n !== 1) { console.log(`✗ FAIL ${label}<h1> 数量应为 1，实际 ${h1n}`); bad++ }
  if (!html.includes('class="bf-page-intro"')) { console.log(`✗ FAIL ${label}缺少页头 intro`); bad++ }
  if (!html.includes('class="bf-page-toolbar"') && !html.includes('bf-page-head')) {
    console.log(`✗ FAIL ${label}缺少页头工具条`); bad++
  }
  expectAll(label, html, markers)
}

const render = (props) => renderToString(React.createElement(mainComp, props))

/* ═════════ ① 概览 ═════════ */
const homeHtml = check('ConsolePage（v4 · 概览）', () => render({
  initialData: {
    ov: FIX['/api/bili-fenshen/overview'],
    act: FIX['/api/bili-fenshen/activity'],
    persona: FIX['/api/bili-fenshen/persona'],
  },
}))
expectPage('v4 概览', homeHtml, [
  '概览',                                  // 页标题
  '让小号在B站保持存在感',                  // intro
  '跑一轮',                                // 主操作
  '自动值班开', '下一轮',                   // 状态条
  'data-freshness',                        // 数据新鲜度徽标
  '今日产出', '今日',                       // ⑤ 今日产出块
  '接话', '扫描',                           // ④ 接话卡
  '最近一条：这个折叠次数是给手残党看的吧',   // 最近说过的话（来自 presence.latest）
  '配额', '挑中', '本轮',                   // ⑥ 配额（日累计/本轮）
  '存在感（近 7 天）',                      // ⑦ 存在感
  '人设与健康', '健康检查明细',              // ⑧ 人设一句话 + 健康
])
// 回归（2026-10-28 事故）：人设卡必须解包 persona.data，否则永远「未加载 / 语料 0 条」
expectAll('v4 概览人设卡', homeHtml, ['蓝色大肥鱼', '语料 23 条', '卡生效'])
if (homeHtml.includes('未加载')) { console.log('✗ FAIL 概览人设卡不应出现「未加载」（persona.data 未解包）'); bad++ }
// 回归：配额上限必须始终可见（不能只印数字，标题却写「上限」）
expectAll('v4 配额上限', homeHtml, ['/ 5', '/ 10', '/ 3'])
// 5 个一级页签、且没有「实时」「判重表」页签
expectAll('v4 页签', homeHtml, ['概览', '活动', '日报', '人设', '设置'])
if (count(homeHtml, /role="tab"/g) !== 5) {
  console.log(`✗ FAIL 一级页签应为 5 个，实际 ${count(homeHtml, /role="tab"/g)}`); bad++
}
// 空数据态：schema 缺失也不能崩
const homeEmpty = check('ConsolePage（v4 · 概览 · 空数据）', () => render({ initialData: { ov: {} } }))
expectAll('v4 概览空数据', homeEmpty, ['今日产出', '配额', '跑一轮'])
// 回归（2026-10-28 事故）：信封还没到时不能把「加载中」误报成「找不到 dsh CLI」
if (homeEmpty.includes('找不到 dsh CLI')) {
  console.log('✗ FAIL 空数据态不应渲染「找不到 dsh CLI」横幅（health 为空不能当缺失）'); bad++
}

// 回归：presence.available=true 但 likesAvailable=false —— 收赞必须「—/无数据源」+ 说明，不能假 0
const likesMissing = check('ConsolePage（v4 · 概览 · 收赞无数据源）', () => render({
  initialData: {
    ov: {
      ...FIX['/api/bili-fenshen/overview'],
      presence: {
        available: true, likesAvailable: false,
        likes7d: 0, replies7d: 2, comments7d: 7,
        trend: [], latest: null,
        note: 'B站没有「收到的赞」通知接口，收赞一栏暂不统计。',
      },
    },
  },
}))
expectAll('v4 收赞无数据源', likesMissing, ['收到点赞', '无数据源', 'B站没有「收到的赞」通知接口'])

// 回归：生效的是用户自己编辑的卡（active.mode='file'，没有 presetId）也要显示卡名，不能「未加载」
const fileCardHtml = check('ConsolePage（v4 · 概览 · 自定义卡）', () => render({
  initialData: {
    ov: FIX['/api/bili-fenshen/overview'],
    persona: {
      ...FIX['/api/bili-fenshen/persona'],
      active: { mode: 'file', path: 'C:/h/persona/card.json' },
    },
  },
}))
expectAll('v4 概览自定义卡', fileCardHtml, ['蓝色大肥鱼', '卡生效', '@2.0.0'])
if (fileCardHtml.includes('未加载')) { console.log('✗ FAIL 自定义卡（无 presetId）不应显示「未加载」'); bad++ }

/* ═════════ ② 概览 · 运行中（原「实时」页并入） ═════════ */
const runningHtml = check('ConsolePage（v4 · 概览 · 运行中）', () => render({
  initialData: { ov: RUNNING_OVERVIEW, act: FIX['/api/bili-fenshen/activity'] },
  live: RUNNING_LIVE,
}))
expectPage('v4 概览运行中', runningHtml, [
  '运行详情', '运行中', '看内容', '自动滚动', '中止',
  'bili_search', '事件流',
  '工具', '扫描', '接话',
])
// 运行中：状态条 + 主按钮都是「中止」
if (!runningHtml.includes('中止')) { console.log('✗ FAIL 运行中主操作应为「中止」'); bad++ }

/* ═════════ ③ 概览 · 接话未扫描（红 chip + 告警） ═════════ */
const missingHtml = check('ConsolePage（v4 · 概览 · 接话未扫描）', () => render({
  initialData: { ov: MISSING_PROACTIVE_OVERVIEW, act: FIX['/api/bili-fenshen/activity'] },
}))
expectPage('v4 接话未扫描', missingHtml, ['接话', '未扫描', '接话扫描'])

/* ═════════ ④ 活动 · 生命周期（默认视图） ═════════ */
const actHtml = check('ConsolePage（v4 · 活动 · 生命周期）', () => render({
  initialTab: 'activity',
  initialData: { act: FIX['/api/bili-fenshen/activity'] },
}))
expectPage('v4 活动', actHtml, [
  '活动',                                   // 页标题
  '它看过什么、说过什么',                    // intro
  '生命周期', '时间线', '判重表',            // 3 视图
  '接话', '接话扫描',                        // 新筛选 + 接话标签
  '全部 3',
  '折1万次',
  '跳过 1 条',                              // 跳过折叠组
  '接话扫描：候选 2',                        // reply-scan 机器行
  '筛选后 3 个视频',
])
// 生命周期链路含「扫描」阶段
expectAll('v4 活动链路', actHtml, ['刷到', '扫描', '被回复', '我回'])

/* ═════════ ⑤ 活动 · 时间线 ═════════ */
const timelineHtml = check('ConsolePage（v4 · 活动 · 时间线）', () => render({
  initialTab: 'activity', initialView: 'timeline',
  initialData: { act: FIX['/api/bili-fenshen/activity'] },
}))
expectPage('v4 时间线', timelineHtml, ['时间线', '接话', '我接话：这句真的是设计师本命'])

/* ═════════ ⑥ 活动 · 判重表（原页签降级为第 3 视图） ═════════ */
const seenHtml = check('ConsolePage（v4 · 活动 · 判重表）', () => render({
  initialTab: 'activity', initialView: 'seen',
  initialData: { seen: FIX['/api/bili-fenshen/seen'] },
}))
expectPage('v4 判重表视图', seenHtml, [
  '判重表', '看过什么', 'BV1xrnz6gEVD', '折1万次，会坏吗？iPhone Duo深度评测', '看过', '评论',
  '折叠 1 条值班备注', '看过+赞过+接话过',
])

/* ═════════ ⑦ 日报 ═════════ */
const reportsHtml = check('ConsolePage（v4 · 日报）', () => render({
  initialTab: 'reports',
  initialData: { reports: { list: FIX['/api/bili-fenshen/reports'], day: '2026-10-23', text: FIX['/api/bili-fenshen/report'].text } },
}))
expectPage('v4 日报', reportsHtml, [
  '日报',                                   // 页标题（也是 tab 名）
  '每一轮的过程记录',                        // intro
  '2026-10-23.md', '月度归档', 'headless-overlay.yml',
  // Markdown 渲染：h1 降为 h2.bf-md-h1（下面单独断言）、粗体渲染成 <strong>、列表项按行渲染
  '<strong>', '折 1 万次', '这个折叠次数', '接话扫描：候选 2',
])
// md 的 h1 渲染成 h2.bf-md-h1，保证页面唯一 h1 = 页头标题
if (!reportsHtml.includes('class="bf-md-h1"')) { console.log('✗ FAIL 日报缺少 md h1（应为 h2.bf-md-h1）'); bad++ }

/* ═════════ ⑧ 人设 · 3 子页签 ═════════ */
const personaHtml = check('ConsolePage（v4 · 人设 · 人设卡）', () => render({
  initialTab: 'persona',
  initialData: { personaPage: { persona: FIX['/api/bili-fenshen/persona'], preview: FIX['/api/bili-fenshen/persona/preview'] } },
}))
expectPage('v4 人设', personaHtml, [
  '人设',                                   // 页标题
  '这个号是谁、说话像不像它',                 // intro
  '人设卡', '素材库', '预览与质量',           // 3 子页签
  '卡（生效）', '蓝色大肥鱼', '1052/1500',    // 生效态 + 五块预算
  'P1 常驻核心',
  'L0 6/6',
  '高级：JSON 编辑',                         // 折叠，但仍在 DOM
  '保存并生效',
])
// 8 个子页签不再出现
for (const gone of ['质量 / L0', '版本对比', '今日状态', '试写沙盒']) {
  if (personaHtml.includes(`>${gone}<`)) { console.log(`✗ FAIL 人设页不应再有独立页签「${gone}」`); bad++ }
}

/* ═════════ ⑨ 人设 · 素材库 ═════════ */
const personaMaterials = check('ConsolePage（v4 · 人设 · 素材库）', () => render({
  initialTab: 'persona', initialPersonaTab: 'bank',
  initialData: {
    personaPage: {
      persona: FIX['/api/bili-fenshen/persona'],
      preview: FIX['/api/bili-fenshen/persona/preview'],
      expression: FIX['/api/bili-fenshen/persona/expression'],
      lore: FIX['/api/bili-fenshen/persona/lore'],
      versions: FIX['/api/bili-fenshen/persona/versions'],
    },
  },
}))
expectPage('v4 人设素材库', personaMaterials, [
  '语料库', '封面能不能好好做？', '桶：question',
  '见闻库', 'wuchang-ranked', '正文内容',
])

/* ═════════ ⑩ 人设 · 预览与质量 ═════════ */
const personaPreview = check('ConsolePage（v4 · 人设 · 预览与质量）', () => render({
  initialTab: 'persona', initialPersonaTab: 'quality',
  initialData: {
    personaPage: {
      persona: FIX['/api/bili-fenshen/persona'],
      preview: FIX['/api/bili-fenshen/persona/preview'],
      expression: FIX['/api/bili-fenshen/persona/expression'],
      lore: FIX['/api/bili-fenshen/persona/lore'],
      versions: FIX['/api/bili-fenshen/persona/versions'],
    },
  },
}))
expectPage('v4 人设预览与质量', personaPreview, [
  '编译产物', 'L0 六条', '红线三件套', '1733/3000',
  '版本快照', 'whale-2.0.0-2026-10-26.json', '回滚',
  '最近说过（注入 P3）', '欠账',
  '试写沙盒（未接',
])

/* ═════════ ⑪ 人设 · legacy ═════════ */
const legacyFixture = {
  ...FIX['/api/bili-fenshen/persona'],
  health: { mode: 'legacy', ok: true, detail: '旧格式人设（legacy 直通）', source: 'legacy' },
}
const personaLegacy = check('ConsolePage（v4 · 人设 · legacy）', () => render({
  initialTab: 'persona',
  initialData: {
    personaPage: { persona: legacyFixture, preview: FIX['/api/bili-fenshen/persona/preview'] },
  },
}))
expectPage('v4 人设 legacy', personaLegacy, [
  'legacy 直通', '人设卡（当前未生效）', '本轮走 legacy 直通', '不会覆盖配置',
])

/* ═════════ ⑫ 设置 · 3 组 ═════════ */
const settingsRules = check('ConsolePage（v4 · 设置 · 节奏与配额）', () => render({
  initialTab: 'settings', initialData: { config: FIX['/api/bili-fenshen/config'] },
}))
expectPage('v4 设置', settingsRules, [
  '设置',                                   // 页标题
  '怎么调它',                                // intro
  '节奏与配额', '内容与禁令', '运行环境',      // 3 组
  '自动值班', '中午窗口', '晚间窗口',
  '每天评论', '每轮主动接话',                 // 配额字段（行式）
  '保存并生效', '与持久化配置一致',
])
// 行式排版：label + help 同行结构
expectAll('v4 设置行式', settingsRules, ['class="bf-row-main"', 'class="bf-row-ctl"', 'class="bf-row-help"'])

/* ═════════ ⑬ settings.section 入口 ═════════ */
const settingsHtml = check('SettingsEntry 静态壳', () => renderToString(React.createElement(settingsComp)))
expectAll('设置页入口', settingsHtml, ['安装自检', '一键诊断', '打开控制台'])

console.log(bad === 0 ? 'RENDER SMOKE ALL GREEN' : `${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
