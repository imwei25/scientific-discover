#!/usr/bin/env python
"""postprocess_docx.py — 在 pandoc 产出的 .docx 上落期刊送审格式（就地修改）。

pandoc 自身没有字体/字号/边距/行距/行号参数，只能靠 reference-doc 模板；本脚本用
python-docx 直接改样式与节属性，让 render_docx.sh 的 --font/--fontsize/--margin/
--line-spacing/--line-numbers/--journal 落到产物上，不再要求用户自备模板。

用法:
  python postprocess_docx.py FILE.docx [--font NAME] [--cjk-font NAME]
         [--fontsize PT] [--margin SPEC] [--line-spacing MULT] [--line-numbers]
         [--heading-cjk-font NAME] [--heading-fontsize PT] [--tables]
         [--page-numbers] [--indent-chars N] [--caption-fontsize PT]
         [--table-fontsize PT] [--title-fontsize PT] [--h1-fontsize PT]
         [--author-fontsize PT]

  --heading-cjk-font/--heading-fontsize 单独控制标题（Heading 1-6）的中文字体与
    字号——中式标书常要求"标题黑体四号、正文宋体小四"这种标题/正文双字体双字号，
    只靠 --cjk-font/--fontsize（作用于正文，标题字号刻意不动）做不出来。

  --margin 接受 1in / 2.5cm / 25mm / 72pt 形式。
  --line-spacing 是行距倍数 (1.0 单倍 / 1.5 / 2.0 双倍)。
  --line-numbers 在每个 section 打开连续行号 (w:lnNumType)。
  --page-numbers 页脚居中插 PAGE 域（pandoc 默认模板不带页码，审稿人没法引用页位）。
  --indent-chars N 正文每段首行缩进 N 个英文半角字符（按 0.5em/字符折算成 pt；
    图表题/表注/作者块/表格单元格会被显式清零，不吃这个缩进）。
  --caption-fontsize 图题/表题/表注字号；图表题并居中、单倍行距、序号加粗。
  --table-fontsize 表内字号（默认正文-1.5pt、下限 9pt；显式给了就用给的值）。
  --title-fontsize / --h1-fontsize 论文标题(Title)与一级标题(Heading 1)字号；
    给了任一标题字号参数时，Title/Heading 1-6 统一加粗并把 pandoc 默认的
    主题蓝改成黑色（期刊送审稿标题不是蓝的）。
  --author-fontsize 作者/机构块（pandoc 的 Author/Affiliation 样式）字号并居中。
  --tables 表格调优：三线表 + 按内容分配固定列宽 + 表内字号降档/单倍行距。
    pandoc 不给列宽时 docx 落成 autofit 表格，Word 自动布局宽度不可预测；
    给了也常是均分。这里按各列内容显示宽度（CJK 记 2 格）重新分配，并同时写
    tblGrid/gridCol 与每格 tcW（只写一处 Word 会无视），tblLayout 固定。
"""
import argparse
import copy
import re
import sys
import unicodedata

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Mm, Pt, RGBColor
from docx.text.run import Run

# pandoc 默认模板里正文/引文类样式；标题单列（字体同步、但不动其字号）
BODY_STYLES = ["Normal", "Body Text", "First Paragraph", "Compact", "Block Text"]
# 首行缩进只给真正的正文段：Compact 是列表（参考文献表就用它）、Block Text 是引用块，
# 它们自带列表/引用缩进，再叠首行缩进会把编号顶歪
INDENT_STYLES = ["Normal", "Body Text", "First Paragraph"]
# pandoc 模板里几乎所有样式都 base=Normal，给 Normal 设首行缩进会顺着继承漏到标题、
# 题名块、题注、列表、代码块上（标题被顶进去 4 个字符，一眼就看出排版坏了）。
# 故这些样式必须显式清零——继承来的值不清就是生效值。
NOINDENT_STYLES = [
    "Title", "Subtitle", "Author", "Affiliation", "Date", "Abstract",
    "Caption", "Image Caption", "Table Caption", "Captioned Figure",
    "Compact", "Block Text", "Source Code", "Bibliography",
    "Footer", "Header", "Footnote Text", "TOC Heading",
] + [f"Heading {i}" for i in range(1, 7)]
HEADING_STYLES = ["Title", "Subtitle"] + [f"Heading {i}" for i in range(1, 7)]
# pandoc 把 YAML 的 author/date 元数据落成这几个段落样式（题名块，随作者一起排）
AUTHOR_STYLES = ["Author", "Affiliation", "Date"]
# pandoc 图题/表题的段落样式（`![…](x.png)` 的题注进 Image Caption/Caption）
CAPTION_STYLES = ["Caption", "Image Caption", "Table Caption"]

