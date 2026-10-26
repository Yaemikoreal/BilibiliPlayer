#!/usr/bin/env node
/**
 * 全局控制台演示稿 v3 · 数据注入（可重复执行）
 *
 * 数据全部来自 scripts/lib/console-demo-data.mjs 的真实快照组装：
 *   config / state / ledger / seen / out 日报 / digest 归档 / headless-overlay / 人设卡。
 * 本脚本只负责把数据写进 dsh-plugin/console-demo-v3.html 的
 * <script id="data" type="application/json">…</script> 数据块（替换已有内容，不重写整份 HTML）。
 *
 * 用法：
 *   node scripts/inject-console-demo.mjs --dry   只算数据 + 打印摘要，不写任何文件
 *   node scripts/inject-console-demo.mjs         写进 dsh-plugin/console-demo-v3.html
 *   （或 cd dsh-plugin && npm run demo:console [-- --dry]）
 *
 * 纪律：不读凭证文件内容（只判断存在）、不联网、不写家目录状态；
 * 人设部分由 lib/persona-demo-data.mjs 用临时 BILI_FENSHEN_HOME 隔离编译。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConsoleDemoData } from './lib/console-demo-data.mjs'
import { defaultRealHome } from './lib/persona-demo-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const HTML = join(PLUGIN_DIR, 'console-demo-v3.html')
const DRY = process.argv.slice(2).includes('--dry')

const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const parseAttrs = (text) => {
  const out = {}
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(text))) out[String(m[1]).toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return out
}

/** 找到 <script id="data" type="application/json"> 数据块（属性顺序/引号风格容忍） */
const findDataBlock = (html) => {
  const RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = RE.exec(html))) {
    const attrs = parseAttrs(m[1])
    if (attrs.id !== 'data') continue
    if (String(attrs.type || '').toLowerCase() !== 'application/json') continue
    const innerStart = m.index + m[0].indexOf('>') + 1
    return { innerStart, innerEnd: innerStart + m[2].length }
  }
  return null
}

