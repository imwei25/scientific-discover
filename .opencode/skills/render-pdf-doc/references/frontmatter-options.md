> Moved verbatim from SKILL.md "Step 1 — Author markdown with frontmatter"; read when you need the example frontmatter or the script defaults (geometry / fontsize / linestretch / colorlinks / ctex fontset).

```yaml
---
title: "Paper 2 Calibration Anchor — Q&A Grid"
author: "<Author Group>"
date: "2026-05-01"
# CJKmainfont: "SimSun"        # override the ctex fontset's Chinese font (optional)
# geometry: "margin=1in"       # script defaults: margin=1in, 12pt, linestretch=1.4
# colorlinks: true
---
```

Defaults if omitted: geometry `margin=1in`, `fontsize=12pt`, `linestretch=1.4`,
`colorlinks=true`. Chinese docs auto-select `ctexart` + the OS fontset (Windows 宋体/黑体,
macOS Songti/Heiti, Linux Fandol); no font settings needed.
