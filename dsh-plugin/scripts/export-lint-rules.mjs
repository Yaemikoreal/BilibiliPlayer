#!/usr/bin/env node
/**
 * 质量门规则导出（W2-2）：把 `lib/persona/lint.js` 的声明式规则写到
 * `<家目录>/persona/lint-rules.json`，供 `mcp_server.py` 发布前哑执行。
 *
 * 为什么要有这一步（计划 §6.3）：
 *   - 规则只在 JS（人设卡、场域上限、247 基线都在宿主这一侧），Python 只读该文件，
 *     **不复制规则**；卡一改就重导，两边永远不会各说各话。
 *   - `mode` 是质量门的总开关：`off` 一键回滚 / `warn` 先跑三天 / `block` 才真拦。
 *     重导默认**保留文件里已有的 mode**（用户在文件里切了 block 不该被覆盖回 warn），
 *     只有显式 `--mode` 才改它。
 *
 * 用法：
 *   node dsh-plugin/scripts/export-lint-rules.mjs
 *   node dsh-plugin/scripts/export-lint-rules.mjs --mode block
 *   node dsh-plugin/scripts/export-lint-rules.mjs --out <路径> --quiet
 *
 * 家目录解析与 `lib/persona/store.js` 的 `homeDir()` 同源：BILI_FENSHEN_HOME 优先，
 * 否则 `~/.dsh/bili-fenshen`；测试可用 BILI_FENSHEN_HOME 指到临时目录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildLintRules, LINT_SPEC, DEFAULT_ROLLOUT, ROLLOUT_MODES,
} from '../lib/persona/lint.js'
import { loadCard, loadBank, readActive, personaDir } from '../lib/persona/store.js'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? String(argv[i + 1]) : ''
}
const hasFlag = (name) => argv.includes(name)

const outFile = () => argOf('--out') || join(personaDir(), 'lint-rules.json')

/** 读已有规则文件里的 mode（坏文件/缺字段都当没有）；重导默认不覆盖用户的选择。 */
const existingMode = (file) => {
  try {
    if (!existsSync(file)) return ''
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const m = String(raw?.mode ?? '').trim().toLowerCase()
    return ROLLOUT_MODES.includes(m) ? m : ''
  } catch {
    return ''
  }
}

const main = () => {
  const active = readActive()
  const loaded = loadCard(active)
  if (!loaded.card) {
    console.error(`FAIL 读不到生效人设卡（${loaded.source}）：${loaded.error || loaded.path}`)
    process.exitCode = 1
    return
  }
  const card = loaded.card
  const bank = loadBank(active)

  const file = outFile()
  const explicit = argOf('--mode')
  if (explicit && !ROLLOUT_MODES.includes(explicit.toLowerCase())) {
    console.error(`FAIL --mode 只接受 ${ROLLOUT_MODES.join(' / ')}，收到：${explicit}`)
    process.exitCode = 1
    return
  }
  const mode = explicit ? explicit.toLowerCase() : (existingMode(file) || DEFAULT_ROLLOUT)

  const rules = buildLintRules({ card, bank, mode })

  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(rules, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.error(`FAIL 规则写盘失败：${file}（${e?.message ?? e}）`)
    process.exitCode = 1
    return
  }

  if (!hasFlag('--quiet')) {
    const l = rules.limits
    console.log(
      `OK 质量门规则已导出：${file}\n`
      + `   card=${rules.card.id || '(无)'}@${rules.card.version || '?'} mode=${rules.mode}`
      + ` 场域上限 comment=${l.comment}/reply=${l.reply}/dynamic=${l.dynamic}`
      + ` 判据=${rules.checks.length} 条 语料=${rules.bank.count} 条 基线=${rules.baseline.comments} 条`
      + ` spec=${LINT_SPEC}`,
    )
  }
}

try {
  main()
} catch (e) {
  console.error('FAIL 导出失败：' + (e?.stack || e?.message || e))
  process.exitCode = 1
}
