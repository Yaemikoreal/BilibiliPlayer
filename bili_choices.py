"""Bilibili interactive archives and native end-of-scene choices."""
import asyncio
from collections import deque
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

from bilibili_api.interactive_video import InteractiveVideo
from bilibili_api.utils.network import Api
from bilibili_api.utils.picture import Picture
from bilibili_api.video_uploader import VideoMeta, VideoUploader, VideoUploaderPage
from pydantic import BaseModel, ConfigDict, Field


class Choice(BaseModel):
    """分 P 编号从 1 开始，text 是观众看到的按钮文字。"""
    model_config = ConfigDict(extra="forbid")
    from_page: int = Field(ge=1, strict=True)
    text: str = Field(min_length=1)
    to_page: int = Field(ge=1, strict=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def route_plan(titles, choices):
    if not 3 <= len(titles) <= 200 or len(set(titles)) != len(titles):
        raise ValueError("请提供 3–200 个分 P，并给每个分 P 唯一标题，以便绑定 CID。")
    if any(not t.strip() or len(t) > 80 for t in titles):
        raise ValueError("分 P 标题应为 1–80 个字符。")
    routes = {page: [] for page in range(1, len(titles) + 1)}
    for choice in choices:
        start, end, label = choice.from_page, choice.to_page, choice.text.strip()
        if start not in routes or end not in routes or not label:
            raise ValueError(f"无效选项 P{start} → P{end}，请检查文字和分 P 编号。")
        if any(edge[0] == label for edge in routes[start]):
            raise ValueError(f"P{start} 有重复按钮「{label}」。")
        if len(routes[start]) >= 4:
            raise ValueError(f"P{start} 超出此版本支持的 4 个底部选项。")
        routes[start].append((label, end))
    if not any(len(edges) >= 2 for edges in routes.values()):
        raise ValueError("至少一个分 P 需要两个可选按钮。")
    reached, queue, direct = {1}, deque([1]), set()
    while queue:
        page = queue.popleft()
        for index, (_, end) in enumerate(routes[page]):
            if end not in reached:
                direct.add((page, index))
                reached.add(end)
                queue.append(end)
    if len(reached) != len(routes):
        raise ValueError(f"从 P1 无法到达这些分 P：{sorted(set(routes) - reached)}")
    if len(routes) + len(choices) - len(direct) > 200:
        raise ValueError("分 P 和汇合或回跳所需的跳转模块合计超过 200。")
    return routes, direct


def media_info(path):
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
           "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", path]
    proc = subprocess.run(cmd, capture_output=True, timeout=40)
    if proc.returncode:
        raise ValueError(f"ffprobe 无法读取视频：{path}")
    info = json.loads(proc.stdout)
    if not info.get("streams"):
        raise ValueError(f"素材缺少视频轨道：{path}")
    stream = info["streams"][0]
    w, h = stream["width"], stream["height"]
    rotation = next((s["rotation"] for s in stream.get("side_data_list", []) if "rotation" in s), 0)
    if round(rotation) % 180 == 90:
        w, h = h, w
    seconds = float(info["format"].get("duration", 0))
    if w < h or w <= 0 or h <= 0 or not math.isfinite(seconds) or seconds <= 0:
        raise ValueError(f"请检查画幅和时长，互动视频需要非竖屏素材：{path}")
    return {"dimension": {"width": w, "height": h}, "duration": round(seconds * 1000)}


