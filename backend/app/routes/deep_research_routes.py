"""深度调研路由: parse_upload / lookup_title / recommend / stream / followup."""
from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import deep_research as dr
from ..http_common import MAX_UPLOAD_BYTES, _read_capped

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
