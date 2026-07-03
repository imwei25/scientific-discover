"""把 Markdown 正文导出成 PDF(reportlab, 纯 Python, 支持中文与可选择文本)。

与 formatting.build_docx 同源: 解析 #/##/###、**加粗**、[链接](url)、GFM 表格、
以及导出前端内嵌的 mermaid 图片(![](data:image/png;base64,...))。中文用 reportlab 内置的
Adobe CID 字体 STSong-Light(无需随包附 TTF), 文本在 PDF 里可选中/复制。
"""
from __future__ import annotations

import base64
import io
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Image as RLImage
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .formatting import _HEADING, _IMG_DATA, _is_table_sep, _png_size, _split_row

_FONT = "STSong-Light"  # reportlab 内置简体中文 CID 字体
_registered = False


def _ensure_font() -> None:
    global _registered
    if not _registered:
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))
        _registered = True


_MARGIN = 2.0 * cm
_INLINE = re.compile(
    r"\*\*(.+?)\*\*"
    r"|\[([^\]]+)\]\((https?://[^)\s]+)(?:\s+\"[^\"]*\")?\)"
)


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inline(text: str) -> str:
    """把一行内的 **加粗** 与 [文本](url) 转成 reportlab 段落标记(其余文本做 XML 转义)。"""
    out: list[str] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            out.append(_esc(text[pos:m.start()]))
        if m.group(1) is not None:
            out.append("<b>" + _esc(m.group(1)) + "</b>")
        else:
            out.append(f'<a href="{_esc(m.group(3))}" color="#0563C1">{_esc(m.group(2))}</a>')
        pos = m.end()
    if pos < len(text):
        out.append(_esc(text[pos:]))
    return "".join(out)


_HEAD_COLOR = colors.HexColor("#1A1A1A")


def _styles() -> dict[str, ParagraphStyle]:
    base = dict(fontName=_FONT, leading=20, spaceAfter=7)
    hbase = dict(fontName=_FONT, leading=20, spaceAfter=6, textColor=_HEAD_COLOR)
    return {
        # 标题: 深色、字号分级、段前留白, 让层级清楚(不再和正文一样平)。
        "title": ParagraphStyle("title", fontSize=19, alignment=1, spaceAfter=16, fontName=_FONT, leading=24, textColor=_HEAD_COLOR),
        "h1": ParagraphStyle("h1", fontSize=15.5, spaceBefore=12, **hbase),
        "h2": ParagraphStyle("h2", fontSize=13.5, spaceBefore=9, **hbase),
        "h3": ParagraphStyle("h3", fontSize=12, spaceBefore=6, **hbase),
        # 正文: 首行缩进 2 字符(约 22pt), 行距略宽, 更像正式中文文稿。
        "body": ParagraphStyle("body", fontSize=11, firstLineIndent=22, **base),
        "bullet": ParagraphStyle("bullet", fontSize=11, leftIndent=16, bulletIndent=2, fontName=_FONT, spaceAfter=5),
        "cell": ParagraphStyle("cell", fontSize=9.5, leading=13, fontName=_FONT),
    }


def _image_flowable(b64: str, avail_w: float, avail_h: float):
    """base64 PNG → 适配页宽的居中图片流; 过高按最大高度收缩。损坏返回 None。"""
    try:
        data = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return None
    size = _png_size(data)
    bio = io.BytesIO(data)
    try:
        if size and size[0] > 0:
            w, h = size
            dw = avail_w
            dh = avail_w * (h / w)
            if dh > avail_h:
                dh = avail_h
                dw = avail_h * (w / h)
            img = RLImage(bio, width=dw, height=dh)
        else:
            img = RLImage(bio, width=avail_w)
        img.hAlign = "CENTER"
        return img
    except Exception:  # noqa: BLE001
        return None


