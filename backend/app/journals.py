"""内置期刊格式规则库(MVP)。

真实产品里这部分应来自“从各刊 Guide for Authors 抽取 + 人工校验”的规则库;
此处先内置几种有代表性的格式, 覆盖中英文常见投稿场景。
后续可扩展为可维护的 JSON 数据文件。
"""
from __future__ import annotations

# 每个期刊的 Word 投稿稿版式规格(docx)与 LaTeX 出口配置(latex)。
# docx 字段: page(a4/letter) / margin_cm / body_font / body_font_cjk(可选) /
#   body_size(pt) / line_spacing(1.0|1.5|2.0) / line_numbers(连续行号)。
# 取值依据各刊"投稿稿"常见要求(单栏、行距、连续行号),非印刷终稿。
JOURNALS: list[dict] = [
    {
        "id": "general_en",
        "name": "通用学术论文（英文 IMRaD）",
        "summary": "标准 IMRaD 结构，适合大多数英文期刊初稿。",
        "csl": "vancouver",
        "docx": {
            "page": "a4", "margin_cm": 2.54, "body_font": "Times New Roman",
            "body_size": 12, "line_spacing": 2.0, "line_numbers": True,
        },
        "latex": {"doc_class": "article", "class_options": ["12pt"], "bib_style": "ieeetran"},
        "check": {
            "lang": "en", "abstract_unit": "words", "abstract_min": 150, "abstract_max": 250,
            "required_sections": ["abstract", "keywords", "introduction", "methods", "results", "discussion", "references"],
        },
        "rules": (
            "- 章节顺序：Title, Abstract, Keywords, Introduction, Methods, "
            "Results, Discussion, Conclusion, References。\n"
            "- 摘要 150-250 词，单段，不分点。\n"
            "- 关键词 3-6 个。\n"
            "- 参考文献按正文出现顺序编号 [1][2]，文末按序列出。\n"
            "- 使用第三人称、过去时描述方法与结果。"
        ),
    },
    {
        "id": "general_cn",
        "name": "中文核心期刊（GB/T 7714）",
        "summary": "中文论文常用结构，参考文献采用 GB/T 7714 顺序编码。",
        "csl": "china-national-standard-gb-t-7714-2015-numeric",
        "docx": {
            "page": "a4", "margin_cm": 2.54, "body_font": "Times New Roman",
            "body_font_cjk": "宋体", "body_size": 12, "line_spacing": 1.5,
            "line_numbers": False,
        },
        "latex": {"doc_class": "article", "class_options": ["12pt"], "bib_style": "unsrt"},
        "check": {
            "lang": "zh", "abstract_unit": "chars", "abstract_min": 200, "abstract_max": 300,
            "required_sections": ["abstract", "keywords", "introduction", "methods", "results", "discussion", "conclusion", "references"],
        },
        "rules": (
            "- 章节顺序：题目, 中文摘要, 关键词, 引言, 材料与方法（或研究方法）, "
            "结果, 讨论, 结论, 参考文献。\n"
            "- 中文摘要 200-300 字，含目的、方法、结果、结论。\n"
            "- 关键词 3-8 个，中文，分号隔开。\n"
            "- 参考文献采用 GB/T 7714 顺序编码制：正文用上标 [1]，"
            "文末格式如：作者. 题名[J]. 刊名, 年, 卷(期): 起止页.\n"
            "- 如有基金资助，在首页脚注标注。"
        ),
    },
    {
        "id": "nature",
        "name": "Nature 系列",
        "summary": "结构化、字数严格，引用为上标编号。",
        "csl": "nature",
        "docx": {
            "page": "a4", "margin_cm": 2.54, "body_font": "Times New Roman",
            "body_size": 12, "line_spacing": 2.0, "line_numbers": True,
        },
        "latex": {"doc_class": "article", "class_options": ["12pt"], "bib_style": "naturemag"},
        "check": {
            "lang": "en", "abstract_unit": "words", "abstract_min": 100, "abstract_max": 200,
            "title_max_chars": 75, "body_words_max": 3500, "ref_max": 50,
            "required_sections": ["abstract", "results", "discussion", "methods", "references"],
        },
        "rules": (
            "- 章节顺序：Title, Abstract, (正文，引言不单列标题), Results, "
            "Discussion, Methods（置于正文后）, References。\n"
            "- 摘要为无标题的一段，约 150-200 词，面向广泛读者，避免专业缩写。\n"
            "- 正文引用使用上标阿拉伯数字，按出现顺序编号。\n"
            "- 图表标题简洁；统计需说明样本量 n 与检验方法。\n"
            "- 语言简洁，避免行话。"
        ),
    },
    {
        "id": "ieee",
        "name": "IEEE Transactions",
        "summary": "工程领域，双栏、方括号引用。",
        "csl": "ieee",
        "docx": {
            "page": "letter", "margin_cm": 1.9, "body_font": "Times New Roman",
            "body_size": 10, "line_spacing": 1.0, "line_numbers": False,
        },
        "latex": {"doc_class": "IEEEtran", "class_options": ["journal"], "bib_style": "IEEEtran"},
        "check": {
            "lang": "en", "abstract_unit": "words", "abstract_min": 150, "abstract_max": 250,
            "required_sections": ["abstract", "keywords", "introduction", "conclusion", "references"],
        },
        "rules": (
            "- 章节顺序：Title, Abstract, Index Terms, I. Introduction, "
            "II. ... （罗马数字编号的章节）, Conclusion, References。\n"
            "- 摘要约 150-250 词。\n"
            "- 关键词称 Index Terms，按字母排序。\n"
            "- 正文引用使用方括号编号 [1]，参考文献按出现顺序，"
            "格式遵循 IEEE 引用样式（作者缩写, 标题, 刊名缩写, 卷, 期, 页, 年）。"
        ),
    },
    {
        "id": "plos_one",
        "name": "PLOS ONE",
        "summary": "开放获取，结构灵活，强调方法可复现。",
        "csl": "plos",
        "docx": {
            "page": "letter", "margin_cm": 2.54, "body_font": "Times New Roman",
            "body_size": 12, "line_spacing": 2.0, "line_numbers": True,
        },
        "latex": {"doc_class": "article", "class_options": ["12pt"], "bib_style": "plos2015"},
        "check": {
            "lang": "en", "abstract_unit": "words", "abstract_max": 300,
            "title_max_chars": 250,
            "required_sections": ["abstract", "introduction", "methods", "results", "discussion", "references"],
        },
        "rules": (
            "- 章节顺序：Title, Abstract, Introduction, Materials and Methods, "
            "Results, Discussion, (Conclusions 可选), References。\n"
            "- 摘要单段，无小标题，约 300 词以内。\n"
            "- 强调方法部分足够详细以可复现。\n"
            "- 参考文献采用编号制（Vancouver 风格），按正文出现顺序。"
        ),
    },
]

