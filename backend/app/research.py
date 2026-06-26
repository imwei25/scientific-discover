"""医学/药学/生物领域的“找选题”深度调研流程。

类似 deep-research:
  1) 用 LLM 把用户主题转成 PubMed 英文检索式;
  2) 实际检索 PubMed, 抓取真实文献(标题/作者/年份/摘要/链接);
  3) 让 LLM 基于这些真实文献梳理“研究现状 / 研究空白 / 候选选题”,
     引用必须用可点击的 Markdown 链接, 严禁编造文献。

对外是一个异步生成器, 逐步 yield (event, data):
  ("status", {"message": ...})      进度提示
  ("references", {"items": [...]})  检索到的文献列表(供前端渲染链接)
  ("delta", {"text": ...})          综述/选题正文流式片段
  ("error", {"message": ...})
"""
from __future__ import annotations

import json
import re
from typing import AsyncIterator

from .config import settings
from .literature import search_literature
from .llm import stream_chat


async def _complete(messages: list[dict], max_tokens: int = 300) -> str:
    """非流式: 累积一次完整回复。"""
    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


async def _gen_queries(field: str, keywords: str, background: str) -> list[str]:
    # 背景可能包含整篇附加文档, 仅取前 500 字用于生成检索式, 控制成本。
    bg = background[:500]
    topic = field + (f"；关键词：{keywords}" if keywords else "") + (f"；背景：{bg}" if bg else "")
    system = (
        "你是医学/生物医学文献检索专家。把用户的研究主题转化为 3 个适合在 PubMed 检索的英文检索式，"
        "可使用布尔逻辑(AND/OR)与必要的 MeSH 术语，覆盖该主题的不同侧面。"
        "只输出一个 JSON 字符串数组，不要任何解释。例如：[\"...\", \"...\", \"...\"]"
    )
    try:
        raw = await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": topic}],
            max_tokens=300,
        )
        start, end = raw.find("["), raw.rfind("]")
        if start != -1 and end != -1:
            arr = json.loads(raw[start : end + 1])
            qs = [str(q).strip() for q in arr if str(q).strip()]
            if qs:
                return qs[:3]
    except Exception:  # noqa: BLE001
        pass
    # 兜底: 直接用原始主题
    base = field
    if keywords:
        base += " AND (" + " OR ".join(k.strip() for k in keywords.split(",") if k.strip()) + ")"
    return [base]


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception:  # noqa: BLE001
        return None


async def _gen_facets(field: str, keywords: str, background: str) -> list[dict]:
    """把研究方向拆成 4-5 个互补子方向, 每个配一个 PubMed 检索式。"""
    bg = background[:500]
    topic = field + (f"；关键词：{keywords}" if keywords else "") + (f"；背景：{bg}" if bg else "")
    system = (
        "你是医学/生物医学文献检索专家。把用户的研究方向拆解为 4-5 个互补的子方向"
        "（例如：发病机制、临床疗效/结局、生物标志物/诊断、耐药与安全性、方法学等，依主题而定），"
        "每个子方向配一个适合 PubMed 的英文检索式（可用 AND/OR 与 MeSH）。"
        "只输出 JSON 数组，每项形如 {\"name\":\"子方向中文名\",\"query\":\"PubMed 检索式\"}，不要任何解释。"
    )
    arr = _parse_json(
        await _complete([{"role": "system", "content": system}, {"role": "user", "content": topic}], max_tokens=600),
        "[", "]",
    )
    facets = []
    if isinstance(arr, list):
        for it in arr:
            if isinstance(it, dict) and it.get("query"):
                facets.append({"name": str(it.get("name") or "子方向"), "query": str(it["query"]).strip()})
    if facets:
        return facets[:5]
    # 兜底: 退回到普通多检索式
    qs = await _gen_queries(field, keywords, background)
    return [{"name": f"方向{i + 1}", "query": q} for i, q in enumerate(qs)]


