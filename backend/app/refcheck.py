"""参考文献核验中心。

治 LLM 时代最大的投稿事故——AI 杜撰出"看似真实、实则不存在"的 DOI/文献，
以及误引已撤稿文献。逐条核验：
  - 真实性：CrossRef /works/{doi} 命中=真实、404=疑似杜撰；
  - 撤稿：PubMed 出版类型含 "Retracted Publication"（医学域覆盖好）；
  - 去重：DOI/PMID/标题归一化匹配；
  - 补全：缺 DOI 的条目用 CrossRef 题名反查补 DOI。

解析用一次 LLM（半结构化），核验全走确定性网络请求（省额度）。
对外: check_references(text) -> {"ok", "items": [...]}。
"""
from __future__ import annotations

import asyncio
import json
import re

import httpx

from .config import settings
from .literature import _throttle  # 复用 NCBI 全局节流(>=0.34s/次)
from .llm import stream_chat
from .logutil import log_swallow

_CROSSREF = "https://api.crossref.org/works"
_EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def _norm_doi(doi: str) -> str:
    return (doi or "").strip().lower().replace("https://doi.org/", "").replace("http://doi.org/", "").rstrip(".")


_PUNCT = re.compile(r"[^a-z0-9]+")


def _norm_title(t: str) -> str:
    return _PUNCT.sub(" ", (t or "").lower()).strip()


def _mailto() -> dict:
    email = getattr(settings, "ncbi_email", "") or ""
    return {"mailto": email} if email else {}


async def _parse_refs(text: str) -> list[dict]:
    """用 LLM 把参考文献整段拆成 [{raw, doi, pmid, title}]。"""
    system = (
        "你是文献信息抽取助手。把下面的参考文献逐条拆解。只输出 JSON 数组，每项形如 "
        "{\"raw\":\"该条原文\",\"doi\":\"DOI(没有留空)\",\"pmid\":\"PMID(没有留空)\",\"title\":\"文章标题(尽量提取)\"}。"
        "不要编造 DOI 或 PMID；识别不到就留空字符串。不要输出任何解释。"
    )
    buf = ""
    async for piece in stream_chat(
        [{"role": "system", "content": system}, {"role": "user", "content": text[:8000]}],
        max_tokens=2000,
    ):
        buf += piece
    s, e = buf.find("["), buf.rfind("]")
    if s == -1 or e == -1:
        return []
    try:
        arr = json.loads(buf[s : e + 1])
    except Exception as exc:  # noqa: BLE001
        log_swallow("参考文献核验: LLM 解析结果不是合法 JSON, 本次核验为空", exc)
        return []
    out = []
    for it in arr:
        if isinstance(it, dict) and (it.get("raw") or it.get("doi") or it.get("title")):
            out.append({
                "raw": str(it.get("raw") or "").strip(),
                "doi": _norm_doi(str(it.get("doi") or "")),
                "pmid": re.sub(r"\D", "", str(it.get("pmid") or "")),
                "title": str(it.get("title") or "").strip(),
            })
    return out


async def _crossref_get(client: httpx.AsyncClient, doi: str) -> dict | None:
    """按 DOI 取 CrossRef 记录; 404 返回 None(=DOI 不存在)。"""
    try:
        r = await client.get(f"{_CROSSREF}/{doi}", params=_mailto())
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json().get("message")
    except httpx.HTTPStatusError:
        return None
    except Exception:  # noqa: BLE001
        return "error"  # 网络错误用哨兵区分"确实不存在"


async def _crossref_search_doi(client: httpx.AsyncClient, title: str) -> dict | None:
    """用题名在 CrossRef 反查最匹配的一条, 用于补全 DOI。"""
    try:
        r = await client.get(
            _CROSSREF, params={"query.bibliographic": title, "rows": "1", **_mailto()}
        )
        r.raise_for_status()
        items = r.json().get("message", {}).get("items", [])
        return items[0] if items else None
    except Exception:  # noqa: BLE001
        return None


