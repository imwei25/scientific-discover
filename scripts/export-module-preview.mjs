// 把某个模块的界面导出成【单个自包含 HTML】，交给设计的人美化。
//
// 产出的文件 = 线上 web/index.html 原封不动 + 顶部注入一段「示例数据 + fetch 拦截」。
// 拦截层把所有后端请求就地答掉，于是文件双击就能打开、不需要跑服务、不需要登录，
// 页面照常按真实代码渲染（真实的 CSS、真实的组件、真实的工作流表单 schema）。
//
// 三条约束：
//   ① 【不改产品代码】。注入的整段被 DEMO-BLOCK 注释包住，删掉它就还原成线上文件，
//      美化的人改的 CSS 能直接搬回 web/index.html。
//   ② 【去掉更新提示】。/api/cloud/notice 恒回"无技能更新、无界面更新、无公告"，
//      三条横幅（skillbanner / webbanner / 公告红点）都不会出现。
//   ③ 【示例内容全是虚构的】。文献、数据、病例、期刊评审意见都是编的占位文本，
//      不含任何真实患者信息，也不要拿去当真实结果引用。
//
// 用法：node scripts/export-module-preview.mjs [输出目录]
//   默认输出到 docs/ui-preview/

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as WF from "../web/workflows.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = resolve(process.argv[2] || join(ROOT, "docs", "ui-preview"))

// 与 web/server.mjs 的 MODULE_DEFS 保持一致（那份不能直接 import：一 import 就把服务起起来了）。
// 这里只用来喂 /api/modules，让工作台分栏与模块徽标显示得跟线上一样。
const MODULE_DEFS = {
  review: { name: "综述撰写", group: "workbench", desc: "整合医学前沿研究成果，梳理领域发展脉络，挖掘研究缺口，明晰创新方向，为课题设计与成果输出夯实理论基础。" },
  grant: { name: "基金申报", group: "workbench", desc: "国自然 / 基金标书智能生成、润色与格式校验，搭建完整研究方案，优化技术路线，覆盖立项依据到研究基础全章节。" },
  paper: { name: "SCI 论文", group: "workbench", desc: "契合医学期刊规范，梳理试验逻辑、深化结果讨论，雕琢全文表述，助力高水平学术成果刊发。" },
  chat: { name: "自由对话", group: "workbench", skills: null, desc: "与科研助手开放对话，随问随答，支持上传文献、数据与方法学讨论。" },
  litread: { name: "文献研读", group: "skills", desc: "追踪医学领域前沿文献，梳理研究脉络，挖掘研究空白，提炼创新思路，为课题设计、文稿创作提供理论支撑。" },
  refcheck: { name: "文稿核查与审校", group: "skills", desc: "核验文献与引用是否真实存在、DOI 与撤稿情况，检查统计方法与数据的自洽性，逐条列出需要你复核的疑点。" },
  humanize: { name: "文章润色", group: "skills", desc: "贴合期刊写作范式，优化行文逻辑、专业表述与段落架构，消除生成式文本痕迹，还原自然学术语感与逻辑节奏。" },
  stats: { name: "数据统计与分析", group: "skills", desc: "一站式医学科研数据服务，涵盖统计建模、基线分析、期刊图表绘制、数据脱敏与源数据核查，完成从数据质控到结果可视化全流程处理。" },
}
const modulesPayload = Object.entries(MODULE_DEFS).map(([id, m]) => ({
  id, name: m.name, desc: m.desc, group: m.group,
  skill: id === "chat" ? null : WF.primaryOf(id) || null,
  skills: id === "chat" ? null : WF.skillsOf(id) || null,
  allowed: true,
}))

