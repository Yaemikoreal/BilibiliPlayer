/**
 * 一键诊断：纯逻辑 + env 注入（契约 §1.3）。
 *
 * 宿主（index.js）负责把真实能力（子进程、网络、凭证、模型目录……）装配成 env；
 * 本模块只做检查与汇总 ⇒ 不 import 宿主、不直接联网、不写真实家目录，全部可在单测里用假 env 覆盖。
 *
 * 纪律：
 * - 10 项固定顺序并行跑（Promise.all），一项炸掉不影响其余；
 * - 每项独立 try/catch + 独立超时（默认 8000ms，超时记 fail「超时」）；
 * - 未知异常也必须产出一个 item（fail），报告结构永远完整；
 * - detail / fix 一律中文人话，fix 只在非 pass 时给。
 */
import { join } from 'node:path'

const DEFAULT_TIMEOUT_MS = 8000

/** 固定顺序（契约 §1.3；前端与报告都依赖这个顺序） */
export const CHECK_ORDER = [
  'python', 'deps', 'mcp-server', 'mcp-connection', 'credential',
  'dsh-cli', 'headless-profile', 'home', 'model', 'route',
]

/** 每项 label（契约表格里的「label」列） */
const LABELS = {
  python: 'Python 解释器',
  deps: 'Python 依赖',
  'mcp-server': 'MCP Server 文件',
  'mcp-connection': 'MCP 连接',
  credential: 'B 站登录凭证',
  'dsh-cli': 'dsh CLI',
  'headless-profile': 'headless profile',
  home: '家目录可写',
  model: '模型可用',
  route: '控制台路由',
}

const STATUSES = new Set(['pass', 'warn', 'fail'])

// 兜底修复建议：单项超时 / 单项抛异常时用（正常路径上每项都有更具体的 fix）
const FIX_TIMEOUT = '再次运行诊断；若一项持续超时，检查该检查项依赖的服务（子进程/网络）是否卡住，必要时重启 DSH'
const FIX_UNKNOWN = '重新运行诊断；若持续失败，重启 DSH 后再试，并查看插件日志里的报错'
const FIX_PYTHON = '在项目根执行 python3 -m venv .venv 重建虚拟环境，再用 .venv/bin/pip install -r requirements.txt（或 mcp bilibili-api-python aiohttp qrcode）安装依赖'
const FIX_DEPS = '在项目根执行 .venv/bin/pip install mcp bilibili-api-python aiohttp qrcode 安装依赖'
const FIX_CRED = '在控制台「账号」里重新扫码登录（凭证会写入项目根的 bili_credential.json）'
const FIX_DSH_CLI = '在插件配置 dshBin 里填 dsh 的 bin.js 绝对路径（形如 …/@deepseek-ai/dsh/lib/bin.js）'
const FIX_PROFILE = '先手动跑一次 headless profile（dsh --profile headless …）创建目录，或在插件配置里改 headlessProfile'
const FIX_HOME = '检查插件家目录是否存在且当前用户可写（必要时 chmod u+w 该目录）'
const FIX_MODEL = '在控制台「模型」组里选择 provider 与模型，或清空三个模型字段以跟随当前会话默认模型'
const FIX_ROUTE = '重启 DSH，让插件重新注册 /api/bili-fenshen 路由'

// 凭证检查的网络预算：必须明显短于单项总超时（默认 8s），否则挂起的 fetch 会被总超时判成 fail。
// 契约要求「网络失败 → warn」，所以连接/风控类问题一律 warn 且不给扫码 fix（扫码只治未登录/过期）。
const CREDENTIAL_NET_TIMEOUT_MS = 5000
const CREDENTIAL_NET_DETAIL = '连接 B站 失败/超时（网络或风控原因，稍后再试）'
// 风控类业务码：不是真的未登录，按网络/风控处理（warn 不给 fix）
const RISK_CODES = new Set([-352, -412, -509])

/* ───────────────────────── env 小工具 ───────────────────────── */

const errText = (e) => {
  try {
    const msg = e?.stderr ? String(e.stderr) : String(e?.message ?? e ?? '')
    return msg.trim().slice(0, 300) || '未知错误'
  } catch {
    return '未知错误'
  }
}

