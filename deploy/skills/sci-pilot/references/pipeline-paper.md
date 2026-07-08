# 流水线：原创研究论文（pipeline = paper）

目标：把用户**真实的**数据与结果写成一篇可投稿的 IMRaD 论文，出 Word。

## 步骤
1. **对齐（停下问用户）**：研究类型（RCT/队列/病例对照/诊断/动物…）、目标期刊、语言、手上材料（数据文件/已跑统计/图/前期文献）。写进 `topic`。
2. **脱敏（若含患者数据，必做，停下确认）**：数据含姓名/身份证/住院号等 → 先 `deidentify` → `analysis/data_deid.csv`。**未脱敏不进入分析**。映射表单独保管。
3. **统计（自动）**：
   - `clinical-stats` 出 Table 1 基线特征表（按变量类型自动选检验）→ `analysis/table1.csv`；需要样本量依据时同样用它（先验，别做 post-hoc power）。
   - 其他分析/建模用 `data-analysis`（含医学统计护栏）→ `analysis/results.md`。
4. **作图（自动）**：出版级图（森林图/KM/火山图）交 `nature-figure` → `figures/`。
5. **写论文（自动）**：`write-paper` 按 IMRaD 组织成文 → `drafts/manuscript.md`。**数字三处一致（正文/表/图）、绝不编数据与引用**；含 ICMJE 投稿声明、流程图（CONSORT/PRISMA）。**第 4 步 `figures/` 里的每张图必须落进正文**：插入 `![图N. 图注](figures/…)` 引用 + 正文点名 `(图N)` + 写图注 + 按出现顺序编号，别留"孤儿图"（详见 write-paper §4 图表规则）。
6. **查假引用（自动，必做）**：`reference-check` → `checks/reference_check.md`。**标红项按 write-paper §6 的自修复循环处理**：能可靠修复（找到真实且回读摘要确认支持论断的文献）就改稿、并只把改动项单独复验；改不动就就地标注 `【待核实…】` 汇总告知用户——**绝不静默删或硬塞未核实文献**（每条最多自修复 2 次）。讨论里对文献的转述由主代理回读摘要核对（reference-check 只验真伪、不验是否支持论断）。
7. **去 AI 味（自动）**：`humanize-academic`（中英文）+ 跑 `check_invariants.py` 确认数字/引用未变 → `drafts/manuscript_humanized.md`。
8. **投稿前自查（自动）**：`peer-review` 自查模式按报告规范（CONSORT/STROBE/STARD/TRIPOD…）逐条核 → `checks/self_review.md`。
9. **出 Word（定稿前停下）**：`render-docx`（医学期刊多要 Word）→ `final/manuscript.docx`；pandoc 未装则退回 `render-pdf-doc` 出 PDF 并告知。

## 停/走
- 停：第 1 步对齐、第 2 步脱敏确认、第 9 步定稿前；任何缺真实数据/伦理号/注册号处停下问、标"待补充"。
- 走：3→8 的确定性部分自动，逐步汇报。

## 硬约束
- 绝不虚构数据/结果/统计量/引用/伦理批号/注册号/基金号/作者单位。
- AI 不得列为作者、须披露 AI 辅助；**产出为草稿，作者须实质审阅负责**（见 write-paper）。
- 附属产出（cover letter、response to reviewers）按需由 write-paper 生成到 `drafts/`。
