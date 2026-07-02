"""稿件与投稿材料类端点: 期刊列表/选刊、参考文献核验/格式化/导入导出、
Word/LaTeX/投稿包导出、就绪检查、伦理材料、病例脱敏。"""
from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from ..http_common import _read_capped
from ..journals import list_journals

router = APIRouter()


class DocxRequest(BaseModel):
    text: str
    journal_id: str = ""
    references: list[str] = []


class RefsRequest(BaseModel):
    references: str
    journal_id: str = ""


class LatexRequest(BaseModel):
    text: str
    journal_id: str = ""
    references: str = ""


class ReadinessRequest(BaseModel):
    manuscript: str
    journal_id: str = ""


class MatchRequest(BaseModel):
    abstract: str


class BundleFile(BaseModel):
    name: str
    content: str


class BundleRequest(BaseModel):
    files: list[BundleFile] = []   # 文本/Markdown 原样写入
    docx: list[BundleFile] = []    # 用 build_docx 转成 Word 写入


class RefsExportRequest(BaseModel):
    refs: list[dict] = []
    format: str = "ris"


class EthicsRenderRequest(BaseModel):
    template: str
    fields: dict = {}


@router.get("/api/journals")
async def journals() -> dict:
    return {"journals": list_journals()}


@router.post("/api/check-refs")
async def check_refs(req: RefsRequest) -> dict:
    """参考文献核验: DOI 真实性 / 撤稿 / 去重 / 补全(确定性网络核验 + 一次 LLM 解析)。"""
    from ..refcheck import check_references

    return await check_references(req.references)


@router.post("/api/journal-match")
async def journal_match(req: MatchRequest) -> dict:
    """智能选刊: 用摘要在 OpenAlex 检索相近文献, 聚合期刊排序 + LLM 给匹配理由。"""
    from ..journalmatch import match_journals

    return await match_journals(req.abstract)


@router.post("/api/format-refs")
async def format_refs(req: RefsRequest) -> dict:
    """按目标期刊的 CSL 样式格式化参考文献(LLM 解析 + citeproc 渲染)。"""
    from ..citations import format_references

    return await format_references(req.references, req.journal_id)


@router.post("/api/latex")
async def latex(req: LatexRequest) -> dict:
    """导出 LaTeX 工程(.tex+.bib)为 base64 zip; 前端用于下载或在 Overleaf 打开。"""
    from ..latexexport import export_latex

    return await export_latex(req.text, req.journal_id, req.references)


@router.post("/api/readiness")
async def readiness(req: ReadinessRequest) -> dict:
    """投稿就绪检查(确定性, 不调 LLM): 必需章节/字数/参考文献/声明/图表。"""
    from ..readiness import check_readiness

    return check_readiness(req.manuscript, req.journal_id)


def _safe_name(name: str) -> str:
    """清理 zip 内文件名, 防路径穿越。"""
    n = (name or "file").replace("\\", "/").split("/")[-1].strip()
    return n or "file"


@router.post("/api/bundle")
async def bundle(req: BundleRequest) -> Response:
    """把各模块产出打包成投稿包 ZIP(文本原样、docx 项转 Word)。"""
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in req.files:
            if f.content and f.content.strip():
                z.writestr(_safe_name(f.name), f.content)
        if req.docx:
            from ..formatting import build_docx
            for f in req.docx:
                if f.content and f.content.strip():
                    z.writestr(_safe_name(f.name), build_docx(f.content, "", []))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=research-package.zip"},
    )


@router.post("/api/docx")
async def docx(req: DocxRequest) -> Response:
    from ..formatting import build_docx

    data = build_docx(req.text, req.journal_id, req.references)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": "attachment; filename=manuscript.docx"},
    )


# ----- 病例数据脱敏 -----

@router.post("/api/deidentify/scan")
async def deidentify_scan(file: UploadFile = File(...)) -> dict:
    """扫描 csv/xlsx, 返回每列检测到的 PHI 类型与计数。"""
    from ..deidentify import scan

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        report = scan(content, file.filename or "data.csv")
        return {"ok": True, **report}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"扫描失败: {e}"}


@router.post("/api/deidentify/apply")
async def deidentify_apply(
    file: UploadFile = File(...),
    columns: str = Form("[]"),
) -> dict:
    """按 columns(JSON 数组字符串) 脱敏, 返回 base64 字节 + 映射表。"""
    from base64 import b64encode

    from ..deidentify import apply as do_apply

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        cols = json.loads(columns) if columns else []
        if not isinstance(cols, list):
            return {"ok": False, "error": "columns 必须是 JSON 数组。"}
        out_bytes, mapping = do_apply(content, file.filename or "data.csv", cols)
        return {
            "ok": True,
            "data_base64": b64encode(out_bytes).decode("ascii"),
            "filename": file.filename or "deidentified.csv",
            "mapping": mapping,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"脱敏失败: {e}"}


# ----- 引用导入导出 -----

@router.post("/api/refs/import")
async def refs_import(
    file: UploadFile = File(...),
    format: str = Form("ris"),
) -> dict:
    """multipart 上传 .ris/.bib/.enw, 返回统一 Reference 列表。"""
    from ..refio import parse

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        refs = parse(content, format)
        return {"ok": True, "refs": refs}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析失败: {e}"}


@router.post("/api/refs/export")
async def refs_export(req: RefsExportRequest) -> Response:
    """把 Reference 列表导出为 .ris/.bib/.enw 字节流(下载)。"""
    from ..refio import serialize

    try:
        data = serialize(req.refs, req.format)
    except ValueError as e:
        return Response(content=str(e).encode("utf-8"), status_code=400, media_type="text/plain")
    ext = (req.format or "ris").lower()
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename=references.{ext}"},
    )


@router.post("/api/ethics/render")
async def ethics_render(req: EthicsRenderRequest) -> Response:
    """生成伦理材料 .docx 文件(下载)。template ∈ {informed_consent, protocol, crf, data_use_commitment}。"""
    from ..ethics import render as do_render

    try:
        data = do_render(req.template, req.fields or {})
    except ValueError as e:
        return Response(content=str(e).encode("utf-8"), status_code=400, media_type="text/plain")
    except Exception as e:  # noqa: BLE001
        return Response(content=f"生成失败: {e}".encode("utf-8"), status_code=500, media_type="text/plain")

    safe = (req.template or "ethics").replace("/", "_")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename={safe}.docx"},
    )
