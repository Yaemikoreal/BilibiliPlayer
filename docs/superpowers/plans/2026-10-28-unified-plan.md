# B站分身：人设系统 × 工程链路 统一方案（2026-10-28）

> **这份文档是什么**：把两份方案**合成一份**，放进同一个叙事里——
> - **原 A 稿**：[人格注入分层方案 v1](../persona-layer-design.md) → 本文 §2（六层×三通道方法）、§3（对标与不抄）、§8（质量门/记忆/语料/门控的设计）
> - **原 B 稿**：[优化方案：链路闭环/稳定性/性能/展现](2026-10-28-optimization-plan.md) → 本文 §4（缺陷清单）、§5（工作项 W0–W7 的代码级改法）
> - **原《总执行计划》** → 并入本文 §6（裁决）、§7（排期）、§9（并行规则），该文件已删除，避免第四份文档继续漂移。
>
> **怎么读**：只想知道"接下来干什么" → §1 + §5；想改代码 → §5 对应 wave + §8 口径；想论证"为什么这么设计" → §2/§3；想核对"现状是不是真的" → §4（每条都带 `文件:行号`，实测过）。
>
> **两稿的地位**：只作为**论证底稿与外部调研记录**保留（A 的酒馆/麦麦/AstrBot 一手资料很贵，别丢）。**排期、取舍、裁决一律以本文为准。**

---

## 1 一页纸

### 1.1 七条判断

1. **人设不是一个字段，是「六层 × 三通道」**：层按**变率**切（多久变一次），通道按**何时能知道**切（spawn 前 / 生成前 / 每一步）。你现在的 P1–P5 已经把"位置即设计"做对了（`compile.js:1-11`），缺的是**生成期通道 C3**。
2. **先修地基再谈分层**：四处地基（冷却表接线 / 场域字数 / 卡内预算 / 降级接线）不修，上面搭得越漂亮越假。**截至今天只剩 3 条半没修**（§4.1、§4.2）。
3. **最大的"假胜利"不在代码里，在配置里**：`personaPrompt` 是非空绝对路径 → `resolvePersona` 走 **legacy 直通**（`lib/persona/index.js:51-61`）→ **线上根本没走 v2 卡链路**，所有卡侧改动（冷却、场域字数、L0 口径、降级、归因）全是"潜伏"的。见 §4.4。
4. **质量门是当前唯一"能拦住错误"的机制**：全链路没有任何发布前 lint（`mcp_server.py:652` / `:825` 都是裸发），判据只在 `duty.md:83` 的散文里。
5. **两份方案的重复只有 ~1.5 人日，但缺口的性质不同**：A 缺"工程接缝"（记忆/门控/通道没有排期），B 缺"设计纵深"（不知道为什么这么分层）。合并后一件事只出现一次（§5 的 W0–W7）。
6. **"已完成"里有 3 个尾巴**：日志轮转"保留 2 代"没实现、`canonUsed` 只写不读、`commitPendingUsage` 无测试（§4.1）。0.3 人日补掉，否则会被"已完成"的错觉盖住。
7. **当前最大风险是工作树**：8 个文件已改 + 10 个未跟踪文件全部未提交（`npm test` 219 绿、四个 smoke 入口 exit=0）。**W0 先补尾巴再提交，然后才谈下一步。**

### 1.2 排期骨架（8 个 wave / 4 个迭代，单人 11.4 人日，双人 8–9 个工作日）

| 迭代 | Wave | 内容 | 人日 | 出口 |
|---|---|---|---|---|
| **S1** | W0 → W1 | 补 3 个尾巴 + 提交 → **切卡链路** → 地基一次重构 | 0.4 + 2 | `mode='card'` + 4 条地基关闭；快照字节级不变；测试 ≥225 全绿 |
| **S2** | W2 ∥ W3 | 归因（persona-inject）+ 质量门（lint）∥ 稳定性 6 项 | 2 + 1.5 | 账本可查"这轮吃了哪版"；"太强了"被拦；故障注入 7 例绿 |
| **S3** | W4 → W5 | 性能（增量读）→ 人设页 5 问 | 1 + 1.5 | 概览 p95 ≤5ms；人设页三块两态可读 |
| **S4** | W6 → W7 | 生成期通道 C3（A→B）→ 记忆 + 发言门控 | 2 + 2.5 | C3 不占 argv；同一 BV 不重复记忆；"为什么没说"可解释 |

**今日两件事**：① W0-1 补三个尾巴（30 分钟）→ W0-2 提交；② W1-6 切链路（先做内容 diff）→ W1-0 抽 `lib/persona/layers.js`。

### 1.3 统一基线数字（全文只用这一套）

| 指标 | 值 | 出处 |
|---|---|---|
| 测试 | **219 pass**（本稿基线）→ **432 pass / 0 fail**（W0–W7 之后实测） | `npm test` |
| 人设编译体量 | whale **1,404** / elaina 1,356 / generic 1,464 字符 | 实测 `compilePersona` |
| 分块体量 | core 885–1010 / lore 0–195 / state 157 / samples 72 / tail 95–117 | 同上 |
| 注入两段 | before ≈1010–1118（章程前）、after ≈324–346（末尾） | `index.js:82-91`（行号已漂移，见 §4.5） |
| 五块预算 | 1500 / 300 / 500 / 450 / 250 = **3,000** | `budget.js:16` |
| 整轮 prompt | 实测 **14,214**；软线 20,000 / 硬线 24,000 | `budget.js:22,25` |
| 账本轮转 | **5 MB** | `lib/ledger.js` |
| 真人评论基线 | 247 条：中位 27 字 / 句号 10.9% / 问号 12.6% / 表情 41.7% | 10-25 语料统计 |

---

## 2 设计：六层 × 三通道

### 2.1 六层（按变率切）

| 层 | 内容 | 变率 | 事实来源 | 通道 | 预算（字符） |
|---|---|---|---|---|---|
| **L0 红线** | `redlines` 摘要 + 禁令开关 + 收尾约束 | 版本级 | `card.redlines`、`cfg.ban*` | C1 摘要 + C2 尾注 | 120 |
| **L1 身份** | `identity` + `voice` 事实 + `canon` + 立场 | 版本级（冻结） | 卡 | C1 | 700 |
| **L2 世界** | 见闻索引 + 命中正文 | 慢变 | `loreIndex` + `lore/*.md` | C1 索引 / **C3 正文** | 300 / 600 |
| **L3 状态** | mood、时段、形态欠账、沉默、冷却 | 日 · 轮 | 账本派生（确定性） | C2 | 250 |
| **L4 手感** | 语料库 active 桶 | 慢变 | `bank` | C2 | 300 |
| **L5 现场** | 候选视频/热评/被回复内容/已接话/记忆摘要 | 步 | MCP 结果 + 账本 | **C3** | 400 |

argv 侧合计 ≈1370（与实测 1356–1464 持平），**C3 侧 ≈1000 字符不占 argv**。

### 2.2 三通道（按"何时能知道"切）

| 通道 | 位置 | 何时求值 | 装什么 | 纪律 |
|---|---|---|---|---|
| **C1 编译期-前段** | 章程之前 | spawn 前定死 | L1 身份 + L2 索引 + L0 摘要 | 只放**永不变**的；越短越好（每步都在前缀里） |
| **C2 编译期-后段** | 整轮 prompt 末尾 | spawn 前定死 | L3 状态 + L4 手感 + L0 尾注 | 只放**越靠后越有效**的约束；固定行数 |
| **C3 生成期-每步** | `systemPrompt.context` | 每个 step 重装配 | L2 命中正文 + L5 现场 | `interpolate:false`；失败必须静默降级 |

**C3 是新增价值，不是省钱**：酒馆的世界书**全部发生在编译期**（一次构建 prompt），只能匹配"已在上下文里的文本"，且官方明确卡片字段会被提前解析、Outlet 宏在卡字段里无法展开。DSH 每步重装配系统提示 → 我们能做**酒馆做不到的"生成期世界书"**：等模型看见视频标题/字幕/热评之后，再决定命中哪条见闻。

真实收益三条：**时机**（看见才知道的信息推迟到看见之后）、**卸载**（C3 不占 argv 24k 硬线，白得 ~1000 字符）、**前缀稳定**（一轮 20+ 次请求，L0/L1 全程不变）。跨轮没有缓存可省——每轮是独立 headless 会话，别自我感动。

### 2.3 六问定层法（新内容进哪个层）

按顺序问，命中即停：

| # | 问题 | 落到 |
|---|---|---|
| Q1 | 它会不会随「这一条评论」变？ | **L5 现场**（C3） |
| Q2 | 要不要**先看到视频/评论**才知道用不用？ | **L2 正文**（C3 命中） |
| Q3 | 它是不是**绝不能让模型自己编**的事实或计数？ | **L3 状态**（宿主算好） |
| Q4 | 它是不是「永不变的你是谁」？ | **L1 身份**（C1，必须短） |
| Q5 | 它是不是「越靠后越有效」的禁令/收尾约束？ | **L0 尾注**（C2） |
| Q6 | 它是不是只影响**风格**不影响事实的示例？ | **L4 手感**（C2，3–5 条） |

**兜底**：拿不准就放 L2 正文（按需读），**绝不**放 L1（每一步都在付 token）。

