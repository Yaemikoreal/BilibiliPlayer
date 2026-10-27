# 人设自演化管道（growth pipeline）——agent 自攒新梗 / 自长见闻（设计文档）

> 日期：2026-10-27 ｜ 状态：四项关键决策已经用户拍板，设计随本轮落地 ｜ 前置：[persona-module-v2-design](2026-10-26-persona-module-v2-design.md)（§附录增量决策）、[业界实践调研](../../research/2026-10-26-persona-card-practices.md)

## 0. 目标与空白

v0.6.0 人设系统落成后，大肥鱼有"反应式状态"（宿主每轮从账本派生 mood/欠账/沉默），但**人格容器是静态的**：语料库、见闻库不会自己生长——新梗靠人工录、新见闻靠人工写。本设计补上最后一环：**agent 在值班轮里自己提交沉淀候选，宿主质检入库，人工修剪**。让"输入在流动"变成"人格在生长"，同时守住监督面（先发后报 + 自动质检 + 限量转正 + 人工随时修剪）。

**已拍板的四项决策**：

| 决策点 | 结论 |
|---|---|
| 素材来源 | **只攒自产 + 公共梗**：语料库收"自己说过且被验证的话"（origin=self，须对上账本）与"公共梗/流行句式"（origin=community，≤30 字）；见闻长"本号的生活碎片"。**他人评论原句绝不入库**（抄热评=水军特征） |
| 把关强度 | **自动质检 + 每天限量自动转正（3 条）+ 人工随时修剪**：过审进 candidate，不阻塞、不积压、人不点也能长 |
| 交稿通道 | **薄 MCP 工具 + pending 管道**：工具只做结构预检 + 追加 pending；质检/入库全部宿主 JS 单一实现 |
| 节奏容量 | **更快节奏**：每轮每库 ≤5 条、pending 存 14 天、桶 active 上限 200、自动转正 3 条/天 |

## 1. 机制总览与数据流

```
值班轮 agent
   │ 当场提交（bili_persona_note 薄工具，回执即得）
   ▼
<家目录>/persona/growth-pending.jsonl   （append-only，候选存 14 天）
   │ 每轮值班启动时，宿主先消化再 spawn
   ▼
lib/persona/growth.js  processGrowth()
   ├─ 质检链（§2）── 拒 → growth-processed.jsonl 记录原因（留 30 天）
   ├─ 过审 → 语料库（status:'candidate'）/ 见闻库（索引+正文，走整卡快照）
   ├─ 转正 → 每天最多 3 条最老的满分 candidate 转 active（FIFO）
   ├─ 淘汰 → 桶 active 200 满：最旧低热降回 candidate；candidate 200 满：删最旧
   └─ 过期 → pending 超 14 天丢弃并记录
   ▼
人工修剪（现成 UI）：语料库 / 见闻库页签的 [启用/停用][改][删]
```

**职责单一**：Python 工具（mcp_server.py）只做结构预检 + 追加 pending（约 40 行）；质检、查重、入库、转正、淘汰全部在宿主 JS——单一实现，无 Python/JS 双语漂移。**agent 不直接碰库文件**。处理时机在轮启动前（宿主先消化、再 spawn 子进程），pending 为 append-only 单写者，处理即清空（结果落 processed 日志），无并发锁需求。

**启动时机**：`runDuty()` 内、`buildOverlay` 之前调用 `processGrowth()`；插件 `apply()` 启动时也跑一次（防止停用自动值班后候选积压）。处理失败绝不阻断值班（try/catch + log）。

## 2. 质检链（每条候选五道闸）

### corpus（语料候选）

1. **结构**：`form` ∈ 六桶（reaction/question/experience/meme/detail/rant）、`text` 非空 ≤100 字
2. **来源对账**（防伪核心）：
   - `origin:'self'` → 文本必须与账本已发的 `comment / dynamic / reply-out` 事件文本做 2-gram Jaccard ≥0.8 匹配——**防 agent 编造"我说过"**；命中即取该事件的互动数据（likes/reply 计数）写进 source
   - `origin:'community'`（公共梗）→ text ≤30 字、source 必填（如"社区通用梗"）
3. **查重**：与库内 active/candidate 任意条 2-gram Jaccard >0.6 → 拒（防自我复读滚雪球）；与 pending 内已有条重复 → 跳过
4. **禁词**：元话语（小号/分身/值班/运营/账号主人/本鲸/主人…）+ 卡 `voice.avoid.bannedWords` + 政治词表（no-politics 红线延伸）→ 拒
5. **容量**：目标桶满则走淘汰（§3），永不超限

### lore（见闻候选）

1. **结构**：`id` 白名单 `[\w-]{1,64}`（缺省宿主按 `lore-<日期戳>` 生成）、`keys` ≥1、`oneLine` ≤40 字、正文 ≤600 字
2. **id 冲突**：与现有 loreIndex 撞 → 拒（回执带原因，agent 可换 id 重交）
3. **查重**：oneLine 与现有条目 2-gram >0.6 → 拒
4. **禁词 + 真实性红线**：元话语/政治词表 + **no-fabricate 延伸词表**——正文不得含"我认识/我买了/我朋友在/新闻说/据可靠消息/我住在/我的职业/我公司"等**可被当真的事实断言**；角色生活碎片（吃饭/掉段/熬夜/烧 token/看片糗事）放行（与卡 identity.boundaries "生活细节编着玩" 一致）
5. **容量**：loreIndex ≤12 条（渲染预算 ≤8，留余量）；满则拒新，回执说明

