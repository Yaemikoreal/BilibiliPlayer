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
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
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
                        "rpid": sub.get("rpid", 0),
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


# ========== 质量门 lint：只读规则文件、哑执行（单一事实来源在 dsh-plugin/lib/persona/lint.js） ==========
#
# 分工（计划 §6.3 / §8.1）：
#   - 判据、词表、阈值全部由 JS 导出的 <家目录>/persona/lint-rules.json 决定；
#     本段只有"解释器"，**不复制任何规则**——改判据改 JS，重导一遍即可。
#   - 文件缺失 / 解析失败 / 判据写坏 → **放行 + 告警**（绝不因规则坏了全线停摆）。
#   - 只有 level=='block' 且文件里 mode=='block' 才不发；mode=='warn'（默认先跑三天）
#     照发，但把 lint 结果塞进返回体，让模型当轮就能看见"这条本该被拦"。

_LINT_EMOJI_RE = re.compile(r"\[[^\]]{1,12}\]|[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")
_LINT_TAIL_RE = re.compile(r'[\s。！!？?～~….,，、:：;；·）」』"”’）)】]+$')
_LINT_SENTENCE_RE = re.compile(r"[。！？!?；;\n]+")
_LINT_QUOTE_PAIRS = (("「", "」"), ("『", "』"), ("“", "”"), ('"', '"'), ("‘", "’"))
_LINT_FORMS = ("comment", "reply", "dynamic")


def _persona_home() -> Path:
    """插件家目录：与 dsh-plugin/lib/persona/store.js 的 homeDir() 同源（BILI_FENSHEN_HOME 优先）。"""
    home = os.environ.get("BILI_FENSHEN_HOME") or os.path.join(
        os.environ.get("HOME") or os.environ.get("USERPROFILE") or ".", ".dsh", "bili-fenshen")
    return Path(home)


def _lint_rules_file() -> Path:
    """质量门规则文件路径；由 dsh-plugin/scripts/export-lint-rules.mjs 写出。"""
    return _persona_home() / "persona" / "lint-rules.json"


def _lint_strip_emoji(s: str) -> str:
    return _LINT_EMOJI_RE.sub("", s)


def _lint_char_len(s: str) -> int:
    """字数口径与 JS 的 charLen 一致：去表情 token、去空白后按码点算。"""
    return len(re.sub(r"\s+", "", _lint_strip_emoji(s)))


def _lint_ngrams(s: str, n: int = 2) -> set:
    t = re.sub(r"\s+", "", _lint_strip_emoji(s))
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def _lint_jaccard(a: str, b: str, n: int = 2) -> float:
    """与 JS text.js 的 jaccard 同口径（两边都太短则退化为"是否相同"）。"""
    x, y = _lint_ngrams(a, n), _lint_ngrams(b, n)
    if not x or not y:
        return 1.0 if a.strip() == b.strip() else 0.0
    hit = len(x & y)
    return hit / (len(x) + len(y) - hit)


def _lint_render(template, variables: dict) -> str:
    """按规则里的 reasonTemplate 渲染理由：占位符也来自 JS，Python 不自造文案。"""
    out = str(template or "")
    for key, value in variables.items():
        out = out.replace("{" + key + "}", str(value))
    return out


def _lint_eval_check(check: dict, text: str, form: str, limits: dict, rules: dict):
    """跑一条声明式判据；命中返回 {code, level, reason, advice}，否则 None。

    只认 lint.js 导出的 kind；未知 kind、缺阈值、坏正则一律跳过（规则升级时宁可漏判不误杀）。
    """
    if not isinstance(check, dict):
        return None
    kind = str(check.get("kind") or "")
    variables: dict = {}

    if kind == "endsWithAny":
        tail = _LINT_TAIL_RE.sub("", _lint_strip_emoji(text)).strip()
        hit = next((w for w in (check.get("words") or [])
                    if isinstance(w, str) and w and tail.endswith(w)), None)
        if not hit:
            return None
        variables["hit"] = hit
    elif kind == "startsWithAny":
        segments = [s.strip() for s in _LINT_SENTENCE_RE.split(_lint_strip_emoji(text).strip()) if s.strip()]
        head = segments[0] if segments else ""
        hit = next((w for w in (check.get("words") or [])
                    if isinstance(w, str) and w and head.startswith(w)), None)
        if not hit:
            return None
        variables["hit"] = hit
    elif kind == "quotedOnly":
        raw = text.strip()
        inner_len = -1
        for open_q, close_q in _LINT_QUOTE_PAIRS:
            if raw.startswith(open_q) and raw.endswith(close_q) and len(raw) > len(open_q) + len(close_q):
                inner_len = _lint_char_len(raw[len(open_q):len(raw) - len(close_q)])
                break
        min_chars = check.get("minChars")
        if inner_len < 0 or not isinstance(min_chars, (int, float)) or inner_len < min_chars:
            return None
        variables["len"] = inner_len
    elif kind == "maxJaccard":
        threshold = check.get("threshold")
        if not isinstance(threshold, (int, float)):
            return None
        ngram = check.get("ngram")
        ngram = ngram if isinstance(ngram, int) and ngram > 0 else 2
        texts = (rules.get("bank") or {}).get("active") or []
        if not isinstance(texts, list) or not texts:
            return None
        best, best_text = 0.0, ""
        for candidate in texts:
            if not isinstance(candidate, str):
                continue
            score = _lint_jaccard(text, candidate, ngram)
            if score > best:
                best, best_text = score, candidate
        if not best > threshold:
            return None
        variables["overlap"] = f"{best:.2f}"
        variables["threshold"] = f"{threshold:.2f}"
        variables["text"] = best_text[:12]
    elif kind == "maxChars":
        limit = limits.get(form)
        if not isinstance(limit, (int, float)):
            return None  # 规则里没这本场域的上限 ⇒ 这条判据不生效（不抄缺省值）
        length = _lint_char_len(text)
        if length <= limit:
            return None
        variables["len"] = length
        variables["limit"] = limit
        variables["mode"] = form
    elif kind == "maxCount":
        char = check.get("char")
        max_n = check.get("max")
        if not isinstance(char, str) or not char or not isinstance(max_n, (int, float)):
            return None
        count = text.count(char)
        if count <= max_n:
            return None
        variables.update({"count": count, "max": max_n, "char": char})
    elif kind == "maxCountEmoji":
        max_n = check.get("max")
        if not isinstance(max_n, (int, float)):
            return None
        count = len(_LINT_EMOJI_RE.findall(text))
        if count <= max_n:
            return None
        variables.update({"count": count, "max": max_n})
    elif kind == "containsAny":
        hit = next((w for w in (check.get("words") or [])
                    if isinstance(w, str) and w and w in text), None)
        if not hit:
            return None
        variables["hit"] = hit
    elif kind == "regexAny":
        pattern = check.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            return None
        try:
            matched = re.search(pattern, text)
        except re.error as e:
            logger.warning("质量门正则无效，跳过该判据：%s（%s）", pattern, e)
            return None
        if not matched:
            return None
        variables["hit"] = matched.group(0)[:20]
    else:
        return None

    return {
        "code": str(check.get("code") or kind),
        "level": "block" if check.get("level") == "block" else "warn",
        "reason": _lint_render(check.get("reasonTemplate"), variables) or f"{check.get('code') or kind} 未通过",
        "advice": str(check.get("advice") or ""),
    }


