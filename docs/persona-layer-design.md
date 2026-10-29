# 人格注入分层方案（v1）

> **已并入统一方案（2026-10-28）**：本文的**方法部分**（§2 六层×三通道、§3 预算与降级、§4 六问定层、§5–§11 记忆/语料/门控/体检/可观测）已全文并入 [B站分身：人设系统 × 工程链路 统一方案](superpowers/plans/2026-10-28-unified-plan.md) 的 §2 / §3 / §8；本文 §12"落地路线"的 P0–P3 已重排为 W0–W7。**这份文档自即日起只作论证底稿与外部调研记录保留**（§15 的一手 URL 别丢），**排期与取舍一律以统一方案为准**。
>
> 三处需注意：G1（冷却表未接线）**已修**；"四字段口径分叉"实际只有 3 项且真漏的是 `jargon.allow`；本文行号已漂移 60–500 行——核对见统一方案 §4.5。
>
> 对照 **SillyTavern（酒馆）/ MaiBot（麦麦）/ AstrBot** 三个成熟项目的做法，给 `dsh-bili-fenshen` 的人设系统一套可落地的方法与路线。
> 结论先行、证据在后；所有"现状"结论都带 `file:line`，可直接核对。

---

## 0 三句话结论

1. **人设不是一个字段，是「六个层 × 三个注入通道」**：层按**变率**（多久变一次）切，通道按**何时能知道**（spawn 前 / 生成前 / 每一步）切。
2. 你现在的 P1–P5 已经把「**位置即设计**」做对了（`compile.js:1-11`），缺的是**生成期通道**——这是 DSH 比酒馆多出来的一只手：酒馆的世界书全部发生在编译期，而 DSH 每一步都会重装配系统提示，于是「看见视频之后才知道该用哪条见闻」这件事终于可做。
3. **先修四处地基**（冷却表没接线、场域字数没分、卡内预算死配置、降级策略没接线）。地基不修，上面搭得越漂亮越假。

---

## 1 现状基线（实测，不是估计）

| 项 | 值 | 证据 |
|---|---|---|
| 编译体量 | whale 1404 / elaina 1356 / generic 1464 字符 | 实测 `compilePersona` |
| 分块体量 | core 885–1010、lore 0–195、state 157、samples 72、tail 95–117 | 同上 |
| 注入两段 | before ≈1010–1118、after ≈324–346 | `index.js:82-91` |
| 分块预算 | 1500/300/500/450/250，合计 3000 | `budget.js:16-19` |
| argv 守卫 | 软 20000 / 硬 24000 | `budget.js:22-25`；整轮实测 14214 |
| 注入形态 | **整轮一次性**，before 放章程前、after 放末尾 | `index.js:684-688`、`index.js:720` |
| 场域上限 | `modeMax` 硬编 100（回复 40 / 动态 60 未区分） | `index.js:631` |

### 1.1 四处地基缺口（必须先修）

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| G1 | `recordUsage` **全仓无生产调用** | `state.js:163` | `loreUsed/canonUsed/expressionUsed` 永远为空 → 「今天用过了」「别复用」从未生效，同一条见闻每天重复 |
| G2 | 卡内 `render.budget` / `render.position` 是死配置，预算写死在 `budget.js:16` | `whale.card.json:124-127` | 改卡不生效，配置给人错觉 |
| G3 | `degradationPlan` 已实现未接线；真实降级只有「整段丢 after」 | `budget.js:66`、`index.js:723-728` | 超软线时丢掉的是**最有效的尾注**，而不是最不重要的见闻 |
| G4 | `behaviorStyle` / `stance.misread` / `mindset.judgement` / `jargon.quota` 进了 L0 校验却从不进 prompt | `card.js:33-70` vs `compile.js:45-144` | L0 判据与真实注入口径分叉：卡"合格"，实际没说 |

另有两处非地基但影响观测：报告无 `personaTag`、账本无人设事件（换卡后行为变化不可追溯）；`looksCopied`（`expression.js:76`）已实现未接线。

---

## 2 三个项目各解决了什么（对照表）

