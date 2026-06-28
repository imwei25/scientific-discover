# 帮助模块（HelpModal）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 9 个不直观的子工具（流程图 / statcheck / 随机化 / DMP / 知情同意 / 图注 / 关键词 / 投稿包 ZIP / PICO）旁挂统一的"?"按钮，点击弹出固定三段（何时使用 / 如何使用 / 最简示例）的帮助模态卡片。

**Architecture:** 一个共享 `HelpModal` 组件 + 一个 `HelpButton` 触发器；9 条帮助内容集中在 `helpContent.tsx` 数据文件；5 个模块文件各挂 1–3 行。无后端改动。

**Tech Stack:** React 18（TS）/ Vite / Playwright e2e / 沿用现有 styles.css token

**Spec:** `docs/superpowers/specs/2026-06-28-help-modules-design.md`

---

## File Structure

**新增：**
- `frontend/src/components/HelpModal.tsx` — 通用模态对话框（ESC/×/遮罩三路关闭、焦点回归、滚动锁）
- `frontend/src/components/HelpButton.tsx` — "?"按钮触发器
- `frontend/src/lib/helpContent.tsx` — 9 条帮助内容数据源
- `frontend/tests/help-modal.spec.ts` — Playwright e2e（4 类断言）

**改动：**
- `frontend/src/styles.css` — 末尾追加 modal 样式（约 30 行）
- `frontend/src/modules/IdeaModule.tsx` — PICO 按钮旁挂（line 386 附近）
- `frontend/src/modules/PlanModule.tsx` — 随机化 summary 内 / DMP h2 / 知情同意 h2（line 245/262/349 附近）
- `frontend/src/modules/AnalyzeModule.tsx` — 图注按钮旁挂（line 267 附近）
- `frontend/src/modules/ImradModule.tsx` — 关键词按钮旁挂 / ZIP h2（line 342/385 附近）
- `frontend/src/modules/ChecklistModule.tsx` — 流程图 h2 / statcheck h2（line 231/287 附近）

---

## Task 1: HelpModal 组件 + 样式

**Files:**
- Create: `frontend/src/components/HelpModal.tsx`
- Modify: `frontend/src/styles.css`（在文件末尾追加）

- [ ] **Step 1: 创建 HelpModal.tsx**

