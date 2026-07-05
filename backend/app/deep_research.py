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
