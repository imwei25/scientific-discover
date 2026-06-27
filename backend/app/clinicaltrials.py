"""ClinicalTrials.gov v2 检索客户端（"在研试验"旁路）。

与论文源(PubMed/EuropePMC/OpenAlex)本质不同：这里检索的是**临床试验注册库**，
能看到"别人正在做、但还没发表论文"的试验——对判断研究空白价值独特。
免费、无需 key。

注意：它不是论文，没有 doi/期刊/摘要的概念，主键是 NCT 编号。因此**单独 normalize 成
trial dict、走独立 SSE 事件/独立板块展示，绝不混进论文去重与排序池**（"旁路"即此意）。
"""
from __future__ import annotations

import httpx

_ENDPOINT = "https://clinicaltrials.gov/api/v2/studies"


def _normalize(study: dict) -> dict | None:
    """把 v2 的一条 study(protocolSection 多模块嵌套) 转成统一 trial dict。"""
    ps = study.get("protocolSection") or {}
    ident = ps.get("identificationModule") or {}
    nct = (ident.get("nctId") or "").strip()
    title = (ident.get("briefTitle") or ident.get("officialTitle") or "").strip()
    if not nct or not title:
        return None
    status = ((ps.get("statusModule") or {}).get("overallStatus") or "").strip()
    phases = (ps.get("designModule") or {}).get("phases") or []
    phase = ", ".join(str(p).replace("PHASE", "Phase ") for p in phases) if phases else ""
    conditions = (ps.get("conditionsModule") or {}).get("conditions") or []
    summary = ((ps.get("descriptionModule") or {}).get("briefSummary") or "").strip()
    start = ((ps.get("statusModule") or {}).get("startDateStruct") or {}).get("date") or ""
    return {
        "nct_id": nct,
        "title": title,
        "status": status,
        "phase": phase,
        "conditions": ", ".join(str(c) for c in conditions[:4]),
        "summary": summary[:600],
        "year": str(start)[:4],
        "url": f"https://clinicaltrials.gov/study/{nct}",
    }


async def _search_one(client: httpx.AsyncClient, query: str, per_query: int) -> list[dict]:
    params = {
        "query.term": query,
        "pageSize": str(per_query),
        "format": "json",
        # 按相关性返回(默认即相关性), 只取概要字段够用。
        "countTotal": "false",
    }
    r = await client.get(_ENDPOINT, params=params)
    r.raise_for_status()
    data = r.json()
    out: list[dict] = []
    for study in data.get("studies", []) or []:
        norm = _normalize(study)
        if norm:
            out.append(norm)
    return out


async def search_trials(queries: list[str], per_query: int = 5, cap: int = 12) -> dict:
    """对多个检索式跑 ClinicalTrials.gov, 按 NCT 去重, 返回 {trials, network_errors}。"""
    seen: set[str] = set()
    collected: list[dict] = []
    network_errors = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for q in queries:
            try:
                results = await _search_one(client, q, per_query)
            except Exception:  # noqa: BLE001
                network_errors += 1
                continue
            for t in results:
                if t["nct_id"] in seen:
                    continue
                seen.add(t["nct_id"])
                collected.append(t)
                if len(collected) >= cap:
                    break
            if len(collected) >= cap:
                break
    return {"trials": collected, "network_errors": network_errors}
