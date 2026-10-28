# 优化方案：链路闭环 / 稳定性 / 性能 / 展现（2026-10-28）

> **已并入统一方案（2026-10-28）**：本文的**缺陷清单与最小改法**已全文并入 [B站分身：人设系统 × 工程链路 统一方案](2026-10-28-unified-plan.md) 的 §4（现状核实）与 §5（W0–W7 工作项）；B0–B4 的批次划分已重排为 W0–W7 并与人格分层方案去重。**这份文档自即日起只作缺陷推导的原始记录保留，排期与取舍一律以统一方案为准。**
>
> 三处需按统一方案修正：§0.1 的"已完成"里有 3 个尾巴（日志轮转 2 代未实现、`canonUsed` 只写不读、`commitPendingUsage` 无测试）；B1-3 的"四字段"清单不准（真漏的是 `jargon.allow`）；全文行号已漂移 60–500 行（~~`index.js:631`~~ → `:708` 等）。
>
> 另：运行期 `personaPrompt` 非空 ⇒ 线上走 legacy 直通，本文的 B1 系列在切链路前处于"潜伏"状态（统一方案 §4.4）。

- **目标**：功能链路完整、稳定、快、且界面上"看得懂"
- **基线**：`npm test` → **208 pass / 0 fail / 964ms**（改完必须仍是 208+，新增用例另计）
- **已有关键数字**：人设编译 1,404 字符（whale）｜五块预算 3,000｜整轮 prompt 14,214｜argv 软 20,000 / 硬 24,000｜账本轮转阈值 5 MB
- **前置阅读（本文不重复论证）**：
  - [人设模块 v2 设计](../specs/2026-10-26-persona-module-v2-design.md)（P0/P1 已实施；P2/P3/P4 部分实施）
  - [控制台 v4 设计定稿](../../analysis/2026-10-28-design-v4.md)（R/P/U1/U2 已拍板）
  - [控制台已知问题与修复方案](../../CONSOLE-ISSUES-2026-10-28.md)（11 项，含根因与改法）
  - [人格注入分层方案](../../persona-layer-design.md)（六层三通道的取舍依据）

> **本文的定位**：不重开设计，只做三件事——① 把上面三份文档里"已定但没做完"的接上；② 补上审计发现、但三份文档都没覆盖的断点；③ 给每个改动配测试、验收与回滚，让它可以按批上线。

---

## 0 一页纸

| 批次 | 主题 | 条数 | 工时 | 上线后用户能看到什么 |
|---|---|---|---|---|
| **B0** | 止血：控制台现在就是坏的 | 2 | 0.5 天 | 打开就有数据，不再红条报警、不再「数据 刚刚」撒谎 |
| **B1** | 链路闭环：让"人设"真的生效并可归因 | 6 | 1.5 天 | 同一天不再讲同一件旧事；发之前有确定性拦截；能看到"这轮吃了哪版" |
| **B2** | 稳定性：把会断的地方接住 | 7 | 1 天 | 日志不再乱码、不再无声超时、误删可恢复、改配置立刻生效 |
| **B3** | 性能：把 O(N) 摊平成增量 | 4 | 1 天 | 一轮跑 10 分钟不再越来越卡；概览重算 <30ms |
| **B4** | 展现：让人设页回答那 5 个问题 | 4 | 1 天 | 人设页能自证"生效/命中/降级/体检/对比" |

**依赖**：B0 无依赖 → B1-4（归因）→ B4（展现依赖归因数据）；B1-1/2/3/6 同在 `buildDutyPrompt` 与 `compile.js`，**必须一次重构**；B2/B3 与 B1 可并行（文件不重叠）。

---

## 0.1 实施状态（2026-10-28 本轮，边写边改，别按"未做"重排）

> 开工前复核发现：**B0 与 P1-3 在本文写作前就已经修好了**（代码里已有对应注释与守卫）。
> 所以本轮直接跳到"还真的没做"的部分。

