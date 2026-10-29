// dsh-plugin/test/mcp.ledger.test.js
// 2026-10-29 改进核验（docs/analysis/2026-10-29-improvement-plan-audit.md）第 0 批的 Python 侧单测：
//   ① §2.5 账本读取：坏行留痕（warning）、坏文件不再静默（error）、判重行为与改造前逐项相同；
//   ② §2.4 通知容错：单侧失败 ⇒ success:true + partial:true + errors + 另一侧数据照常返回。
//
// 纪律（照 test/persona.lint.test.js / persona.lore-tool.test.js）：
//   1. 家目录隔离：所有读写都在 mkdtemp 出来的 BILI_FENSHEN_HOME，不碰真实 ~/.dsh/bili-fenshen；
//   2. Python 侧只起子进程调纯函数 + monkeypatch 网络函数，不联网、不发评论、不碰真实凭证；
//   3. 没有可用的 Python + bilibili_api/mcp 依赖时只 skip Python 那几条。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..') // <repo>/dsh-plugin
const REPO_ROOT = resolve(PLUGIN_DIR, '..')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-ledger-'))
const home = () => process.env.BILI_FENSHEN_HOME

const extraHomes = []
const mkHome = (prefix = 'bf-ledger-extra-') => {
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

// BV 号必须过 _BV_FULL_RE（BV + 8–12 位字母数字）
const line = (obj) => JSON.stringify(obj)
const EV = {
  comment1: { t: '2026-10-27T02:00:00.000Z', round: 'r1', type: 'comment', bvid: 'BV1abc12345', text: '第一条', rpid: 1 },
  view: { t: '2026-10-27T02:05:00.000Z', round: 'r1', type: 'view', bvid: 'BV2abc12345' },
  replyOut: { t: '2026-10-27T02:10:00.000Z', round: 'r1', type: 'reply-out', bvid: 'BV1abc12345', parent: 318, text: '接话' },
  like: { t: '2026-10-27T02:15:00.000Z', round: 'r1', type: 'like', bvid: 'BV3abc12345' },
  comment2: { t: '2026-10-27T02:20:00.000Z', round: 'r1', type: 'comment', bvid: 'BV4abc12345', text: '第二条' },
}

/** 真实事故形状：一行塞两个对象 + 一行坏 JSON + 空行。 */
const fixtureLedger = () => [
  line(EV.comment1),
  line(EV.view),
  `${line(EV.replyOut)}${line(EV.like)}`, // 2026-10-25 事故形状：一行两对象
  '',
  '这不是JSON{{{',
  line(EV.comment2),
].join('\n') + '\n'

// 期望值（与改造前的解析行为逐项一致——本次只加日志，不改语义）
const EXPECT_SEEN = ['BV1abc12345', 'BV2abc12345', 'BV3abc12345', 'BV4abc12345']
const EXPECT_REPLIED = [['BV1abc12345', 318]]

const fixtureHome = () => {
  const dir = mkHome('bf-ledger-fixture-')
  writeFileSync(join(dir, 'ledger.jsonl'), fixtureLedger(), 'utf8')
  return dir
}

/** 坏文件夹具：ledger.jsonl 是个目录 ⇒ open() 必抛（原实现静默吞掉，现在必须 error 留痕）。 */
const unreadableHome = () => {
  const dir = mkHome('bf-ledger-unreadable-')
  mkdirSync(join(dir, 'ledger.jsonl'), { recursive: true })
  return dir
}

/** 缺失家目录：没有 ledger.jsonl ⇒ 空集（不该报错）。 */
const emptyHome = () => mkHome('bf-ledger-empty-')

/** 假凭证（get_cred 只看字段存在，不联网校验）。 */
const credFile = () => {
  const dir = mkHome('bf-ledger-cred-')
  const f = join(dir, 'bili_credential.json')
  writeFileSync(f, JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: 'test', dedeuserid: '123' }), 'utf8')
  return f
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
    const probe = spawnSync(bin, ['-c', "import importlib.util as u, sys; sys.exit(0 if u.find_spec('bilibili_api') and u.find_spec('mcp') else 1)"], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000,
    })
    if (probe.status === 0) return bin
  }
  return ''
})()

const cleanEnv = () => {
  const env = { ...process.env, BILI_FENSHEN_HOME: home(), PYTHONIOENCODING: 'utf-8' }
  delete env.BILI_MCP_TOOLS
  return env
}