// ---------- 各模块的示例场景 ----------
// values 用来裁剪步骤条（与线上 /api/workflow/state 同一套 workflowFor(mod, values)）。
const SCENES = {
  review: {
    label: "综述撰写",
    values: {
      topic: "PD-1 抑制剂联合抗血管生成靶向药在晚期肝细胞癌一线治疗中的疗效与安全性",
      pico: "人群：晚期肝细胞癌初治患者　干预：PD-1 抑制剂联合靶向　对照：单药靶向　结局：总生存期",
      years: "10", designs: ["rct", "cohort"], limit: 50,
      jQuartile: ["Q1", "Q2"], jOA: false,
      length: "4000", fulltext: false, lang: "zh",
    },
    done: ["search", "screen"],
    cur: "write",
    sessionTitle: "PD-1 联合靶向治疗晚期肝癌综述",
    uploads: [
      { name: "既往整理的文献清单.xlsx", size: 41283 },
      { name: "科室综述模板.docx", size: 28714 },
    ],
    outputs: ["evidence_table.csv", "evidence.md", "refs.bib", "screening_log.md", "included.csv"],
    // 对话：用户 → 助手 → 用户 → 助手（最后一轮末尾会挂「下一步」表单卡与产物卡）
    turns: [
      { role: "user", text: "综述撰写 · 选题与检索范围\n主题：PD-1 抑制剂联合抗血管生成靶向药在晚期肝细胞癌一线治疗中的疗效与安全性；近 10 年；纳入 RCT 与队列研究；上限 50 篇；目标篇幅约 4000 字。" },
      {
        role: "bot", text: `已按你的设定完成**文献检索**与**纳入 / 排除筛选**。下面是这两步的结果，证据表已写到本会话产出里。

### 一、检索执行情况

| 检索源 | 检索式 | 命中 | 去重后 |
| --- | --- | ---: | ---: |
| PubMed | (hepatocellular carcinoma) AND (PD-1 OR nivolumab OR pembrolizumab) AND (lenvatinib OR bevacizumab) | 214 | 214 |
| Europe PMC | 同上，限 2016–2026 | 187 | 96 |
| 合计 | — | **401** | **310** |

> 检索日期：2026-08-07。每一条引用的标题、作者、年份、DOI 都经检索接口逐条核实，**没有凭记忆生成的引用**。

### 二、筛选结果

- 初筛（标题 / 摘要）：310 → 78 篇
- 复筛（全文可得性与研究设计）：78 → **31 篇**纳入
- 排除的主要原因：非一线治疗（22 篇）、样本量 < 30（14 篇）、会议摘要无全文（11 篇）

### 三、需要你确认的两点

1. **IMbrave150 的 5 年随访更新**（2025）与初版结果并存，综述里按"同一研究的最新随访"合并处理，还是两版都列？
2. 有 4 篇中文核心期刊的回顾性研究符合纳入标准，是否一并纳入？（纳入会提高本土人群的适用性，但会削弱证据同质性）

确认后我就进入**综述成文**这一步。`,
      },
      { role: "user", text: "IMbrave150 按最新随访合并；中文那 4 篇纳入，但在讨论里单独说明证据等级。" },
      {
        role: "bot", text: `明白，已按这两条更新纳入表（\`included.csv\` 已重写，现为 **31 篇**，其中中文文献 4 篇单独标记 \`evidence_level = retrospective-cn\`）。

**下一步「综述成文」的写作提纲**（可直接改，也可以先看下面的文献卡片再定）：

1. 引言 —— 晚期 HCC 一线治疗格局的变化（索拉非尼 → 联合免疫）
2. 机制基础 —— 抗血管生成如何重塑肿瘤免疫微环境
3. 疗效证据 —— 按 OS / PFS / ORR 三个结局分别综合
4. 安全性 —— 免疫相关不良事件与出血风险的叠加
5. 争议与缺口 —— 生物标志物缺位、亚洲人群数据不足、跨线治疗顺序未定
6. 结语与展望

⚠️ 提醒一句：本模块做的是**叙述性综述**，上面的"疗效证据"一节是**定性综合**，不做 Meta 合并、不出森林图。需要合并效应量请到「自由对话」里说明要做系统综述 / Meta。`,
      },
    ],
    // 富渲染的结构化产物（文献卡片）——就是线上 evidenceCard 那个组件
    artifacts: [{ name: "evidence_table.csv", render: "evidence" }],
    products: ["evidence_table.csv", "screening_log.md"],
    files: {
      "evidence_table.csv": [
        "title,authors,journal,year,doi,design,n,conclusion",
        '"Atezolizumab plus Bevacizumab in Unresectable Hepatocellular Carcinoma","Finn RS; Qin S; Ikeda M","N Engl J Med",2020,10.1056/NEJMoa1915745,RCT,501,"联合方案较索拉非尼显著延长 OS 与 PFS"',
        '"Lenvatinib plus Pembrolizumab in First-line Advanced HCC","Llovet JM; Kudo M; Merle P","Lancet Oncol",2023,10.1016/S1470-2045(23)00469-2,RCT,794,"主要终点未达统计学显著，亚组中 HBV 相关人群获益更明显"',
        '"Camrelizumab plus Rivoceranib as First-line Therapy","Qin S; Chan SL; Gu S","Lancet",2023,10.1016/S0140-6736(23)00961-3,RCT,543,"中位 OS 22.1 个月，为亚洲人群提供一线联合方案证据"',
        '"Real-world Outcomes of PD-1 Inhibitor Combinations in Advanced HCC","Zhang Y; Wang H; Li Q","J Hepatol",2024,10.1016/j.jhep.2024.02.011,Cohort,412,"真实世界 ORR 与注册试验相近，但 3 级以上不良事件比例更高"',
        '"Immune-related Adverse Events in Combination Therapy for HCC: a Multicenter Cohort","Tanaka K; Sato R; Ito M","Hepatology",2025,10.1002/hep.32988,Cohort,268,"联合治疗组出血相关事件发生率 8.2%，需基线胃镜评估"',
        '"抗血管生成联合免疫治疗晚期肝细胞癌的回顾性队列研究","陈明; 李伟; 张岚","中华肝脏病杂志",2024,10.3760/cma.j.cn501113-20240115-00023,Cohort,156,"国内多中心回顾性数据支持联合方案的可行性，随访时间较短"',
      ].join("\n"),
    },
  },

  grant: {
    label: "基金申报",
    values: {
      funder: "nsfc-general",
      keywords: ["肿瘤相关成纤维细胞", "胰腺癌", "免疫治疗抵抗", "单细胞测序", "空间转录组"],
      discipline: "肿瘤学",
      amount: 60,
      yearStart: "2027", yearEnd: "2030",
      applicantName: "李文博",
      applicant: "associate",
      org: "某某大学附属第一医院",
      email: "liwenbo@example-hospital.com",
      phone: "13800138000",
      reqDesc: "正文不超过 8000 字；须含立项依据、研究内容与目标、研究方案与技术路线、特色与创新、研究基础、工作条件；参考文献 30 条以内。",
      baseDesc: "已发表 CAF 相关论著 3 篇（1 篇一作 IF 8.2）；完成 120 例胰腺癌配对组织的多重免疫荧光预实验；本院有空间转录组平台与生物样本库。",
      attachFiles: ["代表作合集.pdf", "预实验数据汇总.docx", "2026年度国自然项目指南.pdf"],
    },
    // 「选题遴选」已经走完（候选选题 + 新颖性裁定 + 预注册在同一格里做完），现在在写正文
    done: ["scan", "topic"],
    cur: "write",
    sessionTitle: "CAF 异质性与胰腺癌免疫抵抗（面上）",
    uploads: [
      { name: "代表作合集.pdf", size: 4210338 },
      { name: "预实验数据汇总.docx", size: 186420 },
      { name: "2026年度国自然项目指南.pdf", size: 932117 },
    ],
    outputs: ["research_scan.md", "landscape.csv", "topic_candidates.csv", "topic_selection.md",
              "novelty_report.md", "preregistration.md", "要求卡-国自然面上.md"],
    turns: [
      { role: "user", text: "基金申报 · 基础信息录入\n申请类型：国家自然科学基金·面上项目；关键字：肿瘤相关成纤维细胞、胰腺癌、免疫治疗抵抗、单细胞测序、空间转录组；领域分类：肿瘤学；申请金额 60 万元；2027–2030；申请人：李文博（副研究员 / 副教授），某某大学附属第一医院；已上传代表作、预实验数据与 2026 年度项目指南。" },
      {
        role: "bot", text: `**研究方向生成**已完成，四象限采样共取回 186 篇（近 5 年，肿瘤学相关），逐条核实过标题 / 年份 / DOI，**没有凭记忆生成的引用**。

### 一、这个方向现在长什么样

| 象限 | 代表工作 | 近 5 年产出 | 当前口径 |
| --- | --- | ---: | --- |
| 机制（单细胞图谱） | Elyada 2019 起的 iCAF / myCAF 二分 | 62 篇 | 分型标准仍未统一 |
| 机制（免疫互作） | CAF→CD8⁺ T 排斥的多条通路 | 48 篇 | 多为单通路验证，缺整合 |
| 干预（靶向 CAF） | FAP-CAR-T、CXCL12 阻断 | 41 篇 | 临床转化多在 I 期止步 |
| 标志物 | CAF 亚群比例与 ICI 应答 | 35 篇 | 队列小，未见前瞻验证 |

> ⚠️ **没搜到 ≠ 研究空白**。上表第 4 行的"未见前瞻验证"是指本次采样范围内未检出，不等于该方向无人做。

### 二、还缺你一句话

你手上的队列是**回顾性存档标本**还是**可前瞻入组**？这一条决定选题往"机制解析"还是"标志物验证"走，两条路的选题风险差别很大。`,
      },
      { role: "user", text: "队列是回顾性存档标本，约 120 例配对组织；前瞻入组这两年做不了。" },
      {
        role: "bot", text: `明白。**选题遴选确认**已经走完 —— 候选选题、新颖性裁定、预注册三件事在这一格里做完了，结论如下。

### 一、候选选题与遴选结果

已把 3 个候选写进 \`topic_candidates.csv\`，按"与你现有基础的契合度 × 面上项目的体量"打分，**选定第 2 个**：

> **myCAF 亚群通过 XXX–YYY 轴重塑 CD8⁺ T 细胞空间排斥、介导胰腺癌 ICI 抵抗的机制研究**

选它的理由：你的 120 例配对组织正好能做空间转录组 + 多重免疫荧光的双重验证，不依赖前瞻入组；另外两个候选（FAP-CAR-T 联合方案、CAF 分型标准共识）分别卡在动物模型体量与多中心协作上，两年周期内做不完。

### 二、新颖性裁定：**增量创新**（不是"真新"，也不是"已被回答"）

- 同轴关系已有 2 篇在**肺腺癌**中报道（2024、2025），**胰腺癌中未见**——这是本课题的增量所在；
- 依据与逐条比对写在 \`novelty_report.md\`；
- ⚠️ 请注意裁定档位是「增量创新」而非「真新」：**立项依据里不要写"国际上首次"**，评审一查就翻车。按"首次在胰腺导管腺癌中阐明"来措辞更稳。

### 三、预注册已锁

\`preregistration.md\` 已把主假设、主要结局（CD8⁺ T 浸润密度）、样本量与主分析计划冻住 —— 后面出了阴性结果也不能回头改假设（anti-HARKing）。

接下来进入**标书初稿生成**。我会先按你上传的《2026 年度国自然项目指南》把本次实际采用的结构提纲与逐节字数硬限写成 \`要求卡-国自然面上.md\` 落盘，再逐节动笔。`,
      },
    ],
    artifacts: [{ name: "novelty_report.md", render: "report" }],
    products: ["topic_candidates.csv", "novelty_report.md", "preregistration.md"],
    files: {
      "topic_candidates.csv": [
        "候选选题,契合度,风险,两年可完成性,备注",
        '"FAP⁺ CAF 靶向 CAR-T 联合 PD-1 阻断的胰腺癌治疗方案",中,高,低,"需大体量动物模型，超出面上周期"',
        '"myCAF 亚群经 XXX–YYY 轴重塑 CD8⁺ T 空间排斥介导 ICI 抵抗",高,中,高,"✔ 选定：现有 120 例配对组织即可双重验证"',
        '"胰腺癌 CAF 分型标准的多中心共识与标志物验证",中,中,低,"依赖多中心协作，立项阶段不可控"',
      ].join("\n"),
      "novelty_report.md": `# 新颖性裁定报告

## 裁定结论：**增量创新**

| 维度 | 判定 | 依据 |
| --- | --- | --- |
| 同一机制轴是否已被报道 | 是（肺腺癌） | Kim 2024 (10.1038/s41467-024-xxxxx)；Ortega 2025 (10.1016/j.ccell.2025.xxxxx) |
| 是否已在胰腺癌中验证 | ⚠️ 本次检索未见 | PubMed / Europe PMC 检索式见附录，检索日 2026-08-07 |
| 是否已有临床转化 | 否 | 无相关注册试验 |

## ⚠️ 需要你注意的措辞风险

- 裁定为「增量创新」，**立项依据中不得写"国际上首次发现该机制轴"**——已有肺腺癌的两篇在先。
- 可用表述：\`首次在胰腺导管腺癌中阐明…\`、\`将该机制轴拓展至…\`。

## ✓ 已通过的核对项

- 检索式可复现，两个检索源结果一致
- 全部 2 条对照文献的 DOI 已逐条核实存在
- 未发现与本课题完全重合的在研项目（NSFC 结题库 2021–2025）
`,
    },
  },

  paper: {
    label: "SCI论文",
    values: {
      studyType: "retrospective",
      articleType: "original",
      topic: "术前中性粒细胞/淋巴细胞比值对结直肠癌根治术后 3 年无病生存的预测价值",
      materials: ["rawdata", "ethics"],
      dataFiles: ["结直肠癌队列_脱敏.xlsx"],
      deidDone: true,
      ethicsNo: "2025-伦审-研第 118 号",
      journalName: "",
      lang: "en",
    },
    done: ["stats", "table1", "integrity"],
    cur: "figure",
    sessionTitle: "NLR 预测结直肠癌术后无病生存",
    uploads: [
      { name: "结直肠癌队列_脱敏.xlsx", size: 386204 },
      { name: "随访记录补充.csv", size: 52310 },
      { name: "伦理批件扫描件.pdf", size: 1284770 },
    ],
    outputs: ["data_report.md", "table1.csv", "table1.docx", "analysis_summary.md"],
    turns: [
      { role: "user", text: "SCI 论文 · 研究与材料\n研究类型：回顾性队列；稿件类型：原创研究论文；主题：术前 NLR 对结直肠癌根治术后 3 年 DFS 的预测价值；已上传脱敏数据表与伦理批件；输出语言 English。" },
      {
        role: "bot", text: `已完成**数据体检与统计分析**、**基线表 Table 1** 与**源数据完整性自查**三步。先说体检，再说结果。

### 一、数据体检（\`结直肠癌队列_脱敏.xlsx\`，482 行 × 27 列）

| 检查项 | 结果 |
| --- | --- |
| 行列规模 | 482 例，27 个变量 |
| 缺失 | \`CEA\` 缺失 31 例（6.4%），\`随访月数\` 缺失 4 例（0.8%） |
| 取值越界 | 未发现 |
| 重复记录 | 未发现完全重复行 |
| 已脱敏 | 表内无姓名 / 住院号 / 身份证 / 联系方式列 ✅ |

\`\`\`text
提示：CEA 缺失 6.4% 已超过"可直接完整病例分析"的常规阈值（5%）。
本轮先按完整病例分析出结果，多重插补的敏感性分析建议在讨论里补一句，或让我另跑一版。
\`\`\`

### 二、Table 1（按 NLR 中位数二分组）

| 变量 | 低 NLR 组 (n=241) | 高 NLR 组 (n=241) | P | SMD |
| --- | --- | --- | ---: | ---: |
| 年龄，岁（mean ± SD） | 61.4 ± 10.2 | 63.8 ± 9.7 | 0.008 | 0.24 |
| 男性，n (%) | 138 (57.3) | 151 (62.7) | 0.23 | 0.11 |
| pT3–4，n (%) | 102 (42.3) | 149 (61.8) | <0.001 | 0.40 |
| 淋巴结阳性，n (%) | 88 (36.5) | 127 (52.7) | <0.001 | 0.33 |
| CEA > 5 ng/mL，n (%) | 61 (27.0) | 96 (42.5) | 0.001 | 0.33 |

> 连续变量用 t 检验、分类变量用未校正卡方（未用 Yates 校正，理由见 \`data_report.md\`）。**P 值与 SMD 一并给出**：样本量大时 P 容易显著，SMD > 0.1 才提示组间确有不均衡。

### 三、源数据完整性自查

对上传的数值表跑了一遍 sanity check：**没有发现需要你回原始记录核对的项**（无重复行、无常数偏移、无跨表复用、GRIM 一致）。这一步只出"待核信号"，通过不等于数据一定没问题，只表示这些自动检查没有报警。

### 四、我的判断

pT 分期与淋巴结状态在两组间显著不均衡，**单因素比较会高估 NLR 的作用**。建议 Cox 模型里把 pT、N 分期、CEA 作为协变量校正，这一条我已经写进 \`analysis_summary.md\`。

要我按这个设定继续出**出版级图表**（KM 曲线 + 森林图）吗？`,
      },
      { role: "user", text: "可以，KM 曲线按 NLR 二分组画，森林图放多因素 Cox 的结果。分辨率 600 dpi，期刊要求矢量图。" },
      {
        role: "bot", text: `收到。出图前先把口径跟你对一遍，避免出完再返工：

1. **KM 曲线**：终点用 3 年 DFS，横轴 0–36 个月，底部带 number-at-risk 表，组间比较用 log-rank。
2. **森林图**：多因素 Cox（校正 pT、N 分期、CEA、年龄），横轴对数刻度，参考线在 HR = 1。
3. **格式**：600 dpi PNG + 矢量 PDF 各一份；字体统一 Arial 7pt（多数期刊的图内最小字号要求）。

⚠️ 有一处要你拍板：**\`随访月数\` 缺失的 4 例**——KM 里是按最后一次随访时间删失处理，还是整例剔除？两种做法结果差别很小（中位 DFS 相差 0.3 个月），但方法学部分的措辞不一样，得写清楚。`,
      },
    ],
    artifacts: [],
    products: ["table1.docx", "data_report.md"],
    files: {},
  },
}

