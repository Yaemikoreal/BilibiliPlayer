#!/usr/bin/env python3
"""
Bilibili MCP Server
B站数据采集 MCP 服务，支持 OpenClaw / Claude Code / Cursor / Cline

功能：搜索视频、抓取评论、获取字幕、弹幕、回复评论
首次运行需扫码登录B站，凭证自动保存复用
"""

import asyncio
import json
import base64
import logging
import aiohttp
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from mcp.server.fastmcp import FastMCP

from bilibili_api import video, search, comment, Credential, dynamic
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# ========== 初始化 ==========

# 凭证路径可经环境变量覆盖（DSH 插件用独立文件隔离小号凭证；未设 = 项目根目录默认值）
CRED_FILE = Path(os.environ.get("BILI_CRED_FILE") or (Path(__file__).parent / "bili_credential.json"))

mcp = FastMCP("bilibili-mcp")

# ========== 白名单门禁（BILI_MCP_TOOLS：逗号分隔的工具名单；未设 = 全量注册，兼容既有用法） ==========

_ALLOWED_TOOLS = os.environ.get("BILI_MCP_TOOLS", "").strip()
_ALLOWED_SET = (
    {t.strip() for t in _ALLOWED_TOOLS.split(",") if t.strip()} if _ALLOWED_TOOLS else None
)


def _gated_tool(*tool_args, **tool_kwargs):
    """mcp.tool() 的门禁包装：名单外工具不注册，模型不可见（最小授权）。"""

    def deco(fn):
        if _ALLOWED_SET is not None and fn.__name__ not in _ALLOWED_SET:
            return fn
        return mcp.tool(*tool_args, **tool_kwargs)(fn)

    return deco

# ========== 日志（输出到 stderr，避免污染 stdio 协议通道） ==========

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("bilibili-mcp")


# ========== 通用helper：统一返回格式 / 凭证读取 / 标题清洗 / 图片上传 ==========

def _ok(data: dict) -> str:
    """统一成功返回"""
    return json.dumps(data, ensure_ascii=False)


def _err(error: str, **extra) -> str:
    """统一错误返回：记录日志 + {"success": false, "error": ...}"""
    logger.error("%s | %s", error, extra or "")
    payload = {"success": False, "error": error}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


def _load_cred_data() -> dict:
    """读取凭证文件原始数据（文件不存在、损坏或格式异常时返回空dict）"""
    if not CRED_FILE.exists():
        return {}
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        logger.error("凭证文件读取失败: %s", e)
        return {}
    if not isinstance(data, dict):
        logger.error("凭证文件格式错误: 期望对象，实际为 %s", type(data).__name__)
        return {}
    return data


def _save_credential(cred: Credential) -> None:
    """原子写入凭证，避免进程中断留下半截 JSON"""
    tmp = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "sessdata": cred.sessdata,
            "bili_jct": cred.bili_jct,
            "buvid3": cred.buvid3,
            "dedeuserid": cred.dedeuserid,
        }, f, ensure_ascii=False)
    os.replace(tmp, CRED_FILE)


async def _cred_is_valid(cred: Credential) -> bool:
    """请求用户信息校验凭证是否仍然有效"""
    uid = str(cred.dedeuserid or "").strip()
    if not uid.isdigit():
        return False
    try:
        await user.User(uid=int(uid), credential=cred).get_user_info()
        return True
    except Exception as e:
        logger.info("凭证有效性校验失败: %s", e)
        return False


def load_credential() -> Credential | None:
    """从文件加载凭证"""
    data = _load_cred_data()
    if not data:
        return None
    return Credential(
        sessdata=data.get("sessdata") or "",
        bili_jct=data.get("bili_jct") or "",
        buvid3=data.get("buvid3") or "",
        dedeuserid=str(data.get("dedeuserid") or ""),
    )


def _clean_title(t: str) -> str:
    """去掉搜索结果标题中的关键词高亮标签"""
    return (t or "").replace('<em class="keyword">', "").replace("</em>", "")


async def _add_images_to_dynamic(dyn, images: list[str]) -> str | None:
    """向动态添加图片（本地路径或URL，最多9张）；成功返回 None，失败返回错误信息"""
    for img_path in (images or [])[:9]:
        img_path = (img_path or "").strip()
        if not img_path:
            continue
        try:
            if img_path.startswith(("http://", "https://")):
                pic = await Picture.load_url(img_path)
            else:
                if not os.path.isfile(img_path):
                    return f"图片文件不存在: {img_path}"
                pic = Picture.from_file(img_path)
            dyn.add_image(pic)
        except Exception as e:
            return f"图片处理失败: {img_path} - {e}"
    return None


# ========== 登录会话（进程级缓存） ==========

QR_FILE = Path(__file__).parent / "qrcode_login.png"

_login_session: QrCodeLogin | None = None


def _cleanup_qr_file() -> None:
    """删除临时二维码图片"""
    if QR_FILE.exists():
        QR_FILE.unlink()


