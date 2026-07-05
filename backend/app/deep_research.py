"""深度调研: 以研究问题为输入,综合文献回答共识/矛盾/空白。

模块内共 6 个能力:
  parse_upload(...)      上传 PDF/DOCX → 抽出 title/摘要 + 缓存全文
  lookup_title(...)      用户手输题名 → crossref/pubmed/openalex 反查
  recommend(...)         摘要 + 研究问题 → 深读推荐分 (high/medium/none)
  fetch_deep_reads(...)  按 deep_read_targets 拿到全文 (upload / oa_url / europepmc)
  synthesize_stream(...) 合成 4 段报告 + 引用核验
  build_contribution_table(...) 二次 LLM 调用,产出结构化贡献表

对外的 SSE 事件语义与 IdeaModule 对齐 (references/evidence/delta/verify/warning/error/done),
新增: recommend / deep_read_progress / contribution_table。
"""
from __future__ import annotations

import asyncio
import json
import re
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Literal

import httpx

from .config import settings

# ── 常量 ──────────────────────────────────────────────────────
DEEP_READ_MAX_TOKENS_PER_PAPER = 8000
DEEP_READ_CONCURRENCY = 3
DEEP_READ_PER_PAPER_TIMEOUT_SEC = 20
DEEP_READ_TOTAL_TIMEOUT_SEC = 90
RECOMMEND_HIGH_CAP = 8
RECOMMEND_MEDIUM_CAP = 5
UPLOAD_CACHE_TTL_HOURS = 24 * 7  # 项目内保留 7 天;项目删除时随之清理

# ── 缓存目录 ─────────────────────────────────────────────────

def _upload_cache_dir(project_id: str | None) -> Path:
    """上传文献全文缓存目录, 按 project 隔离。project_id 缺失时用 default。"""
    from .projects import project_data_dir  # 延迟导入避免循环
    base = project_data_dir(project_id) if project_id else Path.cwd() / ".cache"
    d = Path(base) / "deep_research" / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _new_upload_id() -> str:
    return uuid.uuid4().hex[:16]


# ── Types (TypedDict 用 dict 表达; pydantic 在路由层定义) ─────

RecommendScore = Literal["high", "medium", "none"]


# ── 深读全文的简单章节截断 (v1: 优先 Results + Discussion) ─────
# task #7 记录了 v2 改进方向 (章节切分 + 关键词相关性 + 向量检索评估)

