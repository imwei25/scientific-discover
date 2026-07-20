---
name: data-integrity
description: 论文源数据的数值完整性自查（sanity check）。投稿前扫一遍自己的 Excel/CSV/TSV（或 pdf/docx 里的表格），找出会被审稿人 / 编辑 / PubPeer 盯上的可疑数值模式——复制粘贴错误、列间常数偏移/固定比例、跨表跨文件复用、"整数差+相同高精度小数尾"的抄改痕迹、GRIM/GRIMMER 均值方差不自洽、末位数分布异常等——好在投稿前主动核对或补说明。也可用于审阅他人 / 合作方的数据。当用户说"数据自查 / 查查我的源数据有没有问题 / 会不会被质疑造假 / source data audit / 数据完整性 / PubPeer / 投稿前数据核查"时使用。底层封装 paperconan CLI。**边界**：只看结构化数值表，**不看**图像 / western blot / 像素级图片篡改（那不归本技能）；且它只出"待核信号"，**绝不下"造假"结论**。
---

# 数据完整性自查技能（data-integrity）

封装第三方 CLI **paperconan**（源数据数值取证），本仓库把它定位成**投稿前"自查 QC"**：帮作者提前发现自己真实数据里那些*看着可疑、但多半有正当解释*的数值模式，主动核对或在文中补说明，避免被审稿人 / PubPeer 拿住。

## 铁律：signal not verdict（信号，不是判决）
- 本技能的产出**永远是"待人工核对的信号"，不是不端结论**。禁止输出"疑似造假 / 数据作假 / 学术不端"这类指控性措辞。
- 对每一条 flag，**先给良性解释**（见下"良性解释优先"），把它措辞成"这几处可能被审稿人质疑，建议你核对原始记录 / 在 Methods 里说明来源"。
- 只有用户明确是在**审阅他人数据 / 准备 PubPeer** 时，才转成"值得进一步核实的疑点"口径——即便如此也只提问题、不定性。

## 定位（在套件中的位置）
顶层主控（AGENTS.md）判意图后派到这里就**直接做**。在 `paper` 流水线里是 `data-analysis` 之后、`write-paper` 之前的**可选质量闸**（对"用户上传的原始数据"跑一遍自查）；也可作单步直派（"帮我查下这份数据"）。产物直接写**当前工作目录**——网关已把本会话的 cwd 指到该会话的产物目录，用裸文件名即可，**勿写仓库根**。

## 前置合规
- **数据含患者姓名 / 身份证 / 住院号 / 手机号等可识别信息 → 先走 `deidentify` 脱敏**，再扫描。本技能只碰数值，但扫描目录里别混入未脱敏的原始表。

## 运行环境
Python 用项目根 `.venv`（系统没装 Python）。paperconan 已装在 `.venv` 里。

```
# Windows
${REPO_ROOT:-/app}/.venv/bin/python -X utf8 -m paperconan <数据目录> --md
# Linux / macOS
${REPO_ROOT:-/app}/.venv/bin/python        -X utf8 -m paperconan <数据目录> --md
```

- **必须带 `-X utf8`**：否则中文 Windows 默认 gbk 编码，写 REPORT.md 遇到 `²`/`±` 等符号会 `UnicodeEncodeError` 崩掉（scan.json 能出、REPORT.md 会失败）。等价地可设环境变量 `PYTHONUTF8=1`。
- paperconan 吃**一个目录**（不是单个文件）：把要查的 `*.xlsx/*.csv/*.tsv`（或含表格的 `*.pdf/*.docx`）放进一个目录再指过去。

### 常用参数
- `--md`：额外写人类可读的 `REPORT.md`（默认只出 `scan.json` + `report.html`）。**建议总是带上**，便于你读。
- `--out <目录>`：产物输出目录（默认 `<数据目录>/audit/`）。指到 `audit/`。
- `--profile review|forensic|triage`：假阳性处理档位。**默认 `review`**（平衡，实测本仓库真实临床定量数据下 0 误报）；`forensic` 更敏感（审别人时用，误报升高）；`triage` 最宽松只留强信号。
- `--doi <DOI>` / `--title <标题>`：把出处记进 scan.json（做 provenance / PubPeer 时用）。

## 工作流程
1. **确认 CLI**：`${REPO_ROOT:-/app}/.venv/bin/python -m paperconan --version`（应回 `paperconan 0.x`）。缺了就 `${REPO_ROOT:-/app}/.venv/bin/python -m pip install "paperconan[all]"`。
2. **备数据目录**：把用户要查的表格文件集中到一个目录（如 `pc-in/`）；含患者信息的先脱敏。
3. **跑扫描**：`... -X utf8 -m paperconan pc-in --md --out audit`。**不许编造扫描结果**，一切以 CLI 产物为准。
4. **读产物**：先看 CLI 末尾摘要（files / blocks with findings / digit·decimal anomaly sheets），再读 `audit/REPORT.md`（High / Medium / 末位数 χ² / 两位小数过表征四段）与 `audit/scan.json`（结构化明细，定位到 文件·sheet·行·检测器·数值）。
5. **复核并汇报**：对每条 High/Medium，**回原表看一眼**具体单元格，套"良性解释优先"给出判断，再按上面"铁律"的自查口径向用户汇报，并列出 `report.html` 路径供其自查细看。

