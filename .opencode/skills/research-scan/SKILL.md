---
name: research-scan
description: 领域调研 / 背景摸底。快速摸清一个科研或临床方向的全貌：核心问题、主要流派与代表工作、近年趋势、关键团队/机构、争议与未解问题、可切入的空白。产出一份结构化调研简报。当用户说"调研一下某方向""了解某领域现状""这个方向做到什么程度了""背景摸底""帮我 landscape"时使用。边界：只要**领域全貌快扫简报**用本技能；要写**正式有引用的文献综述**用 literature-review；要**跨来源交叉核实一个具体问题**用 deep-research。
---

# 领域调研技能

> **决策规约（照 AGENTS.md §六）**：本技能任何要用户拍板的抉择——方向 / 方案 / 目标刊 / 作图后端 / 纳排标准 / 下一步等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；**别用开放式提问逼用户打字，也别弹交互选项卡（如 AskUserQuestion）**。只有无法枚举的纯事实（手上的数据文件、伦理批号、代表作清单等）才开放式问。

给一个方向，产出一份能让人 15 分钟看懂现状的**调研简报**。参考 K-Dense scientific-skills 的领域扫描思路。

## 定位（本技能在套件中的位置）
顶层主控（AGENTS.md 常驻指令）负责判意图、定范围、派发；派到本技能就**直接做，别回绕**。产物写 `outputs/`（主控注入了会话专属目录 `outputs/<会话id>/` 时以它为准、勿写仓库根固定名——多用户共享会 clobber）。

## Python 环境（可选，用于取真实文献）
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
.venv/Scripts/python.exe   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
.venv/bin/python           # Linux / macOS
```

## 方法
1. **先界定范围**：跟用户确认方向、时间窗（默认近 5 年）、偏基础还是偏临床、简报篇幅（默认 ≤3000 字、证据池 30–50 篇）。能列成选项的（偏基础 / 偏临床、篇幅档位等）照 AGENTS.md §六 给编号候选、用户回一个数字即定。
2. **抓真实证据**（强烈建议，别凭记忆）：
   - 检索文献默认用 `literature-review` 的 `search.py`（Europe PMC，国内可达）；`search-lit` 作为有 MCP/境外网络时的增强路径；需要全文再用 `fulltext-retrieval`。
   - **高被引排序**（无需任何 key、国内可达）：`literature-review` 的 `search.py` 已从 Europe PMC 取回 `citedByCount` 列，直接按它排序即可挑高被引/代表文献——这是零折腾的默认做法。
   - **"关键团队/机构"聚合**（可选增强）：想按机构/作者聚合发文量与趋势，用 **OpenAlex**（已装 `pyalex`）：`from pyalex import Works, config; config.email="你的邮箱"; Works().search("主题").sort(cited_by_count="desc").get()`，机构聚合 `group_by("authorships.institutions.id")`。✅ **OpenAlex 只需邮箱（polite pool），不需要 API key**（2026-07 实测：`config.email` 即可匿名调通；`config.api_key="..."` 只是可选提限额，与 openscience 同法）。真连不通（限流/被墙）再退回用上面 Europe PMC 的结果人工归纳团队，并把该节标"未核实，仅供线索"。**绝不凭记忆编团队名。**
   - 有联网时也可用 web 搜索补充综述、指南、会议动态。
3. **综合成简报**，写到 `outputs/research_scan.md`。

## 简报结构
- **一句话定义**：这个方向在解决什么问题。
- **为什么重要**：临床/科学意义、需求规模。
- **主要流派 / 技术路线**：2-5 条，各自代表工作与优缺点。
- **近年趋势**：这 3-5 年往哪个方向走（用文献佐证）。
- **关键团队 / 机构 / 平台**：谁在引领。
- **争议与未解问题**。
- **可切入的空白**：3-5 个，标注难度与所需资源（衔接 `topic-selection`）。
- **参考文献**：列真实文献（标题/年份/DOI）。

## 约定
- 产出写 `outputs/research_scan.md`。
- **出 PDF（正式报告默认交付版）**：简报写完后，把 `outputs/research_scan.md` 交给 `render-pdf-doc` 技能渲染成 `outputs/research_scan.pdf`。中文报告务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则会漏字。
- 有据可依：能引文献的论断都引；拿不准的标"待核实"，不要言之凿凿。
- **绝不虚构文献、数据或团队名**。联网受限时说明局限。