def get_cred() -> Credential:
    """获取凭证，未登录或凭证不完整时给出明确指引（唯一以异常上报的错误）"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    if not (cred.sessdata and cred.bili_jct and cred.dedeuserid):
        raise Exception("本地凭证不完整（缺少 sessdata/bili_jct/dedeuserid），请删除 bili_credential.json 后重新调用 bili_login 登录。")
    return cred


# ========== Tool: 扫码登录（生成二维码） ==========

@_gated_tool()
async def bili_login(force: bool = False) -> str:
    """
    生成B站登录二维码，返回二维码图片（base64）供用户扫码。
    用户扫码后，调用 bili_login_check 检查登录状态。

    Args:
        force: 为 True 时忽略本地已有凭证，强制重新扫码登录（凭证过期或换号时使用）

    Returns:
        包含二维码base64图片数据的JSON，前端可直接渲染为图片展示给用户
    """
    global _login_session

    # 已有有效凭证时无需重复登录；凭证失效则自动重新扫码
    if not force:
        cred = load_credential()
        if cred and await _cred_is_valid(cred):
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站，无需重复登录；如需换号请传 force=true",
            }, ensure_ascii=False)

    # 生成新的登录会话
    try:
        _login_session = QrCodeLogin()
        await _login_session.generate_qrcode()
    except Exception as e:
        _login_session = None
        return _err(f"生成登录二维码失败: {e}")

    # 获取二维码图片的 base64（无损PNG）
    pic = _login_session.get_qrcode_picture()
    img_base64 = base64.b64encode(pic.content).decode("utf-8")

    # 保存二维码图片到项目根目录
    with open(QR_FILE, "wb") as f:
        f.write(pic.content)

    # 获取终端文本版二维码（纯文本客户端备用）
    terminal_qr = _login_session.get_qrcode_terminal()

    # 获取原始扫码URL（用户也可以手动在B站App打开）
    qr_url = getattr(_login_session, "_QrCodeLogin__qr_link", "")

    return json.dumps({
        "status": "qrcode_ready",
        "message": "请用B站App扫描二维码登录（180秒内有效）",
        "qrcode_image": f"data:image/png;base64,{img_base64}",
        "qrcode_file": str(QR_FILE),
        "qrcode_terminal": terminal_qr,
        "qrcode_url": qr_url,
        "next_step": "用户扫码后，请调用 bili_login_check 检查登录状态",
    }, ensure_ascii=False)


# ========== Tool: 检查登录状态 ==========

@_gated_tool()
async def bili_login_check() -> str:
    """
    检查B站扫码登录状态。在用户扫码后调用此工具。
    如果返回 "scanning" 或 "confirming"，请等待几秒后再次调用。
    如果返回 "done"，登录成功，可以使用其他工具了。
    如果返回 "timeout"，需要重新调用 bili_login 生成新二维码。

    Returns:
        当前登录状态
    """
    global _login_session

    if not _login_session:
        # 没有登录会话，检查是否已登录
        cred = load_credential()
        if cred and await _cred_is_valid(cred):
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站",
            }, ensure_ascii=False)
        return json.dumps({
            "status": "no_session",
            "message": "没有进行中的登录，请先调用 bili_login 生成二维码",
        }, ensure_ascii=False)

    try:
        state = await _login_session.check_state()
    except Exception as e:
        return _err(f"检查登录状态失败: {e}")

    if state == QrCodeLoginEvents.SCAN:
        return json.dumps({
            "status": "scanning",
            "message": "已扫码，等待用户在手机上确认...",
            "next_step": "请等待3秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.CONF:
        return json.dumps({
            "status": "confirming",
            "message": "用户已确认，正在处理...",
            "next_step": "请等待2秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.TIMEOUT:
        _login_session = None
        _cleanup_qr_file()
        return json.dumps({
            "status": "timeout",
            "message": "二维码已过期，请重新调用 bili_login 生成新二维码",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.DONE:
        # 登录成功，保存凭证
        try:
            _save_credential(_login_session.get_credential())
        except Exception as e:
            return _err(f"保存登录凭证失败: {e}")
        _login_session = None
        _cleanup_qr_file()
        return json.dumps({
            "status": "done",
            "message": "登录成功！凭证已保存，现在可以使用所有B站功能了",
        }, ensure_ascii=False)

    return json.dumps({
        "status": "unknown",
        "message": f"未知状态: {state}",
    }, ensure_ascii=False)


# ========== Tool: 登录状态查询 ==========

@_gated_tool()
async def bili_check_credential() -> str:
    """
    检查当前B站登录凭证是否有效

    Returns:
        登录状态信息
    """
    cred = load_credential()
    if not cred:
        return json.dumps({
            "logged_in": False,
            "message": "未登录，请调用 bili_login 进行扫码登录",
        }, ensure_ascii=False)

    # 尝试用凭证请求一下，验证是否过期
    if not str(cred.dedeuserid or "").strip().isdigit():
        return json.dumps({
            "logged_in": False,
            "message": "凭证缺少 dedeuserid（不完整），请重新调用 bili_login 登录",
        }, ensure_ascii=False)
    try:
        my_info = await user.User(
            uid=int(cred.dedeuserid), credential=cred
        ).get_user_info()
        return json.dumps({
            "logged_in": True,
            "uid": cred.dedeuserid,
            "username": my_info.get("name", ""),
            "message": "凭证有效",
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "logged_in": False,
            "message": f"凭证可能已过期: {str(e)}，请重新调用 bili_login 登录",
        }, ensure_ascii=False)


# ========== Tool 1: 搜索视频 ==========

@_gated_tool()
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank") -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    num = max(1, min(num, 50))
    try:
        videos = []
        page = 1
        # 分页抓取直到凑满num条（单页结果不足时自动停止）
        while len(videos) < num and page <= 5:
            result = await search.search_by_type(
                keyword=keyword,
                search_type=search.SearchObjectType.VIDEO,
                page=page,
                order_type=order_enum,
            )
            items = result.get("result", []) or []
            if not items:
                break
            for item in items:
                videos.append({
                    "bvid": item.get("bvid", ""),
                    "aid": item.get("aid", 0),
                    "title": _clean_title(item.get("title", "")),
                    "author": item.get("author", ""),
                    "play": item.get("play", 0),
                    "review": item.get("review", 0),
                    "danmaku": item.get("video_review", 0),
                    "duration": item.get("duration", ""),
                    "description": item.get("description", "")[:200],
                })
                if len(videos) >= num:
                    break
            page += 1
            await asyncio.sleep(0.3)
        return _ok({"keyword": keyword, "count": len(videos), "videos": videos})
    except Exception as e:
        return _err(f"搜索失败: {e}", keyword=keyword)


# ========== Tool 2: 获取评论 ==========

async def _fetch_comments(aid: int, cred: Credential, num: int) -> dict:
    """按点赞序抓取视频评论，返回 {"comments": [...], "error": str|None}（内部helper，供 bili_comments / bili_crawl 复用）"""
    comments = []
    page = 1
    last_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    "time": r.get("ctime", 0),
                }
                # 子评论
                sub_replies = []
                for sub in (r.get("replies") or [])[:2]:
                    sub_replies.append({
                        "user": sub.get("member", {}).get("uname", ""),
                        "content": sub.get("content", {}).get("message", ""),
                        "like": sub.get("like", 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            last_error = f"评论抓取在第{page}页中断: {e}"
            logger.warning("评论抓取中断(oid=%s, page=%s): %s", aid, page, e)
            break
    return {"comments": comments, "error": last_error}


@_gated_tool()
async def bili_comments(bvid: str, num: int = 30) -> str:
    """
    获取B站视频的热门评论

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
    
    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
    """
    num = max(1, min(num, 100))
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    try:
        info = await v.get_info()
    except Exception as e:
        return _err(f"获取视频信息失败: {e}", bvid=bvid)
    aid = info["aid"]

    data = await _fetch_comments(aid, cred, num)
    payload = {"bvid": bvid, "count": len(data["comments"][:num]), "comments": data["comments"][:num]}
    if data.get("error"):
        payload["partial"] = True
        payload["error"] = data["error"]
    return json.dumps(payload, ensure_ascii=False)


# ========== Tool 3: 获取字幕 ==========

async def _fetch_subtitle(bvid: str, cred: Credential) -> dict:
    """获取字幕数据（内部helper，供 bili_subtitle / bili_crawl 复用）"""
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = info["pages"][0].get("cid", 0)

    if not cid:
        raise ValueError("无法获取cid，该视频可能不支持字幕提取")

    subtitle_list = await v.get_subtitle(cid=cid)
    subtitles = subtitle_list.get("subtitles", [])

    if not subtitles:
        return {"title": info.get("title", ""), "language": "", "segments": 0, "text": ""}

    # 优先AI中文字幕
    target = next(
        (s for s in subtitles if s.get("lan") in ("ai-zh", "zh-CN", "zh")),
        subtitles[0],
    )

    # 下载字幕（带超时、状态码检查与空URL防护）
    sub_url = (target.get("subtitle_url") or "").strip()
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    if not sub_url:
        raise ValueError("字幕下载地址为空，无法获取字幕")

    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(sub_url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"字幕下载失败，HTTP状态码 {resp.status}")
            sub_data = await resp.json(content_type=None)

    texts = [item.get("content", "") for item in sub_data.get("body", [])]
    return {
        "title": info.get("title", ""),
        "language": target.get("lan_doc", ""),
        "segments": len(texts),
        "text": "\n".join(texts),
    }


@_gated_tool()
async def bili_subtitle(bvid: str) -> str:
    """
    获取B站视频的AI字幕（语音转文字）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"

    Returns:
        视频的完整字幕文本
    """
    cred = get_cred()
    try:
        data = await _fetch_subtitle(bvid, cred)
    except Exception as e:
        return _err(f"字幕获取失败: {e}", bvid=bvid)

    if data["segments"] == 0:
        return _ok({"bvid": bvid, "message": "该视频没有字幕"})

    return _ok({"bvid": bvid, **data})


# ========== Tool 4: 获取弹幕 ==========

@_gated_tool()
async def bili_danmaku(bvid: str, num: int = 100) -> str:
    """
    获取B站视频的弹幕

    Args:
        bvid: 视频BV号
        num: 获取弹幕数量，默认100
    
    Returns:
        弹幕列表，包含弹幕文本和出现时间
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    try:
        info = await v.get_info()
        total_pages = len(info.get("pages") or []) or 1
        num = max(1, min(num, 1000))
        result = []
        # 遍历各分P直到取满num条（单分P失败不阻断其他分P）
        for page_index in range(min(total_pages, 10)):
            try:
                danmakus = await v.get_danmakus(page_index=page_index)
            except Exception as e:
                logger.warning("分P %s 弹幕获取失败: %s", page_index + 1, e)
                continue
            for d in danmakus:
                result.append({"text": d.text, "time": d.dm_time, "page": page_index + 1})
                if len(result) >= num:
                    break
            if len(result) >= num:
                break
            await asyncio.sleep(0.3)
        return _ok({"bvid": bvid, "count": len(result), "danmakus": result})
    except Exception as e:
        return _err(f"弹幕获取失败: {e}", bvid=bvid)


