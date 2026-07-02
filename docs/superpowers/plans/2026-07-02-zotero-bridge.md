# 打通 Zotero(找选题 / 写标书 文献互通)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"找选题/写标书"的文献环节与本机 Zotero 互通:支持从 Zotero(或文件)导入文献、把文献推回 Zotero,并可选"跳过自动检索只用导入的文献 / 导入后再补检索"。

**Architecture:** 两阶段。P0(零外部依赖):找选题后端新增 `source_mode`(import_only/import_then_search),前端两个模块补齐"文献来源"选择并复用已有 `RefIO` 文件互导;写标书已支持 `references`+`research`,仅需接 UI。P1(本地活连接):新增 `backend/app/zotero.py` 封装 `localhost:23119` 的本地读 API 与 connector 写端点,经 4 个 `/api/zotero/*` 端点暴露,前端新增 `ZoteroPanel` 组件(读分类 / 整池或勾选回写)。

**Tech Stack:** FastAPI + httpx(后端)、React + TypeScript + Vite(前端)、pytest、Playwright。设计文档:`docs/superpowers/specs/2026-07-02-zotero-bridge-design.md`。

**约定:** 所有 Python 命令用项目 `.venv`(见记忆 python-use-venv)。前端改动完成后 `npm run build`。全部完成后按 CHANGELOG 流程写"未发布"区,再 commit + push(见记忆 rebuild-and-push-after-changes、changelog-workflow)。

---

## 阶段 P0 — 零外部依赖(先做,立即满足功能诉求)

### Task 1: 后端 — 找选题支持 `source_mode`(import_only / import_then_search)

**Files:**
- Modify: `backend/app/research.py`(新增 `_ref_to_paper` 辅助 + `deep_research_idea` 分支)
- Test: `backend/test_idea_source_mode.py`(新建)

**背景:** `deep_research_idea`(research.py:722)当前总是自己检索。下游综述 `_build_context`(research.py:303)用 `p["abstract"]/["first_author"]/["year"]/["title"]/["journal"]/["url"]` **硬取键**,故导入的 Reference 必须先补齐这些键。前端 Reference 字段见 `_REF_FIELDS`(research.py:44)。

- [ ] **Step 1: 写失败测试**

新建 `backend/test_idea_source_mode.py`:

```python
import asyncio
from unittest.mock import patch
from app.research import deep_research_idea, _ref_to_paper


def _collect(inputs):
    async def run():
        return [ev async for ev in deep_research_idea(inputs)]
    return asyncio.get_event_loop().run_until_complete(run())


def test_ref_to_paper_fills_hard_keys():
    p = _ref_to_paper({"title": "T", "authors": ["Zhang W"], "doi": "10.1/x"})
    # 下游 _build_context 会硬取这些键,必须都在
    for k in ("abstract", "first_author", "year", "title", "journal", "url"):
        assert k in p
    assert p["first_author"] == "Zhang W"
    assert p["url"] == "https://doi.org/10.1/x"


def test_import_only_skips_search_and_synthesizes():
    refs = [{"title": "T1", "first_author": "A", "year": "2020",
             "journal": "J", "url": "https://pubmed.ncbi.nlm.nih.gov/1/", "abstract": "finding X"}]

    async def fake_stream(messages, task="research", **kw):
        yield "综述正文"

    with patch("app.research.stream_chat", fake_stream), \
         patch("app.research.search_literature") as searched, \
         patch("app.research.settings") as st:
        st.mock = False
        evs = _collect({"field": "肺癌", "source_mode": "import_only", "references": refs})

    searched.assert_not_called()  # 关键:跳过检索
    kinds = [e[0] for e in evs]
    assert "references" in kinds and "delta" in kinds and "done" in kinds


def test_import_only_empty_refs_errors():
    with patch("app.research.settings") as st:
        st.mock = False
        evs = _collect({"field": "肺癌", "source_mode": "import_only", "references": []})
    assert evs[0][0] == "error"
```

- [ ] **Step 2: 运行,确认失败**

Run: `.venv/Scripts/python.exe -m pytest backend/test_idea_source_mode.py -v`(在 `backend/` 下用 `python -m pytest test_idea_source_mode.py -v`)
Expected: FAIL —`ImportError: cannot import name '_ref_to_paper'`

- [ ] **Step 3: 实现 `_ref_to_paper`**

在 `research.py` 的 `_merge_papers`(约 :283)之前新增:

