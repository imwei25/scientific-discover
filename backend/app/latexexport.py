"""把稿件导出为 LaTeX 工程(.tex + .bib),打包成 base64 zip。

定位(经调研验证):
  - 纯 Python 生成, 不在本地编译, 不打包 LaTeX/Pandoc/Node, 零体积代价;
  - 产出可被官方期刊类(IEEEtran 等)编译的 .tex + BibTeX .bib;
  - 前端用同一个 base64 zip 既可"下载工程", 又可"在 Overleaf 打开"
    (POST data:application/zip 到 overleaf.com/docs, 无需任何服务器托管)。
  - 参考文献走 BibTeX(\bibliographystyle{IEEEtran} 等官方 .bst), 比 CSL 更准更省。

输入是排版模块产出的 Markdown 文本; 作者/单位等元数据原稿通常缺失, 一律用
占位符标注(不替作者编造), 与本产品"不代写"的原则一致。
"""
from __future__ import annotations

import base64
import io
import re
import zipfile

from .journals import get_latex_spec, get_journal

# ---- LaTeX 转义(仅用于纯文本字段与正文中的非数学部分) -----------------------
_LATEX_SPECIALS = {
    "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$",
    "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}
_MATH_RE = re.compile(r"\$\$.+?\$\$|\$[^$]+\$", re.DOTALL)
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_HEADING_RE = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET_RE = re.compile(r"^[-*]\s+(.*)$")
_ABSTRACT_RE = re.compile(r"^\s*(abstract|摘要)\b", re.IGNORECASE)


def _esc(text) -> str:
    if text is None:
        return ""
    return "".join(_LATEX_SPECIALS.get(c, c) for c in str(text))


def _inline(text: str) -> str:
    """行内 Markdown→LaTeX: 保护 $..$ 数学, 其余转义, 再处理 **粗** *斜*。"""
    maths: list[str] = []

    def _stash(m):
        maths.append(m.group(0))
        return f"\x00{len(maths) - 1}\x00"

    protected = _MATH_RE.sub(_stash, text)
    out = _esc(protected)
    out = _BOLD_RE.sub(lambda m: r"\textbf{%s}" % m.group(1), out)
    out = _ITALIC_RE.sub(lambda m: r"\textit{%s}" % m.group(1), out)
    # 还原数学(原样, 不转义)
    out = re.sub(r"\x00(\d+)\x00", lambda m: maths[int(m.group(1))], out)
    return out


def _body_to_latex(lines: list[str]) -> str:
    """把一段(去掉标题后的)行列表转成 LaTeX: 段落 + itemize 列表。"""
    out: list[str] = []
    in_list = False
    for raw in lines:
        line = raw.rstrip()
        bm = _BULLET_RE.match(line)
        if bm:
            if not in_list:
                out.append(r"\begin{itemize}")
                in_list = True
            out.append(r"  \item " + _inline(bm.group(1)))
            continue
        if in_list:
            out.append(r"\end{itemize}")
            in_list = False
        if not line.strip():
            out.append("")
        else:
            out.append(_inline(line))
    if in_list:
        out.append(r"\end{itemize}")
    return "\n".join(out).strip()


def parse_markdown(text: str) -> dict:
    """把排版稿 Markdown 粗解析为 IR: title / abstract / sections[]。"""
    lines = text.split("\n")
    title = ""
    abstract_lines: list[str] = []
    sections: list[dict] = []
    cur: dict | None = None
    mode = None  # None | "abstract" | "section"

    for raw in lines:
        hm = _HEADING_RE.match(raw.strip())
        if hm:
            heading = hm.group(2).strip().lstrip("0123456789.、 ").strip() or hm.group(2).strip()
            if not title:
                # 第一个标题作题目(若它本身像"摘要"则不当题目)
                if not _ABSTRACT_RE.match(hm.group(2).strip()):
                    title = hm.group(2).strip()
                    mode = None
                    continue
            if _ABSTRACT_RE.match(hm.group(2).strip()):
                mode = "abstract"
                continue
            cur = {"title": heading, "lines": []}
            sections.append(cur)
            mode = "section"
            continue
        # 非标题行
        if mode == "abstract":
            abstract_lines.append(raw)
        elif mode == "section" and cur is not None:
            cur["lines"].append(raw)
        elif not title and raw.strip():
            # 文首没有标题时, 第一行非空当题目
            title = raw.strip()
        # 其余(题目前的散行)忽略

    if not title:
        title = "Untitled Manuscript"
    return {
        "title": title,
        "abstract": _body_to_latex(abstract_lines),
        "sections": [{"title": s["title"], "body": _body_to_latex(s["lines"])} for s in sections],
    }


def _render_tex(ir: dict, spec: dict, has_bib: bool) -> str:
    cls = spec["doc_class"]
    opts = ",".join(spec.get("class_options") or [])
    bib_style = spec["bib_style"]
    is_ieee = cls == "IEEEtran"
    L: list[str] = []
    add = L.append
    add(r"%% 由科研助手自动生成的 LaTeX 投稿稿骨架。")
    add(r"%% 可用 pdflatex+bibtex 编译, 或直接在 Overleaf 打开。")
    add(r"\documentclass[%s]{%s}" % (opts, cls))
    if not is_ieee:
        add(r"\usepackage[utf8]{inputenc}")
        add(r"\usepackage[T1]{fontenc}")
        add(r"\usepackage{ctex}  %% 中文支持; 仅含中文时需要, 纯英文可删")
    add(r"\usepackage{cite}")
    add(r"\usepackage{amsmath,amssymb,amsfonts}")
    add(r"\usepackage{graphicx}")
    add(r"\usepackage{url}")
    add("")
    add(r"\begin{document}")
    add("")
    add(r"\title{%s}" % _esc(ir["title"]))
    if is_ieee:
        add(r"\author{[作者姓名，请补充]\thanks{[单位、通讯地址、邮箱，请补充]}}")
    else:
        add(r"\author{[作者姓名，请补充]}")
        add(r"\date{}")
    add(r"\maketitle")
    add("")
    if ir.get("abstract"):
        add(r"\begin{abstract}")
        add(ir["abstract"])
        add(r"\end{abstract}")
        add("")
    if is_ieee:
        add(r"\IEEEpeerreviewmaketitle")
        add("")
    for sec in ir["sections"]:
        add(r"\section{%s}" % _esc(sec["title"]))
        if sec["body"]:
            add(sec["body"])
        add("")
    if has_bib:
        add(r"\nocite{*}  %% 列出 refs.bib 中所有文献(即便正文未显式 \cite)")
        add(r"\bibliographystyle{%s}" % bib_style)
        add(r"\bibliography{refs}")
        add("")
    add(r"\end{document}")
    return "\n".join(L) + "\n"


def _csl_to_bib_entry(csl: dict, key: str) -> dict:
    type_map = {"article-journal": "article", "book": "book",
                "paper-conference": "inproceedings", "chapter": "incollection"}
    e = {"ENTRYTYPE": type_map.get(csl.get("type"), "article"), "ID": key}
    auth = []
    for a in csl.get("author") or []:
        if not isinstance(a, dict):
            continue
        fam, given = a.get("family", ""), a.get("given", "")
        auth.append((fam + ", " + given).strip(", ").strip())
    if auth:
        e["author"] = " and ".join(auth)
    if csl.get("title"):
        e["title"] = str(csl["title"])
    if csl.get("container-title"):
        e["journal"] = str(csl["container-title"])
    dp = (csl.get("issued") or {}).get("date-parts") or [[None]]
    if dp and dp[0] and dp[0][0]:
        e["year"] = str(dp[0][0])
    for k, bk in (("volume", "volume"), ("issue", "number"), ("page", "pages"), ("DOI", "doi")):
        if csl.get(k):
            e[bk] = str(csl[k])
    return e


def _render_bib(csl_json: list[dict]) -> str:
    import bibtexparser
    from bibtexparser.bibdatabase import BibDatabase
    from bibtexparser.bwriter import BibTexWriter

    db = BibDatabase()
    db.entries = [_csl_to_bib_entry(it, f"ref{i}") for i, it in enumerate(csl_json, 1)]
    writer = BibTexWriter()
    writer.indent = "  "
    writer.order_entries_by = None
    return bibtexparser.dumps(db, writer)


async def export_latex(text: str, journal_id: str, references: str = "") -> dict:
    """返回 {ok, b64zip, note} —— base64 编码的 zip(main.tex + 可选 refs.bib)。"""
    if not text.strip():
        return {"ok": False, "error": "请先提供稿件内容。"}
    spec = get_latex_spec(journal_id)
    journal = get_journal(journal_id)
    notes: list[str] = []

    csl_json: list[dict] = []
    if references.strip():
        # 复用参考文献解析链(LLM 解析 + 去重), 得到结构化 CSL-JSON 再转 BibTeX。
        from .citations import _complete, _extract_messages, _normalize_and_dedup, _parse_json_array
        from .config import settings
        if not settings.mock:
            try:
                csl_json = _normalize_and_dedup(_parse_json_array(await _complete(_extract_messages(references))))
            except Exception as e:  # noqa: BLE001
                notes.append(f"参考文献解析失败，已跳过 .bib：{e}")
                csl_json = []

    ir = parse_markdown(text)
    tex = _render_tex(ir, spec, has_bib=bool(csl_json))
    files = {"main.tex": tex.encode("utf-8")}
    if csl_json:
        files["refs.bib"] = _render_bib(csl_json).encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    if spec["doc_class"] != "IEEEtran":
        notes.append("该期刊无官方 LaTeX 类，已用通用 article 模板（IEEE 选 IEEE Transactions 可得官方 IEEEtran 模板）。")
    notes.append("作者/单位信息原稿通常缺失，已用占位符标注，请在 .tex 中补全。")
    return {"ok": True, "b64zip": b64, "files": list(files.keys()), "note": " ".join(notes)}