# ========== Tool 5: 视频详情 ==========

@_gated_tool()
async def bili_video_info(bvid: str) -> str:
    """
    获取B站视频的详细信息

    Args:
        bvid: 视频BV号
    
    Returns:
        视频标题、描述、UP主、播放量、评论数、收藏数等详细数据
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    try:
        info = await v.get_info()
    except Exception as e:
        return _err(f"获取视频信息失败: {e}", bvid=bvid)
    stat = info.get("stat", {})

    return json.dumps({
        "bvid": info.get("bvid"),
        "aid": info.get("aid"),
        "title": info.get("title"),
        "description": info.get("desc"),
        "author": info.get("owner", {}).get("name"),
        "duration": info.get("duration"),
        "pages": len(info.get("pages", [])),
        "tags": [t.get("tag_name") for t in (info.get("Tag") or info.get("Tags") or info.get("tag") or []) if t.get("tag_name")],
        "stat": {
            "view": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "favorite": stat.get("favorite", 0),
            "coin": stat.get("coin", 0),
            "like": stat.get("like", 0),
            "share": stat.get("share", 0),
        },
    }, ensure_ascii=False)


# ========== Tool 6: 回复评论 ==========

@_gated_tool()
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
    
    Returns:
        发表结果
    """
    try:
        cred = get_cred()
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        aid = info["aid"]

        if rpid == 0:
            # 发表新评论
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
            )
        else:
            # 回复评论
            # root=0 表示回复一级评论，root=rpid
            # root!=0 表示回复楼中楼，root=根评论，parent=目标评论
            actual_root = root if root != 0 else rpid
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                root=actual_root,
                parent=rpid,
                credential=cred,
            )

        return json.dumps({"success": True, "message": "评论发送成功"}, ensure_ascii=False)
    except Exception as e:
        return _err(f"评论发送失败: {e}", bvid=bvid)


