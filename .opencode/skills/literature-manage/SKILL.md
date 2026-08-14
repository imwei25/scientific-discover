---
name: literature-manage
description: 把一个文件夹里的 PDF/Word 文献整理成多 sheet 的 Excel 台账——扫描目录抽正文，逐篇填年份/作者/杂志/核心观点，按用户给的标准（或 AI 自定口径）分类，一类一个 sheet；还能按台账里的分类把原文件归到同名子文件夹。只读用户指定的那个本机文件夹，不检索、不下载。
triggers: 文献管理, 整理文献文件夹, 文献台账, 文献分类, 把文献分门别类, 文献目录 Excel, 批量读文献出表, 按分类归档文献, literature library, organize papers folder
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---

> **本仓库运行环境（先读）**：Python 用项目根 `.venv` 的解释器（没建过先跑 `env-setup` 技能）；本技能脚本在
> `.opencode/skills/literature-manage/scripts/` 下，用全路径调用。**产物一律写当前工作目录、用裸文件名**
> （本模块的当前工作目录就是用户选的那个文献文件夹），别拼任何 `outputs/` 前缀。

# 文献管理（文件夹 → 多 sheet Excel 台账 → 按分类归档）

> **决策规约（照 AGENTS.md §六）**：要用户拍板的抉择一律在正文里列 2–4 个编号候选（推荐项放第 1 个并说明理由），
> 让用户回一个数字即推进；别用开放式提问逼用户打字，也别弹交互选项卡。

## 这个技能干什么（边界先说清）

- **只处理用户指定的那一个本机文件夹**里的 `.pdf` / `.docx`。不联网检索、不下载全文、不写综述。
- 每篇只读**开头若干页**（默认 3 页 / 4000 字）——足够拿到标题、作者、期刊、年份、摘要与结论要点。
  整本读一个几百篇的文件夹会把额度烧光，且对台账没有额外价值。
- **抽不到就写「原文未标注」**。年份、期刊、作者是最容易被脑补的三个字段——
  文件名叫 `Nature_2021_final.pdf` 不等于它发在 Nature、也不等于 2021 年，一律以正文为准。

## 三步走

### 第 1 步：扫描目录，抽出每篇的开头正文

```bash
<venv-python> <skills>/literature-manage/scripts/scan_library.py            # 只扫这一层
<venv-python> <skills>/literature-manage/scripts/scan_library.py --recursive # 连子文件夹
```

产物：`library_index.json`（每篇一条：文件名、大小、DOI、PDF 自带元数据、抽到多少字）
和 `library_texts/*.txt`（每篇的开头正文）。

- **接下来只读 `library_texts/` 里的 txt**，不要再去打开原始 PDF——正文已经抽好了，重复读只是烧钱。
- `needs_ocr: true` 的是图片型扫描件：篇数不多时可以走 `ocr` 技能补，不补就在表里如实写
  「图片型扫描件，未能识别正文」，**不许按文件名编内容**。
- `err` 字段有值的是读取失败（常见是 `.doc` 老格式），如实列给用户。

### 第 2 步：填台账 + 分类，写成 `library.json`

逐篇读 `library_texts/` 的正文，填出这几列，写成当前目录下的 `library.json`：

```json
{
  "classified": true,
  "rule": "用户给的分类标准原话；用户没给就写你自定的口径（一句话说清按什么分）",
  "columns": ["文件名", "标题", "年份", "作者", "杂志", "核心观点"],
  "fields":  ["file", "title", "year", "authors", "journal", "point"],
  "categories": ["随机对照试验", "队列研究", "综述"],
  "records": [
    {"file": "a.pdf", "category": "随机对照试验", "title": "……", "year": "2021",
     "authors": "Smith J, et al.", "journal": "Lancet", "point": "一句话说清它做了什么、结论是什么"}
  ]
}
```

- `file` **必须与 `library_index.json` 里的 `file` 逐字一致**（含子目录前缀）——
  界面上的「改分类」「按分类归档」都靠这个字段找文件，写错了那两个功能就对不上。
- `columns` / `fields` 一一对应，**这两行别改**（界面的表格编辑按它读写）。
- **`point`（核心观点）是这张表的价值所在**：写"它做了什么 + 得到什么结论"，
  别写"本文研究了 XX 的相关问题"这种等于没说的话。一到两句，可含关键数字。
- **分类口径**：
  - 用户给了标准 → 严格照他的口径分，`rule` 记他的原话；他的标准覆盖不到的篇目单列一类，
    **别硬塞**，并在交付时告诉他有哪几篇没归进去。
  - 用户没给标准 → 你自己定一个**一致的**维度（研究类型 / 主题方向 / 器官系统 / 技术路线，选一个，
    别混着分），把口径写进 `rule` 并在交付时讲明白，让他知道这批 sheet 是按什么切的。
  - 用户勾了不分类 → `"classified": false`，全部一个 sheet。
  - 类别数控制在 **3–8 类**：一类一篇的分法等于没分。

### 第 3 步：出 Excel

```bash
<venv-python> <skills>/literature-manage/scripts/build_workbook.py
```

`library.json` → `library.xlsx`，一类一个 sheet，sheet 名 = 类名，表头冻结、核心观点自动换行。

交付时告诉用户：在产出栏点开 `library.xlsx` 可以**按 sheet 预览**，并直接在预览里
**把某一篇改到别的分类**（改完立刻重出 Excel），或**一键按分类归档到子文件夹**。

## 按分类归档（会动用户的原始文件，慎重）

```bash
<venv-python> <skills>/literature-manage/scripts/archive_library.py            # 预演，不动文件
<venv-python> <skills>/literature-manage/scripts/archive_library.py --apply    # 真的移动
<venv-python> <skills>/literature-manage/scripts/archive_library.py --undo     # 撤销上一次
```

- **默认只预演**。必须先把"哪些文件会移到哪个子文件夹、共几个"给用户看，
  **等他明确说执行再加 `--apply`**——这是动他硬盘上原始资料的操作，不许自作主张先做了再说。
- 移动后 `library.json` 里的 `file` 会同步成新路径，`archive_log.json` 记录全部 from→to，`--undo` 可原样搬回。
- 用户担心动原件 → 给他 `--copy`（复制一份进子文件夹，原文件留在原地）这个选项。

## 常见追问怎么答

- **"再加一列 XX"**：改 `library.json` 的 `columns`/`fields` 并给每条补上该字段，重跑 build_workbook.py。
- **"换个分法重分一次"**：只改各条的 `category` 与 `rule`（正文已经抽过了，**不要重跑扫描**），重出 Excel。
- **"这篇讲的什么"**：直接读它的 `library_texts/*.txt` 回答；要读透整篇请他去「文献研读」模块。
- **"帮我把这些文献写成综述"**：本模块不做，指路「综述撰写」模块。
