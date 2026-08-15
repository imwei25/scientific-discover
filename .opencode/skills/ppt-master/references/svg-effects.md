# SVG Effects Cookbook — Shadow / Overlay / Stroke / Gradient / Pattern / Rotation / Arcs

> 从 `shared-standards.md` 搬出 §6 与 §7，**按需查**：这些是「要画阴影 / 虚线 / 渐变 / 图案填充 /
> 旋转 / 圆环弧 / 对角箭头时怎么写」的配方，不是前置规则。
> **禁用清单（§1）、PPT 兼容替代（§2）、基础 SVG 规则（§4）、后处理管线（§5）仍在
> `shared-standards.md` 里，那些必须前置通读。**
> 原生 PPTX 表格 / 图表标记（`data-pptx-native`）也在本文件，由 `executor-base.md §3.2` 指来。

---

## 6. Shadow & Overlay Techniques

> `<mask>` elements and `<image opacity="...">` are banned. Always use stacked `<rect>` or gradient overlays instead (see §2).

### Shadow

> **Shadow is restraint, not default.** The "designed" feel comes from absence, not abundance.

#### When to use

Only when the element genuinely floats above another layer:
- Card / quote bubble / annotation on a photo or colored panel
- Single primary CTA or "recommended" item picked out from peers
- Overlay layer (callout, tooltip, modal emphasis)
- Floating image card on a textured background

#### When NOT to use

- Background panels / dividers / decorative bars — they are the floor
- Equal peer cards in a 2/3/4-up grid — keep all flat
- Containers with visible border, gradient fill, or strong tint — redundant
- Body-text paragraph containers — disrupts scan rhythm
- Decorative lines / dividers / icons — they are symbols, not objects
- Pages with only one content container — no second layer to lift above
- Dark backgrounds — black shadows vanish; use 1px low-opacity white stroke or outer glow

**Reference — not a constraint**: 2-3 shadowed elements per page usually reads cleanest; before adding a 4th, check the extra layering earns its weight — a genuinely complex dashboard may justify more.

#### Single light source per page

All `feOffset` on a page must share the same `dx`/`dy` direction. Default: `dx="0"`, `dy="4"`-`dy="8"` (light from upper front).

#### Restraint over visibility

Standard: "the shadow is felt, not seen." If noticed, it's too strong.
- Resting cards: `flood-opacity` 0.06-0.10
- Raised elements (CTA, overlay): max `flood-opacity` 0.20
- Above 0.20 = Office 2007 hard-shadow look
- Color: near-black at low opacity, or a darker tint of background. Brand-color shadow only on accent elements sharing that hue.

#### Two-tier elevation maximum

A page may have at most two non-floor tiers.

| Tier | When | dy | stdDeviation | flood-opacity |
|------|------|----|--------------|---------------|
| Floor (no shadow) | Backgrounds, peer-grid cards, dividers, body-text containers | — | — | — |
| Resting | Cards on photos/panels, secondary callouts | 2-4 | 4-8 | 0.06-0.10 |
| Raised | Primary CTA, focused/recommended card, overlay | 6-10 | 10-16 | 0.12-0.20 |

#### Don't stack visual-weight tools

Pick **one** per container: shadow, border, gradient fill, or strong tint. Stacking = instant template look.

---

#### Filter Soft Shadow — Recommended

Best for: cards, floating panels, elevated elements. The `svg_to_pptx` converter automatically converts `feGaussianBlur` + `feOffset` into native PPTX `<a:outerShdw>`.

```xml
<defs>
  <filter id="softShadow" x="-15%" y="-15%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="12"/>
    <feOffset dx="0" dy="6" result="offsetBlur"/>
    <feFlood flood-color="#000000" flood-opacity="0.10" result="shadowColor"/>
    <feComposite in="shadowColor" in2="offsetBlur" operator="in" result="shadow"/>
    <feMerge>
      <feMergeNode in="shadow"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>
<rect x="60" y="60" width="400" height="240" rx="12" fill="#FFFFFF" filter="url(#softShadow)"/>
```

