// dsh-plugin/test/mcp.tools-snapshot.test.js
// 2026-10-29 改进核验 §4.1 前置条件 + §4.4：MCP 工具集快照（拆包保护网）+ LedgerEventInput 展示契约。
//
// ① 快照（§4.1："没有这张网，拆包属于赌博"）：list_tools() 的 35 个工具 name + 参数 schema
//    逐字节锁定在 test/fixtures/mcp.tools-snapshot.json。拆包/重构/改签名后必须跑一次
//    `node test/mcp.tools-snapshot.test.js --update` 重导快照，并在提交说明里逐条列出差异。
// ② LedgerEventInput（§4.4）：bili_ledger_append 的 events 参数用 pydantic 模型展示字段契约
//    （模型调用前就能看到 JSON Schema），运行时校验仍走 _validate_ledger_event **逐条拒**——
//    一条坏事件不许把整批调用打成 422（那是既有语义，快照+本测试一起锁住）。
//
// 纪律：Python 子进程不联网（只 import mcp_server 读注册表 / 调记账工具）。
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
const SNAPSHOT = join(PLUGIN_DIR, 'test', 'fixtures', 'mcp.tools-snapshot.json')

process.env.BILI_FENSHEN_HOME = mkdtempSync(join(tmpdir(), 'bf-snapshot-'))

after(() => {
  try { rmSync(process.env.BILI_FENSHEN_HOME, { recursive: true, force: true }) } catch { /* 兜住 */ }
})

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

const needPython = (t) => {
  if (PYTHON) return true
  t.skip('本机没有可用的 Python + bilibili_api/mcp 依赖，跳过工具集快照')
  return false
}

/** 导出注册表的 {name → inputSchema}（稳定排序；BILI_MCP_TOOLS 未设 = 全量）。 */
const exportTools = () => {
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    'import mcp_server as m',
    'tools = m.mcp._tool_manager._tools',
    'out = {name: {"name": name, "description": (fn.description or ""), "inputSchema": fn.parameters}',
    '       for name, fn in sorted(tools.items())}',
    'print("TOOLS:" + json.dumps(out, ensure_ascii=False, sort_keys=True))',
    '',
  ].join('\n')
  const res = spawnSync(PYTHON, ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, BILI_FENSHEN_HOME: process.env.BILI_FENSHEN_HOME, PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(res.status, 0, `python 导出工具集失败：${res.stderr || ''}`)
  const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('TOOLS:'))
  assert.ok(line, '没有 TOOLS: 输出行')
  return JSON.parse(line.slice('TOOLS:'.length))
}

test('§4.1 工具集快照：name + docstring + 参数 schema 逐字节锁定（拆包保护网）', (t) => {
  if (!needPython(t)) return
  const tools = exportTools()
  assert.ok(Object.keys(tools).length >= 35, `工具数 ${Object.keys(tools).length}，应 ≥ 35（§2.1 新增 verify 后）`)
  assert.ok(tools.bili_verify_recent_comments, '§2.1 新工具必须在注册表里')

  if (!existsSync(SNAPSHOT)) {
    // 首次生成：写盘并直接通过（快照文件随后入库）
    writeFileSync(SNAPSHOT, JSON.stringify(tools, null, 2) + '\n', 'utf8')
    t.diagnostic(`快照不存在，已生成 ${Object.keys(tools).length} 个工具 → ${SNAPSHOT}（请检查后入库）`)
    return
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const actualNames = Object.keys(tools).sort()
  const expectedNames = Object.keys(expected).sort()
  assert.deepEqual(actualNames, expectedNames, '工具名单变了（增/删/改名都要显式重导快照）')
  assert.deepEqual(tools, expected, '工具 docstring / 参数 schema 与快照不一致——签名或文案变更需 --update 重导并在提交里说明')
})

test('§4.4 LedgerEventInput：events 是强类型列表（schema 里可见字段契约），坏 type 仍逐条拒而非整批失败', (t) => {
  if (!needPython(t)) return
  const tools = exportTools()
  const schema = JSON.stringify(tools.bili_ledger_append.inputSchema)
  assert.match(schema, /LedgerEventInput/, 'events 参数应引用 LedgerEventInput（模型可见的字段契约）')
  for (const field of ['bvid', 'parent', 'reply-scan']) {
    assert.ok(schema.includes(field), `schema 应展示 ${field}`)
  }

  // 行为：dict 照常 coerce；坏 type 走 rejected（逐条），不是整批异常
  const script = [
    'import asyncio, json, os, sys',
    'from pathlib import Path',
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    'import mcp_server as m',
    'os.environ["BILI_FENSHEN_ROUND_ID"] = "r-schema"',
    'os.environ["BILI_FENSHEN_HOME"] = ' + JSON.stringify(process.env.BILI_FENSHEN_HOME),
    'r1 = json.loads(asyncio.run(m.bili_ledger_append(events=[{"type": "view", "bvid": "BV1abc12345"}])))',
    'print("R1:" + json.dumps(r1, ensure_ascii=False))',
    'r2 = json.loads(asyncio.run(m.bili_ledger_append(events=[',
    '    {"type": "view", "bvid": "BV2abc12345"},',
    '    {"type": "nope", "bvid": "BV3abc12345"},',
    '])))',
    'print("R2:" + json.dumps(r2, ensure_ascii=False))',
    '',
  ].join('\n')
  const res = spawnSync(PYTHON, ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, BILI_FENSHEN_HOME: process.env.BILI_FENSHEN_HOME, PYTHONIOENCODING: 'utf-8' },
  })
  assert.equal(res.status, 0, `python 运行失败：${res.stderr || ''}`)
  const pick = (tag) => {
    const line = String(res.stdout || '').split('\n').find((l) => l.startsWith(tag))
    assert.ok(line, `缺 ${tag} 输出`)
    return JSON.parse(line.slice(tag.length))
  }
  const r1 = pick('R1:')
  assert.equal(r1.written, 1, JSON.stringify(r1))
  const r2 = pick('R2:')
  assert.equal(r2.written, 1, '好的一条照常写入')
  assert.equal(r2.rejected.length, 1, '坏的一条逐条拒（不整批失败）')
  assert.match(r2.rejected[0].reason, /type 只允许/)
})
