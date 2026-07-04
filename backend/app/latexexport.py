"""把稿件导出为 LaTeX 工程(.tex + .bib),打包成 base64 zip。

定位(经调研验证):
  - 纯 Python 生成, 不在本地编译, 不打包 LaTeX/Pandoc/Node, 零体积代价;
  - 产出可被官方期刊类(IEEEtran 等)编译的 .tex + BibTeX .bib;
  - 前端用同一个 base64 zip 既可"下载工程", 又可"在 Overleaf 打开"
    (POST data:application/zip 到 overleaf.com/docs, 无需任何服务器托管)。
  - 参考文献走 BibTeX(\\bibliographystyle{IEEEtran} 等官方 .bst), 比 CSL 更准更省。

架构:
  - IR 解析(parse_markdown) 支持: heading / bullet / bold / italic /
    fenced code block(->verbatim) / markdown 表格(->tabular) / 行内 code(->\\texttt)。
  - 每个期刊一个 Jinja2 模板(backend/app/latex_templates/*.tex.j2), 便于扩展。
  - 稿件预处理:
    * 检测 CJK 字符; 若目标是 IEEEtran(不支持中文) 则自动降级到 article+ctex+xelatex,
      并在 note 中提示用户;
    * 剥离 emoji(pdflatex 不支持);
    * 过滤 AI 加在末尾的"格式变更说明/Format Change"元章节;
    * 剥离章节标题里的罗马数字/阿拉伯数字前缀, 避免 IEEEtran 双重编号。

输入是排版模块产出的 Markdown 文本; 作者/单位等元数据原稿通常缺失, 一律用
占位符标注(不替作者编造), 与本产品"不代写"的原则一致。
"""
from __future__ import annotations

import base64
import io
import re
import zipfile
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

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
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_HEADING_RE = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET_RE = re.compile(r"^[-*]\s+(.*)$")
_ABSTRACT_RE = re.compile(r"^\s*(abstract|摘要)\b", re.IGNORECASE)
_KEYWORDS_RE = re.compile(r"^\s*(keywords?|index\s*terms?|关键词|关键字)\b", re.IGNORECASE)
# AI 常在末尾生成的"格式变更说明"元章节, 不应进入正文
_META_SECTION_RE = re.compile(
    r"^\s*(格式变更说明|变更说明|说明[:：]|注意事项|注意[:：]|"
    r"format\s*changes?|change\s*notes?|editorial\s*notes?)\b",
    re.IGNORECASE,
)
# AI 在正文末尾生成的"参考文献"章节: 通常是 `【参考文献：原稿缺失，需作者补充】`
# 占位; 当我们有真实 refs.bib 要 append 时, 这一段是重复的, 应剥离。
_REFS_SECTION_RE = re.compile(
    r"^\s*(参考文献|参考书目|文献|references?|bibliography|works\s*cited)\b",
    re.IGNORECASE,
)
# AI 常在响应开头/章节开头加的"引导语", 例如:
#   "以下是按照 XX 期刊格式要求重新排版的稿件："
#   "Here is the reformatted manuscript:"
#   "根据您的要求, 重排后的稿件如下:"
# 这些行在学术论文里没有位置, 无论出现在哪里都应丢弃。
_PREAMBLE_LINE_RE = re.compile(
    r"^\s*("
    r"以下(是|为|按).{0,40}(稿件|论文|内容|排版|文档|版本)|"
    r"下面(是|为).{0,40}(稿件|论文|内容|排版|文档|版本)|"
    r"根据.{0,20}要求.{0,20}(重排|排版|整理|输出)|"
    r"这(是|里是).{0,30}(稿件|排版|重排|版本)|"
    r"注[:：].{0,80}|"
    r"备注[:：].{0,80}|"
    r"(here|below)\s+is\s+the\s+.{0,60}(manuscript|paper|version|reformatt|revised)|"
    r"the\s+following\s+is\s+the\s+.{0,60}(manuscript|paper|version|reformatt|revised)|"
    r"as\s+per\s+.{0,40}requirement"
    r").*[:：]?\s*$",
    re.IGNORECASE,
)
# emoji / 装饰符号(pdflatex 不支持, 直接剥离)
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FFFF"   # 主要 emoji 平面
    "\u2600-\u27BF"            # Misc symbols + Dingbats
    "\u2300-\u23FF"            # Misc technical
    "\u2B00-\u2BFF"            # Additional arrows
    "\uFE0F"                   # Variation selector
    "]+"
)
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
# markdown 围栏代码块
_FENCE_RE = re.compile(r"^```")
# markdown 表格分隔行(如 |---|---|)
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")