```python
def _ref_to_paper(r: dict) -> dict:
    """把前端回传/导入的 Reference 规整成下游 papers 期望的 dict(补齐所有硬取键)。"""
    authors = r.get("authors")
    first = r.get("first_author") or (authors[0] if isinstance(authors, list) and authors else "")
    doi = r.get("doi") or ""
    return {
        "pmid": r.get("pmid") or "",
        "doi": doi,
        "title": r.get("title") or "",
        "first_author": first or "",
        "journal": r.get("journal") or "",
        "year": str(r.get("year") or ""),
        "url": r.get("url") or (f"https://doi.org/{doi}" if doi else ""),
        "abstract": r.get("abstract") or "",
        "source": r.get("source") or "import",
        "cited_by_count": r.get("cited_by_count"),
        "journal_impact": r.get("journal_impact"),
        "journal_quartile": r.get("journal_quartile"),
    }
```

- [ ] **Step 4: 在 `deep_research_idea` 加分支**

在 `deep_research_idea` 里 `filters = searchfilters.normalize(...)`(research.py:733)之后、`if settings.mock:`(:735)之前插入:

```python
    source_mode = (inputs.get("source_mode") or "auto").strip()
    _imported = inputs.get("references") if isinstance(inputs.get("references"), list) else []
    imported_papers = [_ref_to_paper(r) for r in _imported]

    if source_mode == "import_only":
        if not imported_papers:
            yield ("error", {"message": "未提供可用文献。请先从 Zotero 或文件导入文献,或改用自动检索。"})
            return
        papers = imported_papers[:40]
        yield ("references", {"items": [_ref_item(p) for p in papers]})
        yield ("status", {"message": f"已带入 {len(papers)} 篇文献,正在分析研究现状与空白…"})
        full = ""
        async for piece in stream_chat(_synthesis_messages(field, papers), task="research"):
            full += piece
            yield ("delta", {"text": piece})
        yield ("topic_card", _build_topic_card(field, keywords, full, papers, [], []))
        yield ("verify", _verify_citations(full, papers))
        yield ("done", {})
        return
```

然后在函数末尾 `yield ("verify", _verify_citations(full, papers))`(research.py:795)**之前**插入合并分支:

```python
        if source_mode == "import_then_search" and imported_papers:
            papers = _merge_papers(papers, imported_papers, cap=max(40, len(papers) + len(imported_papers)))
            yield ("references", {"items": [_ref_item(p) for p in papers]})
```

- [ ] **Step 5: 运行,确认通过**

Run: `python -m pytest test_idea_source_mode.py -v`(在 `backend/`)
Expected: PASS(3 项)

- [ ] **Step 6: 回归**

Run: `python -m pytest test_openalex.py test_literature_rank.py -q`(在 `backend/`)
Expected: PASS(确认没破坏检索链)

- [ ] **Step 7: 提交**

```bash
git add backend/app/research.py backend/test_idea_source_mode.py
git commit -m "找选题: 支持 source_mode(import_only 跳过检索 / import_then_search 补检索)"
```

---

### Task 2: 前端 — 找选题"文献来源"选择 + 传参

**Files:**
- Modify: `frontend/src/lib/sse.ts`(streamIdea 输入类型加两字段)
- Modify: `frontend/src/modules/IdeaModule.tsx`(状态 + 选择器 UI + submit 传参 + 不清空导入)

**说明:** 用 3 个功能值覆盖设计里的四态语义:`auto`(自动检索)/`import_then_search`(导入+补检索)/`import_only`(只用导入,跳过检索)。"从 Zotero/文件导入"是始终可见的导入控件(已有 RefIO),非独立模式。

- [ ] **Step 1: streamIdea 输入类型加字段**

在 `sse.ts` 找到 `streamIdea`(约 :330)的 inputs 参数类型(内联对象类型),补两个可选字段。若为内联类型,在其中加:

```typescript
  source_mode?: "auto" | "import_then_search" | "import_only";
  references?: Reference[];
```

(若该参数目前是宽松 `Record<string, unknown>`/`any`,则无需改类型,直接在调用处传即可——跳过本步。)

- [ ] **Step 2: IdeaModule 加状态**

在 `IdeaModule.tsx` 现有 `usePersistentState` 群(约 :134 `idea:refs` 附近)加:

```typescript
  const [sourceMode, setSourceMode] = usePersistentState<"auto" | "import_then_search" | "import_only">("idea:sourceMode", "auto");
```

- [ ] **Step 3: submit 里按模式保留导入并传参**

改 `submit`(IdeaModule.tsx:195)。把重置那行 `setRefs([]);`(:209)改为条件重置——import 模式下保留已导入文献:

```typescript
    if (sourceMode === "auto") setRefs([]);
```

并在 `streamIdea({ ... })` 的第一个入参对象(:224 起,`filters` 之后)追加:

```typescript
        source_mode: sourceMode,
        references: sourceMode === "auto" ? undefined : refs,
```

同时,`import_only` 且无文献时应拦住:在 `if (!f.trim() || running) return;`(:200)之后加:

```typescript
    if (sourceMode === "import_only" && refs.length === 0) {
      setError("已选择"只用导入的文献",但当前没有文献。请先用下方"导入文献"从 Zotero 或文件导入,或改回自动检索。");
      return;
    }
```