## 3. 节奏与容量（决策 B）

| 项 | 值 | 说明 |
|---|---|---|
| 每轮提交上限 | 每库 5 条 | 工具侧计数拒绝超额，回执说明 |
| pending 保存期 | 14 天 | 处理时按 `pendingAt` 过期丢弃，记 processed |
| 桶 active 上限 | 200 | 满：最旧低热（heat 升序、同热按 addedAt 旧优先）**降回 candidate**；candidate 也 200：删最旧 |
| loreIndex 上限 | 12 | 满：拒新 |
| 自动转正 | 3 条/天 | 本地日计数存 `persona/state.json`（`growthPromoted: {date, count}`，跨天重置）；**FIFO**（addedAt 最老的满分 candidate 先转正）——v1 无逐条互动数据，FIFO 诚实简单；将来 like-in 数据接入后可升级为"互动验证优先" |
| 处理日志 | 30 天 | `growth-processed.jsonl`：{t, kind, action: accepted/rejected/expired/promoted/demoted, reason?, text/oneLine 摘要} |

**配置开关**（进 lib/config.js FIELDS + index.js zod）：
- `growthEnable: boolean`（默认 true）——false 时不消化 pending、工具不进值班轮白名单（overlay 构建时过滤）
- `growthAutoPromote: number`（默认 3，0 = 只收候选不自动转正）

## 4. 工具与章程契约

### `bili_persona_note`（mcp_server.py，薄）

参数（一次一条，结构预检就地报错给 agent）：

```
{ kind: 'corpus', form, text, origin: 'self'|'community', source? }
{ kind: 'lore', id?, keys: string[], oneLine, body }
```

行为：字段级预检（缺字段/超长就地拒绝并说明）→ append 一行 JSON 到 `growth-pending.jsonl`（带 `pendingAt`）→ 回执 `{ok, note:'已提交候选，待宿主质检入库'}`。**不做质检不做入库**。加入 `dutyTools` 默认白名单；`growthEnable=false` 时 overlay 构建自动剔除。

### 章程 duty.md 增「沉淀契约」节（与报告/记账/判重/状态并列）

- **什么时候交**：自己说了句连自己都想再用的 → corpus(origin=self)；社区都在用的公共梗想常备 → corpus(origin=community，写明性质)；今天出了个值得记的生活碎片 → lore
- **什么不交**：别人的评论原句（绝对禁止）；政治相关（红线）；编造的可当真事实（红线）
- **纪律**：每轮每库 ≤5 条；沉淀是**可选动作**——工具失败不重试、没素材就不交（省钱纪律，同"配额是上限不是任务"）

### UI（最小）

不加新页签。语料库/见闻库页签现成的 [启用/停用][改][删] 就是审核台（candidate 天然可见）；处理结果进 duty.log + 实时流。看板/状态卡不为此加元素。

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `mcp_server.py` | 新增 `bili_persona_note` 薄工具（结构预检 + append pending） |
| `lib/persona/growth.js` | **新模块**：processGrowth（质检链/入库/转正/淘汰/过期/日志）+ 纯函数拆分 |
| `lib/persona/expression.js` | `normalizeBank` 透传 `addedAt` 字段（FIFO 与淘汰排序需要；additive） |
| `lib/persona/index.js` | 门面导出 growth 函数 |
| `index.js` | runDuty 与 apply() 接 processGrowth；zod 配置两项；dutyTools 默认加工具 + growthEnable 过滤 |
| `lib/config.js` | FIELDS 两项 |
| `client.js` | 配置页「自生长」组（两个开关行） |
| `prompts/duty.md` | 「沉淀契约」节 |
| `test/persona.growth.test.js` | **新测试**（§6） |

## 6. 测试与验收（persona.growth.test.js，临时家目录）

1. 质检链逐闸拒绝用例：self 对账失败 / community 超 30 字或无 source / 查重命中 / 禁词 / 政治词表 / lore id 冲突 / 真实性词表 / loreIndex 满
2. 过审入库：bank candidate 落盘 + lore 索引进卡（版本快照）+ 正文文件落盘
3. 转正限额：4 条满分 candidate 只转 3（FIFO 顺序正确）；跨天重置；growthAutoPromote=0 不转
4. pending 过期、处理完清空、processed 日志含拒绝原因
5. 容量淘汰：active 满 200 降最旧低热；candidate 满 200 删最旧（用 opts 覆盖小上限测）
6. mcp 工具：Python 侧 `python -c` 直调 handler 冒烟（结构错误回错、合法行 append、超额拒绝）
7. 全量 `npm test` 不回归；render smoke 全绿

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 编造"我说过" | origin=self 强制账本对账（2-gram ≥0.8） |
| 自我复读滚雪球 | 入库查重 0.6 + 生成侧 looksCopied 已有 |
| 口癖固化（沉淀变新八股） | candidate 先行 + 每日限量 3 + 人工随时删；jargon 配额机制独立运作 |
| 政治内容混入 | 章程红线 + 质检链政治词表双保险 |
| 无限生长撑爆 prompt | 桶上限 + 淘汰 + 索引 ≤12 + 编译预算不变（抽样注入） |
| pending 写坏/并发 | append-only 单写者；处理时逐行 try/catch，坏行跳过并记录 |
| 工具被滥用刷候选 | 每轮每库 5 条工具侧硬限；质检链拒绝成本在 agent 侧（回执即知） |
