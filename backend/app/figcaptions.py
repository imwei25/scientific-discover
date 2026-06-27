"""数据分析图表的图注(Figure legend)生成。

每张投稿图都需要规范图注。基于分析代码、真实输出与结论，为每张图生成一句
规范图注（客观描述该图展示内容与关键发现，不编造数字）。

对外: caption(inputs) -> {"ok", "captions": [...]} 或 {"ok": False, "error"}。
"""
from __future__ import annotations

import json

from .config import settings
from .llm import stream_chat


async def caption(inputs: dict) -> dict:
    try:
        count = int(inputs.get("count") or 0)
    except (ValueError, TypeError):
        count = 0
    if count <= 0:
        return {"ok": False, "error": "没有可生成图注的图表。"}
    if settings.mock:
        return {"ok": True, "captions": [f"图{i + 1}. [MOCK] 示例图注。" for i in range(count)]}

    system = (
        "你是医学论文图表编辑。下面是一次数据分析的研究目的、分析代码、真实运行输出与结论。"
        f"该分析共生成了 {count} 张图（按生成顺序）。请为每张图写一句规范的中文图注，"
        "形如『图N. 标题：简述该图展示的内容与关键发现』，基于代码与输出客观描述，"
        "严禁编造代码/输出中没有的数字或结论。"
        f"只输出一个 JSON 字符串数组，长度正好等于图的数量({count})，不要任何解释。"
    )
    user = (
        f"图数量：{count}\n\n【研究目的】\n{(inputs.get('question') or '')[:800]}\n\n"
        f"【分析代码】\n{(inputs.get('code') or '')[:2500]}\n\n"
        f"【运行输出】\n{(inputs.get('output') or '')[:2500]}\n\n"
        f"【结论】\n{(inputs.get('conclusion') or '')[:1500]}"
    )
    buf = ""
    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=900,
        ):
            buf += piece
        s, e = buf.find("["), buf.rfind("]")
        arr = json.loads(buf[s : e + 1]) if s != -1 and e != -1 else []
    except Exception as e:  # noqa: BLE001
        import traceback
        print("[figcaptions] exception:\n" + traceback.format_exc(), flush=True)
        return {"ok": False, "error": f"生成图注出错：{type(e).__name__}"}

    caps = [str(x).strip() for x in arr if str(x).strip()] if isinstance(arr, list) else []
    # 对齐到图数量：不足补占位，多余截断。
    while len(caps) < count:
        caps.append(f"图{len(caps) + 1}. [需补充图注]")
    return {"ok": True, "captions": caps[:count]}
