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
import sys
import time
import urllib.parse
from pathlib import Path

# 同目录的 fetch_oa 提供解析 / 校验 / 报告基建，避免两套实现漂移。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_oa import (  # noqa: E402
    CONTACT_EMAIL, classify_title_match, existing_pdf_ok, extract_pdf_text,
    is_valid_pdf, pmid_to_doi, read_doi_file, safe_doi_name, title_to_doi,
)

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
                         "访问验证", "安全验证", "请稍候")

CDP_HELP = """\
无法连接 Chrome CDP（{url}）。机构通道需要挂接你本机已登录的 Chrome：

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


def process_record(context, rec: dict, outdir: Path, email: str,
                   login_timeout: int) -> tuple[str, str]:
    """一条记录：DOI 落实 → 浏览器落地 → （可能）等登录 → 抓 PDF。
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
        page.goto(f"https://doi.org/{urllib.parse.quote(doi, safe='/')}",
                  wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)
        if looks_like_auth_page(page):
            if not wait_for_user_login(page, login_timeout):
                return ("fail", "login-timeout")
        candidates = collect_pdf_candidates(page)
        if not candidates:
            return ("fail", "no-pdf-link")
        referer = page.url
        for url in candidates:
            absolute = urllib.parse.urljoin(referer, url)
            body = try_download(context, page, absolute, referer)
            if body:
                outpath.write_bytes(body)
                return ("institutional", "browser")
        return ("fail", "no-valid-pdf")
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
    parser.add_argument("input", type=Path,
                        help="worklist：fetch_oa 的 manual_needed.txt，或任何 "
                             "fetch_oa 支持的 DOI 清单格式")
    parser.add_argument("-o", "--output", type=Path, default=Path("pdfs"),
                        help="输出目录（默认 pdfs/，与 fetch_oa 共用）")
    parser.add_argument("-e", "--email", default=CONTACT_EMAIL,
                        help="联系邮箱（PMID/标题解析 DOI 用）")
    parser.add_argument("--cdp", default=DEFAULT_CDP_URL,
                        help=f"Chrome CDP 地址（默认 {DEFAULT_CDP_URL}，"
                             "亦可用环境变量 SCI_CDP_URL）")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_S,
                        help=f"逐条间隔秒数（默认 {DEFAULT_DELAY_S}，下限 {MIN_DELAY_S}）")
    parser.add_argument("--max", type=int, default=DEFAULT_MAX_RECORDS,
                        dest="max_records",
                        help=f"单次最多处理条数（默认 {DEFAULT_MAX_RECORDS}；防出版商"
                             "批量下载风控，超出部分下次再跑）")
    parser.add_argument("--login-timeout", type=int, default=DEFAULT_LOGIN_TIMEOUT_S,
                        help="登录墙等待用户完成登录的秒数上限")
    parser.add_argument("--report", type=Path, default=None,
                        help="报告路径（默认 <output>/retrieval_report.json，"
                             "与 fetch_oa 同一份、原地合并）")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s: %(message)s")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(PW_HELP)
        return 2

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

        stats = {"institutional": 0, "skip": 0, "fail": 0}
        labels = {"institutional": "OK (机构通道)", "skip": "SKIP", "fail": "FAIL"}
        for i, rec in enumerate(records, 1):
            disp = rec.get("doi") or rec.get("_raw") or "?"
            print(f"  [{i}/{len(records)}] {disp}", end=" … ", flush=True)
            try:
                status, source = process_record(
                    context, rec, args.output, args.email, args.login_timeout)
            except Exception as e:  # noqa: BLE001
                status, source = ("fail", "error")
                log.debug("unhandled error for %s: %s", disp, e)
            rec["_status"], rec["_source"] = status, source
            stats[status] += 1
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
        print(f"  报告:   {report_path}（counts.institutional="
              f"{report['counts']['institutional']}）")
        return 0
    finally:
        pw.stop()


if __name__ == "__main__":
    sys.exit(main())
