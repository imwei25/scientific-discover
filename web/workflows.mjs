// 模块工作流定义：每个受限模块「走哪几步、每步要用户填什么、产出什么、怎么渲染」的唯一事实来源。
//
// 【为什么单独一个文件】它同时喂三处，写在 server.mjs 里会被淹掉：
//   ① 模块的技能白名单 —— MODULE_DEFS.skills 由 skillsOf() 从 steps 展开（此前是手写数组，
//      结果与 AGENTS.md §三 的路由表漂了：paper 缺了脱敏/统计/作图整个前半段、litread 缺排版）。
//      一份定义两用，从此不会再漂。
//   ② 前端表单 —— /api/modules/<id>/workflow 下发 schema，前端只当渲染器。改流程走「界面包」
//      热更新即可，不用重发桌面安装包。
//   ③ 任务卡 —— 表单值经 taskCard() 序列化成 【任务卡 · …】 文本块，拼在用户第一条消息前面。
//      这条路是抄 index.html 的 zScopePrefix()（Zotero 检索范围前缀），实测有效、零 opencode 改动。
//
// 【设计铁律：只灌初值 + 观察呈现，不做硬状态机】
// agent 会合并步骤、会跳步、会按 AGENTS.md §二 自己回退。服务端若强行卡「必须按序」，就会与它的
// 自主推进正面打架，产生「它已经做完了但界面卡在第 3 步」的死结。所以本模块【不阻断】任何东西：
// 表单填完 → 拼进消息；产物出现 → 反推进度；闸不过 → 给个返工按钮。用户随时可以跳过表单直接打字。
//
// 【系统综述 / Meta 不在此列】systematic-review 技能不属于任何模块，只能从「自由对话」调用
// （2026-08-04 决定）。综述模块的表单底部有一行固定指路，别让它成为哑失败。

// ---- 条件表达式（声明式，不用 eval）----
// 形如 { field:"hasRawData", has:"rawdata" } / { field:"studyType", in:["rct","prospective"] }
// / { field:"deidDone", eq:false }。前端与服务端共用同一套判定，行为必然一致。
export function condOk(cond, values) {
  if (!cond) return true
  if (Array.isArray(cond)) return cond.every((c) => condOk(c, values))   // 数组 = 全部成立（AND）
  const v = values?.[cond.field]
  if ("eq" in cond) return v === cond.eq
  if ("ne" in cond) return v !== cond.ne
  if ("in" in cond) return cond.in.includes(v)
  if ("has" in cond) return Array.isArray(v) && v.includes(cond.has)   // 多选题里勾了某项
  if ("hasNot" in cond) return !Array.isArray(v) || !v.includes(cond.hasNot)
  if ("truthy" in cond) return cond.truthy ? !!v : !v
  return true
}

/** 字段/步骤是否显示：when 全部成立（AND）且 whenAny 至少一条成立（OR）。两者都可缺省。 */
export const visible = (f, values) =>
  condOk(f?.when, values) && (!f?.whenAny || f.whenAny.some((c) => condOk(c, values)))
/** 是否必填：required 恒真，或 requiredWhen 条件成立（如"勾了数据完整性才必须传数值表"） */
export const isRequired = (f, values) => !!f?.required || (!!f?.requiredWhen && condOk(f.requiredWhen, values))

// ---- 字段类型 ----
// text/textarea/number/select/multi/bool ：常规控件
// range      ：两个数字（min/max），值形如 {min,max}
// files      ：从本会话 uploads/ 里挑（前端拉 /api/uploads 填充）
// columns    ：从某个已上传数据表的表头里挑（前端拉 /api/data/headers 填充，见下方说明）
//
// ★ columns 是 stats/paper 最值钱的一个控件：「列名猜错/写错」是当前最高频的失败模式，
//   从真实表头下拉能从根上消灭它。source 指向同表单里那个 files 字段的 id。

const LANG = { id: "lang", label: "输出语言", type: "select", default: "zh",
  options: [{ v: "zh", t: "中文" }, { v: "en", t: "English" }] }

// 期刊筛选：一组字段，多个模块复用。**筛的是"检索到的文献发表在什么刊上"，不是"你想投哪本刊"。**
//
// ⚠️ 两条必须守住的措辞：
// ① 官方 JCR IF 与中科院分区是授权数据，本产品没有、也不能内置分发。默认档用 OpenAlex 的
//    两年篇均被引作近似分级，所以标签一律写「影响力（近似）」，绝不写成 IF / 分区 ——
//    那等于凭空造数（不虚构是本平台的硬性规定）。用户传了本机构的分区表才切精确档并标明来源。
// ② 在 SCI 论文表单里，这组字段紧跟在"目标期刊梯队/具体期刊"后面，实测会被百分之百读成
//    "我想投的刊影响因子几到几"。所以字段名写死成「**文献来源期刊**的影响力」，并靠 section
//    分组把它和目标期刊隔开。别为了简洁把"文献来源期刊"这五个字删掉。
const JOURNAL_FILTER = [
  { id: "jImpact", label: "文献来源期刊的影响力（近似值）", type: "range", min: 0, max: 100, step: 0.1,
    unit: "两年篇均被引", section: "检索到的文献要满足什么条件",
    help: "筛的是「检索结果」发表在什么刊上，不是你想投的刊。这个数来自 OpenAlex 的两年篇均被引，"
        + "跟影响因子算法思路相近但口径不同，不是官方影响因子。留空 = 不筛。" },
  { id: "jQuartile", label: "影响力档位（近似）", type: "multi", options: [
    { v: "Q1", t: "前 25%（Q1）" }, { v: "Q2", t: "前 50%（Q2）" }, { v: "Q3", t: "后 50%（Q3）" }, { v: "Q4", t: "后 25%（Q4）" }],
    help: "按检索结果里各刊影响力排序分四档，近似替代「分区」的说法，不是中科院或 JCR 分区。" },
  { id: "jOA", label: "只保留开放获取（OA）的文献", type: "bool", default: false,
    help: "OA = 不用订阅就能下到全文。勾上后只保留这类文献，能显著提高后续「全文获取」的成功率。" },
]