| 条目 | 状态 | 证据 / 改动 |
|---|---|---|
| B0-1 SSE 首帧 | ✅ **早于本轮已修** | `lib/api.js:190-197` hello 不带 seq；`client.js:768-778` `hasData` 守卫 |
| B0-2 空态与新鲜度 | ✅ **早于本轮已修** | `client.js:1182-1190` 无数据说"正在连接"；`client.js:1316` `health.cli !== undefined` 才判红 |
| P1-3 宽行竖排 CSS | ✅ **早于本轮已修** | `client.js:526-527` `.bf-row-wide{flex-direction:column}` |
| **B1-1 冷却表接线** | ✅ **本轮完成** | `compile.js` 返回 `used`；`persona/index.js` 透传 + 导出 `recordUsage`；`index.js` 新增 `writePendingUsage` / `commitPendingUsage`（编译期落 pending、`round-end` 转正、6h 过期丢弃）。新增 `test/persona.usage.test.js`（4 例） |
| **B2-2 dshBin 缓存** | ✅ **本轮完成** | `index.js`：`dshCliCache`/`cliHealthCache` 的 key 带上 `dshBin`；未命中缓存 60s（原来是双侧 10 分钟）；新增 `export resetCliCaches`，`lib/api.js` POST `/config` 成功后调用 |
| **B2-3 日志乱码** | ✅ **本轮完成** | 新增 `lib/logsink.js` `createUtf8Decoder`；`index.js` 子进程 stdout/stderr 各持一个持久解码器；`toText` 降级为"真 GBK 外部输入"专用 |
| **B2-4 日志轮转** | ✅ **本轮完成** | `lib/logsink.js` `rotateIfBig` 按**字节**保留尾部（且从换行处切，不切半个中文字符）；`index.js` 5 秒节流调用，`appendLogChunk` 也触发 |
| **B2-5 reasoning 灌日志** | ✅ **本轮完成** | `lib/logsink.js` `keepTail`；stdout 只留尾部 4KB，stderr 全量 |
| **探测刷屏** | ✅ **本轮完成** | `lib/logsink.js` `createProbeLogger`；`findDshCli` 只在结论变化时记一行 |
| B1-2 / B1-3 / B1-4 / B1-5 / B1-6 | ⏳ 未做 | 见下文 |
| B2-1 / B2-6 ~ B2-10 | ⏳ 未做 | 见 §4 |
| B3-* / B4-* | ⏳ 未做 | 见 §5 / §6 |

**本轮验证**：`npm test` → **219 pass / 0 fail**（原 208，新增 11 例）；`client.render-smoke.mjs`、`client.smoke.mjs`、`index.integration.mjs`、`e2e-fixture.mjs` 四个入口均 **exit=0**。

---

## 1 四目标 → 可验收指标

| 目标 | 指标 | 现状 | 目标 | 验收方式 |
|---|---|---|---|---|
| 链路完整 | 发布前确定性拦截率 | **0**（只有 `duty.md:83-91` 的散文） | 100% 评论/动态过 lint | 注入一条"太强了"必被拦 |
| 链路完整 | 注入可归因 | **无**（`personaTag` 只在内存返回，未落账本/报告） | 每轮 1 条 `persona-inject` | 账本可查 |
| 链路完整 | 冷却生效 | **恒空**（`recordUsage` 无生产调用） | 同日不重复同条见闻 | 连跑两轮看 `usedToday` |
| 稳定 | 控制台首帧可用 | **坏**（SSE 首帧被 seq 守卫丢） | 打开即有数据 | 冷启动截图 |
| 稳定 | 日志可读 | 中文整块乱码 | 无 `U+FFFD` | 跑一轮看 `duty.log` |
| 性能 | 账本扫描/轮 | 估算 ~600–1200 次全量（待 B3-0 实测） | 1 次全量 + N 次增量 | `scripts/bench-ledger.mjs` |
| 性能 | 概览重算 p95 | 未测 | ≤30ms @ 10 万行 | 同上 |
| 展现 | 人设页能回答的问题数 | 2 / 5 | 5 / 5 | 见 §6 清单 |

---

## 2 B0 · 止血（0.5 天，先做）

