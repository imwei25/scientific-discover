> Source: `SKILL.md` Main Pipeline Scripts, Template Index, and Notes — moved verbatim. Read when you need a script's purpose, an index JSON path, or the local-preview / troubleshooting notes.

## Main Pipeline Scripts

| Script | Purpose |
|--------|---------|
| `${SKILL_DIR}/scripts/source_to_md.py` | Unified source-to-Markdown dispatcher — default Step 1 entry for explicit file(s) or URL(s) |
| `${SKILL_DIR}/scripts/pptx_intake.py` | Standard PPTX intake enrichment — canvas / identity / slide geometry / tables / native chart data |
| `${SKILL_DIR}/scripts/project_manager.py` | Project init / validate / manage |
| `${SKILL_DIR}/scripts/icon_sync.py` | Copy chosen library icons into `<project>/icons/` at selection time; missing names reported + non-zero (re-pick gate) |
| `${SKILL_DIR}/scripts/analyze_images.py` | Image analysis |
| `${SKILL_DIR}/scripts/latex_render.py` | LaTeX formula rendering (manifest-driven PNG assets) |
| `${SKILL_DIR}/scripts/image_gen.py` | AI image generation (multi-provider) |
| `${SKILL_DIR}/scripts/slice_images.py` | Slice one AI illustration sheet into individual spot-illustration elements |
| `${SKILL_DIR}/scripts/svg_quality_checker.py` | SVG quality check |
| `${SKILL_DIR}/scripts/total_md_split.py` | Speaker notes splitting |
| `${SKILL_DIR}/scripts/finalize_svg.py` | SVG post-processing (unified entry) |
| `${SKILL_DIR}/scripts/svg_to_pptx.py` | Export to PPTX |
| `${SKILL_DIR}/scripts/native_enhance_pptx.py` | Existing PPTX enhancement project init / validation / direct OOXML patch export |
| `${SKILL_DIR}/scripts/native_narration_pptx.py` | Backward-compatible entrypoint for existing PPTX notes / narration enhancement |
| `${SKILL_DIR}/scripts/update_spec.py` | Propagate a `spec_lock.md` color / font_family change across all generated SVGs |

For complete tool documentation, see `${SKILL_DIR}/scripts/README.md`.

> **Windows note**: if a `python3 ...` command fails (common on python.org installs, which provide `python.exe` but not `python3.exe`), rerun the same command with `python` instead.

## Template Index

| Index | Path | Purpose |
|-------|------|---------|
| Layout templates | `${SKILL_DIR}/templates/layouts/layouts_index.json` | Query available page layout templates |
| Brand presets | `${SKILL_DIR}/templates/brands/brands_index.json` | Query available brand identity presets (color / typography / logo / voice) |
| Visualization templates | `${SKILL_DIR}/templates/charts/charts_index.json` | Query available visualization SVG templates (charts, infographics, diagrams, frameworks) |
| Icon library | `${SKILL_DIR}/templates/icons/` | See `${SKILL_DIR}/templates/icons/README.md`; search icons on demand with `ls templates/icons/<library>/ \| grep <keyword>` |

## Notes

- Local preview: `python3 -m http.server -d <project_path>/svg_final 8000`
- **Troubleshooting**: on generation issues (layout overflow, export errors, blank images, etc.), check `docs/faq.md` for known solutions