**三条铁律**：
1. **状态不许模型编**（心情、欠账、冷却、配额一律宿主算好，写成人话）；
2. **人格不许承载事实**（见闻/记忆/视频信息走 L2/L5，卡里只放"怎么说话、在乎什么"）；
3. **拿不准就放"按需读"**，别放"每步都在"。

### 2.4 预算、降级与中文特化

**优先级**（学酒馆）：常数项（L0/L1）先占 → **直命中优先于递归命中** → 剩余按 order。

**三层守卫 + 有序降级**：

```
层预算（L1 700 / L2 900 / L3 250 / L4 300 / L0 120）
  → 人设总预算 3000
    → argv 软线 20000（warn）/ 硬线 24000（over）
```

| 级别 | 动作（**按优先级砍，不整段丢**） |
|---|---|
| `warn` | `lore:shrink`（索引 8→5）、`samples:half`（4→2） |
| `over` | `lore:drop`、`samples:drop`、`state:shrink`，**保 L0 尾注**（性价比最高的一段） |

现在的真实行为是 `index.js:804-806` 超硬线**整段 `slice` 掉 after**——丢的正是最有用的尾注。这是 W1-5 要改的。

**C3 独立预算**：每步 ≤600 字符，排序 `直命中 > 冷却未用 > heat 低`，超限截断并记 note。

**中文特化（别照抄酒馆）**：`loreIndex.keys` 用**子串匹配**，不做整词边界（酒馆官方自己说 `match whole words` 对中日文有害，无空格分词）；大小写不敏感但全角/半角归一。

### 2.5 C3 的两条实现路径

| 路径 | 做法 | 成本/风险 | 阶段 |
|---|---|---|---|
| **A 工具** | `bili_persona_lore(keyword)`：宿主做 keys 子串匹配 + 冷却判定，返回命中正文（≤2 条 ≤600 字） | 多一次工具调用；**零安装、零风险** | **W6-1（本轮做）** |
| **B companion** | 约 200 行包 `dsh-bili-persona`，overlay 插一行，用 `ctx.systemPrompt.context({name:'bili:persona', order, interpolate:false, text})`；现场信息由宿主写 `round/<roundId>.json` 供其读取 | 动 headless profile（需一次性 `dsh plugin --profile headless add link:<路径>`）；依赖未文档化字段 | **W6-2（有条件，见 §6.1）** |

B 的三条契约风险（实施时逐条守）：
1. **必须 `interpolate:false`**——否则用户/见闻正文里的 `{{x}}` 会被宿主当模板变量解析，未注册即**整轮装配失败**；
2. `AssembleContext` 的类型声明只有 `{scope, signal}`，`agent` 是运行时塞进去的**未文档化字段** → 取会话信息必须 `try` + 兜底；
3. **现场信息走文件**，不要只依赖 `context.agent`。

---

## 3 对标与不抄

### 3.1 三个项目各解决了什么

| 问题 | 酒馆 SillyTavern | MaiBot（麦麦） | AstrBot | 我们该学谁 |
|---|---|---|---|---|
| **人设放哪层** | 卡片 `description/personality/scenario` 永久常驻；`mes_example` 随历史被挤出；`post_history_instructions` 放历史之后 | 三段解耦：`personality` / `behavior_style` / `reply_style`，单行模板注入 | Persona 是具名资源，profile 默认、会话（UMO）可强绑；注入点 `on_llm_request` 改 system prompt | 麦麦的**三段解耦** + AstrBot 的**会话可覆盖** |
| **关键词触发** | World Info：Key（支持正则）、Optional Filter、constant、Probability、Insertion Order、Inclusion Group、8 种 position、递归三档、Budget | 无（靠记忆检索） | 知识库 RAG：切块 512/overlap 50，20→5 条追加 | 酒馆的**命中规则与预算优先级**；**不学**向量 |
| **冷却与节奏** | Timed Effects：`sticky` / `cooldown` / `delay` | 记忆半衰期 24h、取用强化、`freeze` | 无（主动消息需自建频率闸） | 酒馆的 **cooldown 语义** |
| **记忆** | Summarize / Vector Storage | A_Memorix：向量+BM25 → RRF → PPR，检索 5 条、画像 ≤3 | 上下文压缩：超 ~82% 触发，保留 0.15，仍超整轮丢弃 | 麦麦的**半衰期 + 限量注入 + 频率限制** |
| **风格学习** | `mes_example` 示例块 | `Expression{situation, style, content[], count}`：情景→句式，≤20 字、3–10 条、count 加权、写入前 AI 复核 + 人工 `checked` | 无 | 麦麦的**情景→句式** |
| **说不说** | 无 | logistic：被提及 +1.59、@他人 −1.12、问号 +0.48、纯媒体 −1.03、5min 自身占比 +2.65、截距 −1.20；1h 预算**只收紧不放宽** | Proactive：`future_task` 定时投递 | 麦麦的**可解释特征 + 只收紧** |
| **超限兜底** | Context % / 绝对预算；常数优先、直命中优先 | 摘要 | 82% 阈值 → 压缩 → 整轮丢弃 | 酒馆的**优先级规则** |
| **可观测** | 触发日志 | WebUI + `monitor/planner_delta` | Trace 带 `persona_id` + 注入片段 | AstrBot 的 **persona_id + 注入片段留痕** |

三条来自一手文档、值得单独记住的细节：
1. 酒馆官方明确 **"match whole words" 对中日文有害** → 我们的 keys 必须**子串匹配**。
2. 酒馆官方明确**卡片字段会被提前解析，Outlet 宏在卡字段里无法展开**——这正是 `lore.js:5-9` 那句判断的官方依据。
3. AstrBot 明确 **persona 不承担事实**（事实放知识库逐条追加）；麦麦明确 **"聊天记录是参考资料，不能覆盖这些规则"**——两家结论一致：**人格管怎么说，事实管说什么**。

### 3.2 不抄清单

| 项目 | 别抄 | 原因 |
|---|---|---|
| 酒馆 | `match whole words` | 官方自己说对中日文有害；中文必须子串 |
| 酒馆 | Vector Storage 做见闻召回 | 结果不可预测、不可复现；见闻只有个位数，关键词足够 |
| 酒馆 | Inclusion Group 概率抽取 | 单人设无"多候选择一"需求，徒增不可解释性 |
| 酒馆 | Outlet 宏 | 卡字段提前解析不可用；"索引 + 按需读"更简单 |
| 麦麦 | SQLite + faiss + PPR 三件套 | 为万人群聊设计；单人号体量用不上，重且难复现 |
| 麦麦 | 24h 半衰期 | 群聊节奏；B 站内容寿命以天/周计 → 我们用 **7 天** |
| 麦麦 | 黑话子串匹配 | 没有可信黑话来源，误伤风险高 |
| AstrBot | 82% 阈值 + 整轮截断 | 单轮短会话（14k/240k）用不上；我们守的是 argv 硬线 |
| AstrBot | 向量知识库 | 换 embedding 需重建；见闻几十条，关键词更稳 |

---

## 4 现状（核实过的事实）

> 本节不是抄两稿，是**逐条到代码重新核过**：两个只读核实任务（"声称已完成的 9 条" + "声称未做的 13 组缺口"），外加本机实测。两稿的三处失准与行号漂移见 §4.5。

### 4.1 已完成（其中 3 条有尾巴）

| 项 | 证据 | 说明 |
|---|---|---|
| 冷却表接线 | `compile.js:225-231` 返回 `used{loreIds,canonKeys,expressionIds}`；`persona/index.js:99` 透传；`index.js:658-668` 落 pending、`:671-697` 轮末转正、`:681-685` 6h 过期、`:913` 在 `round-end` 调用 | 闭环真实生效（lore / 语料两路），**但有 3 个尾巴（见下表）** |
| SSE 首帧不再被丢 | `api.js:194` hello 无 seq；`client.js:775` `r.hasData && seq <= r.seq`；`:935` 同口径；`:797` tick 只丢更旧 | 有专测 `api.test.js:222-244` |
| 空态不再误报 | `client.js:1316` `health.cli !== undefined && !== null`；`:1185-1188` 无数据"正在连接…"；`:2676-2682` 三态 | render-smoke 有断言 |
| 宽行不再竖排 | `client.js:526-527` `.bf-row-wide{flex-direction:column}`；`:1269-1275` Row 输出类 | 六处 `wide:true` 实际在用 |
| 日志编码/轮转/尾部/降噪 | `logsink.js:19-28` 持久 `StringDecoder`；`index.js:872-873` 每流一个；`logsink.js:47-54` 按字节+换行切；`index.js:876` 尾部 4KB、`:880` stderr 全量；`logsink.js:67-77` 探测去重 | **轮转只保一代（缺 2 代）** |
| dshBin 缓存即时失效 | `index.js:411-412`/`:1068-1070` key 带 `cfg.dshBin`；`:1078-1081` `resetCliCaches`；`api.js:288` 保存后调用 | 无直接断言 |

**3 个尾巴（两稿都标 ✅，实际没做完）**：

| # | 事 | 实测 | 补法 |
|---|---|---|---|
| T1 | 轮转"保留 2 代" | `logsink.js:55` 只写一个 `.old`，`:40` 注释自认"只保一代" | 改 `.old`/`.old.1` 轮换，补"连续两次轮转两份都在" |
| T2 | `canonUsed` 冷却 | `state.js:167` 写入后**全仓无读取方**，`buildCore` 不按它过滤 → canon 冷却空转 | `compile.js` 的 canon 选取处加 `usedToday(canonUsed, key)` |
| T3 | 轮末转正测试 | `commitPendingUsage` 未 export，6h 过期/转正/roundId 校验零覆盖 | 导出 + 补 3 例 |

