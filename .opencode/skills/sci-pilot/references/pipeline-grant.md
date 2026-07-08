# 流水线：基金标书（pipeline = grant）

目标：把一个课题做成结构完整、有说服力、合规的标书（国自然/NIH），出 PDF。

## 步骤
1. **对齐（停下问用户）**：申请渠道（国自然面上/青年A·B·C类、NIH R01/R21…）、方向、**真实前期基础与数据**、团队条件、拟报学部/申请代码、经费强度。写进 `topic`。
2. **摸现状（自动）**：`research-scan` 拿真实文献梳理方向的空白与争议 → `search/research_scan.md`。高被引用 Europe PMC 的 citedByCount，别凭记忆报团队。
3. **选题定假设（可选，停下拍板）**：不确定具体课题时用 `topic-selection` 生成候选并多棱镜评分 → `drafts/topics.md`；多个候选让用户拍板。
4. **新颖性裁定 + 预注册（选定后，停下拍板）**：`research-design` 对选定课题做严格新颖性裁定（真新/增量/已被回答/有争议，含 ChiCTR/PROSPERO 注册库检索）→ `checks/novelty_assessment.md`；裁定"已被回答"要停下重构。临床试验/前瞻研究再出预注册草案 → `drafts/preregistration.md`（提示用户去 ChiCTR/OSF 正式注册、回填真实注册号）。
5. **起草标书（自动）**：`grant-proposal` 按渠道结构起草（立项依据/目标/内容/方案/创新/基础/预算）→ `drafts/proposal.md`。⚠️ 预算按当年口径（NSFC 三大类；A/B/C 类包干），政策数字标"以当年指南为准"；**绝不虚构数据/预算/成果**。
6. **投稿前自查（自动）**：`peer-review` 的自查模式按资助方标准（NIH 2025 简化三因素 / 国自然）逐项评强弱、查致命伤 → `checks/self_review.md`。
7. **排版交付**（定稿前停下）：`render-pdf-doc` → `final/proposal.pdf`（中文字体自动）。

## 停/走
- 停：第 1 步对齐、第 3 步选题拍板、第 4 步新颖性裁定（"已被回答"要重构）、第 7 步定稿前；任何要真实数据/预算的地方缺就问、标"待补充"。
- 走：2→5→6 的确定性部分自动，进度随时汇报。

## 硬约束
- AI 合规：NSFC 禁 AI 直接生成申请书正文、NIH NOT-OD-25-132——**产出为草稿，须申请人实质性亲自改写**，主控要向用户重申这一点（见 grant-proposal）。
