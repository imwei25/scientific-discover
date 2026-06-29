# 帮助模块（HelpModal）设计

**日期**：2026-06-28
**作者**：Claude × 用户协作（brainstorming）
**背景**：经 14 轮 loop 改进，产品扩展为 8 模块工作台 + 大量子工具。改进日志中的多项功能（PRISMA/CONSORT 流程图、statcheck、随机化分组、DMP、知情同意、ZIP 投稿包、关键词/MeSH、图注、PICO 提取）虽已实现并通过测试，但**对终端用户「何时用 / 如何用」并不直观**。本设计为这 9 个不直观的子工具新增统一的"使用说明"帮助卡片。

---

## 1. 目标与非目标

**目标**：
- 9 个子工具旁挂"?"按钮，点击弹出统一样式的模态卡片。
- 卡片固定三段：**何时使用 / 如何使用 / 最简示例**。
- 内容用真实数字示例（非抽象描述），并明确写出使用前提（如投稿包 ZIP 依赖前置产出、知情同意书必须经 IRB）。
- 文案与组件解耦（数据集中维护，便于改写）。
- 不打扰主流程：默认不可见，按需打开。

**非目标**（YAGNI）：
- 模块级（8 个）总览帮助——本期不做。
- 自动填充示例数据——本期不做，用户复制即可。
- i18n / 多语言——项目无 i18n 框架，沿用硬编码中文。
- 内容快照测试——文案高频改写，快照只增维护负担。
- 动画过场、宽窄切换、多层 modal。

---

## 2. 用户需求来源

用户原话："改进日志中做了不少新功能,但有些功能怎么用不太明朗,对每个功能,帮我都加入一个帮助模块,告诉用户什么时候使用,如何使用,以及一个minimal example"

经 3 轮校准确定：
- **颗粒度**：子工具级（9 个），不做模块级总览。
- **UI 形态**：模态弹窗 + "?"入口（一致、容纳得下结构化内容、不打扰主流程）。
- **内容口径**：含使用前提；真实数字示例；不做自动填充按钮。

---

## 3. 架构

### 3.1 新增文件

| 文件 | 职责 | 体量 |
|------|------|------|
| `frontend/src/components/HelpModal.tsx` | 通用模态对话框：ESC/×/遮罩三路关闭，焦点回归触发按钮，body 滚动锁 | ≈ 60 行 |
| `frontend/src/components/HelpButton.tsx` | "?"按钮：渲染圆形小按钮，注入 `HELP[helpKey]` 到 `HelpModal` | ≈ 25 行 |
| `frontend/src/lib/helpContent.tsx` | 9 条帮助内容集中数据源（导出字典 `HELP`） | ≈ 250 行 |
| `frontend/tests/help-modal.spec.ts` | Playwright e2e（4 类断言，见 §6） | ≈ 80 行 |

### 3.2 改动文件

| 文件 | 改动 | 估计 |
|------|------|------|
| `frontend/src/modules/IdeaModule.tsx` | "提取 PICO/纳排标准"标题旁挂 `<HelpButton helpKey="pico" />` | +1 行 |
| `frontend/src/modules/PlanModule.tsx` | 随机化 / DMP / 知情同意 3 处各挂 1 行 | +3 行 |
| `frontend/src/modules/AnalyzeModule.tsx` | "生成规范图注"标题旁 1 行 | +1 行 |
| `frontend/src/modules/ImradModule.tsx` | 关键词推荐 / 投稿包 ZIP 2 处各挂 1 行 | +2 行 |
| `frontend/src/modules/ChecklistModule.tsx` | statcheck / 流程图 2 处各挂 1 行 | +2 行 |
| `frontend/src/styles.css` | modal 遮罩 / 卡片 / 按钮样式（约 25 行） | +25 行 |
| `frontend/index.html` 或 `App.tsx` | 无需改动 | — |

**不动**：所有业务逻辑、后端、state、history、prompts。

### 3.3 数据结构