Recommended parameters (see "Two-tier elevation maximum" above for tier guidance):
```
stdDeviation:   4–16       (resting cards: 4–8;  raised elements: 10–16)
flood-opacity:  0.06–0.10  (resting cards — default)
                0.12–0.20  (raised elements only — primary CTA, overlay)
                NEVER     > 0.20  (Office 2007 hard-shadow look)
dy:             2–10       (resting: 2–4;  raised: 6–10)
dx:             0–2        (must match every other shadow on the page — single light source)
```

#### Colored Shadow

Best for: accent buttons, brand-colored cards. Use the element's own color family instead of black.

```xml
<filter id="colorShadow" x="-15%" y="-15%" width="140%" height="140%">
  <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
  <feOffset dx="0" dy="6" result="offsetBlur"/>
  <feFlood flood-color="#1A73E8" flood-opacity="0.20" result="shadowColor"/>
  <feComposite in="shadowColor" in2="offsetBlur" operator="in" result="shadow"/>
  <feMerge>
    <feMergeNode in="shadow"/>
    <feMergeNode in="SourceGraphic"/>
  </feMerge>
</filter>
```

Replace `flood-color` with the element's brand color. Keep `flood-opacity` 0.12-0.20. Reserve for the single primary CTA per page — using on every button defeats the cue.

#### Glow Effect

Best for: title highlights, key metrics, hero text. The converter automatically converts `feGaussianBlur` without `feOffset` into native PPTX `<a:glow>`.

```xml
<defs>
  <filter id="titleGlow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blur"/>
    <feFlood flood-color="#1A73E8" flood-opacity="0.45" result="glowColor"/>
    <feComposite in="glowColor" in2="blur" operator="in" result="glow"/>
    <feMerge>
      <feMergeNode in="glow"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>
<text x="640" y="360" text-anchor="middle" font-size="48" fill="#1A73E8" filter="url(#titleGlow)">Key Insight</text>
```

Recommended parameters:
```
stdDeviation:   4–8      (smaller = subtle, larger = prominent)
flood-color:    brand color or accent color (NOT black)
flood-opacity:  0.35–0.55  (stronger than shadow for visibility)
```

**vs shadow**: no `<feOffset>` (or dx=0/dy=0). The converter uses this to distinguish glow from shadow.

#### Layered Rect Shadow — High-Compatibility Fallback

Best for: maximum compatibility with older PowerPoint versions. Stack 2–3 semi-transparent rectangles behind the main card:

```xml
<!-- Shadow layers (back to front, largest offset first) -->
<rect x="68" y="72" width="400" height="240" rx="16" fill="#000000" fill-opacity="0.03"/>
<rect x="65" y="69" width="400" height="240" rx="14" fill="#000000" fill-opacity="0.05"/>
<rect x="62" y="66" width="400" height="240" rx="12" fill="#1A73E8" fill-opacity="0.04"/>
<!-- Main card -->
<rect x="60" y="60" width="400" height="240" rx="12" fill="#FFFFFF"/>
```

### Image Overlay

#### Linear Gradient Overlay — Most Common

Best for: image+text pages. Gradient direction should match text position (text on left → gradient darkens toward left).

```xml
<image href="..." x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice"/>
<defs>
  <linearGradient id="imgOverlay" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%"   stop-color="#1A1A2E" stop-opacity="0.85"/>
    <stop offset="55%"  stop-color="#1A1A2E" stop-opacity="0.30"/>
    <stop offset="100%" stop-color="#1A1A2E" stop-opacity="0"/>
  </linearGradient>
</defs>
<rect x="0" y="0" width="1280" height="720" fill="url(#imgOverlay)"/>
```

#### Bottom Gradient Bar

Best for: cover slides and full-image pages with bottom title.

```xml
<defs>
  <linearGradient id="bottomBar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.72"/>
  </linearGradient>
</defs>
<rect x="0" y="380" width="1280" height="340" fill="url(#bottomBar)"/>
```

#### Radial Gradient Overlay — Vignette Effect

Best for: full-screen atmosphere slides; draws attention to the center.

```xml
<defs>
  <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
    <stop offset="0%"   stop-color="#000000" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0.58"/>
  </radialGradient>
</defs>
<rect x="0" y="0" width="1280" height="720" fill="url(#vignette)"/>
```

#### Brand Color Overlay

Best for: slides needing strong visual brand identity.

