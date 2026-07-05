"""深度调研 lookup_title 端点测试 (TDD)."""
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_lookup_title_hits_crossref(monkeypatch):
    from app import deep_research as dr

    async def fake_search(title):
        return {
            "found": True,
            "abstract": "We studied X.",
            "first_author": "Chen J",
            "year": "2023",
            "url": "https://doi.org/10.1/abc",
            "doi": "10.1/abc",
        }

    monkeypatch.setattr(dr, "_search_title_multi", AsyncMock(side_effect=fake_search))
    resp = client.post("/api/deep_research/lookup_title", json={"title": "A study of foo"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["found"] is True
    assert data["abstract"] == "We studied X."


def test_lookup_title_not_found(monkeypatch):
    from app import deep_research as dr

    async def fake_search(title):
        return {"found": False}

    monkeypatch.setattr(dr, "_search_title_multi", AsyncMock(side_effect=fake_search))
    resp = client.post("/api/deep_research/lookup_title", json={"title": "nonexistent paper xyz"})
    assert resp.status_code == 200
    assert resp.json()["found"] is False