def _strip_emoji(text: str) -> str:
    return _EMOJI_RE.sub("", text)


def has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def _esc(text) -> str:
    if text is None:
        return ""
    return "".join(_LATEX_SPECIALS.get(c, c) for c in str(text))


def _inline(text: str) -> str:
    """行内 Markdown→LaTeX: 保护 $..$ 数学与 `code`, 其余转义, 再处理 **粗** *斜*。"""
    maths: list[str] = []
    codes: list[str] = []

    def _stash_math(m):
        maths.append(m.group(0))
        return f"\x00M{len(maths) - 1}\x00"

    def _stash_code(m):
        codes.append(m.group(1))
        return f"\x00C{len(codes) - 1}\x00"

    protected = _MATH_RE.sub(_stash_math, text)
    protected = _INLINE_CODE_RE.sub(_stash_code, protected)
    out = _esc(protected)
    out = _BOLD_RE.sub(lambda m: r"\textbf{%s}" % m.group(1), out)
    out = _ITALIC_RE.sub(lambda m: r"\textit{%s}" % m.group(1), out)
    # 还原数学(原样, 不转义)
    out = re.sub(r"\x00M(\d+)\x00", lambda m: maths[int(m.group(1))], out)
    # 还原 code: 需要对内容做 \texttt 转义(_ # % 等仍要转)
    out = re.sub(r"\x00C(\d+)\x00", lambda m: r"\texttt{" + _esc(codes[int(m.group(1))]) + "}", out)
    return out