/** 取 env 上的函数；宿主漏注入时抛中文错误（外层会把它变成一条 fail item） */
const need = (env, name) => {
  const fn = env?.[name]
  if (typeof fn !== 'function') throw new Error(`宿主未注入 ${name}（env.${name} 不可用）`)
  return fn
}

const strOf = (v) => (v === undefined || v === null ? '' : String(v))

/* ───────────────────────── 单项超时 ───────────────────────── */

/**
 * 给一个 Promise 套单项超时：永不 reject，统一返回 {timedOut,result,error}。
 * 超时后原 Promise 即使再 reject 也不会造成未处理拒绝（已被 then 的第二个回调吃掉）。
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { clearTimeout(timer) } catch { /* 兜住 */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    timer.unref?.()
    promise.then(
      (result) => finish({ timedOut: false, result }),
      (error) => finish({ timedOut: false, error }),
    )
  })
}

/* ───────────────────────── Python 依赖检查脚本 ───────────────────────── */

// 由 venv 的 Python 执行并在 stdout 打印一行 JSON：required 缺失 → missing；可选缺失 → optionalMissing
const DEPS_SCRIPT = `
import importlib.util, json
required = ["mcp", "bilibili_api", "aiohttp"]
optional = ["qrcode"]
def missing(names):
    out = []
    for n in names:
        try:
            if importlib.util.find_spec(n) is None:
                out.append(n)
        except Exception:
            out.append(n)
    return out
print(json.dumps({"missing": missing(required), "optionalMissing": missing(optional)}))
`.trim()

/** 容错解析依赖脚本的 stdout（可能混有警告行；从后往前找第一行合法 JSON） */
function parseDepsOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (!text) return null
  const parse = (s) => {
    try {
      const v = JSON.parse(s)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null
      // 两个键都没有 ⇒ 不是我们的脚本输出，按解析失败处理
      if (!('missing' in v) && !('optionalMissing' in v)) return null
      return v
    } catch {
      return null
    }
  }
  const direct = parse(text)
  if (direct) return direct
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = parse(lines[i])
    if (hit) return hit
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) return parse(text.slice(first, last + 1))
  return null
}

const toNameList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).map(String) : [])

/* ───────────────────────── 10 项检查（每项返回 {status, detail, fix?}） ───────────────────────── */

