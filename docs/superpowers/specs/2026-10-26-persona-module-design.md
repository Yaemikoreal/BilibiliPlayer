# 人设模块升级 —— 酒馆式卡片 + 动态状态层 + 分层注入（设计文档）

> 日期：2026-10-26 ｜ 状态：已经用户逐节确认 ｜ 上游调研：[2026-10-26-persona-card-practices.md](../../research/2026-10-26-persona-card-practices.md)
> 关联：[真人热评语料](../../research/2026-10-25-human-comments-corpus.md) ｜ [鲸鱼娘生态调研](../../research/2026-10-25-whale-lore.md)

## 0. 目标与背景

**目标**：提升B站分身的"活人感"——不一眼被认出是 AI。把人设从配置里的一个字符串字段（`personaPrompt`）擢升为**独立设置模块**，按酒馆（SillyTavern）的成熟经验丰富人设、丰满人物形象。

**现状的四个缺口**：

| 缺口 | 现状 | 后果 |
|---|---|---|
| 人设只是配置页一个 Group + textarea | `personaPrompt` 单字段，纯文字或文件路径，6000 字截断 | 无法结构化、无卡片库、无预览 |
| 双重权威 | 章程（duty.md）「评论纪律」、index.js:651 硬编码口吻行、whale 卡「评论没有模板」三处平行讲口吻 | 相互覆盖、升级即打架 |
| 无连续性 | 每轮冷启动，没有"这号最近迷什么/心情如何" | 行为是"每轮重置的模板"，不是"活着的号" |
| 防复读靠自觉 | 静态全文注入，每轮组合完全相同 | 风格僵化 →"鱼八股"（调研 §4.4：口癖固化即检测特征） |

**四个设计点**（用户全选）：A 人设独立模块+卡片库 ｜ B 注入层重构 ｜ C 动态状态层（agent 自写 + 宿主监督）｜ D 人设内容升级。

**实现路线**（用户确认）：**方案一**——V2 卡为骨 + 覆盖槽（`{{original}}`）+ 抽样池注入 + ISS 状态层。lorebook 用户拍板"要做"（极简数据模型 + 软触发，见 §3.3）。

## 1. 来源与忠实度声明（哪些抄谁的）

| 设计元素 | 来源 | 依据 |
|---|---|---|
| 卡片 schema（`spec/data` 容器、字段与语义）、覆盖槽 `{{original}}`、extensions 不销毁未知键、管理元数据不进 prompt、`first_mes` 定调、`<START>` 示例块 | ✅ SillyTavern V2 spec | 调研 §1.1/§1.5 |
| `nickname / createdAt / modifiedAt / source` | ✅ V3（只抄这四个） | 调研 §1.3 |
| 抽样池（每槽随机抽样、`{{user1}}` 换随机人名） | ⚠️ elizaOS（非酒馆） | 调研 §2（runtime.ts 源码证实） |
| 状态层 ISS（稳态+`Currently`）、第三人称改写、重要性累计触发 | ⚠️ Generative Agents | 调研 §3（scratch/plan/reflect.py） |
| 分层注入 + 超限截断加"去读原文"标记 + 空层跳过 | ⚠️ OpenClaw | 调研 §4.2 |
| 卡级禁词消毒 | ⚠️ dafeiyu-cleaner 反用 | 调研 §4.4 |
| 作息/节奏模拟 | 参考 ZerePy（本期不实现，已有 noon/night 窗口） | 调研 §4.3 |

**对酒馆的三处有意偏离（交底）**：
1. **lorebook 触发判定从宿主侧移到 agent 侧（软触发）**——值班轮里 agent 自己刷视频，宿主构建 prompt 时不知道会遇到什么视频，宿主无法真扫描。落地：`constant` 条目常驻；keyed 条目全量注入但标注触发词，由 agent 按章程指令自行匹配应用。
2. **字段名 camelCase 内部存储**，导入酒馆 JSON 时 snake_case 自动映射、导出写回 snake_case，保证生态可往返。
3. **`firstMes` 改义**：酒馆里是聊天开场白；我们没有聊天历史，改义为**新卡启用第一轮注入一次的定调样本**。

## 2. 总体架构

