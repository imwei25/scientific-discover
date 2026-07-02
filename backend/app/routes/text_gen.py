"""LLM 文本生成类端点(全部 SSE 流式或其澄清辅助): 通用 run、找选题、标书、
IMRaD、回复审稿、去 AI 味、统计顾问。"""
from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..deai import scan_ai_flavor, stream_rewrite
from ..grant import write_grant, plan_grant, revise_section
from ..http_common import SSE_HEADERS, _sse
from ..imrad import assemble_imrad
from ..llm import LLMError, stream_chat
from ..logutil import log_swallow
from ..prompts import build_messages
from ..rebuttal import rebuttal
from ..research import clarify_topic, deep_research_idea, idea_followup, refine_topic

router = APIRouter()


class RunRequest(BaseModel):
    module: str
    inputs: dict


class DeaiScanRequest(BaseModel):
    text: str


class DeaiRewriteRequest(BaseModel):
    text: str
    blocks: list[int] = []   # 要改写的块索引(来自 scan 的 flagged_blocks); 空则自动扫描取全部命中块
    style: str = ""          # 可选: 作者个人风格档案


@router.post("/api/run")
async def run(req: RunRequest) -> StreamingResponse:
    try:
        messages = build_messages(req.module, req.inputs)
    except ValueError as e:
        # 注意: 把消息先取出为局部变量。Python 在 except 块结束时会清除异常变量 e,
        # 而下面的生成器是延迟执行(流式时才跑), 若闭包里引用 e 会 NameError。
        err_msg = str(e)

        async def err_gen():
            yield _sse("error", {"message": err_msg})
        return StreamingResponse(err_gen(), media_type="text/event-stream")

    async def gen():
        try:
            async for piece in stream_chat(messages):
                yield _sse("delta", {"text": piece})
        except LLMError as e:
            yield _sse("error", {"message": str(e)})
        except Exception as e:  # noqa: BLE001
            yield _sse("error", {"message": f"内部错误: {e}"})
        else:
            yield _sse("done", {})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/deai/scan")
async def deai_scan(req: DeaiScanRequest) -> JSONResponse:
    """去 AI 味 第一步: 启发式扫描, 标出 AI 味较重的句子(非流式, 不调 LLM)。

    任何异常都返回空结果(放行不阻塞), 与其它"分析型"接口一致。
    """
    try:
        return JSONResponse(scan_ai_flavor(req.text))
    except Exception:  # noqa: BLE001
        return JSONResponse({
            "spans": [], "flagged_blocks": [],
            "stats": {"blocks": 0, "prose_blocks": 0, "sentences": 0, "flagged": 0},
        })


