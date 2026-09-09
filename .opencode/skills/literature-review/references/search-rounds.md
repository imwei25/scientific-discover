# search.py 用法与回合制检索细则（阶段 2）

> 本文件从 SKILL.md「阶段 2 — 缺口驱动的迭代检索」搬出，由 SKILL.md 在开跑每一回合 `search.py` 检索、以及各回合跑完合并证据表时引用。循环本身的通用规矩（编排、停止判据、覆盖批判）在 [iterative-retrieval.md](iterative-retrieval.md)。完整参数以 `python search.py --help` 为准。

## 基本调用与各参数的落法
```
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/literature-review/search.py" "概念1" "概念2" --since 2018 --design rct,cohort --landmark "IMbrave150,HIMALAYA" --tag r1
```
> ⚠️ **每一回合都必须带 `--tag`（`r1` / `r2` / `机制` / `诊断` …）**。产物默认是**固定名**
> `evidence_table.csv` / `evidence.md`，脚本**不会追加合并**——回合制检索不带 tag，后一轮就把
> 前一轮挤走：旧表会被改名成 `evidence_table.csv.bak` / `.bak2` / `.bak3`… 保命（数据不会真丢），
> 但你手上那张固定名的表只剩最后一轮。带 tag 后写成 `evidence_table__r1.csv` /
> `evidence__r1.md`，各轮并存、可直接合表（见下）；不带 tag 而文件已存在时脚本会在 stderr
> 报出把哪些文件改名成了什么。
>
> **多个概念默认 AND 合成一条聚焦检索（取交集）**——脚本会打印实际合成的检索式。这样聚焦主题、
> 不掺入只命中单个概念的离题文献。要各自独立检索再并集（旧行为，会掺离题）显式加 `--union`。
> 单概念一条式最可控：`"概念1 AND 概念2 AND (同义词1 OR 同义词2)"`。
>
> **条数默认不限**（不传 `--limit`）：命中多少取多少，脚本会打印命中数（PRISMA 要记这个数）。
> **别随手加 `--limit 25`** —— 综述要的是覆盖，而不是"前 25 篇"；收窄范围请收窄检索式或用
> `--since`，别用条数上限。检索式太宽时脚本按 `SCI_SEARCH_MAX`（默认 5000）截断并**打印告警**，
> 看到告警就收窄重跑（或设 `SCI_SEARCH_MAX=0` 取消），并在汇报里如实说明被截断。
>
> ⚠️ 不限条数之后一条检索式可能回几千篇、`evidence.md` 上兆：**不要整份读进上下文**（读了也用不了，
> 摘要会把写作空间挤没）。按 `design`/`year`/`cites` 在 `evidence_table.csv` 里先筛出这一轮真正要
> 用的那部分（如只看 meta-analysis + RCT、或近 5 年被引前 100）再细读；全量表照旧留在产物里备查。

