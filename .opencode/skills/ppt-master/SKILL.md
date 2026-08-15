---
name: ppt-master
description: >
  Converts source documents (PDF/DOCX/URL/Markdown) into SVG slide pages and exports to PPTX. Use when user asks to "create PPT", "make presentation", "生成PPT", "做PPT", "制作演示文稿", or mentions "ppt-master".
---

> **`<project_path>` 取在哪里（本部署的硬约定）**：**当前工作目录就是本会话的产物目录**
> （网关建会话时已把 opencode 的 session.directory 指到那里），所以本文档下面所有命令里的
> `<project_path>`，一律取**当前目录下的 `<项目名>/`**——直接用相对路径，别再拼任何 `outputs/…` 前缀。
> 于是工程目录、`sources/`、`images/`、`templates/`、导出的 .pptx 全都落在会话产物目录下，
> 既能出现在界面的"产出"侧栏，也随数据卷持久保存。
>
> **绝不要**把工程建到 `${REPO_ROOT:-/app}`（仓库根）下：那里是**应用安装目录**，
> 升级 / 重装 / 更新技能包都可能整片覆盖，**工程连同已导出的 PPT 会一起蒸发**，
> 而且全程不出现在"产出"侧栏里。
> **建工程时必须显式传 `--dir .`**：`project_manager.py init` 的 `base_dir` 默认是 `cwd/projects`（脚本 116 行），
> 不传 `--dir` 就会多套一层 `projects/`，与上面的约定不一致。断点续做口令同理用相对项目名。
>
> 注：本文档里 `<project_name>` 等尖括号写法都是**占位符**，实际执行前替换成真实值
> （直接照抄进 shell 会因 `<` `>` 是重定向符而报错）。
>
> **中文字体（本容器的现实，读一遍免踩坑）**：容器里【没有】`Microsoft YaHei` / `SimHei` /
> `SimSun` / `KaiTi` 等 Windows 字体文件，但**照常按下方 references（strategist §g 等）的
> Windows 家族名选字体即可**——镜像内置 fontconfig 别名（`/etc/fonts/conf.d/65-windows-cjk-aliases.conf`）
> 把这些名字解析到容器真实字体（黑体系→`WenQuanYi Micro Hei`、宋体/仿宋系→`AR PL SungtiL GB`、
> 楷体→`AR PL KaitiM GB`，全部单文件字体；**刻意不用**同样已装的 Noto CJK SC——本镜像的
> LibreOffice 对多 face TTC 有索引缺陷，指过去会渲染成日文字形，实测锚定），LibreOffice
> 预览渲染的是正确的简体字形；pptx 里记录的仍是 Windows 字体名，用户下载后在自己机器上
> 打开效果最佳。因此：**①** 不要因为 `fc-list` 查不到 YaHei 就换用别的字体名或停下报错；
> **②** **禁止在容器里现装字体**（`apt install` / 下载 ttf 塞 `~/.fonts`）——装进容器可写层，
> 重建容器即消失，还会挤占共享宿主磁盘；若确实缺某个字形，如实告知用户该字体不在预装清单、
> 请平台管理员改镜像。

# PPT Master Skill

> AI-driven multi-format SVG content generation system. Converts source documents into high-quality SVG pages through multi-role collaboration and exports to PPTX.

**Core Pipeline**: `Source Document → Create Project → [Template] → Strategist → [Image_Generator] → Executor Live Preview → Quality Check → Post-processing → Export`

