---
name: reference-check
description: 文献真实性核查 / 查假引用。把稿件或参考文献列表里的每条引用去 Crossref、doi.org、PubMed/Europe PMC 对一遍，揪出 AI 常编的假引用——不存在的 DOI/PMID、张冠李戴（DOI 真但标题对不上）、纯属虚构的标题、已撤稿文献。中英文标题都能比对。当用户说"核对参考文献""这些引用是真的吗""查假引用""验证 DOI""AI 会不会编文献""引用真实性""查重引用来源"时使用。
---

> **产物位置**：所有产物一律写到主控注入的**会话专属目录** 当前工作目录（每轮开头会给出确切前缀，照抄即可）。
> 别写仓库根的固定名，也别写 `/app` 下的任意目录——`/app` 根不在任何数据卷上，容器一重建（改档位、重部署技能都会重建）产物就没了。

> 注：`<会话id>` 是**占位符**，执行前替换成主控给出的实际会话 id（原样复制进 shell 会因 `<` `>` 是重定向符而报错）。

# 文献真实性核查技能

**AI 写作最大的坑就是编引用**。本技能用脚本把每条引用对到真实数据库，标出可疑的。参考 CiteMe / Scholar Sidekick / Citely 的核查思路。

## Python 环境
> 没有项目根 `.venv`？先运行 `env-setup` 技能建好并装依赖。
```
${REPO_ROOT:-/app}/.venv/bin/python   # Windows（正斜杠写法，bash 与 PowerShell 都能用）
${REPO_ROOT:-/app}/.venv/bin/python
```
已装 requests / bibtexparser / rispy。

## 用法
```
# 核查参考文献文件（.bib / .ris / 每行一条的 .txt 都行）
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/reference-check/verify_refs.py --input refs.bib

# 或直接给几个 DOI / PMID / 标题
${REPO_ROOT:-/app}/.venv/bin/python ${REPO_ROOT:-/app}/.opencode/skills/reference-check/verify_refs.py "10.1038/xxx" "PMID:12345678" "某篇论文标题"
```

## 判定结果（按风险从高到低）
| 结论 | 含义 | 该怎么办 |
|---|---|---|
| `RETRACTED` | **文献真实存在、但已被撤稿**（Europe PMC 标 Retracted Publication）| **绝不能引**——医学投稿引到撤稿文献是硬伤；换未撤稿来源。报告里附撤稿通知出处 |
| `FABRICATED` | DOI/PMID 查无，**标题也查不到** | 几乎肯定整条编的，删掉或重找 |
| `ID_FAKE` | **DOI/PMID 查无，但按标题查到真实文献**（论文真、号是 AI 编的）| 用报告给出的**正确 DOI/PMID 替换**即可 |
| `NOT_FOUND` | 只有标题、库里查不到匹配 | 疑似虚构，人工确认 |
| `MISMATCH` | DOI/PMID 存在但指向的标题对不上 | 引错号或标题是编的，核对更正 |
| `CHECK` | 标题部分吻合／跨语种无法自动比对；**或没有 DOI/PMID 且按标题没查到**；**或查到了但年份·首作者对不上** | 人工看一眼。三种成因要分清：机器比不了 ≠ 不存在 ≠ 张冠李戴，报告里的 note 已经写明是哪一种 |
| `OK` | 存在且标题吻合 | 通过 |
| `ERROR` | 查询失败（网络等） | 重试 |

> **标题比对是大小写不敏感的**：两侧都先做 casefold + 空白/标点折叠再比，所以全大写著录、Title Case、句首大写这三种写法互相比都算吻合，纯大小写差异**不会**被判 MISMATCH/CHECK（用 `casefold()` 而非 `lower()`：德语全大写把 ß 写成 SS，`GROSSE GEFÄSSE` 与库里 `Große Gefäße` 只有 casefold 才对得上）。首作者姓的比对同理。报告里回显的标题仍是**原文大小写**，只有比较用的中间值被折叠。
> **中文标题**：脚本保留汉字做字符级比对；当引用是中文、而库里只存英文标题（中文期刊在 Crossref 常见）时，不会误判 MISMATCH，而是降为 `CHECK` 让人工核对——既不误伤真文献、也不放行两个不同中文标题的张冠李戴。
> **数据源**：DOI 依次查 Crossref → **doi.org 内容协商（CSL-JSON）** → Europe PMC。doi.org 兜底能覆盖 DataCite/mEDRA 的 DOI，并区分"号根本不存在"与"真 DOI 但库暂未索引"（刚见刊的真文献不会被误判 FABRICATED）。

## 产出（outputs/）
- `reference_check.csv`：逐条结论 + 相似度 + 实际匹配到的标题。
- `reference_check.md`：按风险分组的人读报告。
- **出 PDF（需要留档/交付时）**：把 `reference_check.md` 交给 `render-pdf-doc` 技能渲染成 `reference_check.pdf`。中文报告务必指定中文字体（`--cjk-font`：本地 `Microsoft YaHei`，服务器 `Noto Sans CJK SC`），否则会漏字。

## 撤稿检测（默认开启）
每条**确认存在**的文献会再去 Europe PMC 查撤稿状态：`pubTypeList` 含 `Retracted Publication` → 判 `RETRACTED`；被标 `Expression of Concern`（表达关注）→ 在 note 里提示、不改判。撤稿通知的出处会一并写进报告。**引到撤稿文献是 AI 辅助写作的高频隐患**（模型的知识截点常早于撤稿日期），故列为最高风险档。
- **兜底（防漏）**：EPMC 撤稿标注有滞后/漏收时，还会看 Crossref/doi.org 元数据信号——标题带 `RETRACTED:`/`WITHDRAWN` 前缀、或 `update-to` 含撤稿关系 → 仍判 `RETRACTED`。这层信号是解析 DOI 时顺带拿到的，零额外网络开销。
- 离线或赶时间可加 `--no-retraction` 跳过（会少一次 EPMC 调用/条）。
- 仅对"真实存在"的条目查（OK/CHECK/MISMATCH）；FABRICATED 之类本就不存在，不再查撤稿。

## 约定
- 常配合使用：`search-lit` 导出的 `refs.bib`、或用户稿件里的参考文献。
- 报告时**重点先讲 RETRACTED / FABRICATED / ID_FAKE / NOT_FOUND / MISMATCH 这几条**，给出建议（撤稿则换来源／删除/替换正确号/更正/重找）。
- **`ID_FAKE` 是最常见也最好修的**：论文真实存在、只是 DOI 被 AI 编造——直接换成报告里给出的正确 DOI 即可，别当整条假的删掉。
- 这是**辅助**核查：`NOT_FOUND` / `CHECK` 不等于一定假（可能库里没收录），提示用户人工复核，别武断下结论。
- **人工推翻了脚本的判定，必须把更正写回 `reference_check.md`**，不能只在对话里说。
  实测踩过：脚本把一条真实文献判 `NOT_FOUND`（著录错，不是假引用），模型在对话里正确更正成
  "实为 N Engl J Med 2020;383(15)"，但交付的 `reference_check.md` 一个字没改，仍写着"疑似虚构，请人工确认"。
  用户把这份报告转给通讯作者或学生时，拿到的是**已经被推翻的那个结论**——而报告才是会被留档和传阅的东西。
  做法：在该条目下追加一行「复核更正：…」，或直接重写该条并在报告开头注明"本报告含 N 处人工复核更正"。
- 联网失败会标 `ERROR`，如实说明，不要把没查成的当成"真"。
