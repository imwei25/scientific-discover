import type { ReactNode } from "react";

export type HelpKey =
  | "pico" | "randomize" | "dmp" | "consent"
  | "figcaptions" | "keywords" | "bundle"
  | "statcheck" | "flowdiagram";

export interface HelpEntry {
  title: string;
  whenToUse: ReactNode;
  howToUse: ReactNode;
  example: ReactNode;
}

export const HELP: Record<HelpKey, HelpEntry> = {
  flowdiagram: {
    title: "PRISMA / CONSORT 流程图生成",
    whenToUse: (
      <p>
        投系统综述 / Meta 分析时期刊必交 PRISMA 流程图；投 RCT 必交 CONSORT 2025 流程图。手画 / Word 太慢、数字一致性也难自查。
        <br />
        <strong>前提：</strong>你已完成研究筛选 / 试验流程的真实统计。
      </p>
    ),
    howToUse: (
      <ol>
        <li>选类型（PRISMA 或 CONSORT）</li>
        <li>按表单逐格填入真实数字（<strong>主列 − 右侧排除列必须自洽</strong>，如 920 − 760 = 160）</li>
        <li>点"生成"，预览图片</li>
        <li>按需下载 PNG（300 dpi 投稿用）/ SVG（矢量 PPT 用）/ PDF</li>
      </ol>
    ),
    example: (
      <>
        <p>PRISMA 一个最简的填表示例：</p>
        <pre>{`数据库识别 1240    去重剔除 320
去重后筛选 920     标题摘要剔除 760
获取全文 160       未取得全文 18
评估合格 142       全文剔除 110（非 RCT 80 / 非目标人群 30）
纳入研究 32`}</pre>
        <p>→ 生成 PRISMA 2020 漏斗图，PNG/SVG/PDF 三种格式可下。</p>
      </>
    ),
  },

  statcheck: {
    title: "statcheck 统计一致性自查",
    whenToUse: (
      <p>
        投稿前自查论文里 t / F / χ² / r / z 三件套（统计量 + 自由度 + p 值）算不算得上。期刊审稿越来越多直接跑 statcheck，自己先查。
        <br />
        <strong>前提：</strong>你已有写好的结果段落。
      </p>
    ),
    howToUse: (
      <ol>
        <li>把含统计结果的段落粘进文本框</li>
        <li>点"运行 statcheck"</li>
        <li>看徽章：<strong>一致</strong> ✓ / <strong>不一致</strong>（数值不符但显著性同）/ <strong>严重</strong>（显著性在 .05 翻转）/ <strong>无法核验</strong></li>
      </ol>
    ),
    example: (
      <pre>{`输入：两组差异有统计学意义（t(38)=2.10, p=0.04）。
输出：一致 ✓   报告 p=0.04   重算 p=0.0424`}</pre>
    ),
  },

  randomize: {
    title: "随机化分组表",
    whenToUse: (
      <p>
        写实验方案 / SAP 时需要分组方案 + 分配序列，又不想去 R / SAS 写脚本。本地确定性、固定种子可复现，免费、零额度。
        <br />
        <strong>前提：</strong>已确定样本量、分组和分配比例。
      </p>
    ),
    howToUse: (
      <ol>
        <li>填 n（受试者总数）、分组（如 <code>A,B</code> 或 <code>A,B,C</code>）、分配比例（如 <code>1:1</code> 或 <code>2:1</code>）</li>
        <li>选方法：简单随机 / 置换区组</li>
        <li>区组随机要填区组大小（自动取整为比例和的整数倍）</li>
        <li>设种子（保证可复现）→ 生成 → 导出 CSV</li>
      </ol>
    ),
    example: (
      <pre>{`n=24, 组=A,B, 比例=1:1, 区组=4, 种子=42
→ 6 个区组，每组 12 人均衡（每个区组内 A:B = 2:2）`}</pre>
    ),
  },

  dmp: {
    title: "数据管理计划（DMP）",
    whenToUse: (
      <p>
        申国自然 / NIH / Horizon 等基金时要求附 DMP；机构伦理审查也常索取。沿用 NIH 数据共享 / FAIR 框架。
        <br />
        <strong>前提：</strong>研究题目和数据类型已大致确定。
      </p>
    ),
    howToUse: (
      <ol>
        <li>在"实验规划"输入研究主题（也用于生成实验方案）</li>
        <li>填可用资源 / 数据类型（成像 / 基因 / 临床 CRF / 问卷……）</li>
        <li>点"数据管理计划(DMP)"，得到 NIH/FAIR 框架的 6 节初稿</li>
        <li>缺项会标 <code>[需研究者明确]</code>，自己补齐 → 导出 Word</li>
      </ol>
    ),
    example: (
      <pre>{`研究 = 二甲双胍 NAFLD RCT
数据 = 肝弹+生化
共享意向 = 去标识后发 OSF
→ 1300+ 字含 6 节（数据类型 / 采集组织 / 存储备份 /
   安全隐私合规 / 共享归档 / 角色责任）的初稿`}</pre>
    ),
  },

  consent: {
    title: "知情同意书草案",
    whenToUse: (
      <p>
        临床 / 人群研究递交伦理委员会前要写知情同意书，初稿想省时间。
        <br />
        <strong style={{ color: "var(--bad)" }}>关键前提：</strong>本工具产物是<strong>草案</strong>，必须经 IRB（伦理委员会）审核后方可使用，
        <strong>不可直接发给受试者签字</strong>。
      </p>
    ),
    howToUse: (
      <ol>
        <li>在"实验规划"输入研究主题与人群</li>
        <li>填可用资源（流程 / 风险 / 补偿信息）</li>
        <li>点"知情同意书草案"，得到含目的 / 流程 / 风险获益 / 隐私 / 自愿退出 / 补偿 / 签字栏的草案</li>
        <li>未填项会标 <code>[需研究者补充]</code>，补齐 → 提交 IRB</li>
      </ol>
    ),
    example: (
      <pre>{`目的 = 评估二甲双胍对 NAFLD 肝硬度影响
人群 = 18–65 岁成人
流程 = 12 周口服
→ 1200+ 字含 7 节的草案 + 多处"需 IRB 审核"提示`}</pre>
    ),
  },

  figcaptions: {
    title: "图注生成（数据分析）",
    whenToUse: (
      <p>
        分析跑完出了 N 张图，要为正文 / PPT 写"图 1. … / 图 2. …"规范图注。数字与图保持一致、不编造。
        <br />
        <strong>前提：</strong>数据分析模块已成功跑完一次分析并出图。
      </p>
    ),
    howToUse: (
      <ol>
        <li>在数据分析模块跑完一次分析（出现图表）</li>
        <li>点图表上方的"✍️ 生成规范图注"</li>
        <li>每张图下方显示 1 句中文图注（"图 N. ……"）</li>
      </ol>
    ),
    example: (
      <pre>{`箱线图 →
"图 1. 两组治疗后肝硬度（kPa）箱线图。
差异具有统计学意义（p=0.003）。"`}</pre>
    ),
  },

  keywords: {
    title: "关键词 / MeSH 推荐",
    whenToUse: (
      <p>
        写完摘要要填关键词，或者投英文刊需要 MeSH（Medical Subject Headings）主题词。
        <br />
        <strong>前提：</strong>已有写好（或粘贴的）摘要要点。
      </p>
    ),
    howToUse: (
      <ol>
        <li>在"论文初稿"模块的"结构式摘要"区填入摘要要点</li>
        <li>点"推荐关键词 / MeSH"</li>
        <li>得到中英关键词 + MeSH 主题词；不确定的术语会标"需核对"</li>
      </ol>
    ),
    example: (
      <pre>{`摘要含"二甲双胍 + NAFLD + 肝硬度" →
中文：二甲双胍 / 非酒精性脂肪性肝病 / 肝硬度
英文：metformin / NAFLD / liver stiffness
MeSH：Metformin / Non-alcoholic Fatty Liver Disease
      / Elasticity Imaging Techniques`}</pre>
    ),
  },

  bundle: {
    title: "一键投稿包（ZIP）",
    whenToUse: (
      <p>
        全流程都跑完，要一次性打包给合作者 / 送审。
        <br />
        <strong>关键前提：</strong>本工具汇总各模块的<strong>已产出物</strong>——没产出的项会被静默跳过。建议先在下列模块至少各产出过一次：
        选题综述 / 实验方案 / SAP / 分析结论 / IMRaD 初稿 / 摘要 / 投稿信 / 排版稿 / 参考文献 / 规范核对 / 审稿回复。
      </p>
    ),
    howToUse: (
      <ol>
        <li>检查各模块已产出（可在"历史记录"翻一翻）</li>
        <li>在"论文初稿"模块点"打包投稿包 ZIP"</li>
        <li>浏览器下载 <code>research-package.zip</code></li>
      </ol>
    ),
    example: (
      <pre>{`跑完 8 模块后打包 →
约 11 个文件的 zip，含 draft.docx（IMRaD 初稿）/
选题.md / cover-letter.docx / SAP.docx 等。
（文本项为 .md，docx 项为 .docx）`}</pre>
    ),
  },

  pico: {
    title: "PICO / 纳排标准提取",
    whenToUse: (
      <p>
        把研究问题转化为 PICOTS 框架（Population / Intervention / Comparison / Outcome / Timing / Study design），并据此写纳入 / 排除标准——写综述、方案、伦理申请前的必经步骤。
        <br />
        <strong>前提：</strong>已大致明确研究领域和关键词。
      </p>
    ),
    howToUse: (
      <ol>
        <li>在"找选题"模块输入研究领域 / 关键词 / 背景</li>
        <li>点"提取 PICO / 纳排标准"</li>
        <li>得到 PICOTS 表 + 建议纳入 / 排除标准；信息不足处会标 <code>[需明确]</code></li>
      </ol>
    ),
    example: (
      <pre>{`领域 = 代谢病 + 关键词 = 二甲双胍 NAFLD + 背景一段 →
PICOTS 表：
  P = 成人 NAFLD 患者
  I = 二甲双胍
  C = 安慰剂
  O = 肝硬度 kPa
  T = 12 周
  S = RCT
+ 6 条纳入 + 5 条排除`}</pre>
    ),
  },
};