const CHECKS = {
  /** Python 解释器：文件存在 + 能跑 --version */
  async python(env, { timeoutMs }) {
    const py = strOf(env?.paths?.python).trim()
    if (!py) {
      return { status: 'fail', detail: '没有配置 Python 解释器路径（paths.python 为空）', fix: FIX_PYTHON }
    }
    if (!need(env, 'exists')(py)) {
      return { status: 'fail', detail: `Python 解释器不存在：${py}`, fix: FIX_PYTHON }
    }
    const r = await need(env, 'run')(py, ['--version'], { timeoutMs })
    if (r?.error || r?.code !== 0) {
      return {
        status: 'fail',
        detail: `Python 解释器不可执行（退出码 ${r?.code ?? '—'}）：${errText(r?.error || r)}`,
        fix: FIX_PYTHON,
      }
    }
    const text = `${strOf(r?.stdout)}\n${strOf(r?.stderr)}`.trim()
    const m = /Python\s+(\d+\.\d+(?:\.\d+)?)/i.exec(text)
    return { status: 'pass', detail: m ? `Python ${m[1]}` : `Python 解释器可执行（${py}）` }
  },

  /** Python 依赖：required mcp/bilibili_api/aiohttp；optional qrcode */
  async deps(env, { timeoutMs }) {
    const py = strOf(env?.paths?.python).trim()
    if (!py) {
      return { status: 'fail', detail: '没有 Python 解释器，无法检查依赖', fix: FIX_DEPS }
    }
    const r = await need(env, 'run')(py, ['-c', DEPS_SCRIPT], { timeoutMs })
    if (r?.error || r?.code !== 0) {
      const why = r?.error ? errText(r.error) : errText(r)
      return {
        status: 'fail',
        detail: `依赖检查脚本执行失败（退出码 ${r?.code ?? '—'}）：${why}`,
        fix: FIX_DEPS,
      }
    }
    const parsed = parseDepsOutput(r?.stdout)
    if (!parsed) {
      return {
        status: 'fail',
        detail: `依赖检查输出无法解析：${strOf(r?.stdout).trim().slice(0, 200) || '（空输出）'}`,
        fix: FIX_DEPS,
      }
    }
    const missing = toNameList(parsed.missing)
    const optionalMissing = toNameList(parsed.optionalMissing)
    if (missing.length) {
      return { status: 'fail', detail: `缺少必需依赖：${missing.join('、')}`, fix: FIX_DEPS }
    }
    if (optionalMissing.length) {
      return {
        status: 'warn',
        detail: `必需依赖齐全；可选依赖 ${optionalMissing.join('、')} 未安装（登录二维码降级为外链渲染）`,
        fix: `如需在本地生成登录二维码：.venv/bin/pip install ${optionalMissing.join(' ')}`,
      }
    }
    return { status: 'pass', detail: 'mcp / bilibili_api / aiohttp 均已安装' }
  },

  /** MCP Server 文件：存在 + py_compile 通过 */
  async 'mcp-server'(env, { timeoutMs }) {
    const file = strOf(env?.paths?.mcpServer).trim()
    if (!file) {
      return { status: 'fail', detail: '没有配置 MCP Server 文件路径（paths.mcpServer 为空）', fix: '确认项目根有 mcp_server.py，并在 cordis.patch.yml 的 bili-fenshen-mcp 行把 args 指向它' }
    }
    if (!need(env, 'exists')(file)) {
      return { status: 'fail', detail: `MCP Server 文件不存在：${file}`, fix: '确认 mcp_server.py 在项目根；并在 cordis.patch.yml 的 bili-fenshen-mcp 行里把 args 指向它，然后重启 DSH' }
    }
    const py = strOf(env?.paths?.python).trim()
    if (!py) {
      return { status: 'fail', detail: '没有 Python 解释器，无法校验 mcp_server.py', fix: FIX_PYTHON }
    }
    const r = await need(env, 'run')(py, ['-m', 'py_compile', file], { timeoutMs })
    if (r?.error || r?.code !== 0) {
      return {
        status: 'fail',
        detail: `mcp_server.py 编译失败（退出码 ${r?.code ?? '—'}）：${errText(r?.error || r)}`,
        fix: '修正 mcp_server.py 的语法错误后重启 DSH',
      }
    }
    return { status: 'pass', detail: 'mcp_server.py 可编译' }
  },

  /** MCP 连接：工具列表里出现 mcp__bili-fenshen__ 前缀的工具 */
  async 'mcp-connection'(env) {
    const names = need(env, 'mcpToolNames')()
    const list = Array.isArray(names) ? names.map(String) : []
    const bili = list.filter((n) => n.startsWith('mcp__bili-fenshen__'))
    if (bili.length) return { status: 'pass', detail: `已注册 ${bili.length} 个 bili 工具` }
    return {
      status: 'fail',
      detail: list.length
        ? `MCP 连接里没有 bili 工具（当前共 ${list.length} 个工具）`
        : '没有检测到任何 MCP 工具（bili-fenshen 未连接）',
      fix: '重启 DSH；若仍未注册，检查 cordis.patch.yml 的 bili-fenshen-mcp 行（command 要指 venv python，args 要指 mcp_server.py）',
    }
  },

  /** B 站登录凭证：文件存在 + nav 接口 isLogin；网络失败只 warn */
  async credential(env, { timeoutMs }) {
    // 契约：凭证项绝不 fail —— 文件缺失/未登录/过期 → warn + 扫码 fix；网络/超时/风控 → warn 不给 fix。
    let cred
    try {
      cred = need(env, 'readCred')()
    } catch (e) {
      return { status: 'warn', detail: `无法读取 B 站凭证：${errText(e)}`, fix: '' }
    }
    const file = strOf(env?.paths?.credential).trim()
    if (!cred || !cred.sessdata) {
      let fileExists = false
      try { fileExists = file ? !!need(env, 'exists')(file) : false } catch { /* 读不到就当缺失 */ }
      return {
        status: 'warn',
        detail: fileExists
          ? `凭证文件不完整（缺少 SESSDATA）：${file}`
          : `没有 B 站登录凭证（${file || '凭证路径未配置'}）`,
        fix: FIX_CRED,
      }
    }
    const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    // ⭐ 内部网络预算：单项总超时是 8s，这里最多只等 5s（且总比总量短），
    //    保证挂起的 fetch 在总超时之前就变成 warn，而不是被总超时判成 fail。
    const netBudget = Math.max(10, Math.min(CREDENTIAL_NET_TIMEOUT_MS, Math.floor(Number(timeoutMs) - 200)))
    const outcome = await withTimeout(
      Promise.resolve().then(() => need(env, 'fetchJson')('https://api.bilibili.com/x/web-interface/nav', {
        headers: { cookie, 'user-agent': ua },
        timeoutMs: netBudget,
      })),
      netBudget,
    )
    if (outcome.timedOut || outcome.error) {
      // 网络失败/超时/宿主抛错 → 只 warn，且不给扫码 fix（扫码解决不了网络与风控）
      return { status: 'warn', detail: CREDENTIAL_NET_DETAIL, fix: '' }
    }
    const resp = outcome.result
    const status = Number(resp?.status) || 0
    if (status && (status < 200 || status >= 300)) {
      // 非 2xx（412 风控 / 5xx 等）按网络问题处理，不引导扫码
      return { status: 'warn', detail: CREDENTIAL_NET_DETAIL, fix: '' }
    }
    const json = resp?.json
    const data = json?.data || {}
    const code = Number(json?.code)
    if (code === -101 || code === -400) {
      return { status: 'warn', detail: '登录凭证已过期（B 站返回未登录）', fix: FIX_CRED }
    }
    if (RISK_CODES.has(code)) {
      return { status: 'warn', detail: CREDENTIAL_NET_DETAIL, fix: '' }
    }
    if (code !== 0 || data.isLogin !== true) {
      const msg = strOf(json?.message).trim()
      return { status: 'warn', detail: `B 站返回未登录${msg ? `：${msg}` : ''}`, fix: FIX_CRED }
    }
    const uname = strOf(data.uname).trim()
    const mid = strOf(data.mid).trim()
    return {
      status: 'pass',
      detail: uname ? `已登录：${uname}（UID ${mid || '—'}）` : `已登录（UID ${mid || '—'}）`,
    }
  },

  /** dsh CLI：配置了且文件存在 */
  async 'dsh-cli'(env) {
    const cli = strOf(env?.paths?.dshCli).trim()
    if (!cli) {
      return { status: 'fail', detail: '没有找到 dsh CLI（paths.dshCli 为空）', fix: FIX_DSH_CLI }
    }
    if (!need(env, 'exists')(cli)) {
      return { status: 'fail', detail: `dsh CLI 不存在：${cli}`, fix: FIX_DSH_CLI }
    }
    return { status: 'pass', detail: cli }
  },

  /** headless profile：目录存在 */
  async 'headless-profile'(env) {
    const dir = strOf(env?.paths?.headlessProfileDir).trim()
    if (!dir) {
      return { status: 'fail', detail: '没有配置 headless profile 目录（paths.headlessProfileDir 为空）', fix: FIX_PROFILE }
    }
    if (!need(env, 'exists')(dir)) {
      return { status: 'fail', detail: `headless profile 目录不存在：${dir}`, fix: FIX_PROFILE }
    }
    return { status: 'pass', detail: dir }
  },

  /** 家目录可写：写一个探针文件再删掉 */
  async home(env) {
    const home = strOf(env?.paths?.home).trim()
    if (!home) {
      return { status: 'fail', detail: '没有配置插件家目录（paths.home 为空）', fix: FIX_HOME }
    }
    const probe = join(home, '.diagnose-probe')
    const removeFile = need(env, 'removeFile')
    let wrote
    try {
      wrote = need(env, 'writeText')(probe, String(Date.now()))
    } catch (e) {
      return { status: 'fail', detail: `家目录不可写：${home}（${errText(e)}）`, fix: FIX_HOME }
    } finally {
      try { removeFile(probe) } catch { /* 删不掉不影响结论 */ }
    }
    if (!wrote) {
      return { status: 'fail', detail: `家目录不可写：${home}`, fix: FIX_HOME }
    }
    return { status: 'pass', detail: home }
  },

  /** 模型可用：配置的 provider/model 或当前会话默认 selection；配置了模型要在目录里找得到 */
  async model(env) {
    const cfg = env?.config && typeof env.config === 'object' ? env.config : {}
    const cfgProvider = strOf(cfg.modelProvider).trim()
    const cfgModel = strOf(cfg.modelName).trim()
    const useConfig = !!(cfgProvider && cfgModel)

    let providers
    try {
      providers = await need(env, 'listProviders')()
    } catch (e) {
      return { status: 'warn', detail: `无法获取模型 provider 列表：${errText(e)}`, fix: '稍后重新诊断；或在设置里确认模型服务已启用' }
    }
    const providerList = Array.isArray(providers) ? providers.filter((p) => p && p.id) : []
    if (!providerList.length) {
      return { status: 'fail', detail: 'DSH 里没有任何可用的模型 provider', fix: '检查模型服务是否启用（设置 → 模型），然后重启 DSH' }
    }

    let provider = cfgProvider
    let model = cfgModel
    let note = ''
    if (!useConfig) {
      let sel = null
      try { sel = need(env, 'selection')() } catch { sel = null }
      provider = strOf(sel?.provider ?? sel?.providerId).trim()
      model = strOf(sel?.model ?? sel?.modelId).trim()
      if (!provider || !model) {
        return {
          status: 'fail',
          detail: cfgProvider || cfgModel
            ? '插件里只填了 provider/model 的一部分，当前会话也没有默认模型（按契约部分填写视为跟随默认）'
            : '既没有配置模型，当前会话也没有默认模型',
          fix: FIX_MODEL,
        }
      }
      if (cfgProvider && !cfgModel) note = '；插件里已填 provider 但模型为空，按跟随默认处理'
      else if (!cfgProvider && cfgModel) note = '；插件里已填模型但 provider 为空，按跟随默认处理'
    }

    const providerHit = providerList.find((p) => strOf(p.id).trim() === provider)
    if (!providerHit) {
      const ids = providerList.map((p) => strOf(p.id).trim()).filter(Boolean).join('、')
      return {
        status: 'fail',
        detail: `模型 provider「${provider}」不在可用列表里（可用：${ids || '无'}）`,
        fix: FIX_MODEL,
      }
    }

    if (!useConfig) {
      // 跟随默认：provider 在目录里即可（不校验默认模型是否在列表里，避免误报）
      return { status: 'pass', detail: `${provider} / ${model}（跟随默认${note}）` }
    }

    let models
    try {
      models = await need(env, 'listModels')(provider)
    } catch (e) {
      // 列表拉取失败 → warn 不 fail（契约）
      return {
        status: 'warn',
        detail: `${provider} / ${model}（模型列表拉取失败：${errText(e)}）`,
        fix: '稍后重新诊断；若持续失败，检查该 provider 的网络与配置',
      }
    }
    if (!Array.isArray(models)) {
      return { status: 'warn', detail: `${provider} / ${model}（模型列表格式异常）`, fix: '稍后重新诊断；若持续失败，检查该 provider 的配置' }
    }
    const hit = models.some((m) => strOf(m?.id).trim() === model)
    if (!hit) {
      const ids = models.map((m) => strOf(m?.id).trim()).filter(Boolean).slice(0, 12).join('、')
      return {
        status: 'fail',
        detail: `${provider} 下找不到模型「${model}」（可用：${ids || '无'}）`,
        fix: FIX_MODEL,
      }
    }
    return { status: 'pass', detail: `${provider} / ${model}（插件配置）` }
  },

  /** 控制台路由：由宿主告知是否已挂载（routeOk） */
  async route(env) {
    if (env?.routeOk === true) return { status: 'pass', detail: '已挂载 /api/bili-fenshen' }
    return { status: 'fail', detail: 'HTTP 路由未挂载（/api/bili-fenshen 不可用）', fix: FIX_ROUTE }
  },
}

