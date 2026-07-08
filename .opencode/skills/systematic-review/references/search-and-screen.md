# 系统检索 + 双人筛选（可复现是硬指标）

## 一、系统检索式构建（PICO 概念表法）
1. **拆概念**：把 PICO 每个要素拆成一个概念块（P、I、O 通常各一块；C 视情况）。
2. **每概念两路取词**：受控词（PubMed MeSH、Embase Emtree）+ 自由词（标题/摘要同义词、缩写、旧称、拼写变体）。
   - MeSH 用 `[Mesh]`；不想爆炸（含下位词）用 `MeSH:NoExp`；只查主题词用 `[Majr]`。
3. **组合逻辑**：**概念内 OR、概念间 AND**。`(P1 OR P2 OR …) AND (I1 OR I2 OR …) AND (O1 OR …)`。
4. **加限定**（谨慎）：语言、年份、研究类型过滤器。⚠️ 用"高敏检索过滤器"（如 Cochrane RCT filter）而非随手加 `[pt]`，以免漏检。
5. **敏感度目标**（按综述类型）：
   - 系统综述/Meta：**敏感度优先，目标 >95% 查全**（宁可多筛，别漏）。
   - Scoping review：敏感度与精确度平衡。
   - Rapid review：可提精确度、缩范围，但**须声明这是局限**。

## 二、PRESS 同行评议自查（提交检索式前过一遍）
Peer Review of Electronic Search Strategies 六项：① 是否贴合研究问题（PICO 齐全）；② 布尔逻辑与括号是否正确（AND/OR 没搭错）；③ 受控词与自由词是否都覆盖、有无漏同义词；④ 字段标签、截词、邻近算符用对没有；⑤ 语言/年份等限定是否会误伤查全；⑥ 行数与命中量是否合理（过少可能漏、过多可能逻辑松）。有条件请**信息专员/馆员**过一遍。

## 三、检索文档化（PRISMA-S）
每个数据库**逐字记录**：库名与平台、检索日期、**完整检索式原文**、命中数、任何过滤器。这样才可复现、可在论文附录里贴出。检索执行走 `literature-review` 的 `search.py`（Europe PMC，国内可达）或 `search-lit`（PubMed 系，注意本环境 NCBI 可能被阻断）。

## 四、多库语法差异（同一逻辑，换写法）
| 库/平台 | 受控词 | 字段/邻近 | 备注 |
|---|---|---|---|
| PubMed | `[Mesh]` `[Majr]` `[tiab]` | `[tiab]`，无真正邻近 | 自动词映射会扩，精确检索加引号 |
| Embase(Ovid) | `/`(Emtree) `exp` | `.ti,ab.` `adjN` | `exp` 爆炸下位词 |
| Cochrane CENTRAL | MeSH 树 | `:ti,ab,kw` `NEAR/N` | 找 RCT 的核心库 |
| Web of Science | 无受控词 | `TS=` `NEAR/n` | 靠自由词，重同义词覆盖 |
| CNKI/万方/SinoMed | 主题词表 | 主题/篇名/摘要 | 中文题必查，别漏中文既有工作 |

## 五、去重后进入双人筛选——CSV 列规范（喂 `sr_prisma_count.py`）
去重脚本产出 `01_deduplicated.csv`。据此建**标题摘要筛选表** `02_title_abstract_screen.csv` 与**全文筛选表** `03_fulltext_screen.csv`，列名如下（计数脚本按这些列读，别改名）：

| 列 | 取值 | 说明 |
|---|---|---|
| `record_id` | R0001… | 与去重表对应 |
| `reviewer1_decision` | include / exclude / unclear | 评审者 1 **独立**判定 |
| `reviewer2_decision` | include / exclude / unclear | 评审者 2 **独立**判定 |
| `consensus_decision` | include / exclude | 冲突消解后的**共识**（脚本按它计数）|
| `conflict` | Y / N | 两人是否分歧（供追踪，人工消解）|
| `pdf_retrieved` | Y / N | **仅全文表**：全文拿到没 |
| `exclusion_reason_category` | 文本 | **仅全文表**：排除理由分类（喂 PRISMA 排除理由频次）|

**判定规则**：两人独立判 → 分歧标 `conflict=Y` → 第三人或讨论消解 → 填 `consensus_decision`。**不确定一律先 include**（保守，留到全文阶段）。κ 由脚本按 reviewer1/2 算；**κ<0.6（moderate 以下）说明标准没对齐**，校准纳排定义后重筛该批。

## 六、去重阈值与坑
- `--fuzzy` 默认 0.92：标题模糊匹配阈值，只在**同一年**内比对、且长度差 <30% 才比，降低误并。会议摘要 vs 全文、勘误 vs 原文可能被误判，**canonical 记录选字段最全的那条**，被并记录仍留在 CSV（`dup_of` 可回溯）——人工抽查高相似对。
- DOI/PMID 精确匹配最可靠；跨库导出务必带 DOI。