> 完全按 [CONSOLE-ISSUES](../../CONSOLE-ISSUES-2026-10-28.md) 的 P0-1 / P0-2 执行，这里只补"验收"与"别改坏"。

### B0-1　SSE 首帧不再被丢（P0-1）

**改 3 处**：`lib/api.js` 的 `openStream`（hello 去掉 `seq`）、`client.js:742-760` `accept()`（无数据时允许相等 seq）、`client.js:904` `refresh()`（同上）。

**测试**：`test/api.test.js` 增一例——hub 先算一次（有数据不脏）→ 开 `/stream` → 断言首帧可被接受（`seq > hello.seq` 或客户端 accept 返回 true）；`test/client.*` 增 `accept` 语义单测（无数据 + 相等 seq → 接受）。

**验收**：`autoDuty:false` 空闲下反复刷新，概览不再停在空数据态。
**回滚**：三处独立，可单独还原。

### B0-2　空态不等于故障、新鲜度不撒谎（P0-2）

**改 3 处**：`client.js:1274`（`health.cli !== undefined && !health.cli` 才判红）、`client.js:1150-1163` `Freshness`（`!data` 直接返回"正在连接…"，不算 age）、`client.js:2630-2643`（`undefined → 探测中…` 三态）。

**测试**：`test/client.render-smoke.mjs` 增"无 initialData"渲染断言——**不得出现**「找不到 dsh CLI」「数据 刚刚」。

**验收**：冷启动首屏是「正在连接…」而不是红色告警。

---

## 3 B1 · 链路闭环（1.5 天）

### B1-1　冷却表接线：`recordUsage` 终于被调用（G1，最高优先）

**现状**：`lib/persona/state.js:163` 的 `recordUsage` 只有测试调用 → `loreUsed/canonUsed/expressionUsed` 永远是 `{}` → `usedToday()` 永远 false → 「今天用过了」从未生效（`lore.js:30`、`compile.js:180`）。

**改法**（三步，缺一不可）：
1. `compilePersona`（`compile.js:156-221`）**新增返回值 `used`**：`{ loreIds: [...], canonKeys: [...], expressionIds: [...] }`
   - `loreIds`：`resolveLoreIndex` 里挑出要注入索引的条目中、"今天未用过"的那些（`lore.js:22-32` 已有 `usedToday` 信息）
   - `canonKeys`：`buildCore` 里 `card.canon` 实际进 prompt 的 `when` 值
   - `expressionIds`：`pickExpression` 返回的 `picked.map(e => e.id)`（现在 `compile.js:176-183` 算完就丢了）
2. `resolvePersona`（`lib/persona/index.js:50-98`）透传 `used`
3. 宿主 `buildDutyPrompt`（`index.js:622-730`）把它写进 `<home>/persona/pending-usage.json`；**轮末**（`round-end` 处理点，`index.js:800-830` 一带）读 pending → `recordUsage(state)` → `saveState()` → 删 pending
   - 为什么用 pending 而不是编译时直接写：本轮若 spawn 失败/中途崩，不该污染冷却表。pending 超过 6 小时未转正则忽略。

**测试**：`persona.state.test.js` 已有 `recordUsage` 单测（:64）；新增「两端闭环」用例：编译→pending→转正→次日 `usedToday(loreUsed,id)=true`；再跑一轮断言该条**不再出现在"新鲜"组**（`renderLoreIndex` 把它挪到"今天用过了"）。

**验收**：同一天连跑两轮，第二轮 P2 段出现"今天用过了：night-owl"，且 P4 抽到不同语料。
**回滚**：pending 文件是新增的，删掉即回到旧行为。

### B1-2　场域字数上限生效（评论 100 / 楼中楼 40 / 动态 60）

**现状**：`index.js:631` 硬编 `modeMax: 100`，`state.js:29-36` 的时段上限（凌晨/深夜 40）能覆盖评论，但**楼中楼 40 / 动态 60 从未生效**——所有场域都按 100 字编译。

