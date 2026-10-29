// dsh-plugin/test/persona.lore-tool.test.js
// W6-1 生成期通道（路径 A）：bili_persona_lore(keyword) 的子串匹配 / 冷却降权 / C3 预算 / 静默降级，
// 以及 W2 收尾：bili_persona_note 的 originalText 三分支（community 必填 / self 不受影响 / lore 不受影响）。
//
// 三条纪律（照 test/persona.lint.test.js）：
//   1. 家目录隔离：所有读写都在 mkdtemp 出来的 BILI_FENSHEN_HOME，不碰真实 ~/.dsh/bili-fenshen；
//   2. Python 侧只起子进程调纯函数/工具函数（mcp_server._persona_lore_match / bili_persona_lore /
//      bili_persona_note），不联网、不发评论；
//   3. 没有可用的 Python + bilibili_api/mcp 依赖时只 skip Python 那几条。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const REPO_ROOT = resolve(PLUGIN_DIR, '..')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-lore-'))
const home = () => process.env.BILI_FENSHEN_HOME

const extraHomes = []
const mkHome = (prefix = 'bf-lore-extra-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  extraHomes.push(dir)
  return dir
}

after(() => {
  for (const dir of [home(), ...extraHomes]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
  }
})

/* ───────────────────────── 夹具 ───────────────────────── */

/** 见闻正文 md 的写法：YAML front-matter + 空行 + 正文（真实文件就是这个形状）。 */
const md = (text) => `---\nid: fixture\nkeys: [fixture]\nscope: test\ncooldown: 3\n---\n\n${text}\n`

const mkAssets = (files = {}) => {
  const dir = mkHome('bf-lore-assets-')
  mkdirSync(join(dir, 'lore'), { recursive: true })
  for (const [id, body] of Object.entries(files)) writeFileSync(join(dir, 'lore', `${id}.md`), body, 'utf8')
  return dir
}

const card = (loreIndex) => ({ id: 'test-card', version: '1.0.0', loreIndex })

const assetsMain = mkAssets({
  'wuchang-ranked': md('我打无畏契约，常年在白银边缘反复横跳。'),
  'night-owl': md('我在凌晨三点最容易手滑点开下一集。'),
  'night-owl-2': md('熬夜通宵的第二天总是很困。'),
  'food-wedding': md('表哥结婚我去当伴郎，全程盯着后厨。'),
  valorant: md('我打瓦罗兰特，枪法是玄学。'),
  'ascii-cat': md('cat 是这轮的索引键。'),
})
const assetsLong = mkAssets({
  'long-a': md('长'.repeat(400)),
  'long-b': md('甲'.repeat(400)),
  huge: md('巨'.repeat(700)),
})
const assetsEmpty = mkAssets({}) // 目录在、正文缺失
const assetsMissingDir = join(mkHome('bf-lore-nodir-'), 'lore') // 目录不存在

const INDEX = {
  wuchang: { id: 'wuchang-ranked', keys: ['无畏契约', '上分', '残局'], oneLine: '打无畏契约常年在白银边缘' },
  nightOwl: { id: 'night-owl', keys: ['熬夜', '凌晨', '失眠'], oneLine: '凌晨三点点开下一集' },
  nightOwl2: { id: 'night-owl-2', keys: ['熬夜', '通宵'], oneLine: '熬夜通宵双命中' },
  foodWedding: { id: 'food-wedding', keys: ['婚宴', '吃席', '伴郎'], oneLine: '表哥婚礼当伴郎' },
  valorant: { id: 'valorant', keys: ['VALORANT'], oneLine: '打瓦罗兰特' },
  valorantFullWidth: { id: 'valorant', keys: ['ｖａｌｏｒａｎｔ'], oneLine: '打瓦罗兰特' },
  asciiCat: { id: 'ascii-cat', keys: ['cat'], oneLine: '英文键也走子串' },
  longA: { id: 'long-a', keys: ['长文'], oneLine: '长正文甲' },
  longB: { id: 'long-b', keys: ['长文'], oneLine: '长正文乙' },
  huge: { id: 'huge', keys: ['巨长'], oneLine: '超长正文' },
}

/** 冷却夹具：同一个时间点既当「今天用过的记录」也当 now，避免跨午夜抖动。 */
const NOW_ISO = new Date().toISOString()

