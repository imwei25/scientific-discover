"""上传大小上限回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_upload_limit.py
验证:
  - _read_capped 分块读取, 超限返回 None、未超限完整返回;
  - /api/extract 端点对超限文件返回友好错误(而非 500/OOM), 正常文件仍可用。
"""
import asyncio
import sys

import app.main as main
from app.main import _read_capped


class FakeUpload:
    def __init__(self, data: bytes, chunk: int = 1024 * 1024):
        self.data, self.pos, self.chunk = data, 0, chunk

    async def read(self, n: int = -1) -> bytes:
        if self.pos >= len(self.data):
            return b""
        size = self.chunk if n in (-1, None) else n
        out = self.data[self.pos : self.pos + size]
        self.pos += size
        return out


async def _unit() -> None:
    assert await _read_capped(FakeUpload(b"x" * 5000), limit=10000) == b"x" * 5000
    assert await _read_capped(FakeUpload(b"y" * 50000), limit=10000) is None
    assert await _read_capped(FakeUpload(b"z" * 10000), limit=10000) == b"z" * 10000  # 恰好等于
    assert await _read_capped(FakeUpload(b""), limit=10000) == b""
    print("_read_capped 单元: OK")


def _integration() -> None:
    from fastapi.testclient import TestClient

    orig = main.MAX_UPLOAD_BYTES
    main.MAX_UPLOAD_BYTES = 1000  # 临时把上限调小, 避免造大文件
    try:
        client = TestClient(main.app)
        # 超限 -> 友好错误, 不 500
        r = client.post("/api/extract", files={"file": ("big.txt", b"a" * 2000, "text/plain")})
        assert r.status_code == 200, r.status_code
        body = r.json()
        assert body.get("ok") is False and "过大" in body.get("error", ""), body
        # 正常小文件 -> 可用
        r2 = client.post("/api/extract", files={"file": ("ok.txt", "正文内容".encode("utf-8"), "text/plain")})
        assert r2.json().get("ok") is True, r2.json()
        print("/api/extract 超限拒绝 + 正常可用: OK")
    finally:
        main.MAX_UPLOAD_BYTES = orig


def main_run() -> None:
    asyncio.run(_unit())
    _integration()
    print("\nALL UPLOAD-LIMIT TESTS PASSED")


if __name__ == "__main__":
    try:
        main_run()
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