- [ ] **Step 4: 渲染"文献来源"选择器**

在开始按钮所在表单区(高级检索设置附近)插入一个分段选择。放在 `<RefIO ... />` 渲染(IdeaModule.tsx:824)**之前**的表单里最合适;若结构不便,放在"⚙ 高级检索设置"块上方:

```tsx
      <div className="field" data-testid="idea-source-mode">
        <span className="field-label">文献来源</span>
        <div className="seg-group" role="radiogroup">
          {([
            ["auto", "自动检索"],
            ["import_then_search", "导入 + 再补检索"],
            ["import_only", "只用导入的文献(跳过检索)"],
          ] as const).map(([val, label]) => (
            <label key={val} className="type-chip">
              <input
                type="radio"
                name="idea-source-mode"
                checked={sourceMode === val}
                onChange={() => setSourceMode(val)}
                data-testid={`idea-source-${val}`}
              />
              {label}
            </label>
          ))}
        </div>
        {sourceMode !== "auto" && (
          <span className="field-hint">
            用下方「📥 导入文献」从 Zotero 或文件(.ris/.bib/.enw)带入文献
            {sourceMode === "import_only" ? "；将跳过自动检索,直接据此生成综述与选题。" : "；随后仍会检索并与导入文献合并。"}
          </span>
        )}
      </div>
```

- [ ] **Step 5: 构建校验**

Run: `cd frontend && npm run build`
Expected: 构建成功,无 TS 报错。

- [ ] **Step 6: 手动验证(mock 或真跑)**

启动应用,找选题选"只用导入的文献",点"📥 导入文献"导入一个 .ris,填方向后点开始:应不触发检索、直接出综述与选题卡,文献列表为导入项。切回"自动检索"应恢复原行为。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/lib/sse.ts frontend/src/modules/IdeaModule.tsx
git commit -m "找选题: 前端文献来源选择(自动/导入+补检索/只用导入)"
```

---

### Task 3: 前端 — 写标书接入 RefIO 导入(复用已有 references+research)

**Files:**
- Modify: `frontend/src/modules/GrantModule.tsx`(引入 RefIO + mergeRefs,放在"已带入文献"区)

**背景:** `write_grant`(grant.py:747)已吃 `references`,并有 `research` 开关(:790,`True`=撰写前重检索并入池,`False`=只用带入)。所以写标书**无需后端改动**,也无需新选择器——只要能把 Zotero/文件文献导入 `refs`,现有 `grant-preresearch` 勾选(GrantModule.tsx:478)即覆盖"补检索/跳过检索"。

- [ ] **Step 1: 引入 RefIO 与去重合并**

`GrantModule.tsx` 顶部加导入:

```typescript
import RefIO from "../components/RefIO";
```

在文件内(组件外)加一个与 IdeaModule 同款的 `mergeRefs`。**直接复制** `IdeaModule.tsx:18-47` 的 `mergeRefs` 函数(连同其 `keyOf`),粘到 GrantModule.tsx 组件定义之前(保持逻辑一致,便于日后抽公共模块;本次不抽,YAGNI)。

- [ ] **Step 2: 在"已带入文献"区渲染 RefIO**

把 GrantModule.tsx:468-476 的 `{refs.length > 0 && (...)}` 信息块替换为始终可见的导入块:

```tsx
        <div className="field" data-testid="grant-refs-info">
          <span className="field-label">可引用文献</span>
          <span className="field-hint">
            共 {refs.length} 篇。可来自找选题带入,也可从 Zotero 或文件(.ris/.bib/.enw)导入。
            立项依据会据实引用这些文献;若想在写作前按方向补充新文献,勾选下方"撰写前重新检索"。
          </span>
          <RefIO
            currentRefs={refs}
            exportFilename="标书-文献"
            onImport={(imported) => {
              const { merged, added, dup } = mergeRefs(refs, imported);
              setRefs(merged);
            }}
          />
        </div>
```

(确认 `refs`/`setRefs` 状态与 `Reference` 类型在 GrantModule 已存在——见 GrantModule.tsx:173 `references: refs`。)

- [ ] **Step 3: 构建校验**

Run: `cd frontend && npm run build`
Expected: 构建成功。

- [ ] **Step 4: 手动验证**

写标书页:无找选题带入时,也能"📥 导入文献"从 .ris 带入,篇数更新;关掉"撰写前重新检索"→只用导入文献写立项依据;开着→再补检索合并。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/modules/GrantModule.tsx
git commit -m "写标书: 接入文献导入(RefIO),支持从 Zotero/文件带入并据实引用"
```

---

## 阶段 P1 — 本地活连接(Zotero 在线时免倒文件)

> ⚠️ Zotero 端点无法单元测试真实实例。以下后端任务对**映射/载荷构造**做单测(mock httpx),对**真实连通**用手动冒烟。前提:用户 Zotero 7 运行中且已勾选 *设置→高级→允许本机其它应用与 Zotero 通信*。

