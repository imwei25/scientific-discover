# Strategist Confirmation — Three-Stage Mechanics (Step 4 detail)

> Loaded **on demand**. `SKILL.md` Step 4 keeps the ⛔ BLOCKING semantics, the eight
> confirmation items, and the stage table. This file holds the Confirm UI launch/wait
> commands, the per-stage authoring contract, the deployment override, the opt-out, and
> the upstream-override re-derivation rule. **In every shipped deployment the browser
> page is unavailable (flask is deliberately not installed — see `packaging/requirements.txt`),
> so the chat-fallback path is the operative one; the page path is retained for other deployments.**

---

**Confirm UI Auto-Launch (Mandatory — default visual confirmation surface)**: by default the Strategist confirmation stage is presented through an interactive local page in **three stages within one browser session** — Stage 1 confirms the direction anchors; the AI then re-derives the design-system layer from the **user's actual** anchors; Stage 2 confirms that layer; the AI then re-derives image and execution choices from the confirmed direction + design system; Stage 3 confirms the final operational layer. Color swatches, live font previews, icon samples, image-style reference previews, and candidate picks appear where they help judgment; the chat path is the always-valid fallback. [`scripts/docs/confirm_ui.md`](scripts/docs/confirm_ui.md) owns the schema, server lifecycle, port strategy, and fallback details; this section keeps the orchestration contract. The split:

| Stage | Confirms | Driven by |
|---|---|---|
| **1 — direction anchors** | canvas · audience + core message + `content_divergence` + `delivery_purpose` *(PPT only — omitted on non-PPT canvases)* (all §c key info) · `mode` + `visual_style` | the source + user intent |
| **2 — design system** (re-derived from Stage 1) | page count · color · typography (font + size) · icons · formula policy | the confirmed Stage 1 |
| **3 — images / execution** (re-derived from Stage 1 + Stage 2) | image usage · generated-image style · AI-image generation path · generation mode · refine-spec toggle | the confirmed direction + design system |

> **Why three stages.** Design-system fields are anchored by the same few choices (`visual_style` anchors color / icon / typography; `delivery_purpose` sets the body size, page density, **and** the page-count recommendation). Image strategy depends on both the confirmed visual direction and the confirmed color system — its palette is color behavior only, while final HEX values follow Stage 2. Confirming direction first, then design system, then image / execution choices means each downstream stage fits the user's *real* choices instead of the AI's original assumptions. Page count is a **derived** field (content volume × `delivery_purpose`), which is why it lives in Stage 2, not up front.

> 🛑 **本部署（Web 容器）覆盖规则 —— 确认页不可用，直接走聊天确认。**
> 下面第 2/3/4 步描述的浏览器确认页（`confirm_ui/server.py`）在本部署里**用户打不开**：
> 它绑定的是**容器内**的 `127.0.0.1:5050`，而容器只对外发布 3000 端口，用户浏览器里的
> `localhost:5050` 指向的是用户自己的电脑。服务能正常启动，但没有任何人能点到那个"确认"按钮，
> 每次 `--wait` 会空等约 590 秒才超时，三段确认累计最坏 **≈30 分钟纯等待**。
> 因此在本部署里：**不要启动 `confirm_ui/server.py`，不要执行第 2/3/4 步里的那三条命令，
> 也不要向用户播报任何 5050 地址**。改为直接使用下方原文已定义的 **chat-fallback 路径**：
> 在对话里逐段呈现 Stage 1 / Stage 2 / Stage 3 的候选并等待用户回复。
> 三段确认的**内容与顺序完全不变**，变的只是承载方式（网页 → 聊天）。
> ⛔ BLOCKING 的语义同样保留：最终确认仍必须拿到用户明确答复才能进入 Step 5。
> （本部署未安装 flask，该脚本即使被调用也会立刻 ModuleNotFoundError —— 这是兜底，不是依据：
> 依据是上面这条规则，不要靠"反正它会失败"来省事。Step 6 的编辑器同样停用，见该步的覆盖规则。）

Steps:

> ⛔ **Steps 2 → 3 → 4 are ONE uninterrupted run — do NOT yield to the user mid-flow.** When an intermediate `--wait` returns, the AI **immediately and autonomously** re-derives and writes the next stage in the **same turn**: do **not** summarize, ask a question, report progress, or end the turn in between. The browser is sitting on a "deriving…" spinner polling for the next stage you must write — stopping here strands the page and the user must prod you in chat to finish (a bug, not the intended flow). **Stage-1 and Stage-2 confirmations are intermediate machine handoffs, not stopping points.** The single ⛔ BLOCKING wait is the **final** confirmation at the end of step 4. (Chat-fallback path — only when the page never opened — is the exception: there you do present each stage in chat and wait for a reply.)

