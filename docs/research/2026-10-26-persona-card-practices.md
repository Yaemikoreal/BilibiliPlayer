# 人设卡片系统业界实践调研（2026-10-26）

**方法**：全部结论取一手来源——官方 spec（GitHub raw 经 gh-proxy.com 代理直取，内容为原文件）、官方文档（docs.sillytavern.app / docs.elizaos.ai / docs.openclaw.ai / zerepy.org 直连）、源码（SillyTavern release 分支 js；elizaOS v1 经 npmmirror 官方发布包 + source map 还原 TS 源码；generative_agents 主分支 py）。中文社区部分引兄弟文档交叉验证。
**可信度**：✅已验证（一手来源直读）｜◐单一来源或编译产物还原｜○传言/未核到。

## 1. SillyTavern 角色卡 V2/V3 spec

### 1.1 V2 字段全表（chara_card_v2）✅

V2 = V1 六字段（name / description / personality / scenario / first_mes / mes_example）整体塞进 `data`，data 内新增九个字段（外层另有 `spec` / `spec_version`）（[spec_v2.md](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)）：

| 字段 | 类型 | 是否进 prompt | spec 原文要点 |
| --- | --- | --- | --- |
| `spec` / `spec_version` | `'chara_card_v2'` / `'2.0'` | — | MUST，识别格式用 |
| `name` | string | ✅ | V1 继承 |
| `description` | string | ✅ | V1 继承，人设主体 |
| `personality` | string | ✅ | V1 继承，性格概要 |
| `scenario` | string | ✅ | V1 继承，场景 |
| `first_mes` | string | 开场一次 | V1 继承 |
| `mes_example` | string | 空间不足时逐块挤出 | V1 继承，示例对话 |
| `system_prompt` | string | ✅（替换宿主 system） | 默认行为 MUST 是替换"system prompt"；空串则回落宿主；**MUST 支持 `{{original}}` 占位**（替换为宿主本会用的 system） |
| `post_history_instructions` | string | ✅（替换宿主 ujb/jailbreak 位） | 同上语义，注入在**对话历史之后**，影响最强；空串回落；支持 `{{original}}` |
| `alternate_greetings` | string[] | 开场一次 | 首条消息的多个"swipe"变体 |
| `character_book` | CharacterBook | 触发式 | 角色专属 lorebook，MUST 默认启用；SHOULD 与宿主 world book 叠加且角色书优先 |
| `tags` / `creator` / `character_version` | string[] / string / string | ❌ | spec 明令 creator/character_version MUST NOT 进 prompt，tags SHOULD NOT；仅供前端展示/排序/筛选 |
| `creator_notes` | string | ❌ | MUST NOT 进 prompt；MUST 对用户可见 |
| `extensions` | Record<string,any> | 自定义 | MUST 默认 `{}`；**编辑器/前端 MUST NOT 销毁不认识的键**；应用自定义数据 SHOULD 加命名空间（如 `"agnai/voice"`） |

「管理元数据不进 prompt」是 V2 用 MUST 级别写死的边界——卡片里"给人看的"和"给模型看的"从 spec 层就分家。

### 1.2 character_book（lorebook）条目 schema ✅

CharacterBook（V2 spec 内嵌 TS 定义）：

- 书级：`name?` / `description?` / `scan_depth?` / `token_budget?` / `recursive_scanning?` / `extensions` / `entries[]`
- 条目级必填：`keys: string[]`（触发关键词）、`content: string`（命中后注入的文本）、`enabled`、`insertion_order`（**lower = 插入更靠前/更高**，spec 注释原文）、`extensions`
- 条目级可选：`case_sensitive?`、`name?`、`priority?`（**预算不够时 lower priority 先被丢弃**）、`id?`、`comment?`、`selective?`（true 时需 `keys` 与 `secondary_keys` 各中一个才触发）、`secondary_keys?`、`constant?`（true = 无条件注入，仍在预算内）、`position?: 'before_char' | 'after_char'`

