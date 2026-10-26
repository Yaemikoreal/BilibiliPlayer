#!/usr/bin/env node
/**
 * 人设工作室演示稿 · 数据注入（可重复执行）
 *
 * 数据组装已抽到 scripts/lib/persona-demo-data.mjs（全局控制台 v3 的注入脚本复用同一份），
 * 本脚本只负责：把 buildPersonaDemoData() 的返回值写进
 * dsh-plugin/persona-studio-demo.html 的 <script id="data" type="application/json"> JSON 块。
 *
 * 三条纪律（都是上一轮的坑，实现见 lib/persona-demo-data.mjs）：
 *   1. 仓库根从 import.meta.url 推（scripts/ → dsh-plugin/ → 仓库根），不写死本机绝对路径；
 *   2. 用 mkdtemp 出来的临时 BILI_FENSHEN_HOME 跑编译，不污染真实 ~/.dsh/bili-fenshen；
 *      但**读**真实账本 <realHome>/ledger.jsonl（不存在/读坏都按空数组）；
 *   3. 演示场景固定（2026-10-26 02:10 本地，凌晨时段让「40 字上限」可见；roundId 固定），
 *      所以同一份代码重复执行只有 generatedAt 会变；注入靠替换数据块，不重写整份 HTML。
 *
 * 用法：node dsh-plugin/scripts/inject-persona-demo.mjs
 *       （或 cd dsh-plugin && npm run demo:persona）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPersonaDemoData, defaultRealHome } from './lib/persona-demo-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const DEMO = join(PLUGIN_DIR, 'persona-studio-demo.html')

const main = async () => {
  const data = await buildPersonaDemoData({ pluginDir: PLUGIN_DIR, realHome: defaultRealHome() })

  /* ── 注入数据块（可重复执行：替换已有 JSON 内容） ── */
  const html = readFileSync(DEMO, 'utf8')
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const RE = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/
  if (!RE.test(html)) {
    console.error('FAIL 模板里找不到 <script id="data" type="application/json"> 数据块：' + DEMO)
    process.exitCode = 1
    return
  }
  writeFileSync(DEMO, html.replace(RE, (m, a, _b, c) => a + json + c), 'utf8')

  console.log(
    'OK 已注入演示数据：card=' + data.card.id + '@' + data.card.version
    + ' 编译=' + data.compiled.stats.total + '/' + data.compiled.stats.totalMax + ' 字符 '
    + 'prompt=' + data.promptLen + ' 字符 L0=' + data.l0.filter((c) => c.level === 'pass').length + '/' + data.l0.length + ' pass '
    + '语料=' + data.bank.total + ' 条 sandbox=' + data.sandbox.map((s) => (s.pass ? 'P' : 'F')).join(''),
  )
}

main().catch((e) => {
  console.error('FAIL 注入失败：' + (e?.stack || e?.message || e))
  process.exitCode = 1
})