| 问题 | 酒馆 SillyTavern | MaiBot（麦麦） | AstrBot | 你的现状 | 该学谁 |
|---|---|---|---|---|---|
| **人设放哪层** | 卡片 `description/personality/scenario` = 永久常驻；`mes_example` 随历史被逐块挤出；`post_history_instructions` 放历史之后 | 三段解耦：`personality`（是谁）/ `behavior_style`（何时插话）/ `reply_style`（怎么说），单行模板注入 | Persona = 具名资源，profile 给默认、会话（UMO）可强绑；注入点选 `on_llm_request` 改 **system prompt** | P1 事实 / P5 行为贴近生成点 | 麦麦的**三段解耦** + AstrBot 的**会话可覆盖** |
| **关键词触发内容** | World Info：Key（支持正则）、Optional Filter（AND ANY/AND ALL/NOT ANY/NOT ALL）、constant、Probability %、Insertion Order、Inclusion Group、8 种 position（含 `@D` 深度、Outlet）、递归三档、Budget/Context % | 无（靠记忆检索） | 知识库 RAG：切块 512/overlap 50，融合取 20 → 最终 5 条**追加**进请求 | 索引常驻 + 模型按需 `read` 正文（`lore.js`） | 酒馆的**命中规则与预算优先级**；**不学**向量 |
| **冷却与节奏** | Timed Effects：`sticky` / `cooldown` / `delay`（按消息数） | 记忆半衰期 24h、取用强化、`freeze` 24h | 无（主动消息需自建频率闸） | 冷却表存在但空（G1） | 酒馆的 **cooldown 语义** |
| **记忆** | Summarize 扩展 / Vector Storage | A_Memorix：向量+BM25 → RRF → PPR，检索 5 条、画像 ≤3、启发式 ≤3 条/≤900 字/间隔 ≥180s | 上下文压缩：超 ~82% 触发，保留比例 0.15，仍超则整轮丢弃 | 账本（append-only）+ 活动聚合 | 麦麦的**半衰期 + 限量注入 + 频率限制** |
| **风格学习** | `mes_example` 示例块 | `Expression{situation, style, content[], count}`：情景→句式，"当 A 时，可以 B"，≤20 字、3–10 条、count 加权、写入前 AI 复核 + 人工 `checked` | 无 | 六桶语料 + `heat` + 0.6 反抄 + growth 管道 | 麦麦的**情景→句式**与 `count` |
| **说不说** | 无 | 拟合 logistic：被提及 +1.59、@他人 −1.12、问号 +0.48、纯媒体 −1.03、5min 自身占比 +2.65、截距 −1.20；1h 预算**只收紧不放宽** | Proactive：`future_task` 定时投递 | 配额硬上限 + `skipStreak` + 接话扫描必做 | 麦麦的**可解释特征 + 只收紧** |
| **超限兜底** | Context % / 绝对 token 预算；常数优先、直命中优先于递归命中 | 摘要 | 82% 阈值 → 压缩 → 整轮丢弃，摘要提示要保留"人设约束与已表态立场" | argv 软/硬线，降级策略未接线（G3） | 酒馆的**优先级规则** |
| **可观测** | 触发日志 | WebUI + `monitor/planner_delta` | Trace：`request preparation` 里带 `persona_id` 与注入片段 | 控制台预览 + 一行 log | AstrBot 的 **persona_id + 注入片段留痕** |

> 三条来自一手文档、值得单独记住的细节：
> 1. 酒馆官方明确 **"match whole words" 对中日文有害**（无空格分词）→ 我们的 keys 必须走**子串匹配**，别照抄。
> 2. 酒馆官方明确 **卡片字段会被提前解析，Outlet 宏在卡字段里无法展开**——这正是你 `lore.js:5-9` 那句判断的官方依据。
> 3. AstrBot 明确 **persona 不承担事实**，事实放知识库逐条追加；麦麦明确 **"聊天记录是参考资料，不能覆盖这些规则"**——两家的结论一致：**人格管怎么说，事实管说什么**。

---

## 3 方案：三通道 × 六层

### 3.1 六层（按变率切）