def _lint_eval(text: str, mode: str, rules: dict) -> dict:
    """哑执行：按规则文件里的 checks 逐条跑；返回与 JS lintComment 同形的结果。"""
    form = mode if mode in _LINT_FORMS else "comment"
    limits = rules.get("limits") if isinstance(rules.get("limits"), dict) else {}
    hits = []
    for check in rules.get("checks") or []:
        hit = _lint_eval_check(check, text, form, limits, rules)
        if hit:
            hits.append(hit)
    codes, reasons, advices = [], [], []
    for hit in hits:
        if hit["code"] not in codes:
            codes.append(hit["code"])
        if hit["reason"] and hit["reason"] not in reasons:
            reasons.append(hit["reason"])
        if hit["advice"] and hit["advice"] not in advices:
            advices.append(hit["advice"])
    return {
        "ok": not hits,
        "level": "block" if any(h["level"] == "block" for h in hits) else "warn",
        "codes": codes,
        "reasons": reasons,
        "advice": "；".join(advices),
    }


def _lint_precheck(text: str, mode: str) -> dict:
    """发布前质量门。返回 {"blocked": bool, "payload": dict|None, "warn": dict|None, "notice": str}。

    blocked=True 时 payload 就是工具对外返回的 JSON；放行时 warn 非空表示"本该被拦但当前档位只告警"。
    任何意外（文件缺失/坏 JSON/判据异常）都走放行，绝不让质量门把发布整条链路拖死。
    """
    try:
        rules, why = _load_lint_rules()
        if rules is None:
            logger.warning("质量门规则不可用（%s）：本次放行", why)
            return {"blocked": False, "payload": None, "warn": None, "notice": f"lint 规则不可用，已放行：{why}"}
        apply_mode = str(rules.get("mode") or "warn").strip().lower()
        if apply_mode not in ("off", "warn", "block"):
            apply_mode = "warn"  # 写坏档位按最保守的 warn 处理，不擅自拦
        if apply_mode == "off":
            return {"blocked": False, "payload": None, "warn": None, "notice": ""}
        verdict = _lint_eval(text, mode, rules)
        if verdict["ok"]:
            return {"blocked": False, "payload": None, "warn": None, "notice": ""}
        summary = "；".join(verdict["reasons"])
        if apply_mode == "block" and verdict["level"] == "block":
            logger.warning("质量门拦截（%s/%s）：%s", mode, apply_mode, ",".join(verdict["codes"]))
            return {
                "blocked": True,
                "payload": {
                    "success": False,
                    "ok": False,
                    "code": "LINT_BLOCKED",
                    "codes": verdict["codes"],
                    "reasons": verdict["reasons"],
                    "advice": verdict["advice"],
                    "error": f"发布前质量门拦截：{summary}",
                },
                "warn": None,
                "notice": "",
            }
        logger.warning("质量门告警（%s/%s）：%s", mode, apply_mode, ",".join(verdict["codes"]))
        return {
            "blocked": False,
            "payload": None,
            "warn": {
                "level": verdict["level"],
                "codes": verdict["codes"],
                "reasons": verdict["reasons"],
                "advice": verdict["advice"],
            },
            "notice": "",
        }
    except Exception as e:  # 兜底：质量门自身出 bug 也只告警放行
        logger.warning("质量门执行异常，本次放行：%s", e)
        return {"blocked": False, "payload": None, "warn": None, "notice": f"lint 执行异常，已放行：{e}"}