def compile_tree(aid, titles, routes, direct, media, cids):
    # Native editor format described by phigrey/bilibili-storytree.
    # Each editor video node has one parent. Additional incoming edges use goto nodes.
    nodes, links, playback = {}, {}, {}
    def add_node(number, kind, data, root=False):
        key = f"n-{number:010x}"
        nodes[key] = dict(id=key, type=kind, data=data, isRoot=root,
                          input=[], output=[], refInput=[], refOutput=[])
        return key

    def add_link(kind, start, end, data):
        key = f"l-{len(links) + 1:010x}"
        links[key] = {"id": key, "type": kind, "from": start, "to": end, "data": data}
        ref = kind == "refLink"
        nodes[start]["refOutput" if ref else "output"].append(key)
        nodes[end]["refInput" if ref else "input"].append(key)
        return key

    keys = {}
    for page, title in enumerate(titles, 1):
        count = len(routes[page])
        cid = cids[page - 1]
        info = dict(media[page - 1], type=999 if count == 1 else int(count > 0),
                    aid="", cid=cid, name=title, index=page - 1, showTime=0, innerOptions=[])
        key = keys[page] = add_node(page, "videoNode", info, page == 1)
        playback[page] = dict(id=key, cid=cid, name=title, is_start=int(page == 1),
                              show_time=0 if count == 1 else -1, otype=1, edges=[])
    has_goto = False
    for page, edges in routes.items():
        for index, (label, end) in enumerate(edges):
            target = keys[end]
            if (page, index) not in direct:
                has_goto = True
                jump = add_node(len(nodes) + 1, "gotoNode", {})
                add_link("refLink", jump, target, {})
                target = jump
            data = dict(text=label, default=index == 0, point=dict(x=0, y=0, align=2),
                        conditions=[], actions=[])
            key = add_link("flowLink", keys[page], target, data)
            data["id"] = key
            playback[page]["edges"].append(dict(id=key, title=label, is_default=int(index == 0),
                                                condition=[], attribute=[], to_node_id=keys[end]))
    variables = [dict(id=f"v-{i:010x}", name=f"数值{i}" if i < 5 else "随机值",
                      type=1 if i < 5 else 2, initValue=int(i == 5),
                      initValue2=100 if i == 5 else 0, displayable=False) for i in range(1, 6)]
    regional = [dict(id=v["id"], name=v["name"], type=v["type"], init_min=v["initValue"],
                     init_max=v["initValue2"], is_show=0) for v in variables]
    script = dict(nodes=nodes, links=links, hasGoto=has_goto, editorVersion="1.4.6",
                  createdTime=round(time.time()*1000), currentThemeId=0,
                  enableVariables=False, variables=variables)
    return {"graph": dict(aid=aid, skin_id=0, regional_vars=regional, nodes=list(playback.values()),
                          script=json.dumps(script, ensure_ascii=False))}


def bind_pages(info, titles, aid):
    rows = info.get("videos") or []
    archive = info.get("archive") or {}
    if archive.get("aid") is not None and int(archive["aid"]) != aid:
        raise ValueError("创作中心返回的稿件 ID 不匹配。")
    if "interactive" in archive and str(archive["interactive"]) != "1":
        raise ValueError("创作中心没有把此稿件标记为互动视频。")
    if len(rows) != len(titles) or {row.get("title") for row in rows} != set(titles):
        raise ValueError("创作中心分 P 标题尚未就绪，或与本次素材不匹配。")
    by_title = {row["title"]: row for row in rows}
    if any(int(row.get("aid") or aid) != aid for row in rows):
        raise ValueError("分 P 所属稿件不匹配。")
    cids = [int(by_title[t].get("cid") or 0) for t in titles]
    if min(cids) <= 0 or len(set(cids)) != len(cids):
        raise ValueError("分 P 尚无可用的独立 CID，等待转码后再次调用。")
    return cids


async def save_tree(credential, tree):
    # The installed SDK expands a URL-encoded string as kwargs in up_submit_story_tree.
    # Supply the actual form mapping to its HTTP client so it is encoded exactly once.
    api = Api(url="https://api.bilibili.com/x/stein/graph/save", method="POST",
              verify=True, credential=credential)
    api.update_headers(Referer="https://member.bilibili.com", **{"User-Agent": "Mozilla/5.0"})
    api.update_data(preview=0, data=json.dumps(tree, ensure_ascii=False))
    response = await api.request(raw=True)
    if not isinstance(response, dict) or response.get("code") != 0:
        raise RuntimeError(f"剧情树提交未获确认：{(response or {}).get('message', '无有效回执')}")


@contextmanager
def job_lock(path):
    with path.open("a+b") as handle:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise ValueError("同一投稿任务正在运行，请等待现有调用结束。") from exc
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ValueError("同一投稿任务正在运行，请等待现有调用结束。") from exc
        # Both OS locks are released when the file handle closes, including process exit.
        yield


def checkpoint(path, state):
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