# 手写题注段（本套件 write-paper 约定：`**表1. …**` 独立一行、图题在 `![]()` 里）
CAP_RE = re.compile(r"^\s*(图|表|Figure|Table|Fig\.?|Tab\.?)\s*S?\d+", re.I)
# 题注里要加粗的序号前缀：「图1.」「表2：」「Figure 3.」（含随后的分隔符）
CAP_PREFIX_RE = re.compile(r"^\s*(图|表|Figure|Table|Fig\.?|Tab\.?)\s*S?\d+\s*[\.．。:：]?", re.I)
# 表注/图注段（跟在表格/图下方，不居中、但同样用题注字号）
NOTE_RE = re.compile(r"^\s*(表注|图注|注|Note|Notes)\s*[:：.．]")


def parse_margin(spec: str):
    m = re.fullmatch(r"\s*([\d.]+)\s*(in|cm|mm|pt)\s*", spec)
    if not m:
        raise SystemExit(f"ERROR: --margin '{spec}' 不合法，用 1in / 2.5cm / 25mm / 72pt 形式")
    val = float(m.group(1))
    return {"in": Inches, "cm": Cm, "mm": Mm, "pt": Pt}[m.group(2)](val)


def set_style_fonts(style, latin, cjk):
    if latin:
        style.font.name = latin  # 写 w:ascii + w:hAnsi
    if latin or cjk:
        rpr = style.element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        # 不设 eastAsia 时 Word 会用主题默认（等线）渲染中文，必须显式写
        rfonts.set(qn("w:eastAsia"), cjk or latin)


def _display_width(s: str) -> int:
    """East-Asian-aware 显示宽度：全角/宽字符记 2，其余记 1（与 infer_colwidths.py 同口径）。"""
    w = 0
    for ch in s:
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def _mk_border(parent, tag, val, sz):
    el = parent.makeelement(qn(f"w:{tag}"), {})
    el.set(qn("w:val"), val)
    el.set(qn("w:sz"), str(sz))
    el.set(qn("w:space"), "0")
    el.set(qn("w:color"), "auto")
    parent.append(el)


def _three_line_borders(table):
    """医学期刊三线表：顶/底 1.5pt（sz 以 1/8pt 计 → 12），表头下线 0.5pt，无竖线。"""
    tblPr = table._tbl.tblPr
    for old in tblPr.findall(qn("w:tblBorders")):
        tblPr.remove(old)
    borders = tblPr.makeelement(qn("w:tblBorders"), {})
    for tag, val, sz in (("top", "single", 12), ("left", "none", 0),
                         ("bottom", "single", 12), ("right", "none", 0),
                         ("insideH", "none", 0), ("insideV", "none", 0)):
        _mk_border(borders, tag, val, sz)
    tblPr.insert_element_before(
        borders, "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook",
        "w:tblCaption", "w:tblDescription",
    )
    # 表头下线放首行各格 tcBorders——表级 insideH 已关，格级边框优先于表级生效
    for cell in table.rows[0].cells:
        tcPr = cell._tc.get_or_add_tcPr()
        for old in tcPr.findall(qn("w:tcBorders")):
            tcPr.remove(old)
        tcb = tcPr.makeelement(qn("w:tcBorders"), {})
        _mk_border(tcb, "bottom", "single", 4)
        tcPr.insert_element_before(
            tcb, "w:shd", "w:noWrap", "w:tcMar", "w:textDirection",
            "w:tcFitText", "w:vAlign", "w:hideMark",
        )


