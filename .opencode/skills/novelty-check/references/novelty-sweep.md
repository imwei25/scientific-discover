# 新颖性扫描——操作细则、诚实性清单与产出模板

> 反面教材：Sakana AI Scientist v2 给自己的产出打"新颖"，独立评审却发现同一片地早被人测绘过。失败是结构性的——系统只搜自己已知的、接受自己对"空白"的框定、没有任何能反驳自己的对抗步骤。
>
> **纠正不是让 AI"再努力想想"，而是对真实文献库跑一次它无法幻觉的实时检索，再诚实分类——包括那个最不想要的裁定："已被回答，杀掉。"**

## Step 0 — 构造查询（PICO → 检索式）
```
Population:    [MeSH/主题词] OR [自由词同义]
Intervention:  [MeSH/主题词] OR [自由词同义]
Comparison:    (如适用)
Outcome:       [主要结局词]
组合: (P) AND (I) AND (O)；日期默认近 10 年
```
跑**完整式** + **宽松式**（去掉 Outcome 抓邻近工作）。**记下确切检索串**，进裁定记录。

## Step 1 — 主库：Europe PMC（国内可达，主力）
```bash
PY=${REPO_ROOT:-/app}/.venv/bin/python   # Linux/mac: ${REPO_ROOT:-/app}/.venv/bin/python
# literature-review 的 search.py：Europe PMC，结果含被引数(cites)，可按高被引排序
# 用法：多个概念作位置参数，各自 OR 展开；--limit 每式取多少，--since 起始年，--outdir 产物目录
$PY ${REPO_ROOT:-/app}/.opencode/skills/literature-review/search.py "<P 概念>" "<I 概念>" "<O 概念>" --limit 30 --since 2016 --outdir .
```
- 按 `cites`（被引数）降序看：**有一篇高被引论文直接回答了你的问题 → 近乎确定"已被回答"**。
- 关键文献要读全文：`fulltext-retrieval`。
- 有 MCP/境外网络时用 `search-lit` 增强（PubMed 系）——⚠️ 本环境 NCBI 常被阻断，通不了就只靠 Europe PMC + 下面的增强源，别硬撑。

## Step 2 — 系统综述 / 协议注册库（防"还没做就冗余"）
- **Cochrane Library**：`https://www.cochranelibrary.com/search?q=<terms>`（WebFetch 取）
- **PROSPERO**（在做的 SR 协议）：`https://www.crd.york.ac.uk/prospero/` —— 若有 active 记录覆盖你的确切问题，你独立做的 SR 就是重复，**杀或联系对方团队**。
- **Epistemonikos**：`https://www.epistemonikos.org/en/search?q=<query>`

## Step 3 — 试验注册库（在做的原始研究）
| 注册库 | URL | 范围 |
|---|---|---|
| **ChiCTR** | `https://www.chictr.org.cn/searchproj.html` | 中国（首选） |
| ClinicalTrials.gov | `https://clinicaltrials.gov/search?term=<query>` | 美国 + 国际 |
| ISRCTN | `https://www.isrctn.com/search?q=<query>` | 英国 + 全球 |

筛 Recruiting / Active。若一个大 RCT 还有数年随访，把你的定位成 pilot/探索性，别当定论性研究。

## Step 4 — 广覆盖增强（非索引刊、预印本、引用图）
- **OpenAlex**：`https://api.openalex.org/works?search=<query>&filter=publication_year:2016-&sort=cited_by_count:desc&per_page=20&mailto=<你的邮箱>`（已装 `pyalex`）。**只需邮箱进 polite pool、不需要 API key**（与 research-scan 口径一致，2026-07 实测匿名可调）；如遇限流：先加 `mailto`；仍不通再退回 Europe PMC 人工归纳并把该节标"仅线索、未核实"。
- **Europe PMC** 本身含预印本（medRxiv/bioRxiv），Step 1 已覆盖。
- **Semantic Scholar**：`https://api.semanticscholar.org/graph/v1/paper/search?query=<query>&fields=title,year,citationCount,influentialCitationCount&limit=20` —— `influentialCitationCount` 高且直接回答你问题的，是强"已被回答"信号。

## Step 5 — 中文与邻近领域
- **中文临床题**查 CNKI / 万方 / SinoMed（无免费 API，用 WebFetch 或让用户代查关键词），别漏中文既有工作。
- 至少跑一次**邻近领域版本**（儿科题→成人版；某癌种→相邻癌种），看答案是否可平移。

## 诚实性清单（给"真新颖"裁定前，10 项必须全勾）
- [ ] 用了 ≥2 组同义词/替代表述（不止你偏好的那一种说法）
- [ ] 查了中文库（CNKI/万方/SinoMed）——如为中文临床活跃题
- [ ] 查了预印本（Europe PMC 覆盖 medRxiv/bioRxiv）
- [ ] 对最接近的 2–3 篇做了相关文献扩展（种子扩展/引用邻域）
- [ ] 查了会 2–3 年内回答同问题的**在做试验**（ChiCTR / ClinicalTrials.gov）
- [ ] 查了 **PROSPERO** 有无在做的同题系统综述
- [ ] 跑了**邻近领域**版本的检索
- [ ] OpenAlex/Semantic Scholar 按被引排序——没有高被引论文直接回答本问题
- [ ] 这个"空白"是**真的证据缺失**，不是"没搜到的角落"
- [ ] 临床/领域专家看过最接近的几篇、同意该问题确实未被回答
> 任一项没勾 → 裁定**不能**是"真新颖"，补齐再判。

## 决策树
```
候选问题
  └─ 跑 Europe PMC + 注册库扫描
       ├─ Cochrane SR / PROSPERO active 已覆盖？ → 是：已被回答 → 杀或联系团队
       └─ 否 → 最接近的 5–10 篇里，有没有在你的人群、足够把握度下直接回答主要终点的？
              ├─ 有（充分把握 RCT/SR/指南） → 已被回答 → 杀；或能论证"为何不适用于我的人群/场景/时点"→ 改判增量
              ├─ 有，但仅低质量证据（观察性/小样本/旧数据/不同亚组） → 增量 → 做，须写明差异点
              ├─ 有，且结果互相冲突 → 有争议 → 做，设计成去裁决
              └─ 无接近文献 → 诚实性清单 10 项全勾？ → 全勾：真新颖 → 进研究设计；否则补检索重判
```

## 产出模板：《新颖性裁定记录》
```markdown
## 新颖性裁定记录
**日期：** YYYY-MM-DD
**问题（PICO）：** ...
**评估人：** [姓名]（人）+ AI 扫描

### 用了哪些查询
- Europe PMC 检索式：`...`
- 其他源检索式：`...`
- 日期范围：YYYY–今；测试的同义词：[列出]

### 注册库检查
- PROSPERO：[有无 active 协议？Y/N—标题]
- ChiCTR / ClinicalTrials.gov：[有无在做试验？Y/N—注册号]

### 最接近的 5–10 篇
| # | PMID/DOI | 标题（短） | 年 | 设计 | N | 与本题相关性 |
|---|---|---|---|---|---|---|

### 它们留下了什么没回答
[2–4 句：现有文献没回答、而本题回答的是什么]

### 诚实性清单
[10 项逐条勾]

### 裁定
[ ] 真新颖 / [ ] 增量 / [ ] 已被回答 / [ ] 有争议

### 差异点陈述
"我们的研究不同于现有文献，因为……"（1–2 句，这句话直接进引言）

### 决定
[ ] 进入预注册与研究设计   [ ] 重构（新问题：___）   [ ] 杀（理由：___）
**用户（💡）签核：** ______  日期：______
```