// ---------- 通用示例数据 ----------
const NOW = Date.UTC(2026, 7, 7, 6, 40) // 固定时间戳：重复导出的文件内容才是稳定的
const SID = "ws_demo000000"

function sessionsFor(scene, modId) {
  const t = (h) => NOW - h * 3600_000
  return {
    projects: [{ id: "pj_demo1", name: "肝癌免疫治疗课题" }],
    sessions: [
      { id: SID, title: scene.sessionTitle, updated: t(0), module: modId, moduleName: MODULE_DEFS[modId].name, pinned: false, projectId: null, running: false },
      { id: "ws_demo1", title: "国自然面上标书 · 立项依据初稿", updated: t(20), module: "grant", moduleName: "基金申报", pinned: true, projectId: null, running: false },
      { id: "ws_demo2", title: "IMbrave150 五年随访精读", updated: t(27), module: "litread", moduleName: "文献研读", pinned: false, projectId: "pj_demo1", running: false },
      { id: "ws_demo3", title: "队列基线表与生存分析", updated: t(49), module: "stats", moduleName: "数据统计与分析", pinned: false, projectId: "pj_demo1", running: false },
      { id: "ws_demo4", title: "投稿信润色", updated: t(73), module: "humanize", moduleName: "文章润色", pinned: false, projectId: null, running: false },
      { id: "ws_demo5", title: "随便问问：这个统计方法选得对吗", updated: t(96), module: "chat", moduleName: "自由对话", pinned: false, projectId: null, running: false },
    ],
  }
}

