# 2026-10-25 · 模型配置 / 一键诊断 / 控制台实时运行视图

本文件是**实现契约**（Lead 与 3 名 teammate 的共同依据）。仓库根：`/Users/yaemiko/Projects/bilibiliplayer`，
插件目录：`dsh-plugin/`。所有改动都在 `dsh-plugin/` 内，纯 ESM JavaScript，无新增 npm 依赖、无构建步骤。

## 0. 背景

现有插件 `dsh-bili-fenshen` 0.4.0（Host `index.js` + Client `client.js` + `lib/*.js` + 测试）已经在桌面版 profile
（`~/.dsh/profiles/desktop`，link 安装）里运行。三块新需求：

1. **模型配置**：值班轮（headless dsh 子进程）目前「跟随当前会话默认模型」，需要在插件配置里显式指定
   provider / model / reasoningEffort，留空则仍跟随默认。
2. **一键诊断**：插件安装后一键检查「能不能正常运转 + 依赖是否完备」（Python venv/依赖、MCP server、
   MCP 连接、B 站凭证、dsh CLI、headless profile、家目录可写、模型可用、HTTP 路由）。
3. **控制台实时运行视图**：跑值班轮的过程中，在控制台实时看到进度（阶段、耗时、工具调用、
   原始输出流、配额、结束状态）。

## 1. 共享契约（谁都不许改，除非 Lead 在会话里宣布）

### 1.1 配置字段（`lib/config.js` FIELDS + `index.js` Config schema）

新增 3 个字符串字段（默认 `''`）：

| 字段 | 含义 |
|---|---|
| `modelProvider` | 值班轮 provider id；空 = 跟随默认 |
| `modelName` | 值班轮 model id；空 = 跟随默认 |
| `modelReasoningEffort` | 推理强度 id（如 `high`）；空 = 不改 |

规则：`modelProvider && modelName` 都非空 ⇒ 用配置的模型；否则用 `agentDefaultModel.currentSelection()`。
`modelReasoningEffort` 非空时写进 overlay 的 `agent-default-model` config。
「跟随默认」模式下也会把当前 selection 的 `reasoningEffort`（若有）一并带进 overlay；`start()` 不清 `lastCode`（运行中显示上一轮结果）。

> **2026-10-25 修订（事故后）**：写 overlay 前先按模型能力校验推理强度——
> 模型 `resolveModelInfo(provider, model).reasoning.efforts` 不含该值时（典型：`huoshan / glm-5-3-flash-260828` 无推理强度，
> 而配置里残留了上一模型的 `high`），headless dsh 会在派发前抛 `dsh: UNSUPPORTED_REASONING_EFFORT` 并整轮退出。
> 处理：**不设置该项**（不写进 overlay），其余照旧；不做降级/替代/自动改选。
> 实现：`lib/config.js#pickReasoningEffort` + `index.js#resolveEffectiveModel`（`runDuty` 已改为 async，spawn 前 await 能力查询）。

### 1.2 HTTP 端点（都挂在 `/api/bili-fenshen` 下）

#### GET `/models`
```json
{
  "ok": true,
  "selection": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "high" },
  "effective": { "mode": "default", "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "high" },
  "config": { "modelProvider": "", "modelName": "", "modelReasoningEffort": "" },
  "providers": [ { "id": "deepseek-account", "name": "DeepSeek" } ],
  "models": { "deepseek-account": [ { "id": "deepseek-flash", "name": "deepseek-flash" } ] },
  "reasoningEfforts": [ { "id": "high", "name": "High", "description": "" } ],
  "warnings": [ "某个 provider 拉模型失败：xxx" ]
}
```
- `effective.mode`：`"config"`（用了配置的模型）或 `"default"`（跟随默认）。
- `reasoningEfforts` 来自 `llm.resolveModelInfo(provider, model)` 的 `reasoning.efforts`，取不到 = `[]`。
- provider 的模型列表用 `llm.listModels(id)`，单个失败不影响整体（进 `warnings`）。

