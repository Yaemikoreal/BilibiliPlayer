# bilibili-mcp（本地版）

B站（Bilibili）MCP Server —— 在本地让 AI 助手直接操作B站。

本项目为**纯本地运行的独立项目**：代码、依赖和登录凭证都保存在本机，不需要从远程仓库克隆，也不关联任何远程仓库。除B站 API 外，不依赖其他外部服务。

**27 个工具**，覆盖登录认证、数据采集、内容发布、数据分析、互动运营。

## 功能

### 登录认证（3）

| Tool | 功能 | 说明 |
|------|------|------|
| `bili_login` | 扫码登录 | 生成二维码（base64 图片）；凭证失效时自动重新扫码，传 `force=true` 可强制换号 |
| `bili_login_check` | 登录状态检查 | 轮询扫码状态，确认成功后原子写入凭证 |
| `bili_check_credential` | 凭证验证 | 检查当前登录是否有效，返回 UID、用户名等信息 |

### 数据采集（7）

| Tool | 功能 | 说明 |
|------|------|------|
| `bili_search` | 搜索视频 | 按关键词搜索，支持综合/播放量/最新/弹幕排序，最多 50 条 |
| `bili_comments` | 获取评论 | 获取视频热门评论（按点赞排序），含子评论，最多 100 条 |
| `bili_subtitle` | 获取字幕 | 获取视频 AI 字幕（语音转文字） |
| `bili_danmaku` | 获取弹幕 | 获取视频弹幕列表，最多 1000 条 |
| `bili_video_info` | 视频详情 | 获取播放量、评论数、收藏数、标签等 |
| `bili_reply` | 回复评论 | 发表评论或回复评论（支持楼中楼） |
| `bili_crawl` | 批量采集 | 搜索 + 评论 + 字幕一步到位 |

### 内容发布（5）

| Tool | 功能 | 说明 |
|------|------|------|
| `bili_send_dynamic` | 发图文动态 | 发布文字/图文动态，支持定时发布、话题关联 |
| `bili_upload_video` | 上传视频 | 单P视频上传，支持封面、标签、分区选择 |
| `bili_upload_video_multi` | 多P上传 | 多分P视频合并投稿 |
| `bili_send_opus` | 图文长内容 | 以动态形式发布图文长内容（非独立专栏） |
| `bili_video_zones` | 分区查询 | 获取常用分区 ID，辅助视频上传 |

### 数据分析（6）

| Tool | 功能 | 说明 |
|------|------|------|
| `bili_hot_videos` | 热门视频 | 获取当前B站热门视频列表 |
| `bili_hot_buzzwords` | 热搜关键词 | 获取B站热搜词/热门话题 |
| `bili_weekly_hot` | 每周必看 | 获取每周必看推荐视频 |
| `bili_rank` | 排行榜 | 全站及 24 个分类排行榜（含番剧/国创/纪录片/电影/综艺等） |
| `bili_user_info` | 用户信息 | 获取 UP 主粉丝数、等级、总播放量等 |
| `bili_user_videos` | 用户视频 | 获取 UP 主投稿列表，支持排序和搜索 |

### 互动运营（6）

| Tool | 功能 | 说明 |
|------|------|------|
| `bili_favorite_lists` | 收藏夹列表 | 获取自己或他人的收藏夹 |
| `bili_favorite_content` | 收藏夹内容 | 获取收藏夹内视频，支持搜索 |
| `bili_send_message` | 发私信 | 给指定用户发送文字私信 |
| `bili_unread_messages` | 未读消息 | 获取私信、@、回复、点赞等未读数 |
| `bili_received_replies` | 收到的回复 | 获取评论回复通知 |
| `bili_received_at_and_likes` | @和点赞 | 获取 @ 提及和点赞通知 |

## 环境要求

- **Python 3.10+**
- **ffmpeg**（仅上传视频时自动截取封面需要，可选）
- 能正常访问B站 API 的网络环境
- 支持 MCP 的客户端：Claude Code / Cursor / Cline / OpenClaw 等

## 本地安装

进入项目目录后创建虚拟环境：

```bash
cd /path/to/BilibiliPlayer
python -m venv .venv
```

激活虚拟环境：

**Windows（PowerShell）**

```powershell
.\.venv\Scripts\Activate.ps1
```

如果提示“禁止运行脚本”，可先对当前终端临时放行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

**macOS / Linux**

```bash
source .venv/bin/activate
```

安装依赖：

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

如果不想激活虚拟环境，也可以直接用虚拟环境里的 Python：

```powershell
# Windows
.\.venv\Scripts\python.exe mcp_server.py
```

```bash
# macOS / Linux
./.venv/bin/python mcp_server.py
```

安装 ffmpeg（可选）：

```powershell
# Windows
winget install Gyan.FFmpeg
```

```bash
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt install ffmpeg
```

安装后可用 `ffmpeg -version` 验证。

## 登录与凭证

### 方式一：通过 MCP 客户端登录（推荐）

1. 按下方说明把本地 MCP Server 接入客户端。
2. 对 AI 说“登录B站”。
3. AI 调用 `bili_login`，返回二维码图片（base64）、本地图片文件、终端二维码和扫码 URL。
4. 用B站 App 扫码并在手机上确认。
5. AI 轮询 `bili_login_check`，返回 `done` 后凭证自动保存。

凭证过期或需要换号时，调用 `bili_login(force=true)` 强制重新扫码。

