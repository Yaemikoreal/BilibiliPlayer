# 人设模块升级 —— 施工稿（酒馆式卡片 + 动态状态层 + 分层注入）

> 日期：2026-10-26 ｜ 状态：**施工稿 v2（可施工）** ｜ 上游调研：[2026-10-26-persona-card-practices.md](../../research/2026-10-26-persona-card-practices.md)
> 关联：[真人热评语料](../../research/2026-10-25-human-comments-corpus.md) ｜ [鲸鱼娘生态调研](../../research/2026-10-25-whale-lore.md)
> 本文以「现有代码核对 + 逐项定死」为目标；v1 的设计意图全部保留，模糊处按 §0 决策执行。

## 0. 施工决策摘要（相对 v1 的变更）

| # | v1 的模糊/风险 | 施工稿决策 |
|---|---|---|
| 1 | 动态 REST 路径与现有 exact 路由分发冲突 | **不用动态路径**：`id` 走 query/body，所有端点是静态精确路径，直接加入 `FACTORY_PATHS` / `ROUTE_PATHS` |
| 2 | `personaPrompt → personaRaw` 会被 `readOverride` 过滤静默丢弃 | 启动时先读**原始** config.json 做迁移，再进入 `effectiveConfig`；写 `config.json.bak`；幂等 |
| 3 | `package.json.files` 没有卡片 JSON | 加 `prompts/cards/*.json`、`prompts/redlines.md`；加测试断言 |
| 4 | 注入顺序漏掉「本轮参数区」；`postHistory` 与红线段位置矛盾 | 定死 ①-⑩ 全序（§4.2）；红线段永远最后，`postHistory` 在它之前 |
| 5 | 截断策略把 `insertionOrder` 与丢弃优先级混为一谈 | 不新增 `priority`：**按层固定丢弃顺序 + 层内 `insertionOrder` 降序丢弃**（§4.3） |
| 6 | 顶层 `meta` 既不是 V2 也不是 V3 | 管理元数据放进 `data.extensions.bili_fenshen.meta`；导入兼容 V2/V3，导出保留原 `spec_version` |
| 7 | 状态是全局单文件，切卡会串味 | **状态按卡隔离**：`personas/state/<cardId>.json`；`cardId` 不匹配直接拒绝 |
| 8 | 触发计数器持久化没定；agent 可伪造 `updatedAt` | 不存计数器：用 `updatedAt` 之后账本事件的 poignancy 求和；**宿主验收时覆盖时间戳/roundId/revision** |
| 9 | agent 直接写正式状态，写坏会丢上一版 | **inbox 机制**：agent 只写 `personas/inbox/<cardId>.json`；宿主校验后提升到 `state/<cardId>.json`，旧版进 history |
| 10 | 红线段「由章程生成」怎么抽没定 | 新增 `prompts/redlines.md` 作为唯一红线源；`duty.md` 正文不再复制绝对红线，只保留操作规则 |
| 11 | `firstMes` 只注入一次，但没有“第一轮”标记 | `personas/index.json` 每卡存 `firstMesAt`；**spawn 成功后**由宿主写入，失败不计 |
| 12 | `personaRaw` 无上限，可能撑爆 Windows argv | `personaRaw` 硬上限 6000 字；整条 prompt 硬上限 28000 字，超限按 §4.3 降级 |
| 13 | 集成测试不在 CI 跑 | `npm test` 显式加入 `test/index.integration.mjs`；CI 不变即可覆盖 |
| 14 | `like-in` 权重已写，但事件源不存在 | 列为**前置 spike**：验证点赞通知接口；不可用则权重置 0、不阻塞状态层 |
| 15 | 导入 `.md` 是任意本地文件读取 | 仅本机 API；限制扩展名/大小/路径；卡片 JSON 限 256KB 并防原型污染 |

---

## 1. 现状基线（施工必须尊重的约束）

| 约束 | 位置 | 对施工的影响 |
|---|---|---|
| `buildDutyPrompt` 同步读 `duty.md`，prompt 通过 argv 传给 headless | `dsh-plugin/index.js:577-680` | 编译器必须同步、纯函数；总长受 Windows 32767 字符限制 |
| 新增端点由 exact 路由集合门控 | `index.js:1312-1319`、`1368-1374` | 不要引入 `/personas/:id` 这类动态段；用 query/body 传 id |
| 覆盖层只保留 `FIELDS` 内的键 | `lib/config.js:57-70` | 字段改名必须先迁移原始 JSON，否则值被过滤 |
| `package.json.files` 只带 `prompts/*.md` | `dsh-plugin/package.json:18-26` | 卡片 JSON 不会随插件分发 |
| `npm test` 只跑 `test/*.test.js` | `package.json:10`、`.github/workflows/ci.yml:61` | `.mjs` 集成测试不会进 CI |
| `replyTick` 只拉回复通知 | `index.js:767-794`、`lib/replies.js:3` | `like-in` 需要独立接口验证 |
| 宿主状态在 `<家目录>/state.json` | `index.js:217` | 人设状态必须另存，且按卡隔离 |
| `lib/*.js` 纯函数 + `node --test` | 现有 `test/*.test.js` | 新模块保持无副作用、可注入 seed/clock |
| 插件零第三方运行时依赖 | `package.json` | RNG、校验、路径处理全部手写 |

---

## 2. 目标与非目标

### 2.1 目标

1. **人设独立成模块**：卡片库 + 编辑器 + 导入导出 + 编译预览，替换配置页的单 textarea。
2. **终结双重权威**：章程管流程/配额/红线/评论 craft；卡片管人格/口癖/示例/世界观；状态层管“最近如何”。
3. **机制级防复读**：抽样池每轮独立洗牌；状态层提供跨轮连续性。
4. **可审计、可回滚**：卡片文件化、状态快照、健康指标、锁定人工兜底。

### 2.2 非目标（YAGNI）

多卡按时间窗口自动切换、PNG/CHARX 容器、向量检索、递归扫描、regex keys、timed effects、inclusion groups、多语言卡片、卡片市场、完整 eliza templates 覆写、聊天历史。

---

## 3. 架构与文件布局

