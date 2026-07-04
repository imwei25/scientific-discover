# Grant Literature Picker + Evidence-on-Import + Format Refs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give GrantModule a checkbox literature picker stage (mirroring IdeaModule Step 3), auto-extract core findings for RefIO/Zotero-imported refs (in Idea and Grant), and add a structured refs panel + Zotero to FormatModule with one-way handoff from Idea/Grant.

**Architecture:** One new shared React component (`LiteraturePicker`) extracted from IdeaModule Step 3, plus two tiny client helpers (`evidenceExtract`, `refHandoff`). Backend gains three additions: `fetch_abstract_by_id` fallback helper, a reusable `extract_evidence_for_refs` wrapper around today's module-level `_extract_batch`, and two new endpoints (`/api/refs/extract-evidence`, `/api/grant/search`). `write_grant` gains an optional `provided_refs` input that short-circuits its internal re-search.

**Tech Stack:** Python 3.11 + FastAPI (backend, `backend/app/**`), React + TypeScript + Vite (frontend, `frontend/src/**`), pytest (backend tests, flat `backend/test_*.py`). Frontend has no JS test runner — verification is manual via `npm run build` + browser smoke test.

**Spec:** `docs/superpowers/specs/2026-07-04-grant-lit-picker-and-format-refs-design.md`

---

## Key Design Correction from Spec

The spec claimed `_extract_batch` was a closure inside `deep_research_idea`. **Verified against `backend/app/research.py:364`: `_extract_batch` is already a module-level `async def`.** No promotion needed. We only add a new public wrapper `extract_evidence_for_refs(refs, field="", fetch_missing=True)` that reuses `_extract_batch`.

Also verified:
- Frontend field is `preResearch` (bool), sent to backend as `research: preResearch`. Backend reads `inputs.get("research", True)`.
- FormatModule already has a persistent `importedRefs: Reference[]` state (line 125). The "structured refs panel" builds on this — we add checkbox selection, evidence, and Zotero, not a whole new state slot.

---

## File Structure

**New (frontend):**
- `frontend/src/components/LiteraturePicker.tsx` — shared checkbox picker with RefIO + optional ZoteroPanel + optional primary action button. Extracted from IdeaModule Step 3.
- `frontend/src/lib/evidenceExtract.ts` — client helper `extractEvidenceForRefs(refs, onProgress?)` calling `/api/refs/extract-evidence`, batches of 8.
- `frontend/src/lib/refHandoff.ts` — module-scoped store + `refhandoff:pending` CustomEvent, for one-way handoff to FormatModule.

**New (backend tests, flat under `backend/`):**
- `backend/test_fetch_abstract_by_id.py`
- `backend/test_extract_evidence_endpoint.py`
- `backend/test_grant_provided_refs.py`

**Modified (backend):**
- `backend/app/literature.py` — add `async def fetch_abstract_by_id(doi, pmid) -> str | None`.
- `backend/app/research.py` — add `async def extract_evidence_for_refs(refs, field="", fetch_missing=True) -> list[dict]` reusing `_extract_batch`.
- `backend/app/grant.py` — in `write_grant`, honor `inputs.get("provided_refs")` by skipping the "research" block and using it as the ref pool.
- `backend/app/routes/text_gen.py` — mount `POST /api/refs/extract-evidence` and `POST /api/grant/search`.

**Modified (frontend):**
- `frontend/src/modules/IdeaModule.tsx` — swap Step-3 inline picker markup for `<LiteraturePicker>`; wire `onImport` to `extractEvidenceForRefs`; add "→ 期刊排版" button.
- `frontend/src/modules/GrantModule.tsx` — introduce `stage: "prepare"|"picker"|"writing"`; when `preResearch` true, insert picker stage that calls `/api/grant/search` and hands `provided_refs` into `/api/grant`.
- `frontend/src/modules/FormatModule.tsx` — mount `<LiteraturePicker mode="list">` above textarea; consume handoff on mount; wire format-refs/check-refs/Zotero push to structured refs when non-empty.

**Untouched:** `frontend/src/components/RefIO.tsx`, `frontend/src/components/ZoteroPanel.tsx`, `backend/app/zotero.py`, `backend/app/refio.py`.

---

## Task 1: Backend — `fetch_abstract_by_id` helper in `literature.py`

**Files:**
- Modify: `backend/app/literature.py` (append at end of file)
- Test: `backend/test_fetch_abstract_by_id.py` (new)

**Rationale:** When a Zotero/RefIO-imported ref has no abstract but has a DOI or PMID, we need to fetch it from public sources before evidence extraction can run. Try PubMed → Europe PMC → OpenAlex in order.

- [ ] **Step 1: Write the failing test**

Create `backend/test_fetch_abstract_by_id.py`:

```python
"""fetch_abstract_by_id: PubMed -> EPMC -> OpenAlex fallback (offline, mocked)."""
import asyncio
from unittest.mock import patch, AsyncMock

from app.literature import fetch_abstract_by_id


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_pubmed_hit_short_circuits() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value="PM abstract")) as pm, \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")) as ep, \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")) as oa:
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "PM abstract"
        assert pm.await_count == 1
        assert ep.await_count == 0
        assert oa.await_count == 0


def test_falls_back_to_epmc_when_pubmed_misses() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")) as oa:
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "EPMC abstract"
        assert oa.await_count == 0


def test_falls_back_to_openalex_when_others_miss() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")):
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "OA abstract"


def test_all_miss_returns_none() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value=None)):
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got is None


def test_client_raises_are_swallowed_and_fallthrough() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(side_effect=RuntimeError("boom"))), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")):
        got = _run(fetch_abstract_by_id(doi=None, pmid="12345"))
        assert got == "EPMC abstract"


def test_no_ids_returns_none() -> None:
    got = _run(fetch_abstract_by_id(doi=None, pmid=None))
    assert got is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK  {name}")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/backend
.venv/Scripts/python.exe -m pytest test_fetch_abstract_by_id.py -v
```

Expected: FAIL with `ImportError: cannot import name 'fetch_abstract_by_id' from 'app.literature'`.

- [ ] **Step 3: Implement `fetch_abstract_by_id` and its three per-source helpers**

Append to `backend/app/literature.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
.venv/Scripts/python.exe -m pytest test_fetch_abstract_by_id.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add backend/app/literature.py backend/test_fetch_abstract_by_id.py
git commit -m "feat(literature): fetch_abstract_by_id fallback (PubMed -> EPMC -> OpenAlex)"
```

---

## Task 2: Backend — `extract_evidence_for_refs` wrapper in `research.py`

**Files:**
- Modify: `backend/app/research.py` (add module-level helper after `_extract_evidence` at ~line 437)
- Test: `backend/test_extract_evidence_endpoint.py` — creates the test file we'll extend in Task 3

**Rationale:** Reuse today's `_extract_batch` (already module-level per verified inspection) from a new public wrapper. Support ref lists that came from imports (no `abstract`) by first calling `fetch_abstract_by_id`, then batching to LLM.

- [ ] **Step 1: Write the failing test**

Create `backend/test_extract_evidence_endpoint.py`:

```python
"""extract_evidence_for_refs: batching, missing-abstract fetch, error tolerance."""
import asyncio
from unittest.mock import patch, AsyncMock

from app.research import extract_evidence_for_refs


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _ref(i: int, has_abs: bool = True, doi: str | None = None, pmid: str | None = None) -> dict:
    return {
        "pmid": pmid or f"P{i}",
        "doi": doi or f"10.1/x{i}",
        "title": f"Title {i}",
        "first_author": f"A{i}",
        "journal": "J",
        "year": "2024",
        "url": f"https://example.com/{i}",
        "abstract": f"Abstract text {i}" if has_abs else "",
    }


def test_batches_of_eight() -> None:
    refs = [_ref(i) for i in range(20)]  # 20 refs -> ceil(20/8) = 3 batches
    calls: list[int] = []

    async def fake_batch(field, items):
        calls.append(len(items))
        return {gi: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 2} for gi, _ in items}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="dm", fetch_missing=False))
    assert len(got) == 20
    assert calls == [8, 8, 4]


def test_missing_abstract_triggers_fetch_then_extracts() -> None:
    refs = [_ref(0, has_abs=False, doi="10.1/found", pmid="P0")]

    async def fake_fetch(doi, pmid):
        assert doi == "10.1/found" and pmid == "P0"
        return "fetched abstract"

    async def fake_batch(field, items):
        # after fetch, abstract must be present
        _, p = items[0]
        assert p.get("abstract") == "fetched abstract"
        return {items[0][0]: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 3}}

    with patch("app.research.fetch_abstract_by_id", new=fake_fetch), \
         patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=True))
    assert len(got) == 1
    assert got[0]["_ev_status"] == "ok"
    assert got[0]["finding"] == "f"


def test_missing_abstract_no_fetch_marks_no_abstract() -> None:
    refs = [_ref(0, has_abs=False, doi=None, pmid=None)]

    async def fake_batch(field, items):
        raise AssertionError("must not call LLM for empty abstracts")

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=True))
    assert got[0]["_ev_status"] == "no_abstract"
    assert got[0]["finding"] == ""


def test_batch_error_marks_extract_error_but_other_batch_ok() -> None:
    refs = [_ref(i) for i in range(9)]  # 2 batches: 8 + 1
    call_count = {"n": 0}

    async def fake_batch(field, items):
        call_count["n"] += 1
        if len(items) == 1:
            raise RuntimeError("LLM down")
        return {gi: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 2} for gi, _ in items}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=False))
    ok = [e for e in got if e["_ev_status"] == "ok"]
    err = [e for e in got if e["_ev_status"] == "extract_error"]
    assert len(ok) == 8 and len(err) == 1


def test_result_carries_key() -> None:
    refs = [_ref(0, doi="10.1/abc", pmid="42")]

    async def fake_batch(field, items):
        return {items[0][0]: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 1}}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=False))
    assert got[0]["key"] == "pmid:42"  # key precedence pmid > doi > url


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK  {name}")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
.venv/Scripts/python.exe -m pytest test_extract_evidence_endpoint.py -v
```

Expected: FAIL with `ImportError: cannot import name 'extract_evidence_for_refs' from 'app.research'`.

- [ ] **Step 3: Implement `extract_evidence_for_refs`**

Add to `backend/app/research.py`, right after `_extract_evidence` (currently ends around line 437). Also add an import for `fetch_abstract_by_id` at the existing `from .literature import search_literature` line.

Modify the import (existing line ~26):
```python
from .literature import search_literature, fetch_abstract_by_id
```

Append new function (after `_extract_evidence`):
```python
def _ref_key(p: dict) -> str:
    """Stable key for a ref: pmid > doi > url. Matches frontend evidenceByKey."""
    if p.get("pmid"):
        return f"pmid:{p['pmid']}"
    if p.get("doi"):
        return f"doi:{p['doi']}"
    if p.get("url"):
        return f"url:{p['url']}"
    return f"title:{(p.get('title') or '').strip()[:60]}"


async def extract_evidence_for_refs(
    refs: list[dict],
    field: str = "",
    fetch_missing: bool = True,
) -> list[dict]:
    """Public wrapper: given a list of refs (possibly imported without abstracts),
    optionally backfill abstracts by id, batch-extract structured evidence via
    the existing _extract_batch pipeline, and return one row per input ref
    preserving order.

    Each output row: {key, pop, design, finding, gap, rel?, rel_why?, _ev_status}.
    _ev_status: "ok" | "no_abstract" | "extract_error".
    """
    n = len(refs)
    out: list[dict] = [{} for _ in range(n)]
    to_extract: list[tuple[int, dict]] = []

    # Phase 1: backfill missing abstracts (if requested), determine what to extract.
    for i, p in enumerate(refs):
        ab = (p.get("abstract") or "").strip()
        if not ab and fetch_missing:
            try:
                fetched = await fetch_abstract_by_id(p.get("doi"), p.get("pmid"))
            except Exception:  # noqa: BLE001
                fetched = None
            if fetched:
                p = dict(p)  # do not mutate caller's dict
                p["abstract"] = fetched
                ab = fetched
        if ab:
            to_extract.append((i, p))
        else:
            out[i] = {
                "key": _ref_key(p),
                "pop": "", "design": "", "finding": "", "gap": "",
                "_ev_status": "no_abstract",
            }

    # Phase 2: LLM batches of 8, per-batch error isolation.
    batches = [to_extract[k : k + 8] for k in range(0, len(to_extract), 8)]
    results = await asyncio.gather(
        *[_extract_batch(field or "", batch) for batch in batches],
        return_exceptions=True,
    )
    for batch, res in zip(batches, results):
        if isinstance(res, Exception):
            for gi, p in batch:
                out[gi] = {
                    "key": _ref_key(p),
                    "pop": "", "design": "", "finding": "", "gap": "",
                    "_ev_status": "extract_error",
                }
            continue
        assert isinstance(res, dict)
        for gi, p in batch:
            row = res.get(gi) or {}
            out[gi] = {
                "key": _ref_key(p),
                "pop": row.get("pop") or "",
                "design": row.get("design") or "",
                "finding": row.get("finding") or "",
                "gap": row.get("gap") or "",
                "rel": row.get("rel"),
                "rel_why": row.get("rel_why") or "",
                "_ev_status": "ok",
            }
    return out
```

**Note on `_extract_batch` signature:** it takes `items: list[tuple[int, dict]]` where the int is a caller-assigned index and returns `{that_index: row}`. We reuse this by passing our `i` as the index. `_extract_batch` reads `p.get("abstract")` internally, so backfilling `p["abstract"]` before calling it is sufficient.

- [ ] **Step 4: Run test to verify it passes**

```bash
.venv/Scripts/python.exe -m pytest test_extract_evidence_endpoint.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add backend/app/research.py backend/test_extract_evidence_endpoint.py
git commit -m "feat(research): extract_evidence_for_refs wrapper for import pipeline"
```

---

## Task 3: Backend — `POST /api/refs/extract-evidence` endpoint

**Files:**
- Modify: `backend/app/routes/text_gen.py` (add route)
- Extend: `backend/test_extract_evidence_endpoint.py` (add endpoint-level tests)

- [ ] **Step 1: Write the failing endpoint test**

Append to `backend/test_extract_evidence_endpoint.py`:

```python
# ---- endpoint tests ------------------------------------------------------
from fastapi.testclient import TestClient
from unittest.mock import patch


def _get_client():
    from app.main import app
    return TestClient(app)


def test_endpoint_returns_evidence_list() -> None:
    async def fake_wrapper(refs, field="", fetch_missing=True):
        return [{"key": f"pmid:P{i}", "pop": "p", "design": "d", "finding": "f",
                 "gap": "g", "rel": 2, "rel_why": "", "_ev_status": "ok"}
                for i, _ in enumerate(refs)]

    with patch("app.routes.text_gen.extract_evidence_for_refs", new=fake_wrapper):
        c = _get_client()
        payload = {"refs": [_ref(0), _ref(1)], "fetch_missing_abstracts": True}
        r = c.post("/api/refs/extract-evidence", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert len(body["evidence"]) == 2
    assert body["evidence"][0]["key"].startswith("pmid:")


def test_endpoint_empty_refs_returns_empty() -> None:
    c = _get_client()
    r = c.post("/api/refs/extract-evidence", json={"refs": []})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "evidence": []}


def test_endpoint_defaults_fetch_missing_true() -> None:
    seen = {"flag": None}

    async def fake_wrapper(refs, field="", fetch_missing=True):
        seen["flag"] = fetch_missing
        return []

    with patch("app.routes.text_gen.extract_evidence_for_refs", new=fake_wrapper):
        c = _get_client()
        c.post("/api/refs/extract-evidence", json={"refs": [_ref(0)]})  # omit flag
    assert seen["flag"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
.venv/Scripts/python.exe -m pytest test_extract_evidence_endpoint.py -v
```

