# scientific-agent (opencode-agent branch)

自托管科研 Agent 后端验证分支。基于 **OpenCode**（`opencode serve`）+ **DeepSeek**（OpenAI 格式），
复用本目录 `backend/.venv` 里的科学计算环境（pandas/numpy/scipy/matplotlib/scikit-learn 等）作为“技能”。

- Agent 技能：`.opencode/skills/`（本地，调用 `backend/.venv` 的 Python）与 `deploy/skills/`（服务器/容器，用 `python3`）
- 启动后端：`opencode serve --port 4098`
- 前端：见 `web/`（流式对话 + 文件上传/下载）
- 上传目录 `uploads/`，产出目录 `outputs/`

## 科研医学技能套件（20 个技能）

覆盖「从调研到投稿、再到评审与打假」的完整链路。与独立仓库 [imwei25/sci-skill](https://github.com/imwei25/sci-skill) 同源（该仓库为跨电脑分发版），本目录为双镜像版（`.opencode/skills` 本地 + `deploy/skills` 服务器）。

| 方向 | 技能 | 说明 |
|---|---|---|
| 环境自举 | `env-setup` | 查 Python→建项目根 `.venv`→装依赖+pandoc；换机器/框架先跑它 |
| 调研 | `research-scan` | 领域现状/趋势/空白 → 调研简报 |
| 选题 | `topic-selection` | 找空白、提假设、多棱镜打分（可选对抗式研究） |
| 研究设计 | `novelty-check` | 新颖性裁定（真新/增量/已回答）+ 预注册锁（anti-HARKing） |
| 写标书 | `grant-proposal` | 国自然 / NIH 结构 + 经费预算 + 时效合规，起草与润色 |
| 叙述性综述 | `literature-review` | 多路检索建证据表 → 有引用的叙述性综述 |
| 系统综述/Meta | `systematic-review` | PROSPERO 预注册 → 双人筛选+κ → RoB → GRADE → PRISMA 计数 |
| 文献检索 | `search-lit` ᵛ | PubMed/Semantic Scholar，API 核实，出 BibTeX |
| 文献下载 | `fulltext-retrieval` ᵛ | 按 DOI 从 OA 源(Unpaywall/PMC/OpenAlex)下全文 PDF |
| 深度研究 | `deep-research` | 多源检索 + 交叉核实 + 带引用报告 |
| 数据分析 | `data-analysis` | pandas/scipy/statsmodels 统计与建模（含检验选择护栏） |
| 临床统计 | `clinical-stats` | 基线特征表 Table 1 + 样本量/把握度计算 |
| 数据脱敏 | `deidentify` | 患者可识别信息去标识化（CSV/病历文本） |
| 作图 | `nature-figure` ᵛ | Nature 级图工作流，matplotlib/seaborn，SVG/PDF/TIFF |
| 写论文 | `write-paper` | IMRaD 全流程，把真实数据/结果写成原创研究论文 |
| 去 AI 味 | `humanize-academic` | 去机器腔（中英双语清单）、保术语与引用 + 不变量校验 |
| 期刊排版(PDF) | `render-pdf-doc` ᵛ | Markdown→出版级 PDF（pandoc+xelatex，含 CJK） |
| 期刊排版(Word) | `render-docx` | Markdown→投稿版 `.docx`（多数医学期刊要 Word） |
| 论文/标书评审 | `peer-review` | 逐节剖析 + 报告规范(CONSORT/PRISMA) + 审稿意见 |
| 文献真实性核查 | `reference-check` | 对 Crossref/PubMed 查假引用（不存在/张冠李戴/虚构）|

> ᵛ = 直接引入的现成开源技能（vendored），来源与许可见 [THIRD_PARTY_SKILLS.md](THIRD_PARTY_SKILLS.md)；其余为按本仓库约定适配自研。

> **全流程编排**：无独立"总控"技能。顶层常驻指令 [`AGENTS.md`](AGENTS.md) 就是主控——判意图 → 选流水线（review / systematic / grant / paper / research）→ 按顺序依次调用上述技能，产物写 `outputs/`。

### 一键安装（Python 统一走**项目根 `.venv`**）

```powershell
# Windows 本地
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```
```bash
# Linux 服务器（非 Docker）
bash scripts/setup.sh        # 之后 source .venv/bin/activate 再起服务
```

脚本会：在项目根建/复用 `.venv` → 装 `scripts/requirements-skills.txt` 全部依赖 → 装 pandoc + xelatex（`render-pdf-doc` 用，Windows 走 winget / Linux 走 apt）→ 逐包冒烟测试 →
运行 `scripts/validate_skills.py` 校验所有 SKILL.md（无 BOM、frontmatter 合法、两套镜像一致）→ 把顶层主控 `AGENTS.md` 镜像成**项目根** `CLAUDE.md`（受管块，供 Claude Code 读；OpenCode 直接读 `AGENTS.md`）。
Docker 部署走 `deploy/requirements.txt` + `deploy/Dockerfile`（已含全部 pip 包与 pandoc/texlive/CJK 字体）。

> **换机器 / 换智能体框架（OpenCode·OpenClaw·WorkBuddy…）时**：技能不写死任何机器路径——解释器统一指向**项目根 `.venv`**（Windows `.venv\Scripts\python.exe`，Linux/mac `.venv/bin/python`）。把 `skills/` 拷到目标框架的技能根、让 agent 先跑 `env-setup` 技能（或 `scripts/setup.*`）建好 `.venv` 即可，无需改任何 SKILL.md。
>
> **顶层主控（AGENTS.md）跨框架**：路由铁律放**项目根**，OpenCode 直接读 `AGENTS.md`（Docker 里由 Dockerfile `COPY deploy/AGENTS.md /app/AGENTS.md`）；Claude Code 读项目根 `CLAUDE.md`——安装脚本用 `scripts/install_router.py` 把 `AGENTS.md` 镜像过去（**受管块、幂等、保留你原有 CLAUDE.md 内容**）。**故意只落项目根、不写全局 `~/.claude/CLAUDE.md`**，免得在无关项目也触发科研路由。

> **实测注意（详见 [THIRD_PARTY_SKILLS.md](THIRD_PARTY_SKILLS.md)）**：
> - `render-pdf-doc` 排**中文**稿件要传 `--cjk-font "Microsoft YaHei"`（服务器 `Noto Sans CJK SC`），否则汉字漏字；MiKTeX 首次渲染需先 `miktex packages update`。
> - `search-lit` 依赖 NCBI PubMed，**中国大陆网络常被墙**（curl/requests 均 SSL 失败）；国内改用 `fulltext-retrieval`/`reference-check`（走 Europe PMC/Crossref，可达）。
> - `fulltext-retrieval --email` 必须填**真实邮箱**（Unpaywall 拒 example.com）。

## 技能来源与致谢

> **说明**：分两类。**① 直接引入的现成技能（vendored）**：`nature-figure`、`search-lit`、`fulltext-retrieval`、`render-pdf-doc`——原样引入上游仓库，仅在 SKILL.md 顶部加「本仓库运行环境」说明并精简超大示例资源，来源/许可/改动见 [THIRD_PARTY_SKILLS.md](THIRD_PARTY_SKILLS.md)。**② 适配自研**（下表）：参考社区 skill 的结构与思路，按本仓库约定重写。真正 `pip` 下载的包见 B 节。

### A. 参考的社区 Skill 仓库（GitHub）

| 技能 | 参考来源 |
|---|---|
| `research-scan` / `topic-selection` | [K-Dense-AI/claude-scientific-skills](https://github.com/K-Dense-AI/claude-scientific-skills)、[K-Dense-AI/claude-scientific-writer](https://github.com/K-Dense-AI/claude-scientific-writer) |
| `grant-proposal` | [franklee16/academic-research-skills](https://github.com/franklee16/academic-research-skills)、[wanshuiyin/Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) |
| `literature-review` | [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates)（scientific/literature-review）、[borghei/Claude-Skills](https://github.com/borghei/Claude-Skills) |
| `peer-review` | [K-Dense-AI/claude-scientific-skills](https://github.com/K-Dense-AI/claude-scientific-skills)（peer-review）、[davila7/claude-code-templates](https://github.com/davila7/claude-code-templates)（peer-review） |
| `humanize-academic` | [blader/humanizer](https://github.com/blader/humanizer)、[matsuikentaro1/humanizer_academic](https://github.com/matsuikentaro1/humanizer_academic) |
| `deep-research` | Anthropic 内置 deep-research skill（改写为无子代理顺序版） |
| `reference-check` | 方法参考 [CiteMe](https://citeme.app)、[Scholar Sidekick](https://scholar-sidekick.com/tools/citation-verifier)、[Citely](https://citely.ai/online-citation-checker)；学术依据 [arXiv:2602.15871 CheckIfExist](https://arxiv.org/html/2602.15871v1) |
| `data-analysis` | 本仓库原有（非外部） |

> 作图 / 文献下载 / 期刊排版 三个方向**不在此列**——它们用的是直接引入的现成技能（见上方 ① 与 [THIRD_PARTY_SKILLS.md](THIRD_PARTY_SKILLS.md)）。

其它可参考的科研 skill 合集：[imbad0202/academic-research-skills](https://github.com/imbad0202/academic-research-skills)、[scandnavik/claude-scientific-skills](https://github.com/scandnavik/claude-scientific-skills)、[DenDen047/claude-scientific-skills](https://github.com/DenDen047/claude-scientific-skills)、[Microck/ordinary-claude-skills](https://github.com/Microck/ordinary-claude-skills)。

### B. 实际下载/依赖的工具（pip，来自 PyPI）

| 包 | 用途 | 源码/主页 |
|---|---|---|
| [metapub](https://github.com/metapub/metapub) | PubMed 元数据 + 找 PDF | github.com/metapub/metapub |
| [pymed](https://github.com/gijswobben/pymed) | PubMed 检索封装 | github.com/gijswobben/pymed |
| [biopython](https://biopython.org/) | NCBI E-utilities（`Bio`） | biopython.org |
| [habanero](https://github.com/sckott/habanero) | Crossref REST 客户端 | github.com/sckott/habanero |
| [pyalex](https://pypi.org/project/pyalex/) | OpenAlex 客户端 | pypi.org/project/pyalex |
| [bibtexparser](https://github.com/sciunto-org/python-bibtexparser) | 读写 `.bib` | github.com/sciunto-org/python-bibtexparser |
| [rispy](https://github.com/MrTango/rispy) | 读写 RIS | github.com/MrTango/rispy |
| [pymupdf](https://github.com/pymupdf/PyMuPDF) | 读/校验 PDF（`fulltext-retrieval`） | github.com/pymupdf/PyMuPDF |
| [pymupdf4llm](https://pypi.org/project/pymupdf4llm/) | PDF → Markdown（喂 LLM） | pypi.org/project/pymupdf4llm |
| [lifelines](https://github.com/CamDavidsonPilon/lifelines) | 生存分析（KM/Cox，`data-analysis`） | github.com/CamDavidsonPilon/lifelines |
| [adjustText](https://github.com/Phlya/adjustText) | 标签避让 | github.com/Phlya/adjustText |
| python-docx / reportlab | 通用文档处理（备用） | PyPI |

另用 `requests` / `httpx` / `beautifulsoup4` / `lxml` / `tqdm`（均来自 PyPI）。

**系统依赖（非 pip，供 `render-pdf-doc`）**：pandoc + xelatex（Windows: MiKTeX；Linux/Docker: `texlive-xetex`）+ CJK 字体（Windows 自带 Microsoft YaHei；Linux 装 `fonts-noto-cjk`）。一键脚本与 Dockerfile 已包含。

**免费 API / 数据源（无需 key）**：
- [Europe PMC REST](https://europepmc.org/RestfulWebService) — 文献检索 / 下载 / 核查（覆盖 PubMed + 预印本 + 全文，国内可达）
- [Crossref REST API](https://api.crossref.org) — DOI 元数据核查
- [Unpaywall](https://unpaywall.org/products/api) / [OpenAlex](https://docs.openalex.org/) — `fulltext-retrieval` 下 OA 全文
- NCBI E-utilities / PubMed — 由 metapub、biopython、`search-lit` 调用（**注意：中国大陆网络常被阻断，国内优先用 Europe PMC/Crossref**）

> 旧的 scientific-discover 产品代码保留在 `main` 分支（提交 cc5fc33）。