另有两条**口径修正**：`keepTail` 是**每 chunk** 截 4KB（`index.js:876`），不是整轮累计 → "单轮 <200KB"当前不成立；`resetCliCaches` 与 `health.cli` 守卫都没有直接断言。

### 4.2 未做缺口（全部仍在，一条都没被顺手修掉）

**链路闭环（B1）**

| # | 缺口 | 证据 |
|---|---|---|
| B1-2 | 场域字数：楼中楼 40 / 动态 60 从未生效 | `index.js:708` 硬编 `modeMax: 100`；`budget.js` 之外的 `buildState`（`compile.js:100,125`）其实已支持 `maxChars`，`buildTail`（`:132,143`）收了 `modeMax` 却没用 |
| B1-3 | L0 与注入口径分叉（**实际只 3 项**，见 §4.5） | `card.js:41`（`jargon.allow`）、`:58`（`stance[].misread`）、`:64-65`（`behaviorStyle`）算进 `injectedText`，`compile.js` 全文 0 命中 |
| B1-4 | 归因：无 `persona-inject` 事件、报告无 `personaTag`、`roundAccounting` 无该字段 | `personaTag` 只在 `persona/index.js:59,70,95` 返回，唯一落点是会被删掉的 `pending-usage.json`（`index.js:665`→`:691`） |
| B1-5 | 发布前零 lint | 无 `lib/persona/lint.js`、无 `lint-rules.json`、无导出脚本；`mcp_server.py:652-707` 与 `:843-870` 裸发；`expression.js:76` `looksCopied` **连测试都没调** |
| B1-6 | 降级未接线 | `budget.js:66` `degradationPlan` 无调用者；`index.js:804-806` 整段丢 after |

**稳定性（B2）**

| # | 缺口 | 证据 |
|---|---|---|
| B2-1 | overlay 失败静默无工具起轮 | `index.js:646` 失败 `return null`，`:843-846` 只 `if (overlay) args.push(...)`；overlay 正是 MCP insert 段（`:630-643`） |
| B2-6 | 回复轮询无超时/退避 | `replies.js:32-39` 无 `signal`；`:981-983` 失败只 log |
| B2-7 | 素材删除无留痕/无回收站/孤儿 | `index.js:1573-1593` 直连编辑；全仓无 `.bak`/`disabled`/孤儿扫描；语料库保存（`store.js:259-266`）无快照 |
| B2-8 | 两个 state.json 非原子写 | `index.js:263-264` `writeJsonSafe`、`state.js:152-155` `saveState` 直写（资产层 `store.js:42-52` 已原子化） |
| B2-9 | `personaPrompt` 存绝对路径 | 运行期实读确认（见 §4.4）；`index.js:200` 只 `z.string().default('')`；`persona/index.js:239` legacy 无条件 `ok:true` |
| B2-10 | spawn 无硬超时 | `index.js:850-862` spawn 后无 timeout/进程树 kill；heartbeat（`:988-999`）只改 `running` |

**性能（B3）**：`ledger.js:69` 每次全量 `readFileSync` + `:84` 全量 sort；`index.js` 内 **11 处** `readEvents(`（315/497/821/847/899/959/1093/1119/1549/1679/1813）；无 `ledger-index.js`、无 bench 脚本。**B 稿"20 处 / 每轮 600–1200 次全量"是估算，无法判定，改用 11 处入口。**

**只有 A 稿覆盖的设计缺口**

| # | 缺口 | 证据 |
|---|---|---|
| A-G2 | 卡内 `render.budget`/`position` 是死配置 | 三张卡都有（`whale.card.json:124-126`、`elaina:122-124`、`generic:128-130`），`budget.js:16` 写死同一组数；全仓 grep `render.` 0 命中，`validateCard` 也不校验 |
| A-C3 | 生成期通道未实现 | 全仓（js/py/patch）grep `systemPrompt` **0 命中** |
| A-门控 | 无 `speak-decision` 打分 | 只有配额硬上限 + `skipStreak`（`state.js:98-103`）+ 接话扫描必做 |
| A-记忆 | 无记忆条目/半衰期 | 只有三张按日冷却表（`state.js:163-171`）与 7 天聚合（`round.js:120-153`） |
| A-语料 | origin 只有二分、无反抄升级 | `growth.js:151-167` 仅 `self`/`community`（`blocked` 被拒 `:166`）；只做 self vs 账本（`:159`）与 vs 库内（`:172-174`），**没有"库条目 vs 原帖热评"** |

### 4.3 已完成条目的证据补充

- `npm test` → **219 pass / 0 fail / 1001ms**（与 B 稿"219"一致）；
- 四个 smoke 入口 `client.render-smoke.mjs` / `client.smoke.mjs` / `index.integration.mjs` / `e2e-fixture.mjs` → **exit=0 ×4**；
- 工作树：**8 个文件已改**（+375/−55）、**10 个未跟踪**（3 截图 + 4 文档 + 3 测试/模块）。

### 4.4 最大的假胜利：生产没走卡链路

- **事实**：运行期 `~/.dsh/bili-fenshen/config.json` 的 `personaPrompt` = `D:\projects\bilbili\dsh-plugin\prompts\persona-whale.md`（**非空绝对路径**）；`resolvePersona` 规则是"有 `personaPrompt` ⇒ legacy 直通"（`lib/persona/index.js:51-61`，返回 `mode:'legacy'`、`personaTag:'legacy'`）。同时确认 `persona/active.json` 已是 `{mode:'preset', presetId:'whale'}`——**卡侧早已就绪，只被这一行挡住**。
- **后果**：① v2 卡链路（六层/预算/冷却/场域字数/降级）全部"潜伏"；② **W0-1 的 canon 冷却、W2-1 的归因也一起潜伏**——`writePendingUsage` 开头就是 `if (personaRes.mode !== 'card') return`（`index.js:660`），legacy 下 pending 不写，`recordUsage` 自然调不到；③ "改卡不生效"的体感比代码证据更强。
- **所以 W1-6（切链路）必须是 W1 的第 0 步**（做法与回退见 §5.2）。

### 4.5 两稿的三处失准 + 行号漂移

| # | 两稿的说法 | 实测 |
|---|---|---|
| C1 | "`recordUsage` 全仓无生产调用 → 冷却表恒空" | **已修**（`compile.js:225-229` → `index.js:665` → `:686` → `:913`），现只剩 §4.1 的 3 个尾巴 |
| C2 | "四字段（`behaviorStyle`/`misread`/`judgement`/`jargon.quota`）都算已注入却不注入" | **只 3 项真分叉**：`behaviorStyle`、`stance[].misread`、**`voice.jargon.allow`（两稿都漏）**；`judgement`/`jargon.quota` **两边都没有**，谈不上"算已注入" |
| C3 | "`personaTag` 只在内存返回" | 多了一处临时落点 `pending-usage.json`（`index.js:665`，轮末 `:691` 删除）→ 结论不变（等于没留痕） |

**行号漂移**：两稿引用普遍偏 60–500 行（`index.js` 现 **1834** 行）。本文统一用实测值：`modeMax`=`index.js:708`（两稿写 631）、overlay=`646`/`843-846`（写 619/764-767）、语料见闻 POST=`1573-1593`（写 1469-1490）、丢 after=`804-806`（写 723-728）、`writeJsonSafe`=`263-264`。**实施时不要用两稿的行号定位。**

---

## 5 工作项（W0–W7）

> 人日是**单人当量** ±50%；带 ∥ 的可并行（§9）。每个 wave 收尾必须：`npm test` + 四个 smoke 入口 + 本 wave 验收。

### 5.1 总表（编号 → 内容 → 出处 → 现状）

