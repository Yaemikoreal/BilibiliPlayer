# -*- coding: utf-8 -*-
"""B站分身运维脚本的公共路径与账本读取。

家目录口径必须与插件/ MCP 侧一致（改这里等于同时改 scripts/ 下所有脚本的落点）：
  1. 环境变量 `BILI_FENSHEN_HOME`（插件值班轮、MCP 记账工具都认它）
  2. 否则 `~/.dsh/bili-fenshen`

⚠️ 不要在任何脚本里再写死 `C:\\Users\\<某人>\\.dsh\\...`：
   2026-10-29 的测试报告（§3.3）就是因为 4 个脚本硬编码了另一台机器的用户名，
   在本机全部 `FileNotFoundError`。
"""
import json
import os
from pathlib import Path


def fenshen_home() -> Path:
    """插件家目录（与 dsh-plugin/index.js 的 HOME、mcp_server.py 的 _persona_home 同源）。"""
    env = str(os.environ.get("BILI_FENSHEN_HOME") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".dsh" / "bili-fenshen"


def ledger_path() -> Path:
    """账本绝对路径：<家目录>/ledger.jsonl。"""
    return fenshen_home() / "ledger.jsonl"


def require_ledger() -> Path:
    """取账本路径；不存在时直接给人话报错（而不是抛裸 FileNotFoundError）。"""
    p = ledger_path()
    if not p.is_file():
        raise SystemExit(
            f"找不到账本：{p}\n"
            "  ① 已经跑过值班轮吗？（账本第一行由值班轮写入）\n"
            "  ② 家目录在别的盘/别的用户下？用环境变量指过去："
            "BILI_FENSHEN_HOME=<你的 .dsh/bili-fenshen 路径>"
        )
    return p


def _salvage_objects(line: str):
    """从一行里捞出所有顶层 JSON 对象（字符串/转义敏感）——与 lib/ledger.js 的 salvageObjects 同算法。

    为什么需要：章程要求「一行一个事件」，但历史上模型手写账本时一行塞了多个对象
    （2026-10-25 实测 5 行装 57 个对象）。裸 json.loads 一失败整行丢弃 ⇒ 事件凭空消失、
    配额统计跟着错。宁可多救回几条，也不要让一行格式不整把整批账销掉。
    """
    out = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(line):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
            continue
        if ch == "}":
            if depth > 0:
                depth -= 1
            if depth == 0 and start >= 0:
                try:
                    out.append(json.loads(line[start:i + 1]))
                except Exception:
                    pass  # 这一段坏了就丢这一段
                start = -1
    return out


def ledger_events(path=None):
    """读账本 → 事件列表（BOM 容忍 + 一行多对象 salvage，口径与 lib/ledger.js 一致）。

    `encoding="utf-8-sig"` 是必须的：Windows 下用 PowerShell 写过首行的账本会带 BOM，
    裸 utf-8 会让**第一行**解析失败（2026-10-29 实测：本机账本因此少读 58 条事件）。
    """
    p = Path(path) if path else require_ledger()
    if not p.is_file():
        raise SystemExit(f"找不到账本：{p}（用 BILI_FENSHEN_HOME 指向插件家目录）")
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        one = None
        try:
            one = json.loads(line)
        except Exception:
            one = None
        candidates = [one] if isinstance(one, dict) else _salvage_objects(line)
        for ev in candidates:
            if isinstance(ev, dict) and isinstance(ev.get("type"), str):
                out.append(ev)
    return out
