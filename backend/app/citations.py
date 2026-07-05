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
    async for piece in stream_chat(messages, task="citations", max_tokens=max_tokens):
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


def _normalize_and_dedup(items: list[dict], preserve_ids: bool = False) -> list[dict]:
    """规整 DOI 并按 _dedup_key 去掉重复条目。

    - preserve_ids=False(默认): 重排为连续 refN, 兼容既有调用 (Word/citeproc 渲染无需
      与正文 \\cite{} 对齐)。
    - preserve_ids=True: 保留每条 csl_item 原始 id (如前端/handoff 已指定), 缺失才生成
      唯一 refN. 这样后续正文 \\cite{X} 与 bib 里 key 严格一致, 不会因 dedup 缩表而
      引用到已被删掉的编号。
    """
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
    if preserve_ids:
        used: set[str] = set()
        # 第一遍: 收集已存在且非空的 id (若重复则以首次出现为准, 后续会重新分配)
        for it in out:
            rid = str(it.get("id") or "").strip()
            if rid and rid not in used:
                used.add(rid)
                it["id"] = rid
            else:
                it["id"] = ""  # 待分配
        # 第二遍: 为无 id 的条目分配唯一 refN
        counter = 1
        for it in out:
            if not it.get("id"):
                while f"ref{counter}" in used:
                    counter += 1
                new_id = f"ref{counter}"
                it["id"] = new_id
                used.add(new_id)
                counter += 1
    else:
        for i, it in enumerate(out, 1):
            it["id"] = f"ref{i}"
    return out


def _is_vancouver_style(style_name: str) -> bool:
    """判定是否 Vancouver 系列样式（含 vancouver-superscript / vancouver-brackets 等变体）。

    Vancouver 官方 ICMJE 要求 page-range 使用 minimal（1-10 → 1-10，99-108 → 99-108），
    非 Vancouver 样式则保留 expanded 以规避 citeproc-py minimal 的实现 bug。
    """
    return "vancouver" in (style_name or "").strip().lower()


def _resolve_style(style_name: str) -> CitationStylesStyle:
    try:
        path = get_style_filepath(style_name)
    except Exception:  # noqa: BLE001
        path = get_style_filepath(_DEFAULT_STYLE)
        style_name = _DEFAULT_STYLE
    style = CitationStylesStyle(path, validate=False)
    # Vancouver 官方规则是 minimal；其他样式因 citeproc-py 对 "尾页位数多于首页" 的 minimal
    # 有实现 bug（1-10 → 1–0、99-100 → 99–0），统一强制为 expanded。
    # 仅当 style 明确是 Vancouver 系列时，保留 minimal 以符合 ICMJE 规范。
    try:
        current = style.root.get("page-range-format")
        if current == "minimal" and not _is_vancouver_style(style_name):
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


# ---- 中国作者拼音姓名处理 --------------------------------------------------
# 场景: CrossRef 对中文期刊上的中国作者返回拼音字段 {"family":"Chen","given":"Wei"},
# 但英文样式 (Vancouver 等) 会渲染成 "Chen W.", 而中文样式 (GB/T 7714) 期望"陈伟"
# 或至少"Chen Wei"这样的姓在前、名不缩写. 我们无法把拼音还原成汉字, 但可以在
# 中文样式下把 given 完整保留并置于 family 之后, 避免出现"名+姓"倒置或名被缩写。
#
# 常见中国姓氏 (拼音) 白名单——不试图穷举所有姓, 只覆盖高频姓以降低误伤海外华裔.
_CN_SURNAME_PINYIN: frozenset[str] = frozenset({
    "chen", "wang", "li", "liu", "zhang", "yang", "huang", "zhao", "wu", "zhou",
    "xu", "sun", "ma", "zhu", "hu", "guo", "he", "gao", "lin", "luo",
    "zheng", "liang", "xie", "song", "tang", "han", "feng", "deng", "cao", "peng",
    "zeng", "xiao", "tian", "dong", "yuan", "pan", "yu", "jiang", "cai", "du",
    "ye", "cheng", "su", "wei", "lu", "ding", "ren", "shen", "yao", "cui",
    "zhong", "tan", "fan", "jin", "shi", "liao", "jia", "xia", "fu", "fang",
    "bai", "zou", "meng", "xiong", "qin", "qiu", "yin", "xue", "yan", "duan",
    "lei", "hou", "long", "tao", "gu", "mao", "hao", "gong", "shao", "wan",
    "qian", "dai",
})