| 层 | 内容 | 变率 | 事实来源 | 通道 | 预算（字符） |
|---|---|---|---|---|---|
| **L0 红线** | `redlines` 摘要 + 禁令开关 + 收尾约束 | 版本级 | `card.redlines`、`cfg.ban*` | C1 摘要 + C2 尾注 | 120 |
| **L1 身份** | `identity` + `voice` 事实 + `canon` + 立场 | 版本级（冻结） | 卡 | C1 | 700 |
| **L2 世界** | 见闻索引 + 命中正文 | 慢变 | `loreIndex` + `lore/*.md` | C1 索引 / **C3 正文** | 300 / 600 |
| **L3 状态** | mood、时段、形态欠账、沉默、冷却 | 日 · 轮 | 账本派生（确定性） | C2 | 250 |
| **L4 手感** | 语料库 active 桶 | 慢变 | `bank` | C2 | 300 |
| **L5 现场** | 候选视频/热评/被回复内容/已接话/记忆摘要 | 步 | MCP 结果 + 账本 | **C3** | 400 |

argv 侧合计 ≈1370（与现有实测 1356–1464 持平），**C3 侧 ≈1000 字符不占 argv**。

### 3.2 三通道（按"何时能知道"切）

| 通道 | 位置 | 何时求值 | 装什么 | 纪律 |
|---|---|---|---|---|
| **C1 编译期-前段** | 章程之前 | spawn 前定死 | L1 身份 + L2 索引 + L0 摘要 | 只放**永不变**的东西；越短越好（每步都在前缀里） |
| **C2 编译期-后段** | 整轮 prompt 最末尾 | spawn 前定死 | L3 状态 + L4 手感 + L0 尾注 | 只放**越靠后越有效**的约束；固定行数 |
| **C3 生成期-每步** | `systemPrompt.context` | 每个 step 重新装配 | L2 命中正文 + L5 现场 | `interpolate:false`；失败必须静默降级 |

**为什么 C3 是新增价值**：酒馆的世界书**全部发生在编译期**（一次构建 prompt），所以它只能匹配"已经在上下文里的文本"，官方文档还写明卡片字段提前解析、Outlet 不可用。DSH 的每一步都重新装配系统提示 → 我们能做**酒馆做不到的"生成期世界书"**：等到模型看见视频标题/字幕/热评之后，再决定命中哪条见闻。

这也让你 `lore.js` 里那句「凡是先看到内容才知道要不要用的信息，只能生成期取用」从**约束**变成**能力**——以前没有生成期钩子，只能退化成"索引 + 让模型 read"；现在可以直接注入。

### 3.3 通道给的是"信息时机"，不是"跨轮省钱"

必须说清楚，避免自我感动：每轮是**独立 headless 会话**，跨轮没有缓存可省。C1/C2/C3 的真实收益是三条：
1. **时机**：把"看见才知道"的信息推迟到看见之后（L2 正文、L5 现场）；
2. **卸载**：C3 的内容不占 argv 的 24000 硬线，等于白得约 1000 字符预算；
3. **前缀稳定**：一轮内 20+ 次模型请求，L0/L1 全程不变 → 前缀一致；会变的都放 C2/C3，不打断前缀。

---

## 4 判决规则：六问定层法（可复用的方法）

新内容要进 prompt 时，按顺序问，命中即停：

| # | 问题 | 落到 |
|---|---|---|
| Q1 | 它会不会随「这一条评论」变？ | **L5 现场**（C3） |
| Q2 | 要不要**先看到视频/评论**才知道用不用？ | **L2 正文**（C3 命中） |
| Q3 | 它是不是**绝不能让模型自己编**的事实或计数？ | **L3 状态**（宿主算好） |
| Q4 | 它是不是「永不变的你是谁」？ | **L1 身份**（C1，必须短） |
| Q5 | 它是不是「越靠后越有效」的禁令/收尾约束？ | **L0 尾注**（C2） |
| Q6 | 它是不是只影响**风格**不影响事实的示例？ | **L4 手感**（C2，3–5 条） |

**兜底**：拿不准就放 L2 正文（按需读），**绝不**放 L1——L1 每一 step 都在付 token。

配套两条硬纪律：
- **状态不许模型编**（麦麦 / 你现有 `state.js:4-9` 同一结论）：心情、欠账、冷却、配额一律宿主算好，写成人话。
- **人格不许承载事实**（AstrBot / 麦麦同一结论）：见闻、记忆、视频信息走 L2/L5，卡里只放"怎么说话、在乎什么"。

---

## 5 预算与降级

**优先级规则**（学酒馆）：常数项（L0/L1）先占；**直命中优先于递归命中**；剩余按 order。

**中文特化**：`loreIndex.keys` 用**子串匹配**，不做整词边界；大小写不敏感但全角/半角归一。

