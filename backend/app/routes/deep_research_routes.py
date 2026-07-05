"""深度调研路由: parse_upload / lookup_title / recommend / stream / followup."""
from __future__ import annotations

import traceback
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .. import deep_research as dr
from ..http_common import MAX_UPLOAD_BYTES, SSE_HEADERS, _read_capped, _sse

router = APIRouter()


@router.post("/api/deep_research/parse_upload")
async def parse_upload_ep(
    file: UploadFile = File(...),
    project_id: str | None = Form(None),
):
    """上传 PDF/DOCX/TXT → 抽取 title/摘要, 缓存全文到 project 目录."""
    content = await _read_capped(file, limit=MAX_UPLOAD_BYTES)
    if content is None:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB 上限",
        )
    try:
        result = await dr.parse_upload(file.filename or "upload", content, project_id)
    except ValueError as e:
        # project_data_dir 对非法 project_id (如 ../../.. 路径穿透) 抛 ValueError
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    if not result.get("ok"):
        return JSONResponse(status_code=400, content=result)
    return JSONResponse(result)


class LookupTitleReq(BaseModel):
    title: str


@router.post("/api/deep_research/lookup_title")
async def lookup_title_ep(req: LookupTitleReq):
    """用户手输题名 → crossref/openalex 反查, 返回 {found, abstract, first_author, year, url, doi}."""
    return JSONResponse(await dr.lookup_title(req.title))


class RecommendReq(BaseModel):
    question: str
    refs: list[dict]


@router.post("/api/deep_research/recommend")
async def recommend_ep(req: RecommendReq):
    return JSONResponse(await dr.recommend(req.question, req.refs))


# ── 主 SSE 流: search phase + generate phase ─────────────────

class StreamReq(BaseModel):
    question: str
    field: str = ""
    background: str = ""
    depth: str = "deep"
    sources: list[str] = []
    filters: Any = None
    phase: str = "search"
    references: list[dict] = []
    evidence: list[dict] = []
    deep_read_targets: list[dict] = []
    english_report: bool = False
    project_id: str | None = None


@router.post("/api/deep_research/stream")
async def stream_ep(req: StreamReq) -> StreamingResponse:
    """深度调研主流: search phase 做文献检索, generate phase 做深读+合成+贡献表。"""
    async def gen():
        try:
            if req.phase == "search":
                # 复用找选题检索逻辑: question 作 keywords, field 作研究方向
                from ..research import deep_research_idea
                inputs = {
                    "field": req.field or req.question[:80],
                    "keywords": req.question,
                    "background": req.background,
                    "depth": req.depth,
                    "sources": req.sources,
                    "filters": req.filters,
                    "phase": "search",
                    "references": req.references,
                    "english_report": req.english_report,
                }
                async for event, data in deep_research_idea(inputs):
                    yield _sse(event, data)

            elif req.phase == "generate":
                refs = req.references
                if not refs:
                    yield _sse("error", {"message": "没有可用文献，请返回上一步至少保留一篇。"})
                    return

                # 1. 深读全文 (并发, 流式进度)
                deep_reads_map: dict[str, str] = {}
                targets = req.deep_read_targets
                if targets:
                    yield _sse("status", {"message": f"正在深读 {len(targets)} 篇文献全文…"})
                    async for event, data in dr.fetch_deep_reads_stream(targets, req.project_id):
                        if event == "deep_read_result" and data.get("ok"):
                            deep_reads_map[data["ref_key"]] = data.get("chunk", "")
                        yield _sse(event, data)

                # 2. 合成报告 (流式 delta)
                yield _sse("status", {"message": f"正在据 {len(refs)} 篇文献合成报告…"})
                async for event, data in dr.synthesize_stream(
                    req.question, refs, deep_reads_map, req.english_report
                ):
                    yield _sse(event, data)
                    if event == "error":
                        return

                # 3. 贡献表 (非流式, 单 LLM 调用)
                yield _sse("status", {"message": "正在生成文献贡献表…"})
                rows = await dr.build_contribution_table(req.question, refs, deep_reads_map)
                if rows:
                    yield _sse("contribution_table", {"rows": rows})

                yield _sse("done", {})
            else:
                yield _sse("error", {"message": f"未知 phase: {req.phase}"})
        except Exception as e:  # noqa: BLE001
            print("[deep_research/stream] exception:\n" + traceback.format_exc(), flush=True)
            yield _sse("error", {"message": f"深度调研出错: {type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


# ── 追问/改写流 ───────────────────────────────────────────────

class FollowupReq(BaseModel):
    mode: str = "ask"  # "ask" | "revise"
    question: str
    report: str
    references: list[dict] = []
    evidence: list[dict] = []
    english_report: bool = False


@router.post("/api/deep_research/followup/stream")
async def followup_ep(req: FollowupReq) -> StreamingResponse:
    """追问或改写: 将当前报告 + 追问/指令交给 LLM, 流式输出答复/改写。"""
    async def gen():
        try:
            from ..llm import stream_chat
            lang = "English" if req.english_report else "中文"
            if req.mode == "revise":
                system = (
                    f"你是深度调研报告改写助手。用户会给出一份调研报告和修改指令，"
                    f"请按指令改写整份报告，保留原有四节结构，输出改写后的完整报告。"
                    f"引用仍只使用报告中已有的文献 ref_key，格式 [ref_key]。"
                    f"请用{lang}输出。"
                )
                user = f"修改指令：{req.question}\n\n原报告：\n{req.report}"
            else:
                refs_summary = "\n".join(
                    f"[{r.get('ref_key','')}] {r.get('title','')} ({r.get('year','')})"
                    for r in req.references[:40]
                )
                system = (
                    f"你是深度调研助手。用户已有一份调研报告，现在提出追加问题。"
                    f"请据报告内容和给定文献列表作答，引用格式 [ref_key]，不得编造文献。"
                    f"请用{lang}输出。"
                )
                user = (
                    f"追问：{req.question}\n\n"
                    f"已有报告摘要（前1500字）：\n{req.report[:1500]}\n\n"
                    f"文献列表：\n{refs_summary}"
                )
            msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
            full = ""
            async for piece in stream_chat(msgs, task="research"):
                full += piece
                yield _sse("delta", {"text": piece})
            verify = dr._verify_report_citations(full, req.references)
            yield _sse("verify", verify)
            yield _sse("done", {})
        except Exception as e:  # noqa: BLE001
            print("[deep_research/followup] exception:\n" + traceback.format_exc(), flush=True)
            yield _sse("error", {"message": f"追问出错: {type(e).__name__}: {e}"})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
