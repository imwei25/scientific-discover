"""参考文献的真实格式化(基于 CSL)。

思路(遵循"不让 LLM 排版"原则)：
  - 用 LLM 仅做"解析"：把用户粘贴的参考文献文本结构化为 CSL-JSON;
  - 用 citeproc-py + 目标期刊的 CSL 样式做"渲染"：确定性地输出规范的参考文献，
    而不是让 LLM 凭空套格式(可能出错)。
"""
from __future__ import annotations

import copy
import json
import re

from citeproc import (
    Citation,
    CitationItem,
    CitationStylesBibliography,
    CitationStylesStyle,
    formatter,
)
from citeproc.source.json import CiteProcJSON
from citeproc_styles import get_style_filepath

from .config import settings
from .journals import get_journal
from .llm import stream_chat

_DEFAULT_STYLE = "vancouver"


async def _complete(messages: list[dict], max_tokens: int = 2000) -> str:
    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


def _extract_messages(refs_text: str) -> list[dict]:
    system = (
        "你是参考文献解析器。把用户提供的参考文献文本解析为 CSL-JSON 数组，"
        "每条包含可识别到的字段：type（如 article-journal）、title、"
        "author（[{\"family\":\"姓\",\"given\":\"名缩写\"}]）、issued（{\"date-parts\":[[年]]}）、"
        "container-title（期刊名）、volume、issue、page、DOI、"
        "language（中文文献填 \"zh-CN\"，英文/西文文献填 \"en-US\"）。"
        "无法识别的字段就省略。只输出一个 JSON 数组，不要任何解释或代码块标记。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": refs_text}]


def _parse_json_array(raw: str) -> list[dict]:
    start, end = raw.find("["), raw.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        arr = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return []
    items = []
    for i, it in enumerate(arr, 1):
        if isinstance(it, dict):
            it.setdefault("id", f"ref{i}")
            it.setdefault("type", "article-journal")
            items.append(it)
    return items


_DOI_PREFIXES = (
    "https://doi.org/", "http://doi.org/",
    "https://dx.doi.org/", "http://dx.doi.org/",
    "doi:", "doi ",
)


def _normalize_doi(doi: str) -> str:
    """把 DOI 统一成裸 DOI（去掉 https://doi.org/ 前缀、doi: 前缀），便于显示与查重。"""
    d = (doi or "").strip()
    low = d.lower()
    for pre in _DOI_PREFIXES:
        if low.startswith(pre):
            return d[len(pre):].strip()
    return d


def _dedup_key(it: dict):
    """生成去重键：优先用 DOI；无 DOI 时退回 标题+年份+第一作者姓。无可识别信息则不参与去重。"""
    doi = _normalize_doi(it.get("DOI", ""))
    if doi:
        return ("doi", doi.lower())
    title = str(it.get("title", "")).strip().lower()
    if not title:
        return None
    year = ""
    try:
        year = str(it["issued"]["date-parts"][0][0])
    except Exception:  # noqa: BLE001
        pass
    authors = it.get("author") or []
    first = str(authors[0].get("family", "")).lower() if authors and isinstance(authors[0], dict) else ""
    return ("meta", title, year, first)


def _normalize_and_dedup(items: list[dict]) -> list[dict]:
    """规整 DOI 并按 _dedup_key 去掉重复条目，重排连续 id。"""
    seen = set()
    out = []
    for it in items:
        if it.get("DOI"):
            it["DOI"] = _normalize_doi(it["DOI"])
        key = _dedup_key(it)
        if key is not None and key in seen:
            continue
        if key is not None:
            seen.add(key)
        out.append(it)
    for i, it in enumerate(out, 1):
        it["id"] = f"ref{i}"
    return out


def _resolve_style(style_name: str) -> CitationStylesStyle:
    try:
        path = get_style_filepath(style_name)
    except Exception:  # noqa: BLE001
        path = get_style_filepath(_DEFAULT_STYLE)
    style = CitationStylesStyle(path, validate=False)
    # Vancouver 等样式用 page-range-format="minimal" 缩写页码区间；但 citeproc-py 的
    # minimal 实现对“尾页位数多于首页”的区间会出错（1-10 → 1–0、99-100 → 99–0）。
    # 强制为 expanded：输出完整区间，永不产生错误页码（用户粘贴的本就多是完整区间）。
    try:
        if style.root.get("page-range-format") == "minimal":
            style.root.set("page-range-format", "expanded")
    except Exception:  # noqa: BLE001
        pass
    return style