_BY_ID = {j["id"]: j for j in JOURNALS}


_DEFAULT_DOCX = {
    "page": "a4", "margin_cm": 2.54, "body_font": "Times New Roman",
    "body_size": 12, "line_spacing": 1.0, "line_numbers": False,
}
_DEFAULT_LATEX = {"doc_class": "article", "class_options": ["12pt"], "bib_style": "unsrt"}


def get_journal(journal_id: str) -> dict | None:
    return _BY_ID.get(journal_id)


def get_docx_spec(journal_id: str) -> dict:
    j = _BY_ID.get(journal_id) or {}
    return {**_DEFAULT_DOCX, **(j.get("docx") or {})}


def get_latex_spec(journal_id: str) -> dict:
    j = _BY_ID.get(journal_id) or {}
    return {**_DEFAULT_LATEX, **(j.get("latex") or {})}


_DEFAULT_CHECK = {
    "lang": "en", "abstract_unit": "words", "abstract_min": None, "abstract_max": None,
    "title_max_chars": None, "body_words_max": None, "ref_max": None,
    "required_sections": ["abstract", "introduction", "methods", "results", "discussion", "references"],
}


def get_check_spec(journal_id: str) -> dict:
    j = _BY_ID.get(journal_id) or {}
    return {**_DEFAULT_CHECK, **(j.get("check") or {})}


def list_journals() -> list[dict]:
    return [{"id": j["id"], "name": j["name"], "summary": j["summary"]} for j in JOURNALS]