```
插件内置 prompts/cards/*.json  ──首启种子──▶  <家目录>/personas/
├── index.json            ← 卡片索引（id→文件、active、顺序）
├── <card-id>.json        ← 每张卡一个文件（V2 兼容）
├── state.history.jsonl   ← 状态快照（append-only，宿主写，留 30 条）
└── ../persona-state.json ← agent 自写的动态状态（与宿主 state.json 严格分离！）

配置层新增：personaCard（激活卡 id）、personaStateLock（状态锁定）、personaPrompt→personaRaw（高级原始覆盖）

lib/persona-card.js    纯函数：schema 校验 / 索引读写 / .md 导入 / 内置卡种子 / 导入导出映射
lib/persona-state.js   纯函数：状态校验 / 禁词消毒 / 快照回滚 / 健康指标 / 重要性累计器
lib/persona-compile.js 纯函数：卡片 + 状态 + 足迹 → 分层注入块（含预算与抽样）
lib/persona-footprint.js 纯函数：ledger.jsonl → 足迹摘要
index.js / client.js   薄装配：buildDutyPrompt 接编译器；新 API 路由；PersonaPane UI
```

**权威秩序（终结双重权威）**：
- **章程 duty.md = 宿主默认**（`{{original}}` 的本体）：流程、配额、四契约（报告/记账/判重/状态）、红线、评论纪律（语料校准的 craft，persona 无关）
- **卡片 = 人格与风格的唯一权威**：身份、性格、背景、世界观（lorebook）、说话风格、示例池、梗库、参数
- **两个覆盖槽**（V2 语义，默认空=不覆盖）：`systemPrompt` 非空替换开头身份声明（`{{original}}`=原文）；`postHistoryInstructions` 非空注入 prompt 最底端（`{{original}}` 解析为空串，我们无宿主等价物；v1 不做 UI 编辑入口，仅文件可改）
- **红线不开放覆盖**：红线段始终由章程生成，卡片 `redLines` 只能追加（加严），任何槽写不进红线

**模块边界**：persona-card（卡怎么存取迁移）、persona-state（状态怎么消毒记账）、persona-compile（三者怎么拼成 prompt）各自可独立测试；index.js 路由与 UI 只做装配。

## 3. 注入层（lib/persona-compile.js）

### 3.1 最终 prompt 里的顺序（ST 影响梯度：越靠底部影响越大）

```
① 开头身份声明        ← systemPrompt 槽非空则替换（{{original}}=原文）
② 身份层（≤4000字）   ← name/nickname + description + personality + scenario
                        + bio 洗牌抽3 + likes/dislikes 一行 + adjectives 抽1
③ 世界观层（≤1500字） ← lorebook：constant 条目常驻 + keyed 条目（带触发词标注，软触发）
④ 风格层（≤2500字）   ← style.all + style.duty + mesExample 抽2-3段（<START> 块、
                        {{char}}→昵称、{{user1}}→随机网友名）+ postExamples 抽3
                        + firstMes（仅新卡启用第一轮）
⑤ 章程 duty.md        ← 宿主默认，不动
⑥ 本轮参数区尾部      ← 状态层（≤600字）+ 足迹层（≤800字）+ postHistoryInstructions 槽
⑦ 红线段              ← 章程生成 + 卡 redLines 追加（只增不减）
```

### 3.2 预算与抽样

- 每层独立上限（§3.1 括号内），总人设块 ≤10000 字；超限按 `insertionOrder` 丢弃（lower=先入），截断层尾加「（已截断，原文见卡片）」；空层跳过
- **抽样**（eliza 机制，每轮独立洗牌）：bio 取 3 ｜ adjectives 取 1 ｜ mesExample 段取 2-3 ｜ postExamples 取 3 ｜ keyed lore 全量（<20 条，软触发）。**每轮组合不同 = 机制级防复读**
- 抽样注入随机种子可指定（测试确定性）

### 3.3 lorebook（character_book，ST 数据模型 + 软触发）

- 条目结构（酒馆兼容子集）：`{ keys[], content, enabled, constant, insertionOrder, position: before_char|after_char, comment }`
- `constant` 条目 → 常驻注入；keyed 条目 → 全量注入 + 触发词标注，agent 按章程指令"仅当前视频/评论命中 keys 时应用该条视角"
- 砍掉：递归扫描 / regex keys / selective / probability / timed effects / inclusion groups / 向量检索（调研：对"一轮一上下文"全部过重）
- 保留：`insertionOrder`（预算内排序）+ 总量预算（≤1500 字）+ 溢出告警（写日志 + 预览标红）

### 3.4 口吻权界终结

- **删除 index.js:651 硬编码口吻行**
- 语料纪律（长度双峰/句号率/禁骨架/"删后半句"测试）只住章程「评论纪律」
- 卡片风格层只写 persona 特有项（自称/口癖/梗库/语气样本），**不得复述纪律**（内置卡迁移时剥掉纪律节）
- duty.md 增加一行权界声明："卡片风格与本节冲突时：长度/标点/骨架等语料纪律以本节为准；自称/口癖/梗等以卡片为准"

