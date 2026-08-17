# 临床研究注册与方案报告规范 要求卡（跨渠道公共卡）

> 检索日期 2026-07-21，均为官方一手来源。**这是公共卡**：临床类课题不论申哪个渠道，注册与方案规范都要过一遍；标书里的"研究方案"章节按对应规范写，评审看得出来。

## 1. 三种"注册时机"要求，别混写（最常见的错误）

| 来源 | 时机要求 | 性质 |
|---|---|---|
| **ICMJE**（发表前置） | **首例受试者知情同意时或之前**（at or before the time of first patient consent for enrollment）；**投稿时补注册不满足** | 最严，决定能不能发表 |
| **ClinicalTrials.gov / FDAAA** | **首例入组后 21 个日历日内**（42 CFR §11.24(a)） | 美国法规 |
| **ChiCTR** | **无"首例入组前"硬性要求**——预注册与补注册均接受且均免费，记录中公开标注 Prospective/Retrospective | 平台规则 |

⚠️ ChiCTR 官方原文提醒："无论是预注册还是补注册，均**不保证**研究文章的发表"——因为发表门槛在 ICMJE 那边。**技能不得说"ChiCTR 要求首例入组前注册"。**

## 2. ChiCTR（中国临床试验注册中心）

- 四川大学华西医院运营，**WHO ICTRP 一级注册机构**；官网 https://www.chictr.org.cn/ ｜指南 https://www.chictr.org.cn/guide.html （标注更新于 2026-06-04）
- **适用范围比 ClinicalTrials.gov 宽**（官方原文）：所有在人体中和采用取自人体标本进行的研究，包括有/无对照的干预试验（RCT、病例-对照、队列、非对照研究）、预后研究、病因学研究、以及各种诊断技术/试剂/设备的诊断性试验——**观察性与诊断性研究同样收**。
- 流程：线上建号 → 注册新项目 → **中英文双语**（中国大陆/港澳台一律双语）→ 填必填项 → 提交 → 上传**伦理审查批件**（jpg ≤2MB）→ 上传研究计划书全文与知情同意书（仅供审核不公开）→ 专家审核**两周内**给号（官方注明近期周期延长）→ 获号次周可在 WHO ICTRP 检索到。
- **官方明确要求按 GCP 与 SPIRIT 制订研究计划书、病例观察表与知情同意书** → 见 §4。
- 为配合立项/标书，**信息完整但暂缺计划书者可先期获号**，事后补交（写标书时用得上）。
- 数据管理：官方要求**纸质 CRF 与电子 EDC 两者同时具备**，并明确"EXCEL 是传输格式，不是 EDC"。
- 2016-03-14 起须填**原始数据共享（IPD sharing）计划**；跨国多中心多库注册须取 WHO **UTN**（https://trialsearch.who.int/utn.aspx ）。
- 费用免费；注册表修改留历史版本可追溯；试验结束后结果须上传公网可查的 EDC，一年后公布。
- **注册号格式（当前）**：`ChiCTR` + 2 位年份 + 8 位流水（共 10 位数字），如 `ChiCTR2600117941`。⚠️ WHO ICTRP 页上仍列的 `ChiCTR-TRC-xxxxxxxx` 等字母编码是**旧格式已停用**——官方来源之间不一致，**以 ChiCTR 实录为准**。

## 3. ClinicalTrials.gov

- 法律依据 FDAAA 801 + Final Rule **42 CFR Part 11**；ACT 判定清单 https://cdn.clinicaltrials.gov/documents/ACT_Checklist.pdf
- **是否必须注册（ACT 四问，全"是"才是 ACT）**：① 干预性研究？② 至少一个美国中心 / 在 FDA IND 或 IDE 下 / 涉及在美生产并出口研究的产品？③ 评价至少一个受 FDA 监管的药物、生物制品或器械？④ **不是**药物/生物制品 **Phase 1**、**不是**器械可行性研究？
- 注册时机 21 天（§11.24(a)）；**结果提交**不迟于 Primary Completion Date 后 **1 年**（§11.44）。
- 必填四大类（§11.28）：Descriptive（含主要/次要结局指标）、Recruitment、Location and Contact、Administrative（含 IND/IDE 号、伦理审查状态）。
- **NIH 政策比 FDAAA 更宽**：所有 NIH 资助的临床试验都要注册并报结果，不论是否 ACT。⚠️ 变化点：NIH 自 **2026-05-25** 起不再把 **BESH**（Basic Experimental Studies with Humans）视为 clinical trial，不再要求其注册。
- 观察性研究**不属强制范围**，但可自愿注册。号码格式 `^NCT\d{8}$`。

## 4. 方案报告规范：按研究类型对号入座

| 研究类型 | 方案层面规范 | 条目数 |
|---|---|---|
| 随机对照试验 | **SPIRIT 2025** | **34 项** + 入组/干预/评估时间安排图 |
| 系统综述 | **PRISMA-P 2015** + PROSPERO 注册 | 17 项 |
| 观察性研究 | **无官方通用方案清单**（真实缺口，别臆造）——只有报告层面的 STROBE 22 项 / RECORD 13 项扩展 | — |

