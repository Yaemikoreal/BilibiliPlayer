# mcp bili_persona_note 冒烟：结构预检 / 追加 pending / 分层正确（工具侧不做真实性质检）
import asyncio, json, os, tempfile
os.environ["BILI_FENSHEN_HOME"] = os.path.join(tempfile.gettempdir(), "bf-mcp-smoke")
import importlib.util
spec = importlib.util.spec_from_file_location("mcp_server", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mcp_server.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# 1 结构错误：form 非法
r1 = asyncio.run(mod.bili_persona_note(kind="corpus", form="nope", text="x"))
assert json.loads(r1)["success"] is False, r1
# 2 community 缺 source
r2 = asyncio.run(mod.bili_persona_note(kind="corpus", form="meme", text="电子榨菜", origin="community"))
assert json.loads(r2)["success"] is False, r2
# 3 合法 corpus
r3 = asyncio.run(mod.bili_persona_note(kind="corpus", form="meme", text="电子榨菜", origin="community", source="社区通用梗"))
assert json.loads(r3)["success"] is True, r3
# 4 合法 lore
r4 = asyncio.run(mod.bili_persona_note(kind="lore", id="smoke-entry", keys=["测试"], oneLine="冒烟见闻", body="正文"))
assert json.loads(r4)["success"] is True, r4
# 5 真实性词表宿主管——工具侧放行（分层正确）
pf = os.path.join(os.environ["BILI_FENSHEN_HOME"], "persona", "growth-pending.jsonl")
lines = [json.loads(l) for l in open(pf, encoding="utf-8") if l.strip()]
assert len(lines) == 2, lines
assert lines[0]["text"] == "电子榨菜" and lines[1]["id"] == "smoke-entry"
print("MCP SMOKE ALL GREEN")
