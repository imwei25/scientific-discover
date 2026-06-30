"""OpenAlex 期刊影响力富集(api.openalex.org/sources)。

不是检索源, 而是按 ISSN 批量查期刊的 summary_stats.2yr_mean_citedness
(近2年篇均被引), 作为"影响力指数"回填到每篇文献的 journal_impact 字段。

设计取舍:
  - 延续本项目"规避 Clarivate 官方 IF 版权"的立场(见 journalmatch.py): 数据全部
    来自 OpenAlex 自身, 与检索源同源、免费、无需 key(填 mailto 进 polite pool 更稳)。
  - 这是"近2年篇均被引", 近似而非 Clarivate 官方影响因子; 前端文案据此标注。
  - 查不到的期刊回填 None(表示"未知", 不等于 0), 让前端过滤时可单独处理。
  - 影响力数据变化很慢, 进程内缓存 issn->impact, 避免重复请求与限速。
任何失败都被吞掉, 主检索流程不受影响。
"""
from __future__ import annotations

import asyncio

import httpx

from .config import settings

_ENDPOINT = "https://api.openalex.org/sources"
# issn -> 影响力指数; None 表示"查过但 OpenAlex 无该刊/无指标", 用于避免反复查同一刊。
_CACHE: dict[str, float | None] = {}
# 单次请求用 | 做 OR 的 ISSN 上限, 控制 URL 长度(OpenAlex 支持, 但 URL 不宜过长)。
_CHUNK = 40


async def _fetch_chunk(client: httpx.AsyncClient, issns: list[str], email: str) -> dict[str, float | None]:
    """查一批 ISSN 的影响力, 返回 {issn: impact|None}。失败返回空 dict。"""
    params = {
        "filter": "issn:" + "|".join(issns),
        "select": "id,issn_l,issn,summary_stats",
        "per_page": str(len(issns)),
    }
    if email:
        params["mailto"] = email  # 进 polite pool, 响应更稳定
    out: dict[str, float | None] = {}
    try:
        r = await client.get(_ENDPOINT, params=params)
        r.raise_for_status()
        for s in r.json().get("results", []) or []:
            raw = (s.get("summary_stats") or {}).get("2yr_mean_citedness")
            impact = round(float(raw), 2) if raw else None
            # 一本刊可能有多个 ISSN(印刷/电子), 全部建索引以提高命中。
            for key in {s.get("issn_l"), *(s.get("issn") or [])}:
                if key:
                    out[str(key).strip().upper()] = impact
    except Exception:  # noqa: BLE001
        pass
    return out


async def enrich_impact(papers: list[dict], concurrency: int = 4) -> int:
    """就地给带 issn 的文献补 journal_impact(影响力指数)。返回成功命中的篇数。

    无 issn 或查不到的文献, journal_impact 置为 None(未知)。任何失败静默。
    """
    email = (getattr(settings, "ncbi_email", "") or "").strip()
    # 收集尚未缓存的 ISSN。
    need = sorted({p["issn"] for p in papers if p.get("issn") and p["issn"] not in _CACHE})
    if need:
        chunks = [need[i:i + _CHUNK] for i in range(0, len(need), _CHUNK)]
        sem = asyncio.Semaphore(concurrency)
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            async def one(chunk: list[str]) -> dict[str, float | None]:
                async with sem:
                    return await _fetch_chunk(client, chunk, email)

            maps = await asyncio.gather(*[one(c) for c in chunks], return_exceptions=True)
        for m in maps:
            if isinstance(m, dict):
                _CACHE.update(m)
        for issn in need:  # 查过但没返回的标 None, 避免下次重复查
            _CACHE.setdefault(issn, None)
    hit = 0
    for p in papers:
        val = _CACHE.get(p["issn"]) if p.get("issn") else None
        p["journal_impact"] = val
        if val is not None:
            hit += 1
    return hit
