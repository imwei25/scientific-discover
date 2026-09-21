#!/usr/bin/env python3
"""机构通道全文获取（第二梯队）：挂接用户本机**已登录 CARSI / 机构 SSO 的 Chrome**
（Chrome DevTools Protocol），复用其合法机构授权会话，下载 OA 渠道拿不到、
但用户所在机构**已订购**的全文 PDF。思路来自 nature-downloader：连的是用户
真实浏览器里的登录态，而不是启动一个空白无授权的浏览器。

硬约束（写死在实现里，不是口号）：
- 只复用用户**自己**的登录态与机构订阅权限；绝不读取 / 存储 / 请求密码、OTP、
  恢复码——遇到登录页 / 人机验证只**等用户在浏览器窗口里自己完成**，脚本不代填。
- 不绕过任何访问控制：拿不到就如实记 FAIL，绝不接野路子镜像站。
- 限速 + 限量：逐条间隔默认 5s（下限 3s），单次默认 ≤20 条。出版商对批量下载
  有风控，触发会连累**全机构**的访问权限（图书馆被封 IP 段是真实事故）。

用法：
    python fetch_institutional.py pdfs/manual_needed.txt -o pdfs/
    python fetch_institutional.py worklist.tsv -o pdfs/ --max 10 --delay 8 -v

前置（一次性）：用**专用资料目录**启动 Chrome 并开 CDP（Chrome 136+ 禁止对
默认资料目录开远程调试端口），在该窗口经图书馆 / CARSI 完成一次登录；会话
cookie 存在专用目录里，之后直接复用。命令见本文件底部 CDP_HELP 或 SKILL.md。

服务器 / 无浏览器环境：本通道探测不到 CDP 时**优雅退出**（exit 2）并说明，
不影响 fetch_oa.py 的 OA 主管线——与 zotero-library 的同机降级策略一致。
"""

import argparse
import base64
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# 同目录的 fetch_oa 提供解析 / 校验 / 报告基建，避免两套实现漂移。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_oa import (  # noqa: E402
    CONTACT_EMAIL, classify_title_match, existing_pdf_ok, extract_pdf_text,
    is_valid_pdf, pmid_to_doi, read_doi_file, safe_doi_name, title_to_doi,
)

# Windows 控制台默认 GBK，而本脚本的提示里有 ✅/❌/⏸/▶/⚠ 这类 GBK 编不出来的字符，
# 不强制 UTF-8 的话打印到一半直接 UnicodeEncodeError 崩掉（用户看到的是一串 traceback，
# 而不是"浏览器已启动"）。与 zotero_read.py 同一处理。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass

log = logging.getLogger("fetch_institutional")

DEFAULT_CDP_URL = os.environ.get("SCI_CDP_URL", "http://127.0.0.1:9222")
MIN_DELAY_S = 3.0
DEFAULT_DELAY_S = 5.0
DEFAULT_MAX_RECORDS = 20
DEFAULT_LOGIN_TIMEOUT_S = 240
NAV_TIMEOUT_MS = 60_000
SETTLE_MS = 3_000          # 落地后等 JS 跳转（DOI → 出版商 → 可能的 SSO）稳定
MAX_PDF_CANDIDATES = 6

# 登录墙 / 人机验证的 URL 特征。命中即暂停，把控制权交还给用户。
AUTH_URL_HINTS = (
    "carsi", "shibboleth", "openathens", "ezproxy", "wayf", "/idp",
    "sso", "cas.", "/login", "signin", "sign-in", "authenticat", "authorize",
)
CHALLENGE_TITLE_HINTS = ("just a moment", "attention required", "captcha",
                         "checking your browser", "访问验证", "安全验证", "请稍候",
                         "正在验证")

# ============================================================
# 浏览器自启（让"开一个带调试端口的 Chrome"这件事对普通用户消失）
# ============================================================
# 设计取舍：这一步**不能**要求用户去敲命令行。默认行为改成"探测不到 CDP 就自己
# 用专用资料目录起一个"，用户只会看到弹出一个 Chrome 窗口。两点必须说清楚：
#   · 用的是**专用资料目录**（不是用户日常那个 profile）——这是 Chrome 136+ 的硬
#     限制：对默认资料目录开远程调试端口会被直接拒绝，绕不过去；
#   · 纯 IP 授权制下这无所谓（授权看出口 IP，与登录态无关，空 profile 照样能下）；
#     要走 CARSI/账号登录制的，则需要在这个新窗口里登录一次，之后一直复用。

def _browser_candidates() -> list[str]:
    """按平台列出可用的 Chromium 系浏览器可执行文件（Chrome 优先，Edge 兜底）。"""
    env = os.environ.get("SCI_BROWSER_PATH", "").strip()
    if env:
        return [env]
    if sys.platform == "win32":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        rel_chrome = r"Google\Chrome\Application\chrome.exe"
        rel_edge = r"Microsoft\Edge\Application\msedge.exe"
        return [os.path.join(b, r) for r in (rel_chrome, rel_edge)
                for b in (pf, pf86, local) if b]
    if sys.platform == "darwin":
        return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    found = [shutil.which(n) for n in
             ("google-chrome", "google-chrome-stable", "chromium",
              "chromium-browser", "microsoft-edge")]
    return [p for p in found if p]


def find_browser() -> str | None:
    for p in _browser_candidates():
        if p and Path(p).exists():
            return p
    return None


def default_profile_dir() -> Path:
    """专用资料目录：与 SKILL.md 里写的路径一致，换一个就等于让用户重新登录一次。"""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "sci-scholar-chrome"
    return Path.home() / ".sci-scholar-chrome"


def cdp_alive(cdp_url: str, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(  # noqa: S310（只打本机调试端口）
                cdp_url.rstrip("/") + "/json/version", timeout=timeout) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def launch_browser(cdp_url: str, profile_dir: Path | None = None,
                   wait_s: int = 25) -> tuple[bool, str]:
    """起一个带调试端口的浏览器并等它把端口打开。返回 (成功?, 说明)。"""
    if cdp_alive(cdp_url):
        return (True, "已有带调试端口的浏览器在跑，直接复用。")
    exe = find_browser()
    if not exe:
        return (False, "本机找不到 Chrome / Edge（可用环境变量 SCI_BROWSER_PATH 指定路径）。")
    port = urllib.parse.urlparse(cdp_url).port or 9222
    profile = profile_dir or default_profile_dir()
    profile.mkdir(parents=True, exist_ok=True)
    cmd = [exe, f"--remote-debugging-port={port}",
           f"--user-data-dir={profile}",
           "--no-first-run", "--no-default-browser-check",
           "about:blank"]
    kwargs: dict = {}
    if sys.platform == "win32":
        # 脱离本进程：脚本跑完浏览器还在，用户下次直接复用，不用再等一次启动。
        kwargs["creationflags"] = (subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
                                   | 0x00000008)  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL,  # noqa: S603
                         stderr=subprocess.DEVNULL, **kwargs)
    except Exception as e:  # noqa: BLE001
        return (False, f"启动失败：{type(e).__name__}: {e}")
    for _ in range(wait_s * 2):
        time.sleep(0.5)
        if cdp_alive(cdp_url):
            return (True, f"已启动 {Path(exe).name}（专用资料目录 {profile}）。")
    return (False,
            f"{Path(exe).name} 起来了但 {cdp_url} 没开：多半是**同一个专用资料目录**"
            f"已经有一个没带调试端口的窗口开着。把那个窗口关掉再试一次。")


