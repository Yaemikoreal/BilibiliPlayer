# -*- coding: utf-8 -*-
"""端到端验证 2026-10-29T07:43:22.408Z 这一轮的修复效果。"""
import json
import sys
from collections import Counter

# 兼容 Windows 默认控制台编码，避免 GBK 编码报错
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

from _fenshen_paths import ledger_events, require_ledger

LEDGER = require_ledger()
ROUND = "2026-10-29T07:43:22.408Z"
events = ledger_events(LEDGER)

mine = [e for e in events if str(e.get("round", "")).startswith("2026-10-29T07:43")]
print(f"本轮事件数: {len(mine)}")
if not mine:
    # 换机器/换号后本机账本里很可能没有这一轮 —— 不能把它当成「判据失败」，
    # 否则脚本在任何别的机器上都报 ❌（2026-10-29 测试报告 §3.3 的同类问题）。
    print("[!] 本机账本里没有这一轮（round 前缀 2026-10-29T07:43），跳过验证。")
    print("   要验那一轮，用 BILI_FENSHEN_HOME 指向当时的家目录再跑。")
    raise SystemExit(0)
rounds_seen = Counter(str(e.get("round", "")) for e in mine)
print("本轮 round 值分布:", dict(rounds_seen))
print("[OK] round 单源（全部等于 roundId）" if set(rounds_seen) == {ROUND} else "[FAIL] round 出现多值！")

# 类型分布
print("\n本轮事件类型:", dict(Counter(e.get("type") for e in mine)))

# 回填重复检查：src=report 的 reply-out 且 rpid 为 null
dups = [e for e in mine if e.get("source") == "report" and e.get("type") == "reply-out" and e.get("rpid") is None]
print(f"\nsrc=report 且 rpid=null 的 reply-out（回填重复行）: {len(dups)} 条")
print("[OK] 无回填重复行" if not dups else "[FAIL] 仍有回填重复行！")

# 回填重复 reply-scan
dups2 = [e for e in mine if e.get("source") == "report" and e.get("type") == "reply-scan"]
print(f"src=report 的 reply-scan（回填）: {len(dups2)} 条")
for e in dups2:
    print("   ", e.get("bvid"), e.get("decision"), e.get("targetRpid"))

# 本轮 reply-out 详情
print("\n本轮 reply-out:")
for e in mine:
    if e.get("type") == "reply-out":
        print(f"   parent={e.get('parent')} rpid={e.get('rpid')} kind={e.get('kind','-')} src={e.get('source','-')} text={str(e.get('text',''))[:24]}")

# 本轮 reply-in
print("\n本轮 reply-in:")
for e in mine:
    if e.get("type") == "reply-in":
        print(f"   对方rpid={e.get('rpid')} from={e.get('from')} text={str(e.get('text',''))[:20]}")