async def _gap_queries(field: str, papers: list[dict]) -> list[str]:
    """基于首轮文献标题, 找出值得补充检索的 2-3 个角度。"""
    titles = "\n".join(f"- {p['title']}" for p in papers[:20])
    system = (
        "你是医学科研选题专家。下面是某研究方向已检索到的文献标题。"
        "请找出该方向下【尚未被充分覆盖、值得补充检索】的 2-3 个具体角度，"
        "每个角度给一个适合 PubMed 的英文检索式。只输出 JSON 字符串数组，不要解释。"
    )
    user = f"研究方向：{field}\n\n已有文献标题：\n{titles}"
    arr = _parse_json(
        await _complete([{"role": "system", "content": system}, {"role": "user", "content": user}], max_tokens=400),
        "[", "]",
    )
    if isinstance(arr, list):
        return [str(q).strip() for q in arr if str(q).strip()][:3]
    return []


def _merge_papers(base: list[dict], extra: list[dict], cap: int) -> list[dict]:
    seen = {p["pmid"] for p in base}
    out = list(base)
    for p in extra:
        if p["pmid"] not in seen:
            seen.add(p["pmid"])
            out.append(p)
        if len(out) >= cap:
            break
    return out


def _build_context(papers: list[dict]) -> str:
    lines = []
    for i, p in enumerate(papers, 1):
        abstract = (p["abstract"] or "")[:1200]
        lines.append(
            f"[{i}] {p['first_author']} ({p['year']}). {p['title']} "
            f"{p['journal']}. URL: {p['url']}\n摘要: {abstract or '（无摘要）'}"
        )
    return "\n\n".join(lines)


def _synthesis_messages(field: str, papers: list[dict]) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学科研选题顾问。下面提供的是从 PubMed 检索到的【真实文献】。"
        "请严格基于这些文献完成分析，分三部分：\n"
        "## 一、研究现状\n综述该方向已有的代表性工作。每次引用某篇文献时，"
        "必须使用 Markdown 超链接，格式为 [第一作者 et al., 年份](文献URL)，URL 用文献给出的真实 URL。\n"
        "## 二、研究空白\n基于现状，指出尚未充分解决或较少被研究的问题、争议点或方法学局限。\n"
        "## 三、候选选题\n提出 3-5 个有文献支撑、有创新性且可行的研究课题。"
        "每个课题包含：拟解决的科学问题、创新点、可行性、以及与之相关的文献链接。\n\n"
        "铁律：只能引用下面列出的文献及其真实 URL，严禁编造任何文献、作者或链接；"
        "若现有文献不足以支撑某结论，请明确指出‘现有检索结果有限’。"
    )
    context = _build_context(papers)
    user = f"研究方向：{field}\n\n【检索到的真实文献】\n{context}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _synthesis_messages_deep(field: str, papers: list[dict]) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学科研选题顾问。下面是经【多角度+空白补充】两轮检索得到的真实文献。"
        "请做一份有深度的调研报告，分四部分：\n"
        "## 一、研究现状（按子方向组织）\n按几个子方向分别综述代表性进展，引用必须用 Markdown 链接"
        " [第一作者 et al., 年份](真实URL)。\n"
        "## 二、研究空白矩阵\n用表格或分点，对比『已被充分研究 / 证据不足或有争议 / 几乎空白』三类，"
        "明确指出最值得切入的空白。\n"
        "## 三、候选选题（3-5 个，按推荐度排序）\n每个含：拟解决的科学问题、创新点、"
        "可行性（设计/样本/方法）、**新颖性说明（对照本次检索结果，指出是否已有相近工作、本选题不同在哪）**、"
        "相关文献链接。\n"
        "## 四、首选推荐\n给出你最推荐的一个并说明理由。\n\n"
        "铁律：只能引用下面列出的文献及其真实 URL，严禁编造任何文献、作者或链接；"
        "证据不足时明说‘现有检索结果有限’。"
    )
    context = _build_context(papers)
    user = f"研究方向：{field}\n\n【两轮检索到的真实文献】\n{context}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def _deep_flow(field: str, keywords: str, background: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在把研究方向拆解为多个子方向…"})
    facets = await _gen_facets(field, keywords, background)
    names = "、".join(f["name"] for f in facets)
    yield ("status", {"message": f"正在多角度检索 PubMed（{len(facets)} 个子方向：{names}）…"})
    papers = await search_literature([f["query"] for f in facets], per_query=5, cap=24)
    if not papers:
        yield ("error", {"message": "未能从 PubMed 检索到相关文献，请换更具体的英文关键词。"})
        return
    yield ("references", {"items": [{k: p[k] for k in ("pmid", "title", "first_author", "journal", "year", "url")} for p in papers]})

    yield ("status", {"message": f"首轮找到 {len(papers)} 篇，正在识别空白并补充检索…"})
    gapq = await _gap_queries(field, papers)
    if gapq:
        extra = await search_literature(gapq, per_query=4, cap=12)
        papers = _merge_papers(papers, extra, cap=34)
        yield ("references", {"items": [{k: p[k] for k in ("pmid", "title", "first_author", "journal", "year", "url")} for p in papers]})

    yield ("status", {"message": f"共 {len(papers)} 篇文献，正在综合（现状/空白矩阵/候选选题）…"})
    full = ""
    async for piece in stream_chat(_synthesis_messages_deep(field, papers)):
        full += piece
        yield ("delta", {"text": piece})
    yield ("__verify__", {"papers": papers, "full": full})