**三层守卫 + 有序降级**：

```
层预算（L1 700 / L2 900 / L3 250 / L4 300 / L0 120）
  → 人设总预算 3000
    → argv 软线 20000（warn）/ 硬线 24000（over）
```

降级**按优先级砍**，而不是像现在整段丢 after（`index.js:723-728`）：

| 级别 | 动作 |
|---|---|
| `warn` | `lore:shrink`（索引 8→5 条）、`samples:half`（4→2 条） |
| `over` | `lore:drop`、`samples:drop`、`state:shrink`，**保留 L0 尾注**（它是性价比最高的一段） |

**C3 独立预算**：每步 ≤600 字符，排序 `直命中 > 冷却未用 > heat 低`，超限截断并记 note。

---

## 6 C3 通道的两条实现路径

### 路径 A（零安装，先做）
把人设层做成**工具**而不是 prompt：`bili_persona_lore(keyword)` → 返回命中条目正文（带冷却判定）。
- 等价于现在的"让模型 `read` 文件"，但省掉"模型自己匹配 keys"这一步，且冷却由宿主判。
- 成本：多一次工具调用；风险：零。

### 路径 B（推荐，收益最大）
在 headless profile 装一个**约 200 行**的 companion 包 `dsh-bili-persona`，overlay 里多插一行（`index.js:602-618` 已有插入行的写法，照抄即可）：
- **L2 命中**：取最近 N 条消息文本（视频标题/字幕/热评）做子串匹配 → 注入命中正文（≤2 条、≤600 字）。
- **L5 现场**：宿主每轮把候选视频/配额剩余/已接话清单写成 `round/<roundId>.json`，companion 读文件注入。
- 用 `ctx.systemPrompt.context({ name:'bili:persona', order, interpolate:false, text })`；**必须 `interpolate:false`**，否则用户/见闻正文里的 `{{x}}` 会被宿主当模板变量解析，未注册即**整轮装配失败**（`dsh-system-prompt` 渲染器行为）。
- **已知契约风险**：`AssembleContext` 的类型声明只有 `{scope, signal}`，`agent` 是运行时塞进去的**未文档化字段**。所以：① 取会话信息必须 `try` + 兜底；② **现场信息走文件，不要只依赖 `context.agent`**。
- 前置：headless profile 目前无 `node_modules`，需一次性 `dsh plugin --profile headless add link:<路径>`。

---

## 7 记忆：从"账本"到"少而准"（迁移麦麦）

- **事实源不变**：账本仍是唯一事实来源；记忆 = **活动聚合**（`lib/activity.js` 已有）+ 重要度，不再造第二套库。
- **条目**：`{ id: bv+type, bv, title, up, myText, replies, at, importance, lastUsed }`。
- **重要度**：被回复 +3 / 被赞 >5 +2 / 我评过 +1 / 仅看过 +0；**半衰期 7 天**（麦麦用 24h，那是群聊节奏；B 站慢得多）。
- **注入**：≤3 条、≤600 字，只在 C3，且与当前 UP/关键词相关时。
- **纪律**（麦麦踩过的坑）：`external_id` 幂等、重复条目复用正文并追加证据、**不做向量**（换 embedding 必须重建且不可复现）——用"关键词 + 时间窗 + 重要度"的确定性检索，和 `deriveState` 的可复现哲学一致。

---

## 8 语料学习：从"模型提交"到"情景→句式"（迁移麦麦）

现有六桶 + `active/candidate` + `heat` + 0.6 反抄 + growth 管道是对的，补三件：

1. **来源三分** `origin: self | community | blocked`
   - `self`：走账本对账，**只收自己真发出去的**（这正是麦麦"滤 SELF"的反向用法）；
   - `community`：只收热评，且入库前跑"与原帖"的改写检查；
   - `blocked`：永不入库，只做反例。
2. **结构升级**：条目加 `situation`（"当…时"）+ `style`（"可以…"），各 ≤20 字；注入改成「当 S 时，可以 X」，≤5 条、≤300 字（麦麦实测这个粒度才不复读）。
3. **写入闸门**：`count` 加权 + 写入前 AI 复核 + `checked=false` 人工位（麦麦的 `expression_self_reflect`）。

**反抄升级**：现在只比对"草稿 vs 库内"（`expression.js:65-76`）。要补"库条目 vs 原帖热评"——否则 `community` 条目本身就是抄来的，seed 里的 `source` 字段目前**没有任何校验**。

