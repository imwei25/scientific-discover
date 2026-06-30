"""从 SCImago 年度榜单生成医学期刊 ISSN→分区 离线表 (app/data/scimago_med.json)。

用法(在 backend/ 下, 用项目 .venv):
    pip install pandas pyarrow   # 仅刷新数据时需要; 运行时不依赖(运行时只读 JSON)
    python scripts/build_scimago.py <scimago_journals.(parquet|csv)>

数据来源:
  - parquet: ikashnitsky/sjrdata 的 data-raw/sjr-journal/sjr_journals-YYYY.parquet
    (含全部年份, 本脚本自动取最新年份)
  - csv: scimagojr.com 官方导出(分号分隔, SJR 用逗号小数)。

只保留学科领域(areas)含 "Medicine" 的期刊, 取 Scimago "SJR Best Quartile" 分区。
输出: { 归一化ISSN: {"q": "Q1", "sjr": 9.25}, ... }, 一刊多个 ISSN 各建一条。
列名自动按关键词识别, 兼容 parquet(snake_case) 与 csv(原始列名)两种来源。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "scimago_med.json"
_NON_ISSN = re.compile(r"[^0-9X]")
_Q = re.compile(r"Q[1-4]")


def _find_col(cols: list[str], *keywords: str) -> str | None:
    """按关键词(全部命中)在列名里找一列, 大小写/下划线无关。"""
    for c in cols:
        low = c.lower().replace("_", " ").replace(".", " ")
        if all(k in low for k in keywords):
            return c
    return None


def _norm_issn(raw: str) -> list[str]:
    """一个 ISSN 字段可能含多个号(空格/逗号/分号分隔), 全部归一化返回。"""
    out: list[str] = []
    for part in re.split(r"[,;\s]+", str(raw or "")):
        k = _NON_ISSN.sub("", part.upper())
        if len(k) == 8:  # ISSN 为 8 位(末位可能为 X)
            out.append(k)
    return out


def _to_float(v) -> float | None:
    if v is None:
        return None
    s = str(v).strip().replace(",", ".")  # 兼容欧式小数逗号
    try:
        return round(float(s), 3)
    except ValueError:
        return None


def main(src: str) -> None:
    path = Path(src)
    df = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path, sep=";", dtype=str)
    cols = list(df.columns)

    c_issn = _find_col(cols, "issn")
    c_quart = _find_col(cols, "best", "quartile") or _find_col(cols, "quartile")
    # SJR 值列: 名字含 sjr 但不含 quartile/best(后者是分区列)。
    c_sjr = next(
        (c for c in cols if "sjr" in c.lower() and "quartile" not in c.lower() and "best" not in c.lower()),
        None,
    )
    c_area = _find_col(cols, "areas") or _find_col(cols, "area") or _find_col(cols, "subject", "area")
    c_year = _find_col(cols, "year")
    if not (c_issn and c_quart and c_area):
        raise SystemExit(f"列识别失败: issn={c_issn} quartile={c_quart} area={c_area}; 实际列={cols}")

    if c_year:  # 多年份数据只取最新一年
        years = pd.to_numeric(df[c_year], errors="coerce")
        df = df[years == years.max()]

    med = df[df[c_area].astype(str).str.contains("Medicine", case=False, na=False)]

    mapping: dict[str, dict] = {}
    for _, row in med.iterrows():
        q_match = _Q.search(str(row[c_quart] or ""))
        if not q_match:
            continue
        q = q_match.group(0)
        sjr = _to_float(row[c_sjr]) if c_sjr else None
        for issn in _norm_issn(row[c_issn]):
            cur = mapping.get(issn)
            # 同一 ISSN 多条时保留更优分区(再比 SJR)。
            if cur is None or q < cur["q"] or (q == cur["q"] and (sjr or 0) > (cur.get("sjr") or 0)):
                rec = {"q": q}
                if sjr is not None:
                    rec["sjr"] = sjr
                mapping[issn] = rec

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(mapping, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"源列: issn={c_issn} quartile={c_quart} sjr={c_sjr} area={c_area} year={c_year}")
    print(f"医学期刊条目(按 ISSN): {len(mapping)} -> {OUT}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
