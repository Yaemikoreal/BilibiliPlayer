// dsh-plugin/test/mcp.verify.test.js
// 2026-10-29 改进核验 §2.1 方案 B 的单测：发后复核链路（数据层自记账 + 登录态出网核对）。
//
// 覆盖验收标准：
//   ① bili_reply 成功 → verify-pending.jsonl 多一行（mock 成功响应）；rpid 为空 ⇒ 不写 + 告警；
//   ② bili_verify_recent_comments 对「正常 / 审核中(宽限窗) / 隐藏」三种夹具返回三档不同结论；
//   ③ 接话（带 parent）走楼中楼通道；通道失效 ⇒ unverified 且不判定（绝不默认正常）；
//   ④ TTL 7 天：超龄记录读取侧直接丢弃；超窗（> window_min）记 stale 并清出队列。
//
// 纪律（照 test/persona.lint.test.js）：临时家目录隔离；Python 子进程不联网（通道函数全部 mock）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const REPO_ROOT = resolve(PLUGIN_DIR, '..')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-verify-'))
const home = () => process.env.BILI_FENSHEN_HOME

const extraHomes = []
const mkHome = (prefix = 'bf-verify-extra-') => {
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

/** 找到以 rpid 开头的 verify-pending 行。 */
const lineFor = (probe, rpid) => probe.pendingLines.find((l) => String(l.rpid) === String(rpid)) || null

const pythonProbe = (() => {
  let cached = null
  return () => {
    if (cached) return cached
    if (!PYTHON) return null
    const dir = mkHome('bf-verify-probe-')
    const scriptFile = join(dir, 'verify-probe.py')
    const credFile = join(dir, 'cred.json')
    writeFileSync(credFile, JSON.stringify({ sessdata: 'test', bili_jct: 'test', buvid3: 'test', dedeuserid: '123' }), 'utf8')
    const script = [
      'import asyncio, json, os, sys',
      'from datetime import datetime, timedelta, timezone',
      'from pathlib import Path',
      `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
      `os.environ["BILI_CRED_FILE"] = ${JSON.stringify(credFile)}`, // 必须在 import 前设：CRED_FILE 是 import 期常量
      `os.environ["BILI_FENSHEN_ROUND_ID"] = "r-verify"`,
      'import mcp_server as m',
      '',
      'out = {}',
      'pending = Path(' + JSON.stringify(join(home(), 'verify-pending.jsonl')) + ')',
      '',
      '# ── ① bili_reply 成功 → verify-pending 多一行（全程 mock 网络） ──',
      'class _FakeVideo:',
      '    def __init__(self, bvid=None, credential=None):',
      '        self.bvid = bvid',
      '    async def get_info(self):',
      '        return {"aid": 117506127694406}',
      'm.video.Video = _FakeVideo',
      'async def _send_ok(text, oid, type_, credential=None, root=None, parent=None):',
      '    return {"rpid": 318999000001}',
      'm.comment.send_comment = _send_ok',
      'reply1 = json.loads(asyncio.run(m.bili_reply(bvid="BV1abc12345", text="测试一句发后复核", rpid=0, root=0)))',
      'out["reply1"] = reply1',
      '',
      '# ── ② rpid 取不到 ⇒ 不写 pending + 告警 ──',
      'async def _send_no_rpid(text, oid, type_, credential=None, root=None, parent=None):',
      '    return {"code": 0}',
      'm.comment.send_comment = _send_no_rpid',
      'reply2 = json.loads(asyncio.run(m.bili_reply(bvid="BV1abc12345", text="这条拿不到 rpid", rpid=0, root=0)))',
      'out["reply2"] = reply2',
      '',
      'def read_pending():',
      '    if not pending.exists():',
      '        return []',
      '    return [json.loads(ln) for ln in pending.read_text(encoding="utf-8").splitlines() if ln.strip()]',
      'out["pendingLines"] = read_pending()',
      '',
      '# ── ③ 三档夹具：同一份队列，通道 mock 控制命中/未命中，t 控制宽限窗 ──',
      'now = datetime.now(timezone.utc)',
      'iso = lambda dt: dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")',
      'fix = [',
      '    {"bvid": "BV1abc12345", "rpid": 111, "oid": 117506127694406, "t": iso(now - timedelta(minutes=5)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 222, "oid": 117506127694406, "t": iso(now - timedelta(minutes=3)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 333, "oid": 117506127694406, "t": iso(now - timedelta(minutes=20)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 444, "parent": 999, "oid": 117506127694406, "t": iso(now - timedelta(minutes=5)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 555, "oid": 117506127694406, "t": iso(now - timedelta(minutes=40)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 666, "oid": 117506127694406, "t": iso(now - timedelta(days=8)), "round": "r-verify"},',
      '    {"bvid": "BV1abc12345", "rpid": 777, "oid": 117506127694406, "t": iso(now - timedelta(minutes=6)), "round": "r-verify"},',
      ']',
      'm._verify_write_sync(pending, fix)',
      '',
      '# 通道 mock：111 命中、其余未命中（分层靠 t 与 found 组合）',
      'async def _channel(aid, rpid, cred, max_pages=10):',
      '    return {"found": True, "page": 2, "error": None} if int(rpid) == 111 else {"found": False, "page": None, "error": None}',
      'async def _err(aid, rpid, cred, max_pages=10):',
      '    return {"found": False, "page": None, "error": "评论列表读取失败: 风控"}',
      'async def _sub_hit(aid, root, rpid, cred, bvid=""):',
      '    return {"found": True, "error": None}',
      'm._reply_pages_hit = _channel',
      'm._sub_reply_hit = _sub_hit',
      'v1 = json.loads(asyncio.run(m.bili_verify_recent_comments(window_min=30, grace_min=10)))',
      'out["v1"] = v1',
      '',
      '# 通道失效：error ⇒ unverified，不判定，记录留在队列',
      'm._reply_pages_hit = _err',
      'v2 = json.loads(asyncio.run(m.bili_verify_recent_comments(window_min=30, grace_min=10)))',
      'out["v2"] = v2',
      'out["pendingAfterErr"] = read_pending()',
      '',
      '# 全部未命中：宽限窗外的 ⇒ suspect_hidden；窗内的 ⇒ pending_grace',
      'async def _miss(aid, rpid, cred, max_pages=10):',
      '    return {"found": False, "page": None, "error": None}',
      'm._reply_pages_hit = _miss',
      'v3 = json.loads(asyncio.run(m.bili_verify_recent_comments(window_min=30, grace_min=10)))',
      'out["v3"] = v3',
      'out["pendingAfterMiss"] = read_pending()',
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

/* ───────────────────────── ① 自记账 ───────────────────────── */

test('§2.1 bili_reply 成功 ⇒ verify-pending.jsonl 多一行（含 bvid/rpid/oid/t/round）', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.equal(probe.reply1.success, true, JSON.stringify(probe.reply1))
  const rec = lineFor(probe, 318999000001)
  assert.ok(rec, JSON.stringify(probe.pendingLines))
  assert.equal(rec.bvid, 'BV1abc12345')
  assert.equal(rec.oid, 117506127694406)
  assert.equal(rec.round, 'r-verify')
  assert.ok(rec.t, 't 必须有（宽限窗与 TTL 都靠它）')
  assert.ok(!('parent' in rec), '新评论没有 parent（接话才有）')
})

test('§2.1 rpid 取不到 ⇒ 不写 pending（不留永远无法核对的空行）+ 告警', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  assert.equal(probe.reply2.success, true)
  assert.equal(probe.reply2.rpid ?? null, null)
  assert.equal(lineFor(probe, null), null, '不该有任何无 rpid 的记录')
  assert.equal(probe.pendingLines.filter((l) => l.rpid === 318999000001).length, 1, '只有第一条进队列')
  assert.match(probe.stderr, /进不了发后复核队列/, `stderr=${probe.stderr.slice(-400)}`)
})

/* ───────────────────────── ② 三档结论 ───────────────────────── */

test('§2.1 三档夹具：正常(visible) / 审核中(pending_grace) / 隐藏(suspect_hidden) 返回不同结论', (t) => {
  if (!needPython(t)) return
  const v = pythonProbe().v1
  assert.equal(v.success, true)
  assert.deepEqual(v.visible.map((r) => r.rpid).sort(), [111, 444], '根评论命中 + 接话走楼中楼通道命中')
  assert.deepEqual(v.pending_grace.map((r) => r.rpid).sort(), [222, 777], '发布 3/6 分钟（<10 宽限窗）⇒ 不判压审')
  assert.deepEqual(v.suspect_hidden.map((r) => r.rpid), [333], '发布 20 分钟仍翻不到 ⇒ suspect_hidden')
  assert.deepEqual(v.stale.map((r) => r.rpid), [555], '40 分钟超窗 ⇒ stale')
  assert.equal(v.checked, 6, 'TTL 8 天的 666 在读取侧已丢弃')
  assert.match(v.note, /suspect_hidden/)
})

test('§2.1 通道失效 ⇒ unverified 不判定（绝不默认正常），记录留在队列', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const v = probe.v2
  assert.deepEqual(v.unverified.map((r) => r.rpid), [222, 333, 777], '上一轮留在队列的全部不判定')
  assert.equal(v.visible.length, 0)
  assert.match(v.unverified[0].reason, /风控/)
  // 记录没被清掉
  const kept = probe.pendingAfterErr.map((r) => r.rpid)
  assert.ok(kept.includes(222) && kept.includes(333) && kept.includes(777))
  assert.ok(!kept.includes(111) && !kept.includes(444), 'visible 的已出队')
  assert.ok(!kept.includes(555), 'stale 的已出队')
})

test('§2.1 全部未命中：宽限窗外 suspect_hidden 留队（TTL 内有翻案机会），窗内 pending_grace 留队', (t) => {
  if (!needPython(t)) return
  const probe = pythonProbe()
  const v = probe.v3
  assert.deepEqual(v.suspect_hidden.map((r) => r.rpid), [333])
  assert.deepEqual(v.pending_grace.map((r) => r.rpid).sort(), [222, 777])
  const kept = probe.pendingAfterMiss.map((r) => r.rpid).sort()
  assert.deepEqual(kept, [222, 333, 777])
})

/* ───────────────────────── ③ 宿主侧：死代码已删 ───────────────────────── */

test('§2.1 90s 定时器与 verifyRecentSafe 已删除；state.commentsToVerify 不再被宿主引用', async () => {
  const { readFileSync } = await import('node:fs')
  const code = readFileSync(join(PLUGIN_DIR, 'index.js'), 'utf8')
  assert.ok(!code.includes('commentsToVerify'), '死代码键已删干净')
  assert.ok(!code.includes('verifyRecentSafe'), '占位桩已删干净')
})
