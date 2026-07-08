#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文献真实性核查：把每条引用去 Crossref / Europe PMC 对一遍，
揪出 AI 常编的三类假引用：
  - DOI/PMID 根本不存在（FABRICATED）
  - DOI/PMID 存在但标题对不上（MISMATCH：要么引错号，要么标题是编的）
  - 只有标题、查不到匹配（NOT_FOUND：疑似虚构，需人工确认）
真实且标题吻合的记 OK。

输入（三选一）：
  --input refs.bib / refs.ris / refs.txt   （.txt 每行一条引用）
  位置参数直接给 DOI/PMID/标题： verify_refs.py 10.1038/nature12373 "some title"
输出：
  outputs/reference_check.csv   逐条结果
  outputs/reference_check.md    人读报告（按风险分组）

联网调 api.crossref.org 与 ebi.ac.uk；失败的条目标 ERROR，不中断整体。
"""
import argparse
import csv
import os
import re
import sys
import time
from difflib import SequenceMatcher

try:
    import requests
except ImportError:
    sys.exit("缺少 requests：请先在仓库根运行 install.ps1（Windows）/ install.sh（Linux/macOS），或让 agent 运行 env-setup 技能")

# Contact email for Crossref/EPMC polite pools. Override with env CONTACT_EMAIL.
_EMAIL = os.environ.get("CONTACT_EMAIL", "sci-skill@users.noreply.github.com")
UA = {"User-Agent": f"sci-agent-reference-check/1.1 (mailto:{_EMAIL})"}
CROSSREF = "https://api.crossref.org/works/"
EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
TIMEOUT = 25


def epmc_escape(s):
    r"""Escape Europe PMC query-syntax special chars so a title with quotes/colons
    doesn't break the TITLE:"..." clause."""
    return re.sub(r'(["\\:()])', r"\\\1", s or "")

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*(\d{5,9})\b", re.I)


def _get(url, **kw):
    """带退避重试的 GET：碰到 429/503 就等一会再试（api.crossref 限速常见）。"""
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    for attempt in range(4):
        r = requests.get(url, **kw)
        if r.status_code in (429, 503):
            time.sleep(2 * (attempt + 1))
            continue
        return r
    return r