**position 的取值语义**：spec 层只有 `before_char`（角色定义前）/ `after_char`（角色定义后）两个枚举 ✅。SillyTavern 实现层用的是数字位，release 分支 [world-info.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js)（2026-10-26 取）`world_info_position` 实测：

```js
before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7
```

即业界常说的 0-4 对应（before_char / after_char / AN 顶 / AN 底 / 指定深度）成立，当前版又扩了示例消息上下（5/6）和手动出口（7）✅。文档侧的 UI 说明与之一一对应，且补充：`@ D` 位可再选注入角色（system/user/assistant 消息），depth 0 = prompt 最底（影响最大）（[World Info 文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)）。

### 1.3 V3 相对 V2 新增了什么 ✅

[CCv3 spec](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)（RisuAI 作者维护）自称 V2 超集，新增：

| 字段 | 类型 | 用途与对我们的价值 |
| --- | --- | --- |
| `assets` | `{type,uri,name,ext}[]` | icon/background/user_icon/emotion 四类 + `x_` 自定义；uri 支持 `ccdefault:`、`embeded://`（CHARX 内嵌）、https/base64。**对 headless 文字号基本无用，暂缓** |
| `nickname` | string? | 有值时 `{{char}}`/`<char>`/`<bot>` 替换为昵称而非 name。**有用**：账号名（不吃鱼的豆腐）与人设名（蓝色大肥鱼）分离 |
| `creation_date` / `modification_date` | number? | Unix 秒 UTC；创建时自动写、导出时更新、禁用户编辑、可写 0 表隐私。**有用**：卡片审计 |
| `group_only_greetings` | string[] | 群聊专用开场，MUST 存在可空数组。群聊概念对我们无用 |
| `creator_notes_multilingual` | Record<lang,string> | ISO 639-1 键 |
| `source` | string[] | 卡片出处 ID/URL，SHOULD 只增不删。**有用**：记录梗出处/二创授权链 |
| 容器格式 | PNG tEXt `ccv3` chunk / CHARX zip（`card.json` + assets，`embeded://` 引用）/ 纯 JSON | 导入导出的现成规范 |

lorebook 侧 V3 变化：条目加 `use_regex`（keys 按 JS 正则匹配）；`constant` 从可选升为"必须实现"；`id` 允许 string。另外 V3 把复杂触发条件从字段挪进了 **content 内装饰器**（`@@depth N`、`@@position after_desc|before_desc|personality|scenario`、`@@role`、`@@scan_depth`、`@@activate_only_after N`、`@@additional_keys`、`@@exclude_keys`、`@@activate`/`@@dont_activate`，支持 `@@@` 回退链），宏 `{{char}}`/`{{user}}`/`{{random:}}`/`{{pick:}}`/`{{roll:N}}`。回填 V2 时 MUST 删掉全部装饰器。ST release 分支 `src/` 下已有 `charx.js`、`character-card-parser.js`，说明 ST 侧已落地 V3 容器支持的存在性 ✅（兼容深度未核）。

### 1.4 World Info 运行机制（官方文档 + 源码）✅

WI 是"动态字典"：关键词命中才把 `content` 注入 prompt（[World Info 文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)）：

- **扫描深度**（scan depth）：扫最近 N 条消息找 key；0 = 只评估递归命中和 Author's Note；可整书设置、可单条覆写。配套"包含名字前缀"开关（扫 `Alice: xxx` 缓冲区）。
- **递归扫描**：条目 content 里提到别的条目的 key 会连锁触发；全局开关 + 每条目三态（不可被递归 / 阻止继续递归 / 递归才激活）；`Max Recursion Steps` 限层级。**中文/日文条目建议关"全词匹配"**（无空格分词会伤命中）——文档原文警告。
- **触发概率**（Probability %）：命中后仍有 x% 概率不注入，用于随机事件。
- **时间效果（Timed Effects）**，按消息数计：`sticky N`（命中后保持 N 条，期间免疫概率判定）、`cooldown N`（激活后冷却 N 条，sticky 结束即进冷却）、`delay N`（聊天不足 N 条不许激活）；swipe/删除消息会清掉进行中的效果。
- **预算**：`Context % / Budget` 限制 WI 总 token；超预算后 key 再中也不注入；constant 先入，然后 order 大的先入；预算耗尽可告警（Alert on overflow）。
- **Inclusion Group**：同组命中只插一条，按权重随机或按 order 确定性选择。
- **向量检索**（Vector Storage 扩展）：可用嵌入相似度替代关键词匹配，文档明说"检索结果不可预测，要确定性就用关键词"。

