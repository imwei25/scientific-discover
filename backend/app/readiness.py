"""投稿就绪检查器(确定性，不调 LLM)。

定位(经调研：出版社"免格式初投"时代，最稳的价值是确定性把关，而非让 LLM
猜检查项——LLM 会把"明明有的章节"说成缺失、把字数算错)。本模块只用纯规则
对稿件文本做可复现的检查：必需章节、摘要/标题/正文字数、参考文献条数、必备
声明关键词、图表引用。即时、零额度、不幻觉。

输出: {ok, summary:{pass,warn,fail}, items:[{key,label,status,detail,suggestion}]}
status ∈ pass(✅通过) / warn(⚠️注意) / fail(❌缺失) / info(ℹ️提示)。
"""
from __future__ import annotations

import re

from .journals import get_check_spec, get_journal

# 章节别名(中英)。键是逻辑章节，值是匹配用的小写别名。
_SECTION_ALIASES: dict[str, list[str]] = {
    "abstract": ["abstract", "摘要", "中文摘要", "英文摘要"],
    "keywords": ["keywords", "key words", "关键词", "index terms"],
    "introduction": ["introduction", "引言", "前言", "背景", "background"],
    "methods": ["methods", "materials and methods", "material and methods", "methodology",
                "方法", "材料与方法", "研究方法", "资料与方法", "对象与方法"],
    "results": ["results", "结果", "result"],
    "discussion": ["discussion", "讨论", "讨 论"],
    "conclusion": ["conclusion", "conclusions", "结论", "小结"],
    "references": ["references", "reference", "参考文献", "引用文献"],
}
_SECTION_LABEL = {
    "abstract": "摘要", "keywords": "关键词", "introduction": "引言/前言",
    "methods": "方法", "results": "结果", "discussion": "讨论",
    "conclusion": "结论", "references": "参考文献",
}

# 必备声明关键词(中英)。缺失记为 warn(很多按研究类型才必需)，非 fail。
_DECLARATIONS: list[tuple[str, str, list[str]]] = [
    ("ethics", "伦理审批", ["ethic", "irb", "institutional review", "伦理", "伦理审批", "伦理委员会"]),
    ("consent", "知情同意", ["informed consent", "知情同意"]),
    ("coi", "利益冲突声明", ["conflict of interest", "conflicts of interest", "competing interest", "利益冲突", "无利益冲突"]),
    ("data", "数据可得性声明", ["data availability", "data are available", "availability of data", "数据可得性", "数据可用性"]),
    ("funding", "资助来源", ["funding", "financial disclosure", "grant", "资助", "基金", "课题资助"]),
    ("contrib", "作者贡献", ["author contribution", "author contributions", "credit", "作者贡献"]),
    ("trial", "试验注册号", ["trial registration", "clinicaltrials.gov", "chictr", "试验注册", "注册号"]),
]

_HEADING_RE = re.compile(r"^\s*(?:#{1,6}\s*|[\d一二三四五六七八九十]+[、.\．]\s*)?(.+?)\s*$")
_BRACKET_RE = re.compile(r"^\s*【(.+?)】\s*$")
_REF_ENTRY_RE = re.compile(r"^\s*(?:\[\d+\]|\(\d+\)|\d+[.)、])")


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def _count_en_words(s: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]*", s or ""))


def _count_cjk_chars(s: str) -> int:
    return len(re.findall(r"[一-鿿]", s or ""))


def _match_section_key(heading: str) -> str | None:
    h = _norm(heading).rstrip(":：.。").strip()
    if not h:
        return None
    for key, aliases in _SECTION_ALIASES.items():
        for a in aliases:
            # 标题等于别名，或以别名开头(如 "Introduction and background" / "1 引言")
            if h == a or h.startswith(a) or a in h and len(h) <= len(a) + 8:
                return key
    return None


def _split_sections(text: str) -> tuple[str, dict[str, str]]:
    """返回 (title, {section_key: 该节正文文本})。靠标题行切分。"""
    lines = text.split("\n")
    title = ""
    sections: dict[str, list[str]] = {}
    cur_key: str | None = None

    for raw in lines:
        line = raw.strip()
        if not line:
            if cur_key:
                sections.setdefault(cur_key, []).append("")
            continue
        is_heading = bool(re.match(r"^\s*#{1,6}\s+", raw)) or bool(_BRACKET_RE.match(raw))
        bracket = _BRACKET_RE.match(raw)
        heading_text = bracket.group(1) if bracket else re.sub(r"^\s*#{1,6}\s+", "", raw).strip()
        # 也允许"纯短行恰好是已知章节别名"作为标题(LLM 常不加 #)
        key = _match_section_key(heading_text if is_heading else line)
        short_plain = (not is_heading) and len(line) <= 12 and key is not None
        if is_heading or short_plain:
            if not title and not is_heading and key is None:
                pass
            if not title and is_heading and key is None:
                # 第一个非章节标题当题目
                title = heading_text
                cur_key = None
                continue
            if key:
                cur_key = key
                sections.setdefault(key, [])
                continue
            # 是标题但不是已知章节 → 结束当前节(进入未归类区)
            cur_key = None
            continue
        # 普通正文
        if not title:
            title = line  # 文首第一行兜底当题目
            continue
        if cur_key:
            sections.setdefault(cur_key, []).append(raw)

    return title, {k: "\n".join(v).strip() for k, v in sections.items()}