```xml
<defs>
  <linearGradient id="brandOverlay" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%"   stop-color="#005587" stop-opacity="0.80"/>
    <stop offset="100%" stop-color="#005587" stop-opacity="0.10"/>
  </linearGradient>
</defs>
<rect x="0" y="0" width="1280" height="720" fill="url(#brandOverlay)"/>
```

### Quick-Reference Table

| Scenario | Recommended Technique | Avoid |
|----------|-----------------------|-------|
| Card / panel shadow (only when floating over photo/colored panel) | Filter soft shadow (`flood-opacity` 0.06–0.10, single light source) | Hard black shadow, full-page abundance |
| Equal peer cards in a grid | All flat (no shadow) | Lifting every card uniformly |
| Page-section background panel | Flat fill, no shadow | Treating panels as floating cards |
| Accent / CTA button (one per page) | Colored shadow (same hue family, `flood-opacity` 0.12–0.20) | Generic gray shadow, applying to every button |
| Title / metric highlight | Glow filter (brand color, no offset) | Overuse on body text |
| Text over image | Linear gradient overlay (direction matches text side) | Uniform flat opacity over whole image |
| Cover / full-image slide | Bottom gradient bar + brand color | Solid black overlay |
| Atmosphere / hero slide | Radial vignette | Unprocessed raw image |
| Max PPT compatibility needed | Layered rect shadow | Filter-based shadow |

---

## 7. Stroke, Text & Shape Effects

### stroke-dasharray — Dashed / Dotted Lines

Converts to native PPTX `<a:prstDash>`. Use preset patterns for best results:

| SVG Value | PPTX Preset | Best For |
|-----------|-------------|----------|
| `4,4` | Dash | General dashed lines, separators |
| `2,2` | Dot (sysDot) | Subtle dotted borders, placeholder outlines |
| `8,4` | Long dash | Timeline connectors, flow arrows |
| `8,4,2,4` | Long dash-dot | Technical drawings, dimension lines |

```xml
<rect x="60" y="60" width="400" height="240" rx="12"
  fill="none" stroke="#999999" stroke-width="2" stroke-dasharray="4,4"/>

<line x1="100" y1="360" x2="1180" y2="360"
  stroke="#CCCCCC" stroke-width="1" stroke-dasharray="2,2"/>
```

### stroke-linejoin

Controls how line segments join at corners. Supported values convert to native PPTX line join types:

| SVG Value | PPTX Equivalent | Best For |
|-----------|-----------------|----------|
| `round` | Round join | Smooth polyline charts, organic shapes |
| `bevel` | Bevel join | Technical diagrams |
| `miter` | Miter join (default) | Sharp-cornered rectangles, arrows |

```xml
<polyline points="100,200 200,100 300,200" fill="none"
  stroke="#1A73E8" stroke-width="3" stroke-linejoin="round"/>
```

### text-decoration

Supported text decorations convert to native PPTX text formatting:

| SVG Value | PPTX Equivalent | Best For |
|-----------|-----------------|----------|
| `underline` | Single underline | Emphasis, links, key terms |
| `line-through` | Strikethrough | Removed items, before/after comparisons |

```xml
<text x="100" y="200" font-size="20" fill="#333333" text-decoration="underline">Important Term</text>

<!-- Per-tspan decoration -->
<text x="100" y="240" font-size="18" fill="#333333">
  Regular text <tspan text-decoration="line-through" fill="#999999">old value</tspan> new value
</text>
```

### Gradient Fill — linearGradient & radialGradient

Gradients defined in `<defs>` and referenced via `fill="url(#id)"` convert to native PPTX `<a:gradFill>`. Use them as shape fills (not just overlays) for polished surfaces.

**Linear gradient** — best for buttons, header bars, background panels:

```xml
<defs>
  <linearGradient id="btnGrad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#1A73E8"/>
    <stop offset="100%" stop-color="#0D47A1"/>
  </linearGradient>
</defs>
<rect x="540" y="600" width="200" height="48" rx="24" fill="url(#btnGrad)"/>
```

**Radial gradient** — best for spotlight backgrounds, circular accents:

```xml
<defs>
  <radialGradient id="spotBg" cx="50%" cy="50%" r="70%">
    <stop offset="0%" stop-color="#1A73E8" stop-opacity="0.15"/>
    <stop offset="100%" stop-color="#1A73E8" stop-opacity="0"/>
  </radialGradient>
</defs>
<circle cx="640" cy="360" r="300" fill="url(#spotBg)"/>
```