**改法**：
- `buildState`（`compile.js:100-129`）已支持 `maxChars` 参数；把 `compilePersona` 的 `modeMax` 换成 `modes = { comment: 100, reply: 40, dynamic: 60 }`
- P3 输出一行场域表：`场域上限：评论 ≤100 / 楼中楼 ≤40 / 动态 ≤60（取与时段更严者）`
- P5 的"这条按 N 字以内"保留评论口径（一轮主产出是评论）
- `resolvePersona` 调用处传 `modes`；控制台预览同步用同一份 `modes`（消除"预览 ≠ 实际"）

**测试**：`persona.compile.test.js` 增三例——`modes.reply=40` 时 P3 出现 40；凌晨 + reply 取 40（更严）；动态 60 时胶囊文案正确。

**验收**：模拟一条 80 字楼中楼 → lint（B1-5）按 40 判超限。

### B1-3　L0 与注入口径统一（G4：四个字段"卡里合格、实际没说"）

**现状**：`card.js:33-70` 的 `injectedText` 与 L0 判据把 `behaviorStyle` / `stance[].misread` / `mindset.judgement` / `jargon.quota` 都算进"会被注入"，但 `compile.js:45-144` 从不输出它们。

**改法**（二选一，**必须选一个并同步 L0**）：
- **A（推荐，符合 v2 设计 M6）**：让它真的注入——
  - `behaviorStyle`：抽 1 行进 P5（尾注固定 3 行 → 把第 3 行红线挪到第 2 行，"何时开口"进第 1 行的括号），或进 P3 首行；**不放 P1**（P1 是事实，别塞行为）
  - `mindset.judgement`：进 P1 一行（`判：${judgement}`），上限 30 字
  - `stance[].misread`：进 P1 立场行括号（`（别读成 X）`），仅第一个
  - `jargon.quota`：并在 `voiceFacts`（`compile.js:22-38`）的"禁用"同维度一行
- **B**：从 `injectedText`/L0 里移除这四项，承认它们只是"编辑期参考"

**测试**：新增"口径一致性"用例——遍历卡里被 L0/`injectedText` 认作"已注入"的字段，断言其内容片段确实出现在 `compilePersona().text` 里（这条测试能永久防回归）。

**验收**：whale 卡编译结果里能 grep 到 judgement 与 misread 的字样；L0 六条仍 6/6。

### B1-4　归因：`persona-inject` 事件 + 报告 `personaTag`（设计原则 6 的欠账）

**现状**：`resolvePersona` 返回了 `personaTag`（`persona/index.js:80,95`），`buildDutyPrompt` 拿到了（`index.js:631`），但**没写进任何持久位置**；报告无 personaTag、账本无人设事件 → "换卡前后行为变了"无法归因。

**改法**：
1. 账本新增事件（宿主在 `buildDutyPrompt` 成功后立刻 append，成本 0）：
```jsonc
{"t":"…","round":"R-…","type":"persona-inject","personaTag":"whale@2.1.0",
 "mode":"card","channel":["C1","C2"],
 "layers":[{"name":"core","chars":885,"max":1500},{"name":"lore","chars":188,"max":300},
           {"name":"state","chars":157,"max":500},{"name":"samples","chars":72,"max":450},
           {"name":"tail","chars":95,"max":250}],
 "hits":["night-owl"],"degraded":null,"notes":["P4 用表达库（question，4 条）"]}
```
2. 报告头加一行：`人设：whale@2.1.0（core 885 / lore 188 / state 157 / samples 72 / tail 95）` —— 由 `buildDutyPrompt` 直接拼进 prompt 的"本轮参数"区，模型照抄进报告
3. `roundAccounting`（`lib/round.js`）增 `personaTag` 字段 → 概览信封 `round.lastRound.personaTag`

**测试**：`round.test.js` 增一例（事件→信封字段）；`index.integration.mjs` 增一例（构建 prompt → 账本出现 persona-inject）。

**验收**：跑一轮后账本 `type=persona-inject` 可查；概览 JSON 的 `round.lastRound.personaTag` 有值。

### B1-5　质量门落地：发布前确定性拦截（v2 设计 M5，"能拦的必须拦在 `bili_reply` 之前"）

