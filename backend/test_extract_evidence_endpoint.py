"""extract_evidence_for_refs: batching, missing-abstract fetch, error tolerance."""
import asyncio
from unittest.mock import patch, AsyncMock

from app.research import extract_evidence_for_refs


def _run(coro):
    return asyncio.run(coro)


def _ref(i: int, has_abs: bool = True, doi: str | None = None, pmid: str | None = None) -> dict:
    return {
        "pmid": pmid or f"P{i}",
        "doi": doi or f"10.1/x{i}",
        "title": f"Title {i}",
        "first_author": f"A{i}",
        "journal": "J",
        "year": "2024",
        "url": f"https://example.com/{i}",
        "abstract": f"Abstract text {i}" if has_abs else "",
    }


def test_batches_of_eight() -> None:
    refs = [_ref(i) for i in range(20)]  # 20 refs -> ceil(20/8) = 3 batches
    calls: list[int] = []

    async def fake_batch(field, items):
        calls.append(len(items))
        return {gi: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 2} for gi, _ in items}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="dm", fetch_missing=False))
    assert len(got) == 20
    assert calls == [8, 8, 4]


def test_missing_abstract_triggers_fetch_then_extracts() -> None:
    refs = [_ref(0, has_abs=False, doi="10.1/found", pmid="P0")]

    async def fake_fetch(doi, pmid):
        assert doi == "10.1/found" and pmid == "P0"
        return "fetched abstract"

    async def fake_batch(field, items):
        # after fetch, abstract must be present
        _, p = items[0]
        assert p.get("abstract") == "fetched abstract"
        return {items[0][0]: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 3}}

    with patch("app.research.fetch_abstract_by_id", new=fake_fetch), \
         patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=True))
    assert len(got) == 1
    assert got[0]["_ev_status"] == "ok"
    assert got[0]["finding"] == "f"


def test_missing_abstract_no_fetch_marks_no_abstract() -> None:
    refs = [_ref(0, has_abs=False, doi=None, pmid=None)]

    async def fake_batch(field, items):
        raise AssertionError("must not call LLM for empty abstracts")

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=True))
    assert got[0]["_ev_status"] == "no_abstract"
    assert got[0]["finding"] == ""


def test_batch_error_marks_extract_error_but_other_batch_ok() -> None:
    refs = [_ref(i) for i in range(9)]  # 2 batches: 8 + 1
    call_count = {"n": 0}

    async def fake_batch(field, items):
        call_count["n"] += 1
        if len(items) == 1:
            raise RuntimeError("LLM down")
        return {gi: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 2} for gi, _ in items}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=False))
    ok = [e for e in got if e["_ev_status"] == "ok"]
    err = [e for e in got if e["_ev_status"] == "extract_error"]
    assert len(ok) == 8 and len(err) == 1


def test_result_carries_key() -> None:
    refs = [_ref(0, doi="10.1/abc", pmid="42")]

    async def fake_batch(field, items):
        return {items[0][0]: {"pop": "p", "design": "d", "finding": "f", "gap": "g", "rel": 1}}

    with patch("app.research._extract_batch", new=fake_batch):
        got = _run(extract_evidence_for_refs(refs, field="", fetch_missing=False))
    assert got[0]["key"] == "pmid:42"  # key precedence pmid > doi > url


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK  {name}")