```ts
// frontend/src/lib/helpContent.tsx
import type { ReactNode } from 'react';

export type HelpEntry = {
  title: string;            // 卡片大标题（用功能中文名）
  whenToUse: ReactNode;     // "何时使用"段，含使用前提
  howToUse: ReactNode;      // "如何使用"段（编号列表）
  example: ReactNode;       // "最简示例"段（含真实数字/代码块/字段表）
};

export type HelpKey =
  | 'pico' | 'randomize' | 'dmp' | 'consent'
  | 'figcaptions' | 'keywords' | 'bundle'
  | 'statcheck' | 'flowdiagram';

export const HELP: Record<HelpKey, HelpEntry> = { /* 9 条 */ };
```

### 3.4 组件接口

```tsx
// HelpModal
<HelpModal open={open} onClose={() => setOpen(false)} entry={HELP.flowdiagram} />

// HelpButton（更常用）
<HelpButton helpKey="flowdiagram" />
// 内部：useState(open) + HelpModal + 触发按钮 ref（用于焦点回归）
```

---

## 4. 视觉与交互

### 4.1 样式（沿用 styles.css 现有色板，不引入新设计语言）

- **HelpButton**：直径 18px 圆形，灰底 `#eef2f1`、深绿字 `#0E3A39`、内容 `?`，标题旁 6px 间距，`title="使用说明"` 提供原生 tooltip。
- **HelpModal**：
  - 遮罩：`position:fixed; inset:0; background:rgba(15,30,28,.45)`
  - 卡片：`max-width:640px`、垂直居中、白底、`border-radius:12px`、`box-shadow:0 12px 40px rgba(0,0,0,.18)`、padding 24px。
  - 卡片内固定布局：
    ```
    [标题]                                [×]
    ──────────────
    何时使用      ← 小节标题 + 深绿短横线视觉锚
    （正文）

    如何使用
    （编号列表）

    最简示例
    （代码块 / 字段表）
    ```
- **不使用 emoji**（用户明确决策）。
- **不使用 Portal**（项目无额外依赖）：fixed 定位即可，z-index 1000。

### 4.2 交互

- **打开**：点击 "?" → modal 出现，焦点移到 × 按钮。
- **关闭**（三路均生效）：① 按 ESC；② 点 ×；③ 点遮罩（卡片内点击阻止冒泡）。
- **关闭后**：焦点回到原触发按钮（无障碍硬指标）。
- **body 滚动锁**：打开时 `document.body.style.overflow='hidden'`，关闭恢复。

---

## 5. 9 条帮助内容（文案口径）

每条三段：**何时使用 / 如何使用 / 最简示例**。所有"何时使用"段落均包含"使用前提"（依赖的前置产出、伦理/审核约束等）。

### 5.1 流程图（helpKey: `flowdiagram`）

- **何时使用**：投系统综述/Meta 时期刊必交 PRISMA；投 RCT 必交 CONSORT 2025。手画/Word 太慢且数字一致性难自查。**前提**：你已完成研究筛选/试验流程的真实统计。
- **如何使用**：
  1. 选类型（PRISMA / CONSORT）
  2. 按表单逐格填入真实数字（**主列 − 右侧排除列必须自洽**：例 920 − 760 = 160）
  3. 点"生成"，预览图片
  4. 按需下载 PNG（300 dpi 投稿用）/ SVG（矢量 PPT 用）/ PDF
- **最简示例**（PRISMA）：
  ```
  数据库识别 1240    去重剔除 320
  去重后筛选 920     标题摘要剔除 760
  获取全文 160       未取得全文 18
  评估合格 142       全文剔除 110（非 RCT 80 / 非目标人群 30）
  纳入研究 32
  ```
  → 生成 PRISMA 2020 漏斗图。

### 5.2 statcheck（helpKey: `statcheck`）

- **何时使用**：投稿前自查论文里 t/F/χ²/r/z 三件套（统计量 + 自由度 + p 值）算不算得上。**前提**：你已有写好的结果段落。期刊审稿越来越多直接跑 statcheck，自己先查。
- **如何使用**：
  1. 把含统计结果的段落粘进文本框
  2. 点"运行 statcheck"
  3. 看徽章：**一致** ✓ / **不一致**（数值不符但显著性同）/ **严重**（显著性在 .05 翻转）/ **无法核验**