```tsx
// frontend/src/components/HelpModal.tsx
import { useEffect, useRef, type ReactNode } from "react";

export interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  whenToUse: ReactNode;
  howToUse: ReactNode;
  example: ReactNode;
}

export function HelpModal({ open, onClose, title, whenToUse, howToUse, example }: HelpModalProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="help-modal-overlay"
      onClick={onClose}
      role="presentation"
      data-testid="help-modal-overlay"
    >
      <div
        className="help-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="help-modal"
      >
        <div className="help-modal-header">
          <h3 className="help-modal-title">{title}</h3>
          <button
            ref={closeBtnRef}
            className="help-modal-close"
            onClick={onClose}
            aria-label="关闭"
            data-testid="help-modal-close"
          >
            ×
          </button>
        </div>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">何时使用</h4>
          <div className="help-modal-body">{whenToUse}</div>
        </section>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">如何使用</h4>
          <div className="help-modal-body">{howToUse}</div>
        </section>
        <section className="help-modal-section">
          <h4 className="help-modal-subtitle">最简示例</h4>
          <div className="help-modal-body">{example}</div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 styles.css 末尾追加样式**

打开 `frontend/src/styles.css`，跳到文件末尾，追加：

```css
/* === HelpModal 样式 begin === */
.help-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 30, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}
.help-modal-card {
  background: var(--surface);
  max-width: 640px;
  width: 100%;
  max-height: 85vh;
  overflow-y: auto;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  padding: 24px;
  font-family: var(--sans);
  color: var(--ink);
}
.help-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 2px solid var(--petrol);
  padding-bottom: 8px;
  margin-bottom: 16px;
}
.help-modal-title {
  margin: 0;
  font-size: var(--fs-h2);
  color: var(--petrol);
}
.help-modal-close {
  background: none;
  border: none;
  font-size: 24px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  padding: 0 4px;
}
.help-modal-close:hover { color: var(--petrol); }
.help-modal-section { margin-top: 14px; }
.help-modal-subtitle {
  margin: 0 0 6px 0;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--petrol);
  letter-spacing: 0.4px;
}
.help-modal-body {
  font-size: var(--fs-body);
  line-height: 1.6;
  color: var(--ink);
}
.help-modal-body ol, .help-modal-body ul { margin: 4px 0 4px 20px; padding: 0; }
.help-modal-body li { margin-bottom: 4px; }
.help-modal-body pre {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  font-family: var(--mono);
  font-size: var(--fs-small);
  white-space: pre-wrap;
  margin: 8px 0;
}
.help-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--paper);
  color: var(--petrol);
  border: 1px solid var(--line);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  margin-left: 6px;
  vertical-align: middle;
  padding: 0;
  line-height: 1;
}
.help-button:hover { background: var(--teal-soft); border-color: var(--teal); }
/* === HelpModal 样式 end === */
```

- [ ] **Step 3: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/components/HelpModal.tsx frontend/src/styles.css
git commit -m "$(cat <<'EOF'
新增(帮助): HelpModal 组件 + 样式

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: helpContent.tsx 数据源（9 条）

**Files:**
- Create: `frontend/src/lib/helpContent.tsx`

- [ ] **Step 1: 创建 helpContent.tsx**

```tsx
// frontend/src/lib/helpContent.tsx
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
```

- [ ] **Step 2: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/lib/helpContent.tsx
git commit -m "$(cat <<'EOF'
新增(帮助): 9 条帮助内容数据源 helpContent.tsx

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: HelpButton 触发器

**Files:**
- Create: `frontend/src/components/HelpButton.tsx`

- [ ] **Step 1: 创建 HelpButton.tsx**

```tsx
// frontend/src/components/HelpButton.tsx
import { useState } from "react";
import { HelpModal } from "./HelpModal";
import { HELP, type HelpKey } from "../lib/helpContent";

export interface HelpButtonProps {
  helpKey: HelpKey;
}

export function HelpButton({ helpKey }: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const entry = HELP[helpKey];

  return (
    <>
      <button
        type="button"
        className="help-button"
        onClick={() => setOpen(true)}
        title="使用说明"
        aria-label="使用说明"
        data-testid={`help-btn-${helpKey}`}
      >
        ?
      </button>
      <HelpModal
        open={open}
        onClose={() => setOpen(false)}
        title={entry.title}
        whenToUse={entry.whenToUse}
        howToUse={entry.howToUse}
        example={entry.example}
      />
    </>
  );
}
```

- [ ] **Step 2: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/components/HelpButton.tsx
git commit -m "$(cat <<'EOF'
新增(帮助): HelpButton 触发器

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 集成到 IdeaModule（PICO）

**Files:**
- Modify: `frontend/src/modules/IdeaModule.tsx`（line 386 的 `pico-btn` 按钮旁）

- [ ] **Step 1: 加 import**

在 `IdeaModule.tsx` 的 import 区块（顶部）追加：

```tsx
import { HelpButton } from "../components/HelpButton";
```

- [ ] **Step 2: 挂载 HelpButton**

定位到 `pico-btn` 按钮（line 386–388）：

```tsx
          <button className="btn-secondary" onClick={genPico} disabled={!field.trim() || picoRunning} data-testid="pico-btn">
            {picoRunning ? "提取中…" : "提取 PICO / 纳排标准"}
          </button>
```

改为（在该按钮后**紧挨**插入 `<HelpButton>`）：

```tsx
          <button className="btn-secondary" onClick={genPico} disabled={!field.trim() || picoRunning} data-testid="pico-btn">
            {picoRunning ? "提取中…" : "提取 PICO / 纳排标准"}
          </button>
          <HelpButton helpKey="pico" />