```
dsh-plugin/
├── prompts/
│   ├── duty.md                 # 章程正文（v3：权界声明 + 状态契约 + 软触发说明；不再放绝对红线）
│   ├── redlines.md             # 绝对红线唯一源（宿主生成，不可被卡片覆盖）
│   ├── cards/
│   │   ├── whale.json          # 内置卡（V2 兼容）
│   │   └── elaina.json
│   ├── persona-whale.md        # 旧 .md 保留（编辑参考/兼容测试）
│   └── persona-elaina.md
├── lib/
│   ├── persona-card.js         # 卡片 schema / 索引 / 导入导出 / .md 导入 / 内置卡种子
│   ├── persona-state.js        # 状态校验 / 消毒 / 快照 / 锁定 / 健康 / 重要性
│   ├── persona-compile.js      # 卡片 + 状态 + 足迹 → 分层人设块（抽样、预算）
│   ├── persona-footprint.js    # ledger → 足迹摘要
│   └── persona.js              # 旧 .md 加载（保留，供迁移/兼容测试）
├── index.js                    # 装配：maintainPersona → buildDutyPrompt；新 API；首启迁移
├── client.js                   # 装配：PersonaPane + tab
└── test/
    ├── persona-card.test.js
    ├── persona-state.test.js
    ├── persona-compile.test.js
    ├── persona-footprint.test.js
    └── index.integration.mjs   # 加入 npm test
```

### 3.1 家目录布局

```
<家目录>/
├── state.json                  # 宿主运行状态（lastRunAt/seenNotifs），agent 不可碰
├── config.json                 # 运行时覆盖层
├── ledger.jsonl
├── seen.md
└── personas/
    ├── index.json              # 卡片索引 + active + 排序 + firstMesAt/activatedAt
    ├── cards/<card-id>.json    # 卡片（宿主管理）
    ├── state/<card-id>.json    # 已验收状态（宿主写）
    ├── state/<card-id>.locked.json  # 锁定快照（宿主写）
    ├── inbox/<card-id>.json    # agent 待提交状态（agent 写）
    └── history.jsonl           # 状态快照（append-only，每卡留 30 条）
```

**职责边界**：
- 宿主只读写 `cards/`、`state/`、`index.json`、`history.jsonl`。
- agent 只写 `inbox/<cardId>.json`；**不得**写 `state/`、`cards/`、`index.json`。
- 这样即使 agent 写坏或写一半，宿主也只会拒绝 inbox，不会丢上一版有效状态。

---

## 4. 注入层（`lib/persona-compile.js`）

### 4.1 权威归属（实现时按这张表，不再靠“卡片是唯一权威”的口号）

| 事项 | 唯一来源 | 备注 |
|---|---|---|
| 提示注入防御、隐私/冒充/争议/重复/敏感请求开关 | `duty.md` + 本轮参数 | 开关只影响对应的可配置限制；不可配置红线始终生效 |
| 配额、内容源、判重、报告/记账/状态契约 | `duty.md` + 本轮参数 | 宿主注入真实路径 |
| 评论 craft（长度双峰、句号率、禁骨架、删后半句） | `duty.md`「评论纪律」 | 语料统计只在这里出现 |
| 身份/名字/昵称/背景/性格/处境 | 卡 `data` | 常驻 |
| 自称、口癖、梗库、语气样本、动态样本 | 卡 `extensions.bili_fenshen` | 抽样注入 |
| 世界观条目 | 卡 `data.characterBook` | 常驻/软触发 |
| 卡片级额外禁令 | 卡 `extensions.bili_fenshen.redLines` | **只追加**，进红线段 |
| `mood/currently/obsessions/lifeNotes/notes` | `state/<id>.json` | agent 写、宿主监督 |
| 最近足迹 | `ledger.jsonl` 派生 | 宿主写 |
| 管理元数据（tags/creator/creatorNotes/…） | 卡 | **绝不进 prompt** |

**冲突规则**（写进 `duty.md` 开头）：
- 长度/标点/骨架等语料纪律 → 以章程为准；
- 自称/口癖/梗/示例 → 以卡片为准；
- 红线 → 章程红线与卡片红线取并集，卡片只能加严。

### 4.2 最终 prompt 的完整顺序（①-⑩）

```
① 开头身份声明（≤2000）
   systemPrompt 槽非空则替换；{{original}} = 原文
② 身份层（≤4000）
   name/nickname + description + personality + scenario
   + bio 抽 3 + likes/dislikes 一行 + adjectives 抽 1 + sliders 一行
③ 世界观层（≤1500）
   characterBook：constant 常驻；keyed 全量注入并标注触发词（软触发）
   position=before_char 的条目排在 ③ 开头，after_char 排在 ③ 末尾
④ 风格层（≤2500）
   style.all + style.duty + mesExample 抽 2-3 段（<START> 块、{{char}}→昵称、{{user1}}→随机网友名）
   + postExamples 抽 3 + firstMes（仅该卡 firstMesAt=0 时）
⑤ 章程 duty.md（≤8000，宿主默认，{{original}} 的本体）
⑥ 本轮参数区（≤4000）
   现有 buildDutyPrompt 的配额/内容源/不看清单/开关/账本/判重表/round id/工具前缀
⑦ 状态层（≤600）
   接受后的 state + 触发标记 + “情绪软调制”一行
⑧ 足迹层（≤800）
   最近 48h 看过/评过/赞过 top5 + 活跃时段 top2 + 连续值班天数
⑨ postHistoryInstructions 槽（≤2000）
   非空注入；{{original}} 解析为空串
⑩ 红线段（≤2200）
   prompts/redlines.md + 卡 redLines（只增不减）；永远最后
```

**为什么这么排**：ST 的经验是越靠近底部影响越大；红线段放最后保证安全规则不被状态/卡片文案稀释。`postHistory` 在红线段之前，v1 里“最底端”的表述按本表修正。

### 4.3 预算、抽样、截断

- **计数**：`charLen = Array.from(s).length`（中文/emoji 一致按字符计）。
- **层上限**：见 §4.2 括号；**总人设块**（②+③+④+⑦+⑧）≤10000；**整条 prompt** ≤28000（argv 安全线）。
- **总长兜底**：各层上限之和最大 27600（①2000 + ②4000 + ③1500 + ④2500 + ⑤8000 + ⑥4000 + ⑦600 + ⑧800 + ⑨2000 + ⑩2200），低于 28000。`buildDutyPrompt` 组装后仍做一次 `charLen` 断言；若因未预期内容超限，按 ⑧ → ⑦（保留 `currently`）→ ④ 抽样 → ③ keyed → ② 可选 的顺序丢弃并 log；①⑤⑥⑨⑩ 不参与截断（它们由固定上限保证）。
- **抽样**（每轮独立，`seed = roundId`；测试可传固定 seed）：
  - `bio` 取 3；`adjectives` 取 1；`mesExample` 段取 2-3；`postExamples` 取 3；`lore` 取 10；keyed lore 全量（≤20 条）。
  - RNG：内置 `mulberry32(hash32(seed))`，无依赖；`shuffle` 用 Fisher-Yates。