> [!CAUTION]
> ## 🚨 Global Execution Discipline (MANDATORY)
>
> **This workflow is a strict serial pipeline. The following rules have the highest priority — violating any one of them constitutes execution failure:**
>
> 1. **SERIAL EXECUTION** — Steps MUST be executed in order; the output of each step is the input for the next. Non-BLOCKING adjacent steps may proceed continuously once prerequisites are met, without waiting for the user to say "continue"
> 2. **BLOCKING = HARD STOP** — Steps marked ⛔ BLOCKING require a full stop; the AI MUST wait for an explicit user response before proceeding and MUST NOT make any decisions on behalf of the user
> 3. **NO CROSS-PHASE BUNDLING** — Cross-phase bundling is FORBIDDEN. (Note: the Strategist confirmation stage in Step 4 is ⛔ BLOCKING — the AI MUST present recommendations and wait for explicit user confirmation before proceeding. Once the user confirms, all subsequent non-BLOCKING steps — design spec output, SVG generation, speaker notes, and post-processing — may proceed automatically without further user confirmation)
> 4. **GATE BEFORE ENTRY** — Each Step has prerequisites (🚧 GATE) listed at the top; these MUST be verified before starting that Step
> 5. **NO SPECULATIVE EXECUTION** — "Pre-preparing" content for subsequent Steps is FORBIDDEN (e.g., writing SVG code during the Strategist phase)
> 6. **NO SUB-AGENT SVG GENERATION** — Executor Step 6 SVG generation is context-dependent and MUST be completed by the current main agent end-to-end. Delegating page SVG generation to sub-agents is FORBIDDEN
> 7. **SEQUENTIAL PAGE GENERATION ONLY** — In Executor Step 6, after the global design context is confirmed, SVG pages MUST be generated sequentially page by page in one continuous pass. Grouped page batches (for example, 5 pages at a time) are FORBIDDEN
> 8. **SPEC_LOCK RE-READ PER PAGE** — Before generating each SVG page, Executor MUST `read_file <project_path>/spec_lock.md`. All colors / fonts / icons / images MUST come from this file — no values from memory or invented on the fly. Executor MUST also look up the current page's `page_rhythm` (`anchor` / `dense` / `breathing`), `page_layouts` (which template SVG to inherit, if any), and `page_charts` (which chart template to adapt, if any). Empty / absent entries are intentional Strategist signals — see executor-base.md §2.1. This rule exists to resist context-compression drift on long decks and to break the uniform "every page is a card grid" default
> 9. **SVG MUST BE HAND-WRITTEN, NOT SCRIPT-GENERATED** — Every SVG page is written by the main agent directly, one page at a time (see rules 6 and 7). Writing or running a Python / Node / shell script that produces the SVG files in batch — looping over pages, templating from data, or emitting them via a generator — is FORBIDDEN, including under "save tokens", "quick draft", or "user is in a hurry" pretexts. The script-generation path was tried on a feature branch and abandoned: cross-page visual consistency depends on per-page authoring with full upstream context, which a generator script cannot reproduce
> 10. **FOLLOW DETERMINISTIC ROUTING RULES** — Do not add blocking routing questions when this skill defines a route. If the user request violates a route precondition, state the required prerequisite and stop that route instead of asking the user to choose around the rule. Ordinary finite options, stylistic preferences, and recoverable details are surfaced with a recommended value plus alternatives at the next existing confirmation gate.

> [!IMPORTANT]
> ## 🌐 Language & Communication Rule
>
> - **Response language**: match the user's input and source materials. Explicit user override (e.g., "请用英文回答") takes precedence.
> - **User-facing option labels**: when presenting confirmations, brief proposals, choices, or finite option sets, use the user's language for labels and explanations. English enum IDs / file fields may appear in parentheses for precision, but never rely on English-only labels such as `deck`, `layout`, `mirror`, or `fidelity` without a localized explanation.
> - **Template format**: `design_spec.md` MUST follow its original English template structure (section headings, field names) regardless of conversation language. Content values may be in the user's language.