def norm_title(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def title_sim(a, b):
    return SequenceMatcher(None, norm_title(a), norm_title(b)).ratio()


def _epmc_by_doi(doi):
    """Europe PMC fallback for a DOI (reachable from mainland China when Crossref times out)."""
    params = {"query": f"DOI:{epmc_escape(doi)}", "format": "json", "resultType": "core", "pageSize": 1}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    rec = res[0]
    return rec.get("title", ""), {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                                  "authors": rec.get("authorString", "")}


def resolve_doi(doi):
    """返回 (title, meta) 或 (None, None)；Crossref 失败时回退 Europe PMC。"""
    doi = doi.rstrip(".,;)")
    try:
        r = _get(CROSSREF + doi)
        if r.status_code == 404:
            # Confirm the 404 via EPMC before trusting it — Crossref occasionally
            # 404s a DOI it is merely slow to index.
            t, m = _epmc_by_doi(doi)
            return (t, m) if t else (None, None)
        r.raise_for_status()
        msg = r.json()["message"]
        title = (msg.get("title") or [""])[0]
        meta = {
            "journal": (msg.get("container-title") or [""])[0],
            "year": (msg.get("issued", {}).get("date-parts", [[None]])[0][0]),
            "authors": ", ".join(a.get("family", "") for a in msg.get("author", [])[:3]),
        }
        return title, meta
    except requests.RequestException:
        # Crossref rate-limited/unreachable — try EPMC rather than falsely reporting ERROR/FABRICATED
        return _epmc_by_doi(doi)


def resolve_pmid(pmid):
    # NO "AND SRC:MED": that filter hides real-but-not-yet-MEDLINE records
    # (ahead-of-print, PMC-only, preprints) and would mislabel a real PMID as FABRICATED.
    params = {"query": f"EXT_ID:{pmid}", "format": "json", "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    res = r.json().get("resultList", {}).get("result", [])
    if not res:
        return None, None
    # Prefer the record whose external id actually equals the queried PMID.
    rec = next((x for x in res if str(x.get("pmid", "")) == str(pmid)), res[0])
    meta = {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
            "authors": rec.get("authorString", "")}
    return rec.get("title", ""), meta


def title_search(title):
    """只有标题时，去 Europe PMC 反查是否真有这篇。返回最佳匹配 (title, sim, meta)。"""
    params = {"query": f'TITLE:"{epmc_escape(title)}"', "format": "json", "pageSize": 3, "resultType": "core"}
    r = _get(EPMC, params=params)
    r.raise_for_status()
    best = (None, 0.0, None)
    for rec in r.json().get("resultList", {}).get("result", []):
        s = title_sim(title, rec.get("title", ""))
        if s > best[1]:
            best = (rec.get("title", ""), s,
                    {"journal": rec.get("journalTitle", ""), "year": rec.get("pubYear", ""),
                     "doi": rec.get("doi", ""), "pmid": rec.get("pmid", "")})
    return best


def _author_year_flags(entry, meta):
    """Cross-check claimed first-author surname + year against the resolved record.
    Catches 'DOI is real but points to a different paper'. Returns a note fragment or ''."""
    flags = []
    cy = (entry.get("claimed_year") or "").strip()
    my = str((meta or {}).get("year") or "").strip()
    if cy and my and cy.isdigit() and my.isdigit() and abs(int(cy) - int(my)) > 1:
        flags.append(f"年份不符(引用{cy} vs 库{my})")
    ca = (entry.get("claimed_authors") or "").lower()
    if ca:
        # first author surname: bibtex "Last, First and ..." or "First Last and ..."
        first = re.split(r"\s+and\s+", ca)[0]
        surname = first.split(",")[0].strip() if "," in first else first.split()[-1:] and first.split()[-1]
        surname = (surname or "").strip()
        found_auth = (meta or {}).get("authors", "").lower()
        if surname and len(surname) > 2 and found_auth and surname not in found_auth:
            flags.append(f"首作者不符(引用{surname})")
    return "；".join(flags)


def _verdict_with_meta(v, base_note, entry, meta):
    """Downgrade an otherwise-OK verdict to CHECK when author/year disagree."""
    extra = _author_year_flags(entry, meta)
    if extra and v == "OK":
        return "CHECK", base_note + "；但" + extra + "——疑似张冠李戴，请核对"
    if extra:
        return v, base_note + "；另" + extra
    return v, base_note


def _id_failed(kind, id_str, claimed, entry):
    """某个 DOI/PMID 查不到时：**按标题反查一次**。
    经常遇到"论文真实存在、但 DOI 是 AI 编造的"——直接判 FABRICATED 会冤枉真论文。
    标题查到强匹配 → ID_FAKE（真论文+假号，附上正确标识供替换）；否则才 FABRICATED。"""
    if claimed:
        ft, tsim, tmeta = title_search(claimed)
        if ft and tsim >= 0.85:
            real_doi = (tmeta or {}).get("doi") or ""
            real_pmid = (tmeta or {}).get("pmid") or ""
            correct = (f"DOI:{real_doi}" if real_doi else
                       (f"PMID:{real_pmid}" if real_pmid else "见下方匹配到的文献"))
            return dict(verdict="ID_FAKE", id=id_str, found_title=ft, sim=round(tsim, 2),
                        note=f"此 {kind} 查无（疑似 AI 伪造），但按标题查到真实文献——正确标识 {correct}；"
                             f"用正确 {kind} 替换即可", **entry)
        return dict(verdict="FABRICATED", id=id_str, found_title=ft or "", sim=round(tsim, 2),
                    note=f"{kind} 查无，且按标题也查不到匹配——疑似整条虚构，请人工确认", **entry)
    return dict(verdict="FABRICATED", id=id_str, found_title="", sim=0.0,
                note=f"{kind} 查无（不存在），且无标题可反查——请人工确认", **entry)


def verify_one(entry):
    """entry: {'raw','claimed_title','doi','pmid',...} -> 结果 dict。"""
    claimed = entry.get("claimed_title", "")
    doi, pmid = entry.get("doi"), entry.get("pmid")
    try:
        if doi:
            rt, meta = resolve_doi(doi)
            if rt is None:
                return _id_failed("DOI", f"doi:{doi}", claimed, entry)
            sim = title_sim(claimed, rt) if claimed else 1.0
            v = "OK" if (not claimed or sim >= 0.85) else (
                "MISMATCH" if sim < 0.6 else "CHECK")
            note = ("标题吻合" if v == "OK" else
                    f"DOI 存在但标题对不上(相似度{sim:.2f})——引错号或标题是编的")
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"doi:{doi}", found_title=rt, sim=round(sim, 2),
                        note=note, **entry)
        if pmid:
            rt, meta = resolve_pmid(pmid)
            if rt is None:
                return _id_failed("PMID", f"pmid:{pmid}", claimed, entry)
            sim = title_sim(claimed, rt) if claimed else 1.0
            v = "OK" if (not claimed or sim >= 0.85) else (
                "MISMATCH" if sim < 0.6 else "CHECK")
            note = "标题吻合" if v == "OK" else f"PMID 存在但标题对不上({sim:.2f})"
            v, note = _verdict_with_meta(v, note, entry, meta)
            return dict(verdict=v, id=f"pmid:{pmid}", found_title=rt, sim=round(sim, 2),
                        note=note, **entry)
        # 只有标题
        if claimed:
            ft, sim, meta = title_search(claimed)
            if ft and sim >= 0.85:
                extra = f" (匹配 DOI:{meta.get('doi') or 'NA'})" if meta else ""
                return dict(verdict="OK", id="title", found_title=ft, sim=round(sim, 2),
                            note="按标题查到真实文献" + extra, **entry)
            return dict(verdict="NOT_FOUND", id="title", found_title=ft or "",
                        sim=round(sim, 2), note="按标题查不到匹配——疑似虚构，请人工确认", **entry)
        return dict(verdict="ERROR", id="", found_title="", sim=0.0,
                    note="没提取到 DOI/PMID/标题", **entry)
    except Exception as e:
        return dict(verdict="ERROR", id=doi or pmid or "", found_title="", sim=0.0,
                    note=f"查询出错：{e}", **entry)


def parse_input(path, positional):
    entries = []
    if positional:
        for tok in positional:
            entries.append(extract(tok))
        return entries
    if not path:
        return entries
    ext = os.path.splitext(path)[1].lower()
    if ext == ".bib":
        import bibtexparser
        with open(path, encoding="utf-8") as f:
            db = bibtexparser.load(f)
        for e in db.entries:
            entries.append({"raw": e.get("title", ""), "claimed_title": e.get("title", ""),
                            "doi": (e.get("doi") or "").strip() or None,
                            "pmid": (e.get("pmid") or "").strip() or None,
                            "claimed_year": (e.get("year") or "").strip() or None,
                            "claimed_authors": (e.get("author") or "").strip() or None})
    elif ext == ".ris":
        import rispy
        with open(path, encoding="utf-8") as f:
            for e in rispy.load(f):
                title = e.get("primary_title") or e.get("title", "")
                entries.append({"raw": title, "claimed_title": title,
                                "doi": (e.get("doi") or "").strip() or None,
                                "pmid": None})
    else:  # 纯文本，每行一条
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(extract(line))
    return entries


def extract(text):
    """从一行文字里抽 DOI/PMID/标题。"""
    doi = DOI_RE.search(text)
    pmid = PMID_RE.search(text)
    claimed = text
    # 若整行就是个裸标识符，则不当标题
    if doi and text.strip().rstrip(".,;)") == doi.group(0).rstrip(".,;)"):
        claimed = ""
    if pmid and re.fullmatch(r"PMID:?\s*\d+", text.strip(), re.I):
        claimed = ""
    return {"raw": text, "claimed_title": claimed,
            "doi": doi.group(0) if doi else None,
            "pmid": pmid.group(1) if pmid else None}


def main():
    ap = argparse.ArgumentParser(description="文献真实性核查")
    ap.add_argument("ids", nargs="*", help="直接给 DOI/PMID/标题（可多个）")
    ap.add_argument("--input", help="refs.bib / refs.ris / refs.txt")
    ap.add_argument("--outdir", default="outputs")
    args = ap.parse_args()

    entries = parse_input(args.input, args.ids)
    if not entries:
        sys.exit("没有输入。给 --input 文件，或直接列 DOI/PMID/标题。")
    os.makedirs(args.outdir, exist_ok=True)

    print(f"核查 {len(entries)} 条 …")
    results = []
    for i, e in enumerate(entries, 1):
        r = verify_one(e)
        results.append(r)
        print(f"  [{i}/{len(entries)}] {r['verdict']:10} {(r['claimed_title'] or r['id'])[:60]}")
        time.sleep(0.2)

    # CSV
    cols = ["verdict", "sim", "claimed_title", "found_title", "id", "note", "raw"]
    with open(os.path.join(args.outdir, "reference_check.csv"), "w",
              encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    # Markdown 报告（按风险排序）
    order = {"FABRICATED": 0, "ID_FAKE": 1, "NOT_FOUND": 2, "MISMATCH": 3,
             "CHECK": 4, "ERROR": 5, "OK": 6}
    results.sort(key=lambda r: order.get(r["verdict"], 9))
    from collections import Counter
    dist = Counter(r["verdict"] for r in results)
    with open(os.path.join(args.outdir, "reference_check.md"), "w", encoding="utf-8") as f:
        f.write(f"# 文献真实性核查报告（{len(results)} 条）\n\n")
        f.write("统计：" + "，".join(f"{k} {v}" for k, v in dist.items()) + "\n\n")
        for r in results:
            f.write(f"- **{r['verdict']}** — {r['claimed_title'] or r['id']}\n")
            f.write(f"  - {r['note']}\n")
            if r["found_title"] and r["found_title"] != r["claimed_title"]:
                f.write(f"  - 实际匹配到：{r['found_title']}\n")

    bad = sum(dist.get(k, 0) for k in ("FABRICATED", "ID_FAKE", "NOT_FOUND", "MISMATCH"))
    print("-" * 50)
    print(f"结果：{dict(dist)}")
    print(f"可疑/存疑 {bad} 条。报告见 {args.outdir}/reference_check.md / .csv")


if __name__ == "__main__":
    main()
