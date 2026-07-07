"""PubMed 文献检索客户端(NCBI E-utilities)。

用于医学/药学/生物领域的“找选题”: 实际检索真实文献, 供 LLM 梳理现状与空白,
并生成可点击的 PubMed 链接。E-utilities 免费, 无需 key(限速 3 次/秒)。
"""
from __future__ import annotations

import asyncio
import datetime
import math
import re
import time
import xml.etree.ElementTree as ET

import httpx

from . import searchcache, searchfilters
from .config import settings
from .crossref import search_crossref
from .europepmc import search_epmc
from .impactfactor import enrich_impact
from .openalex import search_openalex
from .scimago import annotate_quartile
from .unpaywall import enrich_oa

_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
_TOOL = "research-assistant"

# NCBI E-utilities 无 api_key 时限速 3 次/秒, 超限会返回 429 甚至临时封 IP。
# 深度调研会连发多次 esearch/efetch, 这里做全局节流, 保证请求间隔 >= 0.34s。
_NCBI_MIN_INTERVAL = 0.34
_ncbi_lock = asyncio.Lock()
_ncbi_last = 0.0


async def _throttle() -> None:
    """确保相邻 NCBI 请求间隔不小于 _NCBI_MIN_INTERVAL 秒。"""
    global _ncbi_last
    async with _ncbi_lock:
        wait = _NCBI_MIN_INTERVAL - (time.monotonic() - _ncbi_last)
        if wait > 0:
            await asyncio.sleep(wait)
        _ncbi_last = time.monotonic()


def pubmed_url(pmid: str) -> str:
    return f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"


def _common_params() -> dict:
    p = {"tool": _TOOL}
    email = getattr(settings, "ncbi_email", "") or ""
    if email:
        p["email"] = email
    return p


async def esearch(client: httpx.AsyncClient, query: str, retmax: int = 8) -> list[str]:
    params = {
        "db": "pubmed",
        "term": query,
        "retmax": str(retmax),
        "retmode": "json",
        "sort": "relevance",
        **_common_params(),
    }
    await _throttle()
    r = await client.get(f"{_BASE}/esearch.fcgi", params=params)
    r.raise_for_status()
    data = r.json()
    return data.get("esearchresult", {}).get("idlist", [])


def _text(el) -> str:
    return "".join(el.itertext()).strip() if el is not None else ""


def _parse_efetch_xml(xml_text: str) -> list[dict]:
    """把 PubMed EFetch 返回的 XML 解析为结构化 dict 列表。
    比 efetch() 富：additionally 返回 authors: list[{family, given}]，
    供 refsenrich 等下游用于稳定的 CSL 作者渲染（不丢失复姓）。"""
    root = ET.fromstring(xml_text)
    papers: list[dict] = []
    for art in root.findall(".//PubmedArticle"):
        pmid = _text(art.find(".//PMID"))
        title = _text(art.find(".//Article/ArticleTitle"))
        journal = _text(art.find(".//Journal/Title"))
        year = _text(art.find(".//JournalIssue/PubDate/Year")) or _text(
            art.find(".//JournalIssue/PubDate/MedlineDate")
        )
        doi = ""
        for aid in art.findall(".//ArticleIdList/ArticleId"):
            if (aid.get("IdType") or "").lower() == "doi":
                doi = _text(aid).lower()
                break
        authors: list[dict] = []
        for a in art.findall(".//AuthorList/Author"):
            family = _text(a.find("LastName")) or _text(a.find("CollectiveName"))
            given = _text(a.find("ForeName")) or _text(a.find("Initials"))
            if family or given:
                authors.append({"family": family, "given": given})
        if not pmid:
            continue
        papers.append({
            "pmid": pmid,
            "title": title,
            "authors": authors,
            "journal": journal,
            "doi": doi,
            "year": year,
        })
    return papers


