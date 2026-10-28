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

import {
  FIX, RUNNING_LIVE, RUNNING_OVERVIEW, MISSING_PROACTIVE_OVERVIEW,
  PERSONA_CHECKUP_EMPTY, PERSONA_HISTORY_EMPTY, NO_PERSONA_INJECT_OVERVIEW,
} from './fixtures/console-fixtures.mjs'

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
/** W4-4：统计 fetch 次数，用来断言 30s 内同一 key 不重复打。 */
let fetchCount = 0
globalThis.fetch = async (path) => {
  fetchCount++
  const clean = String(path).split('?')[0]
  const key = clean.replace(/^\/api\/bili-fenshen/, '')
  // FIX 的 key 带 /api/bili-fenshen 前缀；两种都查，保证真发请求的路径也能取到数据
  const data = FIX[clean] ?? FIX[key]
  return { json: async () => data ?? {}, ok: true }
}
// navigator 在 Node 22 是只读 getter —— 用 defineProperty 覆盖（client.js 只在 LogPane 里用到）
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: () => {} } }, configurable: true })

// ── 加载 client.js ──
const code = (await import('node:fs')).readFileSync(join(pluginDir, 'client.js'), 'utf8')
const sandbox = { window: globalThis.window, console, setInterval, clearInterval, setTimeout, clearTimeout, fetch: globalThis.fetch, navigator: globalThis.navigator, document: globalThis.document, __BF_TEST__: true }
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
const homeHtml = check('ConsolePage（v4 · 概览）', () => render({ initialData: { ov: FIX['/api/bili-fenshen/overview'], act: FIX['/api/bili-fenshen/activity'] } }))
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
// 5 个一级页签、且没有「实时」「判重表」页签
expectAll('v4 页签', homeHtml, ['概览', '活动', '日报', '人设', '设置'])
if (count(homeHtml, /role="tab"/g) !== 5) {
  console.log(`✗ FAIL 一级页签应为 5 个，实际 ${count(homeHtml, /role="tab"/g)}`); bad++
}
/* 账号基础信息区（v4 重做时被误删，2026-10-28 恢复）：头像 + 昵称/UID + 粉丝/关注/硬币 + 等级 */
expectAll('v4 概览 · 当前账号', homeHtml, [
  '当前账号', '蓝鱼小号', 'UID 10000001', 'LV6', '重新登录', 'bf-avatar',
  '>粉丝<', '>关注<', '>硬币<',
])
expectAll('v4 概览 · 账号数字', homeHtml, ['>12<'])       // 粉丝 12
// 有 face 时必须渲染真实头像 <img>（不允许只剩首字母占位）
const withFace = check('ConsolePage（v4 · 概览 · 有头像）', () => render({
  initialData: {
    ov: {
      ...FIX['/api/bili-fenshen/overview'],
      account: { ...FIX['/api/bili-fenshen/overview'].account, face: 'https://i1.hdslb.com/bfs/face/x.jpg' },
    },
  },
}))
if (!/class="bf-avatar"[^>]*>\s*<img[^>]+src="https:\/\/i1\.hdslb\.com/.test(withFace)) {
  console.log('✗ FAIL 有 face 时头像应为 <img>，实际没渲染出来'); bad++
}
// 空数据态：schema 缺失也不能崩
const homeEmpty = check('ConsolePage（v4 · 概览 · 空数据）', () => render({ initialData: { ov: {} } }))
expectAll('v4 概览空数据', homeEmpty, ['今日产出', '配额', '跑一轮'])
/* ⭐ 空数据态不得给出「故障」结论：首帧未到 ≠ CLI 没探测到、≠ 未登录、≠ 数据新鲜 */
for (const bogus of ['找不到 dsh CLI', '数据 刚刚', '未找到']) {
  if (homeEmpty.includes(bogus)) { console.log(`✗ FAIL 空数据态误报「${bogus}」`); bad++ }
}
expectAll('v4 概览空数据 · 占位文案', homeEmpty, ['正在连接…', '读取中…'])
// 完全没有 initialData（真实首屏：信封由 SSE 推来）同样不许误报
const homeNoInit = check('ConsolePage（v4 · 概览 · 无 initialData）', () => render({}))
for (const bogus of ['找不到 dsh CLI', '数据 刚刚']) {
  if (homeNoInit.includes(bogus)) { console.log(`✗ FAIL 首屏（无 initialData）误报「${bogus}」`); bad++ }
}
expectAll('v4 首屏 · 占位文案', homeNoInit, ['正在连接…', '当前账号'])

/* ⭐ W0-1 便宜断言②：`health.cli === undefined` 不许判红（"没拿到"≠"探测失败"）。
 * 只断"不出现横幅"是单边的——把整个 Banner 删掉也能过；所以两面都断：
 *   缺字段 → 不出横幅；明确是空串 → 必须出横幅。 */
