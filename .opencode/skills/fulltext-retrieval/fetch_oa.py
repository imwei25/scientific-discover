#!/usr/bin/env python3
"""
Open-access full-text PDF batch retrieval.

Pipeline: arXiv (for 10.48550/arXiv.* DOIs) → Unpaywall →
          PMC (Europe PMC REST / OA FTP / web) → OpenAlex → Crossref →
          landing-page scrape.

Usage:
    python fetch_oa.py dois.txt --output pdfs/ --email user@example.com
    python fetch_oa.py worklist.tsv -o pdfs/ -e user@example.com --verbose
    python fetch_oa.py worklist.csv -o pdfs/ -e user@example.com --report pdfs/retrieval_report.json

Worklist formats: plain DOI-per-line, or TSV/CSV/Markdown-table with a DOI
column (optional PMID and Title columns). A Title column enables a best-effort
title cross-check (via `pdftotext` if installed) that flags mislabeled PDFs.
"""

import argparse
import csv
import http.client
import io
import json
import logging
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

MIN_PDF_BYTES = 10 * 1024
USER_AGENT = "medsci-skills/1.0"
# 某些金标 OA 出版商（Nature/Springer 等）对非浏览器 UA 返回 HTML 拦截页而非 PDF。
# 拿到 text/html 时用它带 Referer 重试一次直链，取回真 PDF。
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
REPORT_SCHEMA_VERSION = 1
TITLE_MATCH_THRESHOLD = 0.6
RETRIEVED_STATUSES = ("oa", "pmc", "arxiv", "skip")

# 网络瞬时错误的统一集合。关键：http.client.IncompleteRead 是 HTTPException 的子类，
# **不是** OSError——旧版各 download 函数只 catch (URLError, HTTPError, OSError)，
# 传输被截断时 IncompleteRead 逃逸、拖垮整批下载且不出报告。这里统一纳入。
TRANSIENT_ERRORS = (urllib.error.URLError, urllib.error.HTTPError,
                    http.client.HTTPException, OSError)

log = logging.getLogger("fetch_oa")


# ============================================================
# Helpers
# ============================================================

def _ua(email: str) -> str:
    """Build a polite User-Agent string with contact email."""
    return f"{USER_AGENT} (mailto:{email})"


# --- Contact + optional API keys ---------------------------------------------
# All optional; injected once via deploy/.env → container env (see
# deploy/检索通道-API配置.md). Absent = anonymous free tier (still works, slower).
# One contact var covers every source; the older names are kept for back-compat
# so a server that already set them keeps working without reconfiguration.
CONTACT_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
                 or os.environ.get("MEDSCI_CONTACT_EMAIL")
                 or os.environ.get("CONTACT_EMAIL")
                 or "sci-skill@users.noreply.github.com")


def _ncbi_key_param() -> str:
    """`&api_key=…` when NCBI_API_KEY is set (lifts NCBI 3→10 req/s), else ''."""
    k = os.environ.get("NCBI_API_KEY")
    return f"&api_key={urllib.parse.quote(k)}" if k else ""


def _openalex_key_param() -> str:
    """`&api_key=…` when OPENALEX_API_KEY is set (premium pool), else ''."""
    k = os.environ.get("OPENALEX_API_KEY")
    return f"&api_key={urllib.parse.quote(k)}" if k else ""


def _crossref_headers(email: str) -> dict:
    """Polite-pool UA + the paid Metadata Plus token header when configured."""
    h = {"User-Agent": _ua(email)}
    tok = os.environ.get("CROSSREF_PLUS_TOKEN")
    if tok:
        h["Crossref-Plus-API-Token"] = f"Bearer {tok}"
    return h


def safe_doi_name(doi: str) -> str:
    """Filesystem-safe filename stem for a DOI."""
    return re.sub(r"[^\w\-.]", "_", doi)


def is_valid_pdf(data: bytes) -> bool:
    return data.startswith(b"%PDF-") and len(data) >= MIN_PDF_BYTES