# ========== Tool 7: 批量采集 ==========

@_gated_tool()
async def bili_crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 20, get_subtitles: bool = True) -> str:
    """
    批量采集：搜索B站视频并抓取每个视频的评论和字幕

    Args:
        keyword: 搜索关键词
        max_videos: 最多采集视频数，默认5
        comments_per_video: 每个视频采集评论数，默认20
        get_subtitles: 是否获取字幕，默认True
    
    Returns:
        包含视频信息、评论和字幕的完整采集数据
    """
    cred = get_cred()

    # 搜索
    try:
        search_result = await search.search_by_type(
            keyword=keyword,
            search_type=search.SearchObjectType.VIDEO,
            page=1,
            order_type=search.OrderVideo.TOTALRANK,
        )
    except Exception as e:
        return _err(f"搜索失败: {e}", keyword=keyword)

    results = []
    for item in search_result.get("result", [])[:max_videos]:
        bvid = item.get("bvid", "")
        if not bvid:
            continue

        video_data = {
            "bvid": bvid,
            "title": _clean_title(item.get("title", "")),
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
        }

        # 评论（复用搜索结果的aid，省一次视频详情请求）
        aid = item.get("aid", 0)
        if not aid:
            try:
                aid = (await video.Video(bvid=bvid, credential=cred).get_info())["aid"]
            except Exception:
                aid = 0
        comments_data = await _fetch_comments(aid, cred, comments_per_video) if aid else {"comments": [], "error": "无法获取aid"}

        # 字幕（失败不阻断，记录日志）
        subtitle_text = ""
        if get_subtitles:
            try:
                subtitle_text = (await _fetch_subtitle(bvid, cred))["text"]
            except Exception as e:
                logger.warning("字幕获取失败(bvid=%s): %s", bvid, e)

        results.append({
            "video": video_data,
            "comments": comments_data.get("comments", []),
            "comments_error": comments_data.get("error"),
            "subtitle_text": subtitle_text,
        })

        await asyncio.sleep(1)

    return json.dumps({
        "keyword": keyword,
        "video_count": len(results),
        "total_comments": sum(len(r["comments"]) for r in results),
        "results": results,
    }, ensure_ascii=False)


