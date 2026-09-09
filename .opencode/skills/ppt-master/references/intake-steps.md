> Source: `SKILL.md` Workflow Steps 1–3 (Source Content Processing, Project Initialization, Template Option) — full original text, moved verbatim. Read when entering Step 1; `SKILL.md` keeps the gates, commands, and checkpoints.

### Step 1: Source Content Processing

🚧 **GATE**: User has provided source material (PDF / DOCX / EPUB / URL / Markdown file / text description / conversation content — any form is acceptable).

> **No source content?** When the user supplies only a topic name or requirements without any file or substantive description, run the [`topic-research`](../workflows/topic-research.md) workflow first, then return here with its products as input.

When the user provides non-Markdown content, convert immediately through the
unified dispatcher. It preserves the backend converters' existing behavior,
routes by source type, and writes the standard Markdown plus conversion profile.

| User Provides | Action |
|---------------|--------|
| PDF / DOCX / Office document / XLSX / XLSM / PPTX / EPUB / HTML / LaTeX / RST / web URL | `python3 ${SKILL_DIR}/scripts/source_to_md.py <file_or_URL_or_dir> [<file_or_URL_or_dir> ...]` |
| CSV / TSV | Read directly as plain-text table source |
| Markdown | Read directly |

For PPTX sources, Step 1 converts the deck to Markdown content; after Step 2
`import-sources`, standard PPTX intake is also written to `<project>/analysis/`.
Use `source_to_md.py -t <type>` only when extension detection is ambiguous.
Default local conversion writes Markdown/profile outputs beside each source file.
Use `-o` only when a specific output file/directory is required; with multiple
inputs or directory inputs, `-o` is an output directory. Backend converter details are documented in
[`scripts/docs/conversion.md`](../scripts/docs/conversion.md).

> **Office vector assets (EMF/WMF) from DOCX/PPTX sources**:
> Source conversion extracts embedded Office vector images (.emf/.wmf)
> alongside bitmap images when the source format exposes them. After `import-sources`, these land in `images/`
> together with `image_manifest.json` and are first-class assets in §VIII Image Resource List.
>
> **Do NOT convert EMF/WMF to PNG.** The PPT Master pipeline preserves them as external
> references (`finalize_svg.py` skips them) and `svg_to_pptx.py` embeds them as
> PPTX-native media via `image/x-emf` / `image/x-wmf` MIME — PowerPoint renders them at full vector fidelity.
> Converting via LibreOffice/Inkscape introduces CJK font substitution drift and
> rasterization loss; the original EMF/WMF is always higher fidelity than the converted PNG.
>
> Browser-based live preview cannot render EMF (will show blank) — this is expected;
> the PPTX output is the source of truth.

**✅ Checkpoint — Confirm source content is ready, proceed to Step 2.**

---

### Step 2: Project Initialization

🚧 **GATE**: Step 1 complete; source content is ready (Markdown file, user-provided text, or requirements described in conversation are all valid).

```bash
python3 ${SKILL_DIR}/scripts/project_manager.py init <project_name> --format <format> --dir .
```

Format options must be named with concrete dimensions. Default: `ppt169` = `1280x720`, `viewBox="0 0 1280 720"`. Other examples: `ppt43` = `1024x768`, `story` = `1080x1920`, `banner` = `1920x1080`. For the full format list, see `references/canvas-formats.md`.

Import source content (choose based on the situation):

| Situation | Action |
|-----------|--------|
| Has source files (PDF/MD/etc.) | `python3 ${SKILL_DIR}/scripts/project_manager.py import-sources <project_path> <source_files_or_dirs...> --move` |
| User provided text directly in conversation | No import needed — content is already in conversation context; subsequent steps can reference it directly |

For PPTX sources, `import-sources` automatically runs the standard intake enrichment:

```bash
python3 ${SKILL_DIR}/scripts/pptx_intake.py <project_path>/sources/<source.pptx> -o <project_path>/analysis
```

For each PPTX it writes `<stem>.identity.json` (canvas, theme palette/fonts, observed usage) and `<stem>.slide_library.json` (text slots, geometry, native tables, native chart caches), and merges that deck's Strategist-facing digest into the single multi-deck index `analysis/source_profile.json` (`decks[]`, one self-contained entry per source deck, with prefixed artifact pointers). In the main generation path these are source facts and recommendation candidates, not replica constraints; beautify and template-fill workflows decide separately which fields become locked constraints.

