#!/usr/bin/env python
"""postprocess_docx.py — 在 pandoc 产出的 .docx 上落期刊送审格式（就地修改）。

pandoc 自身没有字体/字号/边距/行距/行号参数，只能靠 reference-doc 模板；本脚本用
python-docx 直接改样式与节属性，让 render_docx.sh 的 --font/--fontsize/--margin/
--line-spacing/--line-numbers/--journal 落到产物上，不再要求用户自备模板。

用法:
  python postprocess_docx.py FILE.docx [--font NAME] [--cjk-font NAME]
         [--fontsize PT] [--margin SPEC] [--line-spacing MULT] [--line-numbers]

  --margin 接受 1in / 2.5cm / 25mm / 72pt 形式。
  --line-spacing 是行距倍数 (1.0 单倍 / 1.5 / 2.0 双倍)。
  --line-numbers 在每个 section 打开连续行号 (w:lnNumType)。
"""
import argparse
import re
import sys

from docx import Document
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("docx")
    ap.add_argument("--font", default="")
    ap.add_argument("--cjk-font", default="")
    ap.add_argument("--fontsize", type=float, default=0)
    ap.add_argument("--margin", default="")
    ap.add_argument("--line-spacing", type=float, default=0)
    ap.add_argument("--line-numbers", action="store_true")
    args = ap.parse_args()

    doc = Document(args.docx)
    styles = doc.styles
    applied = []

    if args.font or args.cjk_font:
        for name in BODY_STYLES + HEADING_STYLES:
            try:
                set_style_fonts(styles[name], args.font, args.cjk_font)
            except KeyError:
                continue
        applied.append(f"font={args.font or '-'}/eastAsia={args.cjk_font or args.font}")

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

    if not applied:
        print("[postprocess_docx] nothing to apply", file=sys.stderr)
        return

    doc.save(args.docx)
    print(f"[postprocess_docx] applied: {'; '.join(applied)} -> {args.docx}", file=sys.stderr)


if __name__ == "__main__":
    main()