#### POST `/diagnose`
```json
{
  "ok": true,
  "generatedAt": "2026-10-25T01:02:03.000Z",
  "durationMs": 1234,
  "summary": { "pass": 9, "warn": 1, "fail": 0 },
  "items": [
    { "id": "python", "label": "Python 解释器", "status": "pass",
      "detail": "Python 3.11.15", "fix": "", "durationMs": 42 }
  ]
}
```
- `status` ∈ `pass | warn | fail`；`ok = summary.fail === 0`。
- `items` 顺序固定：`python, deps, mcp-server, mcp-connection, credential, dsh-cli, headless-profile, home, model, route`。

#### GET `/live?after=<seq>`
```json
{
  "ok": true,
  "running": true,
  "roundId": "2026-10-25T01:00:00.000Z",
  "startedAt": "2026-10-25T01:00:00.000Z",
  "elapsedMs": 61234,
  "why": "web",
  "lastCode": null,
  "lastDurationMs": null,
  "phase": { "key": "watch", "label": "看内容" },
  "cursor": 128,
  "events": [
    { "seq": 101, "t": "2026-10-25T01:00:12.000Z", "kind": "tool", "tool": "bili_subtitle", "text": "→ bili_subtitle" }
  ],
  "stats": { "events": 28, "tools": { "bili_search": 1 }, "actions": { "like": 0, "comment": 0, "dynamic": 0, "reply": 0 }, "errors": 0 },
  "quota": { "picked": 1, "comments": 0, "likes": 0, "dynamics": 0,
             "limits": { "perDay": 5, "commentsPerDay": 5, "likesPerDay": 10, "dynamicsPerDay": 1, "repliesPerRound": 2 } }
}
```
- `events` 只含 `seq > after`（最多 200 条，老的先丢）。
- `cursor` = **缓冲里最新的 seq**（不是本响应过滤后的最后一条）：`after` 超前时 `events:[]` 但 `cursor` 仍是缓冲最新值，客户端据此不会重复拉；从未跑过 / `reset()` 后缓存为空才是 0。
- `kind` ∈ `host | tool | reasoning | error | text | state`。
- 空闲时 `running:false`，`lastCode/lastDurationMs` 为上一轮结果（没跑过则 null），且**保留上一轮最后一批 events**（供界面回看；`reset()` 才清空）。运行中 `lastCode/lastDurationMs` 也保留上一轮值（`start()` 不清），便于显示「上一轮 code」。

#### GET `/live/stream`（SSE，`text/event-stream`）
连接建立后：
```
data: {"type":"snapshot","snapshot":{ ...同 GET /live 的字段（含 quota） }}

data: {"type":"event","frame":{"seq":129,"t":"...","kind":"tool","tool":"bili_search","text":"→ bili_search"}}

data: {"type":"snapshot","snapshot":{ ...轮次开始/结束后的整体状态 }}

: ping
```
- 每条 `data:` 一行 JSON + 两个 `\n`；心跳 `: ping\n\n` 每 15s。
- 客户端断开（`req.on('close')`）必须清理监听器与定时器；连接数上限 4，超出直接 503 JSON。
- SSE 里 `snapshot` 与 GET `/live` 响应体一致（可带 `quota`）。

### 1.3 `lib/diagnose.js`（纯逻辑 + 注入 env，不 import 宿主任何东西）

```js
export const CHECK_ORDER = ['python', 'deps', 'mcp-server', 'mcp-connection',
  'credential', 'dsh-cli', 'headless-profile', 'home', 'model', 'route']

export async function runDiagnose(env, { timeoutMs = 8000 } = {})
// → { ok, generatedAt, durationMs, summary:{pass,warn,fail}, items:[{id,label,status,detail,fix,durationMs}] }

export function formatDiagnoseText(report)  // 给 Agent 工具用的纯文本摘要（可选，但建议有）
```

`env` 形状（index.js 负责装配真实实现，测试注入假的）：