### Task 4: 后端 — `zotero.py`(探测 / 读分类 / 条目映射 / 推送载荷)

**Files:**
- Create: `backend/app/zotero.py`
- Test: `backend/test_zotero.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/test_zotero.py`:

```python
from app.zotero import map_item, build_push_payload, ZOTERO_BASE


def test_map_item_to_reference():
    raw = {"key": "ABCD", "data": {
        "itemType": "journalArticle", "title": "Deep Learning in Oncology",
        "creators": [{"creatorType": "author", "lastName": "Zhang", "firstName": "Wei"}],
        "date": "2021-05", "DOI": "10.1000/x", "publicationTitle": "Nature Med",
        "url": "", "abstractNote": "We show ..."}}
    r = map_item(raw)
    assert r["title"] == "Deep Learning in Oncology"
    assert r["first_author"] == "Zhang Wei"
    assert r["year"] == "2021"
    assert r["journal"] == "Nature Med"
    assert r["doi"] == "10.1000/x"
    assert r["url"] == "https://doi.org/10.1000/x"  # 无 url 时用 doi 兜底


def test_map_item_skips_non_reference_types():
    assert map_item({"data": {"itemType": "attachment"}}) is None
    assert map_item({"data": {"itemType": "note"}}) is None


def test_build_push_payload_shape():
    refs = [{"title": "T", "first_author": "Zhang Wei", "year": "2020",
             "journal": "J", "doi": "10.1/x", "url": "https://doi.org/10.1/x",
             "abstract": "ab"}]
    body = build_push_payload(refs)
    assert isinstance(body["items"], list) and len(body["items"]) == 1
    it = body["items"][0]
    assert it["itemType"] == "journalArticle"
    assert it["title"] == "T"
    assert it["creators"][0]["lastName"] == "Zhang"
    assert it["creators"][0]["firstName"] == "Wei"
    assert it["DOI"] == "10.1/x"
    assert body.get("sessionID")  # connector 需要 sessionID
    assert ZOTERO_BASE.endswith(":23119")
```

- [ ] **Step 2: 运行,确认失败**

Run: `python -m pytest test_zotero.py -v`(在 `backend/`)
Expected: FAIL —`ModuleNotFoundError: No module named 'app.zotero'`

- [ ] **Step 3: 实现 `zotero.py`**

新建 `backend/app/zotero.py`:

```python
"""本地 Zotero 打通:读本地库(Zotero 7 本地 API)与回写(connector saveItems)。

前提:Zotero 桌面端运行中,且用户已在 设置→高级 勾选
"允许本机其它应用与 Zotero 通信"。所有请求走 127.0.0.1:23119,不触网。
"""
from __future__ import annotations

import httpx

ZOTERO_BASE = "http://127.0.0.1:23119"
_API = f"{ZOTERO_BASE}/api/users/0"          # 本地库 userID 恒为 0
_CONNECTOR = f"{ZOTERO_BASE}/connector"
_PROBE_TIMEOUT = 1.5
_IO_TIMEOUT = 2.0

# 只导入这些"文献型"条目;附件/笔记/独立标签跳过。
_REF_TYPES = {
    "journalArticle", "conferencePaper", "preprint", "book", "bookSection",
    "report", "thesis", "magazineArticle", "newspaperArticle", "document",
}


def _split_name(c: dict) -> str:
    """Zotero creator → "Last First" 单串(与本应用 first_author 习惯一致)。"""
    if c.get("name"):  # 单字段作者(机构等)
        return str(c["name"]).strip()
    last = (c.get("lastName") or "").strip()
    first = (c.get("firstName") or "").strip()
    return (f"{last} {first}").strip()


def map_item(raw: dict) -> dict | None:
    """Zotero 本地 API 条目 → 本应用统一 Reference;非文献型返回 None。"""
    d = raw.get("data") or {}
    itype = d.get("itemType")
    if itype not in _REF_TYPES:
        return None
    creators = [c for c in (d.get("creators") or []) if c.get("creatorType") == "author"] \
        or (d.get("creators") or [])
    authors = [_split_name(c) for c in creators if _split_name(c)]
    doi = (d.get("DOI") or "").strip()
    date = (d.get("date") or "").strip()
    year = ""
    for tok in date.replace("/", "-").split("-"):
        if len(tok) == 4 and tok.isdigit():
            year = tok
            break
    url = (d.get("url") or "").strip() or (f"https://doi.org/{doi}" if doi else "")
    return {
        "title": (d.get("title") or "").strip(),
        "authors": authors,
        "first_author": authors[0] if authors else "",
        "journal": (d.get("publicationTitle") or d.get("bookTitle") or "").strip(),
        "year": year,
        "doi": doi,
        "url": url,
        "abstract": (d.get("abstractNote") or "").strip(),
        "source": "zotero",
    }


def _push_creators(ref: dict) -> list[dict]:
    out = []
    names = ref.get("authors") or ([ref["first_author"]] if ref.get("first_author") else [])
    for n in names:
        n = str(n).strip()
        if not n:
            continue
        parts = n.split()
        if len(parts) >= 2:
            out.append({"creatorType": "author", "lastName": parts[0], "firstName": " ".join(parts[1:])})
        else:
            out.append({"creatorType": "author", "lastName": n, "firstName": ""})
    return out


def build_push_payload(refs: list[dict]) -> dict:
    """构造 connector/saveItems 载荷(Zotero item JSON 数组)。"""
    items = []
    for r in refs:
        items.append({
            "itemType": "journalArticle",
            "title": r.get("title") or "",
            "creators": _push_creators(r),
            "date": str(r.get("year") or ""),
            "DOI": r.get("doi") or "",
            "url": r.get("url") or "",
            "publicationTitle": r.get("journal") or "",
            "abstractNote": r.get("abstract") or "",
        })
    # sessionID:connector 用它归并同一次保存;固定值即可(单次同步无并发语义)。
    return {"sessionID": "research-assistant", "items": items,
            "uri": "https://research-assistant.local"}


async def probe() -> dict:
    """探测本地 Zotero:running(总)/api(本地读)/connector(写)。"""
    api_ok = connector_ok = False
    async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT) as client:
        try:
            r = await client.get(f"{_API}/collections?limit=1")
            api_ok = r.status_code == 200
        except Exception:  # noqa: BLE001
            api_ok = False
        try:
            r = await client.get(f"{_CONNECTOR}/ping")
            connector_ok = r.status_code in (200, 204)
        except Exception:  # noqa: BLE001
            connector_ok = False
    return {"running": api_ok or connector_ok, "api": api_ok, "connector": connector_ok}


async def list_collections() -> list[dict]:
    """列出本地库分类:[{key, name, count}]。"""
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT) as client:
        r = await client.get(f"{_API}/collections?limit=200")
        r.raise_for_status()
        data = r.json()
    out = []
    for c in data:
        out.append({
            "key": c.get("key") or (c.get("data") or {}).get("key") or "",
            "name": (c.get("data") or {}).get("name") or "",
            "count": (c.get("meta") or {}).get("numItems", 0),
        })
    return [c for c in out if c["key"] and c["name"]]


async def import_collection(collection_key: str, cap: int = 200) -> list[dict]:
    """读某分类的条目 → 统一 Reference 列表(上限 cap)。"""
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT) as client:
        r = await client.get(f"{_API}/collections/{collection_key}/items?limit={cap}")
        r.raise_for_status()
        data = r.json()
    refs = [map_item(x) for x in data]
    return [x for x in refs if x][:cap]


async def push(refs: list[dict]) -> int:
    """把 refs 推入运行中的 Zotero(存进当前选中分类)。返回尝试推送数。"""
    if not refs:
        return 0
    async with httpx.AsyncClient(timeout=_IO_TIMEOUT + 3) as client:
        r = await client.post(f"{_CONNECTOR}/saveItems",
                              json=build_push_payload(refs),
                              headers={"Content-Type": "application/json"})
        r.raise_for_status()
    return len(refs)
```

- [ ] **Step 4: 运行,确认通过**

Run: `python -m pytest test_zotero.py -v`(在 `backend/`)
Expected: PASS(3 项)

- [ ] **Step 5: 提交**

```bash
git add backend/app/zotero.py backend/test_zotero.py
git commit -m "后端: zotero.py 本地读(分类/条目映射)+回写(saveItems 载荷)"
```

---

### Task 5: 后端 — 4 个 `/api/zotero/*` 端点

**Files:**
- Modify: `backend/app/routes/manuscript.py`(在"引用导入导出"区后新增 4 个端点)
- Test: `backend/test_zotero_routes.py`

- [ ] **Step 1: 写失败测试**

新建 `backend/test_zotero_routes.py`:

```python
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_status_offline_is_ok_false_running():
    with patch("app.zotero.probe", AsyncMock(return_value={"running": False, "api": False, "connector": False})):
        r = client.get("/api/zotero/status")
    assert r.status_code == 200
    assert r.json()["running"] is False


def test_import_returns_refs():
    fake = [{"title": "T", "first_author": "A", "url": "u"}]
    with patch("app.zotero.import_collection", AsyncMock(return_value=fake)):
        r = client.post("/api/zotero/import", json={"collection_key": "ABCD"})
    assert r.json()["ok"] is True
    assert r.json()["refs"][0]["title"] == "T"


def test_push_reports_saved_count():
    with patch("app.zotero.push", AsyncMock(return_value=2)):
        r = client.post("/api/zotero/push", json={"refs": [{"title": "a"}, {"title": "b"}]})
    assert r.json() == {"ok": True, "saved": 2}


def test_import_offline_graceful_error():
    with patch("app.zotero.import_collection", AsyncMock(side_effect=Exception("conn refused"))):
        r = client.post("/api/zotero/import", json={"collection_key": "X"})
    assert r.json()["ok"] is False
    assert "Zotero" in r.json()["error"]
```