**Author's Note 注入深度**（[文档](https://docs.sillytavern.app/usage/core-concepts/authors-note/)）：两种放法——After Scenario（场景后、示例前）或 **In-chat 指定深度**（depth 0 = 聊天历史最底端；depth 4 = 插到最近 3 条之前）；"越靠近 prompt 底部影响越大"；`Insertion Frequency` 控制每 N 轮注入一次（0 = 永不）。角色级变体叫 Character's Note（@Depth + 角色 role）（[characterdesign](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)）。

### 1.5 卡片字段怎么进 prompt ✅

（[characterdesign](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)）

- **常驻 token**（每次都发）：name + description + personality + scenario；超过模型上下文一半会红牌警告。
- **非常驻**：first_mes 只在开场发一次；示例消息块（`<START>` 分隔）**只在上下文有余量时保留，满了整块逐块挤出**。
- **首条消息定风格**：模型从 first_mes 学文风与长度，比任何规则都灵。
- **两级覆盖**：Main Prompt（system 位）与 Post-History Instructions 都可被卡片覆盖，受"Prefer Char. Prompt/Instructions"开关控制，`{{original}}` 把宿主默认值挂进卡片文本——**宿主与卡片的单一权威就是靠这两个槽位 + 占位符达成的**。

## 2. ElizaOS 角色文件格式

### 2.1 字段全表 ✅

v1（0.1.9，2025-02 发布，npmmirror 官方包还原）`Character` 类型（packages/core/src/types.ts）与官方默认示例（defaultCharacter.ts）✅：

| 字段 | 类型 | composeState 实际用法（packages/core/src/runtime.ts） |
| --- | --- | --- |
| `name` | string | 拼头部（"Example Posts **for {name}**"） |
| `bio` | string \| string[] | **数组时随机洗牌取 3 条空格拼接**（runtime.ts:1451-1458） |
| `lore` | string[] | **洗牌取 10 条** join \n（runtime.ts:1339-1347） |
| `knowledge` | array | RAG 或知识检索后格式化为 `{{knowledge}}` |
| `messageExamples` | 二维数组（多段对话） | **洗牌取 5 段**，`{{userN}}` 占位符替换成随机人名，段间 \n\n，加头"# Example Conversations for {name}" |
| `postExamples` | string[] | **洗牌取 50 条** join \n，加头"# Example Posts for {name}" |
| `topics` | string[] | `{{topics}}` = "{name} is interested in " + 洗牌取 5；`{{topic}}` = 随机单条 |
| `adjectives` | string[] | `{{adjective}}` = 随机取一 |
| `style` | `{all,chat,post}` | `messageDirections` = style.all + style.chat；`postDirections` = style.all + style.post（各自加头"# Message/Post Directions for {name}"） |
| `system` | string? | system prompt 覆盖 |
| `templates` | object | **按场景覆写模板**：`messageHandlerTemplate`、`shouldRespondTemplate`、`twitterPostTemplate`、`twitterActionTemplate` 等几十个键（types.ts:743+）——人设可以直接自带"这个平台怎么写 prompt" |
| `settings` / `plugins` / `clients` / `extends` | object/数组 | 配置与插件装配，不进 prompt |