def _repeat_header_and_keep_rows(table):
    """跨页表的标准做法：首行设为重复表头，各行禁止被从中间劈到两页。

    期刊接受表格跨页，难看的是跨页后没表头、或一行文字被劈开。这两个开关不改
    任何内容，纯排版兜底。
    """
    trPr = table.rows[0]._tr.get_or_add_trPr()
    if not trPr.findall(qn("w:tblHeader")):
        el = trPr.makeelement(qn("w:tblHeader"), {})
        el.set(qn("w:val"), "true")
        trPr.append(el)
    for row in table.rows:
        p = row._tr.get_or_add_trPr()
        if not p.findall(qn("w:cantSplit")):
            p.append(p.makeelement(qn("w:cantSplit"), {}))


def _add_page_numbers(doc):
    """页脚居中插 PAGE 域。pandoc 默认模板不带页码；审稿人提意见要能指到第几页。

    只写第一节的 footer：后续节（如宽表横向节）没有自己的 footerReference 时，
    OOXML 语义是沿用前一节的页脚，正好全篇统一。
    """
    footer = doc.sections[0].footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    for r in list(p.runs):
        r._r.getparent().remove(r._r)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pf = p.paragraph_format
    pf.line_spacing = 1.0  # Footer 基于 Normal，正文双倍行距别把页脚也撑高
    pf.first_line_indent = Pt(0)
    run = p.add_run()
    r = run._r
    for tag, attrs, text in (
        ("w:fldChar", {"w:fldCharType": "begin"}, None),
        ("w:instrText", {"xml:space": "preserve"}, " PAGE "),
        ("w:fldChar", {"w:fldCharType": "end"}, None),
    ):
        el = r.makeelement(qn(tag), {})
        for k, v in attrs.items():
            el.set(qn(k), v)
        if text is not None:
            el.text = text
        r.append(el)


def _bold_caption_prefix(p):
    """题注段只加粗序号前缀（「图1.」「Table 2:」），说明文字改常规——期刊惯例。

    稿件里题注常整行写成 `**表1. 基线特征**`（对 Markdown 阅读友好），照搬进 Word
    就是一整行黑压压的加粗。前缀可能横跨多个 run（pandoc 会拆），跨界的 run 在
    边界处劈成两半。
    """
    m = CAP_PREFIX_RE.match(p.text)
    if not m:
        return
    remain = len(m.group(0))
    for run in list(p.runs):
        if remain <= 0:
            run.bold = False
            continue
        n = len(run.text)
        if n <= remain:
            run.bold = True
            remain -= n
        else:
            r2 = copy.deepcopy(run._r)
            run._r.addnext(r2)
            rest = Run(r2, p)
            rest.text = run.text[remain:]
            rest.bold = False  # 尾巴不在上面的 runs 快照里，得就地取消加粗
            run.text = run.text[:remain]
            run.bold = True
            remain = 0


def _style_captions_and_notes(doc, cap_pt):
    """图题/表题：cap_pt 字号、居中、单倍行距、序号加粗；表注/图注：同字号、不居中。

    覆盖两类来源：pandoc 题注样式（Caption/Image Caption/Table Caption）与
    write-paper 约定的手写题注段（`**表1. …**` 独立一行、整行加粗）。手写题注
    必须整段加粗才认——正文段落常以「表2显示……」开头，只看正则会把正文误判
    成题注拉去居中。都显式清首行缩进，否则 --indent-chars 会把居中的题注顶歪。
    """

    def _all_bold(par):
        runs = [r for r in par.runs if r.text.strip()]
        return bool(runs) and all(r.bold for r in runs)

    caps = notes = 0
    for p in doc.paragraphs:
        try:
            sname = p.style.name if p.style is not None else ""
        except Exception:
            sname = ""
        text = p.text.strip()
        if not text:
            continue
        is_cap = sname in CAPTION_STYLES or (CAP_RE.match(text) and _all_bold(p))
        is_note = (not is_cap) and NOTE_RE.match(text)
        if not (is_cap or is_note):
            continue
        pf = p.paragraph_format
        pf.line_spacing = 1.0
        pf.first_line_indent = Pt(0)
        for run in p.runs:
            run.font.size = Pt(cap_pt)
            run.font.italic = False  # pandoc 的 Image Caption 默认斜体，期刊不用斜体题注
        if is_cap:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _bold_caption_prefix(p)
            # 表题写在表格上方，不锁的话会被分页留在上一页页脚、表格甩到下一页
            if re.match(r"^\s*\**\s*(表|Table|Tab\.?)\s*S?\d", text, re.I):
                pf.keep_with_next = True
            caps += 1
        else:
            notes += 1
    # 图所在段也锁住：图与紧随其后的图注被分页拆开同样难看
    for p in doc.paragraphs:
        if p._p.findall(".//" + qn("w:drawing")):
            p.paragraph_format.keep_with_next = True
    # 样式级也压一遍：题注若无 direct 字号，Caption 样式默认值才是生效值。
    # 按 style.name 遍历而不是 doc.styles[name] 取——后者对内置样式名会退回 style_id
    # 查找并抛 UserWarning（"Caption" 就会），刷在 stderr 里像出了错。
    for st in doc.styles:
        if st.name in CAPTION_STYLES and hasattr(st, "paragraph_format"):
            st.font.size = Pt(cap_pt)
            st.font.italic = False
            st.paragraph_format.line_spacing = 1.0
            st.paragraph_format.first_line_indent = Pt(0)
    return caps, notes


