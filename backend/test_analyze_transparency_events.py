"""analyze_data 集成:透明化切分 + 结论前置裁剪。
运行: .venv\\Scripts\\python.exe test_analyze_transparency_events.py"""
import asyncio, sys
import pandas as pd
import app.dataanalysis as da

da.settings.mock = False

_CSV = pd.DataFrame({"g": ["A", "B"], "v": [1, 2]}).to_csv(index=False).encode("utf-8")


async def _collect():
    stdout = (
        "『【方法选择】』\nt 检验\n\n"
        "『【假设检查】』\nShapiro p=0.3\n\n"
        "『【数据质量】』\n无缺失\n\n"
        "p=0.02"
    )
    # 三次 _complete 依次:探索代码 / 方法规格 JSON / 分析代码
    call_seq = ["```python\nprint('explore')\n```", "```json\n{\"analyses\":[]}\n```", "```python\nprint('analyze')\n```"]
    ci = {"n": 0}

    async def fake_complete(messages, **kw):
        v = call_seq[ci["n"]] if ci["n"] < len(call_seq) else "```python\nprint('x')\n```"
        ci["n"] += 1
        return v

    async def fake_stream(messages, task=None):
        # 结论 LLM 输出:故意加寒暄, 验证裁剪
        for p in ["好的,我为您总结如下。\n", "## 核心发现\n", "p=0.02"]:
            yield p

    def fake_execute(code, df, chart_format="png", palette="default"):
        # 探索轮:空输出;分析轮:三段 stdout
        if not fake_execute.first_done:
            fake_execute.first_done = True
            return {"ok": True, "error": None, "stdout": "explore ok", "charts": []}
        return {"ok": True, "error": None, "stdout": stdout, "charts": []}

    fake_execute.first_done = False

    da._execute = fake_execute
    da._complete = fake_complete
    da.stream_chat = fake_stream

    events = []
    async for ev, data in da.analyze_data("t.csv", _CSV, "跑 t 检验", "png", "default"):
        events.append((ev, data))
    return events


def main():
    events = asyncio.run(_collect())
    names = [e[0] for e in events]
    print("events:", names)
    fail = 0

    for e in ("transparency_method", "transparency_assumption", "transparency_quality", "output", "delta", "done"):
        if e not in names: print("FAIL 缺", e); fail += 1
        else: print("PASS 有", e)

    trm = next((d["text"] for n, d in events if n == "transparency_method"), "")
    if "t 检验" in trm: print("PASS method 内容")
    else: print("FAIL method 内容:", trm); fail += 1

    tqu = next((d["text"] for n, d in events if n == "transparency_quality"), "")
    if "无缺失" in tqu: print("PASS quality 内容")
    else: print("FAIL quality 内容:", tqu); fail += 1

    out = next((d["text"] for n, d in events if n == "output"), "")
    if out.strip() == "p=0.02": print("PASS output = 主结果")
    else: print("FAIL output:", repr(out)); fail += 1

    # 校验 delta 拼起来:必须以 ## 起，且不含开场白
    conclusion = "".join(d["text"] for n, d in events if n == "delta")
    if conclusion.startswith("## 核心发现"): print("PASS delta 起始 = ##")
    else: print("FAIL delta 未裁剪:", repr(conclusion[:40])); fail += 1
    if "我为您总结" in conclusion: print("FAIL delta 有开场白"); fail += 1
    else: print("PASS delta 无开场白")

    print("RESULT:", "PASS" if fail == 0 else "FAIL")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