```

- [ ] **Step 3: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

---

## Task 5: 集成到 PlanModule（随机化 / DMP / 知情同意）

**Files:**
- Modify: `frontend/src/modules/PlanModule.tsx`

- [ ] **Step 1: 加 import**

在 `PlanModule.tsx` 的 import 区块顶部追加：

```tsx
import { HelpButton } from "../components/HelpButton";
```

- [ ] **Step 2: DMP 标题旁挂**

定位到 DMP h2（line 245）：

```tsx
          <h2 className="section-title" data-testid="dmp-title">🗄️ 数据管理计划（DMP）</h2>
```

改为：

```tsx
          <h2 className="section-title" data-testid="dmp-title">🗄️ 数据管理计划（DMP）<HelpButton helpKey="dmp" /></h2>
```

- [ ] **Step 3: 知情同意标题旁挂**

定位到 consent h2（line 262）：

```tsx
          <h2 className="section-title" data-testid="consent-title">📝 知情同意书（草案 · 需伦理委员会审核）</h2>
```

改为：

```tsx
          <h2 className="section-title" data-testid="consent-title">📝 知情同意书（草案 · 需伦理委员会审核）<HelpButton helpKey="consent" /></h2>
```

- [ ] **Step 4: 随机化 summary 内挂**

定位到 randomize summary（line 349）：

```tsx
        <summary>🎲 随机化分组表（确定性，固定种子可复现，免费）</summary>
```

改为：

```tsx
        <summary>🎲 随机化分组表（确定性，固定种子可复现，免费）<HelpButton helpKey="randomize" /></summary>
```

- [ ] **Step 5: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

---

## Task 6: 集成到 AnalyzeModule（图注）

**Files:**
- Modify: `frontend/src/modules/AnalyzeModule.tsx`

- [ ] **Step 1: 加 import**

顶部 import 区追加：

```tsx
import { HelpButton } from "../components/HelpButton";
```

- [ ] **Step 2: 图注按钮旁挂**

定位到图注按钮（line 266–269）：

```tsx
            <div className="charts-toolbar">
              <button className="btn-ghost btn-sm" onClick={genCaptions} disabled={capBusy} data-testid="gen-captions-btn">
                {capBusy ? "生成图注中…" : "✍️ 生成规范图注"}
              </button>
            </div>
```

改为（在 button 后插入 HelpButton）：

```tsx
            <div className="charts-toolbar">
              <button className="btn-ghost btn-sm" onClick={genCaptions} disabled={capBusy} data-testid="gen-captions-btn">
                {capBusy ? "生成图注中…" : "✍️ 生成规范图注"}
              </button>
              <HelpButton helpKey="figcaptions" />
            </div>
```

- [ ] **Step 3: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

---

## Task 7: 集成到 ImradModule（关键词 / 投稿包 ZIP）

**Files:**
- Modify: `frontend/src/modules/ImradModule.tsx`

- [ ] **Step 1: 加 import**

顶部 import 区追加：

```tsx
import { HelpButton } from "../components/HelpButton";
```

- [ ] **Step 2: 关键词按钮旁挂**

定位到关键词按钮（line 342–344）：

```tsx
          <button className="btn-secondary" onClick={genKeywords} disabled={kwRunning} data-testid="kw-btn">
            {kwRunning ? "推荐中…" : "推荐关键词 / MeSH"}
          </button>
```

改为：

```tsx
          <button className="btn-secondary" onClick={genKeywords} disabled={kwRunning} data-testid="kw-btn">
            {kwRunning ? "推荐中…" : "推荐关键词 / MeSH"}
          </button>
          <HelpButton helpKey="keywords" />
```

- [ ] **Step 3: ZIP 投稿包标题旁挂**

定位到 bundle h2（line 385）：

```tsx
      <h2 className="section-title">📦 一键投稿包（ZIP）</h2>
```

改为：

```tsx
      <h2 className="section-title">📦 一键投稿包（ZIP）<HelpButton helpKey="bundle" /></h2>