# CSL style 名字里包含以下关键词, 即视为中文样式.
_CHINESE_STYLE_TOKENS = ("gb-t7714", "gb/t7714", "gbt7714", "gb7714",
                         "chinese", "zh-cn", "zh-tw", "china")


def is_chinese_style(style_name: str | None) -> bool:
    """判断 CSL style 是否为中文样式 (GB/T 7714 等)。"""
    s = (style_name or "").strip().lower()
    if not s:
        return False
    return any(tok in s for tok in _CHINESE_STYLE_TOKENS)


def _looks_like_chinese_pinyin_name(family: str, given: str) -> bool:
    """启发式判定"看起来是中国人的拼音姓名"。

    条件: family 是常见中国姓氏拼音, 且 family + given 都是纯 ASCII 拉丁 (避免误伤真汉字)。
    given 允许缩写 (J. K.) 或全拼 (Wei), 但不放宽姓氏。
    """
    if not family or not family.isascii():
        return False
    if given and not given.isascii():
        return False
    fam_lower = family.strip().rstrip(".").lower()
    if not fam_lower or len(fam_lower) > 12:
        return False
    return fam_lower in _CN_SURNAME_PINYIN


def _preprocess_cjk_names(csl_json: list[dict], style_name: str | None = None) -> list[dict]:
    """人名归一化:
      1) 汉字姓名 (family/given 含 CJK): family+given 合并到 family, 去除 given,
         避免渲染出西式空格 (张 伟 → 张伟)。
      2) 中文样式 (GB/T 7714 等) 且看起来是中国作者的拼音: 把 given 完整拼在
         family 后, 保持"姓 名"顺序 (Chen Wei 而非 Chen W.), 避免姓名倒置或名被缩写。
    """
    is_zh = is_chinese_style(style_name)
    out = []
    for it in csl_json:
        it = copy.deepcopy(it)
        for a in it.get("author") or []:
            if not isinstance(a, dict):
                continue
            fam, giv = a.get("family", ""), a.get("given", "")
            # 汉字姓名: 合并去空格
            if _is_cjk_text(fam) or _is_cjk_text(giv):
                a["family"] = f"{fam}{giv}".strip()
                a.pop("given", None)
                continue
            # 拼音姓名 + 中文样式: 姓在前、名不缩写
            if is_zh and _looks_like_chinese_pinyin_name(fam, giv):
                if giv:
                    a["family"] = f"{fam} {giv}".strip()
                    a.pop("given", None)
        out.append(it)
    return out


def _postprocess_line(line: str, item: dict) -> str:
    """英文条目把中文 et-al 词「等」修正为「et al」。中文条目保持不动。"""
    if not _entry_is_chinese(item):
        return line.replace("等", "et al")
    return line


# CSL type → 非学术资源提示（映射到 warning kind + 用户可读消息）。
# "article-journal" / "book*" 视为学术，不报警。
_NON_ACADEMIC_TYPES: dict[str, tuple[str, str]] = {
    "posted-content": ("preprint", "该资源为预印本（未经同行评审），学术引用需注意期刊是否接受此类来源。"),
    "proceedings-article": ("conference", "该资源为会议论文或会议摘要，非期刊全文；如目标期刊不接受会议成果请替换。"),
    "report": ("report", "该资源为研究报告（非同行评审）。"),
    "dataset": ("dataset", "该资源为数据集，非学术论文。"),
    "component": ("dataset", "该资源为组件/补充材料，非独立学术论文。"),
    "standard": ("dataset", "该资源为标准文档，非同行评审论文。"),
    "personal-communication": ("communication", "该资源为个人通信，非公开发表。"),
    "dissertation": ("dissertation", "该资源为学位论文（非期刊论文），部分期刊不接受。"),
    "manuscript": ("unknown", "该资源为未发表手稿。"),
    "other": ("unknown", "该资源类型异常，可能非同行评审文献，请核对。"),
}

# URL 关键词 → 非学术资源（即使 CSL type 看起来正常也应提示）。
_NON_ACADEMIC_URL_HINTS: list[tuple[str, str, str]] = [
    ("/infographics/", "infographic", "该资源为科普信息图（infographic），非同行评审学术文献。"),
    ("medium.com/", "blog", "该资源为博客文章，非学术论文。"),
    ("substack.com/", "blog", "该资源为博客/通讯文章，非学术论文。"),
]

