# 第三方（vendored）技能来源与许可

本仓库 `作图 / 文献下载 / 期刊排版` 三个方向改用**现成开源技能**（不再自研）。
下列技能是从上游仓库**原样引入**（仅在 SKILL.md 顶部加了一段「本仓库运行环境」说明、并按需精简了超大示例资源/测试夹具），方法论与脚本保持原样。

| 本仓库技能目录 | 上游仓库 | 上游子技能 | 许可 | 引入版本 |
|---|---|---|---|---|
| `nature-figure` | [Yuan1z0825/nature-skills](https://github.com/Yuan1z0825/nature-skills) | `skills/nature-figure` | Apache-2.0 | `8e3960d` (2026-07-06) |
| `search-lit` | [Aperivue/medsci-skills](https://github.com/Aperivue/medsci-skills) | `skills/search-lit` | MIT | `b71f3ba` (2026-07-06) |
| `fulltext-retrieval` | [Aperivue/medsci-skills](https://github.com/Aperivue/medsci-skills) | `skills/fulltext-retrieval` | MIT | `b71f3ba` (2026-07-06) |
| `render-pdf-doc` | [Aperivue/medsci-skills](https://github.com/Aperivue/medsci-skills) | `skills/render-pdf-doc` | MIT | `b71f3ba` (2026-07-06) |

## 我们做的改动（须按许可声明）
1. 每个技能的 `SKILL.md` **顶部新增一段引用块**：说明本仓库的 Python 解释器（项目根 `.venv`（Windows `.venv/Scripts/python.exe` / Linux `.venv/bin/python`））、脚本目录 `skills/<name>/`、产出目录 `outputs/`。技能正文其余部分未改。
2. `nature-figure`：删除了 `assets/`（约 30MB 的示例图库 chart-atlas/figures4papers/gallery），仅保留 `SKILL.md / manifest.yaml / static / references / scripts / evals`。因此 `references/demos.md` 里指向 figures4papers 的示例图链接会失效——对无界面文本 Agent 无影响。
3. `search-lit` / `fulltext-retrieval`：删除了 `*_challenge/` 与 `tests/` 测试夹具，保留 SKILL.md 与运行脚本。

## 借鉴（非 vendored，仅参考方法/结构，未原样引入代码）
- 自研技能 `grant-proposal` 的**经费预算**部分，参考了 [leonchaox/qinyan-academic-skills](https://github.com/leonchaox/qinyan-academic-skills) 的 `research-grants`（`assets/budget_justification_template.md`，MIT）的预算科目与 justification 组织方式。我们按本仓库风格重写为精简中文，未拷贝其模板原文。

## 许可证全文
- Apache-2.0（nature-skills）：见 https://github.com/Yuan1z0825/nature-skills/blob/main/LICENSE
- MIT（medsci-skills，© 2026 Aperivue）：见 https://github.com/Aperivue/medsci-skills/blob/main/LICENSE

保留上游版权与许可声明；本目录即为按 Apache-2.0 §4 要求对改动的说明。

## 依赖（这些技能真正需要的、已并入一键脚本）
- `nature-figure`：matplotlib / seaborn（Python 后端，已装）。R 后端为可选，未装。OpenRouter 图像路线需自备 key，默认不用。
- `fulltext-retrieval`：`pymupdf` + `pymupdf4llm`（PDF→Markdown）；核心走 OA API（Unpaywall/PMC/OpenAlex/Crossref）。
- `search-lit`：PubMed E-utilities / Semantic Scholar（走 `requests`）。
- `render-pdf-doc`：**pandoc + xelatex**（一键脚本用 winget(Windows)/apt(Linux) 装）。

## 已知环境注意（实测）
- **render-pdf-doc 中文排版（已改）**：脚本现在检测到汉字会**自动切换 `ctexart` 文档类**（宋体正文/黑体标题/避头尾），拉丁正文默认 Times New Roman（覆盖 `≈≤≥±βμ` 等科学符号，Latin Modern 会静默丢字）——**中文稿件无需再手动传 `--cjk-font`**。仅需覆盖时才用 `--font`/`--cjk-font` 或 frontmatter。检测依赖真正可执行的 Python：Windows 上裸 `python3`/`python` 常是不可执行的 Store 存根，脚本已自动回退到项目 `.venv`（也可用 `RENDER_PY` 环境变量指定）。MiKTeX **首次**渲染会自动联网补装宏包（ctex/xeCJK/bigintcalc 等），需先 `miktex packages update` 一次。
- **search-lit 依赖 NCBI**：PubMed 走 `eutils.ncbi.nlm.nih.gov`。实测本机（中国大陆网络）curl 与 Python requests 都 SSL 握手失败——NCBI 常被阻断。**服务器在境外或配代理才稳**；国内环境改用 `fulltext-retrieval` / `reference-check`（走 Europe PMC ebi.ac.uk / Crossref，实测国内可达）。
- **fulltext-retrieval 邮箱**：`--email` 必须真实邮箱，Unpaywall 拒 `example.com`（HTTP 422）。