// ---- 各模块工作流 ----
export const WORKFLOWS = {

  // ============ SCI 论文（样板：最复杂的一条，12 步）============
  paper: {
    primary: "write-paper",
    intakeTitle: "立项确认",
    intake: [
      { id: "studyType", label: "研究类型", type: "select", required: true, options: [
        { v: "retrospective", t: "回顾性队列" }, { v: "prospective", t: "前瞻性队列" },
        { v: "rct", t: "随机对照试验（RCT）" }, { v: "diagnostic", t: "诊断准确性研究" },
        { v: "casecontrol", t: "病例对照" }, { v: "crosssection", t: "横断面" },
        { v: "caseseries", t: "病例系列 / 个案" }, { v: "basic", t: "体外 / 动物实验" }],
        help: "决定流程走法：前瞻性与 RCT 会把新颖性裁定提到最前做预注册锁；诊断准确性研究通常无人口学基线，会跳过基线表那步。" },
      { id: "articleType", label: "稿件类型", type: "select", default: "original", options: [
        { v: "original", t: "Original Article" }, { v: "brief", t: "Brief Report" },
        { v: "case", t: "Case Report" }, { v: "letter", t: "Letter / Correspondence" }] },
      { id: "topic", label: "研究主题一句话", type: "textarea", required: true,
        placeholder: "例：术前中性粒细胞/淋巴细胞比值对胃癌根治术后 3 年生存的预测价值" },
      { id: "materials", label: "已有材料", type: "multi", options: [
        { v: "rawdata", t: "原始数据表（xlsx/csv）" }, { v: "draft", t: "已有初稿" },
        { v: "figures", t: "已有图表" }, { v: "ethics", t: "伦理批件号" },
        { v: "registry", t: "临床试验注册号" }, { v: "refs", t: "参考文献库（bib/Zotero）" }],
        help: "没有的不用勾，缺的会在对应步骤问你要，绝不替你编。" },
      { id: "dataFiles", label: "数据文件", type: "files", when: { field: "materials", has: "rawdata" },
        help: "从「上传数据」里挑。没上传的先去左侧上传。" },
      { id: "deidDone", label: "这份数据已经脱敏过了", type: "bool", default: false,
        when: { field: "materials", has: "rawdata" },
        help: "没脱敏的话流程会自动先做一步脱敏 —— 含患者信息的数据未脱敏不得进入任何统计，这是平台的硬性规定。" },
      { id: "draftFiles", label: "已有的初稿 / 图表 / 文献库文件", type: "files",
        whenAny: [{ field: "materials", has: "draft" }, { field: "materials", has: "figures" }, { field: "materials", has: "refs" }],
        help: "从「上传数据」里挑。勾了「已有初稿 / 已有图表 / 参考文献库」就得把文件传上来，否则那几项等于没说。" },
      { id: "ethicsNo", label: "伦理批件号", type: "text", when: { field: "materials", has: "ethics" },
        placeholder: "原样填写，没有就留空（会标『待补充』，不会编造）" },
      { id: "registryNo", label: "临床试验注册号", type: "text", when: { field: "materials", has: "registry" },
        placeholder: "如 NCT01234567 / ChiCTR2400000000；没有就留空（会标『待补充』，不会编造）" },
      { id: "journalTier", label: "目标期刊梯队", type: "select", default: "target", options: [
        { v: "target", t: "target 主投（推荐）" }, { v: "reach", t: "reach 冲刺" }, { v: "safety", t: "safety 保底" }],
        help: "投稿前就想好被拒后下一站，省来回。" },
      { id: "journalName", label: "已经想好具体期刊", type: "text",
        placeholder: "填了就按该刊稿约排版；留空则用通用送审格式" },
      ...JOURNAL_FILTER,
      LANG,
    ],
    steps: [
      { id: "deid", name: "数据脱敏", skill: "deidentify",
        // ★ 用 truthy:false 而不是 eq:false —— 它同时覆盖 undefined。
        //   用户没碰过"已脱敏"这个开关时值是 undefined，若写 eq:false 就判不成立、脱敏步被整个剔掉，
        //   而这恰恰是最该插脱敏的情形（含患者信息且未声明脱敏）。方向必须 fail-safe：
        //   没明说脱敏过 = 当作没脱敏（AGENTS.md §五 硬规矩）。
        when: [{ field: "materials", has: "rawdata" }, { field: "deidDone", truthy: false }],
        emits: ["deid_*.csv", "deid_*.xlsx", "deid_report.md"], render: "report",
        hint: "含患者信息的数据未脱敏不得进入统计" },
      { id: "stats", name: "数据体检与统计分析", skill: "data-analysis",
        when: { field: "materials", has: "rawdata" },
        form: [
          { id: "analyses", label: "要做的分析", type: "multi", options: [
            { v: "desc", t: "描述性统计" }, { v: "compare", t: "组间比较" },
            { v: "corr", t: "相关 / 回归" }, { v: "survival", t: "生存分析（KM / Cox）" },
            { v: "roc", t: "ROC / 诊断效能" }, { v: "agreement", t: "方法比对（Bland-Altman / Passing-Bablok）" },
            { v: "repeated", t: "重复测量 / 纵向" }] },
          { id: "groupCol", label: "分组列", type: "columns", source: "dataFiles",
            help: "区分组别的那一列，如 治疗组/对照组、手术方式。" },
          { id: "outcomeCol", label: "结局列", type: "columns", source: "dataFiles",
            help: "你要解释或预测的那个结果，如 是否复发、住院天数。" },
          { id: "timeCol", label: "随访时间列（生存分析用）", type: "columns", source: "dataFiles",
            when: { field: "analyses", has: "survival" },
            help: "从起点到终点事件或末次随访的时长。" },
          { id: "eventCol", label: "终点事件列（生存分析用）", type: "columns", source: "dataFiles",
            when: { field: "analyses", has: "survival" },
            help: "1 = 事件发生，0 = 删失。" },
          { id: "covars", label: "需要校正的协变量", type: "columns", source: "dataFiles", multiple: true,
            help: "多因素分析里要一并放进模型的因素，如 年龄、性别、分期。" },
        ],
        emits: ["data_profile.md", "cleaning_log.md", "stats_*.csv", "*_results.csv"], render: "table" },
      { id: "table1", name: "基线表 Table 1", skill: "clinical-stats",
        // AGENTS.md §三 表下注：诊断准确性 / 方法比对 / 纯实验室验证类研究常无人口学基线协变量，
        // 此时 Table 1 无对应数据，整步跳过，别把检测值硬塞成"基线表"制造误导。
        when: [{ field: "materials", has: "rawdata" }, { field: "studyType", in: ["retrospective", "prospective", "rct", "casecontrol", "crosssection"] }],
        emits: ["table1.csv"], render: "table" },
      { id: "integrity", name: "源数据完整性自查", skill: "data-integrity", optional: true, gate: true,
        when: { field: "materials", has: "rawdata" },
        emits: ["integrity_report.md", "audit/*"], render: "integrity", onFail: "stats",
        hint: "投稿前主动核对补说明，只出待核信号、不下造假结论" },
      { id: "figure", name: "出版级图表", skill: "nature-figure",
        form: [
          { id: "figTypes", label: "要出的图", type: "multi", options: [
            { v: "forest", t: "森林图" }, { v: "km", t: "生存曲线 KM" }, { v: "volcano", t: "火山图" },
            { v: "roc", t: "ROC 曲线" }, { v: "bar", t: "柱状 / 箱线" }, { v: "flow", t: "流程图" }] },
          { id: "figDpi", label: "分辨率", type: "select", default: "300", options: [
            { v: "300", t: "300 dpi（多数期刊最低要求）" }, { v: "600", t: "600 dpi（线条图）" }] },
        ],
        emits: ["fig*.png", "fig*.pdf", "fig*.svg", "figures/*"], render: "figure" },
      { id: "novelty", name: "新颖性裁定 / 预注册", skill: "novelty-check", optional: true,
        // 前瞻性与 RCT：必须在采数前把假设与主分析计划冻住 → 提到最前；回顾性研究已有数据，
        // 无法再"采数前预注册"，这步降级为可选的新颖性裁定（AGENTS.md §三 表下注）。
        first: { field: "studyType", in: ["prospective", "rct"] },
        emits: ["novelty_report.md", "preregistration.md"], render: "report" },
      { id: "litreview", name: "文献综述", skill: "literature-review",
        form: [
          { id: "query", label: "检索式 / 关键词", type: "textarea",
            placeholder: "留空则由 AI 依据研究主题自拟检索式" },
          { id: "years", label: "时间范围", type: "select", default: "10", options: [
            { v: "5", t: "近 5 年" }, { v: "10", t: "近 10 年" }, { v: "0", t: "不限" }] },
          { id: "limit", label: "文献数量上限", type: "number", default: 40, min: 5, max: 200 },
        ],
        emits: ["evidence_table.csv", "evidence.md", "refs.bib"], render: "evidence",
        hint: "引言与讨论的文献部分基于本步综述撰写；综述单薄是回退触发点" },
      { id: "write", name: "撰写正文", skill: "write-paper",
        form: [{ id: "sections", label: "要写的章节", type: "multi",
          default: ["title", "abstract", "intro", "methods", "results", "discussion"],
          options: [{ v: "title", t: "标题" }, { v: "abstract", t: "摘要" }, { v: "intro", t: "引言" },
            { v: "methods", t: "方法" }, { v: "results", t: "结果" }, { v: "discussion", t: "讨论" },
            { v: "limitations", t: "局限性" }, { v: "cover", t: "投稿信 Cover Letter" }] }],
        emits: ["manuscript.md", "manuscript_*.md"], render: "manuscript" },
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        emits: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"],
        render: "refcheck", onFail: "write",
        hint: "查假引用 / 核 DOI，全绿才往下排版" },
      { id: "humanize", name: "语言润色", skill: "humanize-academic",
        form: [
          { id: "strength", label: "润色强度", type: "select", default: "standard", options: [
            { v: "light", t: "保守（只动明显 AI 腔）" }, { v: "standard", t: "标准（推荐）" },
            { v: "heavy", t: "激进（重写句式节奏）" }] },
          { id: "protectRefs", label: "不要改动引用处的文字", type: "bool", default: true,
            help: "改了引用文字会自动重跑一次引用核查兜底。" },
        ],
        emits: ["manuscript_humanized.md", "*_humanized.md"], render: "diff" },
      { id: "review", name: "投稿前自审", skill: "peer-review", gate: true,
        form: [{ id: "roles", label: "审稿视角", type: "multi",
          default: ["method", "stats"], options: [
            { v: "method", t: "方法学审稿人" }, { v: "stats", t: "统计审稿人" },
            { v: "clinical", t: "临床审稿人" }, { v: "editor", t: "编辑（是否送审）" }] }],
        emits: ["review_report.md"], render: "review", onFail: "write",
        hint: "发现设计/统计/结果硬伤则回上游返工" },
      { id: "render", name: "排版出件", skill: "render-docx",
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        emits: ["*.docx", "*.pdf"], render: "doc",
        hint: "没指定期刊就用通用送审格式，交付时附查重工具推荐" },
    ],
    extra: ["search-lit", "fulltext-retrieval", "render-pdf-doc"],
  },

  // ============ 综述撰写（叙述性）============
  review: {
    primary: "literature-review",
    intakeTitle: "选题与检索范围",
    // ⚠️ 这一行会显示在表单底部：系统综述不属于任何模块，必须给用户指路，别成哑失败。
    footnote: "需要双人独立筛选 / PRISMA 流程图 / 偏倚风险 RoB / GRADE 这类方法学强度的**系统综述或 Meta 分析**，请到「自由对话」模块 —— 本模块做的是叙述性综述。",
    intake: [
      { id: "topic", label: "综述主题", type: "textarea", required: true,
        placeholder: "例：PD-1 抑制剂在肝细胞癌一线治疗中的进展与争议" },
      { id: "pico", label: "研究问题的四要素（填了检索会精准很多）", type: "textarea",
        placeholder: "人群：晚期肝细胞癌初治患者　干预：PD-1 抑制剂联合靶向　对照：单药靶向　结局：总生存期",
        help: "就是临床研究里常说的 PICO：人群(P) / 干预(I) / 对照(C) / 结局(O)，每项一行或用空格隔开都行。不确定就留空，照样能检索。" },
      { id: "years", label: "时间范围", type: "select", default: "10", options: [
        { v: "3", t: "近 3 年" }, { v: "5", t: "近 5 年" }, { v: "10", t: "近 10 年" }, { v: "0", t: "不限" }] },
      { id: "designs", label: "纳入的研究设计", type: "multi", options: [
        { v: "rct", t: "随机对照试验" }, { v: "cohort", t: "队列研究" }, { v: "casecontrol", t: "病例对照" },
        { v: "crosssection", t: "横断面" }, { v: "review", t: "综述 / 指南" }, { v: "basic", t: "基础研究" }] },
      { id: "limit", label: "最多检索多少篇", type: "number", default: 50, min: 10, max: 300, unit: "篇",
        help: "指检索阶段的召回上限；后面还会按你的条件筛，最终纳入的通常少于这个数。" },
      ...JOURNAL_FILTER,
      { id: "length", label: "目标篇幅", type: "select", default: "4000", options: [
        { v: "2000", t: "约 2000 字（短综述）" }, { v: "4000", t: "约 4000 字（推荐）" },
        { v: "8000", t: "约 8000 字（长篇）" }] },
      { id: "fulltext", label: "尝试下载开放获取全文", type: "bool", default: false,
        help: "只下 OA 渠道能拿到的；下不到的会如实列出原因，不会假装拿到了。" },
      LANG,
    ],
    steps: [
      { id: "search", name: "文献检索", skill: "search-lit",
        emits: ["evidence_table.csv", "evidence.md", "refs.bib"], render: "evidence",
        hint: "每条引用都经 API 核实，不凭记忆造引用" },
      { id: "screen", name: "纳入 / 排除筛选", skill: "literature-review",
        form: [{ id: "excluded", label: "排除的文献", type: "picklist", source: "evidence_table.csv",
          help: "在上一步的文献卡片里勾掉不要的，这里会同步。留空 = 全部纳入。" }],
        emits: ["screening_log.md", "included.csv"], render: "table" },
      { id: "fulltext", name: "全文获取", skill: "fulltext-retrieval", optional: true,
        when: { field: "fulltext", eq: true },
        emits: ["pdfs/*", "retrieval_report.json", "manual_needed.txt"], render: "retrieval",
        hint: "如实区分哪些下到了、哪些没下到及原因" },
      { id: "write", name: "综述成文", skill: "literature-review",
        emits: ["review.md", "literature_review.md", "*_review.md"], render: "manuscript" },
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        emits: ["refcheck_report.md", "reference_check*.md"], render: "refcheck", onFail: "write" },
      { id: "humanize", name: "语言润色", skill: "humanize-academic", optional: true,
        emits: ["*_humanized.md"], render: "diff" },
      { id: "render", name: "排版出件", skill: "render-pdf-doc",
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        emits: ["*.docx", "*.pdf"], render: "doc" },
    ],
    extra: ["render-docx"],
  },

  // ============ 基金申报 ============
  grant: {
    primary: "grant-proposal",
    intakeTitle: "标书立项信息",
    intake: [
      { id: "funder", label: "资助渠道", type: "select", required: true, options: [
        { v: "nsfc-general", t: "国自然 面上项目" }, { v: "nsfc-young", t: "国自然 青年科学基金" },
        { v: "nsfc-region", t: "国自然 地区科学基金" }, { v: "provincial", t: "省 / 市级基金" },
        { v: "hospital", t: "院级 / 校级课题" }, { v: "other", t: "其它" }],
        help: "选「其它」的话，下面要写清楚是哪个渠道 —— 不同渠道的正文结构和字数要求差别很大。" },
      { id: "funderOther", label: "具体是哪个资助渠道", type: "text", when: { field: "funder", eq: "other" },
        required: true, placeholder: "例：中华医学会临床医学科研专项 / 某某市卫健委面上项目" },
      { id: "discipline", label: "申请代码 / 学部方向", type: "text",
        placeholder: "例：H16 消化系统；不确定可留空，会给建议" },
      { id: "applicant", label: "申请人身份", type: "select", required: true, options: [
        { v: "student", t: "在读研究生" }, { v: "postdoc", t: "博士后" }, { v: "lecturer", t: "讲师 / 主治" },
        { v: "associate", t: "副高" }, { v: "professor", t: "正高" }],
        help: "决定选题的体量与风险偏好 —— 青年基金和面上项目的选题策略完全不同。" },
      { id: "direction", label: "研究方向", type: "textarea", required: true,
        placeholder: "你想做的大方向，越具体越好；还没定也可以只写领域，会帮你收敛" },
      { id: "basis", label: "已有工作基础", type: "multi", options: [
        { v: "papers", t: "代表作 / 已发表论文" }, { v: "preliminary", t: "预实验数据" },
        { v: "platform", t: "平台 / 设备条件" }, { v: "cohort", t: "已有样本库 / 队列" },
        { v: "none", t: "暂无（从零开始）", exclusive: true }] },
      { id: "basisFiles", label: "上传代表作 / 预实验材料", type: "files",
        when: { field: "basis", hasNot: "none" } },
      { id: "deadline", label: "申报截止日期", type: "date",
        help: "填了会按剩余时间安排步骤的详略；不填也能写。" },
      { id: "wordLimit", label: "正文字数上限", type: "number", min: 1000, max: 100000, unit: "字",
        placeholder: "留空 = 按所选渠道的常规要求",
        help: "留空即可，系统会按该渠道的通行要求控制篇幅。" },
      LANG,
    ],
    steps: [
      { id: "scan", name: "领域扫描", skill: "research-scan",
        emits: ["research_scan*.md", "landscape*.csv"], render: "report",
        hint: "没搜到 ≠ 研究空白，四象限采样后再下判断" },
      { id: "topic", name: "选题收敛", skill: "topic-selection",
        emits: ["topic_candidates*.csv", "topic_selection*.md"], render: "topics",
        hint: "候选选题会列成卡片，你选一个再往下" },
      { id: "novelty", name: "新颖性裁定与预注册", skill: "novelty-check", gate: true,
        emits: ["novelty_report.md", "preregistration.md"], render: "report", onFail: "topic" },
      { id: "write", name: "标书成文", skill: "grant-proposal",
        form: [{ id: "sections", label: "要写的章节", type: "multi",
          default: ["basis", "content", "route", "foundation", "condition"],
          options: [{ v: "basis", t: "立项依据" }, { v: "content", t: "研究内容与目标" },
            { v: "route", t: "研究方案与技术路线" }, { v: "feature", t: "特色与创新" },
            { v: "foundation", t: "研究基础" }, { v: "condition", t: "工作条件" },
            { v: "budget", t: "经费预算说明" }] }],
        emits: ["proposal.md", "grant_proposal*.md"], render: "manuscript" },
      { id: "review", name: "评审自查", skill: "peer-review", gate: true,
        emits: ["review_report.md"], render: "review", onFail: "write" },
      { id: "render", name: "排版出件", skill: "render-pdf-doc",
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        emits: ["*.docx", "*.pdf"], render: "doc" },
    ],
    extra: ["render-docx"],
  },

  // ============ 文献研读 ============
  litread: {
    primary: "search-lit",
    intakeTitle: "研读设置",
    intake: [
      { id: "mode", label: "怎么读", type: "select", required: true, default: "scan", options: [
        { v: "scan", t: "快速扫描（摸清一个方向有什么）" },
        { v: "deep", t: "深度研究（把一个问题挖到底）" },
        { v: "rag", t: "下载全文后基于原文问答（回答时逐句给出处）", sets: { fulltext: true } }] },
      { id: "topic", label: "主题 / 问题", type: "textarea", required: true,
        placeholder: "例：CAR-T 治疗实体瘤当前的主要瓶颈是什么，近三年有哪些突破方向" },
      { id: "sources", label: "检索源", type: "multi", default: ["epmc"], options: [
        { v: "epmc", t: "Europe PMC（国内可达，推荐）" }, { v: "pubmed", t: "PubMed / NCBI（需境外网络）" },
        { v: "s2", t: "Semantic Scholar" }, { v: "openalex", t: "OpenAlex" },
        { v: "preprint", t: "预印本 bioRxiv / medRxiv" }],
        help: "国内网络下 NCBI 常被阻断，勾了也可能自动降级到 Europe PMC，会如实告知。" },
      { id: "years", label: "时间范围", type: "select", default: "5", options: [
        { v: "3", t: "近 3 年" }, { v: "5", t: "近 5 年" }, { v: "10", t: "近 10 年" }, { v: "0", t: "不限" }] },
      { id: "limit", label: "最多检索多少篇", type: "number", default: 30, min: 5, max: 200, unit: "篇" },
      ...JOURNAL_FILTER,
      { id: "fulltext", label: "尝试下载开放获取全文", type: "bool", default: false },
      { id: "toZotero", label: "把结果推进本机 Zotero", type: "bool", default: false,
        help: "仅在与 Zotero 同机运行时可用；只写题录，不含 PDF 附件。" },
      LANG,
    ],
    steps: [
      { id: "search", name: "文献检索", skill: "search-lit",
        emits: ["evidence_table.csv", "evidence.md", "refs.bib"], render: "evidence" },
      { id: "fulltext", name: "全文获取", skill: "fulltext-retrieval", optional: true,
        when: { field: "fulltext", eq: true },
        emits: ["pdfs/*", "zotero_lib/*", "retrieval_report.json", "manual_needed.txt"], render: "retrieval",
        hint: "只把真正下到 PDF 的算入小库，没下到的列出原因" },
      { id: "rag", name: "基于全文问答", skill: "zotero-library", optional: true,
        when: { field: "mode", eq: "rag" },
        emits: ["zotero_evidence.csv", "rag_*.md"], render: "evidence" },
      { id: "deep", name: "深度研究", skill: "deep-research", optional: true,
        when: { field: "mode", eq: "deep" },
        emits: ["research_report*.md", "deep_research*.md"], render: "manuscript" },
      { id: "digest", name: "研读综述", skill: "literature-review", optional: true,
        when: { field: "mode", eq: "scan" },
        emits: ["review.md", "digest*.md", "*_review.md"], render: "manuscript" },
      { id: "render", name: "出件", skill: "render-pdf-doc", optional: true,
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "pdf", options: [
          { v: "pdf", t: "PDF" }, { v: "docx", t: "Word（.docx）" }] }],
        emits: ["*.pdf", "*.docx"], render: "doc" },
    ],
    extra: ["research-scan", "render-docx"],
  },

  // ============ 数据统计与分析 ============
  stats: {
    primary: "data-analysis",
    intakeTitle: "数据与分析设置",
    intake: [
      { id: "dataFiles", label: "数据文件", type: "files",
        // ★ 不能无条件必填：「样本量 / 把握度」是【做研究之前】算要收多少例的，此时根本没有数据。
        //   之前写死 required 的结果是——设计课题的医生一进来就被"还没填：数据文件"挡住，
        //   等于"想算样本量？先去伪造一份数据"。
        requiredWhen: { field: "analyses", hasNot: "power" },
        help: "从左侧「上传数据」里挑。选好后下面的变量映射会自动读出真实表头。只算样本量 / 把握度的话不用传数据。" },
      { id: "hasPHI", label: "数据里含患者身份信息（姓名/住院号/身份证/住址等）", type: "bool", default: false,
        help: "勾上会先做脱敏再分析 —— 未脱敏的患者数据不得进入统计，这是平台的硬性规定。" },
      { id: "analyses", label: "要做的分析", type: "multi", required: true, options: [
        { v: "profile", t: "数据体检（缺失 / 异常 / 重复 ID）" },
        { v: "desc", t: "描述性统计" }, { v: "table1", t: "基线表 Table 1" },
        { v: "compare", t: "组间比较" }, { v: "corr", t: "相关 / 回归" },
        { v: "survival", t: "生存分析（KM / Cox）" }, { v: "roc", t: "ROC / 诊断效能" },
        { v: "agreement", t: "方法比对（Bland-Altman / Passing-Bablok）" },
        { v: "repeated", t: "重复测量 / 纵向" }, { v: "power", t: "样本量 / 把握度" }],
        help: "建议先勾「数据体检」—— 重复 ID 没去、分类水平没归一时，后面每个 p 值都是错的，而表面看不出来。" },
      // 六个"列"长得一模一样，各自属于哪个分析必须写在 help 里，否则一定填串
      { id: "groupCol", label: "分组列", type: "columns", source: "dataFiles",
        section: "把分析用到的变量对到你表里的列",
        // Table 1 的本质就是"按组分列对比"，勾了它却不给选分组列是说不通的
        whenAny: [{ field: "analyses", has: "compare" }, { field: "analyses", has: "table1" }],
        help: "区分组别的那一列，如 治疗组/对照组、手术方式。用于基线表与组间比较。" },
      { id: "outcomeCol", label: "结局列", type: "columns", source: "dataFiles",
        help: "你要解释或预测的那个结果，如 是否复发、住院天数、缓解与否。" },
      { id: "timeCol", label: "随访时间列（生存分析用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "survival" },
        help: "从起点到终点事件或末次随访的时长，如 随访月数。" },
      { id: "eventCol", label: "终点事件列（生存分析用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "survival" },
        help: "1 = 事件发生（死亡/复发），0 = 删失（失访或随访结束时仍无事件）。" },
      { id: "testCol", label: "待评价指标列（ROC 用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "roc" },
        help: "你想评价诊断效能的那个检测值，如 某标志物浓度、某评分。" },
      { id: "goldCol", label: "金标准列（ROC 用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "roc" },
        help: "公认的确诊依据，如 病理结果。1 = 有病，0 = 无病。" },
      { id: "covars", label: "需要校正的协变量", type: "columns", source: "dataFiles", multiple: true,
        help: "多因素分析里要一并放进模型的因素，如 年龄、性别、分期。可多选，也可不选。" },
      { id: "figs", label: "顺便出投稿级图", type: "bool", default: false,
        help: "300dpi + 矢量，可直接投稿；不勾则只给 150dpi 预览图。" },
      LANG,
    ],
    steps: [
      { id: "deid", name: "数据脱敏", skill: "deidentify", when: { field: "hasPHI", eq: true },
        emits: ["deid_*.csv", "deid_*.xlsx", "deid_report.md"], render: "report" },
      { id: "profile", name: "数据体检", skill: "data-analysis",
        emits: ["data_profile.md", "cleaning_log.md"], render: "report",
        hint: "重复 ID / 分类水平不一致 / 分组缺失必须先清，否则后面每个 p 都是错的" },
      { id: "table1", name: "基线表 Table 1", skill: "clinical-stats",
        when: { field: "analyses", has: "table1" },
        emits: ["table1.csv"], render: "table" },
      { id: "analyze", name: "统计分析", skill: "data-analysis",
        emits: ["stats_*.csv", "*_results.csv", "analysis*.md"], render: "table" },
      { id: "figure", name: "出版级图表", skill: "nature-figure", when: { field: "figs", eq: true },
        emits: ["fig*.png", "fig*.pdf", "fig*.svg", "figures/*"], render: "figure" },
      { id: "integrity", name: "源数据完整性自查", skill: "data-integrity", optional: true, gate: true,
        emits: ["integrity_report.md", "audit/*"], render: "integrity", onFail: "analyze" },
    ],
    // 出完基线表/结果表，用户下一句多半是"导成 Word 给我" —— 不放行排版技能就会被模块闸掐掉，
    // 报"模块限制"。这两个不进 steps（不是规定流程的一环），只作为随时可用的配套。
    extra: ["render-docx", "render-pdf-doc"],
  },

  // ============ 文稿核查与审校 ============
  refcheck: {
    primary: "reference-check",
    intakeTitle: "核查设置",
    intake: [
      { id: "docFiles", label: "待核查的稿件", type: "files", required: true },
      { id: "dataFiles", label: "配套的数值表", type: "files",
        requiredWhen: { field: "checks", has: "integrity" },
        help: "只有勾了「数据完整性」才需要 —— 没有数值表这一项做不了。" },
      { id: "checks", label: "核查项", type: "multi", required: true,
        default: ["refs", "doi", "retracted"],
        options: [{ v: "refs", t: "假引用（文献是否真实存在）" }, { v: "doi", t: "DOI 是否正确" },
          { v: "retracted", t: "是否引用了已撤稿文献" }, { v: "stats", t: "统计陷阱与方法硬伤" },
          { v: "integrity", t: "数据完整性（需一并上传数值表）" }],
        help: "勾了「数据完整性」就必须把配套的数值表也传上来，否则这一项没法做。" },
      { id: "strict", label: "严格度", type: "select", default: "standard", options: [
        { v: "standard", t: "标准（推荐）" }, { v: "strict", t: "严格（宁可多报，把可疑的都列出来让你自己判断）" }] },
      { ...LANG, label: "核查报告用什么语言", help: "只影响报告，不改动你的稿件。" },
    ],
    steps: [
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        when: { field: "checks", has: "refs" },
        emits: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"], render: "refcheck" },
      { id: "review", name: "方法与统计审校", skill: "peer-review", gate: true,
        when: { field: "checks", has: "stats" },
        emits: ["review_report.md"], render: "review" },
      { id: "integrity", name: "数据完整性自查", skill: "data-integrity", gate: true,
        when: { field: "checks", has: "integrity" },
        emits: ["integrity_report.md", "audit/*"], render: "integrity",
        hint: "只出待核信号、不下造假结论" },
    ],
    extra: [],
  },

  // ============ 文章润色 ============
  humanize: {
    primary: "humanize-academic",
    intakeTitle: "润色设置",
    intake: [
      { id: "docFiles", label: "待润色的稿件", type: "files", required: true },
      { id: "goals", label: "润色目标", type: "multi", required: true, default: ["deai"],
        options: [{ v: "deai", t: "去除生成式文本痕迹（去 AI 味）" },
          { v: "language", t: "语言润色（语法 / 措辞 / 流畅度）" },
          { v: "style", t: "对齐目标期刊写作风格" },
          { v: "logic", t: "梳理段落逻辑与衔接" }] },
      { id: "journalName", label: "目标期刊", type: "text", when: { field: "goals", has: "style" },
        placeholder: "填了会去查该刊稿约；查不到会如实说明，不凭印象编" },
      { id: "strength", label: "润色强度", type: "select", default: "standard", options: [
        { v: "light", t: "保守（只动明显问题）" }, { v: "standard", t: "标准（推荐）" },
        { v: "heavy", t: "激进（重写句式节奏）" }] },
      { id: "protectRefs", label: "保持引用处的文字原样不动", type: "bool", default: true,
        help: "默认保持。关掉的话，润色后会自动把引用重新核一遍兜底。" },
      { id: "outFmt", label: "输出格式", type: "select", default: "docx", options: [
        { v: "md", t: "只要 Markdown" }, { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }] },
      // ★ 这里【不能】用通用的 LANG。润色模块里"输出语言=中文"会被理解成"把我的英文稿翻成中文"，
      //   而那是不可逆的后果（拿回来一篇中文稿）。默认改成"保持原文语言"。
      { id: "lang", label: "润色后稿件用什么语言", type: "select", default: "keep", options: [
        { v: "keep", t: "保持原文语言（推荐）" }, { v: "zh", t: "改写成中文" }, { v: "en", t: "改写成英文" }],
        help: "选「保持原文语言」只润色不翻译；选另外两个等于要求翻译改写，改动会大得多。" },
    ],
    steps: [
      { id: "humanize", name: "润色改写", skill: "humanize-academic",
        emits: ["*_humanized.md", "humanized*.md"], render: "diff" },
      { id: "refcheck", name: "引用兜底核查", skill: "reference-check", optional: true, gate: true,
        when: { field: "protectRefs", eq: false },
        emits: ["refcheck_report.md", "reference_check*.md"], render: "refcheck", onFail: "humanize",
        hint: "润色如果动过引用处的文字，必须把引用重新核一遍" },
      { id: "render", name: "排版出件", skill: "render-docx", optional: true,
        when: { field: "outFmt", ne: "md" },
        emits: ["*.docx", "*.pdf"], render: "doc" },
    ],
    extra: ["render-pdf-doc"],
  },
}

