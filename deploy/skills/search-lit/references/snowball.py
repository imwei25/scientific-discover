#!/usr/bin/env python3
"""
Citation snowballing for search-lit (Phase 2.5 Citation Searching).

Expands a seed set of papers along the citation graph and emits API-verified
BibTeX candidates, deduplicated against an existing candidate pool.

Directions
----------
    backward : references the seed papers cite (cited-by-the-seed)
    forward  : papers that cite the seed (citing-the-seed)
    similar  : Semantic Scholar recommendations for the seed
    all      : backward + forward + similar (default)

Data source: Semantic Scholar Graph API (deterministic, no model memory).
    references     GET /graph/v1/paper/{id}/references
    citations      GET /graph/v1/paper/{id}/citations
    recommendations GET /recommendations/v1/papers/forpaper/{id}

Anti-hallucination contract
---------------------------
Snowball candidates carry `verified=false` + `verified_by=semantic_scholar`.
They are NOT cross-checked against PubMed/CrossRef here; the downstream
reference-check skill confirms each entry and upgrades the flag. Nothing is
ever generated from memory.

Output contract (matches search-lit BibTeX section)
---------------------------------------------------
- BibTeX is APPENDED to the candidate pool (default outputs/refs.bib).
- A PRISMA "records identified through citation searching" line is printed.

Usage
-----
    # Live (network) — expand one DOI in all directions, dedup against pool
    python3 snowball.py --seed DOI:10.1148/radiol.2024123 \
        --pool refs.bib --out refs.bib

    # Multiple seeds from a file (one id per line), backward only
    python3 snowball.py --seed @seeds.txt --direction backward

    # Deterministic / offline (challenge-card verifier): read recorded JSON
    python3 snowball.py --seed DOI:10.0/seed1 --direction all \
        --offline-fixture fixture --as-of 2026-06-14 --stdout

Seed id formats accepted: `DOI:10.x/...`, `PMID:123456`, bare `10.x/...`
(treated as DOI), bare digits (treated as PMID), or a raw S2 paper id.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

S2_GRAPH = "https://api.semanticscholar.org/graph/v1/paper"
S2_REC = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper"
S2_FIELDS = "title,year,venue,externalIds,authors.name"

DIRECTIONS = ("backward", "forward", "similar")


# --------------------------------------------------------------------------- #
# Seed id normalization
# --------------------------------------------------------------------------- #
# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    _cwd = _Path.cwd()
    _in_session = _cwd.parent.name == 'outputs'   # cwd 已是 outputs/<会话id>/
    if explicit:
        _p = _Path(explicit)
        # 【拦截已知的错误传法】cwd 已经是会话产物目录，却又传了以 outputs/ 开头的相对路径：
        # 那会写成 outputs/<会话id>/outputs/xxx —— 网关的 dirState 只列顶层文件，
        # 这份产物在界面“产出”侧栏里【永远看不见】，用户会以为跑成功了却什么都没拿到。
        # 这是旧文档教出来的写法，宁可响亮报错也不要静默产出不可见的文件。
        if _in_session and not _p.is_absolute() and _p.parts and _p.parts[0] == 'outputs':
            _m = [
                '!! 产物目录参数写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out table1.csv），或干脆不传该参数。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    _env = (_os.environ.get('SCI_OUTPUT_DIR') or '').strip()
    if _env:
        _e = _Path(_env)
        # 与 explicit 分支同样的拦截。这条尤其要紧：项目文档教的就是
        # `SCI_OUTPUT_DIR=outputs/<会话id>` 这个【相对】写法，而 cwd 已经是会话产物目录，
        # 解析出来就是 outputs/<会话id>/outputs/<会话id>/ —— 产物在界面上永远看不见。
        if _in_session and not _e.is_absolute() and _e.parts and _e.parts[0] == 'outputs':
            _m = [
                '!! 环境变量 SCI_OUTPUT_DIR 的写法有误，已中止。',
                '   当前值： SCI_OUTPUT_DIR=' + _env,
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_cwd),
                '   再拼 outputs/ 前缀会写成 ' + str(_cwd / _e) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确做法：不要设这个环境变量（脚本会自动认出当前目录），',
                '   或把它设成【绝对路径】。',
            ]
            _sys.exit(chr(10).join(_m))
        return _e
    if _in_session:
        return _cwd
    _msg = [
        '!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。',
        '   正常情况下不需要指定：每轮对话的当前工作目录就是本会话的产物目录，',
        '   直接用裸文件名即可（如 --out table1.csv）。现在会走到这里，说明当前工作目录是',
        '   ' + str(_cwd) + '，不在任何会话产物目录下。',
        '   请任选一种方式指定：',
        '     1) 先切回本会话的产物目录再跑（推荐）',
        '     2) 环境变量： SCI_OUTPUT_DIR=<会话产物目录绝对路径>',
        '     3) 显式参数： --outdir <会话产物目录绝对路径>',
        '   注意路径要用【绝对路径】或相对当前目录的正确路径，不要再拼 outputs/<会话id>：',
        '   那是旧架构的写法，现在会多套一层目录导致产物在界面上不可见。',
        '   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。',
    ]
    _sys.exit(chr(10).join(_msg))

def _resolve_out_file(explicit=None, default_name="output"):
    import sys as _sys
    from pathlib import Path as _Path
    if explicit:
        _p = _Path(explicit)
        # 同 _resolve_out_dir：cwd 已是会话产物目录时再拼 outputs/ 前缀，产物会落到
        # outputs/<会话id>/outputs/... —— 界面“产出”侧栏只列顶层文件，用户永远看不见。
        if (_Path.cwd().parent.name == 'outputs' and not _p.is_absolute()
                and _p.parts and _p.parts[0] == 'outputs'):
            _m = [
                '!! 产物路径写法有误，已中止。',
                '   你传的是： ' + str(explicit),
                '   当前工作目录已经【就是】本会话的产物目录： ' + str(_Path.cwd()),
                '   再拼 outputs/ 前缀会写成 ' + str(_Path.cwd() / _p) + '，',
                '   界面的“产出”侧栏只递归一层，再套一层的路径不会显示；且在会话产物目录里'
                '   再造一个名为 outputs 的目录，本身就说明误解了目录布局。',
                '   正确写法：直接用【裸文件名】（如 --out ' + default_name + '）。',
            ]
            _sys.exit(chr(10).join(_m))
        return _p
    return _resolve_out_dir() / default_name


def normalize_seed_id(raw: str) -> str:
    """Return an S2-acceptable paper id token (DOI:/PMID:/raw)."""
    s = raw.strip()
    if not s:
        return ""
    up = s.upper()
    if up.startswith("DOI:") or up.startswith("PMID:") or up.startswith("ARXIV:"):
        return s
    if s.startswith("10.") or "doi.org/" in s.lower():
        return "DOI:" + s.split("doi.org/")[-1]
    if s.isdigit():
        return "PMID:" + s
    return s  # assume raw S2 id


def fixture_slug(seed_id: str) -> str:
    """Filesystem-safe slug for an offline fixture filename."""
    return re.sub(r"[^A-Za-z0-9]+", "_", seed_id).strip("_")


# --------------------------------------------------------------------------- #
# Fetch (network or offline fixture)
# --------------------------------------------------------------------------- #
def _http_get_json(url: str) -> dict:
    """GET JSON from Semantic Scholar with exponential backoff on 429.

    S2's unauthenticated shared pool 429s frequently and *requires* backoff.
    Set S2_API_KEY to raise the limit. A 429 that exhausts retries raises
    RuntimeError so the caller reports it as a rate-limit failure rather than
    silently counting 0 new candidates.
    """
    _email = (os.environ.get("SCI_CONTACT_EMAIL")
              or os.environ.get("MEDSCI_CONTACT_EMAIL")
              or os.environ.get("CONTACT_EMAIL")
              or "sci-skill@users.noreply.github.com")
    headers = {"User-Agent": f"medsci-skills/snowball (mailto:{_email})"}
    api_key = os.environ.get("S2_API_KEY")
    if api_key:
        headers["x-api-key"] = api_key
    delay = 2.0
    for attempt in range(5):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (trusted host)
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                if attempt < 4:
                    retry_after = exc.headers.get("Retry-After")
                    wait = float(retry_after) if (retry_after and str(retry_after).isdigit()) else delay
                    time.sleep(wait)
                    delay *= 2
                    continue
                raise RuntimeError(
                    "Semantic Scholar rate-limited (429) after retries; set S2_API_KEY or retry later"
                ) from exc
            raise
    raise RuntimeError("Semantic Scholar request did not complete")


def fetch_direction(seed_id: str, direction: str, limit: int,
                    fixture_dir: Path | None) -> list[dict]:
    """Return a list of paper dicts for one seed+direction.

    Each returned dict has at least: title, year, venue, externalIds, authors.
    """
    if fixture_dir is not None:
        fpath = fixture_dir / f"{fixture_slug(seed_id)}.{direction}.json"
        if not fpath.exists():
            return []
        payload = json.loads(fpath.read_text())
    else:
        enc = urllib.parse.quote(seed_id, safe="")
        if direction == "backward":
            url = f"{S2_GRAPH}/{enc}/references?fields={S2_FIELDS}&limit={limit}"
        elif direction == "forward":
            url = f"{S2_GRAPH}/{enc}/citations?fields={S2_FIELDS}&limit={limit}"
        elif direction == "similar":
            url = f"{S2_REC}/{enc}?fields={S2_FIELDS}&limit={limit}"
        else:
            raise ValueError(f"unknown direction: {direction}")
        try:
            payload = _http_get_json(url)
        except Exception as exc:  # noqa: BLE001 — network failure is non-fatal
            sys.stderr.write(f"[snowball] {direction} fetch failed for {seed_id}: {exc}\n")
            return []

    # Normalize payload shapes:
    #   references/citations: {"data": [{"citedPaper"|"citingPaper": {...}}]}
    #   recommendations:      {"recommendedPapers": [{...}]} or {"data": [{...}]}
    rows = payload.get("data") or payload.get("recommendedPapers") or []
    papers = []
    for row in rows:
        paper = row.get("citedPaper") or row.get("citingPaper") or row
        if isinstance(paper, dict) and paper.get("title"):
            papers.append(paper)
    return papers


# --------------------------------------------------------------------------- #
# Dedup
# --------------------------------------------------------------------------- #
def norm_doi(doi: str | None) -> str:
    if not doi:
        return ""
    return doi.strip().lower().replace("https://doi.org/", "")


def norm_title(title: str | None) -> str:
    if not title:
        return ""
    return re.sub(r"[^a-z0-9]+", "", title.lower())


def parse_pool_keys(pool_path: Path | None) -> tuple[set[str], set[str]]:
    """Extract existing DOIs and normalized titles from a BibTeX pool."""
    dois: set[str] = set()
    titles: set[str] = set()
    if pool_path is None or not pool_path.exists():
        return dois, titles
    text = pool_path.read_text(errors="ignore")
    for m in re.finditer(r"doi\s*=\s*[{\"]([^}\"]+)[}\"]", text, re.I):
        dois.add(norm_doi(m.group(1)))
    for m in re.finditer(r"title\s*=\s*[{\"](.+?)[}\"]\s*,?\s*\n", text, re.I | re.S):
        titles.add(norm_title(m.group(1)))
    return dois, titles


# --------------------------------------------------------------------------- #
# BibTeX emit
# --------------------------------------------------------------------------- #
def _author_last(name: str) -> str:
    parts = name.strip().split()
    return parts[-1] if parts else "Anon"


def bibtex_key(paper: dict) -> str:
    authors = paper.get("authors") or []
    last = _author_last(authors[0]["name"]) if authors and authors[0].get("name") else "Anon"
    last = re.sub(r"[^A-Za-z]", "", last) or "Anon"
    year = str(paper.get("year") or "ND")
    title_word = ""
    for w in re.findall(r"[A-Za-z]{4,}", paper.get("title") or ""):
        if w.lower() not in {"with", "from", "using", "study", "analysis", "based"}:
            title_word = w.capitalize()
            break
    return f"{last}_{year}_{title_word or 'Snowball'}"


def to_bibtex(paper: dict, direction: str, as_of: str, key: str) -> str:
    ext = paper.get("externalIds") or {}
    doi = ext.get("DOI", "")
    pmid = ext.get("PubMed", "")
    authors = paper.get("authors") or []
    author_str = " and ".join(
        f"{_author_last(a['name'])}, {' '.join(a['name'].split()[:-1])}".strip().rstrip(",")
        for a in authors if a.get("name")
    ) or "Unknown"
    lines = [
        f"@article{{{key},",
        f"  author    = {{{author_str}}},",
        f"  title     = {{{paper.get('title', '').strip()}}},",
        f"  journal   = {{{paper.get('venue', '') or ''}}},",
        f"  year      = {{{paper.get('year') or ''}}},",
    ]
    if doi:
        lines.append(f"  doi       = {{{doi}}},")
    if pmid:
        lines.append(f"  pmid      = {{{pmid}}},")
    lines += [
        "  verified  = {false},",
        "  verified_by = {semantic_scholar},",
        f"  verified_on = {{{as_of}}},",
        "  source    = {citation_snowball},",
        f"  snowball_direction = {{{direction}}},",
        "}",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def load_seeds(raw: str) -> list[str]:
    if raw.startswith("@"):
        lines = Path(raw[1:]).read_text().splitlines()
        items = [ln for ln in lines if ln.strip() and not ln.strip().startswith("#")]
    else:
        items = re.split(r"[,\s]+", raw)
    return [normalize_seed_id(x) for x in items if x.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Citation snowballing for search-lit.")
    ap.add_argument("--seed", required=True,
                    help="comma/space-separated ids, or @file with one id per line")
    ap.add_argument("--direction", default="all",
                    choices=("all", *DIRECTIONS))
    ap.add_argument("--pool", default=None,
                    help="existing candidate .bib to dedup against")
    ap.add_argument("--out", default=None,
                    help="BibTeX append target (candidate pool)")
    ap.add_argument("--limit", type=int, default=50, help="max per seed per direction")
    ap.add_argument("--offline-fixture", default=None,
                    help="dir of recorded JSON (<slug>.<direction>.json) for deterministic runs")
    ap.add_argument("--as-of", default=date.today().isoformat(),
                    help="verified_on date stamp (default today; set for reproducible output)")
    ap.add_argument("--stdout", action="store_true",
                    help="print BibTeX to stdout instead of appending to --out")
    args = ap.parse_args(argv)
    # --stdout 模式根本不写文件（见下方 args.stdout 分支），所以不能在这里强制解析产物目录：
    # 否则从任何非会话目录跑 `--stdout`（含 --offline-fixture 干跑）都会被"未指定产物目录"直接中止，
    # 而这条调用压根不碰磁盘。只有真要落盘时才解析。
    if not args.stdout:
        args.out = str(_resolve_out_file(args.out, "refs.bib"))

    out_path = Path(args.out) if args.out else Path("refs.bib")

    fixture_dir = Path(args.offline_fixture) if args.offline_fixture else None
    pool_dois, pool_titles = parse_pool_keys(Path(args.pool) if args.pool else None)

    seeds = load_seeds(args.seed)
    directions = list(DIRECTIONS) if args.direction == "all" else [args.direction]

    seen_doi = set(pool_dois)
    seen_title = set(pool_titles)
    seen_key: set[str] = set()
    counts = {d: 0 for d in directions}
    entries: list[str] = []
    raw_found = 0

    for seed in seeds:
        for direction in directions:
            papers = fetch_direction(seed, direction, args.limit, fixture_dir)
            if fixture_dir is None:
                time.sleep(1.0)  # be polite to the S2 shared pool between live calls
            for paper in papers:
                raw_found += 1
                ext = paper.get("externalIds") or {}
                d = norm_doi(ext.get("DOI"))
                t = norm_title(paper.get("title"))
                if (d and d in seen_doi) or (t and t in seen_title):
                    continue
                if d:
                    seen_doi.add(d)
                if t:
                    seen_title.add(t)
                key = bibtex_key(paper)
                base_key, n = key, 1
                while key in seen_key:
                    n += 1
                    key = f"{base_key}{chr(96 + n)}"  # _b, _c, ...
                seen_key.add(key)
                entries.append(to_bibtex(paper, direction, args.as_of, key))
                counts[direction] += 1

    new_total = len(entries)
    bibtex_blob = ("\n\n".join(entries) + "\n") if entries else ""

    if args.stdout or not entries:
        sys.stdout.write(bibtex_blob)
    else:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("a", encoding="utf-8") as fh:
            if out_path.exists() and out_path.stat().st_size > 0:
                fh.write("\n")
            fh.write(bibtex_blob)

    # PRISMA citation-searching line (stderr so --stdout BibTeX stays clean)
    breakdown = ", ".join(f"{d}={counts[d]}" for d in directions)
    pool_n = len(pool_dois) + len(pool_titles)
    sys.stderr.write(
        f"Records identified through citation searching (snowballing): "
        f"{raw_found} raw ({breakdown}); after dedup against existing pool: "
        f"{new_total} new candidates.\n"
    )
    sys.stderr.write(
        f"[snowball] seeds={len(seeds)} directions={'+'.join(directions)} "
        f"pool_keys={pool_n} -> {new_total} appended"
        f"{' (stdout)' if args.stdout else f' to {out_path}'}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