async def _mock_flow(field: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在生成检索式…"})
    yield ("status", {"message": "正在检索 PubMed…"})
    items = [
        {
            "pmid": "00000001",
            "title": f"[MOCK] A study related to {field}",
            "first_author": "Smith J",
            "journal": "Mock Journal",
            "year": "2023",
            "url": "https://pubmed.ncbi.nlm.nih.gov/00000001/",
        }
    ]
    yield ("references", {"items": items})
    yield ("status", {"message": "正在分析研究现状与空白…"})
    text = (
        "## 一、研究现状\n已有工作见 [Smith et al., 2023](https://pubmed.ncbi.nlm.nih.gov/00000001/)。\n"
        "## 二、研究空白\n[MOCK] 该方向仍缺乏前瞻性研究。\n"
        "## 三、候选选题\n1. [MOCK] 一个示例选题。"
    )
    for ch in text:
        yield ("delta", {"text": ch})


async def deep_research_idea(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    field = (inputs.get("field") or "").strip()
    keywords = (inputs.get("keywords") or "").strip()
    background = (inputs.get("background") or "").strip()

    if not field:
        yield ("error", {"message": "请填写研究领域/方向。"})
        return

    depth = (inputs.get("depth") or "deep").strip()

    if settings.mock:
        async for ev in _mock_flow(field):
            yield ev
        yield ("verify", {"total": 1, "verified": 1, "unverified": []})
        yield ("done", {})
        return

    try:
        papers: list[dict] = []
        full = ""

        if depth == "deep":
            async for event, data in _deep_flow(field, keywords, background):
                if event == "__verify__":
                    papers, full = data["papers"], data["full"]
                else:
                    yield (event, data)
                    if event == "error":
                        return
        else:
            yield ("status", {"message": "正在生成 PubMed 检索式…"})
            queries = await _gen_queries(field, keywords, background)
            yield ("status", {"message": f"正在检索 PubMed（{len(queries)} 个检索式）…"})
            papers = await search_literature(queries, per_query=6, cap=18)
            if not papers:
                yield ("error", {"message": "未能从 PubMed 检索到相关文献，请尝试更换或细化关键词（建议用英文）。"})
                return
            yield ("references", {"items": [
                {k: p[k] for k in ("pmid", "title", "first_author", "journal", "year", "url")} for p in papers
            ]})
            yield ("status", {"message": f"已找到 {len(papers)} 篇文献，正在分析研究现状与空白…"})
            async for piece in stream_chat(_synthesis_messages(field, papers)):
                full += piece
                yield ("delta", {"text": piece})

        if not papers:
            return

        # 引用自动核验: 正文里引用的每个 PubMed 链接, 必须来自本次检索到的文献。
        valid = {p["pmid"] for p in papers}
        cited = set(re.findall(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", full))
        unverified = sorted(cited - valid)
        yield ("verify", {
            "total": len(cited),
            "verified": len(cited & valid),
            "unverified": unverified,
        })
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"调研过程出错：{e}"})