# ============================================================
# WebVPN（国内高校常见的 URL 改写型代理）
# ============================================================
# 为什么非得单独支持：这类代理**只对带代理前缀的 URL 授权**。用户即便在浏览器里
# 登录了学校 WebVPN，我们照常访问 https://doi.org/... 也一样拿不到——授权不是按
# 会话给的，是按 URL 给的。所以必须把目标地址改写成代理形式再访问。
#
# 改写规则（据南京医科大学的真实样例反推，属这套方案的通行写法）：
#   https://webofscience.clarivate.cn/wos/woscc/smart-search
#   → http://webofscience-clarivate-cn-s.webvpn.njmu.edu.cn:8118/wos/woscc/smart-search
#   即：主机名的点换成横杠；原站是 https 就再加后缀 -s（http 则不加）；
#       然后接上网关主机名与端口；路径、查询串原样保留。
#
# ⚠ 这套方案各校部署有细微差异（尤其**目标站点带非标准端口**时的编码方式），本实现
#   只覆盖最通行的写法。遇到改写后打不开，别猜——让用户在浏览器里手动打开一篇文献，
#   把地址栏里的真实 URL 发回来对照。
#
# 另一个关键设计：**只改写入口 URL 就够了**。落地之后页面里的链接由 WebVPN 自己
# 服务端改写过，collect_pdf_candidates 抓到的本来就是代理形式的地址，不用再动手。
_WEBVPN_SAFE_HOST = re.compile(r"^[A-Za-z0-9.-]+(:\d+)?$")


def parse_webvpn_gateway(raw: str) -> tuple[str, str]:
    """把用户给的网关写成 (scheme, netloc)。接受 'webvpn.x.edu.cn:8118' 或带 scheme 的整串。"""
    raw = (raw or "").strip().rstrip("/")
    if "://" in raw:
        p = urllib.parse.urlparse(raw)
        scheme, netloc = (p.scheme or "https"), p.netloc
    else:
        netloc = raw
        # 带自定义端口的部署实测多为 http（样例 :8118 即是）；不带端口默认 https。
        scheme = "http" if ":" in netloc else "https"
    if not netloc or not _WEBVPN_SAFE_HOST.match(netloc):
        raise ValueError(f"WebVPN 网关写法不对：{raw!r}（应形如 webvpn.njmu.edu.cn:8118）")
    return scheme, netloc


def webvpn_rewrite(url: str, gateway: tuple[str, str]) -> str:
    """把一个真实站点 URL 改写成 WebVPN 形式。非 http(s) 或已是代理形式的原样返回。"""
    scheme, gw_netloc = gateway
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return url
    gw_host = gw_netloc.split(":")[0]
    if p.hostname.endswith(gw_host):        # 已经是代理地址，别套娃
        return url
    host = p.hostname.replace(".", "-")
    if p.scheme == "https":
        host += "-s"
    if p.port:
        # 目标站点带非标准端口的编码方式各校不一，这里不臆造：原样返回并警告，
        # 让调用方如实记下来，好过默默生成一个打不开的地址。
        log.warning("WebVPN：目标 %s 带非标准端口 %s，本实现不改写该形式，已原样使用",
                    p.hostname, p.port)
        return url
    new = p._replace(scheme=scheme, netloc=f"{host}.{gw_netloc}")
    return urllib.parse.urlunparse(new)


def detect_webvpn_gateway(context) -> tuple[str, str] | None:
    """从浏览器**已打开的标签页**里自动认出 WebVPN 网关，省掉让用户去查的麻烦。

    网关的域名和端口是各校特有的，**猜不出来也不该猜**。但只要用户在那个窗口里
    已经经 WebVPN 打开过任意一个页面，地址栏里就写着答案：
      http://webofscience-clarivate-cn-s.webvpn.njmu.edu.cn:8118/...
                                        └────── 网关 ──────┘ └端口┘
    做法是找到主机名里的 webvpn 那一节，从它往后就是网关；它前面那一节是被编码的
    目标站点。优先取**带前缀**的页面（能同时确认端口），退而求其次才用门户页本身。
    """
    best = None
    try:
        pages = list(context.pages)
    except Exception:  # noqa: BLE001
        return None
    for page in pages:
        try:
            url = page.url
        except Exception:  # noqa: BLE001
            continue
        for cand, has_prefix in _gateway_candidates(url):
            if has_prefix:   # 带目标前缀 → 协议与端口都可信，直接采用
                return cand
            best = best or cand
    return best


def _gateway_candidates(url: str) -> list[tuple[tuple[str, str], bool]]:
    """从一个 URL 里挖出可能的网关。返回 [( (scheme, netloc), 是否带目标前缀 )]。

    除了 URL 本身，还要看查询串里**内嵌的回跳地址**——实测未登录访问改写地址会被
    302 到门户，形如：
      https://webvpn.njmu.edu.cn/portal/?redirect_uri=http%3A%2F%2Fwww-sciencedirect-com-s
        .webvpn.njmu.edu.cn%3A8118%2F...#!/login
    门户本身在 https:443，而真正给改写地址用的是 http:8118 —— 只看门户会取错协议和
    端口。内嵌的那个 redirect_uri 才是权威样本。"""
    out: list[tuple[tuple[str, str], bool]] = []
    try:
        p = urllib.parse.urlparse(url)
    except Exception:  # noqa: BLE001
        return out
    if p.scheme not in ("http", "https") or not p.hostname:
        return out

    def add(parsed) -> None:
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return
        labels = parsed.hostname.split(".")
        idx = next((i for i, l in enumerate(labels) if "webvpn" in l.lower()), -1)
        if idx < 0:
            return
        netloc = ".".join(labels[idx:]) + (f":{parsed.port}" if parsed.port else "")
        out.append(((parsed.scheme, netloc), idx > 0))

    for vals in urllib.parse.parse_qs(p.query).values():
        for v in vals:
            if v.startswith(("http://", "https://")):
                try:
                    add(urllib.parse.urlparse(v))
                except Exception:  # noqa: BLE001
                    continue
    add(p)
    # 带前缀的排前面，让调用方优先采信
    out.sort(key=lambda x: not x[1])
    return out


