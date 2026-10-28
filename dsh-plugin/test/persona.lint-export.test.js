// dsh-plugin/test/persona.lint-export.test.js
// W2-2 收尾：卡 / 语料库一改就重导 `<home>/persona/lint-rules.json`（§6.3-3 / §8.1 / §13.4-2）。
//
// 三条纪律：
//   1. 家目录隔离：每个用例 mkdtemp 一个 BILI_FENSHEN_HOME，绝不碰真实 ~/.dsh/bili-fenshen；
//   2. "保留 mode" 用**真实文件**验证：先把规则文件里的 mode 手切成 block，再保存卡，看它有没有被覆盖回 warn；
//   3. "写盘失败不拖垮保存"用**可靠手法**造：把 `<home>/persona/lint-rules.json` 做成一个**目录**——
//      tmp 文件写得进去、rename 一定失败，而 card.json / versions / active.json 全不受影响，
//      正好只坏"规则导出"这一步（不依赖只读权限等平台差异）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const SCRIPT = join(PLUGIN_DIR, 'scripts', 'export-lint-rules.mjs')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-lint-export-'))

const {
  savePersonaCard, editExpressionBank, loadCard, readActive,
} = await import('../lib/persona/index.js')
const { personaDir } = await import('../lib/persona/store.js')
const { LINT_SPEC } = await import('../lib/persona/lint.js')

const whale = JSON.parse(readFileSync(join(PLUGIN_DIR, 'prompts', 'persona', 'whale.card.json'), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))
const rulesFile = () => join(personaDir(), 'lint-rules.json')
const readRules = () => JSON.parse(readFileSync(rulesFile(), 'utf8'))

const homes = [process.env.BILI_FENSHEN_HOME]
/** 每个用例一个干净家目录；store.homeDir() 每次调用都读 env，所以运行中切换是安全的。 */
const mkHome = (prefix = 'bf-lint-export-case-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  homes.push(dir)
  process.env.BILI_FENSHEN_HOME = dir
  return dir
}

after(() => {
  for (const dir of homes) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
  }
})

/* ───────────────────────── 保存卡 → 自动重导 ───────────────────────── */

test('保存卡 → 规则文件生成：默认 warn、场域上限 100/40/60 取自卡、voice.avoid 进词表', () => {
  const home = mkHome()
  const out = savePersonaCard(clone(whale))

  // 原有返回字段一个不少（只加不改）
  assert.equal(out.ok, true, JSON.stringify(out.errors))
  assert.ok(out.snapshot, '原有字段：版本快照仍要返回')

  const lr = out.lintRules
  assert.ok(lr, '返回体要加 lintRules')
  assert.equal(lr.ok, true, lr.error)
  assert.equal(lr.written, true)
  assert.equal(lr.path, join(home, 'persona', 'lint-rules.json'))
  assert.equal(lr.path, rulesFile())
  assert.equal(lr.mode, 'warn')
  assert.equal(lr.version, LINT_SPEC)

  assert.ok(existsSync(lr.path), '规则文件应落盘')
  const rules = readRules()
  assert.equal(rules.spec, LINT_SPEC)
  assert.equal(rules.mode, 'warn', '默认先 warn（§6.3-2）')
  assert.equal(rules.card.id, 'whale')
  assert.deepEqual(rules.limits, { comment: 100, reply: 40, dynamic: 60 })

  const banned = rules.checks.find((c) => c.code === 'L7:bannedWords')
  assert.ok(banned, 'voice.avoid.bannedWords 要进词表')
  for (const w of whale.voice.avoid.bannedWords) {
    assert.ok(banned.words.includes(w), `禁用词「${w}」没进规则文件`)
  }
  const aiCues = rules.checks.find((c) => c.code === 'L7:aiCues')
  assert.ok(aiCues.words.includes('作为一个'))
})

test('保留人工档位：文件里 mode 改成 block 后再保存卡 → 仍是 block（不被重导覆盖回 warn）', () => {
  mkHome()
  assert.equal(savePersonaCard(clone(whale)).lintRules.ok, true, '前置：先生成一份 warn')

  const file = rulesFile()
  const first = readRules()
  assert.equal(first.mode, 'warn')
  first.mode = 'block' // 模拟用户按 §12.5 观察三天后手切 block
  writeFileSync(file, JSON.stringify(first, null, 2), 'utf8')

  const out = savePersonaCard(clone(whale))
  assert.equal(out.ok, true)
  assert.equal(out.lintRules.ok, true, out.lintRules.error)
  assert.equal(out.lintRules.mode, 'block', '返回体要报实际生效档位')
  assert.equal(readRules().mode, 'block', 'block 必须保留：重导不许把人工档位打回 warn')
  assert.equal(readRules().checks.length, first.checks.length, '除 mode 外其它字段照常重导')
})

