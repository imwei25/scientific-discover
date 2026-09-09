> 来源：search-lit/SKILL.md 原「Phase 4b: Zotero Library Integration」节原样搬出（渐进披露）。与 Zotero 同机、或用户明确要求存进本地 Zotero 时读；含 probe/push 流程、静默跳过规则、写入前确认话术与同步审计。

### Phase 4b: Zotero Library Integration

Integration goes through the **`zotero-library` skill** (local Zotero 7 API at
`127.0.0.1:23119` via its `references/zotero_read.py` — there is no Zotero MCP server
in this suite). It only works when this suite runs **on the same machine** as the
user's Zotero desktop app.

1. **Probe silently**:
   `zotero_read.py probe` → `{"running": true/false, ...}`.
2. **`running=false`** (central multi-user server, Zotero closed, or local API
   disabled): **skip this phase without telling the user** — do not report
   "Zotero not connected" for a search they never framed around Zotero. Just record
   `status: "skipped"` + reason in `references/zotero_collection.json` and move on.
   Only surface Zotero if the user explicitly asked to use their library.
3. **`running=true`**: offer to save the verified candidates into Zotero. Pushing is a
   **write** operation into the user's currently selected collection, and Zotero's
   local API has **no delete endpoint** (a wrong push cannot be rolled back
   programmatically) — so ask first with numbered options per AGENTS.md §六, e.g.:
   "**1)** 不导入，只留 `refs.bib`（推荐，可稍后手动导入） **2)** 把这批题录存进
   Zotero 当前选中分类". On "2", run
   `zotero_read.py push --bib outputs/refs.bib` (or `--csv evidence_table.csv`);
   it merges in-payload duplicates and skips items that came from Zotero, but does
   **not** dedupe against the rest of the library — say so when offering.
4. **Write sync audit**: record collection, pushed/skipped/failed counts in
   `references/zotero_collection.json` so Zotero status is auditable rather than a
   hidden optional side effect.