1. **Write Stage 1** to `<project_path>/confirm_ui/recommendations.json` with `"stage": "stage1"` and only the anchor fields. New recommendations MUST use the canonical `stage` selector. Enumerable anchors (`canvas` / `mode` / `visual_style` / `delivery_purpose`) name a recommended canonical `id` in a `recommend` block (the page lists common options from `confirm_ui/static/catalogs.json`); `visual_style` also carries the ≥3-style `visual_style_spectrum` (safe / shifted / bold — same hard rule as h.5). `audience` and `content_divergence` are plain `{ "value": "<free text>" }`. `content_divergence` is the **free-text** field shown under audience in §c — how closely to follow the source vs how freely to reshape it (blank = balanced; facts stay sourced at every level); it is consumed by Strategist when authoring `§IX`, recorded in `design_spec.md §I`, carries no page-count coupling, and is **not** written to `spec_lock.md`. Set `lang` to the page language (`zh` / `en` / `ja`); visible text matches `lang`, or provide multilingual `name_zh` / `name_en` / `name_ja` + `note_zh` / `note_en` / `note_ja` — when the user's language is Japanese, set `lang: "ja"` and always include the `_ja` variants (labels resolve in the page language first — a `ja` page falls back ja → en → zh, so missing `_ja` labels silently render in English; zh/en pages keep their zh↔en fallback and only try `_ja` last).
2. **Launch + wait for Stage 1.** Background launch; the parent returns when the page writes the stage-1 `result.json`. **Long tool timeout — 600000 ms** (the `--wait` ≈590 s budget):
   ```bash
   python3 ${SKILL_DIR}/scripts/confirm_ui/server.py <project_path> --daemon --wait
   ```
   Page opens at `http://localhost:5050` — the **same port as the Step 6 live preview** (they never run at once: this page shuts down at the end of Step 4). If 5050 is held, the launcher **auto-advances** (5051, …) — read the actual URL from the launch log and report it. The page does **not** close after Stage 1: it shows a "deriving…" state and polls for Stage 2. **Launch or wait failure is non-fatal**: if it fails or times out (flask missing, port blocked, no GUI / remote / web host), do **NOT** troubleshoot — **on any non-zero exit, re-check `result.json` once** for a fresh `status: stage1-confirmed` before dropping to the chat fallback. **On success (exit 0 with a stage-1 result), do not pause or report — go straight to step 3 in the same turn.**
3. **Re-derive Stage 2 from the confirmed anchors, write it, then wait for the design-system handoff — immediately, same turn (the page is polling for it).** Read the stage-1 `result.json` (`status: stage1-confirmed`). Using the user's **actual** confirmed anchors (not your originals), author the design-system candidates and **overwrite** `recommendations.json` with `"stage": "stage2"`: page count (content volume × `delivery_purpose`); color and typography as **generative ≥3-candidate** fields (creative recommendations always offer real choice; fewer than 3 only on the honest-shortfall exception, with a stated reason; color: core `palette` with background/secondary_bg/primary/accent/secondary_accent/body_text; typography: CJK + Latin for `heading` and `body` with `css` preview stacks + `body_size` as the body baseline in **px** (every canvas) — **one fixed value per confirmed `delivery_purpose`** (`text` 20 / `balanced` 24 / `presentation` 32), not a range; each typography candidate must include topic-matched `sample_heading` / `sample_heading_latin` / `sample_body` / `sample_body_latin` preview text, never a fixed unrelated industry sample); enumerable `icons` / `formula_policy` (recommended `id`). The still-open page polls, renders Stage 2, and preserves the user's Stage 1 picks. Then attach to the already-running page, do **not** relaunch:
   ```bash
   python3 ${SKILL_DIR}/scripts/confirm_ui/server.py <project_path> --wait-only --wait-stage stage2
   ```
   This returns when the page writes the stage-2 `result.json` (`status: stage2-confirmed`). On a non-zero exit, re-check `result.json` once before falling back to chat.