def fetch_bytes(url: str, email: str, accept: str = "*/*",
                timeout: int = 30, retries: int = 2,
                browser_ua: bool = False, referer: str = "") -> tuple[bytes, str, str]:
    """GET url → (body, final_url, content_type)，带瞬时错误退避重试。
    browser_ua/referer 供 Nature/Springer 拦截页兜底用（伪装浏览器直取 PDF）。
    IncompleteRead（传输截断）在此按瞬时错误重试；仍失败才抛出，由调用方兜住。"""
    headers = {"User-Agent": BROWSER_UA if browser_ua else _ua(email), "Accept": accept}
    if referer:
        headers["Referer"] = referer
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read(), resp.geturl(), resp.headers.get("Content-Type", "")
        except http.client.IncompleteRead as e:
            # 截断但已拿到部分字节：若已是合法 PDF 就用它，否则退避重试。
            if is_valid_pdf(e.partial):
                return e.partial, url, "application/pdf"
            last = e
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            # HTTPError（4xx/5xx）多为确定性失败，不重试（除 429/503）。
            code = getattr(e, "code", None)
            if isinstance(e, urllib.error.HTTPError) and code not in (429, 503):
                raise
            last = e
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    if last:
        raise last
    raise urllib.error.URLError("unknown fetch failure")


def save_pdf(data: bytes, path: Path) -> bool:
    if not is_valid_pdf(data):
        return False
    path.write_bytes(data)
    return True


