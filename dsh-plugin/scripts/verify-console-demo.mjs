#!/usr/bin/env node
/**
 * 全局控制台演示稿 v3 · 校验（可重复执行；失败非 0 退出）
 *
 * 覆盖五层：
 *   1. 结构：页面清单 / 渲染函数 / 无占位符 / div 开合 / 无外部资源依赖；
 *   2. 数据：<script id="data"> 可 JSON.parse、顶层字段齐全、关键子字段有值；
 *   3. 时间：generatedAt 为本地时间 + 时区；
 *   4. 语法：抽出内联应用脚本跑 node --check（临时文件用完删除）；
 *   5. 回归：v3 的关键设计点（主题 token、导航分组、人设 8 页签、显式保存条）仍在。
 *
 * 用法：node dsh-plugin/scripts/verify-console-demo.mjs
 *       （或 cd dsh-plugin && npm run demo:console:verify）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HTML = resolve(HERE, '..', 'console-demo-v3.html')
const html = readFileSync(HTML, 'utf8')

let bad = 0
const ok = (m) => console.log('OK   ' + m)
const fail = (m) => { console.log('FAIL ' + m); bad++ }

/* 1. 占位符 / 外部资源 */
if (html.includes('__DATA__')) fail('残留 __DATA__ 占位符')
else ok('无 __DATA__ 残留')
const htmlNoScript = html.replace(/<script[\s\S]*?<\/script>/g, '')
const ext = [...htmlNoScript.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
if (ext.length) fail('静态 HTML 依赖外部资源：' + ext.join(', '))
else ok('无外部资源依赖（单文件）')

/* 2. 数据块 */
const REQUIRED = ['meta', 'account', 'duty', 'quota', 'presence', 'activities', 'live', 'reports', 'seen', 'persona', 'config', 'health']
let data = null
const dm = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
if (!dm) fail('找不到 <script id="data" type="application/json"> 数据块')
else {
  try {
    data = JSON.parse(dm[1])
    const missing = REQUIRED.filter((k) => !(k in data))
    if (missing.length) fail('data 缺顶层字段：' + missing.join(', '))
    else ok('data JSON 可解析（' + dm[1].length + ' 字符，' + REQUIRED.length + ' 个顶层字段齐全）')
  } catch (e) { fail('data JSON 解析失败：' + e.message) }
}
if (data) {
  const p = data.persona || {}
  if (p.card && p.card.id) ok('人设数据：' + p.card.id + '@' + p.card.version + ' · 编译 ' + (p.compiled?.stats?.total || 0) + ' 字符 · L0 ' + (Array.isArray(p.l0) ? p.l0.length : 0) + ' 条')
  else fail('persona.card 缺失')
  const days = data.activities?.days || []
  const rounds = days.reduce((n, d) => n + (d.rounds || []).length, 0)
  const items = days.reduce((n, d) => n + (d.rounds || []).reduce((m, r) => m + (r.items || []).length, 0), 0)
  ok('活动数据：' + days.length + ' 天 / ' + rounds + ' 轮 / ' + items + ' 个视频')
  if (!days.length) fail('activities.days 为空（真实账本应至少有一轮）')
  const repDays = Object.keys(data.reports?.contents || {})
  if (repDays.length) ok('日报：' + repDays.length + ' 份正文（' + repDays.join(' / ') + '）')
  else fail('reports.contents 为空')
  ok('判重表：' + (data.seen?.rows || []).length + ' 行')
  const cfgKeys = Object.keys(data.config?.values || {})
  if (cfgKeys.length >= 20) ok('配置：' + cfgKeys.length + ' 个字段')
  else fail('config.values 字段过少（' + cfgKeys.length + '）')
  ok('健康检查：' + (data.health?.items || []).length + ' 项')
  if (data.meta?.generatedAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(data.meta.generatedAt)) ok('generatedAt 为本地时间 + 时区：' + data.meta.generatedAt)
  else fail('meta.generatedAt 格式应为 YYYY-MM-DD HH:mm:ss +08:00：' + JSON.stringify(data.meta?.generatedAt))
}

/* 3. 应用脚本语法 */
const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const tmp = join(tmpdir(), 'bf-console-demo-check-' + process.pid + '.js')
try {
  writeFileSync(tmp, scripts.join('\n;\n'), 'utf8')
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  ok('内联脚本语法通过（node --check，' + scripts.length + ' 段 / ' + scripts.join('').length + ' 字符）')
} catch (e) {
  fail('内联脚本语法错误：\n' + String(e.stderr || e.message).slice(0, 1400))
} finally {
  try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
}

/* 4. 结构回归 */
const PAGES = ['renderOverview', 'renderLive', 'renderActivity', 'renderReports', 'renderSeen', 'renderPersona', 'renderSettings']
const missFn = PAGES.filter((f) => !new RegExp('function ' + f + '\\(').test(html))
if (missFn.length) fail('缺页面渲染函数：' + missFn.join(', '))
else ok('页面渲染函数齐全（' + PAGES.length + ' 页）')

const NAV_GROUPS = ['运营', '产出', '配置']
const missNav = NAV_GROUPS.filter((g) => !html.includes("'" + g + "'"))
if (missNav.length) fail('导航分组缺失：' + missNav.join(', '))
else ok('导航分组齐全（' + NAV_GROUPS.join(' / ') + '）')

const PF_TABS = ['卡片', '编译预览', '质量 / L0', '语料库', '见闻库', '今日状态', '版本对比', '试写沙盒']
const missTab = PF_TABS.filter((t) => !html.includes("'" + t + "'"))
if (missTab.length) fail('人设页签缺失：' + missTab.join(', '))
else ok('人设工作室 8 页签齐全')

const DESIGN = ['data-theme', '--dsw-alias-bg-base', 'bf-console', 'savebar']
const missDesign = DESIGN.filter((d) => !html.includes(d))
if (missDesign.length) fail('关键设计点缺失：' + missDesign.join(', '))
else ok('关键设计点齐全（主题 token / 显式保存条 / 宿主命名）')

const open = (html.match(/<div\b/g) || []).length
const close = (html.match(/<\/div>/g) || []).length
if (open === close) ok('div 开合平衡（' + open + '/' + close + '）')
else fail('div 开合不平衡（' + open + '/' + close + '）')

console.log(bad ? '\n=== ' + bad + ' 项失败 ===' : '\n=== ALL OK ===')
process.exit(bad ? 1 : 0)
