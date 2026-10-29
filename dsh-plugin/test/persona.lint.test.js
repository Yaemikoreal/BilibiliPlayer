// dsh-plugin/test/persona.lint.test.js
// W2-2 质量门：L1–L7 判据（JS 是唯一事实来源）、规则导出脚本、Python 侧哑执行。
//
// 三条纪律：
//   1. 家目录隔离：规则文件全部落在 mkdtemp 出来的 BILI_FENSHEN_HOME，不碰真实 ~/.dsh/bili-fenshen；
//   2. Python 侧用子进程跑 mcp_server.py 的纯函数 _lint_precheck（发布前置校验本身），不联网、不发评论；
//   3. 没有可用 Python/依赖时只 skip Python 那几条，JS 判据照常全跑。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const REPO_ROOT = resolve(PLUGIN_DIR, '..')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-lint-'))

const home = () => process.env.BILI_FENSHEN_HOME

const {
  buildLintRules, lintComment, LINT_SPEC, DEFAULT_LIMITS, HUMAN_BASELINE,
} = await import('../lib/persona/lint.js')
const { looksCopied } = await import('../lib/persona/expression.js')

const whale = JSON.parse(readFileSync(join(PLUGIN_DIR, 'prompts', 'persona', 'whale.card.json'), 'utf8'))

// 小语料库：active 两条 + candidate 一条（candidate 不该参与反抄比对）
const bank = {
  spec: 'bili-fenshen.expression-bank/v1',
  buckets: {
    reaction: [{ id: 'r1', text: '史味的巧克力', form: 'reaction', status: 'active', len: 6, heat: 0, source: '测试' }],
    question: [{ id: 'q1', text: '能不能分析一下为什么都是坏在同一个位置？', form: 'question', status: 'active', len: 23, heat: 0, source: '测试' }],
    meme: [{ id: 'm1', text: '电子榨菜', form: 'meme', status: 'candidate', len: 4, heat: 0, source: '测试' }],
  },
}

const lint = (text, mode = 'comment', extra = {}) => lintComment({ text, mode, card: whale, bank, ...extra })

const extraHomes = []
const mkHome = (prefix = 'bf-lint-extra-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  extraHomes.push(dir)
  return dir
}

after(() => {
  for (const dir of [home(), ...extraHomes]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
  }
})

/* ───────────────────────── L1 落点：收尾不得是空泛捧场 ───────────────────────── */

test('L1 落点：收尾「太强了」→ block', () => {
  const r = lint('看完只想说一句：太强了！')
  assert.equal(r.ok, false)
  assert.equal(r.level, 'block')
  assert.deepEqual(r.codes, ['L1'])
  assert.match(r.reasons[0], /空泛捧场「太强了」/)
  assert.ok(r.advice.length > 0, '拦截必须带可读建议')
})

test('L1 落点：收尾是具体细节 → 通过', () => {
  const r = lint('这操作我回去照着试了一遍，锅烧糊了')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.level, 'warn') // 通过时 level 没有更高级别可报
  assert.deepEqual(r.codes, [])
  assert.equal(r.advice, '')
})

/* ───────────────────────── L2 自足：首句不得以指代开手 ───────────────────────── */

test('L2 自足：首句「这个」开手 → warn', () => {
  const r = lint('这个连招我练了三天还是不行')
  assert.equal(r.ok, false)
  assert.equal(r.level, 'warn')
  assert.ok(r.codes.includes('L2'), JSON.stringify(r.codes))
  assert.match(r.reasons[0], /指代「这个」/)
})