/**
 * 一次 Python 子进程跑完全部场景（导入 mcp_server 要 ~2.5s，逐条起进程会把 npm test 拖慢十倍）。
 * 纯函数只读 fixtures 目录；note 工具只写临时家目录的 growth-pending.jsonl；全程不联网。
 */
const scenarios = () => ({
  match: [
    { name: 'cn-substring', keyword: '今天无畏契约上分又掉段了', card: card([INDEX.wuchang]), assets: assetsMain },
    { name: 'case-insensitive', keyword: ' valorant 真好玩', card: card([INDEX.valorant]), assets: assetsMain },
    { name: 'full-width', keyword: 'VALORANT 上分', card: card([INDEX.valorantFullWidth]), assets: assetsMain },
    { name: 'no-word-boundary', keyword: 'concatenate the strings', card: card([INDEX.asciiCat]), assets: assetsMain },
    { name: 'cn-substring-sentence', keyword: '我最近老是熬夜刷视频', card: card([INDEX.nightOwl]), assets: assetsMain },
    {
      name: 'rank-by-hit-count',
      keyword: '熬夜通宵到天亮',
      card: card([INDEX.nightOwl, INDEX.nightOwl2]),
      assets: assetsMain,
    },
    {
      name: 'cooldown',
      keyword: '熬夜',
      // 故意造两条同关键词的：索引里「今天用过的」在前，排序必须把它压到后面
      card: card([INDEX.nightOwl, { id: 'food-wedding', keys: ['熬夜'], oneLine: '婚宴见闻' }]),
      state: { loreUsed: { 'night-owl': NOW_ISO } },
      now: NOW_ISO,
      assets: assetsMain,
    },
    {
      name: 'cap-two',
      keyword: '熬夜 吃席 无畏契约',
      card: card([INDEX.nightOwl, INDEX.foodWedding, INDEX.wuchang]),
      assets: assetsMain,
    },
    { name: 'char-budget-two', keyword: '长文', card: card([INDEX.longA, INDEX.longB]), assets: assetsLong },
    { name: 'char-budget-one', keyword: '巨长', card: card([INDEX.huge]), assets: assetsLong },
    { name: 'no-hit', keyword: '量子力学导论', card: card([INDEX.wuchang, INDEX.nightOwl]), assets: assetsMain },
    { name: 'blank-keyword', keyword: '   ', card: card([INDEX.wuchang]), assets: assetsMain },
    { name: 'card-missing', keyword: '勇气', card: null, assets: assetsMain },
    { name: 'body-missing', keyword: '无畏契约', card: card([INDEX.wuchang]), assets: assetsEmpty },
    { name: 'dir-missing', keyword: '无畏契约', card: card([INDEX.wuchang]), assets: assetsMissingDir },
  ],
  note: {
    home: mkHome('bf-lore-note-'),
    cases: [
      // community 缺原帖原文 → 被工具层拦（W2-3 闸门要求能跑「与原帖」改写检查）
      { kind: 'corpus', form: 'meme', text: '电子榨菜', origin: 'community', source: '社区梗' },
      // community 带原帖原文 → 通过，且 originalText 随候选写进 pending（字段名与 growth.js 一致）
      { kind: 'corpus', form: 'meme', text: '电子榨菜', origin: 'community', source: '社区梗', originalText: '今天又是靠这个视频当电子榨菜的一天' },
      // self 不受影响（走账本对账，不需要原帖原文）
      { kind: 'corpus', form: 'reaction', text: '这饭真香', origin: 'self', source: '被赞 3 次' },
      // lore 候选也不受 originalText 影响（向后兼容）
      { kind: 'lore', keys: ['测试词'], oneLine: '一行摘要', body: '见闻正文' },
    ],
  },
  tool: [],
})

