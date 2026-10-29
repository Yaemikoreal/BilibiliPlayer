# -*- coding: utf-8 -*-
"""按时间线导出 reply-in / reply-out / reply-scan / round 事件。"""
import json

from _fenshen_paths import ledger_events, require_ledger

LEDGER = require_ledger()
events = ledger_events(LEDGER)

# 只看 2026-10-29
evs = [e for e in events if str(e.get("t", "")).startswith("2026-10-29")]
evs.sort(key=lambda e: str(e.get("t", "")))

interesting = {"reply-in", "reply-out", "reply-scan", "round-end", "round-start", "note"}
for e in evs:
    t = e.get("type", "?")
    if t not in interesting:
        continue
    ts = str(e.get("t", ""))[11:19]
    rnd = str(e.get("round", ""))[11:19]
    line = f"{ts} r={rnd} {t:11s}"
    if t == "reply-in":
        line += f" bvid={e.get('bvid')} 对方rpid={e.get('rpid')} 我方rpid={e.get('parent')} from={e.get('from')} text={str(e.get('text',''))[:24]} notifId={e.get('notifId')}"
    elif t == "reply-out":
        line += f" bvid={e.get('bvid')} parent(对方)={e.get('parent')} 自己rpid={e.get('rpid')} kind={e.get('kind','-')} src={e.get('source','-')} text={str(e.get('text',''))[:24]}"
    elif t == "reply-scan":
        line += f" bvid={e.get('bvid')} decision={e.get('decision')} target={e.get('targetRpid')} posted={e.get('postedRpid')} src={e.get('source','-')} cands={len(e.get('candidates',[]))}"
    elif t == "round-end":
        line += f" code={e.get('code')} dur={e.get('durationMs')}"
    elif t == "note":
        line += f" note={str(e.get('note',''))[:60]}"
    print(line)