4. **Re-derive Stage 3 from the confirmed anchors + design system, then wait for the final confirmation.** Read the stage-2 `result.json`. Author the image and execution recommendations and **overwrite** `recommendations.json` with `"stage": "stage3"`: `image_usage` as one or more source ids (`["ai"]`, `["ai","provided"]`, `["web","placeholder"]`, or `["none"]`; `none` is exclusive); `image_strategy.candidates` as **exactly three non-custom** rendering × palette recommendations from h.5 when `image_usage` includes `ai` (the page adds the fourth Custom card itself); enumerable `image_ai_path` / `generation_mode` and `refine_spec` (recommended `id` / boolean). If the recommendation involves several image sources, keep the source list structured in `recommend.image_usage` and write the usage rationale / page-role guidance into `image_notes` (for example, "封面和章节页用 AI 主视觉，产品页优先用户素材，行业背景页可用网络参考"). Write `image_ai_path` only when `image_usage` includes `ai`. Spot-illustration lean is **not** a candidate field here: it derives from the locked `visual_style`'s illustration propensity and is expressed only in the recommendation rationale / `image_notes`, never as a new confirmation field. Generated-image style palettes are **color behavior only**; final image colors follow the confirmed Stage-2 `color`. Custom image-strategy dimensions are handled by the built-in Custom card, are prose-only, and should not promise a gallery reference image. Then attach to the already-running page, do **not** relaunch (same 600000 ms budget):
   ```bash
   python3 ${SKILL_DIR}/scripts/confirm_ui/server.py <project_path> --wait-only
   ```
   This is the ⛔ BLOCKING completion: returns when the page writes the final `result.json` (`status: confirmed`, `stage: final`, carrying Stage 1 + Stage 2 + Stage 3 fields). On a non-zero exit, re-check `result.json` once. Confirmed sizes are **already px** (the system is px-only — no pt anywhere, no conversion): write `result.json` `typography.body_size` / `sizes` into `design_spec.md` / `spec_lock.md` / SVG verbatim. `generation_mode: "split"` / `refine_spec: true` are explicit user choices.
5. **Close the confirm page (Mandatory cleanup — every path).** Shut the server down before leaving Step 4 so it cannot keep holding port 5050 (which Step 6 live preview reuses):
   ```bash
   python3 ${SKILL_DIR}/scripts/confirm_ui/server.py <project_path> --shutdown
   ```
   **Idempotent and required regardless of whether Confirm was clicked**: clicking the final Confirm already shuts the page down (then a no-op); the chat-fallback path leaves it running. Run it after reading the confirmation, before Step 5.

**Always also print each stage's recommendations + URL in chat** as the always-valid fallback. **The chat fallback is staged too**: if the page never opens or a wait times out with no fresh result, present Stage 1 in chat → get confirmation → re-derive → present Stage 2 → get confirmation → re-derive → present Stage 3 → get confirmation → take those values. Either path converges.

---

**Upstream override → re-derive untouched downstream (Mandatory — chat-fallback / single-pass path).** On the **three-stage page path this is already handled** (Step 3 re-derives Stage 2 from the user's actual anchors; Step 4 re-derives Stage 3 from the confirmed anchors + design system). It still applies whenever anchors and downstream fields are confirmed **together** — the staged chat fallback collapsed into one bundle, or a legacy single-pass `result.json`. "Confirmed value wins" governs each field's *own* value — never recompute a value the user set (a size, canvas, or palette they edited stays verbatim). But a single-pass `result.json` can carry a changed **anchor** beside downstream fields still holding your original — now incoherent — recommendation (e.g. switched to `dark-tech` while the light palette you proposed is untouched). Before writing the spec, reconcile: when the user changed an anchor, re-derive the downstream fields the user did **not** themselves edit so they realize the new anchor; fields the user pinned stay as confirmed.

| Anchor the user changed | Re-derive (only the downstream fields the user left at your recommendation) |
|---|---|
| `visual_style` (§d Layer 2 — anchors e–h) | color neutral tiers (§e), icon library / stroke (§f), typography character (§g), image rendering (§h.5) |
| `mode` (§d Layer 1) | outline structure + register (§IX) |
| `delivery_purpose` (§g) | body baseline + per-page density / rhythm (§6.1) |
| `audience` / core message (§c) | tone across e–h, outline emphasis (§IX) |
| `color` HEX (§e) | h.5 palette (re-filter for the new HEX) |

Reconcile **without a new blocking wait** — fold the coherent values into `design_spec.md` / `spec_lock.md` and state the adjustment in the §8 next-step handoff (e.g. "you switched to `dark-tech`; the light palette you had left no longer fit, so background / accent were re-derived — tell me if you wanted the original"). Canvas is the explicit exception: font sizes are deliberately **not** rescaled on a canvas change (see strategist §g).

**Opt-out**: if the user has said they don't want the page (e.g. "不要网页" / "just confirm in chat" / "纯聊天确认"), skip the launch entirely (step 2) and present the Strategist confirmation stage in chat as before — steps 1, 3, 4 still apply (recommendations summary in chat; wait; take chat values).

The page is a **confirmation surface only** — Strategist still authors every recommendation; the page never generates content.