```js
{
  platform: 'darwin',
  paths: {
    projectRoot, python, mcpServer, credential, home, logFile, ledgerFile, outDir,
    headlessProfileDir, dshCli,
  },
  config: { modelProvider, modelName, modelReasoningEffort, dutyTools, headlessProfile },
  exists(p) -> boolean,
  readText(p) -> string | null,
  readJson(p) -> any | null,
  writeText(p, text) -> boolean,
  removeFile(p) -> void,
  run(cmd, args, opts) -> Promise<{ code, stdout, stderr, error? }>,   // spawn 捕获，opts={timeoutMs,cwd,env}
  fetchJson(url, opts) -> Promise<{ status, json }>,                    // 网络失败必须 throw
  readCred() -> { sessdata, bili_jct, buvid3, dedeuserid } | null,
  listProviders() -> Promise<Array<{ id, name }>>,
  listModels(provider) -> Promise<Array<{ id, name }>>,
  selection() -> { provider, model, reasoningEffort } | null,
  mcpToolNames() -> string[],
  routeOk: boolean,
}
```

检查项规格（`detail` 写人话，`fix` 只在该项非 pass 时有值）：

| id | label | 逻辑 | pass 例 | 非 pass |
|---|---|---|---|---|
| python | Python 解释器 | `exists(paths.python)` 且 `run(python,['--version'])` code 0 | `Python 3.11.15` | fail：缺失/不可执行；fix 指向重建 venv |
| deps | Python 依赖 | `run(python,['-c', SCRIPT])`，SCRIPT 打印 JSON `{missing:[], optionalMissing:[]}`（required: mcp,bilibili_api,aiohttp；optional: qrcode） | `mcp / bilibili_api / aiohttp 均已安装` | 有 required 缺失 → fail；仅 optional 缺失 → warn（二维码降级） |
| mcp-server | MCP Server 文件 | `exists(mcpServer)` 且 `run(python,['-m','py_compile',mcpServer])` code 0 | `mcp_server.py 可编译` | fail；fix 指向 cordis.patch.yml args |
| mcp-connection | MCP 连接 | `mcpToolNames()` 里含 `mcp__bili-fenshen__` 前缀工具 | `已注册 28 个 bili 工具` | fail；fix 指重启 DSH / 检查 bili-fenshen-mcp 行 |
| credential | B 站登录凭证 | `readCred()` 存在；用 cookie 请求 `https://api.bilibili.com/x/web-interface/nav` → `data.isLogin` | `已登录：<uname>（UID <mid>）` | 文件缺失/未登录/过期 → warn（fix：控制台重新扫码）；网络失败 → warn |
| dsh-cli | dsh CLI | `paths.dshCli` 非空且 `exists` | 路径 | fail；fix 指配置 dshBin |
| headless-profile | headless profile | `exists(headlessProfileDir)` | 目录路径 | fail；fix 指先建/跑一次 headless |
| home | 家目录可写 | 向 `join(home,'.diagnose-probe')` 写再删 | 路径 | fail；fix 指权限 |
| model | 模型可用 | 配置的 provider/model 或 `selection()` 非空；provider 在 `listProviders()` 里；配置了 model 时 `listModels(provider)` 里能找到（列表拉取失败 → warn 不 fail） | `deepseek-account / deepseek-flash（跟随默认）` 或 `（插件配置）` | 全空/不在目录 → fail；fix 指配置模型 |
| route | 控制台路由 | `env.routeOk === true` | `已挂载 /api/bili-fenshen` | fail；fix 指重启 DSH |

实现要求：每项独立 try/catch + 单项超时（默认 8000ms，标记 fail「超时」），一项炸不影响其余；
`Promise.all` 并行；未知异常也要产出 item。

### 1.4 `lib/live.js`（纯逻辑，不 import 宿主）