def existing_pdf_ok(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        return is_valid_pdf(path.read_bytes())
    except OSError:
        return False


# ============================================================
# Title cross-check (pure, offline-testable)
# ============================================================

def normalize_title(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = (text or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return " ".join(text.split())


def title_overlap(expected_title: str, extracted_text: str) -> float:
    """Fraction of meaningful expected-title tokens present in extracted text.

    Tokens of length <= 2 are dropped as near-stopwords. Returns 0.0 when the
    expected title has no usable tokens.
    """
    expected = {t for t in normalize_title(expected_title).split() if len(t) > 2}
    if not expected:
        return 0.0
    got = set(normalize_title(extracted_text).split())
    return len(expected & got) / len(expected)


def classify_title_match(expected_title: str, extracted_text,
                         threshold: float = TITLE_MATCH_THRESHOLD) -> str:
    """Tri-state title check: 'match' | 'mismatch' | 'unavailable'.

    'unavailable' when no expected title is supplied or no extracted text is
    available (e.g. pdftotext absent). A low overlap is 'mismatch' — flagged,
    never used to auto-reject a downloaded PDF.
    """
    if not expected_title or not extracted_text:
        return "unavailable"
    return "match" if title_overlap(expected_title, extracted_text) >= threshold else "mismatch"


def extract_pdf_text(path: Path, max_pages: int = 2) -> str | None:
    """Best-effort first-page text for the title cross-check.

    Prefer PyMuPDF (``fitz``) — it ships with this skill (requirements: pymupdf),
    so the title guard works out-of-the-box on Windows where poppler's ``pdftotext``
    is usually absent. Falls back to ``pdftotext`` if fitz is unavailable.
    Returns None when neither can read the file.
    """
    try:
        import fitz  # PyMuPDF
        with fitz.open(path) as doc:
            parts = [doc[i].get_text() for i in range(min(max_pages, doc.page_count))]
        text = "\n".join(parts).strip()
        if text:
            return text
    except Exception as e:  # ImportError or any parse error -> try poppler next
        log.debug("PyMuPDF text extraction failed for %s: %s", path, e)

    if shutil.which("pdftotext"):
        try:
            out = subprocess.run(
                ["pdftotext", "-f", "1", "-l", str(max_pages), str(path), "-"],
                capture_output=True, timeout=20,
            )
            if out.returncode == 0:
                return out.stdout.decode("utf-8", errors="ignore")
        except (OSError, subprocess.SubprocessError):
            pass
    return None


# ============================================================
# arXiv (direct, for 10.48550/arXiv.* DOIs)
# ============================================================

_ARXIV_DOI_RE = re.compile(r"^10\.48550/arxiv\.(.+)$", re.IGNORECASE)
_ARXIV_ID_RE = re.compile(r"^arxiv:(.+)$", re.IGNORECASE)


def arxiv_id_from_doi(doi: str) -> str | None:
    """Extract an arXiv ID from a DataCite arXiv DOI or a bare arXiv: id.

    Handles new-style (2401.01234, 2401.01234v2) and old-style
    (hep-th/9901001) identifiers; version suffix preserved when present.
    """
    s = (doi or "").strip()
    m = _ARXIV_DOI_RE.match(s) or _ARXIV_ID_RE.match(s)
    return m.group(1).strip() if m else None


def arxiv_pdf_url(doi: str) -> str | None:
    """Direct arXiv PDF URL for an arXiv DOI/ID (None if not an arXiv id)."""
    aid = arxiv_id_from_doi(doi)
    return f"https://arxiv.org/pdf/{aid}" if aid else None


# ============================================================
# 1. Unpaywall
# ============================================================

def unpaywall_lookup(doi: str, email: str) -> str | None:
    url = f"https://api.unpaywall.org/v2/{urllib.parse.quote(doi, safe='/')}" \
          f"?email={urllib.parse.quote(email)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _ua(email)})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        best = data.get("best_oa_location")
        if best and best.get("url_for_pdf"):
            return best["url_for_pdf"]
        for loc in data.get("oa_locations", []):
            if loc.get("url_for_pdf"):
                return loc["url_for_pdf"]
        if best and best.get("url"):
            return best["url"]
    except urllib.error.HTTPError as e:
        if e.code == 422:
            log.warning("Unpaywall rejected email '%s' (HTTP 422). "
                        "Use a real email address, not example.com.", email)
        else:
            log.debug("Unpaywall error for %s: %s", doi, e)
    except (urllib.error.URLError, json.JSONDecodeError) as e:
        log.debug("Unpaywall error for %s: %s", doi, e)
    return None


# ============================================================
# 2. PMC (3-method fallback, JS-challenge resistant)
# ============================================================

def _pmcid_via_europepmc(identifier: str, email: str, is_pmid: bool) -> str | None:
    """DOI/PMID -> PMCID via Europe PMC. Reachable from mainland China, unlike NCBI idconv."""
    field = "EXT_ID" if is_pmid else "DOI"
    query = f'{field}:"{identifier}"'
    url = ("https://www.ebi.ac.uk/europepmc/webservices/rest/search"
           f"?query={urllib.parse.quote(query)}&format=json&pageSize=1&resultType=core")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _ua(email)})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        res = data.get("resultList", {}).get("result", [])
        if res and res[0].get("pmcid"):
            return res[0]["pmcid"]
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        log.debug("Europe PMC idconv error for %s: %s", identifier, e)
    return None


def _pmcid_via_ncbi(identifier: str, email: str) -> str | None:
    """Convert PMID or DOI to PMCID via NCBI ID converter (often blocked from mainland China)."""
    url = (f"https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/"
           f"?ids={urllib.parse.quote(identifier, safe='/')}&format=json"
           f"&tool=sci-skill-fulltext&email={urllib.parse.quote(email)}"
           f"{_ncbi_key_param()}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _ua(email)})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        records = data.get("records", [])
        if records and records[0].get("pmcid"):
            return records[0]["pmcid"]
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        log.debug("NCBI ID converter error for %s: %s", identifier, e)
    return None


def id_to_pmcid(identifier: str, email: str, is_pmid: bool = False) -> str | None:
    """Resolve a PMID or DOI to a PMCID. Try Europe PMC first (mainland-China reachable),
    then fall back to NCBI's ID converter — so a blocked NCBI does not sink the whole PMC path."""
    if not identifier:
        return None
    return (_pmcid_via_europepmc(identifier, email, is_pmid)
            or _pmcid_via_ncbi(identifier, email))


def pmid_to_doi(pmid: str, email: str) -> str | None:
    """PMID → DOI via Europe PMC（大陆可达）。PMID-only 清单先解析出 DOI 再进主管线。"""
    if not pmid:
        return None
    url = ("https://www.ebi.ac.uk/europepmc/webservices/rest/search"
           f"?query=EXT_ID:{urllib.parse.quote(pmid)}%20AND%20SRC:MED"
           "&format=json&pageSize=1&resultType=core")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _ua(email)})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        res = data.get("resultList", {}).get("result", [])
        if res and res[0].get("doi"):
            return res[0]["doi"].strip()
    except (urllib.error.URLError, http.client.HTTPException,
            json.JSONDecodeError, OSError) as e:
        log.debug("PMID→DOI error for %s: %s", pmid, e)
    return None