# ---- 中英混排修正（方案 C：纯 Python 后处理，0 新依赖） ---------------------
# citeproc-py 只支持标准 CSL 1.0.2，而 GB/T 7714 等样式的"按条目语言切换术语/
# 姓名格式"依赖 citeproc-js 的 CSL-M 扩展。结果两个确定缺陷：
#   1) 中英混排时英文条目也错用 et-al 词「等」(locale 锁中文)；
#   2) 中文人名被插入西式空格（如「张 伟」）。
# 修法：① 人名在 CSL-JSON 输入层把 CJK 的 family+given 合并 → 渲染即无空格，
#        且不触碰标题/刊名，绝对安全；② et-al「等」→「et al」在输出层做，但
#        严格按条目语言门控，只改英文条目（其标题里出现的「等」不可能是中文词）。
_CJK = "一-鿿㐀-䶿豈-﫿"
_CJK_RE = re.compile(f"[{_CJK}]")


def _is_cjk_text(s: str) -> bool:
    return bool(_CJK_RE.search(s or ""))


def _entry_is_chinese(item: dict) -> bool:
    lang = (item.get("language") or "").lower()
    if lang:
        return lang.startswith("zh") or lang.startswith("cn")
    if _is_cjk_text(item.get("title", "")):
        return True
    for a in item.get("author") or []:
        if isinstance(a, dict) and (_is_cjk_text(a.get("family", "")) or _is_cjk_text(a.get("given", ""))):
            return True
    return False


def _preprocess_cjk_names(csl_json: list[dict]) -> list[dict]:
    """把 CJK 作者的 family+given 合并进 family，去掉 given，避免渲染出空格。"""
    out = []
    for it in csl_json:
        it = copy.deepcopy(it)
        for a in it.get("author") or []:
            if not isinstance(a, dict):
                continue
            fam, giv = a.get("family", ""), a.get("given", "")
            if _is_cjk_text(fam) or _is_cjk_text(giv):
                a["family"] = f"{fam}{giv}".strip()
                a.pop("given", None)
        out.append(it)
    return out


def _postprocess_line(line: str, item: dict) -> str:
    """英文条目把中文 et-al 词「等」修正为「et al」。中文条目保持不动。"""
    if not _entry_is_chinese(item):
        return line.replace("等", "et al")
    return line


def render_bibliography(csl_json: list[dict], style_name: str) -> list[str]:
    if not csl_json:
        return []
    prepped = _preprocess_cjk_names(csl_json)
    source = CiteProcJSON(prepped)
    style = _resolve_style(style_name)
    bib = CitationStylesBibliography(style, source, formatter.plain)
    keys = list(source)  # CiteProcJSON 保序，键即各条目 id
    for item_id in keys:
        bib.register(Citation([CitationItem(item_id)]))
    rendered = [str(entry).strip() for entry in bib.bibliography()]
    by_id = {it.get("id"): it for it in prepped}
    return [_postprocess_line(line, by_id.get(k, {})) for k, line in zip(keys, rendered)]


async def format_references(refs_text: str, journal_id: str) -> dict:
    journal = get_journal(journal_id)
    style_name = (journal or {}).get("csl") or _DEFAULT_STYLE
    if not refs_text.strip():
        return {"ok": False, "error": "请粘贴参考文献内容。"}

    if settings.mock:
        return {
            "ok": True,
            "style": style_name,
            "formatted": ["1. [MOCK] Author A, Author B. Title. Journal. 2023;1(1):1-10."],
        }

    try:
        csl_json = _parse_json_array(await _complete(_extract_messages(refs_text)))
        if not csl_json:
            return {"ok": False, "error": "未能解析出参考文献，请检查粘贴的内容格式。"}
        raw_count = len(csl_json)
        csl_json = _normalize_and_dedup(csl_json)
        formatted = render_bibliography(csl_json, style_name)
        result = {"ok": True, "style": style_name, "formatted": formatted}
        if len(csl_json) < raw_count:
            result["note"] = f"已自动去除 {raw_count - len(csl_json)} 条重复参考文献。"
        return result
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"格式化失败：{e}"}
