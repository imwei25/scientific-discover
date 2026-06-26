"""把重排后的文本生成 Word(.docx) 文件。

MVP 不依赖 LaTeX/pandoc, 直接用 python-docx 输出 Word, 安装轻、跨平台。
对常见 Markdown 标记(#, ##, **)做基础解析, 映射到 Word 标题/正文样式。
"""
from __future__ import annotations

import io
import re

from docx import Document
from docx.shared import Pt

from .journals import get_journal

_BOLD = re.compile(r"\*\*(.+?)\*\*")
_SECTION_BRACKET = re.compile(r"^【.+】$")


def _add_runs_with_bold(paragraph, text: str) -> None:
    """处理一行内的 **加粗** 标记。"""
    pos = 0
    for m in _BOLD.finditer(text):
        if m.start() > pos:
            paragraph.add_run(text[pos:m.start()])
        run = paragraph.add_run(m.group(1))
        run.bold = True
        pos = m.end()
    if pos < len(text):
        paragraph.add_run(text[pos:])


def build_docx(text: str, journal_id: str = "") -> bytes:
    doc = Document()

    # 基础正文样式
    style = doc.styles["Normal"]
    style.font.name = "Times New Roman"
    style.font.size = Pt(12)

    journal = get_journal(journal_id)
    if journal:
        title = doc.add_heading(journal["name"] + " · 排版稿", level=0)
        title.alignment = 1  # center

    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.startswith("### "):
            doc.add_heading(line[4:].strip(), level=3)
        elif line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=2)
        elif line.startswith("# "):
            doc.add_heading(line[2:].strip(), level=1)
        elif _SECTION_BRACKET.match(line.strip()):
            doc.add_heading(line.strip().strip("【】"), level=2)
        else:
            p = doc.add_paragraph()
            _add_runs_with_bold(p, line)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