def title_to_doi(title: str, email: str) -> str | None:
    """Title → DOI via Crossref 标题检索，取最高分且标题足够吻合的命中。
    Title-only 清单据此定位文献；阈值卡 title_overlap ≥ 0.6，避免张冠李戴。"""
    if not title or len(title.strip()) < 8:
        return None
    url = ("https://api.crossref.org/works"
           f"?query.bibliographic={urllib.parse.quote(title)}"
           f"&rows=3&select=DOI,title&mailto={urllib.parse.quote(email)}")
    try:
        req = urllib.request.Request(url, headers=_crossref_headers(email))
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        items = (data.get("message", {}) or {}).get("items", []) or []
        best_doi, best_ov = None, 0.0
        for it in items:
            cand_title = " ".join(it.get("title") or [])
            ov = title_overlap(title, cand_title)
            if ov > best_ov and it.get("DOI"):
                best_doi, best_ov = it["DOI"].strip(), ov
        if best_doi and best_ov >= TITLE_MATCH_THRESHOLD:
            return best_doi
    except (urllib.error.URLError, http.client.HTTPException,
            json.JSONDecodeError, OSError) as e:
        log.debug("Title→DOI error for %s: %s", title[:40], e)
    return None


def resolve_identifier(rec: dict, email: str) -> str:
    """给一条 record 落实一个 DOI：已有则用；否则 PMID→DOI，再 Title→DOI。返回 DOI 或 ''。"""
    doi = (rec.get("doi") or "").strip()
    if doi:
        return doi
    doi = pmid_to_doi(rec.get("pmid", ""), email) or ""
    if doi:
        return doi
    return title_to_doi(rec.get("title", ""), email) or ""


def download_pmc_pdf(pmcid: str, outpath: Path, email: str) -> bool:
    """Download PDF from PMC via Europe PMC render → ptpmcrender → OA FTP → web fallback."""

    # Method A0: Europe PMC article render (实测最稳；旧的 ptpmcrender.fcgi 端点近期持续
    # "Remote end closed connection"，此端点直接回 application/pdf，polite/browser UA 均可)。
    try:
        url = f"https://europepmc.org/articles/{pmcid}?pdf=render"
        data, _, _ = fetch_bytes(url, email, accept="application/pdf,*/*", timeout=30)
        if save_pdf(data, outpath):
            log.debug("PMC Method A0 (Europe PMC render) succeeded for %s", pmcid)
            return True
    except TRANSIENT_ERRORS as e:
        log.debug("PMC Method A0 failed for %s: %s", pmcid, e)

    # Method A: Europe PMC ptpmcrender (旧端点，作兜底保留)
    try:
        url = (f"https://europepmc.org/backend/ptpmcrender.fcgi"
               f"?accid={pmcid}&blobtype=pdf")
        data, _, _ = fetch_bytes(url, email, accept="application/pdf,*/*", timeout=30)
        if save_pdf(data, outpath):
            log.debug("PMC Method A (Europe PMC) succeeded for %s", pmcid)
            return True
    except TRANSIENT_ERRORS as e:
        log.debug("PMC Method A failed for %s: %s", pmcid, e)

    # Method B: PMC OA FTP service (XML with direct PDF link)
    try:
        url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={pmcid}{_ncbi_key_param()}"
        xml_data, _, _ = fetch_bytes(url, email, timeout=15)
        root = ET.fromstring(xml_data)
        # Check for error response (non-OA articles)
        if root.find(".//error") is not None:
            log.debug("PMC Method B: %s is not in OA subset", pmcid)
        else:
            for link in root.iter("link"):
                href = link.get("href", "")
                if href.endswith(".pdf"):
                    if href.startswith("ftp://"):
                        href = href.replace(
                            "ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/",
                            "https://ftp.ncbi.nlm.nih.gov/pub/pmc/", 1)
                    data, _, _ = fetch_bytes(
                        href, email, accept="application/pdf,*/*", timeout=30)
                    if save_pdf(data, outpath):
                        log.debug("PMC Method B (OA FTP) succeeded for %s", pmcid)
                        return True
    except (ET.ParseError, *TRANSIENT_ERRORS) as e:
        log.debug("PMC Method B failed for %s: %s", pmcid, e)

    # Method C: Direct PMC web URL (may hit JS PoW challenge)
    try:
        url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/pdf/"
        data, final_url, ct = fetch_bytes(
            url, email, accept="application/pdf,*/*")
        if "pdf" in ct.lower() or final_url.endswith(".pdf"):
            if save_pdf(data, outpath):
                log.debug("PMC Method C (web) succeeded for %s", pmcid)
                return True
    except TRANSIENT_ERRORS as e:
        log.debug("PMC Method C failed for %s: %s", pmcid, e)

    return False