async def interactive_upload(*, paths, titles, title, desc, tid, tags, cover, source, choices,
                             preview, resume_bvid, retry_upload, credential_fn, cover_fn, state_dir):
    titles = [t.strip() for t in titles]
    title = title.strip()
    paths = [str(Path(p).resolve()) for p in paths]
    if len(paths) != len(titles) or not title or len(title) > 80:
        raise ValueError("请提供 1–80 字的投稿标题，并逐一对应素材和分 P 标题。")
    routes, direct = route_plan(titles, choices)
    if resume_bvid and not re.fullmatch(r"BV[0-9A-Za-z]{10}", resume_bvid):
        raise ValueError("resume_bvid 应为完整 BV 号。")
    if preview:
        media = await asyncio.to_thread(lambda: [media_info(p) for p in paths])
        return dict(status="preview", published=False, pages=titles, choices=routes, media=media)
    cred = credential_fn()
    job = digest([cred.dedeuserid or digest(cred.sessdata), title, titles, paths])
    state_dir.mkdir(parents=True, exist_ok=True)
    record = state_dir / (job + ".json")
    graph_hash = digest(routes)
    with job_lock(record.with_suffix(".lock")):
        state = json.loads(record.read_text(encoding="utf-8")) if record.exists() else {}
        bvid = state.get("bvid") or resume_bvid
        if resume_bvid and state.get("bvid") and resume_bvid != state["bvid"]:
            raise ValueError("恢复用 BV 号与本机记录不一致。")
        if state.get("phase") == "submitted" and state.get("graph_hash") == graph_hash:
            return dict(status="story_submitted", bvid=bvid, cached=True)
        if state.get("phase") == "submitted" and not resume_bvid:
            raise ValueError(f"该素材已投稿为 {bvid}。如需更新选项，请明确传入此 resume_bvid。")
        if state.get("phase") == "uploading" and not bvid and not retry_upload:
            return dict(status="check_archive", message="上次建稿结果未知。请核对创作中心；如已建稿，传入 resume_bvid。如确认没有建稿，可设置 retry_upload=true。")
        media = state.get("media") or await asyncio.to_thread(lambda: [media_info(p) for p in paths])
        if not bvid:
            cover_pic = Picture.from_file(cover) if cover else await cover_fn(paths[0])
            pages = [VideoUploaderPage(path=p, title=t, description="") for p, t in zip(paths, titles)]
            meta = VideoMeta(title=title, desc=desc, tid=tid, tags=[t.strip() for t in tags.split(",") if t.strip()],
                             cover=cover_pic, original=not bool(source), source=source or None).__dict__()
            meta["interactive"] = 1
            state = dict(phase="uploading_files", media=media)
            class InteractiveUploader(VideoUploader):
                async def _submit(self, videos, cover_url=""):
                    state["phase"] = "uploading"
                    checkpoint(record, state)
                    return await super()._submit(videos, cover_url)
            uploader = InteractiveUploader(pages=pages, meta=meta, cover=cover_pic, credential=cred)
            try:
                result = await uploader.start()
                bvid = result["bvid"]
                if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
                    raise ValueError("服务器未返回有效 BV 号。")
            except Exception as exc:
                if state["phase"] == "uploading_files":
                    return dict(status="upload_failed", message="分 P 或封面上传失败，可以重试。", error=str(exc))
                return dict(status="check_archive", message="请核对创作中心是否已建稿，再恢复任务。", error=str(exc))
            state.update(phase="archive_created", bvid=bvid)
            checkpoint(record, state)
        try:
            video = InteractiveVideo(bvid=bvid, credential=cred)
            info = await video.up_get_ivideo_pages()
            if resume_bvid and not state.get("bvid"):
                archive = info.get("archive") or {}
                if archive.get("title") != title or str(archive.get("interactive")) != "1":
                    raise ValueError("恢复前需要创作中心确认此 BV 是标题匹配的互动稿件。")
            cids = bind_pages(info, titles, video.get_aid())
            tree = compile_tree(video.get_aid(), titles, routes, direct, media, cids)
            await save_tree(cred, tree)
        except Exception as exc:
            return dict(status="story_pending", bvid=bvid, error=str(exc),
                        next_step="核对分 P 和剧情树状态；使用相同参数和此 resume_bvid 继续，仅提交剧情树。")
        checkpoint(record, dict(phase="submitted", bvid=bvid, media=media, graph_hash=graph_hash))
        return dict(status="story_submitted", bvid=bvid, pages=len(titles), choices=len(choices))
