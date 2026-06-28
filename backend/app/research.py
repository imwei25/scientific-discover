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

import asyncio
import json
import re
import traceback
from typing import AsyncIterator

from . import searchfilters
from .clinicaltrials import search_trials
from .config import settings
from .literature import search_literature
from .llm import stream_chat

_ALL_SOURCES = ["pubmed", "europepmc", "openalex", "clinicaltrials"]


def _parse_sources(raw) -> list[str]:
    """把前端传入的 sources(列表或逗号串)规整为合法源 key 列表; 缺省=全开。"""
    if isinstance(raw, str):
        items = [s.strip() for s in raw.split(",")]
    elif isinstance(raw, list):
        items = [str(s).strip() for s in raw]
    else:
        return list(_ALL_SOURCES)
    items = [s for s in items if s in _ALL_SOURCES]
    return items or list(_ALL_SOURCES)


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
        "若用户输入为中文，先把疾病/药物/方法等关键概念翻译为规范英文医学术语(优先 MeSH 词)，再构造检索式。"
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
        "若用户输入为中文，先把关键概念翻译为规范英文医学术语(优先 MeSH 词)再构造检索式。"
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


async def _suggest_rewrite(
    field: str, keywords: str, background: str, tried_queries: list[str]
) -> dict | None:
    """零命中时, 让 LLM 基于『原输入 + 实际跑过的 PubMed 检索式』给出改写建议。

    返回 {"field": ..., "keywords": ..., "reason": ...} 或 None。
    """
    bg = background[:500]
    tried = "\n".join(f"- {q}" for q in tried_queries) or "（无）"
    system = (
        "你是医学/生物医学文献检索专家。用户在 PubMed 上的检索零命中。"
        "请基于用户的原始研究方向以及实际尝试过但都零命中的检索式，"
        "推断一个更可能命中真实文献的『研究方向 (field)』和『英文关键词 (keywords)』。"
        "要求：field 用简洁中文重述方向（避免过窄的限定），"
        "keywords 用 2-4 个英文术语，逗号分隔，优先使用 PubMed/MeSH 常用词；"
        "reason 用一句中文说明为何这样改更可能命中（如：原检索过窄/含中文/术语不规范等）。"
        "只输出一个 JSON 对象：{\"field\":\"...\",\"keywords\":\"...\",\"reason\":\"...\"}，不要任何解释。"
    )
    user = (
        f"用户原始 field：{field}\n"
        f"用户原始 keywords：{keywords or '（空）'}\n"
        f"用户背景（截断）：{bg or '（空）'}\n\n"
        f"实际跑过且零命中的 PubMed 检索式：\n{tried}"
    )
    raw = await _complete(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=300,
    )
    obj = _parse_json(raw, "{", "}")
    if not isinstance(obj, dict):
        return None
    f = str(obj.get("field") or "").strip()
    k = str(obj.get("keywords") or "").strip()
    r = str(obj.get("reason") or "").strip()
    if not f and not k:
        return None
    return {"field": f or field, "keywords": k, "reason": r}


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
    """按 pmid / doi / url 去重合并（兼容无 pmid 的预印本）。"""
    out = list(base)
    keys: set[str] = set()
    for p in base:
        for k in (p.get("pmid"), p.get("doi"), p.get("url")):
            if k:
                keys.add(k)
    for p in extra:
        ids = [k for k in (p.get("pmid"), p.get("doi"), p.get("url")) if k]
        if any(k in keys for k in ids):
            continue
        out.append(p)
        for k in ids:
            keys.add(k)
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


