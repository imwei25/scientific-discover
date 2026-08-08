#!/usr/bin/env bash
# ocr.sh —— 把图片/扫描件里的中文（含英文数字）识别成文字。
#
# 两条通道，自动选：
#   ① 平台代理（登录了平台账号就走它，**不需要你配任何 key**）：图片发到本机网关，网关贴
#      登录票据转给服务器，服务器贴 OCR key 调 OCR.space。key 只留在服务器，客户端一个字节
#      都拿不到；每人每天的次数与全平台的池子都在服务端算。网关注入 SCI_OCR_URL 认得出。
#   ② 本机 key 直连：没有平台通道时，读 OCR_SPACE_API_KEY（本机自用自己 export）。
# 中文一律走 OCREngine=3（表格/中文最准；走代理时引擎由服务器定，防客户端自选烧哪个额度池）。
#
# 用法：
#   bash ocr.sh <图片URL或本地路径> [更多图片...]      # 多张按顺序识别，各自输出
#   bash ocr.sh img1.jpg img2.png > out.txt            # 自行重定向保存
#   OCR_SPACE_API_KEY=<key> bash ocr.sh a.jpg          # 本机直连时临时给 key（别写进仓库）
#
# 多图输出之间用 "===== FILE: <名> =====" 分隔，便于按图切分（进度与额度都走 stderr，
# 所以上面那种重定向拿到的是干净的识别文本）。
# 依赖：项目根 .venv 的 python（requests；>1MB 图自动用 Pillow 压缩到 1MB 内）。
# 免费额度：Engine3 2500 次/月、Engine1/2 25000/月、500 次/天/IP、单图 ≤1MB。
set -euo pipefail

if [[ -z "${SCI_OCR_URL:-}" && -z "${OCR_SPACE_API_KEY:-}" ]]; then
  echo "ERROR: 既没有平台识字通道，也没有本机 OCR_SPACE_API_KEY。" >&2
  echo "       登录平台账号后本来【不需要你配任何 key】（服务器会代你识别）；走到这里说明" >&2
  echo "       没登录平台账号，或平台还没配识字服务（可让管理员看一眼）。" >&2
  echo "       本机自用：export OCR_SPACE_API_KEY=<key>（免费注册 https://ocr.space/ocrapi ，邮箱即可）。" >&2
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

PYTHONIOENCODING=utf-8 "$PY" - "$@" <<'PY'
import sys, io, os, base64, requests

srcs = sys.argv[1:]
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

# 平台代理优先。走它时【不需要任何 key】，但要带本机网关的转发令牌（网关注入 SCI_OCR_TOKEN）：
# /cloud/* 那道闸只收带令牌的本机请求，否则同机任何程序都能白嫖你的云端识字额度。
PROXY = (os.environ.get('SCI_OCR_URL') or '').strip()
PROXY_TOKEN = (os.environ.get('SCI_OCR_TOKEN') or '').strip()
KEY = (os.environ.get('OCR_SPACE_API_KEY') or '').strip()
DIRECT_URL = 'https://api.ocr.space/parse/image'


class Stop(Exception):
    """平台明确拒绝（次数用完 / 平台没配 / 平台自己的额度没了）。重试与后续几张都毫无意义。"""


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


def sniff(b):
    """按魔数报真实类型。shrink() 只在 >1MB 时才转 JPEG，小图是原样发的，
    一律报 image/jpeg 就是在骗上游（它按 base64 前缀判类型）。"""
    if b[:8] == b'\x89PNG\r\n\x1a\n': return 'image/png'
    if b[:2] == b'\xff\xd8': return 'image/jpeg'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP': return 'image/webp'
    if b[:6] in (b'GIF87a', b'GIF89a'): return 'image/gif'
    if b[:4] == b'%PDF': return 'application/pdf'
    return 'image/jpeg'


def via_proxy(b, name):
    """走平台代理：请求体是我们自己那个小协议，引擎由服务端定、次数由服务端扣。"""
    r = requests.post(PROXY,
        headers={'Authorization': 'Bearer ' + PROXY_TOKEN, 'Content-Type': 'application/json'},
        json={'image': base64.b64encode(b).decode('ascii'), 'filename': name,
              'mime': sniff(b), 'language': 'chs', 'table': True},
        timeout=180)
    if r.status_code != 200:
        # 平台侧的结构化错误值得单独翻一下：自己的次数用完 / 全平台池子满了 / 平台没配，
        # 三种情况用户该做的事完全不同，甩一句 HTTP 429 等于没说。
        try:
            e = r.json().get('error') or {}
        except Exception:
            e = {}
        code, msg = e.get('code') or '', (e.get('message') or '').strip()
        if code in ('OCR_QUOTA_EXCEEDED', 'OCR_PLATFORM_QUOTA', 'OCR_UNCONFIGURED', 'OCR_UPSTREAM_QUOTA'):
            raise Stop(msg or code)
        raise RuntimeError(f"HTTP {r.status_code}: {msg or (r.text or '')[:300]}")
    d = r.json()
    q = d.get('quota') or {}
    if q and not q.get('unlimited'):
        print(f"[额度] 今日已用 {q.get('used')}/{q.get('limit')} 次", file=sys.stderr)
    return d.get('text') or ''


def via_key(b, name):
    """本机 key 直连 OCR.space。"""
    r = requests.post(DIRECT_URL,
        files={'file': ('img.jpg', b, 'image/jpeg')},
        data={'apikey': KEY, 'language': 'chs', 'OCREngine': '3', 'isTable': 'true'},
        timeout=90)
    j = r.json()
    if j.get('IsErroredOnProcessing'):
        m = j.get('ErrorMessage')
        raise RuntimeError('；'.join(m) if isinstance(m, list) else str(m))
    return j['ParsedResults'][0]['ParsedText']


print(f"[通道] {'平台代理（key 在服务器）' if PROXY else '本机 key 直连'}", file=sys.stderr)
rc = 0
for i, src in enumerate(srcs):
    name = src.rsplit('/', 1)[-1]
    if len(srcs) > 1:
        print(f"===== FILE: {name} =====")
    try:
        b = shrink(load(src))
        sys.stdout.write(via_proxy(b, name) if PROXY else via_key(b, name))
        sys.stdout.write("\n")
    except Stop as e:
        # 【绝不继续】次数用完了还一张张撞上去，只会把同一句"已用完"打印 N 遍，
        # 用户还以为是网络在抖；剩下的图也白白排队。
        print(f"[停止] {e}", file=sys.stderr)
        left = len(srcs) - i - 1
        if left:
            print(f"       后面 {left} 张没有识别（第 {i + 1} 张 {name} 起）。", file=sys.stderr)
        sys.exit(5)
    except Exception as e:
        print(f"[OCR 失败] {name}: {e}", file=sys.stderr); rc = 4
sys.exit(rc)
PY