# ========== 辅助：封面处理 ==========

async def _grab_frame(video_path: str, second: int, out_path: str) -> bool:
    """用 ffmpeg 截取指定秒数的一帧；成功返回 True"""
    try:
        await asyncio.to_thread(
            subprocess.run,
            ["ffmpeg", "-y", "-ss", str(second), "-i", video_path,
             "-vframes", "1", "-q:v", "2", out_path],
            capture_output=True, timeout=30,
        )
    except FileNotFoundError:
        raise RuntimeError("未找到 ffmpeg，请先安装并加入 PATH")
    except subprocess.TimeoutExpired:
        logger.warning("ffmpeg 截帧超时（第%s秒）: %s", second, video_path)
        return False
    except OSError as e:
        logger.warning("ffmpeg 执行失败（第%s秒）: %s", second, e)
        return False
    return os.path.isfile(out_path) and os.path.getsize(out_path) > 0


async def _extract_cover_from_video(video_path: str) -> Picture:
    """截取视频第3秒的一帧作为封面，失败则回退到第0秒"""
    tmp_cover = os.path.join(tempfile.gettempdir(), f"bili_cover_{os.getpid()}.png")
    try:
        for second in (3, 0):
            if await _grab_frame(video_path, second, tmp_cover):
                return Picture.from_file(tmp_cover)
    finally:
        if os.path.isfile(tmp_cover):
            os.remove(tmp_cover)
    raise RuntimeError(f"无法从视频截取封面: {video_path}")




@_gated_tool()
async def bili_send_dynamic(
    text: str,
    images: list[str] | None = None,
    topic_id: int = 0,
    schedule_time: int = 0,
) -> str:
    """
    发布B站图文动态

    Args:
        text: 动态文本内容，支持@和表情（如 [doge]）
        images: 图片列表，每项可以是本地文件路径或图片URL，最多9张。为空则发布纯文字动态
        topic_id: 话题ID（可选，0表示不关联话题）
        schedule_time: 定时发布的Unix时间戳（可选，0表示立即发布）

    Returns:
        发布结果，包含动态ID
    """
    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()
    dyn.add_plain_text(text.strip())
    # 上传图片
    if images:
        img_error = await _add_images_to_dynamic(dyn, images)
        if img_error:
            return _err(img_error)

    if topic_id:
        dyn.set_topic(topic_id)

    if schedule_time > 0:
        dyn.set_send_time(schedule_time)

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "动态发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 9: 上传视频 ==========

@_gated_tool()
async def bili_upload_video(
    video_path: str,
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
    dynamic_text: str = "",
    no_reprint: bool = True,
) -> str:
    """
    上传视频到B站

    Args:
        video_path: 视频文件的本地路径
        title: 视频标题（最多80字）
        desc: 视频简介描述
        tid: 分区ID，默认124（趣味科普人文-社科·法律·心理）。
             常用分区：17=单机游戏 21=日常 95=数码 122=野生技术协会
             124=社科 160=生活记录 171=电子竞技 183=影视杂谈
             188=科技资讯 201=科学 207=财经商业 208=科技 209=手工
             230=其他(生活) 231=美食 234=健身 32=完结动画
        tags: 标签，逗号分隔，如"AI,教程,编程"（至少1个标签）
        cover_path: 封面图片路径（可选，不填则B站自动截取）
        source: 转载来源URL（非原创时必填）
        dynamic_text: 粉丝动态文本（可选，投稿时同步发布的动态内容）
        no_reprint: 是否启用未经作者授权禁止转载，默认True

    Returns:
        上传结果，包含BV号
    """
    # ---- 参数校验 ----
    if not video_path or not video_path.strip():
        return json.dumps({"success": False, "error": "video_path 不能为空，请提供视频文件的本地路径"}, ensure_ascii=False)

    video_path = video_path.strip()
    if not os.path.isfile(video_path):
        return json.dumps({"success": False, "error": f"视频文件不存在: {video_path}"}, ensure_ascii=False)

    if not title or not title.strip():
        return json.dumps({"success": False, "error": "title 不能为空"}, ensure_ascii=False)

    cred = get_cred()
    progress_info = {"phase": "初始化"}

    try:
        # 准备分P
        page = VideoUploaderPage(
            path=video_path,
            title=title.strip()[:80],
            description=(desc or "")[:250],
        )

        # 标签处理
        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
        if not tag_list:
            tag_list = ["视频"]

        # 判断原创/转载
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 自动从视频截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = await _extract_cover_from_video(video_path)

        meta = VideoMeta(
            tid=tid,
            title=title.strip()[:80],
            desc=(desc or "")[:2000],
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
            no_reprint=no_reprint if is_original else False,
            dynamic=dynamic_text.strip() if dynamic_text and dynamic_text.strip() else None,
        )

        uploader = VideoUploader(
            pages=[page],
            meta=meta,
            credential=cred,
        )

        # 上传事件回调（记录进度）
        @uploader.on("__ALL__")
        async def on_event(data: dict):
            progress_info["phase"] = str(data)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": "视频上传成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "last_phase": progress_info.get("phase", "unknown"),
        }, ensure_ascii=False)


