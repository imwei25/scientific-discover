#!/usr/bin/env bash
# ocr.sh —— 把图片/扫描件里的中文（含英文数字）识别成文字。
#
# 调 OCR.space 托管 API（模型在云端跑，本机/服务器不装任何 OCR 模型，零负担），
# 中文走 OCREngine=3（表格/中文最准）。多用户容器已由 render-compose 注入 OCR_SPACE_API_KEY。
#
# 用法：
#   bash ocr.sh <图片URL或本地路径> [更多图片...]      # 多张按顺序识别，各自输出
#   bash ocr.sh img1.jpg img2.png > out.txt            # 自行重定向保存
#   OCR_SPACE_API_KEY=<key> bash ocr.sh a.jpg          # 本机跑时临时给 key（别写进仓库）
#
# 多图输出之间用 "===== FILE: <名> =====" 分隔，便于按图切分。
# 依赖：项目根 .venv 的 python（requests；>1MB 图自动用 Pillow 压缩到 1MB 内）。
# 免费额度：Engine3 2500 次/月、Engine1/2 25000/月、500 次/天/IP、单图 ≤1MB。
set -euo pipefail

KEY="${OCR_SPACE_API_KEY:-}"
if [[ -z "$KEY" ]]; then
  echo "ERROR: 没有 OCR_SPACE_API_KEY。多用户容器本应已注入（deploy/.env → render-compose）；" >&2
  echo "       本机手动跑时：export OCR_SPACE_API_KEY=<key>（免费注册 https://ocr.space/ocrapi）。" >&2
  echo "       ⚠ 别把 key 写进脚本或仓库。" >&2
  exit 1
fi
[[ $# -lt 1 ]] && { echo "用法: bash ocr.sh <图片URL或路径> [更多图片...]" >&2; exit 1; }

# 解析项目根 .venv 的 python（优先 .venv，逐级向上找；回退 PATH 上的 python3/python/py）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolve_py() {
  local d="$SCRIPT_DIR"
  for _ in 1 2 3 4 5 6 7; do
    for p in "$d/.venv/Scripts/python.exe" "$d/.venv/bin/python"; do
      [[ -x "$p" ]] && { echo "$p"; return; }
    done
    d="$(dirname "$d")"
  done
  for c in python3 python py; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done
}
PY="$(resolve_py)"
[[ -z "$PY" ]] && { echo "ERROR: 未找到 python（缺 .venv 先跑 env-setup 技能）" >&2; exit 3; }

PYTHONIOENCODING=utf-8 "$PY" - "$KEY" "$@" <<'PY'
import sys, io, requests
key = sys.argv[1]
srcs = sys.argv[2:]
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

def load(src):
    if src.startswith(('http://', 'https://')):
        return requests.get(src, headers=UA, timeout=30).content
    return open(src, 'rb').read()

def shrink(b):
    if len(b) <= 1_000_000:
        return b
    try:
        from PIL import Image
    except ImportError:
        print("WARN: 图 >1MB 且无 Pillow，可能被 API 拒；pip install pillow", file=sys.stderr)
        return b
    im = Image.open(io.BytesIO(b)); q, w = 85, im.width
    while True:
        buf = io.BytesIO()
        im2 = im if im.width <= w else im.resize((w, int(im.height * w / im.width)))
        im2.convert('RGB').save(buf, 'JPEG', quality=q)
        if buf.tell() <= 1_000_000 or (q <= 40 and w <= 1400):
            return buf.getvalue()
        if q > 45: q -= 10
        else: w = int(w * 0.85)

rc = 0
for src in srcs:
    name = src.rsplit('/', 1)[-1]
    if len(srcs) > 1:
        print(f"===== FILE: {name} =====")
    try:
        b = shrink(load(src))
        r = requests.post('https://api.ocr.space/parse/image',
            files={'file': ('img.jpg', b, 'image/jpeg')},
            data={'apikey': key, 'language': 'chs', 'OCREngine': '3', 'isTable': 'true'},
            timeout=90)
        j = r.json()
        if j.get('IsErroredOnProcessing'):
            print(f"[OCR 失败] {name}: {j.get('ErrorMessage')}", file=sys.stderr); rc = 4; continue
        sys.stdout.write(j['ParsedResults'][0]['ParsedText'])
        sys.stdout.write("\n")
    except Exception as e:
        print(f"[OCR 异常] {name}: {e}", file=sys.stderr); rc = 4
sys.exit(rc)
PY