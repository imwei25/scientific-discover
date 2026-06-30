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

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import settings
from .journals import list_journals
from .llm import LLMError, get_balance, get_session_usage, stream_chat
from .prompts import build_messages
from .imrad import assemble_imrad
from .rebuttal import rebuttal
from .research import clarify_topic, deep_research_idea, idea_followup
from .projects import router as projects_router

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

app.include_router(projects_router)


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


@app.post("/api/idea/clarify")
async def idea_clarify(req: RunRequest) -> JSONResponse:
    """检索前澄清: 判断方向是否够具体, 不够则回最多 3 个澄清问题(非流式)。

    任何异常/mock 一律返回 ready=True 放行, 绝不阻塞用户检索。
    """
    if settings.mock:
        return JSONResponse({"ready": True, "questions": []})
    try:
        return JSONResponse(await clarify_topic(req.inputs))
    except Exception:  # noqa: BLE001
        return JSONResponse({"ready": True, "questions": []})


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


# =====================================================================
# Wave 1-A 新增路由(独立功能, 全部支持 mock 模式)
# =====================================================================

# ----- 病例数据脱敏 -----

@app.post("/api/deidentify/scan")
async def deidentify_scan(file: UploadFile = File(...)) -> dict:
    """扫描 csv/xlsx, 返回每列检测到的 PHI 类型与计数。"""
    from .deidentify import scan

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        report = scan(content, file.filename or "data.csv")
        return {"ok": True, **report}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"扫描失败: {e}"}


@app.post("/api/deidentify/apply")
async def deidentify_apply(
    file: UploadFile = File(...),
    columns: str = Form("[]"),
) -> dict:
    """按 columns(JSON 数组字符串) 脱敏, 返回 base64 字节 + 映射表。"""
    from base64 import b64encode

    from .deidentify import apply as do_apply

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

@app.post("/api/refs/import")
async def refs_import(
    file: UploadFile = File(...),
    format: str = Form("ris"),
) -> dict:
    """multipart 上传 .ris/.bib/.enw, 返回统一 Reference 列表。"""
    from .refio import parse

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        refs = parse(content, format)
        return {"ok": True, "refs": refs}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"解析失败: {e}"}


class RefsExportRequest(BaseModel):
    refs: list[dict] = []
    format: str = "ris"


@app.post("/api/refs/export")
async def refs_export(req: RefsExportRequest) -> Response:
    """把 Reference 列表导出为 .ris/.bib/.enw 字节流(下载)。"""
    from .refio import serialize

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


# ----- 医学图表三件套 -----

class ForestRequest(BaseModel):
    studies: list[dict]
    effect: str = "OR"
    format: str = "png"  # 前端要哪种主图: png/svg/pdf(其余仍随响应附带)


@app.post("/api/analyze/forest")
async def analyze_forest(req: ForestRequest) -> dict:
    """森林图(Meta 分析)。返回 image_base64 + summary。

    mock 模式: 直接返回演示数据(不画真图, 返回固定 base64 占位空)。
    """
    if settings.mock:
        return {
            "ok": True,
            "image_base64": "",
            "format": req.format,
            "summary": {"pooled": 0.65, "ci_low": 0.45, "ci_high": 0.93,
                        "i2": 25.3, "q_pvalue": 0.21, "k": len(req.studies) or 3},
            "mock": True,
        }
    from base64 import b64encode

    from .analysis import forest_plot

    try:
        out = forest_plot(req.studies, effect=req.effect or "OR")
        fmt = (req.format or "png").lower()
        if fmt == "svg":
            image_b64 = b64encode(out["svg"].encode("utf-8")).decode("ascii")
        elif fmt == "pdf":
            image_b64 = b64encode(out["pdf"]).decode("ascii")
        else:
            image_b64 = b64encode(out["png"]).decode("ascii")
        return {
            "ok": True,
            "image_base64": image_b64,
            "format": fmt,
            "summary": out["summary"],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"森林图生成失败: {e}"}


@app.post("/api/analyze/km")
async def analyze_km(
    file: UploadFile = File(...),
    time_col: str = Form(...),
    event_col: str = Form(...),
    group_col: str = Form(""),
    format: str = Form("png"),
) -> dict:
    """Kaplan-Meier 曲线。multipart 上传 csv/xlsx + 列名映射。"""
    if settings.mock:
        return {
            "ok": True, "image_base64": "", "format": format, "mock": True,
            "logrank_p": 0.034,
            "groups": [
                {"name": "A", "median_survival": 18.5, "n": 60},
                {"name": "B", "median_survival": 24.3, "n": 60},
            ],
        }
    from base64 import b64encode

    from .analysis import km_curve

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        gc = group_col.strip() or None
        out = km_curve(content, file.filename or "data.csv", time_col, event_col, gc)
        fmt = (format or "png").lower()
        if fmt == "svg":
            image_b64 = b64encode(out["svg"].encode("utf-8")).decode("ascii")
        elif fmt == "pdf":
            image_b64 = b64encode(out["pdf"]).decode("ascii")
        else:
            image_b64 = b64encode(out["png"]).decode("ascii")
        return {
            "ok": True,
            "image_base64": image_b64,
            "format": fmt,
            "logrank_p": out["logrank_p"],
            "groups": out["groups"],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"KM 曲线生成失败: {e}"}


