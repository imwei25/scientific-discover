"""回复审稿意见(Rebuttal)助手。

返修是从数据到投稿全链路里频率高、对录用影响最大、且隐私最敏感的环节
(同时涉及未发表稿件 + 保密审稿意见)——正契合本工具"本地运行、数据不出网"的定位。

流程:
  1) 把审稿意见拆解为带编号的条目(按审稿人分组, 打类型标签), 供前端清单展示;
  2) 基于稿件(节选)与意见, 生成 point-by-point 回复信(Markdown), 每条含:
     意见摘要 → 回应 → 建议的正文改动(定位到章节)。

对外是异步生成器, 逐步 yield (event, data): status / comments / delta / done / error。
铁律: 只能基于作者提供的稿件内容, 不编造数据/结果; 需补做的实验或分析用
"我们将补充…"表述, 不虚构具体数字。
"""
from __future__ import annotations

import json
import traceback
from typing import AsyncIterator

from .config import settings
from .llm import stream_chat


async def _complete(messages: list[dict], max_tokens: int = 800) -> str:
    buf = ""
    async for piece in stream_chat(messages, max_tokens=max_tokens):
        buf += piece
    return buf


def _parse_json(raw: str, opener: str, closer: str):
    s, e = raw.find(opener), raw.rfind(closer)
    if s == -1 or e == -1:
        return None
    try:
        return json.loads(raw[s : e + 1])
    except Exception:  # noqa: BLE001
        return None


_VALID_TYPES = {"澄清", "补实验", "补分析", "补文献", "方法", "写作", "格式", "其他"}


async def _parse_comments(reviews: str) -> list[dict]:
    """把审稿意见拆解为结构化条目(按审稿人/编号, 带类型标签)。"""
    system = (
        "你是医学论文编辑助手。把下面的审稿意见拆解为相互独立的条目。"
        "只输出 JSON 数组，每项形如 "
        "{\"reviewer\":\"审稿人标识(如 R1/编辑)\",\"index\":条目序号(整数),\"comment\":\"意见原文(可精简但保留要点)\",\"type\":\"类型\"}。"
        "type 仅取其一：澄清/补实验/补分析/补文献/方法/写作/格式/其他。不要任何解释。"
    )
    arr = _parse_json(
        await _complete(
            [{"role": "system", "content": system}, {"role": "user", "content": reviews[:6000]}],
            max_tokens=1500,
        ),
        "[", "]",
    )
    items: list[dict] = []
    if isinstance(arr, list):
        for it in arr:
            if isinstance(it, dict) and str(it.get("comment") or "").strip():
                t = str(it.get("type") or "其他").strip()
                items.append({
                    "reviewer": str(it.get("reviewer") or "").strip() or "审稿人",
                    "index": it.get("index") if isinstance(it.get("index"), int) else len(items) + 1,
                    "comment": str(it["comment"]).strip(),
                    "type": t if t in _VALID_TYPES else "其他",
                })
    return items


def _letter_messages(manuscript: str, reviews: str, tone: str) -> list[dict]:
    tone_txt = (
        "礼貌但坚定、有理有据(对确不认同之处礼貌而明确地说明理由与证据)"
        if tone == "firm"
        else "礼貌、谦逊、建设性(尽量采纳, 确有分歧时温和说明)"
    )
    ms = (manuscript or "")[:8000]
    system = (
        "你是资深医学论文通讯作者，正在撰写对审稿意见的 point-by-point 回复信。"
        f"整体语气：{tone_txt}。\n"
        "请按【审稿人 → 逐条意见】组织，每条用如下结构（Markdown）：\n"
        "**审稿人X · 意见N**：<简述该条意见>\n\n"
        "回应：<针对性的具体回应>\n\n"
        "修改：<说明在正文哪一节/段做了什么修改；若需补做实验或分析，写“我们将补充……”并说明方案>\n\n"
        "开头写一句简短的总体致谢，结尾写一句礼貌结语。\n"
        "铁律：只能基于下面提供的稿件内容回应，严禁编造数据、结果或文献；"
        "凡涉及尚未做的新实验/新分析，一律用“我们将补充/拟开展……”表述，绝不杜撰具体数字或结论。"
        "用中文输出。"
    )
    user = (
        f"【稿件（节选，供你核对事实与定位修改处）】\n{ms or '（作者未提供稿件全文，请基于意见给出通用但具体的回应框架，并提示作者补全稿件细节）'}\n\n"
        f"【审稿意见原文】\n{reviews[:6000]}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def _mock_flow(reviews: str) -> AsyncIterator[tuple[str, dict]]:
    yield ("status", {"message": "正在拆解审稿意见…"})
    yield ("comments", {"items": [
        {"reviewer": "R1", "index": 1, "comment": f"[MOCK] {reviews[:30] or '样本量是否充分？'}", "type": "补分析"},
        {"reviewer": "R2", "index": 1, "comment": "[MOCK] 方法描述不够清晰。", "type": "方法"},
    ]})
    yield ("status", {"message": "正在逐条撰写回复…"})
    text = (
        "感谢各位审稿人的宝贵意见。以下逐条回应：\n\n"
        "**审稿人1 · 意见1**：样本量是否充分？\n\n回应：[MOCK] 我们已补充样本量与检验效能说明。\n\n修改：见方法学第 2.3 节。\n\n"
        "**审稿人2 · 意见1**：方法描述不清。\n\n回应：[MOCK] 已补充细节。\n\n修改：见方法学第 2.1 节。\n\n"
        "再次感谢审稿人的建设性意见。"
    )
    for ch in text:
        yield ("delta", {"text": ch})


async def rebuttal(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    manuscript = (inputs.get("manuscript") or "").strip()
    reviews = (inputs.get("reviews") or "").strip()
    tone = (inputs.get("tone") or "balanced").strip()

    if not reviews:
        yield ("error", {"message": "请粘贴/上传审稿意见。"})
        return

    if settings.mock:
        async for ev in _mock_flow(reviews):
            yield ev
        yield ("done", {})
        return

    try:
        yield ("status", {"message": "正在拆解审稿意见…"})
        comments = await _parse_comments(reviews)
        yield ("comments", {"items": comments})
        n = len(comments)
        yield ("status", {"message": (f"已识别 {n} 条意见，正在逐条撰写回复…" if n else "正在撰写逐条回复…")})
        async for piece in stream_chat(_letter_messages(manuscript, reviews, tone)):
            yield ("delta", {"text": piece})
        yield ("done", {})
    except Exception as e:  # noqa: BLE001
        print("[rebuttal] exception:\n" + traceback.format_exc(), flush=True)
        yield ("error", {"message": f"生成回复出错：{type(e).__name__}: {e}"})