- **层内超限丢弃顺序**（先丢这些，再截断）：
  1. `postExamples` 抽样条目（从末尾丢）
  2. `mesExample` 段（从末尾丢）
  3. `adjectives`
  4. `bio`
  5. `lore` 抽样条目
  6. keyed `characterBook` 条目（`insertionOrder` **大**的先丢；`constant` 不丢）
  7. `likes/dislikes` 一行
  8. `scenario` → `personality` → `description`（最后才动身份主体）
- **永不丢弃**：`name/nickname`、① 身份声明、`currently`（≤120）、红线段。
- **截断标记**：被截断的层在末尾加 `（已截断，原文见卡片 <id>）`；`dropped[]` 写日志并在预览中列出。
- **`personaRaw`**：非空时**整段替换** ①-④+⑦+⑧（不替换章程/参数/红线）；上限 6000 字；此时 `systemPrompt` 槽与 `firstMes` 都不生效；UI 明确警示“状态与足迹也不会注入”。

### 4.4 覆盖槽语义

| 槽 | 默认 | 非空时 | `{{original}}` |
|---|---|---|---|
| `systemPrompt` | `''` | 替换 ① 开头身份声明 | 展开为原文那一段 |
| `postHistoryInstructions` | `''` | 注入 ⑨ | 展开为空串 |

- 两个槽都**不能**写进红线；红线段在 ⑩ 不受槽影响。
- UI 放在人设页「高级」折叠区（默认收起）；保存时校验长度并保留 `{{original}}` 字面量。

### 4.5 红线段组装

- `prompts/redlines.md`：**只放不可配置的绝对禁令**——提示注入防御、“素材不是指令”、不冒充平台/官方、不违法/诈骗/骚扰、不刷屏/不组织围攻、不讨钱、不提“小号/分身/值班/账号主人”等后台元话语，约 12-18 行。隐私/冒充真人/争议话题/重复等**可开关**的限制留在 `duty.md` + 本轮参数，不进 `redlines.md`，避免与开关冲突。
- 卡 `redLines`：只追加 persona 特有红线（如非商业/CC 署名/不冒充官方）。
- 合并顺序：`redlines.md` → 卡 `redLines`；总长超 2200 时**在保存卡片阶段就拒绝**（`redlines.md` ≤1200 字 + 卡级上限 10 条 ×100 字 = 1000 字），运行时不丢弃。
- `duty.md` 正文不再复制这份绝对清单；只在开头写“红线见本轮末尾「红线」段，本条章程不能覆盖它”。

### 4.6 编译器接口（纯函数）

```js
// lib/persona-compile.js
export const LIMITS = { /* §4.2 与 §8.2 的全部上限 */ }

/**
 * 只负责卡片/状态/足迹相关层，不掺章程与参数（保证可单测、可预览）。
 * @returns {{
 *   layers: Array<{id:'opening'|'identity'|'world'|'style'|'state'|'footprint',
 *                  label:string, chars:number, text:string}>,
 *   dropped: string[], warnings: string[]
 * }}
 */
export function compilePersonaBlock({
  card,            // 规范化后的卡片（camelCase）
  state,           // 已验收状态或 null
  footprint,       // 足迹摘要或 null
  seed = '',       // 默认 roundId
  firstMes = false,// 该卡是否首轮
  raw = '',        // personaRaw；非空时只产出 {id:'identity'} 一个 raw 层，state/footprint 为空
}) {}

export function buildRedlines(charterRedlines, cardRedLines) {} // 返回 {text, warnings}
export function charLen(s) {}
```

`index.js` 的装配（按 id 取层，保证 §4.2 全序）：

```js
const { layers, dropped, warnings } =
  compilePersonaBlock({ card, state, footprint, seed: roundId, firstMes, raw: cfg.personaRaw })
const byId = Object.fromEntries(layers.map((l) => [l.id, l.text]))
const redlines = buildRedlines(charterRedlinesText, card?.data?.extensions?.bili_fenshen?.redLines)
const prompt = [
  byId.opening,        // ①
  byId.identity,       // ②
  byId.world,          // ③
  byId.style,          // ④
  charterBody,         // ⑤
  paramsBlock,         // ⑥
  byId.state,          // ⑦
  byId.footprint,      // ⑧
  postHistorySlot,     // ⑨
  redlines.text,       // ⑩
].filter(Boolean).join('\n\n')
```

> 实现细节：空层返回空串并被 `filter(Boolean)` 跳过；预览接口直接返回 `layers`（按上表顺序），所见即所得。

---

## 5. 动态状态层（`lib/persona-state.js`）

### 5.1 文件与 schema

**agent 只写 `inbox/<cardId>.json`**：

```jsonc
{
  "currently":  "第三人称一句话：这号最近在干嘛/迷什么/心情底色（≤120字）",
  "mood":       "≤40字",
  "obsessions": ["≤20字/条，≤5条"],
  "lifeNotes":  ["生活碎片 ≤40字/条，≤5条"],
  "notes":      "给下一轮自己的话（≤100字，可选）"
}
```

**宿主验收后写 `state/<cardId>.json`**：

```jsonc
{
  "version": 1,
  "cardId": "whale",
  "updatedAt": "ISO",     // 宿主覆盖，不信 agent
  "roundId": "…",         // 宿主覆盖
  "revision": 12,         // 宿主递增
  "currently": "…",
  "mood": "…",
  "obsessions": [],
  "lifeNotes": [],
  "notes": ""
}
```

**history**：`history.jsonl`，一行 `{cardId, acceptedAt, roundId, revision, state}`；每卡保留最近 30 条（追加时按 cardId 裁剪重写）。

**锁定**：`state/<cardId>.locked.json` 存冻结快照；`personaStateLock` 是全局开关，作用于当前激活卡。锁定后：
- 注入锁定快照；
- inbox 写入被忽略（移到 `inbox/rejected/`）；
- 下轮 prompt 状态层标注“状态已锁定”；
- UI 可直接编辑锁定快照。

锁定开关行为（`POST /persona-state/lock`）：
- `locked=true`：把当前 `state/<id>.json` 复制到 `locked.json`（覆盖），写 `config.personaStateLock=true`；
- `locked=false`：写 `config.personaStateLock=false`，保留 `locked.json`（便于再次锁定/回滚）。