async def efetch_full(client: httpx.AsyncClient, pmids: list[str]) -> list[dict]:
    """完整版 efetch：返回结构化 authors 列表，用于 refsenrich 元数据补齐。"""
    if not pmids:
        return []
    params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "retmode": "xml",
        "rettype": "abstract",
        **_common_params(),
    }
    await _throttle()
    r = await client.get(f"{_BASE}/efetch.fcgi", params=params)
    r.raise_for_status()
    return _parse_efetch_xml(r.text)


async def efetch(client: httpx.AsyncClient, pmids: list[str]) -> list[dict]:
    if not pmids:
        return []
    params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "retmode": "xml",
        "rettype": "abstract",
        **_common_params(),
    }
    await _throttle()
    r = await client.get(f"{_BASE}/efetch.fcgi", params=params)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    papers: list[dict] = []
    for art in root.findall(".//PubmedArticle"):
        pmid = _text(art.find(".//PMID"))
        title = _text(art.find(".//Article/ArticleTitle"))
        # 摘要可能分多段(带 Label)
        abstract_parts = []
        for ab in art.findall(".//Abstract/AbstractText"):
            label = ab.get("Label")
            txt = _text(ab)
            abstract_parts.append(f"{label}: {txt}" if label else txt)
        abstract = " ".join(abstract_parts)
        # 第一作者
        first_author = ""
        author = art.find(".//AuthorList/Author")
        if author is not None:
            last = _text(author.find("LastName"))
            initials = _text(author.find("Initials"))
            first_author = f"{last} {initials}".strip()
        journal = _text(art.find(".//Journal/Title"))
        # 期刊 ISSN: 优先 Journal/ISSN(印刷或电子), 退回 MedlineJournalInfo/ISSNLinking。
        issn = (_text(art.find(".//Journal/ISSN")) or _text(art.find(".//MedlineJournalInfo/ISSNLinking"))).strip().upper()
        year = _text(art.find(".//JournalIssue/PubDate/Year")) or _text(
            art.find(".//JournalIssue/PubDate/MedlineDate")
        )
        # DOI 用于跨源去重（与 Europe PMC 结果对齐）。
        doi = ""
        for aid in art.findall(".//ArticleIdList/ArticleId"):
            if (aid.get("IdType") or "").lower() == "doi":
                doi = _text(aid).lower()
                break
        if not pmid or not title:
            continue
        papers.append(
            {
                "pmid": pmid,
                "doi": doi,
                "title": title,
                "abstract": abstract,
                "first_author": first_author,
                "journal": journal,
                "issn": issn,
                "year": year,
                "url": pubmed_url(pmid),
                "source": "pubmed",
            }
        )
    return papers


async def _search_pubmed(queries: list[str], per_query: int, cap: int, filters: dict | None = None) -> dict:
    """只跑 PubMed（NCBI E-utilities）的版本, 返回与 search_literature 同形 dict。"""
    suffix = searchfilters.pubmed_suffix(filters or {})
    seen: set[str] = set()
    collected: list[str] = []
    network_errors = 0
    queries_tried = list(queries)
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        for q in queries:
            try:
                ids = await esearch(client, q + suffix, retmax=per_query)
            except Exception:  # noqa: BLE001
                network_errors += 1
                continue
            for pid in ids:
                if pid not in seen:
                    seen.add(pid)
                    collected.append(pid)
            if len(collected) >= cap:
                break
        collected = collected[:cap]
        papers: list[dict] = []
        if collected:
            try:
                papers = await efetch(client, collected)
            except Exception:  # noqa: BLE001
                network_errors += 1
                papers = []
    return {"papers": papers, "network_errors": network_errors, "queries_tried": queries_tried}


_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _title_key(title: str) -> str:
    """标题归一化键（去标点+小写+折叠空白）, 用于跨源题名级去重。"""
    return _PUNCT_RE.sub(" ", title.lower()).strip()


# 检索式里的布尔/字段标签等"非主题"记号, 提取真实主题词时剔除。
_QUERY_STOP = {
    "and", "or", "not", "the", "of", "in", "on", "for", "with", "to", "a", "an",
    "mesh", "tiab", "tw", "title", "abstract", "majr", "mh",
}