# ========== Tool 10: 上传多P视频 ==========

@_gated_tool()
async def bili_upload_video_multi(
    video_paths: list[str],
    page_titles: list[str],
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
) -> str:
    """
    上传多P视频到B站（多个分P合并为一个投稿）

    Args:
        video_paths: 视频文件路径列表，如["/path/p1.mp4", "/path/p2.mp4"]
        page_titles: 各分P标题列表，与video_paths一一对应
        title: 视频总标题
        desc: 视频简介
        tid: 分区ID，默认124
        tags: 标签，逗号分隔
        cover_path: 封面图片路径（可选）
        source: 转载来源URL（非原创时必填）

    Returns:
        上传结果
    """
    cred = get_cred()

    if not video_paths:
        return json.dumps({"success": False, "error": "video_paths 不能为空"}, ensure_ascii=False)
    if not page_titles:
        return json.dumps({"success": False, "error": "page_titles 不能为空"}, ensure_ascii=False)
    if len(video_paths) != len(page_titles):
        return json.dumps({"success": False, "error": "video_paths 和 page_titles 数量必须一致"}, ensure_ascii=False)

    try:
        pages = []
        for i, vp in enumerate(video_paths):
            vp = (vp or "").strip()
            if not vp or not os.path.isfile(vp):
                return json.dumps({"success": False, "error": f"文件不存在: {vp}"}, ensure_ascii=False)
            pages.append(VideoUploaderPage(
                path=vp,
                title=(page_titles[i] or "").strip()[:80] or f"P{i+1}",
                description="",
            ))

        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()] or ["视频"]
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 从第一个视频自动截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = await _extract_cover_from_video(pages[0].path)

        meta = VideoMeta(
            tid=tid,
            title=(title or "").strip()[:80],
            desc=(desc or "")[:2000],
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
        )

        uploader = VideoUploader(pages=pages, meta=meta, credential=cred)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": f"多P视频上传成功（共{len(pages)}P）",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 11: 发布专栏文章 (Opus) ==========

@_gated_tool()
async def bili_send_opus(
    title: str,
    content: str,
    images: list[str] | None = None,
) -> str:
    """
    发布B站图文（以动态形式发布长图文内容）

    注意：当前通过动态接口发布，标题以【】包裹置于正文开头，
    并非独立的专栏文章；如需真正的专栏请使用B站创作中心。

    Args:
        title: 图文标题（置于正文首行）
        content: 正文内容（纯文本，段落用换行分隔）
        images: 插入的图片路径或URL列表（可选，最多9张，图片失败不阻断发布）

    Returns:
        发布结果
    """
    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()
    full_text = f"【{title}】\n\n{content}"
    dyn.add_plain_text(full_text)

    if images:
        # 图片失败不阻断发布
        await _add_images_to_dynamic(dyn, images)

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "图文发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 12: 查询分区列表 ==========

@_gated_tool()
async def bili_video_zones() -> str:
    """
    获取B站视频常用分区ID列表，供上传视频时选择tid参数

    Returns:
        常用分区ID及名称
    """
    zones = {
        "科技": {
            188: "科技资讯", 122: "野生技术协会", 95: "数码",
            208: "科技", 209: "手工",
        },
        "知识": {
            201: "科学", 124: "社科·法律·心理", 207: "财经商业",
            228: "人文历史", 36: "科技(知识)",
        },
        "生活": {
            21: "日常", 160: "生活记录", 230: "其他",
            231: "美食", 234: "健身", 161: "搞笑",
        },
        "游戏": {
            17: "单机游戏", 171: "电子竞技", 172: "手机游戏",
            65: "网络游戏",
        },
        "影视": {
            183: "影视杂谈", 138: "搞笑", 182: "影视剪辑",
        },
        "动画": {
            32: "完结动画", 33: "连载动画", 51: "MAD·AMV",
        },
        "音乐": {
            28: "原创音乐", 31: "翻唱", 59: "演奏",
        },
    }
    return json.dumps(zones, ensure_ascii=False)


