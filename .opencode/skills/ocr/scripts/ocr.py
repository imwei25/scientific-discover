#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ocr.py —— 把图片/扫描件/图片版 PDF 里的中文（含英文数字）识别成文字。

【这就是本技能的真入口】ocr.sh / ocr.ps1 都只是替你找到 .venv 的 python 再调这里，
逻辑一份，不会两边打架。直接 `<.venv 的 python> ocr.py a.jpg` 也完全等价。

三条通道，按顺序自动选，**前一条整体不可用就换下一条**（不是逐张重试）：
  ① 平台代理（登录了平台账号就走它，**不需要你配任何 key**）：图片发到本机网关，网关贴
     登录票据转给服务器，服务器贴 OCR key 调 OCR.space。key 只留在服务器，客户端一个字节
     都拿不到；每人每天的次数与全平台的池子都在服务端算。网关注入 SCI_OCR_URL 认得出。
  ② 本机 key 直连：读 OCR_SPACE_API_KEY（本机自用自己 export）。
  ③ Windows 内置 OCR（win_ocr.ps1，见该文件抬头）：离线、免费、不限次、图片不出本机。
     **兜底，不是主力**——中文准确度不如 Engine3、且完全不做表格版面。
中文一律走 OCREngine=3（表格/中文最准；走代理时引擎由服务器定，防客户端自选烧哪个额度池）。

【为什么①之后必须有兜底】①返回 404 = 服务器上根本没有 /ocr 这个接口（多半是线上版本还没
更新到带识字代理的那版）。这种错跟"你今天次数用完了"完全是两回事：重试一万次也不会好，而
用户本机其实躺着一个能用的引擎。以前脚本对 404 只会甩一句 "HTTP 404" 就结束，于是每次都要
有人从头排查一遍平台配置——现在它自己换到下一条通道，并在 stderr 说清为什么换。

用法：
  python ocr.py <图片/PDF 的 URL 或本地路径> [更多...]     # 多个按顺序识别，各自输出
  python ocr.py img1.jpg scan.pdf > out.txt                # 自行重定向保存
  OCR_FORCE_CHANNEL=win python ocr.py a.jpg                # 指定只用某条（proxy|key|win），排查时用