def _build_plain_pdf(text: str, title: str = "") -> bytes:
    """兜底: 富排版失败时, 退回最朴素的逐段纯文本 PDF, 保证导出永不 500。"""
    _ensure_font()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=_MARGIN, rightMargin=_MARGIN,
                            topMargin=_MARGIN, bottomMargin=_MARGIN, title=title or "文档")
    body = ParagraphStyle("plain", fontName=_FONT, fontSize=11, leading=18, spaceAfter=6)
    story = []
    for line in (text or "（无内容）").split("\n"):
        s = line.strip()
        if not s:
            continue
        # 去掉 markdown 记号, 只保留可读文本; 长 URL 允许换行避免超宽。
        s = re.sub(r"[#>*`|]", " ", s)
        s = re.sub(r"\[([^\]]*)\]\((https?://[^)\s]+)\)", r"\1", s)
        try:
            story.append(Paragraph(_esc(s), body))
        except Exception:  # noqa: BLE001
            continue
    if not story:
        story.append(Paragraph("（无内容）", body))
    doc.build(story)
    return buf.getvalue()


def build_pdf(text: str, title: str = "") -> bytes:
    """富排版 PDF; 任何异常都退回纯文本兜底, 保证不 500。"""
    try:
        return _build_pdf_rich(text, title)
    except Exception:  # noqa: BLE001
        import traceback
        print("[pdf] rich build failed, fallback to plain:\n" + traceback.format_exc(), flush=True)
        try:
            return _build_plain_pdf(text, title)
        except Exception:  # noqa: BLE001
            print("[pdf] plain build also failed:\n" + traceback.format_exc(), flush=True)
            # 最后兜底: 一页只写一句提示, 绝不抛错。
            return _build_plain_pdf("导出内容渲染失败，请改用「导出 Word / Markdown」。", title)


def _build_pdf_rich(text: str, title: str = "") -> bytes:
    _ensure_font()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=_MARGIN, rightMargin=_MARGIN, topMargin=_MARGIN, bottomMargin=_MARGIN,
        title=title or "文档",
    )
    avail_w = A4[0] - 2 * _MARGIN
    avail_h = A4[1] - 2 * _MARGIN - 1 * cm
    st = _styles()
    story: list = []

    lines = text.split("\n")
    n = len(lines)
    i = 0
    # 开头的一级标题作居中大标题(如申请书封面标题)。
    while i < n and not lines[i].strip():
        i += 1
    if i < n and lines[i].rstrip().startswith("# "):
        story.append(Paragraph(_inline(lines[i].rstrip()[2:].strip()), st["title"]))
        i += 1

    while i < n:
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        mimg = _IMG_DATA.match(line)
        if mimg:
            img = _image_flowable(mimg.group(2), avail_w, avail_h)
            if img is not None:
                story.append(Spacer(1, 4))
                story.append(img)
                story.append(Spacer(1, 6))
            i += 1
            continue
        # GFM 表格
        if "|" in line and i + 1 < n and _is_table_sep(lines[i + 1]):
            rows = [_split_row(lines[i])]
            i += 2
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            ncol = max((len(r) for r in rows), default=0)
            if ncol:
                data = [[Paragraph(_inline(c if ci < len(r) else ""), st["cell"]) for ci, c in enumerate((r + [""] * ncol)[:ncol])] for r in rows]
                tbl = Table(data, colWidths=[avail_w / ncol] * ncol)
                tbl.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]))
                story.append(tbl)
                story.append(Spacer(1, 6))
            continue
        mh = _HEADING.match(line)
        if mh:
            lvl = len(mh.group(1))
            story.append(Paragraph(_inline(mh.group(2).strip()), st["h1" if lvl <= 1 else "h2" if lvl == 2 else "h3"]))
        elif re.match(r"^[-*]\s+", line):
            story.append(Paragraph(_inline(re.sub(r"^[-*]\s+", "", line)), st["bullet"], bulletText="•"))
        else:
            story.append(Paragraph(_inline(line), st["body"]))
        i += 1

    if not story:
        story.append(Paragraph("（无内容）", st["body"]))
    doc.build(story)
    return buf.getvalue()