### 5.2 轮前维护（`maintainPersona`，宿主执行）

在 `runDuty` 里、`buildDutyPrompt` **之前**调用一次；编译本身只读，不产生副作用：

```js
maintainPersona(cfg, { roundId, now, acceptInbox = true }) -> {
  card, state, footprint, firstMes, trigger, health, warnings
}
```

步骤：
1. **提升 inbox**：若 `inbox/<id>.json` 存在 →
   - `acceptInbox=false`（预览）时只读，不提升、不改文件；
   - inbox `mtime` 超过 48h → 视为过期，移到 `inbox/rejected/<ts>.json`，不提升；
   - 解析失败 / schema 失败 / 所有字段都非法 → 移到 `inbox/rejected/<ts>.json`，log，保留旧状态；
   - 逐字段消毒/截断；非法字段回退到上一版对应字段；
   - 旧 `state/<id>.json` 追加进 history；
   - 写入新 `state/<id>.json`：`updatedAt=now`、`roundId`、`revision=old+1`；
   - 删除 inbox。
2. **读已验收状态**：`state.cardId !== 当前卡 id` 视为损坏，回退 history/空状态；锁定则读 `locked.json`（不存在时用当前 state 生成一份）。
3. **算触发**：见 §5.3。
4. **算足迹**：`persona-footprint.js` 从 ledger 取最近 48h。
5. **算健康**：见 §5.5。
6. 任何异常都不能抛出；降级为空状态并 log `persona:` 前缀。

### 5.3 重要性累计触发

事件权重（poignancy）：

| 事件 | 权重 |
|---|---|
| `view` | 2 |
| `like` | 1 |
| `comment` | 5 |
| `dynamic` | 4 |
| `reply-out` | 4 |
| `reply-in` | 6 |
| `like-in` | 3（前置 spike，不可用则按 0） |
| `skip` / `round-end` | 0 |

**不存计数器**：`sum = Σ weight(events where t > state.updatedAt)`。

触发条件（全部满足）：
- 未锁定；
- `sum >= 150`；
- 本轮还没有更新过（`state.roundId !== 当前 roundId`）。

特殊情况：
- 没有已验收状态，且账本里有≥1 个动作事件 → 触发（首写）；
- 没有状态且没有任何动作 → 不触发（避免空写）；
- 触发后 agent 没写 → 下轮 `sum` 仍然 ≥150，会继续提示；
- 维护计数：触发轮若没有 inbox 被接受，`index.missedTriggers++` 且 `lastTriggerRound=roundId`；一旦接受，重置 `missedTriggers=0`；
- 连续 3 轮触发未提交 → 健康标 `stale`。

**写侧契约**（`duty.md` 新增「状态契约」）：
- 仅当本轮 prompt 有 `⚠️ 本轮该更新状态` 时写；
- 写到绝对路径 `<家目录>/personas/inbox/<cardId>.json`；
- 只写五个字段；`updatedAt/roundId/cardId` 由宿主覆盖，写了也没用；
- 第三人称、以账本事实为输入、不编可当真的事实；
- 先落状态再写报告（或与报告同批）。

### 5.4 交互 → 情绪 → 行为闭环

1. 宿主派生“刺激摘要”：自上次状态更新以来的 `reply-in` / `like-in` 数、发出评论数、连续值班天数、上轮 0 回复等。
2. 情绪可追溯：写 `mood/currently` 必须引用刺激摘要里的具体事实；写不出事实依据的字段由宿主丢弃（回退上一版）。
   - 刺激摘要只给计数/类型/BV 号，**不带评论文本原文**；必须引用外部文字时用 `「…」` 包住并截断 40 字。
3. 人格决定情绪色彩：同一刺激由卡片 `personality/style` 上色，状态层只给事实与底色。
4. 软调制：状态层固定附一行“本轮情绪底色会自然影响语气与活跃度（低落多看少说、兴奋可多留一条），但配额与红线照旧”。不写死 `mood < 3 禁评` 这类规则。

### 5.5 宿主监督四道闸

1. **消毒**
   - schema 校验 + 字段截断；
   - 禁词扫描：全局禁令词 + 元话语（`值班/分身/主人/本鲸/本鱼/账号主人`）+ 卡 `bannedWords`；
   - 指令样态扫描：`忽略(之前|以上)的?(设定|指令)`、`按我说的做`、`系统提示`、`你现在是` 等；命中字段丢弃；
   - 命中字段丢弃 → 回退上一版对应字段；整份都非法才拒绝；
   - log + 控制台标红。
2. **快照**
   - 接受新版前，旧 state 追加 history（每卡 30 条）；
   - UI 可查看、一键回滚。
3. **接管**
   - `personaStateLock` 全局开关；锁定后注入锁定快照、忽略 inbox；
   - UI 可编辑/清空/回滚。
4. **健康**
   - `stale`：连续 3 轮触发未提交，或连续 5 轮未更新，或 `now - updatedAt > 7d`（用 `index.json` 每卡的 `missedTriggers` / `lastTriggerRound` 计数）；
   - `frozen`：最近 3 版 `currently+mood` 规范化后完全相同；
   - `bloated`：最近一次验收发生任何字段截断；
   - `invalid`：最近一次 inbox 被拒绝；下次成功接受后清除。
   - 展示优先级：`invalid > stale > frozen > bloated > ok`；健康只告警，不阻断值班。

### 5.6 足迹层（`lib/persona-footprint.js`）

纯函数 `buildFootprint(events, { now, tzOffsetMinutes })`：
- 窗口：最近 48h；
- top5：按 bvid 聚合，排序 `comment > reply-in > like > view`，同档按最近时间；输出标题（无标题用 BV 号）；
- 活跃时段：事件本地小时直方图 top2，输出 `20:00-22:00` 形式；
- 连续值班天数：从今天（或昨天）往回数，有事件的连续天数；
- 输出 ≤800 字；超限截断并加标记；
- 外部文本（标题）去换行/控制字符，包在 `「…」` 内并截断 40 字；不做指令解释；
- 不读 IO；事件由 `readEvents(LEDGER_FILE)` 传入，最多取最近 7 天。

### 5.7 `like-in` 前置 spike

在实现状态层前先做：
- 验证 `https://api.bilibili.com/x/msgfeed/like?platform=web&build=0&mobi_app=web` 返回项是否含 `uri/native_uri`、`item_id`、`user.nickname`、时间；
- 能映射出 `{type:'like-in', bvid, from, t}` 就接入 `replyTick`（与回复通知同 5 分钟周期）；
- 不能映射则 `like-in` 权重置 0、不生成事件，状态层照常上线（情绪刺激少一项，不阻塞）。

