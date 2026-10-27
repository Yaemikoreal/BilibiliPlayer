# B站分身控制台 · 设计方案（V2 · 2026-10-22）

> **V4 已落地（2026-10-28，0.7.0）**：7 页签 → **5 页签**（概览 / 活动 / 日报 / 人设 / 设置）——
> 「实时」并入概览的运行详情、「判重表」并入活动的第 3 视图、人设 8 子页签 → 3、设置 2 子页 → 3 组；
> 每页加**页头**（唯一 h1 + 一句话 intro + ≤2 主操作），概览首屏改成「状态条 → 今日产出 → 接话 → 运行详情 → 配额（日累计/本轮）」；
> 数据层换成**单一实时信封 + SSE**（seq / dataUpdatedAt / 新鲜度徽标 / 断流降级）；
> 接话从「可选动作」升级为**每轮硬步骤「接话扫描」**（报告机器行 + 账本 `reply-scan`）。
> 设计定稿见 [2026-10-28-design-v4.md](../docs/analysis/2026-10-28-design-v4.md)，审计见
> [ui-audit](../docs/analysis/2026-10-28-ui-audit.md) / [behavior-audit](../docs/analysis/2026-10-28-behavior-audit.md)。
>
> **V3 已落地（2026-10-27，0.6.0）**：全局 UI 重做已从设计稿/演示稿搬进真实 `client.js`——
> 7 页（概览/实时/活动/日报/判重表/人设工作室/设置）、DSH 960px 页面容器、宿主 `--dsw-*` token、深浅主题跟随宿主；
> 宿主已画左侧 rail，插件不再自绘侧栏；设置内部再分「配置 / 宿主日志」。
> 设计说明见 [2026-10-26-console-ui-v3-design.md](../docs/analysis/2026-10-26-console-ui-v3-design.md)，
> 宿主规范见 [2026-10-27-dsh-ui-conformance.md](../docs/analysis/2026-10-27-dsh-ui-conformance.md)。
> 本文件保留为 V2 交互模型（显式保存、生命周期）的历史依据。

配套演示稿：[console-demo.html](./console-demo.html)（V2：显式保存键 + 完整生命周期可视化；数据为 2026-10-22 当日实测值）。

**V1 → V2（响应评审意见）**：① 设置从「即时保存」改为**显式保存键**（每卡 [保存]/[重置] + 脏标记 + 全部保存）；② 新增**「活动 · 生命周期」为一等公民 tab**：看过/点赞/评论/收到的回复/跟进/分享按视频串成完整链路。

## 1. 形态与挂载

- `sidebar.panellist`（「插件」「自动化任务」所在的全局面板列表）注册条目 `id: bili-fenshen`，点击后由 `main`（keyed 槽，按 sidebar entry id 派发，keyDomain 开放）以 key `bili-fenshen` 渲染控制台；
- 现有 `settings.section` 面板降级为「状态一行 + 打开控制台」；
- 实装前用 `Slots.listSubTree(root: 'sidebar.panellist')` 查完整 registration 选项，并按 `references/user-actions.md` 对齐面板动作与 Agent 工具的共享操作。

**Tab 结构**：`🧬 活动 · 生命周期`（默认）｜`🎛 控制台`｜`📄 日报`｜`📚 判重表`｜`🧾 日志`。

## 2. 数据面（host 路由）

| 路由 | 状态 | 说明 |
|---|---|---|
| `GET /api/bili-fenshen/status` | 已有，扩展 | quota 分母、`replies` 跟进数、**凭证真实校验**（nav）、`nextRunAt`、最近一轮结果摘要 |
| `GET/POST /api/bili-fenshen/config` | 新增 | 读 = `configEditor.configuration()` 投影；写 = `configEditor.edit(entry, (cur)=>merge)`。宿主官方服务，持久化进 profile、走 Loader 正常路径；热生效待实测，fallback：`refreshCfg()` 每次现读 |
| `GET /api/bili-fenshen/activity?day=&type=` | 新增 | 生命周期事件查询（§3）：`ledger.jsonl` 按日/类型过滤 |
| `POST /api/bili-fenshen/inbox/sync` | 新增 | 触发一次入站收件箱增量同步（msgfeed replies/likes，JS 直连带 cookie；cursor 存 state.json）；节流：每轮结束后自动 + 控制台打开时 |
| `GET /api/bili-fenshen/metrics` | 新增 | 存在感按日聚合（收赞/被回复/新粉） |
| `GET /api/bili-fenshen/rounds` | 新增 | 轮次流水：`runDuty`/`exit` 时 append `<home>/rounds.json` |
| `report` `log` `login/*` | 已有 | 日报补 `?day=` 日期选择器 |