def _force_heading_black_bold(styles):
    """标题统一加粗 + 黑色。pandoc 默认模板的 Heading 是主题蓝、非加粗——
    期刊送审稿的标题不是蓝的，套字号时顺带归一。"""
    for name in ["Title"] + [f"Heading {i}" for i in range(1, 7)]:
        try:
            st = styles[name]
        except KeyError:
            continue
        st.font.bold = True
        st.font.color.rgb = RGBColor(0, 0, 0)


def _caption_before(tbl):
    """表格上方紧邻的表题段落（`**表n …**`）。转横向时要连它一起搬，否则题在上一页。"""
    prev = tbl.getprevious()
    if prev is None or prev.tag != qn("w:p"):
        return None
    txt = "".join(prev.itertext()).strip()
    return prev if re.match(r"^\**\s*(表|Table)\s*\d", txt) else None


def _note_after(tbl):
    """表格下方紧邻的表注段落（`表注：…` / `注：…` / `Note.…`）。

    不一起搬进横向节的话，表在横向页、注被甩到下一张纵向页，比不转横向还难看。
    """
    nxt = tbl.getnext()
    if nxt is None or nxt.tag != qn("w:p"):
        return None
    txt = "".join(nxt.itertext()).strip()
    return nxt if re.match(r"^\**\s*(表注|注|Note|注意)\s*[:：.]", txt) else None


def _set_pgsz(sect, w_pt, h_pt, orient):
    """写 sectPr 的 w:pgSz（缺就新建）。pandoc 默认模板压根不写页面尺寸，必须补。

    sectPr 里子元素有固定次序，pgSz 必须排在 pgMar 之前，否则 Word 判文档损坏。
    """
    pg = sect.find(qn("w:pgSz"))
    if pg is None:
        pg = sect.makeelement(qn("w:pgSz"), {})
        pgmar = sect.find(qn("w:pgMar"))
        if pgmar is not None:
            pgmar.addprevious(pg)
        else:
            sect.append(pg)
    pg.set(qn("w:w"), str(int(round(w_pt * 20))))   # pt → dxa（1/20 pt）
    pg.set(qn("w:h"), str(int(round(h_pt * 20))))
    pg.set(qn("w:orient"), orient)


def _wrap_in_landscape(doc, table, pw_pt, ph_pt):
    """把该表（含表题）单独放进一个横向节：表前后各插一个带 sectPr 的空段落。

    OOXML 语义：段落 pPr 里的 sectPr 描述的是「以该段落结尾的那一节」。
    所以 表前段落带纵向 sectPr（结束前面的纵向节）、表后段落带横向 sectPr
    （结束包住表格的这一节）→ 正好只有表格所在节是横向。

    两个 sectPr 先全部构造校验完再动文档：中途失败就插了一半，会留下多余的分节符。
    """
    body = doc.element.body
    body_sect = body.find(qn("w:sectPr"))
    if body_sect is None:
        return False
    tbl = table._tbl
    cap = _caption_before(tbl)
    anchor = tbl if cap is None else cap

    note = _note_after(tbl)
    tail = tbl if note is None else note

    portrait = copy.deepcopy(body_sect)
    _set_pgsz(portrait, pw_pt, ph_pt, "portrait")
    land = copy.deepcopy(body_sect)
    _set_pgsz(land, ph_pt, pw_pt, "landscape")  # 横向：宽高互换
    # 文末那节（body 级 sectPr）也补上纵向尺寸：只给前两节写了 pgSz 的话，
    # 末节会退回 Word 的默认纸张，同一份稿子里出现两种纸张。
    _set_pgsz(body_sect, pw_pt, ph_pt, "portrait")

    def _mk_sect_para(sect_el):
        p = body.makeelement(qn("w:p"), {})
        pPr = body.makeelement(qn("w:pPr"), {})
        pPr.append(sect_el)
        p.append(pPr)
        return p

    anchor.addprevious(_mk_sect_para(portrait))
    tail.addnext(_mk_sect_para(land))
    return True