```js
export function createLiveStream({ maxEvents = 400, maxTextLen = 400 } = {})
// 状态机 + 环形缓冲。方法：
//   start({ roundId, startedAt, why })        轮次开始（清空事件、重置统计）
//   end({ code, durationMs })                 轮次结束（保留事件供回看）
//   pushHost(text)                            宿主事件（log() 用）
//   pushChildChunk(chunk)                     子进程 stdout/stderr 原始块：按行切、分类、入缓冲
//   push({ kind, text, tool })                直接入事件（自动 seq/t）
//   snapshot(after = 0)                       见 1.2 GET /live（不含 quota，quota 由 index.js 补）
//   onPush(listener) -> unsubscribe           SSE 用；listener 收两种消息：
//     { kind:'event', frame }  新事件帧
//     { kind:'state' }         start()/end()/reset() 状态变化（订阅方自己再调 snapshot()）
//   reset()
// 分类/阶段：
export function classifyLine(line)
// → { kind:'host'|'tool'|'reasoning'|'error'|'text'|'blank', text, tool? }
//   规则：/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/ → host；/^dsh:\s*reasoning:/ 或裸 "reasoning:" → reasoning（后续行沿用？按单行判断）；
//   含 bili_[a-z_]+ → tool（tool=第一个匹配）；/失败|错误|异常|error|Error/ → error；空行 → blank；其余 text。
export function phaseOfTool(tool)
// bili_search|bili_hot_videos|bili_weekly_hot|bili_rank|bili_user_videos|bili_video_info → {key:'find', label:'找内容'}
// bili_subtitle|bili_comments                              → {key:'watch', label:'看内容'}
// bili_like|bili_reply|bili_send_dynamic|bili_received_replies → {key:'act', label:'发言'}
// 其他/未知                                               → {key:'think', label:'思考'}
```
snapshot 的 `phase` 用「最近一个 tool 事件」推导，没有则 `think`。`stats.actions` 映射（严格按此）：
`like` = `bili_like` 次数、`comment` = `bili_reply` 次数、`dynamic` = `bili_send_dynamic` 次数、
`reply` = `bili_received_replies` 次数。
`stats.errors` 计 kind==='error' 事件数；`stats.events` = 缓冲里事件总数。
`elapsedMs`：running 用 `Date.now()-startedAt`，否则用 `end` 记的 `durationMs`（没有则 0）。

### 1.5 客户端 UI（`client.js`，T3 独占）

数据层新增：
- `apiGet('/models')`、`apiPost('/diagnose')`。
- `useLive()`：优先 SSE `EventSource('/api/bili-fenshen/live/stream')`；`EventSource` 不存在或 onerror 时
  降级为轮询 `GET /live?after=<cursor>`（运行中 1000ms / 空闲 5000ms）。返回：
  `{ data:{running,roundId,startedAt,elapsedMs,phase,stats,quota,events,lastCode,lastDurationMs}, mode:'sse'|'poll', error }`
  events 本地按 seq 去重、最多留 300 条。SSE 的 `type:'snapshot'` 覆盖 meta，`type:'event'` 追加 frame。
- 本地秒表：running 时每秒 +1 更新 `elapsedMs` 展示（不依赖服务端刷新）。

新增/改动组件：
1. `Select` 基础组件（原生 `<select className="bf-select">`，token 配色）。
2. `ConfigPane` 新增第一组「模型」：
   - 一行显示「当前生效」：`<Pill>` provider / model / 模式（跟随默认 or 插件配置）。
   - 「跟随当前会话模型」按钮（把 3 个字段清空并保存）。
   - provider 下拉（`/models` 的 providers）、model 下拉（依赖 provider 的 models）、推理强度下拉
     （reasoningEfforts；空项显示「默认」）。加载中显示占位。
   - 提示文案：只影响值班轮（headless 会话），不影响当前对话。
   - provider 有值但 model 空时显示 warn 提示（保存后按跟随默认处理）。
3. `DiagnosePanel({ report, loading, onRun, compact })`：汇总行（✓9 · !1 · ✗0 + 耗时）+ 每项
   status 图标/颜色 + label + detail + fix 小字；`compact` 时只显示 fail/warn 项 + 一行汇总。
   「一键诊断」按钮（loading 时显示「诊断中…」并禁用）。
4. 放置：
   - `ConfigPane`「运行环境」组内加入 `DiagnosePanel` + 按钮。
   - `SettingsEntry`（设置页，用户安装后最先看到）：顶部卡片「安装自检」+ 说明
     「检查插件依赖、MCP 连接、登录与模型是否就绪」+ 一键诊断按钮 + `DiagnosePanel compact`。
   - `Dashboard`：运行中在 DutyBar 后插入 `LiveCard`（运行中 · 已跑 1m23s · 阶段 · 工具/动作统计 +
     最近 5 条事件 + 「打开实时」按钮），空闲不显示。
