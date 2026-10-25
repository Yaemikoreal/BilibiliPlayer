#!/usr/bin/env bash
# 重新生成 assets/ 下的三张品牌图。
# 依赖：Google Chrome（headless 截图）、python3 + Pillow + numpy。
# 用法：bash assets/src/build.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="${TMPDIR:-/tmp}/bili-brand"

mkdir -p "$TMP"

render() {
  # render <html> <out.png> <w,h> <scale-factor> [extra chrome args...]
  local html="$1" png="$2" size="$3" scale="$4"; shift 4
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --screenshot="$png" --window-size="$size" --force-device-scale-factor="$scale" \
    "$@" "file://$html" >/dev/null 2>&1
  echo "  rendered $(basename "$png")"
}

echo "==> hero (1280x320 @2x -> 2560x640)"
render "$HERE/hero.html" "$TMP/hero-raw.png" 1280,320 2

echo "==> social preview (1280x640 @2x -> downscale)"
render "$HERE/social.html" "$TMP/social-raw.png" 1280,640 2

echo "==> mascot (transparent)"
render "$HERE/mascot-export.html" "$TMP/mascot-raw.png" 1024,768 1 --default-background-color=00000000

echo "==> post-process"
python3 "$HERE/postprocess.py" "$TMP" "$OUT"
echo "==> done"
