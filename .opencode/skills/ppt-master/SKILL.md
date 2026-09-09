---
name: ppt-master
description: >
  Converts source documents (PDF/DOCX/URL/Markdown) into SVG slide pages and exports to PPTX. Use when user asks to "create PPT", "make presentation", "生成PPT", "做PPT", "制作演示文稿", or mentions "ppt-master".
---

> **`<project_path>` 取在哪里（本部署的硬约定）**：当前工作目录就是本会话的产物目录，`<project_path>` 一律取当前目录下的 `<项目名>/`；**绝不要**建到 `${REPO_ROOT:-/app}` 下；**建工程必须传 `--dir .`**；尖括号是占位符；中文字体按 Windows 家族名选，**禁止现装字体**。全文 → `references/deployment-notes.md`。

# PPT Master Skill

> AI-driven multi-format SVG content generation system. Converts source documents into high-quality SVG pages through multi-role collaboration and exports to PPTX.

**Core Pipeline**: `Source Document → Create Project → [Template] → Strategist → [Image_Generator] → Executor Live Preview → Quality Check → Post-processing → Export`

> [!CAUTION]
> ## 🚨 Global Execution Discipline (MANDATORY)
>
> Highest priority; violating any rule is execution failure. Binding full text → `references/global-rules.md`.
> 1 **SERIAL EXECUTION** · 2 **BLOCKING = HARD STOP** (⛔ = wait for explicit user response) · 3 **NO CROSS-PHASE BUNDLING** · 4 **GATE BEFORE ENTRY** · 5 **NO SPECULATIVE EXECUTION** · 6 **NO SUB-AGENT SVG GENERATION** · 7 **SEQUENTIAL PAGE GENERATION ONLY** · 8 **SPEC_LOCK RE-READ PER PAGE** · 9 **SVG MUST BE HAND-WRITTEN, NOT SCRIPT-GENERATED** · 10 **FOLLOW DETERMINISTIC ROUTING RULES**

