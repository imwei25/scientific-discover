import asyncio
import pytest
from pathlib import Path
from unittest.mock import AsyncMock


@pytest.mark.asyncio
async def test_fetch_deep_read_from_upload(tmp_path, monkeypatch):
    from app import deep_research as dr
    monkeypatch.setattr(dr, "_upload_cache_dir", lambda pid: tmp_path)
    up_id = "abc123"
    (tmp_path / f"{up_id}.txt").write_text("Results\nWe found X.", encoding="utf-8")
    target = {"ref_key": "k0", "source": "upload", "upload_id": up_id}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is True
    assert "We found X" in got["chunk"]


@pytest.mark.asyncio
async def test_fetch_deep_read_from_oa_url(monkeypatch):
    from app import deep_research as dr
    async def fake_fetch(url):
        return b"Introduction\n...\nResults\nWe observed Y."
    monkeypatch.setattr(dr, "_fetch_pdf_bytes", fake_fetch)
    monkeypatch.setattr(
        "app.extract.extract_text",
        lambda name, content: {"text": content.decode(), "pages": 1},
    )
    target = {"ref_key": "k1", "source": "oa", "oa_url": "https://example.com/x.pdf"}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is True
    assert "observed Y" in got["chunk"]


@pytest.mark.asyncio
async def test_fetch_deep_read_timeout_degrades(monkeypatch):
    from app import deep_research as dr
    async def slow_fetch(url):
        await asyncio.sleep(30)
        return b""
    monkeypatch.setattr(dr, "_fetch_pdf_bytes", slow_fetch)
    monkeypatch.setattr(dr, "DEEP_READ_PER_PAPER_TIMEOUT_SEC", 0.1)
    target = {"ref_key": "k2", "source": "oa", "oa_url": "https://slow.example/x.pdf"}
    got = await dr.fetch_one_deep_read(target, project_id="p1")
    assert got["ok"] is False
    assert "超时" in got["error"]


@pytest.mark.asyncio
async def test_fetch_all_respects_concurrency(monkeypatch):
    from app import deep_research as dr
    active = 0
    peak = 0
    lock = asyncio.Lock()
    async def track(target, project_id):
        nonlocal active, peak
        async with lock:
            active += 1
            peak = max(peak, active)
        await asyncio.sleep(0.05)
        async with lock:
            active -= 1
        return {"ok": True, "ref_key": target["ref_key"], "chunk": "x"}
    monkeypatch.setattr(dr, "fetch_one_deep_read", track)
    monkeypatch.setattr(dr, "DEEP_READ_CONCURRENCY", 3)
    targets = [{"ref_key": f"k{i}", "source": "upload", "upload_id": f"u{i}"} for i in range(10)]
    results = []
    async for evt, data in dr.fetch_deep_reads_stream(targets, project_id="p1"):
        if evt == "deep_read_result":
            results.append(data)
    assert len(results) == 10
    assert peak <= 3