def _query_terms(queries: list[str]) -> set[str]:
    """从 PubMed 检索式集合里提取主题词(去布尔逻辑/字段标签/MeSH 记号), 用于词面相关性打分。"""
    terms: set[str] = set()
    for q in queries or []:
        # 去掉 [Title/Abstract] 这类字段标签与括号/引号
        cleaned = re.sub(r"\[[^\]]*\]", " ", q or "")
        for tok in _PUNCT_RE.sub(" ", cleaned.lower()).split():
            if len(tok) >= 3 and tok not in _QUERY_STOP and not tok.isdigit():
                terms.add(tok)
    return terms


def _lexical_rel(p: dict, terms: set[str]) -> float:
    """主题词在标题/摘要中的命中比例(标题权重更高), 0~1。无主题词时返回 0.5(中性)。"""
    if not terms:
        return 0.5
    title = (p.get("title") or "").lower()
    abstract = (p.get("abstract") or "")[:1500].lower()
    t_hits = sum(1 for w in terms if w in title)
    a_hits = sum(1 for w in terms if w in abstract)
    n = len(terms)
    return min(1.0, 0.7 * (t_hits / n) + 0.3 * (a_hits / n))


# 非研究型条目(更正/勘误/撤稿声明/评论/回复等)对"找选题/综述"是噪声, 检索阶段剔除。
_NOISE_TITLE = re.compile(
    r"^\s*(?:erratum|corrigendum|correction|author correction|publisher correction|"
    r"retraction(?: note| of)?|withdrawn|comment on|reply to|response to|"
    r"editorial|in this issue|book review|correspondence)\b",
    re.IGNORECASE,
)


def _is_noise(p: dict) -> bool:
    return bool(_NOISE_TITLE.match(p.get("title") or ""))


def _rank_papers(papers: list[dict], terms: set[str] | None = None) -> list[dict]:
    """对合并后的候选池排序选篇: 相关性(0.5) + 被引热度(0.3) + 新近(0.2) 加权。

    - 相关性: 各源返回顺序里的最佳位置 _pos(位置相关) 与 主题词词面命中(词面相关) 的混合,
      这样跨源合并后仍能把"真正切题"的文献顶到前面, 抑制偶然靠前的离题命中。
    - 被引: log1p(cited_by_count) 归一（仅 OpenAlex 提供, 其它源 0）。
    - 新近: 近 15 年内线性加权, 越新越高（找选题/找空白对新工作更敏感）。
    被引数只作"热度信号"参与排序, 不当精确学术指标对外展示。
    """
    cur_year = datetime.date.today().year
    terms = terms or set()

    def score(p: dict) -> float:
        rel_pos = 1.0 / (1.0 + p.get("_pos", 999))
        rel = 0.6 * rel_pos + 0.4 * _lexical_rel(p, terms) if terms else rel_pos
        cited = p.get("cited_by_count", 0) or 0
        cite = min(1.0, math.log1p(cited) / math.log1p(1000))
        try:
            yr = int(p.get("year", "") or 0)
        except (ValueError, TypeError):
            yr = 0
        recency = 0.0
        if yr:
            recency = max(0.0, min(1.0, (yr - (cur_year - 15)) / 15.0))
        return 0.5 * rel + 0.3 * cite + 0.2 * recency

    return sorted(papers, key=score, reverse=True)


