"""对已生成的实验规划主稿追问 / 按意见修改(严格基于当前 draft + 附加材料)。

参考 research.py::idea_followup 模式。返回 (event, data) 元组的异步生成器。
"""
from __future__ import annotations

import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat


async def plan_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = (inputs.get("mode") or "ask").strip()
    question = (inputs.get("question") or "").strip()
    draft = (inputs.get("draft") or "").strip()
    idea = (inputs.get("idea") or "").strip()
    materials = (inputs.get("materials") or "").strip()

    if not question:
        yield ("error", {"message": "请填写追问问题或修改意见。"})
        return
    if not draft:
        yield ("error", {"message": "缺少可依据的方案主稿,请先生成一次实验规划。"})
        return

    if settings.mock:
        reply = f"[MOCK] 已收到{'修改意见' if mode == 'revise' else '追问'}: 「{question}」。"
        for ch in reply:
            yield ("delta", {"text": ch})
        yield ("done", {})
        return

    if mode == "revise":
        system = (
            "你是资深医学/药学/生物医学科研顾问,正在按用户修改意见修订一份【实验规划主稿】。"
            "请基于研究想法与附加材料,按修改意见产出【修改后的完整方案】: "
            "保持原有 Markdown 结构与分部分组织,直接输出修改后的方案全文,不要附加说明。"
            "缺失信息以 [待补充] 明确标注,不得杜撰数字/文献。"
        )
    else:
        system = (
            "你是资深医学/药学/生物医学科研顾问。下面给出一份【实验规划主稿】与用户的追问。"
            "请基于主稿与材料回答用户追问,可针对某一段展开或解释。若超出材料覆盖范围,请明确说明,不得臆造。"
        )

    user = (
        f"【研究想法】\n{idea or '(未填)'}\n\n"
        f"【附加材料】\n{materials or '(未填)'}\n\n"
        f"【当前方案主稿】\n{draft}\n\n"
        f"【用户{'修改意见' if mode == 'revise' else '追问'}】\n{question}"
    )

    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            task="plan",
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[plan-followup] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"追问处理出错: {type(e).__name__}: {e}"})
