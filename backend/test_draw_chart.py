"""draw 流水线事件契约。运行: .venv\\Scripts\\python.exe test_draw_chart.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    calls = {"n": 0}

    def fake_execute(code, df, chart_format="png", palette="default"):
        calls["n"] += 1
        return {"ok": True, "error": None, "stdout": "", "charts": [{"png": "b64", "data": "b64", "ext": "png"}]}

    async def fake_stream(messages, **kw):
        yield "```python\nprint('draw')\n```"

    async def fake_complete(messages, **kw):
        return "```python\nprint('draw')\n```"

    da._execute = fake_execute
    da.stream_chat = fake_stream
    da._complete = fake_complete

    events = []
    async for ev, data in da.draw_chart("t.csv", _CSV, "画个柱状图", "png", "default"):
        events.append((ev, data))
    return events, calls["n"]


def main():
    events, n_exec = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0

    # draw 模式必发 code + charts + done, 绝不发 delta / transparency_* / plan
    for must in ("code", "charts", "done"):
        if must not in names:
            print("FAIL 缺事件", must); fail += 1
        else:
            print("PASS 有事件", must)
    for forbid in ("delta", "transparency_method", "transparency_assumption", "transparency_quality", "plan"):
        if forbid in names:
            print("FAIL 禁事件却发了", forbid); fail += 1
        else:
            print("PASS 未发禁事件", forbid)

    if n_exec != 1:
        print("FAIL 成功时不应重试, n_exec =", n_exec); fail += 1
    else:
        print("PASS 无多余重试 n_exec=1")

    print(f"\nRESULT: {'PASS' if fail == 0 else 'FAIL'}")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