async def _extract_batch(items: list[tuple[int, dict]]) -> dict[int, dict]:
    """把一批文献(摘要)抽成结构化要点行, 返回 {全局编号: row}。

    每行字段: pop(对象/人群) / design(研究类型/方法) / finding(主要发现含关键数据) / gap(局限或未解决)。
    这是 deep-research 常见的"结构化证据表"降本范式: 把 1200 字摘要压成 ~150 字要点,
    既能把上下文成本降 5-8 倍(可安全纳入更多文献), 结构化输入也更抗"中段被忽略"、更难编造。
    """
    parts = []
    for idx, p in items:
        ab = (p.get("abstract") or "")[:1000]
        parts.append(f"[{idx}] {p.get('title', '')}\n摘要: {ab or '（无摘要）'}")
    system = (
        "你是医学文献信息抽取助手。下面给出若干篇文献的编号、标题与摘要。"
        "请为每篇抽取结构化要点，字段用简洁中文（每字段不超过 40 字，信息缺失填空字符串，严禁编造）。"
        "只输出 JSON 数组，每项形如 "
        "{\"i\":编号,\"pop\":\"研究对象/人群\",\"design\":\"研究类型/方法\","
        "\"finding\":\"主要发现(含关键数据/效应量)\",\"gap\":\"局限或未解决的问题\"}，不要任何解释。"
    )
    user = "\n\n".join(parts)
    arr = _parse_json(
        await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=1400,
        ),
        "[", "]",
    )
    out: dict[int, dict] = {}
    if isinstance(arr, list):
        for it in arr:
            if isinstance(it, dict) and it.get("i") is not None:
                try:
                    out[int(it["i"])] = it
                except (ValueError, TypeError):
                    continue
    return out


async def _extract_evidence(papers: list[dict], batch: int = 12) -> dict[int, dict]:
    """对全部纳入文献并发抽取结构化证据行, 返回 {全局编号(1-based): row}。"""
    indexed = list(enumerate(papers, 1))
    batches = [indexed[i : i + batch] for i in range(0, len(indexed), batch)]
    results = await asyncio.gather(
        *[_extract_batch(b) for b in batches], return_exceptions=True
    )
    evidence: dict[int, dict] = {}
    for res in results:
        if isinstance(res, dict):
            evidence.update(res)
    return evidence


def _evidence_line(gi: int, p: dict, row: dict | None) -> str:
    head = (
        f"[{gi}] {p['first_author']} ({p['year']}). {p['title']} "
        f"{p['journal']}. URL: {p['url']}"
    )
    if row:
        body = (
            f"对象: {row.get('pop') or '—'} | 设计: {row.get('design') or '—'} | "
            f"发现: {row.get('finding') or '—'} | 局限: {row.get('gap') or '—'}"
        )
    else:
        ab = (p.get("abstract") or "")[:400]
        body = f"摘要: {ab or '（无摘要）'}"
    return head + "\n" + body


def _build_context_table(papers: list[dict], evidence: dict[int, dict]) -> str:
    """用结构化证据行构建综述上下文; 抽取缺失的文献回退到短摘要(400 字)。"""
    return "\n\n".join(_evidence_line(i, p, evidence.get(i)) for i, p in enumerate(papers, 1))


def _evidence_items(papers: list[dict], evidence: dict[int, dict]) -> list[dict]:
    """合并文献元数据 + 抽取要点, 供前端展示/导出证据表(A4)。"""
    out = []
    for i, p in enumerate(papers, 1):
        row = evidence.get(i) or {}
        out.append({
            "index": i,
            "first_author": p.get("first_author", ""),
            "year": p.get("year", ""),
            "title": p.get("title", ""),
            "journal": p.get("journal", ""),
            "url": p.get("url", ""),
            "source": p.get("source", ""),
            "cited_by_count": p.get("cited_by_count", 0),
            "pop": row.get("pop", ""),
            "design": row.get("design", ""),
            "finding": row.get("finding", ""),
            "gap": row.get("gap", ""),
        })
    return out


def _trials_note(trials: list[dict]) -> str:
    """把在研试验压成简短列表, 供综述判断研究空白(B7)。"""
    if not trials:
        return ""
    lines = []
    for t in trials[:10]:
        ph = f"/{t['phase']}" if t.get("phase") else ""
        lines.append(f"- {t.get('title', '')}（{t.get('status', '')}{ph}，{t.get('nct_id', '')}）")
    return "\n".join(lines)


async def _summarize_chunk(field: str, context: str, facet_name: str | None = None) -> str:
    """Map 步: 把一批文献概括成研究现状要点(保留真实引用链接)。facet_name 给定时按该子方向归纳。"""
    scope = f"『{facet_name}』这一子方向" if facet_name else "这批文献"
    system = (
        f"你是医学科研综述助手。下面是某研究方向中{scope}的真实文献(结构化要点)。"
        f"请用 150-280 字概括{scope}的研究现状要点, 保留最关键的发现与方法、并指出该子方向尚存的争议或空白; "
        "引用时用 Markdown 链接 [第一作者 et al., 年份](URL)，URL 必须用所给真实 URL。"
        "只输出概括段落, 不要逐篇罗列, 不要编造未给出的文献。"
    )
    user = f"研究方向：{field}\n\n【文献】\n{context}"
    return await _complete(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=520,
    )


