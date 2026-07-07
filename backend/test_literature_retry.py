"""逐源重试: source_failure_event 告警载荷 + retry_failed_sources + /api/literature/retry。

覆盖"文献源连接失败时，用户针对失败的那个库单独重试"这条链路:
- source_failure_event 构造出带 retry 上下文的 warning data(空失败清单→None);
- retry_failed_sources 只把 sources 限定到失败源(绕过部分失败缓存)后重跑, 返回 references;
- 端点回传 {ok, references, failed_sources}。
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

from app import literature
from app.research import retry_failed_sources


def _run(coro):
    return asyncio.run(coro)


# ---- source_failure_event ------------------------------------------------
def test_source_failure_event_none_when_no_failure() -> None:
    assert literature.source_failure_event([], queries=["q"]) is None
    assert literature.source_failure_event(None, queries=["q"]) is None


def test_source_failure_event_carries_retry_context() -> None:
    evt = literature.source_failure_event(
        ["pubmed", "openalex"],
        queries=["q1", "q2"], filters={"year_from": 2020},
        per_query=8, cap=16, field="糖尿病",
    )
    assert evt is not None
    assert evt["kind"] == "source_failure"
    assert evt["failed_sources"] == ["pubmed", "openalex"]
    assert "PubMed" in evt["message"] and "OpenAlex" in evt["message"]
    retry = evt["retry"]
    assert retry["queries"] == ["q1", "q2"]
    assert retry["filters"] == {"year_from": 2020}
    assert retry["per_query"] == 8 and retry["cap"] == 16
    assert retry["field"] == "糖尿病"


def test_source_failure_event_drops_non_paper_sources() -> None:
    # ClinicalTrials 走旁路, 不参与逐源重试, 应从 failed_sources 剔除。
    evt = literature.source_failure_event(
        ["pubmed", "clinicaltrials"], queries=["q"],
    )
    assert evt is not None
    assert evt["failed_sources"] == ["pubmed"]


# ---- retry_failed_sources ------------------------------------------------
def test_retry_limits_search_to_failed_sources() -> None:
    seen = {}

    async def fake_search(queries, per_query=6, cap=18, sources=None, filters=None):
        seen["sources"] = sources
        seen["queries"] = queries
        return {
            "papers": [{"pmid": "1", "title": "T", "url": "u", "source": "openalex"}],
            "failed_sources": [],
        }

    with patch("app.research.search_literature", new=fake_search):
        out = _run(retry_failed_sources(["q1"], ["openalex"], per_query=8, cap=16))
    # 只对失败源检索(源集合变了→绕过部分失败缓存)。
    assert seen["sources"] == ["openalex"]
    assert seen["queries"] == ["q1"]
    assert len(out["references"]) == 1
    assert out["references"][0]["pmid"] == "1"
    assert out["failed_sources"] == []


def test_retry_reports_still_failing_sources() -> None:
    async def fake_search(queries, per_query=6, cap=18, sources=None, filters=None):
        return {"papers": [], "failed_sources": ["pubmed"]}

    with patch("app.research.search_literature", new=fake_search):
        out = _run(retry_failed_sources(["q"], ["pubmed"]))
    assert out["references"] == []
    assert out["failed_sources"] == ["pubmed"]


def test_retry_noop_on_empty_or_non_paper_sources() -> None:
    async def fake_search(*a, **k):  # 不应被调用
        raise AssertionError("search_literature should not run for empty valid sources")

    with patch("app.research.search_literature", new=fake_search):
        assert _run(retry_failed_sources([], ["pubmed"])) == {"references": [], "failed_sources": []}
        assert _run(retry_failed_sources(["q"], ["clinicaltrials"])) == {"references": [], "failed_sources": []}


# ---- endpoint ------------------------------------------------------------
from fastapi.testclient import TestClient


def test_retry_endpoint_returns_references() -> None:
    async def fake_retry(queries, sources, per_query=8, cap=18, filters=None):
        return {"references": [{"pmid": "9", "title": "X"}], "failed_sources": []}

    with patch("app.routes.text_gen.retry_failed_sources", new=fake_retry):
        from app.main import app
        c = TestClient(app)
        r = c.post("/api/literature/retry", json={"queries": ["q"], "sources": ["pubmed"]})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["references"][0]["pmid"] == "9"
    assert body["failed_sources"] == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK  {name}")
