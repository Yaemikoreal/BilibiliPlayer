# 发后复核（§2.1 抗压审）可行性探针实验简报

> **实验代号**：PLAN-2026-10-30-REMEDIATION Task 3.2 步骤 1
> **执行日期**：2026-10-30
> **实验账号**：插件小号（登录态，bili_credential.json）
> **目标**：验证「发出去的评论/楼中楼，能否用只读 API 核对是否真的发出（对抗压审/风控静默失败）」，为方案 B（数据层独立出网核对）定技术路线。

## 实验设计

用账本里已知发布成功的评论做正样本，分别探测：

| 实验 | 请求 | 说明 |
|:---:|---|---|
| E1 | 登录态 `GET /x/v2/reply/main?oid=<aid>` | 主评论列表（首屏 + cursor 翻页） |
| E2 | 无 Cookie 游客态同请求 | 验证 AUDIT「未登录只回 ~3 条」的误报根源 |
| E3 | 登录态 `GET /x/v2/reply/reply?oid=<aid>&root=<对方rpid>` | 楼中楼子回复列表 |

正样本（账本 2026-10-29 实发）：
- 根评论：`BV1SYso6VEZW`（aid=117523039128756，55 条评论）rpid=318530278673
- 楼中楼：`BV1vMsZ6JEn4`（aid=117522854581689）rpid=318530232113（root=322243623344）

## 结果

### E1 登录态 reply/main
- **首屏可见自己刚发的根评论**（两个视频均命中：页内找到 rpid，内容/点赞数完整返回）。
- `ps` 参数实际不受控（ps=49 仍只回 1–4 条/页）；**翻页必须走 cursor 协议**（`cursor.next` → `&next=`，`is_end` 终止），`pn` 参数无效。
- cursor 全翻页可达：上例第 2 页（next=21→翻页后）找到目标，总计 5 条即达。
- **楼中楼回复基本不出现在 reply/main**（5 页内未命中；root 的内嵌 `replies` 预览也不含）——楼中楼核对必须走 E3。

### E2 游客态
- 连翻 3 页仅回 **3 条**（每页 1 条）——与 AUDIT-2026-10-29「未登录 ~3 条」实测一致。
- **结论：游客态探测 100% 误报**（查不到≠被压审），白皮书方案 A 正式否定。

### E3 登录态 reply/reply
- `root=<对方rpid>` 稳定返回楼中楼子回复列表，**自己的回复可见**（页内命中）。
- `data.root.replies` 内嵌预览为空 ≠ 子回复丢失（要看主列表 `data.replies`）。

## 结论与方案 B 技术路线

1. **方案 B 可行**：登录态只读核对即可，不需要游客态兜底。
2. 根评论核对：登录态 `reply/main?mode=2`（时间序）+ cursor 翻页（上限 3–4 页即可，自己刚发的评论按时间序必在前面）。
3. 楼中楼核对：登录态 `reply/reply?root=<parent>` 一次请求，`data.replies` 找自己 rpid。
4. **必须带 10 分钟审核宽限窗**（grace_min）：B 站评论发出后常先「审核中」，立查不可见 ≠ 被压审；宽限期内一律返回「待复核」，不产生误报。
5. 账本/verify-pending 必须在**发出时就记下 aid 与 root**（发后只凭 rpid 无法反查 oid），这是数据层自记账的意义。

## 方案 B 落地清单（本次同步实施）

- 删除 `dsh-plugin/index.js` 的 90s 死定时器与 `verifyRecentSafe`（未接入写入源的死代码桩）。
- 新增 `<家目录>/verify-pending.jsonl`（7 天 TTL 滚动清理）：`bili_reply` 发出后尽力拿到 rpid 即写入（bvid/aid/rpid/root/round/text_head）。
- 新增独立只读探测工具 `bili_verify_recent_comments`（grace_min=10）：对 pending 逐条出网核对，返回 found / in-review（宽限期内）/ missing（疑似压审）/ probe-error，不自动改账本。