# ============================================================
# 3. OpenAlex + Crossref
# ============================================================

def openalex_lookup(doi: str, email: str) -> list[str]:
    url = (f"https://api.openalex.org/works/"
           f"https://doi.org/{urllib.parse.quote(doi, safe='/')}"
           f"?mailto={urllib.parse.quote(email)}{_openalex_key_param()}")
    candidates = []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _ua(email)})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        oa = data.get("open_access", {}) or {}
        primary = data.get("primary_location", {}) or {}
        for v in [primary.get("pdf_url"), oa.get("oa_url"),
                  primary.get("landing_page_url")]:
            if v and v not in candidates:
                candidates.append(v)
    except (urllib.error.URLError, urllib.error.HTTPError,
            json.JSONDecodeError) as e:
        log.debug("OpenAlex error for %s: %s", doi, e)
    return candidates


def crossref_lookup(doi: str, email: str) -> list[str]:
    url = (f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}"
           f"?mailto={urllib.parse.quote(email)}")
    candidates = []
    try:
        req = urllib.request.Request(url, headers=_crossref_headers(email))
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        msg = data.get("message", {}) or {}
        for link in msg.get("link", []) or []:
            v = link.get("URL")
            if v and v not in candidates:
                candidates.append(v)
        primary = ((msg.get("resource") or {}).get("primary") or {}).get("URL")
        if primary and primary not in candidates:
            candidates.append(primary)
    except (urllib.error.URLError, urllib.error.HTTPError,
            json.JSONDecodeError) as e:
        log.debug("Crossref error for %s: %s", doi, e)
    return candidates


# ============================================================
# 4. Landing page scraper
# ============================================================

def scrape_pdf_candidates(html: str) -> list[str]:
    patterns = [
        r'citation_pdf_url"\s+content="([^"]+)"',
        r"name=\"citation_pdf_url\"\s+content=\"([^\"]+)\"",
        r'href="([^"]+\.pdf[^"]*)"',
    ]
    found = []
    for pat in patterns:
        for m in re.findall(pat, html, flags=re.IGNORECASE):
            if m not in found:
                found.append(m)
    return found


def download_from_landing(url: str, outpath: Path, email: str) -> bool:
    try:
        raw, final_url, ct = fetch_bytes(url, email, accept="text/html,*/*")
        if "pdf" in ct.lower():
            return save_pdf(raw, outpath)
        html = raw.decode("utf-8", errors="ignore")
        for candidate in scrape_pdf_candidates(html):
            absolute = urllib.parse.urljoin(final_url, candidate)
            try:
                data, _, _ = fetch_bytes(
                    absolute, email, accept="application/pdf,*/*")
                if save_pdf(data, outpath):
                    return True
            except TRANSIENT_ERRORS:
                continue
    except TRANSIENT_ERRORS as e:
        log.debug("Landing page error for %s: %s", url, e)
    return False


def download_pdf(url: str, outpath: Path, email: str) -> bool:
    try:
        data, _, ct = fetch_bytes(url, email, accept="application/pdf,*/*")
        if save_pdf(data, outpath):
            return True
        # 拿到 HTML 拦截页（Nature/Springer 对非浏览器 UA 常见）→ 伪装浏览器带 Referer 再取一次。
        if b"pdf" not in ct.lower().encode() and not data.startswith(b"%PDF-"):
            parsed = urllib.parse.urlparse(url)
            referer = f"{parsed.scheme}://{parsed.netloc}/"
            try:
                data2, _, _ = fetch_bytes(url, email, accept="application/pdf,*/*",
                                          browser_ua=True, referer=referer)
                if save_pdf(data2, outpath):
                    log.debug("Direct download via browser-UA fallback for %s", url)
                    return True
            except TRANSIENT_ERRORS as e:
                log.debug("Browser-UA fallback failed for %s: %s", url, e)
    except TRANSIENT_ERRORS as e:
        log.debug("Direct download error for %s: %s", url, e)
    return False


# ============================================================
# 5. Main pipeline
# ============================================================