**现状**：**全链路没有任何 lint**（JS 无、Python 无）；判据只存在于 `duty.md:83-91` 的散文里。设计 §8.4 要求避免 JS/Python 两套规则漂移。

**改法（单一事实来源 + 哑执行器）**：

1. **规则在 JS**：新增 `lib/persona/lint.js`（纯函数，可单测）
```js
// lintComment({ text, mode, card, rules, bank }) → { ok, level:'block'|'warn', codes, reasons, advice }
// 判据（P0 = 硬拦；P1 = 附建议放行）
// L1 落点：收尾不得是空泛捧场（词表：不错/学习了/太强了/牛/爱了/支持/收藏了）
// L2 自足：首句不得以指代开手（这个/那句/上面/他/它 + 前面没有名词）
// L3 再创作：整句被引号包裹且 ≥8 字（复述未加工信号）
// L4 反抄：与 bank active 的 2-gram Jaccard > 0.6（复用 expression.js:76 的 looksCopied，终于接线）
// L5 形态：mode=comment 超 100 字 / reply 超 40 / dynamic 超 60；句号 > 1；表情 > card.voice.emoji.perComment
// L6 红线：card.redlines 的 lexicon 词命中（如 policy:politics）
// L7 禁用词：voice.avoid.* 命中
```
2. **规则导出**：`scripts/export-lint-rules.mjs` → `<home>/persona/lint-rules.json`
   阈值来源：真人 247 条基线（句号 10.9%、问号 12.6%、表情 41.7%、中位 27 字）+ 当前卡 `voice` 事实 + `budget.js` 的场域上限。**卡一改就重导**（保存卡的路径顺手调用）。
3. **Python 哑执行**：`mcp_server.py` 的 `bili_reply` / `bili_send_dynamic` 在发布前读 `lint-rules.json`，`level==='block'` → **不发**，返回：
```json
{"ok":false,"code":"LINT_BLOCKED","codes":["L1"],"reasons":["收尾是空泛捧场"],"advice":"换成纯情绪/反问/玩梗，别收在评价上"}
```
   文件缺失 / 解析失败 → **放行 + 警告**（安全侧：宁可发出去，也不要因为规则文件坏了全线停摆）。
4. **渐进上线**：先 `mode:"warn"` 跑 3 天（只附 advice 不拦），统计拦截率；确认误杀率 <5% 再切 `block`。

**测试**：`test/persona.lint.test.js` 每判据 2 例（pass/fail）= 14 例；`test/api.test.js` 加"规则文件缺失→放行"；Python 侧加一条 `python -m pytest`（或直接脚本）断言 L1 被拦。

**验收**：注入一条"太强了" → 被拦且理由可读；真实跑一轮，账本里能看到"被拦→重写→发出"的轨迹（重写后不再重复拦）。

**回滚**：`lint-rules.json` 里 `mode:"off"` 一键关闭（Python 侧只读这一个开关）。

### B1-6　降级策略接线（G3：超限时别再先砍尾注）

**现状**：`budget.js:66` 的 `degradationPlan` 没人调；`index.js:723-728` 的超限处理是**整段丢 after**——而 after 里装着最有用的"最后一公里"3 行。

**改法**：
- `compilePersona` 增参数 `degrade: string[]`，按 `lore:shrink`（索引 8→5）/ `samples:half`（4→2）/ `lore:drop` / `samples:drop` / `state:shrink` 二次裁剪
- `buildDutyPrompt` 在 `guardPrompt(prompt).level !== 'ok'` 时按 `degradationPlan(level)` **重新编译一次**（纯函数，1ms 级）再拼；仍超硬线才丢 after
- 把实际降级写进 `persona-inject.degraded`

**测试**：构造超软线场景 → 断言 `tail` 仍在、`lore` 条目减少；超硬线 → after 被丢且 `degraded='hard'`。

**验收**：人为把卡写长到 25k prompt，尾注仍在。
**回滚**：新增参数默认空数组 = 旧行为。

---

## 4 B2 · 稳定性（1 天）

