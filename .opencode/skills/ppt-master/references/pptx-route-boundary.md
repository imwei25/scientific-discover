> Source: `SKILL.md` Standalone Workflows → PPTX Route Boundary — moved verbatim. Read when the input or target is a PPTX and the route is not yet decided (after `workflows/routing.md`).

## Standalone Workflows

**Route authority**: Use [`workflows/routing.md`](../workflows/routing.md) before entering the main pipeline or any standalone workflow.

**Registry**: Use [`workflows/index.md`](../workflows/index.md) for the complete workflow list, triggers, preconditions, exclusions, outputs, and blocking points.

### PPTX Route Boundary

| User intent | Route |
|---|---|
| Raw PPTX template plus new material/topic, generate a PPTX | [`template-fill-pptx`](../workflows/template-fill-pptx.md) |
| Existing PPTX, preserve page count/order and slide wording 1:1, improve layout | [`beautify-pptx`](../workflows/beautify-pptx.md) |
| Existing PPTX as source material, rethink outline or change page count/order | Main pipeline via `source_to_md.py` plus PPTX intake |
| Build a reusable template package from a PPTX/design reference | [`create-template`](../workflows/create-template.md), then return with the generated template directory path |
| Finished PPTX, keep content/layout stable and add notes/audio/timing/transitions | [`native-enhance-pptx`](../workflows/native-enhance-pptx.md) |

**MUST**: Raw `.pptx` template plus "generate PPTX" routes to `template-fill-pptx` by default. The SVG generation route consumes only an explicit template directory path that already contains a valid template `design_spec.md`.

**MUST**: Beautify is strictly 1:1. Any split, merge, drop, reorder, or page-count change routes to the main pipeline.

**FALLBACK**: Ambiguous requests such as "make this PPT more professional" require exactly one discriminator question: preserve original page count/order and slide wording, or treat the deck as source material and restructure it?