const healthNoCli = check('ConsolePage（v4 · 概览 · health 缺 cli 字段）', () => render({
  initialData: { ov: { ...FIX['/api/bili-fenshen/overview'], health: { cred: true, routeOk: true, cliCheckedAt: '2026-10-28T00:20:00.000Z' } } },
}))
if (healthNoCli.includes('找不到 dsh CLI')) {
  console.log('✗ FAIL health.cli 缺失（首帧未到）被误判成「找不到 dsh CLI」'); bad++
}
const healthEmptyCli = check('ConsolePage（v4 · 概览 · health.cli 明确为空）', () => render({
  initialData: { ov: { ...FIX['/api/bili-fenshen/overview'], health: { cli: '', cred: true } } },
}))
if (!healthEmptyCli.includes('找不到 dsh CLI')) {
  console.log('✗ FAIL health.cli 明确为空时必须出横幅（否则隐性故障没人发现）'); bad++
}

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
/* ⭐ W3-3 软删除：disabled:true 的条目必须渲染成「已删除」态 + 恢复（不能删了既看不见也恢复不了） */
expectAll('v4 人设素材库 · 回收站（有数据）', personaMaterials, [
  '这是被软删的语料', 'old-meme', '已删除', '恢复', '彻底删除', '回收站 1',
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

/* ═════════ ⑫ W5 人设页四块：页头 / 本轮注入 / 体检 / 换卡对比（各两态） ═════════ */
/* 有数据：/persona 给页头、概览 round.personaInject 给「本轮注入」、
 * 两个新端点给「体检」「换卡对比」。四块的数据源都是分钟级变化 ⇒ 走 30s 复用。 */
const personaBlocks = check('ConsolePage（v4 · 人设 · 四块有数据）', () => render({
  initialTab: 'persona',
  initialData: {
    ov: FIX['/api/bili-fenshen/overview'],
    personaPage: {
      persona: FIX['/api/bili-fenshen/persona'],
      preview: FIX['/api/bili-fenshen/persona/preview'],
      checkup: FIX['/api/bili-fenshen/persona/checkup'],
      history: FIX['/api/bili-fenshen/persona/history'],
    },
  },
}))
expectPage('v4 人设四块', personaBlocks, ['人设', '这个号是谁、说话像不像它'])
expectAll('v4 人设 · 页头一行（有数据）', personaBlocks, [
  'data-block="persona-who"', '现在是谁', '蓝色大肥鱼 @2.0.0', '卡（生效）',
  '上轮注入', 'whale@2.0.0',
])
expectAll('v4 人设 · 本轮实际注入（有数据）', personaBlocks, [
  'data-block="persona-inject"', '本轮实际注入', '合计 1913 / 3000 字符',
  'P1 常驻核心', '1281/1500', '见闻 wuchang-ranked', '被问到 问是不是 AI',
  '降级 lore:shrink', '守卫：warn',
])
expectAll('v4 人设 · 体检（有数据）', personaBlocks, [
  'data-block="persona-checkup"', '体检', '近 12 条 vs 247 条基线', '有偏离',
  '中位字数', '24 字', '基线 27 字', '句号 / 条', '0.083', '表情占比', '75%',
  '基线 41.7%', '禁用词命中 0%（基线 0）', '表情占比 75%（基线 42%',
  '原来不是打码，是他自己秒切的屏',
])
expectAll('v4 人设 · 换卡对比（有数据）', personaBlocks, [
  'data-block="persona-history"', '换卡对比', '2 组人设',
  'whale@2.0.0', '3 轮 · 赞 7', 'elaina@2.0.0', '1 轮 · 赞 0',
  '封面能不能好好做？', '这句真的是设计师本命',
])

/* 无数据态（端点已就绪但没数据 / 概览里没有 persona-inject）：
 * 必须给「暂无数据」，不许崩、不许说「未找到」。 */
const personaBlocksNoInject = check('ConsolePage（v4 · 人设 · 四块暂无数据）', () => render({
  initialTab: 'persona',
  initialData: {
    ov: NO_PERSONA_INJECT_OVERVIEW,
    personaPage: {
      persona: FIX['/api/bili-fenshen/persona'],
      preview: FIX['/api/bili-fenshen/persona/preview'],
      checkup: PERSONA_CHECKUP_EMPTY,
      history: PERSONA_HISTORY_EMPTY,
    },
  },
}))
expectAll('v4 人设 · 页头一行（无数据）', personaBlocksNoInject, [
  'data-block="persona-who"', '现在是谁', '上轮注入', '暂无数据',
])
expectAll('v4 人设 · 本轮实际注入（无数据）', personaBlocksNoInject, [
  'data-block="persona-inject"', '本轮实际注入', '暂无数据',
  '这轮账本里还没有 persona-inject 记录',
])
expectAll('v4 人设 · 体检（无数据）', personaBlocksNoInject, [
  'data-block="persona-checkup"', '体检', '暂无数据', '数据不足',
])
expectAll('v4 人设 · 换卡对比（无数据）', personaBlocksNoInject, [
  'data-block="persona-history"', '换卡对比', '暂无数据',
  '还没有 persona-inject 归因数据',
])

/* 字段缺失 / 半截数据：契约字段缺失时必须退化成占位，而不是 SSR 直接抛错 */
const ovPartial = {
  ...FIX['/api/bili-fenshen/overview'],
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    personaInject: { personaTag: 'x@1', total: 10, layers: null, hits: null, degraded: null, notes: null },
  },
}
const personaBlocksPartial = check('ConsolePage（v4 · 人设 · 四块字段缺失）', () => render({
  initialTab: 'persona',
  initialData: {
    ov: ovPartial,
    personaPage: {
      persona: FIX['/api/bili-fenshen/persona'],
      checkup: { ok: true, windowDays: 7, n: 6, metrics: {}, verdict: { level: 'bad' }, samples: null },
      history: { ok: true, tags: [{ personaTag: 'x@1', samples: null }] },
    },
  },
}))
expectAll('v4 人设 · 字段缺失退化', personaBlocksPartial, [
  '本轮实际注入', 'whale@2.0.0 · 合计 10 / 0 字符',
  '这轮没有分块统计', '无降级', '这版人设还没有评论样本。',
  '暂无数据',                            // 体检 metrics 半截 → 不假装体检过
])

/* 首帧未到（initialData 全空）：四块统一「正在连接…」，且不回归误报文案。 */
const personaBlocksNoInit = check('ConsolePage（v4 · 人设 · 四块正在连接）', () => render({
  initialTab: 'persona',
  initialData: { personaPage: {} },
}))
expectAll('v4 人设 · 页头一行（正在连接）', personaBlocksNoInit, [
  'data-block="persona-who"', '现在是谁', '正在连接…',
])
expectAll('v4 人设 · 本轮实际注入（正在连接）', personaBlocksNoInit, [
  'data-block="persona-inject"', '本轮实际注入', '正在连接…',
])
expectAll('v4 人设 · 体检（正在连接）', personaBlocksNoInit, [
  'data-block="persona-checkup"', '体检', '正在连接…',
])
expectAll('v4 人设 · 换卡对比（正在连接）', personaBlocksNoInit, [
  'data-block="persona-history"', '换卡对比', '正在连接…',
])
for (const bogus of ['找不到 dsh CLI', '数据 刚刚', '未找到', 'undefined']) {
  if (personaBlocksNoInit.includes(bogus)) { console.log(`✗ FAIL 人设页首帧误报「${bogus}」`); bad++ }
}

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

/* ═════════ ⑭ W4-4 客户端请求复用：同一 key 30s 内不重复打 + 页面隐藏暂停 ═════════ */
const bt = plugin.__bfTest
if (!bt || typeof bt.cachedGet !== 'function') {
  console.log('✗ FAIL client.js 未暴露 __bfTest.cachedGet（30s 复用无法验证）'); bad++
} else {
  bt.resetGetCache()
  const c0 = fetchCount
  await bt.cachedGet('/persona')
  await bt.cachedGet('/persona')
  await bt.cachedGet('/persona/preview')
  await bt.cachedGet('/persona')
  const dupe = fetchCount - c0
  if (dupe !== 2) { console.log(`✗ FAIL 30s 复用：4 次调用应只打 2 次请求，实际 ${dupe}`); bad++ }
  else console.log('✓ 30s 复用：同一 key 4 次调用只打 2 次请求')

  // 过期（把 at 拨回 31s 前）后允许重打
  bt.GET_CACHE.get('/persona').at = Date.now() - (bt.GET_TTL_MS + 1000)
  await bt.cachedGet('/persona')
  if (fetchCount - c0 !== 3) { console.log('✗ FAIL 30s 过期后应重打一次'); bad++ }
  else console.log('✓ 30s 过期后重打一次')

  // 页面隐藏：即使过期也不发新请求；无缓存回 null
  bt.GET_CACHE.get('/persona').at = Date.now() - (bt.GET_TTL_MS + 1000)
  globalThis.document.hidden = true
  const hiddenBefore = fetchCount
  const stale = await bt.cachedGet('/persona')
  const nullish = await bt.cachedGet('/persona/lore')
  globalThis.document.hidden = false
  if (fetchCount !== hiddenBefore) { console.log('✗ FAIL 页面隐藏时不应发新请求'); bad++ }
  else if (!stale || stale.ok !== true) { console.log('✗ FAIL 页面隐藏且缓存过期时应复用旧值'); bad++ }
  else if (nullish !== null) { console.log('✗ FAIL 页面隐藏且无缓存时应返回 null'); bad++ }
  else console.log('✓ 页面隐藏：暂停请求、复用旧值、无缓存回 null')
}

console.log(bad === 0 ? 'RENDER SMOKE ALL GREEN' : `${bad} 项失败`)
process.exit(bad === 0 ? 0 : 1)