/* ───────────────────────── 单项执行（超时 + 异常兜死 + 归一化） ───────────────────────── */

function normalizeItem(id, raw, durationMs) {
  const label = LABELS[id] || id
  const safeRaw = raw && typeof raw === 'object' ? raw : {}
  const status = STATUSES.has(safeRaw.status) ? safeRaw.status : 'fail'
  const detail = strOf(safeRaw.detail).trim() || (status === 'pass' ? '通过' : '检查未通过')
  // fix 只在非 pass 时给；显式给了空串（如凭证网络问题：扫码治不了）就尊重空串，没给才用兜底建议
  const hasFixKey = Object.prototype.hasOwnProperty.call(safeRaw, 'fix')
  const rawFix = strOf(safeRaw.fix).trim()
  const fix = status === 'pass' ? '' : (rawFix || (hasFixKey ? '' : FIX_UNKNOWN))
  return { id, label, status, detail, fix, durationMs }
}

async function runOne(env, id, timeoutMs) {
  const started = Date.now()
  let outcome
  try {
    const check = CHECKS[id]
    if (typeof check !== 'function') throw new Error(`未实现的检查项：${id}`)
    // Promise.resolve().then(...) 保证 check 同步抛出的异常也走同一个超时/异常通道
    outcome = await withTimeout(Promise.resolve().then(() => check(env, { timeoutMs })), timeoutMs)
  } catch (e) {
    outcome = { timedOut: false, error: e }
  }
  const durationMs = Date.now() - started
  if (outcome.timedOut) {
    return {
      id, label: LABELS[id] || id, status: 'fail',
      detail: `检查超时（超过 ${timeoutMs}ms 没有返回）`, fix: FIX_TIMEOUT, durationMs,
    }
  }
  if (outcome.error) {
    return {
      id, label: LABELS[id] || id, status: 'fail',
      detail: `检查出错：${errText(outcome.error)}`, fix: FIX_UNKNOWN, durationMs,
    }
  }
  return normalizeItem(id, outcome.result, durationMs)
}