def _ensure_tblgrid(table):
    """保证表有与实际列数一致的 w:tblGrid，返回列数。

    pandoc 并非每张表都输出 tblGrid（实测同一份稿件里 3 张表有 1 张有、2 张没有）。
    缺了的话 python-docx 的 table.columns 为空 → 列宽分配整段跳过 → 末尾还会写下
    `tblW w:w="0"`（表宽声明为 0），Word 只能自行猜宽度，表格排版随机漂移。
    这是"表格排得丑"的一个隐形大头，且不报任何错。
    """
    tbl = table._tbl
    ncols = max((len(r.cells) for r in table.rows), default=0)
    if ncols == 0:
        return 0
    grid = tbl.find(qn("w:tblGrid"))
    if grid is None:
        grid = tbl.makeelement(qn("w:tblGrid"), {})
        tbl.tblPr.addnext(grid)  # tblGrid 必须紧跟 tblPr、排在第一个 w:tr 之前
    cols = grid.findall(qn("w:gridCol"))
    if len(cols) != ncols:
        for c in cols:
            grid.remove(c)
        for _ in range(ncols):
            gc = grid.makeelement(qn("w:gridCol"), {})
            gc.set(qn("w:w"), "1000")  # 占位值，随后按内容重写
            grid.append(gc)
    return ncols


def _alloc_widths_pt(units, avail_pt, tsize):
    """按内容单位数分配列宽（pt）。返回 (widths, overflow)。

    超长列封顶 36 单位靠换行消化；短列保底 8 单位不被挤成竖条；
    总宽占版心过半就拉满版心（投稿表惯例），小表保持自然宽度。
    """
    unit_pt = 0.5 * tsize  # 1 单位 ≈ 半个字宽（CJK 全角记 2 单位 = 1 字宽）
    pad = 11.0             # 默认单元格左右边距合计 ≈ 2×108dxa = 10.8pt
    nat = [min(u, 36) * unit_pt + pad for u in units]
    low = [min(u, 8) * unit_pt + pad for u in units]
    total = sum(nat)
    if total <= avail_pt:
        if total >= 0.55 * avail_pt:
            k = avail_pt / total
            return [w * k for w in nat], False
        return nat, False
    if sum(low) >= avail_pt:
        k = avail_pt / sum(low)
        return [w * k for w in low], True
    # 比例压缩但不破各列保底；触底后差额由未触底列继续摊
    k = avail_pt / total
    widths = [max(lo, w * k) for lo, w in zip(low, nat)]
    over = sum(widths) - avail_pt
    free = [i for i in range(len(nat)) if widths[i] > low[i]]
    while over > 0.5 and free:
        share = over / len(free)
        nxt = []
        for i in free:
            cut = min(widths[i] - low[i], share)
            widths[i] -= cut
            over -= cut
            if widths[i] > low[i] + 0.5:
                nxt.append(i)
        free = nxt
    return widths, False


