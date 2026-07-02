import asyncio
from unittest.mock import patch
from app.research import deep_research_idea, _ref_to_paper


def _collect(inputs):
    async def run():
        return [ev async for ev in deep_research_idea(inputs)]
    # asyncio.run 每次新建并关闭事件循环, 避免全量跑测时前序用例关闭 loop 后
    # get_event_loop() 报 "no current event loop"。
    return asyncio.run(run())


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


def test_import_then_search_merges_and_dedups():
    searched_paper = {"pmid": "111", "doi": "", "title": "Searched", "first_author": "S",
                      "journal": "J", "year": "2019", "url": "https://pubmed.ncbi.nlm.nih.gov/111/",
                      "abstract": "s-abstract", "source": "pubmed"}
    imported = [
        {"title": "MyRef", "first_author": "M", "year": "2021", "journal": "J2",
         "url": "https://doi.org/10.9/y", "doi": "10.9/y", "abstract": "m-abstract"},
        # duplicate of the searched paper (same url) -> must dedup
        {"title": "Searched dup", "first_author": "S", "year": "2019", "journal": "J",
         "url": "https://pubmed.ncbi.nlm.nih.gov/111/"},
    ]

    async def fake_stream(messages, task="research", **kw):
        yield "综述"

    async def fake_search(*a, **kw):
        return {"papers": [searched_paper], "network_errors": 0, "queries_tried": [],
                "quality": {}, }

    with patch("app.research.stream_chat", fake_stream), \
         patch("app.research.search_literature", side_effect=fake_search) as searched, \
         patch("app.research._gen_queries", return_value=["q"]), \
         patch("app.research._emit_trials", return_value=None), \
         patch("app.research.settings") as st:
        st.mock = False
        evs = _collect({"field": "肺癌", "depth": "fast",
                        "source_mode": "import_then_search", "references": imported})

    assert searched.called  # search happened
    ref_events = [d for (e, d) in evs if e == "references"]
    last = ref_events[-1]["items"]
    titles = {i["title"] for i in last}
    assert "Searched" in titles and "MyRef" in titles
    assert len(last) == 2  # dup collapsed, not 3