def _load_lint_rules():
    """读 <家目录>/persona/lint-rules.json。返回 (rules|None, 原因)；读不到/写坏都返回 None。"""
    file = _lint_rules_file()
    try:
        if not file.exists():
            return None, f"规则文件缺失：{file}"
        with open(file, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None, "规则文件内容不是对象"
        if not isinstance(data.get("checks"), list):
            return None, "规则文件缺 checks 数组"
        return data, ""
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as e:
        return None, f"{type(e).__name__}: {e}"


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

    主动接话（回复别人的一级评论、进他的楼中楼）：**只传 rpid=对方一级评论的 rpid，root 留空**
    （内部会把 root 置成 rpid）；返回里的 rpid 是你自己这条回复的楼层 id。
    例：bili_reply(bvid="BV1xx", text="……", rpid=321560862800)

    Returns:
        发表结果
    """
    # ⭐ 已回复目标硬判重（2026-10-29）：同一目标评论只回一次。账本里（跨轮）或本进程
    #    内存里（轮内）已经回过这个 rpid ⇒ 直接拒绝，不再碰 B站 API。
    #    通知列表里同一条还挂着 ≠ 新互动；对方又发新话 = 新 rpid，不会命中这里。
    if rpid:
        try:
            replied = _replied_targets()
            if (str(bvid), int(rpid)) in replied:
                return _err(
                    f"目标评论 {rpid} 已经回复过（同一评论只回一次；通知还挂着不等于新互动）。"
                    "若对方有新回复，请改传新那条的 rpid；不要重试本调用。",
                    bvid=bvid, rpid=int(rpid), alreadyReplied=True,
                )
        except Exception as _e:  # 判重自身异常不拦正常发送
            logger.warning("已回复目标判重异常，本次放行：%s", _e)
    # 发布前质量门：规则来自 <家目录>/persona/lint-rules.json（JS 导出）；缺失/损坏则放行 + 告警
    gate = _lint_precheck(text, "reply" if rpid else "comment")
    if gate["blocked"]:
        return json.dumps(gate["payload"], ensure_ascii=False)
    lint_warn = gate.get("warn")

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

        rpid_out = None
        if isinstance(result, dict):
            rpid_out = result.get("rpid") or (result.get("data") or {}).get("rpid")
        # ⭐ 回复成功（rpid!=0 即回复别人的评论）⇒ 目标记进进程内存，防本轮内重复
        if rpid:
            try:
                _remember_replied_target(bvid, int(rpid))
            except Exception:
                pass
        payload = {
            "success": True,
            "message": "评论发送成功",
            "bvid": bvid,
            "rpid": rpid_out,
        }
        if lint_warn:
            payload["lint"] = lint_warn  # warn 档：照发，但把"本该被拦"的判据回给模型
        return json.dumps(payload, ensure_ascii=False)
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

    # 发布前质量门：与 bili_reply 同一份规则文件（动态场域上限从规则里读）
    gate = _lint_precheck(text.strip(), "dynamic")
    if gate["blocked"]:
        return json.dumps(gate["payload"], ensure_ascii=False)
    lint_warn = gate.get("warn")

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
        payload = {
            "success": True,
            "message": "动态发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }
        if lint_warn:
            payload["lint"] = lint_warn  # warn 档：照发，但把"本该被拦"的判据回给模型
        return json.dumps(payload, ensure_ascii=False)
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

    每条通知带 already_replied 标注：true = 对方那条评论我已经回过（账本+本进程内存判定）。
    ⚠️ 同一条通知每轮都会出现（B站不会因为你回过就移除它）——already_replied=true 的
    **不是新互动，直接跳过**；只有 already_replied=false 的才需要跟进。

    Returns:
        回复列表（含 already_replied / bvid / target_rpid 标注）
    """
    cred = get_cred()
    try:
        result = await session.get_replies(credential=cred)
    except Exception as e:
        return _err(f"获取回复通知失败: {e}")
    # ⭐ 已回复目标标注（2026-10-29）：跟进回复此前没有任何判重数据（已接话清单只认接话、
    #    seen.md 跟进行记的是自己楼层），同一评论被连回 2 轮才被发现。这里把判重做进工具返回。
    try:
        replied = _replied_targets()
        items = result.get("items") if isinstance(result, dict) else None
        annotated = 0
        if isinstance(items, list):
            for it in items:
                if not isinstance(it, dict):
                    continue
                inner = it.get("item") if isinstance(it.get("item"), dict) else {}
                m = re.search(r"/video/(BV[0-9A-Za-z]+)", str(inner.get("uri") or inner.get("native_uri") or ""))
                bv = m.group(1) if m else ""
                try:
                    src = int(inner.get("source_id"))
                except Exception:
                    src = None
                ar = bool(bv and src is not None and (bv, src) in replied)
                it["already_replied"] = ar
                if bv:
                    it["bvid"] = bv
                if src is not None:
                    it["target_rpid"] = src
                if ar:
                    annotated += 1
        if isinstance(result, dict):
            result = {**result,
                      "alreadyRepliedCount": annotated,
                      "note": "already_replied=true 的通知是已经回过的评论，不是新互动，别再回；只跟进 already_replied=false 的"}
        return _ok(result)
    except Exception as e:
        # 标注自身失败就原样返回，不阻断值班
        logger.warning("回复通知标注失败，原样返回：%s", e)
        return _ok(result)


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


# ========== Tool 29: 关注列表（我关注的 UP 主） ==========

@_gated_tool()
async def bili_followings(pn: int = 1, ps: int = 50, sort: str = "attention", keyword: str = "") -> str:
    """
    获取当前账号关注的 UP 主列表（订阅列表，分页；支持「最常访问」排序）

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认50（最大50）
        sort: 排序：attention=最常访问（常看的在前，默认）；follow=最近关注在前；follow_asc=最早关注在前
        keyword: 按昵称过滤（本地过滤当前页，不区分大小写）

    Returns:
        关注的 UP 主列表：mid、昵称、签名、头像；total = 当前账号总关注数；sort = 实际使用的排序
    """
    cred = get_cred()
    uid = str(cred.dedeuserid or "").strip()
    if not uid.isdigit():
        return _err("凭证里缺少 dedeuserid，无法拉取关注列表；请重新扫码登录")
    page = max(1, min(int(pn or 1), 1000))
    size = max(1, min(int(ps or 50), 50))
    sort_key = str(sort or "").strip().lower()
    attention = sort_key not in ("follow", "follow_asc")
    follow_asc = sort_key == "follow_asc"
    order_enum = user.OrderType.asc if follow_asc else user.OrderType.desc
    u = user.User(uid=int(uid), credential=cred)
    try:
        result = await u.get_followings(pn=page, ps=size, attention=attention, order=order_enum)
    except Exception as e:
        return _err(f"获取关注列表失败: {e}", uid=int(uid))
    kw = str(keyword or "").strip().lower()
    items = []
    for x in result.get("list") or []:
        name = str(x.get("uname") or "")
        if kw and kw not in name.lower():
            continue
        items.append({
            "mid": x.get("mid"),
            "uname": name,
            "sign": str(x.get("sign") or "")[:80],
            "face": x.get("face") or "",
        })
    return _ok({
        "success": True,
        "uid": int(uid),
        "page": page,
        "sort": "attention" if attention else ("follow_asc" if follow_asc else "follow"),
        "total": result.get("total", 0),
        "count": len(items),
        "followings": items,
    })


# ========== 值班轮工具 A：内容源一次拉齐（关注池最新投稿 + 账本过滤） ==========
#
# 为什么要有这个工具（计划 §16.5-1 / §17）：
#   以前一轮的发现阶段是「bili_followings + 每个 UP 一次 bili_user_videos」——
#   2026-10-29 真实日志：第三轮查了 6 个 UP ≈ 6 次调用，20 次预算被吃掉一大块，
#   模型还得在「先扫哪几个」上反复权衡（配置写的还是 40）。服务端一次循环解决：
#   关注池取前 N 个 → 并行拉每人最新 M 条 → 用账本过滤掉已看过的 → 只把没看过的返回。
# 纪律：
#   1. 纯读；单个 UP 失败只进 failures，不影响其他 UP；
#   2. 账本过滤是"尽力而为"：读不到账本就照常全部返回（seen 全 false），绝不因此失败；
#   3. 返回体积可控：默认 8 个 UP × 3 条，最多 20 × 5。

_FEED_MAX_UPS = 20
_FEED_MAX_PER_UP = 5
_FEED_CONCURRENCY = 4
_BV_FULL_RE = re.compile(r"^BV[0-9A-Za-z]{8,12}$")


def _iso_local(ts) -> str:
    """unix 秒 → 本地时区 ISO（模型看"几小时前"比看 epoch 有用）。"""
    try:
        return datetime.fromtimestamp(int(ts)).astimezone().isoformat(timespec="seconds")
    except Exception:
        return ""


def _ledger_read_events(limit: int = 0) -> list:
    """读账本事件。

    一行可能塞了多个对象（2026-10-25 的真实事故：`{...}{...}` 导致整行解析失败、
    当天配额全消失）——所以这里用 raw_decode 逐个扫，容忍老账本里的坏行。
    """
    out: list = []
    path = _persona_home() / "ledger.jsonl"
    try:
        if not path.exists():
            return out
        dec = json.JSONDecoder()
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s:
                    continue
                i = 0
                while i < len(s):
                    while i < len(s) and s[i] in " \t":
                        i += 1
                    if i >= len(s):
                        break
                    try:
                        obj, j = dec.raw_decode(s, i)
                    except Exception:
                        break
                    if isinstance(obj, dict):
                        out.append(obj)
                    i = j
    except Exception:
        return out
    return out[-limit:] if limit and limit > 0 else out


def _ledger_seen_bvids() -> set:
    """账本里"看过/动作过"的 BV（与 dsh-plugin/lib/seen.js 同口径：任何带合法 BV 的事件都算）。"""
    seen: set = set()
    for ev in _ledger_read_events():
        bv = ev.get("bvid")
        if isinstance(bv, str) and _BV_FULL_RE.match(bv):
            seen.add(bv)
    return seen


# ───────── 已回复目标判重（2026-10-29，配合 dsh-plugin/lib/replies.js repliedTargetsFromLedger）─────────
# 「同一评论只回一次，除非对方有新互动」：判重键 = 对方那条评论的 rpid（reply-out.parent）。
# 对方再发新话 = 新 rpid = 新互动，自然不在集合里；老 rpid 永远在集合里 ⇒ 永不重复回。
# 两层防线：账本（跨轮）+ 本进程内存（轮内，账本往往轮末才批量落盘）。

_session_replied_targets: set = set()  # {(bvid, parent_rpid)} 本 MCP 进程里成功回过的目标


def _replied_targets(window_days: int = 0) -> set:
    """账本里回过的目标评论 (bvid, parent_rpid) 集合；window_days=0 不限窗口（判重要宁多勿漏）。"""
    out: set = set()
    cutoff = 0.0
    if window_days and window_days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).timestamp()
    for ev in _ledger_read_events():
        if ev.get("type") != "reply-out":
            continue
        if cutoff:
            try:
                t = datetime.fromisoformat(str(ev.get("t") or "").replace("Z", "+00:00")).timestamp()
            except Exception:
                t = None
            if t is not None and t < cutoff:
                continue
        bv = ev.get("bvid")
        try:
            parent = int(ev.get("parent"))
        except Exception:
            continue  # 没有目标 rpid 的残行没法判重
        if isinstance(bv, str) and bv:
            out.add((bv, parent))
    return out | _session_replied_targets