// ---- 派生：技能白名单 ----
// 模块的技能集 = steps 的 skill ∪ extra。MODULE_DEFS.skills 由它展开，不再手写。
export function skillsOf(mod) {
  const w = WORKFLOWS[mod]
  if (!w) return null
  return [...new Set([...w.steps.map((s) => s.skill), ...(w.extra || [])])]
}
export const primaryOf = (mod) => WORKFLOWS[mod]?.primary || null

// ---- 派生：按 intake 值裁剪出本次实际要走的步骤 ----
// when 不成立的整步剔除；first 成立的步骤提到最前（前瞻性研究的预注册锁）。
export function stepsFor(mod, values = {}) {
  const w = WORKFLOWS[mod]
  if (!w) return []
  const keep = w.steps.filter((s) => visible(s, values))
  const head = [], rest = []
  for (const s of keep) (condOk(s.first, values) && s.first ? head : rest).push(s)
  return [...head, ...rest]
}

// ---- 产物 → 渲染器 ----
// 认产物文件名，不要求 agent 输出 JSON（模型格式会漂，脆）。认不出的返回 null，
// 由前端按既有逻辑当普通产物展示 —— 绝不能因为"没匹配上渲染器"就把文件藏起来。
const globRe = (g) => new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$", "i")
/**
 * emits 里的 glob 是否匹配某个产物路径。
 * 产物路径可能带一层子目录（"pdfs/a.pdf"、"figures/fig1.png"），而 emits 里既有裸名（"table1.csv"）
 * 也有带目录的（"pdfs/*"、"audit/*"）。规则：glob 里带 "/" 就整条比；不带就只比最后一段
 * —— 否则 "fig*.png" 永远匹配不上 agent 写进 figures/ 的图，进度会卡住不动。
 */