> [!IMPORTANT]
> ## 🔌 Compatibility With Generic Coding Skills
>
> - `ppt-master` is a repository-specific workflow, not a general application scaffold
> - Do NOT create `.worktrees/`, `tests/`, branch workflows, or generic engineering structure by default
> - On conflict with a generic coding skill, follow this skill unless the user explicitly says otherwise

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
| Route selection | [`workflows/routing.md`](workflows/routing.md) | Owns deterministic route choice before the main pipeline or a standalone workflow |
| Workflow registry | [`workflows/index.md`](workflows/index.md) | Owns standalone workflow trigger/precondition/output inventory |
| Artifact ownership | [`references/artifact-ownership.md`](references/artifact-ownership.md) | Owns fact channels, source/derived artifact boundaries, and regeneration rules |
| Failure recovery | [`workflows/failure-recovery.md`](workflows/failure-recovery.md) | Owns stop/continue decisions for common failures |
| Confirm UI details | [`scripts/docs/confirm_ui.md`](scripts/docs/confirm_ui.md) | Owns schema, launcher behavior, port strategy, and chat fallback details |

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

## Standalone Workflows

**Route authority**: Use [`workflows/routing.md`](workflows/routing.md) before entering the main pipeline or any standalone workflow.

**Registry**: Use [`workflows/index.md`](workflows/index.md) for the complete workflow list, triggers, preconditions, exclusions, outputs, and blocking points.

### PPTX Route Boundary

| User intent | Route |
|---|---|
| Raw PPTX template plus new material/topic, generate a PPTX | [`template-fill-pptx`](workflows/template-fill-pptx.md) |
| Existing PPTX, preserve page count/order and slide wording 1:1, improve layout | [`beautify-pptx`](workflows/beautify-pptx.md) |
| Existing PPTX as source material, rethink outline or change page count/order | Main pipeline via `source_to_md.py` plus PPTX intake |
| Build a reusable template package from a PPTX/design reference | [`create-template`](workflows/create-template.md), then return with the generated template directory path |
| Finished PPTX, keep content/layout stable and add notes/audio/timing/transitions | [`native-enhance-pptx`](workflows/native-enhance-pptx.md) |

**MUST**: Raw `.pptx` template plus "generate PPTX" routes to `template-fill-pptx` by default. The SVG generation route consumes only an explicit template directory path that already contains a valid template `design_spec.md`.

**MUST**: Beautify is strictly 1:1. Any split, merge, drop, reorder, or page-count change routes to the main pipeline.

**FALLBACK**: Ambiguous requests such as "make this PPT more professional" require exactly one discriminator question: preserve original page count/order and slide wording, or treat the deck as source material and restructure it?

---

## Workflow

### Step 1: Source Content Processing

🚧 **GATE**: User has provided source material (PDF / DOCX / EPUB / URL / Markdown file / text description / conversation content — any form is acceptable).

> **No source content?** When the user supplies only a topic name or requirements without any file or substantive description, run the [`topic-research`](workflows/topic-research.md) workflow first, then return here with its products as input.

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
[`scripts/docs/conversion.md`](scripts/docs/conversion.md).

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

**Hard boundary — raw PPTX template references are not Step 3 templates.** PPTX-as-source remains valid in Step 1 / Step 2, and raw PPTX template + generated PPTX routes to `template-fill`. But if the user wants the SVG/template-based generation route from that PPTX, stop before Step 3. The user must first run [`workflows/create-template.md`](workflows/create-template.md), then return with the generated template directory path. Step 3 only consumes an explicit template directory that already contains `design_spec.md` with `kind: brand` / `kind: layout` / `kind: deck`.

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

> To create a new layout or deck, read [`workflows/create-template.md`](workflows/create-template.md). To create a new brand, read [`workflows/create-brand.md`](workflows/create-brand.md).

**Dispatch & fusion detail** — the three template kinds, segment ownership, single-path
dispatch (with the copy/split commands), multi-path fusion priority, same-kind conflict
resolution, and fused-spec provenance are in
[`workflows/template-dispatch.md`](workflows/template-dispatch.md). Read it **only** when the
trigger above fired; the default free-design path never opens it.

