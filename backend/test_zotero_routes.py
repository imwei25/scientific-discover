from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_status_offline_is_ok_false_running():
    with patch("app.zotero.probe", AsyncMock(return_value={"running": False, "api": False, "connector": False})):
        r = client.get("/api/zotero/status")
    assert r.status_code == 200
    assert r.json()["running"] is False


def test_import_returns_refs():
    fake = [{"title": "T", "first_author": "A", "url": "u"}]
    with patch("app.zotero.import_collection", AsyncMock(return_value=fake)):
        r = client.post("/api/zotero/import", json={"collection_key": "ABCD"})
    assert r.json()["ok"] is True
    assert r.json()["refs"][0]["title"] == "T"


def test_push_reports_saved_count():
    with patch("app.zotero.push", AsyncMock(return_value=2)):
        r = client.post("/api/zotero/push", json={"refs": [{"title": "a"}, {"title": "b"}]})
    assert r.json() == {"ok": True, "saved": 2}


def test_import_offline_graceful_error():
    with patch("app.zotero.import_collection", AsyncMock(side_effect=Exception("conn refused"))):
        r = client.post("/api/zotero/import", json={"collection_key": "X"})
    assert r.json()["ok"] is False
    assert "Zotero" in r.json()["error"]