> [!IMPORTANT]
> 🌐 **Language & Communication Rule** (user's language; `design_spec.md` keeps its English structure) · 🔌 **Compatibility With Generic Coding Skills** (no generic scaffolding; this skill wins) → `references/global-rules.md`.

## Rule Strength Labels

| Label | Meaning |
|---|---|
| `MUST` | Required behavior; violation is workflow failure |
| `MUST NOT` | Forbidden behavior |
| `DEFAULT` | Used when the user has not specified otherwise |
| `OPTIONAL` | Run only when explicitly triggered or when the route says so |
| `FALLBACK` | Recovery path after the primary path fails |
| `GATE` | Required checkpoint before entering the next step |

## Cross-Cutting Authorities

| Concern | Authority | Contract |
|---|---|---|
| Main pipeline sequencing | This `SKILL.md` | Owns Step 1-7 order, gates, role switching, and mandatory commands |
| Route selection | `workflows/routing.md` | Owns deterministic route choice before the main pipeline or a standalone workflow |
| Workflow registry | `workflows/index.md` | Owns standalone workflow trigger/precondition/output inventory |
| Artifact ownership | `references/artifact-ownership.md` | Owns fact channels, source/derived artifact boundaries, and regeneration rules |
| Failure recovery | `workflows/failure-recovery.md` | Owns stop/continue decisions for common failures |
| Confirm UI details | `scripts/docs/confirm_ui.md` | Owns schema, launcher behavior, port strategy, and chat fallback details |
| Moved section text | `references/global-rules.md` · `deployment-notes.md` · `tooling-index.md` · `pptx-route-boundary.md` | Verbatim text of sections that keep only a pointer here |
| Step full text | `references/intake-steps.md` (1-3) · `strategist-phase.md` (4) · `image-acquisition-phase.md` (5) · `executor-phase.md` (6) · `post-processing-export.md` (7) | Verbatim Step text; read when entering that Step |

## Main Pipeline Scripts

→ `references/tooling-index.md`; docs `${SKILL_DIR}/scripts/README.md`; every script answers `--help`.

## Template Index

→ `references/tooling-index.md`.

## Standalone Workflows

**Route authority**: `workflows/routing.md` before entering any route. **Registry**: `workflows/index.md`.

### PPTX Route Boundary

Intent → route table (`template-fill-pptx` default for raw `.pptx` + generate; `beautify-pptx` strictly 1:1) and the discriminator question → `references/pptx-route-boundary.md`.

---

## Workflow

### Step 1: Source Content Processing

🚧 **GATE**: User has provided source material in any form. **No source content?** Run `workflows/topic-research.md` first, then return here.

Non-Markdown sources (PDF / DOCX / Office / PPTX / EPUB / HTML / LaTeX / RST / URL): `python3 ${SKILL_DIR}/scripts/source_to_md.py <file_or_URL_or_dir> [...]`. CSV / TSV / Markdown: read directly. `-t` / `-o`, PPTX intake, `scripts/docs/conversion.md`, **Do NOT convert EMF/WMF to PNG** → `references/intake-steps.md`.

**✅ Checkpoint** → Step 2.

### Step 2: Project Initialization

🚧 **GATE**: Step 1 complete.

```bash
python3 ${SKILL_DIR}/scripts/project_manager.py init <project_name> --format <format> --dir .
python3 ${SKILL_DIR}/scripts/project_manager.py import-sources <project_path> <source_files_or_dirs...> --move
```

Default format `ppt169` (`1280x720`); list in `references/canvas-formats.md`. Chat-only text needs no import. ⚠️ **MUST use `--move`** (not copy) for all source files incl. Step 1's Markdown. PPTX sources: `import-sources` auto-runs `pptx_intake.py ... -o <project_path>/analysis` (`<stem>.identity.json`, `<stem>.slide_library.json`, index `analysis/source_profile.json`). Details → `references/intake-steps.md`.

**✅ Checkpoint** — `sources/` holds all source files → Step 3.

### Step 3: Template Option

🚧 **GATE**: Step 2 complete.

**Default — free design.** Proceed directly to Step 4. Do NOT query any `*_index.json` unless triggered. Do NOT ask the user. Do NOT suggest or fuzzy-match any template.

**Trigger ONLY on explicit template directory paths** in the user's initial message (each containing `design_spec.md` with `kind: brand` / `layout` / `deck`) → read `kind`, dispatch / fuse per `workflows/template-dispatch.md` (read **only** when triggered). Bare names, style descriptions, vague intent → skip Step 3. Raw PPTX templates are not Step 3 templates (→ `template-fill`, or `workflows/create-template.md` first). Full rules → `references/intake-steps.md`.

**✅ Checkpoint — no user interaction; explicit paths dispatched into `<project_path>/templates/`.**

### Step 4: Strategist Phase (MANDATORY — cannot be skipped)

🚧 **GATE**: Step 3 complete.

`Read references/strategist.md`; full Step 4 text → `references/strategist-phase.md`. ⚠️ Before writing `design_spec.md`, Strategist MUST `read_file templates/design_spec_reference.md` (I–XI structure). Fact channels (`analysis/source_profile.json` MUST-read, `sources/` ownership) → `references/artifact-ownership.md`, read first.

⛔ **BLOCKING — Strategist confirmation stage**: present it in **three stages** (direction → design system → images / execution) and **wait for explicit user confirmation or modification** before outputting the spec. Single core gate; afterwards all steps auto-proceed. Items: 1 Canvas format · 2 Page count range · 3 Target audience · 4 Style objective · 5 Color scheme · 6 Icon usage · 7 Typography plan incl. formula policy (`mixed` default / `render-all` / `text-only`) · 8 Image usage. Mechanics → `workflows/confirm-stages.md`. 🛑 本部署确认页不可用：不启动 `confirm_ui/server.py`，在聊天里逐段呈现三段并等待答复。

**Mandatory notes** (every run, one 💡 line each, not confirmations): split-mode (`继续生成 <project_name>` → `workflows/resume-execute.md`) and spec-refinement opt-in (`workflows/refine-spec.md`, default OFF). Wording → `references/strategist-phase.md`.

**Honoring the confirmation (result.json is authoritative — Mandatory)**: confirmed values **override your own recommendations**. `image_usage` → §VIII `Acquire Via` mapping (no `ai` → no h.5 / `ai` rows / Step 5 generation; `none` → no image rows) → `references/strategist-phase.md`; spot illustrations → `references/strategist-images.md`.

Formulas (`mixed` / `render-all`): write `<project_path>/images/formula_manifest.json`, run `python3 ${SKILL_DIR}/scripts/latex_render.py <project_path>`, add `Acquire Via: formula` / `Status: Rendered` rows — **before** the spec. Any images present → `python3 ${SKILL_DIR}/scripts/analyze_images.py <project_path>/images` before the spec (`analysis/image_analysis.csv`, MUST be read before §VIII). ⚠️ NEVER open image files directly.

**Output**: `<project_path>/design_spec.md` · `<project_path>/spec_lock.md` (skeleton `templates/spec_lock_reference.md`).

**✅ Checkpoint — auto-proceed.**

### Step 5: Image Acquisition Phase (Conditional)

🚧 **GATE**: Step 4 confirmed. **Trigger**: any row with `Acquire Via: ai` / `web` / `slice`; otherwise skip to Step 6.

`Read references/image-base.md` always; lazy-load `references/image-generator.md` (`ai`; `slice` §4.3) / `references/image-searcher.md` (`web`) only for row types present. `ai` → write `<project_path>/images/image_prompts.json`, follow image-generator §7 (`image_gen.py --manifest` is **Path A only**). `web` → `image_search.py ...` (≥2 rows → `--batch images/image_queries.json`). `slice` → after the parent sheet is `Generated`: `slice_images.py <project_path>/images/<sheet>.png --grid RxC --names ... --trim --alpha`. Every row must end `Generated` / `Sourced` / `Needs-Manual` (`Failed` is not terminal); then re-run `analyze_images.py <project_path>/images`. Failure: retry once, `Needs-Manual`, never halt. Details → `references/image-acquisition-phase.md`.

**Default — auto-proceed to Step 6.** Only if the user opted into split mode (`generation_mode: "split"`) output the Planning Session Complete handoff (template there) and stop.

### Step 6: Executor Phase

🚧 **GATE**: Step 4 (+5) complete. `svg_output/` is the author source, `svg_final/` derived. Full text → `references/executor-phase.md`.

```
Read references/executor-base.md                # REQUIRED
Read references/shared-standards.md             # REQUIRED
Read references/modes/<locked-mode>.md          # spec_lock `mode`
Read references/visual-styles/<locked-style>.md # spec_lock `visual_style`
```
`custom` → follow `mode_behavior` / `visual_style_behavior` in `spec_lock.md`; never glob those dirs.

**Design Parameter Confirmation (Mandatory)** before the first SVG (executor-base §2). **Pre-generation Batch Read (Mandatory)**: every SVG in `spec_lock.page_layouts` / `page_charts`, once, up front (§1.0). **Per-page spec_lock re-read (Mandatory)**: `read_file <project_path>/spec_lock.md` before **each** page (§2.1); re-run `analyze_images.py` if `images/` changed. **Live preview** 🛑 本部署停用：不启动 `svg_editor/server.py`，直接生成，生成期间不读取注解（`workflows/live-preview-startup.md` 仅供其它部署）。

**Visual Construction**: main agent only, one page at a time → `<project_path>/svg_output/`. **Quality Check Gate (Mandatory)**: `python3 ${SKILL_DIR}/scripts/svg_quality_checker.py <project_path>` on `svg_output/` (before finalize and notes); any `error` MUST be fixed and re-checked. **Logic Construction**: notes → `<project_path>/notes/total.md`.

**✅ Checkpoint** → Step 7. Data charts → `workflows/verify-charts.md` first; `workflows/visual-review.md` only on explicit user request.

### Step 7: Post-processing & Export

🚧 **GATE**: Step 6 complete. 🚧 **Image readiness GATE**: every `Needs-Manual` file must exist at `project/images/<filename>` — else PAUSE, list them, point to `images/image_prompts.md`. Failures → `workflows/failure-recovery.md`. Full text → `references/post-processing-export.md`.

⚠️ Run the three sub-steps **one at a time**; ❌ **NEVER** combine them into one code block or invocation.

**7.1** notes split:
```bash
python3 ${SKILL_DIR}/scripts/total_md_split.py <project_path>
```
**7.2** SVG post-processing → `svg_final/`:
```bash
python3 ${SKILL_DIR}/scripts/finalize_svg.py <project_path>
```
**7.3** export → `exports/<project_name>_<timestamp>.pptx` (reads `svg_output/`) + `backup/<timestamp>/svg_output/`:
```bash
python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path>
```
Flags → `workflows/export-options.md`, `--help`.

> ❌ **NEVER** `cp` instead of `finalize_svg.py` · ❌ **NEVER** force `-s output` for the legacy/preview pptx · ❌ **NEVER** `--only`

## Role Switching Protocol

**MUST first read** the role's reference file, then print the `## [Role Switch: <Role Name>]` marker (→ `references/global-rules.md`).

## Notes

→ `references/tooling-index.md`.
