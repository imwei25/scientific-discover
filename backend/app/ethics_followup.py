"""对已生成的伦理材料 Markdown 预览追问 / 按意见修改。

伦理材料本身是 Word 模板渲染(见 ethics.py),followup 只对 Markdown 预览版做重写,
不改 Word 模板结构;下载 Word 时可选择用修订版重新填模板。
"""
from __future__ import annotations

import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat


_TEMPLATE_LABEL = {
    "informed_consent": "知情同意书",
    "protocol": "研究方案",
    "crf": "病例报告表 (CRF)",
    "data_use_commitment": "数据使用承诺书",
}


async def ethics_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = (inputs.get("mode") or "ask").strip()
    question = (inputs.get("question") or "").strip()
    draft = (inputs.get("draft") or "").strip()
    template = (inputs.get("template") or "").strip()
    materials = (inputs.get("materials") or "").strip()

    tpl_label = _TEMPLATE_LABEL.get(template, "伦理材料")

    if not question:
        yield ("error", {"message": "请填写追问问题或修改意见。"})
        return
    if not draft:
        yield ("error", {"message": f"缺少可依据的{tpl_label}初稿。"})
        return

    if settings.mock:
        reply = f"[MOCK] 已收到{'修改意见' if mode == 'revise' else '追问'}: 「{question}」。"
        for ch in reply:
            yield ("delta", {"text": ch})
        yield ("done", {})
        return

    if mode == "revise":
        system = (
            f"你是资深医学伦理审查顾问,正在按修改意见修订一份【{tpl_label}】草案。"
            "请基于附加材料与用户意见产出【修改后的完整草案】(Markdown),保持原有小节结构,"
            "受试者权利/隐私/自愿等段落须完整,缺失事实以 [待补充] 标注。直接输出修改后全文。"
        )
    else:
        system = (
            f"你是资深医学伦理审查顾问。基于已生成的{tpl_label}草案与附加材料回答用户追问,不得编造事实。"
        )

    user = (
        f"【材料类型】{tpl_label}\n\n"
        f"【附加材料】\n{materials or '(未填)'}\n\n"
        f"【当前草案】\n{draft}\n\n"
        f"【用户{'修改意见' if mode == 'revise' else '追问'}】\n{question}"
    )

    try:
        async for piece in stream_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            task="ethics",
        ):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[ethics-followup] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"追问处理出错: {type(e).__name__}: {e}"})
