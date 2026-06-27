"""网络/超时错误的重试与降级回归测试(不消耗 API 额度)。

运行: .venv\\Scripts\\python.exe test_network_retry.py
验证:
  - httpx 传输层错误被包装成对用户友好的可重试 LLMError;
  - 瞬时网络错误在未产出内容时按 _MAX_RETRIES 重试;
  - 重试耗尽后转用备用供应商; 第二次成功则不降级;
  - 已产出内容后再断网, 直接抛出, 不重试/不降级(避免重复输出)。
"""
import asyncio
import sys

import httpx

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
    # A) httpx 传输层错误 -> 友好且可重试的 LLMError
    orig_openai = llm._stream_openai

    async def fake_openai(cfg, msgs, **kw):
        raise httpx.ConnectTimeout("boom")
        yield  # 让函数成为 async generator

    llm._stream_openai = fake_openai
    try:
        asyncio.run(collect(llm._stream_with(llm._primary_cfg(), [{"role": "user", "content": "hi"}])))
        print("ERROR: should have raised")
        sys.exit(1)
    except llm.LLMError as e:
        assert e.retryable is True, "网络错误应标记 retryable"
        assert "超时" in str(e)
        print("wrap httpx -> friendly retryable LLMError: OK")
    finally:
        llm._stream_openai = orig_openai

    # B) 主供应商持续超时 -> 重试耗尽 -> 切备用
    attempts = {"n": 0}

    async def fake_sw(cfg, messages, **kw):
        if cfg.api_key == "primary":
            attempts["n"] += 1
            raise llm.LLMError("超时", retryable=True)
            yield
        for ch in "FB-AFTER-RETRY":
            yield ch

    llm._stream_with = fake_sw
    got = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}])))
    assert got == "FB-AFTER-RETRY", got
    assert attempts["n"] == llm._MAX_RETRIES + 1, attempts
    print(f"persistent network error -> retry x{llm._MAX_RETRIES} then fallback: OK")

    # C) 第二次成功 -> 不降级
    state = {"n": 0}

    async def fake_sw2(cfg, messages, **kw):
        if cfg.api_key == "primary":
            state["n"] += 1
            if state["n"] == 1:
                raise llm.LLMError("瞬时超时", retryable=True)
                yield
            for ch in "PRIMARY-OK-2ND":
                yield ch
        else:
            for ch in "SHOULD-NOT-FB":
                yield ch

    llm._stream_with = fake_sw2
    got2 = asyncio.run(collect(llm.stream_chat([{"role": "user", "content": "hi"}])))
    assert got2 == "PRIMARY-OK-2ND" and state["n"] == 2, (got2, state)
    print("retry then succeed (no fallback): OK")

    # D) 已产出内容后断网 -> 直接抛, 不重试/不降级
    async def fake_sw3(cfg, messages, **kw):
        if cfg.api_key == "primary":
            yield "partial"
            raise llm.LLMError("中途断网", retryable=True)
        for ch in "DUP":
            yield ch

    llm._stream_with = fake_sw3
    got3 = ""

    async def run4():
        nonlocal got3
        try:
            async for p in llm.stream_chat([{"role": "user", "content": "hi"}]):
                got3 += p
            return "no-raise"
        except llm.LLMError:
            return "raised"

    res = asyncio.run(run4())
    assert got3 == "partial" and res == "raised", (got3, res)
    print("mid-stream network error -> no retry/dup: OK")

    print("\nALL NETWORK-RETRY TESTS PASSED")


if __name__ == "__main__":
    main()
