# 流水线：深度研究一个问题（pipeline = research）

目标：对一个**足够具体**的问题，产出多来源、可核查、带引用、标注置信度的报告，出 PDF。

## 步骤
1. **收敛问题（停下问用户）**：问题太宽先问 2–3 个澄清（范围、时间、地域、用途），缩到可研究。写进 `topic`。
2. **深度研究（自动）**：`deep-research` 拆子问题→判并行/串行→多源取证（学术默认 Europe PMC/literature-review 的 search.py）→交叉核实→成稿前反向核查一轮 → `drafts/deep_research.md`。来源分级 + 检索日志 + 每条结论标置信度。
3. **排版交付（定稿前停下）**：`render-pdf-doc` → `final/deep_research.pdf`（中文字体自动）。

## 停/走
- 停：第 1 步问题收敛、第 3 步定稿前。
- 走：第 2 步自动；无子代理框架里 deep-research 自会串行。

## 与其他流水线的边界
- 要写成**正式综述文体** → 用 `review` 流水线（literature-review）。
- 要摸清**整个领域全貌** → 单用 `research-scan`。
- 本流水线针对**单个具体问题**的跨源求证。