| 编号 | 内容 | 出处 | 现状 |
|---|---|---|---|
| **W0-1** | 补 3 个尾巴 + 2 条便宜断言 | 两稿都回避 | ✅ 完成（轮转保 2 代 / canon 冷却接线 / commitPendingUsage 导出 + 3 例 / resetCliCaches 与 health.cli 断言） |
| **W0-2** | 已完成的改动与文档提交 | — | ✅ 完成（`git status` 干净） |
| **W1-6** | **切卡链路**（先 diff 再切） | 两稿都漏 | ✅ **已切**：diff 见 `docs/analysis/2026-10-28-w1-6-switch-diff.md`；补卡 4 项后 `personaPrompt` 置空（备份 `config.json.bak-w1-6`），实测 `mode=card` |
| **W1-0** | 抽 `lib/persona/layers.js` | A-P1 / B §7 | ✅（18 例 + 字节级快照） |
| **W1-1** | 冷却表接线 | A-P0-① / B-B1-1 | ✅ |
| **W1-2** | 场域字数 100/40/60 | A-P0-② / B-B1-2 | ✅（P3 场域表 + P5 同口径 + 章程 ≤80→≤40 对齐） |
| **W1-3** | 卡内 `render.budget`/`position` 生效 | A-P0-③（B 漏） | ✅ |
| **W1-4** | L0 与注入口径统一（3 项） | A-P0-⑤ / B-B1-3 | ✅（另：judgement/quota 定论不注入、尾注病句修复、canon 4→6） |
| **W1-5** | 降级接线（保尾注） | A-P0-④ / B-B1-6 | ✅（二次编译 + state:drop + 兜底砍前段保尾注） |
| **W2-1** | 归因 `persona-inject` + 报告/概览 `personaTag` | A-§11 / B-B1-4 | ✅ 完成（账本事件 + 报告头照抄行 + 概览字段） |
| **W2-2** | 质量门 lint（JS 规则 + Python 哑执行） | A-§8 / B-B1-5 | ✅ 完成：默认 warn + Python 哑执行 + **保存卡/语料库即重导规则文件**（保留人工 mode，失败不拖垮保存）+ 三个写接口透传 `lintRules`；规则文件已导到真实家目录 |
| **W2-3** | 语料治理（origin 三分 + 反抄 + situation/style） | A-§8 | ✅ lib 完成（生产接线待补：`bili_persona_note` 缺 `originalText`、`review`/`growthCheckedOnly` 未接 config） |
| **W3-1~6** | 稳定性 6 项（overlay/轮询/素材/原子写/路径/超时） | B-B2-1,6,7,8,9,10 | ✅ 全部：overlay 失败中止本轮 + `lastError` / 轮询超时退避 / 素材 `.bak`×3+软删+孤儿扫描 / 两处 state.json 原子写 / `personaPrompt` 支持 `preset:` 与相对根 / spawn 20 分钟硬超时 + 进程树 kill |
| **W3-7~8** | dshBin 缓存、日志治理 | B-B2-2,3,4,5 | ✅（含轮转 2 代） |
| **W4-0~4** | 性能：bench → 增量读 → 一次读多处用 → tick 降频 → 客户端合并 | B-B3-0~4 | ✅ **指标达标**：10 万行概览 p95 94.6→**4.68ms**（≤5）、单帧全流程 **5.02ms**（≤30）、11 处 `readEvents` 收敛为 1 个 reader（稳态读 bytesRead +0）、tick 空闲 0 帧、人设页 6 个 GET 30s 复用 |
| **W5-1~4** | 人设页三块 + 页头 | A-§10/§11 / B-B4 | ✅ 四块（页头 / 本轮实际注入 / 体检 / 换卡对比）各「有数据·无数据·正在连接」三态 + 断言 |
| **W6-1** | C3 路径 A：`bili_persona_lore(keyword)` | A-§6 路径A | ✅ 工具落地（24 例）+ 提示词侧已切换 + `dutyTools` 白名单 |
| **W6-2** | C3 路径 B：companion（**有条件**） | A-§6 路径B | ⏸ 暂缓（§6.1 三条门槛未变） |
| **W7-1** | 记忆：聚合 + 重要度 + 7 天半衰期 + 限量注入 | A-§7 | ✅（C2 注入 ≤2 条 ≤300 字；通道迁 C3 可等 W6-2） |
| **W7-2** | 发言门控：6 特征打分 + `speak-decision` | A-§9 | ✅ 完成：`lib/persona/speak.js`（候选级 6 特征打分 + 轮级节奏闸）；默认 **observe 只记不拦**，`enforce` 才压上限；`speak-decision` 落账本、概览 `round.speakGate`、控制台三处可读 |
| **W7-3** | 体检超阈值 → 下一轮自纠 | A-§10 | ✅（超阈值才加一句动作；结论写进 `persona-inject.checkup`） |

### 5.2 W0 · 补尾巴 + 收尾提交（0.4 人日）

**W0-1（0.3d）**：① `logsink.js:55` 轮转补 2 代 + 断言；② `state.js:167` canon 冷却接上 `usedToday` + 断言；③ 导出 `commitPendingUsage` + 补 3 例（过期丢弃 / roundId 不符忽略 / 正常转正）；④ 补 2 条便宜断言（`resetCliCaches` 被调用、`health.cli === undefined` 不判红）。

**W0-2（0.1d）**：拆 3 个代码提交 + 1 个文档提交（`git add -p` 拆 `index.js`）：
1. `fix(console): SSE 首帧 + 空态三态 + 宽行纵向堆叠`
2. `fix(logsink): UTF-8 持久解码 + 按字节轮转（含 2 代）+ 尾部保留 + 探测降噪`
3. `feat(persona): 冷却表接线（pending → 轮末转正 → canon 冷却启用）`
4. `docs: 统一方案 + 控制台问题清单 + 两份论证底稿`

**验收**：`git status` 干净；`npm test` **≥225**（219 + 6~7 例）；四入口 exit=0。

### 5.3 W1 · 切链路 + 地基一次重构（2 人日，串行，独占 `buildDutyPrompt`）

**为什么一次做完**：W1-2/3/4/5 全在 `compile.js` 返回值与 `index.js:699-830` 的 `buildDutyPrompt` 里，分四次做等于把这个 ~130 行单体改四遍，还让 W3/W4 一直等它。

| 序 | 条目 | 改哪 | 关键点 |
|---|---|---|---|
| 0 | **W1-6 切链路** | 配置 + `lib/persona/index.js` | 见下表四步；**先 diff 再切** |
| 1 | **W1-0 抽 layers.js** | 新增纯函数 `buildLayers({card, state, bank, now, modes, budget, degrade, used}) → {c1, c2, c3Hints, used, stats}` | `buildDutyPrompt` 只剩"取数 → 调纯函数 → 拼装"；**快照测试锁字节级同输出** |
| 2 | **W1-2 场域字数** | `modes = {comment:100, reply:40, dynamic:60}` 取代 `index.js:708` 的 `modeMax:100` | 改点只在调用处；P3 输出一行场域表；**控制台预览用同一份 modes**（消除预览≠实际） |
| 3 | **W1-3 卡内预算** | `layers.js` 读 `card.render.budget`，缺省回落 `budget.js:16`；`render.position` 决定 C1/C2 位置 | 三卡数值与现状相同 → 行为不变，只把开关接上 |
| 4 | **W1-4 L0 口径** | `behaviorStyle` 1 行进 P5 尾注；`stance[0].misread` 进 P1 立场括号；`jargon.allow` 并入 `voiceFacts` 的"可用但少用"行 | 另给 `judgement`/`jargon.quota` 定论（补进卡+注入，或从设计删）；新增"口径一致性"测试：L0 认作已注入的字段，其片段必须真出现在 `compilePersona().text` |
| 5 | **W1-5 降级** | `layers.js` 接受 `degrade`，超软线**二次编译**再拼 | 现在 `index.js:804-806` 整段丢 after；改成先砍见闻/示例、保尾注；实际降级写进 `persona-inject.degraded` |

**W1-6 切换四步（不可跳）**：

| 步 | 做什么 | 判据 |
|---|---|---|
| 1 | `compilePersona({card: whale})` 与 `persona-whale.md` 直通文本做**人工 diff** | 差异逐条可解释：卡有 md 无 → 补进卡；md 有卡无 → 决定丢弃或补卡 |
| 2 | `personaPrompt: ""`（`active.json` 已是 `preset:whale`，无需改） | `resolvePersona(...).mode === 'card'`，日志出现 `personaTag` |
| 3 | 冷启动一轮，看报告头/`persona-inject` | 报告头有"人设：whale@x.y.z（五块 chars）" |
| 4 | 回退 = 把 `personaPrompt` 填回原值 | 30 秒回到旧行为 |

**风险**：切换会**真实改变线上说话风格**（卡片 ≠ md）。diff 不能跳；差异 >20 条不一致就先补卡再切，别"边切边补"。

**验收**：① `mode==='card'`；② 同日两轮不重复见闻（P2 出现"今天用过了"）；③ 80 字楼中楼按 40 判超限；④ 凌晨+reply 取更严值；⑤ 25k prompt 时尾注仍在；⑥ whale 编译快照不变（除有意口径补齐）；⑦ `npm test` ≥225 + 新增用例。
**回滚**：模式缺省回旧行为；`degrade` 默认空数组；L0 可留 `injectLegacyFields:false`；切链路填回 `personaPrompt`。

### 5.4 W2 ∥ W3 · 归因 + 质量门 ∥ 稳定性（2 + 1.5 人日）

> 文件几乎不重叠（W2 动 `lib/persona/*` + `mcp_server.py`；W3 动 `index.js` 进程/存储段 + `replies.js`）。**唯一碰撞点是 `index.js`**：约定 W2-1 先落（0.5d），W3 再动同文件。

**W2-1 归因（0.5d，W5 前置）**：账本新增 `{type:'persona-inject', round, personaTag, mode, channel, layers:[{name,chars,max}], hits:[], degraded, notes:[]}`，在 `buildDutyPrompt` 成功后 append（成本 0）；报告头加一行"人设：whale@x（core/lore/state/samples/tail）"由宿主拼进"本轮参数"、模型照抄；`round.js` 的 `roundAccounting` 增 `personaTag` → 概览 `round.lastRound.personaTag`。
**W2-2 质量门（1d）**：细则见 §8.1；`mcp_server.py` 的 `bili_reply`（`:652`）与 `bili_send_dynamic`（`:825`，校验段 `:843-870`）前置检查。
**W2-3 语料治理（0.5d）**：细则见 §8.3。
**W3 稳定性（1.5d）**：6 项（overlay 失败中止本轮并写 `lastError` / 轮询 `AbortSignal.timeout(8000)` + 1min→5min→15min 退避 + `inbox.lastError` / 素材 `.bak-<ts>` + 软删除 `disabled:true` + 孤儿扫描 / 两处 state.json 走 tmp+rename / `personaPrompt` 支持 `preset:` 与相对根 + 解析失败 warn / spawn 20 分钟硬超时 + 进程树 kill + `round-end code='timeout'`）+ 新增 `test/fault-injection.test.js` 七例（overlay 写失败 / 账本半截行 / 卡 JSON 损坏 / state 半截 / 规则文件缺失 / spawn 立即退出 / 报告缺失）。