_SECTION_PAT = re.compile(
    r"^\s*(introduction|background|methods?|materials?|results?|findings?|discussion|conclusions?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def _split_sections(text: str) -> dict[str, str]:
    """粗切:按常见章节标题分段。找不到章节返回 {'body': text}。"""
    matches = list(_SECTION_PAT.finditer(text))
    if not matches:
        return {"body": text}
    out: dict[str, str] = {}
    for i, m in enumerate(matches):
        name = m.group(1).lower().rstrip("s").rstrip("es")  # normalize
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out[name] = text[start:end].strip()
    return out


def _truncate_to_budget(text: str, budget_tokens: int) -> str:
    """按 ~4 char/token 粗估, 直接切字符; 首版够用。"""
    max_chars = budget_tokens * 4
    return text[:max_chars]


def select_deep_read_chunk(full_text: str, budget_tokens: int = DEEP_READ_MAX_TOKENS_PER_PAPER) -> str:
    """v1: 优先保留 results + discussion + conclusion; 无章节则整段截断。"""
    sections = _split_sections(full_text)
    if "body" in sections:
        return _truncate_to_budget(full_text, budget_tokens)
    priority = ["result", "finding", "discussion", "conclusion", "method", "introduction", "background"]
    picked: list[str] = []
    remaining = budget_tokens * 4
    for name in priority:
        if name not in sections:
            continue
        chunk = sections[name]
        take = chunk[:remaining]
        if take:
            picked.append(f"[{name.upper()}]\n{take}")
            remaining -= len(take)
        if remaining <= 0:
            break
    return "\n\n".join(picked) if picked else _truncate_to_budget(full_text, budget_tokens)


# ── 上传解析 ─────────────────────────────────────────────────

def _extract_title_and_author(text: str) -> tuple[str, str, str, str]:
    """尽力抽取 (title, first_author, year, confidence).

    v1 规则:
      title  = 第一段非空行 (剔除页码/期刊页眉); 长度 6-200 字符; 字母/汉字 >=3;
               排除以 page/vol/doi/http/www 开头的行; 排除含连续 3+ 噪声符号
               (*#@$%^&) 的行 (通常是 markdown 分隔或乱字符).
      author = 匹配 'Firstname Lastname[, ...]' 的第一处
      year   = 首页文本里第一处 4 位数字 (19xx/20xx)
    抽不到 title 或 title 过短 → confidence='low'
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    title = ""
    for ln in lines[:20]:
        if not (6 <= len(ln) <= 200):
            continue
        if not re.search(r"[A-Za-z\u4e00-\u9fff]{3,}", ln):
            continue
        if re.match(r"^(page|vol\.?|doi|http|www\.)", ln, re.I):
            continue
        # 明显噪声/装饰行: 连续 3+ 符号 (***bad***, ###hdr###) — 不当作标题
        if re.search(r"[*#@$%^&~]{3,}", ln):
            continue
        title = ln
        break
    year_match = re.search(r"\b(19|20)\d{2}\b", text[:2000])
    year = year_match.group(0) if year_match else ""
    author_match = re.search(
        r"\b([A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+)\b", text[:2000]
    )
    first_author = author_match.group(1) if author_match else ""
    confidence = "high" if title and len(title) >= 8 else "low"
    return title, first_author, year, confidence


async def parse_upload(
    filename: str,
    content: bytes,
    project_id: str | None,
) -> dict:
    """解析上传文献 → title/摘要 + 全文缓存到 project 目录."""
    from .extract import extract_text  # 重库延迟导入

    try:
        ex = extract_text(filename, content)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析失败: {type(e).__name__}: {e}"}

    if not ex.get("ok"):
        # extract_text 已给出中文可读错误提示, 原样透出
        return {"ok": False, "error": ex.get("error") or "解析失败"}

    full_text = (ex.get("text") or "").strip()
    if not full_text:
        return {"ok": False, "error": "文件无可读文本"}

    title, first_author, year, confidence = _extract_title_and_author(full_text)
    if not title:
        # 回退: 用文件名去后缀 (常见: study_2024.pdf → "study 2024")
        title = re.sub(r"\.(pdf|docx|txt|md)$", "", filename, flags=re.I)
        title = title.replace("_", " ").strip()
        confidence = "low"

    abstract = full_text[:500].replace("\n", " ").strip()

    upload_id = _new_upload_id()
    cache_dir = _upload_cache_dir(project_id)
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{upload_id}.txt").write_text(full_text, encoding="utf-8")

    # extract_text 目前不返回页数; 用文本长度粗估 (PDF 平均 ~3000 char/页)
    kind = ex.get("kind", "")
    if kind == "pdf":
        page_count = max(1, len(full_text) // 3000)
    else:
        page_count = 0

    return {
        "ok": True,
        "upload_id": upload_id,
        "title": title,
        "first_author": first_author,
        "year": year,
        "abstract": abstract,
        "full_text_available": True,
        "page_count": page_count,
        "parse_confidence": confidence,
    }


# ── 题名反查 ─────────────────────────────────────────────────

async def _search_title_multi(title: str) -> dict:
    """依次尝试 crossref → openalex。一命中即返回。

    返回结构: {found: bool, abstract, first_author, year, url, doi}。
    任一源网络失败静默降级到下一源; 全部失败或均无命中 → {found: False}。
    """
    from . import crossref, openalex

    title = title.strip()
    if len(title) < 6:
        return {"found": False}

    # crossref: 题名精确反查
    try:
        if hasattr(crossref, "search_title"):
            cr = await crossref.search_title(title, limit=1)
            if cr:
                it = cr[0]
                return {
                    "found": True,
                    "abstract": it.get("abstract") or "",
                    "first_author": it.get("first_author") or "",
                    "year": it.get("year") or "",
                    "url": it.get("url") or "",
                    "doi": it.get("doi") or "",
                }
    except Exception:  # noqa: BLE001
        pass

    # openalex fallback
    try:
        if hasattr(openalex, "search_title"):
            oa = await openalex.search_title(title, limit=1)
            if oa:
                it = oa[0]
                return {
                    "found": True,
                    "abstract": it.get("abstract") or "",
                    "first_author": it.get("first_author") or "",
                    "year": it.get("year") or "",
                    "url": it.get("url") or "",
                    "doi": it.get("doi") or "",
                }
    except Exception:  # noqa: BLE001
        pass

    return {"found": False}


async def lookup_title(title: str) -> dict:
    """入口: 用户手输题名 → 反查文献元数据。

    返回 {found, abstract, first_author, year, url, doi}。found=False 时其它字段可缺省。
    """
    return await _search_title_multi(title)


# ── 深读推荐分 ───────────────────────────────────────────────
from .llm import stream_chat  # noqa: E402


def _recommend_messages(question: str, refs: list[dict]) -> list[dict]:
    refs_block = "\n".join(
        f"[{r['ref_key']}] {r.get('title', '')}\n摘要: {r.get('abstract', '') or '(无摘要)'}"
        for r in refs
    )
    system = (
        "你是循证综述助手。用户会给出研究问题和一组文献摘要。"
        "评估每篇文献是否值得深读全文以回答该问题。"
        "评分只允许 high / medium / none 三档,给出简短理由 (≤ 20 字)。"
        "high 上限 8 篇, medium 上限 5 篇, 超出的按 none 处理。"
        "仅返回 JSON 数组,不要 markdown, 不要额外文字。"
        "格式: [{\"ref_key\":\"...\",\"score\":\"high|medium|none\",\"reason\":\"...\"}]"
    )
    user = f"研究问题:{question}\n\n文献列表:\n{refs_block}\n\n请返回 JSON。"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _cap_scores(items: list[dict]) -> list[dict]:
    """按 high ≤ RECOMMEND_HIGH_CAP, medium ≤ RECOMMEND_MEDIUM_CAP; 超额降级为 none。"""
    highs = [it for it in items if it.get("score") == "high"]
    meds = [it for it in items if it.get("score") == "medium"]
    nones = [it for it in items if it.get("score") == "none"]
    kept_high = highs[:RECOMMEND_HIGH_CAP]
    dropped_high = [{**it, "score": "none", "reason": (it.get("reason") or "") + " (超推荐上限)"}
                    for it in highs[RECOMMEND_HIGH_CAP:]]
    kept_med = meds[:RECOMMEND_MEDIUM_CAP]
    dropped_med = [{**it, "score": "none", "reason": (it.get("reason") or "") + " (超推荐上限)"}
                   for it in meds[RECOMMEND_MEDIUM_CAP:]]
    return kept_high + kept_med + nones + dropped_high + dropped_med


async def recommend(question: str, refs: list[dict]) -> dict:
    """摘要 + 研究问题 → 深读推荐分。单次 LLM 调用。"""
    if not question.strip():
        return {"ok": False, "error": "缺少研究问题"}
    if not refs:
        return {"ok": True, "items": []}
    if settings.mock:
        return {"ok": True, "items": [
            {"ref_key": r["ref_key"], "score": ("high" if i < 2 else "none"), "reason": "[MOCK]"}
            for i, r in enumerate(refs)
        ]}
    buf = ""
    async for piece in stream_chat(_recommend_messages(question, refs[:40]), task="research"):
        buf += piece
    try:
        raw = json.loads(buf)
        if not isinstance(raw, list):
            raise ValueError("LLM 未返回数组")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析推荐分失败: {e}", "raw": buf[:200]}
    # 归一化 + 校验
    valid_keys = {r["ref_key"] for r in refs}
    items = [
        {
            "ref_key": it.get("ref_key"),
            "score": it.get("score") if it.get("score") in ("high", "medium", "none") else "none",
            "reason": (it.get("reason") or "")[:60],
        }
        for it in raw
        if it.get("ref_key") in valid_keys
    ]
    # 补全未返回的条目为 none
    returned_keys = {it["ref_key"] for it in items}
    for r in refs:
        if r["ref_key"] not in returned_keys:
            items.append({"ref_key": r["ref_key"], "score": "none", "reason": ""})
    items = _cap_scores(items)
    return {"ok": True, "items": items}


# ── 深读全文获取 ─────────────────────────────────────────────


async def _fetch_pdf_bytes(url: str) -> bytes:
    """独立函数,测试易于 mock。"""
    async with httpx.AsyncClient(timeout=DEEP_READ_PER_PAPER_TIMEOUT_SEC, follow_redirects=True) as c:
        r = await c.get(url)
        r.raise_for_status()
        return r.content


async def _load_upload_full_text(upload_id: str, project_id: str | None) -> str:
    p = _upload_cache_dir(project_id) / f"{upload_id}.txt"
    if not p.exists():
        raise FileNotFoundError(f"上传缓存丢失: {upload_id}")
    return p.read_text(encoding="utf-8")


async def fetch_one_deep_read(target: dict, project_id: str | None) -> dict:
    """按 target.source 拿全文并截断。失败返回 ok=False + error。"""
    ref_key = target.get("ref_key", "")
    src = target.get("source", "")
    try:
        async def _do() -> str:
            if src == "upload":
                return await _load_upload_full_text(target["upload_id"], project_id)
            if src in ("oa", "europepmc", "crossref") and target.get("oa_url"):
                from .extract import extract_text
                content = await _fetch_pdf_bytes(target["oa_url"])
                ex = extract_text("paper.pdf", content)
                return ex.get("text") or ""
            raise ValueError(f"无可读全文来源: {src}")

        full = await asyncio.wait_for(_do(), timeout=DEEP_READ_PER_PAPER_TIMEOUT_SEC)
        if not full.strip():
            return {"ok": False, "ref_key": ref_key, "error": "全文为空"}
        chunk = select_deep_read_chunk(full)
        return {"ok": True, "ref_key": ref_key, "chunk": chunk, "chunk_chars": len(chunk)}
    except asyncio.TimeoutError:
        return {"ok": False, "ref_key": ref_key, "error": f"深读超时 (>{DEEP_READ_PER_PAPER_TIMEOUT_SEC}s)"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "ref_key": ref_key, "error": f"{type(e).__name__}: {e}"}


async def fetch_deep_reads_stream(
    targets: list[dict],
    project_id: str | None,
) -> AsyncIterator[tuple[str, dict]]:
    """并发拉深读全文,边完成边 yield (deep_read_progress, deep_read_result)。全局超时 90s。"""
    total = len(targets)
    if total == 0:
        return
    sem = asyncio.Semaphore(DEEP_READ_CONCURRENCY)
    done_count = 0

    async def one(t: dict) -> dict:
        async with sem:
            return await fetch_one_deep_read(t, project_id)

    tasks = [asyncio.create_task(one(t)) for t in targets]
    try:
        for coro in asyncio.as_completed(tasks, timeout=DEEP_READ_TOTAL_TIMEOUT_SEC):
            result = await coro
            done_count += 1
            yield ("deep_read_progress", {
                "done": done_count, "total": total, "current_ref_key": result.get("ref_key", ""),
            })
            yield ("deep_read_result", result)
    except asyncio.TimeoutError:
        # 未完成的任务标为超时降级
        for t, task in zip(targets, tasks):
            if not task.done():
                task.cancel()
                yield ("deep_read_result", {
                    "ok": False, "ref_key": t.get("ref_key", ""),
                    "error": f"全局超时 (>{DEEP_READ_TOTAL_TIMEOUT_SEC}s)",
                })


# ── 合成报告 ─────────────────────────────────────────────────

_REF_KEY_RE = re.compile(r"\[([^\[\]]{1,120})\](?!\()")  # [ref_key] 不跟 ( 的引用


def _dr_refs_block(refs: list[dict], deep_reads_map: dict[str, str]) -> str:
    """把 refs + 深读 chunk 格式化成 LLM 可读的上下文块。"""
    lines = []
    for r in refs:
        rk = r.get("ref_key", "")
        title = r.get("title", "")
        abstract = (r.get("abstract") or "")[:400]
        author = r.get("first_author", "")
        year = r.get("year", "")
        journal = r.get("journal", "")
        meta = " | ".join(x for x in [author, year, journal] if x)
        chunk = deep_reads_map.get(rk, "")
        lines.append(f"[{rk}] {title}")
        if meta:
            lines.append(f"  {meta}")
        if abstract:
            lines.append(f"  摘要: {abstract}")
        if chunk:
            lines.append(f"  全文节选:\n{chunk[:1200]}")
        lines.append("")
    return "\n".join(lines)


def _dr_synthesis_messages(
    question: str,
    refs: list[dict],
    deep_reads_map: dict[str, str],
    english: bool = False,
) -> list[dict]:
    refs_block = _dr_refs_block(refs, deep_reads_map)
    lang_note = "Write the entire report in English." if english else "请用中文输出报告。"
    system = (
        "你是循证综述助手。用户会给出一个研究问题和一批文献（含摘要，部分含全文节选）。"
        "请撰写一份结构化的深度调研报告，直接回答该研究问题，分四节：\n\n"
        "## 一、学界共识\n梳理各文献在该问题上的一致性发现，明确给出共识结论。\n\n"
        "## 二、矛盾与争议\n列出现有文献中相互冲突的发现或方法论争议，分析可能原因。\n\n"
        "## 三、研究空白\n指出该问题尚未被充分回答的方面，包括人群局限、随访不足、机制未明等。\n\n"
        "## 四、综合结论\n综合以上，对研究问题给出有据可查的综合判断。\n\n"
        "铁律：\n"
        "- 引用文献时仅使用给定的 ref_key，格式 [ref_key]（如 [pmid:12345678]）\n"
        "- 不得编造文献；不确定时明说『现有证据有限』\n"
        "- 每个有实质性说法的句子至少引用一篇文献\n"
        f"- {lang_note}"
    )
    user = f"研究问题：{question}\n\n文献资料：\n{refs_block}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _verify_report_citations(text: str, refs: list[dict]) -> dict:
    """核验报告中 [ref_key] 引用是否全部来自给定 refs。"""
    valid_keys = {r.get("ref_key", "") for r in refs if r.get("ref_key")}
    cited = [m.group(1) for m in _REF_KEY_RE.finditer(text)]
    cited_set = set(cited)
    unverified = sorted(k for k in cited_set if k not in valid_keys)
    return {
        "total": len(cited_set),
        "verified": len(cited_set) - len(unverified),
        "unverified": unverified,
        "quotes_total": 0,
        "quotes_ok": 0,
    }


async def synthesize_stream(
    question: str,
    refs: list[dict],
    deep_reads_map: dict[str, str],
    english: bool = False,
) -> AsyncIterator[tuple[str, dict]]:
    """流式生成深度调研报告; 结束后 yield verify 事件。"""
    if not refs:
        yield ("error", {"message": "没有可用文献, 请返回上一步至少保留一篇。"})
        return
    if settings.mock:
        mock_text = (
            "## 一、学界共识\n[MOCK] 示例共识。\n\n"
            "## 二、矛盾与争议\n[MOCK] 示例争议。\n\n"
            "## 三、研究空白\n[MOCK] 示例空白。\n\n"
            "## 四、综合结论\n[MOCK] 示例结论。\n"
        )
        for ch in mock_text:
            await asyncio.sleep(0)
            yield ("delta", {"text": ch})
        yield ("verify", {"total": 0, "verified": 0, "unverified": [], "quotes_total": 0, "quotes_ok": 0})
        return
    full = ""
    try:
        async for piece in stream_chat(
            _dr_synthesis_messages(question, refs, deep_reads_map, english), task="research"
        ):
            full += piece
            yield ("delta", {"text": piece})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"合成报告出错: {type(e).__name__}: {e}"})
        return
    yield ("verify", _verify_report_citations(full, refs))


def _contribution_messages(
    question: str,
    refs: list[dict],
    deep_reads_map: dict[str, str],
) -> list[dict]:
    refs_block = _dr_refs_block(refs, deep_reads_map)
    system = (
        "你是文献综述助手。根据给定的研究问题和文献列表，输出一个 JSON 数组，"
        "每篇文献对应一个对象，字段如下：\n"
        '{"n":1,"author_year":"Smith et al., 2023","journal":"Nature Medicine",'
        '"design":"RCT","sample":"500 patients",'
        '"finding":"主要发现一句话","relevance":"direct","deep_read":false}\n\n'
        "relevance 只允许 direct / indirect / supporting 三档。\n"
        "deep_read 为 true 当且仅当该文献提供了全文节选（见下方资料）。\n"
        "仅返回 JSON 数组，不要 markdown，不要额外文字。"
    )
    user = f"研究问题：{question}\n\n文献资料：\n{refs_block}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def build_contribution_table(
    question: str,
    refs: list[dict],
    deep_reads_map: dict[str, str],
) -> list[dict]:
    """非流式调用 LLM, 返回贡献表行列表。失败返回空列表。"""
    if not refs:
        return []
    if settings.mock:
        return [
            {
                "n": i + 1,
                "author_year": f"{r.get('first_author', 'Unknown')} et al., {r.get('year', '')}",
                "journal": r.get("journal", ""),
                "design": "RCT",
                "sample": "N/A",
                "finding": "[MOCK] 示例发现",
                "relevance": "direct" if i == 0 else "indirect",
                "deep_read": r.get("ref_key", "") in deep_reads_map,
            }
            for i, r in enumerate(refs[:20])
        ]
    buf = ""
    try:
        async for piece in stream_chat(
            _contribution_messages(question, refs, deep_reads_map), task="research"
        ):
            buf += piece
        raw = json.loads(buf)
        if not isinstance(raw, list):
            return []
        out = []
        for i, row in enumerate(raw):
            if not isinstance(row, dict):
                continue
            rel = row.get("relevance", "")
            if rel not in ("direct", "indirect", "supporting"):
                rel = "indirect"
            out.append({
                "n": int(row.get("n") or i + 1),
                "author_year": str(row.get("author_year") or "")[:80],
                "journal": str(row.get("journal") or "")[:80],
                "design": str(row.get("design") or "")[:60],
                "sample": str(row.get("sample") or "")[:80],
                "finding": str(row.get("finding") or "")[:200],
                "relevance": rel,
                "deep_read": bool(row.get("deep_read")),
            })
        return out
    except Exception:  # noqa: BLE001
        return []
