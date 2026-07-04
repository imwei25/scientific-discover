# Design: Literature picker in GrantModule, evidence-on-import, and structured refs in FormatModule

**Date:** 2026-07-04
**Status:** Draft — pending user review

## 1. Goal

Give three modules a consistent "structured references" surface with checkbox selection, Zotero-aware I/O, automatic core-findings extraction on import, and one-way cross-module handoff into journal formatting.

Concretely:

- **写标书 (GrantModule)**: when the existing `preResearch` toggle is on, insert a new picker stage between Step 1 and Step 2. User searches, reviews retrieved papers with checkboxes (mirroring 找选题 Step 3), and clicks "开始写作". The old "search-during-writing" path is removed for this branch.
- **找选题 (IdeaModule) + 写标书 picker**: refs coming in via RefIO file import or Zotero import auto-get their core findings (pop/design/finding/gap) extracted. Missing abstracts are auto-fetched by DOI/PMID.
- **期刊排版 (FormatModule)**: gains a structured refs panel above the existing textarea. The panel is the canonical source for format-refs, check-refs, and Zotero push when non-empty; textarea remains a fallback. Zotero import/export is added.
- **Cross-module handoff**: IdeaModule and GrantModule pickers get a "→ 期刊排版" button that stashes checked refs (with their evidence) for FormatModule to consume on next mount.

## 2. Non-goals (YAGNI)

- Persistent cross-session "reference basket".
- SSE streaming for the new evidence-extract endpoint (plain JSON initially).
- FormatModule sending refs back to Idea/Grant.
- Deduping across modules' pickers.
- Non-Zotero reference-manager sync (Mendeley, EndNote sync).

## 3. Current state (anchors for implementers)

- **Reference schema**: `frontend/lib/sse.ts:170-186` — `pmid`, `doi`, `title`, `first_author`, `journal`, `year`, `url`, `source`, `abstract`, `cited_by_count`, `journal_impact`, `journal_quartile`, `rel`, `rel_why`.
- **EvidenceItem schema**: `frontend/lib/sse.ts:188-202` — `pop`, `design`, `finding`, `gap`, plus metadata mirror.
- **IdeaModule Step-3 picker (source of extraction)**: `frontend/src/modules/IdeaModule.tsx` — `refs` + `selectedKeys` state (~L144), `evByRef` memo (~L384-393), row rendering (~L771-782), RefIO+ZoteroPanel embed (~L676-681).
- **Evidence extraction pipeline**: `backend/app/research.py:364-437` — `_extract_batch(...)` inside `deep_research_idea`. Batch size 8, prompt at L377-392 (finding must include quantitative data).
- **Literature search**: `backend/app/literature.py:298` — `search_literature()` aggregating PubMed / EPMC / OpenAlex / Crossref / ClinicalTrials / Unpaywall.
- **Zotero endpoints**: `/api/zotero/status`, `/api/zotero/collections`, `/api/zotero/import`, `/api/zotero/push` (see `backend/app/zotero.py:34,76`).
- **RefIO endpoints**: `/api/refs/import` (multipart), `/api/refs/export` (JSON→blob) — see `frontend/src/components/RefIO.tsx:85-96`.
- **GrantModule `preResearch` checkbox**: `frontend/src/modules/GrantModule.tsx:539`.
- **FormatModule refs textarea**: `frontend/src/modules/FormatModule.tsx:671-676`; import merge: L128-140.

## 4. Architecture

### 4.1 New shared component — `<LiteraturePicker>`

Path: `frontend/src/components/LiteraturePicker.tsx`.

Extracted from IdeaModule Step 3. Renders a list of `Reference` rows with checkboxes and core-findings badges, plus an embedded `RefIO` and (optional) `ZoteroPanel`. Also renders a primary CTA button when provided.

```ts
interface LiteraturePickerProps {
  refs: Reference[];
  evidenceByKey: Record<string, EvidenceItem>;  // key = pmid || doi || url
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  onImport?: (imported: Reference[]) => void;   // fires after RefIO or Zotero import merges
  mode?: "picker" | "list";                     // "list" hides primaryAction area
  primaryAction?: { label: string; onClick: (checked: Reference[]) => void };
  exportFilename?: string;
  showZotero?: boolean;                         // default true
  header?: React.ReactNode;                     // module-specific title/tips
  extractionStatus?: { done: number; total: number } | null; // inline "N/M" progress
}
```

Row layout preserves what IdeaModule renders today: title (link), first author + year + journal, impact/quartile badges, then the four evidence chips (pop / design / finding / gap). If `evidenceByKey[key]` is absent, badges show a subtle placeholder ("待提取…") instead of blank.