---

## 9 发言门控：把"要不要说"变成可回归的打分（迁移麦麦，简化）

现有：配额硬上限 + `skipStreak` + 接话扫描必做。缺一个**可解释的"说不说"**。建议 6 个特征、线性打分（参数可调、可回归）：

| 特征 | 权重 | 理由 |
|---|---|---|
| 被回复 / 被 @ | +1.6 | 麦麦被提及 +1.59；最该接的信号 |
| 评论含问号 | +0.5 | 有明确可答点 |
| 我近 5 条发言占比 | **−2.6** | 麦麦 +2.65 的**反向**用法：防刷屏 |
| `log(距上次发言)` | +0.06 | 久不说话则该多说 |
| 候选新鲜度 | +0.1 | 新投稿优于老视频 |
| 纯媒体 / 无文本 | −1.0 | 无话可说 |
| 截距 | −1.2 | 默认不发言 |

- **阈值 + 只收紧不放宽**（麦麦的核心教训：一波消息会抬高预期基数，导致系统性偏多）。
- 配额仍是**硬上限**；被 @ / 被回复**直接放行不计分**。
- 账本记 `speak-decision { score, features, decision }` → 控制台可解释"这轮为什么没说"。

---

## 10 防漂移与"人设体检"

- **稳定前缀**：L0 + L1 走 C1、全轮不变；变更只发生在 C2/C3。
- **尾注常驻**：P5 已有且有效，别动（等价酒馆 `post_history_instructions` 的近位压制）。
- **体检指标**（每 N 条算一次）：句长分布、句号/条、表情/条、禁用词命中率、收尾类型分布、与 L1 `voice` 事实的偏离度。
- 超阈值 → 下一轮 L3 加一条自纠（"你最近话变长了，收短"），并记 `persona-checkup` 事件。
- 价值：把酒馆靠"深度注入"的经验，变成**可度量、可回归**的指标。

---

## 11 可观测（AstrBot Trace 的最小版）

账本加一个事件即可解决"换卡后行为变化不可追溯"：

```json
{ "type": "persona-inject", "roundId": "...", "personaTag": "whale@1.2.0",
  "channel": ["C1","C2","C3"], "layers": [{ "name":"core","chars":885,"sha8":"..." }],
  "hits": ["night-owl"], "degraded": null }
```

报告头也带 `personaTag`；控制台「预览与质量」补三栏：**本轮实际注入 / 命中记录 / 降级记录**。

---

## 12 落地路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 地基**（0.5 天） | ① `recordUsage` 接线（轮末回写，`state.js:163`）② `modeMax` 按场域（评论 100 / 回复 40 / 动态 60）③ 卡内 `render.budget` 生效或删掉 ④ `degradationPlan` 接线 ⑤ L0 与注入口径统一（G4 的四个字段：进 prompt 或出 L0） | 同一天同一见闻不出现两次；回复 ≤40 字；超软线时先砍见闻不砍尾注 |
| **P1 分层重构**（1–2 天） | 抽 `lib/persona/layers.js`（纯函数：`(card, state, bank, now) → { c1, c2, c3Hints }`），把 C1/C2 从 `buildDutyPrompt`（`index.js:622-730` 单体 ~110 行）里拆出 | 同输入字节级同输出（快照测试）；`buildDutyPrompt` 只剩拼装 |
| **P2 C3 通道**（1–2 天） | 先路径 A（工具拉取），再路径 B（companion + overlay 行） | 无文件/无网络/字段缺失全部降级不抛；`interpolate:false` 生效（正文含 `{{x}}` 不致装配失败） |
| **P3 记忆 + 门控**（2 天） | 账本→记忆（衰减/幂等/限量注入）；`speak-decision` 打分 | 记忆注入 ≤3 条 ≤600 字；同一 BV 不重复记忆；门控可解释可回归 |

---

## 13 不抄清单（三家各自的坑）