def _abstract_count_detail(spec: dict, abstract_text: str) -> tuple[str, str, str]:
    unit = spec.get("abstract_unit", "words")
    n = _count_cjk_chars(abstract_text) if unit == "chars" else _count_en_words(abstract_text)
    unit_cn = "字" if unit == "chars" else "词"
    lo, hi = spec.get("abstract_min"), spec.get("abstract_max")
    detail = f"摘要约 {n} {unit_cn}"
    if hi and n > hi:
        return "warn", detail + f"，超过上限 {hi} {unit_cn}", f"精简到 {hi} {unit_cn}以内"
    if lo and n < lo:
        return "warn", detail + f"，少于下限 {lo} {unit_cn}", f"补充到 {lo} {unit_cn}以上"
    if lo or hi:
        rng = f"{lo or 0}-{hi or '∞'} {unit_cn}"
        return "pass", detail + f"，符合 {rng}", ""
    return "info", detail, ""


def check_readiness(manuscript: str, journal_id: str) -> dict:
    if not manuscript.strip():
        return {"ok": False, "error": "请先提供稿件内容。"}
    spec = get_check_spec(journal_id)
    journal = get_journal(journal_id)
    jname = journal["name"] if journal else "目标期刊"
    low = manuscript.lower()
    title, sections = _split_sections(manuscript)
    items: list[dict] = []

    # 1) 必需章节
    for key in spec["required_sections"]:
        present = key in sections and bool(sections[key].strip() or key in ("references", "keywords"))
        # references/keywords 即便正文短也算存在(只要有该标题)
        present = present or (key in sections)
        items.append({
            "key": f"section_{key}",
            "label": f"必需章节 · {_SECTION_LABEL.get(key, key)}",
            "status": "pass" if present else "fail",
            "detail": "已找到" if present else "未检测到该章节",
            "suggestion": "" if present else f"补充《{_SECTION_LABEL.get(key, key)}》章节",
        })

    # 2) 摘要字数
    if "abstract" in sections and sections["abstract"].strip():
        st, detail, sug = _abstract_count_detail(spec, sections["abstract"])
        items.append({"key": "abstract_len", "label": "摘要字数", "status": st, "detail": detail, "suggestion": sug})

    # 3) 标题字数
    tmax = spec.get("title_max_chars")
    if tmax and title:
        tlen = len(title)
        over = tlen > tmax
        items.append({
            "key": "title_len", "label": "标题长度",
            "status": "warn" if over else "pass",
            "detail": f"标题约 {tlen} 字符（{jname}上限 {tmax}）",
            "suggestion": f"精简标题到 {tmax} 字符以内" if over else "",
        })

    # 4) 正文字数
    bmax = spec.get("body_words_max")
    if bmax:
        body = "\n".join(v for k, v in sections.items() if k != "references")
        bw = _count_en_words(body) if spec.get("lang") == "en" else _count_cjk_chars(body)
        unit_cn = "词" if spec.get("lang") == "en" else "字"
        over = bw > bmax
        items.append({
            "key": "body_len", "label": "正文篇幅",
            "status": "warn" if over else "pass",
            "detail": f"正文约 {bw} {unit_cn}（{jname}上限约 {bmax}）",
            "suggestion": f"压缩正文到 {bmax} {unit_cn}左右" if over else "",
        })

    # 5) 参考文献条数
    ref_text = sections.get("references", "")
    ref_lines = [ln for ln in ref_text.split("\n") if ln.strip()]
    ref_count = sum(1 for ln in ref_lines if _REF_ENTRY_RE.match(ln)) or len(ref_lines)
    rmax = spec.get("ref_max")
    if "references" in sections:
        if ref_count == 0:
            items.append({"key": "ref_count", "label": "参考文献", "status": "warn",
                          "detail": "检测到参考文献标题但未识别到条目", "suggestion": "确认参考文献已列出"})
        elif rmax and ref_count > rmax:
            items.append({"key": "ref_count", "label": "参考文献条数", "status": "warn",
                          "detail": f"约 {ref_count} 条，超过{jname}上限 {rmax}",
                          "suggestion": f"精简到 {rmax} 条以内（方法/补充材料引用通常不计入）"})
        else:
            items.append({"key": "ref_count", "label": "参考文献条数", "status": "pass",
                          "detail": f"约 {ref_count} 条", "suggestion": ""})

    # 6) 必备声明(关键词全文搜索)
    for key, label, kws in _DECLARATIONS:
        found = any(k in low for k in kws)
        items.append({
            "key": f"decl_{key}", "label": f"声明 · {label}",
            "status": "pass" if found else "warn",
            "detail": "已提及" if found else "未检测到",
            "suggestion": "" if found else f"如适用，请补充{label}（部分期刊在投稿系统单独填写）",
        })

    # 7) 图表引用 + 高分图提醒
    fig_refs = len(re.findall(r"(?:figure|fig\.?|图)\s*\d+", low))
    if fig_refs:
        items.append({
            "key": "figures", "label": "图件提交提醒", "status": "info",
            "detail": f"正文引用图约 {fig_refs} 处",
            "suggestion": "投稿时图通常需单独高分文件（TIFF/EPS，300–600 dpi），本工具不处理图件",
        })

    summary = {
        "pass": sum(1 for i in items if i["status"] == "pass"),
        "warn": sum(1 for i in items if i["status"] == "warn"),
        "fail": sum(1 for i in items if i["status"] == "fail"),
    }
    return {"ok": True, "journal": jname, "summary": summary, "items": items}