test('L2 自足：首句先给名词 → 通过', () => {
  const r = lint('视频里这个连招我练了三天还是不行')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── L3 再创作：整句引号包裹 ───────────────────────── */

test('L3 再创作：整句引号包裹且 ≥8 字 → warn', () => {
  const r = lint('「我看完这个视频直接笑出声」')
  assert.equal(r.ok, false)
  assert.ok(r.codes.includes('L3'), JSON.stringify(r.codes))
  assert.match(r.reasons[0], /12 字/)
})

test('L3 再创作：引号内太短 → 通过', () => {
  const r = lint('「笑出声」')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── L4 反抄：与 active 语料重合 ───────────────────────── */

test('L4 反抄：与 active 条目的 2-gram 重合 >0.6 → block（真接 looksCopied）', () => {
  assert.equal(looksCopied('史味的巧克力', bank), true, '前置：expression.js 的 looksCopied 判定为抄')
  const r = lint('史味的巧克力')
  assert.equal(r.ok, false)
  assert.equal(r.level, 'block')
  assert.ok(r.codes.includes('L4'), JSON.stringify(r.codes))
  assert.match(r.reasons[0], /重合（上限 0\.60）/)
})

test('L4 反抄：candidate 条目不算（只比 active）', () => {
  const r = lint('电子榨菜')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(!buildLintRules({ card: whale, bank }).bank.active.includes('电子榨菜'))
})

test('L4 反抄：无关文本 → 通过', () => {
  const r = lint('今天的饭煮得有点硬，锅背锅')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── L5 形态 ───────────────────────── */

test('L5a 形态：reply 超过 40 字 → warn', () => {
  const text = '今天下班顺路买了半只烧鸡，回家路上没忍住站在楼下啃了两个鸡腿，油都蹭到袖子上了真的'
  const r = lint(text, 'reply')
  assert.equal(r.ok, false)
  assert.ok(r.codes.includes('L5a'), JSON.stringify(r.codes))
  assert.match(r.reasons[0], /reply 上限 40/)
})

test('L5a 形态：reply 未超上限 → 通过', () => {
  const r = lint('这饭我吃了三碗', 'reply')
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('L5b 形态：句号 > 上限（periodMax=0 ⇒ 任何句号都点名）→ warn', () => {
  const r = lint('我去了。饭没了。锅还在')
  assert.equal(r.ok, false)
  assert.deepEqual(r.codes, ['L5b'])
  assert.match(r.reasons[0], /句号 2 个（上限 0）/)
  // §2.4.3：advice 不再引用"真人句号率"，改成风格规定（{count}/{max} 由解释器渲染）
  assert.match(r.advice, /本号规定不使用句号：换行或表情结句更有口气。/)
  assert.ok(!/真人句号率/.test(r.advice), 'advice 不许再教模型假分布')
})

test('L5b 形态：句号 = 0 → 通过', () => {
  const r = lint('我去了饭没了锅还在')
  assert.equal(r.ok, true, JSON.stringify(r))
})

test('L5c 形态：表情数超过 card.voice.emoji.perComment → warn', () => {
  const r = lint('好吃[doge][doge]')
  assert.equal(r.ok, false)
  assert.deepEqual(r.codes, ['L5c'])
  assert.match(r.reasons[0], /表情 2 个（上限 1）/)
})

test('L5c 形态：表情数在上限内 → 通过', () => {
  const r = lint('好吃[doge]')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── L6 红线 ───────────────────────── */

test('L6 红线：policy:politics 词表命中 → block', () => {
  const r = lint('这届选举真热闹')
  assert.equal(r.ok, false)
  assert.equal(r.level, 'block')
  assert.deepEqual(r.codes, ['L6:no-politics'])
  assert.match(r.reasons[0], /命中红线「选举」/)
  assert.match(r.advice, /换成：/, '红线必须给正向替代动作（instead）')
})

test('L6 红线：不命中 → 通过', () => {
  const r = lint('这游戏打得我血压高')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── L7 禁用词 ───────────────────────── */

test('L7 禁用词：voice.avoid.aiCues 命中 → block', () => {
  const r = lint('作为一个观众，我看完直接笑出声')
  assert.equal(r.ok, false)
  assert.deepEqual(r.codes, ['L7:aiCues'])
  assert.match(r.reasons[0], /禁用词「作为一个」/)
})

test('L7 禁用词：不命中 → 通过', () => {
  const r = lint('我看完直接笑出声')
  assert.equal(r.ok, true, JSON.stringify(r))
})

/* ───────────────────────── 规则：单一事实来源 + 导出脚本 ───────────────────────── */

test('buildLintRules：判据 / 上限 / 全量基线 / venues 档位 / active 语料全部由 JS 产出', () => {
  const rules = buildLintRules({ card: whale, bank })
  assert.equal(rules.spec, LINT_SPEC)
  assert.equal(rules.mode, 'warn', '默认先 warn 三天（§6.3）')
  assert.deepEqual(rules.limits, { comment: 60, reply: 40, dynamic: 60 })
  // §2.4 决策 A：venues 三档进规则文件（数值 max），Python 质量门据此按档执行
  assert.deepEqual(rules.venueLimits, { '生态区': 40, 'AI话题区': 50, '普通区': 35 })
  assert.equal(rules.venueDefault, '普通区')
  const codes = rules.checks.map((c) => c.code)
  for (const code of ['L1', 'L2', 'L3', 'L4', 'L5a', 'L5b', 'L5c', 'L6:no-politics', 'L7:aiCues', 'L7:bookish', 'L7:bannedWords']) {
    assert.ok(codes.includes(code), `缺判据 ${code}：${codes.join(',')}`)
  }
  // 2026-10-29 核验 §2.2-B：基线锁字面量（旧断言拿 HUMAN_BASELINE 跟自己比，恒真无保护）
  assert.equal(rules.baseline.comments, 52464)
  assert.equal(rules.baseline.medianChars, 19)
  assert.equal(rules.baseline.periodRate, 0.1704)
  assert.equal(rules.baseline.questionRate, 0.0742)
  assert.equal(rules.baseline.emojiRate, 0.3139)
  assert.match(rules.baseline.note, /charLen/)
  assert.equal(rules.bank.count, 2, '只有 active 进规则文件')
  assert.equal(buildLintRules({ card: whale, mode: 'blok' }).mode, 'warn', '坏档位降级 warn，不擅自拦')
})

test('venues 档位：同一句话在普通区/生态区取得不同 maxChars（§2.4.4 验收）', () => {
  // 39 字：普通区（35）超限，生态区（40）/ AI话题区（50）通过；42 字 reply 不受档位影响
  const t39 = '今天下班顺路买了半只烧鸡，回家路上没忍住站在楼下啃了两个鸡腿，油都蹭到袖子上了'
  assert.equal([...t39].length, 39)
  const t42 = t39 + '真的'
  assert.equal([...t42].length, 41)

  const normal = lintComment({ text: t39, mode: 'comment', card: whale, bank: null })
  assert.ok(normal.codes.includes('L5a'), `普通区 35 应拦 39 字：${JSON.stringify(normal)}`)
  assert.match(normal.reasons[0], /comment 上限 35/)
  const eco = lintComment({ text: t39, mode: 'comment', venue: '生态区', card: whale, bank: null })
  assert.equal(eco.ok, true, `生态区 40 应放行 39 字：${JSON.stringify(eco)}`)
  const ai = lintComment({ text: t39, mode: 'comment', venue: 'AI话题区', card: whale, bank: null })
  assert.equal(ai.ok, true, `AI话题区 50 应放行 39 字：${JSON.stringify(ai)}`)
  // 未传 venue ⇒ 默认档（普通区 35）；楼中楼不按档（保持 reply 40）
  const def = lintComment({ text: t39, mode: 'comment', card: whale, bank: null })
  assert.ok(def.codes.includes('L5a'))
  const reply = lintComment({ text: t42, mode: 'reply', venue: 'AI话题区', card: whale, bank: null })
  assert.ok(reply.codes.includes('L5a'), 'reply 场域不受 venue 档位影响')
})

test('lintComment 从 rules 读场域上限（不硬编第二份）', () => {
  const rules = buildLintRules({ card: whale })
  rules.limits.reply = 10
  const text = '这碗饭我一口气吃了三碗' // charLen 11
  const tight = lintComment({ text, mode: 'reply', rules })
  assert.ok(tight.codes.includes('L5a'), JSON.stringify(tight.codes))
  const normal = lintComment({ text, mode: 'reply', card: whale, bank: null })
  assert.equal(normal.ok, true, '卡里的 reply 上限 40 时这条不该超')
})

test('导出脚本：默认 mode=warn、重导保留已改档位、--mode 显式覆盖', () => {
  const exportHome = mkHome('bf-lint-export-')
  const run = (args = []) => spawnSync(
    process.execPath,
    [join(PLUGIN_DIR, 'scripts', 'export-lint-rules.mjs'), ...args],
    { cwd: PLUGIN_DIR, encoding: 'utf8', env: { ...process.env, BILI_FENSHEN_HOME: exportHome } },
  )
  const file = join(exportHome, 'persona', 'lint-rules.json')

  let r = run()
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.ok(existsSync(file), '规则文件应写到家目录 persona/')

  const first = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(first.spec, LINT_SPEC)
  assert.equal(first.mode, 'warn')
  assert.deepEqual(first.limits, { comment: 60, reply: 40, dynamic: 60 }, '场域上限取自卡（60/40/60），不是缺省 100')
  assert.equal(first.venueDefault, '普通区', 'venues 默认档随规则文件导出')
  assert.equal(first.card.id, 'whale')
  assert.equal(first.baseline.comments, 52464)
  assert.ok(first.checks.some((c) => c.code === 'L1'))
  assert.ok(first.checks.some((c) => c.code === 'L6:no-politics'))
  assert.ok(first.bank.count > 0, '语料 active 要带上给 Python 反抄用')

  // 用户手动把档位切到 block：重导不许覆盖回 warn
  first.mode = 'block'
  writeFileSync(file, JSON.stringify(first, null, 2), 'utf8')
  r = run()
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mode, 'block')

  // 一键回滚
  r = run(['--mode', 'off'])
  assert.equal(r.status, 0, r.stderr || r.stdout)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mode, 'off')

  // 坏档位直接失败，不写半截
  r = run(['--mode', 'nope'])
  assert.equal(r.status, 1)
})

/* ───────────────────────── Python 侧：只读文件、哑执行 ───────────────────────── */

/** 找一个能 import bilibili_api / mcp 的 Python（仓库 .venv 优先）；找不到就 skip。 */
const PYTHON = (() => {
  const candidates = [
    process.env.BILI_PYTHON,
    join(REPO_ROOT, '.venv', 'Scripts', 'python.exe'),
    join(REPO_ROOT, '.venv', 'bin', 'python'),
    'python',
    'python3',
  ].filter(Boolean)
  for (const bin of candidates) {
    if ((bin.includes('/') || bin.includes('\\')) && !existsSync(bin)) continue
    // 只查依赖是否装好（find_spec 不真正 import，省掉 2s+ 的导入开销）
    const probe = spawnSync(bin, ['-c', "import importlib.util as u, sys; sys.exit(0 if u.find_spec('bilibili_api') and u.find_spec('mcp') else 1)"], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
    })
    if (probe.status === 0) return bin
  }
  return ''
})()

/** 一个场景 = 一份规则文件 + 一组待校验文本；Python 侧按顺序铺好规则文件再逐条跑。 */
const pythonScenarios = () => {
  const bareHome = mkHome('bf-lint-bare-')
  const mainHome = home()
  const rules = {
    block: buildLintRules({ card: whale, bank, mode: 'block' }),
    warn: buildLintRules({ card: whale, bank, mode: 'warn' }),
    off: buildLintRules({ card: whale, bank, mode: 'off' }),
  }
  const L1_TEXT = '看完只想说一句：太强了！'
  const CLEAN_TEXT = '这操作我回去照着试了一遍，锅烧糊了'
  const crossCases = [
    { text: L1_TEXT, mode: 'comment' },
    { text: '这个连招我练了三天还是不行', mode: 'comment' },
    { text: '「我看完这个视频直接笑出声」', mode: 'comment' },
    { text: '史味的巧克力', mode: 'comment' },
    { text: '今天下班顺路买了半只烧鸡，回家路上没忍住站在楼下啃了两个鸡腿，油都蹭到袖子上了真的', mode: 'reply' },
    { text: '我去了。饭没了。锅还在', mode: 'comment' },
    { text: '好吃[doge][doge]', mode: 'comment' },
    { text: '这届选举真热闹', mode: 'comment' },
    { text: '作为一个观众，我看完直接笑出声', mode: 'comment' },
    { text: CLEAN_TEXT, mode: 'comment' },
  ]
  return {
    rules,
    crossCases,
    specs: [
      { home: bareHome, rules: null, cases: [{ text: L1_TEXT, mode: 'comment' }] }, // 规则文件缺失
      { home: mainHome, rules: rules.block, cases: [{ text: L1_TEXT, mode: 'comment' }, { text: CLEAN_TEXT, mode: 'comment' }] },
      { home: mainHome, rules: rules.warn, cases: [{ text: L1_TEXT, mode: 'comment' }] },
      { home: mainHome, rules: rules.off, cases: [{ text: L1_TEXT, mode: 'comment' }] },
      { home: mainHome, rules: rules.warn, cases: crossCases }, // 跨语言一致性
    ],
  }
}

/**
 * 只起一次 Python 子进程：导入 mcp_server（bilibili_api + FastMCP）要 ~2.5s，
 * 五组断言合并成一次探针，npm test 不至于被拖慢十倍。探针只调纯函数 _lint_precheck，不联网。
 */
const pythonProbe = (() => {
  let cached = null
  return () => {
    if (cached) return cached
    if (!PYTHON) return null
    const dir = mkHome('bf-lint-probe-')
    const scenarioFile = join(dir, 'lint-scenarios.json')
    const scriptFile = join(dir, 'lint-probe.py')
    const scenario = pythonScenarios()
    writeFileSync(scenarioFile, JSON.stringify(scenario.specs), 'utf8')
    const script = [
      'import json, os, sys',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
      'import mcp_server as m',
      `specs = json.load(open(${JSON.stringify(scenarioFile)}, encoding="utf-8"))`,
      'out = []',
      'for spec in specs:',
      '    home_dir = Path(spec["home"])',
      '    rules_path = home_dir / "persona" / "lint-rules.json"',
      '    rules = spec.get("rules")',
      '    if rules is None:',
      '        if rules_path.exists():',
      '            rules_path.unlink()',
      '    else:',
      '        rules_path.parent.mkdir(parents=True, exist_ok=True)',
      '        rules_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")',
      '    os.environ["BILI_FENSHEN_HOME"] = str(home_dir)',
      '    out.append([m._lint_precheck(c.get("text", ""), c.get("mode", "comment")) for c in spec.get("cases") or []])',
      'print("RESULT:" + json.dumps(out, ensure_ascii=False))',
      '',
    ].join('\n')
    writeFileSync(scriptFile, script, 'utf8')
    const res = spawnSync(PYTHON, [scriptFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env, BILI_FENSHEN_HOME: home(), PYTHONIOENCODING: 'utf-8' },
    })
    assert.equal(res.status, 0, `python 探针退出码 ${res.status}：${res.stderr || ''}`)
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(line, `python 探针没有输出 RESULT 行：${res.stdout}${res.stderr}`)
    cached = {
      payloads: JSON.parse(line.slice('RESULT:'.length)),
      rules: scenario.rules,
      crossCases: scenario.crossCases,
      stderr: String(res.stderr || ''),
    }
    return cached
  }
})()

const needPython = (t) => {
  if (PYTHON) return true
  t.skip('本机没有可用的 Python + bilibili_api/mcp 依赖，跳过哑执行断言')
  return false
}

test('Python 侧：规则文件缺失 → 放行 + 告警（绝不因规则坏了全线停摆）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const r = probe.payloads[0][0]
  assert.equal(r.blocked, false, '规则文件缺失必须放行')
  assert.equal(r.payload, null)
  assert.match(r.notice, /lint 规则不可用/)
  assert.match(r.notice, /lint-rules\.json/)
  assert.match(probe.stderr, /质量门规则不可用/, '放行同时要留告警日志')
})

test('Python 侧：mode=block 时 L1「太强了」被拦，返回 LINT_BLOCKED', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const blocked = probe.payloads[1][0]
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.payload.code, 'LINT_BLOCKED')
  assert.equal(blocked.payload.ok, false)
  assert.ok(blocked.payload.codes.includes('L1'), JSON.stringify(blocked.payload.codes))
  assert.match(blocked.payload.reasons[0], /太强了/)
  assert.match(blocked.payload.error, /质量门拦截/)
  assert.match(probe.stderr, /质量门拦截/)
  assert.equal(probe.payloads[1][1].blocked, false, '正常评论不该被误杀')
})

test('Python 侧：mode=warn → 照发，但回执里带 lint 告警', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const r = probe.payloads[2][0]
  assert.equal(r.blocked, false)
  assert.ok(r.warn, 'warn 档要把"本该被拦"的判据回给模型')
  assert.ok(r.warn.codes.includes('L1'))
  assert.match(probe.stderr, /质量门告警/)
})

test('Python 侧：mode=off → 一键回滚，不评估不告警', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe().payloads[3][0]
  assert.deepEqual(r, { blocked: false, payload: null, warn: null, notice: '' })
})

test('跨语言一致：同一份规则文件下 JS lintComment 与 Python 哑执行判定相同', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const expected = probe.crossCases.map((c) => lintComment({ text: c.text, mode: c.mode, card: whale, rules: probe.rules.warn }))
  const actual = probe.payloads[4].map((r) => ({
    ok: r.warn === null,
    level: r.warn ? r.warn.level : 'warn',
    codes: r.warn ? r.warn.codes : [],
    reasons: r.warn ? r.warn.reasons : [],
    advice: r.warn ? r.warn.advice : '',
  }))
  assert.deepEqual(actual, expected, 'JS 与 Python 的判定/理由必须逐字一致')
})
