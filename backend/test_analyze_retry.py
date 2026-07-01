"""数据分析自动纠错重试次数回归测试(不消耗 API 额度, mock LLM 与执行)。

运行: .venv\\Scripts\\python.exe test_analyze_retry.py
验证: AI 生成代码报错时, 至多重试 3 次(共 4 次执行); 第 4 次成功则整体成功,
      4 次都失败才报错。(此前仅 3 次执行, 边缘情况下旗舰分析会失败。)
"""
import asyncio
import sys

import pandas as pd

import app.dataanalysis as da

da.settings.mock = False  # 走真实分析路径(但 LLM/执行都被 mock)

_CSV = pd.DataFrame({"组别": ["A", "B"], "值": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect(fail_times: int):
    """让 _execute 前 fail_times 次失败, 之后成功; 返回(事件列表, 执行次数)。"""
    calls = {"n": 0}

    def fake_execute(code, df, chart_format="png", palette="default"):
        calls["n"] += 1
        if calls["n"] <= fail_times:
            return {"ok": False, "error": "boom", "stdout": "", "charts": []}
        return {"ok": True, "error": None, "stdout": "结果输出", "charts": []}

    async def fake_stream(messages, **kw):
        yield "```python\nprint('x')\n```"

    da._execute = fake_execute
    da.stream_chat = fake_stream  # _complete 与结论流式都走它

    events = []
    async for ev, _ in da.analyze_data("d.csv", _CSV, "比较"):
        events.append(ev)
    return events, calls["n"]


def main() -> None:
    # 失败 3 次, 第 4 次成功 -> 整体 done, 共 4 次执行
    ev, n = asyncio.run(_collect(fail_times=3))
    assert "done" in ev and "error" not in ev, ev
    assert n == 4, f"应执行 4 次, 实际 {n}"
    print(f"失败3次后第4次成功 -> done, 执行 {n} 次: OK")

    # 4 次全失败 -> 报错, 且不超过 4 次执行
    ev2, n2 = asyncio.run(_collect(fail_times=99))
    assert "error" in ev2 and "done" not in ev2, ev2
    assert n2 == 4, f"应执行 4 次后放弃, 实际 {n2}"
    print(f"全失败 -> error, 执行 {n2} 次后停止: OK")

    print("\nALL ANALYZE-RETRY TESTS PASSED")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("FAILED:", e)
        sys.exit(1)
