# dsh-bili-fenshen ｜ B站分身

DSH 插件：把本仓库的 [bilibili-mcp](../README.md)（29 个工具）挂载给 DeepSeek Harness 的 Agent，并让它按**值班章程**自动运营一个B站小号——看视频、读字幕、点赞、评论、跟进被回复、发动态，全部先发后报、可配置配额。

## 组成

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | bundle 挂载声明：原生 MCP connection（stdio → 项目 venv 的 `mcp_server.py`）+ Host 插件行 |
| `index.js` | Host 半部：值班调度（手动 + 谷时窗口）、dsh CLI 探测、headless 值班轮（overlay 动态生成）、轮次生命周期（`round-end`/报告兜底回填/中止/心跳自愈）、回复通知轮询、配额账本、`/api/bili-fenshen/*` 路由、JS 侧扫码登录 |
| `lib/*.js` | 纯逻辑模块（`node --test` 覆盖）：账本 JSONL、报告兜底解析、活动聚合、配置覆盖层、回复通知映射、账号拉取、路由工厂、一键诊断（`diagnose.js`）、实时运行流（`live.js`） |
| `client.js` | Client 半部：左侧栏「B站分身」控制台 —— DSH 原生风格 **5 页**（概览 / 活动 / 日报 / 人设 / 设置）；运行详情并入概览、判重表并入活动、人设置 3 子页签、设置 3 组；设置页另含「安装自检」入口 |
| `prompts/duty.md` | 值班章程：内容判据、评论/点赞/动态纪律、提示注入防御红线、`### BV号` 报告契约、账本记账契约 |
| `test/*.test.js` | `npm test`（`node --test`）纯函数单测 |
| `templates/` | DSH 官方模板拷贝（decoration / mcp），仅作开发参考 |

## Agent 工具

安装后 Agent 自动获得两层能力：

- **全量 MCP 工具**（`mcp__bili-fenshen__bili_*`，32 个）：任何 DSH 会话里都能直接用（搜索/字幕/评论/关注列表/点赞/动态/登录…）
- **值班轮专用（宿主侧）**：`bili_feed`（一次拿到常看 UP 主的最新投稿，已按账本标好看过/没看过）、
  `bili_ledger_append`（一次写多条账本事件，宿主补 t/round、校验、去重）、`bili_report_append`（追加本轮报告并校验 round id）
- **宿主工具**：`bili_fenshen_status`（状态与配额）、`bili_fenshen_run`（立即值班一轮）、`bili_fenshen_diagnose`（一键诊断，返回逐项 pass/warn/fail 与修复建议）

## 值班机制

1. 到点（或手动触发）→ Host 生成一次性 overlay → `dsh --profile headless --patch overlay "值班提示词"` 拉起独立会话
2. 那一轮只见白名单工具（`BILI_MCP_TOOLS`，默认值班所需的最小集），看不到上传/私信等高权限工具
3. Agent 按章程：拉内容源（**优先 `bili_feed` 一次拉齐常看 UP 主的最新投稿并已按账本过滤「看过」→ 关键词搜索 → 热门榜兜底**，命中「不看清单」直接跳过）→ 判重 → 读字幕原文 → 决定动作（受配额与禁令开关约束）→ `bili_ledger_append` 记账 + `bili_report_append` 写报告
4. 结束 90 秒后宿主复核调度（对抗压审：接口回执成功 ≠ 公开可见）

## 控制台

装好后左侧栏出现「B站分身」图标（插件 / 自动化任务 旁边）。**5 个页签，每页只回答一个问题**：

- **概览（它在干什么？今天干成了什么？）**：页头 + 状态条（运行/自动值班/下一轮/数据新鲜度）→ **今日产出**（看/赞/评/接话/动态 + 它今天说过的原话）→ **接话**（今日扫描/接/不接理由，未扫描标红）→ **运行详情**（运行中展开：阶段轨、秒表、工具计数、事件流；空闲折叠成一行）→ **配额**（日累计 vs 本轮，6 项 3×2，不再有孤儿瓦片）→ 存在感 / 人设与健康。
- **活动（它看过/说过什么，链路通不通？）**：三视图 `生命周期 / 时间线 / 判重表` + 类型 chips（含「接话」「接话扫描」）+ 搜索；每条视频的链路是「刷到 → 看 → 赞 → 评 → 扫描 → 被回复 → 我回」，接话与跟进回复分开标。
- **日报（那一轮它怎么想的？）**：日期/月度归档/overlay 列表 + Markdown 渲染（h1 降级，页面只有一个 h1）。
- **人设（这个号是谁、说话像不像它？）**：3 子页签 `人设卡 / 素材库 / 预览与质量`；人设卡 = 字段折叠 + 五块预算 + 高级 JSON（折叠）+ **回滚出口（legacy 直通，折叠）**；素材库 = 语料库 + 见闻库；预览与质量 = 编译预览 + L0 六条 + 今日状态 + 版本对比。**人设内容的唯一编辑入口就是这一页。**
- **设置（怎么调它？）**：3 组 `节奏与配额 / 内容与禁令 / 运行环境`（模型、一键诊断、宿主日志）；宿主式行式布局（label 左、控件右），脏标记 + 保存并生效。这里只放**运行参数与默认禁令**——人设内容（身份 / 口吻 / 素材 / 回滚）不在这页，去「人设」。
- **设置 → B站分身**：顶部「安装自检」卡片，一键诊断依赖/MCP 连接/登录/模型是否就绪（安装后先点这个）。

