"""引用文献的导入导出(EndNote/Zotero 双向)。

支持三种通用格式:
  - RIS (.ris)  - 用 rispy 解析
  - BibTeX (.bib) - 用 bibtexparser 解析
  - EndNote 文本 (.enw) - 自行实现 (格式简单, 行起始字段标签)

对外统一引用结构(贴近 IdeaModule 现有 Reference 类型):
  {
    "title":   str,
    "authors": list[str],
    "journal": str,
    "year":    str | None,
    "volume":  str | None,
    "issue":   str | None,
    "pages":   str | None,
    "doi":     str | None,
    "url":     str | None,
    "abstract": str | None,
  }

接口:
  parse(data: bytes, format: str) -> list[dict]
  serialize(refs: list[dict], format: str) -> bytes
"""
from __future__ import annotations

import io
import re
from typing import Any

import bibtexparser
import rispy

from .textio import decode_text


# ---------- 内部统一结构 ----------

_FIELDS = ("title", "authors", "journal", "year", "volume", "issue",
           "pages", "doi", "url", "abstract")


def _empty_ref() -> dict:
    return {
        "title": "",
        "authors": [],
        "journal": "",
        "year": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doi": None,
        "url": None,
        "abstract": None,
    }


def _clean_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _clean_or_none(v: Any) -> str | None:
    s = _clean_str(v)
    return s or None


# ---------- RIS ----------

def _ris_to_ref(item: dict) -> dict:
    ref = _empty_ref()
    ref["title"] = _clean_str(item.get("title") or item.get("primary_title")
                              or item.get("translated_title"))
    authors = item.get("authors") or item.get("first_authors") or []
    if isinstance(authors, str):
        authors = [authors]
    ref["authors"] = [_clean_str(a) for a in authors if _clean_str(a)]
    ref["journal"] = _clean_str(item.get("journal_name") or item.get("secondary_title")
                                or item.get("alternate_title1"))
    ref["year"] = _clean_or_none(item.get("year") or item.get("publication_year"))
    ref["volume"] = _clean_or_none(item.get("volume"))
    ref["issue"] = _clean_or_none(item.get("number") or item.get("issue"))
    sp = _clean_str(item.get("start_page"))
    ep = _clean_str(item.get("end_page"))
    pages = item.get("pages")
    if sp and ep:
        ref["pages"] = f"{sp}-{ep}"
    elif sp:
        ref["pages"] = sp
    elif pages:
        ref["pages"] = _clean_str(pages)
    ref["doi"] = _clean_or_none(item.get("doi"))
    urls = item.get("urls") or item.get("url")
    if isinstance(urls, list):
        ref["url"] = _clean_or_none(urls[0]) if urls else None
    else:
        ref["url"] = _clean_or_none(urls)
    ref["abstract"] = _clean_or_none(item.get("abstract") or item.get("notes_abstract"))
    return ref


def _ref_to_ris(ref: dict) -> dict:
    item: dict = {"type_of_reference": "JOUR"}
    if ref.get("title"):
        item["title"] = ref["title"]
    if ref.get("authors"):
        item["authors"] = list(ref["authors"])
    if ref.get("journal"):
        item["journal_name"] = ref["journal"]
    if ref.get("year"):
        item["year"] = str(ref["year"])
    if ref.get("volume"):
        item["volume"] = str(ref["volume"])
    if ref.get("issue"):
        item["number"] = str(ref["issue"])
    pages = ref.get("pages")
    if pages:
        s = str(pages)
        if "-" in s:
            sp, _, ep = s.partition("-")
            item["start_page"] = sp.strip()
            item["end_page"] = ep.strip()
        else:
            item["start_page"] = s.strip()
    if ref.get("doi"):
        item["doi"] = str(ref["doi"])
    if ref.get("url"):
        item["urls"] = [str(ref["url"])]
    if ref.get("abstract"):
        item["abstract"] = str(ref["abstract"])
    return item


# ---------- BibTeX ----------

def _bib_to_ref(entry: dict) -> dict:
    ref = _empty_ref()
    ref["title"] = _clean_str(entry.get("title"))
    raw_author = _clean_str(entry.get("author"))
    if raw_author:
        # BibTeX 用 ' and ' 分隔作者
        parts = re.split(r"\s+and\s+", raw_author)
        ref["authors"] = [p.strip() for p in parts if p.strip()]
    ref["journal"] = _clean_str(entry.get("journal") or entry.get("booktitle"))
    ref["year"] = _clean_or_none(entry.get("year"))
    ref["volume"] = _clean_or_none(entry.get("volume"))
    ref["issue"] = _clean_or_none(entry.get("number") or entry.get("issue"))
    ref["pages"] = _clean_or_none(entry.get("pages"))
    ref["doi"] = _clean_or_none(entry.get("doi"))
    ref["url"] = _clean_or_none(entry.get("url"))
    ref["abstract"] = _clean_or_none(entry.get("abstract"))
    return ref