> 除特别标注，来源均为 [CONSOLE-ISSUES](../../CONSOLE-ISSUES-2026-10-28.md)。

| # | 问题 | 改法 | 验收 |
|---|---|---|---|
| B2-1 | **overlay 生成失败静默无工具起轮**（`index.js:619` 失败返回 `null`，`index.js:764-767` 只 `if (overlay) args.push(...)`）→ 轮次照跑但没有 MCP 工具，现象是"模型什么都没干" | `null` 时**中止本轮**并写 `state.lastError='overlay'`，概览显形 | 删掉 `<home>` 写权限模拟失败 → 本轮标记失败而不是空跑 |
| B2-2 | `dshBin` 改了最长 10 分钟不生效（`index.js:970-977`、`:360-399` 两个缓存 key 不含 cfg） | 保存配置时 `resetCliCaches()` + 缓存 key 带 `cfg.dshBin` + 探测日志只在结论翻转时写 | 改 dshBin → 下一帧概览即"已探测" |
| B2-3 | `duty.log` 中文整块乱码（`index.js:431-438` 按块嗅探编码） | 每流一个 `StringDecoder('utf8')`，`appendLogChunk` 接受 string | 跑一轮 `duty.log` 无 `U+FFFD` |
| B2-4 | 日志轮转按字符切 + 子进程输出不触发（`index.js:283-291`） | 按**字节**截断（`buf.subarray`）+ 两处都触发 + 保留 2 代 | 中文日志轮转后 `.old` ≤ 256KB |
| B2-5 | 子进程 stdout 全量落盘（含 reasoning） | stdout 只留尾部 4KB、stderr 全量；完整流已在 `live` 环形缓冲 | `duty.log` 单轮增量 < 200KB |
| B2-6 | 回复轮询无超时/退避（`lib/replies.js:32-39`） | `AbortSignal.timeout(8000)` + `1min→5min→15min` 退避 + `inbox.lastError` 进信封 | 断网时概览显示"上次失败·Ns 前重试" |
| B2-7 | 语料/见闻删除无留痕、孤儿正文（`index.js:1469-1490`） | 写前 `<file>.bak-<ts>` 留 5 份；删除改**软删除** `disabled:true`；启动/保存时扫 `lore/*.md` 未被引用的 → 标"未引用" | 删一条→可恢复；孤儿文件在素材库标红 |
| B2-8 | `state.json` / `persona/state.json` **非原子写**（`index.js:263`、`state.js:155` 直写 `writeFileSync`） | 统一走 `writeTextFile`（tmp+rename，`persona.js:168` 已有同款；`store.js:45-47` 也是） | 写入中断不产生半截 JSON |
| B2-9 | `personaPrompt` 存绝对路径（设计文档 P3-11） | 存 `preset:<id>` 或相对插件根；解析失败 → `personaHealth` 报 warn + 设置页"路径不存在" | 换机器后仍能解析或明确报错 |
| B2-10 | spawn 无硬超时（只有轮末 90s 复核） | 每轮 hard timeout（建议 20 分钟）+ 进程树 kill + `round-end code='timeout'` | 模拟挂死 → 20 分钟内收尾并标 timeout |

**故障注入测试清单**（新增 `test/fault-injection.test.js`）：overlay 写失败 / 账本半截行 / 卡 JSON 损坏 / state 半截 / 规则文件缺失 / spawn 立即退出 / 报告缺失。

---

## 5 B3 · 性能（1 天）

> B3 的第一步是**把估算变成实测**。下面量级为估算（按 200 B/事件、5 MB 轮转上限 ≈ 2.5 万事件）。

### B3-0　先做基准脚本（0.2 天）
`scripts/bench-ledger.mjs`：造 1k / 10k / 100k 行账本 → 分别测 `readEvents` 与新版 reader 的耗时；`scripts/bench-overview.mjs` 测 `buildOverview` p95。**结果写进 PR 描述**，否则后面所有优化都是猜。

### B3-1　账本增量读（最大头）