def _group_context(group: list[dict], evidence: dict[int, dict], index_of: dict[int, int]) -> str:
    return "\n\n".join(
        _evidence_line(index_of[id(p)], p, evidence.get(index_of[id(p)])) for p in group
    )


async def _map_summaries_by_facet(
    field: str,
    groups: list[tuple[str, list[dict]]],
    evidence: dict[int, dict],
    index_of: dict[int, int],
) -> list[tuple[str, str]]:
    """按子方向并发归纳现状小结(Map-Reduce 的 Map, 分组=子方向)。返回 [(子方向名, 小结)]。"""
    async def one(name: str, group: list[dict]):
        if not group:
            return None
        s = await _summarize_chunk(field, _group_context(group, evidence, index_of), facet_name=name)
        return (name, s) if s and s.strip() else None

    results = await asyncio.gather(*[one(n, g) for n, g in groups], return_exceptions=True)
    return [r for r in results if isinstance(r, tuple)]


def _reduce_messages_deep(field: str, summaries: list[tuple[str, str]], trials_note: str) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学科研选题顾问。下面是按【子方向】分别归纳出的研究现状小结"
        "（每段已含真实文献的 Markdown 链接）。请据此综合成一份有深度的调研报告，分四部分：\n"
        "## 一、研究现状（按子方向组织）\n沿用下面给出的子方向，逐个综述代表性进展，引用沿用小结中的"
        " [第一作者 et al., 年份](真实URL) 链接。\n"
        "## 二、研究空白矩阵\n用 Markdown 表格对比『已被充分研究 / 证据不足或有争议 / 几乎空白』三类，"
        "可结合各子方向，明确指出最值得切入的空白。\n"
        "## 三、候选选题（3-5 个，按推荐度排序）\n"
        "每个选题用 `### 候选选题N：一句话题名` 作小标题，下面分点给出：\n"
        "- 拟解决的科学问题；- 创新点；- 可行性（设计/样本/方法）；"
        "- **新颖性说明（对照检索结果，指出是否已有相近工作、本选题不同在哪）**；- 相关文献链接；\n"
        "- **自评分（帮助非专业读者快速判断）**：单列一行，格式严格为 "
        "`> 可行性 ★N/5（一句话理由）｜创新性 ★N/5（一句话理由）`，N 为 1-5 整数，"
        "理由要基于上文证据与子方向空白，不要套话。\n"
        "## 四、首选推荐\n给出你最推荐的一个并说明理由（可结合上面的自评分）。\n\n"
        "铁律：只能引用上面小结中出现过的文献链接，严禁编造任何文献、作者或链接；证据不足时明说‘现有检索结果有限’。"
    )
    joined = "\n\n".join(f"【子方向：{name}】\n{s}" for name, s in summaries)
    extra = ""
    if trials_note:
        extra = (
            "\n\n【相关在研临床试验（ClinicalTrials.gov，仅供判断研究空白）】\n" + trials_note +
            "\n注意：在『研究空白矩阵』里参考这些在研试验判断哪些方向已有团队布局、哪些仍空白；"
            "但它们是注册试验、非已发表文献，不要作为文献引用。"
        )
    user = f"研究方向：{field}\n\n{joined}{extra}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _synthesis_messages(field: str, papers: list[dict]) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学科研选题顾问。下面提供的是从 PubMed 检索到的【真实文献】。"
        "请严格基于这些文献完成分析，分三部分：\n"
        "## 一、研究现状\n综述该方向已有的代表性工作。每次引用某篇文献时，"
        "必须使用 Markdown 超链接，格式为 [第一作者 et al., 年份](文献URL)，URL 用文献给出的真实 URL。\n"
        "## 二、研究空白\n基于现状，指出尚未充分解决或较少被研究的问题、争议点或方法学局限。\n"
        "## 三、候选选题\n提出 3-5 个有文献支撑、有创新性且可行的研究课题。"
        "每个课题用 `### 候选选题N：一句话题名` 作小标题，分点给出：拟解决的科学问题、创新点、可行性、相关文献链接，"
        "并单列一行自评分，格式严格为 `> 可行性 ★N/5（一句话理由）｜创新性 ★N/5（一句话理由）`（N 为 1-5 整数，理由基于检索证据）。\n\n"
        "铁律：只能引用下面列出的文献及其真实 URL，严禁编造任何文献、作者或链接；"
        "若现有文献不足以支撑某结论，请明确指出‘现有检索结果有限’。"
    )
    context = _build_context(papers)
    user = f"研究方向：{field}\n\n【检索到的真实文献】\n{context}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _synthesis_messages_deep(field: str, papers: list[dict], context: str | None = None) -> list[dict]:
    system = (
        "你是资深的医学/药学/生物医学科研选题顾问。下面是经【多角度+空白补充】两轮检索得到的真实文献。"
        "请做一份有深度的调研报告，分四部分：\n"
        "## 一、研究现状（按子方向组织）\n按几个子方向分别综述代表性进展，引用必须用 Markdown 链接"
        " [第一作者 et al., 年份](真实URL)。\n"
        "## 二、研究空白矩阵\n用表格或分点，对比『已被充分研究 / 证据不足或有争议 / 几乎空白』三类，"
        "明确指出最值得切入的空白。\n"
        "## 三、候选选题（3-5 个，按推荐度排序）\n"
        "每个选题用 `### 候选选题N：一句话题名` 作小标题，分点给出：拟解决的科学问题、创新点、"
        "可行性（设计/样本/方法）、**新颖性说明（对照本次检索结果，指出是否已有相近工作、本选题不同在哪）**、"
        "相关文献链接，并单列一行自评分，格式严格为 "
        "`> 可行性 ★N/5（一句话理由）｜创新性 ★N/5（一句话理由）`（N 为 1-5 整数，理由基于检索证据与空白）。\n"
        "## 四、首选推荐\n给出你最推荐的一个并说明理由（可结合自评分）。\n\n"
        "铁律：只能引用下面列出的文献及其真实 URL，严禁编造任何文献、作者或链接；"
        "证据不足时明说‘现有检索结果有限’。\n"
        "注意：下面每篇文献已抽取为『对象/设计/发现/局限』要点行，请据此综合；"
        "引用编号与 URL 必须与所给文献一致。"
    )
    ctx = context if context is not None else _build_context(papers)
    user = f"研究方向：{field}\n\n【两轮检索到的真实文献（结构化要点）】\n{ctx}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _src_label(sources: list[str]) -> str:
    names = {"pubmed": "PubMed", "europepmc": "Europe PMC", "openalex": "OpenAlex"}
    enabled = [names[s] for s in ("pubmed", "europepmc", "openalex") if s in sources]
    return " / ".join(enabled) if enabled else "PubMed"