const COMMON = {
  "api/model": { gateway: true, modelID: "deepseek-v4-pro", cloud: { configured: true, loggedIn: true, mustChangePassword: false } },
  "api/models": {
    models: [
      { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "DeepSeek" },
      { model: "deepseek-v4", label: "DeepSeek V4", provider: "DeepSeek" },
      { model: "deepseek-r2", label: "DeepSeek R2（推理）", provider: "DeepSeek" },
    ],
  },
  "api/cloud/status": { configured: true, loggedIn: true, username: "李医生", profile: { tier: "标准版", tierName: "标准版", displayName: "李医生" } },
  "api/quota": {
    limit: 0, used: 0,
    cloud: {
      daily: { unlimited: false, remain: 3240, used: 760, limit: 4000, pct: 19 },
      monthly: { unlimited: false, remain: 41200, used: 8800, limit: 50000, pct: 18 },
      creditUsd: 0.01, stale: false,
    },
  },
  "api/storage": { used: 48 * 1048576, limit: 0 },
  "api/job": { running: false },
  // ★ 更新提示按要求全部关掉：无技能更新、无界面更新、无公告红点。
  "api/cloud/notice": { digest: [], keepDays: 180, skillUpdate: null, webUpdate: null },
  "api/zotero/status": { running: false, deployment: "multiuser" },
  "api/zotero/lib": { refs: [] },
  "api/zotero/collections": { collections: [] },
  "api/suggest": { suggestions: [] },
  "api/skillpacks/status": { current: null, update: null },
}

