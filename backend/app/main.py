"""科研助手本地 sidecar —— FastAPI 服务。

前端(Tauri webview)通过 http://127.0.0.1:<PORT> 访问。
端点:
  GET  /api/health      健康检查
  GET  /api/journals    期刊列表
  POST /api/run         文本类模块流式输出(找idea/实验规划/写作/排版)
  POST /api/analyze     上传数据 -> 本地统计分析(返回 JSON)
  POST /api/docx        把重排文本生成 Word 文件下载
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import settings
from .journals import list_journals
from .llm import LLMError, get_balance, get_session_usage, stream_chat
from .prompts import build_messages
from .imrad import assemble_imrad
from .rebuttal import rebuttal
from .research import deep_research_idea, idea_followup

# 说明: 依赖 pandas/scipy/matplotlib/citeproc/python-docx 等重库的模块
# (dataanalysis / extract / citations / formatting) 改为"用到时才导入",
# 让服务能秒级绑定端口、健康检查立即可用; 重库在首次实际使用相应功能时才加载。

app = FastAPI(title="科研助手 sidecar", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    module: str
    inputs: dict


class DocxRequest(BaseModel):
    text: str
    journal_id: str = ""
    references: list[str] = []


class RefsRequest(BaseModel):
    references: str
    journal_id: str = ""


class SampleSizeRequest(BaseModel):
    design: str
    params: dict


class MatchRequest(BaseModel):
    abstract: str


class StatcheckRequest(BaseModel):
    text: str


class FlowRequest(BaseModel):
    kind: str = "prisma"
    counts: dict = {}


class FigCapRequest(BaseModel):
    count: int = 0
    question: str = ""
    code: str = ""
    output: str = ""
    conclusion: str = ""


class BundleFile(BaseModel):
    name: str
    content: str


class BundleRequest(BaseModel):
    files: list[BundleFile] = []   # 文本/Markdown 原样写入
    docx: list[BundleFile] = []    # 用 build_docx 转成 Word 写入


@app.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "provider": settings.provider,
        "model": settings.model,
        "mock": settings.mock,
        "configured": settings.mock or bool(settings.api_key),
    }


@app.get("/api/journals")
async def journals() -> dict:
    return {"journals": list_journals()}


@app.get("/api/usage")
async def usage() -> dict:
    data = await get_balance()
    data["tokens"] = get_session_usage()
    return data


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# 上传大小上限(与前端 Dropzone 一致); 后端再设一道, 防 LAN/直连绕过前端导致 OOM。
MAX_UPLOAD_BYTES = 30 * 1024 * 1024


async def _read_capped(file: UploadFile, limit: int | None = None) -> bytes | None:
    """分块读取上传文件, 超过 limit 立即停止并返回 None(不把超大文件整个读入内存)。"""
    lim = MAX_UPLOAD_BYTES if limit is None else limit
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > lim:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/api/run")
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

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/idea")
async def idea(req: RunRequest) -> StreamingResponse:
    """医学/药学/生物 找选题: 检索 PubMed + 分析现状/空白/选题(带文献链接)。"""
    async def gen():
        async for event, data in deep_research_idea(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/imrad")
async def imrad_ep(req: RunRequest) -> StreamingResponse:
    """IMRaD 初稿装配: 把已有材料分段拼成 Intro/Methods/Results/Discussion(本地, 只据材料)。"""
    async def gen():
        async for event, data in assemble_imrad(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/rebuttal")
async def rebuttal_ep(req: RunRequest) -> StreamingResponse:
    """回复审稿意见: 拆解意见 → 逐条生成 point-by-point 回复信(本地处理, 数据不出网)。"""
    async def gen():
        async for event, data in rebuttal(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/idea-followup")
async def idea_followup_ep(req: RunRequest) -> StreamingResponse:
    """对已生成的找选题报告追问 / 按意见修改(基于回传的真实文献, 不重新检索)。"""
    async def gen():
        async for event, data in idea_followup(req.inputs):
            yield _sse(event, data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    question: str = Form(""),
    chart_format: str = Form("png"),
    palette: str = Form("default"),
) -> StreamingResponse:
    """AI 看懂数据 → 写分析代码 → 本地执行 → 流式输出结论(SSE)。"""
    from .dataanalysis import analyze_data

    content = await _read_capped(file)
    filename = file.filename or "data.csv"

    if content is None:
        async def too_big():
            yield _sse("error", {"message": "文件过大（超过 30MB），请上传更小的数据文件。"})
        return StreamingResponse(too_big(), media_type="text/event-stream")

    async def gen():
        async for event, data in analyze_data(filename, content, question, chart_format, palette):
            yield _sse(event, data)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/figure-captions")
async def figure_captions(req: FigCapRequest) -> dict:
    """为数据分析的每张图生成规范图注(基于代码/输出/结论, 不编造)。"""
    from .figcaptions import caption

    return await caption(req.model_dump())


@app.post("/api/extract")
async def extract(file: UploadFile = File(...)) -> dict:
    """抽取上传文档(Word/PDF/Excel/CSV/txt)的纯文本, 供分析或润色。"""
    from .extract import extract_text

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    return extract_text(file.filename or "file", content)


@app.post("/api/check-refs")
async def check_refs(req: RefsRequest) -> dict:
    """参考文献核验: DOI 真实性 / 撤稿 / 去重 / 补全(确定性网络核验 + 一次 LLM 解析)。"""
    from .refcheck import check_references

    return await check_references(req.references)


@app.post("/api/flow-diagram")
async def flow_diagram(req: FlowRequest) -> dict:
    """确定性绘制 PRISMA 2020 / CONSORT 2025 流程图(本地 matplotlib, 导出 png/svg/pdf)。"""
    from .flowdiagram import render_flow

    return render_flow(req.kind, req.counts)


@app.post("/api/statcheck")
async def statcheck_ep(req: StatcheckRequest) -> dict:
    """statcheck 式统计一致性自查: LLM 抽取统计量 → scipy 确定性重算 p → 标不一致。"""
    from .statcheck import check_stats

    return await check_stats(req.text)


@app.post("/api/journal-match")
async def journal_match(req: MatchRequest) -> dict:
    """智能选刊: 用摘要在 OpenAlex 检索相近文献, 聚合期刊排序 + LLM 给匹配理由。"""
    from .journalmatch import match_journals

    return await match_journals(req.abstract)


@app.post("/api/format-refs")
async def format_refs(req: RefsRequest) -> dict:
    """按目标期刊的 CSL 样式格式化参考文献(LLM 解析 + citeproc 渲染)。"""
    from .citations import format_references

    return await format_references(req.references, req.journal_id)


@app.post("/api/sample-size")
async def sample_size(req: SampleSizeRequest) -> dict:
    """确定性计算样本量 / 检验效能(不经 LLM, 零额度)。"""
    from .samplesize import compute

    return compute(req.design, req.params)


@app.post("/api/randomize")
async def randomize_ep(req: SampleSizeRequest) -> dict:
    """确定性生成随机化分组表(简单/置换区组, 固定种子可复现, 零额度)。"""
    from .randomize import generate

    return generate(req.params)


def _safe_name(name: str) -> str:
    """清理 zip 内文件名, 防路径穿越。"""
    n = (name or "file").replace("\\", "/").split("/")[-1].strip()
    return n or "file"


@app.post("/api/bundle")
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
            from .formatting import build_docx
            for f in req.docx:
                if f.content and f.content.strip():
                    z.writestr(_safe_name(f.name), build_docx(f.content, "", []))
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=research-package.zip"},
    )


@app.post("/api/docx")
async def docx(req: DocxRequest) -> Response:
    from .formatting import build_docx

    data = build_docx(req.text, req.journal_id, req.references)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": "attachment; filename=manuscript.docx"},
    )


# 若前端已构建(frontend/dist 存在), 由本服务直接托管, 实现“单进程”部署:
# 用户只需启动本服务并打开浏览器即可, 无需单独的前端服务器。
_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="static")


def _lan_ip() -> str:
    import socket

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # 不会真的发包, 仅用于取本机出口 IP
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return ""


def _log(msg: str) -> None:
    import datetime

    # 仅打印到 stdout; 由启动脚本把 stdout/stderr 重定向到 backend/server.log,
    # 这样连"导入期"的报错也能一并捕获(那时本函数还没机会写文件)。
    print(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def run_server():
    import platform
    import sys
    import traceback

    try:
        _log(f"启动科研助手后端… Python {sys.version.split()[0]} on {platform.system()} {platform.release()}")
        _log(f"工作目录: {Path.cwd()}")
        _log(f"配置: host={settings.host} port={settings.port} mock={settings.mock} "
             f"provider={settings.provider} model={settings.model} "
             f"api_key={'已配置' if settings.api_key else '未配置'}")
        _log(f"前端已构建(dist 存在): {_DIST.is_dir()} -> {_DIST}")
        if not settings.api_key and not settings.mock:
            _log("警告: 未配置 LLM_API_KEY 且未开启 MOCK_LLM, AI 功能将不可用(但服务仍会启动)。")

        port = settings.port
        lines = ["=" * 56, f"  本机访问:   http://127.0.0.1:{port}"]
        if settings.host == "0.0.0.0":
            ip = _lan_ip()
            if ip:
                lines.append(f"  局域网访问: http://{ip}:{port}  （同一网络的其他设备可用）")
            lines.append("  注意: 已开放局域网, 任何同网设备都能使用你的 API 额度。")
        lines.append("=" * 56)
        print("\n".join(lines), flush=True)

        import uvicorn

        _log(f"开始监听 {settings.host}:{port} …")
        uvicorn.run(app, host=settings.host, port=port, log_level="info")
        _log("服务已正常退出。")
    except Exception:  # noqa: BLE001
        _log("启动失败! 错误详情如下:\n" + traceback.format_exc())
        _log("请把 backend\\server.log 的内容发给开发者以便定位。")
        raise


if __name__ == "__main__":
    run_server()
