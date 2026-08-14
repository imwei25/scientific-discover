---
name: nature-figure
description: >-
  Submission-grade journal figure workflow for DATA-DRIVEN plots (Python matplotlib/seaborn; R ggplot2 only when explicitly requested). Use when the user asks to create, revise, audit, or polish manuscript figures — forest/KM/volcano/ROC, multi-panel, journal-ready SVG/PDF/TIFF. NOT for data-free schematics or graphical abstracts (use mechanism-figure) and not for dashboards/infographics. Chinese triggers: 论文配图、科研绘图、画图、出图、森林图、生存曲线、火山图、箱线图、热图.
version: 2.1.0
author: Community contribution (nature-skills); repo-adapted backend/default policy
---

> **本仓库运行环境（先读）**：Python 用 `"${REPO_ROOT:-/app}/.venv/bin/python"`（项目根 `.venv`，随包装好；报错先查路径引号，别重建）；本技能脚本在 `"${REPO_ROOT:-/app}/.opencode/skills/nature-figure/"` 下，运行时先 `cd` 到该目录或用全路径；产出写 `outputs/`（有会话专属目录时以它为准、勿写仓库根固定名）。
>
> **本技能只管【数据图】（本仓库的分工）**：图上形状由数字决定的（森林图/KM/火山图/ROC/箱线图/热图…）走这里；**没有数据的机制图 / 通路示意图 / 图形摘要走 `mechanism-figure` 技能**（文生图，带反编造闸与标签必核清单）。上游正文里的 OpenRouter 图像示意图路线在本仓库**保持关闭**（需自备 key，且能力已由 `mechanism-figure` 覆盖）。
>
> **本仓库后端策略（覆盖下方 vendored 正文的"必须问一次 Python or R"）**：默认直接用 **Python 后端**（matplotlib/seaborn 已装，R 后端未装）。**不要**为了选后端而停下来问用户——除非用户在请求里明确说要 R。因此下方 "Resolve the backend — a blocking gate" 一节在本仓库简化为：无明确 R 要求 → 直接 Python，跳过提问。默认不使用 OpenRouter 图像路线（需自备 key）。以下为上游技能原文（vendored，方法论未改）。
>
> **R 未装，且【禁止在容器里现装】**：不要执行 `install.packages()`、`apt install r-base`、conda 装 R 或任何等效操作——装进的是容器可写层，**每次上线重建容器就全部消失**，只会制造"上周还能跑、今天又不行"的幻觉，还会挤占共享宿主的内存与磁盘。用户明确要 R 时按优先级处理：**①** 用已装的 Python 栈复刻同等图形并说明等价性；**②** 把写好的 R 脚本作为产物交付（含 `install.packages()` 注释），由用户在自己机器上运行；**③** 如用户坚持容器内直接跑 R，如实告知本部署不含 R、需平台管理员改镜像。`r-workflow.md` 里"may provide install.packages() commands"在本仓库理解为【写进交付脚本的注释】，不是在容器里执行。

> **上游故事线定案（有就照单干）**：开工先扫当前工作目录有无 `design_brief.md`（idea-forge 故事线锻打的出件，paper 流水线在本技能之前）——有，其「下游任务清单 · nature-figure 该画」一节就是本次的图表清单：**按清单画、图与核心主张一一对应，别自作主张多画或漏画**；主张梯度（如"独立关联、不声称因果"）同时约束图注措辞。没有该文件则照常按用户请求与数据判断。

# Nature Figure Making — Router

This skill is split into two layers:

- A **static layer** under `static/` that holds versioned, reusable content fragments (the figure contract and default stance, plus a per-backend quick-start for Python and R).
- A **dynamic layer** (this file plus `manifest.yaml`) that detects the plotting backend and loads only the fragment needed for the current job. The large design, API, pattern, and QA material lives in on-demand references.

Do not try to apply the figure logic from memory or from this router. Always load fragments from disk as described below.

## Routing protocol

Follow these steps every time the skill is invoked.

### 0. Check for the OpenRouter AI-schematic route

If the user explicitly asks to generate a manuscript schematic, graphical abstract, mechanism diagram, concept illustration, or paper schematic with OpenRouter, GPT Image 2, an image-generation API, or similar wording, do **not** ask "Python or R?". This is a non-plotting AI-schematic route.

For this route:

1. Read [manifest.yaml](manifest.yaml) and the `always_load` files.
2. Read [references/openrouter-image-generation.md](references/openrouter-image-generation.md).
3. Use [scripts/generate_openrouter_schematic.py](scripts/generate_openrouter_schematic.py) when the user wants a real API call or a reproducible payload.
4. Treat output as a draft schematic / graphical abstract, not as a quantitative data panel. Do not invent experimental values, author logos, institutional marks, or unsupported mechanisms.