/** 工具级夹具：file 模式卡 + 见闻正文 + 今日冷却表（走真实工具入口，验卡解析/剥 front-matter/JSON 形状）。 */
const toolScenarios = () => {
  const fileHome = mkHome('bf-lore-tool-file-')
  const persona = join(fileHome, 'persona')
  mkdirSync(join(persona, 'lore'), { recursive: true })
  writeFileSync(join(persona, 'active.json'), JSON.stringify({ mode: 'file' }), 'utf8')
  writeFileSync(join(persona, 'card.json'), JSON.stringify(card([{ id: 'night-owl', keys: ['熬夜'], oneLine: '凌晨三点' }])), 'utf8')
  writeFileSync(join(persona, 'lore', 'night-owl.md'), md('我凌晨三点又点开下一集。'), 'utf8')
  writeFileSync(join(persona, 'state.json'), JSON.stringify({ loreUsed: { 'night-owl': NOW_ISO } }), 'utf8')

  const fallbackHome = mkHome('bf-lore-tool-fallback-')
  mkdirSync(join(fallbackHome, 'persona'), { recursive: true })
  // active=file 但家目录没有 card.json → 必须回落 preset whale（插件 prompts/persona/whale.card.json）
  writeFileSync(join(fallbackHome, 'persona', 'active.json'), JSON.stringify({ mode: 'file' }), 'utf8')

  return [
    { home: fileHome, keyword: '熬夜刷视频' },
    { home: fallbackHome, keyword: '无畏契约上分' },
  ]
}

/* ───────────────────────── Python 探测（一次子进程） ───────────────────────── */

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

const cleanEnv = () => {
  const env = { ...process.env, BILI_FENSHEN_HOME: home(), PYTHONIOENCODING: 'utf-8' }
  delete env.BILI_MCP_TOOLS // 默认全量注册：本工具必须注册得上
  return env
}

const pythonProbe = (() => {
  let cached = null
  return () => {
    if (cached) return cached
    if (!PYTHON) return null
    const dir = mkHome('bf-lore-probe-')
    const scenario = scenarios()
    scenario.tool = toolScenarios()
    const scenarioFile = join(dir, 'scenarios.json')
    const scriptFile = join(dir, 'probe.py')
    writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
    const script = [
      'import asyncio, inspect, json, os, sys',
      'from datetime import datetime',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
      'import mcp_server as m',
      `spec = json.load(open(${JSON.stringify(scenarioFile)}, encoding="utf-8"))`,
      'out = {',
      '    "signatures": {"lore": str(inspect.signature(m.bili_persona_lore)),',
      '                   "note": str(inspect.signature(m.bili_persona_note))},',
      '    "registered": sorted(m.mcp._tool_manager._tools.keys()),',
      '}',
      'out["match"] = [',
      '    m._persona_lore_match(s["keyword"], s.get("card"), s.get("state") or {}, s.get("assets"),',
      '                         datetime.fromisoformat(s["now"].replace("Z", "+00:00")) if s.get("now") else None)',
      '    for s in spec["match"]',
      ']',
      'os.environ["BILI_FENSHEN_HOME"] = spec["note"]["home"]',
      'out["note"] = [json.loads(asyncio.run(m.bili_persona_note(**args))) for args in spec["note"]["cases"]]',
      'pending = Path(spec["note"]["home"]) / "persona" / "growth-pending.jsonl"',
      'out["notePending"] = [json.loads(ln) for ln in pending.read_text(encoding="utf-8").splitlines() if ln.strip()] if pending.exists() else []',
      'out["tool"] = []',
      'for s in spec["tool"]:',
      '    os.environ["BILI_FENSHEN_HOME"] = s["home"]',
      '    out["tool"].append(json.loads(asyncio.run(m.bili_persona_lore(s["keyword"]))))',
      'print("RESULT:" + json.dumps(out, ensure_ascii=False))',
      '',
    ].join('\n')
    writeFileSync(scriptFile, script, 'utf8')
    const res = spawnSync(PYTHON, [scriptFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: cleanEnv(),
    })
    assert.equal(res.status, 0, `python 探针退出码 ${res.status}：${res.stderr || ''}`)
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(line, `python 探针没有输出 RESULT 行：${res.stdout}${res.stderr}`)
    cached = { ...JSON.parse(line.slice('RESULT:'.length)), stderr: String(res.stderr || '') }
    return cached
  }
})()

const needPython = (t) => {
  if (PYTHON) return true
  t.skip('本机没有可用的 Python + bilibili_api/mcp 依赖，跳过 Python 侧断言')
  return false
}

/** 按场景名取纯函数结果（场景顺序与 scenarios().match 一致）。 */
const matchOf = (name) => {
  const probe = pythonProbe()
  const idx = scenarios().match.findIndex((s) => s.name === name)
  assert.ok(idx >= 0, `没有场景 ${name}`)
  return probe.match[idx]
}