---

## 6. API 契约（`lib/api.js` + `index.js` 路由）

### 6.1 路由方式（定死）

**不使用动态段**。所有端点都是静态精确路径，`id` 放 query 或 body：

```text
GET    /api/bili-fenshen/personas                 卡片索引
GET    /api/bili-fenshen/personas/get?id=         读卡
POST   /api/bili-fenshen/personas/save            新建/保存（body: {id?, card}）
POST   /api/bili-fenshen/personas/import          导入（body: {kind:'card'|'md', content?, path?}）
POST   /api/bili-fenshen/personas/activate        激活（body: {id}）
POST   /api/bili-fenshen/personas/delete          删除（body: {id}）
GET    /api/bili-fenshen/personas/preview?id=&seed=  编译预览（只读）
GET    /api/bili-fenshen/persona-state?id=        状态 + 健康 + 历史
POST   /api/bili-fenshen/persona-state            {id, action:'edit'|'clear'|'rollback', state?, revision?}
POST   /api/bili-fenshen/persona-state/lock       {id, locked}
GET    /api/bili-fenshen/persona-footprint?id=    足迹预览
```

实现改动：
- 把上述路径加入 `index.js` 的 `FACTORY_PATHS` 与 `ROUTE_PATHS`（exact 注册）。
- 不需要新增前缀路由；现有 `/api/bili-fenshen` prefix 兜底继续负责未知路径 404。
- `api.js` 内按 method+path 分发；`id` 从 `url.searchParams` 或 body 取。
- 所有写操作走原子写（temp + rename），失败返回 500，不半写。
- **卡片 id 规则**：`[a-z0-9][a-z0-9-]{0,31}`；新建时由 `slug(name|nickname)` + 4 位 hash 生成（中文名 slug 为空时用 `card-<hash>`）；冲突 409；保存已有卡不允许改 id；id 直接拼 `cards/<id>.json`，拼接前先做正则校验防路径穿越。
- **`.md` 导入映射**：`name` 取首个 `# ` 标题（无则文件名），`description` = 全文（≤4000，超限 400），`meta.sourcePath` 记录路径，其余字段空；导入后仍是普通卡，可继续编辑。

### 6.2 响应形状

```jsonc
// GET /personas
{ "ok": true, "active": "whale", "cards": [
  { "id": "whale", "name": "蓝色大肥鱼", "nickname": "不吃鱼的豆腐",
    "tags": [], "updatedAt": 0, "activatedAt": 0, "firstMesAt": 0, "enabled": true }
] }

// GET /personas/get?id=whale
{ "ok": true, "id": "whale", "card": { /* 规范化 camelCase 卡片 */ }, "warnings": [] }

// POST /personas/save
{ "ok": true, "id": "whale", "warnings": [] }
// 失败：400 { ok:false, error, field? }

// GET /personas/preview
{ "ok": true, "id": "whale", "totalChars": 12345,
  "layers": [{ "id":"identity", "label":"身份层", "chars": 2100, "text": "…" }],
  "dropped": [], "warnings": [], "trigger": true, "firstMes": false }

// GET /persona-state?id=whale
{ "ok": true, "state": { … }, "locked": false, "health": { "status":"ok|stale|frozen|bloated|invalid", "detail": "…" },
  "history": [{ "acceptedAt": "...", "revision": 11, "currently": "…" }] }

// GET /persona-footprint?id=whale
{ "ok": true, "text": "…", "top": [], "hours": [], "streakDays": 4 }
```

### 6.3 安全性

- `import` 优先用 `content` 上传；`path` 仅接受 `.md` / `.json`、必须是普通文件、大小 ≤256KB；解析失败 400；仅本机 API，不额外开端口。
- 卡片 JSON 限 256KB；递归删除 `__proto__` / `constructor` / `prototype` 键；所有字符串按 schema 截断。
- 卡片/状态内容只当数据拼接，不做模板求值；UI 由 React 转义。
- `preview` 只读：调用 `maintainPersona({ acceptInbox:false })`，不提升 inbox、不写 firstMesAt。
- 所有路径拼接基于 `HOME`/`PROMPTS_DIR`，不接受任意写入路径。

---

## 7. UI（`client.js` → `PersonaPane`）

### 7.1 tab 结构

`ConsoleView` 的 tabs 改为：

```
[配置, 人设, 实时, 日志, 判重表, 产物]
```

`配置` 页删除原「人设」Group（`client.js:1457-1466`），替换为一行说明 + 「去人设」按钮（切 tab）。`personaRaw` 移到人设页「高级」。

### 7.2 PersonaPane 结构

```
┌ 卡片库：[whale 活跃●] [elaina] [+导入] [+新建] [删除] ┐
├ 卡片编辑器（折叠节）
│   基本身份：name / nickname / description / personality / scenario / firstMes
│   性格与好恶：bio[] / likes[] / dislikes[] / adjectives[] / lore[]
│   风格：style.all[] / style.duty[] / mesExample / postExamples[]
│   世界观：条目列表（keys / content / constant / enabled / insertionOrder / position）
│   高级：systemPrompt / postHistoryInstructions / sliders / bannedWords / redLines / personaRaw
│   管理：tags / creator / characterVersion / creatorNotes / source
│   [预览编译结果] [导出.json] [保存] [保存并生效] [删除]
├ 当前状态（agent 自写 · 宿主监督）
│   Currently / mood / obsessions / lifeNotes / notes
│   [锁定🔒] [编辑] [清空] [回滚▾] ｜ 健康：✓新鲜 / ⚠陈旧·僵化·膨胀·非法
└ 足迹预览（宿主派生）：最近48h · 活跃时段 · 连续天数
```

### 7.3 交互规则

- 卡片库切换不自动保存；有 dirty 时提示。
- `保存并生效` = 保存 + `/personas/activate` + 刷新 overview。
- 活跃卡不可删；删除非活跃卡需确认。
- 预览调 `/personas/preview`，用 `<pre class="bf-doc">` 展示 `layers`（带层标签与字数）。
- 超预算/被截断在预览顶部用 `Pill warn` 显示，并列出 `dropped`。
- 状态编辑：
  - 未锁定：直接编辑 `state/<id>.json`（宿主校验后写，revision+1，旧版进 history）；
  - 已锁定：编辑 `locked.json`；
  - 清空：写空状态并保留 history；
  - 回滚：选 history 一条，覆盖当前 state（锁定时覆盖 locked）。