### Pattern Fill — `<pattern>` with PPTX preset annotation

`<pattern>` fills convert to native PPTX `<a:pattFill prst="...">` — but only PPTX's built-in preset patterns are reachable. The converter does **not** render hand-drawn `<path>` geometry inside the pattern; instead it reads two annotations off the `<pattern>` element and emits the matching DrawingML preset.

**Prefer explicit geometry when spacing matters.** A `<pattern>` renders at PowerPoint's **fixed preset density** — you cannot reproduce a specific tile size (e.g. a 40px grid). For grids / textures whose spacing or line weight is part of the design, draw the lines as **one `<path>` with all lines as subpaths** (`M40 0V720 M80 0V720 … M0 40H1280 …`, `fill="none" stroke=…`) — the converter supports `M/L/H/V` and multi-subpath, so it becomes **one editable vector shape that reproduces the exact spacing** across all four renderers. Reserve `<pattern>` + `data-pptx-pattern` for **round-tripping an existing PPTX** (decks imported via `pptx_to_svg`), where the source genuinely used a native preset fill. For pure display where no PPT-side editing is needed, `--svg-snapshot` is the other faithful option.

**Required annotations** (only when you intentionally use a `<pattern>` preset):

| Attribute | Purpose | Without it |
|---|---|---|
| `data-pptx-pattern="<preset>"` | Names the PPTX preset (one of the enum below) | Falls back to `ltUpDiag` — diagonal stripes, not your geometry |
| Child `<rect fill="<bg-hex>"/>` | Background color of the pattern tile | `bg` falls back to `#FFFFFF`, painting over the page background |

The child `<path>`'s `stroke` becomes the foreground color (the pattern's line color).

```xml
<defs>
  <pattern id="bpGrid" x="0" y="0" width="40" height="40"
           patternUnits="userSpaceOnUse" data-pptx-pattern="lgGrid">
    <rect width="40" height="40" fill="#0E2A47"/>
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#2D4A6B" stroke-width="0.6"/>
  </pattern>
</defs>
<rect width="1280" height="720" fill="url(#bpGrid)"/>
```

**Valid `data-pptx-pattern` values** (OOXML `ST_PresetPatternVal` — closed enum, anything outside makes PowerPoint open with "needs to be repaired"):

| Category | Values |
|---|---|
| Grids | `smGrid` · `lgGrid` · `dotGrid` *(no `ltGrid` — common typo)* |
| Diagonal lines | `ltUpDiag` · `ltDnDiag` · `dkUpDiag` · `dkDnDiag` · `wdUpDiag` · `wdDnDiag` · `dashUpDiag` · `dashDnDiag` · `diagCross` |
| Horizontal / vertical lines | `horz` · `vert` · `ltHorz` · `ltVert` · `dkHorz` · `dkVert` · `narHorz` · `narVert` · `dashHorz` · `dashVert` · `cross` |
| Percent fills | `pct5` · `pct10` · `pct20` · `pct25` · `pct30` · `pct40` · `pct50` · `pct60` · `pct70` · `pct75` · `pct80` · `pct90` |
| Checks & confetti | `smCheck` · `lgCheck` · `smConfetti` · `lgConfetti` |
| Decorative | `horzBrick` · `diagBrick` · `weave` · `plaid` · `trellis` · `zigZag` · `wave` · `sphere` · `divot` · `shingle` · `solidDmnd` · `openDmnd` · `dotDmnd` |

> `svg_quality_checker.py` warns on missing `data-pptx-pattern` and errors on values outside the enum. Catch these pre-export — PowerPoint's repair dialog hides which pattern broke.

### Native PPTX Table / Chart Markers (Experimental)

Native PowerPoint tables and Excel-backed charts activate at export time only. The default chart/table route remains hand-authored SVG geometry so the deck stays pixel-stable across PowerPoint / Keynote / LibreOffice / WPS.

**Authoring — markers are standard on supported data charts and text-grid tables**: Executor writes the marker at draw time on every data chart whose type falls in the supported set and on every pure text-grid data table ([executor-base.md §3.2](executor-base.md)), so any deck can later form native objects without regeneration. Tables with merged or graphical cells stay unmarked on the SVG fallback route. The marker group supplies both: visible SVG fallback children for browser/live-preview rendering, and JSON metadata for `svg_to_pptx` native export.