test('卡一改就重导：改 voice.avoid.bannedWords / voice.modes 后规则文件跟着变', () => {
  mkHome()
  assert.equal(savePersonaCard(clone(whale)).lintRules.ok, true)
  const before = readRules()
  assert.ok(!before.checks.find((c) => c.code === 'L7:bannedWords').words.includes('锅巴脆'))

  const card = clone(whale)
  card.voice.avoid.bannedWords = [...card.voice.avoid.bannedWords, '锅巴脆']
  card.voice.modes.reply = { maxChars: 30 } // 场域上限也由卡决定
  const out = savePersonaCard(card)
  assert.equal(out.ok, true, JSON.stringify(out.errors))
  assert.equal(out.lintRules.ok, true, out.lintRules.error)

  const after_ = readRules()
  const banned = after_.checks.find((c) => c.code === 'L7:bannedWords')
  assert.ok(banned.words.includes('锅巴脆'), '卡里新加的禁用词必须进规则文件（不能还用旧词表）')
  assert.equal(after_.limits.reply, 30, '卡改场域上限 → 规则文件同步')
  assert.equal(after_.mode, 'warn')
})

/* ───────────────────────── 语料库 → 自动重导 ───────────────────────── */

test('语料库一改就重导：add 一条 → bank.active 含它；软删后重导不再含它', () => {
  const home = mkHome()
  const text = '隔着屏幕都闻到厨房那股焦味了'
  const out = editExpressionBank({ action: 'add', form: 'detail', text, source: '测试语料' })

  assert.equal(out.ok, true, out.error)
  // 原有字段一个不少（只加不改）
  assert.equal(out.total, out.buckets.detail.length + out.buckets.reaction.length
    + out.buckets.question.length + out.buckets.experience.length
    + out.buckets.meme.length + out.buckets.rant.length)
  assert.equal(out.materialized, true)

  const lr = out.lintRules
  assert.ok(lr, '返回体要加 lintRules')
  assert.equal(lr.ok, true, lr.error)
  assert.equal(lr.path, join(home, 'persona', 'lint-rules.json'))
  assert.equal(lr.mode, 'warn')

  const rules = readRules()
  assert.ok(rules.bank.active.includes(text), 'bank.active 是 L4 反抄快照的输入，新条目必须进去')
  assert.ok(rules.bank.count >= 1)

  // 软删除（remove）之后重导：active 快照不该还留着它（L4 不能拿已摘出教学池的条目录比）
  const entry = out.buckets.detail.find((e) => e.text === text)
  assert.ok(entry, '前置：新条目应能读回')
  const rm = editExpressionBank({ action: 'remove', form: 'detail', id: entry.id })
  assert.equal(rm.ok, true, rm.error)
  assert.equal(rm.lintRules.ok, true, rm.lintRules.error)
  assert.ok(!readRules().bank.active.includes(text), '软删除条目不该留在规则文件的 active 快照里')
})

/* ───────────────────────── 路径跟随 BILI_FENSHEN_HOME ───────────────────────── */

test('规则文件路径始终是 <home>/persona/lint-rules.json（跟随 BILI_FENSHEN_HOME）', () => {
  const homeA = mkHome()
  const outA = savePersonaCard(clone(whale))
  const homeB = mkHome()
  const outB = savePersonaCard(clone(whale))

  assert.notEqual(homeA, homeB)
  assert.equal(outA.lintRules.path, join(homeA, 'persona', 'lint-rules.json'))
  assert.equal(outB.lintRules.path, join(homeB, 'persona', 'lint-rules.json'))
  assert.ok(existsSync(join(homeA, 'persona', 'lint-rules.json')))
  assert.ok(existsSync(join(homeB, 'persona', 'lint-rules.json')))
  // 第二份导出没有跑去第一份家目录
  assert.equal(outB.lintRules.path.startsWith(homeA), false)
})

/* ───────────────────────── 失败不拖垮保存（§6.3-1） ───────────────────────── */

test('保存卡时规则写盘失败：saved.ok 仍 true，lintRules.ok=false 且带原因', () => {
  const home = mkHome()
  // 造法：<home>/persona/lint-rules.json 先做成一个**目录** → tmp 能写、rename 必失败；
  // card.json / versions / active.json 全不受影响，正好只坏"规则导出"这一步。
  const blocker = join(home, 'persona', 'lint-rules.json')
  mkdirSync(blocker, { recursive: true })

  const out = savePersonaCard(clone(whale))

  assert.equal(out.ok, true, '规则写不出来绝不能让保存卡失败（§6.3-1 绝不因规则坏了全线停摆）')
  assert.ok(out.snapshot, '原有字段照旧')
  const lr = out.lintRules
  assert.equal(lr.ok, false)
  assert.equal(lr.written, false)
  assert.equal(lr.path, blocker)
  assert.equal(lr.mode, 'warn', '失败时也要报"本来要用"的档位')
  assert.equal(lr.version, LINT_SPEC)
  assert.equal(typeof lr.error, 'string')
  assert.ok(lr.error.length > 0, '失败必须带原因')

  // 卡确实保存成功了：active 切到 file、card.json 可读回
  assert.equal(readActive().mode, 'file')
  assert.equal(loadCard().card.id, 'whale')
  assert.ok(existsSync(join(home, 'persona', 'card.json')))
  assert.ok(existsSync(blocker), '挡住的那层目录还在（没被删）')
  assert.deepEqual(
    readdirSync(join(home, 'persona')).filter((f) => f.includes('.tmp')),
    [],
    '失败路径要清掉半截 tmp 文件，不留垃圾',
  )
})