**验收**：账本可查 `persona-inject`、概览有 `personaTag`；"太强了"被拦且理由可读；规则文件缺失 → 放行 + 告警；删 `<home>` 写权限 → 本轮**标记失败**而非空跑；断网 → 概览"上次失败·Ns 前重试"；挂死 → 20 分钟内 `timeout`。

### 5.5 W4 · 性能（1 人日）→ W5 · 展现（1.5 人日，依赖 W2-1）

**W4**：`W4-0` bench 脚本（1k/10k/100k 行 + 概览 p95，**没有前后数字不许动 `readEvents`**）→ `W4-1` 新增 `lib/ledger-index.js` `createLedgerReader(file)`（stat 未变 0 次读盘 / size 增大只读增量段 / size 变小全量回退并记 `fallbacks`）并把 **11 处**调用收敛为一个实例 → `W4-2` 一轮一次读多处用 → `W4-3` 空闲不推 tick 帧 → `W4-4` 人设页 4 个请求合并为 `/persona/bundle`（或 30s 复用）。
**验收**：10 万行概览 p95 ≤5ms、重算 ≤30ms；无变化时 `readFileSync` 0 次（fs 计数注入）。
**回滚**：reader 是新增模块，切回 `readEvents` 即旧行为。

**W5**（复用 `bf-` 控件与 `--dsw-*`，字号白名单 11/12/13/14/16/18/20/24，空态"正在连接…"）：

| 块 | 回答 | 数据来源 |
|---|---|---|
| 页头一行 | 这个号现在是谁 | `GET /persona` |
| 本轮实际注入 | 上轮吃了什么 / 超预算了吗 / 砍了谁（五块进度条 + 命中见闻 + 降级徽标） | `persona-inject` + 编译 stats |
| 体检 | 说话还像它吗（近 20 条 vs 247 条基线） | 账本聚合（§8.2 口径） |
| 换卡对比 | 改了卡有变好吗（按 `personaTag` 分组各 3 条评论 + 点赞） | `persona-inject` + 活动聚合 |

**验收**：每块"有数据/无数据"两态各一条 render-smoke 断言；不得回归"找不到 dsh CLI""数据 刚刚"。

### 5.6 W6 · 生成期通道（2 人日，W6-2 有条件）

**W6-1（0.5d，必做）**：`bili_persona_lore(keyword)`——宿主做子串匹配（中文**不许整词**）+ 冷却判定 + 返回 ≤2 条 ≤600 字；同时把语料的注入形态升级为「当 S 时，可以 X」（§8.3 的结构在 W2-3 已就位）。
**W6-2（1.5d，暂缓）**：companion 包 + overlay 插行（照抄 `index.js:602-618`）+ `interpolate:false` + 现场信息写 `round/<roundId>.json`；**门槛见 §6.1**。
**验收**：正文含 `{{x}}` 不致装配失败；无文件/无网络/字段缺失全部**静默降级不抛**；C3 内容不计入 argv 24k。

### 5.7 W7 · 记忆 + 门控（2.5 人日，硬依赖 W4；W7-3 依赖 W5-2）

细则见 §8.4/§8.5。**为什么必须排在 W4 后**：记忆聚合与门控特征都要从账本反查（同 BV 去重、近 5 条发言占比、被回复/被@），在增量读落地前做，等于给 11 处全量读再加两处。**兜底**：W4 若延期，先做"只读最近 7 天窗口 + 复用 `lib/activity.js`"的窄版。

**合计**：W0 0.4 + W1 2 + W2 2 + W3 1.5 + W4 1 + W5 1.5 + W6 2 + W7 2.5 ≈ **12.9 人日**（W6-2 不计则 **11.4**）。

---

## 6 八处裁决

### 6.1 companion 插件：本轮不做，路径 A 先行

A 稿推荐（收益最大），B 稿明令本轮不做（涉及 profile 改动）。**裁决：B 的禁令只对"本轮"成立，不由它否掉方向；A 的收益也不足以插队。**

**W6-2 启动门槛（三条同时满足）**：① W1–W5 全部收口且连续 3 天值班无回归；② 账本有**确凿证据**至少 2 轮"看见视频/热评才知道该用哪条见闻"却漏用（`persona-inject.hits` 空但索引有高相关条目）；③ headless profile 可写且 `dsh plugin --profile headless add link:` 已用临时 profile 演练成功。任一条不满足 → 继续挂着，**不影响 W6-1 交付**。

### 6.2 卡内 `render.budget`：生效，读卡优先、`budget.js` 作缺省

理由：卡是编辑面，预算是"这张卡想吃多少"的表达；三张卡数值与 `budget.js` 相同 → 读卡不改变现有行为，只把开关接上。`render.position` 同理（`before-charter`/`after-params` 正是现在硬编的两处）。

### 6.3 质量门：规则只在 JS，Python 哑执行

1. **规则文件缺失/解析失败 → 放行 + 告警**（绝不因规则坏了全线停摆）；
2. **先 `warn` 三天**，误杀率 <5% 才切 `block`；`off` 一键回滚；
3. Python 只读 `<home>/persona/lint-rules.json`，**不复制规则**；卡 `voice` 一改就重导（挂在"保存卡"同一路径）。

### 6.4 记忆/门控必须排在性能之后

见 §5.7。这是两稿都没说清的依赖反转。

### 6.5 体检：一次实现、两处消费

A §10 与 B B4-第4问是同一件事。纯函数算指标（W5-2 渲染用），同一份阈值判定喂给下一轮 L3 自纠（W7-3）。口径只写一次（§8.2）。

### 6.6 门控 ≠ 多发

配额仍是**硬上限**，门控只在配额内收紧、永不放宽（麦麦教训：一波消息会抬高预期基数，导致系统性偏多）；被 @/被回复**直接放行且不计分**，但**仍占配额**。

### 6.7 基线数字统一

见 §1.3。全文只用那一套；B 稿的"20 处调用 / 600–1200 次全量"改为实测 11 处 + 由 bench 给真实数字。

### 6.8 切链路与可移植性是两件事

W1-6 是"让卡链路生效"（改运行期配置），W3-5 是"让配置可移植"（改表示法）。**W1-6 先做**，否则 W3-5 改完仍是 legacy 直通。

---

## 7 排期、依赖与并行

### 7.1 依赖图（含关键路径）

```
W0（尾巴+提交）── W1-6 切卡链路（门） ──┬── W1-0 layers.js（结构前置）
                                        ├── W1-2 场域上限 ─┐
                                        ├── W1-3 卡内预算 ─┤  （同一函数，必须一次做完）
                                        ├── W1-4 L0 口径  ─┤
                                        └── W1-5 降级     ─┘
                                             │
                                             ├── W2-1 归因 ──────────────┬── W5 展现（三块）
                                             │        │                  └── W5-2 ── W7-3 自纠
                                             ├── W2-2 质量门 ── W2-3 语料治理
                                             │
                                             └── W3 稳定（可与 W2 并行，index.js 串行点：W2-1 先落）

W2-1 ── W4-1 增量读 ── W7-1 记忆 ── W7-2 门控
W2-2 ── W6-1 工具通道 ── W6-2 companion（有条件）
```

**关键路径**：`W0 → W1（含切链路）→ W2-1 → W5` ≈ **6.5 个工作日**；W7 尾巴 +2.5 → **8–9 个工作日**（两人并行）。
**最长等待链**：`W1 → W2-2 → W6-1`（先能拦，再谈"看见才知道"的注入）。

### 7.2 按人日分档取舍

| 只有 | 做到 | 用户能看到 |
|---|---|---|
| **~2.5 人日** | W0 + W1（含切链路 + 4 条地基） | 人设真的生效：不重复讲旧事、场域字数对、超限不砍尾注、改卡终于生效 |
| **~5 人日** | + W2-1 + W2-2（先 warn） | 账本可查"这轮吃了哪版"；"太强了"发出去前被拦（只告警） |
| **~9 人日** | + W2-3、W3、W4、W5、W6-1 | 页面不再静默空跑；概览 ≤5ms；人设页 5 问有答案；可按需取见闻正文 |
| **~11.5 人日** | + W7 | "为什么这轮没说""说过的别再讲"变成可查、可回归的数字 |
| **~13 人日** | + W6-2（仍受门槛约束） | 真正的生成期世界书 |

---

## 8 质量门、记忆、语料、门控的设计口径

> 这一节是"改成什么样"的规格；§5 说的是"在哪改、怎么验"。两稿里散落的设计细节集中到这里，避免实施时再翻文档。

### 8.1 发布前 lint（W2-2）

**单一事实来源在 JS**：新增 `lib/persona/lint.js`（纯函数，可单测）：

```
lintComment({ text, mode, card, rules, bank }) → { ok, level:'block'|'warn', codes, reasons, advice }
```