**Hard rule — activation is the opt-in, dormant unless exported with `--native-objects`**: A marker only declares that a group is eligible for native export. Normal `svg_to_pptx.py` runs keep the fallback SVG children. Pass `--native-objects` only when editability in PowerPoint matters more than cross-renderer layout fidelity: it emits the PowerPoint object and skips the fallback children to avoid duplicates. Native styling preserves the core palette, text, axis, grid, and background colors where possible, but it is still a PowerPoint chart/table object rather than a pixel-identical SVG drawing.

| Marker | Native output | Required metadata |
|---|---|---|
| `<g data-pptx-native="table">` | `<p:graphicFrame>` with `<a:tbl>` | bounds + `columns` or `rows` |
| `<g data-pptx-native="chart">` | `<p:graphicFrame>` with `c:chart` / `cx:chart` + chart part + embedded workbook | bounds + `type`, plus chart data |

**Metadata placement**: Put JSON in a child `<metadata data-pptx-native="...">`. Attribute JSON (`data-pptx-json="..."`) is supported but harder to XML-escape correctly.

**Bounds**: Provide `x`, `y`, `width`, and `height` in metadata, or as
`data-pptx-x` / `data-pptx-y` / `data-pptx-width` / `data-pptx-height` on the
marker group. If any bound is omitted, the exporter infers the object frame
from the visible fallback geometry; this keeps SVG fallback and native object
placement aligned.

**Validation**: `svg_quality_checker.py` validates native marker kind, JSON
metadata, bounds/fallback availability, table rows/columns, supported chart
type, and chart data shape before export.

```xml
<g id="p03-revenue-chart" data-pptx-native="chart">
  <metadata data-pptx-native="chart">
    {
      "x": 120, "y": 150, "width": 520, "height": 320,
      "type": "column",
      "title": "Revenue by Segment",
      "categories": ["Q1", "Q2", "Q3"],
      "series": [
        {"name": "Cloud", "values": [12, 15, 19]},
        {"name": "Services", "values": [8, 9, 11]}
      ]
    }
  </metadata>
  <!-- Visible SVG fallback for live preview / non-native export goes here. -->
</g>
```

**Table schema**: Native tables are rectangular DrawingML grids. Use `columns`
for the optional header row and `rows` for body rows; shorter rows are padded
with blank cells unless `strict_grid: true` is set. Use `column_widths` and
`row_heights` as relative weights. Cell objects accept `text`, `fill`, `color`,
`align`, `valign`, `bold`, `font_size`, `padding`, `border_color`, and
`border_width`; the same `padding`, `border_color`, and `border_width` keys may
also live under `style` as table defaults. Native table typography mirrors the
visible SVG fallback: put `style.font_family` and `style.font_size` on the
marker from the table text already drawn, then use `style.header_font_size` or
per-cell `font_size` only when the fallback visibly differs. If the fallback
has no explicit table font, use the deck body family and locked body size from
`spec_lock.md`.

**Hard rule — table metadata is the native source of truth**: Every row,
summary line, value, and cell-level style that must survive
`--native-objects` must be present in `columns` / `rows`. SVG fallback text is
discarded during native export. `svg_quality_checker.py` warns when visible
fallback `<text>` inside a native table marker does not appear in metadata.
For numeric or currency columns, use cell objects with `align: "r"`; SVG
`text-anchor="end"` does not carry into the native table.

**Forbidden — native merged table cells**: Do not use `rowSpan`, `colSpan`,
`gridSpan`, `hMerge`, `vMerge`, or top-level merge lists in native table
metadata. `svg_to_pptx.py --native-objects` rejects them so merged-cell tables
do not silently degrade into incorrect grids. Keep merged-cell tables on the
default SVG fallback route, or merge cells manually in PowerPoint after native
export.

