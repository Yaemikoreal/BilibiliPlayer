# dsh-bili-fenshen ｜ B站分身

DSH 插件：把本仓库的 [bilibili-mcp](../README.md)（28 个工具）挂载给 DeepSeek Harness 的 Agent，并让它按**值班章程**自动运营一个B站小号——看视频、读字幕、点赞、评论、跟进被回复、发动态，全部先发后报、可配置配额。

## 组成

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | bundle 挂载声明：原生 MCP connection（stdio → 项目 venv 的 `mcp_server.py`）+ Host 插件行 |
| `index.js` | Host 半部：值班调度（手动 + 谷时窗口）、dsh CLI 探测、headless 值班轮（overlay 动态生成）、配额账本、发后复核调度、`/api/bili-fenshen/*` 路由、JS 侧扫码登录 |
| `client.js` | Client 半部：设置页「B站分身」面板（账号状态 / 扫码登录 / 现在跑一轮 / 日报 / 日志） |
| `prompts/duty.md` | 值班章程：内容判据、评论/点赞/动态纪律、提示注入防御红线、`### BV号` 报告契约 |
| `templates/` | DSH 官方模板拷贝（decoration / mcp），仅作开发参考 |

## Agent 工具

安装后 Agent 自动获得两层能力：

- **全量 MCP 工具**（`mcp__bili-fenshen__bili_*`，28 个）：任何 DSH 会话里都能直接用（搜索/字幕/评论/点赞/动态/登录…）
- **宿主工具**：`bili_fenshen_status`（状态与配额）、`bili_fenshen_run`（立即值班一轮）

## 值班机制

1. 到点（或手动触发）→ Host 生成一次性 overlay → `dsh --profile headless --patch overlay "值班提示词"` 拉起独立会话
2. 那一轮只见白名单工具（`BILI_MCP_TOOLS`，默认值班所需的最小集），看不到上传/私信等高权限工具
3. Agent 按章程：拉内容源（热门/搜索/订阅 UP 主）→ 判重 → 读字幕原文 → 决定动作（受配额约束）→ 写报告与判重表
4. 结束 90 秒后宿主复核调度（对抗压审：接口回执成功 ≠ 公开可见）

## 安装（本机自用）

前提：本仓库已 clone 到本地、`.venv` 已建好（`pip install -r requirements.txt`）、DSH 桌面版。

```powershell
# 在 DSH 会话里让 AI 执行，或手动：
#   1. 编辑 dsh-plugin/cordis.patch.yml，把 command/args/cwd 三处路径改成你的项目位置
#   2. 安装 bundle：
dsh plugin --profile desktop add link:<项目路径>/dsh-plugin
#   3. 重启 DSH
```

装完在 **设置 → B站分身**：点「生成登录二维码」→ 手机B站扫码 → 手机上点确认（选「记住我/长期」）→ 面板显示登录成功 → 点「现在跑一轮」。

## 配置

全部配置走 Loader patch 的 `config`（`id: bili-fenshen` 行），关键字段：

`autoDuty`（自动值班总开关，默认关）、`noon`/`night`（谷时窗口）、`perDay` / `commentsPerDay` / `commentsPerRound` / `likesPerDay` / `dynamicsPerDay` / `repliesPerRound`（配额）、`keywords`（搜索关键词）、`followUids`（订阅 UP 主）、`personaPrompt`（人设，留空=中性）、`reportLevel`（full/brief/off）、`dutyTools`（值班轮白名单）、`dshBin`（CLI 路径，留空自动探测）、`headlessProfile`（默认 `headless`）。

## 安全说明

- 凭证只存本机 `bili_credential.json`（已被 [.gitignore](../.gitignore) 排除），路径可用 `BILI_CRED_FILE` 环境变量覆盖
- 值班轮用独立 headless profile + 工具白名单，写操作最小授权
- 章程硬红线：不透露隐私、不冒充真人、不碰争议、同视频只评一次、不刷屏
- 自动化操作有被B站风控的 theoretical 风险，请自担；建议先用小号

## 致谢

值班轮/发后复核/环境自愈等模式移植自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）；bilibili-mcp 上游为 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT）。