## 3. 活动生命周期（本次核心新增）

### 3.1 事件模型（`<home>/ledger.jsonl`，一行一事件）

```json
{"time":"2026-10-22T23:02:11+08:00","type":"follow","bvid":"BV192n66dEDQ","title":"爆！亚当·重锤怒喷…","rpid":317856268497,"text20":"补仓补到康陶总部去了…","replyTo":{"user":"究极无敌路由器","rpid":317851964705},"round":4}
{"time":"…","type":"reply-in","bvid":"…","user":"究极无敌路由器","text":"发挥主观能动性自己去街上补仓[doge_金箍]","rootRpid":317851964705,"handled":true}
```

`type ∈ watch | like | comment | reply-in | like-in | follow | share | danmaku | skip`；出站事件带 `rpid/text20`，入站事件带 `user/rootRpid/handled`。

### 3.2 采集链（不依赖 Agent 写 JSON）

1. **出站事件**：`runDuty` 起轮前快照 `seen.md`（大小/mtime），轮结束后 diff 新行 → 宿主解析成结构化事件 append 进 `ledger.jsonl`（延续「报告/判重表是事实来源」的模式，Agent 只写它本来就要写的判重表）；
2. **入站事件**：轮后复核定时器 + 控制台打开时，宿主 JS 直连 msgfeed（replies / at_and_likes 的 like 流）带 SESSDATA 增量同步 → `inbox.jsonl` → 合并入 ledger（cursor 记在 state.json）。**「收到了哪些回复」从此不漏**——包括 Agent 决定不跟进的旧回复也入账（`handled:false`）；
3. **评论正文**：章程「评论纪律」本就要求记「正文前 20 字」，实际执行不全 → 强化执行并在 ledger 落盘；修复前发出的旧评论无法回溯正文，UI 如实显示「正文未存档」（demo 已示范）。

### 3.3 两个视图 + 类型筛选

- **按视频（生命周期链卡）**：一个视频一张卡，链路为 `👀 看过 → 👍 点赞 → 💬 评论(rpid) → 📥 收到回复 → ↩️ 跟进回复 → ❤️ 收赞`，右上有状态徽章：`✓ 闭环`（评论→收到回复→已跟进）· `💬 已评论` · `⚠ 断链`（rpid 未取到，修复前缺陷）· `📣 已分享` · `👀 仅互动`；
- **按时间线**：混合事件流（按轮次/时段分组），事件带类型图标与关联 rpid；
- **筛选 chips**：全部 / 看过 / 点赞 / 评论 / 收到的回复 / 评论收赞 / 跟进回复 / 分享（+ 弹幕）。

今天的数据正好是四种典型样张，demo 已逐一呈现：完整闭环（BV192n66dEDQ）、评论获赞（日食记，rpid 由点赞流回溯定位）、断链事故（李维刚，修复前 rpid 未取到）、仅互动（5 条折叠）。

## 4. 控制台交互模型（显式保存）

- **每卡页脚**：`● 修改后点保存生效` + `[重置] [💾 保存]`；任何控件变更点亮脏标记（含步进器）；
- **全局未保存条**：任一卡变脏时顶部出现「N 张设置卡有未保存的修改 + [全部保存]」；
- **二次确认**：影响公开行为的卡（值班调度 / 配额 / 内容源 / 互动能力 / 人设）在点保存时 confirm；
- **保存生效路径**：`configEditor.edit` → 持久化进 profile → Loader 正常路径（热生效实测；fallback：`refreshCfg()` 现读 `configuration()`）；
- 保存成功 toast + 卡角「已保存 HH:MM」。

