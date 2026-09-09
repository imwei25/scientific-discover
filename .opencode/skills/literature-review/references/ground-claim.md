# ground_claim.py 用法与分档解读（引用溯源到原句）

> 本文件从 SKILL.md「引用溯源到原句（`ground_claim.py`）」搬出，由 SKILL.md 在写完综述做句级转述自查（阶段 5 第 3 步）时引用。完整参数以 `python ground_claim.py --help` 为准。

## 用法
```
# 单条：论断 + 它引的一个或多个 DOI/PMID
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py" "他汀降低卒中复发风险" 10.1056/NEJMoa1615664 PMID:27295427
# 批量：CSV 两列 claim,ref，把综述里每个"论断→引用"对逐条核
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/ground_claim.py" --input claims.csv
```

## 产出与分档解读
- 产出 `claim_grounding.md` / `.csv`。分档：**GROUNDED**（≥0.45，措辞高度相关）、**CHECK**（0.25–0.45，请人工确认）、**WEAK**（<0.25，⚠️ 摘要里找不到支撑句——可能转述失真，或支撑点在全文正文）、**NOTFOUND/NOABSTRACT**（取不到文献/无摘要）。
- **关键在"捞出的原句"，分数只用来排优先级**：TF-IDF 对短转述天然保守，忠实的转述常落 CHECK 档但会把**正确的原句**摆到你面前——照着确认措辞即可。WEAK 且无相关句才是真信号。
- ⚠️ **只对英文论断有效（TF-IDF 词面匹配、不跨语言）**：Europe PMC 摘要基本全英文，**中文论断对英文摘要会恒判 WEAK/0.0，与转述是否准确无关**——分数失去意义。所以核对时**把该条论断先translate成英文再传给脚本**（用你自己译的英文短句）；若坚持传中文论断，则 WEAK 一律当"未测"、必须人工回原文核，别信这个分。
- 摘要没有的支撑点 → 用 `fulltext-retrieval` 下全文再核（本脚本只看摘要）。
