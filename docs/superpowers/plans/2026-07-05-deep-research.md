# 深度调研模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"深度调研"模块 (以研究问题为输入,产出循证综述式报告 + 逐文献贡献表),并加入开发者模式开关,深度调研作为首个开发中模块隐藏其后。

**Architecture:** 方案 A — 新建 `ResearchModule.tsx` 与 `deep_research.py`,复用检索层 (`literature.search_literature`) 与 Zotero/OA 补全,从 `IdeaModule` 抽 3 个公用 UI 组件。合成走两次 LLM 调用 (报告 Markdown + 贡献表 JSON)。深读全文并发 3,单篇 20s,全局 90s,8k 截断。

**Tech Stack:** FastAPI + SSE (`text/event-stream` 走 `_sse` 编码), pytest + monkeypatch, React + TypeScript, `usePersistentState` (按 project 隔离), `llm.stream_chat`, `extract.extract_text`。

**Spec:** `docs/superpowers/specs/2026-07-05-deep-research-design.md`

---

## File Structure

**New (backend):**
- `backend/app/deep_research.py` — 上传解析、题名反查、推荐分、深读、合成、贡献表、追问
- `backend/app/routes/deep_research_routes.py` — 5 个 endpoints
- `backend/test_deep_research_parse_upload.py`
- `backend/test_deep_research_lookup_title.py`
- `backend/test_deep_research_recommend.py`
- `backend/test_deep_research_deep_read.py`
- `backend/test_deep_research_synthesize.py`
- `backend/test_deep_research_stream.py`
- `backend/test_deep_research_followup.py`

**New (frontend):**
- `frontend/src/modules/ResearchModule.tsx` — 主模块
- `frontend/src/components/AttachmentUploadBox.tsx` — 从 IdeaModule Step1 抽出
- `frontend/src/components/FollowupPanel.tsx` — 从 IdeaModule Step4 抽出
- `frontend/src/components/ReportExportBar.tsx` — 从 IdeaModule Step4 抽出
- `frontend/src/lib/uploadedLit.ts` — 上传文献前端辅助

**Modified:**
- `backend/app/main.py` — 挂载新路由
- `frontend/src/App.tsx` — NAV dev flag, dropdown settings, ModuleId union
- `frontend/src/modules/IdeaModule.tsx` — 用抽出的 3 个组件替换 inline 代码
- `frontend/src/lib/sse.ts` — 新增 stream 函数

---

## Task 1: 后端 - 建立 deep_research 模块骨架与共享类型

**Files:**
- Create: `backend/app/deep_research.py`

- [ ] **Step 1: 创建 `deep_research.py` 骨架**

创建文件 `backend/app/deep_research.py`,写入:

```python
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
```

- [ ] **Step 2: 添加"章节切分 + 8k 截断"辅助**

追加到 `deep_research.py`:

```python
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
```

- [ ] **Step 3: Commit**

```bash
git add backend/app/deep_research.py
git commit -m "feat(deep_research): 模块骨架 + 章节截断辅助"
```

---

## Task 2: 后端 - `parse_upload` 上传解析

**Files:**
- Modify: `backend/app/deep_research.py`
- Test: `backend/test_deep_research_parse_upload.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_parse_upload.py`:

```python
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app

client = TestClient(app)


def _fake_pdf_bytes() -> bytes:
    # 最小可解析的 PDF: 包含"A Study of Foo Bar" 作为首行
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 750, "A Study of Foo Bar")
    c.drawString(100, 730, "John Smith, 2024")
    c.drawString(100, 700, "This paper investigates the effect of X on Y.")
    c.showPage(); c.save()
    return buf.getvalue()


def test_parse_upload_pdf_returns_title_and_upload_id(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.app.deep_research._upload_cache_dir", lambda pid: tmp_path)
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("study.pdf", _fake_pdf_bytes(), "application/pdf")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["title"]
    assert data["upload_id"]
    assert data["full_text_available"] is True
    assert (tmp_path / f"{data['upload_id']}.txt").exists()


def test_parse_upload_rejects_over_limit(monkeypatch):
    from backend.app import http_common
    monkeypatch.setattr(http_common, "MAX_UPLOAD_BYTES", 100)
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("big.pdf", b"x" * 1024, "application/pdf")},
    )
    assert resp.status_code == 413


def test_parse_upload_low_confidence_when_no_title(tmp_path, monkeypatch):
    monkeypatch.setattr("backend.app.deep_research._upload_cache_dir", lambda pid: tmp_path)
    # 只塞几个乱码,无 title
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("blob.txt", b"@#$%^&\n***random noise***", "text/plain")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["parse_confidence"] == "low"
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
python -m pytest backend/test_deep_research_parse_upload.py -v
```

Expected: 3 tests, all FAIL with 404 (endpoint 未定义) 或 import error。

- [ ] **Step 3: 实现 `parse_upload` 功能**

追加到 `backend/app/deep_research.py`:

```python
# ── 上传解析 ─────────────────────────────────────────────────

def _extract_title_and_author(text: str) -> tuple[str, str, str, str]:
    """尽力抽取 (title, first_author, year, confidence)。

    v1 规则:
      title  = 第一段非空行 (剔除页码/期刊页眉);长度 6-200 字符
      author = 匹配"Firstname Lastname[, ...]"的第一处
      year   = 首页文本里第一处 4 位数字 (19xx/20xx)
    抽不到 title 或 title 全是非字母字符 → confidence="low"
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    title = ""
    for ln in lines[:20]:
        if 6 <= len(ln) <= 200 and re.search(r"[A-Za-z\u4e00-\u9fff]{3,}", ln):
            # 跳过明显不是标题的行 (纯数字/期刊页眉常见词)
            if re.match(r"^(page|vol\.?|doi|http|www\.)", ln, re.I):
                continue
            title = ln
            break
    year_match = re.search(r"\b(19|20)\d{2}\b", text[:2000])
    year = year_match.group(0) if year_match else ""
    author_match = re.search(r"\b([A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+)\b", text[:2000])
    first_author = author_match.group(1) if author_match else ""
    confidence = "high" if title and len(title) >= 8 else "low"
    return title, first_author, year, confidence


async def parse_upload(
    filename: str,
    content: bytes,
    project_id: str | None,
) -> dict:
    """解析上传文献 → title/摘要 + 全文缓存到 project 目录。"""
    from .extract import extract_text  # 重库延迟导入

    try:
        ex = extract_text(filename, content)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析失败: {type(e).__name__}: {e}"}

    full_text = (ex.get("text") or "").strip()
    if not full_text:
        return {"ok": False, "error": "文件无可读文本"}

    title, first_author, year, confidence = _extract_title_and_author(full_text)
    if not title:
        # 回退用文件名去后缀
        title = re.sub(r"\.(pdf|docx|txt|md)$", "", filename, flags=re.I).replace("_", " ").strip()
        confidence = "low"

    abstract = full_text[:500].replace("\n", " ").strip()

    upload_id = _new_upload_id()
    cache_dir = _upload_cache_dir(project_id)
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / f"{upload_id}.txt").write_text(full_text, encoding="utf-8")

    page_count = int(ex.get("pages") or 0)

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
```

- [ ] **Step 4: 挂载 route**

创建 `backend/app/routes/deep_research_routes.py`:

```python
"""深度调研路由: parse_upload / lookup_title / recommend / stream / followup。"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .. import deep_research as dr
from ..http_common import MAX_UPLOAD_BYTES, SSE_HEADERS, _read_capped, _sse

router = APIRouter()


@router.post("/api/deep_research/parse_upload")
async def parse_upload_ep(
    file: UploadFile = File(...),
    project_id: str | None = Form(None),
):
    content = await _read_capped(file)
    if content is None:
        raise HTTPException(status_code=413, detail=f"文件超过 {MAX_UPLOAD_BYTES // (1024*1024)}MB 上限")
    result = await dr.parse_upload(file.filename or "upload", content, project_id)
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return JSONResponse(result)
```

追加到 `backend/app/main.py` (在 `include_router(projects_router)` 之后):

```python
from .routes.deep_research_routes import router as deep_research_router
app.include_router(deep_research_router)
```

- [ ] **Step 5: 检查 `projects.project_data_dir` 是否存在**

```bash
grep -n "def project_data_dir\|def _project_dir" backend/app/projects.py
```

若不存在, 追加到 `projects.py`:

```python
def project_data_dir(project_id: str | None) -> Path:
    """返回项目数据目录 (供 deep_research 缓存上传全文用)。project_id 缺失时用 default。"""
    root = Path(_projects_root())  # 复用现有 root 函数
    pid = project_id or "default"
    d = root / pid / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d
```

若 `_projects_root` 不存在,用 `settings.data_dir` 或 `Path.home() / ".niuma-research" / "projects"` 兜底 (查阅 `projects.py` 决定)。

- [ ] **Step 6: 运行测试确认通过**

```bash
python -m pytest backend/test_deep_research_parse_upload.py -v
```

Expected: 3/3 PASS。若 reportlab 未装,pip install reportlab (仅测试依赖)。

- [ ] **Step 7: Commit**

```bash
git add backend/app/deep_research.py backend/app/routes/deep_research_routes.py backend/app/main.py backend/app/projects.py backend/test_deep_research_parse_upload.py
git commit -m "feat(deep_research): parse_upload 端点 (PDF/DOCX → title+摘要+缓存)"
```

---

## Task 3: 后端 - `lookup_title` 手输题名反查

**Files:**
- Modify: `backend/app/deep_research.py`, `backend/app/routes/deep_research_routes.py`
- Test: `backend/test_deep_research_lookup_title.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_lookup_title.py`:

```python
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def test_lookup_title_hits_crossref(monkeypatch):
    from backend.app import deep_research as dr
    async def fake_search(title):
        return {
            "found": True, "abstract": "We studied X.", "first_author": "Chen J",
            "year": "2023", "url": "https://doi.org/10.1/abc", "doi": "10.1/abc",
        }
    monkeypatch.setattr(dr, "_search_title_multi", AsyncMock(side_effect=fake_search))
    resp = client.post("/api/deep_research/lookup_title", json={"title": "A study of foo"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["found"] is True
    assert data["abstract"] == "We studied X."


def test_lookup_title_not_found(monkeypatch):
    from backend.app import deep_research as dr
    async def fake_search(title):
        return {"found": False}
    monkeypatch.setattr(dr, "_search_title_multi", AsyncMock(side_effect=fake_search))
    resp = client.post("/api/deep_research/lookup_title", json={"title": "nonexistent paper xyz"})
    assert resp.status_code == 200
    assert resp.json()["found"] is False
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_lookup_title.py -v
```

Expected: FAIL (endpoint 未定义)。

- [ ] **Step 3: 实现 `lookup_title`**

追加到 `backend/app/deep_research.py`:

```python
# ── 题名反查 ─────────────────────────────────────────────────

async def _search_title_multi(title: str) -> dict:
    """依次尝试 crossref → openalex → pubmed。一命中即返回。"""
    from . import crossref, openalex, literature

    title = title.strip()
    if len(title) < 6:
        return {"found": False}

    # crossref by title
    try:
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
    except Exception:
        pass

    # openalex fallback
    try:
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
    except Exception:
        pass

    return {"found": False}


async def lookup_title(title: str) -> dict:
    """入口。返回 {found, abstract, first_author, year, url, doi}。"""
    return await _search_title_multi(title)
```

**注意**: `crossref.search_title` / `openalex.search_title` 若不存在,先在对应模块新增一个薄薄的按标题搜索函数 (可复用现有 `search_epmc` 等类似结构; grep 一下现有能力):

```bash
grep -n "def search\|async def search" backend/app/crossref.py backend/app/openalex.py
```

若确实缺失,在这个 Task 中补上最小实现 (再补一个测试)。

- [ ] **Step 4: 在 route 中添加**

追加到 `backend/app/routes/deep_research_routes.py`:

```python
class LookupTitleReq(BaseModel):
    title: str


@router.post("/api/deep_research/lookup_title")
async def lookup_title_ep(req: LookupTitleReq):
    return JSONResponse(await dr.lookup_title(req.title))
```

- [ ] **Step 5: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_lookup_title.py -v
```

Expected: 2/2 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/deep_research.py backend/app/routes/deep_research_routes.py backend/app/crossref.py backend/app/openalex.py backend/test_deep_research_lookup_title.py
git commit -m "feat(deep_research): lookup_title 端点 (crossref→openalex 依次反查)"
```

---

## Task 4: 后端 - `recommend` 深读推荐分

**Files:**
- Modify: `backend/app/deep_research.py`, `backend/app/routes/deep_research_routes.py`
- Test: `backend/test_deep_research_recommend.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_recommend.py`:

```python
from unittest.mock import AsyncMock
import json
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def _refs(n):
    return [
        {"ref_key": f"k{i}", "title": f"Paper {i}", "abstract": f"Abstract of paper {i}"}
        for i in range(n)
    ]


def test_recommend_returns_scores(monkeypatch):
    from backend.app import deep_research as dr
    fake_llm_output = json.dumps([
        {"ref_key": "k0", "score": "high", "reason": "对立结论"},
        {"ref_key": "k1", "score": "medium", "reason": "样本量大"},
        {"ref_key": "k2", "score": "none", "reason": "偏离"},
    ])
    async def fake_llm(messages, **kw):
        yield fake_llm_output
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    resp = client.post(
        "/api/deep_research/recommend",
        json={"question": "X 对 Y 的作用", "refs": _refs(3)},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    scores = {it["ref_key"]: it["score"] for it in data["items"]}
    assert scores == {"k0": "high", "k1": "medium", "k2": "none"}


def test_recommend_high_cap_enforced(monkeypatch):
    from backend.app import deep_research as dr
    # LLM 返回 20 篇全 high; 后端应截到 8 篇 high, 其余降级为 none
    fake = json.dumps([{"ref_key": f"k{i}", "score": "high", "reason": "r"} for i in range(20)])
    async def fake_llm(messages, **kw):
        yield fake
    monkeypatch.setattr(dr, "stream_chat", fake_llm)
    resp = client.post(
        "/api/deep_research/recommend",
        json={"question": "Q", "refs": _refs(20)},
    )
    items = resp.json()["items"]
    high_count = sum(1 for it in items if it["score"] == "high")
    assert high_count == 8
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_recommend.py -v
```

- [ ] **Step 3: 实现 `recommend`**

追加到 `backend/app/deep_research.py`:

```python
# ── 深读推荐分 ───────────────────────────────────────────────
from .llm import stream_chat  # 顶部已有其它 import 时可合并


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
    """按 high ≤ 8, medium ≤ 5 上限截断; 超额降级为 none。"""
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
```

- [ ] **Step 4: 添加 route**

追加到 `backend/app/routes/deep_research_routes.py`:

```python
class RecommendReq(BaseModel):
    question: str
    refs: list[dict]


@router.post("/api/deep_research/recommend")
async def recommend_ep(req: RecommendReq):
    return JSONResponse(await dr.recommend(req.question, req.refs))
```

- [ ] **Step 5: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_recommend.py -v
```

Expected: 2/2 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/deep_research.py backend/app/routes/deep_research_routes.py backend/test_deep_research_recommend.py
git commit -m "feat(deep_research): recommend 端点 (LLM 批量打分 + high/medium 上限)"
```

---

## Task 5: 后端 - 深读全文获取

**Files:**
- Modify: `backend/app/deep_research.py`
- Test: `backend/test_deep_research_deep_read.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_deep_read.py`:

```python
import asyncio
import pytest
from pathlib import Path
from unittest.mock import AsyncMock


@pytest.mark.asyncio
async def test_fetch_deep_read_from_upload(tmp_path, monkeypatch):
    from backend.app import deep_research as dr
    monkeypatch.setattr(dr, "_upload_cache_dir", lambda pid: tmp_path)
    up_id = "abc123"
    (tmp_path / f"{up_id}.txt").write_text("Results\nWe found X.", encoding="utf-8")
    target = {"ref_key": "k0", "source": "upload", "upload_id": up_id}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is True
    assert "We found X" in got["chunk"]


@pytest.mark.asyncio
async def test_fetch_deep_read_from_oa_url(monkeypatch):
    from backend.app import deep_research as dr
    async def fake_fetch(url):
        return b"Introduction\n...\nResults\nWe observed Y."
    monkeypatch.setattr(dr, "_fetch_pdf_bytes", fake_fetch)
    monkeypatch.setattr(
        "backend.app.extract.extract_text",
        lambda name, content: {"text": content.decode(), "pages": 1},
    )
    target = {"ref_key": "k1", "source": "oa", "oa_url": "https://example.com/x.pdf"}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is True
    assert "observed Y" in got["chunk"]


@pytest.mark.asyncio
async def test_fetch_deep_read_timeout_degrades(monkeypatch):
    from backend.app import deep_research as dr
    async def slow_fetch(url):
        await asyncio.sleep(30)
        return b""
    monkeypatch.setattr(dr, "_fetch_pdf_bytes", slow_fetch)
    monkeypatch.setattr(dr, "DEEP_READ_PER_PAPER_TIMEOUT_SEC", 0.1)
    target = {"ref_key": "k2", "source": "oa", "oa_url": "https://slow.example/x.pdf"}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is False
    assert "超时" in got["error"]


@pytest.mark.asyncio
async def test_fetch_all_respects_concurrency(monkeypatch):
    from backend.app import deep_research as dr
    active = 0
    peak = 0
    lock = asyncio.Lock()
    async def track(target, project_id):
        nonlocal active, peak
        async with lock:
            active += 1
            peak = max(peak, active)
        await asyncio.sleep(0.05)
        async with lock:
            active -= 1
        return {"ok": True, "ref_key": target["ref_key"], "chunk": "x"}
    monkeypatch.setattr(dr, "fetch_one_deep_read", track)
    monkeypatch.setattr(dr, "DEEP_READ_CONCURRENCY", 3)
    targets = [{"ref_key": f"k{i}", "source": "upload", "upload_id": f"u{i}"} for i in range(10)]
    results = []
    async for evt, data in dr.fetch_deep_reads_stream(targets, project_id="p1"):
        if evt == "deep_read_result":
            results.append(data)
    assert len(results) == 10
    assert peak <= 3
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_deep_read.py -v
```

- [ ] **Step 3: 实现 fetch 逻辑**

追加到 `backend/app/deep_research.py`:

```python
# ── 深读全文获取 ─────────────────────────────────────────────
import httpx


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
```

- [ ] **Step 4: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_deep_read.py -v
```

Expected: 4/4 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/deep_research.py backend/test_deep_research_deep_read.py
git commit -m "feat(deep_research): 深读全文获取 (upload/oa + 超时降级 + 并发限流)"
```

---

## Task 6: 后端 - 合成 4 段报告 + 贡献表

**Files:**
- Modify: `backend/app/deep_research.py`
- Test: `backend/test_deep_research_synthesize.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_synthesize.py`:

```python
import json
from unittest.mock import AsyncMock
import pytest


@pytest.mark.asyncio
async def test_synthesize_stream_yields_delta_and_verify(monkeypatch):
    from backend.app import deep_research as dr

    async def fake_stream(messages, **kw):
        for ch in "## 一、当前解答\n研究显示 X [ref-k0]。\n\n## 二、共识\n- 无\n\n## 三、矛盾\n未发现\n\n## 四、空白\n- 空白 A\n":
            yield ch
    monkeypatch.setattr(dr, "stream_chat", fake_stream)

    refs = [{"ref_key": "k0", "title": "Paper 0", "abstract": "abs", "url": "https://x/0"}]
    events = []
    async for evt, data in dr.synthesize_stream(
        question="Q", field="", background="", refs=refs, evidence=[], deep_read_chunks={},
        english=False,
    ):
        events.append((evt, data))
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert "verify" in kinds


@pytest.mark.asyncio
async def test_build_contribution_table_returns_rows(monkeypatch):
    from backend.app import deep_research as dr
    fake_out = json.dumps([
        {"n": 1, "author_year": "Chen 2023", "journal": "Nat Med",
         "design": "RCT", "sample": "n=302", "finding": "…",
         "relevance": "direct", "deep_read": True},
    ])
    async def fake_stream(messages, **kw):
        yield fake_out
    monkeypatch.setattr(dr, "stream_chat", fake_stream)
    rows = await dr.build_contribution_table(
        question="Q", report="dummy", refs=[{"ref_key": "k0", "title": "t0"}],
        deep_read_keys={"k0"},
    )
    assert isinstance(rows, list)
    assert rows[0]["relevance"] == "direct"


@pytest.mark.asyncio
async def test_synthesize_verify_flags_unverified_ref(monkeypatch):
    from backend.app import deep_research as dr

    async def fake_stream(messages, **kw):
        yield "结论 A [ref-KNOWN]。结论 B [ref-BOGUS]。"
    monkeypatch.setattr(dr, "stream_chat", fake_stream)

    refs = [{"ref_key": "KNOWN", "title": "t", "url": "https://x"}]
    got_verify = None
    async for evt, data in dr.synthesize_stream(
        question="Q", field="", background="", refs=refs, evidence=[], deep_read_chunks={}, english=False,
    ):
        if evt == "verify":
            got_verify = data
    assert got_verify is not None
    assert "BOGUS" in json.dumps(got_verify, ensure_ascii=False)
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_synthesize.py -v
```

- [ ] **Step 3: 实现合成 + 贡献表 + 引用核验**

追加到 `backend/app/deep_research.py`:

```python
# ── 合成 4 段报告 ────────────────────────────────────────────

def _refs_block(refs: list[dict], evidence: list[dict]) -> str:
    ev_by_key = {(e.get("url") or e.get("title") or ""): e for e in evidence}
    lines = []
    for r in refs:
        key = r.get("ref_key") or r.get("url") or r.get("title")
        ev = ev_by_key.get(r.get("url") or r.get("title") or "") or {}
        lines.append(
            f"[ref-{key}] {r.get('first_author', '')} ({r.get('year', '')}) — {r.get('title', '')}\n"
            f"  摘要: {(r.get('abstract') or '(无摘要)')[:400]}\n"
            f"  设计: {ev.get('design', '')} | 样本: {ev.get('pop', '')} | 发现: {ev.get('finding', '')}"
        )
    return "\n".join(lines)


def _synthesis_messages(
    question: str, field: str, background: str,
    refs: list[dict], evidence: list[dict], deep_read_chunks: dict[str, str],
    english: bool,
) -> list[dict]:
    lang = "英文" if english else "中文"
    refs_txt = _refs_block(refs, evidence)
    deep_txt = "\n\n".join(f"[ref-{k}] 全文关键段落:\n{v}" for k, v in deep_read_chunks.items())
    system = (
        f"你是循证综述助手。严格基于给定文献回答用户的研究问题,用{lang}输出。"
        "报告必须包含四段固定标题:\n"
        "## 一、当前解答\n## 二、文献共识\n## 三、矛盾与不一致\n## 四、研究空白\n"
        "每条结论后必须以 [ref-KEY] 形式引用具体文献,KEY 用文献列表中给出的。"
        "若某段确无内容 (例如无矛盾),该段写'未发现'即可,严禁凭空编造。"
        "不要输出任何超出四段模板的额外前言或结语。"
    )
    user_parts = [f"研究问题:{question}"]
    if field: user_parts.append(f"研究领域:{field}")
    if background: user_parts.append(f"背景资料:\n{background[:2000]}")
    user_parts.append(f"文献列表:\n{refs_txt}")
    if deep_txt: user_parts.append(f"深读段落:\n{deep_txt}")
    user_parts.append("请开始输出报告 (四段固定标题, 每条结论带 [ref-KEY])。")
    return [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(user_parts)}]


_REF_CITE_PAT = re.compile(r"\[ref-([A-Za-z0-9_\-]+)\]")


def _verify_report_citations(report: str, refs: list[dict]) -> dict:
    valid = {r.get("ref_key") for r in refs}
    found = set(_REF_CITE_PAT.findall(report))
    unverified = sorted(k for k in found if k not in valid)
    return {
        "total": len(found),
        "verified": len(found) - len(unverified),
        "unverified": unverified,
    }


async def synthesize_stream(
    *,
    question: str,
    field: str,
    background: str,
    refs: list[dict],
    evidence: list[dict],
    deep_read_chunks: dict[str, str],
    english: bool,
) -> AsyncIterator[tuple[str, dict]]:
    """流式合成 4 段报告 + 引用核验。"""
    if settings.mock:
        full = "## 一、当前解答\n[MOCK] 示例回答 [ref-k0]。\n\n## 二、文献共识\n未发现\n\n## 三、矛盾与不一致\n未发现\n\n## 四、研究空白\n- 示例空白\n"
        for ch in full:
            yield ("delta", {"text": ch})
        yield ("verify", _verify_report_citations(full, refs))
        return
    messages = _synthesis_messages(question, field, background, refs, evidence, deep_read_chunks, english)
    buf = ""
    async for piece in stream_chat(messages, task="research"):
        buf += piece
        yield ("delta", {"text": piece})
    yield ("verify", _verify_report_citations(buf, refs))


# ── 贡献表 (二次 LLM 调用, JSON) ──────────────────────────────

def _contribution_messages(
    question: str, report: str, refs: list[dict], deep_read_keys: set[str],
) -> list[dict]:
    refs_txt = "\n".join(
        f"[ref-{r.get('ref_key')}] {r.get('first_author', '')} ({r.get('year', '')}) {r.get('title', '')}"
        for r in refs
    )
    system = (
        "根据已生成的报告和文献列表,产出结构化贡献表。"
        "每行:{n, author_year, journal, design, sample, finding, relevance, deep_read}。"
        "relevance 只能是 direct / indirect / supporting。deep_read 为布尔 (在给定深读集合内为 true)。"
        "只返回 JSON 数组, 不要 markdown 包装, 不要额外文字。"
    )
    user = (
        f"研究问题:{question}\n\n"
        f"已生成报告:\n{report[:3000]}\n\n"
        f"文献列表:\n{refs_txt}\n\n"
        f"深读集合 (ref_key): {sorted(deep_read_keys)}\n\n"
        "请返回 JSON 数组。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def build_contribution_table(
    *,
    question: str,
    report: str,
    refs: list[dict],
    deep_read_keys: set[str],
) -> list[dict]:
    if settings.mock:
        return [
            {"n": i + 1, "author_year": r.get("first_author", "?") + " " + r.get("year", ""),
             "journal": r.get("journal", ""), "design": "[MOCK]", "sample": "[MOCK]",
             "finding": "[MOCK]", "relevance": "direct",
             "deep_read": r.get("ref_key") in deep_read_keys}
            for i, r in enumerate(refs)
        ]
    buf = ""
    async for piece in stream_chat(
        _contribution_messages(question, report, refs, deep_read_keys),
        task="research",
    ):
        buf += piece
    try:
        rows = json.loads(buf)
        if not isinstance(rows, list):
            raise ValueError("非数组")
    except Exception:  # noqa: BLE001
        return []
    # 归一化
    out = []
    for i, row in enumerate(rows):
        rel = row.get("relevance")
        if rel not in ("direct", "indirect", "supporting"):
            rel = "supporting"
        out.append({
            "n": i + 1,
            "author_year": str(row.get("author_year") or "")[:60],
            "journal": str(row.get("journal") or "")[:80],
            "design": str(row.get("design") or "")[:80],
            "sample": str(row.get("sample") or "")[:60],
            "finding": str(row.get("finding") or "")[:200],
            "relevance": rel,
            "deep_read": bool(row.get("deep_read")),
        })
    return out
```

