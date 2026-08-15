# Template Dispatch & Fusion (Step 3 detail)

> Loaded **on demand** — only when the user supplied one or more explicit template
> directory paths and Step 3 actually triggered. The default free-design path never
> reads this file. Trigger rule, hard boundaries, and the checkpoint stay in `SKILL.md` Step 3.

## Three template kinds

The architecture has three independent reference bundles. Full schema in [`docs/zh/templates-architecture.md`](../../../docs/zh/templates-architecture.md). Summary:

| Kind | Physical dir | Contains | Frontmatter |
|---|---|---|---|
| **brand** | `templates/brands/<id>/` | identity-only segment: color / typography / logo / voice / icon style | `kind: brand` |
| **layout** | `templates/layouts/<id>/` | structure-only segment: canvas / page structure / page types / SVG roster | `kind: layout` |
| **deck** | `templates/decks/<id>/` | full replica: identity + structure + middle (template overview) segments | `kind: deck` |

**Segment ownership** (governs fusion override priority):

| Segment | Sections | Owner kind on fusion |
|---|---|---|
| Identity | Color Scheme / Typography / Logo / Voice & Tone / Icon Style | brand |
| Structure | Canvas / Page Structure / Page Types / SVG Roster | layout |
| Middle | Template Overview (use cases / design intent) | deck (no other kind writes this) |

## Single-path dispatch

| User path's `kind` | Step 3 action |
|---|---|
| `kind: brand` | `design_spec.md` + non-image assets → `<project>/templates/`; logo / illustration / icon **bitmaps** → `<project>/images/`. Strategist locks identity segment as truth; structure stays free. |
| `kind: layout` | `design_spec.md` + SVG roster → `<project>/templates/`; any **bitmap** assets → `<project>/images/`. Strategist locks structure; identity decided in Strategist confirmation stage e–g. |
| `kind: deck` | `design_spec.md` + template SVGs → `<project>/templates/`; logos / backgrounds / other **bitmaps** → `<project>/images/`. Strategist locks all segments; Strategist confirmation stage narrows to deck-content fields (audience / page count / outline / tone tweaks). |

```bash
TEMPLATE_DIR=<user-supplied path>
# Bitmaps join the project's single runtime image pool (images/, referenced as
# ../images/); the spec + template SVGs + other non-image assets stay in
# templates/ as design reference the Strategist/Executor read but never render.
cp -r ${TEMPLATE_DIR}/* <project_path>/templates/
find <project_path>/templates -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.bmp' \) -exec mv {} <project_path>/images/ \;
```

The same split applies to all three kinds — bitmaps always land in `images/`, the rest in `templates/`. The spec's `kind` field tells Strategist how to read the `templates/` side; downstream code doesn't distinguish. (Template SVGs in `templates/` are reference material only — the rendered pages live in `svg_output/` and reference images via `../images/`.)

## Multi-path fusion

When the user gives two or more paths of **different kinds**, Step 3 fuses them into a single `<project>/templates/design_spec.md`. **Default granularity is segment-level integer replacement** — entire identity / structure / middle segments are taken from the highest-priority source for that segment, no implicit field-level mixing.

Override priority by segment:

| Combination | Identity from | Structure from | Middle from |
|---|---|---|---|
| brand only | brand | (free design) | (none) |
| layout only | (free design) | layout | (none) |
| deck only | deck | deck | deck |
| brand + layout | brand | layout | (none) |
| brand + deck | brand (overrides deck) | deck | deck |
| layout + deck | deck | layout (overrides deck) | deck |
| brand + layout + deck | brand | layout | deck |

Field-level micro-adjustment (e.g. "use anthropic brand but primary changed to #FF0000") is **not** part of Step 3 fusion — it flows into Strategist confirmation stage e–g as a normal user request.

## Same-kind multiple paths — conflict resolution

When the user gives two paths of the **same kind** (e.g. `brands/anthropic` + `brands/google`), Step 3 surfaces a conflict prompt before fusing — like resolving a git merge conflict:

```
AI: 你给了两个 brand，检测到段级冲突：
    - Color Scheme（Anthropic 橙红 vs Google 多色）
    - Typography（Styrene/AnthropicSans vs GoogleSans/Roboto）
    - Logo（Anthropic 标 vs Google 标）
    - Voice & Tone（restrained vs friendly）
    - Icon Style（stroke vs filled）

    要 (a) 全部按 Anthropic / (b) 全部按 Google / (c) 逐段挑？
```

Rules:
- Default: no implicit ordering — every cross-source segment difference is reported as a conflict
- Only when the user picks `(c)` does AI walk through each segment one by one
- Field-level conflicts are out of scope — segment-level only
- Three or more same-kind paths are not supported — ask the user to converge to at most two

## Fused spec provenance

When fusion happens (any multi-path case), the resulting `<project>/templates/design_spec.md` carries a provenance block immediately under its H1:

```markdown
> **Fused from:**
> - deck: `templates/decks/招商银行/` （base）
> - brand: `templates/brands/anthropic/` （identity override）
> - layout: `templates/layouts/academic_defense/` （structure override）
> - conflicts resolved: Color Scheme from anthropic（user picked a）
```

Single-path Step 3 does **not** add provenance (the source is self-evident from the copied files).