def _merge_all(source_lists: list[list[dict]], cap: int, terms: set[str] | None = None) -> list[dict]:
    """合并多源候选(pmid/doi/title 三键去重), 去噪后排序选篇取前 cap。

    source_lists 顺序即"保留优先级": 第一个里先出现的版本胜出(PubMed 在前→链接走 PubMed)。
    合并时: 被引数取 max、缺失摘要用其它源补、缺 pmid/doi 也互补。
    terms 给定时参与词面相关性排序; 更正/勘误/撤稿声明/评论等非研究条目在此剔除。
    """
    merged: dict[str, dict] = {}
    # 反向索引: pmid / doi / title_key → primary key. 三层保证同篇文献不会因不同源提供
    # 不同 id 组合 (PubMed 只 pmid + OpenAlex 只 doi + 两者都掉 id 只剩标题) 而重复入池.
    by_pmid: dict[str, str] = {}
    by_doi: dict[str, str] = {}
    by_title: dict[str, str] = {}
    for papers in source_lists:
        for pos, p in enumerate(papers):
            if _is_noise(p):
                continue
            pmid = str(p.get("pmid") or "").strip() or None
            doi = str(p.get("doi") or "").strip().lower() or None
            title_key = _title_key(p.get("title", ""))
            # 查询是否已存在 (按 pmid → doi → title_key 依次找)
            existing_key = None
            if pmid and pmid in by_pmid:
                existing_key = by_pmid[pmid]
            elif doi and doi in by_doi:
                existing_key = by_doi[doi]
            elif title_key and title_key in by_title:
                existing_key = by_title[title_key]
            if existing_key is None:
                # 新条目; primary key 优先 doi > pmid > title
                key = doi or pmid or title_key
                if not key:
                    continue
                if key in merged:
                    existing_key = key
                else:
                    q = dict(p)
                    q["_pos"] = pos
                    q.setdefault("cited_by_count", 0)
                    merged[key] = q
                    if pmid: by_pmid[pmid] = key
                    if doi: by_doi[doi] = key
                    if title_key: by_title[title_key] = key
                    continue
            cur = merged[existing_key]
            cur["_pos"] = min(cur["_pos"], pos)
            cur["cited_by_count"] = max(
                cur.get("cited_by_count", 0) or 0, p.get("cited_by_count", 0) or 0
            )
            if not cur.get("abstract") and p.get("abstract"):
                cur["abstract"] = p["abstract"]
            if not cur.get("pmid") and pmid:
                cur["pmid"] = pmid
                cur["url"] = p["url"]
                cur["source"] = p["source"]  # PubMed 后到时纠正 preprint 标签
                by_pmid[pmid] = existing_key
            if not cur.get("doi") and doi:
                cur["doi"] = doi
                by_doi[doi] = existing_key
            if title_key and title_key not in by_title:
                by_title[title_key] = existing_key
            if not cur.get("issn") and p.get("issn"):
                cur["issn"] = p["issn"]
    ranked = _rank_papers(list(merged.values()), terms)
    for p in ranked:
        p.pop("_pos", None)
    return ranked[:cap]


_PAPER_SOURCES = ("pubmed", "europepmc", "openalex", "crossref")

# 论文源 → 展示名(前端"连不上某外网源"告警用)。
SOURCE_LABELS = {"pubmed": "PubMed", "europepmc": "Europe PMC", "openalex": "OpenAlex", "crossref": "Crossref"}


def failed_sources_warning(failed: list[str] | None) -> str | None:
    """把 search_literature 的 failed_sources 列表转成一句用户可见告警; 空则 None。

    failed 可直接传 res.get("failed_sources"), 也可传上层聚合(如多子方向取交集)后的源清单。
    """
    if not failed:
        return None
    names = "、".join(SOURCE_LABELS.get(s, s) for s in failed)
    return f"以下文献源连接失败：{names}，检索结果可能不完整（请检查网络或代理设置）。"


def source_failure_event(
    failed: list[str] | None,
    *,
    queries: list[str],
    filters: dict | None = None,
    per_query: int = 6,
    cap: int = 18,
    field: str = "",
) -> dict | None:
    """构造 source-failure 的 warning 事件 data: 人话 message + 结构化 retry 上下文。

    前端据 retry 上下文渲染"重试失败源"按钮(POST /api/literature/retry): 只对失败的源
    单独重跑检索(源集合不同→绕过缓存→真正走网络), 再把结果并入现有文献列表。
    空失败清单 → None。
    """
    msg = failed_sources_warning(failed)
    if not msg:
        return None
    # 只保留论文源(ClinicalTrials 走旁路, 不参与逐源重试)。
    retry_sources = [s for s in (failed or []) if s in _PAPER_SOURCES]
    return {
        "message": msg,
        "kind": "source_failure",
        "failed_sources": retry_sources,
        "retry": {
            "queries": list(queries or []),
            "filters": filters or {},
            "per_query": per_query,
            "cap": cap,
            "field": field or "",
        },
    }


