"""引用导入导出 round-trip 测试: ris / bib / enw 各一条样本。"""
from __future__ import annotations

from app.refio import parse, serialize


_SAMPLE_RIS = b"""TY  - JOUR
AU  - Smith, John
AU  - Doe, Jane
TI  - A study of stuff
JO  - Journal of Things
PY  - 2020
VL  - 10
IS  - 2
SP  - 100
EP  - 110
DO  - 10.1234/test
UR  - https://example.org/paper
AB  - This is an abstract.
ER  -
"""


_SAMPLE_BIB = b"""@article{smith2020,
  author = {Smith, John and Doe, Jane},
  title = {A study of stuff},
  journal = {Journal of Things},
  year = {2020},
  volume = {10},
  number = {2},
  pages = {100--110},
  doi = {10.1234/test},
  url = {https://example.org/paper},
  abstract = {This is an abstract.}
}
"""


_SAMPLE_ENW = b"""%0 Journal Article
%A Smith, John
%A Doe, Jane
%T A study of stuff
%J Journal of Things
%D 2020
%V 10
%N 2
%P 100-110
%R 10.1234/test
%U https://example.org/paper
%X This is an abstract.
"""


def _check_fields(ref: dict):
    assert ref["title"] == "A study of stuff"
    assert ref["authors"] == ["Smith, John", "Doe, Jane"]
    assert ref["journal"] == "Journal of Things"
    assert str(ref["year"]) == "2020"
    assert str(ref["volume"]) == "10"
    assert str(ref["issue"]) == "2"
    assert ref["doi"] == "10.1234/test"
    assert ref["url"] == "https://example.org/paper"
    assert "abstract" in ref["abstract"].lower() or "abstract" in ref["abstract"]
    pages = str(ref["pages"]).replace("--", "-")
    assert pages.startswith("100")


# ---------- 解析 ----------

def test_parse_ris():
    refs = parse(_SAMPLE_RIS, "ris")
    assert len(refs) == 1
    _check_fields(refs[0])


def test_parse_bib():
    refs = parse(_SAMPLE_BIB, "bib")
    assert len(refs) == 1
    _check_fields(refs[0])


def test_parse_enw():
    refs = parse(_SAMPLE_ENW, "enw")
    assert len(refs) == 1
    _check_fields(refs[0])


# ---------- Round-trip: 解析 -> 序列化 -> 再解析, 关键字段保留 ----------

def test_roundtrip_ris():
    refs = parse(_SAMPLE_RIS, "ris")
    out = serialize(refs, "ris")
    again = parse(out, "ris")
    assert len(again) == 1
    _check_fields(again[0])


def test_roundtrip_bib():
    refs = parse(_SAMPLE_BIB, "bib")
    out = serialize(refs, "bib")
    assert b"@article" in out.lower() or b"@Article" in out
    again = parse(out, "bib")
    assert len(again) == 1
    _check_fields(again[0])


def test_roundtrip_enw():
    refs = parse(_SAMPLE_ENW, "enw")
    out = serialize(refs, "enw")
    again = parse(out, "enw")
    assert len(again) == 1
    _check_fields(again[0])


# ---------- 跨格式互转 ----------

def test_cross_format_ris_to_bib_to_enw():
    refs = parse(_SAMPLE_RIS, "ris")
    bib_bytes = serialize(refs, "bib")
    refs2 = parse(bib_bytes, "bib")
    enw_bytes = serialize(refs2, "enw")
    refs3 = parse(enw_bytes, "enw")
    assert len(refs3) == 1
    _check_fields(refs3[0])


# ---------- 多条记录 ----------

def test_parse_multi_ris():
    multi = _SAMPLE_RIS + b"\n" + _SAMPLE_RIS.replace(b"A study of stuff", b"Another study")
    refs = parse(multi, "ris")
    assert len(refs) == 2
    titles = {r["title"] for r in refs}
    assert "A study of stuff" in titles
    assert "Another study" in titles


def test_parse_multi_enw():
    multi = _SAMPLE_ENW + b"\n\n" + _SAMPLE_ENW.replace(b"A study of stuff", b"Another study")
    refs = parse(multi, "enw")
    assert len(refs) == 2


# ---------- 边界: 空字节 / 异常格式 ----------

def test_parse_empty_bytes():
    assert parse(b"", "ris") == []
    assert parse(b"", "bib") == []
    assert parse(b"", "enw") == []


def test_invalid_format_raises():
    import pytest
    with pytest.raises(ValueError):
        parse(b"x", "doc")
    with pytest.raises(ValueError):
        serialize([], "doc")


# ---------- 序列化空列表 ----------

def test_serialize_empty():
    assert serialize([], "ris") == b"" or serialize([], "ris").strip() == b""
    out_bib = serialize([], "bib")
    # bibtexparser 输出可能是空
    assert isinstance(out_bib, bytes)
    out_enw = serialize([], "enw")
    assert isinstance(out_enw, bytes)