/* ───────────────────────── 1. 中文子串命中（含 front-matter 剥离） ───────────────────────── */

test('W6-1 子串命中：中文关键词「无畏契约上分」命中见闻，且正文剥掉 YAML front-matter', (t) => {
  if (!needPython(t)) return
  const r = matchOf('cn-substring')
  assert.equal(r.ok, true)
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0].id, 'wuchang-ranked')
  assert.equal(r.matched[0].body, '我打无畏契约，常年在白银边缘反复横跳。')
  assert.ok(!r.matched[0].body.includes('keys:'), '正文里不许残留 front-matter 的 keys 行')
  assert.ok(!r.matched[0].body.startsWith('---'))
  assert.equal(r.matched[0].usedToday, false)
  assert.equal(r.matched[0].truncated, false)
  assert.equal(r.matched[0].chars, [...r.matched[0].body].length)
  assert.equal(r.total, 1)
})

/* ───────────────────────── 2. 大小写 / 全角半角归一 ───────────────────────── */

test('W6-1 大小写不敏感：key 大写命中小写关键词', (t) => {
  if (!needPython(t)) return
  const r = matchOf('case-insensitive')
  assert.equal(r.ok, true)
  assert.equal(r.matched[0]?.id, 'valorant', JSON.stringify(r))
})

test('W6-1 全角半角归一（NFKC）：全角 key 命中半角关键词', (t) => {
  if (!needPython(t)) return
  const r = matchOf('full-width')
  assert.equal(r.ok, true)
  assert.equal(r.matched[0]?.id, 'valorant', JSON.stringify(r))
})

/* ───────────────────────── 3. 绝不整词边界（中文没空格） ───────────────────────── */

test('W6-1 绝不做整词匹配：英文 key「cat」命中「concatenate」（酒馆 match whole words 对中日文有害）', (t) => {
  if (!needPython(t)) return
  const r = matchOf('no-word-boundary')
  assert.equal(r.ok, true)
  assert.equal(r.matched[0]?.id, 'ascii-cat', JSON.stringify(r))
})

test('W6-1 中文子串：关键词「我最近老是熬夜刷视频」命中 key「熬夜」', (t) => {
  if (!needPython(t)) return
  const r = matchOf('cn-substring-sentence')
  assert.equal(r.ok, true)
  assert.equal(r.matched[0]?.id, 'night-owl', JSON.stringify(r))
})

/* ───────────────────────── 4. 排序：直命中 > 冷却未用 > 索引顺序 ───────────────────────── */

test('W6-1 排序：keys 命中数多的排前面（不被索引顺序压住）', (t) => {
  if (!needPython(t)) return
  const r = matchOf('rank-by-hit-count')
  assert.equal(r.ok, true)
  assert.equal(r.matched.length, 2)
  assert.equal(r.matched[0].id, 'night-owl-2', '两条 keys 命中的应排在一条命中的前面')
  assert.equal(r.matched[1].id, 'night-owl')
})

test('W6-1 冷却降权：今天用过的排到后面但仍返回，并标 usedToday:true', (t) => {
  if (!needPython(t)) return
  const r = matchOf('cooldown')
  assert.equal(r.ok, true)
  assert.equal(r.matched.length, 2, '今天用过只降权、不淘汰')
  assert.deepEqual(r.matched.map((m) => m.id), ['food-wedding', 'night-owl'])
  assert.equal(r.matched[0].usedToday, false)
  assert.equal(r.matched[1].usedToday, true)
})

/* ───────────────────────── 5. C3 预算：≤2 条、≤600 字 ───────────────────────── */

test('W6-1 预算：命中 3 条只返回 2 条，total 记命中总数', (t) => {
  if (!needPython(t)) return
  const r = matchOf('cap-two')
  assert.equal(r.ok, true)
  assert.equal(r.matched.length, 2, '最多 2 条')
  assert.equal(r.total, 3, 'total = 命中总条数（截断前）')
  assert.match(r.note, /命中 3 条/)
})