/* ───────────────────────── 对外 API ───────────────────────── */

/**
 * 跑一轮完整诊断。
 * @param {object} env 契约 §1.3 的注入环境（宿主装配；测试注入假实现）
 * @param {{timeoutMs?: number}} [opts] 单项超时（默认 8000ms）
 * @returns {Promise<{ok:boolean, generatedAt:string, durationMs:number,
 *   summary:{pass:number,warn:number,fail:number},
 *   items:Array<{id:string,label:string,status:string,detail:string,fix:string,durationMs:number}>}>}
 */
export async function runDiagnose(env, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now()
  const host = env && typeof env === 'object' ? env : {}
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_TIMEOUT_MS
  // 并行跑：runOne 自身永不 reject，这里不需要额外兜底
  const items = await Promise.all(CHECK_ORDER.map((id) => runOne(host, id, limit)))
  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const it of items) summary[it.status] += 1
  return {
    ok: summary.fail === 0,
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    items,
  }
}

const ICONS = { pass: '✅', warn: '⚠️', fail: '❌' }

/**
 * 报告 → 纯文本摘要（给 Agent 工具 / 日志用）。
 * 含汇总行、每项结果；非 pass 项附带 fix。
 */
export function formatDiagnoseText(report) {
  try {
    if (!report || typeof report !== 'object') return '诊断报告为空'
    const s = report.summary && typeof report.summary === 'object' ? report.summary : {}
    const pass = Number(s.pass) || 0
    const warn = Number(s.warn) || 0
    const fail = Number(s.fail) || 0
    const duration = Number(report.durationMs) || 0
    const head = fail === 0 && warn === 0
      ? `B站分身诊断：一切正常（通过 ${pass} 项，耗时 ${duration}ms）`
      : `B站分身诊断：通过 ${pass} 项 · 警告 ${warn} 项 · 失败 ${fail} 项（耗时 ${duration}ms）`
    const lines = [head]
    const items = Array.isArray(report.items) ? report.items : []
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const status = STATUSES.has(it.status) ? it.status : 'fail'
      const label = strOf(it.label || it.id).trim() || '未知检查项'
      const detail = strOf(it.detail).trim()
      lines.push(`${ICONS[status]} ${label}${detail ? `：${detail}` : ''}`)
      if (status !== 'pass' && strOf(it.fix).trim()) lines.push(`   → 修复：${strOf(it.fix).trim()}`)
    }
    return lines.join('\n')
  } catch {
    return '诊断报告格式化失败'
  }
}