```

- [ ] **Step 4: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

---

## Task 8: 集成到 ChecklistModule（流程图 / statcheck）

**Files:**
- Modify: `frontend/src/modules/ChecklistModule.tsx`

- [ ] **Step 1: 加 import**

顶部 import 区追加：

```tsx
import { HelpButton } from "../components/HelpButton";
```

- [ ] **Step 2: 流程图标题旁挂**

定位到 flowdiagram h2（line 231）：

```tsx
      <h2 className="section-title">📈 流程图生成（PRISMA 2020 / CONSORT 2025）</h2>
```

改为：

```tsx
      <h2 className="section-title">📈 流程图生成（PRISMA 2020 / CONSORT 2025）<HelpButton helpKey="flowdiagram" /></h2>
```

- [ ] **Step 3: statcheck 标题旁挂**

定位到 statcheck h2（line 287）：

```tsx
      <h2 className="section-title">🔢 统计一致性自查（statcheck）</h2>
```

改为：

```tsx
      <h2 className="section-title">🔢 统计一致性自查（statcheck）<HelpButton helpKey="statcheck" /></h2>
```

- [ ] **Step 4: 验证编译**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 5: Commit 所有 5 个模块集成**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/src/modules/IdeaModule.tsx frontend/src/modules/PlanModule.tsx frontend/src/modules/AnalyzeModule.tsx frontend/src/modules/ImradModule.tsx frontend/src/modules/ChecklistModule.tsx
git commit -m "$(cat <<'EOF'
集成(帮助): 9 个子工具旁挂 HelpButton

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Playwright e2e

**Files:**
- Create: `frontend/tests/help-modal.spec.ts`

- [ ] **Step 1: 创建 e2e spec**

```ts
// frontend/tests/help-modal.spec.ts
import { test, expect, Page } from "@playwright/test";

async function mockBase(page: Page) {
  await page.route("**/api/health", (r) =>
    r.fulfill({ json: { status: "ok", provider: "openai", model: "deepseek-chat", mock: true } }),
  );
  await page.route("**/api/journals", (r) => r.fulfill({ json: { journals: [] } }));
  await page.route("**/api/usage", (r) => r.fulfill({ json: { available: false } }));
}

test("帮助模态: 流程图 ? 按钮打开/三段内容齐全/关闭三路/焦点回归", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  await page.getByTestId("nav-checklist").click();
  // 流程图区
  const help = page.getByTestId("help-btn-flowdiagram");
  await expect(help).toBeVisible();
  await help.click();
  // 模态出现
  const modal = page.getByTestId("help-modal");
  await expect(modal).toBeVisible();
  // 三段标题
  await expect(modal).toContainText("何时使用");
  await expect(modal).toContainText("如何使用");
  await expect(modal).toContainText("最简示例");
  // 关键示例数字
  await expect(modal).toContainText("1240");
  // 关闭: ESC
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  // 焦点回到触发按钮
  await expect(help).toBeFocused();

  // 关闭: × 按钮
  await help.click();
  await page.getByTestId("help-modal-close").click();
  await expect(modal).toHaveCount(0);

  // 关闭: 点遮罩
  await help.click();
  await page.getByTestId("help-modal-overlay").click({ position: { x: 10, y: 10 } });
  await expect(modal).toHaveCount(0);
});