def _remember_replied_target(bvid: str, parent_rpid: int) -> None:
    """本轮刚回成功的目标记进进程内存（账本可能要等轮末才写，跨工具调用也得住）。"""
    if bvid and parent_rpid:
        _session_replied_targets.add((str(bvid), int(parent_rpid)))


@_gated_tool()
async def bili_feed(limit_up: int = 8, per_up: int = 3, only_new: bool = True) -> str:
    """
    一次拿到「最常访问」前 N 个关注 UP 主的最新投稿，并已按账本标好"看过/没看过"

    这是"拉内容源"的第一档首选：一次调用顶掉「bili_followings + N 次 bili_user_videos」。
    返回里 seen=True 的视频**直接丢**（账本里已经看过/赞过/评过/跳过过），别再花调用。

    Args:
        limit_up: 取前几个常看 UP 主，默认 8（上限 20）
        per_up: 每个 UP 主拉最新几条，默认 3（上限 5）
        only_new: True=只返回账本里没看过的（默认）；False=全返回并带 seen 标记

    Returns:
        videos（按发布时间倒序的候选，带 up/mid/seen）、ups（每个 UP 的新旧计数）、
        skippedSeen、failures（单个 UP 失败不影响其他人）
    """
    cred = get_cred()
    uid = str(cred.dedeuserid or "").strip()
    if not uid.isdigit():
        return _err("凭证里缺少 dedeuserid，无法拉关注池；请重新扫码登录")
    limit = max(1, min(int(limit_up or 8), _FEED_MAX_UPS))
    per = max(1, min(int(per_up or 3), _FEED_MAX_PER_UP))
    me = user.User(uid=int(uid), credential=cred)
    try:
        fol = await me.get_followings(pn=1, ps=limit, attention=True, order=user.OrderType.desc)
    except Exception as e:
        return _err(f"拉关注列表失败: {e}（可退回 bili_followings + bili_user_videos）")
    ups = [x for x in (fol.get("list") or []) if x.get("mid")]
    if not ups:
        return _ok({"success": True, "videos": [], "ups": [], "skippedSeen": 0, "failures": [],
                    "hint": "关注列表是空的（先关注几个 UP 主，或改用关键词搜索）"})
    seen = _ledger_seen_bvids()
    sem = asyncio.Semaphore(_FEED_CONCURRENCY)

    async def pull(x):
        mid = int(x.get("mid"))
        name = str(x.get("uname") or "")
        async with sem:
            try:
                r = await user.User(uid=mid, credential=cred).get_videos(
                    pn=1, ps=per, order=user.VideoOrder.PUBDATE)
            except Exception as e:
                return {"mid": mid, "uname": name, "error": str(e)[:120], "videos": []}
        vlist = ((r.get("list") or {}).get("vlist")) or []
        out = []
        for it in vlist:
            bv = str(it.get("bvid") or "")
            out.append({
                "bvid": bv,
                "title": str(it.get("title") or ""),
                "play": it.get("play", 0),
                "comment": it.get("comment", 0),
                "created": it.get("created", 0),
                "publishedAt": _iso_local(it.get("created")),
                "length": str(it.get("length") or ""),
                "description": str(it.get("description") or "")[:100],
                "seen": bv in seen,
            })
        return {"mid": mid, "uname": name, "error": "", "videos": out}

    results = await asyncio.gather(*[pull(x) for x in ups])
    videos: list = []
    failures: list = []
    up_rows: list = []
    skipped = 0
    for r in results:
        if r.get("error"):
            failures.append({"mid": r["mid"], "uname": r["uname"], "error": r["error"]})
            continue
        fresh = [v for v in r["videos"] if not v["seen"]]
        skipped += len(r["videos"]) - len(fresh)
        up_rows.append({"mid": r["mid"], "uname": r["uname"], "new": len(fresh),
                        "seen": len(r["videos"]) - len(fresh), "total": len(r["videos"])})
        for v in (fresh if only_new else r["videos"]):
            v2 = dict(v)
            v2["up"] = r["uname"]
            v2["mid"] = r["mid"]
            videos.append(v2)
    videos.sort(key=lambda v: int(v.get("created") or 0), reverse=True)
    return _ok({
        "success": True,
        "videos": videos,
        "ups": up_rows,
        "newVideos": sum(1 for v in videos if not v["seen"]),
        "skippedSeen": skipped,
        "failures": failures,
        "note": "seen=true 的别再看/别再评；只挑真正没看过的判",
    })