def process_doi(doi: str, outdir: Path, email: str,
                pmid: str = "") -> tuple[str, str]:
    """Try to download a PDF for one DOI.

    Returns (status, source):
      status ∈ {"arxiv", "oa", "pmc", "skip", "fail"}
      source identifies the resolver that succeeded (e.g. "unpaywall", "pmc",
      "openalex", "crossref", "landing", "arxiv", "existing", "").
    """
    outpath = outdir / f"{safe_doi_name(doi)}.pdf"

    if existing_pdf_ok(outpath):
        return ("skip", "existing")

    # Remove stale stub
    if outpath.exists():
        outpath.unlink(missing_ok=True)

    # Step 0: arXiv direct (for 10.48550/arXiv.* DOIs)
    ax_url = arxiv_pdf_url(doi)
    if ax_url and download_pdf(ax_url, outpath, email):
        return ("arxiv", "arxiv")

    # Step 1: Unpaywall direct PDF URL (fastest path)
    uw_url = unpaywall_lookup(doi, email)
    if uw_url and ".pdf" in uw_url.lower():
        if download_pdf(uw_url, outpath, email):
            return ("oa", "unpaywall")
        time.sleep(0.3)

    # Step 2: PMC (try before slow landing-page scraping)
    pmcid = id_to_pmcid(pmid, email, is_pmid=True) if pmid else None
    if not pmcid:
        pmcid = id_to_pmcid(doi, email, is_pmid=False)
    if pmcid and download_pmc_pdf(pmcid, outpath, email):
        return ("pmc", "pmc")

    # Step 3: OA candidates from OpenAlex, Crossref, landing pages
    candidates: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(source: str, url: str | None):
        if url and url not in seen:
            seen.add(url)
            candidates.append((source, url))

    add("unpaywall", uw_url)
    for v in openalex_lookup(doi, email):
        add("openalex", v)
    for v in crossref_lookup(doi, email):
        add("crossref", v)
    add("landing", f"https://doi.org/{doi}")

    for source, url in candidates:
        if ".pdf" in url.lower():
            ok = download_pdf(url, outpath, email)
        else:
            ok = download_from_landing(url, outpath, email)
        if ok:
            return ("oa", source)
        time.sleep(0.3)

    return ("fail", "")


def build_report(records: list[dict], results: dict[str, tuple[str, str]],
                 outdir: Path, extracted_text_by_doi: dict[str, str] | None = None,
                 threshold: float = TITLE_MATCH_THRESHOLD) -> dict:
    """Assemble a deterministic retrieval report (no network, no I/O writes).

    records: list of {"doi", "pmid", "title"}.
    results: doi -> (status, source) as returned by process_doi.
    outdir:  directory where PDFs were written (used for file/size lookup).
    extracted_text_by_doi: optional doi -> first-page text for title cross-check.
    """
    extracted_text_by_doi = extracted_text_by_doi or {}
    items = []
    for rec in records:
        doi = rec.get("doi", "")
        # 优先用主循环写在 rec 上的实际状态（PMID/Title-only 记录可能无 doi 键）；
        # 回退到 results 字典（保持 build_report 可被单测直接调用的旧签名）。
        if "_status" in rec:
            status, source = rec["_status"], rec.get("_source", "")
        else:
            status, source = results.get(doi, ("fail", ""))
        path = outdir / f"{safe_doi_name(doi)}.pdf" if doi else outdir / "__none__.pdf"
        have_file = bool(doi) and status in RETRIEVED_STATUSES and path.exists()
        size = path.stat().st_size if have_file else 0
        if have_file:
            title_match = classify_title_match(
                rec.get("title", ""), extracted_text_by_doi.get(doi), threshold)
        else:
            title_match = "unavailable"
        items.append({
            "doi": doi,
            "pmid": rec.get("pmid", ""),
            "title": rec.get("title", ""),
            "status": status,
            "source": source,
            "file": path.name if have_file else "",
            "size_bytes": size,
            "title_match": title_match,
        })

    # "skip" = file already present from a previous run. Count it separately from
    # freshly retrieved so the report and the console summary agree on every re-run.
    fresh = [i for i in items if i["status"] in ("oa", "pmc", "arxiv")]
    already = [i for i in items if i["status"] == "skip"]
    not_retrieved = [i for i in items if i["status"] == "fail"]
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_by": "fetch_oa.py",
        "counts": {
            "total": len(items),
            "retrieved": len(fresh),
            "already_present": len(already),
            # available on disk now = freshly retrieved + already present
            "available": len(fresh) + len(already),
            "not_retrieved": len(not_retrieved),
            "title_mismatch": sum(1 for i in items if i["title_match"] == "mismatch"),
        },
        "items": items,
    }