## 4. 动态状态层（lib/persona-state.js + 章程状态契约）

### 4.1 文件与 schema

agent 写 `<家目录>/persona-state.json`（**与宿主 state.json 分离**——后者存 lastRunAt/seenNotifs 等运行状态，绝不能被 agent 覆盖）；宿主写 `personas/state.history.jsonl`。

```jsonc
{
  "updatedAt": "ISO", "roundId": "…",
  "currently":  "第三人称一句话：这号最近在干嘛/迷什么/心情底色（≤120字）",
  "mood":       "≤40字",
  "obsessions": ["≤20字/条，≤5条"],
  "lifeNotes":  ["生活碎片 ≤40字/条，≤5条"],
  "notes":      "给下一轮自己的话（≤100字，可选）"
}
```

ISS 对应：稳态（名字/本质/学来的特征/生活节律）由卡片身份层常驻供给，agent **不碰**；动态只有上述五字段。

### 4.2 触发：重要性累计器（宿主执行，agent 只在被要求时才写）

- 事件权重（poignancy 思想，互动比主动动作重）：`view=2, like=1, comment=5, dynamic=4, reply-out=4, reply-in=6, like-in=3`
- 计数器从 150 起步（`IMPORTANCE_TRIGGER_MAX`），按账本事件累计扣减；**扣到 0 → 下一轮 prompt 标记"该更新状态"**
- 触发轮：附输入材料（账本最近 20 条摘要 + 上轮 currently）+ 契约指令（第三人称改写、以账本事实为输入、不编可当真的事实）；写完重置 150
- 未触发轮：沿用现有 currently，不催写（省钱 + 防状态抖动）

### 4.3 交互→情绪→行为闭环（一等机制）

1. **宿主派生"交互刺激摘要"**：扩展 `replyTick`（每 5 分钟已拉回复通知）**加拉点赞通知**（`bili_received_at_and_likes` 同族接口），新账本事件 `like-in`；重写前从账本算出"自上次重写以来的刺激"：`收到回复 3 · 我的评论被赞 5 · 发出评论 2 · 连续值班 4 天 · 上轮被无视（0 回复）`
2. **情绪必须可追溯**（重写契约条款）：更新 `mood/currently` 时必须引用刺激摘要里的具体事实——"因为那条回复被赞有点得意"可以，"莫名emo"不行（写不出事实依据的项宿主丢弃）。这是 revise_identity 的做法：以最近记忆为输入，不是凭空写心情
3. **人格决定情绪表达**：同一刺激，不同卡片感受不同——被夸时 whale"看热闹型暗爽"、elaina"嘴硬说我早就知道"。情绪素材公共，**情绪色彩由卡片 personality/style 上色**
4. **情绪反作用行为**（软调制）：编译器在状态层固定附一行——"本轮情绪底色会自然影响语气与活跃度（低落多看少说、兴奋可多留一条），但配额与红线照旧"。不写死"mood<3 禁评"这类规则（会变成模板腔），交给 agent 演绎，监督面照旧

闭环：**交互（账本事实）→ 刺激摘要 → 人格上色的情绪 → 下轮语气与活跃度 → 新的交互**。

### 4.4 宿主监督四道闸（读时执行）

1. **消毒**：schema 校验 + 字段截断 + 禁词扫描（全局禁令词 + 元话语"值班/分身/主人/本鲸" + 卡 `bannedWords`——dafeiyu 识别维度反用）；违规字段丢弃 → 回退上一有效快照，log + 控制台标红
2. **快照**：接受新版前旧版 append 进 `state.history.jsonl`（留 30 条），UI 可查看、一键回滚
3. **接管**：`personaStateLock` 锁定开关——锁定后注入锁定版、agent 写入忽略、下轮 prompt 告知"状态已锁定"；UI 可直接编辑/清空
4. **健康**：陈旧（连续 N 轮没更新→warn）、僵化（连续 3 版文本相同→warn）、膨胀（触发截断→warn）

### 4.5 足迹层（lib/persona-footprint.js）

宿主从 `ledger.jsonl` 派生纯事实（与 agent 自写情绪互不依赖）：最近 48h 看过/评过/赞过 top5、活跃时段（事件小时直方图 top2）、连续值班天数。≤800 字，注在状态层旁。

### 4.6 写侧契约（duty.md 新增「状态契约」节，与报告/记账/判重并列）

