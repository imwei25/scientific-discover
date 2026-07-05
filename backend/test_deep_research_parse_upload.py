"""深度调研 parse_upload 端点测试 (TDD)."""
import io

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _fake_pdf_bytes() -> bytes:
    """最小可解析的 PDF: 首行为 'A Study of Foo Bar'."""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 750, "A Study of Foo Bar")
    c.drawString(100, 730, "John Smith, 2024")
    c.drawString(100, 700, "This paper investigates the effect of X on Y.")
    c.showPage()
    c.save()
    return buf.getvalue()


def test_parse_upload_pdf_returns_title_and_upload_id(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.deep_research._upload_cache_dir", lambda pid: tmp_path
    )
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("study.pdf", _fake_pdf_bytes(), "application/pdf")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["title"]
    assert data["upload_id"]
    assert data["full_text_available"] is True
    assert (tmp_path / f"{data['upload_id']}.txt").exists()


def test_parse_upload_rejects_over_limit(monkeypatch):
    from app import http_common
    from app.routes import deep_research_routes as dr_routes

    monkeypatch.setattr(http_common, "MAX_UPLOAD_BYTES", 100)
    # 路由模块导入时已把常量绑到局部符号, 也一并覆盖以生效
    monkeypatch.setattr(dr_routes, "MAX_UPLOAD_BYTES", 100)
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("big.pdf", b"x" * 1024, "application/pdf")},
    )
    assert resp.status_code == 413


def test_parse_upload_low_confidence_when_no_title(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.deep_research._upload_cache_dir", lambda pid: tmp_path
    )
    resp = client.post(
        "/api/deep_research/parse_upload",
        files={"file": ("blob.txt", b"@#$%^&\n***random noise***", "text/plain")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["parse_confidence"] == "low"
