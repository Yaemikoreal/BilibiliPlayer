# 2026-10-29 · 回复判重修复（v6：目标级统一判重 + round id 单源化）

## 问题（用户报告 + 账本实锤）

同一评论在相邻轮次被重复回复：

| 对方评论 | 09:14 轮 | 11:16 轮 | 12:25 轮 |
|---|---|---|---|
| Aria_凛酱门 rpid 318480411329「大肥鱼怎么这么快喵」 | 回了 ✅ | **又回了 ❌** | 想再回，被 B站 12022 拦住 |
| 究极无敌路由器 rpid 317852573329「去街上补仓」 | 回了 ✅ | **又回了 ❌** | — |

duty.log 显示模型第一遍推理得出"连续剧 → 不接"，随后因**查无已回记录**推翻自己。

## 根因

1. **跟进回复没有目标级判重数据**：已接话清单只认 `kind=proactive`（`replies.js`）；seen.md 的跟进行记的是自己楼层 rpid，不是对方 rpid；`bili_received_replies` 原样透传、同一条通知每轮重现。
2. **round id 双源**：宿主 roundId（`index.js runDuty`）与 MCP 补账本用的 `state.json.lastRunStartedAt` 差 1s+ ⇒ 同轮两个 round 值 ⇒ 一切按 round 对账的去重失效。
3. **回填兜底过宽**：roundSection 找不到本轮且全文轮次 ≤1 时退回解析**整份日报** ⇒ 01:37/02:13 失败轮把上午轮的扫描整套抄一遍；每轮轮末还把模型已记过的 reply-out 再补一份 `rpid=null` 重复行。

## 修复

| 层 | 改动 | 文件 |
|---|---|---|
| 注入 | `proactiveTargetsFromLedger` → `repliedTargetsFromLedger`（接话+跟进全量，返回 `{proactive, followup}`）；prompt 注入「已回复清单」+ 硬规则 | `dsh-plugin/lib/replies.js`、`index.js` |
| 工具 | `bili_received_replies` 每条通知带 `already_replied` / `bvid` / `target_rpid`；`bili_reply` 对已回目标**硬拦截**（账本全量 + 进程内存双层）；`_current_round_id()` 优先读 env | `mcp_server.py` |
| 单源 | overlay 注入 `BILI_FENSHEN_ROUND_ID`；`bumpState(lastRunStartedAt: roundId)` | `dsh-plugin/index.js` |
| 回填 | 兜底收窄（rounds ≥ 1 即拒绝整份解析）；`dedupeScans` 两键全局去重；reply-out 回填去重去掉 round 条件 | `dsh-plugin/index.js`、`lib/report.js` |
| 章程 | v6：跟进/接话共用「已回复清单」；通知还挂着 ≠ 新互动；判重表跟进行改记 `跟进过rpid <对方>→自己楼层<own>` | `dsh-plugin/prompts/duty.md` |

判重键统一为**对方评论的 rpid**：对方有新互动 = 新 rpid，规则自洽（"同一评论只回一次，除非人家再继续跟你有新的互动"）。

## 验证

- 单测：round/report/replies/persona.prompt 相关 61 例全绿；全套 477/484（4 失败 = 62230e5 清空语料库种子导致的基线断言，3 取消 = fetch 测试事件循环怪癖，均与本次无关）。
- 数据回放（`scripts/replay-reply-dedup.mjs`）：两条真实重复目标进清单；01:37 失败轮回填的重复扫描被全局去重拦住。
- 真跑一轮（round id `2026-10-29T07:43:22.408Z`）：16 条事件 round 值单一；无 `src=report` 重复行；日志实锤 `3 already_replied=true items — skip`（正是上午连回的那两条）+ 硬拦截零触发（模型提前跳过）。