- [ ] **Step 4: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_synthesize.py -v
```

Expected: 3/3 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/deep_research.py backend/test_deep_research_synthesize.py
git commit -m "feat(deep_research): 合成 4 段报告 + 二次 LLM 出贡献表 + 引用核验"
```

---

## Task 7: 后端 - `/api/deep_research/stream` SSE 主端点

**Files:**
- Modify: `backend/app/deep_research.py`, `backend/app/routes/deep_research_routes.py`
- Test: `backend/test_deep_research_stream.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_stream.py`:

```python
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def _parse_sse(text: str) -> list[tuple[str, str]]:
    out = []
    for chunk in text.strip().split("\n\n"):
        lines = chunk.splitlines()
        event = next((ln[7:] for ln in lines if ln.startswith("event: ")), "")
        data = next((ln[6:] for ln in lines if ln.startswith("data: ")), "")
        if event:
            out.append((event, data))
    return out


def test_stream_generate_phase_returns_delta_and_contribution(monkeypatch):
    from backend.app import config as cfg
    monkeypatch.setattr(cfg.settings, "mock", True)  # 走 mock 路径
    payload = {
        "question": "X 对 Y 有效吗?",
        "phase": "generate",
        "references": [{"ref_key": "k0", "title": "t", "first_author": "A", "year": "2024"}],
        "evidence": [],
        "deep_read_targets": [],
        "english_report": False,
    }
    resp = client.post("/api/deep_research/stream", json=payload)
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    kinds = [e for e, _ in events]
    assert "delta" in kinds
    assert "contribution_table" in kinds
    assert "done" in kinds
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_stream.py -v
```

- [ ] **Step 3: 实现主流程**

追加到 `backend/app/deep_research.py`:

```python
# ── 主流程 (SSE 编排) ─────────────────────────────────────────

async def deep_research_stream(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    from . import literature, searchfilters

    question = (inputs.get("question") or "").strip()
    field = (inputs.get("field") or "").strip()
    background = (inputs.get("background") or "").strip()
    phase = (inputs.get("phase") or "generate").strip()
    english = bool(inputs.get("english_report"))
    project_id = inputs.get("project_id")

    if not question:
        yield ("error", {"message": "请填写研究问题。"})
        return

    if phase == "search":
        # 复用现有检索层。用 question 作为 "field"; 无关键词。
        depth = (inputs.get("depth") or "deep").strip()
        sources = inputs.get("sources") or ["pubmed", "europepmc", "openalex", "crossref", "unpaywall"]
        filters = searchfilters.normalize(inputs.get("filters"))
        try:
            yield ("status", {"message": "正在检索相关文献…"})
            # 复用 literature.search_literature 的返回;它已产 references + evidence 事件
            async for evt, data in literature.search_literature_stream(
                field=question, keywords="", background=background,
                depth=depth, sources=sources, filters=filters,
            ):
                yield (evt, data)
            yield ("done", {})
        except Exception as e:  # noqa: BLE001
            print("[deep_research:search]\n" + traceback.format_exc(), flush=True)
            yield ("error", {"message": f"检索失败: {type(e).__name__}: {e}"})
        return

    # phase == "generate"
    refs = inputs.get("references") or []
    evidence = inputs.get("evidence") or []
    targets = inputs.get("deep_read_targets") or []

    if not refs:
        yield ("error", {"message": "请至少勾选一篇文献。"})
        return

    # 1. 深读
    deep_chunks: dict[str, str] = {}
    deep_read_keys: set[str] = set()
    if targets:
        yield ("status", {"message": f"正在深读 {len(targets)} 篇文献全文…"})
        async for evt, data in fetch_deep_reads_stream(targets, project_id):
            yield (evt, data)
            if evt == "deep_read_result" and data.get("ok"):
                deep_chunks[data["ref_key"]] = data["chunk"]
                deep_read_keys.add(data["ref_key"])
            elif evt == "deep_read_result" and not data.get("ok"):
                yield ("warning", {"message": f"深读失败 [{data.get('ref_key')}]: {data.get('error')}"})

    if targets and not deep_chunks:
        yield ("warning", {"message": "全部深读失败,将仅用摘要合成。"})

    # 2. 合成 4 段报告
    yield ("status", {"message": "正在合成调研报告…"})
    report_buf = ""
    async for evt, data in synthesize_stream(
        question=question, field=field, background=background,
        refs=refs, evidence=evidence, deep_read_chunks=deep_chunks, english=english,
    ):
        if evt == "delta":
            report_buf += data.get("text", "")
        yield (evt, data)

    # 3. 贡献表 (二次 LLM 调用)
    try:
        yield ("status", {"message": "正在生成贡献表…"})
        rows = await build_contribution_table(
            question=question, report=report_buf, refs=refs, deep_read_keys=deep_read_keys,
        )
        yield ("contribution_table", {"rows": rows})
    except Exception as e:  # noqa: BLE001
        yield ("warning", {"message": f"贡献表生成失败: {e}"})

    yield ("done", {})
```

**注意**: `literature.search_literature_stream` 若不存在,查阅 `literature.py` 找到现有的对应函数 (可能叫 `search_literature` 但返回 tuple)。若返回不是 async iter,需在此 wrapper 一层。

- [ ] **Step 4: 添加 route**

追加到 `backend/app/routes/deep_research_routes.py`:

```python
class DeepResearchStreamReq(BaseModel):
    question: str = ""
    field: str = ""
    background: str = ""
    depth: str = "deep"
    sources: list[str] | None = None
    filters: dict | None = None
    phase: str = "generate"
    references: list[dict] | None = None
    evidence: list[dict] | None = None
    deep_read_targets: list[dict] | None = None
    english_report: bool = False
    project_id: str | None = None


@router.post("/api/deep_research/stream")
async def deep_research_stream_ep(req: DeepResearchStreamReq):
    async def gen():
        async for event, data in dr.deep_research_stream(req.model_dump()):
            yield _sse(event, data)
    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
```

- [ ] **Step 5: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_stream.py -v
```

Expected: 1/1 PASS。

- [ ] **Step 6: Commit**

```bash
git add backend/app/deep_research.py backend/app/routes/deep_research_routes.py backend/test_deep_research_stream.py
git commit -m "feat(deep_research): stream 端点 (search/generate 两 phase, SSE 编排)"
```

---

## Task 8: 后端 - 追问端点

**Files:**
- Modify: `backend/app/deep_research.py`, `backend/app/routes/deep_research_routes.py`
- Test: `backend/test_deep_research_followup.py`

- [ ] **Step 1: 先写失败的测试**

创建 `backend/test_deep_research_followup.py`:

```python
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app

client = TestClient(app)


def _parse_sse(text): 
    out = []
    for chunk in text.strip().split("\n\n"):
        lines = chunk.splitlines()
        event = next((ln[7:] for ln in lines if ln.startswith("event: ")), "")
        data = next((ln[6:] for ln in lines if ln.startswith("data: ")), "")
        if event: out.append((event, data))
    return out


def test_followup_ask_streams_delta(monkeypatch):
    from backend.app import config as cfg
    monkeypatch.setattr(cfg.settings, "mock", True)
    payload = {
        "mode": "ask", "question": "第一篇的样本量?",
        "report": "研究显示 X [ref-k0]。", "references": [{"ref_key": "k0", "title": "t"}], 
        "evidence": [], "english_report": False,
    }
    resp = client.post("/api/deep_research/followup/stream", json=payload)
    assert resp.status_code == 200
    kinds = [e for e, _ in _parse_sse(resp.text)]
    assert "delta" in kinds
    assert "done" in kinds
```

- [ ] **Step 2: 运行确认失败**

```bash
python -m pytest backend/test_deep_research_followup.py -v
```

- [ ] **Step 3: 实现追问**

追加到 `backend/app/deep_research.py`:

```python
# ── 追问 ─────────────────────────────────────────────────────