Expected: 3 new tests fail with `404` (route missing).

- [ ] **Step 3: Add the route to `text_gen.py`**

Find the existing `from ..research import` block near the top of `backend/app/routes/text_gen.py` and add `extract_evidence_for_refs`. (If the file imports `research` as a whole module, add the specific import at top of file.)

Add a Pydantic model near the other `RunRequest`-style models at the top of the file:

```python
class ExtractEvidenceRequest(BaseModel):
    refs: list[dict] = []
    fetch_missing_abstracts: bool = True
    field: str = ""
```

Add the route (place it near `/api/refs/import` if that lives here, otherwise near the grant endpoints):

```python
@router.post("/api/refs/extract-evidence")
async def refs_extract_evidence_ep(req: ExtractEvidenceRequest) -> JSONResponse:
    """Extract structured evidence (pop/design/finding/gap) for a list of refs.
    Auto-fetches missing abstracts by DOI/PMID unless fetch_missing_abstracts=False.
    Used by RefIO/Zotero import path so imported refs get 核心发现 badges.
    """
    try:
        evidence = await extract_evidence_for_refs(
            req.refs,
            field=req.field,
            fetch_missing=req.fetch_missing_abstracts,
        )
        return JSONResponse({"ok": True, "evidence": evidence})
    except Exception as e:  # noqa: BLE001
        log_swallow("提取核心发现: 失败", e)
        return JSONResponse(status_code=500, content={"error": f"提取失败：{type(e).__name__}: {e}"})
```

If `extract_evidence_for_refs` is not already imported at the top of `text_gen.py`, add it:

```python
from ..research import extract_evidence_for_refs
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
.venv/Scripts/python.exe -m pytest test_extract_evidence_endpoint.py -v
```

Expected: 8 passed (5 unit + 3 endpoint).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add backend/app/routes/text_gen.py backend/test_extract_evidence_endpoint.py
git commit -m "feat(api): POST /api/refs/extract-evidence for import evidence"
```

---

## Task 4: Backend — `write_grant` honors `provided_refs`

**Files:**
- Modify: `backend/app/grant.py` (around line 832-849, the `research` search block in `write_grant`)
- Test: `backend/test_grant_provided_refs.py` (new)

**Rationale:** When the frontend picker has already selected refs, we must not do the pre-writing re-search; we use `provided_refs` verbatim as the ref pool.

- [ ] **Step 1: Write the failing test**

Create `backend/test_grant_provided_refs.py`:

```python
"""write_grant: when inputs.provided_refs is set, skip pre-writing re-search."""
import asyncio
from unittest.mock import patch, AsyncMock

from app import config


def _run_gen(gen):
    async def collect():
        events = []
        async for ev in gen:
            events.append(ev)
        return events
    return asyncio.get_event_loop().run_until_complete(collect())


def test_provided_refs_skips_search():
    # settings.mock triggers mock path early; disable to hit the real branch.
    from app.grant import write_grant

    provided = [{"pmid": "P1", "title": "provided one", "first_author": "A",
                 "year": "2024", "journal": "J", "url": "https://x/1", "abstract": "ab"}]

    with patch("app.grant.settings", type("S", (), {"mock": True})()):
        # mock mode short-circuits into _mock_write; not what we need for this test.
        # Instead, force non-mock and mock stream_chat + review + verify to noop.
        pass

    # Non-mock path: patch expensive/network calls to no-ops.
    async def noop_stream(*args, **kwargs):
        if False:
            yield ""
        return

    async def noop_search(*args, **kwargs):
        raise AssertionError("search_literature must NOT be called when provided_refs is set")

    async def noop_gen_queries(*a, **kw):
        return ["q"]

    async def noop_run_review(*a, **kw):
        if False:
            yield ("delta", {"text": ""})
        return

    with patch("app.grant.settings", type("S", (), {"mock": False})()), \
         patch("app.grant.search_literature", new=noop_search), \
         patch("app.grant._gen_queries", new=noop_gen_queries), \
         patch("app.grant.stream_chat", side_effect=lambda *a, **k: noop_stream()), \
         patch("app.grant._run_review", side_effect=lambda *a, **k: noop_run_review()), \
         patch("app.grant._verify_citations", return_value={"total": 0, "verified": 0}):
        inputs = {
            "title": "T", "idea": "i", "report": "r", "background": "",
            "grant_type": "nsfc-general",
            "references": provided,
            "provided_refs": provided,
            "research": True,  # would normally trigger search, but provided_refs wins
            "scheme": {"title": "T"},
            "sections": [{"key": "背景", "title": "背景", "budget": 200}],
        }
        events = _run_gen(write_grant(inputs))

    # No AssertionError from noop_search means search was skipped. Also verify
    # a "references" event was emitted carrying our provided set.
    ref_events = [d for name, d in events if name == "references"]
    assert any(d.get("items") == provided for d in ref_events) or not ref_events, \
        "if references event was emitted, it must carry provided_refs"


def test_no_provided_refs_uses_research_flag():
    """When provided_refs absent and research=True, search_literature IS called."""
    from app.grant import write_grant
    called = {"n": 0}

    async def spy_search(*args, **kwargs):
        called["n"] += 1
        return {"papers": []}

    async def noop_stream(*args, **kwargs):
        if False:
            yield ""
        return

    async def noop_gen_queries(*a, **kw):
        return ["q"]

    async def noop_run_review(*a, **kw):
        if False:
            yield ("delta", {"text": ""})
        return

    with patch("app.grant.settings", type("S", (), {"mock": False})()), \
         patch("app.grant.search_literature", new=spy_search), \
         patch("app.grant._gen_queries", new=noop_gen_queries), \
         patch("app.grant.stream_chat", side_effect=lambda *a, **k: noop_stream()), \
         patch("app.grant._run_review", side_effect=lambda *a, **k: noop_run_review()), \
         patch("app.grant._verify_citations", return_value={"total": 0, "verified": 0}):
        inputs = {
            "title": "T", "idea": "i", "report": "r", "background": "",
            "grant_type": "nsfc-general",
            "research": True,
            "scheme": {"title": "T"},
            "sections": [{"key": "背景", "title": "背景", "budget": 200}],
        }
        _run_gen(write_grant(inputs))
    assert called["n"] >= 1


if __name__ == "__main__":
    test_provided_refs_skips_search()
    print("OK  test_provided_refs_skips_search")
    test_no_provided_refs_uses_research_flag()
    print("OK  test_no_provided_refs_uses_research_flag")
```

- [ ] **Step 2: Run test to verify failure**

```bash
.venv/Scripts/python.exe -m pytest test_grant_provided_refs.py -v
```

Expected: `test_provided_refs_skips_search` fails with the AssertionError from `noop_search` (because current code will call search even when `provided_refs` is set).

- [ ] **Step 3: Modify `write_grant` to honor `provided_refs`**

In `backend/app/grant.py`, locate `async def write_grant(inputs)`. Near where `refs` is initially populated from `inputs.get("references")`, add:

```python
    # New in 2026-07-04: frontend picker may pass an already-chosen set that
    # bypasses the pre-writing re-search entirely.
    provided = inputs.get("provided_refs")
    if isinstance(provided, list) and provided:
        refs = list(provided)
```

Then modify the search block (currently around lines 834-848). Change:

```python
        if inputs.get("research", True):
```

to:

```python
        # provided_refs short-circuits the re-search: picker already chose.
        if not (isinstance(inputs.get("provided_refs"), list) and inputs.get("provided_refs")) \
                and inputs.get("research", True):
