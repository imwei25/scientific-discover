"""NCBI E-utilities 限速节流回归测试(不消耗 API 额度, 纯本地计时)。

运行: .venv\\Scripts\\python.exe test_ncbi_throttle.py
验证: _throttle 保证相邻 NCBI 请求间隔 >= _NCBI_MIN_INTERVAL, 从而不超过 ~3 次/秒;
      并发发起也被串行节流。
"""
import asyncio
import sys
import time

from app import literature


async def main() -> None:
    iv = literature._NCBI_MIN_INTERVAL

    # 顺序: n 次请求 -> 至少 (n-1) 个间隔(首次免等)。
    n = 6
    t0 = time.monotonic()
    for _ in range(n):
        await literature._throttle()
    elapsed = time.monotonic() - t0
    assert elapsed >= (n - 1) * iv * 0.9, f"顺序节流不足: {elapsed:.2f}s"

    # 相邻请求的最大瞬时速率不超过 ~3/秒。
    assert 1.0 / iv <= 3.0 + 1e-9, "间隔过小, 可能超 3/秒"

    # 并发: 同时发起 4 次也被串行拉开 >= 3 个间隔。
    t1 = time.monotonic()
    await asyncio.gather(*[literature._throttle() for _ in range(4)])
    el2 = time.monotonic() - t1
    assert el2 >= 3 * iv * 0.9, f"并发未串行节流: {el2:.2f}s"

    print(f"顺序 {n} 次 {elapsed:.2f}s(>= {(n-1)*iv:.2f}s)、并发 4 次 {el2:.2f}s: OK")
    print("ALL NCBI-THROTTLE TESTS PASSED")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