扫码登录在控制台右上角「重新扫码」。

## 一键诊断

两个入口：设置页「安装自检」卡片、控制台「设置 → 配置 → 运行环境 → 一键诊断」；Agent 也可调用 `bili_fenshen_diagnose`。

并行检查 10 项，每项返回 `pass / warn / fail` + 人话说明 + 修复建议：

| 检查 | 说明 |
|---|---|
| Python 解释器 | 项目 `.venv` 里的解释器是否存在且可执行 |
| Python 依赖 | `mcp` / `bilibili_api` / `aiohttp`（必需）、`qrcode`（可选，缺了只是二维码降级） |
| MCP Server 文件 | `mcp_server.py` 存在且可编译 |
| MCP 连接 | 宿主里 `mcp__bili-fenshen__*` 工具是否已注册 |
| B站登录凭证 | 凭证存在且 `nav` 接口返回已登录（missing/过期只 warn，网络异常也只 warn） |
| dsh CLI | 值班轮要 spawn 的 `bin.js` 是否找得到 |
| headless profile | `~/.dsh/profiles/<headlessProfile>` 是否存在 |
| 家目录可写 | 写一个探针文件再删掉 |
| 模型可用 | 插件配置/默认选择的 provider+model 是否在模型目录里 |
| 控制台路由 | `/api/bili-fenshen/*` 是否已挂载 |

## 概览实时（单一信封 + SSE）

概览不再靠「各卡各拉各的」：服务端把一屏要的数字**一次算完**，客户端只维护一个信封。

- `GET /api/bili-fenshen/stream`（SSE）：`hello` → `overview`（完整信封，文件一变/轮次起止/配置保存就推）→ 运行中每 1.5s 一帧 `tick`（秒表/阶段/工具计数）；15s 心跳。
- `GET /api/bili-fenshen/overview`：同一个信封的拉取版（SSE 不可用时降级用），含 `seq / serverTime / dataUpdatedAt / degraded`。
- 客户端 `useRealtime()`：`seq` 单调守卫、`AbortController` 防竞态、断流自动降级轮询（运行中 2s / 空闲 10s）、`window.focus` + `visibilitychange` 立即刷；页头显示**数据新鲜度**（>15s 黄、>60s 红，拉取失败也显形）。
- 运行中的真实进度来自 `lib/live.js`（工具/动作计数），不再等「轮末才写账本」——所以跑着的时候配额、秒表、阶段都会动。
- `round.lastRound` 从账本按 roundId 聚合（不再用 state.json 拼「新开始时间 + 上一轮退出码」）。

事件流（工具/推理/输出逐行）仍走 `GET /api/bili-fenshen/live/stream`，渲染在概览的「运行详情」里。

## 主动接话（每轮硬步骤：扫描 → 可发 0..N 条）

「接话」= 主动回复**别人的**评论进楼中楼。它以前是「可选动作」，模型合法跳过且不留痕迹；现在：

- **扫描必做**：每轮必须从已拉到的热评里评估 ≥1 条，结论写成报告一行 `接话扫描：…` + 账本 `reply-scan` 事件（`decision: posted|skipped`）。不写 = 本轮不合规，宿主会记 `note` 并在概览「接话」卡标红「未扫描」。
- **发不发自由**：可发上限 `replyOthersPerRound`（默认 2，0 = 只扫描不发）；扫描本身不占「工具调用 ≤20」预算，接一条只多 1 次 `bili_reply`。
- **去重靠宿主**：`已接话清单`（近 14 天 `BV→对方 rpid`）随 prompt 注入；同 BV 每轮 ≤1、同一 target 永不重复、同一人 7 天 ≤1。
- **可接三类**：能答清的提问 / 被逗到共鸣 / **轻互动**（被夸、道谢、生日这类，一句就够）。
- 报告解析器会先剥离「接话」段再解析评论段（避免把接话的 rpid/正文误回填成评论），并从报告兜底回填 `reply-scan` / `reply-out(proactive)`。

