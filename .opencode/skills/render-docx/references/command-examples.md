> 本文件从 SKILL.md「用法」搬出，由 SKILL.md 在需要完整命令示例、各排版参数用法或内置 CSL 清单时引用。

# render-docx 命令用法示例（原 SKILL.md「用法」）

脚本在 `/app/.opencode/skills/render-docx/scripts/`（容器内的实际路径；命令行里写 `"${REPO_ROOT:-/app}/..."` 由 shell 展开，但**散文里的路径要能直接拿去 Read/ls**，所以这里写实路径）（Windows 经 Git Bash 跑 .sh）：
```bash
# 最简：Markdown → Word
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md -o manuscript.docx

# ★ 按指定期刊格式排版（预设一键落：字体/字号/边距/行距/行号/参考文献样式）
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --journal nejm
#   可用预设：nejm lancet jama bmj cmj(中华系列) generic-submission(通用送审)；--journal list 列出
#   预设值可被单项覆盖，如：--journal lancet --line-spacing 1.5

# 手动指定送审格式（不套预设）：双倍行距 + 连续行号 + Times 12pt + 1in 边距（默认预设是 1.5 倍行距、无行号）
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md \
  --font "Times New Roman" --fontsize 12 --margin 1in --line-spacing double --line-numbers

# 细排单项（各自可单独用，也可覆盖预设值）：页码 / 首行缩进 / 图表题与表内字号 / 分级标题字号 / 作者块
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md \
  --page-numbers --indent-chars 4 --caption-fontsize 10.5 --table-fontsize 10 \
  --title-fontsize 16 --h1-fontsize 14 --heading-fontsize 12 --author-fontsize 10.5

# 图表置于正文末尾（NEJM/JAMA/Lancet 送审稿要求，原位留"见文末"占位）
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md \
  --journal nejm --figures-at-end

# 中文稿指定中文字体（docx 的 eastAsia 字体，如宋体）
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --journal cmj
#   （cmj 预设已含 宋体正文 + Times 西文 + 1.5 倍行距 + 2.5cm 边距 + GB/T 7714）

# 套用期刊/机构的 Word 模板（继承其样式与字体）；可与格式参数叠加，模板先套、参数后覆盖
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md --ref templates/journal_template.docx

# 按 GB/T 7714 渲染参考文献（仅当稿件用 pandoc @citekey 引用、配 .bib 时；见下方限制）
bash "${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh" -i manuscript.md \
  --csl china-national-standard-gb-t-7714-2015-numeric --bib refs.bib
```
> **常用 CSL 已内置** 在 `presets/csl/`（vancouver / the-lancet / the-new-england-journal-of-medicine / american-medical-association / bmj / china-national-standard-gb-t-7714-2015-numeric），`--csl` 直接写名字即可（不必带路径和 .csl 后缀）；期刊预设配 `--bib` 时自动选用对应样式。要别的样式：本仓库 `backend/.venv/Lib/site-packages/citeproc_styles/styles/` 内置 5 万+ 官方 CSL 可拷进 `presets/csl/`，或从 `citation-style-language/styles` / `zotero-chinese/styles` 下载后 `--csl` 指绝对路径。
