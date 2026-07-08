---
name: sci-pilot
description: 医学科研全流程总控 / 导航。当用户提出一个完整科研目标（而非单步操作）时先用本技能：如"我要写一篇XX的综述""从头做一个XX课题""写个国自然标书""把我的数据写成论文投稿""继续上次那个课题"。本技能判断意图→确定流水线（调研→选题→标书/论文→检索→分析→作图→查引用→去AI味→排版）→逐步调用对应技能→在 workspace/ 维护项目状态、支持中断续跑。单步且明确的任务（只画一张图、只查一个 DOI、只脱敏一份数据、只出一版 PDF）直接用对应单项技能，不必经本技能。
license: MIT
metadata:
  version: "1.0"
---

# sci-pilot — 医学科研全流程主控

把"一句话的完整目标"变成一条**逐步推进、可中断续跑、产物不互相覆盖**的流水线。本技能不自己做检索/分析/写作，而是**判断意图 → 选流水线 → 按顺序调用各单项技能 → 维护项目状态**。

## 什么时候用本技能，什么时候不用
- **用**：用户给的是一个**完整目标**（写综述/论文/标书、深度研究一个问题、"接着上次那个课题继续"）。
- **不用**：单步且明确的任务——只画一张图（`nature-figure`）、只查一个 DOI（`reference-check`）、只脱敏一份数据（`deidentify`）、只把已有 md 出成 PDF（`render-pdf-doc`）。这些直接用对应单项技能，别绕本技能。

## 一、意图 → 流水线
| 用户意图 | pipeline | 步骤（依次） | 细节 |
|---|---|---|---|
| 写文献综述 | `review` | search-lit/literature-review → reference-check → humanize-academic(可选) → render-pdf-doc | [references/pipeline-review.md](references/pipeline-review.md) |
| 写基金标书 | `grant` | research-scan → topic-selection → grant-proposal → peer-review(自查) → render-pdf-doc | [references/pipeline-grant.md](references/pipeline-grant.md) |
| 写原创研究论文 | `paper` | deidentify(如含患者数据) → clinical-stats + data-analysis → nature-figure → write-paper → reference-check → humanize-academic → peer-review(自查) → render-docx | [references/pipeline-paper.md](references/pipeline-paper.md) |
| 深度研究一个问题 | `research` | deep-research → render-pdf-doc | [references/pipeline-research.md](references/pipeline-research.md) |

拿不准归哪条时，问用户一句"你的目标更接近：综述 / 原创论文 / 标书 / 查透一个问题？"。

## 二、工作区与状态（这是主控的核心）
每个课题一个 `workspace/<课题slug>/`，用 `manifest.json` 记录目标、流水线、每步状态与 `next`。**技能间只传文件路径、不传大块内容**（43 篇证据表不塞进上下文）。完整约定见 [references/workspace-protocol.md](references/workspace-protocol.md)。

用脚本管理状态（纯 stdlib，Windows/Linux 通用）：
```bash
PY=.venv/Scripts/python.exe   # Linux/mac: .venv/bin/python
WS=.opencode/skills/sci-pilot/scripts/workspace.py
# 开工：建工作区 + 骨架 manifest（日期由你传入，脚本不取系统时间）
$PY $WS init --slug sglt2i-hfpef-review --goal 系统综述 --pipeline review --topic '{"P":"HFpEF","I":"SGLT2i","lang":"zh"}' --date 2026-07-08
# 每步产物应写到哪（把它作为该技能脚本的 --out/--outdir/-o）
$PY $WS path --slug sglt2i-hfpef-review --step search-lit
# 一步做完，更新状态、自动推进 next
$PY $WS set --slug sglt2i-hfpef-review --step search-lit --status done --out search/refs.bib --n 43
# 看进度 / 列出所有课题（"继续上次"就先 list 再 show）
$PY $WS show --slug sglt2i-hfpef-review
$PY $WS list
```
调用每个单项技能时，**把 `path` 给出的工作区路径作为它的产物路径**（各技能脚本都接受 `--out`/`--outdir`/`-o`；纯 prompt 技能则在指令里写明"写到这个路径"）。这样产物落进课题工作区、不再混写仓库根 `outputs/` 互相覆盖。

## 三、交互协议：何时自动往下、何时停下问用户
**必须停下问用户**（不可逆或方向性决策）：
- 主题 / PICO 收敛（开工时一次性问清主题、时间窗、语言、目标篇幅或期刊）
- 目标期刊 / 资助渠道未定
- 选题出多个候选时的拍板
- 标书的真实前期基础、真实数据（**绝不替用户编**）
- **数据含患者信息、是否已脱敏**（未脱敏先走 `deidentify`）
- 大批量全文下载前（量大耗时）
- 终稿定稿 / 对外交付前

**自动往下走**（确定性步骤，只汇报进度不打断）：
- 检索 → 去重 → 建证据表 / 结果表
- 写完综述/论文后自动跑 `reference-check` 查假引用
- 引用核查全绿后自动排版
- 环境缺失自动先跑 `env-setup`
- 某检索源失败按各技能已有的降级路径**自动换道**（如 NCBI 不通 → Europe PMC）

**失败即上浮**：换道也失败，才停下告诉用户"这一步没跑通、原因是 X、可选 A/B"。

每完成一步：`set` 更新 manifest，并**向用户宣告一句进度** + 下一步要做什么，如"已完成第 1/5 步：检索到 43 篇（refs.bib）。下一步自动开始建证据表、写综述。"

## 四、跨框架说明
- 本技能只用 markdown + 目录约定 + 一个 stdlib 脚本，**在 Claude Code / OpenCode / OpenClaw / WorkBuddy 都能用**。
- 运行时**没有子代理**（无法派并发子任务）的框架里，本技能退化为**顺序编排**（一步跑完再跑下一步）——功能不变，只是不并行。判断方法同 `deep-research`：工具列表里没有子代理/任务派发类工具、或拿不准，就串行。

## 约定
- 不自己编造任何内容——所有事实性产物都来自被调用的单项技能。
- 课题 slug 用短横线小写（脚本会自动 slugify）。
- `workspace/` 已在 `.gitignore`（课题数据不入库）。
