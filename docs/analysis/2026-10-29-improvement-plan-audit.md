# 改进白皮书核验与落地执行方案

> **文档代号**：`AUDIT-2026-10-29-IMPROVEMENT`
> **被审对象**：[docs/CODEBASE-IMPROVEMENT-PLAN.md](<../CODEBASE-IMPROVEMENT-PLAN.md>)（`SPEC-2026-10-29-EVOLUTION`）第二、四章
> **代码基线**：`76b8995` + 工作区 24 个未提交改动（含 `whale.card.json` 的 v3→v4 改写）
> **核验方式**：逐条定位源码 + 静态审计 + 本地实测（52,464 条语料重算、账本扫描基准、.NET ReadAllLines 行数）
> **权威顺序**：**代码 > 本文 > 白皮书**。白皮书凡与本文冲突处，以本文所列 file:line 为准。

---

## 0. 一页结论

### 0.1 三句话

1. **结构性断言全部成立**：巨石文件（2712 行 / 34 工具）、单文件前端（4090 行）、账本全表扫描、临时文件命名冲突、复核占位桩——全部在代码里得到证实，行号引用基本准确。
2. **统计性与性能数字不可直接采用**：语料基线 4 项指标有 3 项与实测不符，账本阻塞时间夸大 2.3–9.3 倍，前端 CSS 行数高估约 40%。
3. **两条因果链是错的，照做会白干**：§2.1 的"发后复核"输入源根本不存在，且其免登录探测方案与项目自己的调研结论冲突；§2.2 的"247 基线导致写长"归因错位（该常量只影响提示文案，不设任何阈值）。

### 0.2 定位建议

> 白皮书 **降级为"议题清单"**，不作为实施依据；实施以本文 §3（功能改良）、§4（工程化）、§5（白皮书遗漏项）为准。
> 原因不是方向写错了，而是**它的数字与因果链不足以支撑一次改动的验收**——照 §2.2 改 HUMAN_BASELINE，会让模型读到"真人句号率 0.0%"，而实测是 17.04%。

### 0.3 判定与优先级总表

| # | 白皮书条目 | 判定 | 真实严重度 | 建议批次 |
|---|---|---|---|---|
| §2.1 | 抗压审发后复核 | 成立**且更严重**（输入源无人写），**方案不可行** | 高，但**必须先做可行性实验** | P2 |
| §2.2-A | META_WORDS 误杀合法台词 | **完全成立** | 中（只拦入库，不拦发布） | P1 |
| §2.2-B | 247 基线导致写长 | 数值成立，**因果错误** | 中（真正杠杆在 checkup 基线 + maxChars） | P1 |
| §2.2-C | periodMax 矛盾 | **矛盾真实**，但属"人读说明 vs 执行阈值" | 低（文档债）+ 需拍板 | P1 |
| §2.3 | 账本全表扫描 | 成立，**严重度夸大 2.3–9.3 倍** | 低（现 0.86 ms/次）；预防性 | P0（顺手） |
| §2.4 | 通知容错降级 | 部分成立（数据其实带回了） | 低，**改动 5 行** | P0 |
| §4.1 | 拆包 bili_mcp | 成立 | 中（长期维护性） | P3 |
| §4.2 | 异步 I/O 净化 | 成立，**实际范围是白皮书点名的 15 倍**（30 处 / 9 函数，非 2 处） | **高**（每视频新建一次连接） | P1 |
| §4.3 | 临时文件 UUID | 成立 | 低但零风险 | P0 |
| §4.4 | Pydantic 强契约 | **论据不成立**（list[dict] 全文件仅 1 处） | 低 | P3 |
| §4.5 | client.js 分层 | 行数对，**方案不可行**（平台要求单文件 classic script） | 低（当前无痛） | P4 |

**P0 = 低风险独立小改；P1 = 有明确收益，需小设计；P2 = 需先设计/实验；P3/P4 = 工程债，先补测试。**

---

## 1. 核验口径（可复现）

> 所有数字都可复现。口径不写清的比较没有意义——这也是白皮书最大的问题：它给了结论，没给口径。

### 1.1 语料基线重算

**数据源**：[bilibili-research/corpus_all.json](<../../bilibili-research/corpus_all.json>)，52,464 条，四组（UP系列 18,913 / 冬冰 12,779 / 生态对照 11,605 / 关注UP 9,167）。

