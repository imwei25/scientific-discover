---
name: zotero-library
description: 读取用户本机 Zotero 文献库并对其中 PDF 做全文证据检索（PaperQA2-lite，带页码引用），供撰写带引用回答。当用户说“用我的 Zotero”“我本地的文献库”“就基于我导入的文献回答”时使用。默认只读；唯一写操作是 push 子命令（把题录写入 Zotero 当前选中分类）。仅 opencode 与 Zotero 同机时可用，探测失败优雅回退 search-lit / fulltext-retrieval。
triggers: Zotero, 我的文献库, 本地文献库, 我收藏的PDF, 我库里的文献, 用我导入的文献, zotero library, my PDFs, ask my papers, local reference library
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用 `.venv/Scripts/python.exe`（Windows）/ `.venv/bin/python`（Linux/macOS）（项目根 `.venv`，随包装好；报错先查路径引号，别重建）。本技能脚本在 `.opencode/skills/zotero-library/references/` 下，运行时用全路径或先 `cd`。产出直接写**当前工作目录**、用裸文件名（网关已把 cwd 指到本会话的产物目录）；别拼 `outputs/` 前缀，也别写仓库根固定名。依赖 `fitz`(pymupdf)/`scikit-learn`，均已装。

> **决策规约（照 AGENTS.md §六）**：任何要用户拍板的抉择——用哪个分类、按哪几篇、要不要补检索等——一律**在正文里列 2–4 个编号候选**（推荐项放第 1 个并写明“推荐 X，因为……”），让用户**回一个数字即推进**；别用开放式提问，也别弹交互选项卡。

# Zotero 本地文献库 —— 读取 + 全文证据检索

让 agent 关联到**用户本机 Zotero** 的题录与 **PDF 全文**，做"基于我自己的文献库回答"的检索增强。补上仓库原有链路（API 现查 → OA 下载）缺的一环：**用用户已收藏、已读的本地文献做证据源**。

## ⚠️ 运行位置铁律（务必先判）

本技能访问 `127.0.0.1:23119`（Zotero 7 本地 API）与本机 `storage/` 目录里的 PDF，
所以**只在"opencode/技能与 Zotero 桌面端在同一台机器上"时有效**：

- ✅ **本机运行**（用户在自己电脑上跑本套 + Zotero 常驻）→ 技能直连本机 Zotero，完整可用。
- ❌ **中心服务器多用户**（一台服务器服多人）→ 服务器打 `127.0.0.1` 只到服务器自身，读不到用户电脑的 Zotero。此场景需改走**浏览器侧**发起 Zotero 调用（属 `web/` 前端工程，不在本技能内）；本技能会探测失败并**优雅报告**，不阻塞。

**先跑 `probe`**；`running=false` 就按上面判断并如实告知用户，不要假装读到了。

## 前提（用户侧一次性设置）

1. Zotero 桌面端**正在运行**；
2. Zotero → 设置 → 高级 → 勾选 **"允许本机其它应用与 Zotero 通信"**（Zotero 7 起本地 API 读取默认开启）；
3. 要做全文检索的文献，其 PDF 已存在 Zotero 库里（imported file）。数据目录默认 `~/Zotero`，非默认时用 `--data-dir` 或环境变量 `ZOTERO_DATA_DIR` 指定。

## 脚本与子命令

`references/zotero_read.py`（stdlib，只读）：

```bash
PY=.venv/Scripts/python.exe   # Linux/macOS: .venv/bin/python
SK=.opencode/skills/zotero-library/references

# 1) 探测（务必先跑）
"$PY" "$SK/zotero_read.py" probe
#   → {"running":true/false,"api":..,"connector":..,"data_dir":".."}

# 2) 列分类（拿 collection key）
"$PY" "$SK/zotero_read.py" collections

# 3) 导入题录 → 统一 Reference（写 evidence 表）
#    某分类：
"$PY" "$SK/zotero_read.py" items <COLLECTION_KEY> --cap 200 \
    --out zotero_refs.json --csv zotero_refs.csv
#    整库顶层 My Library（用户没建分类文件夹、文献堆在根层时）：
"$PY" "$SK/zotero_read.py" items --top --cap 200 --csv zotero_refs.csv

# 4) 看某条目的 PDF 附件与磁盘路径
"$PY" "$SK/zotero_read.py" attachments <ITEM_KEY>

# 5) 取某条目 PDF 全文（Zotero 预索引优先，回退 pymupdf 解析）
"$PY" "$SK/zotero_read.py" fulltext <ITEM_KEY> --out ft.txt

# 6) 会话小库落地：把选中文献的 PDF 复制进一个目录（供 --pdf-dir 检索）
"$PY" "$SK/zotero_read.py" materialize --top --to zotero_lib
"$PY" "$SK/zotero_read.py" materialize <COLLECTION_KEY> --to zotero_lib
"$PY" "$SK/zotero_read.py" materialize --items K1,K2 --to zotero_lib

# 7) 导出回写：存回运行中的 Zotero（**写操作**，存当前选中分类）；输入三选一
"$PY" "$SK/zotero_read.py" push --refs zotero_lib/zotero_refs.json
"$PY" "$SK/zotero_read.py" push --csv  evidence_table.csv   # 综述检索结果
"$PY" "$SK/zotero_read.py" push --bib  refs.bib
```

