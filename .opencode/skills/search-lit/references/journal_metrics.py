#!/usr/bin/env python3
"""给证据表补上「期刊影响力」列，并可按区间/四分位筛选。

═══════════════════════════════════════════════════════════════════════════
⚠️ 这【不是】影响因子。请把下面这段读完再用。
═══════════════════════════════════════════════════════════════════════════
官方的 JCR Impact Factor 与中科院分区都是【授权数据】，本套件没有、也不能内置分发。
本脚本给出的是 OpenAlex 的 `summary_stats.2yr_mean_citedness` —— 该刊近两年发文的
篇均被引，与 JIF 的算法思路相近但【口径不同、数值不同、不可互相替代】。

所以：
  · 输出列名叫 `journal_impact`（不叫 impact_factor），单位写明「两年篇均被引」；
  · 分档列叫 `journal_quartile`，是【本次结果集内部】的四分位，不是中科院/JCR 分区；
  · 任何面向用户的表述都必须带上"近似""非官方影响因子"字样。凭这个数说"这篇发在 5 分
    的杂志上"就是编造数据，违反 AGENTS.md §五 的不虚构铁律。

要精确的分区，用 `--table 你机构的JCR或中科院分区表.xlsx/csv`：脚本按 ISSN（或期刊名）
映射，命中的行用你表里的真值覆盖，并在 `impact_source` 列标明来源，让用户一眼看出
哪几行是官方数据、哪几行只是近似。

用法
----
    PY=${REPO_ROOT:-/app}/.venv/bin/python
    S=${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/journal_metrics.py

    # 给证据表补列（就地写回，另存 --out 也行）
    "$PY" "$S" evidence_table.csv --email you@example.com

    # 补列 + 只保留影响力 ≥3 且 OA 的
    "$PY" "$S" evidence_table.csv --min-impact 3 --only-oa

    # 用机构的分区表覆盖（列名自动认 ISSN / 期刊 / IF / 分区）
    "$PY" "$S" evidence_table.csv --table /path/中科院分区表2025.csv
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

OPENALEX = "https://api.openalex.org/sources"
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "sci-journal-metrics.json")
UA = "sci-skill-suite/1.0 (journal metrics; mailto:%s)"


# ---------------------------------------------------------------- 本地缓存
# 期刊指标几乎不变，缓存能让同一批检索的重复期刊只查一次；跨会话也复用。
def load_cache():
    try:
        with open(CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(c):
    try:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        with open(CACHE, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False)
    except Exception as e:                      # 缓存写不了不是错误，别打断主流程
        sys.stderr.write("[warn] 缓存写入失败（不影响结果）：%s\n" % e)


def _get(url, email, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA % (email or "anonymous@example.com")})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_source(name, email, cache):
    """按期刊名（或 ISSN）问 OpenAlex 要该刊指标。查不到返回 None —— 不猜、不编。"""
    key = re.sub(r"\s+", " ", (name or "").strip().lower())
    if not key:
        return None
    if key in cache:
        return cache[key]
    try:
        if re.fullmatch(r"\d{4}-\d{3}[\dxX]", key):
            url = "%s/issn:%s" % (OPENALEX, key)
            data = _get(url, email)
            hit = data if data.get("id") else None
        else:
            url = "%s?filter=display_name.search:%s&per-page=1" % (
                OPENALEX, urllib.parse.quote(key))
            data = _get(url, email)
            res = data.get("results") or []
            hit = res[0] if res else None
    except Exception as e:
        sys.stderr.write("[warn] 查询失败 %r：%s\n" % (name, e))
        return None                             # 失败不写缓存，下次还能重试
    if not hit:
        cache[key] = None                       # 确认查无此刊才缓存空值
        return None
    st = hit.get("summary_stats") or {}
    out = {
        "name": hit.get("display_name") or name,
        "issn": (hit.get("issn_l") or ""),
        "impact": round(st.get("2yr_mean_citedness") or 0.0, 2),
        "h_index": st.get("h_index") or 0,
        "is_oa": bool(hit.get("is_oa")),
        "in_doaj": bool(hit.get("is_in_doaj")),
    }
    cache[key] = out
    time.sleep(0.12)                            # polite pool 限速，别把共享池打爆
    return out


# ------------------------------------------------------- 用户上传的分区表
def load_user_table(path):
    """读机构的 JCR / 中科院分区表。列名尽量自动认；认不出就如实报错，不瞎猜。"""
    rows = []
    if path.lower().endswith((".xlsx", ".xls")):
        try:
            import openpyxl                     # 有就用，没有就让用户另存为 csv
        except ImportError:
            sys.exit("读 xlsx 需要 openpyxl（.venv 里跑 pip install openpyxl），"
                     "或把分区表另存为 CSV 再传给 --table。")
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        head = [str(x or "").strip() for x in next(it)]
        for r in it:
            rows.append(dict(zip(head, [("" if x is None else x) for x in r])))
    else:
        with open(path, "r", encoding="utf-8-sig", newline="") as f:
            rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("分区表是空的：%s" % path)

    def find(cands):
        for k in rows[0]:
            kk = str(k).strip().lower().replace(" ", "")
            for c in cands:
                if c in kk:
                    return k
        return None

    col_issn = find(["issn"])
    col_name = find(["journal", "期刊", "刊名", "title", "名称"])
    col_if = find(["impactfactor", "if", "影响因子", "jif"])
    col_q = find(["quartile", "分区", "q值", "jcr分区", "中科院分区"])
    if not (col_issn or col_name):
        sys.exit("分区表里既找不到 ISSN 列也找不到期刊名列，没法映射。"
                 "请确认表头包含 ISSN 或 Journal/期刊 之一。")
    idx = {}
    for r in rows:
        for key in filter(None, [str(r.get(col_issn, "")).strip().lower() if col_issn else "",
                                 str(r.get(col_name, "")).strip().lower() if col_name else ""]):
            if key:
                idx[key] = {
                    "impact": str(r.get(col_if, "")).strip() if col_if else "",
                    "quartile": str(r.get(col_q, "")).strip() if col_q else "",
                }
    sys.stderr.write("[info] 已载入分区表 %s：%d 条映射（IF 列=%s，分区列=%s）\n"
                     % (os.path.basename(path), len(idx), col_if or "无", col_q or "无"))
    return idx


def main():
    ap = argparse.ArgumentParser(description="给证据表补期刊影响力列（OpenAlex 近似，非官方 IF）")
    ap.add_argument("csv_path", help="evidence_table.csv（需含 journal 或 issn 列）")
    ap.add_argument("--out", help="输出路径（默认就地写回）")
    ap.add_argument("--email", default=os.environ.get("OPENALEX_MAILTO", ""),
                    help="OpenAlex polite pool 联系邮箱（不填也能用，但限速更紧）")
    ap.add_argument("--table", help="机构的 JCR / 中科院分区表（csv/xlsx），命中的行用它覆盖")
    ap.add_argument("--min-impact", type=float, help="只保留影响力 ≥ 该值的文献")
    ap.add_argument("--max-impact", type=float, help="只保留影响力 ≤ 该值的文献")
    ap.add_argument("--quartile", help="只保留这些四分位，逗号分隔，如 Q1,Q2")
    ap.add_argument("--only-oa", action="store_true", help="只保留开放获取期刊的文献")
    args = ap.parse_args()

    if not os.path.exists(args.csv_path):
        sys.exit("找不到文件：%s" % args.csv_path)
    with open(args.csv_path, "r", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("证据表是空的：%s" % args.csv_path)

    jcol = next((k for k in rows[0] if str(k).strip().lower() in ("journal", "期刊", "source", "venue")), None)
    icol = next((k for k in rows[0] if "issn" in str(k).strip().lower()), None)
    if not (jcol or icol):
        sys.exit("证据表里没有 journal / issn 列，无法查期刊指标。"
                 "（search-lit 的 enhanced_search.py 产出的表带 journal 列）")

    user_tbl = load_user_table(args.table) if args.table else {}
    cache = load_cache()
    n_hit = n_miss = n_user = 0
    for r in rows:
        jname = (r.get(icol) or r.get(jcol) or "").strip() if icol else (r.get(jcol) or "").strip()
        info = fetch_source(jname, args.email, cache)
        r["journal_impact"] = info["impact"] if info else ""
        r["journal_h_index"] = info["h_index"] if info else ""
        r["is_oa"] = "1" if (info and info["is_oa"]) else ("0" if info else "")
        r["impact_source"] = "OpenAlex 两年篇均被引(近似)" if info else "未查到"
        # 用户表命中则覆盖，并把来源改成那张表 —— 让用户一眼分得清哪几行是官方真值
        key1 = str(r.get(icol, "")).strip().lower() if icol else ""
        key2 = str(r.get(jcol, "")).strip().lower() if jcol else ""
        u = user_tbl.get(key1) or user_tbl.get(key2)
        if u:
            if u["impact"]:
                r["journal_impact"] = u["impact"]
            if u["quartile"]:
                r["journal_quartile"] = u["quartile"]
            r["impact_source"] = os.path.basename(args.table)
            n_user += 1
        if info:
            n_hit += 1
        else:
            n_miss += 1
    save_cache(cache)

    # 四分位：仅当用户表没给分区时才自己算，且【只在本结果集内部】排序分档。
    # 这不是中科院/JCR 分区 —— 换一批检索结果，同一本刊可能落在不同档。列名与文档都写死这层含义。
    vals = sorted([float(r["journal_impact"]) for r in rows
                   if str(r.get("journal_impact", "")).replace(".", "", 1).isdigit()], reverse=True)
    for r in rows:
        if r.get("journal_quartile"):
            continue
        try:
            v = float(r["journal_impact"])
        except (TypeError, ValueError):
            r["journal_quartile"] = ""
            continue
        rank = vals.index(v) / max(1, len(vals) - 1) if len(vals) > 1 else 0
        r["journal_quartile"] = "Q1" if rank <= 0.25 else "Q2" if rank <= 0.5 else "Q3" if rank <= 0.75 else "Q4"

    kept = rows
    if args.min_impact is not None:
        kept = [r for r in kept if _f(r.get("journal_impact")) is not None and _f(r["journal_impact"]) >= args.min_impact]
    if args.max_impact is not None:
        kept = [r for r in kept if _f(r.get("journal_impact")) is not None and _f(r["journal_impact"]) <= args.max_impact]
    if args.quartile:
        want = {q.strip().upper() for q in args.quartile.split(",") if q.strip()}
        kept = [r for r in kept if (r.get("journal_quartile") or "").upper() in want]
    if args.only_oa:
        kept = [r for r in kept if r.get("is_oa") == "1"]

    out = args.out or args.csv_path
    head = list(rows[0].keys())
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=head)
        w.writeheader()
        w.writerows(kept)

    dropped = len(rows) - len(kept)
    sys.stderr.write(
        "\n期刊指标补全完成 → %s\n"
        "  查到指标 %d 篇 / 未查到 %d 篇%s\n"
        "  筛选后保留 %d 篇%s\n"
        "\n⚠️ journal_impact 是 OpenAlex 的【两年篇均被引】，是 JIF 式的【近似】指标，\n"
        "   不是官方影响因子；journal_quartile 是【本结果集内部】的四分位，不是中科院/JCR 分区。\n"
        "   向用户汇报时必须带上这层限定，不要说成\"影响因子 X 分\"或\"X 区\"。%s\n"
        % (out, n_hit, n_miss,
           ("（未查到的行 journal_impact 留空，不要拿 0 当真值）" if n_miss else ""),
           len(kept), ("，按条件剔除 %d 篇" % dropped) if dropped else "",
           ("\n   其中 %d 篇已被 %s 的官方数值覆盖（见 impact_source 列）。"
            % (n_user, os.path.basename(args.table)) if n_user else ""))
    )


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    main()
