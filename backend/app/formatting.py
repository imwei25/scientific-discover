"""把重排后的文本生成 Word(.docx) 投稿稿。

不依赖 LaTeX/pandoc, 直接用 python-docx 输出 Word, 安装轻、跨平台。
按目标期刊的"投稿稿"版式规格(journals.py 的 docx 字段)程序化设定:
页面/页边距、正文中英文字体与字号、行距、连续行号——这些是投稿稿(单栏)
的核心要求, 效果远好于从零拼装。印刷双栏终稿不在此范围(属出版社流程)。
对常见 Markdown 标记(#, ##, **, - )做基础解析, 映射到 Word 标题/正文样式。
"""
from __future__ import annotations

import io
import re

import base64
import struct

from docx import Document
from docx.enum.text import WD_LINE_SPACING
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

from .journals import get_docx_spec, get_journal

_BOLD = re.compile(r"\*\*(.+?)\*\*")
_SECTION_BRACKET = re.compile(r"^【.+】$")
_BULLET = re.compile(r"^[-*]\s+")
# Markdown 标题: 1-6 个 # + 可选空格(AI 写中文常漏空格, 如 ###立项依据) + 标题文字。
# 容忍漏空格与 #### 以上层级, 避免把 ### 这类记号原样导出到成稿里。
_HEADING = re.compile(r"^(#{1,6})\s*(\S.*?)\s*$")
# 行内标记(供导出成稿): **加粗** 或 [链接文本](url)。链接可能残留 title(支持句), 一并吞掉丢弃。
_INLINE = re.compile(
    r"\*\*(.+?)\*\*"
    r"|\[([^\]]+)\]\((https?://[^)\s]+)(?:\s+\"[^\"]*\")?\)"
)
# 独占一行的内嵌图片(mermaid 渲染成的 PNG data URL): ![alt](data:image/png;base64,XXXX)。
_IMG_DATA = re.compile(r'^!\[[^\]]*\]\(data:image/(png|jpe?g);base64,([A-Za-z0-9+/=]+)\)\s*$')


def _png_size(data: bytes) -> tuple[int, int] | None:
    """从 PNG 字节里读出像素宽高(IHDR 在文件头固定偏移)。非 PNG 返回 None。"""
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return int(w), int(h)
    return None