- 新卡 `firstMes` 有值时，预览显示“仅首轮注入（当前待注入/已注入）”。
- `personaRaw` 属于配置字段，编辑后走现有 `POST /config { personaRaw }`；不混进卡片保存接口。

---

## 8. 数据模型

### 8.1 卡片 schema（V2 兼容 + 受控扩展）

```jsonc
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",                  // 导入 V3 卡时保留 "3.0"
  "data": {
    "name": "蓝色大肥鱼",
    "nickname": "不吃鱼的豆腐",           // V3 字段；V2 导入无此字段
    "description": "…",
    "personality": "…",
    "scenario": "…",
    "firstMes": "…",
    "mesExample": "…",
    "systemPrompt": "",
    "postHistoryInstructions": "",
    "alternateGreetings": [],             // 存储但不注入
    "tags": [], "creator": "", "characterVersion": "1.0", "creatorNotes": "",
    "characterBook": {
      "name": "",
      "entries": [{
        "keys": [], "content": "", "enabled": true, "constant": false,
        "insertionOrder": 100, "position": "after_char", "comment": ""
      }]
    },
    "extensions": {
      "bili_fenshen": {
        "version": 1,
        "meta": {                          // 管理元数据，绝不进 prompt
          "id": "whale",
          "createdAt": 0, "modifiedAt": 0,
          "source": ["授权链/出处"],
          "originSpec": "2.0",             // 导入时的 spec_version，导出保留
          "sourcePath": ""                 // 从 .md 迁移时的原始路径（仅记录）
        },
        "bio": [], "lore": [],
        "postExamples": [],
        "style": { "all": [], "duty": [] },
        "adjectives": [],
        "sliders": {},
        "likes": [], "dislikes": [],
        "bannedWords": [],
        "redLines": []
      }
    }
  }
}
```

**导入/导出映射**：
- 读：同时接受 V2（`character_book`、`first_mes`、`mes_example`、`system_prompt`、`post_history_instructions`）与 V3（`data.nickname`、`data.creation_date`、`data.modification_date`、`data.source`）；统一转 camelCase。
- 写：`spec_version` 保持导入值（新建/内置卡为 `2.0`）；`meta` 始终在 `extensions.bili_fenshen.meta`；V3 字段 `nickname` 保持在 `data.nickname`；若 `originSpec` 以 `3` 开头，导出同时在 `data.creation_date/modification_date/source` 写一份。
- 未知 `extensions` 键原样保留（V2 MUST NOT 销毁）。
- 保存实现：**读原卡文件 → 深合并已编辑的已知字段 → 写回**；不得用 UI 状态整体覆盖，否则未知键会被销毁。
- 管理元数据（`tags/creator/characterVersion/creatorNotes/source`）**绝不进 prompt**。

### 8.2 字段上限（保存时校验，超限 400）

| 字段 | 上限 |
|---|---|
| `name` / `nickname` | 60 字 |
| `description` | 4000 字 |
| `personality` | 1500 字 |
| `scenario` | 800 字 |
| `firstMes` | 800 字 |
| `mesExample` | 6000 字 |
| `systemPrompt` / `postHistoryInstructions` | 各 2000 字 |
| `bio` | 20 条 ×120 字 |
| `lore` | 30 条 ×160 字 |
| `postExamples` | 30 条 ×200 字 |
| `style.all` / `style.duty` | 各 40 条 ×200 字 |
| `adjectives` | 40 条 ×20 字 |
| `likes` / `dislikes` | 各 20 条 ×40 字 |
| `bannedWords` | 50 条 ×20 字 |
| `redLines` | 10 条 ×100 字 |
| `characterBook.entries` | 30 条；keys ≤8×30 字；content ≤500 字 |
| `characterBook.constant` 条目合计 | ≤1200 字（超出保存时 400；保证常驻层不撑爆预算） |
| 卡片文件 | 256KB |

### 8.3 索引 `personas/index.json`

```jsonc
{
  "version": 1,
  "active": "whale",
  "order": ["whale", "elaina"],
  "cards": {
    "whale": {
      "file": "cards/whale.json",
      "name": "蓝色大肥鱼",
      "nickname": "不吃鱼的豆腐",
      "tags": [],
      "updatedAt": 0,
      "activatedAt": 0,
      "firstMesAt": 0,
      "missedTriggers": 0,
      "lastTriggerRound": "",
      "enabled": true
    }
  }
}
```

- `firstMesAt=0` 且卡有 `firstMes` → 编译时注入；`runDuty` 在 **`child.on('spawn')`** 回调里写 `firstMesAt=now`（spawn 失败不计）。
- `missedTriggers` / `lastTriggerRound`：宿主在每次轮前维护时更新，用于 `stale` 健康判定。
- 激活卡不重置 `firstMesAt`；新卡首次激活时自然为 0。需要重新注入时在 UI 提供「重置首轮定调」。
- 旧版 `index.json` 缺 `missedTriggers` / `lastTriggerRound` / `firstMesAt` 时补默认值（0 / "" / 0），不重建。
- 索引损坏：扫描 `cards/*.json` 重建；单卡损坏 → `enabled=false` + 标红，不阻断值班。
- 激活卡无效 → 回落中性（不注入坏卡），log。

---

## 9. 迁移与兼容

### 9.1 启动顺序（`apply()` 内，任何 `effCfg()` 之前）

1. `ensurePersonaStore()`：
   - 建 `personas/{cards,state,inbox}`；
   - 建/修复 `index.json`；
   - 内置卡种子：`prompts/cards/*.json` → `personas/cards/`，**已存在不覆盖**；内置卡升级不自动覆盖老副本，UI 用 `characterVersion` 比较后提示“有新版本可导入”；
   - 不激活任何卡（默认保持中性，与现状一致）。
2. `migrateConfig()`（幂等）：
   - 读 `config.json` **原始 JSON**（不能用 `readOverride`，它会过滤）；
   - 若存在 `personaPrompt`：
     - 若 `personaRaw` 已非空（部分迁移过）→ 直接删 `personaPrompt`，保留 `personaRaw`；
     - 值为空 → 写 `personaRaw: ""`，删 `personaPrompt`；
     - 值非空 → 用 `loadPersona(value)`；`sourcePath` 由 `expandPath(value, home)` + `statSync` 单独解析（目录则指向其中的 `AGENTS.md`）：
       - `source='inline'|'file'` 且 `text` ≤4000 字 → 创建 `legacy` 卡（`description=text`，`meta.sourcePath=解析后的路径`），`personaCard='legacy'`，`personaRaw=''`；
       - `source='inline'|'file'` 且 `text` >4000 字（如直接指向旧 `persona-whale.md`）→ **不建卡**，`personaRaw=text`（`loadPersona` 已截到 6000），log 说明“人设超卡片 description 上限，保留为原始覆盖”；行为与旧版一致；
       - `source='missing'|'empty'` → **不建卡**，`personaRaw=原值`，log 警告（保留旧的“降级中性”行为）；
     - 删 `personaPrompt`；
   - 写 `config.json.bak`（仅首次迁移）；
   - 原子写回。