def _followup_messages(mode: str, question: str, report: str, refs: list[dict], evidence: list[dict], english: bool) -> list[dict]:
    lang = "英文" if english else "中文"
    refs_block = _refs_block(refs, evidence)
    if mode == "ask":
        system = f"回答用户对报告的追问,用{lang}。仅基于给定文献,答案末尾用 [ref-KEY] 标注支持文献。"
        user = f"报告:\n{report[:3000]}\n\n文献:\n{refs_block}\n\n追问:{question}"
    else:  # revise
        system = f"根据用户意见修订原报告, 保持 4 段模板 (一/二/三/四), 用{lang}。"
        user = f"原报告:\n{report}\n\n文献:\n{refs_block}\n\n用户意见:{question}\n\n请输出修订后的完整报告。"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def followup_stream(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = inputs.get("mode") or "ask"
    q = (inputs.get("question") or "").strip()
    if not q:
        yield ("error", {"message": "请填写追问内容"})
        return
    report = inputs.get("report") or ""
    refs = inputs.get("references") or []
    evidence = inputs.get("evidence") or []
    english = bool(inputs.get("english_report"))

    if settings.mock:
        for ch in f"[MOCK-{mode}] 已收到追问: {q}\n":
            yield ("delta", {"text": ch})
        if mode == "revise":
            yield ("verify", _verify_report_citations(report, refs))
        yield ("done", {})
        return

    buf = ""
    async for piece in stream_chat(
        _followup_messages(mode, q, report, refs, evidence, english),
        task="research",
    ):
        buf += piece
        yield ("delta", {"text": piece})
    if mode == "revise":
        yield ("verify", _verify_report_citations(buf, refs))
    yield ("done", {})
```

- [ ] **Step 4: 添加 route**

追加到 `backend/app/routes/deep_research_routes.py`:

```python
class FollowupReq(BaseModel):
    mode: str = "ask"
    question: str = ""
    report: str = ""
    references: list[dict] | None = None
    evidence: list[dict] | None = None
    english_report: bool = False


@router.post("/api/deep_research/followup/stream")
async def deep_research_followup_ep(req: FollowupReq):
    async def gen():
        async for event, data in dr.followup_stream(req.model_dump()):
            yield _sse(event, data)
    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
```

- [ ] **Step 5: 运行确认通过**

```bash
python -m pytest backend/test_deep_research_followup.py -v
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/deep_research.py backend/app/routes/deep_research_routes.py backend/test_deep_research_followup.py
git commit -m "feat(deep_research): followup 端点 (ask/revise 两 mode)"
```

---

## Task 9: 前端 - 抽出 `AttachmentUploadBox` 组件

**Files:**
- Create: `frontend/src/components/AttachmentUploadBox.tsx`
- Modify: `frontend/src/modules/IdeaModule.tsx`

- [ ] **Step 1: 创建 `AttachmentUploadBox.tsx`**

创建 `frontend/src/components/AttachmentUploadBox.tsx`:

```tsx
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import AttachmentChips from "./AttachmentChips";

interface Props {
  label: string;                 // 字段标签,如 "相关资料"、"上传文献"
  hint?: string;                 // 说明文字
  textValue?: string;            // 文本 textarea 值 (仅"相关资料"型用);不传则不渲染文本框
  onTextChange?: (v: string) => void;
  pendingFiles: File[];
  onFilesAdd: (files: File[]) => void;
  onFileRemove: (index: number) => void;
  disabled?: boolean;
  accept?: string;
  testId: string;
  placeholder?: string;
  rows?: number;
}

export default function AttachmentUploadBox(props: Props) {
  const {
    label, hint, textValue, onTextChange,
    pendingFiles, onFilesAdd, onFileRemove, disabled,
    accept = ".docx,.pdf,.txt,.md", testId, placeholder, rows = 4,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const ingest = (fl: FileList | File[] | null | undefined) => {
    const list = fl ? Array.from(fl) : [];
    if (list.length === 0) return;
    onFilesAdd(list);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="field" data-testid={testId}>
      <span className="field-label">{label}</span>
      <div
        className={`combo-input${drag ? " dragover" : ""}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setDrag(false); ingest(e.dataTransfer.files); }}
      >
        {onTextChange !== undefined && (
          <textarea
            data-testid={`${testId}-text`}
            value={textValue || ""}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
          />
        )}
        <div className="combo-foot">
          <button
            type="button" className="combo-attach"
            data-testid={`${testId}-attach`}
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            📎 添加附件 (可多选)
          </button>
          {hint && <span className="combo-hint">{hint}</span>}
          <input
            ref={fileRef}
            data-testid={`${testId}-input`}
            type="file"
            accept={accept}
            multiple
            style={{ display: "none" }}
            onChange={(e: ChangeEvent<HTMLInputElement>) => ingest(e.target.files)}
          />
        </div>
        <AttachmentChips
          files={pendingFiles}
          onRemove={onFileRemove}
          disabled={disabled}
          testId={`${testId}-chips`}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 替换 `IdeaModule.tsx` Step 1 的 inline 代码**

在 `frontend/src/modules/IdeaModule.tsx` 顶部 imports 后加:

```tsx
import AttachmentUploadBox from "../components/AttachmentUploadBox";
```

替换 Step 1 中"相关资料"字段的整块 `<div className="field" data-testid="background-field">…</div>` (约 lines 503-541) 为:

```tsx
<AttachmentUploadBox
  label="相关资料 (可选)"
  hint="支持 Word / PDF / txt, 将在开始检索时解析"
  textValue={background}
  onTextChange={setBackground}
  pendingFiles={pendingAttachments}
  onFilesAdd={(files) => setPendingAttachments((prev) => [...prev, ...files])}
  onFileRemove={removeAttachment}
  disabled={running}
  testId="background-field"
  placeholder="粘贴你之前的研究/综述/草案,或把 Word/PDF/txt 文件直接拖进这个框 (可多个) 作为背景。"
  rows={4}
/>
```

**测试保留**: `data-testid="background-field"`, `background-field-attach`, `background-field-input`, `background-field-chips`, `background-field-text` 都必须保留 (对应原 `combo-attach`, `upload-doc`, `idea-attach-chips`, `input-background`)。旧 testid 别名可通过在 AttachmentUploadBox 里额外挂:

```tsx
data-testid-alias="combo-attach"   // 或者在 IdeaModule 里同步改 e2e 断言
```

**决策**: 若查证现有 e2e/回归确认没有硬编码 `combo-attach`/`upload-doc`/`idea-attach-chips`/`input-background`,直接改新 testid 即可。运行:

```bash
grep -rn "combo-attach\|upload-doc\|idea-attach-chips\|input-background" backend frontend tests 2>/dev/null | grep -v node_modules
```

若查到硬编码,在这一步一并修改断言指到新 testid;若查不到,忽略。

- [ ] **Step 3: 手动开发者验证**

```bash
cd frontend && npm run dev
```

访问 `http://localhost:5173/`,进入"找选题",Step 1 应能:
- 拖入 PDF/DOCX
- 点击"📎 添加附件"打开文件选择器
- 显示已选文件 chips 并可删除
- 文本框输入不受影响

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AttachmentUploadBox.tsx frontend/src/modules/IdeaModule.tsx
git commit -m "refactor: 抽出 AttachmentUploadBox 供深度调研模块复用"
```

---

## Task 10: 前端 - 抽出 `FollowupPanel` 组件

**Files:**
- Create: `frontend/src/components/FollowupPanel.tsx`
- Modify: `frontend/src/modules/IdeaModule.tsx`

- [ ] **Step 1: 创建 `FollowupPanel.tsx`**

创建 `frontend/src/components/FollowupPanel.tsx`:

```tsx
import { useRef, useState } from "react";
import Markdown from "./Markdown";

export interface FollowupItem { q: string; a: string; }

interface Props {
  followups: FollowupItem[];
  onAddFollowup: (item: FollowupItem) => void;
  onReviseReport: (revised: string) => void;
  onVerifyUpdate?: (verify: unknown) => void;
  streamFn: (
    payload: {
      mode: "ask" | "revise"; question: string; report: string;
      references: unknown[]; evidence: unknown[]; english_report: boolean;
    },
    callbacks: {
      signal: AbortSignal;
      onDelta: (t: string) => void;
      onVerify?: (v: unknown) => void;
      onError: (msg: string) => void;
      onDone: () => void;
    },
  ) => Promise<void>;
  currentReport: string;
  references: unknown[];
  evidence: unknown[];
  englishReport: boolean;
  disabled?: boolean;
  testId?: string;
}

export default function FollowupPanel(props: Props) {
  const {
    followups, onAddFollowup, onReviseReport, onVerifyUpdate,
    streamFn, currentReport, references, evidence, englishReport,
    disabled, testId = "followup",
  } = props;

  const [input, setInput] = useState("");
  const [current, setCurrent] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const run = async (mode: "ask" | "revise") => {
    const q = input.trim();
    if (!q || running || disabled) return;
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    let buf = "";
    if (mode === "ask") setCurrent("…"); else onReviseReport("");
    await streamFn(
      { mode, question: q, report: currentReport, references, evidence, english_report: englishReport },
      {
        signal: ctrl.current.signal,
        onDelta: (t) => {
          buf += t;
          if (mode === "ask") setCurrent(buf);
          else onReviseReport(currentReport + buf); // stream 到父端
        },
        onVerify: (v) => { if (mode === "revise" && onVerifyUpdate) onVerifyUpdate(v); },
        onError: (m) => { setError(m); setRunning(false); },
        onDone: () => {
          if (mode === "ask") { onAddFollowup({ q, a: buf }); setCurrent(""); }
          setInput(""); setRunning(false);
        },
      },
    );
    setRunning(false);
  };

  return (
    <div className="followup" data-testid={testId}>
      <div className="followup-head">追问 / 修改意见</div>
      <p className="followup-tip">
        可针对某篇文献或某条结论追问, 或提出意见让 AI 修订报告。回答仍只基于本次检索到的真实文献。
      </p>
      {followups.length > 0 && (
        <div className="qa-list" data-testid={`${testId}-list`}>
          {followups.map((qa, i) => (
            <div key={i} className="qa-item">
              <div className="qa-q">❓ {qa.q}</div>
              <div className="qa-a"><Markdown>{qa.a}</Markdown></div>
            </div>
          ))}
        </div>
      )}
      {running && current && (
        <div className="qa-item">
          <div className="qa-a"><Markdown>{current}</Markdown><span className="cursor-blink">▍</span></div>
        </div>
      )}
      <textarea
        data-testid={`${testId}-input`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="例如: 第 3 篇的样本量是多少? / 请把结论段扩写一些"
        rows={2}
        disabled={running}
      />
      {error && <div className="result-error">{error}</div>}
      <div className="form-actions">
        <button className="btn-primary" data-testid={`${testId}-ask`} onClick={() => run("ask")} disabled={!input.trim() || running || disabled}>追问</button>
        <button className="btn-ghost" data-testid={`${testId}-revise`} onClick={() => run("revise")} disabled={!input.trim() || running || disabled}>按此修改报告</button>
        {running && (
          <button className="btn-ghost" data-testid={`${testId}-stop`} onClick={() => { ctrl.current?.abort(); setRunning(false); }}>停止</button>
        )}
        {running && <span className="status-line"><span className="spinner" /> 处理中…</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 替换 IdeaModule.tsx Step 4 的追问块**

找到 IdeaModule.tsx 中 `{text && !running && (<div className="followup" data-testid="followup">…</div>)}` 整块 (约 lines 1038-1071),替换为:

```tsx
{text && !running && (
  <FollowupPanel
    testId="followup"
    followups={followups}
    onAddFollowup={(item) => setFollowups((prev) => [...prev, item])}
    onReviseReport={setText}
    onVerifyUpdate={setVerify as (v: unknown) => void}
    streamFn={(payload, cb) => streamIdeaFollowup(payload as unknown as Parameters<typeof streamIdeaFollowup>[0], cb as unknown as Parameters<typeof streamIdeaFollowup>[1])}
    currentReport={text}
    references={refs}
    evidence={evidence}
    englishReport={englishReport}
  />
)}
```

删除对应的 useState (followupInput / currentAnswer / fRunning / fError / fctrl) 与 runFollowup 函数。

- [ ] **Step 3: 加 import**

在 IdeaModule.tsx 顶部:

```tsx
import FollowupPanel from "../components/FollowupPanel";
```

- [ ] **Step 4: 手动验证 IdeaModule 追问仍工作**

```bash
cd frontend && npm run dev
```

进入"找选题",走完生成报告后测试:
- 追问一条,答案 stream 显示
- "按此修改报告" 修订流写回正文
- 停止按钮生效

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FollowupPanel.tsx frontend/src/modules/IdeaModule.tsx
git commit -m "refactor: 抽出 FollowupPanel 供深度调研复用 (IdeaModule 行为不变)"
```

---

## Task 11: 前端 - 抽出 `ReportExportBar` 组件

**Files:**
- Create: `frontend/src/components/ReportExportBar.tsx`
- Modify: `frontend/src/modules/IdeaModule.tsx`

- [ ] **Step 1: 创建 `ReportExportBar.tsx`**

创建 `frontend/src/components/ReportExportBar.tsx`:

```tsx
import { useState } from "react";
import type { Reference } from "../lib/sse";
import { downloadText, downloadDocxFromText, downloadPdfFromText, tsName } from "../lib/download";
import { copyToClipboard } from "../lib/clipboard";
import { stripSupportQuotes } from "../lib/exportPrep";

interface Props {
  text: string;
  refs: Reference[];
  title: string;                                 // 报告主题 (导出文件名前缀)
  extraMarkdown?: string;                        // 追加在正文后 (如选题卡候选段)
  running: boolean;
  reportCollapsed: boolean;
  onToggleCollapsed: () => void;
  onCopyDone?: () => void;
  onStatus?: (msg: string) => void;
  extraLeadingActions?: React.ReactNode;         // 用于加"送到实验规划"等按钮
  extraTrailingActions?: React.ReactNode;
  testIdPrefix?: string;
}

export default function ReportExportBar(props: Props) {
  const {
    text, refs, title, extraMarkdown = "",
    running, reportCollapsed, onToggleCollapsed, onCopyDone, onStatus,
    extraLeadingActions, extraTrailingActions, testIdPrefix = "",
  } = props;
  const [wordBusy, setWordBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refMd = refs.length
    ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
    : "";
  const compose = () => stripSupportQuotes(text) + extraMarkdown + refMd;

  if (running || !text) return null;

  return (
    <div className="result-actions">
      {extraLeadingActions}
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}toggle-report-btn`}
        onClick={onToggleCollapsed}
        title={reportCollapsed ? "展开调研报告" : "折叠调研报告"}
      >
        {reportCollapsed ? "展开报告 ▾" : "折叠报告 ▴"}
      </button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}copy-report-btn`}
        onClick={async () => {
          const ok = await copyToClipboard(compose());
          if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); onCopyDone?.(); }
          else onStatus?.("复制失败:请手动选择复制");
        }}
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-md-btn`}
        onClick={() => downloadText(tsName(title, "md"), compose())}
      >导出 Markdown</button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-docx-btn`}
        disabled={wordBusy}
        onClick={async () => {
          setWordBusy(true);
          try { await downloadDocxFromText(tsName(title, "docx"), compose()); }
          catch (e) { onStatus?.(`导出 Word 失败:${(e as Error).message}`); }
          finally { setWordBusy(false); }
        }}
      >{wordBusy ? "导出中…" : "导出 Word"}</button>
      <button
        className="btn-ghost" data-testid={`${testIdPrefix}export-pdf-btn`}
        disabled={wordBusy}
        onClick={async () => {
          setWordBusy(true);
          try { await downloadPdfFromText(tsName(title, "pdf"), compose(), title); }
          catch (e) { onStatus?.(`导出 PDF 失败:${(e as Error).message}`); }
          finally { setWordBusy(false); }
        }}
      >{wordBusy ? "导出中…" : "导出 PDF"}</button>
      {extraTrailingActions}
    </div>
  );
}
```

- [ ] **Step 2: 替换 IdeaModule.tsx 中的 result-actions 块**

在 IdeaModule.tsx Step 4 中,找到 `<div className="result-actions">…</div>` 那一大坨 (约 lines 823-908),替换为:

```tsx
<ReportExportBar
  text={text}
  refs={refs}
  title="选题调研"
  extraMarkdown={candidatesMd(card)}
  running={running}
  reportCollapsed={reportCollapsed}
  onToggleCollapsed={() => setReportCollapsed((v) => !v)}
  onStatus={setStatus}
  extraLeadingActions={
    <>
      {running && <button className="btn-ghost" onClick={stop} data-testid="stop-btn">停止</button>}
      {text && !running && (!card || card.candidates.length === 0) && (
        <button className="btn-ghost" data-testid="send-to-plan-btn" onClick={() => {
          /* 保留原覆盖确认逻辑 (从 IdeaModule 原来那段拷回) */
        }}>用此结果做实验规划 →</button>
      )}
    </>
  }
/>
```

**注意**: 原"用此结果做实验规划"的 onClick 逻辑较复杂,保留完整拷贝进 `extraLeadingActions` 里。

- [ ] **Step 3: 加 import**

```tsx
import ReportExportBar from "../components/ReportExportBar";
```

- [ ] **Step 4: 手动验证导出仍工作**

```bash
cd frontend && npm run dev
```

进入"找选题",跑完报告后:
- 复制 → 剪贴板有内容
- 导出 MD/Word/PDF 各下载一次

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ReportExportBar.tsx frontend/src/modules/IdeaModule.tsx
git commit -m "refactor: 抽出 ReportExportBar 供深度调研复用"
```

---

## Task 12: 前端 - `uploadedLit.ts` 辅助 + sse.ts 类型扩展

**Files:**
- Create: `frontend/src/lib/uploadedLit.ts`
- Modify: `frontend/src/lib/sse.ts`

- [ ] **Step 1: 创建 `uploadedLit.ts`**

创建 `frontend/src/lib/uploadedLit.ts`:

```ts
import { apiUrl } from "./api";
import type { Reference } from "./sse";

export interface UploadedRef {
  upload_id: string;
  title: string;
  first_author: string;
  year: string;
  abstract: string;
  full_text_available: boolean;
  page_count: number;
  parse_confidence: "high" | "low";
}

export async function parseUpload(file: File, projectId: string | null): Promise<UploadedRef | { error: string }> {
  const fd = new FormData();
  fd.append("file", file);
  if (projectId) fd.append("project_id", projectId);
  const r = await fetch(apiUrl("/api/deep_research/parse_upload"), { method: "POST", body: fd });
  const data = await r.json();
  if (!r.ok || data.ok === false) return { error: data.error || `解析失败 (${r.status})` };
  return data as UploadedRef;
}

export async function lookupTitle(title: string): Promise<{ found: boolean; abstract?: string; first_author?: string; year?: string; url?: string; doi?: string }> {
  const r = await fetch(apiUrl("/api/deep_research/lookup_title"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return r.json();
}

export function uploadedToReference(u: UploadedRef): Reference & { upload_id: string; full_text_available: boolean; parse_confidence: "high" | "low" } {
  return {
    pmid: "",
    title: u.title,
    first_author: u.first_author,
    year: u.year,
    journal: "",
    url: "",
    abstract: u.abstract,
    source: "upload",
    upload_id: u.upload_id,
    full_text_available: u.full_text_available,
    parse_confidence: u.parse_confidence,
  } as Reference & { upload_id: string; full_text_available: boolean; parse_confidence: "high" | "low" };
}

/** 前端估算深读 token 成本 (~4 char/token; 章节截断预算 8k/篇)。*/
export function estimateDeepReadTokens(refs: { page_count?: number }[]): number {
  return refs.reduce((sum, r) => sum + Math.min(8000, (r.page_count ?? 8) * 500), 0);
}
```

- [ ] **Step 2: 在 `sse.ts` 添加深度调研流函数**

先查看现有 `streamIdea` 签名以对齐:

```bash
grep -n "export.*streamIdea\|type Reference\|type EvidenceItem\|export.*streamIdeaFollowup" frontend/src/lib/sse.ts
```

追加到 `frontend/src/lib/sse.ts`:

```ts
// ── 深度调研 ─────────────────────────────────────────────────

export interface RecommendItem { ref_key: string; score: "high" | "medium" | "none"; reason: string; }

export interface ContributionRow {
  n: number;
  author_year: string;
  journal: string;
  design: string;
  sample: string;
  finding: string;
  relevance: "direct" | "indirect" | "supporting";
  deep_read: boolean;
}

export interface DeepReadTarget {
  ref_key: string;
  source: "upload" | "oa" | "europepmc" | "crossref";
  upload_id?: string;
  oa_url?: string;
}

export interface DeepResearchPayload {
  question: string;
  field?: string;
  background?: string;
  depth?: string;
  sources?: string[];
  filters?: unknown;
  phase: "search" | "generate";
  references?: Reference[];
  evidence?: EvidenceItem[];
  deep_read_targets?: DeepReadTarget[];
  english_report?: boolean;
  project_id?: string | null;
}

export interface DeepResearchCallbacks {
  signal: AbortSignal;
  onStatus?: (msg: string) => void;
  onReferences?: (items: Reference[]) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  onDeepReadProgress?: (p: { done: number; total: number; current_ref_key: string }) => void;
  onDelta: (text: string) => void;
  onContributionTable?: (rows: ContributionRow[]) => void;
  onVerify?: (v: Verification) => void;
  onWarning?: (msg: string) => void;
  onError: (msg: string) => void;
  onDone: () => void;
}

export async function streamDeepResearch(payload: DeepResearchPayload, cb: DeepResearchCallbacks): Promise<void> {
  await streamSSE(apiUrl("/api/deep_research/stream"), payload, cb.signal, (event, data) => {
    switch (event) {
      case "status": cb.onStatus?.(data.message); break;
      case "references": cb.onReferences?.(data.items); break;
      case "evidence": cb.onEvidence?.(data.items); break;
      case "deep_read_progress": cb.onDeepReadProgress?.(data); break;
      case "delta": cb.onDelta(data.text); break;
      case "contribution_table": cb.onContributionTable?.(data.rows); break;
      case "verify": cb.onVerify?.(data); break;
      case "warning": cb.onWarning?.(data.message); break;
      case "error": cb.onError(data.message); break;
      case "done": cb.onDone(); break;
    }
  });
}

export async function streamDeepResearchRecommend(
  payload: { question: string; refs: { ref_key: string; title: string; abstract: string }[] },
): Promise<{ ok: boolean; items?: RecommendItem[]; error?: string }> {
  const r = await fetch(apiUrl("/api/deep_research/recommend"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return r.json();
}

export async function streamDeepResearchFollowup(
  payload: {
    mode: "ask" | "revise"; question: string; report: string;
    references: Reference[]; evidence: EvidenceItem[]; english_report?: boolean;
  },
  cb: {
    signal: AbortSignal;
    onDelta: (t: string) => void;
    onVerify?: (v: Verification) => void;
    onError: (m: string) => void;
    onDone: () => void;
  },
): Promise<void> {
  await streamSSE(apiUrl("/api/deep_research/followup/stream"), payload, cb.signal, (event, data) => {
    switch (event) {
      case "delta": cb.onDelta(data.text); break;
      case "verify": cb.onVerify?.(data); break;
      case "error": cb.onError(data.message); break;
      case "done": cb.onDone(); break;
    }
  });
}
```

**注意**: `streamSSE` 是现有内部函数,查阅 sse.ts 顶部 `streamIdea` 的实现照抄结构。若函数名不同 (可能叫 `runStream` / `openSSE`),对齐即可。

- [ ] **Step 3: 类型检查通过**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 无 error。有 error 则修复 (通常是 Reference/EvidenceItem/Verification 未 export)。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/uploadedLit.ts frontend/src/lib/sse.ts
git commit -m "feat(deep_research): 前端 API/SSE 客户端 + 上传辅助"
```

---

## Task 13: 前端 - 开发者模式开关

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 添加开发者模式 hook 与 NAV.dev 字段**

在 App.tsx 顶部加:

```tsx
function useDevMode(): [boolean, (v: boolean) => void] {
  return usePersistentState<boolean>("dev:mode", false);
}
```

修改 `ModuleId` 类型:

```tsx
export type ModuleId = "home" | "idea" | "research" | "grant" | "plan" | "ethics" | "analyze" | "imrad" | "journal" | "format" | "checklist" | "poster" | "rebuttal" | "history";
```

修改 `NAV` 类型和数组 (在 idea 后插入 research):

```tsx
const NAV: { id: ModuleId; icon: ReactNode; title: string; desc: string; hidden?: boolean; dev?: boolean }[] = [
  { id: "idea",     icon: <Lightbulb {...ICON_PROPS} />,    title: "找选题",     desc: "发现研究方向与创新点" },
  { id: "research", icon: <Microscope {...ICON_PROPS} />,   title: "深度调研",   desc: "针对研究问题的循证综合",     dev: true },
  { id: "grant",    icon: <FileSignature {...ICON_PROPS} />, title: "写标书",     desc: "把选题写成中文基金申请书初稿" },
  // ... 其余保持不变
];
```

加 import:

```tsx
import { Lightbulb, Map, ..., Microscope } from "lucide-react";
```

在 `App` 函数体内使用:

```tsx
const [devMode, setDevMode] = useDevMode();
const visibleNav = NAV.filter((m) => !m.hidden && (devMode || !m.dev));
```

把所有 `NAV.filter((m) => !m.hidden)` 出现的地方 (sidebar nav、rail-ticks、Home 卡片、CommandPalette modules 属性) 改为 `visibleNav`。

- [ ] **Step 2: 添加设置下拉菜单**

在 App.tsx 找到设置按钮 (约 line 347-355):

```tsx
<button className="settings-btn" ...>⚙ 设置</button>
```

替换为下拉:

```tsx
<div className="settings-menu" data-testid="settings-menu">
  <button
    className="settings-btn"
    data-testid="open-settings-menu"
    onClick={(e) => {
      const menu = (e.currentTarget.nextSibling as HTMLElement | null);
      if (menu) menu.classList.toggle("open");
    }}
    aria-label="设置"
    title="设置"
  >
    ⚙ 设置
  </button>
  <div className="settings-dropdown" onClick={(e) => (e.currentTarget as HTMLElement).classList.remove("open")}>
    <button
      className="settings-item"
      data-testid="settings-api"
      onClick={() => setOnboardingOpen(true)}
    >
      API / 模型设置
    </button>
    <label className="settings-item settings-toggle" data-testid="settings-dev-mode">
      <input
        type="checkbox"
        checked={devMode}
        onChange={(e) => setDevMode(e.target.checked)}
      />
      开发者模式
    </label>
  </div>
</div>
```

- [ ] **Step 3: 加最小 CSS (styles.css 追加)**

追加到 `frontend/src/styles.css`:

```css
.settings-menu { position: relative; display: inline-block; }
.settings-dropdown {
  position: absolute; right: 0; top: calc(100% + 6px);
  background: var(--panel, #fff); border: 1px solid var(--border, #ddd);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.08);
  min-width: 200px; padding: 6px 0; display: none; z-index: 100;
}
.settings-dropdown.open { display: block; }
.settings-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px; background: transparent; border: none;
  text-align: left; cursor: pointer; font-size: 14px;
}
.settings-item:hover { background: var(--hover-bg, rgba(0,0,0,.05)); }
.settings-toggle { justify-content: space-between; }
```

- [ ] **Step 4: 处理 ResearchModule 未创建时的编译**

在 App.tsx `page` 里的 render 分支加占位:

```tsx
{active === "research" && <div style={{ padding: 24 }}>深度调研模块开发中...</div>}
```

- [ ] **Step 5: 手动验证**

```bash
cd frontend && npm run dev
```

- 默认打开时,侧栏、首页、命令面板都看不到"深度调研"
- 点击右上角"⚙ 设置" → dropdown 出现 → 勾选"开发者模式" → 侧栏立刻多出"深度调研"
- 取消勾选 → 立刻隐藏
- 若 active 是 research 时被隐藏,应回落到 home (可选; 若嫌复杂本次不处理)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/styles.css
git commit -m "feat: 开发者模式开关 + 深度调研 NAV 占位 (dev:true 默认隐藏)"
```

---

## Task 14: 前端 - ResearchModule Step 1 & Step 2 骨架

**Files:**
- Create: `frontend/src/modules/ResearchModule.tsx`

- [ ] **Step 1: 创建 ResearchModule 骨架 (state + Step 1 & 2 UI)**

创建 `frontend/src/modules/ResearchModule.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { streamDeepResearch, streamDeepResearchRecommend, streamDeepResearchFollowup, Reference, EvidenceItem, RecommendItem, ContributionRow, Verification } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import { parseAttachments, appendAttachmentsToField } from "../lib/attachments";
import { parseUpload, lookupTitle, uploadedToReference, estimateDeepReadTokens, UploadedRef } from "../lib/uploadedLit";
import AttachmentUploadBox from "../components/AttachmentUploadBox";
import { LiteraturePicker } from "../components/LiteraturePicker";
import EditableMarkdown from "../components/EditableMarkdown";
import WarningPanel from "../components/WarningPanel";
import FollowupPanel from "../components/FollowupPanel";
import ReportExportBar from "../components/ReportExportBar";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { useProjects } from "../lib/projects";
import { downloadCsv, tsName } from "../lib/download";
import type { Goto } from "../App";

const STUDY_TYPES = [
  { key: "rct", label: "随机对照试验" },
  { key: "meta", label: "Meta 分析" },
  { key: "systematic", label: "系统综述" },
  { key: "review", label: "综述" },
];

const DEFAULT_SOURCES = ["pubmed", "europepmc", "openalex", "crossref", "unpaywall"];

const STEPS = [
  { n: 1, title: "研究问题", desc: "问题 · 相关资料 · 上传文献" },
  { n: 2, title: "检索设置", desc: "年份 · 证据等级 · 质量" },
  { n: 3, title: "文献复核", desc: "查看 · 深读推荐 · 勾选" },
  { n: 4, title: "调研产出", desc: "报告 · 贡献表 · 追问" },
];

const refKeyOf = (r: Reference & { upload_id?: string }) => r.upload_id || r.pmid || r.url || r.title;

export default function ResearchModule({ goto }: { goto: Goto }) {
  const { current: project } = useProjects();
  const projectId = project?.id ?? null;

  // ── 表单字段 ────────────────────────────────────────────────
  const [question, setQuestion] = usePersistentState("research:question", "");
  const [field, setField] = usePersistentState("research:field", "");
  const [background, setBackground] = usePersistentState("research:background", "");
  const [depth, setDepth] = usePersistentState("research:depth", "deep");
  const [yearsBack, setYearsBack] = usePersistentState("research:yearsBack", "3");
  const [studyTypes, setStudyTypes] = usePersistentState<string[]>("research:studyTypes", STUDY_TYPES.map((s) => s.key));
  const [impactMin, setImpactMin] = usePersistentState("research:impactMin", "");
  const [minQuartile, setMinQuartile] = usePersistentState("research:minQuartile", "");
  const [keepUnknown, setKeepUnknown] = usePersistentState("research:keepUnknownImpact", true);
  const [englishReport, setEnglishReport] = usePersistentState("research:englishReport", false);

  // ── 向导步骤 ────────────────────────────────────────────────
  const [step, setStep] = usePersistentState<number>("research:step", 1);
  const [maxStep, setMaxStep] = usePersistentState<number>("research:maxStep", 1);
  const goStep = (n: number) => { setStep(n); if (n > maxStep) setMaxStep(n); };

  // ── 上传文献 & 相关资料附件 ────────────────────────────────
  const [uploadedRefs, setUploadedRefs] = usePersistentState<UploadedRef[]>("research:uploadedRefs", []);
  const [pendingLitFiles, setPendingLitFiles] = useState<File[]>([]);
  const [pendingBackgroundFiles, setPendingBackgroundFiles] = useState<File[]>([]);
  const [uploadParsing, setUploadParsing] = useState<{ done: number; total: number } | null>(null);
  const [uploadNeedingTitle, setUploadNeedingTitle] = useState<{ file: File; err?: string }[]>([]);

  // ── 检索结果 / 复核 ────────────────────────────────────────
  const [refs, setRefs] = usePersistentState<Reference[]>("research:refs", []);
  const [selectedKeys, setSelectedKeys] = usePersistentState<string[]>("research:selectedKeys", []);
  const [deepReadKeys, setDeepReadKeys] = usePersistentState<string[]>("research:deepReadKeys", []);
  const [refSort, setRefSort] = usePersistentState("research:refSort", "relevance");
  const [evidence, setEvidence] = usePersistentState<EvidenceItem[]>("research:evidence", []);
  const [recommend, setRecommend] = useState<Record<string, RecommendItem>>({});

  // ── 产出 ──────────────────────────────────────────────────
  const [text, setText] = usePersistentState("research:result", "");
  const [contribution, setContribution] = usePersistentState<ContributionRow[]>("research:contribution", []);
  const [verify, setVerify] = usePersistentState<Verification | null>("research:verify", null);
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("research:qa", []);
  const [reportCollapsed, setReportCollapsed] = useState(false);

  // ── 运行状态 ──────────────────────────────────────────────
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [deepReadProgress, setDeepReadProgress] = useState<{ done: number; total: number } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // ── 上传解析 (拖入即解析) ─────────────────────────────────
  const ingestLit = async (files: File[]) => {
    if (files.length === 0) return;
    setUploadParsing({ done: 0, total: files.length });
    const needTitle: { file: File; err?: string }[] = [];
    const good: UploadedRef[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setUploadParsing({ done: i, total: files.length });
      const res = await parseUpload(f, projectId);
      if ("error" in res) needTitle.push({ file: f, err: res.error });
      else if (res.parse_confidence === "low" && !res.title) needTitle.push({ file: f });
      else good.push(res);
    }
    setUploadedRefs((prev) => [...prev, ...good]);
    if (needTitle.length) setUploadNeedingTitle((prev) => [...prev, ...needTitle]);
    setUploadParsing(null);
  };

  const filtersPayload = () => ({
    year_from: yearsBack ? String(new Date().getFullYear() - Number(yearsBack) + 1) : "",
    study_types: studyTypes,
    min_quartile: minQuartile,
    min_impact: impactMin,
    keep_unknown: keepUnknown,
  });

  // 后续 Step 3/4 实现见后续 Task
  const runSearch = async () => { /* Task 15 */ };
  const runGenerate = async () => { /* Task 16 */ };
  const stop = () => { ctrl.current?.abort(); setRunning(false); setStatus(""); };

  const toggleStudyType = (key: string) => {
    setStudyTypes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };

  return (
    <div className="module idea-wizard">
      <header className="module-head">
        <h1>🔬 深度调研 · 医学/药学/生物</h1>
        <p>四步:研究问题 → 检索设置 → 文献复核 (含深读推荐) → 调研产出。</p>
      </header>

      <div className="wiz-steps" data-testid="wiz-steps">
        {STEPS.map((s) => {
          const state = step === s.n ? "current" : s.n < step ? "done" : "todo";
          const clickable = s.n <= maxStep;
          return (
            <button key={s.n} type="button" className={`wiz-step ${state}`}
              data-testid={`wiz-step-${s.n}`}
              disabled={!clickable}
              onClick={() => clickable && setStep(s.n)}
            >
              <span className="wiz-step-num">{s.n < step ? "✓" : s.n}</span>
              <span className="wiz-step-text">
                <span className="wiz-step-title">{s.title}</span>
                <span className="wiz-step-desc">{s.desc}</span>
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="result-error">{error}</div>}
      <WarningPanel warnings={warnings} onClear={() => setWarnings([])} testId="research-warnings" />

      {/* Step 1 */}
      {step === 1 && (
        <div className="wiz-panel" data-testid="wiz-panel-1">
          <div className="form">
            <label className="field">
              <span className="field-label">研究问题 <em>必填</em></span>
              <textarea
                data-testid="input-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如: PD-1 抑制剂能否改善三阴性乳腺癌患者的 OS? 与化疗相比不同亚组的效应差异如何?"
                rows={3}
              />
            </label>
            <label className="field">
              <span className="field-label">研究领域 (可选,用于消歧)</span>
              <input
                data-testid="input-field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="例如: 乳腺癌免疫治疗"
              />
            </label>
            <AttachmentUploadBox
              label="相关资料 (可选)"
              hint="Word / PDF / txt,将在开始检索时解析,作为背景注入"
              textValue={background}
              onTextChange={setBackground}
              pendingFiles={pendingBackgroundFiles}
              onFilesAdd={(fs) => setPendingBackgroundFiles((prev) => [...prev, ...fs])}
              onFileRemove={(i) => setPendingBackgroundFiles((prev) => prev.filter((_, k) => k !== i))}
              disabled={running}
              testId="background-field"
              placeholder="粘贴前置综述/背景, 或拖入 pdf/docx"
            />
            <div className="field" data-testid="upload-lit-field">
              <span className="field-label">上传文献 (可选,进入文献池)</span>
              <AttachmentUploadBox
                label=""
                hint={uploadParsing ? `解析中 ${uploadParsing.done}/${uploadParsing.total}` : "拖入或选择;解析后自动进入 Step 3 文献池"}
                pendingFiles={pendingLitFiles}
                onFilesAdd={async (fs) => {
                  setPendingLitFiles((prev) => [...prev, ...fs]);
                  await ingestLit(fs);
                  setPendingLitFiles([]);
                }}
                onFileRemove={(i) => setPendingLitFiles((prev) => prev.filter((_, k) => k !== i))}
                disabled={running || !!uploadParsing}
                testId="upload-lit-box"
              />
              {uploadedRefs.length > 0 && (
                <div className="uploaded-list" data-testid="uploaded-list">
                  已解析 {uploadedRefs.length} 篇:
                  <ul>
                    {uploadedRefs.map((u) => (
                      <li key={u.upload_id}>
                        {u.parse_confidence === "low" ? "❓ " : ""}
                        {u.title} {u.first_author && `— ${u.first_author}`} {u.year}
                        <button className="btn-ghost" onClick={() => setUploadedRefs((prev) => prev.filter((x) => x.upload_id !== u.upload_id))}>删</button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {uploadNeedingTitle.length > 0 && (
                <NeedTitleList
                  items={uploadNeedingTitle}
                  onResolved={(idx, ref) => {
                    setUploadNeedingTitle((prev) => prev.filter((_, i) => i !== idx));
                    if (ref) setUploadedRefs((prev) => [...prev, ref]);
                  }}
                />
              )}
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-primary" onClick={() => goStep(2)} disabled={!question.trim()} data-testid="wiz-next-1">
              下一步:检索设置 →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="wiz-panel" data-testid="wiz-panel-2">
          <div className="form">
            <label className="field">
              <span className="field-label">调研深度</span>
              <select data-testid="input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
                <option value="deep">深入 (多子方向 + 空白补检索)</option>
                <option value="fast">快速 (单轮检索)</option>
              </select>
            </label>
            <div className="field">
              <span className="field-label">时间范围</span>
              <div className="filter-row filter-chips">
                {([["1", "近 1 年"], ["2", "近 2 年"], ["3", "近 3 年"], ["4", "近 4 年"], ["5", "近 5 年"], ["", "不限"]] as const).map(([val, label]) => (
                  <label key={val || "all"} className={`type-chip${yearsBack === val ? " on" : ""}`}>
                    <input type="radio" name="research-years" data-testid={`years-${val || "all"}`}
                      checked={yearsBack === val} onChange={() => setYearsBack(val)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">证据等级 (勾选 = 保留)</span>
              <div className="filter-types">
                {STUDY_TYPES.map((s) => (
                  <label key={s.key} className={`type-chip${studyTypes.includes(s.key) ? " on" : ""}`}>
                    <input type="checkbox" data-testid={`type-${s.key}`}
                      checked={studyTypes.includes(s.key)} onChange={() => toggleStudyType(s.key)} />
                    {s.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">文献质量</span>
              <div className="filter-row filter-quality">
                <label>分区≥
                  <select data-testid="filter-quartile" value={minQuartile} onChange={(e) => setMinQuartile(e.target.value)}>
                    <option value="">不限</option>
                    <option value="1">仅 Q1</option>
                    <option value="2">Q1–Q2</option>
                    <option value="3">Q1–Q3</option>
                  </select>
                </label>
                <label>影响力≥
                  <input type="number" min="0" step="0.5" placeholder="不限"
                    data-testid="filter-impact"
                    value={impactMin} onChange={(e) => setImpactMin(e.target.value)}
                    style={{ width: "4.5em" }} />
                </label>
                <label className="type-chip">
                  <input type="checkbox" data-testid="filter-keep-unknown"
                    checked={keepUnknown} onChange={(e) => setKeepUnknown(e.target.checked)} />
                  保留无指标数据
                </label>
              </div>
            </div>
            <div className="field">
              <span className="field-label">报告语言</span>
              <label className="type-chip">
                <input type="checkbox" data-testid="english-report"
                  checked={englishReport} onChange={(e) => setEnglishReport(e.target.checked)} />
                用英语输出最终报告
              </label>
            </div>
          </div>
          <div className="wiz-nav">
            <button className="btn-ghost" onClick={() => setStep(1)} data-testid="wiz-back-2">← 上一步</button>
            <button className="btn-primary" onClick={runSearch} disabled={running || !question.trim()} data-testid="wiz-next-2">
              下一步:检索文献 →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 & 4 待后续 Task 补 */}
    </div>
  );
}

// ── 手输题名子组件 ────────────────────────────────────────────
function NeedTitleList({ items, onResolved }: {
  items: { file: File; err?: string }[];
  onResolved: (index: number, ref: UploadedRef | null) => void;
}) {
  return (
    <div className="need-title-list" data-testid="need-title-list">
      {items.map((it, idx) => (
        <NeedTitleRow key={idx} file={it.file} err={it.err}
          onSkip={() => onResolved(idx, null)}
          onSubmitTitle={async (title) => {
            const info = await lookupTitle(title);
            const upload_id = "typed_" + Math.random().toString(36).slice(2, 10);
            const ref: UploadedRef = {
              upload_id, title,
              first_author: info.first_author || "",
              year: info.year || "",
              abstract: info.abstract || "",
              full_text_available: false,
              page_count: 0,
              parse_confidence: "low",
            };
            onResolved(idx, ref);
          }}
        />
      ))}
    </div>
  );
}

function NeedTitleRow({ file, err, onSkip, onSubmitTitle }: {
  file: File; err?: string; onSkip: () => void; onSubmitTitle: (t: string) => void;
}) {
  const [title, setTitle] = useState("");
  return (
    <div className="need-title-row">
      <span>无法识别题名:{file.name} {err && `(${err})`}</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="请输入论文题目" />
      <button onClick={() => title.trim() && onSubmitTitle(title.trim())} disabled={!title.trim()}>提交</button>
      <button onClick={onSkip}>跳过</button>
    </div>
  );
}
```

- [ ] **Step 2: 挂到 App.tsx**

在 App.tsx 顶部加:

```tsx
import ResearchModule from "./modules/ResearchModule";
```

替换占位 `{active === "research" && <div>...</div>}` 为:

```tsx
{active === "research" && <ResearchModule goto={goto} />}
```

- [ ] **Step 3: 类型检查**

```bash
cd frontend && npx tsc --noEmit
```

修复所有类型错误。

- [ ] **Step 4: 手动验证 Step 1 & 2 可用**

```bash
cd frontend && npm run dev
```

- 开发者模式开 → 进"深度调研"
- Step 1 拖入 pdf/docx → 后端应命中 `/api/deep_research/parse_upload`,上传成功后显示在"已解析"列表
- Step 2 各筛选项可交互
- "下一步"按钮暂时不能真跑 (Step 15 才实现 runSearch)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modules/ResearchModule.tsx frontend/src/App.tsx
git commit -m "feat(research): Step 1 & 2 骨架 + 上传解析 + 手输题名回退"
```

---

## Task 15: 前端 - ResearchModule Step 3 (检索 + 深读推荐)

**Files:**
- Modify: `frontend/src/modules/ResearchModule.tsx`

- [ ] **Step 1: 实现 `runSearch` + Step 3 渲染**

在 ResearchModule 中替换 `runSearch` stub 为:

```tsx
const runSearch = async () => {
  if (!question.trim() || running) return;
  setError(null);
  let mergedBackground = background;
  // 相关资料附件解析 (沿用 IdeaModule 语义)
  if (pendingBackgroundFiles.length > 0) {
    const parseCtrl = new AbortController();
    ctrl.current = parseCtrl;
    setRunning(true);
    try {
      const parsed = await parseAttachments(pendingBackgroundFiles, {
        signal: parseCtrl.signal,
        onProgress: (p) => setStatus(`正在解析相关资料 ${p.index}/${p.total}: ${p.name}`),
      });
      mergedBackground = appendAttachmentsToField(background, parsed);
      setPendingBackgroundFiles([]);
    } catch (e) {
      setError((e as Error).message); setRunning(false); return;
    }
  }
  setRefs([]); setSelectedKeys([]); setDeepReadKeys([]); setEvidence([]);
  setText(""); setContribution([]); setVerify(null); setFollowups([]); setRecommend({});
  setStatus(""); setError(null); setWarnings([]); setRunning(true);
  goStep(3);
  ctrl.current = new AbortController();
  const uploadedAsRefs = uploadedRefs.map(uploadedToReference);
  await streamDeepResearch(
    {
      question, field, background: mergedBackground, depth,
      sources: DEFAULT_SOURCES,
      filters: filtersPayload(),
      phase: "search",
      project_id: projectId,
    },
    {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onReferences: (items) => {
        // 合并: 上传的 refs 置顶, 检索到的追加, 按 title/DOI 去重
        const norm = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
        const seen = new Set(uploadedAsRefs.map((r) => norm(r.title)));
        const merged: Reference[] = [...uploadedAsRefs];
        for (const r of items) {
          if (!seen.has(norm(r.title))) { merged.push(r); seen.add(norm(r.title)); }
        }
        setRefs(merged);
        setSelectedKeys(merged.map(refKeyOf));
      },
      onEvidence: setEvidence,
      onDelta: () => {},
      onWarning: (m) => setWarnings((prev) => [...prev, m]),
      onError: (m) => { setError(m); setStatus(""); setRunning(false); reportLLMError(m); },
      onDone: async () => {
        setStatus(""); setRunning(false); window.dispatchEvent(new Event("usage-updated"));
        // 触发深读推荐 (纯摘要 + question)
        try {
          const cur = readPersisted<Reference[]>("research:refs", []);
          const forRec = cur.map((r) => ({
            ref_key: refKeyOf(r as Reference & { upload_id?: string }),
            title: r.title || "",
            abstract: r.abstract || "",
          }));
          const res = await streamDeepResearchRecommend({ question, refs: forRec });
          if (res.ok && res.items) {
            const map: Record<string, RecommendItem> = {};
            const autoDeep: string[] = [];
            for (const it of res.items) {
              map[it.ref_key] = it;
              if (it.score === "high") autoDeep.push(it.ref_key);
            }
            setRecommend(map);
            setDeepReadKeys(autoDeep);
          }
        } catch {
          // 推荐失败不阻塞
        }
      },
    },
  );
  setRunning(false);
};
```

- [ ] **Step 2: 添加 Step 3 UI (LiteraturePicker + 深读列)**

在 ResearchModule return 里 Step 2 之后追加:

```tsx
{step === 3 && (
  <div className="wiz-panel" data-testid="wiz-panel-3">
    {status && <div className="status-line"><span className="spinner" /> {status}</div>}

    <div className="deep-read-bar" data-testid="deep-read-bar">
      <span>
        AI 推荐深读 <strong>{Object.values(recommend).filter((r) => r.score === "high").length}</strong> 篇(⭐);
        你已勾 <strong>{deepReadKeys.length}</strong> 篇,预计 ~
        <strong>{estimateDeepReadTokens(uploadedRefs.filter((u) => deepReadKeys.includes(u.upload_id))).toLocaleString()}</strong> tokens
      </span>
      <button className="btn-ghost" onClick={() => {
        const highs = Object.values(recommend).filter((r) => r.score === "high").map((r) => r.ref_key);
        setDeepReadKeys([...new Set([...deepReadKeys, ...highs])]);
      }}>全选推荐</button>
      <button className="btn-ghost" onClick={() => setDeepReadKeys([])}>清空深读</button>
    </div>

    <LiteraturePicker
      refs={refs}
      evidenceByKey={/* 按 refKeyOf 组织 */ (() => {
        const m: Record<string, EvidenceItem & { _ev_status?: string }> = {};
        const byUrl: Record<string, EvidenceItem> = {};
        const byTitle: Record<string, EvidenceItem> = {};
        for (const e of evidence) {
          if (e.url) byUrl[e.url.replace(/\/+$/, "")] = e;
          if (e.title) byTitle[e.title.trim().toLowerCase()] = e;
        }
        for (const r of refs) {
          const ev = byUrl[(r.url || "").replace(/\/+$/, "")] || byTitle[(r.title || "").trim().toLowerCase()];
          if (ev) m[refKeyOf(r as Reference & { upload_id?: string })] = ev as EvidenceItem & { _ev_status?: string };
        }
        return m;
      })()}
      selectedKeys={selectedKeys}
      onSelectionChange={setSelectedKeys}
      keyFn={(r) => refKeyOf(r as Reference & { upload_id?: string })}
      exportFilename="深度调研-文献"
      extraColumns={[
        {
          key: "recommend",
          header: "⭐",
          render: (r) => {
            const rec = recommend[refKeyOf(r as Reference & { upload_id?: string })];
            if (!rec || rec.score === "none") return <span>—</span>;
            return <span className={`rec-${rec.score}`} title={rec.reason}>{rec.score === "high" ? "⭐" : "○"}</span>;
          },
        },
        {
          key: "deep",
          header: "深读",
          render: (r) => {
            const k = refKeyOf(r as Reference & { upload_id?: string });
            return (
              <input
                type="checkbox"
                data-testid={`deep-${k}`}
                checked={deepReadKeys.includes(k)}
                onChange={(e) => {
                  if (e.target.checked) setDeepReadKeys((prev) => [...new Set([...prev, k])]);
                  else setDeepReadKeys((prev) => prev.filter((x) => x !== k));
                }}
              />
            );
          },
        },
      ]}
    />

    <div className="wiz-nav">
      <button className="btn-ghost" onClick={() => setStep(2)}>← 上一步</button>
      {running ? (
        <button className="btn-ghost" onClick={stop}>停止</button>
      ) : (
        <button className="btn-primary" onClick={runGenerate} disabled={selectedKeys.length === 0} data-testid="wiz-next-3">
          开始文献调研 (勾选 {selectedKeys.length} 篇, 深读 {deepReadKeys.length} 篇) →
        </button>
      )}
    </div>
  </div>
)}
```

**注意**: `LiteraturePicker` 目前不一定支持 `extraColumns` 属性。查阅它的 props 类型:

```bash
grep -n "interface.*LiteraturePickerProps\|extraColumns" frontend/src/components/LiteraturePicker.tsx
```

若无 `extraColumns` 支持,任选:
  - (A) 在 LiteraturePicker 加 `extraColumns?: Column[]` prop (~30 行改动)
  - (B) 用一个"外层深读横条 + 深读单独列表" 平铺展示 (更快, 但 UI 一致性差)

优先 (A) — 短小的增强。若 LiteraturePicker 内部用 `<ol>` 排,可以在每行 metadata 处 append。

- [ ] **Step 3: 类型检查 + 手动验证**

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run dev
```

- Step 1 填写研究问题, 上传 2 篇 PDF
- 点击 Step 2 → 下一步检索文献
- Step 3 应看到:上传的 2 篇 + 检索到的若干,置顶的是上传的
- 上部横条显示推荐 ≤ 8 篇高
- 勾选/取消深读复选框正常

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modules/ResearchModule.tsx frontend/src/components/LiteraturePicker.tsx
git commit -m "feat(research): Step 3 检索 + 深读推荐 (AI 打分 + 用户勾选)"
```

---

## Task 16: 前端 - ResearchModule Step 4 (合成 + 贡献表 + 追问)

**Files:**
- Modify: `frontend/src/modules/ResearchModule.tsx`

- [ ] **Step 1: 实现 `runGenerate`**

替换 `runGenerate` stub 为:

```tsx
const runGenerate = async () => {
  if (running) return;
  const sel = refs.filter((r) => selectedKeys.includes(refKeyOf(r as Reference & { upload_id?: string })));
  if (sel.length === 0) { setError("请至少勾选一篇文献"); return; }
  const selEvidence = evidence.filter((e) => sel.some((r) =>
    (r.url && r.url.replace(/\/+$/, "") === (e.url || "").replace(/\/+$/, ""))
    || (r.title && r.title.trim().toLowerCase() === (e.title || "").trim().toLowerCase())
  ));
  const deep_read_targets = sel
    .filter((r) => deepReadKeys.includes(refKeyOf(r as Reference & { upload_id?: string })))
    .map((r) => {
      const cast = r as Reference & { upload_id?: string; oa_url?: string };
      return {
        ref_key: refKeyOf(cast),
        source: cast.upload_id ? "upload" as const
              : cast.oa_url ? "oa" as const
              : "crossref" as const,
        upload_id: cast.upload_id,
        oa_url: cast.oa_url,
      };
    });
  setError(null); setStatus(""); setText(""); setContribution([]); setVerify(null);
  setReportCollapsed(false); setFollowups([]); setWarnings([]);
  setRunning(true); goStep(4);
  ctrl.current = new AbortController();
  await streamDeepResearch(
    {
      question, field, background, phase: "generate",
      references: sel,
      evidence: selEvidence,
      deep_read_targets,
      english_report: englishReport,
      project_id: projectId,
    },
    {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onDeepReadProgress: (p) => setDeepReadProgress(p),
      onDelta: (t) => setText((prev) => prev + t),
      onContributionTable: (rows) => { setContribution(rows); setDeepReadProgress(null); },
      onVerify: setVerify,
      onWarning: (m) => setWarnings((prev) => [...prev, m]),
      onError: (m) => {
        setError(m); setStatus(""); setRunning(false);
        setText((t) => (t && !t.endsWith("…(生成中断)") ? t + "\n\n…(生成中断)" : t));
        reportLLMError(m);
      },
      onDone: () => {
        setStatus(""); setRunning(false); setDeepReadProgress(null);
        window.dispatchEvent(new Event("usage-updated"));
      },
    },
  );
  setRunning(false);
};
```

- [ ] **Step 2: 添加 Step 4 UI**

在 return 里 Step 3 之后追加:

```tsx
{step === 4 && (
  <div className="wiz-panel" data-testid="wiz-panel-4">
    {status && <div className="status-line"><span className="spinner" /> {status}</div>}
    {deepReadProgress && (
      <div className="deep-read-progress" data-testid="deep-read-progress">
        深读 {deepReadProgress.done}/{deepReadProgress.total} …
      </div>
    )}

    <div className="result-panel">
      <div className="result-toolbar">
        <span className="result-status">
          {running ? "生成中…" : text ? (text.endsWith("…(生成中断)") ? "⚠ 已中断" : "已完成") : "等待生成"}
        </span>
        <ReportExportBar
          text={text}
          refs={refs}
          title="深度调研"
          running={running}
          reportCollapsed={reportCollapsed}
          onToggleCollapsed={() => setReportCollapsed((v) => !v)}
          onStatus={setStatus}
          extraLeadingActions={
            <>
              {running && <button className="btn-ghost" onClick={stop}>停止</button>}
              {text && !running && (
                <button className="btn-ghost" data-testid="send-to-plan-btn" onClick={() => {
                  const existing = (readPersisted<string>("plan:idea", "") || "").trim();
                  if (existing && existing !== text.trim()) {
                    if (!window.confirm(`实验规划页已有研究想法 (~${existing.length} 字), 覆盖?`)) return;
                  }
                  goto("plan", {
                    "plan:idea": text,
                    "plan:materials": [`[研究问题]\n${question}`, background && `[背景]\n${background}`].filter(Boolean).join("\n\n"),
                    "plan:materials:migrated": true,
                  });
                }}>→ 送到实验规划</button>
              )}
            </>
          }
        />
      </div>
      {reportCollapsed && text && !running && (
        <button className="report-collapsed-bar" onClick={() => setReportCollapsed(false)}>
          📄 调研报告已折叠 —— 点此展开
        </button>
      )}
      <div className={reportCollapsed && text && !running ? "report-body is-collapsed" : "report-body"}>
        <EditableMarkdown
          value={text}
          onSave={setText}
          running={running}
          enableRefine={!running && !!text}
          refs={refs}
          placeholder={running ? "正在合成…" : "点击 Step 3 的开始按钮后, 报告会显示在这里。"}
          testId="result-text"
        />
      </div>
    </div>

    {verify && !running && (
      verify.unverified.length === 0 ? (
        <div className="verify-ok" data-testid="verify">
          ✓ 引用核验:{verify.total} 处引用均命中已勾选文献
        </div>
      ) : (
        <div className="verify-bad" data-testid="verify">
          ⚠ 引用核验:{verify.unverified.length} 处引用未命中 (可能为 LLM 编造): {verify.unverified.join(", ")}
        </div>
      )
    )}

    {contribution.length > 0 && !running && (
      <div className="contribution-table" data-testid="contribution-table">
        <div className="contribution-head">
          <span>逐文献贡献表</span>
          <button className="btn-ghost" onClick={() => {
            const headers = ["#", "作者/年份", "期刊", "设计", "样本", "主要发现", "相关性", "深读"];
            const rows = contribution.map((c) => [c.n, c.author_year, c.journal, c.design, c.sample, c.finding, c.relevance, c.deep_read ? "是" : "否"]);
            downloadCsv(tsName("深度调研-贡献表", "csv"), headers, rows);
          }}>导出 CSV</button>
        </div>
        <table>
          <thead><tr>{["#", "作者/年份", "期刊", "设计", "样本", "主要发现", "相关性", "深读"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {contribution.map((c) => (
              <tr key={c.n}>
                <td>{c.n}</td><td>{c.author_year}</td><td>{c.journal}</td>
                <td>{c.design}</td><td>{c.sample}</td><td>{c.finding}</td>
                <td>{c.relevance === "direct" ? "直接" : c.relevance === "indirect" ? "间接" : "支持"}</td>
                <td>{c.deep_read ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {text && !running && (
      <FollowupPanel
        testId="research-followup"
        followups={followups}
        onAddFollowup={(item) => setFollowups((prev) => [...prev, item])}
        onReviseReport={setText}
        onVerifyUpdate={setVerify as (v: unknown) => void}
        streamFn={(payload, cb) => streamDeepResearchFollowup(
          payload as Parameters<typeof streamDeepResearchFollowup>[0],
          cb as Parameters<typeof streamDeepResearchFollowup>[1],
        )}
        currentReport={text}
        references={refs}
        evidence={evidence}
        englishReport={englishReport}
      />
    )}

    <div className="wiz-nav">
      <button className="btn-ghost" onClick={() => setStep(3)}>← 返回文献</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: 加最小 CSS**

追加到 `styles.css`:

```css
.deep-read-bar { display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: var(--panel-alt); border-radius: 6px; margin-bottom: 8px; }
.deep-read-progress { padding: 6px 10px; background: var(--panel-alt); border-radius: 4px; margin: 8px 0; }
.contribution-table { margin-top: 16px; }
.contribution-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
.contribution-table th, .contribution-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
.contribution-head { display: flex; justify-content: space-between; margin-bottom: 8px; }
.rec-high { color: gold; font-size: 16px; }
.rec-medium { color: #888; }
.need-title-row { display: flex; gap: 8px; align-items: center; padding: 6px; background: #fff4e5; border-radius: 4px; margin-top: 6px; }
```

- [ ] **Step 4: 类型检查 + 手动完整走一次**

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run dev
```

完整流程测试:
- Step 1 填研究问题 + 上传 2 篇 PDF
- Step 2 默认设置
- Step 3 检索 → 复核 → 勾几篇深读
- Step 4 → 应看到:深读进度 → 报告 4 段 → 引用核验 → 贡献表 → 追问框
- 试一次追问 → stream 显示答案
- 导出 Markdown/PDF 各一次
- 导出贡献表 CSV

- [ ] **Step 5: history 集成**

在 ResearchModule 的 `useEffect` 里追加 (仿 IdeaModule):

```tsx
const savedRef = useRef("");
useEffect(() => {
  if (!running && !error && text && savedRef.current !== text) {
    savedRef.current = text;
    addHistory({
      module: "research", icon: "🔬",
      title: question.slice(0, 40) || "深度调研",
      data: {
        "research:question": question, "research:field": field,
        "research:background": background, "research:result": text,
        "research:refs": refs, "research:evidence": evidence,
        "research:contribution": contribution, "research:verify": verify,
        "research:qa": followups,
        "research:step": step, "research:maxStep": Math.max(maxStep, step),
        "research:selectedKeys": selectedKeys, "research:deepReadKeys": deepReadKeys,
        "research:uploadedRefs": uploadedRefs,
      },
    });
  }
}, [running, error, text]);
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/modules/ResearchModule.tsx frontend/src/styles.css
git commit -m "feat(research): Step 4 深读+合成+贡献表+追问+导出+history 集成"
```

---

## Task 17: 前端 - build 并全流程手动回归

- [ ] **Step 1: `npm run build` 检查**

```bash
cd frontend && npm run build
```

Expected: 无 error, dist/ 生成。若有 lint/type error 修复。

- [ ] **Step 2: 后端整体 test**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
python -m pytest backend/test_deep_research_*.py -v
```

Expected: 全部 PASS。

- [ ] **Step 3: 完整手动回归清单**

启动服务:

```bash
python -m backend.app.main  # 或用 启动科研助手.bat
```

浏览器打开 UI, 依次验证:

- [ ] 开发者模式关闭时, 侧栏/首页/命令面板均无"深度调研"
- [ ] 开启后, 三处都出现"深度调研"
- [ ] "找选题"模块的所有行为不变 (Step 1 附件, Step 4 追问/导出)
- [ ] 深度调研 Step 1: 拖入 3 篇 PDF (含 1 篇故意乱码), 应显示 2 好 + 1 需手输题名; 手输题名成功回到列表
- [ ] Step 2 各筛选可交互, 设置保存到刷新后仍在
- [ ] Step 3: 上传 refs 置顶, 检索结果合并; 推荐分显示; 勾/取消深读复选框; 顶部横条数字更新
- [ ] Step 4: 报告 4 段模板产生, 引用核验通过, 贡献表渲染
- [ ] 深读中途点停止, 报告出现"…(生成中断)"; 恢复后仍可导出
- [ ] 追问 (ask) 显示答案 → 追加到 QA 列表; 追问 (revise) 重写报告
- [ ] 导出 Markdown/Word/PDF/复制/贡献表 CSV 均生效
- [ ] "→ 送到实验规划"按钮跳转成功, plan 页有 idea 内容
- [ ] 切换 project 后返回, refs/report 按项目隔离
- [ ] 历史记录里能看到"深度调研"条目, 恢复后落在 Step 4

- [ ] **Step 4: Commit build 产物**

按项目惯例 (见 CLAUDE.md 内存: "后端托管 dist,不 build 用户看不到任何变化"):

```bash
git add frontend/dist
git commit -m "build: 深度调研模块 (含开发者模式开关)"
```

- [ ] **Step 5: 更新 CHANGELOG**

在 `CHANGELOG.md` 顶部追加:

```markdown
## Unreleased

### 新增
- **深度调研**模块 (开发者模式下可见): 以研究问题为输入, 综合文献回答共识/矛盾/空白, 支持上传 PDF/DOCX 参与深读、Zotero 导入, AI 推荐深读候选。
- **开发者模式**开关 (右上角 ⚙ 设置 → 开发者模式), 默认关闭, 用于隐藏开发中模块。
```

```bash
git add CHANGELOG.md
git commit -m "docs: 记录深度调研 + 开发者模式到 CHANGELOG"
```

---

## Self-Review Notes

**Spec coverage check (逐节对应):**

| Spec 节 | 实现在 Task |
|---|---|
| §3 Step 1 数据模型 (question / field / background / uploaded_refs) | Task 14 |
| §3 Step 1 上传解析管线 | Task 2 (parse_upload) + Task 12 (uploadedLit) + Task 14 (ingestLit) |
| §3 Step 1 手输题名反查 | Task 3 (lookup_title) + Task 14 (NeedTitleRow) |
| §3 Step 2 检索设置 (沿用) | Task 14 |
| §3 Step 3 复核 + 去重 | Task 15 (runSearch merge logic) |
| §3 Step 3 深读推荐 (AI + 用户确认) | Task 4 (recommend) + Task 15 (UI) |
| §3 Step 4 4 段报告 + 贡献表 | Task 6 (synthesize) + Task 16 (UI) |
| §3 Step 4 追问 | Task 8 (backend) + Task 10 (FollowupPanel) + Task 16 (wire) |
| §3 Step 4 导出 + 下游跳转 | Task 11 (ReportExportBar) + Task 16 |
| §4.2 开发者模式 | Task 13 |
| §4.3 SSE 事件 | Task 7 (backend) + Task 12 (frontend types) |
| §4.4 合成管线 (2 次 LLM) | Task 6 + Task 7 |
| §4.5 深读全文获取顺序 | Task 5 |
| §5 持久化 key | Task 14 |
| §7 错误处理 (超时降级/中断/零命中) | Task 5 (timeout) + Task 7 (warning) + Task 15/16 (frontend) |
| §8 测试 (6 个 pytest) | Task 2/3/4/5/6/7/8 |

**已知偏差**:
- `test_dev_mode_gate.py` (前端 e2e) 未包含 — 项目当前无前端 e2e 框架, 用手动测试代替
- v2 章节切分改进已入 task #7 (backlog), 不在本计划

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-deep-research.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
