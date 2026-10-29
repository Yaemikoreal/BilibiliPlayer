# -*- coding: utf-8 -*-
"""分析 ledger.jsonl：找出同一目标评论被多次回复的情况。"""
import json, sys, io
from collections import defaultdict
from datetime import datetime, timezone, timedelta

LEDGER = r"C:\Users\Administrator\.dsh\bili-fenshen\ledger.jsonl"
events = []
with open(LEDGER, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception as e:
            print("PARSE_FAIL:", e)

print(f"总事件数: {len(events)}")

# 1) 所有 reply-out 事件（我回复别人的评论），按 (bvid, parent) 分组
reply_out = [e for e in events if e.get("type") == "reply-out"]
print(f"\nreply-out 总数: {len(reply_out)}")
proactive = [e for e in reply_out if e.get("kind") == "proactive"]
followup = [e for e in reply_out if e.get("kind") != "proactive"]
print(f"  其中 kind=proactive(接话): {len(proactive)}")
print(f"  其中 跟进回复(无kind): {len(followup)}")

def dt(e):
    try:
        return datetime.fromisoformat(e.get("t", "").replace("Z", "+00:00"))
    except Exception:
        return None

# 2) 接话重复检测：同一 (bvid, parent) 被接话多次
groups = defaultdict(list)
for e in proactive:
    key = (e.get("bvid"), e.get("parent"))
    groups[key].append(e)

print("\n=== 同一目标评论被接话多次（kind=proactive）===")
dup_found = False
for key, lst in sorted(groups.items(), key=lambda kv: str(kv[0])):
    if len(lst) > 1:
        dup_found = True
        lst2 = sorted(lst, key=lambda x: str(x.get("t")))
        print(f"\n目标 {key[0]} → 对方rpid {key[1]}  被接了 {len(lst)} 次:")
        for e in lst2:
            t = dt(e)
            ts = t.strftime("%m-%d %H:%M") if t else e.get("t")
            print(f"  {ts} round={e.get('round','')[:19]} 自己rpid={e.get('rpid')} text={str(e.get('text',''))[:30]}")
if not dup_found:
    print("（无）")

# 3) 跟进回复重复检测：同一 (bvid, parent) 被跟进多次
groups2 = defaultdict(list)
for e in followup:
    key = (e.get("bvid"), e.get("parent"))
    groups2[key].append(e)

print("\n=== 同一目标评论被跟进回复多次（无kind）===")
dup2 = False
for key, lst in sorted(groups2.items(), key=lambda kv: str(kv[0])):
    if len(lst) > 1:
        dup2 = True
        lst2 = sorted(lst, key=lambda x: str(x.get("t")))
        print(f"\n目标 {key[0]} → 对方rpid {key[1]}  被跟进了 {len(lst)} 次:")
        for e in lst2:
            t = dt(e)
            ts = t.strftime("%m-%d %H:%M") if t else e.get("t")
            print(f"  {ts} round={e.get('round','')[:19]} 自己rpid={e.get('rpid')} text={str(e.get('text',''))[:30]}")
if not dup2:
    print("（无）")

# 4) 同一个用户被接话多次（7天窗口规则）
by_user_scan = [e for e in events if e.get("type") == "reply-scan" and e.get("decision") == "posted"]
print(f"\nreply-scan(posted) 总数: {len(by_user_scan)}")

# 5) 接话 vs 同视频多条
vid_groups = defaultdict(list)
for e in proactive:
    vid_groups[e.get("bvid")].append(e)
print("\n=== 同一视频被接话多条 ===")
for bvid, lst in vid_groups.items():
    if len(lst) > 1:
        rounds = [str(x.get("round",""))[:19] for x in lst]
        print(f"  {bvid}: {len(lst)} 次, rounds={rounds}")

# 6) reply-in 事件（别人回复我）与 followup 的对应：跟进的目标是否都是 reply-in 的 rpid？
reply_in_rpids = {e.get("rpid") for e in events if e.get("type") == "reply-in"}
followup_parents = {e.get("parent") for e in followup}
orphan = followup_parents - reply_in_rpids
print(f"\nreply-in 事件数: {len([e for e in events if e.get('type')=='reply-in'])}")
print(f"跟进回复的 parent 不在 reply-in 集合里的: {len(orphan)}")
for p in list(orphan)[:10]:
    print("  orphan parent:", p)
