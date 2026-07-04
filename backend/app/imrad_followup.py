"""对已生成的 IMRaD 初稿追问 / 按意见修改。"""
from __future__ import annotations

import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat


async def imrad_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = (inputs.get("mode") or "ask").strip()
    question = (inputs.get("question") or "").strip()
    draft = (inputs.get("draft") or "").strip()
    topic = (inputs.get("topic") or "").strip()
    materials = (inputs.get("materials") or "").strip()

    if not question:
        yield ("error", {"message": "请填写追问问题或修改意见。"})
        return
    if not draft:
        yield ("error", {"message": "缺少可依据的初稿,请先装配一次 IMRaD 初稿。"})
        return

    if settings.mock:
        reply = f"[MOCK] 已收到{'修改意见' if mode == 'revise' else '追问'}: 「{question}」。"
        for ch in reply:
            yield ("delta", {"text": ch})
        yield ("done", {})
        return

    if mode == "revise":
        system = (
            "你是资深医学/药学/生物医学论文写作助手,正在按修改意见修订一份【论文 IMRaD 初稿】。"
            "请基于附加材料与用户意见,产出【修改后的完整初稿】: 保持 Introduction/Methods/Results/Discussion 结构,"
            "所有数字/统计量必须原样来自材料,禁止编造。缺失处标注 [待补充: ...]。直接输出修改后全文。"
        )
    else:
        system = (
            "你是资深医学/药学/生物医学论文写作助手。基于已装配的 IMRaD 初稿与附加材料回答用户追问,不得编造数字/文献。"
        )

    user = (
        f"【论文主题】{topic or '(未提供)'}\n\n"
        f"【附加材料】\n{materials or '(未填)'}\n\n"
        f"【当前 IMRaD 初稿】\n{draft}\n\n"
        f"【用户{'修改意见' if mode == 'revise' else '追问'}】\n{question}"
    )

    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            task="imrad",
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[imrad-followup] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"追问处理出错: {type(e).__name__}: {e}"})