多图输出之间用 "===== FILE: <名> =====" 分隔，便于按图切分（进度、通道与额度都走 stderr，
所以上面那种重定向拿到的是干净的识别文本）。
依赖：requests；>1MB 图自动用 Pillow 压缩到 1MB 内（仅云端通道需要）；PDF 逐页渲染用 PyMuPDF。
免费额度（仅云端两条）：Engine3 2500 次/月、Engine1/2 25000/月、500 次/天/IP、单图 ≤1MB。
"""
import sys, io, os, base64, shutil, subprocess, tempfile

# 【自己把两个流拧成 UTF-8】别指望调用方记得 PYTHONIOENCODING：Windows 控制台默认 GBK，
# 识别出来的生僻字一遇到就 UnicodeEncodeError，整批白跑。
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

try:
    import requests
except ImportError:
    print("ERROR: 缺 requests（用项目根 .venv 的 python 跑；缺 .venv 先跑 env-setup 技能）", file=sys.stderr)
    sys.exit(3)

srcs = [a for a in sys.argv[1:] if a not in ('-h', '--help')]
if len(srcs) != len(sys.argv[1:]) or not srcs:
    print("用法: python ocr.py <图片/PDF 的 URL 或路径> [更多...]", file=sys.stderr)
    sys.exit(0 if len(srcs) != len(sys.argv[1:]) else 1)

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

# 平台代理优先。走它时【不需要任何 key】，但要带本机网关的转发令牌（网关注入 SCI_OCR_TOKEN）：
# /cloud/* 那道闸只收带令牌的本机请求，否则同机任何程序都能白嫖你的云端识字额度。
PROXY = (os.environ.get('SCI_OCR_URL') or '').strip()
PROXY_TOKEN = (os.environ.get('SCI_OCR_TOKEN') or '').strip()
KEY = (os.environ.get('OCR_SPACE_API_KEY') or '').strip()
FORCE = (os.environ.get('OCR_FORCE_CHANNEL') or '').strip().lower()
DIRECT_URL = 'https://api.ocr.space/parse/image'
SCRIPTS = os.environ.get('OCR_SKILL_SCRIPTS') or os.path.dirname(os.path.abspath(__file__))
WIN_PS = os.path.join(SCRIPTS, 'win_ocr.ps1')


class ChannelDown(Exception):
    """这条通道【整体】不可用（服务器没这个接口 / 平台没配 key / 本机引擎起不来）→ 换下一条。"""


class Stop(Exception):
    """额度用尽（自己的次数 / 平台池子 / 上游）。重试无意义；有本地兜底就转过去，没有就收场。"""


def load(src):
    if src.startswith(('http://', 'https://')):
        return requests.get(src, headers=UA, timeout=30).content
    return open(src, 'rb').read()


def shrink(b):
    if len(b) <= 1_000_000 or sniff(b) == 'application/pdf':
        # PDF 交给 rasterize() 处理，别丢给 Pillow（它打不开，会炸成一句看不懂的报错）
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


def rasterize(b, dpi=200):
    """PDF → 每页一张 PNG。
    【为什么要有这一步】本地兜底通道（③）根本不认 PDF，云端也卡单文件 1MB——扫描版 PDF
    十有八九超标。以前这两种情况都只能让用户自己去导图片，等于把技能卡死在最后一米。"""
    try:
        import pymupdf as fitz  # 新名字；旧版只有 fitz，且用 fitz 会打一行弃用警告污染 stderr
    except ImportError:
        try:
            import fitz
        except ImportError:
            fitz = None
    if fitz is None:
        raise RuntimeError('要处理 PDF 需要 PyMuPDF（.venv 里 pip install pymupdf），'
                           '或先把页面导出成 PNG/JPG 再喂进来')
    doc = fitz.open(stream=b, filetype='pdf')
    out = []
    for i, page in enumerate(doc):
        out.append((i + 1, page.get_pixmap(dpi=dpi).tobytes('png')))
    doc.close()
    if not out:
        raise RuntimeError('这个 PDF 一页都解析不出来')
    return out


def via_proxy(b, name):
    """走平台代理：请求体是我们自己那个小协议，引擎由服务端定、次数由服务端扣。"""
    try:
        r = requests.post(PROXY,
            headers={'Authorization': 'Bearer ' + PROXY_TOKEN, 'Content-Type': 'application/json'},
            json={'image': base64.b64encode(b).decode('ascii'), 'filename': name,
                  'mime': sniff(b), 'language': 'chs', 'table': True},
            timeout=180)
    except requests.RequestException as e:
        # 网关根本没起来（桌面版没在跑 / 端口变了）也是整条通道的事，不是这张图的事
        raise ChannelDown(f"连不上本机网关：{e}")
    if r.status_code != 200:
        # 平台侧的结构化错误值得单独翻一下：自己的次数用完 / 全平台池子满了 / 平台没配 /
        # 服务器压根没这个接口，四种情况用户该做的事完全不同，甩一句 HTTP 429 等于没说。
        try:
            e = r.json().get('error') or {}
        except Exception:
            e = {}
        code, msg = e.get('code') or '', (e.get('message') or '').strip()
        if code in ('OCR_QUOTA_EXCEEDED', 'OCR_PLATFORM_QUOTA', 'OCR_UPSTREAM_QUOTA'):
            raise Stop(msg or code)
        if code == 'OCR_UNCONFIGURED':
            raise ChannelDown(msg or '平台还没有配置图片识字服务')
        if r.status_code in (404, 405, 501):
            # 【这就是那个 404】服务器上没有 /ocr 接口——线上版本早于识字代理那版，或反代没放行。
            # 归为"通道不可用"而不是"这张图失败"：重试没用，换道才有用。
            raise ChannelDown(
                f"服务器没有识字接口（HTTP {r.status_code}）——线上版本可能还没更新到带 /ocr 代理的那版，"
                f"请管理员部署后重试")
        if r.status_code in (401, 403):
            raise ChannelDown(f"平台通道鉴权不通过（HTTP {r.status_code}）：{msg or '登录票据无效或未登录'}")
        raise RuntimeError(f"HTTP {r.status_code}: {msg or (r.text or '')[:300]}")
    d = r.json()
    q = d.get('quota') or {}
    if q and not q.get('unlimited'):
        print(f"[额度] 今日已用 {q.get('used')}/{q.get('limit')} 次", file=sys.stderr)
    return d.get('text') or ''


UPLOAD_EXT = {'image/png': ('a.png', 'image/png'), 'image/jpeg': ('a.jpg', 'image/jpeg'),
              'image/gif': ('a.gif', 'image/gif'), 'image/webp': ('a.webp', 'image/webp'),
              'application/pdf': ('a.pdf', 'application/pdf')}


def via_key(b, name):
    """本机 key 直连 OCR.space。"""
    fn, mime = UPLOAD_EXT.get(sniff(b), ('a.jpg', 'image/jpeg'))
    r = requests.post(DIRECT_URL,
        files={'file': (fn, b, mime)},
        data={'apikey': KEY, 'language': 'chs', 'OCREngine': '3', 'isTable': 'true'},
        timeout=90)
    try:
        j = r.json()
    except ValueError:
        j = None
    # 【先看状态码再看 body】key 无效时上游回的是 403 + 一个 {"error": "E555: API key not valid"}，
    # 结构跟正常响应完全不同 —— 只在"解不出 JSON"的分支里判 403，就会漏成"这一张失败"，
    # 于是本地兜底通道永远轮不上（实测踩过）。
    txt = (str(j.get('error') or j.get('ErrorMessage') or '') if isinstance(j, dict) else (r.text or '')).strip()[:200]
    if r.status_code in (401, 403) or 'not valid' in txt.lower():
        raise ChannelDown(f"OCR_SPACE_API_KEY 不被接受（HTTP {r.status_code}）：{txt}")
    if r.status_code == 429 or (j is None and r.status_code >= 400):
        raise Stop(f"上游限速或额度用尽（HTTP {r.status_code}）：{txt}")
    if not isinstance(j, dict):
        raise RuntimeError(f"上游返回的不是 JSON（HTTP {r.status_code}）：{txt}")
    if j.get('IsErroredOnProcessing'):
        m = j.get('ErrorMessage')
        raise RuntimeError('；'.join(m) if isinstance(m, list) else str(m))
    rs = j.get('ParsedResults')
    if not isinstance(rs, list) or not rs:
        # 上游偶尔 200 但什么都没带（key 无效时就是这样）。别让 KeyError 冒到最外层——
        # 那句 "'ParsedResults'" 谁也看不懂，还盖住了真正的原因。
        raise RuntimeError(f"上游没有返回识别结果（HTTP {r.status_code}）：{str(j)[:200]}")
    return '\n'.join((x.get('ParsedText') or '') for x in rs)


_win = None


def win_ready():
    """探一次 Windows 内置 OCR 是否真能用（powershell 在不在、语言包装没装），结果缓存。
    返回 (powershell 路径, 可用语言串)；不可用时返回 ('', 原因)。"""
    global _win
    if _win is not None:
        return _win
    if os.name != 'nt':
        _win = ('', '不是 Windows'); return _win
    if not os.path.exists(WIN_PS):
        _win = ('', f'缺 {WIN_PS}'); return _win
    ps = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if not os.path.exists(ps):
        ps = shutil.which('powershell') or shutil.which('powershell.exe') or ''
    if not ps:
        _win = ('', '找不到 powershell.exe（Windows 内置 OCR 需要 Windows PowerShell 5.1）'); return _win
    try:
        r = subprocess.run([ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                            '-File', WIN_PS, '-Probe'], capture_output=True, timeout=90)
    except Exception as e:
        _win = ('', f'探测失败：{e}'); return _win
    langs = r.stdout.decode('utf-8', 'replace').strip()
    if r.returncode != 0 or not langs:
        _win = ('', (r.stderr.decode('utf-8', 'replace').strip() or f'探测退出码 {r.returncode}')[:200])
        return _win
    _win = (ps, langs)
    return _win


EXT = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
       'image/webp': '.webp', 'image/bmp': '.bmp', 'image/tiff': '.tif'}


def via_win(b, name):
    """Windows 内置 OCR。图片不出本机，也不占任何额度。"""
    ps, _ = win_ready()
    mime = sniff(b)
    if mime == 'application/pdf':
        # 正常走不到这儿（run() 会先把 PDF 拆成页图）；留着以防有人单独调用
        raise RuntimeError('Windows 内置 OCR 不认 PDF，请先把页面导出成图片再喂进来')
    fd, tmp = tempfile.mkstemp(suffix=EXT.get(mime, '.jpg'), prefix='sci_ocr_')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(b)
        r = subprocess.run([ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                            '-File', WIN_PS, '-Path', tmp, '-Lang', 'zh-Hans-CN'],
                           capture_output=True, timeout=300)
        err = r.stderr.decode('utf-8', 'replace').strip()
        if err:
            print(err, file=sys.stderr)
        if r.returncode in (3, 4):
            raise ChannelDown(err or f'Windows 内置 OCR 不可用（退出码 {r.returncode}）')
        if r.returncode != 0:
            raise RuntimeError(err or f'powershell 退出码 {r.returncode}')
        return r.stdout.decode('utf-8', 'replace')
    finally:
        try: os.unlink(tmp)
        except OSError: pass


LABEL = {
    'proxy': '平台代理（key 在服务器，桌面版默认）',
    'key':   '本机 key 直连 OCR.space',
    'win':   'Windows 内置 OCR（离线兜底，图片不出本机）',
}
FN = {'proxy': via_proxy, 'key': via_key, 'win': via_win}


def run(kind, raw, name):
    """按通道识别一个文件；PDF 在需要时先拆成页图。"""
    # 本地引擎不认 PDF；云端认，但单文件卡 1MB，扫描版 PDF 基本都超 → 这两种情况都逐页转图。
    if sniff(raw) == 'application/pdf' and (kind == 'win' or len(raw) > 1_000_000):
        pages = rasterize(raw)
        print(f"[PDF] {name}：{len(pages)} 页，逐页转图后识别", file=sys.stderr)
        out = []
        for pno, img in pages:
            out.append(f"----- PAGE {pno} -----\n"
                       + FN[kind](img if kind == 'win' else shrink(img), f'{name}#p{pno}'))
        return '\n'.join(out)
    return FN[kind](raw if kind == 'win' else shrink(raw), name)


ORDER = []
if PROXY: ORDER.append('proxy')
if KEY: ORDER.append('key')
# ③ 只在 Windows 上排队，真正可用与否等轮到它再探（探一次要起个 powershell，云端通的时候白花）
if os.name == 'nt': ORDER.append('win')
if FORCE:
    if FORCE not in FN:
        print(f"ERROR: OCR_FORCE_CHANNEL={FORCE} 无效，只能是 proxy / key / win", file=sys.stderr)
        sys.exit(1)
    # 指定了却没配前提，就直说；否则会拿空 key 打上游，拿回一句看不懂的解析错
    need = {'proxy': (PROXY, 'SCI_OCR_URL'), 'key': (KEY, 'OCR_SPACE_API_KEY')}.get(FORCE)
    if need and not need[0]:
        print(f"ERROR: OCR_FORCE_CHANNEL={FORCE} 但没有 {need[1]}。", file=sys.stderr)
        sys.exit(1)
    ORDER = [FORCE]


def pick(i):
    """从第 i 条起找一条真能用的通道，返回下标；都不行返回 -1。"""
    while i < len(ORDER):
        if ORDER[i] != 'win':
            return i
        ok, why = win_ready()
        if ok:
            return i
        print(f"[通道] Windows 内置 OCR 用不了：{why}", file=sys.stderr)
        i += 1
    return -1


ci = pick(0)
if ci < 0:
    print("ERROR: 没有任何可用的识字通道。", file=sys.stderr)
    print("       ① 平台代理：登录平台账号后本来【不需要你配任何 key】（服务器会代你识别）；", file=sys.stderr)
    print("          走到这里说明没登录，或平台还没配识字服务（可让管理员看一眼）。", file=sys.stderr)
    print("       ② 本机自用：export OCR_SPACE_API_KEY=<key>（免费注册 https://ocr.space/ocrapi ，邮箱即可）。", file=sys.stderr)
    print("          ⚠ 别把 key 写进脚本或仓库。", file=sys.stderr)
    print("       ③ Windows 内置 OCR：需 Windows 10+ 且装了识别语言包", file=sys.stderr)
    print("          （设置 → 时间和语言 → 语言 → 中文(简体) → 可选功能 → 光学字符识别）。", file=sys.stderr)
    sys.exit(1)

said = set()
rc = 0
for idx, src in enumerate(srcs):
    name = src.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    if len(srcs) > 1:
        print(f"===== FILE: {name} =====")
    try:
        raw = load(src)
    except Exception as e:
        print(f"[OCR 失败] {name}: 取图失败：{e}", file=sys.stderr); rc = 4; continue
    while True:
        kind = ORDER[ci]
        if kind not in said:
            print(f"[通道] {LABEL[kind]}", file=sys.stderr); said.add(kind)
        try:
            sys.stdout.write(run(kind, raw, name))
            sys.stdout.write("\n")
            break
        except (ChannelDown, Stop) as e:
            nxt = pick(ci + 1)
            # 有下家就叫「换道」，没下家才叫「停止」——额度用尽但本地还能兜住时喊"停止"，
            # 会让人以为这一批黄了
            tag = '换道' if nxt >= 0 else ('停止' if isinstance(e, Stop) else '不可用')
            print(f"[{tag}] {LABEL[kind]}：{e}", file=sys.stderr)
            if nxt < 0:
                # 【绝不继续】次数用完了还一张张撞上去，只会把同一句"已用完"打印 N 遍，
                # 用户还以为是网络在抖；剩下的图也白白排队。
                if isinstance(e, Stop):
                    left = len(srcs) - idx - 1
                    if left:
                        print(f"       后面 {left} 张没有识别（第 {idx + 1} 张 {name} 起）。", file=sys.stderr)
                    sys.exit(5)
                print(f"[OCR 失败] {name}: 没有其它可用通道了", file=sys.stderr); rc = 4; break
            print(f"       改用 {LABEL[ORDER[nxt]]}", file=sys.stderr)
            if ORDER[nxt] == 'win':
                print("       ⚠ 本地引擎准确度低于云端 Engine3、且不还原表格版面；"
                      "交付时必须说明用的是这条通道，关键字段逐个核对。", file=sys.stderr)
            ci = nxt
        except Exception as e:
            print(f"[OCR 失败] {name}: {e}", file=sys.stderr); rc = 4; break
sys.exit(rc)
