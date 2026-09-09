> Source: `SKILL.md` Workflow Step 5 (Image Acquisition Phase) — full original text, moved verbatim. Read when Step 5 triggers (any `ai` / `web` / `slice` row).

### Step 5: Image Acquisition Phase (Conditional)

🚧 **GATE**: Step 4 complete; Design Specification & Content Outline generated and user confirmed. Any formula rows already have `Acquire Via: formula` and `Status: Rendered`.

> **Trigger**: At least one row in the resource list has `Acquire Via: ai`, `web`, and/or `slice`. If every row is `user`, `formula`, or `placeholder`, skip to Step 6.

**Failure recovery**: stop/continue behavior for AI/web/slice/image-readiness failures is defined in [`workflows/failure-recovery.md`](../workflows/failure-recovery.md). This Step keeps the acquisition procedure.

**Always load the common framework**:

```
Read references/image-base.md
```

Then **lazy-load the path-specific reference** for each row that actually needs it:

| Acquire Via | Load reference (only if any such row exists) | Run |
|---|---|---|
| `ai` | `references/image-generator.md` | write `<project_path>/images/image_prompts.json`, then follow `image-generator.md §7 Path Selection` (`image_gen.py --manifest` is **Path A only**) |
| `web` | `references/image-searcher.md` | `python3 ${SKILL_DIR}/scripts/image_search.py ...` (≥2 web rows → `--batch images/image_queries.json`) |
| `slice` | `references/image-generator.md` §4.3 | derived — **after** the parent `ai` sheet row is `Generated`, run `python3 ${SKILL_DIR}/scripts/slice_images.py <project_path>/images/<sheet>.png --grid RxC --names ... --trim --alpha` (see workflow step 2.5) |
| `user` / `formula` / `placeholder` | (skip) | (skip) |

A deck with only `ai` rows never loads `image-searcher.md`; a deck with only `web` rows never loads `image-generator.md`. A mixed deck loads both, processes each row through its own path, and writes both `image_prompts.json` and `image_sources.json`.

> ⚠️ **Step 5 的四条硬规矩**（manifest 契约必走、web 多行必须 `--batch`、≥3 张同族插图走 sheet + slice、确认过的 `image_ai_path` 优先于 `IMAGE_BACKEND`）正文在 [`image-base.md`](../references/image-base.md) 与 [`image-generator.md`](../references/image-generator.md) §4.3 / §7。本步真的有 `ai` / `web` / `slice` 行时按上表 lazy-load 它们，规矩随正文一起到手。

Workflow:

1. Extract all resource rows from the design spec and group them by `Acquire Via`; rows with `Status: Pending` or `Status: Failed` and `Acquire Via ∈ {ai, web, slice}` must all reach a terminal state before Executor starts
2. Generate prompts (ai rows) and/or run search (web rows) per [image-base.md](../references/image-base.md) §3 dispatch table
2.5. **Slice any spot-illustration sheets (only if `slice` rows exist).** For each generated `ai` **sheet** row, run `slice_images.py` (grid + the element `--names` matching the `slice` rows, `--trim --alpha`) so every element file lands in `images/`; mark each `slice` row `Generated`. A sheet still in `Needs-Manual` cannot be sliced — leave its `slice` rows `Needs-Manual` and surface them at the Step 7 readiness gate. Contract: [image-generator.md](../references/image-generator.md) §4.3.
3. Verify every row reaches a terminal status: `Generated` (ai success / sliced element), `Sourced` (web success), or `Needs-Manual`. `Failed` is not a terminal status: it means the current run did not generate that item, but the item remains retryable. The agent must resolve every residual `Failed` item by rerunning the confirmed path or marking it `Needs-Manual` before Executor starts
4. Re-derive image facts now that web / AI / sliced files are in the folder — `python3 ${SKILL_DIR}/scripts/analyze_images.py <project_path>/images` — so `analysis/image_analysis.csv` reflects every acquired image **including the sliced elements** (real measured sizes) before the Executor lays them out. Image facts are regenerated on use, never a stale store (see Step 4's image-facts note).

**✅ Checkpoint — Confirm acquisition attempted for every row**:
```markdown
## ✅ Image Acquisition Phase Complete
- [x] image_prompts.json created (when any ai rows processed)
- [x] image_prompts.md sidecar rendered (when any ai rows processed)
- [x] image_sources.json created (when any web rows processed)
- [x] Spot-illustration sheets sliced (when any `slice` rows exist); every element file present in `images/` and listed in `spec_lock.md images`
- [x] Each row: status is `Generated` / `Sourced` / `Needs-Manual` (no `Pending` or `Failed` remaining)
- [x] analyze_images.py re-run so image_analysis.csv covers the acquired web / AI / sliced images
```

**Default — auto-proceed to Step 6.** Only when the user's Step 4 response explicitly opted into split mode (in chat or via Confirm UI `result.json` with `generation_mode: "split"`), output the planning-session handoff below and stop this conversation:

  ```markdown
  ## ✅ Planning Session Complete
  - [x] Spec: `design_spec.md`, `spec_lock.md`
  - [x] Resources: `sources/`, `images/`, `templates/`
  - [ ] **Next**: open a fresh chat window and input `继续生成 <project_name>` to enter the execution session via the [`resume-execute`](../workflows/resume-execute.md) workflow.
  ```

> On acquisition failure, do NOT halt — follow the Failure Handling rule in [image-base.md](../references/image-base.md) §5: retry once, then mark the row `Needs-Manual`, report to user, and continue to the checkpoint above.
