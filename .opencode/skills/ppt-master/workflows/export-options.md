# Export Options & Post-Export Windows (Step 7 detail)

> Loaded **on demand**. `SKILL.md` Step 7 keeps the canonical three-command pipeline and the
> ❌ NEVER guardrails. This file holds the native-pptx fidelity notes, raster/merge/native-object
> flags, the optional animation & narration flags, and the post-export annotation windows.

---

> The native pptx consumes `svg_output/` directly so the converter can preserve
> high-fidelity primitives (icon `<use>` placeholders, image `preserveAspectRatio`
> → native picture crop metadata, rounded rect `rx/ry` → `prstGeom roundRect`).
> Native raster images are optimized by default before writing `ppt/media`
> (`--image-sizing cap`, `--image-max-dimension 2560`, `--image-quality 85`).
> This optimization downscales only oversized full source images; it does not
> crop pixels out of embedded PPTX media, and it does not reduce a small
> placement image merely because it is currently displayed small. Display
> cropping remains editable PPT picture-crop metadata. Add `--no-image-optimize`
> only when the deck must retain original image bytes. Use
> `--image-sizing display --image-scale 2` only for aggressive size reduction.
> The `svg_output/`
> snapshot in `backup/<timestamp>/` is always written so the project can be
> re-exported from frozen SVG sources without re-running the LLM. The SVG-rendered
> preview pptx is opt-in via `--svg-snapshot` — live preview already provides the
> SVG visual reference, so it's only needed when you want a self-contained file
> to share. Pass `-s output` or `-s final` to force a single source if you need it.

> **Paragraph editability vs line fidelity** — by default, mergeable dy-stacked
> paragraph blocks collapse into one editable PowerPoint text frame with multiple
> `<a:p>`, improving body-text editing and resize/reflow behavior. Add `--no-merge`
> only when the user explicitly asks for strict line-layout fidelity or when a
> layout-tight page must keep every dy-stacked line as its own text frame. The
> merge detector is conservative; mixed-layout text falls back to per-line frames.

> **Native table/chart objects** — supported data charts and pure text-grid
> tables carry `data-pptx-native` markers by default (Executor transcribes
> them at draw time; see `references/executor-base.md` §3.2) and the markers
> stay dormant.
> Add `--native-objects` only when the user explicitly wants
> PowerPoint-editable native tables/charts and accepts that those objects may
> render differently across PowerPoint / Keynote / LibreOffice / WPS. Without
> the flag, marked groups export through their SVG fallback children like
> ordinary SVG content.

---

**Optional animation flags** (page transitions are on by default; per-element entrance is off by default — turn it on only when the user asks for it):
- `-t <effect>` — page transition. Default `fade`. Options: `fade` / `push` / `wipe` / `split` / `strips` / `cover` / `random` / `none`.
- `-a <effect>` — per-element entrance animation. **Default `none`** — pages appear as a whole, no auto-firing element builds (the unsolicited cascade reads as the "AI deck" tell). Opt in with `auto` (map effect from group id: chart→wipe, card-/step-/pillar-→fly, title/takeaway→fade; image-like ids `hero` / `figure-` / `image` / `img-` / `kpi` cycle a richer pool — zoom / dissolve / circle / box / diamond / wheel — so multiple images vary across the deck), a specific effect like `fade`, or `mixed` for the legacy 16-effect cycle. Requires top-level `<g id="...">` groups (already required by Executor).
- `--animation-trigger {on-click,with-previous,after-previous}` — Start mode (matches PowerPoint's animation-pane Start dropdown). Default `after-previous` (click-free cascade; pace via `--animation-stagger`). Use `on-click` for presenter-paced reveals, or `with-previous` for all-at-once.
- `--animation-config <path>` — optional object-level sidecar. Default: `<project_path>/animations.json` when present.
- `--auto-advance <seconds>` — kiosk-style auto-play.

**Optional custom animations** (only when the user asks to tune animation order/effects/timing for specific objects):

Run the standalone [`customize-animations`](workflows/customize-animations.md) workflow. Default export applies page transitions but no per-element entrance animation; create `animations.json` (or pass `-a auto`) only when the user asks for element animation or object-level customization.

**Optional recorded narration** (only when the user asks for narrated/video export):

Run the standalone [`generate-audio`](workflows/generate-audio.md) workflow. The AI picks a narration backend (`edge` by default, or a configured cloud provider such as ElevenLabs / MiniMax / Qwen / CosyVoice for high-quality or cloned voices), asks the user once (backend + voice + rate/settings + embed-or-not, all with recommended values), then executes `notes_to_audio.py` and (if chosen) re-exports the PPTX with `--recorded-narration audio`.

Do NOT call `notes_to_audio.py` directly without going through the workflow — `--voice` / `--voice-id` is required and the workflow produces the locale/provider-aware recommendation that makes the choice meaningful.

Full effect list, anchor logic, and limits: [`references/animations.md`](references/animations.md).

---

> **Post-export annotation window**: the preview service from Step 6 typically remains running after export. If the user submitted annotations in the browser (during Executor or after export) and now asks to apply them — they may quote the browser prompt (`Changes saved to svg_output...` / `修改已保存到 svg_output...`), say "apply my annotations" / "应用注解" / equivalent — run [`live-preview`](workflows/live-preview.md) Step 2 to apply and re-export. Annotations submitted during generation are also handled here, not earlier.

> **Direct edits in the browser**: the user may also stage text / SVG attribute edits in the preview. These land in `svg_output/` only after the user clicks **Apply changes**. If they ask to "re-export" / "重新导出" after applying such edits, just re-run Step 7.2–7.3 (finalize + export); no annotation-application step is needed unless they also saved AI-needed annotations.

> **Preview not running?** Any time the user mentions "live preview", "preview", "看效果", or wants to select/click a slide element and the service is not running, run [`live-preview`](workflows/live-preview.md) Step 1 to start it. If the service is already running, just point them at the URL — do not restart.