def detect_webvpn_from_cookies(context) -> tuple[str, str] | None:
    """第二条识别路径：看 cookie。

    标签页识别要求用户**当时正好开着**一个 WebVPN 页面，这个条件太脆。而只要他登录过，
    `.webvpn.xxx.edu.cn` 上的会话 cookie 就一直在，关了标签页也还在。代价是 cookie
    只带域名、不带端口和协议，所以拿到域名后要探一下门户到底在哪个 origin 上。"""
    try:
        cookies = context.cookies()
    except Exception:  # noqa: BLE001
        return None
    hosts = set()
    for c in cookies:
        d = (c.get("domain") or "").lstrip(".")
        if "webvpn" in d.lower() and d.count(".") >= 1:
            labels = d.split(".")
            idx = next((i for i, l in enumerate(labels) if "webvpn" in l.lower()), -1)
            if idx >= 0:
                hosts.add(".".join(labels[idx:]))
    for host in sorted(hosts, key=len):
        for scheme, netloc in (("https", host), ("http", host),
                               ("http", f"{host}:8118")):
            try:
                r = context.request.get(f"{scheme}://{netloc}/", timeout=8000,
                                        max_redirects=2)
                if r.status < 500:
                    return (scheme, netloc)
            except Exception:  # noqa: BLE001
                continue
    return None


def auto_webvpn(context) -> tuple[str, str] | None:
    """标签页优先（能同时确认端口），退回 cookie（更耐久但要探 origin）。"""
    return detect_webvpn_gateway(context) or detect_webvpn_from_cookies(context)


def entry_url_for(doi: str, email: str, gateway: tuple[str, str] | None) -> str:
    """一条记录的入口地址。

    不走 WebVPN 时就是 doi.org。走 WebVPN 时**先用 Crossref 把 DOI 解成出版商真实
    落地页再改写**——而不是改写 doi.org 本身：多数 WebVPN 只放行白名单内的站点，
    doi.org 往往不在名单里；而且它的 302 会跳到未改写的真实域名上，直接跳出代理。
    Crossref 是公开 API，本机直连即可，不需要机构权限。"""
    plain = f"https://doi.org/{urllib.parse.quote(doi, safe='/')}"
    if not gateway:
        return plain
    try:
        from fetch_oa import crossref_lookup  # noqa: PLC0415
        for cand in crossref_lookup(doi, email):
            if cand.startswith("http"):
                return webvpn_rewrite(cand, gateway)
    except Exception as e:  # noqa: BLE001
        log.debug("crossref resolve failed for %s: %s", doi, e)
    return webvpn_rewrite(plain, gateway)


# ============================================================
# 机构网络自检（--diagnose）
# ============================================================
# 为什么要有这个：真实的机构网络多半不在开发者手上，只能委托别人代跑。而"下不下来"
# 这一个结果背后至少有五种互不相干的原因（不在机构网段 / 网络不通 / 没订这篇 /
# 人机验证 / 页面结构特殊），代跑的人口述分不清。所以让脚本自己把证据收齐成一份
# 报告，对方整份发回来即可定位，不用来回追问。
#
# 探针都是**真实存在、且经 Unpaywall 核实为非 OA（真付费墙）**的医学文章，每家主流
# 出版商一篇；外加一篇确定的 OA 文章做**对照组**——对照组的成败是分水岭：
#   对照成功 + 订阅篇全败 → 网络通，问题在权限/出版商；
#   对照也失败            → 是网络/代理问题，跟订阅权限根本无关。
# 换探针前务必重新核实 is_oa=false，否则对照失效、整份报告的结论都会跑偏。
PROBES = [
    {"doi": "10.1371/journal.pone.0000308", "publisher": "PLoS（OA 对照组）",
     "oa": True},
    {"doi": "10.1016/j.clnesp.2020.09.303", "publisher": "Elsevier / ScienceDirect"},
    {"doi": "10.1002/jcu.23131", "publisher": "Wiley"},
    {"doi": "10.1007/s40520-021-02032-5", "publisher": "Springer"},
    {"doi": "10.1080/15563650.2018.1546009", "publisher": "Taylor & Francis"},
    {"doi": "10.1177/17504589211045225", "publisher": "SAGE"},
    {"doi": "10.1093/tropej/fmz082", "publisher": "Oxford University Press"},
]

# 查出口 IP 及其归属。多个源互为备份（国内可达性不一）。归属比 IP 本身更有用：
# 最常见的误判就是"我连了 VPN / 连的是访客 WiFi，以为自己在校园网里"。
IP_SERVICES = [
    ("ip-api.com", "http://ip-api.com/json/?fields=query,org,isp,as,country,city"),
    ("ipinfo.io", "https://ipinfo.io/json"),
    ("ifconfig.co", "https://ifconfig.co/json"),
]


def probe_egress_ip() -> dict:
    for name, url in IP_SERVICES:
        try:
            with urllib.request.urlopen(url, timeout=8) as r:  # noqa: S310
                d = json.loads(r.read().decode("utf-8", "replace"))
            return {"source": name,
                    "ip": d.get("query") or d.get("ip") or "",
                    "org": d.get("org") or d.get("asn_org") or d.get("isp") or "",
                    "asn": d.get("as") or d.get("asn") or "",
                    "country": d.get("country") or d.get("country_iso") or "",
                    "city": d.get("city") or ""}
        except Exception as e:  # noqa: BLE001
            log.debug("ip service %s failed: %s", name, e)
    return {"source": "", "error": "所有出口 IP 查询源都不可达（本机可能完全没有外网）"}


def probe_environment(cdp_url: str) -> dict:
    env: dict = {"python": sys.version.split()[0], "platform": sys.platform}
    try:
        import importlib.metadata as _md  # noqa: PLC0415
        env["playwright"] = _md.version("playwright")
    except Exception:  # noqa: BLE001
        env["playwright"] = "未安装"
    env["browser_exe"] = find_browser() or "未找到 Chrome/Edge"
    env["profile_dir"] = str(default_profile_dir())
    env["cdp_url"] = cdp_url
    env["cdp_alive"] = cdp_alive(cdp_url)
    if env["cdp_alive"]:
        try:
            with urllib.request.urlopen(  # noqa: S310
                    cdp_url.rstrip("/") + "/json/version", timeout=5) as r:
                env["browser_version"] = json.loads(r.read()).get("Browser", "")
        except Exception:  # noqa: BLE001
            pass
    return env


def diagnose_direct(doi: str, email: str) -> dict:
    """不开浏览器的直连尝试——机构 IP 授权在这条路上也可能直接生效。"""
    import tempfile  # noqa: PLC0415
    from fetch_oa import download_from_landing  # noqa: PLC0415
    rec: dict = {"ok": False}
    tmp = Path(tempfile.gettempdir()) / f"_diag_{safe_doi_name(doi)}.pdf"
    try:
        rec["ok"] = bool(download_from_landing(
            f"https://doi.org/{urllib.parse.quote(doi, safe='/')}", tmp, email))
        if rec["ok"]:
            rec["size_bytes"] = tmp.stat().st_size
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
    finally:
        tmp.unlink(missing_ok=True)
    return rec