# ========================================================================
#                        V1.2 — 数据分析 & 互动运营
# ========================================================================


# ========== Tool 13: 热门视频 ==========

@_gated_tool()
async def bili_hot_videos(pn: int = 1, ps: int = 20) -> str:
    """
    获取B站当前热门视频列表

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认20，最大50

    Returns:
        热门视频列表，包含标题、播放量、UP主等
    """
    try:
        result = await hot.get_hot_videos(pn=pn, ps=min(ps, 50))
    except Exception as e:
        return _err(f"获取热门视频失败: {e}")
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "desc": (item.get("desc", "") or "")[:100],
            "duration": item.get("duration", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"page": pn, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 14: 热搜关键词 ==========

@_gated_tool()
async def bili_hot_buzzwords(page_num: int = 1, page_size: int = 20) -> str:
    """
    获取B站热搜词/热门关键词

    Args:
        page_num: 页码，默认1
        page_size: 每页数量，默认20

    Returns:
        热搜词列表
    """
    try:
        result = await hot.get_hot_buzzwords(page_num=page_num, page_size=page_size)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return _err(f"获取热搜词失败: {e}")


# ========== Tool 15: 每周必看 ==========

@_gated_tool()
async def bili_weekly_hot(week: int = 0) -> str:
    """
    获取B站每周必看视频推荐

    Args:
        week: 期数（0表示获取期数列表，>0表示获取该期的视频）

    Returns:
        每周必看期数列表或指定期的视频列表
    """
    try:
        if week <= 0:
            result = await hot.get_weekly_hot_videos_list()
        else:
            result = await hot.get_weekly_hot_videos(week=week)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return _err(f"获取每周必看失败: {e}")


# ========== Tool 16: 排行榜 ==========

@_gated_tool()
async def bili_rank(category: str = "all", day: int = 3) -> str:
    """
    获取B站各分区排行榜

    Args:
        category: 分区名，可选值：
            all=全站 original=原创 rookie=新人
            douga=动画 music=音乐 dance=舞蹈 game=游戏
            knowledge=知识 technology=科技 sports=运动 car=汽车
            life=生活 food=美食 animal=动物 fashion=时尚
            ent=娱乐 cinephile=影视
            bangumi=番剧 guochuang=国创 guochuang_anime=国产动画
            documentary=纪录片 kichiku=鬼畜 movie=电影 tv=电视剧 variety=综艺
        day: 时间维度，3=三日 7=七日

    Returns:
        排行榜视频列表
    """
    type_map = {
        "all": rank.RankType.All, "original": rank.RankType.Original,
        "rookie": rank.RankType.Rookie, "douga": rank.RankType.Douga,
        "music": rank.RankType.Music, "dance": rank.RankType.Dance,
        "game": rank.RankType.Game, "knowledge": rank.RankType.Knowledge,
        "technology": rank.RankType.Technology, "sports": rank.RankType.Sports,
        "car": rank.RankType.Car, "life": rank.RankType.Life,
        "food": rank.RankType.Food, "animal": rank.RankType.Animal,
        "fashion": rank.RankType.Fashion, "ent": rank.RankType.Ent,
        "cinephile": rank.RankType.Cinephile,
        "bangumi": rank.RankType.Bangumi, "guochuang": rank.RankType.Guochuang,
        "guochuang_anime": rank.RankType.GuochuangAnime,
        "documentary": rank.RankType.Documentary, "kichiku": rank.RankType.Kichiku,
        "movie": rank.RankType.Movie, "tv": rank.RankType.TV,
        "variety": rank.RankType.Variety,
    }
    day_map = {3: rank.RankDayType.THREE_DAY, 7: rank.RankDayType.WEEK}

    rank_type = type_map.get(category.lower(), rank.RankType.All)
    rank_day = day_map.get(day, rank.RankDayType.THREE_DAY)

    try:
        result = await rank.get_rank(type_=rank_type, day=rank_day)
    except Exception as e:
        return _err(f"获取排行榜失败: {e}")
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "coin": stat.get("coin", 0),
            "score": item.get("score", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"category": category, "day": day, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 17: 用户信息 ==========

@_gated_tool()
async def bili_user_info(uid: int) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)
    try:
        info = await u.get_user_info()
    except Exception as e:
        return _err(f"获取用户信息失败: {e}", uid=uid)

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except Exception as e:
        logger.warning("获取UP主统计失败(uid=%s): %s", uid, e)

    relation = {}
    try:
        relation = await u.get_relation_info()
    except Exception as e:
        logger.warning("获取UP主关系数据失败(uid=%s): %s", uid, e)

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)


# ========== Tool 18: 用户视频列表 ==========