async def search_literature(
    queries: list[str],
    per_query: int = 6,
    cap: int = 18,
    sources: list[str] | None = None,
    filters: dict | None = None,
) -> dict:
    """并发检索所选论文源(PubMed/Europe PMC/OpenAlex/Crossref), 合并去重 + 排序选篇。

    返回 {"papers", "network_errors", "queries_tried"}。
    - sources: 要启用的论文源子集; None 或空 → 论文源全开。ClinicalTrials 不在此(走旁路)。
    - sources 含 "unpaywall" 时, 合并后用 Unpaywall 给带 DOI 的文献补 oa_url(OA 全文链接)。
    - filters: {year_from, study_types} 年份/证据等级过滤(各源按各自语法落地)。
    - 各源各自召回至多 cap 篇 → 合并去重得到更大候选池 → 按 相关性+被引+新近 排序 → 取前 cap。
    - network_errors 仅在所选源全部失败时为非零(用于区分『检索式太窄』和『全网连不上』)。
    每篇 paper 带 source: "pubmed"/"preprint"/"europepmc"/"openalex"/"crossref"; 部分源额外带 cited_by_count。
    """
    enabled = [s for s in _PAPER_SOURCES if (not sources or s in sources)]
    if not enabled:  # 防御: 一个论文源都没选 → 退回全开, 否则综述无文献可依
        enabled = list(_PAPER_SOURCES)
    want_oa = (sources is None) or ("unpaywall" in sources)
    f = searchfilters.normalize(filters)

    cache_key = (
        "lit", tuple(queries), per_query, cap, tuple(enabled),
        f["year_from"], tuple(f["study_types"]), want_oa,
        f["min_quartile"], f["min_impact"], f["keep_unknown"],
    )
    cached = searchcache.get(cache_key)
    if cached is not None:
        return cached

    share = max(2, per_query)
    runners = {
        "pubmed": lambda: _search_pubmed(queries, share, cap, f),
        "europepmc": lambda: search_epmc(queries, share, cap, f),
        "openalex": lambda: search_openalex(queries, share, cap, f),
        "crossref": lambda: search_crossref(queries, share, cap, f),
    }
    results = await asyncio.gather(
        *(runners[s]() for s in enabled), return_exceptions=True
    )
    # 保持 PubMed→EuropePMC→OpenAlex 的合并优先级顺序
    by_source: dict[str, dict] = {}
    for s, res in zip(enabled, results):
        by_source[s] = {"papers": [], "network_errors": max(1, len(queries))} if isinstance(res, Exception) else res
    ordered = [by_source[s] for s in _PAPER_SOURCES if s in by_source]
    merged = _merge_all([r["papers"] for r in ordered], cap, _query_terms(queries))
    all_fail = all(r["network_errors"] >= max(1, len(queries)) for r in ordered)
    if not all_fail:  # 只对最终入选的 cap 篇做富集; 影响力与 OA 并发, 各自失败静默
        jobs = [enrich_impact(merged)]
        if want_oa:
            jobs.append(enrich_oa(merged))
        try:
            await asyncio.gather(*jobs, return_exceptions=True)
        except Exception:  # noqa: BLE001
            pass
        annotate_quartile(merged)  # 本地查表(Scimago 医学分区), 同步且零网络
    # 质量预筛(喂给 AI 前): 富集分区/影响力之后才能判定; 命中太少自动放宽。
    q_dropped, q_relaxed = 0, False
    if not all_fail:
        merged, q_dropped, q_relaxed = searchfilters.apply_quality_filter(merged, f)
    net_errs = sum(r["network_errors"] for r in ordered)
    # 逐源"连不上"清单: 某源的全部检索式都失败(或整源抛错)时算不可达。
    # 与 network_errors(仅全网皆败时非零)不同, 单个源挂掉也会出现在这里, 供前端逐源提示。
    threshold = max(1, len(queries))
    failed_sources = [s for s in _PAPER_SOURCES if s in by_source and by_source[s]["network_errors"] >= threshold]
    out = {
        "papers": merged,
        # 上游用 network_errors >= len(queries) 判断网络故障; 只要任一源能通就不算网络全败。
        "network_errors": net_errs if all_fail else 0,
        "failed_sources": failed_sources,
        "queries_tried": list(queries),
        "quality": {
            "active": searchfilters.quality_active(f),
            "dropped": q_dropped, "relaxed": q_relaxed, "kept": len(merged),
        },
    }
    if not all_fail:  # 不缓存"全失败"(可能只是一次偶发网络故障)
        searchcache.put(cache_key, out)
    return out