async def _pubmed_lookup(client: httpx.AsyncClient, doi: str, pmid: str, title: str) -> dict:
    """在 PubMed 找到该文献并返回 {pmid, retracted}。优先 DOI、其次 PMID、再题名。"""
    found_pmid = pmid
    if not found_pmid:
        term = f"{doi}[AID]" if doi else (f'"{title}"[Title]' if title else "")
        if term:
            try:
                await _throttle()
                r = await client.get(
                    f"{_EUTILS}/esearch.fcgi",
                    params={"db": "pubmed", "term": term, "retmode": "json", "retmax": "1"},
                )
                r.raise_for_status()
                ids = r.json().get("esearchresult", {}).get("idlist", [])
                found_pmid = ids[0] if ids else ""
            except Exception:  # noqa: BLE001
                found_pmid = ""
    if not found_pmid:
        return {"pmid": "", "retracted": False}
    try:
        await _throttle()
        r = await client.get(
            f"{_EUTILS}/esummary.fcgi",
            params={"db": "pubmed", "id": found_pmid, "retmode": "json"},
        )
        r.raise_for_status()
        res = r.json().get("result", {}).get(found_pmid, {})
        pubtypes = [str(x) for x in (res.get("pubtype") or [])]
        retracted = any("retracted publication" in p.lower() for p in pubtypes)
        return {"pmid": found_pmid, "retracted": retracted}
    except Exception:  # noqa: BLE001
        return {"pmid": found_pmid, "retracted": False}


async def _verify_one(client: httpx.AsyncClient, item: dict) -> dict:
    doi, pmid, title = item["doi"], item["pmid"], item["title"]
    status, note, completed = "unverifiable", "", ""
    cr = None
    if doi:
        cr = await _crossref_get(client, doi)
        if cr is None:
            status, note = "not_found", "CrossRef 查无此 DOI，疑似杜撰，请核对。"
        elif cr == "error":
            status, note = "unverifiable", "网络错误，暂未能核验。"
        else:
            status = "real"
            ct = cr.get("title") or []
            if ct and not title:
                title = ct[0]
    # 撤稿核验(PubMed, 医学域覆盖好) —— 仅在非"DOI 不存在"时查
    if status != "not_found":
        pm = await _pubmed_lookup(client, doi, pmid, title)
        if pm["pmid"]:
            pmid = pm["pmid"]
            if status == "unverifiable":
                status = "real"  # PubMed 命中即视为真实
            if pm["retracted"]:
                status = "retracted"
                note = "PubMed 标注为 Retracted Publication（已撤稿），请勿引用。"
    # 缺 DOI 的补全
    if status in ("unverifiable", "real") and not doi and title:
        hit = await _crossref_search_doi(client, title)
        if hit and hit.get("DOI"):
            cand = _norm_doi(hit["DOI"])
            ht = (hit.get("title") or [""])[0]
            nt, nh = _norm_title(title), _norm_title(ht)
            # 标题须非空且双向前缀任一匹配, 才认为是同一篇(防把无题命中错配 DOI)
            if nh and (nt[:40] in nh or nh[:40] in nt):
                doi = cand
                completed = cand
                if status == "unverifiable":
                    status = "real"
                note = (note + " ").strip() + f"已补全 DOI：{cand}"
    return {**item, "doi": doi, "pmid": pmid, "title": title, "status": status, "note": note, "completed": completed}


def _mark_duplicates(items: list[dict]) -> None:
    """按 DOI / PMID / 归一化标题 任一相同即判为重复(指向首次出现, 1-based)。"""
    seen: dict[str, int] = {}
    for idx, it in enumerate(items):
        keys = [k for k in (it.get("doi"), it.get("pmid"), _norm_title(it.get("title", ""))) if k]
        hit = next((seen[k] for k in keys if k in seen), None)
        if hit is not None:
            it["duplicate_of"] = hit + 1
        else:
            for k in keys:
                seen.setdefault(k, idx)


async def check_references(text: str) -> dict:
    if not (text or "").strip():
        return {"ok": False, "error": "请粘贴参考文献。"}
    if settings.mock:
        return {"ok": True, "items": [
            {"raw": "[MOCK] Smith J. A real paper. 2023.", "doi": "10.1000/real", "pmid": "1", "title": "A real paper", "status": "real", "note": "", "completed": ""},
            {"raw": "[MOCK] Fake X. Hallucinated. 2024.", "doi": "10.0000/fake", "pmid": "", "title": "Hallucinated", "status": "not_found", "note": "CrossRef 查无此 DOI。", "completed": ""},
        ]}
    try:
        parsed = await _parse_refs(text)
        if not parsed:
            return {"ok": False, "error": "未能从文本中识别出参考文献，请检查格式。"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
            items = await asyncio.gather(*[_verify_one(client, it) for it in parsed])
        items = list(items)
        _mark_duplicates(items)
        return {"ok": True, "items": items}
    except Exception as e:  # noqa: BLE001
        import traceback
        print("[refcheck] exception:\n" + traceback.format_exc(), flush=True)
        return {"ok": False, "error": f"核验出错：{type(e).__name__}: {e}"}