| 判据 | 内容 |
|---|---|
| **L1 落点** | 收尾不得是空泛捧场（词表：不错/学习了/太强了/牛/爱了/支持/收藏了） |
| **L2 自足** | 首句不得以指代开手（这个/那句/上面/他/它 + 前面没有名词） |
| **L3 再创作** | 整句被引号包裹且 ≥8 字（复述未加工信号） |
| **L4 反抄** | 与 bank active 的 2-gram Jaccard > 0.6（复用 `expression.js:76` 的 `looksCopied`，终于接线） |
| **L5 形态** | comment >100 / reply >40 / dynamic >60；句号 >1；表情 > `card.voice.emoji.perComment` |
| **L6 红线** | `card.redlines` 的 lexicon 命中（如 policy:politics） |
| **L7 禁用词** | `voice.avoid.*` 命中 |

**导出**：`scripts/export-lint-rules.mjs` → `<home>/persona/lint-rules.json`，阈值来源 = 247 条真人基线 + 当前卡 `voice` 事实 + 场域上限；**卡一改就重导**。

**Python 哑执行**：`bili_reply` / `bili_send_dynamic` 发布前读该文件，`level==='block'` → 不发，返回 `{ok:false, code:'LINT_BLOCKED', codes, reasons, advice}`；文件缺失/解析失败 → **放行 + 警告**。

**测试**：每判据 pass/fail 各 1 例（≥14 例）；规则缺失→放行；Python 侧一条断言 L1 被拦。

### 8.2 体检指标（W5-2 / W7-3）

每 N 条算一次：句长分布（中位）、句号/条、表情/条、禁用词命中率、收尾类型分布、与 L1 `voice` 事实的偏离度。**基线是固定常量**：中位 27 字 / 句号 10.9% / 问号 12.6% / 表情 41.7%（247 条真人）。

超阈值 → 下一轮 L3 加一条自纠（"你最近话变长了，收短"）并记 `persona-checkup`。价值：把酒馆靠"深度注入"的经验，变成**可度量、可回归**的指标。

### 8.3 语料学习（W2-3 / W6-1）

现有六桶 + `active/candidate` + `heat` + 0.6 反抄 + growth 管道是对的，补三件：

1. **来源三分** `origin: self | community | blocked`：`self` 走账本对账，**只收自己真发出去的**；`community` 只收热评且入库前跑"与原帖"改写检查；`blocked` 永不入库，只做反例。
2. **结构升级**：条目加 `situation`（"当…时"）+ `style`（"可以…"），各 ≤20 字；注入改成「当 S 时，可以 X」，≤5 条 ≤300 字（麦麦实测这个粒度才不复读）。
3. **写入闸门**：`count` 加权 + 写入前 AI 复核 + `checked=false` 人工位。
4. **反抄升级**：现在只比对"草稿 vs 库内"，要补"库条目 vs 原帖热评"——否则 `community` 条目本身就是抄来的（seed 的 `source` 字段目前无校验）。

### 8.4 记忆（W7-1）

- **事实源不变**：账本仍是唯一来源；记忆 = **活动聚合**（`lib/activity.js` 已有）+ 重要度，**不造第二套库**。
- **条目**：`{id: bv+type, bv, title, up, myText, replies, at, importance, lastUsed}`。
- **重要度**：被回复 +3 / 被赞 >5 +2 / 我评过 +1 / 仅看过 +0；**半衰期 7 天**。
- **注入**：≤3 条、≤600 字，与当前 UP/关键词相关时才注入；通道先 C2（≤2 条 ≤300 字），C3 就绪后迁 C3。
- **纪律**：`external_id` 幂等、重复条目复用正文并追加证据、**不做向量**（换 embedding 必须重建且不可复现）——用"关键词 + 时间窗 + 重要度"的确定性检索，与 `deriveState` 的可复现哲学一致。

### 8.5 发言门控（W7-2）

| 特征 | 权重 | 理由 |
|---|---|---|
| 被回复 / 被 @ | +1.6 | 麦麦被提及 +1.59；最该接的信号 |
| 评论含问号 | +0.5 | 有明确可答点 |
| 我近 5 条发言占比 | **−2.6** | 麦麦 +2.65 的**反向**用法：防刷屏 |
| `log(距上次发言)` | +0.06 | 久不说话则该多说 |
| 候选新鲜度 | +0.1 | 新投稿优于老视频 |
| 纯媒体 / 无文本 | −1.0 | 无话可说 |
| 截距 | −1.2 | 默认不发言 |

**阈值 + 只收紧不放宽**；配额仍是硬上限；被 @/被回复直接放行不计分（但仍占配额）。账本记 `speak-decision {score, features, decision}` → 控制台可解释"这轮为什么没说"。

---

## 9 文件冲突域（并行前先看）

| 文件 | 被谁改 | 串行规则 |
|---|---|---|
| **运行期** `~/.dsh/bili-fenshen/config.json` | W1-6（切链路）、W3-5（表示法） | 不在仓库里但影响最大；W1-6 先，W3-5 后 |
| `dsh-plugin/index.js` | W1（`buildDutyPrompt` 699-830）、W2-1、W3、W4、W6-1 | **W1 独占完成后**才放其他；W2-1 先落再放 W3；W4 只碰 `readEvents` 调用点；W6-1 只碰 `tools`（`:624-628`） |
| `lib/persona/compile.js` / 新增 `layers.js` | 仅 W1 | 独占 |
| `lib/persona/{card,budget,state,expression,lore}.js` | W1（budget/state）、W2-3（expression）、W7-1（state） | W1 先；W2-3 只动 `expression.js` |
| 新增 `lib/persona/lint.js`、`scripts/export-lint-rules.mjs` | 仅 W2-2 | 独占（新文件） |
| `mcp_server.py` | W2-2（`bili_reply` `:652` / `bili_send_dynamic` `:825`+`:843-870`）、W6-1 | W2-2 先；W6-1 只追加工具，不改既有签名 |
| `client.js` | W4-4（请求层）、W5（渲染块） | W4-4 先 |
| `lib/replies.js` | 仅 W3-2 | 独占 |
| `lib/ledger.js` / 新增 `lib/ledger-index.js` | 仅 W4 | 独占 |
| `lib/round.js`、`lib/report.js` | W2-1、W5-3 | W2-1 先 |

**可并行**：W2-2 ∥ W3（新文件 vs 进程段）、W4 ∥ W5 前半（ledger vs 渲染）、W7 ∥ W6-2（账本派生 vs companion）。
**禁止并行**：W1 与任何动 `index.js` 的 wave；W2-1 与 W3 同时改 `index.js`。

---

## 10 验收、风险、不做、待拍板

### 10.1 全局 DoD

1. `npm test` ≥ **225**（219 + W0-1 的 6~7 例），四入口 exit=0；
2. `scripts/bench-ledger.mjs` / `bench-overview.mjs` 有前后数字（W4 前后各一次）；
3. 真机各一次：冷启动首屏有数据（已达成）｜账本出现 `persona-inject`｜同日两轮不重复见闻｜"太强了"被拦｜`duty.log` 无乱码｜楼中楼 ≤40 字｜人设页三块可读；
4. 每 wave 独立可回滚：W1 的开关是 `modes`/`degrade`/`injectLegacyFields`；W2 是 `lint-rules.json` 的 `mode`；W6 是 overlay 插行；
5. 任何 wave 不得让 `duty.log` 出现新的 `U+FFFD` 或 ERROR（最便宜的回归哨兵）。

### 10.2 风险表

| 风险 | 影响 | 对策 |
|---|---|---|
| **未提交状态被覆盖** | 1.5 人日工作蒸发 | W0 先提交；提交前后各跑一次测试 |
| 质量门误杀 | 账号变闷 | `warn` 三天、误杀 <5% 才 `block`；L1 词表用基线筛 |
| 规则文件缺失 | 全站发不出去 | Python 侧缺失 = 放行 + 告警 |
| 增量读遇非 append 写 | 读到半截/漏事件 | size 变小即全量回退；首周记 `fullReads`/`fallbacks` |
| companion 未文档化字段失效 | 宿主升级后注入静默消失 | 现场信息走文件；取值全 `try`；W6-2 前先演练 |
| `{{x}}` 正文 | 整轮装配失败 | `interpolate:false` + 过 `sanitizeForHost` |
| 降级二次编译 | 每轮 +1ms | 仅 `level!=='ok'` 触发 |
| 记忆变成复读旧事 | 人设更假 | 半衰期 7 天 + ≤3 条 + 相关性门槛 |
| 门控调成话痨 | 刷屏 | 硬配额不变、只收紧；被 @ 也占配额 |
| 体检基线漂移 | 自纠把语气带偏 | 基线是固定常量，随版本号改 |
| 三份文档各自漂移 | 排期又对不上 | 本文是唯一执行口径；两稿只作论证底稿 |

### 10.3 本轮不做

❌ 向量记忆 / RAG（见闻 >50 条再评估）｜❌ companion 插件（W6-2 有门槛）｜❌ 试写沙盒｜❌ 动宿主 token/控件几何｜❌ 改 `mcp_server.py` 既有工具签名（只加 lint 前置与新工具）｜❌ 第二套记忆库（记忆 = 账本聚合）。
**不抄**：见 §3.2。

### 10.4 待拍板（6 件，按影响排序）

1. **W1-6 要不要切卡链路**——不切，W1 的改动等于白做；切，会真实改变线上说话风格。**唯一"不切就问"的项。**
2. **W0 的三个提交现在就做**（影响 `git log` 形状，不影响代码）；
3. **L0 口径选 A（真注入）还是 B（从 L0 移除）**——推荐 A，代价 +2~3 行；
4. **质量门先 `warn` 几天**（建议 3 天）；
5. **记忆半衰期 7 天**是否接受（麦麦 24h 是群聊节奏）；
6. **W6-2 companion 是否立项**（建议先不做，等 §6.1 门槛）。