**✅ Checkpoint — Default path proceeds to Step 4 without user interaction. If the user supplied one or more explicit template paths, those have been dispatched (or fused) into `<project_path>/templates/` before advancing.**

---

### Step 4: Strategist Phase (MANDATORY — cannot be skipped)

🚧 **GATE**: Step 3 complete; default free-design path taken, or (if triggered) template files copied into the project.

First, read the role definition:
```
Read references/strategist.md
```

> ⚠️ **Mandatory gate**: before writing `design_spec.md`, Strategist MUST `read_file templates/design_spec_reference.md` and follow its full I–XI section structure. See `strategist.md` Section 1.

**Artifact ownership**: fact-channel and source/derived artifact boundaries are defined in [`references/artifact-ownership.md`](references/artifact-ownership.md). This Step uses those ownership rules; it does not redefine them.

**Fact channels** — `<project_path>/analysis/` 的事实文件归属（`source_profile.json` 等 MUST-read 契约、多 deck 索引读法、源 deck 的配色/字体只是参考而非约束），以及 **channel ownership**（`sources/` 里哪些算内容、哪些是流程 sidecar 不许当内容读、图表数值该从哪一路取）——正文在 [`references/artifact-ownership.md`](references/artifact-ownership.md)，进入 Step 4 前读它。

**Strategist confirmation stage** (full template: `templates/design_spec_reference.md`):

⛔ **BLOCKING**: present the Strategist confirmation stage and **wait for explicit user confirmation or modification** before outputting Design Specification & Content Outline. This is the single core confirmation gate — once the final confirmation lands, all subsequent steps proceed automatically. The default Confirm UI delivers the gate in **three stages** (direction → design system → images / execution; see below); the chat fallback mirrors the same staged order.

1. Canvas format
2. Page count range
3. Target audience
4. Style objective
5. Color scheme
6. Icon usage approach
7. Typography plan, including formula rendering policy
8. Image usage approach

**Confirmation mechanics** — the Confirm UI launch/wait commands, per-stage authoring
contract, deployment override, opt-out, and the upstream-override re-derivation rule live in
[`workflows/confirm-stages.md`](workflows/confirm-stages.md). Read it when entering Step 4.

> 🛑 **本部署：确认页不可用（未装 flask），直接走聊天确认。** 不要启动 `confirm_ui/server.py`、
> 不要向用户播报任何 5050 地址。三段确认的**内容与顺序完全不变**，变的只是承载方式（网页 → 聊天）：
> 在对话里逐段呈现 Stage 1 / Stage 2 / Stage 3 的候选并等待用户回复。⛔ BLOCKING 语义保留 ——
> 最终确认仍必须拿到用户明确答复才能进入 Step 5。细节见上面的 workflow 文件。

**Honoring the confirmation (result.json is authoritative — Mandatory)**: the confirmed values **override your own recommendations** when you write `design_spec.md` / `spec_lock.md`. A user who changed any field changed it on purpose. In particular, map `image_usage` to §VIII `Acquire Via` (its value names differ from §h options — translate). `image_usage` may be either a legacy single string or a Confirm UI multi-select array; for arrays, apply every selected source. `image_notes`, when present, is a user-authored image intent note that Strategist must honor while assigning per-page §VIII rows:

| `result.json.image_usage` | §VIII `Acquire Via` | h.5 + Step 5 generation |
|---|---|---|
| `ai` | `ai` rows | Run h.5 (lock rendering + palette); Step 5 generates |
| `web` | `web` rows | None |
| `provided` | **`user`** rows | None — never generate |
| `placeholder` | `placeholder` rows | None |
| `none` | no image rows (§h option A) | None |
| Legacy custom prose | Infer the intended rows from the prose | Run h.5 only if the prose includes AI |