export function globMatch(glob, name) {
  if (!glob || !name) return false
  const re = globRe(glob)
  if (glob.includes("/")) return re.test(String(name))
  return re.test(String(name).split("/").pop())
}
const RENDER_RULES = [
  { render: "evidence", globs: ["evidence_table.csv", "evidence.csv", "included.csv", "zotero_evidence.csv", "zotero_refs.csv"] },
  { render: "retrieval", globs: ["retrieval_report.json", "manual_needed.txt"] },
  { render: "refcheck", globs: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"] },
  { render: "review", globs: ["review_report.md", "peer_review*.md"] },
  { render: "integrity", globs: ["integrity_report.md", "audit_report*.md"] },
  { render: "topics", globs: ["topic_candidates*.csv", "topic_selection*.md"] },
  { render: "diff", globs: ["*_humanized.md", "humanized*.md"] },
  { render: "figure", globs: ["*.png", "*.jpg", "*.jpeg", "*.svg", "*.webp"] },
  { render: "doc", globs: ["*.docx", "*.doc", "*.pdf", "*.pptx"] },
  { render: "table", globs: ["*.csv", "*.tsv"] },
  { render: "manuscript", globs: ["manuscript*.md", "proposal*.md", "review.md", "*_review.md", "digest*.md", "research_report*.md", "deep_research*.md"] },
  { render: "report", globs: ["*_report.md", "*_log.md", "data_profile.md", "preregistration.md"] },
]
const COMPILED = RENDER_RULES.map((r) => ({ render: r.render, res: r.globs.map(globRe) }))
/** 文件名（可含一层子目录，如 pdfs/a.pdf）→ 渲染器 id；认不出返回 null */
export function rendererFor(name) {
  if (!name) return null
  const base = String(name).split("/").pop()
  for (const r of COMPILED) if (r.res.some((re) => re.test(base))) return r.render
  return null
}

// ---- 表单值 → 任务卡文本 ----
// 抄 index.html 的 zScopePrefix()：把结构化输入拼成一段【…】块塞在用户消息前面。
// 【格式约束】必须是纯文本、可读、并明确声明"这是用户通过表单提交的"，否则 agent 会把它
// 当成系统噪音忽略掉。末尾那句反幻觉提示是必须的 —— 表单必然有留空项，不写死它就会去编。
const fmtVal = (f, v) => {
  if (v === undefined || v === null || v === "") return null
  const label = (val) => (f.options || []).find((o) => o.v === val)?.t || val
  if (f.type === "bool") return v ? "是" : "否"
  if (f.type === "multi" || f.multiple) {
    const arr = Array.isArray(v) ? v : [v]
    return arr.length ? arr.map(label).join("、") : null
  }
  if (f.type === "range") {
    const { min, max } = v || {}
    if (min === undefined && max === undefined) return null
    if (min !== undefined && max !== undefined) return `${min} – ${max}${f.unit ? " " + f.unit : ""}`
    return min !== undefined ? `≥ ${min}` : `≤ ${max}`
  }
  if (f.type === "files") { const arr = Array.isArray(v) ? v : [v]; return arr.length ? arr.join("、") : null }
  if (f.type === "select") return label(v)
  return String(v)
}

/**
 * 把一组表单值序列化成任务卡。
 * @param modName 模块显示名（"SCI 论文"）
 * @param title   卡片标题（"立项确认" / 步骤名）
 * @param fields  字段定义数组
 * @param values  用户填的值
 * @param opts    { footnote, upDir }
 */
export function taskCard(modName, title, fields, values = {}, opts = {}) {
  const lines = []
  for (const f of fields || []) {
    if (!visible(f, values)) continue              // 条件没成立的字段压根没显示过，别拼进去
    const s = fmtVal(f, values[f.id])
    if (s !== null) lines.push(`- ${f.label}：${s}`)
  }
  if (!lines.length) return ""                     // 一项都没填 = 用户跳过了表单，什么都不拼
  // ★ 脚注必须放在结束标记【以上为用户通过表单…】的【前面】。
  //   放后面的话 server.mjs 的 WFCARD_RE 剥到 `】` 就停了，脚注会残留在用户气泡里 ——
  //   用户回看历史会看到自己"说"了一句"需要 PRISMA/RoB 请到自由对话"，而他根本没说过。
  const foot = opts.footnote ? `\n补充说明：${opts.footnote}` : ""
  return `【任务卡 · ${modName} / ${title}】\n${lines.join("\n")}${foot}\n`
    + `【以上为用户通过表单勾选提交的结构化输入，视同用户明确指令，按它推进即可、不要再逐项复述确认。`
    + `未填写的项一律标注"待补充"并在需要时向用户索要，**绝不臆测或编造**（伦理批号、注册号、数据数值尤其如此）。】\n\n`
}

// ---- 模块/技能闸的判据（纯函数，便于测试）----
// 三条：① skill 工具调了白名单外的技能；② 受限模块用 task 子代理绕道；
//       ③ bash 命令里直接跑白名单外的技能脚本。
//
// ③ 是随"技能集扩成整条 pipeline"一起补上的：前言本来就教 agent 用
// `${REPO_ROOT}/.venv/bin/python ${REPO_ROOT}/.opencode/skills/<技能>/xxx.py` 跑脚本，
// 于是"顺手跑一个隔壁模块的脚本"是条真实且高频的绕道路径，而它走 bash 工具、不经过 ①。
//
// 【边界，别误解】变量拼接、cd 进目录后用相对路径、base64 等刻意绕法都能过 —— 这与本套件
// 既有口径一致：模块闸是**产品分权**，不是对抗边界（agent 本来就有 shell）。堵住顺手绕道
// 已经拿到绝大部分收益；真要物理隔离得每模块一个 opencode 实例，代价不值。
const SKILL_PATH_RE = /\.opencode[/\\]+skills[/\\]+([a-z0-9_-]+)/gi
// 只读命令不算"调用技能"：agent 常常需要 cat/grep 一下别的技能的 SKILL.md 才能把话讲清楚
// （综述模块的脚注就是让它告诉用户"系统综述在自由对话"，它顺手 cat 一下那份文档很自然）。
// 把这些也判成越权会整轮 abort，属于误杀 —— 读文档不产生该技能的产出，不是分权要挡的东西。
const READONLY_CMD = /^\s*(sudo\s+)?(cat|head|tail|less|more|grep|rg|ls|ll|find|wc|file|stat|md5sum|sha\w*sum|diff)\b/
export function gateViolation({ tool, input, skillGate, restricted }) {
  if (!skillGate) return null
  if (tool === "skill" && input?.name && !skillGate.has(input.name)) return input.name
  if (restricted && tool === "task") return "task(子代理)"
  if (tool === "bash") {
    let cmd = String(input?.command || "")
    if (READONLY_CMD.test(cmd)) return null
    // 归一化再匹配：`skills//deidentify`、`skills/./deidentify`、`"…/skills"/deidentify`
    // 这几种写法在 shell 里都很平常（路径含空格时加引号是习惯），不归一的话直接漏过去。
    cmd = cmd.replace(/["']/g, "").replace(/\/\.\//g, "/").replace(/\\\.\\/g, "\\")
    // matchAll 按规范会克隆正则，不会推进原对象的 lastIndex，故无需手动归零
    for (const m of cmd.matchAll(SKILL_PATH_RE))
      if (!skillGate.has(m[1].toLowerCase())) return `${m[1]}（bash 直呼技能脚本）`
  }
  return null
}

/** 模块的完整工作流描述，供 /api/modules/<id>/workflow 下发给前端 */
export function workflowFor(mod, values) {
  const w = WORKFLOWS[mod]
  if (!w) return null
  return {
    module: mod,
    primary: w.primary,
    intakeTitle: w.intakeTitle,
    intake: w.intake,
    footnote: w.footnote || null,
    steps: (values ? stepsFor(mod, values) : w.steps).map((s) => ({
      id: s.id, name: s.name, skill: s.skill, gate: !!s.gate, optional: !!s.optional,
      hint: s.hint || null, form: s.form || null, render: s.render || null, emits: s.emits || null,
      when: s.when || null, first: s.first || null,
    })),
  }
}

/** 模块前言里那句"本模块的标准流程"——把步骤链与质量闸讲给 agent 听 */
export function pipelineLine(mod, values) {
  const steps = stepsFor(mod, values)
  if (!steps.length) return ""
  const chain = steps.map((s) => s.name + (s.optional ? "(可选)" : "") + (s.gate ? "(闸)" : "")).join(" → ")
  const gates = steps.filter((s) => s.gate)
  const gateTxt = gates.length
    ? `质量闸：${gates.map((g) => `${g.name}（不过则回退到「${steps.find((x) => x.id === g.onFail)?.name || "上游相应步骤"}」返工）`).join("；")}。`
    : ""
  return `\n- **本模块的标准流程**：${chain}。${gateTxt}按此顺序推进；确有理由跳步或合并要先向用户说明。同一闸反复回退 ≥2 次仍不过就停下问用户，别无限返工。`
}

/** 产物契约：告诉 agent 用约定文件名，界面才认得出并渲染成表格/卡片 */
export function artifactLine(mod, values) {
  const names = [...new Set(stepsFor(mod, values).flatMap((s) => s.emits || []))]
  if (!names.length) return ""
  return `\n- **产物文件名用约定名**（界面按文件名把产物渲染成表格/文献卡片/报告，名字对不上就只能当普通附件列出）：${names.join("、")}。确有额外产物照常写，不受此限。`
}