| 项目 | 别抄 | 原因 |
|---|---|---|
| 酒馆 | `match whole words` | 官方自己说对中日文有害；中文必须子串 |
| 酒馆 | Vector Storage 做见闻召回 | 结果不可预测、不可复现；我们只有个位数见闻，关键词足够 |
| 酒馆 | Inclusion Group 概率抽取 | 单人设无"多候选择一"需求，徒增不可解释性 |
| 酒馆 | Outlet 宏 | 卡字段提前解析不可用；"索引 + 按需读"更简单 |
| 麦麦 | SQLite + faiss + PPR 三件套 | 为万人群聊设计；B 站单人号体量用不上，重且难复现 |
| 麦麦 | 24h 半衰期 | 群聊节奏；B 站内容寿命以天/周计 |
| 麦麦 | 黑话子串匹配 | 我们没有可信的黑话来源，误伤风险高 |
| AstrBot | 82% 阈值 + 整轮截断 | 单轮短会话（实测 14k/240k）用不上；我们守的是 argv 硬线 |
| AstrBot | 向量知识库 | 换 embedding 需重建；见闻几十条，关键词更稳 |

---

## 14 一页速查

**新增内容时**：六问定层（Q1–Q6）→ 定层后按该层通道注入 → 记 `persona-inject`。

**每轮装配时**：
```
C1 = L1 身份 + L2 索引 + L0 摘要      （章程之前，永不变）
C2 = L3 状态 + L4 手感 + L0 尾注      （最末尾，固定行数）
C3 = L2 命中正文 + L5 现场            （每步重算，≤600 字，interpolate:false）
```

**三条铁律**：
1. 状态别让模型编（宿主算）；
2. 人格别承载事实（事实走 L2/L5）；
3. 拿不准就放"按需读"，别放"每步都在"。

---

## 15 来源（外部结论均可回溯）

**酒馆 SillyTavern**（官方文档，逐页抓取核实）
- World Info（字段/position 枚举/递归/预算/Min Activations/Timed Effects）：https://docs.sillytavern.app/usage/core-concepts/worldinfo/
- Character Design（卡片字段与 permanent tokens / mes_example 挤出 / PHI）：https://docs.sillytavern.app/usage/core-concepts/characterdesign/
- Author's Note（位置与 Insertion Frequency）：https://docs.sillytavern.app/usage/core-concepts/authors-note/
- Prompt Manager（Role/Position/Depth/Order 与默认块）：https://docs.sillytavern.app/usage/prompts/prompt-manager/
- 未核实说明：`raw.githubusercontent.com` 本次不可达，故 **JSON 键名**（`key`/`keysecondary`/`selectiveLogic`/`depth`）未逐字核对，正文只用文档确证的 UI 字段名。

**MaiBot（麦麦）**（官方文档 + 主仓源码）
- 人格四段配置：https://docs.mai-mai.org/manual/configuration/bot-config
- 记忆引擎 A_Memorix（半衰期/强化/freeze/RRF/PPR）：https://docs.mai-mai.org/manual/configuration/amemorix-config ｜ `src/A_memorix/CONFIG_REFERENCE.md`
- 发言概率门控：`src/maisaka/turn_trigger/reply_likelihood.py`、`dynamic_gate.py`、`idle_backoff.py`
- 表达学习：`src/common/data_models/expression_data_model.py`、`prompts/zh-CN/learn_style.prompt`、`src/learners/expression_learner.py`
- 黑话：`src/common/data_models/jargon_data_model.py`、`src/maisaka/jargon_context_matcher.py`

**AstrBot**（官方文档，中文版去 `/en`）
- 上下文压缩（82% 阈值 / 0.15 保留比例 / 整轮截断）：https://docs.astrbot.app/en/use/context-compress.html
- 知识库（切块 512/50、20→5 条、embedding 锁定）：https://docs.astrbot.app/en/use/knowledge-base.html
- WebUI 与 Trace（`persona_id`、request preparation）：https://docs.astrbot.app/en/use/webui.html
- 事件钩子（`on_llm_request` 可改 system prompt）：https://docs.astrbot.app/en/dev/star/guides/listen-message-event.html
- 主动消息（`future_task`）：https://docs.astrbot.app/en/use/proactive-agent.html
- 会话级覆盖（UMO）：https://docs.astrbot.app/en/use/custom-rules.html

**本仓库**
- 人设编译与预算：`dsh-plugin/lib/persona/compile.js`、`budget.js`、`state.js`、`expression.js`、`lore.js`
- 注入点：`dsh-plugin/index.js:622-730`（`buildDutyPrompt`）、`dsh-plugin/lib/persona/index.js:50-98`（`resolvePersona`）