@app.post("/api/analyze/roc")
async def analyze_roc(
    file: UploadFile = File(...),
    y_true_col: str = Form(...),
    y_score_col: str = Form(...),
    format: str = Form("png"),
) -> dict:
    """ROC 曲线 + AUC + bootstrap 95% CI + Youden 最优阈值。"""
    if settings.mock:
        return {
            "ok": True, "image_base64": "", "format": format, "mock": True,
            "auc": 0.84, "auc_ci": [0.78, 0.89], "threshold": 0.51,
        }
    from base64 import b64encode

    from .analysis import roc_curve_plot

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    try:
        out = roc_curve_plot(content, file.filename or "data.csv", y_true_col, y_score_col)
        fmt = (format or "png").lower()
        if fmt == "svg":
            image_b64 = b64encode(out["svg"].encode("utf-8")).decode("ascii")
        elif fmt == "pdf":
            image_b64 = b64encode(out["pdf"]).decode("ascii")
        else:
            image_b64 = b64encode(out["png"]).decode("ascii")
        return {
            "ok": True,
            "image_base64": image_b64,
            "format": fmt,
            "auc": out["auc"],
            "auc_ci": out["auc_ci"],
            "threshold": out["optimal_threshold"],
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"ROC 曲线生成失败: {e}"}


# ----- 样本量扫描 -----

class SampleSizeSweepRequest(BaseModel):
    scenario: str
    fixed_params: dict = {}
    vary: str
    range_values: list[float] = []


@app.post("/api/samplesize/sweep")
async def samplesize_sweep(req: SampleSizeSweepRequest) -> dict:
    """单参数 sweep, 返回 [{value, n}, ...]。"""
    from .samplesize import sweep

    try:
        pts = sweep(req.scenario, req.fixed_params, req.vary, req.range_values)
        return {"ok": True, "points": [{"value": v, "n": n} for v, n in pts]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"sweep 失败: {e}"}


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


@app.post("/api/stats/advice")
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
        return StreamingResponse(mock_gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    from .prompts import build_stats_advice
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

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ----- 伦理材料模板 -----

class EthicsRenderRequest(BaseModel):
    template: str
    fields: dict = {}


# ----- 配置写入 / key 测试 (W2-1 首次配置向导) -----

class TestKeyRequest(BaseModel):
    provider: str
    key: str
    base_url: str | None = None
    model: str | None = None


class SaveConfigRequest(BaseModel):
    provider: str
    key: str
    base_url: str | None = None
    model: str | None = None
    mock: bool = False  # 演示模式: 写 MOCK_LLM=1, 其它字段可空


def _is_localhost(request: Request) -> bool:
    """只允许 127.0.0.1 / ::1 调用敏感配置接口。"""
    client = request.client
    if client is None:
        return False
    host = (client.host or "").strip()
    return host in {"127.0.0.1", "::1", "localhost"}


@app.post("/api/config/test-key")
async def config_test_key(req: TestKeyRequest) -> dict:
    """测试一个 LLM key 是否可用; 返回 {ok, msg}。"""
    from .config_io import test_provider_key

    ok, msg = await test_provider_key(
        req.provider or "",
        req.key or "",
        (req.base_url or ""),
        (req.model or ""),
    )
    return {"ok": ok, "msg": msg}


@app.post("/api/config/save")
async def config_save(req: SaveConfigRequest, request: Request) -> dict:
    """写入 backend/.env 并热重载配置。仅允许 127.0.0.1 调用。"""
    from fastapi.responses import JSONResponse

    if not _is_localhost(request):
        # 用 JSONResponse 返回 403, 不让远端写入 .env
        return JSONResponse(status_code=403, content={"ok": False, "error": "禁止: 仅允许本机访问该接口"})

    from .config_io import PROVIDER_PRESETS, write_env_file

    try:
        updates: dict[str, str] = {}
        if req.mock:
            # 演示模式: 把 MOCK_LLM 打开, key/base_url/model 清空(尊重用户)
            updates["MOCK_LLM"] = "1"
            updates["LLM_API_KEY"] = ""
            # provider / base_url / model 保持上次值
        else:
            preset_key = (req.provider or "").strip().lower()
            preset = PROVIDER_PRESETS.get(preset_key, {})
            updates["MOCK_LLM"] = "0"
            updates["LLM_PROVIDER"] = (preset.get("provider") or "openai")
            updates["LLM_API_KEY"] = (req.key or "").strip()
            updates["LLM_BASE_URL"] = (req.base_url or preset.get("base_url", "")).strip()
            updates["LLM_MODEL"] = (req.model or preset.get("model", "")).strip()

        write_env_file(updates)
        # 热重载, 让运行时立即拿到新值
        settings.reload()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"保存失败: {e}"}


@app.post("/api/ethics/render")
async def ethics_render(req: EthicsRenderRequest) -> Response:
    """生成伦理材料 .docx 文件(下载)。template ∈ {informed_consent, protocol, crf, data_use_commitment}。"""
    from .ethics import render as do_render

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