def _tune_tables(doc, body_pt, landscape_wide=False, long_rows=20, table_pt=0):
    """全部表格：三线表 + 固定列宽 + 表内字号降档/表头加粗居中/单倍行距 + 跨页兜底。

    返回 (完整调优数, 仅样式数)。含合并格（gridSpan/vMerge）的表不动列宽只调样式。
    landscape_wide=True 时，按内容压不下的宽表连同表题单独放进横向节。
    table_pt 显式给了就用（期刊常明说"图表 10pt"），否则默认正文-1.5pt、下限 9pt。
    """
    tsize = table_pt if table_pt else max(9.0, body_pt - 1.5)
    sec = doc.sections[0]
    # pandoc 默认模板的 sectPr 可缺 w:pgSz/边距 → python-docx 返回 None，按 Letter/1in 回退
    _pt = lambda v, default: (v / 12700) if v is not None else default  # EMU→pt
    pw = _pt(sec.page_width, 612.0)
    ph = _pt(sec.page_height, 792.0)
    lm = _pt(sec.left_margin, 72.0)
    rm = _pt(sec.right_margin, 72.0)
    avail_pt = pw - lm - rm
    avail_land_pt = ph - lm - rm  # 转横向后版心宽 = 原页高 − 左右边距
    done = styled_only = landscaped = 0
    for ti, table in enumerate(doc.tables, 1):
        try:
            if not table.rows:
                continue
            _three_line_borders(table)
            _repeat_header_and_keep_rows(table)
            if len(table.rows) > long_rows:
                print(
                    f"[postprocess_docx] 注：第{ti}张表 {len(table.rows)} 行，必然跨页"
                    f"（已设重复表头 + 禁止行内断页）。若审稿方要求单页放下，"
                    f"按 write-paper 表格铁律拆成 表na/表nb 或移入补充材料",
                    file=sys.stderr,
                )
            for ri, row in enumerate(table.rows):
                for cell in row.cells:
                    for p in cell.paragraphs:
                        pf = p.paragraph_format
                        pf.line_spacing = 1.0  # 表内单倍行距，不吃正文的双倍行距
                        pf.space_before = Pt(1)
                        pf.space_after = Pt(1)
                        pf.first_line_indent = Pt(0)  # 别吃 --indent-chars 的正文缩进
                        if ri == 0:
                            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        for run in p.runs:
                            run.font.size = Pt(tsize)
                            if ri == 0:
                                run.font.bold = True
            if table._tbl.xpath(".//w:gridSpan | .//w:vMerge"):
                styled_only += 1
                continue
            ncols = _ensure_tblgrid(table)
            if ncols == 0:
                styled_only += 1
                continue
            units = [1] * ncols
            for row in table.rows:
                cells = row.cells
                for c in range(min(ncols, len(cells))):
                    for p in cells[c].paragraphs:
                        units[c] = max(units[c], _display_width(p.text))
            widths, overflow = _alloc_widths_pt(units, avail_pt, tsize)
            # 纵向压不下 → 先试横向：版心从页宽变页高，通常能多出 40% 以上
            if overflow and landscape_wide:
                w2, of2 = _alloc_widths_pt(units, avail_land_pt, tsize)
                if _wrap_in_landscape(doc, table, pw, ph):
                    widths, overflow = w2, of2
                    landscaped += 1
                    print(f"[postprocess_docx] 第{ti}张表纵向放不下，已连同表题转入横向节"
                          f"（版心 {avail_pt:.0f}pt → {avail_land_pt:.0f}pt）", file=sys.stderr)
            table.autofit = False  # tblLayout fixed，列宽不再由 Word 自动布局漂移
            for c, col in enumerate(table.columns):
                col.width = Pt(widths[c])  # 写 tblGrid/gridCol
            for row in table.rows:
                cells = row.cells
                for c in range(min(len(widths), len(cells))):
                    cells[c].width = Pt(widths[c])  # 写每格 tcW
            tblPr = table._tbl.tblPr
            for old in tblPr.findall(qn("w:tblW")):
                tblPr.remove(old)
            tblW = tblPr.makeelement(qn("w:tblW"), {})
            tblW.set(qn("w:w"), str(int(sum(widths) * 20)))
            tblW.set(qn("w:type"), "dxa")
            tblPr.insert_element_before(
                tblW, "w:jc", "w:tblCellSpacing", "w:tblInd", "w:tblBorders",
                "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook",
                "w:tblCaption", "w:tblDescription",
            )
            if overflow:
                need = sum(min(u, 8) * 0.5 * tsize + 11.0 for u in units)
                print(
                    f"[postprocess_docx] WARN: 第{ti}张表按内容至少需约 {need:.0f}pt、"
                    f"版心仅 {avail_pt:.0f}pt——已强行压缩，建议列名改缩写/转置/拆表"
                    f"（见 write-paper 表格排版铁律）",
                    file=sys.stderr,
                )
            done += 1
        except Exception as e:  # 单表失败不拖垮整份文档，保持 pandoc 原样
            print(f"[postprocess_docx] WARN: 第{ti}张表调优失败，保持原样：{e}", file=sys.stderr)
    return done, styled_only, landscaped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx")
    ap.add_argument("--font", default="")
    ap.add_argument("--cjk-font", default="")
    ap.add_argument("--fontsize", type=float, default=0)
    ap.add_argument("--margin", default="")
    ap.add_argument("--line-spacing", type=float, default=0)
    ap.add_argument("--line-numbers", action="store_true")
    ap.add_argument("--heading-cjk-font", default="")
    ap.add_argument("--heading-fontsize", type=float, default=0)
    ap.add_argument("--tables", action="store_true")
    ap.add_argument("--landscape-wide-tables", action="store_true",
                    help="纵向版心压不下的宽表，连同表题单独放进横向节")
    ap.add_argument("--page-numbers", action="store_true")
    ap.add_argument("--indent-chars", type=float, default=0,
                    help="正文每段首行缩进的英文半角字符数（按 0.5em/字符折算）")
    ap.add_argument("--caption-fontsize", type=float, default=0)
    ap.add_argument("--table-fontsize", type=float, default=0)
    ap.add_argument("--title-fontsize", type=float, default=0)
    ap.add_argument("--h1-fontsize", type=float, default=0)
    ap.add_argument("--author-fontsize", type=float, default=0)
    args = ap.parse_args()

    doc = Document(args.docx)
    styles = doc.styles
    applied = []

    if args.font or args.cjk_font or args.heading_cjk_font:
        for name in BODY_STYLES:
            try:
                set_style_fonts(styles[name], args.font, args.cjk_font)
            except KeyError:
                continue
        # 标题类样式：中文字体可与正文不同（标书"标题黑体、正文宋体"），未指定则随正文
        for name in HEADING_STYLES:
            try:
                set_style_fonts(styles[name], args.font, args.heading_cjk_font or args.cjk_font)
            except KeyError:
                continue
        note = f"font={args.font or '-'}/eastAsia={args.cjk_font or args.font}"
        if args.heading_cjk_font:
            note += f"/headingEastAsia={args.heading_cjk_font}"
        applied.append(note)

    if args.heading_fontsize:
        # 只动 Heading 1-6，不动 Title/Subtitle（文档主标题保持层级），各级统一字号
        for i in range(1, 7):
            try:
                styles[f"Heading {i}"].font.size = Pt(args.heading_fontsize)
            except KeyError:
                continue
        applied.append(f"heading_fontsize={args.heading_fontsize:g}pt")

    # 分级标题字号（覆盖顺序：先 --heading-fontsize 统一，再 --h1/--title 单点覆盖）
    if args.h1_fontsize:
        try:
            styles["Heading 1"].font.size = Pt(args.h1_fontsize)
            applied.append(f"h1_fontsize={args.h1_fontsize:g}pt")
        except KeyError:
            pass
    if args.title_fontsize:
        try:
            styles["Title"].font.size = Pt(args.title_fontsize)
            applied.append(f"title_fontsize={args.title_fontsize:g}pt")
        except KeyError:
            pass
    if args.heading_fontsize or args.h1_fontsize or args.title_fontsize:
        # 动了标题字号就顺带归一：加粗 + 黑色（pandoc 默认是主题蓝、非加粗）
        _force_heading_black_bold(styles)
        applied.append("headings=bold+black")

    if args.fontsize:
        for name in BODY_STYLES:
            try:
                styles[name].font.size = Pt(args.fontsize)
            except KeyError:
                continue
        applied.append(f"fontsize={args.fontsize}pt")

    if args.line_spacing:
        for name in BODY_STYLES:
            try:
                styles[name].paragraph_format.line_spacing = args.line_spacing
            except KeyError:
                continue
        applied.append(f"line_spacing={args.line_spacing}x")

    if args.margin:
        emu = parse_margin(args.margin)
        for sec in doc.sections:
            sec.top_margin = sec.bottom_margin = emu
            sec.left_margin = sec.right_margin = emu
        applied.append(f"margin={args.margin}")

    # 正文基准字号：显式给了用给的，否则读 Normal 样式（后面缩进/表格都要用）
    body_pt = args.fontsize
    if not body_pt:
        try:
            sz = styles["Normal"].font.size
            body_pt = sz.pt if sz is not None else 12.0
        except KeyError:
            body_pt = 12.0

    if args.indent_chars:
        indent = Pt(args.indent_chars * 0.5 * body_pt)  # 1 英文半角字符 ≈ 0.5em
        for st in doc.styles:
            # 同名字符样式（如 "Source Code" 有段落版也有字符版）没有 paragraph_format
            if not hasattr(st, "paragraph_format"):
                continue
            if st.name in INDENT_STYLES:
                st.paragraph_format.first_line_indent = indent
            elif st.name in NOINDENT_STYLES:
                st.paragraph_format.first_line_indent = Pt(0)  # 断掉从 Normal 的继承
        applied.append(f"indent={args.indent_chars:g}字符({indent.pt:g}pt)")

    if args.author_fontsize:
        hit = 0
        for st in doc.styles:  # 按 name 遍历：doc.styles["Date"] 会退回 id 查找并告警
            if st.name not in AUTHOR_STYLES or not hasattr(st, "paragraph_format"):
                continue
            st.font.size = Pt(args.author_fontsize)
            # Author/Date 在 pandoc 模板里 base=Title，会把标题的加粗继承过来——
            # 作者与机构不该是粗体，显式关掉（不写 False 就是"继承生效"）
            st.font.bold = False
            st.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            st.paragraph_format.first_line_indent = Pt(0)
            hit += 1
        if hit:
            applied.append(f"author_fontsize={args.author_fontsize:g}pt(居中)")
        else:
            print("[postprocess_docx] 注：文档无 Author/Affiliation 样式段"
                  "（作者块要写在稿件 YAML 的 author: 里才会生成），--author-fontsize 未生效",
                  file=sys.stderr)

    if args.caption_fontsize:
        caps, notes = _style_captions_and_notes(doc, args.caption_fontsize)
        applied.append(f"captions={caps}题+{notes}注@{args.caption_fontsize:g}pt")

    if args.page_numbers:
        _add_page_numbers(doc)
        applied.append("page_numbers=页脚居中")

    if args.line_numbers:
        for sec in doc.sections:
            spr = sec._sectPr
            for old in spr.findall(qn("w:lnNumType")):
                spr.remove(old)
            ln = spr.makeelement(qn("w:lnNumType"), {})
            ln.set(qn("w:countBy"), "1")
            ln.set(qn("w:restart"), "continuous")
            # CT_SectPr 有固定元素顺序，lnNumType 须落在 pgNumType/cols 等之前
            spr.insert_element_before(
                ln,
                "w:pgNumType", "w:cols", "w:formProt", "w:vAlign", "w:noEndnote",
                "w:titlePg", "w:textDirection", "w:bidi", "w:rtlGutter", "w:docGrid",
                "w:printerSettings", "w:sectPrChange",
            )
        applied.append("line_numbers=continuous")

    if args.tables:  # 放最后：列宽分配依赖上面 --margin 生效后的版心宽度
        done, styled_only, landscaped = _tune_tables(
            doc, body_pt, landscape_wide=args.landscape_wide_tables,
            table_pt=args.table_fontsize)
        if done or styled_only:
            tsize = args.table_fontsize if args.table_fontsize else max(9.0, body_pt - 1.5)
            note = f"tables={done}张(三线表/固定列宽/{tsize:g}pt)"
            if styled_only:
                note += f"+{styled_only}张仅样式(含合并格)"
            if landscaped:
                note += f"+{landscaped}张转横向节"
            applied.append(note)

    if not applied:
        print("[postprocess_docx] nothing to apply", file=sys.stderr)
        return

    doc.save(args.docx)
    print(f"[postprocess_docx] applied: {'; '.join(applied)} -> {args.docx}", file=sys.stderr)


if __name__ == "__main__":
    main()
