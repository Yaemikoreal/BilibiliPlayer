# 安装与客户端配置

本文把 [README](../README.md) 的「30 秒上手」展开成完整步骤：从零环境到客户端里能看到 28 个工具，含 Windows 与 macOS / Linux 两套命令、ffmpeg、MCP Inspector 调试、凭证说明和常见安装故障。

---

## 0. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Python | **3.10+** | 代码用了 PEP 604 联合类型标注（3.10 起才支持的类型语法），3.9 会直接语法报错 |
| 网络 | 能访问B站 API | 搜索、评论、字幕等全部依赖B站 Web API |
| MCP 客户端 | 支持 **stdio** 传输 | Claude Code / Cursor / Cline / OpenClaw / mcporter 等 |
| ffmpeg | 可选 | 只在「上传视频且未指定封面」时用于自动截帧 |
| Node.js | 可选，18+ | 仅开发时需要：`dsh-plugin` 的 `npm test` 用内置 `node --test`；运行 MCP Server 不需要 Node |

验证 Python 版本：

```bash
python --version      # Windows 也可用: py -3 --version
python3 --version     # macOS / Linux
```

---

## 1. 克隆与虚拟环境

```bash
git clone https://github.com/Yaemikoreal/BilibiliPlayer.git
cd BilibiliPlayer
```

> 下文统一用 `BilibiliPlayer/` 代指项目根目录。所有客户端配置里请把它换成**本机绝对路径**（例如 `/Users/you/Projects/BilibiliPlayer` 或 `E:/code/BilibiliPlayer`），并且路径中尽量避免空格。

### Windows（PowerShell）

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 如果报「禁止运行脚本」，只对当前终端临时放行：
Set-ExecutionPolicy -Scope Process Bypass
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 安装依赖（两端相同）

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

依赖只有三个：`bilibili-api-python`（B站 API 封装）、`aiohttp`（异步 HTTP）、`mcp`（MCP Python SDK）。

### 不想激活虚拟环境？

直接用 venv 里的解释器也行，客户端配置本来就要写它的绝对路径：

```powershell
# Windows
.\.venv\Scripts\python.exe mcp_server.py
```

```bash
# macOS / Linux
./.venv/bin/python mcp_server.py
```

---

## 2. 安装 ffmpeg（可选）

只影响「上传视频但没传 `cover_path`」这一条路径：此时会调用 ffmpeg 截取第 3 秒画面作封面，失败回退第 0 秒；两帧都失败则需要手动指定封面。

```powershell
# Windows
winget install Gyan.FFmpeg
```

```bash
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg

# Fedora
sudo dnf install ffmpeg
```

安装后验证：

```bash
ffmpeg -version
```

如果客户端启动 MCP Server 时环境变量里没有 ffmpeg 的路径，请重启客户端或把 ffmpeg 的 `bin` 目录写入系统 `PATH`。

---

## 3. 接入 MCP 客户端

统一原则：**`command` 指向项目 venv 里的 Python 绝对路径，`args` 指向 `mcp_server.py` 的绝对路径。** 用 venv 里的 Python 可以避免客户端启动时找不到依赖。

### Claude Code

在项目根目录创建 `.mcp.json`。

macOS / Linux：

```json
{
  "mcpServers": {
    "bilibili-mcp": {
      "command": "/path/to/BilibiliPlayer/.venv/bin/python",
      "args": ["/path/to/BilibiliPlayer/mcp_server.py"]
    }
  }
}
```

Windows（注意用双反斜杠或正斜杠）：

```json
{
  "mcpServers": {
    "bilibili-mcp": {
      "command": "E:/path/to/BilibiliPlayer/.venv/Scripts/python.exe",
      "args": ["E:/path/to/BilibiliPlayer/mcp_server.py"]
    }
  }
}
```

### Cursor / Cline

在客户端的 MCP Server 设置里新增一项：

- 传输方式：`stdio`
- `command`：venv 里的 Python 绝对路径
- `args`：`mcp_server.py` 的绝对路径

示例（Windows）：

```text
command: E:\path\to\BilibiliPlayer\.venv\Scripts\python.exe
args:    E:\path\to\BilibiliPlayer\mcp_server.py
```

### OpenClaw / mcporter

```bash
npx mcporter config add bilibili-mcp "/path/to/BilibiliPlayer/.venv/bin/python /path/to/BilibiliPlayer/mcp_server.py"
```

Windows 把前半段换成 `.venv\Scripts\python.exe` 的绝对路径。

### 中文 / 编码问题

如果日志或返回值出现乱码，在客户端配置里给这个 Server 加环境变量（`mcp.json` 支持 `env` 字段）：

```json
{
  "mcpServers": {
    "bilibili-mcp": {
      "command": "/path/to/BilibiliPlayer/.venv/bin/python",
      "args": ["/path/to/BilibiliPlayer/mcp_server.py"],
      "env": { "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8" }
    }
  }
}
```

---

## 4. 首次登录

### 方式一：让 AI 帮你登录（推荐）