---

## 11 附录

### 11.1 来源

- **外部一手资料**（详细 URL 与逐条核对见 A 稿 §15）：酒馆 World Info / Character Design / Author's Note / Prompt Manager；麦麦人格四段与 A_Memorix / 发言门控 / 表达学习；AstrBot WebUI / 知识库 / 上下文压缩 / 事件钩子 / 主动消息。
- **本仓库**：`lib/persona/{compile,budget,state,expression,lore,card,growth}.js`、`index.js`、`client.js`、`lib/{ledger,replies,round,report,activity,api}.js`、`mcp_server.py`。
- **核实方式**：两个只读核实任务逐条取 `文件:行号`（"已完成 9 条" + "未做 13 组"），外加本机实测 `npm test` / 四个 smoke 入口 / `git diff --stat` / 实读运行期 `config.json`。

### 11.2 关键行号锚点（**以本节为准，两稿已漂移**）

`index.js:708`（`modeMax:100`）｜`index.js:699-830`（`buildDutyPrompt`）｜`index.js:656-697`（pending-usage）｜`index.js:660`（legacy 不写 pending）｜`index.js:804-806`（丢 after）｜`index.js:646`、`:843-846`（overlay 静默）｜`index.js:624-628`（工具白名单）｜`index.js:263-264`（`writeJsonSafe` 非原子）｜`lib/persona/index.js:51-61`（legacy 直通）、`:239`（无条件 ok）｜`lib/persona/state.js:152-155`（`saveState` 非原子）、`:167`（`canonUsed` 写入）｜`lib/persona/budget.js:16,22,25,66`｜`lib/persona/expression.js:76`（`looksCopied`）｜`lib/logsink.js:40,47-55`｜`lib/ledger.js:69,84`｜`lib/replies.js:32-39`｜`prompts/persona/whale.card.json:124-126`｜`mcp_server.py:652`（`bili_reply`）、`:825`/`:843-870`（`bili_send_dynamic`）。

### 11.3 四份文档的分工（读完即归档）

| 文档 | 角色 | 何时读 |
|---|---|---|
| **本文** | **唯一执行口径** | 任何时候先读这里 |
| [人格注入分层方案](../persona-layer-design.md) | 方法与外部调研底稿 | 想论证"为什么六层三通道"或查外部资料 URL |
| [优化方案](2026-10-28-optimization-plan.md) | 缺陷根因与最小改法的原始记录 | 想回溯某条缺口的推导过程 |
| [控制台问题清单](../CONSOLE-ISSUES-2026-10-28.md) | B0/B2 的原始排查与修复进展 | 查控制台问题的现场证据（截图/日志） |

---

## 12 进度快照与下一波（2026-10-28 夜）

> 这一节是**执行记录**，不是设计。每次收口后追加，别改上面的设计段落。

### 12.1 已交付（W0 / W1 / W2 / W3 部分 / W4 前半）

| 项 | 结果 | 证据 |
|---|---|---|
| W0 三个尾巴 + 2 条便宜断言 | ✅ | `commits 57c6d58 / 4406984 / 2c16bee` |
| W1 全波（含切卡链路） | ✅ | `commit 45ed973`；实测 `mode=card / whale@2.2.0` |
| W2-1 归因闭环 | ✅ | `commit 9644e91`；账本 `persona-inject` + 报告头行 + 概览 `round.personaTag` |
| W2-2 质量门 | ✅ 代码（默认 warn） | `commit 999f387`；27 例，含 JS↔Python 判定逐字一致 |
| W2-3 语料治理 | ✅ lib | `commit 697999d`；seed 输出逐字节不变 |
| W3 部分 | ✅ 3/6 | 轮询超时退避 / state 原子写 / 故障注入 8 例（`commit 9008446`） |
| W4 前半 | ✅ 2/5 | `commit 9644e91`；bench 前后数字见 `docs/analysis/` |

**测试基线**：219 → **327 pass / 0 fail**；四个 smoke 入口 exit=0（每波收尾都跑）。

### 12.2 本波实测得到的三个硬数字

1. **人设注入体量**：whale 卡编译 1,913 字符 / 五块 core 1281 · lore 236 · state 112 · samples 140 · tail 159
   （预算 3000，未超任何块）；报告头那行：`人设：whale@2.2.0（core 1281 / … · 合计 1928 / 3000；降级：无）`。
2. **账本/概览**（10 万行，`scripts/bench-ledger.mjs`）：
   - 概览纯计算 p95 **2554ms → 99ms**（`lastRoundFrom` 的 O(轮次×事件) 改单遍）；
   - 一次概览全流程（全量读 + 概览）p95 **2729ms → 343ms**；
   - 增量读稳态（文件没变）p95 **0.12ms / 读盘 0 字节**（500 次连读 bytesRead +0）。
   - ⚠️ 与 §5.5 的「10 万行概览 ≤5ms」还有差距：`countToday`/`presenceFrom` 仍扫全量事件，
     11 处 `readEvents` 调用点也还没收敛成一个 reader —— 这是下一波 W4-2/3 的入口。
3. **W1-6 内容 diff**：A 类矛盾 9 / B 类实质缺失 21 / C 类 5 / D 类约 22 组同义，
   其中 **41 项被章程 `duty.md:85-97` 与宿主 prompt 重复覆盖**（所以 md 的 12k 字符边际内容远小于观感）。
   详见 `docs/analysis/2026-10-28-w1-6-switch-diff.md`。

### 12.3 切链路（W1-6）的实际做法与回退

1. 先 diff（不跳步），按结论**先补卡再切**：`identity.boundaries` +5 条（能力边界 / 不编事实 /
   不冒充官方 / 不传谣 / 不碰黑产与私德）、`food-wedding` 见闻改写（原句是真人语料里的别人原话）、
   `version 2.1.0 → 2.2.0`；**话题红线仍只有政治一条**（主人 10-27 拍板不变）。
2. 章程 `duty.md` 的楼中楼上限 **≤80 → ≤40**（与卡内 `voice.modes.reply=40`、方案验收③对齐）。
3. 运行期 `~/.dsh/bili-fenshen/config.json` 的 `personaPrompt` 置空；原文件备份为
   `config.json.bak-w1-6`。
4. **回退（30 秒）**：把 `personaPrompt` 填回 `D:\projects\bilbili\dsh-plugin\prompts\persona-whale.md`
   （或直接覆盖回备份文件）。
5. **尚未做的验收**：真机冷启动一轮（会真实发评论、占配额）留给主人手动触发；
   切换前已做只读验证：`resolvePersona(cfg) → mode=card / whale@2.2.0`，P3 与 P5 的场域口径一致。

### 12.4 下一波建议顺序（按依赖，不按人日）

1. **W4-2/W4-3**：把 `index.js` 的 11 处 `readEvents` 收敛成 `ledgerReaderFor()` 一个实例 +
   概览只读近 7/14 天窗口 ⇒ 冲「10 万行 p95 ≤5ms」；随后 `W4-3` 空闲不推 tick 帧。
2. **W3 余下 3 项**（都在 `index.js`，可与 W4-2 同批）：overlay 写失败中止本轮并写 `lastError`、
   素材删除 `.bak-<ts>` + 软删除 + 孤儿扫描、spawn 20 分钟硬超时 + 进程树 kill、
   `personaPrompt` 支持 `preset:` 与相对根。
3. **W2 收尾接线**（小但卡住生产）：`mcp_server.py` 的 `bili_persona_note` 加 `originalText`；
   `processGrowth` 注入 `review` 与 `cfg.growthCheckedOnly`；「保存卡 → 重导 lint-rules.json」挂同一路径。
4. **W5 人设页**（依赖 W2-1，已就绪）：页头 / 本轮实际注入 / 体检 / 换卡对比，四请求合并成
   `/persona/bundle`（W4-4 先落）。
5. **W6-1** `bili_persona_lore(keyword)`：`layers.c3Hints` 已经把 `interpolate:false / maxChars:600 /
   maxLoreBodies:2 / loreIndex` 准备好，只差 MCP 工具与冷却判定落地。
6. **W7-1/W7-2**：记忆与发言门控（硬依赖 W4 的增量读）。

### 12.5 待主人拍板（仍有效）

1. **真机冷启动一轮的时机**：切链路已生效，但「真跑一轮」会真实发评论、占当日配额 —— 需要主人点头
   （或直接在控制台点「跑一轮」）。
2. **质量门何时从 `warn` 切 `block`**：现状是 warn；建议按 §6.3 观察 3 天、误杀 <5% 再切。
3. **W6-2 companion 插件**：仍按 §6.1 三条门槛挂起。
4. **记忆半衰期 7 天 / 体检基线**：等 W7 开工前再确认一次。

---

## 13 进度快照·第二轮（2026-10-28 夜 → 29 凌晨）

> 第二轮把 §12.4 的 6 条全部做完（除 W6-2 门槛项），另加 W7 三件。
> 测试基线 327 → **410 pass / 0 fail**；四个 smoke 入口 exit=0。

### 13.1 第二轮交付（6 个提交）