async def _emit_trials(queries: list[str], sources: list[str]) -> dict | None:
    """ClinicalTrials.gov 旁路: 若启用则检索在研试验, 返回 trials 事件数据。"""
    if "clinicaltrials" not in sources:
        return None
    res = await search_trials(queries, per_query=5, cap=12)
    return {"items": res.get("trials", [])}


def _pkey(p: dict) -> str:
    return p.get("doi") or p.get("pmid") or p.get("url") or ""


async def _facet_grouped_search(
    facets: list[dict], sources: list[str], filters: dict, per_facet_cap: int = 16
) -> tuple[list[tuple[str, list[dict]]], bool]:
    """并发逐子方向检索, 跨子方向去重(先到先得), 保留子方向归属。

    返回 (groups=[(子方向名, [papers])], any_source_ok)。
    """
    results = await asyncio.gather(
        *[
            search_literature([f["query"]], per_query=10, cap=per_facet_cap, sources=sources, filters=filters)
            for f in facets
        ],
        return_exceptions=True,
    )
    seen: set[str] = set()
    groups: list[tuple[str, list[dict]]] = []
    any_ok = False
    for f, res in zip(facets, results):
        if isinstance(res, Exception):
            continue
        if res.get("network_errors", 0) == 0:
            any_ok = True
        grp: list[dict] = []
        for p in res["papers"]:
            k = _pkey(p)
            if not k or k in seen:
                continue
            seen.add(k)
            grp.append(p)
        groups.append((f["name"], grp))
    return groups, any_ok