5. `LivePane`（操作台新 tab「实时」，插到「日志」前）：
   - 头部：运行状态 Pill、本地秒表、阶段、`stats` chips、配额、自动滚动 Switch、「跑一轮/中止」。
   - 主体：事件流（等宽字体，按 kind 配色：tool 蓝 / reasoning 灰 / error 红 / host 紫 / text 常规），
     自动滚到底（用户上滚时暂停自动滚动），空闲时显示上一轮尾部或「空闲中」占位；
     `mode==='poll'` 时显示「降级轮询」小标。
   - 用户点看板「跑一轮」成功后自动切到「实时」tab（ConsolePage 提升 `view`/`pane` 状态）。
6. CSS：全部用 `--dsw-alias-*` token（映射进 `.bf-console` 的局部变量），新增类一律 `bf-` 前缀；
   不 require 任何 `@deepseek-ai/dsh-client-*`；不写 DOM。

### 1.6 `index.js` / `lib/api.js`（Lead 负责）

- Config schema + overlay 用配置模型（§1.1）。
- `/models`、`/diagnose`、`/live`、`/live/stream` 接线（§1.2），`FACTORY_PATHS` 加进组合分发。
- `log()` 同步 `live.pushHost`；spawn 子进程 chunk → `live.pushChildChunk`；start/end 调 `live.start/end`。
- Agent 工具新增 `bili_fenshen_diagnose`（返回 `runDiagnose` 报告 JSON）。
- `/overview` 增加 `model: effective`（供 UI 显示）。
- api.js 的 handler 在 deps 缺 `live`/`diagnose` 时必须优雅降级（不 500），保证老集成测试可跑。

## 2. 文件归属 / 写入范围（避免并发冲突）

| 角色 | 独占写入 |
|---|---|
| host-checks（T1） | `dsh-plugin/lib/diagnose.js`、`dsh-plugin/lib/config.js`、`dsh-plugin/test/diagnose.test.js`、`dsh-plugin/test/config.test.js` |
| live-core（T2） | `dsh-plugin/lib/live.js`、`dsh-plugin/test/live.test.js` |
| client-ui（T3） | `dsh-plugin/client.js`、`dsh-plugin/test/client.render-smoke.mjs` |
| Lead | `dsh-plugin/index.js`、`dsh-plugin/lib/api.js`、`dsh-plugin/package.json`、`dsh-plugin/cordis.patch.yml`、`dsh-plugin/README.md`、本契约 |
| verifier（T4） | `dsh-plugin/test/verify-*.mjs`（只新增，不改别人的） |

不要改其他人的文件；发现契约有问题 → 消息 Lead，不要自行改契约。

## 3. 通用工程要求

- 纯 ESM，Node 内置模块 only；不加依赖、不加构建；与现有代码风格一致（中文注释、`try/catch` 兜死、
  无 console 噪音）。
- 每个新文件必须 `node --check` 通过（ESM 用 `node --check` 即可）。
- 对应测试：`node --test test/<x>.test.js` 全绿；不能联外网、不能写真实家目录（用 `mkdtempSync`）。
- 不要改插件的 `dsh.client`/`files` 清单（Lead 负责），不要运行 `plugin_manager`，不要重启/刷新 DSH，
  不要动 `~/.dsh` 下任何真实数据。
- 不要 git commit / git checkout；Lead 统一审查与提交。
- 完成后回报：改了哪些文件、测试命令与结果、与契约的偏差（如有）、遗留风险。

## 4. 验收（Lead + verifier）

- `npm test`（`node --test test/*.test.js`）全绿；`node test/client.smoke.mjs`、`node test/client.render-smoke.mjs`、
  `node test/index.integration.mjs`、`node test/e2e-fixture.mjs` 全绿。
- Host 重载（toggle off/on）后：`GET /models`、`POST /diagnose`、`GET /live` 真机可用；
  `POST /run` 后 `GET /live` 1 秒内能看到事件增长；SSE 用 `curl -N --max-time 3` 能看到 `data:` 帧。
- 模型配置写入后 `~/.dsh/bili-fenshen/headless-overlay.yml` 里出现对应 `agent-default-model` 条目；
  测试后恢复用户原配置（`modelProvider/modelName/modelReasoningEffort` 清空）。
- 页面刷新后控制台出现「实时」tab、模型组、诊断按钮（无浏览器控制时由用户确认；静态渲染与
  slot 注册由 render-smoke 覆盖）。