# ========== 值班轮工具 B：记账 / 报告（宿主写盘，模型不必碰文件编码） ==========
#
# 为什么要把「写账本 / 写报告」变成工具（计划 §16.5-2）：
#   模型现在用 pwsh here-string 手拼 JSONL / Markdown —— 2026-10-25 出过"一行塞两条 ⇒
#   当天配额全消失"的事故；2026-10-29 又为"控制台乱码"白烧了 2 次调用去回读校验。
#   工具化之后：t / round 由宿主补（模型不可能写错），字段按类型校验，重复条目直接拒，
#   UTF-8 一次写一行 —— 编码问题从"模型要小心"变成"结构上不可能"。

_LEDGER_REQUIRED = {
    "view": ("bvid",),
    "like": ("bvid",),
    "comment": ("bvid", "text"),
    "dynamic": ("text",),
    "skip": ("bvid", "reason"),
    "reply-out": ("bvid", "parent", "text"),
    "reply-scan": ("bvid", "decision"),
    "note": ("text",),
}
_LEDGER_MAX_EVENTS = 40


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _current_round_id() -> str:
    """本轮 round id：优先读宿主注入的 BILI_FENSHEN_ROUND_ID（与 prompt 里那个值同源），
    读不到再退 state.json.lastRunStartedAt（2026-10-29 之前它俩差 1s+，是双源 bug 的根源）。"""
    env_round = str(os.environ.get("BILI_FENSHEN_ROUND_ID") or "").strip()
    if env_round:
        return env_round
    st = _persona_read_json(_persona_home() / "state.json") or {}
    return str(st.get("lastRunStartedAt") or "")


def _validate_ledger_event(ev, idx: int, round_id: str):
    """单条事件校验 + 补 t/round。返回 (obj, error)。"""
    if not isinstance(ev, dict):
        return None, "不是对象"
    kind = str(ev.get("type") or "").strip()
    if kind not in _LEDGER_REQUIRED:
        return None, f"type 只允许 {'/'.join(_LEDGER_REQUIRED)}，收到 {kind or '空'}"
    for key in _LEDGER_REQUIRED[kind]:
        val = ev.get(key)
        if val is None or (isinstance(val, str) and not val.strip()):
            return None, f"{kind} 缺必填字段 {key}"
    bv = ev.get("bvid")
    if bv not in (None, "") and not _BV_FULL_RE.match(str(bv)):
        return None, f"bvid 格式不合法: {bv}"
    if kind == "reply-scan":
        decision = str(ev.get("decision") or "").strip()
        if decision not in ("posted", "skipped"):
            return None, "reply-scan.decision 只能是 posted / skipped"
        if decision == "posted" and ev.get("targetRpid") is None:
            return None, "reply-scan(decision=posted) 必须带 targetRpid"
    if kind == "reply-out":
        try:
            int(ev.get("parent"))
        except Exception:
            return None, "reply-out.parent 必须是对方评论 rpid（整数）"
    out = dict(ev)
    out.setdefault("t", _now_iso())
    if not out.get("round"):
        out["round"] = round_id
    return out, ""