### 把综述检索到的文献导入 Zotero / 会话小库

`search-lit` / `literature-review` 产出 `evidence_table.csv`（含 DOI；多轮检索时是 `evidence_table__<标签>.csv`，先确认要推的是哪一份/合并表）。基于它：

- **→ Zotero**：`push --csv evidence_table.csv`（或 `--bib refs.bib`）把**题录**写进 Zotero 当前选中分类。**只有题录、无 PDF 附件**（检索阶段本就没下全文）。
- **→ 会话小库做 RAG**：小库是 PDF 目录，而检索结果**多数无全文**，所以：
  1. **先用 `fulltext-retrieval` 按 DOI 试下 OA 全文**到 `zotero_lib/`（它的 `retrieval_report.json` / `manual_needed.txt` 会逐条记成功/失败）；
  2. **只把真正下到 PDF 的算入小库**，对该目录 `zotero_rag.py --pdf-dir`；
  3. **诚实汇报**：哪些下到了全文（已入小库）、哪些没下到（**因此没导入小库**，给原因：非 OA / 无 DOI / OA 源缺失），**绝不假装全部导入**。没全文的仍可 `push` 进 Zotero（只题录）。

### 会话小库 vs 整库（双 scope）+ Web 面板

- **会话小库**：`materialize` 把一批 Zotero 文献的 PDF 复制进 `zotero_lib/`，之后对它做 RAG：`zotero_rag.py --pdf-dir zotero_lib`。适合"只针对我这次带进来的这几篇"。
- **整库**：`zotero_rag.py --library` / `--collection <key>` 直接对本机 Zotero。
- **Web 网关面板**（单机部署）：`web/server.mjs` 暴露 `/api/zotero/status|collections|import|lib|push`，前端"Zotero 文献库"面板可探测/选分类/导入到会话小库/选检索范围/导出回写；chat preamble 会告诉 agent 用哪个 scope。

`references/zotero_rag.py`（全文证据检索，PaperQA2-lite）：

```bash
# 对某分类的全部文献，按问题排出带页码引用的证据段
"$PY" "$SK/zotero_rag.py" --question "阿司匹林是否增加消化道出血风险？" \
    --collection <COLLECTION_KEY> --top-k 12 \
    --out-md zotero_evidence.md --out-csv zotero_evidence.csv

# 整库顶层（没建分类时）
"$PY" "$SK/zotero_rag.py" --question "..." --library --top-k 12 ...

# 或只针对指定几篇
"$PY" "$SK/zotero_rag.py" --question "..." --items KEY1,KEY2,KEY3 ...

# 离线：直接对一批本地 PDF（不经 Zotero，便于测试/无库场景）
"$PY" "$SK/zotero_rag.py" --question "..." --pdf-dir path/to/pdfs ...
```

### 检索后端（`--backend`）

- `--backend tfidf`（默认）：词级 TF-IDF + 余弦。**零额外依赖、离线**；对英文有效，**中文问题对英文全文命中弱**（无共享词→近乎全 0）。
- `--backend embed`（推荐，跨语言）：**本地稠密嵌入**，用 ModelScope 上的 **BCE 双语模型** `maidalun/bce-embedding-base_v1`（中英跨语义），全程**不触任何远程大模型端点**。中文问题问英文全文可正确命中（实测：中文"二甲双胍禁忌"→英文 metformin 全文 top-1）。

```bash
# 一次性装依赖 + 下模型（ModelScope 国内快；模型缓存到 ~/.cache/modelscope）
"$PY" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple modelscope sentence-transformers
"$PY" -c "from modelscope import snapshot_download; snapshot_download('maidalun/bce-embedding-base_v1')"

# 之后用 embed 后端（模型自动走缓存；也可 --model-dir 指定本地目录、--model-id 换模型）
"$PY" "$SK/zotero_rag.py" --backend embed --question "二甲双胍什么情况下禁用？" --library --top-k 12 ...
```

