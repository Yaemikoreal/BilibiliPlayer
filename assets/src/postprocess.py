#!/usr/bin/env python3
"""把 Chrome 渲染出的原始 PNG 处理成仓库用的品牌图。

- hero.png          : 2560x640（1280x320 @2x），8-bit 调色板 + 有序抖动控体积
- social-preview.png: 1280x640，2x 超采样下采样后转 8-bit 调色板
- mascot.png        : 256x256 透明底，自动裁掉空白并居中
"""
import sys
import os

import numpy as np
from PIL import Image

tmp_dir, out_dir = sys.argv[1], sys.argv[2]


def bayer(n: int) -> np.ndarray:
    if n == 1:
        return np.array([[0]])
    m = bayer(n // 2)
    return np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])


def quantize_dither(im: Image.Image, colors: int = 256, amp: float = 16.0,
                    tile: int = 16) -> Image.Image:
    """调色板量化 + 有序抖动：暗部渐变不出明显色带，体积远小于 24-bit。"""
    im = im.convert("RGB")
    arr = np.asarray(im).astype(np.float32)
    pal_img = im.quantize(colors=colors, method=Image.FASTOCTREE)
    b = bayer(tile).astype(np.float32)
    b = (b + 0.5) / float(tile * tile) - 0.5        # -0.5 .. +0.5
    h, w = arr.shape[:2]
    pattern = np.tile(b, (h // tile + 1, w // tile + 1))[:h, :w][..., None]
    dithered = np.clip(arr + pattern * amp * 2, 0, 255).astype(np.uint8)
    return Image.fromarray(dithered).quantize(palette=pal_img, dither=Image.Dither.NONE)


def save(im: Image.Image, name: str) -> None:
    path = os.path.join(out_dir, name)
    im.save(path, optimize=True)
    kb = os.path.getsize(path) / 1024
    print(f"  {name}: {im.size[0]}x{im.size[1]}, {kb:.0f} KB")


# --- hero ---------------------------------------------------------------
hero = Image.open(os.path.join(tmp_dir, "hero-raw.png"))
save(quantize_dither(hero, amp=16.0), "hero.png")

# --- social preview -----------------------------------------------------
social = Image.open(os.path.join(tmp_dir, "social-raw.png")).convert("RGB")
social = social.resize((1280, 640), Image.LANCZOS)       # 2x 超采样 -> 1x
save(quantize_dither(social, amp=9.0, tile=8), "social-preview.png")

# --- mascot（透明底，裁空白后按比例居中放到 256 画布） -------------------
raw = Image.open(os.path.join(tmp_dir, "mascot-raw.png")).convert("RGBA")
bbox = raw.split()[3].getbbox()
art = raw.crop(bbox)
pad = 12
scale = min((256 - pad * 2) / art.width, (256 - pad * 2) / art.height)
art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
canvas.paste(art, ((256 - art.width) // 2, (256 - art.height) // 2), art)
save(canvas, "mascot.png")
