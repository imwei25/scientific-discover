"""静态托管缓存策略: 入口 index.html 禁缓存, hash 资源可缓存。

目的: 防止"更新/pull 后浏览器仍显示旧界面"(入口 HTML 被缓存)。
仅当 frontend/dist 已构建时才有意义; 未构建则跳过。

用法: python -m pytest test_static_cache.py
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.main import app, _DIST


pytestmark = pytest.mark.skipif(not _DIST.is_dir(), reason="frontend/dist 未构建")


def test_index_html_no_cache() -> None:
    c = TestClient(app)
    r = c.get("/")
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("text/html")
    cc = r.headers.get("cache-control", "")
    assert "no-cache" in cc and "no-store" in cc


def test_hashed_asset_is_cacheable() -> None:
    c = TestClient(app)
    html = c.get("/").text
    m = re.search(r'assets/(index-[^"]+\.js)', html)
    if not m:  # 构建产物命名变化时不强求
        return
    a = c.get("/assets/" + m.group(1))
    assert a.status_code == 200
    # hash 资源不应被强制 no-store(才能长缓存)
    assert "no-store" not in (a.headers.get("cache-control") or "")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
