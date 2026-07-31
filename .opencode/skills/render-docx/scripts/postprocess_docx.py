#!/usr/bin/env python
"""postprocess_docx.py — 在 pandoc 产出的 .docx 上落期刊送审格式（就地修改）。

pandoc 自身没有字体/字号/边距/行距/行号参数，只能靠 reference-doc 模板；本脚本用
python-docx 直接改样式与节属性，让 render_docx.sh 的 --font/--fontsize/--margin/
--line-spacing/--line-numbers/--journal 落到产物上，不再要求用户自备模板。

用法:
  python postprocess_docx.py FILE.docx [--font NAME] [--cjk-font NAME]
         [--fontsize PT] [--margin SPEC] [--line-spacing MULT] [--line-numbers]
         [--heading-cjk-font NAME] [--heading-fontsize PT] [--tables]

  --heading-cjk-font/--heading-fontsize 单独控制标题（Heading 1-6）的中文字体与
    字号——中式标书常要求"标题黑体四号、正文宋体小四"这种标题/正文双字体双字号，
    只靠 --cjk-font/--fontsize（作用于正文，标题字号刻意不动）做不出来。

  --margin 接受 1in / 2.5cm / 25mm / 72pt 形式。
  --line-spacing 是行距倍数 (1.0 单倍 / 1.5 / 2.0 双倍)。
  --line-numbers 在每个 section 打开连续行号 (w:lnNumType)。
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
from docx.shared import Cm, Inches, Mm, Pt

# pandoc 默认模板里正文/引文类样式；标题单列（字体同步、但不动其字号）
BODY_STYLES = ["Normal", "Body Text", "First Paragraph", "Compact", "Block Text"]
HEADING_STYLES = ["Title", "Subtitle"] + [f"Heading {i}" for i in range(1, 7)]


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
    """医学期刊三线表：顶/底 1.5pt（sz 以 1/8pt 计 → 12），表头下线 0.75pt，无竖线。"""
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
        _mk_border(tcb, "bottom", "single", 6)
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


def _tune_tables(doc, body_pt, landscape_wide=False, long_rows=20):
    """全部表格：三线表 + 固定列宽 + 表内字号降档/表头加粗居中/单倍行距 + 跨页兜底。

    返回 (完整调优数, 仅样式数)。含合并格（gridSpan/vMerge）的表不动列宽只调样式。
    landscape_wide=True 时，按内容压不下的宽表连同表题单独放进横向节。
    """
    tsize = max(9.0, body_pt - 1.5)
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
                        if ri == 0:
                            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        for run in p.runs:
                            run.font.size = Pt(tsize)
                            if ri == 0:
                                run.font.bold = True
            if table._tbl.xpath(".//w:gridSpan | .//w:vMerge"):
                styled_only += 1
                continue
            ncols = len(table.columns)
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
        body_pt = args.fontsize
        if not body_pt:
            try:
                sz = styles["Normal"].font.size
                body_pt = sz.pt if sz is not None else 12.0
            except KeyError:
                body_pt = 12.0
        done, styled_only, landscaped = _tune_tables(
            doc, body_pt, landscape_wide=args.landscape_wide_tables)
        if done or styled_only:
            note = f"tables={done}张(三线表/固定列宽/{max(9.0, body_pt - 1.5):g}pt)"
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