**SPIRIT 2025（已取代 2013 版！）**
- 官方站 **https://www.consort-spirit.org/**（原 spirit-statement.org 已重定向）；Chan A-W, et al. *BMJ* 2025;389:e081477；开放全文 https://pmc.ncbi.nlm.nih.gov/articles/PMC12035670/
- 相对 2013 版（33 项）：新增 2 条、修订 5 条、删除 3 条、合并 2 条 → **34 项**。
- 结构性新增：**open science 专节**（试验注册、方案与统计分析计划可获取性、数据共享、经费披露、成果传播）、强化**危害（harms）评估**与干预/对照描述、新增**患者与公众参与（PPI）**条目。
- 清单下载：docx https://www.consort-spirit.org/_files/ugd/b5740e_667c45b02102408ab983c9704525597b.docx ｜扩展目录 https://www.consort-spirit.org/extensions
- 配套结果报告规范 **CONSORT 2025 = 30 项** + 流程图。
- ⚠️ **任何仍写"SPIRIT 33 项 / SPIRIT 2013"的模板都已过时**；ChiCTR 指南目前仍指向 2013 版 BMJ 链接（官方来源滞后，按 2025 版写）。

**PRISMA-P 2015（系统综述方案，17 项三大节）**
- 官方 https://www.prisma-statement.org/protocols ｜清单 PDF https://www.prisma-statement.org/s/PRISMA-P-checklist-h7cd.pdf ｜Moher D, et al. *Syst Rev* 2015;4:1
- ADMINISTRATIVE：1a 标识为方案 / 1b 是否更新 / **2 Registration（注册库与注册号）** / 3a-3b 作者与 guarantor / 4 Amendments / 5a-5c 资助与资助方角色
- INTRODUCTION：6 Rationale / 7 Objectives（**按 PICO 表述**）
- METHODS：8 Eligibility / 9 Information sources / 10 **检索式草案需可复现** / 11a-11c 数据管理、**双人独立筛选**、提取流程 / 12 Data items / 13 结局与优先级 / 14 单研究偏倚风险 / 15a-15d 合并判据、统计量与异质性、附加分析、不宜合并时的替代 / 16 Meta-bias / 17 **证据确信度（如 GRADE）**
- ⚠️ 二手来源称 PRISMA-P 更新在研（"PRISMA-P 2025 steering group"、"PRISMA 2026"）——**未获官方确认，现行可引用的仍是 PRISMA-P 2015**。

**STROBE / RECORD（报告规范，非方案规范——别搞混）**
- STROBE 2007，**22 项**，覆盖队列/病例对照/横断面；官网 https://www.strobe-statement.org/ 。官方定义其规范的是"已完成研究的论文报告"。
- RECORD 2015（常规采集健康数据研究的报告扩展），**13 个子条目**挂在 STROBE 上；https://www.record-statement.org/ 。另有 RECORD-PE（药物流行病学）。
- ⚠️ STROBE 官网未列完整扩展目录（/about-strobe/ 返回 404），STREGA、STROBE-MR 等**未从官方一手确认**。

## 5. PROSPERO（系统综述注册）

- CRD, University of York；https://www.crd.york.ac.uk/prospero/ ｜纳入标准 https://www.crd.york.ac.uk/PROSPERO/help/eligibility
- 收：结局与**人类健康直接相关**的系统综述。**不收**：注册时**已开始数据提取**的（IPD 综述已获部分数据集的同理）；结局仅间接影响健康的（如教育成就）；运动表现类；只做了系统检索但未用其他系统综述方法的传统综述；证据与缺口图；对临床指南的系统性批判性评价。**Scoping review 目前不收**。
- **截止线是"数据提取开始前"**，但官方建议方案定稿后、筛选开始前就注册。
- PROSPERO 记录**不等于完整方案**，可另上传完整方案 PDF；由 guarantor 批准后**即时分配注册号并公开**；修订留带日期审计轨迹、历史版本永久公开；**不做同行评审、不背书，记录不是正式出版物**。
- 学生/培训项目须选 **student project** 选项（不公开、不可检索）。

## 6. ICMJE 与 WHO 最少数据集

- ICMJE Recommendations（**Updated January 2026**）https://www.icmje.org/recommendations/browse/publishing-and-editorial-issues/clinical-trial-registration.html
- 试验定义：前瞻性把人或人群分配到干预以研究干预与健康结局关系的研究（**无对照亦算**）。
- 可接受注册库：WHO ICTRP **一级注册机构**或 ClinicalTrials.gov → **ChiCTR 符合**。
- 注册须填齐 **WHO 24 项最少数据集**（版本 1.3.1），缺一项即视为注册不充分。
- 自 2018-07-01 起，临床试验稿件须含 **data sharing statement**（是否共享去标识个体数据、哪些数据、起止时间、与谁共享、何种分析、何种机制）。

## 7. 自查清单

- [ ] 研究类型判定 → 选对注册库（干预性且涉美/FDA → ClinicalTrials.gov；国内各类含观察性 → ChiCTR）
- [ ] 注册时机：若计划发表，按 **ICMJE 首例知情同意前**执行（最严的那条）
- [ ] 注册前备好伦理批件（ChiCTR 上传必需）
- [ ] 方案按对应规范写：RCT → SPIRIT **2025（34 项）**；系统综述 → PRISMA-P 17 项 + PROSPERO；观察性 → 无方案清单，按 STROBE 22 项组织内容并说明
- [ ] 数据管理：CRF + EDC 双备（ChiCTR 要求）；IPD 共享计划已填
- [ ] 多中心/跨国：UTN 已取；牵头与参与中心伦理均到位
- [ ] 标书中引用的规范版本正确（**不写 SPIRIT 2013/33 项**）

## 8. 动态核实项

ICMJE Recommendations 版本月份（现 January 2026）｜WHO 数据集版本（现 1.3.1）｜ChiCTR 指南更新日期（现 2026-06-04）与注册号流水位数｜NIH BESH 政策（2026-05-25 变更）｜PRISMA-P 更新进展（在研，未证实）｜SPIRIT/STROBE 扩展清单目录
⚠️ equator-network.org 在调研环境不可访问，上述规范均取自各自官方站与原文，未经 EQUATOR 交叉确认。
