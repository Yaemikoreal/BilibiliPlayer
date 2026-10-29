// dsh-plugin/test/mcp.perf.test.js
// 2026-10-29 改进核验（docs/analysis/2026-10-29-improvement-plan-audit.md）第 1 批的 Python 侧单测：
//   ① §2.5 Step 2 账本增量缓存：size+mtime 签名，第二次读不重复解析（5MB 夹具 < 5ms），追加后自动失效；
//   ② §4.2 共享 HTTP 会话：get_http_session 两次调用复用同一对象（不再每个视频一次 TLS 握手）；
//   ③ 同步 I/O 收进线程后，bili_ledger_append / bili_report_append 工具行为不变（端到端走真函数）。
//
// 纪律（照 test/persona.lint.test.js）：临时家目录隔离；Python 子进程不联网。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const REPO_ROOT = resolve(PLUGIN_DIR, '..')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-perf-'))
const home = () => process.env.BILI_FENSHEN_HOME

const extraHomes = []
const mkHome = (prefix = 'bf-perf-extra-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  extraHomes.push(dir)
  return dir
}

after(() => {
  for (const dir of [home(), ...extraHomes]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 兜住 */ }
  }
})

/* ───────────────────────── Python 探测 ───────────────────────── */

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
    const dir = mkHome('bf-perf-probe-')
    const scriptFile = join(dir, 'perf-probe.py')
    const script = [
      'import asyncio, json, os, sys, time',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
      'import mcp_server as m',
      '',
      'out = {}',
      '',
      '# ① 5MB 夹具：~80k 行（> 5 MiB），与核验口径同量级',
      'big_home = Path(' + JSON.stringify(join(home(), 'big')) + ')',
      'big_home.mkdir(parents=True, exist_ok=True)',
      'path = big_home / "ledger.jsonl"',
      'row = \'{"t":"2026-10-27T02:00:00.000Z","round":"r1","type":"view","bvid":"BV1abc12345"}\'',
      'with open(path, "w", encoding="utf-8", newline="\\n") as f:',
      '    for i in range(80000):',
      '        f.write(row + "\\n")',
      'size = path.stat().st_size',
      'assert size > 5 * 1024 * 1024, f"夹具不足 5MB: {size}"',
      '',
      'os.environ["BILI_FENSHEN_HOME"] = str(big_home)',
      't0 = time.perf_counter()',
      'first = m._ledger_cache.read()',
      'out["firstMs"] = round((time.perf_counter() - t0) * 1000, 2)',
      't1 = time.perf_counter()',
      'second = m._ledger_cache.read()',
      'out["secondMs"] = round((time.perf_counter() - t1) * 1000, 2)',
      'out["events"] = len(first)',
      'out["secondSame"] = len(second) == len(first)',
      '',
      '# limit 语义与 _ledger_read_events(limit) 一致：取尾部 N 条',
      'limited = m._ledger_cache.read(limit=800)',
      'out["limitedCount"] = len(limited)',
      'out["limitedIsTail"] = limited[-1] is first[-1]',
      '',
      '# 追加 ⇒ size/mtime 变化 ⇒ 自动重解析（不用手动失效）',
      'os.environ["BILI_FENSHEN_ROUND_ID"] = "r-perf"',
      'receipt = json.loads(asyncio.run(m.bili_ledger_append(events=[{"type": "view", "bvid": "BV5abc12345"}])))',
      'out["appendReceipt"] = receipt',
      'after = m._ledger_cache.read()',
      'out["afterAppendCount"] = len(after)',
      'out["afterAppendHasNew"] = any(e.get("bvid") == "BV5abc12345" for e in after)',
      '',
      '# ② 共享 HTTP 会话：两次拿到同一对象；同一事件循环内 lifespan 退出统一关闭',
      'async def _session_check():',
      '    s1 = await m.get_http_session()',
      '    s2 = await m.get_http_session()',
      '    cm = m._mcp_lifespan(None)',
      '    await cm.__aenter__()',
      '    await cm.__aexit__(None, None, None)',
      '    return s1 is s2, s1.closed',
      'out["sessionReused"], out["sessionClosedByLifespan"] = asyncio.run(_session_check())',
      '',
      '# ③ 报告工具端到端（to_thread 路径）：写入 + 重复拒',
      'md = "## 测试轮（round id 2099-01-01T00:00:00.000Z）\\n\\n内容一段。"',
      'rep1 = json.loads(asyncio.run(m.bili_report_append(markdown=md)))',
      'rep2 = json.loads(asyncio.run(m.bili_report_append(markdown=md)))',
      'out["reportFirst"] = rep1',
      'out["reportDup"] = rep2.get("code")',
      '',
      'print("RESULT:" + json.dumps(out, ensure_ascii=False))',
      '',
    ].join('\n')
    writeFileSync(scriptFile, script, 'utf8')
    const res = spawnSync(PYTHON, [scriptFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180000,
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

/* ───────────────────────── 断言 ───────────────────────── */

test('§2.5 缓存：5MB 夹具第二次读不重复解析（< 5ms），事件数与首次一致', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe()
  assert.equal(r.secondSame, true)
  assert.equal(r.events, 80000)
  assert.ok(r.secondMs < 5, `第二次全量读耗时 ${r.secondMs}ms，应 < 5ms（size+mtime 未变 ⇒ 直接返回缓存）`)
  assert.ok(r.firstMs > r.secondMs, `首次 ${r.firstMs}ms 应明显慢于第二次 ${r.secondMs}ms`)
})

test('§2.5 缓存 limit 语义：read(limit=800) 返回尾部 800 条（与 _ledger_read_events(limit) 一致）', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe()
  assert.equal(r.limitedCount, 800)
  assert.equal(r.limitedIsTail, true)
})

test('§2.5 缓存失效：bili_ledger_append 追加后 size/mtime 变化 ⇒ 下一次读自动带上新事件', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe()
  assert.equal(r.appendReceipt.written, 1, JSON.stringify(r.appendReceipt))
  assert.equal(r.afterAppendCount, r.events + 1)
  assert.equal(r.afterAppendHasNew, true)
})

test('§4.2 共享会话：get_http_session 两次调用复用同一对象；lifespan 退出统一关闭', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe()
  assert.equal(r.sessionReused, true)
  assert.equal(r.sessionClosedByLifespan, true)
})

test('§4.2/§5-3 报告工具端到端：首写成功、同 round 重复追加被拒（DUPLICATE_ROUND）', (t) => {
  if (!needPython(t)) return
  const r = pythonProbe()
  assert.equal(r.reportFirst.success, true, JSON.stringify(r.reportFirst))
  assert.equal(r.reportDup, 'DUPLICATE_ROUND')
})
