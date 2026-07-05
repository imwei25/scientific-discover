"""智能选刊匹配。

原理同 JANE：用摘要在 OpenAlex 检索语义相近的近年文献，聚合这些文献的发表期刊
做频次/相关度排序，得到"投哪本期刊"的候选；再用一次 LLM 给每本候选一句匹配理由。
OpenAlex 免费无 key（填 mailto 进 polite pool）。期刊元数据(是否 OA / DOAJ / ISSN)
直接取自 OpenAlex source，无需第三方、规避影响因子版权问题。

已停刊 / 已迁移期刊(is_ceased / is_moved)在聚合阶段过滤。前 N*2 候选做一次影响力
(OpenAlex 近2年篇均被引) 与 Scimago 分区富集, 再按 count × 分区权重加权排序;
分区库覆盖不全时对未收录期刊保持中性权重, 不做额外惩罚。

对外: match_journals(abstract) -> {"ok", "journals": [...]}。
"""
from __future__ import annotations

import datetime
import json

import httpx

from .config import settings
from .impactfactor import enrich_impact
from .llm import stream_chat
from .logutil import log_swallow
from .scimago import annotate_quartile

# 分区权重: Q1 优先, Q4 降级(不完全过滤, 因分区库仅覆盖医学子集)。缺失时中性(0)。
_Q_WEIGHT = {"Q1": 1.5, "Q2": 1.15, "Q3": 0.85, "Q4": 0.6}

_ENDPOINT = "https://api.openalex.org/works"


def _mailto() -> dict:
    email = getattr(settings, "ncbi_email", "") or ""
    return {"mailto": email} if email else {}


async def _annotate(abstract: str, journals: list[dict]) -> dict[str, str]:
    """用一次 LLM 给每本候选期刊一句匹配理由(≤40字)。失败则返回空。"""
    lst = "\n".join(
        f"- {j['journal']}（近年相近文献样例：{'；'.join(j['samples'][:2]) or '—'}）"
        for j in journals
    )
    system = (
        "你是科研选刊顾问。下面是某稿件摘要，以及候选期刊及其近年发表的相近文献样例。"
        "请为每本期刊给一句不超过 40 字的匹配理由（说明为何契合：读者群/主题/研究类型）。"
        "只输出 JSON 数组，每项 {\"journal\":\"期刊名(与给定完全一致)\",\"reason\":\"理由\"}，不要解释。"
    )
    user = f"【稿件摘要】\n{abstract[:1500]}\n\n【候选期刊】\n{lst}"
    buf = ""
    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            task="journal_match",
            max_tokens=900,
        ):
            buf += piece
        s, e = buf.find("["), buf.rfind("]")
        arr = json.loads(buf[s : e + 1]) if s != -1 and e != -1 else []
    except Exception as exc:  # noqa: BLE001
        log_swallow("智能选刊: 匹配理由生成失败(结果将不带理由)", exc)
        return {}
    out: dict[str, str] = {}
    if isinstance(arr, list):
        for it in arr:
            if isinstance(it, dict) and it.get("journal"):
                out[str(it["journal"]).strip()] = str(it.get("reason") or "").strip()
    return out


async def match_journals(abstract: str, max_journals: int = 10) -> dict:
    abstract = (abstract or "").strip()
    if not abstract:
        return {"ok": False, "error": "请粘贴稿件摘要或标题。"}
    if settings.mock:
        return {"ok": True, "journals": [
            {"journal": "Mock Journal of Oncology", "count": 7, "is_oa": True, "in_doaj": True,
             "issn": "0000-0000", "journal_impact": 8.2, "journal_quartile": "Q1",
             "samples": ["[MOCK] A related study"], "reason": "[MOCK] 主题高度契合"},
        ]}
    cur_year = datetime.date.today().year
    # select 显式列 source 内字段(含 is_in_doaj/is_oa/is_ceased/is_moved), 便于过滤已停刊/迁移期刊。
    params = {
        "search": abstract[:600],
        "filter": f"from_publication_date:{cur_year - 6}-01-01,primary_location.source.type:journal",
        "per_page": "50",
        "select": "id,title,publication_year,primary_location",
        **_mailto(),
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            r = await client.get(_ENDPOINT, params=params)
            r.raise_for_status()
            results = r.json().get("results", []) or []
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"无法连接 OpenAlex：{type(e).__name__}"}

    agg: dict[str, dict] = {}
    for w in results:
        src = (w.get("primary_location") or {}).get("source") or {}
        name = (src.get("display_name") or "").strip()
        if not name:
            continue
        # 过滤已停刊/已迁移期刊: OpenAlex 用 is_ceased/is_moved 标记, 不宜再推荐投稿。
        if src.get("is_ceased") or src.get("is_moved"):
            continue
        d = agg.setdefault(name, {
            "journal": name, "count": 0,
            "is_oa": bool(src.get("is_oa")),
            "in_doaj": bool(src.get("is_in_doaj")),
            "issn": (src.get("issn_l") or "") or "",
            "samples": [],
        })
        d["count"] += 1
        t = (w.get("title") or "").strip()
        if t and len(d["samples"]) < 2:
            d["samples"].append(t)
    # 先取相近度前 N*2, 富集后再按加权重排, 保证 Q1/高影响力候选不被相近度独占。
    prelim = sorted(agg.values(), key=lambda x: -x["count"])[: max_journals * 2]
    if not prelim:
        return {"ok": False, "error": "未能匹配到相近期刊，请提供更完整的摘要后重试。"}

    # 富集: OpenAlex 近2年篇均被引作影响力指数; 本地 Scimago 医学分区表; 均失败静默(字段回 None)。
    try:
        await enrich_impact(prelim)
    except Exception as exc:  # noqa: BLE001
        log_swallow("智能选刊: 影响力富集失败(将不显示影响力)", exc)
    try:
        annotate_quartile(prelim)
    except Exception as exc:  # noqa: BLE001
        log_swallow("智能选刊: 分区标注失败(将不显示分区)", exc)

    # 加权排序: 分区库不完整, 缺失时权重=1(中性), 不惩罚未收录期刊。
    def _score(j: dict) -> float:
        return float(j.get("count", 0)) * _Q_WEIGHT.get(j.get("journal_quartile") or "", 1.0)

    journals = sorted(prelim, key=lambda x: -_score(x))[:max_journals]

    reasons = await _annotate(abstract, journals)
    for j in journals:
        j["reason"] = reasons.get(j["journal"], "")
    return {"ok": True, "journals": journals}