The picker owns nothing persistent — all state is lifted; only ephemeral UI toggles (expanded rows, sort, filter text) are local.

### 4.2 New client helper — `evidenceExtract.ts`

Path: `frontend/src/lib/evidenceExtract.ts`.

```ts
export async function extractEvidenceForRefs(
  refs: Reference[],
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, EvidenceItem>>;
```

Calls `POST /api/refs/extract-evidence`, batches client-side in groups of 8 so `onProgress` can update as chunks return. Returns an evidence map keyed by `pmid || doi || url` (same convention as `LiteraturePicker`).

Failure of one chunk does not fail the whole call — that chunk's refs land in the map with `finding: ""` and `_ev_status: "extract_error"`. Callers may retry.

### 4.3 New client helper — `refHandoff.ts`

Path: `frontend/src/lib/refHandoff.ts`.

```ts
export interface RefHandoff {
  refs: Reference[];
  evidence: Record<string, EvidenceItem>;
  from: "idea" | "grant";
}
export function stash(h: RefHandoff): void;
export function consume(): RefHandoff | null;   // clears stash after read
export function peek(): RefHandoff | null;
```

Module-scoped variable (no localStorage) — survives tab switches, not page reloads. Emits `window.dispatchEvent(new CustomEvent("refhandoff:pending"))` on `stash`. FormatModule listens on mount and on that event.

### 4.4 New backend endpoint

Route: `POST /api/refs/extract-evidence` in `backend/app/routes/text_gen.py`.

```jsonc
// Request
{
  "refs": [ { "pmid": "...", "doi": "...", "title": "...", "abstract": "...", ... } ],
  "fetch_missing_abstracts": true   // default true
}

// Response
{
  "ok": true,
  "evidence": [
    {
      "key": "pmid:12345678",
      "pop": "...", "design": "...", "finding": "...", "gap": "...",
      "rel": 3, "rel_why": "...",
      "_ev_status": "ok" | "no_abstract" | "extract_error"
    }
  ]
}
```

Server flow:

1. For each ref lacking `abstract`, call new helper `literature.fetch_abstract_by_id(doi, pmid)` — tries PubMed → Europe PMC → OpenAlex in order using existing clients. Returns `str | None`.
2. Refs still without abstract → yield `{_ev_status: "no_abstract"}` and skip LLM.
3. Remaining refs → batch by 8 → call refactored `research.extract_evidence_batch(batch)` (module-level extraction of today's inner `_extract_batch` closure — same prompt string).
4. Assemble response.

Plain JSON, not SSE, initially. If a full request exceeds the LLM timeout we'll revisit; typical batches (≤20 refs from one import) fit inside the current timeout budget.

### 4.5 Backend refactors

- `backend/app/research.py`:
  - Promote today's inner `_extract_batch` closure to a module-level `async def extract_evidence_batch(refs: list[dict]) -> list[dict]`, preserving prompt text and parsing verbatim. Keep `deep_research_idea` calling the module-level function.
  - Add a thin `async def extract_evidence_for_refs(refs, fetch_missing=True)` that composes the fetch-abstract step + `extract_evidence_batch` in groups of 8. The new endpoint calls this.
- `backend/app/literature.py`:
  - Add `async def fetch_abstract_by_id(doi: str | None, pmid: str | None) -> str | None`.
  - Uses existing `pubmed`, `europepmc`, `openalex` clients in that order. Any client raising → try next.

### 4.6 Module wiring

**IdeaModule** (`frontend/src/modules/IdeaModule.tsx`):

- Replace the inline Step-3 picker markup with `<LiteraturePicker>`, passing existing `refs`, `evidence`-derived map, `selectedKeys`, existing setters.
- Add `onImport` prop that calls `extractEvidenceForRefs(newRefs)` and merges the result into `evidence`.
- Add a `primaryAction={{ label: "→ 期刊排版", onClick: refs => { refHandoff.stash({refs, evidence: subset, from:"idea"}); navigateToFormatTab(); } }}` alongside the existing report-generation CTA. (Both CTAs coexist; the report-generation button remains the primary.)

**GrantModule** (`frontend/src/modules/GrantModule.tsx`):

- Introduce a new `stage: "prepare" | "picker" | "writing"` local state. When `preResearch` is on:
  - After Step 1 "开始检索文献" transitions to `stage: "picker"`.
  - Call a new endpoint `POST /api/grant/search` (added in `backend/app/routes/text_gen.py`) that streams SSE events (`references`, `evidence`) using the same `search_literature()` + `extract_evidence_batch(...)` pipeline that `preResearch` triggers today inside `streamGrant`. The endpoint accepts the Step-1 inputs (field, keywords, attachments). Rationale: extracts the search phase from `streamGrant` into its own callable so the picker can consume it standalone.
  - Stream results into local `refs` + `evidence`, render `<LiteraturePicker>` with them.
  - `primaryAction: { label: "开始写作", onClick: checked => { setPickedRefs(checked); startWriting({ ...step1Inputs, provided_refs: checked }); setStage("writing"); } }`.
  - Include a secondary "→ 期刊排版" button.
- **`streamGrant` change**: accept an optional `provided_refs: Reference[]` in the request body. When present, skip its internal `search_literature()` call (used today by `preResearch`) and use `provided_refs` as-is. `preResearch` toggle still governs whether the frontend enters the picker stage at all; the backend flag becomes a no-op when `provided_refs` is set.
- When `preResearch` is off: behavior unchanged; `stage` goes prepare → writing directly.
- Import handler (RefIO/Zotero via `<LiteraturePicker>.onImport`) runs `extractEvidenceForRefs` and merges evidence.

**FormatModule** (`frontend/src/modules/FormatModule.tsx`):

- Add state: `structuredRefs: Reference[]`, `evidenceByKey: Record<string, EvidenceItem>`.
- Render `<LiteraturePicker mode="list" showZotero>` above `refsInput`. Its `primaryAction` is unused; check state drives Zotero push.
- On mount: `const stash = refHandoff.consume(); if (stash) { setStructuredRefs(stash.refs); setEvidenceByKey(stash.evidence); toast("已从 " + (stash.from === "idea" ? "找选题" : "写标书") + " 带入 N 篇文献") }`. Also listen for `refhandoff:pending`.
- `onImport` (Zotero / RefIO) merges into `structuredRefs`, dedupes by `pmid||doi||url`, then runs `extractEvidenceForRefs` on newly-added rows.
- Operations wired to structured-first:
  ```ts
  const source = structuredRefs.length > 0
    ? structuredRefs                       // canonical
    : parseRefsFromText(refsInput);        // fallback
  ```
  Apply to `formatRefs()`, `checkRefs()`, and Zotero push (push uses the checked subset only).

## 5. Data flow

### 5.1 GrantModule with `preResearch` on

```
Step 1 "开始检索文献"
   → literature search stream (existing endpoint reused; NOT the writing endpoint)
        → yields references + evidence progressively into LiteraturePicker
Step 1.5 picker
   → user checks N refs
   → "开始写作" primaryAction
        → GrantModule.state.pickedRefs = checked
        → writing endpoint called with pickedRefs (no auto-search inside writing)
Step 2 writing
   → renders as today, but references list is fixed to pickedRefs
```

### 5.2 Any import into any picker

```
User: RefIO drop  OR  ZoteroPanel import
   → /api/refs/import  or  /api/zotero/import → refs[]
   → LiteraturePicker.onImport (module-provided handler):
        1. merge into module refs, dedupe by pmid||doi||url; if incoming has abstract and existing doesn't, upgrade
        2. extractEvidenceForRefs(newRefsOnly, progress)
             → POST /api/refs/extract-evidence
                for missing-abstract refs: fetch_abstract_by_id(doi, pmid)
                batch(8) → extract_evidence_batch(...) → EvidenceItem[]
             → returns { key → EvidenceItem }
        3. merge into evidenceByKey; picker re-renders badges
```

### 5.3 Handoff to FormatModule

```
IdeaModule/GrantModule picker "→ 期刊排版" primaryAction:
   refHandoff.stash({ refs: checked, evidence: subset, from })
   window.dispatchEvent(new CustomEvent("refhandoff:pending"))
   navigate to Format tab
FormatModule mount (or on event):
   const stash = refHandoff.consume()
   if (stash) { populate structuredRefs + evidenceByKey; toast }
```

### 5.4 FormatModule operations resolve source

```
formatRefs() / checkRefs() / zoteroPush():
   const source = structuredRefs.length > 0 ? structuredRefs : parseFromText(refsInput)
   ...existing pipelines with source as input
   (Zotero push uses checked subset only, matching current ZoteroPanel selectedForPush semantics)
```

## 6. Edge cases and error handling

- **Batch too large on import** → split client-side into groups of 8; a chunk failing does not abort the whole call.
- **Missing abstract after all three sources tried** → return `{_ev_status: "no_abstract"}`; picker renders "无摘要" chip instead of blank badges.
- **Duplicate refs on import** → dedupe by `pmid || doi || url`. If incoming has abstract and existing doesn't, replace (upgrade path).
- **User navigates away mid-extraction** → keep the request running; guard `setState` with a mounted-ref; merge results when they arrive.
- **Backend endpoint failure** → picker still shows refs; badges stay empty; toast "核心发现提取失败,可稍后手动重试"; show a small retry button in the picker header (retries only rows missing evidence).
- **Handoff is in-memory only** → refresh loses it. Acceptable — matches other in-app handoffs and avoids adding project-scoped storage. If the user reloads before FormatModule mounts, they can re-open the source module and click "→ 期刊排版" again.
- **`preResearch` toggled off after picker stage** — not supported mid-stage; toggle is only read at Step 1 transition. Add a small note next to the toggle.
- **Empty search result in GrantModule Step 1.5** → picker shows empty state with "跳过,直接开始写作" and "重新检索" options.

## 7. Testing

**Backend (pytest under `backend/tests/`):**

- `test_fetch_abstract_by_id.py`: mock PubMed / EPMC / OpenAlex clients; verify fallback order, and that all three missing returns `None`.
- `test_extract_evidence_endpoint.py`: 20 mixed refs → assert batching of 8, evidence length matches, `_ev_status:"no_abstract"` on missing, prompt unchanged from today's `_extract_batch`.
- `test_extract_evidence_batch_parity.py`: run the promoted `extract_evidence_batch` on a fixture and diff against a golden output captured from the current closure — guards against accidental prompt drift.

**Manual UI checklist:**

- IdeaModule: import 5 refs via RefIO → badges populate within seconds; import via Zotero → same. "→ 期刊排版" carries checked refs to FormatModule with correct evidence.
- GrantModule `preResearch` ON: Step 1.5 picker appears after Step 1; picking N refs and clicking "开始写作" produces a proposal referencing only those.
- GrantModule `preResearch` OFF: no regression; identical to pre-change behavior.
- FormatModule: pasting text into `refsInput` still works; Zotero import populates structured panel; format-refs uses structured items when panel non-empty; Zotero push sends only checked rows.
- Handoff: Idea → Format after button click shows toast + populated panel; refresh clears handoff without error state.
- Missing abstract path: import a Zotero item that has DOI only, no abstract → verify PubMed lookup fires and evidence still populates (or "无摘要" chip appears if truly unavailable).

## 8. Rollout

- Single PR, single deploy. No feature flag: new picker is inert when `preResearch` is off; FormatModule falls back to textarea when no structured items exist.
- **Build reminder (per user memory):** `npm run build` in `frontend/` before commit — backend serves `dist/`.

## 9. Risks

- **`_extract_batch` promotion** — refactoring the closure could drift the prompt. Mitigation: the parity test in §7; keep the prompt string verbatim; land the refactor in one commit before wiring the new endpoint.
- **`LiteraturePicker` extraction from IdeaModule** — biggest UI refactor. Mitigation: extract first, verify IdeaModule renders and behaves identically (visual diff against current dist), then move on to Grant/Format.
- **`stage` state machine in GrantModule** — introducing new stages can break the resume/history logic. Verify HistoryView still renders past grant runs correctly.

## 10. Files touched (summary)

**New:**
- `frontend/src/components/LiteraturePicker.tsx`
- `frontend/src/lib/evidenceExtract.ts`
- `frontend/src/lib/refHandoff.ts`
- `backend/tests/test_fetch_abstract_by_id.py`
- `backend/tests/test_extract_evidence_endpoint.py`
- `backend/tests/test_extract_evidence_batch_parity.py`

**Modified:**
- `backend/app/research.py` (promote `_extract_batch`; add `extract_evidence_for_refs`)
- `backend/app/literature.py` (add `fetch_abstract_by_id`)
- `backend/app/grant.py` (`streamGrant` accepts optional `provided_refs`; skips internal search when set)
- `backend/app/routes/text_gen.py` (mount `/api/refs/extract-evidence` and `/api/grant/search`)
- `frontend/src/modules/IdeaModule.tsx` (use `LiteraturePicker`; add handoff button)
- `frontend/src/modules/GrantModule.tsx` (Step 1.5 picker stage; call `/api/grant/search`; pass `provided_refs` to writing)
- `frontend/src/modules/FormatModule.tsx` (structured refs panel + Zotero + handoff consume)

**Unchanged (embedded/reused):**
- `frontend/src/components/RefIO.tsx`
- `frontend/src/components/ZoteroPanel.tsx`
- `backend/app/zotero.py`
- `backend/app/refio.py`