仅当本轮 prompt 标记"该更新状态"才重写；写到绝对路径 `persona-state.json`；字段与上限表；"只改这一个文件、违规字段会被丢弃"；先落状态再写报告（或与报告同批）。

## 5. UI（操作台 → 人设 tab）与 API

**落点**：`ConsoleView` tabs → `[配置, 人设, 实时, 日志, 判重表, 产物]`。`PersonaPane` 复用现有组件（Card/Group/Row/Switch/Num/ChipsInput/Pill/Btn/Tabs + bf-* CSS）。

```
┌ 卡片库：[whale 活跃●] [elaina] [+导入.json] [+新建] ┐
├ 卡片编辑器（折叠节）：基本身份 / 性格与好恶 / 风格 / 示例池 /
│   世界观（条目列表 keys|content|constant|开停）/ 覆盖槽（高级，警示"非空即替换"）/
│   参数滑条 + bannedWords + redLines ｜ [预览编译结果] [导出.json] [删除] [保存并生效] ┤
├ 当前状态（agent 自写·宿主监督）：Currently + mood/obsessions/lifeNotes
│   [锁定🔒] [编辑] [清空] [回滚▾] ｜ 健康：✓新鲜 / ⚠陈旧·僵化·膨胀 ┤
└ 足迹预览（宿主派生）：最近48h·活跃时段·连续天数 ┘
```

- **注入预览**：调编译接口返回完整分层人设块（带层标签），`<pre class="bf-doc">` 展示——所见即所得，调人设不用跑真值班轮
- 保存即写卡文件 + 更新索引 + 立即生效（下轮值班用新卡，与现有"保存即热生效"一致）

**API**（沿用现有 `/api/bili-fenshen/*` 模式）：

```
GET  /personas                  卡片索引（id/name/active/tags/updatedAt）
POST /personas                  新建/导入（卡 JSON 或 {mdPath}）
GET  /personas/:id              读卡
POST /personas/:id              保存（schema 校验，保留未知 extensions 键）
POST /personas/:id/activate     激活（写 config.personaCard）
DELETE /personas/:id            删除（活跃卡不可删）
GET  /personas/compile-preview  编译预览（分层带标签）
GET  /persona-state             状态 + 健康指标 + 历史列表
POST /persona-state             {action: edit|clear|rollback}
POST /persona-state/lock        {locked: true|false}
GET  /persona-footprint         足迹预览
```

**配置字段**（进 `lib/config.js` FIELDS + index.js zod）：`personaCard: 'string'`（空=未启用卡模式）、`personaStateLock: 'boolean'`（默认 false）、`personaPrompt` 改名 `personaRaw`（string，非空=整段替换编译结果，最高优先级）。

## 6. 卡片 schema（V2 兼容）

```jsonc
{
  "spec": "chara_card_v2", "spec_version": "2.0",
  "data": {
    "name": "蓝色大肥鱼",              // 人设名（进 prompt）
    "nickname": "不吃鱼的豆腐",        // V3：账号名/昵称与人设名分离
    "description": "…",               // 身份+背景主体（长文，常驻）
    "personality": "…",               // 性格概要（常驻）
    "scenario": "…",                  // 这个号在B站的处境（常驻）
    "firstMes": "…",                  // 定调样本（新卡第一轮注入一次）
    "mesExample": "…",                // ST <START> 块格式，兼容酒馆写法
    "systemPrompt": "",               // 覆盖槽，默认空
    "postHistoryInstructions": "",    // 覆盖槽，默认空
    "alternateGreetings": [],
    "tags": [], "creator": "", "characterVersion": "1.0",
    "creatorNotes": "给人看的备注，绝不进 prompt",
    "characterBook": {                // 极简 lorebook（§3.3）
      "name": "", "entries": [ { "keys": [], "content": "", "enabled": true,
        "constant": false, "insertionOrder": 100, "position": "after_char", "comment": "" } ]
    },
    "extensions": {                   // V2 铁律：不销毁未知键 → 升级不丢自定义
      "bili_fenshen": {
        "bio": [],                    // 随机抽 3
        "lore": [],                   // 背景碎片池，随机抽 10（注意：与 characterBook 分工——
                                      //   lore=零散背景碎片走抽样；characterBook=结构化世界观条目走软触发）
        "postExamples": [],           // 动态池，随机抽 3（对应 eliza postExamples；建议 12 的"动态池≤15"）
        "style": { "all": [], "duty": [] },
        "adjectives": [],             // 随机抽 1
        "sliders": {},                // 参数滑条（原「配比/参数」行数值化）
        "likes": [], "dislikes": [],
        "bannedWords": [],            // 卡级禁词，并入消毒表（只加严）
        "redLines": []                // 卡级红线补充（并入红线段，只增不减）
      }
    }
  },
  "meta": { "id": "whale", "createdAt": 0, "modifiedAt": 0, "source": ["授权链/出处"] }
}
```