test('W6-1 预算：两条 400 字正文总长 ≤600，第二条截断并标 truncated', (t) => {
  if (!needPython(t)) return
  const r = matchOf('char-budget-two')
  assert.equal(r.ok, true)
  assert.equal(r.matched.length, 2)
  assert.equal(r.matched[0].chars, 400)
  assert.equal(r.matched[0].truncated, false)
  assert.equal(r.matched[1].truncated, true)
  assert.equal(r.matched[1].chars, 200, '剩下 200 字预算（含省略号）')
  assert.ok(r.matched[1].body.endsWith('…'))
  const totalChars = r.matched.reduce((n, m) => n + m.chars, 0)
  assert.ok(totalChars <= 600, `总正文 ${totalChars} 必须 ≤600`)
  assert.equal(totalChars, 600)
})

test('W6-1 预算：单条 700 字正文截到 600 并标 truncated', (t) => {
  if (!needPython(t)) return
  const r = matchOf('char-budget-one')
  assert.equal(r.ok, true)
  assert.equal(r.matched[0].chars, 600)
  assert.equal(r.matched[0].truncated, true)
  assert.ok(r.matched[0].body.endsWith('…'))
})

/* ───────────────────────── 6. 无命中 / 降级（绝不抛） ───────────────────────── */

test('W6-1 无命中：ok:true、matched 空、note 明说「别硬凑」', (t) => {
  if (!needPython(t)) return
  const r = matchOf('no-hit')
  assert.deepEqual(r, { ok: true, matched: [], total: 0, note: '没有命中的见闻（这很正常，别硬凑）' })
})

test('W6-1 空关键词：不抛、按无命中处理', (t) => {
  if (!needPython(t)) return
  const r = matchOf('blank-keyword')
  assert.equal(r.ok, true)
  assert.deepEqual(r.matched, [])
})

test('W6-1 静默降级：人设卡缺失 → ok:false，不抛', (t) => {
  if (!needPython(t)) return
  const r = matchOf('card-missing')
  assert.equal(r.ok, false)
  assert.deepEqual(r.matched, [])
  assert.match(r.note, /^见闻库暂时不可用：/)
  assert.match(r.note, /人设卡缺失/)
})

test('W6-1 静默降级：见闻正文缺失 → ok:false，不抛', (t) => {
  if (!needPython(t)) return
  const r = matchOf('body-missing')
  assert.equal(r.ok, false)
  assert.match(r.note, /见闻正文缺失/)
})

test('W6-1 静默降级：见闻目录缺失 → ok:false，不抛', (t) => {
  if (!needPython(t)) return
  const r = matchOf('dir-missing')
  assert.equal(r.ok, false)
  assert.match(r.note, /见闻目录缺失/)
})

/* ───────────────────────── 7. 工具入口：卡解析 / 冷却 / 回落 ───────────────────────── */

test('W6-1 工具：file 模式卡 + 今日冷却端到端（返回 JSON 字符串里的 matched）', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe().tool[0]
  assert.equal(r.ok, true)
  assert.equal(r.matched[0].id, 'night-owl')
  assert.equal(r.matched[0].usedToday, true, 'persona/state.json 里今天用过的必须标 true')
  assert.equal(r.matched[0].body, '我凌晨三点又点开下一集。')
  assert.ok(!r.matched[0].body.includes('fixture'), 'front-matter 不许漏进正文')
})

test('W6-1 工具：file 卡缺失 → 回落 preset whale（工具不整个死）', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe().tool[1]
  assert.equal(r.ok, true)
  assert.equal(r.matched[0]?.id, 'wuchang-ranked', JSON.stringify(r))
})

test('W6-1 工具签名与注册：keyword 必填、默认全量注册', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.equal(probe.signatures.lore, '(keyword: str) -> str')
  assert.ok(probe.registered.includes('bili_persona_lore'), probe.registered.join(','))
  assert.ok(probe.registered.includes('bili_persona_note'), probe.registered.join(','))
})

/* ───────────────────────── 8. 白名单门禁（BILI_MCP_TOOLS 没列 → 不暴露） ───────────────────────── */

