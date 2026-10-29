// 数据回放：用真实账本验证 repliedTargetsFromLedger / dedupeScans 的修复效果。
// 用法：node scripts/replay-reply-dedup.mjs
import { readFileSync } from 'node:fs'
import { repliedTargetsFromLedger } from '../dsh-plugin/lib/replies.js'
import { dedupeScans } from '../dsh-plugin/lib/report.js'
import { parseLedgerText, sortEvents } from '../dsh-plugin/lib/ledger.js'
import { requireLedger } from './_fenshen-paths.mjs'

let ledgerFile
try {
  ledgerFile = requireLedger()
} catch (e) {
  // 找不到账本时只给一句人话（脚本是给人手动跑的，不该甩一屏 stack）
  console.error(String(e?.message || e))
  process.exit(1)
}
const ledger = sortEvents(parseLedgerText(readFileSync(ledgerFile, 'utf8')))
console.log(`账本事件总数: ${ledger.length}`)

// 1) 新已回复清单：两条真实重复目标必须在内
const targets = repliedTargetsFromLedger(ledger, { days: 14 })
const all = [...targets.proactive, ...targets.followup]
console.log(`\n已回复清单（近14天）: 接话 ${targets.proactive.length} 条, 跟进 ${targets.followup.length} 条`)
for (const x of all) console.log(`  [${x === targets.proactive.find(p => p === x) ? '接话' : '跟进'}] ${x.bvid}→对方rpid ${x.parent}`)

// mustHave 是「当初触发这个修复的那台机器」的样本；换机器/换号后本机账本里可能压根没有这两条。
// 判据因此改成：**账本里确实回过这个目标** ⇒ 必须在清单里；账本里没有 ⇒ 样本缺失，跳过不报错。
const mustHave = [
  { bvid: 'BV1TisX6dEFS', parent: 318480411329 },
  { bvid: 'BV192n66dEDQ', parent: 317852573329 },
]
const keys = all.map((x) => `${x.bvid}→${x.parent}`)
for (const { bvid, parent } of mustHave) {
  const key = `${bvid}→${parent}`
  const inLedger = ledger.some((e) => e.type === 'reply-out' && e.bvid === bvid
    && String(e.parent ?? '') === String(parent))
  if (!inLedger) {
    console.log(`⏭  ${key} 本机账本里没有回过这条（样本缺失，跳过）`)
    continue
  }
  console.log(keys.includes(key)
    ? `✅ ${key} 在清单里（那一轮会自动跳过这条跟进）`
    : `❌ ${key} 在账本里回过，却没进已回复清单！`)
}

// 2) 模拟 03:14 轮的已接话清单注入检查：如果模型那时想接/跟这两个目标，会被清单拦住
// 3) dedupeScans 全局键：模拟失败轮回填「账本里已经有过的扫描」（旧实现会整套再抄一遍）
//    判重键与 lib/report.js:140 一致：posted → targetRpid，skipped → bvid。
//    ⚠️ 这组样本来自触发修复的那台机器；换机器/换号后本机账本里可能没有这两条原始扫描，
//    此时它们本就是「新扫描」，不该被去重拦住 —— 所以只对账本实有扫描做回归。
const scanKey = (e) => (e && e.decision === 'posted'
  ? `posted|${e.targetRpid == null ? '' : e.targetRpid}`
  : `skipped|${(e && e.bvid) || ''}`)
const existingScans = ledger.filter((e) => e.type === 'reply-scan')
const seenScanKeys = new Set(existingScans.map(scanKey))
console.log(`\n账本 reply-scan 事件: ${existingScans.length} 条`)
const candidatesAll = [
  { bvid: 'BV1Qsnt6HExf', decision: 'posted', targetRpid: 318012908193, round: '2026-10-29T01:37:05.000Z' },
  { bvid: 'BV1dHHP6FErS', decision: 'skipped', round: '2026-10-29T01:37:05.000Z' },
]
const fakeBackfillScans = candidatesAll.filter((x) => seenScanKeys.has(scanKey(x)))
if (!fakeBackfillScans.length) {
  console.log('⏭  本机账本里没有这两条原始扫描（样本缺失，跳过去重回归）')
} else {
  const fresh = dedupeScans(existingScans, fakeBackfillScans, '2026-10-29T01:37:05.000Z')
  console.log(fresh.length === 0
    ? `✅ 失败轮回填的 ${fakeBackfillScans.length} 条重复扫描被全局去重拦住（旧实现会整套再抄一遍）`
    : `❌ 仍有 ${fresh.length} 条重复扫描漏过: ${JSON.stringify(fresh.map((x) => [x.bvid, x.decision]))}`)
}

// 4) round id 双源检查：账本里同一轮的 round 值种类
const rounds29 = new Set(ledger.filter((e) => String(e.round || '').startsWith('2026-10-29T03:14')).map((e) => e.round))
console.log(`\n03:14 轮出现过的 round 值: ${[...rounds29].join(' | ') || '（无）'}`)
console.log(rounds29.size > 1 ? '（这就是修复前的双源现场；env 注入后新轮不会再出现）' : '（单源正常）')
