> Source: `SKILL.md` Workflow Step 4 (Strategist Phase) — full original text, moved verbatim. Read when entering Step 4; `SKILL.md` keeps the ⛔ BLOCKING gate, mandatory commands, outputs, and pointers.

### Step 4: Strategist Phase (MANDATORY — cannot be skipped)

🚧 **GATE**: Step 3 complete; default free-design path taken, or (if triggered) template files copied into the project.

First, read the role definition:
```
Read references/strategist.md
```

> ⚠️ **Mandatory gate**: before writing `design_spec.md`, Strategist MUST `read_file templates/design_spec_reference.md` and follow its full I–XI section structure. See `strategist.md` Section 1.

**Artifact ownership**: fact-channel and source/derived artifact boundaries are defined in [`references/artifact-ownership.md`](../references/artifact-ownership.md). This Step uses those ownership rules; it does not redefine them.

**Fact channels** — `<project_path>/analysis/` 的事实文件归属（`source_profile.json` 等 MUST-read 契约、多 deck 索引读法、源 deck 的配色/字体只是参考而非约束），以及 **channel ownership**（`sources/` 里哪些算内容、哪些是流程 sidecar 不许当内容读、图表数值该从哪一路取）——正文在 [`references/artifact-ownership.md`](../references/artifact-ownership.md)，进入 Step 4 前读它。

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
[`workflows/confirm-stages.md`](../workflows/confirm-stages.md). Read it when entering Step 4.

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

**Small spot illustrations are a Strategist judgment, not a confirmation field.** 用户只通过 `image_usage` 选图像**来源**；是否走装饰性插图由锁定的 `visual_style` 的 illustration propensity 决定，只体现在 `image_notes` 的理由里，**绝不新增确认项**。用户明确要或明确不要则覆盖该默认；`image_usage: none` 仍然优先（不写任何插图行）。需要 ≥3 张同族 AI 插图时默认走 Illustration Sheet + `slice`，不要一张一张生成。完整规则与优先级：[`references/strategist-images.md`](../references/strategist-images.md)。


**Mandatory — split-mode note** (not a separate confirmation): after listing the Strategist confirmation stage details, you MUST append exactly one short line (rendered in the user's language, prefixed with 💡) about generation mode. Pick the variant by qualitative read of upstream-load signals — recommended page count, source-material bulk, whether `topic-research` ran with substantial web-fetch accumulation:

| Signal read | Line content |
|---|---|
| Heavy (long page count / bulky sources / heavy web-fetch accumulation) | State estimated page count and large source size; recommend switching to [split mode](../workflows/resume-execute.md) after Step 5 — stop this chat, open a fresh window and input `继续生成 <project_name>` to enter the execution session (SVG generation + export); no response or "continue" = default continuous mode. |
| Normal (default) | State scale is moderate, default continuous mode generates in one go; if mid-way window switch is desired, input `继续生成 <project_name>` after Step 5 to switch to [split mode](../workflows/resume-execute.md). |

This line is required output every run — the user must always see the mode choice exists. Whether to act on it is the user's call. When the Confirm UI is used, this choice also appears as the in-page generation-mode toggle and is captured in `result.json` (`generation_mode`); the chat-summary fallback still prints this line.

**Mandatory — spec-refinement note** (not a separate confirmation): after the split-mode line, you MUST append one short opt-in line (rendered in the user's language, prefixed with 💡) telling the user they may **refine the spec first** — Strategist will produce the full design spec, then stop for review/revision of any part of it before any generation, via the [refine-spec](../workflows/refine-spec.md) workflow. Default is OFF: no request → the spec is written in one go and the pipeline auto-proceeds as usual. Only when the user explicitly asks in chat (e.g. "refine the spec first") or confirms `refine_spec: true` through Confirm UI does the [refine-spec](../workflows/refine-spec.md) workflow take over after the Strategist confirmation stage. This line, like the split-mode line, is required output every run — the user must see the choice exists; whether to act on it is theirs. When the Confirm UI is used, this choice also appears as the in-page refine-spec toggle and is captured in `result.json` (`refine_spec`); the chat-summary fallback still prints this line.

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