v2 官方文档的字段表与 v1 基本同构（bio string|string[] 必填、system、templates、adjectives、topics、knowledge、messageExamples 二维、postExamples、style、plugins、settings、secrets）（[docs.elizaos.ai/agents/character-interface](https://docs.elizaos.ai/agents/character-interface)）✅。

### 2.2 字段在 prompt 构建中的真实去向（源码佐证）✅◐

Twitter 发帖模板（@elizaos/client-twitter 0.1.9，packages/client-twitter/src/post.ts，经发布包 source map 还原 ◐）：

```
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}...
Your response should be 1, 2, or 3 sentences (choose the length at random).
...No emojis. Use \n\n (double spaces) between statements...
```

- **postExamples → 只进发帖模板**（few-shot 文风库）；**style.post → postDirections → 发帖与互动决策模板**；**style.chat → messageDirections → 对话模板**（twitterVoiceHandlerTemplate / shouldRespond 模板用 `{{bio}} + {{messageDirections}} + {{recentMessages}}`）。同一人设、两个行为面、两组不同素材——**"人设与行为风格分离"在 eliza 是用模板分槽实现的**。
- 互动决策模板（twitterActionTemplate）= bio + postDirections + 打分制行动判据（[LIKE] 9.8/10、[RETWEET] 9.5/10…"Default to NO action unless extremely confident"）；shouldRespond 模板内置"很怕吵到人，有疑问一律 [IGNORE]"的保守倾向。
- 模板引擎：`composeContext` 简单 `{{key}}` 替换（state 缺键替换空串），可选 handlebars（core/src/context.ts）。

### 2.3 写 character file 的社区惯例 ✅

官方 defaultCharacter.ts 就是模板：bio 14 条**第三人称短句**（"A real girl, not an AI agent"…"She never uses emojis"——同一事实换个说法重复写两次也行）；lore 10 条**背景故事碎片**（履历、地点、传闻）；messageExamples 30 段一问一答（用户侧全用 `{{user1}}` 占位）；postExamples 15 条一句话帖；topics 19 个名词短语；style 三槽各 10-14 条**祈使句**（"use lowercase for casual tone"）；adjectives 40 个形容词（每次随机只抽 1 个进 prompt）。**核心设计：每个槽都是"池子"，每次构建 prompt 随机抽小样**——同一个人设每天说出的话组合不同，天然防复读。

## 3. 斯坦福 Generative Agents（arXiv 2304.03442）

### 3.1 memory stream 与检索打分 ✅

（[retrieve.py](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/retrieve.py)）

- 记忆流 = 事件/想法节点按时间排序的序列，每节点带 embedding、poignancy（LLM 打的重要性 1-10）、last_accessed。
- 检索分 = recency + relevance + importance 加权和：`recency = 0.99^i`（按新旧序的**指数衰减**，scratch.py:60 `recency_decay = 0.99`）；`relevance` = 与焦点问题的余弦相似度；`importance` = 节点 poignancy。三者各自 min-max 归一化到 [0,1] 后加权。
- 源码里最终权重 `gw = [0.5, 3, 2]`（recency 0.5 / relevance 3 / importance 2），注释明说"权重应该被学习，先用着"；每次取 top-30，并刷新 last_accessed（被检索本身就改变 recency）。

### 3.2 reflection ✅

（[reflect.py](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/reflect.py)）

- 触发条件是**重要性分数累计和倒数**：scratch 里 `importance_trigger_curr` 从 `importance_trigger_max = 150` 起步，agent **每感知一个新事件/对话就减去该事件的 poignancy**（perceive.py:178），扣到 0 才反思，反思完重置——**不是每步都反思，是攒够"重要事"才归纳**。
- 反思动作：取最近记忆让 LLM 出 3 个焦点问题 → 按焦点检索 → 对每簇生成 5 条带证据节点编号的洞察（insights+evidence）→ 存回记忆流为 thought（poignancy 重打分，**30 天过期**）。

### 3.3 plan 与每日身份改写 ✅

（[plan.py](https://github.com/joonspk-research/generative_agents/blob/main/reverie/backend_server/persona/cognitive_modules/plan.py)）

- 计划三级：起床时间 → 当日宽计划（daily_req）→ 逐小时日程（generate_hourly_schedule）→ 任务再分解（generate_task_decomp）；执行中用 decide_to_talk/decide_to_react 决定继续按计划还是插话。
- **`revise_identity`（plan.py:408）是"agent 自写状态"的祖师爷**：每天一次，取"今天的计划 + 近期重要事件"检索结果 → 让 LLM 产出两段话（对今天的计划注意什么 / "对至今为止的日子感受如何"）→ 连同**昨天的 `scratch.currently`** 一起喂给 LLM → 生成**第三人称**的新 "Status: <new status>" 覆写 `currently`。
- **身份稳定集 ISS**（scratch.py:382 `get_str_iss`）："几乎所有 prompt 都要用的最小人设描述"——`Name / Age / Innate traits / Learned traits / Currently / Lifestyle / Daily plan requirement` 固定七行。**前四行 + Lifestyle 是稳态，`Currently` 是每日自改的动态行，两者拼在一起进所有 prompt**。

## 4. 社交媒体 agent 的人设/风格实践

### 4.1 elizaOS（X/Twitter client）✅

见 §2.2。要点：人设字段→行为槽位靠**模板**连接；随机抽样防复读；templates 支持人设自带 prompt 覆写；互动判据（打分制 + 默认不动）独立于文风素材。

### 4.2 OpenClaw ✅

（[docs.openclaw.ai/concepts/agent](https://docs.openclaw.ai/concepts/agent)）每个 agent 一个工作区，固定六个 Markdown 注入系统提示词：**AGENTS.md**（操作守则+记忆）、**SOUL.md**（人格/边界/语气）、**IDENTITY.md**（名字/气质/emoji）、**USER.md**（用户画像与称呼）、**BOOTSTRAP.md**（一次性首启仪式，完成后删除）、**MEMORY.md**（存在才注入）。空文件跳过；**大文件截断并加"去读原文"标记**；缺失文件注入一行占位。一个现成的"分层注入 + 注入预算"参照系。

### 4.3 ZerePy ✅

（[zerepy.org/docs/create-agents](https://www.zerepy.org/docs/create-agents)）`agents/*.json`：`bio`（数组）、`traits`、`examples`（示例帖）、`example_accounts`（对标的真人账号）——人格侧四件套；`config[]`（平台参数：读多少条 timeline、发帖间隔 5400s）、`tasks [{name, weight}]`（行为权重）、`use_time_based_weights` + `time_based_multipliers`（凌晨 1-5 点发帖 ×0.4、白天互动 ×1.5）。Pydantic v2 校验。**"像真人一样有作息"被做成了配置**。

### 4.4 B 站侧的"敌方视角"：dafeiyu-cleaner ✅

（[liyupi/dafeiyu-cleaner README](https://github.com/liyupi/dafeiyu-cleaner)）离线打分 0-99，≥60 判大肥鱼、≥35 可疑；正文维度：自称"本鲸/本鱼"、括号里演动作、**@ 和自己昵称同款的"主人"汇报**、开头 @ 人后复述视频要点、数弹幕"×19"；昵称维度（鲸/鱼鱼/白饭/token/bot/Agent）；减分项是"像真人在提问、短吐槽"。实测 284 账号评论区离线规则认出约 85%。与[鲸鱼娘调研](./2026-10-25-whale-lore.md)第 4 节结论互为印证：**口癖一旦固化成模板，就从"人设"变成"检测特征"**。

### 4.5 状态/心情层对比

| 项目 | 有没有状态层 | 谁写 | 载体 |
| --- | --- | --- | --- |
| elizaOS v1 | 无显式心情；靠随机抽样制造变化 | 模板运行时抽 | character file 静态池 |
| Generative Agents | 有（currently + 情绪感受） | **agent 自己每日改写** | scratch 序列化文件 |
| OpenClaw | 无自动状态；MEMORY.md 手工/半自动 | 人 + agent 协商 | Markdown 文件 |
| ZerePy | 无；用任务权重与时间乘数模拟作息 | 配置者 | agents/*.json |
| 本插件现状 | 无；章程静态 | — | 章程 + 判重表 |

## 5. 中文社区（简）

「AI 评论区账号」的生态、翻车案例与清洗工具已在[鲸鱼娘调研](./2026-10-25-whale-lore.md)（✅）与[真人热评语料](./2026-10-25-human-comments-corpus.md)（✅）中核过：同质化（鱼灾）、汇报体（鱼八股）、口癖即检测特征是三大死因；真人短评的定量分布（长度双峰、句号 11%、@ 2.4%）是口吻校准的基线。本篇不重复展开。

## 6. 给本设计的 12 条建议

**对应设计点 1（独立卡片模块）**

1. **卡片 schema 主体抄 V2 `data`，别自创字段名**：name/description/personality/scenario/first_mes/mes_example/system_prompt/post_history_instructions/alternate_greetings/tags/creator/character_version/extensions 全收。依据：V2 是事实标准，字段语义有 MUST/SHOULD 级定义，未来导入导出酒馆卡可直接映射。
2. **参数滑条放 `extensions`，加命名空间**：如 `extensions["bili_fenshen"] = { 配比: {判断:4,社区:4,鱼味:2}, 语气样本开关: … }`。依据：V2 规定 extensions MUST 默认 `{}`、**MUST NOT 销毁未知键**——这天然就是"内置卡升级不丢自定义参数"的迁移通道，也是酒馆生态十年验证的扩展位。
3. **V3 只抄四个字段**：`creation_date`/`modification_date`（自动维护，宿主写，禁手改）、`nickname`（人设名与账号名分离）、`source`（记录二创署名链/授权，如 CC BY-NC-SA 出处）。assets 与 group_only_greetings 对 headless 文字号无用，不实现。依据：V3 spec 各字段定义。
4. **导入导出用纯 JSON 文件，不做 PNG 内嵌**：卡片库 = 目录 + index；导出保留未知键（V2 铁律），`spec_version` 按**浮点比较**判新旧（V3 规则）以支持前向兼容。依据：V3 容器三种里 JSON 是合法一种；CHARX 仅在将来带素材时再考虑。

**对应设计点 2（注入层重构 + 双重权威）**

5. **用 `system_prompt`/`post_history_instructions` 的覆盖语义终结双重权威**：章程（duty.md）声明自己只是"宿主默认"（=`{{original}}`），卡片定制层显式覆盖或用 `{{original}}` 挂载章程；**口吻规则只允许住在卡片一个地方**——现在 duty.md「评论纪律」与 persona-whale.md「评论没有模板」是两份平行权威。V2 spec 给的秩序是：卡片值一旦非空，替换宿主默认就是 MUST 的默认行为；宿主想再叠一层额外覆盖（不直接改卡的那种），MUST NOT 成为默认行为、必须显式开启。照抄这套"谁是默认、谁是显式"的规则即可。依据：V2 spec §system_prompt/§post_history_instructions。
6. **注入顺序按"影响梯度"排**：身份层（description/personality，常驻高位）→ 风格层（示例对话/帖子，余量不足先挤出）→ 状态层与足迹（Author's Note 式 in-chat 深度注入，贴近底部）→ 红线定制层（post-history 位，最靠近输出）。依据：ST 文档"越靠近 prompt 底部影响越大"、常驻 vs 可挤出的 token 分层。
7. **注入预算与截断照抄 OpenClaw**：每层设 token 上限，超限截断加"去读原文"标记行；空层跳过不注入。依据：OpenClaw bootstrap 文件契约。

**对应设计点 3（动态状态层 + 宿主监督）**

8. **状态层结构抄 ISS**：身份层出"稳定七行"（本设计可化为：名字/本质设定/学来的特征/生活节律），状态层只占一行 `Currently:`，由 agent 改写；**改写必须以账本派生事实为输入**——generative agents 的 revise_identity 是"读最近记忆 → 写第三人称状态"，不是凭空写心情。我们的等价物：每轮把 ledger.jsonl 最近 N 条 + seen.md 摘要喂给 agent，要求产出第三人称新状态。依据：scratch.py get_str_iss、plan.py revise_identity。
9. **状态改写用"重要性累计和"触发，不每轮强制**：像 importance_trigger_max=150 那样——每次动作按其"重要度"扣减一个累计计数器，扣到 0 才让 agent 重写状态（省钱 + 防状态抖动）；两次改写之间宿主沿用旧状态。依据：reflect.py reflection_trigger + perceive.py:178（按事件 poignancy 扣减）。
10. **防僵化用"随机抽样 + 指数衰减"双机制**：状态里 agent 写的"最近着迷"按 `0.99^i` 式时间衰减滑出（对应健康指标里的"陈旧"）；示例池每轮洗牌抽小样（eliza：bio 抽 3 / lore 抽 10 / 帖子抽 50 / 对话抽 5——**每轮组合不同是防"鱼八股"复读的机制级解法**，比"规则里写禁词"更根本）。依据：eliza runtime.ts composeState、retrieve.py extract_recency。
11. **宿主监督三件套**：schema 校验（ZerePy 的 Pydantic 模式）；禁词消毒直接用 dafeiyu 的正文维度表反向做规则（自称本鲸/括号动作/@主人汇报/复述要点）；快照回滚对应 generative agents 的 scratch 持久化——每次改写前存快照，人工锁定 = 冻结 Currently 字段。健康指标：陈旧度（天数）、僵化度（状态文本与历史状态的相似度）、膨胀度（token 预算，超限告警照抄 ST 的 Alert on overflow）。

**对应设计点 4（人设内容充实）**

12. **示例对话按"池子"组织，三个行为面分池**：评论池（对应对话）≤30 段、动态池（对应 postExamples）≤15 条、回复池（跟进）≤10 段，都用 ST 的 `<START>` 块 + `{{char}}/{{user}}` 前缀写法（ST 的示例消息逐块挤出 + eliza 的 `{{user1}}` 随机人名替换都是现成规范）；**每轮只注入抽样 2-3 条，不全文注入**。背景故事（lore）写 10 条碎片式短句而非一段长文（eliza 官方示例形态 + 随机抽 10 的用法决定它就该是碎片）。世界观细节与好恶不新开字段：常驻的进 description，触发式的进 character_book。

**lorebook 的取舍得单说**：对本场景，`constant`（红线/身份句常驻注入）+ `after_char` 位 + `insertion_order` + `token_budget` 四件套值得抄；**递归扫描、regex keys、inclusion groups、向量检索、timed effects 全部过重**——我们每轮只构建一次上下文、词条总量 <20 条，触发式机制省不了多少 token，反而引入"该触发没触发"的不确定性。唯一要继承的思想是 timed effects 的"按轮次衰减"：把它降维成状态层"最近着迷 N 轮内保持、之后滑出"的一个数字即可。

---

> **不确定**：ST 旧版本 position 数字位的历史含义未查 changelog（只核了 2026-10-26 release 分支）；eliza v1 源码经 npm 发布包 source map 还原，文件行号以包内还原版为准（◐）；V3 在各前端的实际采用率未做普查；generative_agents 主分支代码与论文 (arXiv 2304.03442) 的最终发表版可能有细节出入；ElizaOS v1 仓库现无同名 v1 分支/标签可直读，以 0.1.9 发布包为 v1 证据。

> 链接：[CCv2 spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)｜[CCv3 spec](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)｜[ST World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)｜[ST Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/)｜[ST Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/)｜[ST world-info.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js)｜[elizaOS/eliza](https://github.com/elizaOS/eliza)｜[eliza v2 Character 文档](https://docs.elizaos.ai/agents/character-interface)｜[eliza core 0.1.9 包](https://registry.npmmirror.com/@elizaos/core/-/core-0.1.9.tgz)｜[client-twitter 0.1.9 包](https://registry.npmmirror.com/@elizaos/client-twitter/-/client-twitter-0.1.9.tgz)｜[Generative Agents 仓库](https://github.com/joonspk-research/generative_agents)｜[论文](https://arxiv.org/abs/2304.03442)｜[OpenClaw Agent Runtime](https://docs.openclaw.ai/concepts/agent)｜[ZerePy 文档](https://www.zerepy.org/docs/create-agents)｜[dafeiyu-cleaner](https://github.com/liyupi/dafeiyu-cleaner)。
