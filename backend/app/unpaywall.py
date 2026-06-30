"""Unpaywall OA 全文富集(api.unpaywall.org)。

Unpaywall 不是检索源, 而是按 DOI 查"该文献是否有合法开放获取(OA)全文、链接在哪"。
它补足本方案"只有元数据、拿不到全文"的短板: 给已检索到、带 DOI 的文献追加一个
oa_url 字段(优先 PDF 直链), 供前端展示"🔓 免费全文"。只发现合法 OA, 不绕付费墙。

Unpaywall 强制要求 email 参数(无 email 直接拒绝), 这里复用 NCBI_EMAIL;
未配置时本步静默跳过(返回 0), 不影响主检索流程。
"""
from __future__ import annotations

import asyncio

import httpx

from .config import settings

_ENDPOINT = "https://api.unpaywall.org/v2/"


async def _lookup(client: httpx.AsyncClient, doi: str, email: str) -> str:
    """查单个 DOI 的最佳 OA 全文链接; 无 OA 或出错返回空串。"""
    try:
        r = await client.get(f"{_ENDPOINT}{doi}", params={"email": email})
        if r.status_code != 200:
            return ""
        data = r.json()
        if not data.get("is_oa"):
            return ""
        loc = data.get("best_oa_location") or {}
        return (loc.get("url_for_pdf") or loc.get("url") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


async def enrich_oa(papers: list[dict], email: str | None = None, concurrency: int = 6) -> int:
    """就地给带 DOI、尚无 oa_url 的文献补 oa_url。返回成功补到链接的篇数。

    并发受限(默认 6), 对 Unpaywall 友好; 任何失败都被吞掉, 主流程不受影响。
    """
    email = (email or getattr(settings, "ncbi_email", "") or "").strip()
    if not email:  # Unpaywall 必须带 email, 未配置则跳过
        return 0
    targets = [p for p in papers if p.get("doi") and not p.get("oa_url")]
    if not targets:
        return 0
    sem = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0)) as client:
        async def one(p: dict) -> int:
            async with sem:
                url = await _lookup(client, p["doi"], email)
            if url:
                p["oa_url"] = url
                return 1
            return 0

        results = await asyncio.gather(*[one(p) for p in targets], return_exceptions=True)
    return sum(r for r in results if isinstance(r, int))
