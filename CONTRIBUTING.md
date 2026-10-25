# 参与贡献

感谢你愿意花时间改进 BilibiliPlayer。这里有两部分：`mcp_server.py` 的 Python MCP Server，和 `dsh-plugin/` 的 DeepSeek Harness 插件。

## 开始之前

- 有 Bug 或功能想法：先搜一遍 [现有 issue](https://github.com/Yaemikoreal/BilibiliPlayer/issues)，避免重复。
- **安全问题**（凭证泄露、注入、权限放大等）：不要开公开 issue，走 [SECURITY.md](./SECURITY.md) 的私密渠道。
- 不要提交 `bili_credential.json`、`qrcode_login.png` 或任何真实账号数据、日志、截图里的 UID。测试请用临时目录（插件侧用 `BILI_FENSHEN_HOME` 指到 `mkdtemp`）。

## 开发环境

```bash
git clone https://github.com/Yaemikoreal/BilibiliPlayer.git
cd BilibiliPlayer

# Python 侧：3.10+，CI 用 3.11
python3 -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 插件侧：纯 ESM，无第三方运行时依赖；npm test 需要 Node 18+（CI 用 Node 20）
cd dsh-plugin
npm test
```

运行侧只需要能连上B站 API 的网络；ffmpeg 仅上传视频且未给封面时需要。

## 测试

提交前请务必跑一遍，本地应当全绿：

```bash
# 1) Python 语法检查（与 CI 的 python job 等价）
python -m py_compile mcp_server.py bili_login.py
python - <<'PY'
import ast, pathlib
for f in sorted(pathlib.Path('.').rglob('*.py')):
    if '.venv' not in f.parts and '__pycache__' not in f.parts:
        ast.parse(f.read_text(encoding='utf-8'), filename=str(f))
print('ok')
PY

# 2) 插件单测（node --test，覆盖 test/*.test.js：账本/报告/活动/配置/回复/api）
cd dsh-plugin && npm test
```

插件还有几个独立验证脚本（不在 `npm test` 的 glob 内，按需手动跑）：

```bash
cd dsh-plugin
node test/index.integration.mjs     # 离线：路由组合 / 工厂端点 / 404 兜底
node test/e2e-fixture.mjs           # 离线：账本 → /activity /seen /log 数据通路
node test/client.smoke.mjs          # 离线：client.js 可加载、槽位注册
node test/client.render-smoke.mjs   # 需要临时安装 react/react-dom（联网）
```

会真实调用B站接口的操作（登录、评论、投稿）不要写进自动测试。

## 代码风格

### Python（`mcp_server.py`、`bili_login.py`）

- **Python 3.10+**：可以用 PEP 604 的 `X | None`；不要引入需要 3.12+ 的语法。
- 新工具一律用 `@_gated_tool()` 注册，而不是 `@mcp.tool()` —— 白名单门禁（`BILI_MCP_TOOLS`）依赖这层包装，绕过它会让最小授权失效。
- 统一的返回约定：成功走 `_ok({...})`，失败走 `_err("原因", **上下文)`，返回值是 JSON 字符串（`ensure_ascii=False`）。
- 工具函数必须有中文 docstring，写清每个参数的含义、默认值和上限；上限用代码里的钳位显式表达（`max(1, min(num, 100))`）。
- 别把登录凭证写进返回值或日志；日志只走 `logging`（stderr），`print` 会污染 stdio 协议流。
- 批量请求要保留请求间隔（现有实现为 0.3～1 秒）。

### Node.js（`dsh-plugin/`）

- **纯 ESM**（`"type": "module"`），只 import Node 内置模块和宿主注入的依赖，不要新增 `dependencies`。
- 纯逻辑放 `lib/*.js` 并配单测；`index.js`（Host）只做装配与副作用，`client.js`（Client）只做 UI。
- 测试用 `node:test` + `node:assert`，文件名 `test/*.test.js` 才会被 `npm test` 收进来。
- 涉及文件系统的测试必须先把 `BILI_FENSHEN_HOME` 指向临时目录，别污染真实的 `~/.dsh/bili-fenshen/`。
- 面向用户的文案按语言放 `locale/zh.json`、`locale/en.json`；领域术语统一按 [CONTEXT.md](./CONTEXT.md) 的用词（值班轮 / 章程 / 账本 / 压审……）。

## 添加一个新工具

1. 在 `mcp_server.py` 里用 `@_gated_tool()` 实现，docstring 写全参数。
2. 更新 README 的「29 个工具全览」：数量、分类表格和徽章数字（`tools-29`）要一起改。
3. 如果 DSH 插件需要它，把工具名加进值班白名单相关配置或 `prompts/duty.md` 的说明。
4. 跑 `python -m py_compile mcp_server.py`，确认没破坏语法。

## 提交信息规范

仓库使用 **Conventional Commits，描述用中文**（参考现有历史）：

```text
<type>(<scope>): <中文描述>
```

- `type`：`feat` / `fix` / `docs` / `test` / `refactor` / `style` / `chore`
- `scope`：`mcp` / `host` / `client` / `charter` / `ledger` / `report` / `api` / `config` / `docs` 等

真实例子（取自本仓库历史）：

```text
feat(charter): 新增小号人设（伊蕾娜 / 蓝色大肥鱼），供 personaPrompt 按路径加载
fix(host): 今日配额改按账本事件计数（报告正则无 m 标志导致永远数 0）
test: e2e/集成脚本自清理临时目录
docs(plan): 修正账本轮转与 /seen 解析（均经实跑验证）
```

一次提交只做一件事；描述里写清「改了什么、为什么」，最好带上实际验证结论。

## PR 流程

1. Fork → 从 `main` 拉分支：`git switch -c feat/your-thing`。
2. 按上面的测试清单本地跑绿。
3. PR 描述用仓库模板，说明动机、改动点、验证方式（贴命令与结果）、影响面。
4. 涉及 UI / 控制台的改动，附截图（浅色 / 深色都建议）。
5. CI 会跑 Python 语法检查与插件 `npm test`，全绿后由维护者 review 合并。

新增依赖、改动凭证处理、修改白名单机制属于敏感改动，请在 PR 里单独说明原因。

## 文档贡献

- README 只描述**已合并到 `main`** 的功能；未提交的本地改动不要写进去。
- 图片一律用仓库内相对路径（`assets/`、`docs/demo/shots/`），不要外链图床；徽章可用 `img.shields.io`。
- 安装细节写进 [docs/INSTALL.md](./docs/INSTALL.md)，README 只留最短路径。
