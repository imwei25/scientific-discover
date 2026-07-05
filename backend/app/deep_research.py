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
