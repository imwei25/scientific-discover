# 流水线：文献综述（pipeline = review）

目标：把一个主题做成一份**有结构、有真实引用**的综述，出 PDF/Word。

## 步骤
1. **收敛主题（停下问用户）**：主题、时间窗（默认近 5–10 年）、语言（中文核心/英文）、目标篇幅或期刊、是否系统综述。写进 manifest 的 `topic`。
2. **检索建证据表**（自动）：优先 `literature-review` 的 `search.py`（Europe PMC，国内可达）；需要更广检索/雪球用 `search-lit`。产物 → `search/evidence_table.csv` + `search/refs.bib`。多概念时可拆检索式。
3. **写综述**（自动）：`literature-review` 读证据表成文（引言→分主题证据→争议与空白→结论→参考文献），产物 → `drafts/review.md`。每条论断都能追溯到证据表某篇。
4. **查假引用（自动，必做）**：把 `refs.bib` 或稿件引用交 `reference-check` → `checks/reference_check.md`。有 FABRICATED/NOT_FOUND/MISMATCH 就回到第 3 步改，别放过。
5. **去 AI 味（可选）**：中英文稿都可交 `humanize-academic`，并跑其 `check_invariants.py` 确认数字/引用未被改动 → `drafts/review_humanized.md`。
6. **排版交付**（定稿前停下确认）：中文默认 `render-pdf-doc`（字体自动）；要 Word 用 `render-docx` → `final/review.pdf|docx`。

## 停/走
- 停：第 1 步主题收敛、第 6 步定稿前。
- 走：2→3→4→5 全自动；检索源失败自动换 Europe PMC。
- 引用核查未过**不进入**排版。

## 常见分叉
- 用户其实只要"文献清单"而非成文综述 → 退回单用 `search-lit`。
- 只要"快速摸底不成文" → 退回单用 `research-scan`。
- **是"系统综述/Meta 分析"而非叙述性综述**（要双人筛选、PRISMA、偏倚风险、GRADE）→ 改走 `systematic-review` 技能的八步方法学流程（预注册→系统检索→去重→双人筛选+κ→RoB→数据提取→GRADE→PRISMA 计数），再交 `write-paper` 成文（其报告规范自检走 PRISMA 2020）。上面第 2–3 步的普通检索+成文**不适用**系统综述。
