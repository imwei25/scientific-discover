import asyncio
from unittest.mock import patch
from app.research import deep_research_idea, _ref_to_paper


def _collect(inputs):
    async def run():
        return [ev async for ev in deep_research_idea(inputs)]
    return asyncio.get_event_loop().run_until_complete(run())


def test_ref_to_paper_fills_hard_keys():
    p = _ref_to_paper({"title": "T", "authors": ["Zhang W"], "doi": "10.1/x"})
    for k in ("abstract", "first_author", "year", "title", "journal", "url"):
        assert k in p
    assert p["first_author"] == "Zhang W"
    assert p["url"] == "https://doi.org/10.1/x"


def test_import_only_skips_search_and_synthesizes():
    refs = [{"title": "T1", "first_author": "A", "year": "2020",
             "journal": "J", "url": "https://pubmed.ncbi.nlm.nih.gov/1/", "abstract": "finding X"}]

    async def fake_stream(messages, task="research", **kw):
        yield "综述正文"

    with patch("app.research.stream_chat", fake_stream), \
         patch("app.research.search_literature") as searched, \
         patch("app.research.settings") as st:
        st.mock = False
        evs = _collect({"field": "肺癌", "source_mode": "import_only", "references": refs})

    searched.assert_not_called()
    kinds = [e[0] for e in evs]
    assert "references" in kinds and "delta" in kinds and "done" in kinds


def test_import_only_empty_refs_errors():
    with patch("app.research.settings") as st:
        st.mock = False
        evs = _collect({"field": "肺癌", "source_mode": "import_only", "references": []})
    assert evs[0][0] == "error"