- **最简示例**：
  ```
  输入：两组差异有统计学意义（t(38)=2.10, p=0.04）。
  输出：一致 ✓   报告 p=0.04   重算 p=0.0424
  ```

### 5.3 随机化分组表（helpKey: `randomize`）

- **何时使用**：写实验方案/SAP 时需要分组方案 + 分配序列，又不想去 R/SAS 写脚本。**前提**：已确定样本量、分组和分配比例。
- **如何使用**：
  1. 填 n（受试者总数）、分组（A,B 或 A,B,C）、分配比例（1:1 或 2:1）
  2. 选方法：简单随机 / 置换区组
  3. 区组随机要填区组大小（自动取整为比例和的整数倍）
  4. 设种子（保证可复现）→ 生成 → 导出 CSV
- **最简示例**：n=24、组 A,B、比例 1:1、区组 4、种子 42 → 6 个区组，每组 12 人均衡。

### 5.4 数据管理计划 DMP（helpKey: `dmp`）

- **何时使用**：申国自然/NIH/Horizon 等基金时要求附 DMP；机构伦理审查也常索取。**前提**：研究题目和数据类型已大致确定。
- **如何使用**：
  1. 填研究题目、数据类型（成像 / 基因 / 临床 CRF / 问卷……）
  2. 填存储和共享意向（可留空，缺项会标 `[需研究者明确]`）
  3. 点"生成 DMP"，得到 NIH/FAIR 框架的 6 节初稿
  4. 自己补缺、提交 Word
- **最简示例**：研究=二甲双胍 NAFLD RCT、数据=肝弹+生化、计划共享=去标识后发 OSF → 输出含 6 个分节（数据类型 / 采集组织 / 存储备份 / 安全隐私合规 / 共享归档 / 角色责任）的 1300+ 字初稿。

### 5.5 知情同意书草案（helpKey: `consent`）

- **何时使用**：临床/人群研究递交伦理委员会前要写知情同意书，初稿想省时间。**前提（关键）**：本工具产物是**草案**，必须经 IRB（伦理委员会）审核后方可使用，不可直接发给受试者签字。
- **如何使用**：
  1. 填研究目的、人群、流程/风险/补偿
  2. 点"生成知情同意书"，得到含目的/流程/风险获益/隐私/自愿退出/补偿/签字栏的草案，凡未填项标 `[需研究者补充]`
  3. 提交 IRB 审核
- **最简示例**：目的=评估二甲双胍对 NAFLD 肝硬度影响、人群=18–65 岁成人、流程=12 周口服 → 输出 1200+ 字含 7 个分节的草案，包含明确"需 IRB 审核"提示。

### 5.6 图注生成（helpKey: `figcaptions`）

- **何时使用**：分析跑完出了 N 张图，要为正文/PPT 写"图 1. … / 图 2. …"规范图注。**前提**：数据分析模块已成功跑完一次分析并出图。
- **如何使用**：
  1. 在数据分析模块跑完一次分析（出现图表）
  2. 点"生成规范图注"
  3. 每张图下方显示 1 句中文图注（"图 N. ……"），数字与图保持一致、不编造
- **最简示例**：箱线图 → "图 1. 两组治疗后肝硬度（kPa）箱线图。差异具有统计学意义（p=0.003）。"

### 5.7 关键词 / MeSH 推荐（helpKey: `keywords`）

- **何时使用**：写完摘要要填关键词，或者投英文刊需要 MeSH 主题词。**前提**：已有写好（或粘贴的）摘要。
- **如何使用**：
  1. 在论文初稿模块完成摘要（或在摘要区粘贴）
  2. 点"推荐关键词/MeSH"
  3. 得到中英关键词 + MeSH 主题词；不确定的术语会标"需核对"
- **最简示例**：摘要含"二甲双胍 + NAFLD + 肝硬度" → 输出 中文关键词（二甲双胍 / 非酒精性脂肪性肝病 / 肝硬度）+ 英文（metformin / NAFLD / liver stiffness）+ MeSH（Metformin / Non-alcoholic Fatty Liver Disease / Elasticity Imaging Techniques）。

### 5.8 投稿包 ZIP（helpKey: `bundle`）