@_gated_tool()
async def bili_user_videos(uid: int, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    try:
        result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    except Exception as e:
        return _err(f"获取用户视频失败: {e}", uid=uid)
    videos = []
    for item in result.get("list", {}).get("vlist", []):
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": item.get("created", 0),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 19: 收藏夹列表 ==========

@_gated_tool()
async def bili_favorite_lists(uid: int = 0) -> str:
    """
    获取用户的收藏夹列表

    Args:
        uid: 用户UID（0表示获取自己的收藏夹）

    Returns:
        收藏夹列表，包含ID、名称、视频数量
    """
    cred = get_cred()
    if uid == 0:
        # 从凭证获取自己的UID
        try:
            uid = int(_load_cred_data().get("dedeuserid") or 0)
        except (TypeError, ValueError):
            uid = 0
        if uid <= 0:
            return _err("凭证中缺少 dedeuserid，无法获取你的收藏夹，请重新登录")

    try:
        result = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    except Exception as e:
        return _err(f"获取收藏夹列表失败: {e}")
    fav_lists = []
    for item in (result.get("list", []) or []):
        fav_lists.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "media_count": item.get("media_count", 0),
            "fav_state": item.get("fav_state", 0),
        })
    return json.dumps({"uid": uid, "count": len(fav_lists), "lists": fav_lists}, ensure_ascii=False)


# ========== Tool 20: 收藏夹内容 ==========

@_gated_tool()
async def bili_favorite_content(media_id: int, page: int = 1, keyword: str = "") -> str:
    """
    获取收藏夹内的视频列表

    Args:
        media_id: 收藏夹ID（从 bili_favorite_lists 获取）
        page: 页码，默认1
        keyword: 搜索关键词（在收藏夹内搜索）

    Returns:
        收藏夹内的视频列表
    """
    cred = get_cred()
    try:
        result = await favorite_list.get_video_favorite_list_content(
            media_id=media_id,
            page=page,
            keyword=keyword if keyword else None,
            credential=cred,
        )
    except Exception as e:
        return _err(f"获取收藏夹内容失败: {e}", media_id=media_id)
    medias = []
    for item in (result.get("medias", []) or []):
        medias.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("cnt_info", {}).get("play", 0),
            "collect": item.get("cnt_info", {}).get("collect", 0),
            "author": item.get("upper", {}).get("name", ""),
            "duration": item.get("duration", 0),
            "fav_time": item.get("fav_time", 0),
        })
    return json.dumps({
        "media_id": media_id,
        "page": page,
        "has_more": result.get("has_more", False),
        "count": len(medias),
        "medias": medias,
    }, ensure_ascii=False)


# ========== Tool 21: 发私信 ==========

@_gated_tool()
async def bili_send_message(receiver_uid: int, text: str) -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容

    Returns:
        发送结果
    """
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    try:
        result = await session.send_msg(
            credential=cred,
            receiver_id=receiver_uid,
            msg_type=session.EventType.TEXT,
            content=text.strip(),
        )
        return json.dumps({
            "success": True,
            "message": f"私信已发送给UID:{receiver_uid}",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 22: 未读消息 ==========

@_gated_tool()
async def bili_unread_messages() -> str:
    """
    获取B站未读消息数（私信、@、回复、点赞等）

    Returns:
        各类未读消息数量
    """
    cred = get_cred()
    try:
        result = await session.get_unread_messages(credential=cred)
        return _ok(result)
    except Exception as e:
        return _err(f"获取未读消息失败: {e}")


# ========== Tool 23: 最近收到的回复 ==========

@_gated_tool()
async def bili_received_replies() -> str:
    """
    获取最近收到的评论回复通知

    Returns:
        回复列表
    """
    cred = get_cred()
    try:
        result = await session.get_replies(credential=cred)
        return _ok(result)
    except Exception as e:
        return _err(f"获取回复通知失败: {e}")


# ========== Tool 24: 最近收到的@和点赞 ==========

@_gated_tool()
async def bili_received_at_and_likes() -> str:
    """
    获取最近收到的@提及和点赞通知

    Returns:
        包含 at 和 likes 两部分的通知数据
    """
    cred = get_cred()
    result = {}
    errors = []
    try:
        result["at"] = await session.get_at(credential=cred)
    except Exception as e:
        errors.append(f"@通知获取失败: {e}")
    try:
        result["likes"] = await session.get_likes(credential=cred)
    except Exception as e:
        errors.append(f"点赞通知获取失败: {e}")
    if errors:
        return _err("; ".join(errors), **result)
    return _ok(result)


# ========== Tool 28: 点赞视频（混迹轻互动） ==========

@_gated_tool()
async def bili_like(bvid: str, like: bool = True) -> str:
    """
    给B站视频点赞（或取消点赞）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        like: True=点赞，False=取消点赞

    Returns:
        点赞结果
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    try:
        await v.like(status=like)
        return _ok({"success": True, "bvid": bvid, "message": "点赞成功" if like else "已取消点赞"})
    except Exception as e:
        return _err(f"点赞失败: {e}", bvid=bvid)


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")