```

- [ ] **Step 4: Run test to verify pass**

```bash
.venv/Scripts/python.exe -m pytest test_grant_provided_refs.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add backend/app/grant.py backend/test_grant_provided_refs.py
git commit -m "feat(grant): honor provided_refs to skip pre-writing re-search"
```

---

## Task 5: Backend — `POST /api/grant/search` endpoint (search + evidence, standalone)

**Files:**
- Modify: `backend/app/grant.py` (add new module-level `async def search_grant(inputs)` generator)
- Modify: `backend/app/routes/text_gen.py` (mount route)
- Test: extend `backend/test_grant_provided_refs.py`

**Rationale:** GrantModule's new Step 1.5 needs to run just the literature search + evidence extraction (same pipeline `preResearch` uses today) without writing. Refactor the block into a callable generator and expose it.

- [ ] **Step 1: Write the failing test**

Append to `backend/test_grant_provided_refs.py`:

```python
def test_grant_search_endpoint_yields_refs_and_evidence():
    """search_grant streams references and evidence; skips writing."""
    from app.grant import search_grant

    fake_papers = [
        {"pmid": "P1", "title": "Fake", "first_author": "A", "year": "2024",
         "journal": "J", "url": "https://x/1", "abstract": "ab"},
    ]

    async def fake_search(*a, **kw):
        return {"papers": fake_papers}

    async def fake_gen_queries(*a, **kw):
        return ["q"]

    async def fake_evidence(refs, field="", fetch_missing=True):
        return [{"key": "pmid:P1", "pop": "p", "design": "d", "finding": "f",
                 "gap": "g", "rel": 3, "rel_why": "", "_ev_status": "ok"}]

    with patch("app.grant.settings", type("S", (), {"mock": False})()), \
         patch("app.grant.search_literature", new=fake_search), \
         patch("app.grant._gen_queries", new=fake_gen_queries), \
         patch("app.grant.extract_evidence_for_refs", new=fake_evidence):
        events = _run_gen(search_grant({"title": "T", "idea": "diabetic nephropathy"}))

    names = [n for n, _ in events]
    assert "references" in names
    assert "evidence" in names
    assert "done" in names
    ref_event = next(d for n, d in events if n == "references")
    assert ref_event["items"] == fake_papers