Multi-deck: several PPTX files may be imported into one main-pipeline project — each gets its own `<stem>.*` artifacts and a deck entry in `source_profile.json`. `source_profile.json` stays the single must-read index (one entry for a one-deck project, several for a combined-source project). Stems must be distinct; re-importing the same stem replaces that deck's entry. The beautify / template-fill workflows remain single-deck (1:1 to one chosen source deck) and read that deck's `<stem>.*` artifacts.

> ⚠️ **MUST use `--move`** (not copy): all source files — Step 1's generated Markdown, original PDFs / MDs / images — go into `sources/` via `import-sources --move`. If Step 1 wrote Markdown beside the original sources, pass that source path/directory once. If Step 1 used `-o` to write Markdown elsewhere, pass both the original source path(s)/directory and the Markdown output path(s)/directory. After execution they no longer exist at the original location. Intermediate artifacts (e.g., `_files/`) are handled automatically.

**✅ Checkpoint — Confirm project structure created successfully, `sources/` contains all source files, converted materials are ready. Proceed to Step 3.**

---

### Step 3: Template Option

🚧 **GATE**: Step 2 complete; project directory structure is ready.

**Default — free design.** Proceed directly to Step 4. Do NOT query any `*_index.json` unless triggered. Do NOT ask the user. Do NOT proactively suggest, hint at, or fuzzy-match any template based on content, slug-like words, or vague style descriptions.

**Hard boundary — raw PPTX template references are not Step 3 templates.** PPTX-as-source remains valid in Step 1 / Step 2, and raw PPTX template + generated PPTX routes to `template-fill`. But if the user wants the SVG/template-based generation route from that PPTX, stop before Step 3. The user must first run [`workflows/create-template.md`](../workflows/create-template.md), then return with the generated template directory path. Step 3 only consumes an explicit template directory that already contains `design_spec.md` with `kind: brand` / `kind: layout` / `kind: deck`.

Do **not** reinterpret this boundary as 1:1 redesign or free SVG generation. Use `template-fill` for raw PPTX template + generated PPTX requests; use `beautify` only when the source deck's page count, order, and wording are preserved.

**Template flow triggers ONLY on explicit directory paths** supplied by the user in their initial message. The trigger rule is mechanical, not interpretive:

| User input contains | Step 3 action |
|---|---|
| One or more explicit template directory paths (each resolves to a directory containing `design_spec.md` with `kind: brand` / `kind: layout` / `kind: deck` in its YAML frontmatter) | Read each spec's `kind`, dispatch per the kind matrix below, fuse if multiple |
| Anything else — bare template names ("用 academic_defense"), style descriptions ("麦肯锡风格"), brand mentions ("招商银行风格"), vague intent ("想用个模板"), or silence | Skip Step 3, free design |

There is no slug matching, no name lookup, no fuzzy resolution. A name without a path does not trigger — the user must give a path the AI can `cd` into.

> Style descriptions ("麦肯锡风格" / "Keynote 风" / "极简风" / etc.) never trigger Step 3. They flow into the Strategist confirmation stage as a style brief (color / typography / tone in fields e–g).

> Bare names ("academic_defense", "招商银行", "anthropic") do NOT trigger Step 3 even if a matching directory exists in the library. The user must give a path. AI must not "helpfully" resolve a name to a path.

> "What templates exist?" is out-of-band Q&A — answer by listing entries from `brands_index.json` / `layouts_index.json` / `decks_index.json` together with their paths. Listing alone does not advance the pipeline; the user must send a path back to trigger Step 3.

> To create a new layout or deck, read [`workflows/create-template.md`](../workflows/create-template.md). To create a new brand, read [`workflows/create-brand.md`](../workflows/create-brand.md).

**Dispatch & fusion detail** — the three template kinds, segment ownership, single-path
dispatch (with the copy/split commands), multi-path fusion priority, same-kind conflict
resolution, and fused-spec provenance are in
[`workflows/template-dispatch.md`](../workflows/template-dispatch.md). Read it **only** when the
trigger above fired; the default free-design path never opens it.

**✅ Checkpoint — Default path proceeds to Step 4 without user interaction. If the user supplied one or more explicit template paths, those have been dispatched (or fused) into `<project_path>/templates/` before advancing.**