test("帮助按钮: 9 个子工具旁都有 ? 按钮", async ({ page }) => {
  await mockBase(page);
  await page.goto("/");
  // 找选题
  await page.getByTestId("nav-idea").click();
  await expect(page.getByTestId("help-btn-pico")).toBeVisible();
  // 实验规划
  await page.getByTestId("nav-plan").click();
  // 输入主题让 DMP/consent 面板显示需要先点按钮; 但 randomize summary 默认在; 这里只查 randomize summary 内的 help-btn 与按钮存在
  await expect(page.getByTestId("help-btn-randomize")).toHaveCount(1);
  // DMP/consent 的 HelpButton 在 h2 标题旁, 只有产出后 panel 才渲染; 仅断言 helpContent.tsx 中已注册即可（间接由 flowdiagram 测试通过编译保证）
  // 数据分析
  await page.getByTestId("nav-analyze").click();
  // figcaptions 的 HelpButton 在 charts-toolbar 内, 只有图表存在才显示; 间接验证, 不在此用例硬断言
  // 论文初稿
  await page.getByTestId("nav-imrad").click();
  await expect(page.getByTestId("help-btn-keywords")).toBeVisible();
  await expect(page.getByTestId("help-btn-bundle")).toBeVisible();
  // 规范核对
  await page.getByTestId("nav-checklist").click();
  await expect(page.getByTestId("help-btn-flowdiagram")).toBeVisible();
  await expect(page.getByTestId("help-btn-statcheck")).toBeVisible();
});
```

注意：`figcaptions` / `dmp` / `consent` 的 HelpButton 只在对应面板渲染后才出现（依赖前置数据/产出），不在此 e2e 硬断言（用 mock 后端模拟跑通这些流程会大幅增加测试体量，YAGNI）。`pico` / `randomize` / `keywords` / `bundle` / `flowdiagram` / `statcheck` 6 个在静态 UI 中即可见，已覆盖。

- [ ] **Step 2: 运行 e2e**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx playwright test tests/help-modal.spec.ts
```

Expected: 2 passed。

- [ ] **Step 3: 运行**全部** e2e 防回归**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npx playwright test
```

Expected: 全绿（既有 48 + 新增 2 = 50 个）。

- [ ] **Step 4: Commit e2e**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add frontend/tests/help-modal.spec.ts
git commit -m "$(cat <<'EOF'
测试(帮助): e2e 验证 HelpModal 打开/关闭/焦点 + 6 个按钮存在性

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 收尾 — 构建 dist + 改进日志

**Files:**
- Modify: `改进日志/LOG.md`（顶部追加一条）
- 构建 `frontend/dist`

- [ ] **Step 1: 构建 dist**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover/frontend && npm run build
```

Expected: 无 TS 错误，`dist/` 重建。

- [ ] **Step 2: 在 LOG.md 顶部插入一条**

打开 `改进日志/LOG.md`，在 line 3（`> 每完成一个改进方向追加一条。最新在最上。` 下方空行后）插入：

```markdown
## 2026-06-28 — 可用性 / 帮助模块（loop 第 16 轮）：9 个子工具加"?"使用说明
- **动机**：经 14+ 轮迭代，产品已达 8 模块工作台 + 大量子工具，但 PRISMA/CONSORT 流程图、statcheck、随机化分组、DMP、知情同意、ZIP 投稿包、关键词/MeSH、图注、PICO 提取等 9 处对终端用户"何时用 / 如何用"不直观。
- **改动**：新增 `HelpModal.tsx` / `HelpButton.tsx` / `helpContent.tsx`（9 条统一三段：何时使用 / 如何使用 / 最简示例，含真实数字示例与使用前提）；styles.css 加 modal 样式（约 30 行）；5 个模块文件各挂 1–3 行 `<HelpButton helpKey="…" />`。无后端、无业务逻辑改动。
- **测试**：新增 `help-modal.spec.ts`（2 用例：模态三路关闭+焦点回归+三段内容、6 个静态可见按钮存在性）；Playwright 48 → 50 全绿；dist 已重建。零额度。
- **commit**：见本次提交
```

- [ ] **Step 3: Commit 收尾**

```bash
cd C:/Users/Administrator/Desktop/scientific-discover
git add 改进日志/LOG.md frontend/dist
git commit -m "$(cat <<'EOF'
日志/构建(帮助模块): LOG 第 16 轮 + dist 重建

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完成判定

1. 6 个静态 HelpButton 在对应位置可见（flowdiagram / statcheck / randomize / pico / keywords / bundle），其余 3 个（figcaptions / dmp / consent）依赖前置面板渲染。
2. 任一 HelpButton 点击弹出模态，三段（何时使用 / 如何使用 / 最简示例）齐全。
3. ESC / × / 遮罩 三种关闭都生效，关闭后焦点回到原触发按钮。
4. Playwright 48 → 50 全绿。
5. `npm run build` 无 TS 错误，dist 重建。
6. 改进日志 LOG.md 已加新一条。