- **何时使用**：全流程都跑完，要一次性打包给合作者/送审。**前提（关键）**：本工具汇总各模块的**已产出物**——没产出的项会被静默跳过。需先在下列模块至少各产出过一次：选题综述 / 实验方案 / SAP / 分析结论 / IMRaD 初稿 / 摘要 / 投稿信 / 排版稿 / 参考文献 / 规范核对 / 审稿回复。
- **如何使用**：
  1. 检查各模块已产出（可在历史记录里翻一翻）
  2. 在论文初稿模块点"打包投稿包 ZIP"
  3. 浏览器下载 `research-package.zip`（文本项为 `.md`，docx 项为 `.docx`）
- **最简示例**：跑完 8 模块后打包 → 得到约 11 个文件的 zip，含 `draft.docx`（IMRaD 初稿）/ `选题.md` / `cover-letter.docx` 等。

### 5.9 PICO/纳排提取（helpKey: `pico`）

- **何时使用**：要把研究问题转化为 PICOTS 框架（Population / Intervention / Comparison / Outcome / Timing / Study design），并据此写纳入/排除标准——写综述、方案、伦理申请前的必经步骤。**前提**：已大致明确研究领域和关键词。
- **如何使用**：
  1. 在"找选题"模块输入研究领域 / 关键词 / 背景
  2. 点"提取 PICO/纳排标准"
  3. 得到 PICOTS 表 + 建议纳入/排除标准；信息不足处会标 `[需明确]`
- **最简示例**：领域=代谢病 + 关键词=二甲双胍 NAFLD + 背景一段 → 输出 PICOTS 表（P=成人 NAFLD 患者 / I=二甲双胍 / C=安慰剂 / O=肝硬度 kPa / T=12 周 / S=RCT）+ 6 条纳入 + 5 条排除。

---

## 6. 测试策略

新增 1 个 Playwright spec：`frontend/tests/help-modal.spec.ts`。4 类断言：

1. **存在性**：进入 9 个对应模块，断言每个子工具标题旁渲染出"?"按钮（用 `getByRole('button', { name: '使用说明' })` 计数 = 9，或在每个模块内分别断言）。
2. **打开/内容**：点开"流程图"的"?"，断言模态出现且包含三个小节标题（"何时使用" / "如何使用" / "最简示例"）和样本关键数字 `1240`。
3. **关闭三路**：ESC、点 ×、点遮罩各一次断言关闭（同一个 modal，按顺序）。
4. **焦点回归**：关闭后断言原"?"按钮重新获得焦点（无障碍硬指标）。

**不做**：9 张卡片的内容快照测试。

**完成判定**：
1. 9 个 "?" 按钮在对应位置可见
2. 任一 "?" 按钮点击弹出模态，三段内容齐全
3. ESC/×/遮罩 三种关闭都生效，关闭后焦点回到触发按钮
4. Playwright 48 → 49（新增 1 个 spec）全绿
5. `npm run build` 无 TS 错误，dist 重建

---

## 7. 风险与回滚

**风险**：
- modal 焦点回归在 React 严格模式 / 异步 setState 下可能时序错。**缓解**：用 `useRef` 缓存触发元素，在 `useEffect(open === false)` 里调用 `.focus()`。
- body 滚动锁忘记恢复。**缓解**：`useEffect` 的 cleanup 强制恢复。
- 9 个模块挂载位置不一致。**缓解**：plan 阶段在每个模块文件标注精确插入行号。

**回滚**：
- 新增文件直接删除。
- 模块文件单行 import + 单行 JSX 改动，git revert 即可。
- styles.css 改动用注释包裹 `/* === HelpModal 样式 begin === */ ... /* === HelpModal 样式 end === */`，方便手动剔除。

---

## 8. 提交边界

一次提交，不切分：
- 新增：`HelpModal.tsx` / `HelpButton.tsx` / `helpContent.tsx` / `help-modal.spec.ts`
- 改动：9 个模块文件各 1–3 行 + `styles.css` 加约 25 行
- dist 重建：是（前端有改）
- 不动：所有业务逻辑、后端、state、history、prompts