const pythonProbe = (() => {
  let cached = null
  return () => {
    if (cached) return cached
    if (!PYTHON) return null
    const dir = mkHome('bf-ledger-probe-')
    const spec = {
      fixtureHome: fixtureHome(),
      unreadableHome: unreadableHome(),
      emptyHome: emptyHome(),
      credFile: credFile(),
    }
    const scriptFile = join(dir, 'ledger-probe.py')
    const script = [
      'import asyncio, json, os, sys',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
      `os.environ["BILI_CRED_FILE"] = ${JSON.stringify(spec.credFile)}`, // 必须在 import 前设：CRED_FILE 是 import 期常量
      'import mcp_server as m',
      '',
      'out = {}',
      '# fixture 家目录：正常解析 + 坏行',
      'os.environ["BILI_FENSHEN_HOME"] = ' + JSON.stringify(spec.fixtureHome),
      'out["events"] = m._ledger_read_events()',
      'out["seen"] = sorted(m._ledger_seen_bvids())',
      'out["replied"] = sorted([list(x) for x in m._replied_targets()])',
      'out["limited"] = m._ledger_read_events(limit=2)',
      'os.environ["BILI_FENSHEN_HOME"] = ' + JSON.stringify(spec.emptyHome),
      'out["missing"] = m._ledger_read_events()',
      '# 坏文件（ledger.jsonl 是目录）⇒ 不静默',
      'os.environ["BILI_FENSHEN_HOME"] = ' + JSON.stringify(spec.unreadableHome),
      'out["unreadable"] = m._ledger_read_events()',
      '',
      '# §2.4 通知容错：monkeypatch 网络函数，不联网',
      'async def _ok_at(credential=None):',
      '    return {"items": [{"id": 1}], "at": True}',
      'async def _fail_likes(credential=None):',
      '    raise RuntimeError("频控了")',
      'async def _ok_likes(credential=None):',
      '    return {"items": [{"id": 2}], "likes": True}',
      '',
      'm.session.get_at = _ok_at',
      'm.session.get_likes = _fail_likes',
      'out["partial"] = json.loads(asyncio.run(m.bili_received_at_and_likes()))',
      'm.session.get_likes = _ok_likes',
      'out["both"] = json.loads(asyncio.run(m.bili_received_at_and_likes()))',
      '',
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
    const lineOut = String(res.stdout || '').split('\n').find((l) => l.startsWith('RESULT:'))
    assert.ok(lineOut, `python 探针没有输出 RESULT 行：${res.stdout}${res.stderr}`)
    cached = { ...JSON.parse(lineOut.slice('RESULT:'.length)), stderr: String(res.stderr || '') }
    return cached
  }
})()

const needPython = (t) => {
  if (PYTHON) return true
  t.skip('本机没有可用的 Python + bilibili_api/mcp 依赖，跳过 Python 侧断言')
  return false
}

/* ───────────────────────── §2.5 账本读取 ───────────────────────── */

test('§2.5 判重行为不变：多对象行/坏行/空行的夹具下 seen 与 replied 逐项相同', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.deepEqual(probe.seen, EXPECT_SEEN, JSON.stringify(probe.seen))
  assert.deepEqual(probe.replied, EXPECT_REPLIED, JSON.stringify(probe.replied))
  assert.equal(probe.events.length, 5, '5 个事件全部解析出来（含一行两对象）')
  assert.deepEqual(probe.missing, [], '账本缺失 ⇒ 空集且不报错')
})

test('§2.5 limit 语义不变：limit=2 取最后 2 条（全量解析后切片，行为与改造前一致）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.deepEqual(probe.limited, [EV.like, EV.comment2])
})

test('§2.5 坏行不静默：解析失败的行留 warning 日志', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.match(probe.stderr, /账本有 1 行解析失败/, `stderr=${probe.stderr}`)
})

test('§2.5 坏文件不静默：整文件读失败留 error 日志，返回已读部分（空）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.deepEqual(probe.unreadable, [])
  assert.match(probe.stderr, /账本读取失败/, `stderr=${probe.stderr}`)
})

/* ───────────────────────── §2.4 通知容错 ───────────────────────── */

test('§2.4 单侧失败 ⇒ success:true + partial:true + errors 有内容 + 另一侧数据照常可用', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe().partial
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(r.partial, true)
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /likes/)
  assert.ok(r.at, '成功那侧的数据不许丢')
  assert.equal(r.at.at, true)
  assert.match(r.note, /部分通知获取失败/)
})

test('§2.4 双侧成功 ⇒ 无 partial/errors 字段（不添乱）', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe().both
  assert.equal(r.success, true)
  assert.equal(r.partial, false)
  assert.ok(!('errors' in r))
  assert.ok(r.at && r.likes)
})