@_gated_tool()
async def bili_ledger_append(events: list[dict]) -> str:
    """
    把本轮动作一次性追加进账本（宿主补 t/round、校验字段、去重、UTF-8 落盘）

    **首选这个，不要用 pwsh 手写 ledger.jsonl**。每条事件的 `t` 和 `round` 缺省由宿主补，
    你只需要写业务字段。被拒的条目看 rejected 里的 reason 改完再发（不要重试同一条）。

    Args:
        events: 事件数组，每个对象带 type 与必填字段。例：
            [{"type":"view","bvid":"BV1xx","title":"…","author":"…","views":123,"duration":892,"source":"follow","grade":"worth"},
             {"type":"comment","bvid":"BV1xx","text":"正文","rpid":318480352401},
             {"type":"reply-scan","bvid":"BV1xx","candidates":[],"decision":"skipped","reason":"热评全在站队"}]

    Returns:
        written（写入条数）、rejected（[{index,reason}]）、round（本轮 round id）
    """
    if not isinstance(events, list) or not events:
        return _err("events 必须是非空数组（一次可传多条，别再一行塞两个对象）")
    if len(events) > _LEDGER_MAX_EVENTS:
        return _err(f"一次最多 {_LEDGER_MAX_EVENTS} 条（收到 {len(events)}）")
    round_id = _current_round_id()
    if not round_id:
        return _err("读不到本轮 round id（state.json 缺 lastRunStartedAt）；退回直接写文件")
    existing = _ledger_read_events(limit=800)
    seen_keys = {(e.get("round"), e.get("type"), e.get("bvid"), e.get("text")) for e in existing}
    path = _persona_home() / "ledger.jsonl"
    lines: list = []
    rejected: list = []
    for idx, ev in enumerate(events):
        obj, why = _validate_ledger_event(ev, idx, round_id)
        if obj is None:
            rejected.append({"index": idx, "reason": why})
            continue
        if "\ufffd" in json.dumps(obj, ensure_ascii=False):
            rejected.append({"index": idx, "reason": "文本里有 U+FFFD（编码坏了），重发一次"})
            continue
        key = (obj.get("round"), obj.get("type"), obj.get("bvid"), obj.get("text"))
        if key in seen_keys:
            rejected.append({"index": idx, "reason": "重复条目（账本里已有同 round/type/bvid/text）"})
            continue
        seen_keys.add(key)
        lines.append(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    if not lines:
        return _ok({"success": False, "written": 0, "rejected": rejected, "round": round_id,
                    "error": "没有一条通过校验，账本未改动"})
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = "\n".join(lines) + "\n"
        if path.exists() and path.stat().st_size > 0:
            with open(path, "rb") as f:
                f.seek(-1, os.SEEK_END)
                tail = f.read(1)
            if tail not in (b"\n", b"\r"):
                blob = "\n" + blob
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(blob)
    except Exception as e:
        return _err(f"账本写入失败: {e}")
    return _ok({"success": True, "written": len(lines), "rejected": rejected, "round": round_id,
                "path": str(path)})


_REPORT_HEADING_RE = re.compile(
    r"^##\s+.*?round\s*id\s*[:：]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)", re.I | re.M)


@_gated_tool()
async def bili_report_append(markdown: str) -> str:
    """
    把本轮报告整段追加到 out/<今天>.md（宿主校验标题里的 round id，重复提交会被拒）

    **首选这个，不要用 pwsh 手拼 Markdown**。标题必须是 `## <时段>轮（round id <ISO>）`，
    否则宿主回填/控制台对不上账。同一个 round id 已经写过一次 ⇒ 拒绝（防止重复追加）。

    Args:
        markdown: 本轮报告全文（从 `## …轮（round id …）` 开始，到本轮总结行为止）

    Returns:
        file、bytes、roundId
    """
    text = (markdown or "").strip("\n")
    if not text.strip():
        return _err("markdown 不能为空")
    if len(text) > 20000:
        return _err(f"单轮报告超长（{len(text)} > 20000 字）；分段发或精简")
    if "\ufffd" in text:
        return _err("文本里有 U+FFFD（编码坏了）；重发一次，别手抄")
    first = next((ln for ln in text.splitlines() if ln.strip()), "")
    if not first.startswith("## "):
        return _err("第一行必须是 `## <时段>轮（round id <ISO>）`（否则控制台对不上账）")
    hit = _REPORT_HEADING_RE.search(text)
    if not hit:
        return _err("找不到 round id：标题要写成 `## 凌晨轮（round id 2026-10-28T16:07:49.108Z）`（只写时段名+round id，别写「第三轮」这种全局编号）")
    round_id = hit.group(1)
    home = _persona_home()
    day = datetime.now().astimezone().strftime("%Y-%m-%d")
    path = home / "out" / f"{day}.md"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        old = path.read_text(encoding="utf-8") if path.exists() else ""
        if round_id in old:
            return _ok({"success": False, "code": "DUPLICATE_ROUND", "error": f"这一轮（{round_id}）已经写进报告了，别重复追加",
                        "file": str(path), "roundId": round_id})
        head = "" if old else f"# {day}\n\n"
        sep = "" if not old or old.endswith("\n\n") else ("\n" if old.endswith("\n") else "\n\n")
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(head + sep + text + "\n")
    except Exception as e:
        return _err(f"报告写入失败: {e}")
    return _ok({"success": True, "file": str(path), "roundId": round_id,
                "bytes": len((head + sep + text + "\n").encode("utf-8")),
                "message": "报告已追加；账本用 bili_ledger_append 写"})


# ========== Tool: 见闻正文按需取用（C3 生成期通道 · 路径 A / W6-1） ==========
#
# 为什么要有这个工具（计划 §2.2/§2.5/§5.6/§8.3）：
#   候选视频是子进程「拉内容源」之后才出现的，而 argv 里的 prompt 在 spawn 前就定死了；
#   所以见闻只能「索引常驻、正文按需读」：模型看见视频标题/字幕/热评之后，再调本工具命中正文，
#   不占 argv 24k 硬线 —— 这正是酒馆（世界书全在编译期）做不到的「生成期世界书」。
# 三条纪律：
#   1. 中文**子串匹配**（NFKC 全角半角归一 + casefold 大小写不敏感），**绝不做整词边界** ——
#      酒馆官方自己说 match whole words 对中日文有害（中文没有空格分词）；
#   2. 排序 直命中（keys 命中数多）> 今天未用 > 索引顺序；今天用过只降权不淘汰；
#      预算 C3：≤2 条、总正文 ≤600 字，超了截断并标 truncated；
#   3. 纯读、不联网；任何异常（卡坏/目录缺失/正文缺失）都**静默降级**成 ok:false，绝不抛。

_PERSONA_LORE_MAX_ITEMS = 2
_PERSONA_LORE_MAX_CHARS = 600
_PERSONA_LORE_NO_HIT = "没有命中的见闻（这很正常，别硬凑）"
_PERSONA_LORE_HINT = "见闻是这个号自己的经历；用得上就借一句细节或一个角度，别整段复述、别当外部事实讲"


def _persona_read_json(path):
    """只读 JSON：读不到/坏 JSON/顶层不是对象都返回 None（人设工具一律按「缺失即降级」处理）。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _persona_presets_dir() -> Path:
    """内置预设卡目录：<仓库根>/dsh-plugin/prompts/persona（与 store.js 的 PRESETS_DIR 同源）。"""
    return Path(__file__).resolve().parent / "dsh-plugin" / "prompts" / "persona"


def _persona_resolve_card():
    """按 active.json 解析生效卡 + 资产根目录（规则与 store.js 的 readActive/loadCard/assetDir 同源）。

    - preset：卡与见闻都在 <插件>/prompts/persona（随包只读）；
    - file：卡在 <家目录>/persona/card.json（或 active.path），见闻正文在 <家目录>/persona；
    - active.json 缺失/读坏 → 按缺省 preset whale；file 卡读不到 → 回落 preset whale。
    返回 (card|None, assets_dir)；card is None = 连 whale 预设都读不到，调用方静默降级。
    """
    persona = _persona_home() / "persona"
    presets = _persona_presets_dir()
    active = _persona_read_json(persona / "active.json")
    if not isinstance(active, dict) or active.get("mode") not in ("preset", "file"):
        active = {"mode": "preset", "presetId": "whale"}
    if active.get("mode") == "file":
        path = Path(str(active.get("path") or (persona / "card.json")))
        card = _persona_read_json(path) or _persona_read_json(persona / "card.json")
        if card is not None:
            return card, persona
        active = {"mode": "preset", "presetId": "whale"}  # 用户卡读坏 → 回落预设，别让工具整个死
    preset_id = str(active.get("presetId") or "whale")
    card = (_persona_read_json(presets / f"{preset_id}.card.json")
            or _persona_read_json(presets / "whale.card.json"))
    return card, presets


def _persona_lore_norm(text) -> str:
    """子串匹配前的归一：NFKC（全角→半角） + casefold（大小写不敏感）。中文本身不受影响。"""
    return unicodedata.normalize("NFKC", str(text or "")).casefold()


def _persona_lore_strip_front_matter(text: str) -> str:
    """剥掉见闻 md 的 YAML front-matter（仅当首行是 --- 且后面有闭合行）。"""
    raw = str(text or "").lstrip("\ufeff")
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return raw.strip()
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            return "\n".join(lines[i + 1:]).strip()
    return raw.strip()  # 没有闭合行：当正文就是全部（宁可多给，也别把正文吞掉）


def _persona_lore_used_today(lore_used, lore_id: str, now=None) -> bool:
    """state.loreUsed[id] 是不是「今天」。时间戳按**本地时区**判日；非 ISO 串退回前 10 位比较。"""
    at = lore_used.get(lore_id) if isinstance(lore_used, dict) else None
    if not isinstance(at, str) or not at.strip():
        return False
    now = now or datetime.now().astimezone()
    raw = at.strip()
    try:
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw[:10] == now.strftime("%Y-%m-%d")
    if stamp.tzinfo is not None:
        stamp = stamp.astimezone(now.tzinfo) if now.tzinfo is not None else stamp.astimezone()
    return stamp.strftime("%Y-%m-%d") == now.strftime("%Y-%m-%d")


def _persona_lore_degrade(reason: str) -> dict:
    return {"ok": False, "matched": [], "total": 0, "note": f"见闻库暂时不可用：{reason}"}


def _persona_lore_match(keyword, card, state=None, assets_dir=None, now=None) -> dict:
    """W6-1 核心（纯函数，可单测）：子串命中 → 冷却降权 → 取正文，≤2 条 ≤600 字。

    参数：keyword 现场关键词（标题 + 字幕要点 + 热评关键词）；card 人设卡；state 今日状态（读 loreUsed）；
         assets_dir 资产根（preset = 插件 prompts/persona，file = <家目录>/persona）；now 注入时钟（测试用）。
    返回 {ok, matched:[{id,oneLine,usedToday,body,chars,truncated}], total, note}；total = 命中总条数（截断前）。
    任何异常都返回 ok:false 的降级体，绝不抛（C3 纪律：失败必须静默降级）。
    """
    try:
        if not isinstance(card, dict) or not isinstance(card.get("loreIndex"), list):
            return _persona_lore_degrade("人设卡缺失或没有 loreIndex")
        if not assets_dir:
            return _persona_lore_degrade("见闻目录未知")
        assets = Path(assets_dir)
        if not assets.is_dir():
            return _persona_lore_degrade(f"见闻目录缺失：{assets}")
        lore_used = state.get("loreUsed") if isinstance(state, dict) else None
        needle = _persona_lore_norm(keyword)

        hits = []
        for order, entry in enumerate(card["loreIndex"]):
            if not isinstance(entry, dict):
                continue
            lore_id = str(entry.get("id") or "").strip()
            if not lore_id:
                continue
            keys = [str(k).strip() for k in (entry.get("keys") or []) if str(k).strip()]
            # 子串匹配：normalize(键) 出现在 normalize(关键词) 里即命中；不做整词边界
            hit_count = sum(1 for k in keys if _persona_lore_norm(k) and _persona_lore_norm(k) in needle)
            if not hit_count:
                continue
            hits.append({
                "id": lore_id,
                "oneLine": str(entry.get("oneLine") or "").strip(),
                "usedToday": _persona_lore_used_today(lore_used, lore_id, now),
                "_hitCount": hit_count,
                "_order": order,
            })
        if not hits:
            return {"ok": True, "matched": [], "total": 0, "note": _PERSONA_LORE_NO_HIT}

        # 排序：直命中（keys 命中数多）> 今天未用 > 索引顺序（今天用过只降权、仍可返回）
        hits.sort(key=lambda h: (-h["_hitCount"], h["usedToday"], h["_order"]))

        matched = []
        remaining = _PERSONA_LORE_MAX_CHARS
        capped = False
        for hit in hits[:_PERSONA_LORE_MAX_ITEMS]:
            if remaining <= 0:
                capped = True
                break
            body_file = assets / "lore" / f"{hit['id']}.md"
            try:
                raw = body_file.read_text(encoding="utf-8")
            except FileNotFoundError:
                return _persona_lore_degrade(f"见闻正文缺失：{body_file}")
            body = _persona_lore_strip_front_matter(raw)
            if not body:
                return _persona_lore_degrade(f"见闻正文为空：{body_file}")
            truncated = False
            if len(body) > remaining:
                # 留 1 字给省略号，保证总正文严格 ≤600 字
                body = body[: max(remaining - 1, 0)] + "…" if remaining >= 2 else "…"
                truncated = capped = True
            remaining -= len(body)
            matched.append({
                "id": hit["id"],
                "oneLine": hit["oneLine"],
                "usedToday": hit["usedToday"],
                "body": body,
                "chars": len(body),
                "truncated": truncated,
            })

        note = _PERSONA_LORE_HINT
        if len(hits) > len(matched) or capped:
            note += f"；命中 {len(hits)} 条，按相关度与冷却只给了 {len(matched)} 条（C3 预算 ≤2 条 ≤600 字）"
        return {"ok": True, "matched": matched, "total": len(hits), "note": note}
    except Exception as e:  # 兜底：工具自身出 bug 也只降级，不阻断本轮
        return _persona_lore_degrade(f"{type(e).__name__}: {e}")


@_gated_tool()
async def bili_persona_lore(keyword: str) -> str:
    """
    按现场关键词取最多 2 条「见闻正文」（生成期世界书：看见视频/热评之后再决定用哪条）。

    只在**准备写评论/回复/动态**、且标题或热评让你想起「我好像有类似经历」时调用一次；
    纯本地只读、不联网。

    Args:
        keyword: 现场关键词（把视频标题 + 字幕要点 + 热评关键词拼起来最准，如"无畏契约 上分 残局"）

    Returns:
        JSON：{ok, matched:[{id, oneLine, usedToday, body, chars, truncated}], total, note}
        - 命中：matched 最多 2 条、总正文 ≤600 字；usedToday=true 表示今天已经用过（可返回但该换一条）；
        - 没命中：matched 为空（这很正常，别硬凑，也别凭印象编细节）；
        - 见闻库不可用：ok=false、matched 为空 → 本轮照常进行，别重试。
    """
    try:
        keyword = str(keyword or "")
        card, assets_dir = _persona_resolve_card()
        state = _persona_read_json(_persona_home() / "persona" / "state.json") or {}
        return _ok(_persona_lore_match(keyword, card, state, assets_dir))
    except Exception as e:  # 兜底：C3 通道失败必须静默降级，绝不阻断本轮
        logger.warning("见闻库不可用（静默降级）：%s", e)
        return _ok(_persona_lore_degrade(f"{type(e).__name__}: {e}"))


# ========== Tool: 人设沉淀候选（自演化管道；薄工具——只做结构预检 + 追加 pending，质检/入库在宿主 JS） ==========

def _persona_pending_file() -> Path:
    """growth-pending.jsonl 的路径：<家目录>/persona/。家目录解析与插件宿主同源（BILI_FENSHEN_HOME 优先）。"""
    home = os.environ.get("BILI_FENSHEN_HOME") or os.path.join(
        os.environ.get("HOME") or os.environ.get("USERPROFILE") or ".", ".dsh", "bili-fenshen")
    return Path(home) / "persona" / "growth-pending.jsonl"

_CORPUS_FORMS = {"reaction", "question", "experience", "meme", "detail", "rant"}


@_gated_tool()
async def bili_persona_note(
    kind: str,
    form: str = "",
    text: str = "",
    origin: str = "self",
    source: str = "",
    originalText: str = "",
    id: str = "",
    keys: list[str] | None = None,
    oneLine: str = "",
    body: str = "",
) -> str:
    """
    把值得沉淀的素材提交为「人设自演化候选」。提交后宿主会在下一轮值班启动前质检入库。

    两种用法：
    - kind="corpus"：沉淀一句语料（自己说过且想再用的话用 origin="self"；
      社区都在用的公共梗用 origin="community" 并写明 source，**且必须带 originalText（原帖热评原文）**；
      **别人评论的原句绝对不许提交**）
    - kind="lore"：沉淀一条见闻（这个号的生活碎片，如"照着做菜视频煮翻车了"；
      只能编角色的生活细节，不许出现可被当真的现实事实）

    Args:
        kind: 'corpus'（语料）或 'lore'（见闻）
        form: corpus 必填：reaction/question/experience/meme/detail/rant 六桶之一
        text: corpus 必填：语料原文（≤100 字）
        origin: corpus 用：'self'（自己发过的，宿主会跟账本对账）或 'community'（公共梗，≤30 字）
        source: 来源说明（community 必填；self 可写互动情况，如"被赞 5 次"）
        originalText: **corpus/community 必填**：原帖热评原文（宿主用它做"与原帖"改写检查；缺了会被拒）
        id: lore 可选：见闻 id（字母数字-连字符；缺了宿主生成）
        keys: lore 必填：触发词列表（命中这些词时才读正文）
        oneLine: lore 必填：一行摘要（≤40 字，会常驻 prompt）
        body: lore 可选：正文（≤600 字，不注入，命中后才读）

    Returns:
        提交回执 JSON
    """
    pending = _persona_pending_file()
    try:
        pending.parent.mkdir(parents=True, exist_ok=True)
        existing = []
        if pending.exists():
            with open(pending, encoding="utf-8") as f:
                existing = [ln for ln in f.read().split("\n") if ln.strip()]
    except Exception as e:
        return _err(f"候选文件读不了: {e}")

    same_kind = 0
    try:
        for ln in existing:
            obj = json.loads(ln)
            if obj.get("kind") == kind:
                same_kind += 1
    except Exception:
        same_kind = 0
    if same_kind >= 5:
        return _err(f"{kind} 候选已积压 {same_kind} 条（待宿主消化后再交）；沉淀是可选动作，这轮交够了")

    entry: dict = {"kind": kind, "pendingAt": __import__("datetime").datetime.now().astimezone().isoformat()}

    if kind == "corpus":
        text = (text or "").strip()
        if form not in _CORPUS_FORMS:
            return _err(f"form 必须是 {'/'.join(sorted(_CORPUS_FORMS))} 之一，收到: {form or '空'}")
        if not text:
            return _err("text 不能为空")
        if len(text) > 100:
            return _err(f"text 超长（{len(text)} > 100 字）")
        if origin not in ("self", "community"):
            return _err(f"origin 只允许 self/community，收到: {origin}")
        if origin == "community" and len(text) > 30:
            return _err(f"公共梗应 ≤30 字（当前 {len(text)}），太长说明不是梗，是自己写的——用 origin=self 或别交")
        if origin == "community" and not (source or "").strip():
            return _err("公共梗必须写 source（出处性质）")
        original_text = (originalText or "").strip()
        if origin == "community" and not original_text:
            # W2-3 的入库闸门要求 community 能跑「与原帖」改写检查；工具层先拦，免得宿主质检时才拒
            return _ok({"ok": False, "code": "NEED_ORIGINAL_TEXT", "error": "community 语料必须附原帖原文"})
        entry.update({"form": form, "text": text, "origin": origin, "source": (source or "").strip()})
        if original_text:
            entry["originalText"] = original_text
    elif kind == "lore":
        kid = (id or "").strip()
        if kid and not all(ch.isalnum() or ch in "-_" for ch in kid):
            return _err(f"id 只允许字母数字下划线连字符: {kid}")
        k = [str(x).strip() for x in (keys or []) if str(x).strip()]
        if not k:
            return _err("keys 不能为空（触发词，命中才读正文）")
        oneLine = (oneLine or "").strip()
        if not oneLine:
            return _err("oneLine 不能为空（一行摘要，会常驻 prompt）")
        if len(oneLine) > 40:
            return _err(f"oneLine 超长（{len(oneLine)} > 40 字）")
        if len((body or "").strip()) > 600:
            return _err(f"正文超长（{len(body.strip())} > 600 字）")
        entry.update({"id": kid, "keys": k, "oneLine": oneLine, "body": (body or "").strip()})
    else:
        return _err(f"kind 只允许 corpus/lore，收到: {kind or '空'}")

    try:
        with open(pending, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        return _err(f"候选写盘失败: {e}")

    return _ok({
        "success": True,
        "message": "已提交候选，待宿主质检入库（过审先进候选区，每天限量自动转正）",
        "kind": kind,
        "pending_of_kind": same_kind + 1,
    })


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")