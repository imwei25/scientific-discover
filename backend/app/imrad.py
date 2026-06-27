"""IMRaD 初稿装配。

把用户已产出的真实材料（选题综述、实验方案/SAP、数据分析结论、讨论要点）
分段拼成连贯的 Introduction / Methods / Results / Discussion 初稿。
独有护城河：每一块都来自用户自己的真实材料 —— 铁律是只据材料、禁止编造
数字/统计量/文献，缺失处用 [待补充：…] 标注。

对外异步生成器, 逐步 yield (event, data): status / delta / done / error。
"""
from __future__ import annotations

import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat

# (材料键, 章节标题, 写作要点)
_SECTIONS = [
    ("background", "## 一、引言 (Introduction)",
     "综述研究背景与现状、指出研究空白与本研究的科学问题/假设与目的；末段点出本研究做了什么。"),
    ("methods", "## 二、方法 (Methods)",
     "用过去时客观描述研究设计、对象与入排、变量与测量、样本量、统计分析计划；可写明伦理与注册（材料有则写）。"),
    ("results", "## 三、结果 (Results)",
     "用过去时客观陈述主要与次要结果，**所有数字/统计量必须原样来自材料**，不做过度解读；图表用 [图1]/[表1] 占位。"),
    ("discussion", "## 四、讨论 (Discussion)",
     "解读主要发现的意义、与既有文献的关系、临床/科学价值，诚实陈述局限（样本量、偏倚、混杂等）与未来方向。"),
]


def _section_messages(title: str, guide: str, material: str, topic: str, refs: str) -> list[dict]:
    system = (
        "你是资深医学/药学/生物医学论文写作助手，正在撰写论文的某一部分(IMRaD)。"
        f"本次撰写：{title.lstrip('# ').strip()}。写作要求：{guide}\n"
        "铁律：只能使用下面【材料】中的事实，严禁编造任何数字、统计量、p 值或文献；"
        "材料不足以支撑之处，用 [待补充：……] 明确标注，绝不杜撰。引用文献时在文中用 [第一作者, 年] 标注，"
        "且只能引用材料/参考文献中确有的文献。语言客观、学术、连贯，用中文 Markdown，"
        "只输出该部分正文，不要重复小节标题、不要写其它部分。"
    )
    user = f"【论文主题】{topic or '（未提供）'}\n\n【本部分材料】\n{material or '（材料缺失，请基于其它信息合理标注 [待补充]）'}"
    if refs:
        user += f"\n\n【可引用的参考文献】\n{refs[:2000]}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def assemble_imrad(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    topic = (inputs.get("topic") or "").strip()
    refs = (inputs.get("references") or "").strip()
    mats = {k: (inputs.get(k) or "").strip() for k, _, _ in _SECTIONS}
    if not any(mats.values()):
        yield ("error", {"message": "请至少提供一部分材料（引言/方法/结果/讨论之一）。"})
        return

    if settings.mock:
        for key, title, _ in _SECTIONS:
            yield ("status", {"message": f"正在撰写{title.lstrip('# ').strip()}…"})
            for ch in f"{title}\n[MOCK] 基于材料的{key}段落。\n\n":
                yield ("delta", {"text": ch})
        yield ("done", {})
        return

    try:
        for i, (key, title, guide) in enumerate(_SECTIONS):
            yield ("status", {"message": f"正在撰写{title.lstrip('# ').strip()}（{i + 1}/4）…"})
            yield ("delta", {"text": ("" if i == 0 else "\n\n") + title + "\n"})
            async for piece in stream_chat(_section_messages(title, guide, mats[key], topic, refs)):
                yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[imrad] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"初稿装配出错：{type(e).__name__}: {e}"})