**Category chart schema**: `column`, `bar`, `line`, `area`, `pie`,
`doughnut`, `pieOfPie`, `barOfPie`, and `radar` use `categories` plus
`series[].values`. Pie-family charts (`pie`, `doughnut`, `pieOfPie`, and
`barOfPie`) must have exactly one series; the exporter assigns per-category
slice colors so single-series charts do not collapse into one solid color.
Column and bar charts may set per-point colors with `series[].point_colors`
or `series[].pointColors`; the list must match `series[].values` length.
Classic category charts may set native PowerPoint data labels with
`data_labels`. Use `data_labels: true` for default value labels, or an object
with `show_value`, `position`, `number_format`, `font_size`, `font_family`,
`bold`, `color`, and optional per-point `colors`. Supported label positions
depend on chart type: clustered column/bar labels may use `outside_end`,
`inside_end`, `inside_base`, or `center`; stacked / percent-stacked column/bar
labels may use `inside_end`, `inside_base`, or `center`; line labels may use
`above`, `center`, or `best_fit`; area labels do not emit a native label
position. To label only selected data points, use `data_labels.points` with
zero-based `idx` plus optional per-point `position`, `number_format`,
`font_size`, `font_family`, `bold`, and `color`.

**Combo chart schema**: `combo` uses shared `categories` plus either `plots[]`
or typed `series[]`. Each plot supports `type: "column" | "line" | "area"`,
its own `series`, and optional `axis: "secondary"` for a right-side value axis.
Typed `series[]` accepts the same `type` and `axis` fields per series, and
adjacent compatible series are grouped into the same PowerPoint plot. Area
series may set `fill_opacity` / `fillOpacity` as a `0..1` SVG opacity value
when the SVG fallback uses a transparent area fill under an opaque line. A line plot with `area_fill: true`
is exported as a PowerPoint area chart under the hood; `fill_opacity` only sets
the fill style and does not trigger conversion by itself. Combo export layers
area plots below columns and lines while preserving the original series indices.
Line and area series may set `line_width` / `lineWidth` in SVG px units to
match fallback `stroke-width`.

**XY chart schema**: `scatter` and `bubble` use `series[].x` + `series[].y`; `bubble` also requires one `series[].size` / `series[].sizes` value per point. `series[].points` is also accepted as `[x, y]` / `[x, y, size]` tuples or `{x, y, size}` objects.

**Chart typography**: Native classic chart typography mirrors the visible SVG
fallback. Copy fallback chart text sizes into metadata using the same px-style
unit as SVG text (`1px = 0.75pt`). Put the shared visible chart font in
`style.font_family`, and override local chart text objects or `data_labels`
with `font_family` only when the fallback visibly differs. If omitted, the
exporter infers the shared font family and base chart text size from visible
fallback text inside the native marker, but explicit metadata remains the
stable contract when roles differ. Typical mappings are chart title
(`title_font_size`), chart subtitle (`subtitle_font_size`), chart labels
(`axis_font_size`, shared by axis titles / ticks / legend unless the fallback
differs), and notes (`note_font_size`). Use `axis_title_font_size`,
`legend_font_size`, or per-entry companion `font_size` only when the fallback
visibly uses a separate size. When no explicit fallback size exists for a role,
default to compact PowerPoint text: `title_font_size: 16` (12pt),
`subtitle_font_size: 12` (9pt), `axis_font_size: 12` (9pt), and
`note_font_size: 12` (9pt).

**Chart chrome metadata**: Text that is visually part of the chart must be in
metadata, not only in SVG fallback children; metadata MUST still match visible
fallback chrome. `title` becomes the native chart title on classic charts; it
is not an object name, so use `name` for semantic object naming. `subtitle`
becomes the second rich-text line of that classic chart title. `title`,
`subtitle`, and axis-title values may be strings or objects with `text`,
`font_size`, `font_family`, and `color` when the fallback uses local role
typography. `svg_quality_checker.py` rejects `title`, `subtitle`, or axis-title
metadata whose text is not visible inside the native marker's fallback. Direct
`--native-objects` export keeps the chart native but omits that inconsistent
chrome with a warning. chartEx keeps PowerPoint's empty `<cx:title>` and emits
the title / subtitle as companion editable text boxes until chartEx rich titles
are validated. Axis
titles are optional and explicit: use `axis_titles` with
`category`, `value`, `x`, `y`, or `secondary_value` keys, or the root aliases
`category_axis_title`, `value_axis_title`, `x_axis_title`, `y_axis_title`, and
`secondary_value_axis_title`; do not add semantic axis titles that are not
visible in the fallback. Set `show_value_axis_labels: false` when the fallback
keeps category labels but omits numeric value-axis tick labels, such as a radar
chart without radial coordinates. Native legends are metadata-controlled: use
`show_legend: true` and `legend_position` only when the fallback's legend is
meant to be replaced by PowerPoint's native legend.
Companion text such as `caption`, `source`, `note`, `notes`, `footnote`, and
`footnotes` is exported as editable PPT text boxes next to the native chart. A
companion entry may be a string or an object with `text`, `x`, `y`, `width`,
`height`, `font_size`, `color`, `align`, and `bold`; explicit bounds are
recommended so the native export matches the SVG fallback placement. Explicit
companion bounds are slide coordinates, not local coordinates inside a
transformed marker group. Use companion text for chart captions, source notes,
center labels, and freeform annotations; use `data_labels` for values that
belong to chart points.