def _norm_key(key: str) -> str:
    return (key or "").strip().lstrip("#").strip().lower()


def _records_from_dictrows(rows) -> list[dict]:
    records = []
    for row in rows:
        rec = {"doi": "", "pmid": "", "title": ""}
        for k, v in row.items():
            nk = _norm_key(k)
            if nk in rec:
                rec[nk] = (v or "").strip()
        # 有 doi / pmid / title 任一即保留——PMID-only、Title-only 稿件也能定位（见 resolve_identifier）。
        if rec["doi"] or rec["pmid"] or rec["title"]:
            records.append(rec)
    return records


def _records_from_markdown(lines: list[str]) -> list[dict]:
    pipe_rows = [ln for ln in lines if ln.strip().startswith("|")]
    if not pipe_rows:
        return []

    def cells(line: str) -> list[str]:
        return [c.strip() for c in line.strip().strip("|").split("|")]

    header = [_norm_key(c) for c in cells(pipe_rows[0])]
    records = []
    for line in pipe_rows[1:]:
        c = cells(line)
        # Skip the |---|---| separator row
        if c and all(set(x) <= set("-: ") for x in c):
            continue
        row = dict(zip(header, c))
        doi = (row.get("doi") or "").strip()
        pmid = (row.get("pmid") or "").strip()
        title = (row.get("title") or "").strip()
        if doi or pmid or title:
            records.append({"doi": doi, "pmid": pmid, "title": title})
    return records


def read_doi_file(path: Path) -> list[dict]:
    """Read a worklist of DOIs.

    Supports: plain DOI-per-line; TSV/CSV with a DOI header (optional PMID,
    Title columns); and a Markdown pipe table with a DOI column. Each record is
    {"doi", "pmid", "title"}.
    """
    text = Path(path).read_text(encoding="utf-8")
    lines = text.splitlines()
    first = next((ln for ln in lines
                  if ln.strip() and not ln.strip().startswith("#")), "")
    low = first.lower()

    # Markdown pipe table with a DOI column
    if first.strip().startswith("|") and "doi" in low:
        return _records_from_markdown(lines)

    # Delimited (TSV or CSV) with a DOI header
    if "doi" in low and ("\t" in first or "," in first):
        delimiter = "\t" if "\t" in first else ","
        body = "\n".join(ln for ln in lines if not ln.strip().startswith("#"))
        reader = csv.DictReader(io.StringIO(body), delimiter=delimiter)
        return _records_from_dictrows(reader)

    # Plain text: one DOI per line
    records = []
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#"):
            records.append({"doi": line, "pmid": "", "title": ""})
    return records