async def _deep_flow(
    field: str, keywords: str, background: str, sources: list[str], filters: dict
) -> AsyncIterator[tuple[str, dict]]:
    flt_label = searchfilters.label(filters)
    flt_tip = f"（过滤：{flt_label}）" if flt_label else ""
    yield ("status", {"message": "正在把研究方向拆解为多个子方向…"})
    facets = await _gen_facets(field, keywords, background)
    names = "、".join(f["name"] for f in facets)
    yield ("status", {"message": f"正在按子方向检索 {_src_label(sources)}{flt_tip}（{len(facets)} 个子方向：{names}）…"})

    groups, any_ok = await _facet_grouped_search(facets, sources, filters)
    total = sum(len(g) for _, g in groups)
    if total == 0:
        if not any_ok:
            yield ("error", {"message": "无法连接文献源（网络异常），请检查网络后重试。"})
            return
        yield ("status", {"message": "文献源零命中，正在请 AI 改写检索方向…"})
        sugg = await _suggest_rewrite(field, keywords, background, [f["query"] for f in facets])
        yield ("rewrite_suggestion", {"tried_queries": [f["query"] for f in facets], "suggestion": sugg})
        yield ("error", {"message": "未能从所选文献源检索到相关文献。可采纳上面的 AI 改写建议后重试（或放宽年份/证据等级过滤）。"})
        return

    seen_keys = {_pkey(p) for _, g in groups for p in g}

    def _flatten() -> list[dict]:
        return [p for _, g in groups for p in g]

    papers = _flatten()
    yield ("references", {"items": [{k: p.get(k, "") for k in ("pmid", "title", "first_author", "journal", "year", "url", "source", "cited_by_count")} for p in papers]})

    queries = [f["query"] for f in facets]
    trials = await _emit_trials(queries, sources)
    if trials is not None:
        yield ("trials", trials)
    trial_items = (trials or {}).get("items", [])

    yield ("status", {"message": f"首轮找到 {total} 篇（{len(groups)} 个子方向），正在识别空白并补充检索…"})
    gapq = await _gap_queries(field, papers)
    if gapq:
        extra = await search_literature(gapq, per_query=6, cap=24, sources=sources, filters=filters)
        gap_grp = [p for p in extra["papers"] if _pkey(p) and _pkey(p) not in seen_keys]
        if gap_grp:
            groups.append(("空白补充角度", gap_grp))
            papers = _flatten()
            yield ("references", {"items": [{k: p.get(k, "") for k in ("pmid", "title", "first_author", "journal", "year", "url", "source", "cited_by_count")} for p in papers]})

    # 结构化证据表: 综述前把每篇压成要点行(并发抽取), 既能纳入更多文献又抗"中段被忽略"。
    yield ("status", {"message": f"共 {len(papers)} 篇文献，正在逐篇抽取结构化要点…"})
    evidence = await _extract_evidence(papers)
    index_of = {id(p): i for i, p in enumerate(papers, 1)}
    yield ("evidence", {"items": _evidence_items(papers, evidence)})

    # Map-Reduce(按子方向分组): 每个子方向先各自归纳现状小结, 再汇总成结构化报告。
    yield ("status", {"message": f"已抽取 {len(evidence)}/{len(papers)} 篇要点，正在按子方向归纳现状…"})
    summaries = await _map_summaries_by_facet(field, groups, evidence, index_of)
    if not summaries:  # 兜底: 分批失败则退回整表一次性综述
        summaries = [("全部文献", _build_context_table(papers, evidence))]

    yield ("status", {"message": f"正在汇总 {len(summaries)} 个子方向（现状/空白矩阵/候选选题）…"})
    full = ""
    async for piece in stream_chat(_reduce_messages_deep(field, summaries, _trials_note(trial_items))):
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
            "source": "pubmed",
        },
        {
            "pmid": "",
            "title": f"[MOCK] OpenAlex-indexed work on {field}",
            "first_author": "Doe A",
            "journal": "Mock Open Journal",
            "year": "2024",
            "url": "https://openalex.org/W0000000001",
            "source": "openalex",
        },
    ]
    yield ("references", {"items": items})
    yield ("trials", {"items": [
        {
            "nct_id": "NCT00000000",
            "title": f"[MOCK] A registered trial on {field}",
            "status": "Recruiting",
            "phase": "Phase 3",
            "conditions": field,
            "summary": "[MOCK] 在研试验示例。",
            "year": "2025",
            "url": "https://clinicaltrials.gov/study/NCT00000000",
        }
    ]})
    yield ("evidence", {"items": [
        {"index": 1, "first_author": "Smith J", "year": "2023", "title": f"[MOCK] A study related to {field}",
         "journal": "Mock Journal", "url": "https://pubmed.ncbi.nlm.nih.gov/00000001/", "source": "pubmed",
         "cited_by_count": 12, "pop": "成人患者", "design": "RCT", "finding": "[MOCK] 主要终点改善", "gap": "样本量小"},
    ]})
    yield ("status", {"message": "正在分析研究现状与空白…"})
    text = (
        "## 一、研究现状\n已有工作见 [Smith et al., 2023](https://pubmed.ncbi.nlm.nih.gov/00000001/)。\n"
        "## 二、研究空白矩阵\n\n| 角度 | 证据强度 |\n| --- | --- |\n| 机制 | 充分 |\n| 长期结局 | 空白 |\n\n"
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
    sources = _parse_sources(inputs.get("sources"))
    filters = searchfilters.normalize(inputs.get("filters"))

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
            async for event, data in _deep_flow(field, keywords, background, sources, filters):
                if event == "__verify__":
                    papers, full = data["papers"], data["full"]
                else:
                    yield (event, data)
                    if event == "error":
                        return
        else:
            flt_label = searchfilters.label(filters)
            flt_tip = f"（过滤：{flt_label}）" if flt_label else ""
            yield ("status", {"message": "正在生成检索式…"})
            queries = await _gen_queries(field, keywords, background)
            yield ("status", {"message": f"正在检索 {_src_label(sources)}{flt_tip}（{len(queries)} 个检索式）…"})
            result = await search_literature(queries, per_query=10, cap=28, sources=sources, filters=filters)
            papers = result["papers"]
            if not papers:
                if result["network_errors"] >= max(1, len(queries)):
                    yield ("error", {"message": "无法连接文献源（网络异常），请检查网络后重试。"})
                    return
                yield ("status", {"message": "文献源零命中，正在请 AI 改写检索方向…"})
                sugg = await _suggest_rewrite(field, keywords, background, result["queries_tried"])
                yield ("rewrite_suggestion", {
                    "tried_queries": result["queries_tried"],
                    "suggestion": sugg,
                })
                yield ("error", {"message": "未能从所选文献源检索到相关文献。可采纳上面的 AI 改写建议后重试。"})
                return
            yield ("references", {"items": [
                {k: p.get(k, "") for k in ("pmid", "title", "first_author", "journal", "year", "url", "source", "cited_by_count")} for p in papers
            ]})
            trials = await _emit_trials(queries, sources)
            if trials is not None:
                yield ("trials", trials)
            yield ("status", {"message": f"已找到 {len(papers)} 篇文献，正在分析研究现状与空白…"})
            async for piece in stream_chat(_synthesis_messages(field, papers)):
                full += piece
                yield ("delta", {"text": piece})

        if not papers:
            return

        yield ("verify", _verify_citations(full, papers))
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        # 把完整 traceback 打到 server.log, 友好错误返给前端。
        print("[idea] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"调研过程出错：{type(e).__name__}: {e}"})


def _verify_citations(full: str, items: list[dict]) -> dict:
    """引用自动核验: 正文 Markdown 链接里的每个 URL 必须命中给定文献。

    兼容 PubMed (pubmed.ncbi.nlm.nih.gov/<pmid>/) 与 Europe PMC (europepmc.org/...)。
    items 可为检索到的 papers 或前端回传的 references/evidence(都含 url, 部分含 pmid)。
    """
    valid_urls = {(p.get("url") or "").rstrip("/") for p in items if p.get("url")}
    valid_pmids = {p["pmid"] for p in items if p.get("pmid")}
    link_urls = re.findall(r"\]\((https?://[^)\s]+)\)", full)
    cited_urls: set[str] = set()
    for u in link_urls:
        if "pubmed.ncbi.nlm.nih.gov" in u or "europepmc.org" in u:
            cited_urls.add(u.rstrip("/"))

    def _pmid_ok(u: str) -> bool:
        # 按"末尾路径段 == PMID"精确匹配, 避免子串误判(如 PMID 456 命中 .../4567890/)
        tail = u.rstrip("/").rsplit("/", 1)[-1]
        return tail in valid_pmids

    unverified = sorted(u for u in cited_urls if u not in valid_urls and not _pmid_ok(u))
    return {
        "total": len(cited_urls),
        "verified": len(cited_urls) - len(unverified),
        "unverified": unverified,
    }


def _followup_context(items: list[dict]) -> str:
    """把回传的文献(references 或 evidence)拼成带编号/链接的上下文; evidence 额外带要点。"""
    lines = []
    for i, r in enumerate(items, 1):
        head = (
            f"[{i}] {r.get('first_author', '')} ({r.get('year', '')}). {r.get('title', '')} "
            f"{r.get('journal', '')}. URL: {r.get('url', '')}"
        )
        if r.get("finding") or r.get("pop") or r.get("design"):
            head += (
                f"\n  对象:{r.get('pop', '') or '—'} | 设计:{r.get('design', '') or '—'} | "
                f"发现:{r.get('finding', '') or '—'} | 局限:{r.get('gap', '') or '—'}"
            )
        lines.append(head)
    return "\n".join(lines)


async def idea_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    """对已生成的调研报告追问(ask)或按意见修改(revise), 严格基于回传的真实文献, 不重新检索。"""
    mode = (inputs.get("mode") or "ask").strip()
    question = (inputs.get("question") or "").strip()
    report = (inputs.get("report") or "").strip()
    # 优先用 evidence(信息更全), 否则用 references。
    items = inputs.get("evidence") or inputs.get("references") or []
    if not isinstance(items, list):
        items = []

    if not question:
        yield ("error", {"message": "请填写追问问题或修改意见。"})
        return
    if not items:
        yield ("error", {"message": "缺少可依据的文献，请先完成一次文献调研。"})
        return

    if settings.mock:
        reply = f"[MOCK] 已收到{'修改意见' if mode == 'revise' else '追问'}：「{question}」。"
        for ch in reply:
            yield ("delta", {"text": ch})
        yield ("verify", {"total": 0, "verified": 0, "unverified": []})
        yield ("done", {})
        return

    ctx = _followup_context(items)
    if mode == "revise":
        system = (
            "你是资深医学/药学/生物医学科研顾问。下面给出一次文献调研的【真实文献】、【已生成的调研报告】，"
            "以及用户的【修改意见】。请基于真实文献，按修改意见产出【修改后的完整报告】："
            "保持原有 Markdown 结构与分部分组织；引用用 [第一作者 et al., 年份](真实URL) 链接，"
            "且只能引用下面列出的文献链接，严禁编造任何文献或链接；直接输出修改后的报告全文，不要附加说明。"
        )
        user = f"【真实文献】\n{ctx}\n\n【已生成的调研报告】\n{report}\n\n【用户的修改意见】\n{question}"
    else:
        system = (
            "你是资深医学/药学/生物医学科研顾问。下面给出一次文献调研的【真实文献】与【已生成的调研报告】。"
            "请基于它们回答用户的追问，可针对某篇文献或某条结论展开。"
            "引用文献时用 [第一作者 et al., 年份](真实URL) 链接，且只能引用下面列出的文献链接，严禁编造。"
            "若问题超出现有文献覆盖范围，请明确说明‘现有检索结果未覆盖，建议补充检索’，不要臆造。"
        )
        user = f"【真实文献】\n{ctx}\n\n【已生成的调研报告】\n{report}\n\n【用户追问】\n{question}"

    try:
        full = ""
        async for piece in stream_chat([{"role": "system", "content": system}, {"role": "user", "content": user}]):
            full += piece
            yield ("delta", {"text": piece})
        yield ("verify", _verify_citations(full, items))
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[idea-followup] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"追问处理出错：{type(e).__name__}: {e}"})
