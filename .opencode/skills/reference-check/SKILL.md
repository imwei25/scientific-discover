---
name: reference-check
description: 文献真实性核查 / 查假引用。把稿件或参考文献列表里的每条引用去 Crossref 和 PubMed/Europe PMC 对一遍，揪出 AI 常编的假引用——不存在的 DOI/PMID、张冠李戴（DOI 真但标题对不上）、纯属虚构的标题。当用户说"核对参考文献""这些引用是真的吗""查假引用""验证 DOI""AI 会不会编文献""引用真实性""查重引用来源"时使用。
---

# 文献真实性核查技能

**AI 写作最大的坑就是编引用**。本技能用脚本把每条引用对到真实数据库，标出可疑的。参考 CiteMe / Scholar Sidekick / Citely 的核查思路。

## Python 环境
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
.venv/Scripts/python.exe   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
.venv/bin/python           # Linux / macOS
```
已装 requests / bibtexparser / rispy。

## 用法
```
# 核查参考文献文件（.bib / .ris / 每行一条的 .txt 都行）
.venv/Scripts/python.exe .opencode/skills/reference-check/verify_refs.py --input outputs/refs.bib

# 或直接给几个 DOI / PMID / 标题
.venv/Scripts/python.exe .opencode/skills/reference-check/verify_refs.py "10.1038/xxx" "PMID:12345678" "某篇论文标题"
```

## 判定结果（按风险从高到低）
| 结论 | 含义 | 该怎么办 |
|---|---|---|
| `FABRICATED` | DOI/PMID 查无，**标题也查不到** | 几乎肯定整条编的，删掉或重找 |
| `ID_FAKE` | **DOI/PMID 查无，但按标题查到真实文献**（论文真、号是 AI 编的）| 用报告给出的**正确 DOI/PMID 替换**即可 |
| `NOT_FOUND` | 只有标题、库里查不到匹配 | 疑似虚构，人工确认 |
| `MISMATCH` | DOI/PMID 存在但指向的标题对不上 | 引错号或标题是编的，核对更正 |
| `CHECK` | 标题部分吻合 | 人工看一眼 |
| `OK` | 存在且标题吻合 | 通过 |
| `ERROR` | 查询失败（网络等） | 重试 |

## 产出（outputs/）
- `reference_check.csv`：逐条结论 + 相似度 + 实际匹配到的标题。
- `reference_check.md`：按风险分组的人读报告。
- **出 PDF（需要留档/交付时）**：把 `outputs/reference_check.md` 交给 `render-pdf-doc` 技能渲染成 `outputs/reference_check.pdf`。中文报告务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则会漏字。

## 约定
- 常配合使用：`search-lit` 导出的 `refs.bib`、或用户稿件里的参考文献。
- 报告时**重点先讲 FABRICATED / ID_FAKE / NOT_FOUND / MISMATCH 这几条**，给出建议（删除/替换正确号/更正/重找）。
- **`ID_FAKE` 是最常见也最好修的**：论文真实存在、只是 DOI 被 AI 编造——直接换成报告里给出的正确 DOI 即可，别当整条假的删掉。
- 这是**辅助**核查：`NOT_FOUND` 不等于一定假（可能库里没收录），提示用户人工复核，别武断下结论。
- 联网失败会标 `ERROR`，如实说明，不要把没查成的当成"真"。
