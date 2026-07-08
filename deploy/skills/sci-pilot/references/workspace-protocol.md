# 工作区 / manifest 协议

每个课题一个 `workspace/<slug>/`，一份 `manifest.json` 当唯一状态真源。目的：产物不互相覆盖、支持"继续上次的项目"、技能间只传路径不传大块内容。

## 目录结构
```
workspace/<slug>/
├── manifest.json     # 状态真源（workspace.py 读写）
├── search/           # search-lit(refs.bib) / literature-review(evidence_table.csv) / research-scan
├── fulltext/         # fulltext-retrieval 下的 PDF/MD
├── analysis/         # deidentify / clinical-stats / data-analysis 的数据与结果
├── figures/          # nature-figure 出的 SVG/PDF/TIFF
├── drafts/           # write-paper / literature-review / grant-proposal / deep-research 的 md 稿
├── checks/           # reference-check / peer-review 报告
└── final/            # render-docx / render-pdf-doc 的交付件
```

## manifest.json 字段
```json
{
  "project": "sglt2i-hfpef-review",   // slug
  "goal": "系统综述",                  // 人读目标
  "pipeline": "review",               // review|grant|paper|research
  "created": "2026-07-08",            // 主控传入的日期（脚本不取系统时间，保证可复现）
  "topic": {"P":"HFpEF","I":"SGLT2i","O":"心衰住院","lang":"zh","target":"中文综述4000字"},
  "steps": [
    {"skill":"search-lit","status":"done","out":"search/refs.bib","n":43},
    {"skill":"literature-review","status":"running","out":"drafts/review.md","n":null},
    ...
  ],
  "next": "literature-review"          // 由 workspace.py 自动算：第一个 pending/running 步
}
```
- `status` ∈ `pending | running | done | skipped`。
- `next` 不手改——`set` 更新某步后脚本自动重算（指向第一个未完成步；全 done 则为 null）。

## 状态机（workspace.py 子命令）
| 命令 | 作用 |
|---|---|
| `init --slug --goal --pipeline [--topic JSON] [--date]` | 建工作区 + 子目录 + 骨架 manifest（按流水线预置步骤与默认产物路径）。**课题已存在时会拒绝、防止清空已有进度**——续跑请直接 show/set；确要清空重来才加 `--force` |
| `path --slug --step` | 打印某步产物应写到的相对路径（`workspace/<slug>/...`），作为该技能 `--out` |
| `set --slug --step --status [--out] [--n]` | 更新某步状态并自动推进 `next` |
| `show --slug [--json]` | 打印进度（可选原始 JSON） |
| `list` | 列出所有课题及 `[done/total]` 进度与 `next` |

## 主控怎么用它
1. 开工：`init` 建骨架。
2. 循环：读 `next` → 对该步调用对应单项技能，产物写到 `path` 给的位置 → 跑完 `set --status done` → 宣告进度。
3. 遇到"交互协议"里该停的点就停下问用户；确定性步骤自动往下。
4. "继续上次"：`list` 找到课题 → `show` 看 `next` → 从 `next` 续跑。

## 传递规则
- **大产物只传路径不传内容**：脚本类产物（43 篇证据表 CSV、下好的 PDF、图片）以文件路径交给下一步，不把整表/整库读进上下文。纯 prompt 技能（如 write-paper 读综述稿再改）仍需读入文本内容——"只传路径"主要针对大数据文件与脚本产物，不是说任何东西都不读。
- **slug 一致性**：所有命令内部统一 slugify（中文/空格→连字符），所以 `init` 和后续 `show/set/path` 传同一个原始 `--slug` 都能对上；`../` 之类穿越尝试会被 slugify 消解在 `workspace/` 内。
- 各技能脚本都接受产物路径参数（`search.py --outdir`、`verify_refs.py --outdir`、`table1.py --out`、`deidentify.py --out`、`fetch_oa.py -o`、`render_*.sh -o`…）；纯 prompt 技能在指令里写明"写到 workspace/<slug>/drafts/xxx.md"。
- 单独用某个技能、不建工作区时，技能仍回退到仓库根 `outputs/`（向后兼容，行为不变）。
