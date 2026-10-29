// 数据回放：用真实账本验证 repliedTargetsFromLedger / dedupeScans 的修复效果。
// 用法：node scripts/replay-reply-dedup.mjs
import { readFileSync } from 'node:fs'
import { repliedTargetsFromLedger } from '../dsh-plugin/lib/replies.js'
import { dedupeScans } from '../dsh-plugin/lib/report.js'
import { parseLedgerText, sortEvents } from '../dsh-plugin/lib/ledger.js'

const ledger = sortEvents(parseLedgerText(readFileSync('C:/Users/Administrator/.dsh/bili-fenshen/ledger.jsonl', 'utf8')))
console.log(`账本事件总数: ${ledger.length}`)

// 1) 新已回复清单：两条真实重复目标必须在内
const targets = repliedTargetsFromLedger(ledger, { days: 14 })
const all = [...targets.proactive, ...targets.followup]
console.log(`\n已回复清单（近14天）: 接话 ${targets.proactive.length} 条, 跟进 ${targets.followup.length} 条`)
for (const x of all) console.log(`  [${x === targets.proactive.find(p => p === x) ? '接话' : '跟进'}] ${x.bvid}→对方rpid ${x.parent}`)

const mustHave = ['BV1TisX6dEFS→318480411329', 'BV192n66dEDQ→317852573329']
const keys = all.map((x) => `${x.bvid}→${x.parent}`)
for (const k of mustHave) {
  console.log(keys.includes(k) ? `✅ ${k} 在清单里（03:14 那轮会自动跳过这条跟进）` : `❌ ${k} 不在清单里！`)
}

// 2) 模拟 03:14 轮的已接话清单注入检查：如果模型那时想接/跟这两个目标，会被清单拦住
// 3) dedupeScans 全局 posted 键：模拟 01:37 失败轮回填（旧代码会把 01:13 的扫描再抄一遍）
const existingScans = ledger.filter((e) => e.type === 'reply-scan')
console.log(`\n账本 reply-scan 事件: ${existingScans.length} 条`)
const fakeBackfillScans = [
  { bvid: 'BV1Qsnt6HExf', decision: 'posted', targetRpid: 318012908193, round: '2026-10-29T01:37:05.000Z' },
  { bvid: 'BV1dHHP6FErS', decision: 'skipped', round: '2026-10-29T01:37:05.000Z' },
]
const fresh = dedupeScans(existingScans, fakeBackfillScans, '2026-10-29T01:37:05.000Z')
console.log(fresh.length === 0
  ? '✅ 失败轮回填的重复扫描被全局去重拦住（旧实现会多记 1 条 posted）'
  : `❌ 仍有 ${fresh.length} 条重复扫描漏过: ${JSON.stringify(fresh.map((x) => [x.bvid, x.decision]))}`)

// 4) round id 双源检查：账本里同一轮的 round 值种类
const rounds29 = new Set(ledger.filter((e) => String(e.round || '').startsWith('2026-10-29T03:14')).map((e) => e.round))
console.log(`\n03:14 轮出现过的 round 值: ${[...rounds29].join(' | ') || '（无）'}`)
console.log(rounds29.size > 1 ? '（这就是修复前的双源现场；env 注入后新轮不会再出现）' : '（单源正常）')
