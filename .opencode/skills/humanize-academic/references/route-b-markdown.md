> 本文件从 SKILL.md「B 路：markdown」与「机械校验」两节搬出，由 SKILL.md 在用户给 `.pdf` / `.md`（或 `.doc` 转换失败）、走 B 路 markdown 改写时引用。参数以 `python scripts/<脚本>.py --help` 为准。

# B 路：markdown（`.pdf` / `.md`）——完整命令与细则

## 为什么不能自己随手抽文本

**不要自己拿 pandoc 或 python-docx 随手抽文本**。那几条路都丢图：
裸 `pandoc x.docx -o x.md` 不带 `--extract-media`，md 里留下 `![](media/xxx.png)` 但文件没落盘；
`pdf_to_md.py` 写死 `ignore_images=True`；`python-docx` 的 `doc.paragraphs` 里既没有图也没有表。
丢了之后一路无声：排版时 pandoc 只打一句 WARNING 就退 0，用户打开 Word 才发现图没了。

## 统一走 `ingest_doc.py`

统一走这个脚本（它会抽媒体、把表转成 pipe 表、并**报出图与表各多少**）：

```bash
"${REPO_ROOT:-/app}/.venv/bin/python" \
  "${REPO_ROOT:-/app}/.opencode/skills/humanize-academic/scripts/ingest_doc.py" manuscript.pdf
# → manuscript_src.md + manuscript_files/fig_001.png ...
# → [ingest] 抽出 图 N 张 / 表 M 张
```

（它也认 `.docx`，但**拿到 .docx 请走 A 路**——走这里等于主动把用户的格式扔掉。）

## 机械校验：B 路跑 `check_invariants.py`

**B 路（markdown）跑 `check_invariants.py`**，确认数字 / 引用 / **图 / 表** / 术语没被动过：
```
# Windows: "${REPO_ROOT:-/app}/.venv/bin/python" ; Linux/macOS: "${REPO_ROOT:-/app}/.venv/bin/python"
"${REPO_ROOT:-/app}/.venv/bin/python" "${REPO_ROOT:-/app}/.opencode/skills/humanize-academic/scripts/check_invariants.py" \
  --before manuscript_src.md --after manuscript_humanized.md \
  --terms "HFpEF,SGLT2i,eGFR"     # 可选：逐个核对关键术语计数
```
`--before` 要给**第零步抽出来的 `_src.md`**，不是用户上传的 .docx / .pdf（脚本只读文本）。

脚本抽取改写前后的数字、引用标记（[n]/(作者,年)/DOI/PMID）、**图片链接**、**表格签名**（表头首格｜列数×行数）、指定术语，做集合 diff，报出任何丢失/新增；并额外检查**图片链接指向的文件是不是真的在**（链接还写着、文件没了，是最隐蔽的一种丢图）。