| 提交 | 内容 |
|---|---|
| `16cb3b5` | W7-1 记忆（`lib/memory.js`）/ W7-3 体检自纠（`selfcorrect.js`）/ W7-2 打分核心（`speak.js`）/ W3-5 `personaPrompt` 表示法 / W3-3 软删除 lib 半 / W6-1 提示词侧切换 |
| `cbc50f0` | W5 人设页四块 + W4-4 请求 30s 复用 + 软删除回收站 UI + `checkup.js` / `tagstats.js` |
| `d9730e2` | W4 账本收敛 + 概览窗口化 + tick 去重 + W3 余 4 项 + W5 服务端端点 + W2 收尾接线 |
| `e84cd62` | W6-1 `bili_persona_lore` 工具 + `bili_persona_note` 的 `originalText` |

### 13.2 性能：方案指标全部达标

| 场景（10 万行账本） | 轮一末 | 轮二末 | 方案目标 |
|---|---:|---:|---|
| `buildOverview` 纯计算 p95 | 94.63ms | **4.68ms** | ≤5ms ✅ |
| 单帧全流程（稳态读 + 概览）p95 | 100.31ms | **5.02ms** | ≤30ms ✅ |
| 稳态读（文件没变） | 0.09ms | 0.08ms | 0 次读盘 ✅（500 次连读 `bytesRead +0B`） |

手段：11 处 `readEvents` 收敛成 1 个 `ledgerReaderFor` 实例 + 概览 14 天窗口单遍粗筛
（`windowDays:0` 留旧口径逃生门，与旧实现对拍 `deepEqual`）。

### 13.3 本轮新增的两个"可解释"能力

1. **记忆**：`persona-inject.memory = {injected, pool, relevant, fallbackToRecent}` ⇒ 能查"为什么这轮提了旧事"。
2. **体检**：`persona-inject.checkup = {level, n, reasons, selfCorrect}` ⇒ 能查"为什么这轮被要求收短"。
3. **发言门控**（仅打分）：`speak-decision {score, decision, reason, features}` ⇒ 未来能查"为什么没说"。

### 13.4 下一轮（按依赖）

1. **W7-2 接线**：把 `scoreSpeakDecision` 接进 `buildDutyPrompt` 的候选判定，**先 observe（只记不拦）**，
   观察 3 天误杀率再决定 enforced；同时把 `speak-decision` 接进人设页/活动页。
2. **`saveCard` → 重导 `lint-rules.json`**：§6.3 要求"卡一改就重导"，现在还得手动跑脚本。
3. **W6-2 companion**（仍受 §6.1 门槛约束）；门槛之一"账户连续 3 天值班无回归"取决于主人是否放开真机跑。
4. **真机验收**：§10.1 的 6 条真人验证（账本出现 `persona-inject` / 同日两轮不重复见闻 / "太强了"被拦 /
   楼中楼 ≤40 字 / 人设页四块可读 / `duty.log` 无 U+FFFD）——全部需要主人点头跑一轮。
5. 已知小尾巴（都不阻塞）：`/persona/history` 全量扫描（10 万行 5–8ms，30s 轮询可接受）；
   14 天窗口化后"永远显示上一轮"不可得（有意）；`scripts/snapshot-console.mjs` 未补新端点数据。

---

## 14 进度快照·第三轮（2026-10-29 凌晨）

> 第三轮把 §13.4 的 1、2 两条做完，并把"控制台可解释"与"demo 数据"补齐。
> 测试基线 410 → **432 pass / 0 fail**；四个 smoke exit=0；真实 `duty.log` 490KB / 4,338 行 / **0 个 U+FFFD**。

### 14.1 第三轮交付（3 个提交）

| 提交 | 内容 |
|---|---|
| `8781806` | W7-2 发言门控接线：轮级节奏闸（off/observe/enforce，默认 observe）、`speak-decision` 落账本、概览 `round.speakGate`；含方案第 7 例「spawn 立即退出」故障注入 |
| `b17cc18` | W2-2 收尾：保存卡/语料库**即重导** `lint-rules.json`（保留人工 mode、失败不拖垮保存）+ 三个写接口透传 `lintRules` + `speakGateMode` 配置项 |
| `1877f5f` | 控制台三处门控展现（概览卡 / 人设页行 / 设置项）+ 门控 5 份 fixture + 4 条硬守卫断言 + demo 数据补齐 |

### 14.2 本轮实测发现的两个真问题（都被修掉了）

1. **陈年回复会把门控永久钉成"放行"**：真实账本里躺着 2026-04 的 5 条未回 reply-in，
   不设窗口的话轮级闸每轮都判 `forced`（永不收紧）⇒ W7-2 等于没接。
   修法：`pendingReplyCount` 只看**近 7 天**；补了「陈年回复不算待回复」的用例。
2. **假响应体导致"看起来跑了两轮"**：一次性探针的 fake `res` 没实现 `writableEnded`，
   外层路由把 `api()` 已处理的请求又跑了一遍（真实 HTTP 有 `writableEnded/headersSent`，不会发生）。
   已把这条坑写进探针注释 —— 免得后人把探针 bug 当成产品 bug 去改。

### 14.3 端到端干跑（临时家目录 + 真实 whale 卡 + 真实配置形状 + 秒退假 dsh）

```
POST /run => started:true（roundId 2026-10-28T15:36:31.038Z）
round-end      => { code: 0, durationMs: 69 }
persona-inject => { tag: whale@2.2.0, layers: 5, total: 2037, degraded: [], hits: 13,
                    memoryInjected: 1, checkup: 'ok', selfCorrect: '' }
speak-decision => { scope: 'round', mode: 'observe', decision: 'normal',
                    reason: '节奏正常（近 2 个动作说了 1 次，距上次 1560 分钟）',
                    features: { recentShare: 0.5, recentWindow: 2, recentSpoke: 1, gapMinutes: 1560, pendingReplies: 0 } }
```
—— 不联网、不发评论、不碰真实家目录。这一步取代了"真机冷启动一轮"里**除了模型发言**以外的全部链路验证。

### 14.4 §10.1 全局 DoD 现状

| # | 项 | 现状 |
|---|---|---|
| 1 | `npm test` ≥225 + 四入口 exit=0 | ✅ 432 / 四入口 0 |
| 2 | bench 有前后数字 | ✅ `docs/analysis/bench-before.md` / `bench-after.md` / `bench-round2.md` |
| 3 | 真机各一次（6 条） | ⏳ **只差"真跑一轮"**：`duty.log` 无 U+FFFD ✅已验、楼中楼 ≤40 ✅已对齐、人设页四块 ✅render-smoke；剩下 3 条（账本出现 `persona-inject`、同日两轮不重复见闻、"太强了"被拦）需要主人点一次「跑一轮」（会真实发评论、占配额） |
| 4 | 每 wave 可回滚 | ✅ W1=`personaPrompt`/`modes`/`degrade`；W2=`lint-rules.json` 的 `mode`；W7-2=`speakGateMode:off`；W6=overlay 插行 |
| 5 | `duty.log` 无新 U+FFFD/ERROR | ✅ 实测 0 个 U+FFFD |

### 14.5 接下来（只剩主人动作）

1. **等主人点一次「跑一轮」**：这一项**没有任何开发工作**，只是让真模型说一次话。
   §10.1-3 的六条已经在真代码路径上全部验过（见 14.6），但「模型按卡说话」只能真跑一轮看到。
   同时给 §6.1 的 W6-2 第一条门槛"连续 3 天值班无回归"起算。
2. 观察 3 天后按需把 `speakGateMode` 切 `enforce`、把 lint 的 `mode` 从 `warn` 切 `block`
   （都只需改配置或点设置页，不用改代码）。
3. 小尾巴：`/persona/history` 可考虑窗口化；`console-demo-v3.html`（旧静态稿）不消费新字段，
   若还要 demo 截图，数据源用 `snapshot-console.mjs`。

### 14.6 §10.1-3「真机六条」的逐条证据（全部在真代码路径上，临时家目录）

| # | 项 | 证据 |
|---|---|---|
| 1 | 账本出现 `persona-inject` | 干跑两轮：账本 `{persona-inject:2, speak-decision:2, round-end:2}`，两条 tag 都是 `whale@2.2.0` |
| 2 | **同日两轮不重复见闻** | 轮一末 `state.loreUsed = {wuchang-ranked, food-wedding, night-owl}`；轮二 P2 出现「今天用过了：wuchang-ranked、food-wedding、night-owl」且 `used.loreIds = []`；日志「人设用量已转正（lore 3 / canon 6 / 语料 4）」 |
| 3 | **「太强了」被拦** | 用**真实规则文件副本**跑 `mcp_server._lint_precheck`：`mode=warn` → 放行 + `codes:['L1']`；`mode=block` → `blocked:true, codes:['L1']`（comment 与 reply 都拦）；正常评论不被误杀 |
| 4 | `duty.log` 无乱码 | 真实 `duty.log` 490,003 字节 / 4,338 行 / **U+FFFD = 0** |
| 5 | 楼中楼 ≤40 字 | 卡 `voice.modes.reply=40` + 章程 `duty.md` ≤40 + P3/P5 同口径（深夜三者都压到 40） |
| 6 | 人设页三块可读 | render-smoke 四块 × 「有数据/无数据/正在连接」断言 + `snapshot-console.mjs` 实跑产物含四块有数据态 |

唯一**没有**被覆盖的是"模型真的按卡说话"这件事本身 —— 那需要一次真机值班轮（会真实发评论、占配额）。