**Chart color styling**: For classic native charts, `style.colors` sets series
colors. The exporter also writes explicit chart-area fill, plot-area fill,
axis line, gridline, and label text colors so PowerPoint does not substitute a
white/default-theme chart. If omitted, the exporter infers these colors from
the visible SVG fallback: the largest panel-like `<rect>` becomes the chart
background, fallback text supplies label color, and fallback strokes supply
axis/grid colors. Override any of them explicitly under `style` with
`chart_area_fill`, `plot_area_fill`, `text_color`, `axis_color`, and
`grid_color`; use `"none"` for transparent chart or plot area fill. Color
values may be `#RRGGBB`, `#RGB`, `rgb(...)` / `rgba(...)`, or common CSS names
such as `white`, `black`, and `gray`; the exporter normalizes them to 6-digit
OOXML RGB. Bar and column series also disable PowerPoint's negative-value
inversion so negative bars keep the same series fill instead of turning into
white/theme fill.

**PowerPoint chartEx schema**: `treemap`, `sunburst`, `histogram`, `pareto`,
`boxWhisker`, `waterfall`, and `funnel` use Office 2016+ chartEx parts. Use
these input shapes:

| Type | Required data |
|---|---|
| `treemap`, `sunburst` | `values` plus either `levels` (`levels[level][point]`) or path-style `categories` (`[["Region", "Group", "Leaf"], ...]`) |
| `treemap` display note | Top-level group labels default to `overlapping`; override with `parent_label_layout: "banner" \| "overlapping" \| "none"`. PowerPoint labels only the top level and leaves — intermediate levels group tiles spatially without labels (sunburst shows every ring). |
| `histogram` | `values` |
| `pareto`, `waterfall`, `funnel` | `categories` + `values`; `waterfall` also accepts `subtotals` / `subtotal_indices` point indexes |
| `boxWhisker` | `series[].values`; optional `series[].categories` per value |

> Note: chartEx files are valid PPTX and editable in PowerPoint; non-Microsoft
> renderers can display a limited subset.

**Stock chart schema**: `stock` uses numeric Excel date serials in
`categories` or `dates`, plus exactly four series in open / high / low / close
order. Use either `series` with four entries, or top-level `open`, `high`,
`low`, and `close` arrays.

**Deferred chart types**: Exploded pie / doughnut variants, `map`, `heatmap`,
`bullet`, and `gantt` are intentionally outside the current native-object
support boundary. The exporter fails fast for these types until each mapping is
implemented and validated one by one.

**Supported chart types**:

- `column`, `bar`: `clustered`, `stacked`, or `percentStacked` (`grouping`)
- `line`: `standard`, `stacked`, or `percentStacked` (`grouping`); `line` or `lineMarker` (`line_style`, default `line` / no markers)
- `area`: `standard`, `stacked`, or `percentStacked` (`grouping`)
- `pie`: exactly one series, per-slice colors
- `doughnut`: exactly one series, per-slice colors
- `pieOfPie`, `barOfPie`: exactly one series, per-slice colors
- `radar`, `radarMarkers`, `radarFilled`
- `scatter`: `marker` (default), `lineMarker`, `line`, `smoothMarker`, or `smooth` (`scatter_style`)
- `bubble`: x/y/size series
- `combo`: `column`, `line`, and `area` plots, optional secondary value axis
- `treemap`, `sunburst`: hierarchical chartEx charts
- `histogram`, `pareto`
- `boxWhisker`
- `waterfall`, `funnel`
- `stock`: open / high / low / close series