- [ ] **Step 2: 运行,确认失败**

Run: `python -m pytest test_zotero_routes.py -v`(在 `backend/`)
Expected: FAIL — 404(端点未定义)

- [ ] **Step 3: 加端点**

在 `manuscript.py` 的 `refs_export`(:214-228)之后新增。先在文件顶部的 pydantic 模型区(与 `RefsExportRequest` 同处;若模型在别处,就近定义)加请求模型,再加路由:

```python
class ZoteroImportRequest(BaseModel):
    collection_key: str


class ZoteroPushRequest(BaseModel):
    refs: list[dict]


@router.get("/api/zotero/status")
async def zotero_status() -> dict:
    """探测本机 Zotero 是否可用(读/写)。离线也返回 200,便于前端优雅回退。"""
    from .. import zotero
    try:
        return await zotero.probe()
    except Exception:  # noqa: BLE001
        return {"running": False, "api": False, "connector": False}


@router.get("/api/zotero/collections")
async def zotero_collections() -> dict:
    from .. import zotero
    try:
        return {"ok": True, "collections": await zotero.list_collections()}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"读取 Zotero 分类失败(请确认 Zotero 已运行并允许本机通信): {e}"}


@router.post("/api/zotero/import")
async def zotero_import(req: ZoteroImportRequest) -> dict:
    from .. import zotero
    try:
        refs = await zotero.import_collection(req.collection_key)
        return {"ok": True, "refs": refs}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"从 Zotero 导入失败(请确认 Zotero 已运行并允许本机通信): {e}"}


@router.post("/api/zotero/push")
async def zotero_push(req: ZoteroPushRequest) -> dict:
    from .. import zotero
    try:
        saved = await zotero.push(req.refs)
        return {"ok": True, "saved": saved}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"推送到 Zotero 失败(请确认 Zotero 已运行并允许本机通信): {e}"}
```

确认 `manuscript.py` 顶部已 `from pydantic import BaseModel`(refs_export 用了 `RefsExportRequest`,应已导入;若模型集中在别的模块,则把两个新模型加到该模块并 import)。

- [ ] **Step 4: 运行,确认通过**

Run: `python -m pytest test_zotero_routes.py -v`(在 `backend/`)
Expected: PASS(4 项)

- [ ] **Step 5: 更新 OpenAPI 契约(项目惯例)**

Run: `python export_openapi.py`(在 `backend/`,若该脚本存在;生成 `docs/api-openapi.json`)
Expected: 无报错,契约含新端点。若脚本路径不同,跳过并在提交说明注明。

- [ ] **Step 6: 提交**

```bash
git add backend/app/routes/manuscript.py backend/test_zotero_routes.py docs/api-openapi.json
git commit -m "后端: /api/zotero/status|collections|import|push 四端点"
```

---

### Task 6: 前端 — `ZoteroPanel` 组件(状态探测 / 选分类导入 / 整池或勾选回写)

**Files:**
- Create: `frontend/src/components/ZoteroPanel.tsx`

**接口:** 与 RefIO 并列,props 对齐以便复用:

```typescript
interface ZoteroPanelProps {
  currentRefs: Reference[];
  onImport: (imported: Reference[]) => void;   // 复用调用方的 mergeRefs
  selectedForPush?: Reference[];                // 勾选子集;空/未传则推 currentRefs 全池
}
```

- [ ] **Step 1: 实现组件**

新建 `frontend/src/components/ZoteroPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { Reference } from "../lib/sse";
import { apiUrl } from "../lib/api";

interface ZoteroPanelProps {
  currentRefs: Reference[];
  onImport: (imported: Reference[]) => void;
  selectedForPush?: Reference[];
}

type Coll = { key: string; name: string; count: number };

// 后端 zotero 条目 → 前端 Reference(与 RefIO 的映射一致)。
function toRef(r: any): Reference {
  return {
    pmid: r.pmid || r.doi || "",
    title: r.title || "",
    first_author: r.first_author || (Array.isArray(r.authors) && r.authors.length ? String(r.authors[0]) : ""),
    journal: r.journal || "",
    year: r.year ? String(r.year) : "",
    url: r.url || (r.doi ? `https://doi.org/${r.doi}` : ""),
    source: r.source,
  };
}