- 管理元数据（creatorNotes/tags/creator/characterVersion）**绝不进 prompt**（V2 MUST）
- `extensions` 未知键原样保留（V2 MUST NOT 销毁）
- 内置卡 `whale.json` / `elaina.json` 随插件分发（`prompts/cards/`），首启种子到 `<家目录>/personas/`，已存在不覆盖

## 7. 内容迁移（设计点 D）

1. **whale.json v1.0**（persona-whale.md v0.9 迁移充实）：
   - `description` ← 身份节+本体节+社区味节改写为背景长文；`personality` ← 配比+活人感要点凝练；`scenario` ← "民间二创小号"处境（三条边界改写）
   - `bio` ← 8-12 条第三人称短句；`lore` ← 梗库可用项+署名链+社区处境（鱼八股/清洗插件的存在，让 agent 懂得口癖为何要克制）；`characterBook` keyed 条目示例：`["三角洲","王者","LOL","无畏契约"]`→游戏区视角、`["AI","模型","额度"]`→科技区视角（科技区大热评论区少凑——鱼灾主场）
   - `style.duty` ← 贴吧腔+persona 侧残余（纪律本体剥给章程）；`postExamples` ← 动态样本；`mesExample` ← 语气样本改写 `<START>` 块（评论与回复两类合并进 mesExample 的不同 `<START>` 段——调研建议 12 的"三池"在此简化为"示例对话一池"，动态独立成池）
   - `sliders` ← 参数行数值化；`bannedWords` ← "别用"清单；`redLines` ← persona 特有红线（不商业/CC 署名）
2. **elaina.json v0.2**：同法迁移
3. 原 .md 保留在 `prompts/`（加载兼容测试保留），README 指向卡片
4. **迁移内容纪律**：不得复述章程纪律；不得引入新的固化口癖（口癖即检测特征，多样性靠抽样池与结构变化）

## 8. 兼容与迁移

- 老用户：`personaPrompt` 有值 → 首启自动转 `legacy` 卡（description=原文）并激活；字段改名 `personaRaw`（config 覆盖层自动搬迁），语义：非空=整段替换编译结果
- duty.md bump 到 v3：开头权界声明、「状态契约」节、lorebook 软触发使用说明
- 家目录旧文件零破坏（state.json 不动，新文件全是新增）
- 卡 JSON 手工改坏：该卡标红禁用，回落中性人格，绝不把坏数据注进 prompt（persona.js 既有原则延续）

## 9. 测试计划（node --test 纯函数惯例）

- `persona-card.test.js`：schema 校验/未知键保留/snake_case↔camelCase 映射/.md 导入/种子不覆盖/删除保护
- `persona-state.test.js`：消毒（禁词命中字段丢弃+回退快照）/快照 30 条上限/锁定语义/健康指标（陈旧/僵化/膨胀）/重要性累计器扣减与重置
- `persona-compile.test.js`：分层顺序与标签/抽样确定性（注入随机种子）/预算截断顺序/覆盖槽 `{{original}}` 语义/红线永不被覆盖/空层跳过
- `persona-footprint.test.js`：账本→足迹摘要/活跃时段/连续天数
- `index.integration.mjs` 扩展：新 API 路由 200/400、buildDutyPrompt 产物含各层标签、口吻行已删除
- 内置卡测试：whale/elaina 过 schema、抽样池非空、bannedWords 非空

## 10. 明确不做（YAGNI）

多卡按时间窗口自动切换、PNG/CHARX 容器、向量检索、递归扫描、timed effects、inclusion groups、多语言卡片、卡片市场、完整 eliza templates 覆写机制。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 漏写状态/写坏 | 触发才写 + 四道闸 + 快照回退 + 健康指标（陈旧 warn），缺状态不阻断值班 |
| 状态自我污染（元话语滚雪球） | 消毒禁词表 + 只回退不放大 + 锁定人工兜底 |
| persona 内容变成新口癖（检测特征） | 抽样池机制级防复读 + 迁移纪律"不复述纪律、不加新口癖" + dafeiyu 维度反向自检 |
| prompt 膨胀 | 分层预算 + 总量 ≤10000 字 + 截断告警 + headless 模型 1M 上下文兜底 |
| 覆盖槽误用致纪律失效 | 红线段永不进覆盖槽；槽默认空；UI 折叠+警示 |
