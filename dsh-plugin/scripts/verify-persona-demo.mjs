#!/usr/bin/env node
/**
 * 人设工作室演示稿 · 校验（可重复执行；失败非 0 退出）
 *
 * 覆盖四层：
 *   1. 数据：无 __DATA__ 占位符残留；<script id="data"> 可 JSON.parse 且关键顶层字段齐全；
 *   2. 内容回归：generatedAt 是本地时间+时区；版本对比页两处数字已按真实数据修正；
 *   3. 语法：抽出全部内联 <script>（不含 data JSON 块）写临时文件跑 node --check；
 *   4. 结构：关键 DOM id、渲染函数齐全；<div> 开合平衡。
 *
 * 用法：node dsh-plugin/scripts/verify-persona-demo.mjs
 *       （或 cd dsh-plugin && npm run demo:persona:verify）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HTML = resolve(HERE, '..', 'persona-studio-demo.html')
const html = readFileSync(HTML, 'utf8')

let bad = 0
const ok = (msg) => console.log('OK   ' + msg)
const fail = (msg) => { console.log('FAIL ' + msg); bad++ }

/* 1. 占位符残留 */
if (html.includes('__DATA__')) fail('残留 __DATA__ 占位符')
else ok('无 __DATA__ 残留')

/* 2. 数据块可解析 + 关键顶层字段 */
const DATA_KEYS = ['generatedAt', 'active', 'card', 'compiled', 'promptLen', 'l0', 'schema', 'bank', 'pickForm', 'lore', 'state', 'sandbox', 'diff']
let data = null
const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
if (!m) fail('找不到 <script id="data" type="application/json"> 数据块')
else {
  try {
    data = JSON.parse(m[1])
    const missing = DATA_KEYS.filter((k) => !(k in data))
    if (missing.length) fail('data 缺顶层字段：' + missing.join(', '))
    else ok(`data JSON 可解析（${m[1].length} 字符，${DATA_KEYS.length} 个关键顶层字段齐全）`)
  } catch (e) {
    fail('data JSON 解析失败：' + e.message)
  }
}

/* 3. 内容回归：本地时区时间戳 + 版本对比页两处数字修正 */
if (data) {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(String(data.generatedAt))) {
    ok('generatedAt 为本地时间 + 时区：' + data.generatedAt)
  } else {
    fail('generatedAt 格式应为 "YYYY-MM-DD HH:mm:ss +08:00"（不能用 UTC 冒充本地）：' + data.generatedAt)
  }

  const refs = [...new Set([...html.matchAll(/\bDATA\.([A-Za-z_]\w*)/g)].map((x) => x[1]))]
  const missRef = refs.filter((k) => !(k in data))
  if (missRef.length) fail('应用脚本引用了不存在的 DATA 字段：' + missRef.join(', '))
  else ok(`DATA.* 引用全部可解析（${refs.length} 个：${refs.join('/')}）`)

  const diff = Array.isArray(data.diff) ? data.diff : []
  const row = (k) => diff.find((d) => d && d.k === k)
  const red = row('红线')
  const negRow = row('禁止句占比')
  const freq = row('形象词词频')

  if (red && /全是否定式/.test(red.old) && /那要写成什么/.test(red.old)) ok('红线行 v1 统计为现算（全否定式 + 0 条正向替代）：' + red.old)
  else fail('红线行 v1 统计不完整：' + JSON.stringify(red?.old))

  if (negRow && /^\d+\/\d+ = \d+%/.test(negRow.old) && /不是越少越好/.test(negRow.why)) ok('禁止句占比行已改为诚实表述：' + negRow.old)
  else fail('禁止句占比行表述不完整：' + JSON.stringify(negRow))

  if (freq && !/无超限词（无超限词）/.test(freq.new)) ok('形象词词频行无重复括号：' + freq.new)
  else fail('形象词词频行仍有重复：' + JSON.stringify(freq?.new))
}

/* 4. 内联渲染脚本语法（node --check；临时文件写到 os.tmpdir，跑完删掉） */
const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1])
const tmp = join(tmpdir(), `bf-persona-demo-check-${process.pid}.js`)
try {
  writeFileSync(tmp, scripts.join('\n;\n'), 'utf8')
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  ok(`内联脚本语法通过（node --check，${scripts.length} 段 / ${scripts.join('').length} 字符）`)
} catch (e) {
  fail('内联脚本语法错误：\n' + String(e.stderr || e.message).slice(0, 1200))
} finally {
  try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
}

/* 5. 关键 DOM id / 渲染函数齐全 */
const ids = ['tabs', 'panes', 'data', 'chip-active', 'chip-budget', 'foot']
const missId = ids.filter((id) => !html.includes(`id="${id}"`))
if (missId.length) fail('缺 DOM id：' + missId.join(', '))
else ok(`关键 DOM id 齐全（${ids.length} 个）`)

const fns = ['renderCard', 'renderPreview', 'renderQuality', 'renderBank', 'renderLore', 'renderState', 'renderVersion', 'renderSandbox', 'renderBucketSamples', 'renderPick']
const missFn = fns.filter((f) => !new RegExp(`function ${f}\\(`).test(html))
if (missFn.length) fail('缺渲染函数：' + missFn.join(', '))
else ok(`渲染函数齐全（${fns.length} 个）`)

/* 6. div 开合平衡（模板字面量里的标签也计入） */
const open = (html.match(/<div\b/g) || []).length
const close = (html.match(/<\/div>/g) || []).length
if (open === close) ok(`div 开合平衡（${open}/${close}）`)
else fail(`div 开合不平衡（${open}/${close}）`)

console.log(bad ? `\n=== ${bad} 项失败 ===` : '\n=== ALL OK ===')
process.exit(bad ? 1 : 0)