export default function ZoteroPanel({ currentRefs, onImport, selectedForPush }: ZoteroPanelProps) {
  const [online, setOnline] = useState<boolean | null>(null); // null=探测中
  const [colls, setColls] = useState<Coll[] | null>(null);
  const [busy, setBusy] = useState<"" | "load" | "import" | "push">("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/zotero/status"))
      .then((r) => r.json())
      .then((d) => { if (alive) setOnline(!!d.running); })
      .catch(() => { if (alive) setOnline(false); });
    return () => { alive = false; };
  }, []);

  const loadColls = async () => {
    setBusy("load"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/collections"))).json();
      if (!d.ok) throw new Error(d.error || "读取失败");
      setColls(d.collections || []);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  const importColl = async (key: string, name: string) => {
    setBusy("import"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/import"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection_key: key }),
      })).json();
      if (!d.ok) throw new Error(d.error || "导入失败");
      const refs = (d.refs || []).map(toRef);
      onImport(refs);
      setMsg(`已从「${name}」导入 ${refs.length} 篇`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  const push = async () => {
    const payload = (selectedForPush && selectedForPush.length ? selectedForPush : currentRefs);
    if (!payload.length) { setMsg("当前没有可推送的文献"); return; }
    setBusy("push"); setMsg("");
    try {
      const d = await (await fetch(apiUrl("/api/zotero/push"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: payload }),
      })).json();
      if (!d.ok) throw new Error(d.error || "推送失败");
      setMsg(`已推送 ${d.saved} 篇到 Zotero(存入当前选中分类)`);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  if (online === null) return null;              // 探测中不占位
  if (!online) {
    return (
      <div className="zotero-panel offline" data-testid="zotero-offline" style={{ fontSize: 12, color: "var(--muted,#78877f)", marginTop: 4 }}>
        未检测到运行中的 Zotero。可改用上方「📥 导入文献」拖入 Zotero 导出的 .ris/.bib;
        或在 Zotero 设置→高级 勾选「允许本机其它应用与 Zotero 通信」后刷新。
      </div>
    );
  }

  const pushCount = (selectedForPush && selectedForPush.length) ? selectedForPush.length : currentRefs.length;
  const pushLabel = (selectedForPush && selectedForPush.length)
    ? `🔗 推送到 Zotero(已选 ${pushCount}）`
    : `🔗 推送到 Zotero(全部 ${pushCount}）`;

  return (
    <div className="zotero-panel" data-testid="zotero-panel" style={{ marginTop: 6 }}>
      <div className="form-actions">
        <button className="btn-secondary" data-testid="zotero-load-colls" disabled={!!busy} onClick={loadColls}>
          {busy === "load" ? "读取分类…" : "🔗 从 Zotero 导入"}
        </button>
        <button className="btn-secondary" data-testid="zotero-push" disabled={!!busy || pushCount === 0} onClick={push}>
          {busy === "push" ? "推送中…" : pushLabel}
        </button>
      </div>
      {colls && (
        <div className="zotero-colls" data-testid="zotero-colls" style={{ marginTop: 6, maxHeight: 200, overflowY: "auto" }}>
          {colls.length === 0 && <div style={{ fontSize: 12 }}>Zotero 里没有分类。</div>}
          {colls.map((c) => (
            <button key={c.key} className="btn-ghost" data-testid={`zotero-coll-${c.key}`}
              disabled={busy === "import"} onClick={() => importColl(c.key, c.name)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "transparent", fontSize: 13 }}>
              {c.name} <span style={{ color: "var(--muted,#78877f)" }}>({c.count})</span>
            </button>
          ))}
        </div>
      )}
      {msg && <div data-testid="zotero-msg" style={{ marginTop: 6, fontSize: 12 }}>{msg}</div>}
    </div>
  );
}
```

- [ ] **Step 2: 构建校验**

Run: `cd frontend && npm run build`
Expected: 构建成功。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/ZoteroPanel.tsx
git commit -m "前端: ZoteroPanel 组件(探测/选分类导入/整池或勾选回写)"
```

---

### Task 7: 前端 — 把 ZoteroPanel 接进找选题 / 写标书,并加"推送勾选"

**Files:**
- Modify: `frontend/src/modules/IdeaModule.tsx`(RefIO 旁挂 ZoteroPanel + 文献列表加勾选)
- Modify: `frontend/src/modules/GrantModule.tsx`(RefIO 旁挂 ZoteroPanel)

- [ ] **Step 1: 找选题挂 ZoteroPanel + 勾选状态**

`IdeaModule.tsx` 顶部加 `import ZoteroPanel from "../components/ZoteroPanel";`。加勾选状态(放在 `refs` state 附近):

```typescript
  const [pushSel, setPushSel] = useState<Set<string>>(new Set());
  const refKey = (r: Reference) => r.pmid || r.url || r.title;
```

在 `<RefIO ... />`(:824-833)之后紧接:

```tsx
      <ZoteroPanel
        currentRefs={refs}
        onImport={(imported) => {
          const { merged, added, dup } = mergeRefs(refs, imported);
          setRefs(merged);
          setStatus(`从 Zotero 导入 ${added} 篇，去重 ${dup} 篇`);
          window.setTimeout(() => setStatus((s) => (s.startsWith("从 Zotero") ? "" : s)), 4000);
        }}
        selectedForPush={refs.filter((r) => pushSel.has(refKey(r)))}
      />
```

在文献列表 `<li>`(IdeaModule.tsx:852 起)的题名前加一个勾选框:

```tsx
                <input
                  type="checkbox"
                  data-testid={`ref-push-${i}`}
                  checked={pushSel.has(refKey(r))}
                  onChange={(e) => setPushSel((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(refKey(r)); else next.delete(refKey(r));
                    return next;
                  })}
                  title="勾选后可只把选中的文献推送到 Zotero"
                  style={{ marginRight: 6 }}
                />
```

- [ ] **Step 2: 写标书挂 ZoteroPanel**

`GrantModule.tsx` 顶部加 `import ZoteroPanel from "../components/ZoteroPanel";`。在 Task 3 新增的 `<RefIO .../>` 之后加:

```tsx
          <ZoteroPanel
            currentRefs={refs}
            onImport={(imported) => {
              const { merged } = mergeRefs(refs, imported);
              setRefs(merged);
            }}
          />
```

(写标书推送用整池即可,不加勾选,保持简洁;需要时用户在找选题勾选后推。)

- [ ] **Step 3: 构建校验**

Run: `cd frontend && npm run build`
Expected: 构建成功。

- [ ] **Step 4: 手动冒烟(需 Zotero 运行 + 勾选允许通信)**

1. 找选题页应出现「🔗 从 Zotero 导入」「🔗 推送到 Zotero(全部 N)」。点导入→列出分类→选一个→文献并入池、去重提示。
2. 勾选列表里几篇→按钮变「(已选 K)」→推送→Zotero 当前选中分类里出现这些条目。
3. 关闭 Zotero→刷新→应显示灰字回退提示,不报红、不阻塞。
4. 写标书页同样能从 Zotero 导入、整池推送。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/modules/IdeaModule.tsx frontend/src/modules/GrantModule.tsx
git commit -m "找选题/写标书: 接入 ZoteroPanel(活导入/回写)+文献推送勾选"
```

---

### Task 8: CHANGELOG + 构建 + 推送

**Files:**
- Modify: `CHANGELOG.md`(未发布区)

- [ ] **Step 1: 写 CHANGELOG(仅用户可感知变化)**

在 `CHANGELOG.md` 的 `## 未发布` → `### 找选题 / 写标书` 追加:

```markdown
- **新增:与 Zotero 打通**:找选题和写标书都能把文献与本机 Zotero 互通。若 Zotero 正
  开着(并在 设置→高级 勾选"允许本机其它应用与 Zotero 通信"),会出现「🔗 从 Zotero
  导入」——选一个分类即可把里面的文献带进当前文献池;还能「🔗 推送到 Zotero」把
  检索/带入的文献存回 Zotero(可整池推,也可在文献列表勾选几篇只推选中的)。Zotero
  没开也不影响:继续用「📥 导入文献」拖入 Zotero 导出的 .ris/.bib 文件即可。
- **新增:找选题可"只用自己的文献"**:文献来源可选"自动检索 / 导入+再补检索 /
  只用导入的文献(跳过检索)"。带着自己整理好的一批文献时,可跳过联网检索,直接据此
  生成研究现状综述与候选选题。
```

- [ ] **Step 2: 最终构建**

Run: `cd frontend && npm run build`
Expected: 成功。

- [ ] **Step 3: 全量后端测试**

Run: `python -m pytest -q`(在 `backend/`)
Expected: 全绿(至少新增的 idea_source_mode / zotero / zotero_routes 通过,无回归)。

- [ ] **Step 4: 提交并推送**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 Zotero 打通与找选题文献来源"
git push
```

---

## 自检对照(spec 覆盖)

- 导入(文件)→ 已有 RefIO,Task 3 接入写标书 ✅
- 导入(本地 Zotero 读分类)→ Task 4/5/6/7 ✅
- 回写(整池 + 勾选)→ Task 6(push + selectedForPush)、Task 7(勾选)✅
- 文献来源四态(自动/导入/导入+补检索/跳过检索)→ 找选题 Task 1+2,写标书 Task 3(RefIO + 既有 research 开关)✅
- Zotero 离线优雅回退 → Task 6(offline 分支)、Task 5(端点吞异常返 ok:false)✅
- 导入 200 上限 → Task 4 `import_collection(cap=200)` ✅
- "当前选中条目"用文件替代 → 不做直读,RefIO 兜底(spec 已确认)✅
- 不引入 Web API / Better BibTeX → 本计划未涉及 ✅