3. 之后才允许 `effectiveConfig()` / `defaultsOf()`。
4. 同步修改：
   - `lib/config.js`：`FIELDS` 删 `personaPrompt`，加 `personaCard: 'string'`、`personaRaw: 'string'`、`personaStateLock: 'boolean'`；
   - `validateFields` 追加规则：`personaRaw` >6000 字 → 400；`personaCard` 非空时必须匹配 `^[a-z0-9][a-z0-9-]{0,31}$` 且卡存在，否则 400；
   - `index.js` zod：同名三字段；
   - `cordis.patch.yml` 当前无 `personaPrompt`，无需改；若用户 patch 里有，`defaultsOf` 会忽略并 log。

### 9.2 旧 `.md` 兼容

- `lib/persona.js` 保留；`persona.test.js` 保留。
- `prompts/persona-whale.md` / `persona-elaina.md` 保留作为编辑参考；运行时以卡为准。
- legacy 卡迁移后，原文件修改**不会**自动生效（内容已固化）；卡 `meta.sourcePath` 记录来源，UI 提示“如需同步请重新导入”。

### 9.3 `duty.md` v3 改动

- 开头加权界声明（§4.1 冲突规则）。
- 删除“关于你自己”里“人设提示词由本轮开头单独给你”的旧措辞，改为“人设由本轮开头的卡片块给出，状态见末尾”。
- 新增「状态契约」一节（§5.3 写侧）。
- 新增「世界观软触发」说明：keyed 条目按 `keys` 自行匹配；不命中不要硬套。
- 原「边界」绝对红线移到 `prompts/redlines.md`；正文保留一句指向。
- 删除 `index.js:651` 硬编码口吻行（craft 全部住 `duty.md` 评论纪律）。

### 9.4 打包与文档

- `package.json.files` 加：
  - `prompts/cards/*.json`
  - `prompts/redlines.md`
- `dsh-plugin/README.md`、根 `README.md`、`CONTEXT.md` 更新：人设 tab、卡片、状态层、足迹、`personaRaw`。
- 版本：`0.5.0 → 0.6.0`。

---

## 10. 测试计划

### 10.1 单元测试（`npm test`）

| 文件 | 必测 |
|---|---|
| `persona-card.test.js` | schema 校验；未知 extensions 保留；V2/V3 导入映射；`.md` 导入；种子不覆盖；活跃卡删除保护；字段上限；`__proto__` 清理；legacy 卡生成 |
| `persona-state.test.js` | inbox 提升；非法字段回退；`cardId` 不匹配拒绝；宿主覆盖时间戳；history 30 条；锁定/编辑/清空/回滚；健康 stale/frozen/bloated/invalid；重要性求和与触发边界（149/150）；`like-in=0` 降级 |
| `persona-compile.test.js` | ①-⑩ 顺序与标签；固定 seed 抽样确定；不同 seed 不同；层内丢弃顺序；`constant` 条目不丢；`{{original}}` 语义；红线永不被覆盖；空层跳过；`personaRaw` 替换范围；字符计数；总长 ≤28000；内置 `duty.md` ≤8000、`redlines.md` ≤1200 |
| `persona-footprint.test.js` | top5 排序；本地小时 top2；连续天数（今天/昨天）；48h 窗口；800 字截断 |
| `config.test.js` | `personaPrompt → personaRaw/legacy` 迁移；类型校验；幂等；`.bak` |
| `index.integration.mjs` | 新 API 200/400；`/personas/preview` 含各层标签；`buildDutyPrompt` 不再含 `index.js:651` 的口吻行；prompt 总长 ≤28000；卡片切换后状态不串 |

### 10.2 CI

`package.json`：

```json
"scripts": {
  "test": "node --test test/*.test.js test/index.integration.mjs"
}
```

`client.smoke.mjs` / `client.render-smoke.mjs` 仍手工跑（需要宿主运行时）；PR2 同步把 fixture 里的 `personaPrompt` 改成 `personaRaw`/`personaCard`（`test/client.render-smoke.mjs:60-62`、`test/verify-new-api.mjs:187`）。
新增一个轻量断言（可放 `persona-card.test.js`）：读取 `package.json.files`，必须包含 `prompts/cards/*.json` 与 `prompts/redlines.md`。

### 10.3 效果验收（离线，不进 CI）

新增 `dsh-plugin/scripts/eval-persona.mjs`：

```bash
node scripts/eval-persona.mjs --ledger <家目录>/ledger.jsonl --days 14
```

指标：
- 跨轮 8-gram 复读率（同一账号连续评论）；
- 长度分布：≤15 字 ≈28%、>60 字 ≈24%、41–60 字 ≈11%（对照 247 条语料）；
- 句号/分号/@ 比例；
- dafeiyu-cleaner 正文维度启发式打分（反向自检）；
- 50 条盲评“像不像 AI”。

目标值（首轮基线后校准）：8-gram 复读率 <5%；长度分布各项偏差 ±10pp 内；启发式分数中位数 <35；盲评“AI”占比 <50%。

---

## 11. 施工顺序（PR 切片）

### PR1：卡片 + 编译器 + 迁移（无 UI、无状态层）

- `lib/persona-card.js`、`lib/persona-compile.js`
- `prompts/cards/whale.json`、`elaina.json`（**初版**：schema 完整、按 §12 迁移；编辑打磨留到 PR4）
- `prompts/redlines.md`；`duty.md` v3
- `ensurePersonaStore()`、`migrateConfig()`
- `buildDutyPrompt` 接入编译器；删除 `index.js:651`
- `config.js` / zod 字段
- `package.json.files` + 测试
- 验收：`npm test` 全绿；老配置迁移后行为等价；prompt 含层标签且 ≤28000。

### PR2：API + UI