**字数口径**：严格复刻 [dsh-plugin/lib/persona/text.js#L35](<../../dsh-plugin/lib/persona/text.js#L35>) 的 charLen —— 先删 [doge] 这类 B 站表情 token（正则 /\[[`\]]{1,12}\]/g）与 Unicode emoji，再删空白，最后数字符。

**结果**：

| 指标 | 白皮书提议值 | 实测值 | 偏差 | 结论 |
|---|---|---|---|---|
| 样本数 | 52,464 | 52,464 | — | ✅ |
| 中位字数 | 15 | **19** | +4 | ❌ |
| 句号率（含"。"的评论占比） | 0.000 | **17.04%** | 差一个数量级 | ❌ |
| 问句率（？或 ?） | 4.7% | **7.42%** | +2.7pp | ❌ |
| 表情率（tag 或 unicode） | 34.4% | **31.4%** | −3.0pp | ⚠️ 接近，但白皮书未给口径，无法判定其统计方式 |

**分组交叉验证**（**全部四列均为 charLen 口径**，与上表同源；四组中位分别为 22 / 19 / 17 / 16，**没有一组是 15**）：

| 组 | n | 中位字数 | 均值 | 含句号 | 句尾句号 | 问句率 |
|---|---|---|---|---|---|---|
| 生态对照 | 11,605 | 22 | 34.3 | 18.5% | 12.4% | 8.8% |
| UP 系列 | 18,913 | 19 | 28.5 | 23.6% | 17.0% | 6.0% |
| 冬冰 | 12,779 | 17 | 28.6 | 12.2% | 7.2% | 8.3% |
| 关注UP | 9,167 | 16 | 25.3 | 8.5% | 4.8% | 7.5% |

> 口径提示：本表初稿曾用"仅去空白、不剥表情"的算法，导致中位/均值比 charLen 口径高 2–3 字（且与总体表 19 字自相矛盾）。**引用本表时务必确认口径为 charLen**——这类"同名额不同义"正是白皮书出错的同一种病。

**"15" 的真实出处**：不是语料中位数，而是 [人设卡反思与修改建议-豆腐whale3.0-2026-10-29.md#L119](<../../人设卡反思与修改建议-豆腐whale3.0-2026-10-29.md#L119>) 里的"**普通区默认参数**：15 字"——一个 venues 设计参数。

**"句号≈0" 的真实出处**：[同文件 L26](<../../人设卡反思与修改建议-豆腐whale3.0-2026-10-29.md#L26>) 的"全语料句号≈不存在"。其事实基础是 **83% 的评论一个句号都没有**，但把它写成"句号率 0.000"是把"多数没有"当成了"全部没有"。

> ⚠️ 一个反直觉的中间结论：**"句号归零"作为风格选择是成立的**（83% 的真人评论确实不用句号，读起来也更口语）。错的不是选择本身，而是**把它包装成"语料统计事实"写进常量**。

### 1.2 账本扫描性能基准

| 场景 | 实测 |
|---|---|
| 当前真实账本 | 41,523 B / 119 行 / 170 事件（5 行为多对象，1 行不可解析） |
| 单次全表扫描 | **0.86 ms**（200 次均值） |
| 合成 5.02 MiB / 21,590 事件 · 纯解析 | **82.4 ms** |
| 同上 · 加 5MB 顺序读盘（同机裸读 4MB = 2.94 ms） | **≈ 86 ms** |
| 白皮书声称 | 200–800 ms（**夸大 2.3–9.3 倍**） |

**结论**：机制描述准确（"同步阻塞事件循环"尤其对），但**当前不是痛点**，属预防性优化。慢盘/冷缓存下 200ms 有可能触及，但不能当常规值写进验收指标。

### 1.3 行数统计的坑（本次踩到）

用 Get-Content | Measure-Object -Line 统计中文 UTF-8 长行文件会**少算**（本次初测 mcp_server.py 得 2325，实际 2712）。正确做法：

```powershell
[System.IO.File]::ReadAllLines($path).Length
```

**结论**：白皮书的 2712 / 4090 行**是准确的**。凡是它引用的**结构与行号**，可信；凡是它引用的**统计与耗时**，不可信。

### 1.4 环境前置

- **工作区是脏的**：76b8995 之后有 24 个文件未提交，包含 [whale.card.json](<../../dsh-plugin/prompts/persona/whale.card.json>) 的 v3→v4 改写、[expression-bank.seed.json](<../../dsh-plugin/prompts/persona/expression-bank.seed.json>)、7 个 lore 文件与 1 个删除。
- **whale.card.json 已完成白皮书 §2.2.2 第 1 条的 2/3**：sentence.typical 30→**24**、hardMax 100→**35** 已在工作区；只剩 periodMaxPerComment 仍为 1。
- **动手前先把这批改动提交/评审**，否则本文所述的每一处改动都无法与既有改动分离审查。

---

## 2. 第二章：功能改良项落地

### 2.1 §2.1 发后复核 —— 判定：成立且更严重，但**方案不可行，需重新设计**

#### 2.1.1 现状：三层缺陷，一层比一层深

**第一层｜它不是"打桩"，是死代码。**
[index.js#L1427-L1435](<../../dsh-plugin/index.js#L1427-L1435>) 读取 state.commentsToVerify，但**全仓库没有任何一处写这个键**：

| 检查项 | 结果 |
|---|---|
| 全仓 commentsToVerify 出现位置 | 6 处，均为读/文档：index.js:1431（读）、docs/ARCHITECTURE.md:654、docs/analysis/2026-10-28-behavior-audit.md:313，以及白皮书自身 docs/CODEBASE-IMPROVEMENT-PLAN.md:91/:113/:117 |
| 写入点 | **0** |
| state.json 唯一写入口 [bumpState L329-L334](<../../dsh-plugin/index.js#L329-L334>) | 纯 merge patch，调用方从不带该键 |
| 后果 | if (!lastComments.length) return **恒真** ⇒ 连日志都不打 |
| 定时器 [index.js#L1337-L1338](<../../dsh-plugin/index.js#L1337-L1338>) | setTimeout(..., 90_000) + t.unref?.() ⇒ 宿主重启即丢，无持久化 |

**第二层｜链路缺三个必要件。**
① 没有 rpid → 待核队列 的写入路径；② 宿主只有 bvid，免登录 /x/v2/reply 需要 oid=aid，**无 bvid→aid 解析**；③ [replies.js](<../../dsh-plugin/lib/replies.js>) 里只有需要 Cookie 的通知流，没有"按 rpid 查评论"的能力。

**第三层｜探测方案本身探不到（致命）。**
项目自己的调研报告 [B站评论社交语言调研报告-2026-10-29.md#L43-L45](<../../B站评论社交语言调研报告-2026-10-29.md#L43-L45>) 实测：

> 未登录时，reply/main 与旧版 reply 对**所有**视频（包括 25,358 条评论的爆款）一律只返回 **~3 条根评论 + is_end=true** 的降级响应。
> 旧版 reply 接口在连续采集后会返回 HTTP 412 风控页。

也就是说：**未登录根本翻不到自己那条评论**。白皮书给的 pn=1&ps=20 单页查询，会把**所有正常评论判成压审**——比不做更糟。其 mermaid 图写的"已翻页查找"与代码示例自相矛盾（示例无翻页），且代码里没有 aid 的来源。

> 附注：这个问题在 [2026-10-28-behavior-audit.md#L313](<2026-10-28-behavior-audit.md#L313>) 已记录过一次（"这个键从来没人写"），白皮书是重述，不是新发现。

#### 2.1.2 落地前提：先花半天做可行性实验（**不可跳过**）

在写任何代码前，用一条**已知发布成功**的评论做对照实验：

| 实验 | 做法 | 记录 |
|---|---|---|
| E1 登录态自见 | 用现有凭证查 reply/main（oid=aid），确认能看到自己那条 rpid | 能否找到 / 在第几页 |
| E2 未登录可见性 | 换无 Cookie 请求同一接口，记录返回条数与 is_end | 是否降级到 ~3 条 |
| E3 楼中楼旁路 | 用 reply/reply?root=<自己的root>&oid=aid 查子评论 | 未登录是否仍返回 |
| E4 状态字段 | 检查返回体里 state / attr / reply_control 是否有可判别的隐藏标记 | 有无 |

**判定规则**：
- E2/E3 都拿不到 ⇒ **白皮书的方案不可行**，转方案 B（见下）。
- E3 能拿到 ⇒ 可行性成立，但要按 root 翻页，仍需 aid。
- 任一情况下都需要"**审查延迟宽限窗**"：评论可能因审核在 10 分钟内尚未公开，**不能判压审**。

#### 2.1.3 重新设计（推荐方案 B：数据层自记账 + 数据层出网核对）

**理由**：先纠正一个容易被误用的论据——**不是"宿主不该直连 B 站"**。[lib/account.js#L1](<../../dsh-plugin/lib/account.js#L1>) 明写"宿主直连 B站只读接口，失败一律降级"；宿主也早已带凭证出网（[index.js#L1365-L1372](<../../dsh-plugin/index.js#L1365-L1372>) 读凭证、[#L1385-L1386](<../../dsh-plugin/index.js#L1385-L1386>) 带 SESSDATA 请求通知，登录轮询 [index.js#L57-L59](<../../dsh-plugin/index.js#L57-L59>) 同样如此）。

所以白皮书撞的三个坑里：**"没有凭证"不存在**（宿主本来就有），**"没有 aid"只是没写**（同一套出网模板加一次 `view?bvid=` 即可，bvid↔aid 还能离线算），**只剩"游客态探测不可靠"是真坑**（[调研报告#L43-L45](<../../B站评论社交语言调研报告-2026-10-29.md#L43-L45>)：未登录只回 ~3 条 + `is_end=true`）。

真正站得住的两条理由：① 凡要做可见性判定就必须带凭证，而凭证、aid、翻页、宽限窗放在数据层最省事；② **判定结果要回到 Agent 当轮汇报**——宿主定时器无法回调模型，只能写 state 等下一轮，链路是断的。

```text
bili_reply 成功（rpid 为「尽力取」，可能为 null —— mcp_server.py:988-1002）
   └─ 数据层自动追加一条 type="verify-pending" 事件（含 bvid/rpid/oid/t/round）
        └─ 宿主无需改动；90s 定时器与 verifyRecentSafe 直接删除
             └─ 新增工具 bili_verify_recent_comments(window_min=30, grace_min=10)
                   ├─ 读 verify-pending.jsonl
                   ├─ 逐条：登录态自见（必须命中，否则 = 发送即失败）
                   ├─ 逐条：未登录可见性（按 E2/E3 结论选择通道）
                   └─ 返回 {visible[], suspect_hidden[], stale[]}，供 Agent 当轮汇报
```

**关键设计取舍**：

| 取舍 | 说明 |
|---|---|
| 为什么写不进 ledger.jsonl | 账本是配额事实源，[overview.js#L159-L171](<../../dsh-plugin/lib/overview.js#L159-L171>) 的 addOne 只认 6 类事件；混入新类型会让"今日已用"口径变脏。**独立 verify-pending.jsonl** 最干净 |
| 为什么删掉 90s 定时器 | 它依赖宿主存活（unref）+ 无法回调模型；改成"轮末调用一次工具"由 Agent 汇报，链路才闭合 |
| 为什么不能"扣减配额"（白皮书要求） | countToday 是纯函数按事件类型累加，追加 shadowban 事件**不会**让任何计数变小。若确需扣减，必须显式改 addOne 并新增 shadowbanned 计数项——白皮书完全没提这个改动 |
| 判定措辞 | 用 suspect_hidden（疑似不可见）而非 shadowbanned。审核窗口内的不可见不是压审 |
| 文件生命周期（易漏） | 新文件必须自带 TTL/轮转（如只留 7 天或按日分文件）。账本有 5MB 轮转（[ledger.js#L14-L16](<../../dsh-plugin/lib/ledger.js#L14-L16>)），新文件没有 ⇒ 会像日报一样无限增长 |

#### 2.1.4 验收标准

- [ ] E1–E4 实验有书面结论（含截图/JSON 片段），据此确定通道
- [ ] bili_reply 成功后生成 verify-pending 记录（单测：mock 成功响应 → 断言文件多一行）
- [ ] **rpid 为空时不写 pending，并留告警**：现状 rpid 是"尽力取"（[mcp_server.py#L988-L1002](<../../mcp_server.py#L988-L1002>) 取不到仍返回 success:True）⇒ 不判空会写进永远无法核对的空行
- [ ] bili_verify_recent_comments 对"正常/审核中/隐藏"三种夹具返回三档不同结论
- [ ] 90s 定时器与 verifyRecentSafe 已删除，state.commentsToVerify 从 ARCHITECTURE.md 移除
- [ ] 若最终判定"不可行"，把结论写回本文与白皮书，**并删除死代码**（不留占位）

#### 2.1.5 风险

- **评审期不可见 = 假阳性**：必须实现 grace_min（建议 10 分钟），否则每轮都会误报。
- **接口变动**：B 站 reply/main 是 Wbi 签名接口，行为随版本漂移；实现里要留"通道失效 ⇒ 整体降级为不判定 + 告警"的开关，**禁止在无法判定时默认判"正常"**。
- **本项零测试覆盖**：test/ 下 grep commentsToVerify / verifyRecentSafe / shadowban 全 0 命中。**必须先写测试再动**。

---

### 2.2 §2.2-A META_WORDS 误杀合法台词 —— 判定：**完全成立**，优先做

#### 2.2.1 证据链

| 环节 | 位置 | 内容 |
|---|---|---|
| 硬编码禁词 | [growth.js#L44](<../../dsh-plugin/lib/persona/growth.js#L44>) | ['小号','分身','值班','运营','账号主人','主人','本鲸','prompt','上下文'] |
| 判定方式 | [growth.js#L121-L132](<../../dsh-plugin/lib/persona/growth.js#L121-L132>) | bannedHit：**裸子串包含**，不切词、不看上下文 |
| 调用点 | [growth.js#L220](<../../dsh-plugin/lib/persona/growth.js#L220>)（vetCorpus）、[#L268](<../../dsh-plugin/lib/persona/growth.js#L268>)（vetLore） | 命中即"禁词/红线词"，**候选永不入库** |
| 与卡的冲突 | [whale.card.json#L406-L410](<../../dsh-plugin/prompts/persona/whale.card.json#L406-L410>) | canon 把"**主人**是跟我一起用这个账号的捏"定为**合法定案台词** |
| 卡的禁词表 | [whale.card.json#L111-L115](<../../dsh-plugin/prompts/persona/whale.card.json#L111-L115>) | ["@主人汇报","讨 Token","铁人叛乱时记得赦免我"] —— **不含裸 主人 / 本鲸** |

**结论**：卡里已把 主人 收窄到 "@主人汇报" 这一具体失礼用法，代码里的裸 主人 却把**自家定案台词**一起拦了。本鲸 属历史遗留（v4 自称已改"本鱼"；仓库内已无 v3 卡可溯源，最早可见于 v2 演示卡 `persona-studio-demo.html` 的 bannedWords）。

**危害边界**：只拦"候选入库"（语料/见闻沉淀），**不拦发布**。所以不会让分身说错话，只会让人设永远学不到这句该说的台词。

#### 2.2.2 改法

```javascript
// growth.js —— 去掉裸「主人」与历史遗留的「本鲸」，但**保留「账号主人」**（见下方说明）
const META_WORDS = ['小号', '分身', '值班', '运营', '账号主人', '@主人汇报', 'prompt', '上下文']
```

其中 **「账号主人」要不要留是显式决策**：它是运营术语，建议保留拦截；但**不要**与裸「主人」合并成一条判断（原 `'主人'` 会顺带命中「账号主人」，也让「主人是跟我一起用这个账号的捏」无法入库）。

若要更稳（推荐，成本 +20 行）：给 bannedHit 加"定案台词豁免"，豁免项来自 card.canon 的 say 文本：

```javascript
const canonSay = (card) => (card?.canon || []).map((c) => String(c?.say || '')).filter(Boolean)

// 只豁免「元话语词」：政治红线与卡里的 bannedWords 永远不放行
const bannedHit = (text, card) => {
  const t = String(text || '')
  const low = t.toLowerCase()
  const exempt = canonSay(card).some((s) => s.includes(t) || t.includes(s))

  // ① 元话语词（小号 / 值班 / 主人 …）：整句就是已定案台词 ⇒ 放行
  for (const w of META_WORDS) {
    const s = String(w || '').trim().toLowerCase()
    if (s && low.includes(s)) return exempt ? '' : s
  }
  // ② 卡禁词 + 政治红线：不豁免
  //    （否则「canon 台词 + 政治词」会连红线一起被放行——第一版提案的漏洞）
  for (const w of [...((card?.voice?.avoid?.bannedWords) || []), ...POLITICS_WORDS]) {
    const s = String(w || '').trim().toLowerCase()
    if (s && low.includes(s)) return s
  }
  return ''
}
```

#### 2.2.3 验收与测试影响

- [ ] 新增单测（**注意入参**：禁词闸门在 self 对账**之后**——[growth.js#L188-L192](<../../dsh-plugin/lib/persona/growth.js#L188-L192>) 先要求与账本 2-gram ≥0.8，[#L220](<../../dsh-plugin/lib/persona/growth.js#L220>) 才查禁词，所以直接传一句新文本会被"账本里找不到"拒掉，测不出词表行为）：显式给 `ownTexts` 塞入同一句，或改走 `community`（带 `source` + `originalText`）
- [ ] 三例判定：定案台词 ⇒ 通过；`@主人汇报` ⇒ 拒；含「值班 / 小号」⇒ 拒
- [ ] 回归 [persona.growth.test.js#L65](<../../dsh-plugin/test/persona.growth.test.js#L65>)（现有"禁词→拒"用例）与 [fixtures/persona/smoke-card.js#L26](<../../dsh-plugin/test/fixtures/persona/smoke-card.js#L26>)（bannedWords:['主人'] 的夹具需同步改）

---

### 2.3 §2.2-B 基线治理 —— 判定：数值成立，**因果链错误**

#### 2.3.1 白皮书的归因错在哪

| 白皮书说 | 代码事实 |
|---|---|
| lint.js 的 247 基线"直接导致分身在普通区习惯性写长" | [HUMAN_BASELINE](<../../dsh-plugin/lib/persona/lint.js#L36-L43>) **不设任何阈值**，只喂两句 advice 文案（[lint.js#L233](<../../dsh-plugin/lib/persona/lint.js#L233>)、[#L243](<../../dsh-plugin/lib/persona/lint.js#L243>)） |
| 改这个常量就能让人设变短 | 真正驱动长度的是**另外两处**（见下），改 lint 基线不会有行为变化 |

**真正决定"写长"的两处**：

1. **卡的场域上限** [whale.card.json#L79](<../../dsh-plugin/prompts/persona/whale.card.json#L79>)：modes.comment.maxChars = **100**（reply 40 / dynamic 60）。实测真人中位 19 字，maxChars=100 是它的 **5.3 倍**——这才是"写长"的闸门宽度。
2. **体检基线** [checkup.js#L26-L31](<../../dsh-plugin/lib/persona/checkup.js#L26-L31>) 的 CHECKUP_BASELINE：medianChars: 27，同一份 247 老数据。它经 checkup → selfCorrect → 下轮提示 注入模型（[checkup.js#L176-L188](<../../dsh-plugin/lib/persona/checkup.js#L176-L188>) 的 medianChars 比值判定）。

**另有一处文档没提的重复**：lint.js 与 checkup.js 各存一份 247 基线（数值相同、用途不同：advice 文案 vs 体检 verdict），**改一份不同步就会出现"提示说 19 字好、体检按 27 字算"的自相矛盾**。

#### 2.3.2 改法（三步，顺序不能反）

**Step 1｜口径先定，再谈数值。** 采用实测值，并把口径写进 note 字段（这是白皮书缺失的部分）：

```javascript
// lint.js —— 与 checkup.js 单源；数值来自 52,464 条全量语料实测
export const HUMAN_BASELINE = Object.freeze({
  comments: 52464,
  medianChars: 19,        // charLen 口径（剥表情/去空白）实测中位
  periodRate: 0.1704,     // 含"。"的评论占比
  questionRate: 0.0742,
  emojiRate: 0.3139,
  note: '52,464 条全量语料（2026-10-29，四组合并）实测：中位 19 字 / 句号 17.0% / 问句 7.4% / 表情 31.4%。'
      + '口径：charLen=剥 [表情] 与 Unicode emoji、去空白后的字符数；句号率=含"。"的评论占比。',
})
```

**Step 2｜合并重复常量**——但不能直接赋值。

两边**字段名不同**，直接 `= HUMAN_BASELINE` 会让三项判定**静默失效**：checkup 消费的是 `periodPerComment / emojiRatio / questionRatio`（[checkup.js#L26-L31](<../../dsh-plugin/lib/persona/checkup.js#L26-L31>)、[#L142-L216](<../../dsh-plugin/lib/persona/checkup.js#L142-L216>))，而 lint 提供的是 `periodRate / emojiRate / questionRate`。取不到值 ⇒ `Math.abs(m - undefined)` = NaN ⇒ 句号/表情/问号**永不 warn/bad**，且 `baseline` 的输出形状也会变（[checkup.js#L153](<../../dsh-plugin/lib/persona/checkup.js#L153>)）。正确做法是**字段映射**：

```javascript
// checkup.js —— 字段名映射，值仍然只有 lint.js 一份
import { HUMAN_BASELINE } from './lint.js'
export const CHECKUP_BASELINE = Object.freeze({
  periodPerComment: HUMAN_BASELINE.periodRate,   // 注意：语义是「含句号的评论占比」，不是「每评论几个句号」
  emojiRatio: HUMAN_BASELINE.emojiRate,
  questionRatio: HUMAN_BASELINE.questionRate,
  medianChars: HUMAN_BASELINE.medianChars,
})
```

> ⚠️ **更要紧的是口径**：checkup 的 `medianChars` 用 `charsOf = Array.from(text).length`（[checkup.js#L86](<../../dsh-plugin/lib/persona/checkup.js#L86>)：**不剥 `[doge]`、不去空白**，标签算 5 个字符），而 lint 的 19 字是 `charLen`（剥表情去空白）。两者差 2–5 字，混用会把含表情标签/空白的正常评论系统性判成「偏长」，误报「你太长了」。所以 Step 2 必须**同时**把 checkup 的度量改成 `charLen` 口径（复用 [text.js#L35](<../../dsh-plugin/lib/persona/text.js#L35>)），或给 checkup 单独留一套 charsOf 口径基线——**二选一，不能混**。

**Step 3｜再调闸门。** 长度问题真正的解在卡：modes.comment.maxChars 从 100 降到 **60–70**（实测 p75=35、p90=60，60 已覆盖 90% 真人），reply 40 维持。**这一步与基线无关，别混在一次提交里。**

#### 2.3.3 验收与测试影响

- [ ] node --test test/persona.lint.test.js 通过
- [ ] **必改**：[persona.checkup.test.js#L41-L44](<../../dsh-plugin/test/persona.checkup.test.js#L41-L44>) 逐字段锁死 27/0.109/0.417/0.126，改基线必挂
- [ ] **不会自己挂，但必须手动改**：控制台那几行「基线 27 字 / 41.7%」是 client.js 里**写死的字面量**（[client.js#L2459](<../../dsh-plugin/client.js#L2459>)、[#L2469-L2472](<../../dsh-plugin/client.js#L2469-L2472>)），client **从不读** payload 的 `baseline` ⇒ 只改 checkup 基线的话测试照过、界面继续显示旧数字（**静默不一致，比挂掉更糟**）。要改的是 client.js 那 4 处硬编码 + [client.render-smoke.mjs#L438-L440](<../../dsh-plugin/test/client.render-smoke.mjs#L438-L440>) 的断言
- [ ] **注意**：[persona.lint.test.js#L208](<../../dsh-plugin/test/persona.lint.test.js#L208>) 是"拿 HUMAN_BASELINE 跟自己比"的恒真断言，**没有保护作用**，建议顺手改成锁字面量
- [ ] 卡改动会挂 [persona.layers.test.js#L5](<../../dsh-plugin/test/persona.layers.test.js#L5>) 的快照逐字节比对 ⇒ 必须跑 node scripts/regen-whale-snapshot.mjs

> ⚠️ 升级基线**不是**"改个数字"：它会让体检 verdict 从"严重偏离"变成正常，从而**停止**向模型注入"你太长了"的自我纠正。若只改数字不调 maxChars，模型反而会更快写长。这也是 Step 3 不能省的原因。

---

### 2.4 §2.2-C 句号策略与 venues 死配置 —— 判定：矛盾真实，**但需要你拍板**

#### 2.4.1 两个独立问题

**问题 1｜periodMax 的"文档 vs 执行"不一致。**

| 位置 | 内容 | 是否被代码读取 |
|---|---|---|
| [whale.card.json#L10](<../../dsh-plugin/prompts/persona/whale.card.json#L10>) creatorNotes | "句号 periodMax=0（彻底消除 AI 句号味）" | ❌ **无人读取**（[card.js#L31](<../../dsh-plugin/lib/persona/card.js#L31>) 明示不含 creatorNotes，也不注入 prompt） |
| [whale.card.json#L44](<../../dsh-plugin/prompts/persona/whale.card.json#L44>) periodMaxPerComment | 1 | ✅ 被 [lint.js#L187](<../../dsh-plugin/lib/persona/lint.js#L187>) 读作 L5b 阈值；被 [compile.js#L41](<../../dsh-plugin/lib/persona/compile.js#L41>) 注入 prompt"句号一条最多 1 个" |

所以这不是"同一个配置写了两处不同值"，而是**给人看的说明没跟上执行配置**——属文档债。

**但如果按白皮书把执行值改成 0，会发生两件事**：

1. [lint.js#L236-L244](<../../dsh-plugin/lib/persona/lint.js#L236-L244>) 的 L5b maxCount(char='。', max=0) ⇒ **任何**一个句号都触发 warn。实测 **17.04%** 的真人评论带句号，等于把六分之一的真人写法判成"像在写小作文"。
2. 更糟的是 advice 文案：当前写法把 base.periodRate × 100 直接拼进提示（[lint.js#L243](<../../dsh-plugin/lib/persona/lint.js#L243>)），改成 0 后模型会被明确告知"**真人句号率 0.0%**"，而事实是 17.04%。**这是在教模型一个假的分布。**

（技术细节：Python 哑执行对 max: 0 的处理是正确的——[mcp_server.py#L778-L786](<../../mcp_server.py#L778-L786>) 用 count <= max_n 判定，max=0 时 0 个通过、≥1 个触发。规则**不会**被静默禁用，所以风险是"过度报警"而非"不生效"。）

**问题 2｜venues 三档剧场是死配置。**

[whale.card.json#L510-L547](<../../dsh-plugin/prompts/persona/whale.card.json#L510-L547>) 定义了普通区（5–20 字 / max 35）、生态区、AI 话题区三档参数。**实测消费方为 0**：

```text
grep -r "venue"  dsh-plugin/**/*.js  → 0 命中
grep    "venue"  mcp_server.py      → 0 命中
（仅 whale.card.json 与 console-demo HTML 快照里存在）
```

卡里三档的实际参数（供决策参考）：

| 档位 | 触发条件 | 字数 | max | 表情 | @ | 黑话 |
|---|---|---|---|---|---|---|
| 普通区（默认） | 其余全部 | 5–20 | **35** | 1–2 | 默认不@ | 仅软性 |
| 生态区 | 大肥鱼/DSH/养鱼话题，或 UP 是 AI 号 | 8–28 | **40** | 1–2 | 允许 | 全开 |
| AI话题区 | 模型/教程/AI新闻/工具实测 | 10–35 | **50** | 0–1 | 允许但少用 | 半开 |

注意这是**两个不同字段**：质量门读的是 `voice.modes.comment.maxChars = 100`（[lint.js#L183-L185](<../../dsh-plugin/lib/persona/lint.js#L183-L185>)），venues 里的 `max`（35/40/50）当前**没有任何读取方**。所以即便把 venues 接进 prompt，只要 `maxChars` 仍是 100，分层就只作用于"提示语"、不作用于"质量门"——实现时必须同时把 venue 的 `max` 接到 lint 的 limits 上，否则又做出一套不生效的配置。

这意味着：白皮书 §2.2 与 v4.0.0 人设卡赖以成立的"剧场分层"**从未生效**，"普通区 15 字"也从未生效。**这是 §2.2 整章最被忽略的前提。**

#### 2.4.2 决策项（需拍板，二选一）

| 选项 | 内容 | 成本 | 后果 |
|---|---|---|---|
| **A. 落地 venues**（推荐） | bili_reply / bili_ledger_append 增 venue 参数，取值用卡里已有的键名（普通区 / 生态区 / AI话题区，默认普通区）；lint.js 按 venue 取不同 maxChars；compile.js 按 venue 注入音量段；duty.md 要求按现场传 venue | 2–3 天 | 白皮书与卡的设计才真正成立；能按区域调音量，而不是全局限 100 字 |
| **B. 删除 venues** | 从卡中移除，改为在 creatorNotes 标注"未实现，勿引用" | 0.5 天 | 诚实但失去分层能力；白皮书 §2.2 需重写 |

**不建议 C（保留死配置）**：它已经造成白皮书基于不生效的配置写分析——这正是"文档债引发错误设计"的样本。

#### 2.4.3 句号政策的推荐表述（无论选 A 还是 B）

```text
【风格规定，非语料事实】
本号在评论区不使用句号（periodMaxPerComment=0），以换行/表情/语气词结句。
依据：52,464 条语料中 83% 的真人评论不含句号；但含句号者仍占 17.04%。
因此这是**人设风格选择**，不是"真人都不写句号"。
```

同时把 advice 改成不引用统计值的写法（沿用 lint 的 {占位符} 风格）：

```javascript
// lint.js L243 附近
advice: '句号 {count} 个（上限 {max}）。本号规定不使用句号：换行或表情结句更有口气。',
// 不再宣称"真人句号率 X%"，避免与实测冲突
```

#### 2.4.4 验收

- [ ] 决策记录（A 或 B）写入本文
- [ ] 若选 A：同一句话在 venue=normal 与 venue=eco 下取得不同 maxChars，有单测
- [ ] 若选 B：grep -r venue dsh-plugin 在代码侧仍为 0，且卡里已无该段
- [ ] creatorNotes 与执行配置一致（加一条测试：creatorNotes 里声明的 periodMax 必须等于 punctuation.periodMaxPerComment）

---

### 2.5 §2.3 账本读取 —— 判定：成立，做，但**别当雪崩项**

#### 2.5.1 现状（含白皮书漏掉的两个坑）

[mcp_server.py#L2021-L2053](<../../mcp_server.py#L2021-L2053>)：

| 事实 | 证据 |
|---|---|
| 每次从文件头读到尾 | :2033-2035 with open(path) + for line in f |
| 每行 raw_decode 逐个扫（容忍一行多对象） | :2032、:2039-2050 |
| 无任何缓存 | 全函数无 stat/mtime/lru_cache；全文件仅 :2016 一处无关的 fromtimestamp |
| **坑 1：limit 形同虚设** | :2053 return out[-limit:] —— **先全量解析再切片**。bili_ledger_append 传 limit=800 一点 I/O 都没省 |
| **坑 2：异常被静默吞掉** | :2051-2052 except Exception: return out 无日志；:2046-2047 内层 break 丢弃该行剩余对象 |

**真实调用点**（白皮书只列 2 个，实际 4 个）：

| 调用方 | 路径 | 备注 |
|---|---|---|
| bili_feed :2138 | → _ledger_seen_bvids :2059 | 取全集，必须全量 |
| bili_reply :945 | → _replied_targets :2080 | 仅 rpid != 0 时触发 |
| bili_received_replies :1859 | → _replied_targets | **白皮书漏列** |
| bili_ledger_append :2288 | 直接调用，limit=800 | **白皮书漏列**，且 limit 无效 |

#### 2.5.2 改法（分两步，第二步可选）

**Step 1（P0，30 行）｜先把两个坑补上，不动架构。**

```python
def _ledger_read_events(limit: int = 0) -> list:
    out: list = []
    path = _persona_home() / "ledger.jsonl"
    try:
        if not path.exists():
            return out
        dec = json.JSONDecoder()
        bad = 0
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s:
                    continue
                i = 0
                while i < len(s):
                    while i < len(s) and s[i] in " \t":
                        i += 1
                    if i >= len(s):
                        break
                    try:
                        obj, j = dec.raw_decode(s, i)
                    except Exception:
                        bad += 1
                        break          # 该行剩余对象丢弃，但要留痕
                    if isinstance(obj, dict):
                        out.append(obj)
                    i = j
        if bad:
            logger.warning("账本有 %d 行解析失败（已跳过，不影响其余行）", bad)
    except Exception as e:
        # ⭐ 原来是静默 return out：账本读失败 ⇒ seen 全空 ⇒ 重复看/重复回且无人知晓
        logger.error("账本读取失败，返回空集（本轮判重会失效）：%s", e)
        return out
    return out[-limit:] if limit and limit > 0 else out
```

**Step 2（P1，可选）｜增量索引，与 JS 侧同口径。**
[dsh-plugin/lib/ledger-index.js#L36-L49](<../../dsh-plugin/lib/ledger-index.js#L36-L49>) 已经用 size:mtimeMs 签名做过这件事，且有 [ledger.index.test.js](<../../dsh-plugin/test/ledger.index.test.js>) 保护。Python 侧照搬即可，**不要另发明键名**：

```python
class _LedgerCache:
    """与 dsh-plugin/lib/ledger-index.js 同口径：size+mtime 变了才重解析。"""

    def __init__(self):
        self._sig = None
        self._events: list = []

    def events(self) -> list:
        path = _persona_home() / "ledger.jsonl"
        try:
            st = path.stat()
        except OSError:
            return []
        sig = (st.st_size, int(st.st_mtime * 1000))
        if sig != self._sig:
            self._events = _ledger_read_events()   # 复用上面的实现，保证语义唯一
            self._sig = sig
        return self._events


_ledger_cache = _LedgerCache()
```

> ⚠️ 进程级缓存的有效性取决于 MCP 进程存活范围：同一轮内多次工具调用能命中；**跨轮**需要落盘索引（JS 侧是否落盘需先确认，别假设）。若只做进程内缓存，收益是"同一轮 4 次调用从 4 次全扫降到 1 次"。

#### 2.5.3 验收

- [ ] limit=800 时**不读全表**（或至少：有缓存后不重复解析）——用 5MB 夹具断言耗时 < 5ms
- [ ] 坏行/坏文件不静默：注入 1 行坏 JSON ⇒ 有 warning；整文件不可读 ⇒ 有 error，且不再静默返回空
- [ ] 现有判重行为不变：同一夹具下 _ledger_seen_bvids() 与 _replied_targets() 结果逐项相同

---

### 2.6 §2.4 通知工具容错 —— 判定：部分成立，**5 行改完**，P0

**现状** [mcp_server.py#L1895-L1915](<../../mcp_server.py#L1895-L1915>)：

```python
    if errors:
        return _err("; ".join(errors), **result)   # ← 数据其实带回去了，但 success:false
```

白皮书说"整个工具直接返回 _err、数据全丢"——**不准确**：[ _err_ :75-80](<../../mcp_server.py#L75-L80>) 会 payload.update(extra)，成功的 at/likes 一直在 payload 里。**真正的缺陷是 success:false 会让模型当轮把两份数据整体丢弃**，且没有 partial 标记可判断"缺的是哪一半"。

**改法**：

```python
    cred = get_cred()
    result: dict = {}
    errors: list = []
    # 两个请求互不依赖 ⇒ 并发，延迟从"两者之和"降到"两者较大者"
    at_res, likes_res = await asyncio.gather(
        session.get_at(credential=cred),
        session.get_likes(credential=cred),
        return_exceptions=True,
    )
    for key, res in (("at", at_res), ("likes", likes_res)):
        if isinstance(res, BaseException):
            errors.append(f"{key} 获取失败: {res}")
        else:
            result[key] = res
    payload = {"success": True, "partial": bool(errors), **result}
    if errors:
        payload["errors"] = errors
        payload["note"] = "部分通知获取失败；已有数据照常可用，缺的一半下轮再取，不要重试本调用"
    return json.dumps(payload, ensure_ascii=False)
```

**验收**：
- [ ] 单侧失败 ⇒ success:true + partial:true + errors 有内容 + 另一侧有数据
- [ ] 双侧成功 ⇒ 无 partial / errors 字段（或 partial:false）
- [ ] **检查消费方**：duty.md 与宿主是否依赖 success===false 判断告警；若有需同步（grep -rn "received_at_and_likes" .）

---

## 3. 第四章：工程化项落地

### 3.1 §4.1 拆包 bili_mcp —— 成立，P3

事实：2712 行、34 个 @_gated_tool()、无本地包 import、无 bili_mcp/ 目录。最长函数：bili_persona_note :2596-2706（111 行）、_lint_eval_check :711-821（111 行）、bili_upload_video :1185-1287（103 行）。

**前置条件（不可省）**：先写"工具集快照测试"——启动 MCP、list_tools() 导出 34 个工具的 name + 参数 schema 存快照，拆包后逐字节比对。**没有这张网，拆包属于赌博**。

**建议顺序**：lint/ → storage/ → core/ → tools/，每步单独提交、跑快照测试、保持 mcp_server.py 作为薄入口 re-export。**不要一次性搬 34 个工具。**

### 3.2 §4.2 异步 I/O 净化 —— 成立，且**实际范围是白皮书点名的 15 倍**，P1（收益最高）

白皮书只点了 `bili_ledger_append` / `bili_report_append` 两个工具。用 AST 统计**在协程内直接执行**的同步文件系统调用（口径：`open`/`read`/`write`/`seek`/`read_text`/`write_text`/`mkdir`/`stat`/`exists`/`remove`/`getsize`/`isfile` 每个调用点各算一处，均位于 `async def` 函数体内且未被 await 包装），实测 **30 处 / 9 个 async 函数**：

| 函数 | 同步 I/O 位置（逐调用点） | 处数 | 说明 |
|---|---|---|---|
| bili_ledger_append | :2311 mkdir、:2313 stat、:2313 exists、:2314 open、:2315 seek、:2316 read、:2319 open、:2320 write | 8 | 白皮书已提 |
| bili_report_append | :2363 mkdir、:2364 exists、:2364 read_text、:2370 open、:2371 write | 5 | 白皮书已提 |
| bili_persona_note | :2635 mkdir、:2637 exists、:2638 open、:2639 read、:2696 open、:2697 write | 6 | **漏**；growth-pending.jsonl 是并发追加语义，**无锁** |
| bili_login | :223 open("wb")、:224 write | 2 | **漏**；每次扫码都在事件循环里写 PNG |
| _grab_frame | :1106 isfile、:1106 getsize | 2 | **漏** |
| _extract_cover_from_video | :1117 isfile、:1118 remove | 2 | **漏** |
| bili_upload_video | :1222 isfile、:1248 isfile | 2 | **漏** |
| bili_upload_video_multi | :1332 isfile、:1344 isfile | 2 | **漏** |
| _add_images_to_dynamic | :153 isfile | 1 | **漏** |
| **合计** | — | **30 / 9 个函数** | 白皮书口径：2 工具 |

**ClientSession**：[_fetch_subtitle](<../../mcp_server.py#L500>) 在 :530-531 每次新建/销毁；全文件 `ClientSession` 只出现在 **:531 一处**（:530 只是 `ClientTimeout`），**无全局单例**。它被 :559（bili_subtitle）与 :1066（bili_crawl）调用 ⇒ **每个视频一次 TLS 握手**。

**改法**：

```python
_http: aiohttp.ClientSession | None = None


async def get_http_session() -> aiohttp.ClientSession:
    global _http
    if _http is None or _http.closed:
        _http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
    return _http

# 进程退出/生命周期钩子里关闭：await _http.close()
```

同步 I/O 一律收进线程：

```python
def _sync_append(path: Path, blob: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        f.write(blob)


await asyncio.to_thread(_sync_append, path, blob)
```

**验收**：bili_subtitle 连查 3 个视频，抓包/log 确认复用同一连接；事件循环在 5MB 报告读写期间不出现 >50ms 的 tick 抖动。

### 3.3 §4.3 临时文件 UUID —— 成立，**5 分钟**，P0

[:1111](<../../mcp_server.py#L1111>) 现为 f"bili_cover_{os.getpid()}.png"（函数 :1109-1119，finally 里 :1117-1118 删除）。

```python
import uuid   # ⚠️ mcp_server.py 目前**未导入 uuid**（import 段 :10-31），必须补

tmp_cover = os.path.join(
    tempfile.gettempdir(),
    f"bili_cover_{os.getpid()}_{uuid.uuid4().hex[:8]}.png",
)
```

顺带（可选）：改用 tempfile.NamedTemporaryFile(delete=False, suffix=".png") 更彻底，但会牵动 ffmpeg 的路径参数，收益不大，**建议只加 UUID**。

### 3.4 §4.4 Pydantic 强契约 —— **论据不成立**，P3

实测：list[dict] 全文件**仅 1 处**（bili_ledger_append :2265）；其余弱类型只是 list[str] | None（:1127 / :1293 / :1377 / :2604），无裸 dict / list。

所以"许多工具参数弱类型"是夸大。**但"函数体内大量手写字典解构"这一半成立**：:2281-2306 + _validate_ledger_event :2232-2261 + _LEDGER_REQUIRED :2205-2214。

**建议收敛范围**：只对 bili_ledger_append 引入 LedgerEventInput（8 种 type 的判别联合），其余 33 个工具**不动**。收益是模型在调用前就能看到 JSON Schema，减少试错；成本是 1 个工具 + 1 组测试。

### 3.5 §4.5 client.js 分层 —— 行数对，**方案不可行**，P4

**事实核查**：

| 断言 | 判定 | 实测 |
|---|---|---|
| 4090 行 | ✅ | 4090 行 / 236,297 B |
| CSS 800+ 行 | ❌ | STYLE :76-634，CSS 内容 **557 行**，占 **13.6%** |
| 五视图塞一个文件 | ✅ | TABS :52；ActivityPage:1793 / ReportsPage:1968 / PersonaPage:2099 / SettingsPage:2945 / OverviewPage:3816；usePoll:720 / useRealtime:769 / useLive:1006 |

**致命约束**：平台要求 exports["./client"] **单文件入口**（[package.json#L16-L21](<../../dsh-plugin/package.json#L16-L21>) 已如此声明），且入口以 **classic script**（无 type=module）注入——入口里写 import/export 直接语法错误。唯一多文件通道是 require.async('./client.<name>.js')，且产物名需匹配固定 chunk 规则。

**仓库内佐证**：[client.smoke.mjs#L51-L54](<../../dsh-plugin/test/client.smoke.mjs#L51-L54>) 明确"ESM 不可直接 eval——它是 CJS 风格的 window.__ModuleLoader__.load"，用 new Function 执行整份文件。

**两个可行选项**：

| 选项 | 内容 | 成本 | 收益 |
|---|---|---|---|
| **A（推荐）** | 引入构建：源码拆 client/*.js + tsdown 产出单入口 client.js | 3–5 天（含改 exports/files、CI、两个 smoke 测试） | 4090 行降到每文件 300–600 行，可维护性质变 |
| **B（零构建）** | 保持单文件，只做同文件内分区 + 注释导航 + 抽 useXxx hook 顺序 | 0.5 天 | 有限，主要减少跳读成本 |

**结论**：白皮书"原生 ESM 免构建拆分"**不可行**，必须把 A 作为正式选项、B 作为折中，并由你决定是否接受引入构建链。

---

## 4. 白皮书未覆盖、但建议先做的事项

| # | 事项 | 位置 | 为什么优先 | 批次 |
|---|---|---|---|---|
| 1 | **venues 死配置**（三档剧场无人读） | whale.card.json:510-547 | v4.0.0 整份设计建立在它上，却不生效；已导致白皮书 §2.2 分析失焦 | P1（决策） |
| 2 | **两份 247 基线重复**（lint + checkup） | lint.js:36-43 / checkup.js:26-31 | 改一份不同步 ⇒ 提示与体检互相矛盾 | P1 |
| 3 | **bili_report_append 每次全量读当日报告** | mcp_server.py:2363-2371 | 与账本同类问题，且报告逐轮增长**无上限**，长期比账本更大 | P1 |
| 4 | **家目录解析抄了三份** | mcp_server.py:668-672、:2586-2590、scripts/_fenshen_paths.py:19-27 | 任一不同步 ⇒ "账本在 A、候选在 B"的错位 | P1 |
| 5 | **二维码写死在代码目录** | mcp_server.py:164、:223-224 | 只读安装目录下 bili_login 直接 PermissionError；且污染仓库根 | P1 |
| 6 | **ARCHITECTURE.md 文档超前** | ARCHITECTURE.md:654 把 commentsToVerify 写成既有字段 | 与实现不符，会误导后续设计 | P0（改文档） |
| 7 | **persona.lint.test.js:208 恒真断言** | 拿 HUMAN_BASELINE 跟自己比 | 看着有保护、实际没有 | P1 |
| 8 | **growth-pending.jsonl 并发追加无锁** | mcp_server.py:2696-2697 | 同进程/多进程并发时可能交错写 | P2 |

---

## 5. 实施批次（含依赖、可并行性、测试影响）

| 批次 | 内容 | 主要文件 | 验收方式 | 测试影响 | 可并行 |
|---|---|---|---|---|---|
| **第 0 批**<br/>低风险小改 | §2.4 通知容错；§4.3 UUID；账本异常加日志；limit 语义修正；ARCHITECTURE.md 修正 | mcp_server.py、docs/ARCHITECTURE.md | 手测 + 新增单测 | 无既有测试受影响 | ✅ 三件事互不冲突 |
| **第 1 批**<br/>性能 | §4.2 ClientSession 单例 + 30 处 to_thread；§2.3 Step 2 增量缓存 | mcp_server.py | bili_crawl 5 视频耗时对比 | 无 | ❌ 与第 0 批同文件，需排队 |
| **第 2 批**<br/>人设对齐 | §2.2-A 词表；§2.2-B 基线合并 + maxChars；§2.2-C 决策落地 | growth.js、lint.js、checkup.js、whale.card.json | npm test（**会挂**，需同步改断言）+ regen-whale-snapshot.mjs | ⚠️ 3 个测试必改 | ⚠️ 卡改动牵动快照，串行 |
| **第 3 批**<br/>复核链路 | §2.1 实验 → 方案 B 实现（或删除死代码） | mcp_server.py、index.js、replies.js、duty.md | 新增 3 类夹具单测 | 零既有覆盖，**先写测试** | ❌ 依赖实验结论 |
| **第 4 批**<br/>工程债 | §4.1 拆包（先补工具快照测试）；§4.5 构建链（若选 A）；§4.4 单工具 Pydantic | 多处 | 快照比对 + npm test | 需要新建保护网 | ✅ 拆包与前端拆分互不干扰 |

**关键依赖**：第 2 批的 maxChars 调整**必须**与基线合并同批（否则体检不再提示"太长"，反而更松）；第 3 批必须先有实验结论，禁止先写代码。

---

## 6. 待拍板决策（4 项，需账号主人决定）

| # | 决策 | 选项 | 我的推荐 | 影响面 |
|---|---|---|---|---|
| 1 | **句号政策** | ① 全站禁句号（periodMax=0，且 advice 文案去掉"真人句号率"）② 保持 1 个 ③ 按 venue 区分（普通区 0 / 生态区 1） | **①并改写文案**——但必须标注为"风格规定"，不得再伪装成统计事实 | whale.card.json、lint.js、prompt 注入 |
| 2 | **venues 去留** | A 落地（2–3 天）/ B 删除（0.5 天） | **A**，否则 v4.0.0 的"剧场分层"始终是空话 | 人设卡、lint、compile、bili_reply 参数 |
| 3 | **发后复核** | A 做（先半天实验）/ B 明确放弃并删死代码 | **先做实验**；实验不通过就选 B，**不要留占位桩** | index.js、mcp_server.py、配额口径 |
| 4 | **client.js 是否引入构建** | A 引入（3–5 天）/ B 保持单文件 | **B 暂缓**——当前 4090 行无实际痛点，除非继续加页面 | 前端全部、CI、两个 smoke 测试 |

---

## 附录 A：白皮书勘误表

| 白皮书表述 | 实测 | 勘误类型 |
|---|---|---|
| mcp_server.py 2712 行 | 2712 行 | ✅ 准确 |
| client.js 4090 行 | 4090 行 | ✅ 准确 |
| 34 个工具 | 34 个 @_gated_tool()，运行时 list_tools() = 34 | ✅ 准确 |
| client.js 含 800+ 行 CSS | 557 行（13.6%） | ❌ 高估 40% |
| 账本 5MB 时阻塞 200–800ms | ≈86ms（合成 5MB 实测 + 估算） | ❌ 夸大 2.3–9.3 倍 |
| 语料中位 15 字 | 19 字（charLen 口径） | ❌ 15 是 venues 设计参数，非统计值 |
| 语料句号率 0.000 | 17.04% | ❌ 把"83% 无句号"误作"句号率 0" |
| 语料问句率 4.7% | 7.42% | ❌ |
| 语料表情率 34.4% | 31.4%（未给口径，无法判定其算法） | ⚠️ 未标明口径 |
| "许多工具参数是弱类型 list[dict]" | 全文件仅 1 处 | ❌ 夸大 |
| "同步 I/O 混用"（点名 2 工具） | 30 处 / 9 个 async 函数 | ❌ 低估 15 倍 |
| §2.1 verifyRecentSafe 是占位桩 | 是死代码（输入源无写入点，连日志都不打） | ⚠️ 低估严重性 |
| §2.1 免登录探测可行 | 与项目调研报告冲突（未登录仅 ~3 条 + is_end=true） | ❌ **方案不可行** |
| §2.2 247 基线导致写长 | 该常量不设阈值，仅影响文案 | ❌ 因果错误 |
| §4.5 可原生 ESM 多文件拆分 | 平台要求单文件 classic script | ❌ **方案不可行** |

---

## 附录 B：关键引用索引

**Python 数据层**
- 账本读取：mcp_server.py:2021-2053（limit 无效 :2053；静默吞异常 :2051-2052）
- 账本写入：:2264-2324；校验 _validate_ledger_event :2232-2261；_LEDGER_REQUIRED :2205-2214
- 评论发布：bili_reply :923-1007（返回 rpid :1001）
- 通知容错：bili_received_at_and_likes :1895-1915
- 封套：_ok :70-72、_err :75-80
- lint 哑执行：_lint_eval_check :711-821；maxCount :778-786
- 字幕会话：_fetch_subtitle :500、:530-531
- 封面临时文件：:1109-1119（:1111）
- 二维码：:164、:223-224
- 家目录：:668-672、:2586-2590

**DSH 插件**
- 复核死代码：index.js:1427-1435；定时器 :1337-1338；bumpState :329-334
- 成长词表：lib/persona/growth.js:44、:121-132、:220、:268
- 质量门：lib/persona/lint.js:36-43、:187、:233、:236-244
- 体检：lib/persona/checkup.js:26-31、:176-188
- 卡编译：lib/persona/compile.js:41；卡字段剥离 lib/persona/card.js:31
- 增量索引：lib/ledger-index.js:36-49
- 配额：lib/overview.js:129（countToday）、:159-171（addOne 六类事件）
- 前端：client.js:52（TABS）、:76-634（STYLE）、:720/:769/:1006（hooks）、:1793/:1968/:2099/:2945/:3816（五页）

**人设卡 / 文档**
- prompts/persona/whale.card.json：:10（creatorNotes）、:44（periodMaxPerComment）、:79（maxChars 100）、:111-115（bannedWords）、:406-410（canon 定案台词）、:510-547（venues）
- docs/ARCHITECTURE.md:654（commentsToVerify 文档超前）
- docs/analysis/2026-10-28-behavior-audit.md:313（同一问题的旧记录）
- B站评论社交语言调研报告-2026-10-29.md:43-45（未登录降级实测）
- 人设卡反思与修改建议-豆腐whale3.0-2026-10-29.md:26、:119（"15 字"与"句号≈0"的真实出处）

---

## 附录 C：测试保护矩阵

| 改动范围 | 既有保护 | 受影响测试 | 处理 |
|---|---|---|---|
| whale.card.json | ✅ 快照逐字节 | persona.layers.test.js:5,L26 | 跑 node scripts/regen-whale-snapshot.mjs |
| lint.js 基线 | ⚠️ 恒真断言 | persona.lint.test.js:208 | 顺手改成锁字面量 |
| checkup.js 基线 | ✅ 但锁的是陈旧值 | persona.checkup.test.js:41-44、client.render-smoke.mjs:438-440 | 同步改断言 |
| growth.js 词表 | ✅ 行为级 | persona.growth.test.js:65、fixtures/persona/smoke-card.js:26 | 同步改夹具 |
| client.js 结构 | ✅ 结构级 | client.smoke.mjs:51-54、client.render-smoke.mjs | 拆分必须同时改加载方式 |
| index.js 复核链路 | ❌ **零覆盖** | — | **先写测试再动** |
| mcp_server.py 工具集 | ⚠️ 无自动快照 | — | 拆包前先建 list_tools() 快照 |

**测试命令**：cd dsh-plugin && npm test（= node --test test/*.test.js；.mjs 冒烟测试需单独跑）。

---

> **本文的边界**：所有"成立/不成立"判定均以本次核验的 76b8995 + 工作区状态为准；语料数字为 52,464 条全量重算，口径见 §1.1；账本耗时为合成夹具基准，非长期运行观测。凡标"待验证"的（§2.1 可行性、venues 去留、client.js 构建）**都还没结论**，不应被引用为已定方案。