1. 客户端里确认能看到 `bili_login` 等工具。
2. 对 AI 说「**登录B站**」。
3. AI 调用 `bili_login`，返回二维码 base64 图片、本地 PNG 路径、终端二维码和扫码 URL（任一方式都能扫），二维码 180 秒有效。
4. 用B站 App 扫码并在手机上确认。
5. AI 轮询 `bili_login_check`，状态变成 `done` 后凭证自动保存。

凭证过期或要换号：调用 `bili_login(force=true)` 强制重新扫码。

### 方式二：命令行扫码

```powershell
# Windows
.\.venv\Scripts\python.exe bili_login.py
```

```bash
# macOS / Linux
./.venv/bin/python bili_login.py
```

按终端提示扫码即可，凭证写入同一份 `bili_credential.json`，MCP Server 直接复用。

### 凭证说明

| 项 | 说明 |
|---|---|
| 默认路径 | 项目根目录 `bili_credential.json` |
| 覆盖方式 | 环境变量 `BILI_CRED_FILE=/your/path/bili_credential.json` |
| 内容 | `sessdata`、`bili_jct`、`buvid3`、`dedeuserid` |
| 写入 | 临时文件 + 原子替换，进程中断不会留下半截 JSON |
| 版本控制 | 已在 `.gitignore` 中，**永远不要提交或分享** |

凭证泄露的处置流程见 [SECURITY.md](../SECURITY.md)。

### 工具白名单（可选）

`BILI_MCP_TOOLS` 是逗号分隔的工具名单：**未设置 = 全量注册 28 个工具**；设置后名单外的工具不会注册，模型根本看不见。

```json
{
  "mcpServers": {
    "bilibili-mcp": {
      "command": "/path/to/BilibiliPlayer/.venv/bin/python",
      "args": ["/path/to/BilibiliPlayer/mcp_server.py"],
      "env": { "BILI_MCP_TOOLS": "bili_hot_videos,bili_search,bili_subtitle,bili_comments" }
    }
  }
}
```

### DSH 插件（可选）

如果用的是 DeepSeek Harness，[dsh-plugin/](../dsh-plugin/) 会把上述工具挂成 `mcp__bili-fenshen__bili_*`，并提供看板 / 操作台控制台。安装步骤见 [dsh-plugin/README.md](../dsh-plugin/README.md)，要点：

1. 编辑 `dsh-plugin/cordis.patch.yml`，把 `command` / `args` / `cwd` 三处绝对路径改成你的项目位置。
2. 执行 `dsh plugin --profile desktop add link:<项目路径>/dsh-plugin`。
3. 重启 DSH，打开左侧栏「B站分身」→ 右上角「重新扫码」。

---

## 5. 验证安装

### 语法检查

```bash
python -m py_compile mcp_server.py bili_login.py
```

无输出即通过。

### 用 MCP Inspector 单独调试

```powershell
# Windows
npx @modelcontextprotocol/inspector .\.venv\Scripts\python.exe mcp_server.py
```

```bash
# macOS / Linux
npx @modelcontextprotocol/inspector ./.venv/bin/python mcp_server.py
```

打开 Inspector 面板 → Connect → 在 Tools 里应当看到 **28 个** `bili_*` 工具，逐个可调用。日志输出到 stderr，不会污染 stdio 协议通道。

---

## 6. 常见安装故障

**`ModuleNotFoundError: No module named 'mcp'` / `bilibili_api`**
客户端用的不是装了依赖的那个解释器。把 `command` 改成 `BilibiliPlayer/.venv` 里的 Python 绝对路径，别写系统 `python`。

**Windows 提示「无法加载文件，因为在此系统上禁止运行脚本」**
执行 `Set-ExecutionPolicy -Scope Process Bypass` 后重试；或干脆不激活，直接用 `.\.venv\Scripts\python.exe`。

**`python` 命令不存在 / 指向错误版本**
Windows 试 `py -3`；macOS / Linux 试 `python3`。`python --version` 必须 ≥ 3.10。

**路径里有空格导致启动失败**
把项目放在无空格路径（如 `E:/code/BilibiliPlayer`），或在 `args` 里保持完整绝对路径不要自行拼接。

**客户端重启后工具消失**
确认 `.mcp.json` 在客户端读取的位置（Claude Code 认项目根目录），改完要重启客户端；远程 / WSL 场景要保证 MCP Server 与客户端在同一环境。

**上传视频报「未找到 ffmpeg」**
安装 ffmpeg 并确认 `ffmpeg -version` 在**同一终端环境**可用；或调用时传 `cover_path`。

**登录相关错误**：`no_session` = 扫码会话在内存里，进程重启后丢失，重新 `bili_login`；`already_logged_in` = 已有有效凭证，换号请 `force=true`；接口报错先用 `bili_check_credential` 验活。

---

## 7. 卸载

```bash
# 删除虚拟环境与凭证（凭证请自行确认已失效：B站「退出所有设备」）
rm -rf .venv bili_credential.json qrcode_login.png
```

DSH 插件：在 DSH 里移除 `dsh-bili-fenshen`（具体子命令见 `dsh plugin --help`），并删除家目录数据 `~/.dsh/bili-fenshen/`。