def diagnose_browser(context, doi: str, email: str = CONTACT_EMAIL,
                     gateway: tuple[str, str] | None = None) -> dict:
    """浏览器通道的**完整轨迹**——只记不留文件。逐步记录是关键：光有成败无法定位。"""
    rec: dict = {"ok": False}
    page = context.new_page()
    try:
        entry = entry_url_for(doi, email, gateway)
        rec["entry_url"] = entry[:200]
        page.goto(entry, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)
        rec["landed_url"] = page.url[:200]
        try:
            rec["page_title"] = (page.title() or "")[:120]
        except Exception:  # noqa: BLE001
            rec["page_title"] = ""
        rec["challenge"] = looks_like_challenge(page)
        rec["auth_page"] = looks_like_auth_page(page)
        rec["paywalled"] = looks_paywalled(page)
        cands = collect_pdf_candidates(page)
        rec["pdf_candidates"] = len(cands)
        rec["first_candidate"] = cands[0][:200] if cands else ""
        for url in cands:
            absolute = urllib.parse.urljoin(page.url, url)
            body = try_download(context, page, absolute, page.url)
            if body:
                rec.update(ok=True, size_bytes=len(body),
                           head=body[:8].decode("latin-1", "replace"))
                break
        if not rec["ok"]:
            rec["verdict"] = ("challenge" if rec["challenge"] else
                              "needs-login" if rec["auth_page"] else
                              "paywalled" if rec["paywalled"] else
                              "no-pdf-link" if not cands else "download-failed")
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
        # 网络层失败要和"访问被拒"分开：前者是这张网到该站点根本不通（DNS 污染、
        # 连接重置、被墙），跟订阅权限无关；混成一个 "error" 会让人去查错方向。
        msg = str(e)
        rec["verdict"] = ("unreachable" if any(
            k in msg for k in ("ERR_CONNECTION", "ERR_NAME_NOT_RESOLVED",
                               "ERR_TIMED_OUT", "ERR_SSL", "ERR_ADDRESS",
                               "ERR_EMPTY_RESPONSE", "Timeout"))
            else "error")
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
    return rec


_VERDICT_CN = {
    "challenge": "人机验证页（需人工在浏览器里点一次）",
    "needs-login": "要登录（该出版商不认 IP）",
    "paywalled": "页面挂着购买入口 → 本机构未订购",
    "no-pdf-link": "页面上没有全文直链",
    "download-failed": "找到了链接但下载失败（多为无权限）",
    "unreachable": "网络层就不通（连接被重置/解析失败）——与订阅权限无关",
    "no-browser": "浏览器通道没跑起来（见第二节 cdp_alive）",
    "error": "该条出错（详见 json）",
}


def render_diagnose_md(report: dict) -> str:
    ip = report["egress_ip"]
    env = report["environment"]
    L = ["# 机构网络自检报告", "",
         f"生成时间：{report['generated_at']}", ""]
    L += ["## 一、你在哪张网里（最关键）", "",
          f"- 出口 IP：**{ip.get('ip', '?')}**（来源 {ip.get('source') or '查询失败'}）",
          f"- 归属：**{ip.get('org') or '未知'}** {ip.get('asn', '')}",
          f"- 位置：{ip.get('country', '')} {ip.get('city', '')}", ""]
    if ip.get("error"):
        L += [f"- ⚠ {ip['error']}", ""]
    L += ["> 归属若不是学校 / 医院 / 图书馆，说明这台机器**不在机构网段里**"
          "（常见：连了 VPN、连的是访客 WiFi），机构订阅本来就不会生效。", ""]
    L += ["## 二、运行环境", ""]
    L += [f"- {k}：{v}" for k, v in env.items()]
    wv = report.get("webvpn") or {}
    if wv.get("detected"):
        L += [f"- **WebVPN 网关：{wv['gateway']}**（这所机构走 URL 改写型代理，"
              "已自动识别，下载会经它走）"]
    elif "webvpn" in report:
        L += ["- WebVPN：未识别到（说明不是 URL 改写型代理，或用户还没在这个浏览器"
              "窗口里登录过学校 VPN）"]
    L += ["", "## 三、逐篇探针结果", "",
          "| 出版商 | 直连 | 浏览器 | 判定 | 大小 |", "|---|---|---|---|---|"]
    for p in report["probes"]:
        d, b = p["direct"], p["browser"]
        size = b.get("size_bytes") or d.get("size_bytes") or 0
        verdict = ("成功" if (d["ok"] or b["ok"])
                   else _VERDICT_CN.get(b.get("verdict", ""), b.get("verdict", "?")))
        L.append(f"| {p['publisher']} | {'✅' if d['ok'] else '❌'} | "
                 f"{'✅' if b['ok'] else '❌'} | {verdict} | "
                 f"{size // 1024} KB |")
    L += ["", "## 四、怎么读这份报告", "",
          "1. **先看 OA 对照组那一行**：它也失败 → 是网络/代理问题，与订阅权限无关，"
          "后面几行不用细看；它成功而订阅篇全败 → 网络通，问题在权限或出版商。",
          "2. 大量「未订购」→ 本机构确实没买这些刊，正常。",
          "3. 大量「人机验证」→ 让操作的人去那个浏览器窗口手动点一次验证，再重跑。",
          "4. 大量「要登录」→ 该机构不是 IP 授权制，需要先在浏览器里经 CARSI / 图书馆登录。", "",
          "完整逐步轨迹（落地 URL、页面标题、找到几个候选链接等）在同名 .json 里。", ""]
    return "\n".join(L)


