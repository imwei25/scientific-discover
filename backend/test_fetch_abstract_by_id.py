"""fetch_abstract_by_id: PubMed -> EPMC -> OpenAlex fallback (offline, mocked)."""
import asyncio
from unittest.mock import patch, AsyncMock

from app.literature import fetch_abstract_by_id


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_pubmed_hit_short_circuits() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value="PM abstract")) as pm, \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")) as ep, \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")) as oa:
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "PM abstract"
        assert pm.await_count == 1
        assert ep.await_count == 0
        assert oa.await_count == 0


def test_falls_back_to_epmc_when_pubmed_misses() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")) as oa:
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "EPMC abstract"
        assert oa.await_count == 0


def test_falls_back_to_openalex_when_others_miss() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value="OA abstract")):
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got == "OA abstract"


def test_all_miss_returns_none() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value=None)), \
         patch("app.literature._fetch_abstract_openalex", new=AsyncMock(return_value=None)):
        got = _run(fetch_abstract_by_id(doi="10.1/x", pmid="12345"))
        assert got is None


def test_client_raises_are_swallowed_and_fallthrough() -> None:
    with patch("app.literature._fetch_abstract_pubmed", new=AsyncMock(side_effect=RuntimeError("boom"))), \
         patch("app.literature._fetch_abstract_epmc", new=AsyncMock(return_value="EPMC abstract")):
        got = _run(fetch_abstract_by_id(doi=None, pmid="12345"))
        assert got == "EPMC abstract"


def test_no_ids_returns_none() -> None:
    got = _run(fetch_abstract_by_id(doi=None, pmid=None))
    assert got is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK  {name}")
