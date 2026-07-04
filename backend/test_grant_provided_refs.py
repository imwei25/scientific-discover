"""write_grant: when inputs.provided_refs is set, skip pre-writing re-search."""
import asyncio
from unittest.mock import patch


def _run_gen(gen):
    async def collect():
        events = []
        async for ev in gen:
            events.append(ev)
        return events
    return asyncio.run(collect())


def test_provided_refs_skips_search():
    from app.grant import write_grant

    provided = [{"pmid": "P1", "title": "provided one", "first_author": "A",
                 "year": "2024", "journal": "J", "url": "https://x/1", "abstract": "ab"}]
    called = {"n": 0}

    async def spy_search(*args, **kwargs):
        called["n"] += 1
        return {"papers": []}

    async def noop_stream(*args, **kwargs):
        if False:
            yield ""
        return

    async def noop_gen_queries(*a, **kw):
        return ["q"]

    async def noop_run_review(*a, **kw):
        if False:
            yield ("delta", {"text": ""})
        return

    with patch("app.grant.settings", type("S", (), {"mock": False})()), \
         patch("app.grant.search_literature", new=spy_search), \
         patch("app.grant._gen_queries", new=noop_gen_queries), \
         patch("app.grant.stream_chat", side_effect=lambda *a, **k: noop_stream()), \
         patch("app.grant._run_review", side_effect=lambda *a, **k: noop_run_review()), \
         patch("app.grant._verify_citations", return_value={"total": 0, "verified": 0}):
        inputs = {
            "title": "T", "idea": "i", "report": "r", "background": "",
            "grant_type": "nsfc-general",
            "references": provided,
            "provided_refs": provided,
            "research": True,
            "scheme": {"title": "T"},
            "sections": [{"key": "背景", "title": "背景", "budget": 200}],
        }
        _run_gen(write_grant(inputs))

    assert called["n"] == 0, "search_literature must NOT be called when provided_refs is set"


def test_no_provided_refs_uses_research_flag():
    """When provided_refs absent and research=True, search_literature IS called."""
    from app.grant import write_grant
    called = {"n": 0}

    async def spy_search(*args, **kwargs):
        called["n"] += 1
        return {"papers": []}

    async def noop_stream(*args, **kwargs):
        if False:
            yield ""
        return

    async def noop_gen_queries(*a, **kw):
        return ["q"]

    async def noop_run_review(*a, **kw):
        if False:
            yield ("delta", {"text": ""})
        return

    with patch("app.grant.settings", type("S", (), {"mock": False})()), \
         patch("app.grant.search_literature", new=spy_search), \
         patch("app.grant._gen_queries", new=noop_gen_queries), \
         patch("app.grant.stream_chat", side_effect=lambda *a, **k: noop_stream()), \
         patch("app.grant._run_review", side_effect=lambda *a, **k: noop_run_review()), \
         patch("app.grant._verify_citations", return_value={"total": 0, "verified": 0}):
        inputs = {
            "title": "T", "idea": "i", "report": "r", "background": "",
            "grant_type": "nsfc-general",
            "research": True,
            "scheme": {"title": "T"},
            "sections": [{"key": "背景", "title": "背景", "budget": 200}],
        }
        _run_gen(write_grant(inputs))
    assert called["n"] >= 1


if __name__ == "__main__":
    test_provided_refs_skips_search()
    print("OK  test_provided_refs_skips_search")
    test_no_provided_refs_uses_research_flag()
    print("OK  test_no_provided_refs_uses_research_flag")