def run_diagnose(cdp_url: str, email: str, profile_dir: Path | None,
                 auto_launch: bool, delay: float) -> int:
    print("机构网络自检：将访问 7 篇探针文献（1 篇 OA 对照 + 6 家主流出版商各 1 篇）。")
    print("⚠ 报告里会包含这台机器的**出口 IP 与网络归属**（用来判断你是否真的在机构"
          "网段里）。发给别人前请自行确认可接受。\n")
    report: dict = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "egress_ip": probe_egress_ip(),
    }
    print(f"· 出口 IP：{report['egress_ip'].get('ip', '?')}"
          f"（{report['egress_ip'].get('org', '未知')}）", flush=True)

    if not cdp_alive(cdp_url) and auto_launch:
        ok, msg = launch_browser(cdp_url, profile_dir)
        print(("· ✅ " if ok else "· ❌ ") + msg, flush=True)
    report["environment"] = probe_environment(cdp_url)

    try:
        from playwright.sync_api import sync_playwright  # noqa: PLC0415
    except ImportError:
        print(PW_HELP)
        return 2

    pw = sync_playwright().start()
    try:
        context = None
        if report["environment"]["cdp_alive"]:
            try:
                browser = pw.chromium.connect_over_cdp(cdp_url)
                context = (browser.contexts[0] if browser.contexts
                           else browser.new_context())
            except Exception as e:  # noqa: BLE001
                report["environment"]["cdp_connect_error"] = str(e)[:200]
        # 识别出网关 = 这所机构走的是 URL 改写型代理（WebVPN）。这一项在远程定位里
        # 分量很重：没识别到而订阅篇全败，多半是 IP 授权没生效或根本没在机构网里。
        gw = None
        if context is not None:
            gw = auto_webvpn(context)
            report["webvpn"] = ({"detected": True, "gateway": f"{gw[0]}://{gw[1]}"}
                                if gw else {"detected": False})
            if gw:
                print(f"· 识别到 WebVPN 网关：{gw[0]}://{gw[1]}", flush=True)
        probes = []
        for i, p in enumerate(PROBES, 1):
            print(f"  [{i}/{len(PROBES)}] {p['publisher']} …", end=" ", flush=True)
            rec = {"doi": p["doi"], "publisher": p["publisher"],
                   "is_oa_control": bool(p.get("oa"))}
            rec["direct"] = diagnose_direct(p["doi"], email)
            rec["browser"] = (diagnose_browser(context, p["doi"], email, gw)
                              if context else {"ok": False, "verdict": "no-browser"})
            probes.append(rec)
            print("直连 " + ("OK" if rec["direct"]["ok"] else "×")
                  + " / 浏览器 " + ("OK" if rec["browser"]["ok"] else "×"), flush=True)
            if i < len(PROBES):
                time.sleep(delay)
        report["probes"] = probes
    finally:
        pw.stop()

    Path("机构网络自检报告.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    Path("机构网络自检报告.md").write_text(
        render_diagnose_md(report), encoding="utf-8")
    ok_n = sum(1 for p in report["probes"]
               if p["direct"]["ok"] or p["browser"]["ok"])
    print(f"\n完成：{ok_n}/{len(report['probes'])} 篇取到全文。")
    print("报告已写出：机构网络自检报告.md（人看）、机构网络自检报告.json（细节）")
    print("把这两个文件整个发回来即可定位问题。")
    return 0


CDP_HELP = """\
无法连接 Chrome CDP（{url}），自动启动也没成功。机构通道需要一个带调试端口的浏览器：

0) 先试试让脚本自己起（推荐，什么都不用敲）：
     python fetch_institutional.py --launch-browser
   起不来再按下面手动来。

1) 用【专用资料目录】启动 Chrome（Chrome 136+ 禁止对默认资料目录开 CDP）：
   Windows (PowerShell):
     & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" `
       --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\\sci-scholar-chrome"
   macOS:
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
       --remote-debugging-port=9222 --user-data-dir="$HOME/.sci-scholar-chrome"
   Linux:
     google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.sci-scholar-chrome"
   （没有 Chrome 用 Edge 也行：把可执行文件换成 msedge。）

2) 首次使用：在该窗口打开学校图书馆 / CARSI（https://www.carsi.edu.cn）完成一次
   登录。会话保存在专用资料目录里，之后运行本脚本直接复用，无需每次登录。

3) 重新运行本脚本。CDP 地址非默认时用 --cdp 或环境变量 SCI_CDP_URL 指定。

服务器 / 无浏览器环境：本通道不可用（这是预期行为，非故障）。请改在装有
浏览器的本机运行，或只用 fetch_oa.py 的 OA 渠道。
"""

PW_HELP = """\
缺依赖 playwright（仅本机构通道需要；OA 主管线 fetch_oa.py 仍是零依赖）。
安装（挂接现有 Chrome，**不需要** `playwright install` 下载浏览器内核）：
    "${REPO_ROOT:-/app}/.venv/bin/python" -m pip install playwright
"""


# ============================================================
# Worklist（复用 fetch_oa 的 read_doi_file，再兼容 manual_needed.txt 行格式）
# ============================================================

_PMID_LINE_RE = re.compile(r"(?i)^pmid[:：]\s*(\d+)$")


def load_worklist(path: Path) -> list[dict]:
    """读 worklist。除 fetch_oa 支持的格式外，兼容 manual_needed.txt 的三种行：
    DOI、`PMID:123`、裸标题（fetch_oa 的纯文本路径会把它们都当 DOI，这里纠正）。"""
    records = read_doi_file(path)
    for rec in records:
        raw = (rec.get("doi") or "").strip()
        rec["_raw"] = raw or rec.get("pmid") or rec.get("title") or ""
        if not raw:
            continue
        m = _PMID_LINE_RE.match(raw)
        if m:
            rec["doi"], rec["pmid"] = "", m.group(1)
        elif not raw.startswith("10."):
            rec["doi"], rec["title"] = "", raw
    return records


def resolve_doi(rec: dict, email: str) -> str:
    doi = (rec.get("doi") or "").strip()
    if doi:
        return doi
    return (pmid_to_doi(rec.get("pmid", ""), email)
            or title_to_doi(rec.get("title", ""), email) or "")


# ============================================================
# 浏览器侧：登录墙检测 → 等用户 → 找 PDF 链接 → 带会话下载
# ============================================================