// ---------- 生成 ----------
const BANNER = (modName, variant) => `
<!-- ==================== DEMO-BLOCK 开始（设计预览稿注入，非产品代码） ====================
     这个文件是 web/index.html 的【原样副本】 + 下面这一段注入脚本。
     注入脚本只做一件事：拦下所有后端请求，用一份写死的示例数据作答，
     让页面脱离服务端也能按真实代码渲染出来（真实 CSS、真实组件、真实表单 schema）。

     当前预览：【${modName}】模块 · ${variant}

     · 美化完请把 DEMO-BLOCK 这一整段删掉，剩下的部分就能直接搬回 web/index.html。
     · 页面里的文献、数据、病例、评审意见【全部是虚构的占位内容】，不是真实结果。
     · 「技能更新 / 界面更新 / 平台公告」三条提示条已按要求关闭。
     · 输入框可以打字，但发送不会真的生成回答（没有后端）。
     ================================================================================== -->`

function fixtureScript(modId, variant) {
  const scene = SCENES[modId]
  const wfFull = WF.workflowFor(modId)
  const wfTrimmed = WF.workflowFor(modId, scene.values)
  const name = MODULE_DEFS[modId].name

  const data = {
    modId, variant, sid: SID,
    workflow: { ...wfFull, name },
    // /api/workflow/state 的回包（仅"对话进行中"用；首屏那版恒回 state:null）
    wfState: variant === "chat"
      ? { state: { module: modId, form: scene.values, done: scene.done, cur: scene.cur, failed: [], implied: [], stale: [] }, module: modId, name, steps: wfTrimmed.steps }
      : { state: null },
    modules: modulesPayload,
    sessions: sessionsFor(scene, modId),
    history: variant === "chat" ? scene.turns.map((t) => ({ role: t.role, text: t.text })) : [],
    outputs: variant === "chat" ? scene.outputs.map((n) => ({ name: n })) : [],
    uploads: variant === "chat" ? scene.uploads : [],
    artifacts: variant === "chat" ? scene.artifacts : [],
    products: variant === "chat" ? scene.products : [],
    files: scene.files || {},
    common: COMMON,
  }

  return `${BANNER(name, variant === "chat" ? "对话进行中" : "进入模块的首屏")}
<script>
;(function () {
  var D = ${JSON.stringify(data, null, 2)};

  // --- 预置本地状态：登录态、会话栏展开、当前会话 ---
  try {
    localStorage.setItem("nm_cloud_gated", "1");
    localStorage.removeItem("nm_locked");
    localStorage.setItem("nm_sessbar", "1");
    localStorage.removeItem("nm_collapsed");
    if (D.variant === "chat") localStorage.setItem("nm_sid", D.sid);
    else localStorage.removeItem("nm_sid");
  } catch (e) {}
  // 首屏那版靠 hash 把页面停在该模块的欢迎页（与从工作台点进来完全一致的路径）
  if (D.variant === "intake" && !location.hash) {
    try { history.replaceState(null, "", location.pathname + location.search + "#module=" + D.modId); } catch (e) {}
  }

  // --- fetch 拦截 ---
  var J = function (body, status) {
    return new Response(typeof body === "string" ? body : JSON.stringify(body),
      { status: status || 200, headers: { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" } });
  };
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var raw = String((input && input.url) || input || "");
    var qs = raw.indexOf("?") >= 0 ? raw.slice(raw.indexOf("?") + 1) : "";
    var path = raw.split("?")[0].replace(/^\\.?\\//, "");
    var q = new URLSearchParams(qs);

    if (D.common[path] !== undefined) return Promise.resolve(J(D.common[path]));
    if (path === "api/modules") return Promise.resolve(J({ modules: D.modules, entRev: "demo" }));
    if (/^api\\/modules\\/[^/]+\\/workflow$/.test(path)) {
      var mid = decodeURIComponent(path.split("/")[2]);
      return Promise.resolve(mid === D.modId ? J({ workflow: D.workflow }) : J({ workflow: null }));
    }
    if (path === "api/workflow/state") return Promise.resolve(J(D.wfState));
    if (path === "api/sessions") return Promise.resolve(J(D.sessions));
    if (path === "api/history") return Promise.resolve(J(D.history));
    if (path === "api/outputs") return Promise.resolve(J(D.outputs));
    if (path === "api/uploads") return Promise.resolve(J(D.uploads));
    if (path === "api/raw" || path === "api/preview" || path === "api/download") {
      var f = D.files[q.get("name") || ""];
      return Promise.resolve(f === undefined ? J("（预览稿没有内嵌这个文件的内容）", 404) : J(f));
    }
    if (path === "api/workflow/form") return Promise.resolve(J({ card: "（预览稿：这里本应回一张任务卡）", warnings: [] }));
    if (path === "api/chat/start") return Promise.resolve(J({ ok: false, err: "这是设计预览稿，没有连后端，不会真的生成回答。" }, 400));
    // 其余一律回空对象：没配到的接口在真实页面里也都有"拿不到就降级"的分支
    return Promise.resolve(J({}));
  };
  // SSE 在预览稿里不该真去连（file:// 下会直接报错刷屏）
  var NoopES = function () { this.close = function () {}; this.addEventListener = function () {}; };
  NoopES.CONNECTING = 0; NoopES.OPEN = 1; NoopES.CLOSED = 2;
  window.EventSource = NoopES;

  // --- 页面渲染完之后，把只有"生成过程中"才会出现的几个组件补上 ---
  // （结构化文献卡片 / 产物下载卡 / 下一步表单卡 —— 它们平时由 SSE 事件驱动，
  //   静态预览稿里手动调一次同样的函数，用的是产品里那份真实实现。）
  if (D.variant === "chat") {
    window.addEventListener("load", function () {
      var tries = 0;
      var timer = setInterval(function () {
        var msgs = document.querySelectorAll("#log .msg");
        if (msgs.length < D.history.length) { if (++tries > 60) clearInterval(timer); return; }
        clearInterval(timer);
        var last = msgs[msgs.length - 1];
        try { if (D.artifacts.length && window.renderArtifacts) window.renderArtifacts(D.artifacts); } catch (e) {}
        try { if (D.products.length && window.addProducts) window.addProducts(D.products); } catch (e) {}
        try { if (window.offerStepForm) window.offerStepForm(last); } catch (e) {}
        // 发消息不会真的起轮：给个明确提示，别让人以为页面坏了
        if (window.sendMessage) {
          window.sendMessage = function (text) {
            if (!text) return;
            var b = window.add ? window.add("user", text) : null;
            setTimeout(function () { if (window.add) window.add("bot", "**这是设计预览稿**，没有连接后台，不会真的生成回答。要看真实效果请在应用里操作。"); }, 250);
            return b;
          };
        }
      }, 120);
    });
  }
})();
</script>
<!-- ==================== DEMO-BLOCK 结束 ==================== -->
`
}

const base = await readFile(join(ROOT, "web", "index.html"), "utf8")
if ((base.match(/<script>/g) || []).length !== 1) {
  throw new Error("web/index.html 里 <script> 标签不止一个了 —— 注入点要重新确认，别盲目替换")
}

await mkdir(OUT_DIR, { recursive: true })
const written = []
for (const modId of ["review", "grant", "paper"]) {
  for (const variant of ["intake", "chat"]) {
    const html = base.replace("<script>", fixtureScript(modId, variant) + "<script>")
    const file = join(OUT_DIR, `${SCENES[modId].label}-${variant === "intake" ? "首屏表单" : "对话进行中"}.html`)
    await writeFile(file, html, "utf8")
    written.push(file)
  }
}
console.log("已导出：\n" + written.map((f) => "  " + f).join("\n"))
