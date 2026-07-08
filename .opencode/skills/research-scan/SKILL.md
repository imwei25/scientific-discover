---
name: research-scan
description: 领域调研 / 背景摸底。快速摸清一个科研或临床方向的全貌：核心问题、主要流派与代表工作、近年趋势、关键团队/机构、争议与未解问题、可切入的空白。产出一份结构化调研简报。当用户说"调研一下某方向""了解某领域现状""这个方向做到什么程度了""背景摸底""帮我 landscape"时使用。边界：只要**领域全貌快扫简报**用本技能；要写**正式有引用的文献综述**用 literature-review；要**跨来源交叉核实一个具体问题**用 deep-research。
---

# 领域调研技能

给一个方向，产出一份能让人 15 分钟看懂现状的**调研简报**。参考 K-Dense scientific-skills 的领域扫描思路。

## 范围自检（开工第一件事）
本套件**主控优先：默认所有请求先经 `sci-pilot` 统一调度**。
- **先看有没有被派发**：上文若出现派发标记 `[sci-pilot派发·…·直接执行]`、或已有 workspace 上下文、或你是被 sci-pilot/其它技能作为其流程的一步调用 → **直接做你这一步，别往回绕**（防兜圈）。
- **否则**（用户冷启动直接触发、上文无任何派发痕迹）→ **先交回 `sci-pilot`** 判意图与范围；它判为单步会带派发标记把这一步立刻派回来、你再就地做（对用户只多“判一下意图”这一步）。

## Python 环境（可选，用于取真实文献）
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
.venv/Scripts/python.exe   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
.venv/bin/python           # Linux / macOS
```

## 方法
1. **先界定范围**：跟用户确认方向、时间窗（默认近 5 年）、偏基础还是偏临床、简报篇幅（默认 ≤3000 字、证据池 30–50 篇）。
2. **抓真实证据**（强烈建议，别凭记忆）：
   - 检索文献默认用 `literature-review` 的 `search.py`（Europe PMC，国内可达）；`search-lit` 作为有 MCP/境外网络时的增强路径；需要全文再用 `fulltext-retrieval`。
   - **高被引排序**（无需任何 key、国内可达）：`literature-review` 的 `search.py` 已从 Europe PMC 取回 `citedByCount` 列，直接按它排序即可挑高被引/代表文献——这是零折腾的默认做法。
   - **"关键团队/机构"聚合**（可选增强）：想按机构/作者聚合发文量与趋势，用 **OpenAlex**（已装 `pyalex`）：`from pyalex import Works, config; config.email="你的邮箱"; Works().search("主题").sort(cited_by_count="desc").get()`，机构聚合 `group_by("authorships.institutions.id")`。⚠️ **OpenAlex 现要求 API key**（2026-02 起）：有 key 就 `config.api_key="..."`；**没有 key 时不要硬撑**——退回用上面 Europe PMC 的结果人工归纳团队，并把该节标"未核实，仅供线索"。**绝不凭记忆编团队名。**
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