# 有 DOI 或 CrossRef ISSN 视为学术，可覆盖 URL 提示以外的分类。
_ACADEMIC_TYPES = {"article-journal", "article", "book", "book-chapter",
                   "book-part", "book-section", "reference-book", "monograph",
                   "reference-entry"}


def _detect_non_academic(csl_json: list[dict]) -> list[dict]:
    """扫描 CSL-JSON，为非学术/非同行评审的条目生成用户可读提示。

    返回 [{index, kind, title, message}]，index 从 1 开始与用户在 UI 上看到的条目对齐。
    """
    warnings: list[dict] = []
    for i, it in enumerate(csl_json, start=1):
        if not isinstance(it, dict):
            continue
        typ = str(it.get("type") or "").strip().lower()
        url = str(it.get("URL") or "").lower()
        title = str(it.get("title") or "").strip()
        has_doi = bool(str(it.get("DOI") or "").strip())

        # 1) URL 关键词优先（信息图/博客即便 type=article-journal 也应提示）
        matched_url: tuple[str, str] | None = None
        for needle, kind, msg in _NON_ACADEMIC_URL_HINTS:
            if needle in url:
                matched_url = (kind, msg)
                break
        if matched_url:
            warnings.append({"index": i, "kind": matched_url[0],
                             "title": title, "message": matched_url[1]})
            continue

        # 2) 显式的非学术 CSL type
        if typ in _NON_ACADEMIC_TYPES:
            kind, msg = _NON_ACADEMIC_TYPES[typ]
            warnings.append({"index": i, "kind": kind, "title": title, "message": msg})
            continue

        # 3) type 缺失/为空 且 无 DOI → 可疑
        if not typ and not has_doi:
            warnings.append({
                "index": i, "kind": "unknown", "title": title,
                "message": "该条参考文献类型未知且无 DOI，可能非同行评审文献，请核对。",
            })
            continue

    return warnings


def render_bibliography(csl_json: list[dict], style_name: str) -> list[str]:
    if not csl_json:
        return []
    prepped = _preprocess_cjk_names(csl_json, style_name)
    source = CiteProcJSON(prepped)
    style = _resolve_style(style_name)
    bib = CitationStylesBibliography(style, source, formatter.plain)
    keys = list(source)  # CiteProcJSON 保序，键即各条目 id
    for item_id in keys:
        bib.register(Citation([CitationItem(item_id)]))
    rendered = [str(entry).strip() for entry in bib.bibliography()]
    by_id = {it.get("id"): it for it in prepped}
    return [_postprocess_line(line, by_id.get(k, {})) for k, line in zip(keys, rendered)]


async def format_references(refs_text: str, journal_id: str, csl_json: list[dict] | None = None) -> dict:
    """按 CSL 样式渲染参考文献。
    - 若 csl_json 已给出(前端 handoff/结构化输入): 直接归一化 + 渲染, 跳过 LLM。
    - 否则用 LLM 从 refs_text 中抽取 CSL-JSON。
    """
    journal = get_journal(journal_id)
    style_name = (journal or {}).get("csl") or _DEFAULT_STYLE
    if not csl_json and not (refs_text or "").strip():
        return {"ok": False, "error": "请粘贴参考文献内容。"}

    if settings.mock:
        return {
            "ok": True,
            "style": style_name,
            "formatted": ["1. [MOCK] Author A, Author B. Title. Journal. 2023;1(1):1-10."],
        }

    try:
        if csl_json:
            # 前端已给结构化输入, 补全 id/type 便于 citeproc 使用。
            items: list[dict] = []
            for i, it in enumerate(csl_json, 1):
                if not isinstance(it, dict):
                    continue
                it.setdefault("id", f"ref{i}")
                it.setdefault("type", "article-journal")
                items.append(it)
            if not items:
                return {"ok": False, "error": "结构化参考文献为空。"}
            csl_items = items
        else:
            csl_items = _parse_json_array(await _complete(_extract_messages(refs_text)))
            if not csl_items:
                return {"ok": False, "error": "未能解析出参考文献，请检查粘贴的内容格式。"}
        raw_count = len(csl_items)
        csl_items = _normalize_and_dedup(csl_items)
        formatted = render_bibliography(csl_items, style_name)
        warnings = _detect_non_academic(csl_items)
        result = {"ok": True, "style": style_name, "formatted": formatted}
        if warnings:
            result["warnings"] = warnings
        if len(csl_items) < raw_count:
            result["note"] = f"已自动去除 {raw_count - len(csl_items)} 条重复参考文献。"
        return result
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"格式化失败：{e}"}