## 账本

控制台的事实来源是 `<家目录>/ledger.jsonl`（一行一个事件，append-only）。
值班轮按章程「记账契约」写入动作；宿主每 5 分钟拉一次回复通知补 `reply-in`；
每轮结束后解析当日报告**兜底回填**缺失事件（`source: "report"`，界面标注「据报告回填」）；
报告 `out/<日期>.md` 仍保留，用于人读与兜底回填。

## 安装（本机自用）

前提：本仓库已 clone 到本地、`.venv` 已建好（`pip install -r requirements.txt`）、DSH 桌面版。

```powershell
# 在 DSH 会话里让 AI 执行，或手动：
#   1. 编辑 dsh-plugin/cordis.patch.yml，把 command/args/cwd 三处路径改成你的项目位置
#   2. 安装 bundle：
dsh plugin --profile desktop add link:<项目路径>/dsh-plugin
#   3. 重启 DSH
```

装完打开左侧栏「B站分身」控制台 → 点「重新扫码」→ 手机B站扫码 → 手机上点确认（选「记住我/长期」）→ 账号条显示登录有效 → 点「跑一轮」。

> 装好后建议先到 **设置 → B站分身 → 安装自检 → 一键诊断** 跑一遍：依赖、MCP 连接、登录、模型任一没就绪都会给出修复建议。

## 配置

默认值走 Loader patch 的 `config`（`id: bili-fenshen` 行）；控制台「设置 → 配置」保存到 `<家目录>/config.json` 覆盖层（逐字段覆盖 patch，不改用户的 patch 文件），保存即热生效。关键字段：

`autoDuty`（自动值班总开关，默认关）、`noon`/`night`（谷时窗口）、`perDay` / `commentsPerDay` / `commentsPerRound` / `likesPerDay` / `dynamicsPerDay` / `repliesPerRound`（配额）、`followUids`（指定 UP 主 UID，可选、优先）、`followAuto`（**自动按「最常访问」拉取常看的 UP 主**，默认开）、`followPerRound`（每轮按「最常访问」取前几个常看 UP 主，默认 8；都看过就顺延）、`keywords`（搜索关键词，其次）、`avoidList`（**不看清单**：BV号 / UP主（名或UID）/ 标题关键词，命中整条跳过）、`banPrivacy` / `banImpersonation` / `banControversy` / `banRepeat` / `banReplyRefusal`（**默认禁令开关**，默认全开）、`dynamicPureText`（**是否允许纯文本感想动态**）、`personaPrompt`（人设：普通文字，或一个文件路径——`/绝对路径`、`~/…`、Windows 盘符都行；填目录则读其中的 `AGENTS.md`；读不到会降级为中性并把原因写进值班日志。仓库内置样例 `prompts/persona-whale.md` / `prompts/persona-elaina.md`；**控制台入口只有「人设 → 人设卡 → 回滚出口」一处**，设置页不再重复放输入框）、`reportLevel`（full/brief/off）、`dutyTools`（值班轮白名单）、`dshBin`（CLI 路径，留空自动探测）、`headlessProfile`（默认 `headless`）、`modelProvider` / `modelName` / `modelReasoningEffort`（值班轮模型，**三个都留空 = 跟随当前会话默认模型**）。

模型说明：只影响值班轮拉起的 headless 会话，不影响当前对话；换 provider 时插件会把桌面版 profile 里的 `llm-pi-ai` provider 配置（你的 key/模型）带进 headless，所以自定义 provider 也能用。控制台「配置 → 模型」有下拉选择，保存即写覆盖层并热生效（下一轮值班生效）。

推理强度只按模型能力决定「写」或「不写」：模型不支持该强度（或根本没有推理强度，如 `huoshan / glm-5-3-flash-260828`）时，不把它写进 headless 配置，避免 headless 轮因 `UNSUPPORTED_REASONING_EFFORT` 退出；其余情况原样传入，不做任何降级或替代。

## 安全说明

- 凭证只存本机 `bili_credential.json`（已被 [.gitignore](../.gitignore) 排除），路径可用 `BILI_CRED_FILE` 环境变量覆盖
- 值班轮用独立 headless profile + 工具白名单，写操作最小授权
- 默认禁令（隐私 / 冒充真人 / 争议 / 同视频只评一次·不刷屏 / 敏感请求）可在控制台「禁令」组各自开关，默认全开；提示注入防御与报告/账本保底纪律不可关
- 自动化操作有被B站风控的 theoretical 风险，请自担；建议先用小号

## 致谢

值班轮/发后复核/环境自愈等模式移植自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）；bilibili-mcp 上游为 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)（MIT）。