### 方式二：本地命令行登录

```bash
python bili_login.py
```

按终端提示用B站 App 扫码即可。

### 凭证说明

- 凭证默认保存在项目根目录的 `bili_credential.json`。
- 文件仅包含 `sessdata`、`bili_jct`、`buvid3`、`dedeuserid`。
- 已在 `.gitignore` 中忽略，不会进入版本库。
- 写入采用临时文件 + 原子替换，避免进程中断留下半截 JSON。
- **不要提交、分享或上传该文件。** 如曾进入 git 历史，仅删除文件不够，需要重写历史，并在B站“退出所有设备”或修改密码使旧会话失效。

## 接入 MCP 客户端

统一原则：`command` 指向项目虚拟环境里的 Python，`args` 指向 `mcp_server.py` 的**绝对路径**。使用 venv 里的 Python 可以避免客户端启动时找不到依赖。

### Claude Code

在项目目录创建 `.mcp.json`。

Windows：

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

### Cursor / Cline

在客户端的 MCP Server 设置中新增一项，传输方式选 `stdio`：

- **command**：venv 里的 Python 绝对路径
- **args**：`mcp_server.py` 的绝对路径

例如 Windows：

```text
command: E:\path\to\BilibiliPlayer\.venv\Scripts\python.exe
args:    E:\path\to\BilibiliPlayer\mcp_server.py
```

### OpenClaw / mcporter

```bash
npx mcporter config add bilibili-mcp "/path/to/BilibiliPlayer/.venv/bin/python /path/to/BilibiliPlayer/mcp_server.py"
```

Windows 使用 `.venv\Scripts\python.exe` 的绝对路径。

## 本地调试

检查语法：

```bash
python -m py_compile mcp_server.py bili_login.py
```

用 MCP Inspector 调试：

Windows：

```powershell
npx @modelcontextprotocol/inspector .\.venv\Scripts\python.exe mcp_server.py
```

macOS / Linux：

```bash
npx @modelcontextprotocol/inspector ./.venv/bin/python mcp_server.py
```

日志输出到 stderr，不会污染 stdio 协议通道。

## 使用示例

接入后可以直接用自然语言操作：

- “登录B站”（AI 会展示二维码给你扫）
- “搜索B站上关于 AI Agent 的热门视频”
- “获取这个视频的评论，分析用户需求”
- “获取视频字幕，总结视频内容”
- “帮我回复这条评论”
- “批量采集 AI Agent 相关视频的评论和字幕”
- “帮我发一条B站动态，配上这几张图片”
- “把这个视频上传到B站科技区”
- “看看B站现在什么最火”
- “获取科技区排行榜前10的视频”
- “分析这个UP主的粉丝和投稿数据”
- “我有多少未读私信和回复？”
- “看看我的收藏夹里有什么”

上传视频、封面的路径必须是**本机路径**，因为 MCP Server 运行在你自己的机器上。

## 项目结构

```text
BilibiliPlayer/
├── mcp_server.py          # MCP Server 主文件（27 个工具）
├── bili_login.py          # 命令行扫码登录（备用）
├── requirements.txt       # Python 依赖
├── README.md              # 项目说明
├── LICENSE                # MIT 协议
├── .gitignore             # 忽略凭证、二维码和虚拟环境
├── bili_credential.json   # 登录后自动生成（已忽略）
└── qrcode_login.png       # 登录二维码临时文件（已忽略）
```

## 安全与注意事项

- 凭证只保存在本机，不会上传到任何地方。
- 不要提交 `bili_credential.json`、`qrcode_login.png`，它们已在 `.gitignore` 中。
- 回复评论、发私信、发布动态和上传视频会真实作用于B站账号，请谨慎使用并遵守B站社区规则。
- 搜索、评论、弹幕等批量操作自带请求间隔，仍建议控制频率，避免触发风控。
- 上传视频未指定封面时，自动截取视频第 3 秒画面；失败会回退到第 0 秒。两种方式都失败时需要 ffmpeg 或手动传 `cover_path`。
- 本项目仅用于学习和研究。

## 常见问题

**提示“未登录B站”？**

先调用 `bili_login` 生成二维码，扫码后在手机上确认，再轮询 `bili_login_check`。

**凭证过期了，`bili_login` 却返回 `already_logged_in`？**

登录前会自动校验凭证；若仍判断为已登录，调用 `bili_login(force=true)` 强制重新扫码。

**返回 `no_session`？**

进程重启后，内存中的扫码会话会丢失。重新调用 `bili_login` 即可。

**上传视频报“未找到 ffmpeg”？**

安装 ffmpeg 并加入 `PATH`，或直接传入 `cover_path` 指定封面。

**上传失败时返回里的 `last_phase` 是什么？**

表示上传中断时所在的阶段，结合 `error` 排查网络或参数问题。

**接口返回空结果或报错？**

B站接口可能触发风控或需要登录。先用 `bili_check_credential` 验证登录状态，再稍后重试。

## 技术栈

- **[bilibili-api-python](https://github.com/Nemo2011/bilibili-api)** — B站 API 封装库，提供搜索、评论、字幕、弹幕等接口
- **[MCP (Model Context Protocol)](https://modelcontextprotocol.io/)** — 标准化 AI 与工具交互的开放协议
- **[FastMCP](https://github.com/modelcontextprotocol/python-sdk)** — MCP Python SDK，用于构建 MCP Server

## License

MIT