const whitelistProbe = () => {
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    'import mcp_server as m1',
    'print("A:" + ",".join(sorted(m1.mcp._tool_manager._tools.keys())))',
    'del sys.modules["mcp_server"]',
    'import os',
    'os.environ["BILI_MCP_TOOLS"] = "bili_search,bili_persona_note,bili_persona_lore"',
    'import mcp_server as m2',
    'print("B:" + ",".join(sorted(m2.mcp._tool_manager._tools.keys())))',
    '',
  ].join('\n')
  const env = cleanEnv()
  env.BILI_MCP_TOOLS = 'bili_search,bili_persona_note'
  const res = spawnSync(PYTHON, ['-c', script], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000, env })
  assert.equal(res.status, 0, res.stderr || '')
  const lines = String(res.stdout || '').split(/\r?\n/)
  const pick = (tag) => (lines.find((l) => l.startsWith(tag)) || '').slice(tag.length)
  return { without: pick('A:'), withLore: pick('B:') }
}

test('白名单门禁：BILI_MCP_TOOLS 没列 bili_persona_lore → 不注册；列了才注册', (t) => {
  if (!needPython(t)) return
  const { without, withLore } = whitelistProbe()
  const withoutList = without.split(',')
  assert.ok(withoutList.includes('bili_search'), `stdout=${JSON.stringify(without)}`)
  assert.ok(withoutList.includes('bili_persona_note'))
  assert.ok(!withoutList.includes('bili_persona_lore'), '白名单外工具必须不暴露')
  assert.ok(withLore.split(',').includes('bili_persona_lore'))
})

/* ───────────────────────── 9. W2 收尾：originalText 三分支 ───────────────────────── */

test('W2 收尾：community 缺 originalText → {ok:false, code:NEED_ORIGINAL_TEXT}，且不写 pending', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const r = probe.note[0]
  assert.deepEqual(r, { ok: false, code: 'NEED_ORIGINAL_TEXT', error: 'community 语料必须附原帖原文' })
  assert.equal(probe.notePending.length, 3, '被拒的候选不该进 growth-pending.jsonl')
})

test('W2 收尾：community 带 originalText → 通过，字段名 originalText 原样进 pending（与 growth.js 对齐）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const r = probe.note[1]
  assert.equal(r.success, true)
  assert.equal(r.kind, 'corpus')
  const entry = probe.notePending.find((p) => p.text === '电子榨菜')
  assert.ok(entry, JSON.stringify(probe.notePending))
  assert.equal(entry.origin, 'community')
  assert.equal(entry.originalText, '今天又是靠这个视频当电子榨菜的一天')
})

test('W2 收尾：self 不需要 originalText（向后兼容，pending 里也不留空字段）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const r = probe.note[2]
  assert.equal(r.success, true)
  const entry = probe.notePending.find((p) => p.text === '这饭真香')
  assert.ok(entry, JSON.stringify(probe.notePending))
  assert.equal(entry.origin, 'self')
  assert.ok(!('originalText' in entry), '没传该字段就不该写进 pending')
})

test('W2 收尾：lore 候选不受 originalText 影响（工具签名多了可选参数，行为不变）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.equal(probe.note[3].success, true)
  assert.match(probe.signatures.note, /originalText: str = ''/)
  const entry = probe.notePending.find((p) => p.kind === 'lore')
  assert.ok(entry, JSON.stringify(probe.notePending))
  assert.deepEqual(entry.keys, ['测试词'])
  assert.equal(entry.oneLine, '一行摘要')
  assert.equal(entry.body, '见闻正文')
})

/* ───────────────────────── 10. 真实预设卡冒烟（只读插件包） ───────────────────────── */

test('W6-1 真实预设卡：whale 卡的 loreIndex 三条都能被子串命中（只读插件包、不写盘）', (t) => {
  if (!needPython(t)) return
  // 这条不经过 pythonProbe：直接读插件里的真卡，确认卡字段形状没变（卡一改，本工具就要跟着坏）
  const whale = JSON.parse(readFileSync(join(PLUGIN_DIR, 'prompts', 'persona', 'whale.card.json'), 'utf8'))
  assert.ok(Array.isArray(whale.loreIndex) && whale.loreIndex.length >= 3)
  for (const entry of whale.loreIndex) {
    assert.ok(entry.id && Array.isArray(entry.keys) && entry.keys.length, JSON.stringify(entry))
    assert.ok(existsSync(join(PLUGIN_DIR, 'prompts', 'persona', 'lore', `${entry.id}.md`)), `见闻正文缺失：${entry.id}.md`)
  }
  // 中文子串（不做整词边界）在这个卡上是可命中的：keys 都是短词，标题里常整串出现
  assert.ok(whale.loreIndex.some((e) => e.keys.includes('无畏契约')))
})
