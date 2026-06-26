"""参考文献的真实格式化(基于 CSL)。

思路(遵循"不让 LLM 排版"原则)：
  - 用 LLM 仅做"解析"：把用户粘贴的参考文献文本结构化为 CSL-JSON;
  - 用 citeproc-py + 目标期刊的 CSL 样式做"渲染"：确定性地输出规范的参考文献，
    而不是让 LLM 凭空套格式(可能出错)。
"""
from __future__ import annotations

import json

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
        "container-title（期刊名）、volume、issue、page、DOI。"
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


def _resolve_style(style_name: str) -> CitationStylesStyle:
    try:
        path = get_style_filepath(style_name)
    except Exception:  # noqa: BLE001
        path = get_style_filepath(_DEFAULT_STYLE)
    return CitationStylesStyle(path, validate=False)


def render_bibliography(csl_json: list[dict], style_name: str) -> list[str]:
    if not csl_json:
        return []
    source = CiteProcJSON(csl_json)
    style = _resolve_style(style_name)
    bib = CitationStylesBibliography(style, source, formatter.plain)
    for item_id in source:
        bib.register(Citation([CitationItem(item_id)]))
    return [str(entry).strip() for entry in bib.bibliography()]


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
        formatted = render_bibliography(csl_json, style_name)
        return {"ok": True, "style": style_name, "formatted": formatted}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"格式化失败：{e}"}