const summarize = (data) => {
  const days = data.activities?.days || []
  const rounds = days.reduce((n, d) => n + (d.rounds || []).length, 0)
  const items = days.reduce((n, d) => n + (d.rounds || []).reduce((m2, r) => m2 + (r.items || []).length, 0), 0)
  const evs = days.reduce((n, d) => n + (d.rounds || []).reduce((m2, r) => m2 + (r.items || []).reduce((k, it) => k + (it.events || []).length, 0), 0), 0)
  const reportDays = data.reports?.days || []
  const reportBytes = reportDays.reduce((n, d) => n + (d.bytes || 0), 0)
  const contentChars = Object.values(data.reports?.contents || {}).reduce((n, t) => n + String(t || '').length, 0)
  const digestBytes = (data.reports?.digests || []).reduce((n, d) => n + (d.bytes || 0), 0)
  const demo = data.live?.demo || {}
  const q = data.quota || {}
  const seenRows = data.seen?.rows || []
  const healthItems = data.health?.items || []
  const personaCard = data.persona?.card || {}
  const lines = []
  lines.push('── 顶层键 ──')
  lines.push(Object.keys(data).join(' / '))
  lines.push('── 关键值 ──')
  lines.push('meta：' + data.meta?.generatedAt + ' · v' + data.meta?.appVersion)
  lines.push('account：loggedIn=' + data.account?.loggedIn + ' · name=' + (data.account?.name || '（空）') + ' · level=' + String(data.account?.level) + '（null=未联网，不编造）')
  lines.push('duty：autoDuty=' + data.duty?.autoDuty + ' noon=' + data.duty?.noon + ' night=' + data.duty?.night
    + ' next=' + data.duty?.nextWindowLabel + ' lastCode=' + String(data.duty?.lastCode)
    + ' lastWhy=' + data.duty?.lastWhy + ' lastRunAt=' + data.duty?.lastRunAt + ' roundsToday=' + data.duty?.roundsToday)
  lines.push('quota：picked=' + q.picked + ' comments=' + q.comments + ' likes=' + q.likes + ' dynamics=' + q.dynamics + ' replies=' + q.replies
    + ' limits=' + JSON.stringify(q.limits))
  lines.push('presence：likes7d=' + data.presence?.likes7d + ' replies7d=' + data.presence?.replies7d + ' comments7d=' + data.presence?.comments7d
    + ' trend=' + (data.presence?.trend || []).length + ' 天 · latestComment=' + (data.presence?.latestComment ? ('「' + data.presence.latestComment.text + '」 @' + data.presence.latestComment.bvid) : '（无）'))
  lines.push('config.model：' + JSON.stringify(data.config?.model) + ' · sources override=' + Object.keys(data.config?.sources || {}).filter((k) => data.config.sources[k] === 'override').length + ' 项')
  lines.push('── 数量 ──')
  lines.push('activities：days=' + days.length + ' · rounds=' + rounds + ' · items=' + items + ' · item.events=' + evs + ' · totalEvents=' + data.activities?.totalEvents + ' · bvidCount=' + data.activities?.bvidCount)
  for (const d of days) lines.push('  ' + d.date + '：' + (d.rounds || []).length + ' 轮 / ' + (d.rounds || []).reduce((n, r) => n + (r.items || []).length, 0) + ' 条')
  lines.push('reports：days=' + reportDays.length + '（' + reportDays.map((d) => d.date).join(',') + '，' + reportBytes + ' 字节，contents ' + contentChars + ' 字符）'
    + ' · digests=' + (data.reports?.digests || []).length + '（' + digestBytes + ' 字节）'
    + ' · overlay=' + (data.reports?.overlay?.text ? data.reports.overlay.name + ' ' + data.reports.overlay.text.length + ' 字符' : '缺失'))
  lines.push('seen：rows=' + seenRows.length + ' · total=' + data.seen?.total + ' · rawBytes=' + data.seen?.rawBytes)
  lines.push('persona：card=' + personaCard.id + '@' + personaCard.version + ' · promptLen=' + data.persona?.promptLen + ' · L0=' + (data.persona?.l0 || []).length + ' 项 · diff=' + (data.persona?.diff || []).length + ' 行')
  lines.push('live：idle.lastRunAt=' + (data.live?.idle?.lastRunAt || '') + ' · demo.events=' + (demo.events || []).length
    + ' · phase=' + (demo.phase?.key || '') + '/' + (demo.phase?.label || '')
    + ' · elapsedMs=' + demo.elapsedMs + ' · stats=' + JSON.stringify(demo.stats)
    + ' · demo.quota=' + JSON.stringify(demo.quota ? { picked: demo.quota.picked, comments: demo.quota.comments, likes: demo.quota.likes, dynamics: demo.quota.dynamics } : null))
  lines.push('health：' + healthItems.length + ' 项 → ' + healthItems.map((h) => h.id + ':' + h.status).join(' '))
  lines.push('── 体积 ──')
  lines.push('JSON：' + Buffer.byteLength(JSON.stringify(data), 'utf8') + ' 字节')
  return lines.join('\n')
}

const main = async () => {
  const data = await buildConsoleDemoData({ pluginDir: PLUGIN_DIR, realHome: defaultRealHome() })

  if (DRY) {
    console.log('DRY 只算数据，不写文件。realHome=' + defaultRealHome())
    console.log(summarize(data))
    console.log('DRY OK（未写入任何文件）')
    return
  }

  if (!existsSync(HTML)) {
    console.error('FAIL 找不到模板：' + HTML + '（先由 Lead 放入 console-demo-v3.html）')
    process.exitCode = 1
    return
  }
  const html = readFileSync(HTML, 'utf8')
  const block = findDataBlock(html)
  if (!block) {
    console.error('FAIL 模板里找不到 <script id="data" type="application/json"> 数据块：' + HTML)
    process.exitCode = 1
    return
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  writeFileSync(HTML, html.slice(0, block.innerStart) + json + html.slice(block.innerEnd), 'utf8')
  console.log('OK 已注入控制台演示数据：' + json.length + ' 字符 → ' + HTML)
  console.log(summarize(data))
}

main().catch((e) => {
  console.error('FAIL 组装/注入失败：' + (e?.stack || e?.message || e))
  process.exitCode = 1
})
