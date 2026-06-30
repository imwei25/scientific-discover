"""Scimago 期刊分区(仅医学)离线匹配。

内置一份 SCImago(SJR) 年度榜单的医学子集(data/scimago_med.json), 按 ISSN 本地
匹配出期刊分区(Q1-Q4)与 SJR 值 —— 零网络、零限速。它与 OpenAlex 影响力指数互补:
影响力是连续数值, 分区是 Scimago 的相对档位, 跨刊比较更公平。

数据来源: SCImago Journal Rank (scimagojr.com), 基于 Scopus 的免费数据; 仅取医学领域,
分区取 Scimago 自家 "SJR Best Quartile"(非中科院/JCR 分区, 也非 Clarivate 数据,
延续本项目规避官方 IF 版权的立场)。

刷新数据: 重跑 scripts/build_scimago.py 生成新的 data/scimago_med.json。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_DATA = Path(__file__).parent / "data" / "scimago_med.json"
_NON_ISSN = re.compile(r"[^0-9X]")


def _key(issn: str) -> str:
    """ISSN 归一化: 去连字符/空格、大写, 便于与 Scimago 的 8 位号匹配。"""
    return _NON_ISSN.sub("", (issn or "").upper())


def _load() -> dict[str, dict]:
    try:
        return json.loads(_DATA.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 — 数据文件缺失/损坏时静默降级(功能可选)
        return {}


_MAP = _load()


def annotate_quartile(papers: list[dict]) -> int:
    """就地给带 ISSN 的(医学)期刊文献补 journal_quartile / journal_sjr。返回命中篇数。

    本地查表, 同步执行(无网络); 查不到则 journal_quartile=None(未知)。
    """
    hit = 0
    for p in papers:
        rec = _MAP.get(_key(p["issn"])) if p.get("issn") else None
        if rec:
            p["journal_quartile"] = rec.get("q")
            p["journal_sjr"] = rec.get("sjr")
            hit += 1
        else:
            p.setdefault("journal_quartile", None)
    return hit
