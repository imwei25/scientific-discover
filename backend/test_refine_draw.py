"""refine_draw 事件契约。运行: .venv\\Scripts\\python.exe test_refine_draw.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    def fake_execute(code, df, chart_format="png", palette="default"):
        return {"ok": True, "error": None, "stdout": "", "charts": [{"png": "b64", "data": "b64", "ext": "png"}]}

    async def fake_complete(messages, **kw):
        return "```python\nprint('draw2')\n```"

    da._execute = fake_execute
    da._complete = fake_complete

    events = []
    async for ev, data in da.refine_draw(
        "t.csv", _CSV, "print('draw')", "换成箱线图", "画柱状图", "png", "default",
    ):
        events.append((ev, data))
    return events


def main():
    events = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0
    for must in ("code", "charts", "done"):
        if must not in names: print("FAIL 缺", must); fail += 1
        else: print("PASS 有", must)
    for forbid in ("delta", "transparency_method", "transparency_assumption", "transparency_quality"):
        if forbid in names: print("FAIL 禁事件却发了", forbid); fail += 1
        else: print("PASS 未发", forbid)
    print("RESULT:", "PASS" if fail == 0 else "FAIL")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