## 5. 七个功能点的实现要点

| # | 功能 | 改动 | 关键设计 |
|---|---|---|---|
| 1 | 内容源接线 | config + buildDutyPrompt、duty.md、白名单 | `contentSources: {weekly, rank, buzzwords, favMediaId}`；白名单加 hot_buzzwords / favorite_lists / favorite_content；每周必看取法 = week=0 列表第一项的期号再查该期（配合功能 4 latest 化后一步到位） |
| 2 | 存在感仪表 | duty.md 契约、index.js 解析 | 报告总结行加「存在感：收赞 N / 被回复 M」→ `<home>/metrics.json` 按日聚合 → `/metrics` 画图；冷启动用 received_at_and_likes 快照补底 |
| 3 | 弹幕互动 | mcp_server.py、白名单、duty.md 弹幕纪律 | `bili_send_danmaku(bvid, text, page=1)`；`danmakuPerDay`（0=关）+ 控制台开关；≤20 字 / 不剧透 / 同视频 1 条；**弹幕压审复核 V1 不覆盖**，靠频控 |
| 4 | 工具面补全 | mcp_server.py | delete_comment / delete_dynamic（白名单默认不含）；received_replies / at_and_likes 加 `num`+`since`、五字段瘦身；weekly_hot latest 化；rank 加 `num`；video_info 补 get_tags、duration 统一秒 |
| 5 | 调度增强 | index.js WINDOWS/tick | `roundsNoon / roundsNight / roundIntervalMin`（默认 1/1/120）；窗口状态改计数 `{date, fired:n}`；fired<rounds 且距上次≥间隔才起轮 |
| 6 | seen.md 轮转 | index.js 前置、duty.md | 跨月或 >48KB → 归档 `seen-YYYY-MM.md`（仅审计）；**`seen-bvs.txt` 每行一个 BV、append-only 永不清**作为判重主索引；章程判重改为「先 seen.md 再 seen-bvs.txt」 |
| 7 | dutyModel | config + buildOverlay | 空=跟随当前；设置后覆盖 overlay 的 agent-default-model 段；下拉来自 overlay 已带 provider 行（huoshan/xiaomi flash） |

## 6. 控制台布局（demo 所示）

```
┌ 顶栏：账号 · 凭证真实状态 · 值班状态/下一轮 · [▶ 现在跑一轮]
├ 概览：今日配额（5 进度条）┬ 存在感仪表（7日图+最热评论）┬ 值班流水（轮次时间线）
└ Tabs：活动·生命周期（默认）→ 控制台（六卡，显式保存）→ 日报 → 判重表 → 日志
```

## 7. 分期（每步独立可验收）

1. **控制台壳 + 生命周期地基**：sidebar+main 挂载、configEditor 保存链路（含保存键交互）、rounds.json、seen.md diff → `ledger.jsonl`、活动 tab（按视频/按时间/筛选）；
2. **host 侧**：调度增强 + dutyModel + seen.md 轮转 + **inbox 增量同步**（收到回复/收赞完整入账）；
3. **值班侧**：内容源接线 + 存在感仪表（契约行）；
4. **工具侧**：弹幕 + 删除工具 + 通知瘦身 + weekly/rank/tags 输出治理。

改动集中在 `client.js / index.js / mcp_server.py / prompts/duty.md`；完成一批重启一次 DSH 生效。

## 8. Demo 与最终实现的差异

- demo 为静态稿：开关只做交互演示不落盘；数据为 10-22 实测（带 ≈ 的时间为区间估计，断链/超配等事故样张保留，作为验收基准）；
- 最终版绑定 `--dsw-*` 主题 token、图标用插件自带 SVG、左侧栏由 DSH 原生渲染；
- ledger 的入站事件（收到回复）在 demo 中由当日报告/判重表回溯而成；实装后由 inbox 同步持续供给（含未跟进的旧回复）。