def main():
    parser = argparse.ArgumentParser(
        description="Batch download open-access PDFs by DOI.")
    parser.add_argument("input", type=Path,
                        help="Worklist: DOIs (one per line) or TSV/CSV/Markdown "
                             "with a DOI column (optional PMID, Title)")
    # pdfs/ 子目录是合适的组织方式：网关的 dirState 现在【递归一层】，侧栏会列出
    # "pdfs/xxx.pdf" 并可直接下载/预览。（此前 dirState 只列顶层文件，这些 PDF 在界面上
    # 一个都看不见——生产上真实会话就是这么丢的；现已在网关侧修好，故保留子目录组织。）
    # 注意别再往更深一层放：侧栏只递归一层。
    parser.add_argument("-o", "--output", type=Path, default=Path("pdfs"),
                        help="Output directory (default: pdfs/ —— 相对本会话产物目录，侧栏可见)")
    parser.add_argument("-e", "--email", default=CONTACT_EMAIL,
                        help="Contact email (required by Unpaywall TOS). Falls back to "
                             "SCI_CONTACT_EMAIL / MEDSCI_CONTACT_EMAIL / CONTACT_EMAIL env vars.")
    parser.add_argument("--report", type=Path, default=None,
                        help="Path for the JSON retrieval report "
                             "(default: <output>/retrieval_report.json)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Show debug messages")
    args = parser.parse_args()

    if not args.email:
        parser.error("a contact email is required (Unpaywall TOS): pass --email you@lab.org "
                     "or set MEDSCI_CONTACT_EMAIL")

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s: %(message)s",
    )

    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.report or (args.output / "retrieval_report.json")
    records = read_doi_file(args.input)
    print(f"Loaded {len(records)} DOIs from {args.input}")

    stats = {"arxiv": 0, "oa": 0, "pmc": 0, "fail": 0, "skip": 0}
    results: dict[str, tuple[str, str]] = {}

    labels = {"arxiv": "OK (arXiv)", "oa": "OK (OA)", "pmc": "OK (PMC)",
              "fail": "FAIL", "skip": "SKIP"}
    for i, rec in enumerate(records, 1):
        pmid = rec.get("pmid", "")
        disp = rec.get("doi") or (f"PMID:{pmid}" if pmid else (rec.get("title") or "")[:50])
        print(f"  [{i}/{len(records)}] {disp}", end=" … ", flush=True)

        # 每条独立 try/except：任一条（截断/超时/解析异常）都不得拖垮整批，记 FAIL 继续，报告照出。
        try:
            doi = resolve_identifier(rec, args.email)
            if not doi:
                status, source = ("fail", "unresolved")
            else:
                rec["doi"] = doi  # 供 build_report 定位产物文件名
                status, source = process_doi(doi, args.output, args.email, pmid)
        except Exception as e:  # noqa: BLE001 —— 兜底一切，绝不让单条异常中断整批
            status, source = ("fail", "error")
            log.debug("Unhandled error for %s: %s", disp, e)

        rec["_status"], rec["_source"] = status, source
        if rec.get("doi"):
            results[rec["doi"]] = (status, source)
        stats[status] += 1
        suffix = " (无法解析 DOI/PMID/标题)" if source == "unresolved" else ""
        print(labels[status] + suffix)
        time.sleep(0.5)

    # Best-effort title cross-check on successful downloads. extract_pdf_text uses
    # PyMuPDF (installed) and falls back to pdftotext, so gate on either being available
    # rather than on poppler alone (which Windows usually lacks).
    def _pdf_text_available():
        try:
            import fitz  # noqa: F401
            return True
        except Exception:
            return bool(shutil.which("pdftotext"))

    extracted: dict[str, str] = {}
    have_titles = any(r.get("title") for r in records)
    if have_titles and _pdf_text_available():
        for rec in records:
            doi = rec["doi"]
            if not rec.get("title"):
                continue
            status, _ = results.get(doi, ("fail", ""))
            if status not in RETRIEVED_STATUSES:
                continue
            path = args.output / f"{safe_doi_name(doi)}.pdf"
            if path.exists():
                text = extract_pdf_text(path)
                if text:
                    extracted[doi] = text

    report = build_report(records, results, args.output, extracted)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"\n--- Summary ---")
    print(f"  arXiv:   {stats['arxiv']}")
    print(f"  OA:      {stats['oa']}")
    print(f"  PMC:     {stats['pmc']}")
    print(f"  Failed:  {stats['fail']}")
    print(f"  Skipped: {stats['skip']}")
    total = stats["arxiv"] + stats["oa"] + stats["pmc"] + stats["fail"]
    if total > 0:
        pct = (stats["arxiv"] + stats["oa"] + stats["pmc"]) / total * 100
        print(f"  Success: {pct:.0f}%")
    mismatches = report["counts"]["title_mismatch"]
    if mismatches:
        print(f"  Title mismatches flagged: {mismatches} (see report)")
    print(f"  Report:  {report_path}")

    # Write failed DOIs for manual retrieval
    if stats["fail"] > 0:
        fail_path = args.output / "manual_needed.txt"
        with open(fail_path, "w") as f:
            f.write("# DOIs needing manual retrieval\n")
            f.write("# Options: institutional access, ILL\n\n")
            for rec in records:
                doi = rec.get("doi", "")
                pdf = args.output / f"{safe_doi_name(doi)}.pdf" if doi else None
                if pdf is not None and existing_pdf_ok(pdf):
                    continue
                # 无法解析出 DOI 的（PMID/Title-only 且检索无果）也列进来，标注来源标识。
                ident = doi or (f"PMID:{rec['pmid']}" if rec.get("pmid")
                                else (rec.get("title") or "").strip())
                if ident:
                    f.write(f"{ident}\n")
        print(f"  Manual list: {fail_path}")


if __name__ == "__main__":
    main()
