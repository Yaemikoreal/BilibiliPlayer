// dsh-plugin/test/diagnose.test.js
// 一键诊断纯逻辑单测：全部用假 env（不联网、不 spawn 真实 python、不写真实家目录）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_ORDER, runDiagnose, formatDiagnoseText } from '../lib/diagnose.js'

const EXPECTED_ORDER = [
  'python', 'deps', 'mcp-server', 'mcp-connection', 'credential',
  'dsh-cli', 'headless-profile', 'home', 'model', 'route',
]

const dirs = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'bf-diag-'))
  dirs.push(d)
  return d
}

after(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 清理失败不掩盖结果 */ }
  }
})

/* ───────────────────────── 假 env ───────────────────────── */

const baseConfig = () => ({
  modelProvider: '', modelName: '', modelReasoningEffort: '',
  dutyTools: [], headlessProfile: 'headless',
})

/**
 * 造一个「全部就绪」的假 env，再按用例覆盖。
 * 只把路径记进 exists 集合（不真建文件），家目录用临时目录真写探针。
 */
function makeEnv(patch = {}) {
  const root = tempDir()
  const pluginHome = join(root, 'plugin-home')
  mkdirSync(pluginHome, { recursive: true })
  const paths = {
    projectRoot: root,
    python: join(root, '.venv', 'bin', 'python'),
    mcpServer: join(root, 'mcp_server.py'),
    credential: join(root, 'bili_credential.json'),
    home: pluginHome,
    logFile: join(pluginHome, 'duty.log'),
    ledgerFile: join(pluginHome, 'ledger.jsonl'),
    outDir: join(pluginHome, 'out'),
    headlessProfileDir: join(root, '.dsh', 'profiles', 'headless'),
    dshCli: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  }
  const mergedPaths = { ...paths, ...(patch.paths || {}) }
  // 默认「这些默认路径存在」；用例把某路径改成别的（模拟缺失）时自然判为不存在
  const exists = patch.exists || ((p) => [
    paths.python, paths.mcpServer,
    paths.headlessProfileDir, paths.dshCli,
  ].includes(p))
  const env = {
    platform: process.platform,
    paths: mergedPaths,
    config: { ...baseConfig(), ...(patch.config || {}) },
    exists,
    readText: () => null,
    readJson: () => null,
    writeText: (p, text) => {
      try { writeFileSync(p, String(text), 'utf8'); return true } catch { return false }
    },
    removeFile: (p) => { try { rmSync(p, { force: true }) } catch { /* 兜住 */ } },
    // 假 python：--version → 3.11.15；-c → 依赖探测 JSON；-m py_compile → 成功
    run: async (_cmd, args = []) => {
      if (args[0] === '--version') return { code: 0, stdout: 'Python 3.11.15\n', stderr: '' }
      if (args[0] === '-c') return { code: 0, stdout: JSON.stringify({ missing: [], optionalMissing: [] }) + '\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    // 假 nav：默认已登录
    fetchJson: async () => ({ status: 200, json: { code: 0, data: { isLogin: true, uname: '小号', mid: 312299788 } } }),
    readCred: () => ({ sessdata: 'sess', bili_jct: 'jct', buvid3: 'buvid', dedeuserid: '312299788' }),
    listProviders: async () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-flash', name: 'deepseek-flash' }],
    selection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
    mcpToolNames: () => ['mcp__bili-fenshen__bili_search', 'mcp__bili-fenshen__bili_like'],
    routeOk: true,
    ...patch,
  }
  // paths / config 必须是合并后的对象（patch 里可能只改了一个子键）
  env.paths = mergedPaths
  env.config = { ...baseConfig(), ...(patch.config || {}) }
  env.exists = exists
  return env
}

const item = (report, id) => report.items.find((x) => x.id === id)
const depsRunWith = (payload) => async (_cmd, args = []) => {
  if (args[0] === '--version') return { code: 0, stdout: 'Python 3.11.15\n', stderr: '' }
  if (args[0] === '-c') return { code: 0, stdout: JSON.stringify(payload) + '\n', stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

/* ───────────────────────── 顺序 / 结构 / 全通过 ───────────────────────── */

test('CHECK_ORDER 固定 10 项且顺序与契约一致', async () => {
  assert.deepEqual(CHECK_ORDER, EXPECTED_ORDER)
  assert.equal(new Set(CHECK_ORDER).size, 10)

  const report = await runDiagnose(makeEnv())
  assert.deepEqual(report.items.map((x) => x.id), EXPECTED_ORDER)
  assert.equal(report.items.length, 10)
})

test('全部就绪：10 项 pass，ok=true，report 结构完整', async () => {
  const report = await runDiagnose(makeEnv())
  assert.equal(report.ok, true)
  assert.deepEqual(report.summary, { pass: 10, warn: 0, fail: 0 })
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  assert.equal(typeof report.durationMs, 'number')
  assert.ok(report.durationMs >= 0)
  for (const it of report.items) {
    assert.equal(it.status, 'pass', `${it.id} 应该 pass：${it.detail}`)
    assert.equal(it.fix, '', `${it.id} pass 时不该给 fix`)
    assert.equal(typeof it.label, 'string')
    assert.ok(it.label.length > 0)
    assert.equal(typeof it.detail, 'string')
    assert.equal(typeof it.durationMs, 'number')
  }
  // 关键 detail 的人话格式（契约 §1.3 pass 例）
  assert.equal(item(report, 'python').detail, 'Python 3.11.15')
  assert.equal(item(report, 'deps').detail, 'mcp / bilibili_api / aiohttp 均已安装')
  assert.match(item(report, 'mcp-connection').detail, /已注册 2 个 bili 工具/)
  assert.match(item(report, 'credential').detail, /已登录：小号（UID 312299788）/)
  assert.match(item(report, 'model').detail, /deepseek-account \/ deepseek-flash（跟随默认）/)
  assert.equal(item(report, 'route').detail, '已挂载 /api/bili-fenshen')
})

/* ───────────────────────── python / deps / mcp-server ───────────────────────── */

test('python 缺失 → fail，且不影响其余检查', async () => {
  const missing = join(tempDir(), 'no-python')
  const report = await runDiagnose(makeEnv({ paths: { python: missing } }))
  const py = item(report, 'python')
  assert.equal(py.status, 'fail')
  assert.match(py.detail, /不存在/)
  assert.ok(py.fix.includes('venv'))
  assert.equal(item(report, 'route').status, 'pass')
  assert.equal(report.ok, false)
  assert.equal(report.summary.fail, 1)
})

test('python --version 退出码非 0 → fail 并带 detail', async () => {
  const env = makeEnv({
    run: async (_cmd, args = []) => {
      if (args[0] === '--version') return { code: 2, stdout: '', stderr: 'bad interpreter' }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const report = await runDiagnose(env)
  const py = item(report, 'python')
  assert.equal(py.status, 'fail')
  assert.match(py.detail, /bad interpreter/)
})

test('deps 缺必需依赖 → fail；只有可选依赖缺 → warn', async () => {
  const required = await runDiagnose(makeEnv({
    run: depsRunWith({ missing: ['bilibili_api'], optionalMissing: [] }),
  }))
  const d1 = item(required, 'deps')
  assert.equal(d1.status, 'fail')
  assert.match(d1.detail, /bilibili_api/)
  assert.ok(d1.fix.includes('pip'))

  const optional = await runDiagnose(makeEnv({
    run: depsRunWith({ missing: [], optionalMissing: ['qrcode'] }),
  }))
  const d2 = item(optional, 'deps')
  assert.equal(d2.status, 'warn')
  assert.match(d2.detail, /qrcode/)
  assert.ok(d2.fix.includes('pip install qrcode'))
  // warn 不影响整体 ok（契约：ok = fail === 0）
  assert.equal(optional.ok, true)
  assert.equal(optional.summary.warn, 1)
})

test('deps 脚本输出无法解析 → fail 并给 detail', async () => {
  const env = makeEnv({
    run: async (_cmd, args = []) => {
      if (args[0] === '-c') return { code: 0, stdout: 'Traceback: something broken\n', stderr: '' }
      return { code: 0, stdout: 'Python 3.11.15\n', stderr: '' }
    },
  })
  const report = await runDiagnose(env)
  const d = item(report, 'deps')
  assert.equal(d.status, 'fail')
  assert.match(d.detail, /无法解析/)
  assert.ok(d.fix)
})

test('mcp-server 文件缺失 / 编译失败 → fail', async () => {
  const missingEnv = makeEnv()
  missingEnv.exists = (p) => p !== missingEnv.paths.mcpServer
  const missing = await runDiagnose(missingEnv)
  const s1 = item(missing, 'mcp-server')
  assert.equal(s1.status, 'fail')
  assert.match(s1.detail, /不存在/)
  assert.ok(s1.fix.includes('cordis.patch.yml'))

  const compileFail = await runDiagnose(makeEnv({
    run: async (_cmd, args = []) => {
      if (args[0] === '--version') return { code: 0, stdout: 'Python 3.11.15\n', stderr: '' }
      if (args[0] === '-c') return { code: 0, stdout: '{"missing":[],"optionalMissing":[]}', stderr: '' }
      return { code: 1, stdout: '', stderr: 'SyntaxError: invalid syntax' }
    },
  }))
  const s2 = item(compileFail, 'mcp-server')
  assert.equal(s2.status, 'fail')
  assert.match(s2.detail, /编译失败/)
  assert.match(s2.detail, /SyntaxError/)
})

/* ───────────────────────── MCP 连接 ───────────────────────── */

test('mcp-connection 没有 bili 工具 → fail', async () => {
  const report = await runDiagnose(makeEnv({ mcpToolNames: () => ['mcp__other__x'] }))
  const it = item(report, 'mcp-connection')
  assert.equal(it.status, 'fail')
  assert.match(it.detail, /没有 bili 工具/)
  assert.ok(it.fix.includes('重启 DSH'))
})

test('mcp-connection 工具列表为空 → fail', async () => {
  const report = await runDiagnose(makeEnv({ mcpToolNames: () => [] }))
  assert.equal(item(report, 'mcp-connection').status, 'fail')
})

/* ───────────────────────── 凭证 ───────────────────────── */

test('credential 文件缺失 → warn（不是 fail）', async () => {
  const report = await runDiagnose(makeEnv({ readCred: () => null }))
  const it = item(report, 'credential')
  assert.equal(it.status, 'warn')
  assert.match(it.detail, /没有 B 站登录凭证/)
  assert.ok(it.fix.includes('扫码'))
  assert.equal(report.ok, true)
})

test('credential nav 未登录 → warn 且给扫码 fix（只有未登录/过期才给 fix）', async () => {
  const report = await runDiagnose(makeEnv({
    fetchJson: async () => ({ status: 200, json: { code: -101, data: { isLogin: false } } }),
  }))
  const it = item(report, 'credential')
  assert.equal(it.status, 'warn')
  assert.match(it.detail, /过期|未登录/)
  assert.ok(it.fix.includes('扫码'))
})

test('credential fetchJson 立即 throw → warn、无 fix、不影响其余项', async () => {
  const report = await runDiagnose(makeEnv({
    fetchJson: async () => { throw new Error('ECONNRESET') },
  }))
  const it = item(report, 'credential')
  assert.equal(it.status, 'warn')
  assert.equal(it.detail, '连接 B站 失败/超时（网络或风控原因，稍后再试）')
  assert.equal(it.fix, '')
  assert.equal(item(report, 'python').status, 'pass')
  assert.equal(report.ok, true)
})

test('credential fetchJson 挂起 → 内部短超时转 warn（不被单项总超时判 fail）', async () => {
  // withTimeout 的定时器是 unref 的，不持有事件循环；裸跑测试进程里若不保活，
  // loop 会被抽干，node:test 直接取消本用例及之后所有用例。
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    const env = makeEnv({ fetchJson: () => new Promise(() => {}) }) // 永远不返回
    const started = Date.now()
    const report = await runDiagnose(env, { timeoutMs: 800 })
    const elapsed = Date.now() - started
    const it = item(report, 'credential')
    assert.equal(it.status, 'warn')
    assert.equal(it.detail, '连接 B站 失败/超时（网络或风控原因，稍后再试）')
    assert.equal(it.fix, '')
    assert.doesNotMatch(it.detail, /检查超时/)
    // 内部预算 = min(5000, 800-200) = 600ms：应明显早于 800ms 单项总超时
    assert.ok(it.durationMs >= 450 && it.durationMs < 800, `durationMs=${it.durationMs}`)
    assert.ok(elapsed < 3000)
    assert.equal(report.ok, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('credential 风控 HTTP 非 2xx → warn 且无扫码 fix', async () => {
  const report = await runDiagnose(makeEnv({
    fetchJson: async () => ({ status: 412, json: { code: -412, message: '请求被拦截' } }),
  }))
  const it = item(report, 'credential')
  assert.equal(it.status, 'warn')
  assert.equal(it.detail, '连接 B站 失败/超时（网络或风控原因，稍后再试）')
  assert.equal(it.fix, '')
})

/* ───────────────────────── dsh-cli / headless-profile / home / route ───────────────────────── */

test('dsh-cli / headless-profile / home / route 缺失或不可用 → fail', async () => {
  const env = makeEnv({ routeOk: false })
  env.exists = (p) => ![
    env.paths.dshCli, env.paths.headlessProfileDir,
  ].includes(p)
  env.writeText = () => false
  const report = await runDiagnose(env)
  for (const id of ['dsh-cli', 'headless-profile', 'home', 'route']) {
    assert.equal(item(report, id).status, 'fail', `${id} 应该 fail`)
    assert.ok(item(report, id).fix.length > 0, `${id} fail 时必须有 fix`)
  }
})

/* ───────────────────────── 模型 ───────────────────────── */

test('model：插件配置的 provider/model 都在目录里 → pass（标「插件配置」）', async () => {
  const report = await runDiagnose(makeEnv({
    config: { modelProvider: 'deepseek-account', modelName: 'deepseek-flash' },
  }))
  const it = item(report, 'model')
  assert.equal(it.status, 'pass')
  assert.match(it.detail, /deepseek-account \/ deepseek-flash（插件配置）/)
  assert.equal(it.fix, '')
})

test('model：配置了不存在的模型 → fail，detail 带可用模型', async () => {
  const report = await runDiagnose(makeEnv({
    config: { modelProvider: 'deepseek-account', modelName: 'gpt-not-exist' },
  }))
  const it = item(report, 'model')
  assert.equal(it.status, 'fail')
  assert.match(it.detail, /gpt-not-exist/)
  assert.match(it.detail, /deepseek-flash/)
  assert.ok(it.fix.includes('模型'))
})

test('model：selection 为空且没配置 → fail', async () => {
  const report = await runDiagnose(makeEnv({ selection: () => null }))
  const it = item(report, 'model')
  assert.equal(it.status, 'fail')
  assert.match(it.detail, /没有默认模型|既没有配置模型/)
})

test('model：listModels 拉取失败 → warn 不 fail', async () => {
  const report = await runDiagnose(makeEnv({
    config: { modelProvider: 'deepseek-account', modelName: 'deepseek-flash' },
    listModels: async () => { throw new Error('network down') },
  }))
  const it = item(report, 'model')
  assert.equal(it.status, 'warn')
  assert.match(it.detail, /列表拉取失败/)
  assert.equal(report.ok, true)
})

/* ───────────────────────── 超时 / 抛异常 ───────────────────────── */

test('单项超时 → 该 fail「超时」，其余项不受影响', async () => {
  // 同上：unref 定时器不持有事件循环，裸跑时需要保活兜底
  const keepAlive = setTimeout(() => {}, 5_000)
  try {
    const env = makeEnv({
      run: async (_cmd, args = []) => {
        if (args[0] === '--version') return new Promise(() => {}) // 永不返回
        if (args[0] === '-c') return { code: 0, stdout: '{"missing":[],"optionalMissing":[]}', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    const started = Date.now()
    const report = await runDiagnose(env, { timeoutMs: 40 })
    const elapsed = Date.now() - started
    const py = item(report, 'python')
    assert.equal(py.status, 'fail')
    assert.match(py.detail, /超时/)
    assert.ok(py.fix)
    assert.ok(py.durationMs >= 30, `durationMs=${py.durationMs}`)
    assert.ok(elapsed < 2000)
    // 一项超时不影响其余
    assert.equal(item(report, 'deps').status, 'pass')
    assert.equal(item(report, 'route').status, 'pass')
    assert.equal(report.summary.fail, 1)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('单项抛异常 → fail 并产出 item，不炸整轮', async () => {
  const report = await runDiagnose(makeEnv({
    mcpToolNames: () => { throw new Error('boom') },
  }))
  const it = item(report, 'mcp-connection')
  assert.equal(it.status, 'fail')
  assert.match(it.detail, /检查出错/)
  assert.match(it.detail, /boom/)
  assert.equal(report.items.length, 10)
  assert.equal(item(report, 'python').status, 'pass')
  assert.equal(report.ok, false)
})

/* ───────────────────────── summary / ok 规则 ───────────────────────── */

test('summary 统计与 ok 规则：有 warn 仍 ok，有 fail 才不 ok', async () => {
  const oneWarn = await runDiagnose(makeEnv({ readCred: () => null }))
  assert.deepEqual(oneWarn.summary, { pass: 9, warn: 1, fail: 0 })
  assert.equal(oneWarn.ok, true)

  const oneFail = await runDiagnose(makeEnv({ routeOk: false }))
  assert.deepEqual(oneFail.summary, { pass: 9, warn: 0, fail: 1 })
  assert.equal(oneFail.ok, false)
})

/* ───────────────────────── formatDiagnoseText ───────────────────────── */

test('formatDiagnoseText 含汇总与失败项 / 修复建议', async () => {
  const report = await runDiagnose(makeEnv({ routeOk: false, readCred: () => null }))
  const text = formatDiagnoseText(report)
  assert.match(text, /通过 8 项/)
  assert.match(text, /警告 1 项/)
  assert.match(text, /失败 1 项/)
  assert.match(text, /控制台路由/)
  assert.match(text, /修复：/)
  assert.match(text, /B 站登录凭证/)
})

test('formatDiagnoseText 对空报告 / 全通过报告兜底', async () => {
  assert.equal(formatDiagnoseText(null), '诊断报告为空')
  const text = formatDiagnoseText(await runDiagnose(makeEnv()))
  assert.match(text, /一切正常/)
  assert.match(text, /通过 10 项/)
  assert.doesNotMatch(text, /修复：/)
})
