> Source: `SKILL.md` Workflow Step 7 (Post-processing & Export) — full original text, moved verbatim. Read when entering Step 7.

### Step 7: Post-processing & Export

🚧 **GATE**: Step 6 complete; all SVGs generated to `svg_output/`; speaker notes `notes/total.md` generated.

🚧 **Image readiness GATE** (when Step 5 left ai rows in `Needs-Manual`): every expected file must exist at `project/images/<filename>` before running 7.1.

**Failure recovery**: if a Step 7 command fails, fix the owning source artifact and resume from the failed sub-step per [`workflows/failure-recovery.md`](../workflows/failure-recovery.md). Do not restart the planning session unless the owning source changed.

> If files are missing: PAUSE, list the missing filenames, point the user to `images/image_prompts.md` (each `### Image N:` block is paste-ready for ChatGPT / Gemini / Midjourney; auto-generated from `image_prompts.json`) and the required placement `project/images/<filename>`. Resume Step 7.1 only after all expected files are in place. `finalize_svg.py` and `svg_to_pptx.py` do not detect missing files at this layer — proceeding with gaps produces a deck with broken image references.

> **Spot-illustration sheets at this gate**: `slice` element files are **derived**, not placed by the user. If a sheet was `Needs-Manual` (offline), the element files do not exist yet — list the **sheet** filename (`images/<sheet>.png`) plus its element target names, and instruct: place the sheet, then run the Step 5 `slice_images.py` command for it, then re-run `analyze_images.py`, before resuming 7.1. Never tell the user to hand-place the individual element files — they only come from slicing the sheet.

> ⚠️ Run the three sub-steps **one at a time** — each must complete successfully before the next.
> ❌ **NEVER** combine them into a single code block or shell invocation.

Canonical three-command pipeline (mirrors `references/shared-standards.md` §5):

**Step 7.1** — Split speaker notes:
```bash
python3 ${SKILL_DIR}/scripts/total_md_split.py <project_path>
```

**Step 7.2** — SVG post-processing (icon embedding / image crop & embed / raster image optimization / text flattening / rounded rect to path):
```bash
python3 ${SKILL_DIR}/scripts/finalize_svg.py <project_path>
```
Default raster handling for `svg_final/`: images are embedded at the rendered SVG size budget (`--image-scale 2`, `--max-dimension 2560`), opaque PNG photos may be written as JPEG, and transparent assets remain PNG. Use `--no-compress` or a higher `--max-dimension` only for diagnostic / high-fidelity SVG snapshots.

**Step 7.3** — Export PPTX (embeds speaker notes by default):
```bash
python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path>
# Output (default-flow mode):
#   exports/<project_name>_<timestamp>.pptx           ← native pptx (canonical output, reads svg_output/)
#   backup/<timestamp>/svg_output/                    ← Executor SVG source backup (always written)
#
# Add --svg-snapshot to additionally emit the SVG-image preview pptx alongside the native pptx:
#   exports/<project_name>_<timestamp>_svg.pptx      ← SVG preview pptx (reads svg_final/)
# Add --native-objects to emit real editable chart/table objects instead of flattened shapes:
#   exports/<project_name>_<timestamp>_native_charts.pptx  ← native chart/table objects (data-pptx-native markers)
# Re-export with --recorded-narration audio (generate-audio workflow) embeds per-slide narration:
#   exports/<project_name>_<timestamp>_narrated.pptx  ← narrated pptx (embedded audio + auto-advance timings)
```

**Optional flags & post-export windows** — native-pptx fidelity notes, raster / merge /
`--native-objects` flags, animation (`-t` / `-a` / `--animation-*`) and recorded-narration
options, plus the post-export annotation / direct-edit / preview windows are in
[`workflows/export-options.md`](../workflows/export-options.md). The three commands above are the
default path and need none of them.


> ❌ **NEVER** substitute `cp` for `finalize_svg.py` — finalize performs multiple critical processing steps
> ❌ **NEVER** force `-s output` for the legacy/preview pptx (PowerPoint's internal SVG parser drops icons and rounded corners). The default auto-split already gives native the high-fidelity source it needs without touching legacy.
> ❌ **NEVER** use `--only` (it suppresses one of the two output files)
