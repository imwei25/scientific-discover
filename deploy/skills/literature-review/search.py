#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
综述用检索：一个或多个检索式 → 去重的证据表（供模型据此写综述）。

用法：
  python search.py "concept1" "concept2" --limit 25 --since 2018
产出：
  outputs/evidence_table.csv   标题/年份/期刊/研究类型线索/DOI/PMID/摘要
  outputs/evidence.md          精简清单（模型写综述时读它，逐条引用）

研究类型线索：从标题/摘要里粗粒度识别 RCT / cohort / meta-analysis /
review / case report 等，方便按证据等级组织综述。不替代人工判读。
"""
import argparse
import csv
import os
import re
import sys
import time

# Windows 控制台默认 GBK；强制 UTF-8，避免中文进度输出变 mojibake（agent 靠 stdout 判成败）。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先在仓库根运行 install.ps1（Windows）/ install.sh（Linux/macOS），或让 agent 运行 env-setup 技能")

EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
_EMAIL = (os.environ.get("SCI_CONTACT_EMAIL")
          or os.environ.get("MEDSCI_CONTACT_EMAIL")
          or os.environ.get("CONTACT_EMAIL")
          or "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-literature-review/1.1 (mailto:{_EMAIL})"}
TIMEOUT = 30


# ---- 产物目录解析（8 个技能脚本统一；见 AGENTS.md §五）----
# 优先级：显式参数 > SCI_OUTPUT_DIR 环境变量 > 当前工作目录(若已在 outputs/<会话id>/ 内) > 报错中止。
# 【绝不】再默认写共享的 outputs/ 根：那里不会出现在界面"产出"侧栏，
# 且同一用户的多个会话共用一个 outputs 卷，写固定名会跨会话互相覆盖。
# 为什么必须由外部传进来：opencode 是【一个进程服务所有会话】的，
# 脚本自己读不到任何会话级上下文，只能靠主控（网关每轮注入的 preamble）用环境变量或参数告知。
def _resolve_out_dir(explicit=None):
    import os as _os, sys as _sys
    from pathlib import Path as _Path
    if explicit:
        return _Path(explicit)
    _env = (_os.environ.get("SCI_OUTPUT_DIR") or "").strip()
    if _env:
        return _Path(_env)
    _cwd = _Path.cwd()
    if _cwd.parent.name == "outputs":          # 已经 cd 进 outputs/<会话id>/
        return _cwd
    _msg = [
        "!! 未指定产物目录，已中止（不再默认写共享的 outputs/ 根）。",
        "   请用以下任一方式指定本会话的产物目录（<会话id> 由主控在每轮开头给出）：",
        "     1) 环境变量： SCI_OUTPUT_DIR=outputs/<会话id> python3 <本脚本> ...",
        "     2) 显式参数： --outdir outputs/<会话id>   （或 --out outputs/<会话id>/<文件名>）",
        "     3) 先切目录： cd outputs/<会话id> && python3 ...",
        "   原因：写到共享的 outputs/ 根会跨会话互相覆盖，且不出现在界面的“产出”侧栏里。",
    ]
    _sys.exit(chr(10).join(_msg))


def _resolve_out_file(explicit=None, default_name="output"):
    from pathlib import Path as _Path
    if explicit:
        return _Path(explicit)
    return _resolve_out_dir() / default_name


def _get(url, **kw):
    """GET with backoff on 429/503 so a transient Europe PMC rate-limit does not
    silently drop a whole query."""
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    r = None
    for attempt in range(4):
        r = requests.get(url, **kw)
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    return r

DESIGN = [
    ("meta-analysis", r"meta-?analysis|systematic review"),
    ("RCT", r"randomi[sz]ed|randomised controlled|double-?blind|placebo-?controlled"),
    ("cohort", r"cohort|prospective|longitudinal"),
    ("case-control", r"case-?control"),
    ("cross-sectional", r"cross-?sectional|survey"),
    ("review", r"\breview\b|narrative review"),
    ("case-report", r"case report|case series"),
    ("preclinical", r"mice|mouse|in vitro|in vivo|rat\b|cell line"),
]


def classify(text):
    t = (text or "").lower()
    for name, pat in DESIGN:
        if re.search(pat, t):
            return name
    return "other"


def one_query(q, limit, since):
    query = q
    if since:
        query += f" AND (FIRST_PDATE:[{since}-01-01 TO 3000-12-31])"
    out, cursor = [], "*"
    while len(out) < limit:
        params = {"query": query, "format": "json",
                  "pageSize": min(100, limit - len(out)),
                  "cursorMark": cursor, "resultType": "core"}
        r = _get(EPMC, params=params)
        r.raise_for_status()
        d = r.json()
        batch = d.get("resultList", {}).get("result", [])
        if not batch:
            break
        out.extend(batch)
        nxt = d.get("nextCursorMark")
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        time.sleep(0.34)
    return out[:limit]


def main():
    ap = argparse.ArgumentParser(description="综述检索 → 证据表")
    ap.add_argument("queries", nargs="+", help="一个或多个检索式")
    ap.add_argument("--limit", type=int, default=25, help="每个检索式取多少")
    ap.add_argument("--since", type=int)
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()
    args.outdir = str(_resolve_out_dir(args.outdir))
    os.makedirs(args.outdir, exist_ok=True)

    seen, rows = set(), []
    for q in args.queries:
        print(f"检索：{q!r}")
        try:
            recs = one_query(q, args.limit, args.since)
        except Exception as e:
            print(f"  (失败：{e})")
            continue
        for rec in recs:
            key = rec.get("doi") or rec.get("pmid") or rec.get("id")
            if not key or key in seen:
                continue
            seen.add(key)
            abstract = (rec.get("abstractText") or "").replace("\n", " ").strip()
            rows.append({
                "title": (rec.get("title") or "").strip().rstrip("."),
                "year": rec.get("pubYear", ""),
                "journal": rec.get("journalInfo", {}).get("journal", {}).get("title", ""),
                "design": classify(f"{rec.get('title','')} {abstract}"),
                "doi": rec.get("doi", ""),
                "pmid": rec.get("pmid", ""),
                "cites": rec.get("citedByCount", 0),
                "abstract": abstract,
            })

    if not rows:
        sys.exit("没有命中文献（检查检索式或网络）。")
    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    rows.sort(key=lambda x: (_int(x["year"]), _int(x["cites"])), reverse=True)

    csv_path = os.path.join(args.outdir, "evidence_table.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["title", "year", "journal", "design",
                                          "cites", "doi", "pmid", "abstract"])
        w.writeheader()
        w.writerows(rows)

    md_path = os.path.join(args.outdir, "evidence.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(f"# 证据清单（{len(rows)} 篇，去重后）\n\n")
        for i, r in enumerate(rows, 1):
            f.write(f"{i}. **{r['title']}** ({r['year']}, {r['journal']}) "
                    f"— *{r['design']}*, cited {r['cites']}x. DOI:{r['doi'] or 'NA'}\n")
            if r["abstract"]:
                f.write(f"   > {r['abstract'][:400]}\n")
            f.write("\n")

    from collections import Counter
    dist = Counter(r["design"] for r in rows)
    print(f"去重后 {len(rows)} 篇。研究类型分布：{dict(dist)}")
    print(f"已写：{csv_path}\n      {md_path}")


if __name__ == "__main__":
    main()
