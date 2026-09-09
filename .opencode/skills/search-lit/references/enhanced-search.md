> 来源：search-lit/SKILL.md 原「检索路径选择」第 4、5 条（多源增强检索 enhanced_search.py / 期刊影响力补列 journal_metrics.py」节原样搬出（渐进披露）。需要跨源广召回、或用户要求按期刊影响力/分区筛选时读；含命令示例、护栏、鉴权与措辞铁律全文。

# 多源增强检索与期刊影响力补列（enhanced_search.py / journal_metrics.py）

4. **多源增强检索**（`references/enhanced_search.py`）——需要**更全的召回**时（交叉学科、
   预印本、按被引/机构补充）用它。一次打通 **Europe PMC + Semantic Scholar + arXiv +
   OpenAlex** 四源，**跨源按 DOI→标题去重**后汇成统一证据表。以 Europe PMC 为国内可达
   骨干：**任一增强源失败（限流/被墙）只跳过并在末尾报告，不中断整体**，境外/代理下四源
   齐发效果最佳。产出对齐 `literature-review/search.py`（`evidence_table.csv` +
   `evidence.md`，多一列 `sources` 标每篇命中的源）。

   ```bash
   PY="${REPO_ROOT:-/app}/.venv/bin/python"   # Linux/macOS: "${REPO_ROOT:-/app}/.venv/bin/python"
   S="${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/enhanced_search.py"
   # 默认四源全开、跨源去重，**条数不限**（命中多少取多少）
   "$PY" "$S" "graph neural network drug discovery" --since 2021 --email you@example.com
   # 只要预印本+跨学科（跳过 PubMed 系）
   "$PY" "$S" "protein language model" --sources semantic_scholar,arxiv,openalex
   # 同一会话里的第 2、3 轮检索：必须带 --tag，否则上一轮的表被挤成 .bak（见上文「多轮检索」节）
   "$PY" "$S" "heart failure outcome" --tag outcome
   ```

   - **检索条数默认不限**（`--limit` 不传即可）：每源每检索式翻页取到源枯竭，各源命中总数会打印
     在 stderr（PRISMA 要记的就是这个数）。**别为了"省事"随手加 `--limit 25`** —— 那会把领域
     里的绝大多数文献挡在外面，而用户看到的只是一份"看起来完整"的证据表。只有用户明确说
     "先看前 N 篇"时才给 `--limit N`。
     - 跑飞护栏：检索式过宽时按 `SCI_SEARCH_MAX`（默认 5000/源/式）截断，**截断一定会打印告警**，
       看到就收窄检索式重跑，或设 `SCI_SEARCH_MAX=0` 取消上限。汇报时如实说"本次被截断到 N 条"。
     - 源方自己的上限不算护栏：Semantic Scholar 的 relevance 检索端点最多只给前 1000 条，
       脚本会单独说明 —— 这种情况要如实转达"该源只给了前 1000 条"，不能说成"共命中 1000 篇"。

   - **OpenAlex 鉴权**：默认走 polite pool，只需 `--email`（或环境变量 `OPENALEX_MAILTO`）
     一个联系邮箱即可**匿名调通，不需要 API key**（与 openscience 同法）；设了环境变量
     `OPENALEX_API_KEY` 会自动带上进 premium pool。**Semantic Scholar** 同理：共享池会
     429 限流（脚本已指数退避），设 `S2_API_KEY` 提限额。
   - 用途边界：`enhanced_search.py` 是**广召回 + 跨源去重**的证据池生成器，产出的 `doi/pmid`
     仍须经 Phase 4 反幻觉协议 / `reference-check` 技能逐条核实后才能进正文引用。

5. **期刊影响力补列与筛选**（`references/journal_metrics.py`）——用户要求"只看高分杂志 /
   某分区以上"时用它给 `evidence_table.csv` 补 `journal_impact` / `journal_quartile` /
   `is_oa` 列，并可直接按条件筛掉。

   ```bash
   PY="${REPO_ROOT:-/app}/.venv/bin/python"
   S="${REPO_ROOT:-/app}/.opencode/skills/search-lit/references/journal_metrics.py"
   "$PY" "$S" evidence_table.csv --email you@example.com            # 只补列
   "$PY" "$S" evidence_table.csv --min-impact 3 --quartile Q1,Q2    # 补列 + 筛选
   "$PY" "$S" evidence_table.csv --table /path/中科院分区表.csv      # 用机构分区表覆盖成官方真值
   ```

   > ⚠️ **措辞铁律（违反即为编造数据，见 AGENTS.md §五）**：`journal_impact` 是 OpenAlex 的
   > **两年篇均被引**，与 JCR 影响因子算法思路相近但**口径不同、数值不同**；`journal_quartile`
   > 是**本次结果集内部**的四分位，**不是**中科院/JCR 分区。向用户汇报时一律说
   > "期刊影响力（近似）""结果集内四分位"，**绝不能**说成"影响因子 X 分""X 区"。
   > 官方 IF 与中科院分区是授权数据，本套件没有；用户要精确值就请他提供本机构的分区表，
   > 用 `--table` 覆盖（覆盖过的行 `impact_source` 列会标出来源，如实告诉用户哪些是官方值）。
   > 查不到的期刊 `journal_impact` **留空**，不要拿 0 当真值去排序或筛选。
