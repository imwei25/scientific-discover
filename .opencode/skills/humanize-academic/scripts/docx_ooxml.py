#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docx 就地改写的公共底座：部件枚举、段落定位、域冻结、run 可见格式。

被 docx_extract.py / docx_apply.py / docx_verify.py 共用。单独成文件是因为
"哪些 run 不许动""什么算可见格式"这两条判断必须三个脚本完全一致——
抽取时说可以改、回填时按另一套规则改，就会出现"模型改了但落不下去"的静默失败。
"""
import re
import zipfile

from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

# 域内文字在给模型看的文本里用这对括号包住：可以整体挪位置，一个字都不许改。
FREEZE_OPEN, FREEZE_CLOSE = "⟦", "⟧"      # ⟦ ⟧
FREEZE_RE = re.compile(FREEZE_OPEN + r"([^" + FREEZE_CLOSE + r"]*)" + FREEZE_CLOSE)

# 会被就地改写的部件。页眉页脚脚注也要进来——期刊稿的页眉常有短标题(running title)，
# 脚注里常有基金号与通讯作者信息，这些同样是"用户的字"，漏掉就等于只润色了一半。
PART_RE = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")


def part_prefix(part):
    """word/header2.xml → 'h2'；word/footnotes.xml → 'fn'；正文 → 'p'。

    前缀带进段落 id，用户在清单里一眼看出这句话在正文还是页眉——
    否则"为什么这段改了没效果"要查半天（其实是改在页脚上）。
    """
    name = part[len("word/"):-len(".xml")]
    if name == "document":
        return "p"
    if name == "footnotes":
        return "fn"
    if name == "endnotes":
        return "en"
    m = re.match(r"(header|footer)(\d*)", name)
    return ("h" if m.group(1) == "header" else "f") + (m.group(2) or "1") + "p"


def parts_of(path):
    """按固定顺序返回文档里存在的可改部件（顺序固定 = 段落 id 稳定）。"""
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if PART_RE.match(n)]
    names.sort(key=lambda n: (n != "word/document.xml", n))
    return names


def paragraphs(root):
    """部件内全部 w:p，按文档序。表格单元格内的段落也在其中（w:p 是嵌套的）。"""
    return list(root.iter(W + "p"))


# ---- run 的性质判断 -------------------------------------------------------

# 一个 run 只有这些子元素时才敢"拆开重组"（修订标记需要把 run 切成三段）。
# 含 w:drawing / w:object / w:pict 的 run 一旦拆开就会把图复制两份或丢掉，
# 所以那些 run 一律当冻结处理——图本来也不是文字，没有改写的必要。
SPLITTABLE_CHILDREN = {W + "rPr", W + "t", W + "lastRenderedPageBreak",
                       W + "softHyphen", W + "noBreakHyphen"}


def is_splittable(run):
    return all(c.tag in SPLITTABLE_CHILDREN for c in run)


def run_text(run):
    return "".join(t.text or "" for t in run.iter(W + "t"))


def visible_fmt(run):
    """run 的【可见】格式指纹：颜色、高亮、粗、斜、下划线、字号、西文字体、上下标。

    刻意不含 w:lang / rFonts@hint / rsid —— Word 会因拼写检查和输入法把一句话
    切成十几个 run，它们的 lang/hint 各不相同但**渲染完全一样**。把这些算进来，
    每一次正常改写都会报"跨格式边界"，护栏就被噪声废掉了。
    """
    rPr = run.find(W + "rPr")
    if rPr is None:
        return ()
    def val(tag, attr="val"):
        el = rPr.find(W + tag)
        return el.get(W + attr) if el is not None else None
    fonts = rPr.find(W + "rFonts")
    return (val("color"), val("highlight"), val("b"), val("i"), val("u"),
            val("strike"), val("sz"), val("vertAlign"),
            fonts.get(W + "ascii") if fonts is not None else None)


# ---- 段落切片：可改片 / 冻结片 -------------------------------------------

def segments(p):
    """把段落切成 [('edit', [run,...]), ('freeze', '文字'), ...]，按文档序。

    进冻结片的有三类，都是"改了会坏事"的：
      1. 域（w:fldChar…w:fldChar）——EndNote/Zotero 引文、交叉引用、页码、超链接。
         域【结果】那段虽是可见文字，但它由 Word 按域代码重算；改了它，用户下次
         按 F9 更新域，你的改动就没了。
      2. 公式（m:oMath）——OOXML 数学标记，不是文字流。
      3. 拆不开的 run（含图片/嵌入对象）。
    """
    segs, depth, cur = [], 0, []

    def flush():
        if cur:
            segs.append(("edit", list(cur)))
            cur.clear()

    def freeze(txt):
        if not txt:
            return
        if segs and segs[-1][0] == "freeze":
            segs[-1] = ("freeze", segs[-1][1] + txt)
        else:
            segs.append(("freeze", txt))

    for child in p:
        if child.tag == W + "r":
            fc = child.find(W + "fldChar")
            typ = fc.get(W + "fldCharType") if fc is not None else None
            in_field = depth > 0 or typ == "begin" or child.find(W + "instrText") is not None
            if typ == "begin":
                depth += 1
            if in_field or not is_splittable(child):
                flush()
                freeze(run_text(child))
            else:
                cur.append(child)
            if typ == "end":
                depth = max(0, depth - 1)
        elif child.tag in (M + "oMath", M + "oMathPara"):
            flush()
            freeze("".join(child.itertext()))
        elif child.tag in (W + "hyperlink", W + "sdt", W + "ins", W + "del",
                           W + "smartTag", W + "bookmarkStart"):
            # w:hyperlink 内的 run 是可读文字，但改了锚文本要连着改 rels，超出就地改写的范畴；
            # w:ins/w:del 是别人留下的修订痕迹，动它等于篡改他人修订。一律冻结。
            txt = "".join(t.text or "" for t in child.iter(W + "t"))
            if txt:
                flush()
                freeze(txt)
    flush()
    return segs


def marked_text(p):
    """给模型看的整段文字：域/公式/图内文字用 ⟦⟧ 包住。"""
    out = []
    for kind, val in segments(p):
        out.append(FREEZE_OPEN + val + FREEZE_CLOSE if kind == "freeze"
                   else "".join(run_text(r) for r in val))
    return "".join(out)


def plain_text(p):
    """段落的可见文字（不带 ⟦⟧），用于不变量比对。"""
    return "".join(t.text or "" for t in p.iter(W + "t"))


def editable_len(p):
    return sum(len(run_text(r)) for k, v in segments(p) if k == "edit" for r in v)


def revision_groups(root):
    """数【用户在 Word 里看到的】修订处数：相邻的同类修订算一处。

    别报 w:ins / w:del 的元素个数——一句话跨 20 个碎 run 时会生成 20 个 w:del，
    但 Word 把连着的删除显示成一条删除线，用户看到的是 1 处。报元素个数等于
    把"改了 30 处"说成"改了 240 处"，用户会以为稿子被大改了。
    """
    ins = dele = 0
    for p in root.iter(W + "p"):
        prev = None
        for child in p:
            tag = child.tag if child.tag in (W + "ins", W + "del") else None
            if tag and tag != prev:
                if tag == W + "ins":
                    ins += 1
                else:
                    dele += 1
            prev = tag
    return ins, dele


def load(path, part):
    with zipfile.ZipFile(path) as z:
        return etree.fromstring(z.read(part))


def rezip(src, dst, replaced):
    """把 src 原样复制成 dst，只替换 replaced={部件名: 新字节} 里的那几个部件。

    其余条目**逐字节搬运**（含图片、样式、主题、字体表、rels）——
    这就是"格式不会被破坏"的机械保证：没被改的部分根本没有被重新生成过。
    """
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, replaced.get(item.filename, zin.read(item.filename)))


def serialize(root):
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
