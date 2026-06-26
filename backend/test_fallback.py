"""自动降级逻辑回归测试(不消耗 API 额度)。

运行: .venv\Scripts\python.exe test_fallback.py
验证: 配额错误时自动切备用; 非配额错误不切; 已产出内容后不重复降级。
"""
import asyncio
import sys

from app import config

config.settings.mock = False
config.settings.api_key = "primary"
config.settings.fallback_api_key = "fb"
config.settings.fallback_base_url = "https://x"
config.settings.fallback_model = "m"

import app.llm as llm  # noqa: E402


async def collect(agen) -> str:
    out = ""
    async for p in agen:
        out += p
    return out


def main() -> None:
    # 1) 配额错误判定
    assert llm.is_quota_error(llm.LLMError("x", status=402))
    assert llm.is_quota_error(llm.LLMError("Insufficient Balance"))
    assert llm.is_quota_error(llm.LLMError("余额不足"))
    assert not llm.is_quota_error(llm.LLMError("401 Unauthorized", status=401))
    print("is_quota_error: OK")

    # 2) 主供应商配额错误 -> 自动切备用
    async def fake_stream(cfg, messages, **kw):
        if cfg.api_key == "primary":
            raise llm.LLMError("Insufficient Balance", status=402)
            yield  # noqa: 让函数成为 generator
        for ch in "FALLBACK-OK":
            yield ch

    llm._stream_with = fake_stream
    assert asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}]))) == "FALLBACK-OK"
    print("quota -> fallback: OK")

    # 3) 非配额错误 -> 不降级
    async def fake_stream2(cfg, messages, **kw):
        if cfg.api_key == "primary":
            raise llm.LLMError("401 Unauthorized", status=401)
            yield
        for ch in "SHOULD-NOT":
            yield ch

    llm._stream_with = fake_stream2
    try:
        asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}])))
        print("ERROR: should have raised")
        sys.exit(1)
    except llm.LLMError:
        print("non-quota -> raised (no fallback): OK")

    # 4) 已产出内容后报错 -> 不重复降级
    async def fake_stream3(cfg, messages, **kw):
        if cfg.api_key == "primary":
            yield "partial"
            raise llm.LLMError("Insufficient Balance", status=402)
        for ch in "DUP":
            yield ch

    llm._stream_with = fake_stream3
    got = ""

    async def run4():
        nonlocal got
        try:
            async for p in llm.stream_chat([{"role": "user", "content": "hi"}]):
                got += p
            return "no-raise"
        except llm.LLMError:
            return "raised"

    res = asyncio.run(run4())
    assert got == "partial" and res == "raised", (got, res)
    print("mid-stream error -> no duplicate fallback: OK")
    print("\nALL FALLBACK TESTS PASSED")


if __name__ == "__main__":
    main()