@router.post("/api/deai/rewrite")
async def deai_rewrite_ep(req: DeaiRewriteRequest) -> StreamingResponse:
    """去 AI 味 第二步: 逐块流式改写被标记的散文块(可随时断流中断)。"""
    async def gen():
        try:
            blocks = req.blocks or scan_ai_flavor(req.text)["flagged_blocks"]
            async for event, data in stream_rewrite(req.text, blocks, style=req.style):
                yield _sse(event, data)
        except LLMError as e:
            yield _sse("error", {"message": str(e)})
        except Exception as e:  # noqa: BLE001
            yield _sse("error", {"message": f"内部错误: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/idea")
async def idea(req: RunRequest) -> StreamingResponse:
    """医学/药学/生物 找选题: 检索 PubMed + 分析现状/空白/选题(带文献链接)。"""
    async def gen():
        async for event, data in deep_research_idea(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/idea/clarify")
async def idea_clarify(req: RunRequest) -> JSONResponse:
    """检索前澄清: 判断方向是否够具体, 不够则回最多 3 个澄清问题(非流式)。

    任何异常/mock 一律返回 ready=True 放行, 绝不阻塞用户检索。
    """
    if settings.mock:
        return JSONResponse({"ready": True, "questions": []})
    try:
        return JSONResponse(await clarify_topic(req.inputs))
    except Exception as e:  # noqa: BLE001
        log_swallow("找选题/澄清: 失败, 按 ready=True 放行", e)
        return JSONResponse({"ready": True, "questions": []})


@router.post("/api/idea/refine")
async def idea_refine(req: RunRequest) -> JSONResponse:
    """澄清回答后, 给出 2-3 个优化的研究方向/关键词候选(非流式)。失败/mock 返回空 options 放行。"""
    if settings.mock:
        f = (req.inputs.get("field") or "").strip()
        return JSONResponse({"options": [
            {"field": f + "（更聚焦）", "keywords": "mock, biomarker", "reason": "[MOCK] 补了人群与结局，更可检索。"},
        ]})
    try:
        return JSONResponse(await refine_topic(req.inputs))
    except Exception as e:  # noqa: BLE001
        log_swallow("找选题/方向优化: 失败, 返回空候选", e)
        return JSONResponse({"options": []})


@router.post("/api/imrad")
async def imrad_ep(req: RunRequest) -> StreamingResponse:
    """IMRaD 初稿装配: 把已有材料分段拼成 Intro/Methods/Results/Discussion(本地, 只据材料)。"""
    async def gen():
        async for event, data in assemble_imrad(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/grant")
async def grant_ep(req: RunRequest) -> StreamingResponse:
    """写中文标书: 凝练方案 → 大纲 → 分节撰写 → 评审自查(据选题报告与真实文献, 接在找选题之后)。

    若 inputs 含已确认的 scheme/sections, 则跳过凝练直接据此撰写(两段式)。
    """
    async def gen():
        async for event, data in write_grant(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/grant/plan")
async def grant_plan_ep(req: RunRequest) -> JSONResponse:
    """两段式第一步: 产出可编辑的【方案骨架 + 大纲】交用户确认(非流式)。失败也回退不阻断。"""
    try:
        return JSONResponse(await plan_grant(req.inputs))
    except Exception as e:  # noqa: BLE001
        log_swallow("写标书/生成大纲: 失败, 返回默认方案骨架", e)
        from ..grant import _default_outline, _norm_scheme
        title = (req.inputs.get("title") or req.inputs.get("field") or "").strip()
        return JSONResponse({"scheme": _norm_scheme({}, title), "outline": _default_outline()})


@router.post("/api/grant/revise")
async def grant_revise_ep(req: RunRequest) -> StreamingResponse:
    """逐节重写: 仅按意见重写某一章节, 不重跑全篇(流式)。"""
    async def gen():
        async for event, data in revise_section(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/rebuttal")
async def rebuttal_ep(req: RunRequest) -> StreamingResponse:
    """回复审稿意见: 拆解意见 → 逐条生成 point-by-point 回复信(本地处理, 数据不出网)。"""
    async def gen():
        async for event, data in rebuttal(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/idea-followup")
async def idea_followup_ep(req: RunRequest) -> StreamingResponse:
    """对已生成的找选题报告追问 / 按意见修改(基于回传的真实文献, 不重新检索)。"""
    async def gen():
        async for event, data in idea_followup(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


# ----- 统计顾问(SSE 流式) -----

class StatsAdviceRequest(BaseModel):
    question: str
    data_meta: dict | None = None


_STATS_ADVICE_DEMO = {
    "recommended": {
        "test": "独立样本 t 检验",
        "why": "两个独立组比较一个连续变量的均值, 样本足够时用 t 检验; 若不满足正态性可改用 Wilcoxon 秩和检验。",
    },
    "assumptions": [
        "两组独立同分布",
        "结局变量近似正态分布(可用 Shapiro-Wilk 检验)",
        "两组方差齐性(可用 Levene 检验; 不齐时用 Welch's t)",
    ],
    "cautions": [
        "样本量较小时优先报告效应量 Cohen's d 与 95% 置信区间, 不要只报 p 值",
        "若进行多组多次比较, 务必做多重比较校正(Bonferroni/Holm/FDR)",
        "观察性数据下不能直接得出因果结论",
    ],
    "alternatives": [
        {"test": "Wilcoxon 秩和检验(Mann-Whitney U)", "when": "结局非正态或样本量较小(每组 < 30)"},
        {"test": "Welch's t 检验", "when": "两组方差不齐"},
        {"test": "线性回归(协方差分析 ANCOVA)", "when": "需要调整其他协变量(如年龄/性别)"},
    ],
}


@router.post("/api/stats/advice")
async def stats_advice(req: StatsAdviceRequest) -> StreamingResponse:
    """SSE: 让 LLM 流式输出严格 JSON, 前端解析后渲染推荐卡片。

    mock 模式: 把固定演示 JSON 分块吐出, 保留前端流式 UI 体验。
    """
    if settings.mock:
        async def mock_gen():
            text = json.dumps(_STATS_ADVICE_DEMO, ensure_ascii=False)
            # 30 字符一片
            for i in range(0, len(text), 30):
                yield _sse("delta", {"text": text[i:i + 30]})
            yield _sse("done", {})
        return StreamingResponse(mock_gen(), media_type="text/event-stream", headers=SSE_HEADERS)

    from ..prompts import build_stats_advice
    messages = build_stats_advice(req.question, req.data_meta)

    async def gen():
        try:
            async for piece in stream_chat(messages):
                yield _sse("delta", {"text": piece})
        except LLMError as e:
            yield _sse("error", {"message": str(e)})
        except Exception as e:  # noqa: BLE001
            yield _sse("error", {"message": f"内部错误: {e}"})
        else:
            yield _sse("done", {})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