def _ref_to_bib(ref: dict, idx: int) -> dict:
    # 生成稳定的 entry id
    first = ""
    if ref.get("authors"):
        first = str(ref["authors"][0]).split(",")[0].strip().lower()
        first = re.sub(r"[^a-z0-9]+", "", first) or "ref"
    year = str(ref.get("year") or "")
    entry_id = f"{first or 'ref'}{year or idx}"

    entry: dict = {"ENTRYTYPE": "article", "ID": entry_id}
    if ref.get("title"):
        entry["title"] = str(ref["title"])
    if ref.get("authors"):
        entry["author"] = " and ".join(str(a) for a in ref["authors"])
    if ref.get("journal"):
        entry["journal"] = str(ref["journal"])
    if ref.get("year"):
        entry["year"] = str(ref["year"])
    if ref.get("volume"):
        entry["volume"] = str(ref["volume"])
    if ref.get("issue"):
        entry["number"] = str(ref["issue"])
    if ref.get("pages"):
        entry["pages"] = str(ref["pages"])
    if ref.get("doi"):
        entry["doi"] = str(ref["doi"])
    if ref.get("url"):
        entry["url"] = str(ref["url"])
    if ref.get("abstract"):
        entry["abstract"] = str(ref["abstract"])
    return entry


# ---------- EndNote (.enw) ----------
# 字段映射(常见 tag):
#   %A 作者(可多次)  %T 标题  %J 期刊  %D 年  %V 卷  %N 期
#   %P 页  %R DOI    %U URL  %X 摘要  %0 类型
#
# 多条记录之间用空行分隔。

_ENW_FIELD_TO_KEY = {
    "%T": "title",
    "%J": "journal",
    "%B": "journal",
    "%D": "year",
    "%V": "volume",
    "%N": "issue",
    "%P": "pages",
    "%R": "doi",
    "%U": "url",
    "%X": "abstract",
}


def _enw_parse_one(block: str) -> dict | None:
    ref = _empty_ref()
    found = False
    for raw in block.splitlines():
        line = raw.rstrip()
        if len(line) < 3 or not line.startswith("%"):
            continue
        tag = line[:2]
        value = line[2:].strip()
        if not value:
            continue
        found = True
        if tag == "%A":
            ref["authors"].append(value)
        elif tag in _ENW_FIELD_TO_KEY:
            key = _ENW_FIELD_TO_KEY[tag]
            if key in ("year", "volume", "issue", "pages", "doi", "url", "abstract"):
                ref[key] = value
            else:
                ref[key] = value
    return ref if found else None


def _ref_to_enw(ref: dict) -> str:
    lines = ["%0 Journal Article"]
    for a in (ref.get("authors") or []):
        lines.append(f"%A {a}")
    if ref.get("title"):
        lines.append(f"%T {ref['title']}")
    if ref.get("journal"):
        lines.append(f"%J {ref['journal']}")
    if ref.get("year"):
        lines.append(f"%D {ref['year']}")
    if ref.get("volume"):
        lines.append(f"%V {ref['volume']}")
    if ref.get("issue"):
        lines.append(f"%N {ref['issue']}")
    if ref.get("pages"):
        lines.append(f"%P {ref['pages']}")
    if ref.get("doi"):
        lines.append(f"%R {ref['doi']}")
    if ref.get("url"):
        lines.append(f"%U {ref['url']}")
    if ref.get("abstract"):
        lines.append(f"%X {ref['abstract']}")
    return "\n".join(lines)


# ---------- 公开 API ----------

def parse(data: bytes, format: str) -> list[dict]:
    """解析引用字节流。

    format ∈ {'ris', 'bib', 'enw'}
    返回统一的 Reference 字典列表。
    """
    fmt = (format or "").lower().strip()
    text = decode_text(data)
    if fmt == "ris":
        try:
            items = rispy.loads(text)
        except Exception:  # noqa: BLE001
            items = []
        return [_ris_to_ref(it) for it in items]
    if fmt == "bib":
        try:
            bib = bibtexparser.loads(text)
            entries = bib.entries
        except Exception:  # noqa: BLE001
            entries = []
        return [_bib_to_ref(e) for e in entries]
    if fmt == "enw":
        # EndNote 块用空行分隔; 兼容 \r\n
        blocks = re.split(r"\r?\n\s*\r?\n", text.strip())
        refs: list[dict] = []
        for b in blocks:
            r = _enw_parse_one(b)
            if r is not None:
                refs.append(r)
        return refs
    raise ValueError(f"不支持的格式: {format}")


def serialize(refs: list[dict], format: str) -> bytes:
    """把统一 Reference 列表序列化为指定格式的字节流。"""
    fmt = (format or "").lower().strip()
    if fmt == "ris":
        ris_items = [_ref_to_ris(r) for r in (refs or [])]
        s = rispy.dumps(ris_items)
        return s.encode("utf-8")
    if fmt == "bib":
        from bibtexparser.bibdatabase import BibDatabase

        db = BibDatabase()
        db.entries = [_ref_to_bib(r, i + 1) for i, r in enumerate(refs or [])]
        s = bibtexparser.dumps(db)
        return s.encode("utf-8")
    if fmt == "enw":
        blocks = [_ref_to_enw(r) for r in (refs or [])]
        s = "\n\n".join(blocks) + "\n"
        return s.encode("utf-8")
    raise ValueError(f"不支持的格式: {format}")