```

- [ ] **Step 2: Run test**

Expected: FAIL — `search_grant` does not exist.

- [ ] **Step 3: Implement `search_grant`**

Add to `backend/app/grant.py`, near the top-level imports:

```python
from .research import _verify_citations, _gen_queries, _pkey, _QUOTE_RULE, extract_evidence_for_refs
```

(Extending the existing `.research` import line.)

Add module-level function (place near `write_grant`, e.g., right after `_RERESEARCH_SOURCES` constant):

```python
async def search_grant(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    """Standalone search for GrantModule Step 1.5: PubMed/EPMC/OpenAlex/etc.
    plus structured-evidence extraction. Streams:
      ("status", ...) ("references", {"items": [...]}) ("evidence", {"items": [...]}) ("done", {})
    """
    title = (inputs.get("title") or "").strip()
    idea = (inputs.get("idea") or inputs.get("field") or "").strip()
    direction = idea or title
    if not direction:
        yield ("error", {"message": "缺少研究方向。"})
        return
    try:
        yield ("status", {"message": "正在把研究方向转成检索式…"})
        queries = await _gen_queries(direction, "", title)
        yield ("status", {"message": "正在检索 PubMed / Europe PMC / OpenAlex…"})
        res = await search_literature(queries, per_query=8, cap=16, sources=_RERESEARCH_SOURCES)
        papers = res.get("papers") or []
        yield ("references", {"items": papers})
        if papers:
            yield ("status", {"message": f"正在提取 {len(papers)} 篇文献的核心发现…"})
            evidence = await extract_evidence_for_refs(papers, field=direction, fetch_missing=False)
            yield ("evidence", {"items": evidence})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        yield ("error", {"message": f"检索失败：{type(e).__name__}: {e}"})
```

- [ ] **Step 4: Add the route**

In `backend/app/routes/text_gen.py`, near the other `/api/grant/*` endpoints:

```python
@router.post("/api/grant/search")
async def grant_search_ep(req: RunRequest) -> StreamingResponse:
    """写标书 Step 1.5: 单独跑一次文献检索 + 核心发现抽取 (供 picker 使用)。"""
    async def gen():
        from ..grant import search_grant
        async for event, data in search_grant(req.inputs):
            yield _sse(event, data)
    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
```

- [ ] **Step 5: Run test to verify pass**

```bash
.venv/Scripts/python.exe -m pytest test_grant_provided_refs.py -v
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add backend/app/grant.py backend/app/routes/text_gen.py backend/test_grant_provided_refs.py
git commit -m "feat(grant): POST /api/grant/search — standalone search + evidence for picker"
```

---

## Task 6: Frontend — `refHandoff.ts` module

**Files:**
- Create: `frontend/src/lib/refHandoff.ts`

**Rationale:** Tiny in-memory pipe between Idea/Grant pickers and FormatModule. Fires an event so FormatModule can react if already mounted; consume clears the pipe.

- [ ] **Step 1: Write the module**

Create `frontend/src/lib/refHandoff.ts`:

```typescript
import type { Reference, EvidenceItem } from "./sse";

export interface RefHandoff {
  refs: Reference[];
  evidence: Record<string, EvidenceItem>;
  from: "idea" | "grant";
}

let _stash: RefHandoff | null = null;

export const REFHANDOFF_EVENT = "refhandoff:pending";

export function stash(h: RefHandoff): void {
  _stash = h;
  try {
    window.dispatchEvent(new CustomEvent(REFHANDOFF_EVENT, { detail: { from: h.from, count: h.refs.length } }));
  } catch {
    // no-op: SSR / non-DOM
  }
}

export function peek(): RefHandoff | null {
  return _stash;
}

export function consume(): RefHandoff | null {
  const s = _stash;
  _stash = null;
  return s;
}
```

- [ ] **Step 2: Sanity-check compile**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx tsc --noEmit
```

Expected: no errors from `refHandoff.ts` (there may be pre-existing errors elsewhere — ignore those; verify no new ones referencing this file).

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/lib/refHandoff.ts
git commit -m "feat(frontend): refHandoff module for one-way ref pipe"
```

---

## Task 7: Frontend — `evidenceExtract.ts` client helper

**Files:**
- Create: `frontend/src/lib/evidenceExtract.ts`

- [ ] **Step 1: Write the module**

Create `frontend/src/lib/evidenceExtract.ts`:

```typescript
import type { Reference, EvidenceItem } from "./sse";

/** Match backend _ref_key: pmid > doi > url > title. */
export function refKey(r: Reference): string {
  if (r.pmid) return `pmid:${r.pmid}`;
  if (r.doi) return `doi:${r.doi}`;
  if (r.url) return `url:${r.url}`;
  return `title:${(r.title || "").trim().slice(0, 60)}`;
}

interface ExtractedRow {
  key: string;
  pop: string;
  design: string;
  finding: string;
  gap: string;
  rel?: number;
  rel_why?: string;
  _ev_status: "ok" | "no_abstract" | "extract_error";
}

/** POST /api/refs/extract-evidence in client-side batches of 8. Merges partial
 *  successes so one failing chunk doesn't fail the whole call. Returns a map
 *  from refKey → EvidenceItem shape (with _ev_status attached). */
export async function extractEvidenceForRefs(
  refs: Reference[],
  onProgress?: (done: number, total: number) => void,
  fetchMissingAbstracts: boolean = true,
): Promise<Record<string, EvidenceItem & { _ev_status?: string }>> {
  const total = refs.length;
  const out: Record<string, EvidenceItem & { _ev_status?: string }> = {};
  if (!total) return out;

  const CHUNK = 8;
  let done = 0;

  for (let i = 0; i < total; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK);
    try {
      const r = await fetch("/api/refs/extract-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: chunk, fetch_missing_abstracts: fetchMissingAbstracts }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const rows: ExtractedRow[] = (data && data.evidence) || [];
      rows.forEach((row, j) => {
        const ref = chunk[j];
        if (!ref) return;
        out[row.key || refKey(ref)] = {
          index: i + j,
          first_author: ref.first_author,
          year: ref.year,
          title: ref.title,
          journal: ref.journal,
          url: ref.url,
          source: ref.source || "",
          cited_by_count: ref.cited_by_count || 0,
          oa_url: ref.oa_url,
          pop: row.pop,
          design: row.design,
          finding: row.finding,
          gap: row.gap,
          _ev_status: row._ev_status,
        } as EvidenceItem & { _ev_status?: string };
      });
    } catch {
      // Chunk failure: mark all as extract_error so UI can show retry affordance.
      chunk.forEach((ref, j) => {
        out[refKey(ref)] = {
          index: i + j,
          first_author: ref.first_author,
          year: ref.year,
          title: ref.title,
          journal: ref.journal,
          url: ref.url,
          source: ref.source || "",
          cited_by_count: ref.cited_by_count || 0,
          pop: "", design: "", finding: "", gap: "",
          _ev_status: "extract_error",
        } as EvidenceItem & { _ev_status?: string };
      });
    }
    done = Math.min(total, i + CHUNK);
    onProgress?.(done, total);
  }
  return out;
}
```

- [ ] **Step 2: Sanity-check compile**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx tsc --noEmit
```

Expected: no new errors from `evidenceExtract.ts`.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/lib/evidenceExtract.ts
git commit -m "feat(frontend): evidenceExtract client helper (batches of 8)"
```

---

## Task 8: Frontend — extract `<LiteraturePicker>` from IdeaModule Step 3

**Files:**
- Create: `frontend/src/components/LiteraturePicker.tsx`
- Modify: `frontend/src/modules/IdeaModule.tsx` (replace Step-3 inline block with `<LiteraturePicker>`)

**Rationale:** IdeaModule Step 3 already has the exact picker UI we need — checkbox list, RefIO+ZoteroPanel, evidence badges. Extract it verbatim as a reusable component. IdeaModule must render identically after the swap.

- [ ] **Step 1: Read the current Step-3 block**

Open `frontend/src/modules/IdeaModule.tsx` and identify:
- Where `refs`, `selectedKeys`, `evidence`, `evByRef` are declared (~L144, ~L384).
- The Step-3 JSX block that renders the row list including `RefIO`, `ZoteroPanel`, the checkbox, the title link, and the "核心发现" line (~L676-782).

Note the exact JSX and CSS class names in use — do not change them.

- [ ] **Step 2: Create `LiteraturePicker.tsx`**

Create `frontend/src/components/LiteraturePicker.tsx`:

```tsx
import { useMemo, type ReactNode } from "react";
import type { Reference, EvidenceItem } from "../lib/sse";
import { RefIO } from "./RefIO";
import { ZoteroPanel } from "./ZoteroPanel";

/** Key precedence must match backend _ref_key and frontend refKey. */
export function pickerKey(r: Reference): string {
  if (r.pmid) return `pmid:${r.pmid}`;
  if (r.doi) return `doi:${r.doi}`;
  if (r.url) return `url:${r.url}`;
  return `title:${(r.title || "").trim().slice(0, 60)}`;
}

export interface LiteraturePickerProps {
  refs: Reference[];
  evidenceByKey: Record<string, EvidenceItem & { _ev_status?: string }>;
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  onImport?: (imported: Reference[]) => void;
  mode?: "picker" | "list";
  primaryAction?: { label: string; onClick: (checked: Reference[]) => void; disabled?: boolean };
  secondaryAction?: { label: string; onClick: (checked: Reference[]) => void; disabled?: boolean };
  exportFilename?: string;
  showZotero?: boolean;
  header?: ReactNode;
  extractionStatus?: { done: number; total: number } | null;
}

export function LiteraturePicker(props: LiteraturePickerProps) {
  const {
    refs, evidenceByKey, selectedKeys, onSelectionChange,
    onImport, mode = "picker", primaryAction, secondaryAction,
    exportFilename = "references", showZotero = true, header, extractionStatus,
  } = props;

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const checkedRefs = useMemo(
    () => refs.filter((r) => selectedSet.has(pickerKey(r))),
    [refs, selectedSet],
  );

  const toggle = (key: string) => {
    if (selectedSet.has(key)) {
      onSelectionChange(selectedKeys.filter((k) => k !== key));
    } else {
      onSelectionChange([...selectedKeys, key]);
    }
  };

  const toggleAll = () => {
    if (selectedSet.size === refs.length) onSelectionChange([]);
    else onSelectionChange(refs.map(pickerKey));
  };

  return (
    <div className="lit-picker">
      {header}
      <div className="lit-picker-toolbar">
        <button type="button" onClick={toggleAll} disabled={!refs.length}>
          {selectedSet.size === refs.length && refs.length ? "取消全选" : "全选"}
        </button>
        <span className="lit-picker-count">
          已选 {selectedSet.size} / {refs.length}
        </span>
        {extractionStatus && (
          <span className="lit-picker-progress">
            正在提取核心发现 {extractionStatus.done}/{extractionStatus.total}…
          </span>
        )}
        <div className="lit-picker-io">
          <RefIO
            currentRefs={refs}
            onImport={(imported) => onImport?.(imported)}
            exportFilename={exportFilename}
          />
          {showZotero && (
            <ZoteroPanel
              currentRefs={refs}
              onImport={(imported) => onImport?.(imported)}
              selectedForPush={checkedRefs}
            />
          )}
        </div>
      </div>

      <ul className="lit-picker-list">
        {refs.map((r) => {
          const k = pickerKey(r);
          const ev = evidenceByKey[k];
          const checked = selectedSet.has(k);
          return (
            <li key={k} className={"lit-picker-row" + (checked ? " selected" : "")}>
              <label className="lit-picker-check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(k)}
                />
              </label>
              <div className="lit-picker-body">
                <div className="lit-picker-title">
                  <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                </div>
                <div className="lit-picker-meta">
                  {r.first_author} · {r.year} · {r.journal}
                  {r.journal_impact != null && <> · IF {r.journal_impact}</>}
                  {r.journal_quartile && <> · {r.journal_quartile}</>}
                  {r.source && <> · {r.source}</>}
                </div>
                <div className="lit-picker-evidence">
                  {ev?._ev_status === "no_abstract" ? (
                    <span className="ev-chip ev-empty">无摘要，未提取</span>
                  ) : ev?._ev_status === "extract_error" ? (
                    <span className="ev-chip ev-error">核心发现提取失败</span>
                  ) : ev ? (
                    <>
                      <span className="ev-chip">对象: {ev.pop || "—"}</span>
                      <span className="ev-chip">设计: {ev.design || "—"}</span>
                      <span className="ev-chip ev-finding">发现: {ev.finding || "—"}</span>
                      <span className="ev-chip">局限: {ev.gap || "—"}</span>
                    </>
                  ) : (
                    <span className="ev-chip ev-pending">待提取…</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {mode === "picker" && (primaryAction || secondaryAction) && (
        <div className="lit-picker-actions">
          {secondaryAction && (
            <button
              type="button"
              onClick={() => secondaryAction.onClick(checkedRefs)}
              disabled={secondaryAction.disabled || checkedRefs.length === 0}
            >
              {secondaryAction.label}
            </button>
          )}
          {primaryAction && (
            <button
              type="button"
              className="primary"
              onClick={() => primaryAction.onClick(checkedRefs)}
              disabled={primaryAction.disabled || checkedRefs.length === 0}
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add CSS for the picker**

Append to `frontend/src/styles.css`:

```css
/* LiteraturePicker (extracted from IdeaModule Step 3) */
.lit-picker { display: flex; flex-direction: column; gap: 12px; }
.lit-picker-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lit-picker-count { color: var(--text-muted, #666); font-size: 0.9em; }
.lit-picker-progress { color: var(--accent, #0a7); font-size: 0.85em; }
.lit-picker-io { margin-left: auto; display: flex; gap: 8px; }
.lit-picker-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.lit-picker-row { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border, #ddd); border-radius: 6px; }
.lit-picker-row.selected { border-color: var(--accent, #0a7); background: var(--accent-bg, rgba(0,170,119,0.05)); }
.lit-picker-check { display: flex; align-items: flex-start; padding-top: 2px; }
.lit-picker-body { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.lit-picker-title a { font-weight: 600; }
.lit-picker-meta { font-size: 0.85em; color: var(--text-muted, #666); }
.lit-picker-evidence { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.ev-chip { font-size: 0.8em; padding: 2px 8px; border-radius: 10px; background: var(--chip-bg, #eef); }
.ev-chip.ev-finding { background: var(--chip-finding-bg, #efe); }
.ev-chip.ev-empty, .ev-chip.ev-pending { background: transparent; color: var(--text-muted, #888); }
.ev-chip.ev-error { background: var(--chip-error-bg, #fee); color: var(--error, #a00); }
.lit-picker-actions { display: flex; justify-content: flex-end; gap: 8px; }
.lit-picker-actions .primary { background: var(--accent, #0a7); color: white; }
```

- [ ] **Step 4: Wire `LiteraturePicker` into IdeaModule Step 3**

In `frontend/src/modules/IdeaModule.tsx`:

1. Add imports at the top:
```tsx
import { LiteraturePicker, pickerKey } from "../components/LiteraturePicker";
import { extractEvidenceForRefs } from "../lib/evidenceExtract";
import { stash as stashHandoff } from "../lib/refHandoff";
```

2. Build the `evidenceByKey` map from existing `evidence` state:
```tsx
const evidenceByKey = useMemo(() => {
  const m: Record<string, EvidenceItem & { _ev_status?: string }> = {};
  for (const e of evidence) {
    // Map from EvidenceItem URL/title back to a ref key.
    const r = refs.find((x) => x.url === e.url || x.title === e.title);
    if (r) m[pickerKey(r)] = e;
  }
  return m;
}, [evidence, refs]);
```

3. Replace the existing Step-3 inline picker block (the `<ul>` that lists refs with checkboxes, `RefIO`, `ZoteroPanel`) with:

```tsx
<LiteraturePicker
  refs={refs}
  evidenceByKey={evidenceByKey}
  selectedKeys={selectedKeys}
  onSelectionChange={setSelectedKeys}
  onImport={async (imported) => {
    // Merge into refs (dedupe by key); upgrade rows if imported has abstract.
    const keyMap = new Map(refs.map((r) => [pickerKey(r), r]));
    for (const imp of imported) {
      const k = pickerKey(imp);
      const existing = keyMap.get(k);
      if (!existing) keyMap.set(k, imp);
      else if (!existing.abstract && imp.abstract) keyMap.set(k, { ...existing, ...imp, abstract: imp.abstract });
    }
    const merged = Array.from(keyMap.values());
    setRefs(merged);
    const newOnes = imported.filter((imp) => !refs.some((r) => pickerKey(r) === pickerKey(imp)));
    if (!newOnes.length) return;
    setEvidenceExtractProgress({ done: 0, total: newOnes.length });
    const evMap = await extractEvidenceForRefs(newOnes, (d, t) => setEvidenceExtractProgress({ done: d, total: t }));
    // Merge into existing evidence[] (append new EvidenceItem-shaped rows).
    setEvidence((prev) => {
      const next = [...prev];
      for (const key of Object.keys(evMap)) {
        const row = evMap[key];
        // Skip if URL already covered by prev to avoid dupes.
        if (prev.some((p) => p.url === row.url)) continue;
        next.push(row);
      }
      return next;
    });
    setEvidenceExtractProgress(null);
  }}
  primaryAction={{
    label: "→ 期刊排版",
    onClick: (checked) => {
      const subset: Record<string, EvidenceItem & { _ev_status?: string }> = {};
      for (const r of checked) {
        const k = pickerKey(r);
        if (evidenceByKey[k]) subset[k] = evidenceByKey[k];
      }
      stashHandoff({ refs: checked, evidence: subset, from: "idea" });
      // Existing tab-switch mechanism — locate the current one in this file.
      // Look for `setTab("format")` or equivalent and reuse it.
      switchToFormatTab();
    },
  }}
  extractionStatus={evidenceExtractProgress}
  exportFilename="idea-refs"
/>
```

4. Add the progress state near other useState calls:
```tsx
const [evidenceExtractProgress, setEvidenceExtractProgress] = useState<{done:number;total:number}|null>(null);
```

5. Replace `switchToFormatTab` placeholder with the actual mechanism used elsewhere in IdeaModule (search this file and `App.tsx` for how modules switch tabs — typically a prop like `onSwitchTab` or a shared context).

- [ ] **Step 5: Verify IdeaModule builds and renders identically**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx tsc --noEmit
npm run build
```

Expected: no TS errors; build succeeds. Then start the backend and open the app. Run the 找选题 flow through Step 3 with an existing query and verify: same rows, same evidence badges, same import/export behavior. If any visual difference exists, adjust CSS in `styles.css` (Step 3 above) to match the previous appearance.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/components/LiteraturePicker.tsx frontend/src/styles.css frontend/src/modules/IdeaModule.tsx
git commit -m "refactor(idea): extract LiteraturePicker; add evidence-on-import + handoff button"
```

---

## Task 9: Frontend — GrantModule Step 1.5 picker stage

**Files:**
- Modify: `frontend/src/modules/GrantModule.tsx`

**Rationale:** When `preResearch` is on, insert a picker stage that calls `/api/grant/search`, streams refs + evidence, presents the checkbox picker, and hands `provided_refs` into the writing endpoint. When `preResearch` is off, skip the picker (unchanged behavior).

- [ ] **Step 1: Add local state for the picker stage**

Near existing `useState` calls in `GrantModule.tsx`, add:

```tsx
type GrantStage = "prepare" | "picker" | "writing" | "done";
const [stage, setStage] = useState<GrantStage>("prepare");
const [searchRefs, setSearchRefs] = useState<Reference[]>([]);
const [searchEvidence, setSearchEvidence] = useState<Record<string, EvidenceItem & { _ev_status?: string }>>({});
const [searchSelectedKeys, setSearchSelectedKeys] = useState<string[]>([]);
const [searchBusy, setSearchBusy] = useState(false);
const [pickerExtractProgress, setPickerExtractProgress] = useState<{done:number;total:number}|null>(null);
```

Also import:
```tsx
import { LiteraturePicker, pickerKey } from "../components/LiteraturePicker";
import { extractEvidenceForRefs } from "../lib/evidenceExtract";
import { stash as stashHandoff } from "../lib/refHandoff";
import type { Reference, EvidenceItem } from "../lib/sse";
```

(`Reference` / `EvidenceItem` may already be imported — check first.)

- [ ] **Step 2: Add the search launcher**

Somewhere in the module, add:

```tsx
async function launchGrantSearch() {
  setSearchBusy(true);
  setSearchRefs([]);
  setSearchEvidence({});
  setSearchSelectedKeys([]);
  setStage("picker");
  try {
    const res = await fetch("/api/grant/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: { title, idea: field, background } }),
    });
    if (!res.body) throw new Error("no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // parse SSE `event: X\ndata: {...}`
        const evLine = chunk.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!evLine || !dataLine) continue;
        const evName = evLine.slice(6).trim();
        const data = JSON.parse(dataLine.slice(5).trim());
        if (evName === "references") setSearchRefs(data.items || []);
        else if (evName === "evidence") {
          const map: Record<string, EvidenceItem & { _ev_status?: string }> = {};
          for (const row of data.items || []) map[row.key] = row;
          setSearchEvidence(map);
        }
        // status/done/error handled implicitly via setSearchBusy(false) at end
      }
    }
  } catch (e) {
    console.error("grant search failed", e);
  } finally {
    setSearchBusy(false);
  }
}
```

**Note:** If the module already has an SSE parser helper (search this file and `frontend/src/lib/sse.ts`), use it instead of reimplementing. The above is a fallback if none exists.

- [ ] **Step 3: Modify the "开始写作" trigger**

Find the current button that transitions from Step 1 to writing (search for `startWriting` or the `/api/grant` fetch, around L310). Split into two branches:

```tsx
async function startFlow() {
  if (preResearch) {
    await launchGrantSearch();
  } else {
    await beginWriting([]);  // empty provided_refs -> backend behavior unchanged
  }
}

async function beginWriting(provided: Reference[]) {
  setStage("writing");
  // ...existing fetch to /api/grant, but include provided_refs in inputs:
  const payload = {
    inputs: {
      title, idea: field, report: mergedReport, background,
      grant_type: grantType, references: refs,
      research: preResearch,
      provided_refs: provided.length ? provided : undefined,
      style_profile: effStyle,
    },
  };
  // ...existing SSE consumption unchanged
}
```

Replace the current button `onClick` with `startFlow`.

- [ ] **Step 4: Render the picker stage**

Around the existing Step 2 JSX, add a conditional Step 1.5 block:

```tsx
{stage === "picker" && (
  <section className="grant-picker-stage">
    <h3>检索到的文献 — 请勾选要写进标书的文献</h3>
    <LiteraturePicker
      refs={searchRefs}
      evidenceByKey={searchEvidence}
      selectedKeys={searchSelectedKeys}
      onSelectionChange={setSearchSelectedKeys}
      onImport={async (imported) => {
        const keyMap = new Map(searchRefs.map((r) => [pickerKey(r), r]));
        for (const imp of imported) {
          const k = pickerKey(imp);
          const existing = keyMap.get(k);
          if (!existing) keyMap.set(k, imp);
          else if (!existing.abstract && imp.abstract) keyMap.set(k, { ...existing, ...imp, abstract: imp.abstract });
        }
        const merged = Array.from(keyMap.values());
        setSearchRefs(merged);
        const newOnes = imported.filter((imp) => !searchRefs.some((r) => pickerKey(r) === pickerKey(imp)));
        if (!newOnes.length) return;
        setPickerExtractProgress({ done: 0, total: newOnes.length });
        const evMap = await extractEvidenceForRefs(newOnes, (d, t) => setPickerExtractProgress({ done: d, total: t }));
        setSearchEvidence((prev) => ({ ...prev, ...evMap }));
        setPickerExtractProgress(null);
      }}
      primaryAction={{
        label: searchBusy ? "检索中…" : "开始写作",
        onClick: (checked) => beginWriting(checked),
        disabled: searchBusy,
      }}
      secondaryAction={{
        label: "→ 期刊排版",
        onClick: (checked) => {
          const subset: Record<string, EvidenceItem & { _ev_status?: string }> = {};
          for (const r of checked) {
            const k = pickerKey(r);
            if (searchEvidence[k]) subset[k] = searchEvidence[k];
          }
          stashHandoff({ refs: checked, evidence: subset, from: "grant" });
          switchToFormatTab();  // same helper as IdeaModule
        },
      }}
      extractionStatus={pickerExtractProgress}
      exportFilename="grant-refs"
    />
    {searchBusy && <div className="grant-picker-status">正在检索并提取核心发现…</div>}
    {!searchBusy && searchRefs.length === 0 && (
      <div className="grant-picker-empty">
        未检索到文献。
        <button type="button" onClick={() => beginWriting([])}>跳过,直接开始写作</button>
        <button type="button" onClick={launchGrantSearch}>重新检索</button>
      </div>
    )}
  </section>
)}
```

Gate the existing Step 2 writing UI with `stage === "writing" || stage === "done"`.

- [ ] **Step 5: Build + smoke test**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx tsc --noEmit
npm run build
```

Start backend, open 写标书, run a flow:
- With `preResearch` ON: after Step 1 you see the picker; pick 3 refs; click "开始写作"; verify writing runs and cites only picked refs.
- With `preResearch` OFF: verify Step 1 → writing directly (no regression).
- Click "→ 期刊排版" in the picker; verify tab switches to FormatModule (Task 11 will make it consume the stash).

- [ ] **Step 6: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/modules/GrantModule.tsx
git commit -m "feat(grant): Step 1.5 picker stage w/ provided_refs handoff to writing"
```

---

## Task 10: Frontend — FormatModule structured refs panel + Zotero + handoff consume

**Files:**
- Modify: `frontend/src/modules/FormatModule.tsx`

**Rationale:** Add checkbox selection + evidence badges on top of the existing `importedRefs` state. Add Zotero (via `LiteraturePicker` which embeds it). Consume `refHandoff` on mount. Wire format-refs / check-refs / Zotero push to structured refs when non-empty.

- [ ] **Step 1: Add state**

Near existing `useState` in `FormatModule.tsx`:

```tsx
const [structuredEvidence, setStructuredEvidence] = usePersistentState<Record<string, EvidenceItem & { _ev_status?: string }>>("format:evidence", {});
const [structuredSelectedKeys, setStructuredSelectedKeys] = usePersistentState<string[]>("format:selectedKeys", []);
const [formatExtractProgress, setFormatExtractProgress] = useState<{done:number;total:number}|null>(null);
```

Imports:
```tsx
import { LiteraturePicker, pickerKey } from "../components/LiteraturePicker";
import { extractEvidenceForRefs } from "../lib/evidenceExtract";
import { consume as consumeHandoff, REFHANDOFF_EVENT } from "../lib/refHandoff";
import type { EvidenceItem } from "../lib/sse";
```

- [ ] **Step 2: Consume handoff on mount and on event**

Add a useEffect near other useEffects:

```tsx
useEffect(() => {
  const drain = () => {
    const stash = consumeHandoff();
    if (!stash) return;
    setImportedRefs((prev) => {
      const keyMap = new Map(prev.map((r) => [pickerKey(r), r]));
      for (const r of stash.refs) keyMap.set(pickerKey(r), r);
      return Array.from(keyMap.values());
    });
    setStructuredEvidence((prev) => ({ ...prev, ...stash.evidence }));
    setStructuredSelectedKeys((prev) => {
      const s = new Set(prev);
      for (const r of stash.refs) s.add(pickerKey(r));
      return Array.from(s);
    });
    toast(`已从 ${stash.from === "idea" ? "找选题" : "写标书"} 带入 ${stash.refs.length} 篇文献`);
  };
  drain();  // mount
  window.addEventListener(REFHANDOFF_EVENT, drain);
  return () => window.removeEventListener(REFHANDOFF_EVENT, drain);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Use the existing `toast` helper — search this file for how notifications are surfaced today (may be `showToast`, or via a context). If none exists, use `alert` as fallback for now and leave a comment.

- [ ] **Step 3: Render the structured panel above the textarea**

Insert above the existing `<textarea value={refsInput} ...>` block (around L671):

```tsx
{(importedRefs.length > 0 || structuredSelectedKeys.length > 0) && (
  <section className="format-structured-refs">
    <h3>结构化参考文献（勾选后作为格式化/核验的输入）</h3>
    <LiteraturePicker
      refs={importedRefs}
      evidenceByKey={structuredEvidence}
      selectedKeys={structuredSelectedKeys}
      onSelectionChange={setStructuredSelectedKeys}
      mode="list"
      onImport={async (imported) => {
        const keyMap = new Map(importedRefs.map((r) => [pickerKey(r), r]));
        for (const imp of imported) {
          const k = pickerKey(imp);
          const existing = keyMap.get(k);
          if (!existing) keyMap.set(k, imp);
          else if (!existing.abstract && imp.abstract) keyMap.set(k, { ...existing, ...imp, abstract: imp.abstract });
        }
        const merged = Array.from(keyMap.values());
        setImportedRefs(merged);
        const newOnes = imported.filter((imp) => !importedRefs.some((r) => pickerKey(r) === pickerKey(imp)));
        if (!newOnes.length) return;
        setFormatExtractProgress({ done: 0, total: newOnes.length });
        const evMap = await extractEvidenceForRefs(newOnes, (d, t) => setFormatExtractProgress({ done: d, total: t }));
        setStructuredEvidence((prev) => ({ ...prev, ...evMap }));
        setFormatExtractProgress(null);
      }}
      extractionStatus={formatExtractProgress}
      exportFilename="format-refs"
      showZotero={true}
    />
  </section>
)}
```

**Note:** The existing `<RefIO onImport={...}>` block around L631 currently updates `importedRefs` and appends to `refsInput`. Keep it in place — it will now also feed through the picker view when `importedRefs.length > 0`. To avoid two RefIO widgets side-by-side, remove the standalone `<RefIO>` block from the current location and let the one embedded in `LiteraturePicker` be the only one. If the flow uses `importedRefs` for anything specific in the old RefIO callback (like text append), preserve that behavior in `onImport` above:

```tsx
// After merge, also append RIS-formatted text to refsInput so legacy flows keep working:
const asText = imported.map((r) => `${r.first_author} et al. (${r.year}). ${r.title}. ${r.journal}. ${r.url}`).join("\n");
setRefsInput((prev) => prev + (prev.endsWith("\n") || !prev ? "" : "\n") + asText);
```

- [ ] **Step 4: Wire format-refs / check-refs / Zotero push to structured refs**

Locate the current `refsInput`-based handlers (search for `body: JSON.stringify({ references: refsInput`).

Change them to prefer structured refs when the checked set is non-empty:

```tsx
function selectedStructuredRefs(): Reference[] {
  if (!structuredSelectedKeys.length) return [];
  const s = new Set(structuredSelectedKeys);
  return importedRefs.filter((r) => s.has(pickerKey(r)));
}

function refsSourceForApi(): { as: "structured"; refs: Reference[] } | { as: "text"; text: string } {
  const struct = selectedStructuredRefs();
  if (struct.length) return { as: "structured", refs: struct };
  return { as: "text", text: refsInput };
}
```

Modify format-refs and check-refs bodies to pass the structured refs directly when available. **Coordinate with backend:** the existing routes probably accept only `references: string`. If they only accept text, serialize the structured refs to RIS/BibTeX server-side first, or adjust the routes to accept `references: string | Reference[]`. **Verify with the current backend implementation** — search `backend/app/formatting.py` and `backend/app/refcheck.py` for the accepted shape.

If accepting `Reference[]` requires a bigger backend change, the fallback is:
```tsx
// Serialize structured refs to a plain-text form the existing endpoint can parse:
const serialized = struct.map((r, i) => `${i+1}. ${r.first_author} et al. ${r.title}. ${r.journal}. ${r.year}. ${r.doi ? "DOI:"+r.doi : r.url}`).join("\n");
body: JSON.stringify({ references: serialized, journal_id: journalId })
```

Choose one approach based on what the backend accepts today. **Do not silently drop structured data on the floor.**

- [ ] **Step 5: Build + smoke test**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npx tsc --noEmit
npm run build
```

Manual checks:
- Import via Zotero in FormatModule → structured panel populates with evidence badges.
- Idea → picker → "→ 期刊排版" → FormatModule opens with toast + refs prefilled + checkboxes preselected.
- Format-refs button uses the checked structured refs (verify via network tab / result content).
- Pasting text into `refsInput` still works when structured panel is empty or nothing checked.

- [ ] **Step 6: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/modules/FormatModule.tsx
git commit -m "feat(format): structured refs panel + Zotero + handoff consume"
```

---

## Task 11: Final build, smoke test, and end-to-end verification

**Files:** none — verification only.

- [ ] **Step 1: Full build**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend
npm run build
```

Expected: build succeeds; `dist/` updated. Per user memory (`feedback_build_before_push.md`), this is required so the backend-served dist reflects the changes.

- [ ] **Step 2: Backend test suite (touched areas)**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/backend
.venv/Scripts/python.exe -m pytest \
  test_fetch_abstract_by_id.py \
  test_extract_evidence_endpoint.py \
  test_grant_provided_refs.py \
  -v
```

Expected: all pass.

Also run the pre-existing tests that touch the same files to catch regressions:

```bash
.venv/Scripts/python.exe -m pytest test_literature_rank.py test_grant_review.py test_grant_style.py test_zotero.py test_zotero_routes.py test_refio.py test_refcheck.py -v
```

Expected: all pass (no regressions).

- [ ] **Step 3: End-to-end manual checklist**

Start backend + open the app.

- [ ] 找选题 — run a search, verify Step 3 picker renders identically to before.
- [ ] 找选题 — import 3 refs via RefIO; verify "正在提取核心发现" progress; badges populate.
- [ ] 找选题 — import via Zotero (if configured); same result.
- [ ] 找选题 — click "→ 期刊排版" with 2 checked refs; verify tab switch + toast + refs prefilled in FormatModule structured panel with badges.
- [ ] 写标书 — with `preResearch` ON, click 开始检索文献; verify picker stage renders with refs + badges; pick 2 refs; click 开始写作; verify writing runs and cites only picked refs.
- [ ] 写标书 — with `preResearch` OFF, verify no picker stage; writing runs directly.
- [ ] 写标书 picker — click "→ 期刊排版"; verify handoff carries refs to FormatModule.
- [ ] 期刊排版 — paste plain refs text; run format-refs; verify unchanged behavior.
- [ ] 期刊排版 — import via Zotero; run Zotero push with 2 rows checked; verify only checked rows pushed.
- [ ] 期刊排版 — one row missing abstract: verify "无摘要，未提取" chip (or evidence auto-fetched from public source).
- [ ] Refresh the page after a handoff without visiting FormatModule; verify no error; handoff is lost gracefully (expected).

- [ ] **Step 4: Commit the built dist**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/dist
git commit -m "build(frontend): rebuild dist for grant picker + format structured refs"
```

---

## Self-Review Notes (planner's checks)

**Spec coverage:**
- §4.1 LiteraturePicker → Task 8 ✓
- §4.2 evidenceExtract.ts → Task 7 ✓
- §4.3 refHandoff.ts → Task 6 ✓
- §4.4 /api/refs/extract-evidence → Task 3 ✓
- §4.5 fetch_abstract_by_id + extract_evidence_for_refs → Tasks 1, 2 ✓
- §4.5 (also mentioned): _extract_batch promotion → verified NOT NEEDED (already module-level); called out at top ✓
- §4.6 IdeaModule wiring → Task 8 Step 4 ✓
- §4.6 GrantModule stage machine + provided_refs → Task 9 + Task 4 ✓
- §4.6 FormatModule structured panel + Zotero + handoff consume → Task 10 ✓
- §5 Data flows A/B/C/D → Tasks 4/5/9/10 ✓
- §6 Edge cases (batch too large, missing abstract, dedup, mid-extraction navigation, endpoint failure, in-memory handoff) → Task 7 chunk-error handling + Task 2 `_ev_status: "no_abstract"` + Task 10 handoff-lost graceful path ✓
- §7 Testing plan → backend tests covered in Tasks 1, 2, 3, 4, 5; manual checklist in Task 11 ✓
- §8 Rollout (no feature flag, remember `npm run build`) → Task 11 Step 4 ✓

**Type consistency:**
- `pickerKey` (frontend, LiteraturePicker.tsx) and `refKey` (frontend, evidenceExtract.ts) and `_ref_key` (backend, research.py) — all use same precedence: pmid > doi > url > title-prefix. Verified in Task 8, Task 7, Task 2 respectively.
- `_ev_status` values ("ok" | "no_abstract" | "extract_error") consistent across backend response (Task 2/3), frontend helper (Task 7), and picker UI (Task 8).
- `RefHandoff.from`: "idea" | "grant" — set in Idea (Task 8) and Grant (Task 9); consumed in Format (Task 10).

**Placeholder scan:**
- No "TBD" / "TODO" / "implement later" left. Every step shows the code or command.
- One deliberate lookup: `switchToFormatTab` — the plan tells the engineer to locate the existing tab-switch mechanism rather than inventing one, because it's project-specific and not part of the design.
- One backend/frontend decision left to the engineer in Task 10 Step 4: whether the format-refs / check-refs endpoints accept `Reference[]` or need text-serialized input. The plan spells out both paths and instructs the engineer to verify against current code — not a placeholder, an intentional branch.

**Scope check:** Single implementation plan. All tasks compose into one PR. No sub-project decomposition needed.