def bounced_to_gateway(page, gateway: tuple[str, str] | None) -> bool:
    """走 WebVPN 时被弹回**网关门户本身** = 没登录（或会话过期）。

    实测未登录访问改写地址会 302 到 `https://<网关>/portal/?redirect_uri=...`。落地主机
    等于网关主机、却没有被编码的目标前缀，就是这种情况。不单独判的话它会被记成
    "no-pdf-link"，把"你没登录"说成"这篇没有全文链接"，方向就错了。"""
    if not gateway:
        return False
    try:
        host = (urllib.parse.urlparse(page.url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return False
    gw_host = gateway[1].split(":")[0].lower()
    return host == gw_host          # 带前缀时 host 是 xxx-s.<网关>，不会相等


def looks_like_auth_page(page) -> bool:
    url = page.url.lower()
    if any(h in url for h in AUTH_URL_HINTS):
        return True
    try:
        title = (page.title() or "").lower()
        if any(h in title for h in CHALLENGE_TITLE_HINTS):
            return True
    except Exception:
        pass
    try:
        return page.locator("input[type='password']").first.is_visible(timeout=800)
    except Exception:
        return False


def wait_for_user_login(page, timeout_s: int) -> bool:
    """检测到登录墙 / 人机验证：不代填任何凭证，只提示用户去浏览器窗口完成，
    轮询等待页面离开认证域。返回是否等到。"""
    print("\n  ⏸ 命中登录页/验证页 —— 请到 Chrome 窗口完成登录（CARSI 选校 / 统一"
          f"身份认证 / 人机验证），脚本最多等 {timeout_s}s，登录成功后自动继续 …",
          flush=True)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        time.sleep(3)
        try:
            if not looks_like_auth_page(page):
                page.wait_for_timeout(SETTLE_MS)
                print("  ▶ 检测到已通过认证，继续。", flush=True)
                return True
        except Exception:
            pass
    return False


_COLLECT_JS = """() => {
  const out = [];
  const m = document.querySelector('meta[name="citation_pdf_url"]');
  if (m && m.content) out.push(m.content);
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href || '';
    if (/\\.pdf($|[?#])/i.test(h) || /\\/(pdf|epdf|pdfdirect)\\//i.test(h)) out.push(h);
  }
  return [...new Set(out)];
}"""

_FETCH_JS = """async url => {
  const r = await fetch(url, {credentials: 'include'});
  if (!r.ok) return null;
  const blob = await r.blob();
  return await new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.readAsDataURL(blob);
  });
}"""


# 付费墙特征：出版商在未授权时几乎必然给出"购买 / 获取访问权限"入口。
# 只读 DOM 文本，不点任何东西。命中只用来把 FAIL 的原因标成 paywalled，
# 好让用户看得出"这篇是本机构没订"而不是"脚本没找着链接"。
_PAYWALL_JS = """() => {
  const sel = '.access-options, .get-access, [class*="GetAccess"], ' +
              '[class*="purchase"], [data-test*="access"], [class*="paywall"]';
  if (document.querySelector(sel)) return true;
  const t = (document.body ? document.body.innerText : '').slice(0, 20000);
  return /get access|purchase pdf|buy article|rent this article|订阅后可见|购买本文/i.test(t);
}"""


# Cloudflare 人机验证页的特征。**只用来把失败原因标准确，绝不自动点它**——
# 过验证是用户自己在浏览器窗口里做的事（实测：Elsevier/Cell 在非机构网络下
# 返回的就是这个页，而不是付费墙，标成 no-pdf-link 会让用户误以为是脚本没找着链接）。
_CHALLENGE_JS = """() => {
  if (document.querySelector('#challenge-form, #cf-chl-widget, ' +
      'iframe[src*="challenges.cloudflare.com"], iframe[title*="verification"]')) return true;
  const t = (document.body ? document.body.innerText : '').slice(0, 3000);
  return /just a moment|checking your browser|ray id|安全验证|请稍候|正在验证/i.test(t);
}"""


def collect_pdf_candidates(page) -> list[str]:
    cands: list[str] = []
    u = page.url
    if re.search(r"\.pdf($|[?#])", u, re.IGNORECASE):
        cands.append(u)
    try:
        for c in page.evaluate(_COLLECT_JS):
            if c not in cands:
                cands.append(c)
    except Exception as e:
        log.debug("candidate collection failed on %s: %s", u, e)
    return cands[:MAX_PDF_CANDIDATES]


def try_download(context, page, url: str, referer: str) -> bytes | None:
    """先走 context.request（共享浏览器 cookie、无 CORS 限制），失败再退回
    页面内 fetch（真实浏览器指纹，对部分风控更稳，但受 CORS 约束）。"""
    try:
        resp = context.request.get(
            url, timeout=NAV_TIMEOUT_MS,
            headers={"Referer": referer, "Accept": "application/pdf,*/*"})
        if resp.ok:
            body = resp.body()
            if is_valid_pdf(body):
                return body
    except Exception as e:
        log.debug("context.request failed for %s: %s", url, e)
    try:
        b64 = page.evaluate(_FETCH_JS, url)
        if b64:
            body = base64.b64decode(b64)
            if is_valid_pdf(body):
                return body
    except Exception as e:
        log.debug("in-page fetch failed for %s: %s", url, e)
    return None


def looks_paywalled(page) -> bool:
    """页面明确挂着"购买 / 获取访问权限"入口 → 本机构大概率**没订**这篇。
    只用于把失败原因分得更准（paywalled ≠ 没找到链接），不改变任何行为。"""
    try:
        return bool(page.evaluate(_PAYWALL_JS))
    except Exception:
        return False


def looks_like_challenge(page) -> bool:
    """命中人机验证页。同样只用于给失败原因分类，**不自动通过任何验证**。

    标题要单独判：Cloudflare 拦截页刚渲染出来时 body 往往还是空的，只有 <title>
    已经是 "Just a moment..." / "请稍候"。只看 DOM 和正文会漏判，然后被后面的
    looks_like_auth_page 按 URL 特征捡走、误报成"要登录"——实测 Elsevier 就是这样，
    结果把人引去登录 CARSI，方向完全错了。"""
    try:
        title = (page.title() or "").lower()
        if any(h in title for h in CHALLENGE_TITLE_HINTS):
            return True
    except Exception:  # noqa: BLE001
        pass
    try:
        return bool(page.evaluate(_CHALLENGE_JS))
    except Exception:
        return False


def _try_take_pdf(context, page, outpath: Path) -> bool:
    """在当前页面上找 PDF 直链并下载，成功即写盘。"""
    candidates = collect_pdf_candidates(page)
    if not candidates:
        return False
    referer = page.url
    for url in candidates:
        absolute = urllib.parse.urljoin(referer, url)
        body = try_download(context, page, absolute, referer)
        if body:
            outpath.write_bytes(body)
            return True
    return False


def process_record(context, rec: dict, outdir: Path, email: str,
                   login_timeout: int, ip_only: bool = False,
                   gateway: tuple[str, str] | None = None) -> tuple[str, str]:
    """一条记录：DOI 落实 → 浏览器落地 → 先直接取 PDF → 取不到再判登录墙。

    **先取后判**是刻意的：机构若是 **IP 授权制**（机器在校园网 / 机构网段内），
    落地页当场就是已授权状态，根本不会出现登录墙——此时任何"先判认证页"的
    启发式都只可能**误判**，而一次误判就是白等 login_timeout 秒（默认 240s），
    20 条能空转一个多小时。所以把认证判断降级成"拿不到 PDF 时才问的兜底"。

    返回 (status, source)，status ∈ {institutional, skip, fail}。"""
    doi = resolve_doi(rec, email)
    if not doi:
        return ("fail", "unresolved")
    rec["doi"] = doi
    outpath = outdir / f"{safe_doi_name(doi)}.pdf"
    if existing_pdf_ok(outpath):
        return ("skip", "existing")

    page = context.new_page()
    try:
        page.goto(entry_url_for(doi, email, gateway),
                  wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)

        # 第一轮：直接试。IP 授权制下绝大多数在这里就成了。
        if _try_take_pdf(context, page, outpath):
            return ("institutional", "browser")

        # 没拿到才问：谁挡着？两种都要人来处理，但**原因必须分开标**——
        # 人机验证和"要登录"给用户的下一步动作完全不同（前者点一下验证框，
        # 后者得去 CARSI 登录），混成一个标签只会把人引到错误的方向。
        # 顺序：先判人机验证，因为 looks_like_auth_page 的标题特征里混着验证页的词。
        blocker = ("challenge" if looks_like_challenge(page)
                   else "needs-login" if (bounced_to_gateway(page, gateway)
                                          or looks_like_auth_page(page)) else "")
        if blocker:
            if ip_only:
                # 纯 IP 制批量（无人值守）：不等人，记下来继续下一条。
                return ("fail", blocker)
            if not wait_for_user_login(page, login_timeout):
                return ("fail", f"{blocker}-timeout")
            # 第二轮：用户处理完再试一次。
            if _try_take_pdf(context, page, outpath):
                return ("institutional", "browser")

        if looks_paywalled(page):
            return ("fail", "paywalled")
        return ("fail", "no-pdf-link")
    except Exception as e:  # noqa: BLE001 —— 单条隔离，绝不拖垮整批
        log.debug("record error for %s: %s", doi, e)
        return ("fail", "error")
    finally:
        try:
            page.close()
        except Exception:
            pass


# ============================================================
# 报告合并（与 fetch_oa 的 retrieval_report.json 同一份、同 schema）
# ============================================================

_RETRIEVED = ("oa", "pmc", "arxiv", "institutional")


def merge_into_report(report_path: Path, records: list[dict], outdir: Path) -> dict:
    if report_path.exists():
        data = json.loads(report_path.read_text(encoding="utf-8"))
    else:
        data = {"schema_version": 1, "generated_by": "fetch_oa.py",
                "counts": {}, "items": []}
    data["generated_by"] = data.get("generated_by", "fetch_oa.py")
    if "fetch_institutional" not in data["generated_by"]:
        data["generated_by"] += " + fetch_institutional.py"

    by_doi = {i.get("doi"): i for i in data["items"] if i.get("doi")}
    for rec in records:
        doi = rec.get("doi", "")
        status, source = rec.get("_status", "fail"), rec.get("_source", "")
        item = by_doi.get(doi)
        if item is None:
            item = {"doi": doi, "pmid": rec.get("pmid", ""),
                    "title": rec.get("title", ""), "status": status,
                    "source": source, "file": "", "size_bytes": 0,
                    "title_match": "unavailable"}
            data["items"].append(item)
            if doi:
                by_doi[doi] = item
        elif item.get("status") in _RETRIEVED and status == "fail":
            continue  # 绝不把既有成功降级成失败
        path = outdir / f"{safe_doi_name(doi)}.pdf" if doi else None
        if status == "institutional" and path and path.exists():
            item.update(status=status, source=source, file=path.name,
                        size_bytes=path.stat().st_size)
            if rec.get("title"):
                text = extract_pdf_text(path)
                item["title_match"] = classify_title_match(rec["title"], text)
        elif item.get("status") not in _RETRIEVED + ("skip",):
            item.update(status=status, source=source)

    items = data["items"]
    fresh = [i for i in items if i["status"] in _RETRIEVED]
    data["counts"] = {
        "total": len(items),
        "retrieved": len(fresh),
        "already_present": sum(1 for i in items if i["status"] == "skip"),
        "available": len(fresh) + sum(1 for i in items if i["status"] == "skip"),
        "not_retrieved": sum(1 for i in items if i["status"] == "fail"),
        "institutional": sum(1 for i in items if i["status"] == "institutional"),
        "title_mismatch": sum(1 for i in items
                              if i.get("title_match") == "mismatch"),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")
    return data


def rewrite_manual_list(path: Path, records: list[dict], outdir: Path) -> None:
    """输入就是 manual_needed.txt 时：把这次下到的从清单里划掉，仍失败的保留。"""
    still = []
    for rec in records:
        doi = rec.get("doi", "")
        pdf = outdir / f"{safe_doi_name(doi)}.pdf" if doi else None
        if pdf is not None and existing_pdf_ok(pdf):
            continue
        if rec.get("_raw"):
            still.append(rec["_raw"])
    with open(path, "w", encoding="utf-8") as f:
        f.write("# DOIs needing manual retrieval\n")
        f.write("# Options: institutional access (fetch_institutional.py), ILL\n\n")
        for ident in still:
            f.write(f"{ident}\n")


# ============================================================
# Main
# ============================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description="机构通道（CARSI/浏览器登录态）全文获取——OA 管线失败后的第二梯队。")
    parser.add_argument("input", type=Path, nargs="?",
                        help="worklist：fetch_oa 的 manual_needed.txt，或任何 "
                             "fetch_oa 支持的 DOI 清单格式（用 --launch-browser 时可省）")
    parser.add_argument("-o", "--output", type=Path, default=Path("pdfs"),
                        help="输出目录（默认 pdfs/，与 fetch_oa 共用）")
    parser.add_argument("-e", "--email", default=CONTACT_EMAIL,
                        help="联系邮箱（PMID/标题解析 DOI 用）")
    parser.add_argument("--cdp", default=DEFAULT_CDP_URL,
                        help=f"Chrome CDP 地址（默认 {DEFAULT_CDP_URL}，"
                             "亦可用环境变量 SCI_CDP_URL）")
    parser.add_argument("--no-auto-launch", action="store_true",
                        help="探测不到 CDP 时不要自动启动浏览器（默认会自动起一个带调试"
                             "端口的 Chrome/Edge，用专用资料目录）")
    parser.add_argument("--launch-browser", action="store_true",
                        help="只把带调试端口的浏览器起起来就退出（给用户先登录用），不下载")
    parser.add_argument("--webvpn", default=os.environ.get("SCI_WEBVPN", ""),
                        help="学校 WebVPN 网关（URL 改写型代理），形如 "
                             "webvpn.njmu.edu.cn:8118。这类代理只对带前缀的 URL 授权，"
                             "光在浏览器里登录不够，必须改写地址。不填则自动从浏览器"
                             "已打开的页面里识别。亦可用环境变量 SCI_WEBVPN")
    parser.add_argument("--no-webvpn", action="store_true",
                        help="关掉 WebVPN 自动识别（识别错了、或你走的是 IP 授权/CARSI 时用）")
    parser.add_argument("--diagnose", action="store_true",
                        help="机构网络自检：查出口 IP 归属 + 对 7 篇探针（1 篇 OA 对照 + "
                             "6 家主流出版商）逐步取证，产出可发回的报告。远程代测必用")
    parser.add_argument("--profile-dir", default=None,
                        help=f"浏览器专用资料目录（默认 {default_profile_dir()}）")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_S,
                        help=f"逐条间隔秒数（默认 {DEFAULT_DELAY_S}，下限 {MIN_DELAY_S}）")
    parser.add_argument("--max", type=int, default=DEFAULT_MAX_RECORDS,
                        dest="max_records",
                        help=f"单次最多处理条数（默认 {DEFAULT_MAX_RECORDS}；防出版商"
                             "批量下载风控，超出部分下次再跑）")
    parser.add_argument("--login-timeout", type=int, default=DEFAULT_LOGIN_TIMEOUT_S,
                        help="登录墙等待用户完成登录的秒数上限")
    parser.add_argument("--ip-only", action="store_true",
                        help="纯 IP 授权制机构（机器就在校园网/机构网段内，无需 CARSI "
                             "登录）：遇到登录墙不等用户，直接记 needs-login 继续下一条，"
                             "适合无人值守批量。默认关闭（会等用户在 Chrome 里登录）")
    parser.add_argument("--report", type=Path, default=None,
                        help="报告路径（默认 <output>/retrieval_report.json，"
                             "与 fetch_oa 同一份、原地合并）")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s: %(message)s")

    profile_dir = Path(args.profile_dir) if args.profile_dir else None

    gateway = None
    if args.webvpn:
        try:
            gateway = parse_webvpn_gateway(args.webvpn)
        except ValueError as e:
            print(f"❌ {e}")
            return 2
        print(f"· WebVPN 模式：目标地址将改写到 {gateway[0]}://…{gateway[1]}")
        print("  前提：先在那个 Chrome 窗口里登录一次学校 WebVPN，否则会落到登录页。")

    # --launch-browser：只把浏览器起起来（给用户先登录 / 先确认在校园网里），不下载。
    if args.launch_browser:
        ok, msg = launch_browser(args.cdp, profile_dir)
        print(("✅ " if ok else "❌ ") + msg)
        if ok:
            print("这是一个**独立的浏览器资料目录**，和你平时用的 Chrome 互不影响。\n"
                  "· 学校/医院是 IP 授权制（机器就在单位网里）：不用登录任何东西，直接开下。\n"
                  "· 要走 CARSI / 图书馆账号：在这个新窗口里登录一次，以后一直复用。")
        return 0 if ok else 2

    if args.diagnose:
        return run_diagnose(args.cdp, args.email, profile_dir,
                            not args.no_auto_launch, max(args.delay, MIN_DELAY_S))

    if args.input is None:
        parser.error("缺少 worklist（自检用 --diagnose，只起浏览器用 --launch-browser）")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(PW_HELP)
        return 2

    # 探测不到调试端口就自己起一个——不让用户去敲 --remote-debugging-port。
    if not cdp_alive(args.cdp) and not args.no_auto_launch:
        print("· 没检测到带调试端口的浏览器，正在为你启动 …", flush=True)
        ok, msg = launch_browser(args.cdp, profile_dir)
        print(("  ✅ " if ok else "  ❌ ") + msg, flush=True)

    records = load_worklist(args.input)
    if not records:
        print(f"{args.input} 里没有可处理的记录。")
        return 0
    if len(records) > args.max_records:
        print(f"⚠ 清单 {len(records)} 条 > 单次上限 {args.max_records} 条，本次只处理前 "
              f"{args.max_records} 条（机构通道刻意限量：出版商对批量下载有风控，"
              f"触发会连累全机构访问权限）。剩余的再跑一次即可续传；确要放宽用 --max。")
        records = records[:args.max_records]

    delay = max(args.delay, MIN_DELAY_S)
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.report or (args.output / "retrieval_report.json")

    pw = sync_playwright().start()
    try:
        try:
            browser = pw.chromium.connect_over_cdp(args.cdp)
        except Exception:
            print(CDP_HELP.format(url=args.cdp))
            return 2
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        # 没显式给网关时，看看用户是不是已经经 WebVPN 开着页面——是的话直接认出来。
        if gateway is None and not args.no_webvpn:
            detected = auto_webvpn(context)
            if detected:
                gateway = detected
                print(f"· 自动识别到 WebVPN 网关：{detected[0]}://{detected[1]}"
                      "（来自浏览器里已打开的页面）")
                print("  识别错了或不想走代理：加 --no-webvpn。")

        stats = {"institutional": 0, "skip": 0, "fail": 0}
        fail_reasons: dict[str, int] = {}
        labels = {"institutional": "OK (机构通道)", "skip": "SKIP", "fail": "FAIL"}
        for i, rec in enumerate(records, 1):
            disp = rec.get("doi") or rec.get("_raw") or "?"
            print(f"  [{i}/{len(records)}] {disp}", end=" … ", flush=True)
            try:
                status, source = process_record(
                    context, rec, args.output, args.email, args.login_timeout,
                    ip_only=args.ip_only, gateway=gateway)
            except Exception as e:  # noqa: BLE001
                status, source = ("fail", "error")
                log.debug("unhandled error for %s: %s", disp, e)
            rec["_status"], rec["_source"] = status, source
            stats[status] += 1
            if status == "fail":
                fail_reasons[source or "unknown"] = fail_reasons.get(source or "unknown", 0) + 1
            suffix = f" ({source})" if status == "fail" and source else ""
            print(labels[status] + suffix, flush=True)
            if i < len(records):
                time.sleep(delay)

        report = merge_into_report(report_path, records, args.output)
        if args.input.name == "manual_needed.txt":
            rewrite_manual_list(args.input, records, args.output)

        print("\n--- Summary（机构通道）---")
        print(f"  下到:   {stats['institutional']}")
        print(f"  已存在: {stats['skip']}")
        print(f"  失败:   {stats['fail']}  （原因见各行标注；报告里有逐条记录）")
        if fail_reasons:
            # 失败原因要分开报：paywalled = 本机构没订这篇（换馆际互借），
            # needs-login = 不是 IP 制、得先登录，两者的下一步动作完全不同。
            detail = "、".join(f"{k} {v}" for k, v in sorted(fail_reasons.items()))
            print(f"          失败原因分布：{detail}")
            if fail_reasons.get("paywalled"):
                print("          · paywalled = 落地页仍挂着购买入口 → 本机构大概率"
                      "未订购这篇，走馆际互借 / 找作者要。")
            if fail_reasons.get("challenge"):
                print("          · challenge = 出版商弹了人机验证（脚本绝不自动过）→ 去 Chrome "
                      "窗口手动点一次验证，同一站点之后一般就放行了，再重跑。")
            if fail_reasons.get("needs-login"):
                print("          · needs-login = 出版商要登录（不是纯 IP 授权）→ 去 Chrome "
                      "窗口经 CARSI/图书馆登录一次，再不带 --ip-only 重跑。")
        print(f"  报告:   {report_path}（counts.institutional="
              f"{report['counts']['institutional']}）")
        return 0
    finally:
        pw.stop()


if __name__ == "__main__":
    sys.exit(main())