**现状**：`lib/ledger.js:65-86` `readEvents` 每次 `readFileSync` 全量 + 逐行 JSON.parse + **全量 sort**；`index.js` 里 **20 处调用**，其中热路径：
- `buildOverview()` → `readEvents`（`index.js:989`），由 `overviewHub` 在文件变更（2s 轮询 + debounce 250ms / 最小间隔 800ms）时重算
- `quotaPerRound()` → `readEvents`（`index.js:1015`），**运行中 tick 每 1.5s 一次**
- `liveSnapshot()` → `quotaFromLedger()` → `readEvents`（`index.js:1211`）
- `tick()` 每分钟 → `quotaFromLedger()`（`index.js:931`）

**改法**：新增 `lib/ledger-index.js`
```js
createLedgerReader(file) → { read(): events, stats: { fullReads, appendedEvents, bytes } }
// 行为：
// 1) stat(size, mtimeMs) 未变 → 直接返回缓存数组（0 次读盘）
// 2) size 增大且 > 上次偏移 → 只 read 新增字节段（fd + Buffer），解析新行并 push
// 3) size 变小（轮转/重写）→ 全量重读并重置偏移
// 4) sort 只在有新事件时做（或用插入有序 + 尾部排序）
```
`index.js` 里 20 处改为共享**一个实例**（`const ledger = createLedgerReader(LEDGER_FILE)`），每个请求内多处调用只读一次。
**风险**：账本是 append-only 才成立——`ledger.js:14-16` 轮转 + 测试里的覆盖写都会让 size 变小，规则 3 已覆盖；加一条断言日志 `ledger reader: 非法回退(N)`。

**测试**：`test/ledger-index.test.js`——追加后增量读 == 全量读（逐事件 deepEqual）；无变化时 `readFileSync` 调用次数为 0（用 fs spy/计数注入）；轮转后回退全量。

**验收**：10 万行账本，`buildOverview` p95 从"估算 20–40ms"降到 ≤5ms；运行中 tick 不再触发全量读。

### B3-2　一轮内"一次读、多处用"
`buildOverview` 已经拿到 `events`（`index.js:989`），但 `presenceFrom`/`quotaPerRound`/`liveSnapshot` 又各自读一遍——统一为**传入 events**。`liveSnapshot(after, events)` 增形参，`quotaFromLedger(events)` 可接受外部 events（默认自己读）。

### B3-3　hub 计算降频与去抖
- `hubPoll` 2s 已比大小（`index.js:1664-1677`，好习惯，保留）
- 补：**空闲时不做 tick 帧**（tick 只在 `round.running` 为真时推），减少客户端无谓渲染与 `quotaPerRound` 调用
- `accountForOverview` 5 分钟缓存已有（`index.js:953-967`），保留

### B3-4　客户端请求去重
`client.js` 里人设页 3 个子页签各自 fetch `/persona`、`/persona/preview`、`/persona/expression`、`/persona/lore`——合并为**一次 `/persona/bundle`**（服务端一次算完，复用 `readEvents` 单例），或至少在页签切换时**复用 30s 内的结果**。

---

## 6 B4 · 展现（1 天，依赖 B1-4）

人设页当前 3 子页签（`client.js:1887`：`人设卡 / 素材库 / 预览与质量`），应回答 5 个问题：

| 用户的问题 | 现在 | 改成（放哪） | 数据来源 |
|---|---|---|---|
| 这个号现在是谁？ | ✅ 卡名/版本 | 页头一行：`whale@2.1.0 · 生效中 · 1,404 字符 · 3 个见闻` | `GET /persona` |
| 它上一轮实际吃了什么人设？ | ❌ | **新增「本轮实际注入」块**（预览与质量页签顶部）：五块 chars/max 进度条 + 命中见闻 + 降级标记 | `persona-inject` 事件 |
| 超预算了吗？砍了谁？ | ❌（只有预览的 bars） | 同上，超 90% 黄、超预算红、"已降级"徽标 | 编译 stats + `degraded` |
| 说话还像它吗？ | ❌ | **新增「体检」块**：近 20 条句长中位/句号占比/表情占比/禁用词命中，vs 基线（247 条：27 字 / 10.9% / 41.7%） | 账本聚合（纯函数 `presenceFrom` 同款思路） |
| 改了卡有变好吗？ | 部分（版本对比） | 版本对比里按 `personaTag` 分组显示"换卡前后各 3 条评论 + 点赞" | 账本 `persona-inject` + 活动聚合 |

