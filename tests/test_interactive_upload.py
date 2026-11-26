import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["BILI_MCP_TOOLS"] = "bili_login,bili_login_check,bili_check_credential,bili_video_zones,bili_upload_video,bili_upload_video_multi"
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from bilibili_api import Credential
from bilibili_api.utils.network import Api
from bilibili_api.video_uploader import VideoUploader
import bili_choices as ext
import mcp_server as server


async def run():
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        files = [str(base / f"p{i}.mp4") for i in range(3)]
        subprocess.run(["ffmpeg", "-loglevel", "error", "-f","lavfi","-i",
                        "color=c=blue:s=320x180:r=5","-t","1","-c:v","mpeg4",files[0]],check=True)
        for path in files[1:]:
            Path(path).write_bytes(Path(files[0]).read_bytes())
        titles = ["起点", "解释", "结尾"]
        raw = [dict(from_page=1, text="求证", to_page=2), dict(from_page=1, text="继续", to_page=3),
               dict(from_page=2,text="继续阅读",to_page=3),dict(from_page=2,text="回看",to_page=1)]
        input_args = dict(video_paths=files, page_titles=titles, title="offline",choices=raw,preview=True)
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1",
                   BILI_CRED_FILE=str(base / "unused.json"))
        params = StdioServerParameters(command=sys.executable,args=["-B",str(ROOT / "mcp_server.py")],env=env)
        async with stdio_client(params) as (reader,writer), ClientSession(reader,writer) as client:
            await client.initialize()
            tools=(await client.list_tools()).tools
            tool=next(t for t in tools if t.name=="bili_upload_video_multi")
            assert len(tools)==6 and "choices" in tool.inputSchema["properties"]
            reply=await client.call_tool(tool.name,input_args)
            parsed=json.loads(reply.content[0].text)
            assert parsed["status"]=="preview" and parsed["media"][1]["dimension"]["width"]==320, parsed
            invalid=await client.call_tool(tool.name,dict(input_args,choices=[raw[0],raw[0]]))
            assert json.loads(invalid.content[0].text)["success"] is False
            print("PASS stdio handshake, original allowlist, live tool schema, media preview, invalid route",flush=True)
        choices=[ext.Choice(**c) for c in raw]
        calls=[]
        stub_pages=[dict(cid=777+i,title=t) for i,t in enumerate(titles)]
        ready=False
        async def api_request(api, raw=False, **kwargs):
            if "archive/view" in api.url:
                return {"videos":list(reversed(stub_pages)) if ready else []}
            if "graph/save" in api.url:
                assert raw and api.data["preview"] == 0
                graph=json.loads(api.data["data"])["graph"]
                assert graph["aid"]==server.video.Video(bvid="BV17x411w7KC").get_aid()
                root=graph["nodes"][0]
                assert [n["cid"] for n in graph["nodes"]]==[777,778,779]
                assert [e["title"] for e in root["edges"]]==["求证","继续"]
                assert [e["to_node_id"] for e in root["edges"]]==[n["id"] for n in graph["nodes"][1:]]
                assert graph["nodes"][1]["edges"][1]["to_node_id"]==root["id"]
                assert graph["nodes"][2]["edges"]==[]
                assert json.loads(graph["script"])["hasGoto"]
                calls.append("graph")
                return {"code":0, "data":None}
            assert api.data["interactive"]==1 and [v["title"] for v in api.data["videos"]]==titles
            calls.append("archive")
            return {"bvid":"BV17x411w7KC"}
        cred=Credential(sessdata="offline",bili_jct="offline",dedeuserid="101")
        with (patch.object(Api,"request",api_request),
              patch("bilibili_api.video_uploader._choose_line",AsyncMock(return_value=None)),
              patch.object(VideoUploader,"_upload_page",AsyncMock(side_effect=[
                  {"filename":f"part{i}","cid":777+i} for i in range(3)])),
              patch.object(VideoUploader,"_upload_cover",AsyncMock(return_value="offline")),
              patch.object(server,"CRED_FILE",base/"unused.json"),
              patch.object(server,"get_cred",return_value=cred),
              patch.object(server,"_extract_cover_from_video",AsyncMock(return_value=ext.Picture()))):
            args=dict(input_args,choices=choices,preview=False)
            first=json.loads(await server.bili_upload_video_multi(**args))
            assert first["status"]=="story_pending",first
            assert first["bvid"]=="BV17x411w7KC",first
            ready=True
            second=json.loads(await server.bili_upload_video_multi(**args,resume_bvid=first["bvid"]))
            assert second["status"]=="story_submitted",second
            again=json.loads(await server.bili_upload_video_multi(**args))
            assert again["cached"] and calls==["archive","graph"],(again,calls)
            print("PASS simulated HTTP archive, delayed CIDs, merge/back edge, graph submission, retry deduplication",flush=True)


if __name__=="__main__":
    asyncio.run(run())