def _add_hyperlink(paragraph, url: str, text: str) -> None:
    """给段落追加一个真正的 Word 超链接(蓝色下划线), 只显示链接文本, 不显示裸 URL。"""
    part = paragraph.part
    r_id = part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    rpr.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rpr.append(underline)
    run.append(rpr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    run.append(t)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def _add_inline(paragraph, text: str) -> None:
    """处理一行内的 **加粗** 与 [文本](url) 链接; 链接渲染为可点击超链接(丢弃支持句 title)。"""
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            paragraph.add_run(text[pos:m.start()])
        if m.group(1) is not None:  # 加粗
            run = paragraph.add_run(m.group(1))
            run.bold = True
        else:  # 链接: group(2)=文本, group(3)=url
            _add_hyperlink(paragraph, m.group(3), m.group(2))
        pos = m.end()
    if pos < len(text):
        paragraph.add_run(text[pos:])

# 纸张尺寸(宽 x 高, cm)
_PAGE = {"a4": (21.0, 29.7), "letter": (21.59, 27.94)}
_SPACING_RULE = {
    1.0: WD_LINE_SPACING.SINGLE,
    1.5: WD_LINE_SPACING.ONE_POINT_FIVE,
    2.0: WD_LINE_SPACING.DOUBLE,
}
# sectPr 内 lnNumType 之后允许出现的元素(用于 schema 感知插入, 保证 OOXML 顺序合法)
_SECTPR_AFTER_LNNUM = (
    "w:pgNumType", "w:cols", "w:formProt", "w:vAlign", "w:noEndnote",
    "w:titlePg", "w:textDirection", "w:bidi", "w:rtlGutter", "w:docGrid",
    "w:printerSettings", "w:sectPrChange",
)


def _add_image(doc: Document, b64: str, max_w_cm: float, max_h_cm: float) -> None:
    """把 base64 PNG 内嵌成居中图片, 按可用宽度铺满; 过高则改按最大高度约束。"""
    try:
        data = base64.b64decode(b64)
    except Exception:  # noqa: BLE001
        return
    p = doc.add_paragraph()
    p.alignment = 1  # center
    run = p.add_run()
    size = _png_size(data)
    try:
        if size and size[0] > 0:
            w, h = size
            if max_w_cm * (h / w) > max_h_cm:
                run.add_picture(io.BytesIO(data), height=Cm(max_h_cm))
            else:
                run.add_picture(io.BytesIO(data), width=Cm(max_w_cm))
        else:
            run.add_picture(io.BytesIO(data), width=Cm(max_w_cm))
    except Exception:  # noqa: BLE001
        pass  # 图片损坏不阻断整篇导出


def _split_row(line: str) -> list[str]:
    """把一行 GFM 表格 `| a | b |` 拆成单元格; 去掉首尾竖线与两侧空白。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def _is_table_sep(line: str) -> bool:
    """判断是否为 GFM 表格分隔行(如 `| --- | :--: |`)。"""
    s = line.strip()
    if "|" not in s or "-" not in s:
        return False
    cells = _split_row(s)
    return bool(cells) and all(re.fullmatch(r":?-+:?", c) for c in cells)


def _add_table(doc: Document, rows: list[list[str]]) -> None:
    """把解析出的 GFM 表格渲染成带边框的 Word 表格(单元格内保留 **加粗**)。"""
    ncol = max((len(r) for r in rows), default=0)
    if ncol == 0:
        return
    table = doc.add_table(rows=0, cols=ncol)
    try:
        table.style = "Table Grid"  # 内置样式, 提供网格边框
    except KeyError:
        pass
    for r in rows:
        cells = table.add_row().cells
        for ci in range(ncol):
            para = cells[ci].paragraphs[0]
            para.text = ""
            _add_inline(para, r[ci] if ci < len(r) else "")


def _apply_page_and_style(doc: Document, spec: dict) -> None:
    """按期刊规格设定页面、页边距、正文中英文字体/字号、行距。"""
    w, h = _PAGE.get(spec["page"], _PAGE["a4"])
    margin = Cm(float(spec["margin_cm"]))
    for section in doc.sections:
        section.page_width = Cm(w)
        section.page_height = Cm(h)
        section.left_margin = section.right_margin = margin
        section.top_margin = section.bottom_margin = margin

    normal = doc.styles["Normal"]
    normal.font.name = spec["body_font"]
    normal.font.size = Pt(float(spec["body_size"]))
    # 中文字体(eastAsia)需写进 rPr 的 rFonts, python-docx 无高层 API。
    cjk = spec.get("body_font_cjk")
    if cjk:
        rpr = normal.element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        rfonts.set(qn("w:eastAsia"), cjk)
        rfonts.set(qn("w:ascii"), spec["body_font"])
        rfonts.set(qn("w:hAnsi"), spec["body_font"])
    rule = _SPACING_RULE.get(float(spec["line_spacing"]))
    if rule is not None:
        normal.paragraph_format.line_spacing_rule = rule

    # 标题样式: 中文用黑体、字体黑色(默认 Word 标题是蓝色 Latin 字体, 中文文档很丑),
    # 并给各级标题合理字号与段前后间距, 让导出的 Word 不再"和 Markdown 一样朴素"。
    heading_cjk = spec.get("heading_font_cjk") or "黑体"
    heading_latin = spec.get("heading_font") or spec["body_font"]
    _HEADING_SIZE = {0: 18, 1: 16, 2: 14, 3: 13, 4: 12}
    for lvl in range(0, 5):
        name = "Title" if lvl == 0 else f"Heading {lvl}"
        try:
            st = doc.styles[name]
        except KeyError:
            continue
        st.font.name = heading_latin
        st.font.size = Pt(_HEADING_SIZE.get(lvl, 12))
        st.font.bold = True
        try:
            st.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)
        except Exception:  # noqa: BLE001
            pass
        rpr = st.element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        rfonts.set(qn("w:eastAsia"), heading_cjk)
        rfonts.set(qn("w:ascii"), heading_latin)
        rfonts.set(qn("w:hAnsi"), heading_latin)
        pf = st.paragraph_format
        pf.space_before = Pt(10 if lvl <= 1 else 8)
        pf.space_after = Pt(6)


def _add_line_numbers(doc: Document, count_by: int = 1, start: int = 1,
                      restart: str = "continuous") -> None:
    """往首个 section 的 sectPr 注入连续行号(schema 感知插入, 不用 append)。"""
    sectPr = doc.sections[0]._sectPr
    for el in sectPr.findall(qn("w:lnNumType")):
        sectPr.remove(el)
    ln = OxmlElement("w:lnNumType")
    ln.set(qn("w:countBy"), str(count_by))
    ln.set(qn("w:start"), str(start))
    ln.set(qn("w:restart"), restart)
    # OOXML CT_SectPr 要求 lnNumType 在 pgMar 之后、cols 之前; 用 insert_element_before
    # 保证落在合法位置(直接 append 会排到 cols/docGrid 之后, 严格校验器会丢弃)。
    sectPr.insert_element_before(ln, *_SECTPR_AFTER_LNNUM)


def build_docx(
    text: str,
    journal_id: str = "",
    references: list[str] | None = None,
    csl_json: list[dict] | None = None,
) -> bytes:
    """构建 docx.

    参数说明:
      - references: 已格式化的字符串列表 (旧路径, 保持向后兼容)。
      - csl_json:   结构化参考文献 (CSL-JSON)。给出时优先按目标期刊的 CSL 样式
                    渲染成字符串列表, 而不是原样贴入 references 里的字符串,
                    确保 Word 版与 LaTeX 版走同一个 CSL 管线, 不再"我上传成 Vancouver
                    但选了 Nature 期刊, Word 输出还是 Vancouver"。
    """
    doc = Document()
    spec = get_docx_spec(journal_id)
    _apply_page_and_style(doc, spec)

    # 若给出结构化 csl_json, 优先用 citeproc 按期刊样式渲染出字符串列表, 覆盖 references.
    # 失败时降级为原来的 references, 保证不因参考文献格式化异常而丢掉整个 docx 导出。
    if csl_json:
        try:
            from .citations import _normalize_and_dedup, render_bibliography
            from .journals import get_journal as _get_journal

            _journal = _get_journal(journal_id)
            _style_name = (_journal or {}).get("csl") or "vancouver"
            _items: list[dict] = []
            for i, it in enumerate(csl_json, 1):
                if not isinstance(it, dict):
                    continue
                it.setdefault("id", f"ref{i}")
                it.setdefault("type", "article-journal")
                _items.append(it)
            if _items:
                _items = _normalize_and_dedup(_items)
                rendered = render_bibliography(_items, _style_name)
                if rendered:
                    references = rendered
        except Exception:  # noqa: BLE001
            # 渲染失败保留调用方传入的 references (可能是空), 不阻断 docx 导出。
            pass

    journal = get_journal(journal_id)
    if journal:
        title = doc.add_heading(journal["name"] + " · 排版稿", level=0)
        title.alignment = 1  # center

    # 内嵌图片(mermaid 渲染成的 PNG)可用的最大宽/高(cm): 页面尺寸去掉页边距。
    pw, ph = _PAGE.get(spec["page"], _PAGE["a4"])
    _m = float(spec["margin_cm"])
    max_w_cm = max(4.0, pw - 2 * _m)
    max_h_cm = max(4.0, ph - 2 * _m - 2.0)

    lines = text.split("\n")
    n = len(lines)
    i = 0
    # 文档最前面的一级标题(如申请书封面标题「国家自然科学基金申请书」)作居中大标题。
    while i < n and not lines[i].strip():
        i += 1
    if i < n and lines[i].rstrip().startswith("# "):
        t = doc.add_heading(lines[i].rstrip()[2:].strip(), level=0)
        t.alignment = 1  # center
        i += 1

    while i < n:
        line = lines[i].rstrip()
        if not line.strip():
            i += 1
            continue
        # 内嵌图片(独占一行的 data:image PNG, 由 mermaid 渲染而来)。
        mimg = _IMG_DATA.match(line)
        if mimg:
            _add_image(doc, mimg.group(2), max_w_cm, max_h_cm)
            i += 1
            continue
        # GFM 表格: 当前行含竖线且下一行是分隔行时, 整块解析为 Word 表格。
        if "|" in line and i + 1 < n and _is_table_sep(lines[i + 1]):
            rows = [_split_row(lines[i])]
            i += 2  # 跳过表头行与分隔行
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            _add_table(doc, rows)
            continue
        mh = _HEADING.match(line)
        if mh:
            doc.add_heading(mh.group(2).strip(), level=min(len(mh.group(1)), 4))
        elif _SECTION_BRACKET.match(line.strip()):
            doc.add_heading(line.strip().strip("【】"), level=2)
        elif _BULLET.match(line):
            p = doc.add_paragraph(style="List Bullet")
            _add_inline(p, _BULLET.sub("", line))
        else:
            p = doc.add_paragraph()
            _add_inline(p, line)
            # 通用中文文稿(找选题/标书等, 非期刊排版)正文首行缩进 2 字符, 更像正式文档。
            if not journal_id:
                p.paragraph_format.first_line_indent = Pt(24)
        i += 1

    # 追加按期刊样式格式化好的参考文献
    if references:
        cn = bool(journal) and journal_id == "general_cn"
        doc.add_heading("参考文献" if cn else "References", level=1)
        for ref in references:
            ref = (ref or "").strip()
            if ref:
                doc.add_paragraph(ref)

    # 连续行号放最后(确保 sectPr 已是最终状态)
    if spec.get("line_numbers"):
        _add_line_numbers(doc)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
