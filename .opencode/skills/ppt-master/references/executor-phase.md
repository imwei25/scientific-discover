> Source: `SKILL.md` Workflow Step 6 (Executor Phase) — full original text, moved verbatim. Read when entering Step 6 (also from `workflows/resume-execute.md`).

### Step 6: Executor Phase

🚧 **GATE**: Step 4 (and Step 5 if triggered) complete; all prerequisite deliverables are ready.

**Artifact ownership**: `svg_output/` is the author source, `svg_final/` is derived, and image facts come from the regenerated `analysis/image_analysis.csv`; see [`references/artifact-ownership.md`](../references/artifact-ownership.md).

Read the execution references for this deck's locked `mode` + `visual_style` (from `spec_lock.md`):
```
Read references/executor-base.md                  # REQUIRED: common guidelines
Read references/shared-standards.md               # REQUIRED: SVG/PPT technical constraints
Read references/modes/<locked-mode>.md            # narrative skeleton (spec_lock.md `mode`)
Read references/visual-styles/<locked-style>.md   # aesthetic (spec_lock.md `visual_style`)
```

> Read executor-base + shared-standards + the one locked mode file + the one locked visual-style file. For `mode: custom` or `visual_style: custom`, skip that preset file and follow `mode_behavior` / `visual_style_behavior` from `spec_lock.md` instead. Never glob `modes/` or `visual-styles/`.

**Design Parameter Confirmation (Mandatory)**: before the first SVG, output key design parameters from the spec (canvas dimensions, color scheme, font plan, body font size). See executor-base.md §2.

**Live preview** — 🛑 **本部署整体停用**：不要启动 `svg_editor/server.py`，不要向用户播报任何
`localhost:5050` 地址（那是个永远打不开的链接），也不要因为预览缺失就停下来问用户或反复排查 ——
直接继续生成 SVG，这不是错误状态。用户想看效果 → 引导其下载 Step 7 导出的 `.pptx`；想改 →
让其在对话里描述，你直接编辑 `svg_output/` 下的 SVG 后重新导出。
**生成期间不要读取或应用任何已提交的注解**（应用注解的窗口只在 Step 7 之后开启）。
其它部署的原始启动流程见 [`workflows/live-preview-startup.md`](../workflows/live-preview-startup.md)。

**Pre-generation Batch Read (Mandatory)**: before the first SVG, batch-read every distinct layout SVG referenced in `spec_lock.page_layouts` and every distinct chart SVG referenced in `spec_lock.page_charts` (plus any §VII backup charts). One read per file, up front — do not re-read these during page generation. See executor-base.md §1.0.

> Image facts: trust the `analysis/image_analysis.csv` regenerated at the end of Step 5. If `images/` changed since (the user swapped or added files), re-run `python3 ${SKILL_DIR}/scripts/analyze_images.py <project_path>/images` before laying images out — facts are re-derived on use, never a stale store (Step 4 image-facts note).

**Per-page spec_lock re-read (Mandatory)**: before **each** SVG page, `read_file <project_path>/spec_lock.md` and use only its colors / fonts / icons / images, plus the per-page `page_rhythm` / `page_layouts` / `page_charts` lookups (resolves to template SVGs already loaded in the batch read above). Resists context-compression drift on long decks. See executor-base.md §2.1.

> ⚠️ **Main-agent only**: SVG generation MUST stay in the current main agent — page design depends on full upstream context. Do NOT delegate to sub-agents.
> ⚠️ **Generation rhythm**: generate pages sequentially, one at a time, in the same continuous context. Do NOT batch (e.g., 5 per group).

**Visual Construction Phase**: generate SVG pages sequentially, one at a time, in one continuous pass → `<project_path>/svg_output/`

**Quality Check Gate (Mandatory)** — after all SVGs, BEFORE annotation handling and speaker notes:
```bash
python3 ${SKILL_DIR}/scripts/svg_quality_checker.py <project_path>
```
- Any `error` (banned SVG features, viewBox mismatch, spec_lock drift, etc.) MUST be fixed before proceeding — return to Visual Construction, regenerate that page, re-run check.
- `warning` entries (low-res image, non-PPT-safe font tail, etc.): fix when straightforward, otherwise acknowledge and release.
- Run against `svg_output/` (not after `finalize_svg.py` — finalize rewrites SVG and masks violations).

**Logic Construction Phase**: generate speaker notes → `<project_path>/notes/total.md`

**✅ Checkpoint — Confirm all SVGs and notes are fully generated and quality-checked. Proceed directly to Step 7 post-processing**:
```markdown
## ✅ Executor Phase Complete
- [x] Live preview started before the first SVG and kept available at the reported URL
- [x] All SVGs generated to svg_output/
- [x] svg_quality_checker.py passed (0 errors)
- [x] Speaker notes generated at notes/total.md
```

> **Chart pages?** If this deck contains data charts (bar / line / pie / radar / etc.), run the standalone [`verify-charts`](../workflows/verify-charts.md) workflow before Step 7 to calibrate coordinates. AI models routinely introduce 10–50 px errors when mapping data to pixel positions; verify-charts eliminates that class of error. Skip if no chart pages.

> **Visual self-check (opt-in)?** If the user explicitly asked for a per-page visual re-pass on the SVGs ("跑一下视觉自检 / 视觉回看", "visual review", "check pages visually", etc.), run the standalone [`visual-review`](../workflows/visual-review.md) workflow before Step 7. Do NOT run it by default and do NOT recommend it based on inferred model capability or deck size — trigger is user request only.