3D chart aliases (`3DColumn`, `3DBar`, `3DLine`, `3DArea`, `3DPie`, cone,
cylinder, pyramid variants, and `surface`) are intentionally unsupported. They
add compatibility risk without meaningful presentation value.

Native chart legends are off by default because right-side legends routinely
steal plot area in PPT. Add `show_legend: true` only when the legend is needed;
`legend_position` defaults to `bottom` and also accepts `top`, `left`, or
`right`.

**Forbidden — native marker transforms**: Do not rotate, skew, or matrix-transform native table/chart marker groups. Translate / scale is accepted; complex transforms fail export because PowerPoint native table/chart frames do not preserve arbitrary SVG transforms.

### transform: rotate — Element Rotation

Rotation converts to native PPTX `<a:xfrm rot="...">`. Supported on all element types: `rect`, `circle`, `ellipse`, `line`, `path`, `polygon`, `polyline`, `image`, and `text`.

```xml
<!-- Rotated decorative element -->
<rect x="100" y="100" width="60" height="60" fill="#1A73E8" fill-opacity="0.1"
  transform="rotate(45, 130, 130)"/>

<!-- Rotated text label -->
<text x="50" y="400" font-size="14" fill="#999999"
  transform="rotate(-90, 50, 400)">Y-Axis Label</text>
```

**Syntax**: `rotate(angle)` or `rotate(angle, cx, cy)` where `cx,cy` is the rotation center. Positive angles rotate clockwise.

### Arc Paths — Donut / Pie Charts

Calculate arc endpoint coordinates precisely with trigonometry. Never estimate — small errors produce wildly wrong shapes.

**Calculation formula** (center `cx,cy`, radius `r`, angle `θ` in degrees):
```
x = cx + r × cos(θ × π / 180)
y = cy + r × sin(θ × π / 180)
```

**Key rules**:
1. Start at **-90°** (12 o'clock position) and go clockwise
2. Each sector spans `percentage × 360°`
3. Use **large-arc flag = 1** when the sector is > 180°, **0** otherwise
4. sweep-direction = 1 (clockwise) for outer arc, 0 (counter-clockwise) for inner arc returning
5. **Always verify** that the sum of all sector angles equals 360° and that the last sector's end point matches the first sector's start point

**Example — 75% donut sector** (center 400,400, outer r=180, inner r=100):
```
Start angle: -90°    → outer(400, 220), inner(400, 300)
End angle: -90+270=180° → outer(220, 400), inner(300, 400)
Large-arc flag: 1 (270° > 180°)

<path d="M 400,220 A 180,180 0 1,1 220,400 L 300,400 A 100,100 0 1,0 400,300 Z"/>
```

### Polygon Arrows on Diagonal Lines

> For connector lines prefer `marker-end`/`marker-start` (§1.1). For chunky/wide solid/non-connector arrows, use standalone polygon or path.

Horizontal/vertical lines can use simple point offsets for `<polygon>` arrowheads. Diagonal lines need triangle vertices rotated to match line direction.

**Method** — calculate triangle points using the line's direction vector:

```
Given line from (x1,y1) to (x2,y2):
1. Direction vector: dx = x2-x1, dy = y2-y1
2. Normalize: len = √(dx²+dy²), ux = dx/len, uy = dy/len
3. Perpendicular: px = -uy, py = ux
4. Arrow tip = (x2, y2)
5. Back point 1 = (x2 - ux×12 + px×5,  y2 - uy×12 + py×5)
6. Back point 2 = (x2 - ux×12 - px×5,  y2 - uy×12 - py×5)
```

**Example — diagonal line** from (260,310) to (370,430):
```
dx=110, dy=120, len≈162.8, ux=0.676, uy=0.737
px=-0.737, py=0.676
Tip: (370, 430)
Back1: (370-8.1-3.7, 430-8.8+3.4) = (358.2, 424.6)
Back2: (370-8.1+3.7, 430-8.8-3.4) = (365.6, 417.8)

<polygon points="370,430 365.6,417.8 358.2,424.6" fill="#C8A96E"/>
```

⚠️ Never use a fixed downward/rightward triangle on a diagonal line — arrow will point wrong.