**实现约束**：复用现有宿主 token 与行式控件（`bf-` 前缀、`--dsw-*`、`bf-row`/`settings-card`）；不新增字号（白名单 11/12/13/14/16/18/20/24）；空态用"正在连接…"而非虚线框（与 B0-2 一致）。

**测试**：`test/client.render-smoke.mjs` 每组新增块各 1 条断言（有数据/无数据两态）。

---

## 7 顺序、依赖与冲突

```
B0-1, B0-2            （独立，0.5d）
   └── B1-4 归因 ──────────────► B4 展现（体检/对比依赖 personaTag）
B1-1 ┐
B1-2 ├─ 同一处重构：compile.js 返回值 + buildDutyPrompt   （必须一次做完）
B1-3 │  建议同时抽 lib/persona/layers.js（见分层方案 §3）
B1-6 ┘
B1-5 质量门           （独立，动 mcp_server.py + 新增 lint.js）
B2-*                  （与 B1 可并行；index.js 有小重叠，见下）
B3-*                  （动 lib/ledger.js + index.js 调用点）
```

**文件冲突预警**：
- `index.js` 被 B1-1/2/4/6、B2-1/2/3/4/5、B3-1/2/3 同时改 → **建议先做 B1 的 `buildDutyPrompt` 重构**（抽出 `lib/persona/layers.js`，把 110 行单体拆成"取数/编译/拼装"三段），之后 B2/B3 各改各的函数。
- `mcp_server.py` 只被 B1-5（lint 调用点）与既有工具体动，隔离性好。

---

## 8 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 质量门误杀 | 该发的没发，账号变闷 | `mode:"warn"` 先跑 3 天，统计拦截率；`L1` 词表先用真人基线筛，别凭感觉加 |
| 规则文件缺失 | 全站发不出去 | Python 侧缺失=**放行**+告警，绝不阻断 |
| 增量读遇到非 append 写 | 读到半截/漏事件 | size 变小即全量回退；上线首周记 `stats.fullReads` 与 `fallbacks` |
| `degraded` 二次编译增加延迟 | 每轮 +1 次编译（~1ms） | 只在 `level!=='ok'` 时触发 |
| 归因事件写账本增体积 | 每轮 +1 行 | 可忽略（相对评论事件） |
| 软删除留 `disabled` 条目 | 索引变长 | 编译期过滤 `disabled`，且不占 P2 预算 |

---

## 9 不做（本轮）

- ❌ 不做向量记忆 / RAG（等 B1 稳定、见闻 >50 条再评估；理由见分层方案 §13）
- ❌ 不做 companion 插件或 headless 载入宿主插件做"生成期注入"（收益大但涉及 profile 改动，单独立项）
- ❌ 不动宿主 token/控件几何（`2026-10-27-dsh-ui-conformance.md` 的"不要动"清单）
- ❌ 不做试写沙盒（需 host LLM 调用与配额保护，`client.js:2422-2423` 已标 disabled）
- ❌ 不改 `mcp_server.py` 的既有接口签名（只加 lint 前置检查）

---

## 10 交付定义（Definition of Done）

1. `npm test` ≥ 208 pass（新增用例另计），`node test/client.render-smoke.mjs`、`index.integration.mjs`、`client.smoke.mjs`、`e2e-fixture.mjs` 全绿
2. `scripts/bench-ledger.mjs` 有前后对比数字，写进 PR
3. 真机各一次：冷启动控制台首屏有数据（B0）、跑一轮账本出现 `persona-inject`（B1-4）、同日两轮不重复见闻（B1-1）、"太强了"被拦（B1-5）、`duty.log` 无乱码（B2-3）
4. 每批可独立回滚：B1 的开关是 `pending-usage.json` / `lint-rules.json` / `degrade` 参数；B2/B3 是局部函数替换