When the confirmed `image_usage` does not include `ai` (and no legacy custom prose includes AI), do **NOT** run h.5, do **NOT** write `ai` rows, and do **NOT** generate images in Step 5 — regardless of what you recommended. `none` is exclusive: if confirmed, write no §VIII image rows. The same "confirmed value wins" rule applies to every field (color → §III, typography → §IV, etc.).

**Small spot illustrations are a Strategist judgment, not a confirmation field.** 用户只通过 `image_usage` 选图像**来源**；是否走装饰性插图由锁定的 `visual_style` 的 illustration propensity 决定，只体现在 `image_notes` 的理由里，**绝不新增确认项**。用户明确要或明确不要则覆盖该默认；`image_usage: none` 仍然优先（不写任何插图行）。需要 ≥3 张同族 AI 插图时默认走 Illustration Sheet + `slice`，不要一张一张生成。完整规则与优先级：[`references/strategist-images.md`](references/strategist-images.md)。


**Mandatory — split-mode note** (not a separate confirmation): after listing the Strategist confirmation stage details, you MUST append exactly one short line (rendered in the user's language, prefixed with 💡) about generation mode. Pick the variant by qualitative read of upstream-load signals — recommended page count, source-material bulk, whether `topic-research` ran with substantial web-fetch accumulation:

| Signal read | Line content |
|---|---|
| Heavy (long page count / bulky sources / heavy web-fetch accumulation) | State estimated page count and large source size; recommend switching to [split mode](workflows/resume-execute.md) after Step 5 — stop this chat, open a fresh window and input `继续生成 <project_name>` to enter the execution session (SVG generation + export); no response or "continue" = default continuous mode. |
| Normal (default) | State scale is moderate, default continuous mode generates in one go; if mid-way window switch is desired, input `继续生成 <project_name>` after Step 5 to switch to [split mode](workflows/resume-execute.md). |

This line is required output every run — the user must always see the mode choice exists. Whether to act on it is the user's call. When the Confirm UI is used, this choice also appears as the in-page generation-mode toggle and is captured in `result.json` (`generation_mode`); the chat-summary fallback still prints this line.

**Mandatory — spec-refinement note** (not a separate confirmation): after the split-mode line, you MUST append one short opt-in line (rendered in the user's language, prefixed with 💡) telling the user they may **refine the spec first** — Strategist will produce the full design spec, then stop for review/revision of any part of it before any generation, via the [refine-spec](workflows/refine-spec.md) workflow. Default is OFF: no request → the spec is written in one go and the pipeline auto-proceeds as usual. Only when the user explicitly asks in chat (e.g. "refine the spec first") or confirms `refine_spec: true` through Confirm UI does the [refine-spec](workflows/refine-spec.md) workflow take over after the Strategist confirmation stage. This line, like the split-mode line, is required output every run — the user must see the choice exists; whether to act on it is theirs. When the Confirm UI is used, this choice also appears as the in-page refine-spec toggle and is captured in `result.json` (`refine_spec`); the chat-summary fallback still prints this line.

**Formula rendering policy lives inside item 7 (Typography plan)**:

| Policy | Behavior |
|---|---|
| `mixed` (default) | Strategist renders complex formula-worthy expressions as PNG assets; simple inline expressions remain editable text / Unicode |
| `render-all` | Strategist renders every formula-worthy expression as PNG assets |
| `text-only` | No formula rendering; formulas remain editable text / Unicode |

After the Strategist confirmation stage is approved and **before outputting `design_spec.md` / `spec_lock.md`**, if the confirmed formula policy is `mixed` or `render-all` and the content contains formula-worthy expressions, Strategist MUST:

1. Identify explicit LaTeX and any source expressions that should be faithfully structured as formulas.
2. Write `<project_path>/images/formula_manifest.json` with only the formulas selected for rendering.
3. Run:
   ```bash
   python3 ${SKILL_DIR}/scripts/latex_render.py <project_path>
   ```
4. Include the rendered formula PNGs as `Acquire Via: formula`, `Status: Rendered`, `Type: Latex Formula` rows in `design_spec.md §VIII Image Resource List`; also list them in `spec_lock.md images` with `| no-crop`.

The formula renderer uses a provider fallback chain by default: `codecogs,quicklatex,mathpad,wikimedia`. The first three are color-aware; Wikimedia is an availability fallback. Formula PNGs are transparent by default: manifest `background` is the temporary render matte and transparency-removal reference, not a retained final background unless `transparent: false` is set for that item. Do not scan `spec_lock.md` for `$...$` or `$$...$$`. Dollar-delimited math in source material is only a signal for Strategist; the renderer consumes the explicit manifest.

If the user provided images or formula PNGs were rendered, run analysis **before outputting the design spec**. It writes `analysis/image_analysis.csv` — the authoritative regenerated image-fact view in the `analysis/` folder, which MUST be read before authoring §VIII:
```bash
python3 ${SKILL_DIR}/scripts/analyze_images.py <project_path>/images
```

> 🔁 **图像事实按需重算，不是持久存储**：`images/` 是活动目录（导入时抽图、用户随时增删、Step 5 写入 web/AI 图），唯一真相是它**当前的内容**；`analysis/image_analysis.csv` 只是它的**重新生成视图**。因此在任何要读图像事实的步骤前先重跑 `analyze_images.py <project_path>/images`（§h 推荐前、写 §VIII 前、Step 5 取图后、以及用户说换过图之后）。不设缓存、不做失效管理。

> ⚠️ **Image handling**: NEVER directly read / open / view image files (`.jpg`, `.png`, etc.). All image info comes from `analyze_images.py` output (`analysis/image_analysis.csv`) or the Design Spec's Image Resource List.

**Output**:
- `<project_path>/design_spec.md` — human-readable design narrative
- `<project_path>/spec_lock.md` — machine-readable execution contract (skeleton: `templates/spec_lock_reference.md`); Executor re-reads before every page

**✅ Checkpoint — Phase deliverables complete, auto-proceed to next step**:
```markdown
## ✅ Strategist Phase Complete
- [x] Read the auto-extracted facts already in `analysis/` (e.g. `source_profile.json`) before the Strategist confirmation stage
- [x] Strategist confirmation stage completed (user confirmed via Confirm UI `result.json` or chat fallback)
- [x] Split-mode note appended below the confirmation fields (heavy or normal variant)
- [x] Spec-refinement opt-in line appended (default OFF; only the user's explicit request enters the refine-spec workflow)
- [x] Design Specification & Content Outline generated
- [x] Execution lock (spec_lock.md) generated
- [ ] **Next**: Auto-proceed to [Image_Generator / Executor] phase
```

---

### Step 5: Image Acquisition Phase (Conditional)

🚧 **GATE**: Step 4 complete; Design Specification & Content Outline generated and user confirmed. Any formula rows already have `Acquire Via: formula` and `Status: Rendered`.

> **Trigger**: At least one row in the resource list has `Acquire Via: ai`, `web`, and/or `slice`. If every row is `user`, `formula`, or `placeholder`, skip to Step 6.

**Failure recovery**: stop/continue behavior for AI/web/slice/image-readiness failures is defined in [`workflows/failure-recovery.md`](workflows/failure-recovery.md). This Step keeps the acquisition procedure.

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

> ⚠️ **Step 5 的四条硬规矩**（manifest 契约必走、web 多行必须 `--batch`、≥3 张同族插图走 sheet + slice、确认过的 `image_ai_path` 优先于 `IMAGE_BACKEND`）正文在 [`image-base.md`](references/image-base.md) 与 [`image-generator.md`](references/image-generator.md) §4.3 / §7。本步真的有 `ai` / `web` / `slice` 行时按上表 lazy-load 它们，规矩随正文一起到手。

Workflow:

1. Extract all resource rows from the design spec and group them by `Acquire Via`; rows with `Status: Pending` or `Status: Failed` and `Acquire Via ∈ {ai, web, slice}` must all reach a terminal state before Executor starts
2. Generate prompts (ai rows) and/or run search (web rows) per [image-base.md](references/image-base.md) §3 dispatch table
2.5. **Slice any spot-illustration sheets (only if `slice` rows exist).** For each generated `ai` **sheet** row, run `slice_images.py` (grid + the element `--names` matching the `slice` rows, `--trim --alpha`) so every element file lands in `images/`; mark each `slice` row `Generated`. A sheet still in `Needs-Manual` cannot be sliced — leave its `slice` rows `Needs-Manual` and surface them at the Step 7 readiness gate. Contract: [image-generator.md](references/image-generator.md) §4.3.
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
  - [ ] **Next**: open a fresh chat window and input `继续生成 <project_name>` to enter the execution session via the [`resume-execute`](workflows/resume-execute.md) workflow.
  ```

> On acquisition failure, do NOT halt — follow the Failure Handling rule in [image-base.md](references/image-base.md) §5: retry once, then mark the row `Needs-Manual`, report to user, and continue to the checkpoint above.

---

### Step 6: Executor Phase

🚧 **GATE**: Step 4 (and Step 5 if triggered) complete; all prerequisite deliverables are ready.

**Artifact ownership**: `svg_output/` is the author source, `svg_final/` is derived, and image facts come from the regenerated `analysis/image_analysis.csv`; see [`references/artifact-ownership.md`](references/artifact-ownership.md).

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
其它部署的原始启动流程见 [`workflows/live-preview-startup.md`](workflows/live-preview-startup.md)。

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

> **Chart pages?** If this deck contains data charts (bar / line / pie / radar / etc.), run the standalone [`verify-charts`](workflows/verify-charts.md) workflow before Step 7 to calibrate coordinates. AI models routinely introduce 10–50 px errors when mapping data to pixel positions; verify-charts eliminates that class of error. Skip if no chart pages.

> **Visual self-check (opt-in)?** If the user explicitly asked for a per-page visual re-pass on the SVGs ("跑一下视觉自检 / 视觉回看", "visual review", "check pages visually", etc.), run the standalone [`visual-review`](workflows/visual-review.md) workflow before Step 7. Do NOT run it by default and do NOT recommend it based on inferred model capability or deck size — trigger is user request only.

---

### Step 7: Post-processing & Export

🚧 **GATE**: Step 6 complete; all SVGs generated to `svg_output/`; speaker notes `notes/total.md` generated.

🚧 **Image readiness GATE** (when Step 5 left ai rows in `Needs-Manual`): every expected file must exist at `project/images/<filename>` before running 7.1.

**Failure recovery**: if a Step 7 command fails, fix the owning source artifact and resume from the failed sub-step per [`workflows/failure-recovery.md`](workflows/failure-recovery.md). Do not restart the planning session unless the owning source changed.

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
[`workflows/export-options.md`](workflows/export-options.md). The three commands above are the
default path and need none of them.


> ❌ **NEVER** substitute `cp` for `finalize_svg.py` — finalize performs multiple critical processing steps
> ❌ **NEVER** force `-s output` for the legacy/preview pptx (PowerPoint's internal SVG parser drops icons and rounded corners). The default auto-split already gives native the high-fidelity source it needs without touching legacy.
> ❌ **NEVER** use `--only` (it suppresses one of the two output files)


---

## Role Switching Protocol

Before switching roles, **MUST first read** the corresponding reference file. Output marker:

```markdown
## [Role Switch: <Role Name>]
📖 Reading role definition: references/<filename>.md
📋 Current task: <brief description>
```

---


---

## Notes

- Local preview: `python3 -m http.server -d <project_path>/svg_final 8000`
- **Troubleshooting**: on generation issues (layout overflow, export errors, blank images, etc.), check `docs/faq.md` for known solutions