test('语料库保存成功后规则写盘失败：out.ok 仍 true，lintRules.ok=false（不影响语料库本身）', () => {
  mkHome()
  const first = editExpressionBank({ action: 'add', form: 'detail', text: '第一条先让规则文件正常生成' })
  assert.equal(first.ok, true)
  assert.equal(first.lintRules.ok, true)

  // 把规则文件换成目录，只让下一次导出失败
  const blocker = rulesFile()
  rmSync(blocker, { force: true })
  mkdirSync(blocker, { recursive: true })

  const text = '第二条用来验证导出失败不影响保存'
  const out = editExpressionBank({ action: 'add', form: 'detail', text })
  assert.equal(out.ok, true, '规则写不出来不能拖垮语料库保存')
  assert.equal(out.lintRules.ok, false)
  assert.equal(out.lintRules.written, false)
  assert.ok(out.lintRules.error.length > 0)
  // 语料库本身确实写进去了
  const bank = JSON.parse(readFileSync(join(personaDir(), 'expression-bank.json'), 'utf8'))
  assert.ok(bank.buckets.detail.some((e) => e.text === text), '语料库保存不受影响')
})

/* ───────────────────────── 门面 vs 既有导出脚本：同一口径 ───────────────────────── */

test('门面导出与 scripts/export-lint-rules.mjs 一致（同一输入 → 除 generatedAt 外逐字段相同）', () => {
  const home = mkHome()
  // 先造一个非空语料库，再让门面写一次规则：这样"门面读到的东西"和"脚本读到的东西"都有内容可对
  assert.equal(editExpressionBank({ action: 'add', form: 'detail', text: '两边要读同一个库' }).ok, true)
  const saved = savePersonaCard(clone(whale))
  assert.equal(saved.lintRules.ok, true, saved.lintRules.error)

  const runScript = () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--quiet'], {
      cwd: PLUGIN_DIR,
      encoding: 'utf8',
      env: { ...process.env, BILI_FENSHEN_HOME: home },
    })
    assert.equal(r.status, 0, r.stderr || r.stdout)
  }
  // generatedAt 是落盘时刻，天然不同；它是唯一允许不同的字段（口径字段必须逐字一致）。
  const strip = (rules) => {
    const x = clone(rules)
    delete x.generatedAt
    return x
  }

  const facade = readRules()
  assert.ok(facade.bank.count > 0, '前置：语料快照非空，一致性才有意义')
  runScript()
  const scripted = readRules()
  assert.deepEqual(strip(scripted), strip(facade), '门面必须对齐既有导出脚本（脚本是验收口径）')
  assert.equal(scripted.mode, facade.mode)

  // mode 保留逻辑也要两边一致：手切 block → 门面保存 → 脚本再跑一遍，仍是 block 且其它字段仍相同
  const blocked = readRules()
  blocked.mode = 'block'
  writeFileSync(rulesFile(), JSON.stringify(blocked, null, 2), 'utf8')
  const saved2 = savePersonaCard(clone(whale))
  assert.equal(saved2.lintRules.mode, 'block')
  const facade2 = readRules()
  runScript()
  const scripted2 = readRules()
  assert.equal(scripted2.mode, 'block')
  assert.deepEqual(strip(scripted2), strip(facade2))
})

/* ───────────────────────── 原行为不变：失败路径不多写、不多报 ───────────────────────── */

test('保存卡校验失败：行为不变（ok=false），不写规则文件、也不加 lintRules 字段', () => {
  const home = mkHome()
  const out = savePersonaCard({ id: '', version: '' })
  assert.equal(out.ok, false)
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0, '校验失败仍要回 errors')
  assert.equal(out.lintRules, undefined, '保存没成功就不该假装重导')
  assert.ok(!existsSync(join(home, 'persona', 'lint-rules.json')), '失败路径不写规则文件')
})

test('语料库非法输入：行为不变（ok=false），不重导', () => {
  const home = mkHome()
  const out = editExpressionBank({ action: 'wat', form: 'meme' })
  assert.equal(out.ok, false)
  assert.match(out.error, /action 必须是/)
  assert.equal(out.lintRules, undefined)
  assert.ok(!existsSync(join(home, 'persona', 'lint-rules.json')))
})