依赖缺失（未装 sentence-transformers/未下模型）时 `--backend embed` 会报错——**回退用 `--backend tfidf`**，别硬跑。

### 精排（`--rerank`，两段式）

召回之后再加一段 **cross-encoder 精排**（本地 **BCE reranker** `maidalun/bce-reranker-base_v1`，对每个 (问题, 段落) 打校准相关性分），准度优于纯余弦。这是"精排"的**标准做法**，**不是生成式 LLM**（不下本地大模型、不走任何远程端点）。

```bash
# 一次性下 reranker 模型
"$PY" -c "from modelscope import snapshot_download; snapshot_download('maidalun/bce-reranker-base_v1')"

# 两段式：嵌入召回 rerank-topn 个 → cross-encoder 精排到 top-k
"$PY" "$SK/zotero_rag.py" --backend embed --rerank --rerank-topn 30 \
    --question "二甲双胍什么情况下禁用？" --library --top-k 12 ...
```

- 流程：`embed/tfidf 召回 top-N(默认30)` → `BCE cross-encoder 精排` → 输出 top-k；证据表 `检索方式` 行会写明用了哪种。
- **仍非 PaperQA2 的 RCS**（RCS 用生成模型逐段摘要+打分）；cross-encoder 精排是判别式打分，本地、快、零 token 成本——刻意不引入生成模型。

## 标准流程

1. **`probe`** → 若 `running=false`：按"运行位置铁律"如实告知，引导用户开 Zotero / 勾设置，或改用 `search-lit`/`fulltext-retrieval` 从公开库检索。**不要**编造读到的内容。
2. **`collections`** → 展示分类，让用户用**编号候选**选一个（或让其给 item key）。**若返回空**（用户没建分类文件夹）→ 改用 `items --top` / `zotero_rag --library` 读整库顶层，别卡在"没有分类"。
3. **`zotero_rag.py`** 生成 `zotero_evidence.md`（按相关性排序、每段带 `作者 年 p.页 — 标题 + itemKey`）。
4. **撰写带引用回答**：Read `zotero_evidence.md`，**逐条主张落到具体证据段**，行文引用标注 `(作者 年)`；**不得脱离证据表编造**。缺证据的点标"库中未见，待补充"。
5. 需要把这些文献接入综述/论文时，把 `zotero_refs.csv` / `zotero_evidence.md` 交给 `literature-review` 或 `write-paper` 作为**本地证据源**；投稿前照常跑 `reference-check`。

## 与其它技能的关系

- **补位**：`search-lit`/`literature-review` 从公开 API **现查**；本技能用**用户本地已有**文献。三者可并用（本地库打底 + 公开库补检）。
- **复用**：全文解析与 `fulltext-retrieval` 的 pdf→文本同源（pymupdf）；本技能多了"按问题排证据段"。
- **下游**：证据表可喂 `literature-review`/`write-paper`；引用真实性仍由 `reference-check` 兜底。

## 边界与限制

- **两种条目形态都支持**：既支持"文献条目 + PDF 子附件"，也支持用户**直接拖 PDF 进 Zotero 形成的顶层独立附件**（题名取文件名、无书目元数据，故引用里作者/年可能是 `?`）。
- **页码锚点**：走 Zotero **预索引全文**时无分页信息（引用页码显示 `?`）；需要精确页码时该段回退 pymupdf 逐页解析才有。
- **默认只读，回写需显式**：检索/导入全程只读；**唯一的写操作是 `push`（导出回写）**，且只在用户明确要"导出到 Zotero"时才跑，绝不自动回写。push 存进用户当前在 Zotero 里选中的分类。
- **检索：两段可选**。召回后端 `tfidf`（默认、零依赖、离线、跨语言弱）/ `embed`（本地 BCE 双语嵌入、跨中英、不触端点）；可选 `--rerank` 加一段本地 **BCE cross-encoder 精排**。全部本地、无远程端点、无生成模型。**精排是判别式 cross-encoder，不是 PaperQA2 的生成式 RCS**——别把它说成 LLM 逐段摘要精排。
- **导入上限**默认 200 篇/分类，超出截断并提示。
- **扫描版 PDF**（纯图片、无文本层）取不到全文；Zotero 若已 OCR 索引则可用其预索引文本。
- **不触网**：所有请求走 `127.0.0.1:23119`，不外发用户文献数据。

## 反幻觉

- `probe` 失败就说读不到，**绝不**凭模型记忆编造"你库里的文献"。
- 回答只用 `zotero_evidence.md` 里真实存在的片段；每条主张可回指到某段。
- 不虚构 itemKey、页码、DOI；缺就标"待补充"。