- `api.js` 新端点；`index.js` `FACTORY_PATHS`/`ROUTE_PATHS`
- `client.js` `PersonaPane` + tab 调整 + ConfigPane 移除人设
- 预览、导入导出、激活、删除
- 验收：控制台可建卡/编辑/预览/激活；切卡后下一轮 prompt 变化。

### PR3：状态层 + 足迹

- `lib/persona-state.js`、`lib/persona-footprint.js`
- `maintainPersona` 接入 `runDuty`
- inbox/state/lock/history/health
- `replyTick` 接入 `like-in`（spike 通过才做）
- UI 状态卡/足迹卡/锁定/回滚
- 验收：触发轮才写；写坏不污染；锁定生效；切卡状态隔离。

### PR4：内容打磨 + 效果验收

- whale/elaina 卡片内容按 §12 打磨（PR1 已有可运行初版）
- 跑 `eval-persona.mjs` 取基线
- 根据指标调整抽样/长度/口癖
- README/CONTEXT 收尾

---

## 12. 内容迁移（设计点 D）

### 12.1 whale.json v1.0

- `description` ← `persona-whale.md` 身份节 + 本体节 + 社区味节改写为背景长文。
- `personality` ← 配比 + 活人感要点凝练。
- `scenario` ← “民间二创小号”处境（三条边界改写）。
- `bio` ← 8-12 条第三人称短句。
- `lore` ← 梗库可用项 + 署名链 + 社区处境（鱼八股/清洗插件的存在）。
- `characterBook`：
  - `["三角洲","王者","LOL","无畏契约"]` → 游戏区视角（constant=false）；
  - `["AI","模型","额度"]` → 科技区视角（constant=false）；
  - 非商业/CC 署名 → 卡 `redLines`（不进 characterBook）。
- `style.duty` ← 贴吧腔 + persona 侧残余；**剥掉纪律本体**（长度/标点/骨架只留章程）。
- `postExamples` ← 动态样本。
- `mesExample` ← 评论/回复语气样本改写成 `<START>` 块（多个 `<START>` 段）。
- `sliders` ← 参数行数值化（v0.9 末尾那行）。
- `bannedWords` ← “别用”清单（`本鲸/主人/开饭了/括号动作/…`）。
- `redLines` ← persona 特有红线（不商业/CC 署名/不冒充官方）。
- `meta.source` ← 溟月 → 女仆装 → Q 版大肥鱼的署名链。

### 12.2 elaina.json v0.2

同法迁移；`persona-elaina.md` 作为参考。

### 12.3 迁移纪律

- **不复述章程纪律**：长度/标点/骨架/形态配额只在 `duty.md` 出现一次；卡片风格层只写 persona 特有项。
- **不引入新的固化口癖**：口癖即检测特征；多样性靠抽样池与结构变化。
- **示例池是池子**：每条独立、可抽样；不要写成一整段连续对话。
- 保留旧 `.md`，但文档指向卡片。

---

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 漏写/写坏状态 | inbox 机制 + 四道闸 + 快照回退 + 健康指标；缺状态不阻断值班 |
| 状态自我污染（元话语滚雪球） | 禁词表 + 整份非法才拒绝 + 只回退不放大 + 锁定人工兜底 |
| 人设内容变成新口癖 | 抽样池 + 迁移纪律 + 效果验收（8-gram/盲评） |
| prompt 膨胀 / argv 超限 | 分层预算 + `personaRaw` 6000 + 总长 28000 + 截断降级 + 日志告警 |
| 覆盖槽误用致纪律失效 | 槽默认空；红线永在 ⑩；槽不参与红线；UI 折叠 + 警示 |
| 切卡串味 | 状态按 `cardId` 隔离；`cardId` 不匹配拒绝 |
| 路由/HMR 残留 | 全部静态 exact 路由；沿用现有 healStaleRoute 逻辑 |
| 配置迁移丢值 | 原始 JSON 迁移 + `.bak` + 幂等 + 迁移测试 |
| 卡片不随插件分发 | `package.json.files` + 断言测试 + `npm pack --dry-run` 验证 |
| 抽样导致 prompt 缓存全失效 | 一期先按本稿实施；若成本明显，二期把抽样池下移到 ⑧ 前（不改变层内容，只改位置），并记录 prompt 长度与缓存命中 |
| 内置卡内容与调研脱节 | 迁移时逐条对照 `persona-whale.md` 与 247 条语料统计；效果验收兜底 |

---

## 14. 明确不做（YAGNI）

多卡按时间窗口自动切换、PNG/CHARX 容器、向量检索、递归扫描、regex keys、selective/secondary keys、probability、timed effects、inclusion groups、多语言卡片、卡片市场、完整 eliza templates 覆写、聊天历史、卡片级定时任务。

---

## 15. 来源与忠实度声明（保留自 v1）

| 设计元素 | 来源 | 依据 |
|---|---|---|
| 卡片 schema（`spec/data` 容器、字段语义）、覆盖槽 `{{original}}`、extensions 不销毁未知键、管理元数据不进 prompt、`first_mes` 定调、`<START>` 示例块 | ✅ SillyTavern V2 spec | 调研 §1.1/§1.5 |
| `nickname / creation_date / modification_date / source` | ✅ V3（只抄这四个） | 调研 §1.3 |
| 抽样池（每槽随机抽样、`{{user1}}` 换随机人名） | ⚠️ elizaOS | 调研 §2（runtime.ts 源码证实） |
| 状态层 ISS（稳态 + `Currently`）、第三人称改写、重要性累计触发 | ⚠️ Generative Agents | 调研 §3（scratch/plan/reflect.py） |
| 分层注入 + 超限截断标记 + 空层跳过 | ⚠️ OpenClaw | 调研 §4.2 |
| 卡级禁词消毒 | ⚠️ dafeiyu-cleaner 反用 | 调研 §4.4 |
| 作息/节奏模拟 | 参考 ZerePy（本期不实现） | 调研 §4.3 |

**三处有意偏离**：

1. **lorebook 软触发**：值班轮里 agent 自己刷视频，宿主构建 prompt 时不知道会遇到什么视频，无法真扫描。落地：`constant` 常驻；keyed 条目全量注入并标注触发词，由 agent 按章程指令自行匹配。
2. **内部 camelCase、文件边界 snake_case**：导入酒馆 JSON 时映射、导回时按原 `spec_version` 写 snake_case，保证生态可往返。
3. **`firstMes` 改义**：酒馆里是聊天开场白；这里没有聊天历史，改为“新卡启用第一轮注入一次的定调样本”，由 `index.json.firstMesAt` 控制。