def _parse_table_row(line: str) -> list[str]:
    """把 '| a | b | c |' 拆成 ['a','b','c'], 去掉两端空 cell。"""
    parts = [c.strip() for c in line.split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def _render_table(rows: list[list[str]]) -> str:
    """rows[0] 是表头; 生成 tabular 环境。"""
    if not rows:
        return ""
    ncols = max(len(r) for r in rows)
    align = "l" * ncols
    L: list[str] = []
    L.append(r"\begin{table}[h]")
    L.append(r"\centering")
    L.append(r"\begin{tabular}{" + align + "}")
    L.append(r"\toprule")
    header = rows[0] + [""] * (ncols - len(rows[0]))
    L.append(" & ".join(_inline(c) for c in header) + r" \\")
    L.append(r"\midrule")
    for row in rows[1:]:
        row = row + [""] * (ncols - len(row))
        L.append(" & ".join(_inline(c) for c in row) + r" \\")
    L.append(r"\bottomrule")
    L.append(r"\end{tabular}")
    L.append(r"\end{table}")
    return "\n".join(L)


def _body_to_latex(lines: list[str]) -> str:
    """把一段(去掉标题后的)行列表转成 LaTeX: 段落 + itemize + verbatim + tabular。

    支持:
      - fenced code block(``` ... ```)-> verbatim
      - markdown 表格(| col | col | + 分隔行)-> tabular
      - 无序列表(- / *)-> itemize
      - 段落(其余非空行)-> \\par 分段
    """
    out: list[str] = []
    in_list = False
    in_code = False
    code_buf: list[str] = []
    i = 0
    # 先做一次预扫描找出表格块
    n = len(lines)

    def close_list():
        nonlocal in_list
        if in_list:
            out.append(r"\end{itemize}")
            in_list = False

    while i < n:
        raw = lines[i]
        line = raw.rstrip()

        # ---- 代码块围栏 ----
        if _FENCE_RE.match(line.strip()):
            if in_code:
                out.append(r"\begin{verbatim}")
                out.extend(code_buf)
                out.append(r"\end{verbatim}")
                code_buf = []
                in_code = False
            else:
                close_list()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(raw)
            i += 1
            continue

        # ---- markdown 表格: 需要"下一行是分隔行"这一特征 ----
        if "|" in line and i + 1 < n and _TABLE_SEP_RE.match(lines[i + 1].strip()):
            close_list()
            header = _parse_table_row(line)
            i += 2  # 跳过表头 + 分隔行
            rows: list[list[str]] = [header]
            while i < n:
                cur = lines[i].rstrip()
                if not cur.strip() or "|" not in cur:
                    break
                rows.append(_parse_table_row(cur))
                i += 1
            out.append(_render_table(rows))
            continue

        # ---- 无序列表 ----
        bm = _BULLET_RE.match(line)
        if bm:
            if not in_list:
                out.append(r"\begin{itemize}")
                in_list = True
            out.append(r"  \item " + _inline(bm.group(1)))
            i += 1
            continue
        if in_list:
            out.append(r"\end{itemize}")
            in_list = False

        # ---- 空行 / 段落 ----
        if not line.strip():
            out.append("")
        else:
            out.append(_inline(line))
        i += 1

    # 收尾
    if in_list:
        out.append(r"\end{itemize}")
    if in_code:  # 未关闭的代码块也保底输出
        out.append(r"\begin{verbatim}")
        out.extend(code_buf)
        out.append(r"\end{verbatim}")
    return "\n".join(out).strip()


def _clean_section_title(raw: str) -> str:
    """剥离标题里的编号前缀,避免 IEEEtran / ctex 章节自动编号叠加。

    "I. Introduction" -> "Introduction"
    "1. 引言" -> "引言"
    "II) Methods" -> "Methods"
    "一、引言" -> "引言"
    "第三章 结果" -> "结果"
    """
    s = raw.strip()
    # 中文"第 X 章/节/部分"前缀
    s = re.sub(r"^第[一二三四五六七八九十百零〇\d]+[章节部分讲课回]\s*", "", s)
    # 中文数字 + 、
    s = re.sub(r"^[一二三四五六七八九十百零〇]+\s*[、.．)）:：]\s*", "", s)
    # 罗马数字 + 点/括号
    s = re.sub(r"^[IVXLCDM]+\s*[.、)）:：]\s*", "", s, flags=re.IGNORECASE)
    # 阿拉伯数字 + 点/括号
    s = re.sub(r"^\d+\s*[.、)）:：]\s*", "", s)
    return s.strip() or raw.strip()


def _extract_keywords(lines: list[str]) -> tuple[str, list[str]]:
    """从章节 lines 里拎出关键词(第一段作为关键词, 或者所有内容当关键词)。返回 (kw_text, remaining_lines)。"""
    text = "\n".join(lines).strip()
    return text, []


def parse_markdown(text: str, skip_refs_section: bool = False) -> dict:
    """把排版稿 Markdown 粗解析为 IR: title / abstract / keywords / sections[]。

    预处理:
      1. 剥离 emoji
      2. 丢弃 AI 前置引导语("以下是按照 XX 期刊..." / "Here is the reformatted...")
      3. 丢弃 AI 加在末尾的元章节(格式变更说明等)
      4. 若 skip_refs_section=True (下游要 append 真实 refs.bib), 丢弃 AI 生成
         的"参考文献 / References"占位章节 (通常是 `【参考文献：原稿缺失，需作者补充】`)
    """
    text = _strip_emoji(text)

    # 逐行过滤 AI 前置引导语(可能出现在开头, 也可能出现在某章节开头)
    lines = [ln for ln in text.split("\n") if not _PREAMBLE_LINE_RE.match(ln)]
    title = ""
    abstract_lines: list[str] = []
    keywords_lines: list[str] = []
    sections: list[dict] = []
    cur: dict | None = None
    mode = None  # None | "abstract" | "keywords" | "section" | "skip"

    for raw in lines:
        hm = _HEADING_RE.match(raw.strip())
        if hm:
            raw_head = hm.group(2).strip()
            if not title:
                # 第一个标题作题目(若它本身像"摘要"则不当题目)
                if not _ABSTRACT_RE.match(raw_head):
                    title = raw_head
                    mode = None
                    continue
            # 检测元章节 -> 后续行全部丢弃
            if _META_SECTION_RE.match(raw_head):
                mode = "skip"
                cur = None
                continue
            # 参考文献占位章节: 下游会 append 真实 refs.bib, 此处剥离避免重复。
            if skip_refs_section and _REFS_SECTION_RE.match(raw_head):
                mode = "skip"
                cur = None
                continue
            if _ABSTRACT_RE.match(raw_head):
                mode = "abstract"
                cur = None
                continue
            if _KEYWORDS_RE.match(raw_head):
                mode = "keywords"
                cur = None
                continue
            heading = _clean_section_title(raw_head)
            cur = {"title": heading, "lines": []}
            sections.append(cur)
            mode = "section"
            continue

        # 非标题行
        if mode == "skip":
            continue
        if mode == "abstract":
            abstract_lines.append(raw)
        elif mode == "keywords":
            keywords_lines.append(raw)
        elif mode == "section" and cur is not None:
            cur["lines"].append(raw)
        elif not title and raw.strip():
            # 文首没有标题时, 第一行非空当题目
            title = raw.strip()
        # 其余(题目前的散行)忽略

    if not title:
        title = "Untitled Manuscript"

    # 关键词: 单段, 折成一行, 去除 markdown 列表符号
    kw_raw = "\n".join(keywords_lines).strip()
    kw_clean = re.sub(r"^[-*]\s+", "", kw_raw, flags=re.MULTILINE)
    kw_clean = re.sub(r"\s+", " ", kw_clean).strip()

    return {
        "title": _inline(title),
        "abstract": _body_to_latex(abstract_lines),
        "keywords": _inline(kw_clean) if kw_clean else "",
        "sections": [
            {"title": _inline(s["title"]), "body": _body_to_latex(s["lines"])}
            for s in sections
            if s["title"] or s["lines"]
        ],
    }


# ---- Jinja2 环境 ----------------------------------------------------------
_TEMPLATES_DIR = Path(__file__).parent / "latex_templates"
_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=False,   # LaTeX 不需要 HTML 转义
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


def _short_title(title: str, max_chars: int = 60) -> str:
    """给 IEEE \\markboth 用的短标题: 截断在词边界, 去掉尾部标点。"""
    t = re.sub(r"\s+", " ", title or "").strip()
    if len(t) <= max_chars:
        return t
    # 截到 max_chars, 回退到最近空格
    cut = t[:max_chars]
    sp = cut.rfind(" ")
    if sp > max_chars * 0.6:
        cut = cut[:sp]
    return cut.rstrip(",.:;-—") + "..."


def _render_tex(
    ir: dict,
    spec: dict,
    needs_cjk: bool,
    has_bib: bool,
    journal_name: str,
    include_all_refs: bool = False,
    bib_ids: list[str] | None = None,
) -> str:
    template_name = spec.get("template", "general_en.tex.j2")
    tpl = _env.get_template(template_name)
    return tpl.render(
        title=ir["title"],
        short_title=_short_title(ir["title"]),
        abstract=ir["abstract"],
        abstract_en=ir.get("abstract_en", ""),
        keywords=ir["keywords"],
        keywords_en=ir.get("keywords_en", ""),
        sections=ir["sections"],
        doc_class=spec["doc_class"],
        class_options=",".join(spec.get("class_options") or []),
        bib_style=spec["bib_style"],
        needs_cjk=needs_cjk,
        has_bib=has_bib,
        include_all_refs=include_all_refs,
        bib_ids=bib_ids or [],
        journal_name=journal_name,
        compiler_hint=spec.get("compiler", "pdflatex"),
    )


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


def _degrade_to_cjk_article(spec: dict) -> dict:
    """IEEEtran/其他不支持中文的类 -> article+ctex+xelatex 兜底。"""
    fallback = dict(spec)
    fallback["doc_class"] = "article"
    fallback["class_options"] = ["UTF8", "12pt"]
    fallback["template"] = "general_cn.tex.j2"
    fallback["compiler"] = "xelatex"
    fallback["cjk"] = True
    return fallback


async def export_latex(text: str, journal_id: str, references: str = "", csl_json: list[dict] | None = None) -> dict:
    """返回 {ok, b64zip, note} —— base64 编码的 zip(main.tex + 可选 refs.bib)。
    csl_json 给出时跳过 LLM 解析, 直接归一化 + 建 .bib (更准更快)。"""
    if not text.strip():
        return {"ok": False, "error": "请先提供稿件内容。"}

    spec = get_latex_spec(journal_id)
    journal = get_journal(journal_id)
    journal_name = journal["name"] if journal else "目标期刊"
    notes: list[str] = []
    original_class = spec["doc_class"]

    # 参考文献 -> BibTeX. 优先用结构化输入; 否则退回 LLM 解析文本。
    from .citations import _normalize_and_dedup
    csl_items: list[dict] = []
    if csl_json:
        items: list[dict] = []
        for i, it in enumerate(csl_json, 1):
            if not isinstance(it, dict):
                continue
            it.setdefault("id", f"ref{i}")
            it.setdefault("type", "article-journal")
            items.append(it)
        csl_items = _normalize_and_dedup(items)
    elif references.strip():
        from .citations import _complete, _extract_messages, _parse_json_array
        from .config import settings
        if not settings.mock:
            try:
                csl_items = _normalize_and_dedup(_parse_json_array(await _complete(_extract_messages(references))))
            except Exception as e:  # noqa: BLE001
                notes.append(f"参考文献解析失败，已跳过 .bib：{e}")
                csl_items = []
    has_bib = bool(csl_items)

    # 先解析 markdown, 剥离 emoji 与元/参考文献占位章节, 再基于"干净"的正文判断
    # 是否需要 CJK 支持。原来的做法是对整段 text 直接 has_cjk, 但 LLM 输出常带
    # 中文占位符 (【摘要：原稿缺失，需作者补充】) 或中文格式变更说明, 即使正文
    # 是纯英文也会误判成中文 → 触发 IEEEtran 降级到单栏 article, 用户看不到
    # 两栏排版. 用 parse_markdown 得到干净的 title/abstract/正文再检测.
    stripped = _strip_emoji(text)
    ir = parse_markdown(stripped, skip_refs_section=has_bib)
    ir_content_for_cjk = " ".join([
        ir.get("title", ""),
        ir.get("abstract", ""),
        ir.get("keywords", ""),
        *[(s.get("title") or "") + " " + (s.get("body") or "") for s in ir.get("sections", [])],
    ])
    contains_cjk = has_cjk(ir_content_for_cjk)

    # IEEEtran 不支持中文 -> 自动降级
    if contains_cjk and original_class == "IEEEtran":
        spec = _degrade_to_cjk_article(spec)
        notes.append(
            "稿件含中文, 而 IEEEtran 官方类不支持中文, 已自动切换到 article + ctex 模板, "
            "并建议使用 xelatex 编译。若为纯英文稿, 请把中文段落删除后重新导出。"
        )
        # 换了模板 -> IR 里的参考文献策略也可能需要重解析; 但正文本身不变, IR 复用即可.
    elif contains_cjk and not spec.get("cjk"):
        spec = dict(spec)
        spec["compiler"] = "xelatex"
        notes.append("稿件含中文, 已启用 ctex 支持, 建议使用 xelatex 编译。")

    needs_cjk = bool(spec.get("cjk")) or contains_cjk
    # bib IDs 必须与 _render_bib 里的键一致 (enumerate 从 1 开始)
    bib_ids = [f"ref{i}" for i, _ in enumerate(csl_items, 1)] if csl_items else []
    tex = _render_tex(
        ir, spec,
        needs_cjk=needs_cjk,
        has_bib=bool(csl_items),
        journal_name=journal_name,
        # 结构化输入时用户已明确选了要附上哪些参考文献 → 全部列出;
        # 只有走 LLM 解析路径时才只列文中引用到的, 避免噪音条目污染文末。
        include_all_refs=bool(csl_json),
        bib_ids=bib_ids,
    )

    files = {"main.tex": tex.encode("utf-8")}
    if csl_items:
        files["refs.bib"] = _render_bib(csl_items).encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    if original_class != "IEEEtran" and spec["doc_class"] != "IEEEtran":
        # 只有非 IEEE 才补这个说明; IEEE 用户看到"选 IEEE Transactions 可得 IEEEtran"会困惑
        pass
    notes.append("作者/单位信息原稿通常缺失, 已用占位符标注, 请在 .tex 中补全。")
    return {
        "ok": True,
        "b64zip": b64,
        "files": list(files.keys()),
        "note": " ".join(notes),
        "compiler": spec.get("compiler", "pdflatex"),
    }