## 良性解释优先（临床/检验数据尤其容易误报，先排除这些）
paperconan 的检测器是"看着像人为构造"的统计红旗，但很多**正当数据结构**天生就会触发。核对时先想是不是下面这些：
- **百分比 / 构成比**：两列恒和 100%、互补关系 → `sum_constant`。正常。
- **单位换算 / 派生列**：B = A×系数、B = A+常数（如 ℃/℉、稀释倍数、log 转换）→ `constant_offset`/`constant_ratio`/`exact_linear`。正常。
- **标准化 / 归一化 / 公式列**：同一公式算出的列共享小数尾、四舍五入到固定网格（整数 / 0.5 / 0.25）→ `within_col_decimal_repetition`/`rounded_to_half_or_int`。正常。
- **仪器量程 / 检测限**：值卡在固定档位、末位缺某些数字 → `missing_last_digits`/`last_digit_chi_square`。多为仪器/记录习惯。
- **小样本重复测量 / 阳性对照**：同一标准品在多孔重复 → `within_col_value_duplication`。正常。
- **优先看跨表信号**：`cross_sheet_*`（跨 sheet / 跨文件的位置相同、数值重叠、小数尾复用、整列重复）优先级最高——**这类最难用"正当结构"解释**，若非模板/公式联动，值得重点核对。

> 关键区分：**paperconan 的 `report.html` = 检测器原始输出**（机器信号）；**你给用户的 = 经你复核+良性解释后的自查摘要**（人工裁定）。两者别混为一谈，也别把 severity 当成"造假程度"。

## 汇报模板（自查口径）
- 一句话结论：扫了 N 个文件，`review` 档下 High X 条 / Medium Y 条（0 条就直说"未触发需关注的信号，数据在这些维度上没有会被质疑的模式"）。
- 对每条 flag：**位置**（文件 / sheet / 行 / 列）＋**检测器与具体数值**＋**最可能的良性解释**＋**给作者的建议**（"核对原始记录"或"在 Methods 里说明这列是 X 换算/归一化得到"）。
- 附 `report.html` 路径，供用户自己细看。
- **收尾提醒**：这是算法信号、非结论；最终以原始实验记录与作者说明为准。

## p 值一致性自查（`pcheck.py`，与 paperconan 正交、查稿件正文）
paperconan 查**源数据表**的数值模式；`pcheck.py` 查**稿件正文里报告的统计检验**——从 `t/F/r/z/χ²` 的统计量+自由度**重算 p 值**，比对作者所报的 p，揪出 statcheck 式不一致。二者互补：一个看原始数据、一个看结果文字。

```
# 扫一篇稿件（Methods/Results 里的检验报告）
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/data-integrity/pcheck.py manuscript.md --outdir audit
# 或直接给一段文本
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/data-integrity/pcheck.py --text "t(28)=2.05, p=.02"
```
- 只认**统计量+自由度+p 三者齐全**的句子（如 `t(28)=2.05, p=.048`、`F(2,57)=3.11, p=.05`、`χ²(1)=4.10, p=.04`）；缺自由度的裸统计量无法重算、自动跳过。
- 产出 `pcheck.md` / `pcheck.csv`，三档：**🔴 DECISION_ERROR**（重算跨过 .05 而报告没跨，或反之——显著性判断相反，最需核对）、**🟡 INCONSISTENT**（数值不符但同侧于 .05，多为笔误/四舍五入）、**🔵 ONE_TAILED**（两尾对不上但≈重算/2，可能按单尾报告）。
- **同样 signal not verdict**：报告措辞成"这几处 p 请回原始分析核对（单双尾？笔误？）"，**绝不**据此下造假结论。默认按**两尾**重算——若研究预先声明单尾，ONE_TAILED 档多属正常。
- 用在 `write-paper` 的"数字来源核对"之后、或 `peer-review` 的机械可核对项里当一道自动闸；纯描述性、无 NHST 检验的稿件跳过。

## 环境注意（实测）
- **必带 `-X utf8`**（见上），否则中文 Windows 写 REPORT.md 崩。
- 真实临床定量数据实测 `review` 档 **0 误报**；换 `forensic` 会更敏感、误报上升，审别人数据再用。
- 依赖已并入 `scripts/requirements-skills.txt`（`paperconan[all]`，含 `python-calamine` 读旧版 xls 的 Rust 引擎、`pdfplumber` 抽 pdf 表）。来源与许可见仓库根 `THIRD_PARTY_SKILLS.md`。