# ---------------------------------------------------------------------------
# Abstract-by-id fallback: for imported refs lacking abstract (Zotero/RefIO).
# Order: PubMed -> Europe PMC -> OpenAlex. Any client raising -> next.
# ---------------------------------------------------------------------------
async def _fetch_abstract_pubmed(pmid: str | None) -> str | None:
    """Fetch a single abstract from PubMed efetch given a PMID."""
    if not pmid:
        return None
    await _throttle()
    params = _common_params() | {"db": "pubmed", "id": str(pmid), "rettype": "abstract", "retmode": "xml"}
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(f"{_BASE}/efetch.fcgi", params=params)
        r.raise_for_status()
        try:
            root = ET.fromstring(r.text)
        except ET.ParseError:
            return None
        parts: list[str] = []
        for node in root.iter("AbstractText"):
            txt = "".join(node.itertext()).strip()
            if txt:
                parts.append(txt)
        return " ".join(parts) if parts else None


async def _fetch_abstract_epmc(doi: str | None, pmid: str | None) -> str | None:
    """Fetch abstract from Europe PMC search API by DOI or PMID."""
    query = None
    if doi:
        query = f'DOI:"{doi}"'
    elif pmid:
        query = f"EXT_ID:{pmid} AND SRC:MED"
    if not query:
        return None
    url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
    params = {"query": query, "format": "json", "resultType": "core", "pageSize": 1}
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(url, params=params)
        r.raise_for_status()
        data = r.json()
    results = ((data or {}).get("resultList") or {}).get("result") or []
    if not results:
        return None
    abstract = (results[0].get("abstractText") or "").strip()
    return abstract or None


async def _fetch_abstract_openalex(doi: str | None) -> str | None:
    """Fetch abstract from OpenAlex works API by DOI. Reconstruct from inverted index."""
    if not doi:
        return None
    url = f"https://api.openalex.org/works/https://doi.org/{doi}"
    async with httpx.AsyncClient(timeout=20) as cli:
        r = await cli.get(url)
        r.raise_for_status()
        data = r.json() or {}
    idx = data.get("abstract_inverted_index") or {}
    if not idx:
        return None
    positions: list[tuple[int, str]] = []
    for word, poss in idx.items():
        for p in poss or []:
            positions.append((int(p), word))
    positions.sort(key=lambda x: x[0])
    text = " ".join(w for _, w in positions).strip()
    return text or None


async def fetch_abstract_by_id(doi: str | None, pmid: str | None) -> str | None:
    """Try PubMed -> Europe PMC -> OpenAlex in order. Return abstract or None."""
    if not doi and not pmid:
        return None
    for fetcher in (
        lambda: _fetch_abstract_pubmed(pmid),
        lambda: _fetch_abstract_epmc(doi, pmid),
        lambda: _fetch_abstract_openalex(doi),
    ):
        try:
            got = await fetcher()
        except Exception:  # noqa: BLE001
            continue
        if got:
            return got.strip()
    return None
