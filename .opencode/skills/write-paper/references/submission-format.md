# 排版交付格式细则（默认送审预设 / 按期刊稿约）

> 本文件从 SKILL.md「排版交付格式」节搬出，由 SKILL.md 在定稿出件排版时引用。

判一件事：**用户指定目标期刊了没有**。

**A. 没指定 / 说"不知道投哪" → 直接用默认送审格式出件**，别追问格式细节：
```bash
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --journal generic-submission
```
（要 PDF 就把同一个 `--journal generic-submission` 给 `render-pdf-doc/scripts/render_pdf.sh`。）
该预设 = 下面这套默认要求，一个参数全落齐，**不必再手敲字体字号**：

| 项 | 默认值 |
|---|---|
| 字体 | 全文 Times New Roman（中文字符走宋体） |
| 正文字号 / 行距 | 12pt / 1.5 倍行距（目标刊要求双倍时加 `--line-spacing double`） |
| 图表 | 表内 10pt、单倍行距；图题表题 10.5pt 居中、序号加粗 |
| 标题 | 论文标题 16pt、一级标题 14pt、其余 12pt，**全部加粗**（各级都不小于正文） |
| 作者与机构 | 10.5pt 居中 |
| 首行缩进 | 每段 4 个英文字符 |
| 行号 / 页码 | **不加行号**（目标刊要求连续行号时加 `--line-numbers`，NEJM/JAMA/Lancet/BMJ 预设已含）；页脚居中页码 |
| 页边距 | 1in（**不限**；稿件太长可换窄边距 `--margin 0.75in`，太短保持默认） |
| 表格 | 三线表：顶/底 1.5 磅、表头下 0.5 磅、无竖线；**表宽拉满版心**（列宽按内容分配后等比撑满）；表注在表格下一行 |
| 图表位置 | **放正文对应位置**，不后置（个别刊要求后置时才加 `--figures-at-end`） |
| 参考文献 | 期刊名写全称；作者 >3 位时第 3 位之后用 et al.（**这条由写作层保证，排版脚本改不了**） |

**B. 指定了期刊 → 先查该刊稿约，再按查到的要求排**，别拿默认值硬套：
1. 先看有没有现成预设：`--journal list`（已内置 nejm / lancet / jama / bmj / cmj 等）——有就直接用。
2. 没有预设 → **WebFetch 该刊官网的 Instructions for Authors / Author Guidelines**（搜"<刊名> instructions for authors"），把字数上限、摘要结构、图表数量、参考文献风格与上限、行距行号要求、图表是否后置逐项**摘出来告诉用户**，再用 `--font/--fontsize/--margin/--line-spacing/--line-numbers/--csl` 落到命令上；常用的可照 `render-docx/presets/README.md` 存成新预设。
3. **查不到或联网不可用**：如实说明，退回 `--journal generic-submission`，并提示用户投稿前对照该刊稿约复核——**不要凭印象编该刊的格式要求**。
4. 页数：多数刊的正文上限在 **30 页**上下（超 1–3 页一般无妨）。脚本不统计页数，**交付时提醒用户在 Word 里看实际页数**；超出优先砍讨论、把敏感性/亚组移补充材料。

> 上表里排版脚本**做不到**的两项，写作阶段就得写对：**参考文献的期刊全称与 et al. 规则**（`[n]` 文本引用不会被 CSL 重排）、**图表在正文中的位置**（脚本按稿件里的位置渲染）。
