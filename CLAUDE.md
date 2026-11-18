# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

仓库同时是两样东西的家：

1. **bilibili-mcp**（`mcp_server.py`）：单文件 Python MCP Server，FastMCP + stdio，把 B 站 Web API 封装成工具。
2. **dsh-bili-fenshen**（`dsh-plugin/`）：DeepSeek Harness 插件「B站分身」，用上面的工具 + 值班章程 + 人设卡，让 Agent 定时运营一个小号。

目录名叫 BilibiliPlayer 但项目里没有播放器。领域术语统一以 `CONTEXT.md` 为准（值班轮 / 章程 / 账本 / 压审 / 活动 / 剧场…），深入实现见 `docs/ARCHITECTURE.md`。

## 常用命令

```bash
# Python 侧（3.10+，CI 用 3.11）
python -m py_compile mcp_server.py bili_login.py
# CI 等价的全量语法检查（含 scripts/*.py）
python - <<'PY'
import ast, pathlib
for f in sorted(pathlib.Path('.').rglob('*.py')):
    if '.venv' in f.parts or '__pycache__' in f.parts: continue
    ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
print('ok')
PY

# 插件侧（纯 ESM，Node 18+，CI 用 20）
cd dsh-plugin && npm test                       # node --test test/*.test.js
node --test test/ledger.test.js                 # 跑单个测试文件
node test/index.integration.mjs                 # 独立集成脚本，不在 npm test 的 glob 内
node test/e2e-fixture.mjs
node test/client.smoke.mjs

# 单独启动 MCP Server 调试
.venv/Scripts/python.exe mcp_server.py          # Windows
```

Python 侧没有单元测试，CI 只做 `py_compile` + 全量 AST 解析；插件侧才有测试套件。会真实出网写 B 站的操作（登录、评论、投稿）不要写进自动测试。

## 架构

### 数据层 `mcp_server.py`

- 每个工具用 `@_gated_tool()` 注册，**不要用 `@mcp.tool()`**。`BILI_MCP_TOOLS`（逗号分隔）是白名单门禁：名单外的工具根本不注册，模型看不见——值班轮的最小授权依赖这层。
- 当前代码里有 **35 个** `@_gated_tool`；README（29）、插件 README（32）、cordis.patch.yml（28）里的数字都过时了。加工具时以 `grep -c '@_gated_tool' mcp_server.py` 为准，并同步更新 README 徽章/表格。
- 统一返回约定：成功 `_ok({...})`，失败 `_err("原因", **上下文)`，返回 JSON 字符串（`ensure_ascii=False`）。
- 日志只走 `logging`（stderr）；`print` 会污染 stdio 的 JSON-RPC 流。
- 凭证：`bili_credential.json`（已 gitignore），可用 `BILI_CRED_FILE` 覆盖。
- 批量接口保留 0.3～1 秒请求间隔，别去掉。
- 服务端不只有 API 封装：`bili_feed` / `bili_ledger_append` / `bili_report_append` / `bili_persona_lore` / `bili_persona_note` 会直接读写插件的家目录（`BILI_FENSHEN_HOME`，默认 `~/.dsh/bili-fenshen`），是 Python 与 Node 两侧的耦合点。
- 发言前会读取 `<家目录>/persona/lint-rules.json`（由插件 `scripts/export-lint-rules.mjs` 导出）做规则校验——改人设 lint 规则时要意识到 Python 侧在执行同一份规则。
- `bili_login.py` 是命令行扫码登录的备用入口，改凭证逻辑时两处一起看。

### 插件 `dsh-plugin/`

三层严格分工，加代码前先确认属于哪层：

| 文件 | 职责 | 不该做 |
|---|---|---|
| `index.js` | Host：`apply(ctx, config)` 装配、调度 tick、`runDuty` 拉起 headless 值班轮、overlay 生成、账本/报告落盘、`/api/bili-fenshen/*` 路由、3 个宿主工具 | 不直接出网写 B 站 |
| `client.js` | Client：5 页控制台（概览/活动/日报/人设/设置），数据全部来自本机 API | 不持有业务状态 |
| `lib/*.js` | 纯逻辑（账本、排班、聚合、人设、路由工厂、诊断……），`node --test` 覆盖 | 不做 UI、不产生副作用 |

关键机制：

- **账本**：`<家目录>/ledger.jsonl`，一行一个 JSON 事件，append-only，是控制台与配额的唯一事实来源。报告 `out/<日期>.md` 只是给人读的摘要，轮末会从报告兜底回填缺失事件。
- **家目录**：`BILI_FENSHEN_HOME` 覆盖，默认 `~/.dsh/bili-fenshen`；含 `ledger.jsonl`、`config.json`（覆盖层）、`state.json`、`out/`、`duty.log`、`persona/`、`seen.md`。
- **值班轮**：调度到点 → 生成 headless overlay（独立 profile + `BILI_MCP_TOOLS` 白名单）→ spawn `dsh --patch overlay` → Agent 按 `prompts/duty.md` 执行 → 写账本/报告。写操作永远只有一条路：Agent 调 `bili_*` 工具。
- **人设**：运行时事实来源是 `prompts/persona/*.card.json`。`lib/persona/` 把人设卡、今日状态、语料、见闻、体检编译成注入 prompt 的若干块（C1 章程前 / C2 末尾 / C3 生成期提示）；控制台「人设」页是唯一编辑入口。
- **配置**：默认值在 `cordis.patch.yml`，控制台保存写入 `<家目录>/config.json` 覆盖层（逐字段覆盖，不改用户的 patch），保存即热生效。

### 部署注意

- `cordis.patch.yml` 里 `command` / `args` / `cwd` 是硬编码的 Windows 绝对路径，换机器必须改。
- `index.js` 在模块加载时就固定 `HOME` 等路径；测试要在 **import `index.js` 之前** 设好 `BILI_FENSHEN_HOME` 指向临时目录，否则会污染真实数据。

## 代码约定

- Python：中文 docstring；新工具用 `_gated_tool`；参数上限用代码钳位（`max(1, min(num, 100))`）显式表达。
- Node：纯 ESM，只 import Node 内置模块与宿主注入的依赖，**不要新增 `dependencies`**；纯逻辑进 `lib/` 并配 `test/*.test.js`；`node --test` 只收 `test/*.test.js`。
- 面向用户的文案放 `locale/zh.json` / `locale/en.json`。
- 提交信息：Conventional Commits，中文描述，如 `feat(charter): 新增小号人设（…）`；一次提交只做一件事。完整规范见 `CONTRIBUTING.md`。

## 安全红线

- 永不提交 `bili_credential.json`、`qrcode_login.png`、真实账号数据或日志里的 UID。
- 写操作（评论/点赞/私信/动态/投稿）会真实作用于账号；无人值守自动化只建议用小号。
- 工具白名单、提示注入防御、账本/报告保底纪律属于安全边界，改动前单独说明理由。