Only continue to the Python/R backend gate for plotting, charting, data visualization, or manuscript figure assembly tasks that are not explicit OpenRouter AI image-generation requests.

### 1. Load the manifest and the core layer

Read [manifest.yaml](manifest.yaml). It declares the `backend` axis, the allowed values, and the file paths each value maps to.

Also read every file listed under `always_load` (`static/core/contract.md` and `static/core/stance.md`). These hold the figure contract, the backend gate, the missing-runtime rule, the privacy rule, and the default operating stance that apply to every figure job.

### 2. Resolve the backend — a blocking gate

Backend selection blocks plotting tasks, but it should not annoy the same user forever. Decide the `backend` value in this order:

1. If the current request explicitly chooses Python or R, use that backend and save it with `scripts/nature_figure_backend.py set python` or `scripts/nature_figure_backend.py set r`.
2. If the request provides a clearly language-specific input file/workflow, use that backend and save it.
3. Otherwise run `scripts/nature_figure_backend.py get`. If it returns `python` or `r`, use the saved preference.
4. If no saved preference exists, ask exactly one concise question — **Python or R? I will remember this as your default.** — and stop. After the user answers, save the answer before proceeding.

- `python` — matplotlib / seaborn.
- `r` — ggplot2 / patchwork / ComplexHeatmap.

Do not guess or choose a backend by aesthetics alone. Only recommend a backend when the user explicitly asks you to choose; then use `references/backend-selection.md`, state the reason, save the selected backend, and proceed. Once selected, the backend is **exclusive** for all drawing, previewing, exporting, and visual QA (see `core/contract.md`). This gate does not apply to the explicit OpenRouter AI-schematic route above.

### 3. Load the matching backend fragment

After the backend is resolved, Read the mapped fragment (`static/fragments/backend/python.md` or `static/fragments/backend/r.md`). It carries the backend-only execution rule and the publication quick-start (rcParams/theme and export helper). Do **not** load the other backend's fragment.

### 4. Build the figure using the loaded material

Apply the loaded material in this order:

1. Figure contract (`core/contract.md`) — write the core conclusion, map the evidence chain, classify the archetype, set the journal/export contract, before any code.
2. Default stance (`core/stance.md`) — archetype-first composition, hero panel, restrained palette, statistics/integrity as part of the figure.
3. Backend fragment — the exclusive Python or R quick-start and execution rule.

The chart serves the scientific logic; aesthetic polish is subordinate to making the core conclusion clear, defensible, and reviewable.

**字体必须走 `figfont`，存图前必须调 `guard_cjk()`。** 不要手抄 rcParams 字体链——文档里那几段
写死的是 Linux 容器的字体名，而桌面版跑在 Windows 上，一个都没有，于是中文标签全渲染成豆腐块(□)。
**而你没有图像输入能力，看不出来**：实测一整张 KM 图的标题、坐标轴、图例全是 □，脚本"没有报错"，
模型据此宣布"图已生成"，用户拿去就往稿子里贴。`setup_fonts()` 会现场探测本机真装了什么，
`guard_cjk(标题, 轴标签, 图例…)` 会在"含中文却无可用字体"时直接抛错——把静默的坏图变成显式失败。
**没调 `guard_cjk()` 不算画完。**

**Never invent units.** Axis labels, cut-off annotations, and legends may only carry a unit that is stated in the data itself (in the column name, data dictionary, or a free-text column) or given by the user. When no unit is stated, print the bare number (`Cutoff 1.20`) — do **not** infer one from the magnitude. Observed failure: a source table whose column was just `D-dimer` produced a 300 dpi submission figure reading `Cutoff 1.20 mg/L`; D-dimer is reported as mg/L FEU, µg/mL FEU, or ng/mL DDU depending on the lab, and those differ by up to 1000×. A figure is the artefact that gets published — a wrong unit baked into it survives every later review. Ask the user instead.

### 5. Reach for references only when needed

The files under `references/` are deep references, not defaults. Open them on demand per the `references.on_demand` table in the manifest — for example `references/figure-contract.md` to build the contract, `references/api.md` for the Python palette and helpers, `references/r-workflow.md` for R, `references/design-theory.md` for color/typography/export rationale, `references/common-patterns.md` and `references/chart-types.md` for layout/chart recipes, `references/nature-2026-observations.md` for real Nature page archetypes, `references/qa-contract.md` before final delivery, and `references/tutorials.md` / `references/demos.md` for worked examples.

## Why this split

- The static layer is versioned and reviewable. The backend gate is now explicit in the manifest rather than buried in prose.
- The dynamic layer keeps each invocation cheap: only the selected backend's quick-start enters context, and the 2,600+ lines of reference depth load only when a step needs them.
- The router itself is short on purpose. Update fragments and references, not this file, when adding scope.
- This structure mirrors `nature-writing`, `nature-polishing`, `nature-reader`, and `nature-paper2ppt`.