> **首屏表单勾了「纳入的研究设计」→ 必须把它传给 `--design`**（`rct,cohort,casecontrol,crosssection,review,meta,basic`，
> 逗号分隔，与表单选项同名）。脚本会给每一类各跑一趟**按被引降序**的定向检索并入结果
> （主检索照旧宽召回，不做过滤），跑完打印「勾选的研究设计在表里占百分之几」。
> **不传等于那个勾选框没起作用**——实测一次勾了「RCT+队列」的检索回来 106 篇里 RCT 只有 8 篇，
> 用户会认为这个表单是摆设。定向趟按被引降序取，顺带把**领域里程碑试验**捞回来
> （普通主题检索按相关度排序，排在前面的多是评论与真实世界研究，Ⅲ期原始论文常常一篇都排不上来）。
>
> **首屏的「参考文献时间范围」→ 必须传 `--since`**，否则那个选项同样等于没填（脚本会就此告警）。
>
> **奠基文献补捞（`--landmark`，默认就开，别关）**：里程碑试验有两种漏法，脚本各堵一条 ——
> ① **被年限卡掉**（「近 5 年」会把 2020 年的 IMbrave150 排除）；
> ② **被 AND 掉**（主检索 `HCC AND (PD-1 OR PD-L1) AND first-line` 三概念取交集，
> 而 IMbrave150 那篇 NEJM 的题录里既没有 "PD-L1" 也没有 "first-line"，一 AND 就没它了）。
> 所以奠基趟**只用第一个概念**（病种/领域）+ 试验/指南限定 + 被引降序、**不套 `--since`**。
> 实测这一趟的前几名就是 SHARP(10144 引)、IMbrave150 NEJM(5854)、REFLECT(4299)——
> 任何一篇该方向综述都要引的那几篇。
> **你已经知道试验叫什么名字时，把名字列上**：`--landmark "IMbrave150,CheckMate 9DW,HIMALAYA"`，
> 每个名字另跑一趟精确补捞（检索式里出现过的试验名会自动认，但你脑子里的那些得你自己给）。
> 这一步就是为了**替掉"凭记忆写 DOI"**——两轮实测里模型都干过这件事，其中一次自述"我编造了 DOI"。
> 补回来的奠基文献**豁免时间范围过滤**；汇报时说明"这几篇超出你选的年限，因为它们是本方向的
> 原始Ⅲ期试验/领域基石"，不必请示。
> 只有"确实只要某个时间窗内的新文"（如"近一年有什么新进展"）才加 `--no-landmark`。
>
> **看到「‼ 奠基文献补捞没跑成」就先把那一趟重跑，跑通了再往下写。** 这一趟整趟失败时，
> 证据表**表面上完全正常**（条数照样几百条），只是前排被高被引泛综述占满、地基文献一篇不在
> —— 实测一次 SSL 握手失败就造成 225 条里零篇 NEJM。**别把这种表当成"这个方向就这些文献"**，
> 更不要凭记忆把缺掉的原始试验补写进参考文献（那是假引用最高发的场景，引用核查会当场打回）。
>
> **`--budget-sec`（默认 90 秒）是墙钟护栏**：到点就停止翻页、把已取回的写出来并**响亮报告截断**。
> 宁可少而有产物，也不要超时零产物（实测一次宽检索式把调用超时耗光、两轮检索什么都没写下来）。
> 看到"因时间预算被截断"就收窄检索式或加大预算重跑，**别把那份结果当成"这个方向就这么多文献"**。
>
> ⚠️ **语种：这套检索源（Europe PMC / PubMed / Crossref）不收录 CNKI / 万方 / 维普，检索不到中文期刊文献。**
> 目标刊是**中文核心**时（用户说"投中华系/国内核心"，或首屏语言选了中文），**开工时就当面告诉用户**：
> 中文参考文献要他自己补，或用 `zotero-library` 从他本机文献库取。中文核心综述普遍要求引一定比例国内研究，
> 到送审才被编辑指出"参考文献全是外文"，返工的是整份稿子。脚本在 0 篇中文命中时也会打印同款提醒。

## 合并各轮证据表（所有回合跑完、进阶段 3 之前）
每回合产出 `evidence_table__<tag>.csv` / `evidence__<tag>.md`，脚本不会自动追加合并，用下面的脚本合成一张总表：

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" - <<'EOF'
import csv, glob, pathlib
rows, seen = [], set()
for p in sorted(glob.glob("evidence_table__*.csv")):
    for r in csv.DictReader(open(p, encoding="utf-8-sig")):
        k = (r.get("doi") or "").lower() or (r.get("title") or "").lower().strip(" .")
        if k and k in seen:
            continue
        seen.add(k); r["source_round"] = pathlib.Path(p).stem.split("__", 1)[1]; rows.append(r)
cols = list(rows[0].keys())
with open("evidence_table.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(rows)
with open("evidence.md", "w", encoding="utf-8") as f:
    f.write(f"# 证据清单（{len(rows)} 篇，各轮合并去重）\n\n")
    for i, r in enumerate(rows, 1):
        f.write(f"{i}. **{r['title']}** ({r['year']}, {r['journal']}) — *{r['design']}*, "
                f"cited {r['cites']}x, round={r['source_round']}. DOI:{r['doi'] or 'NA'}\n")
        if r.get("abstract"):
            f.write(f"   > {r['abstract'][:400]}\n")
        f.write("\n")
print(f"合并 {len(seen)} 篇 → evidence_table.csv / evidence.md")
EOF
```
