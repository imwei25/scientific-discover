"""数据分析类端点: 上传分析、图注、文档抽取、医学图表三件套、统计自查、
样本量/随机化、流程图。重库(pandas/scipy/matplotlib)一律用到时才导入。"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings
from ..http_common import SSE_HEADERS, _read_capped, _sse

router = APIRouter()


class SampleSizeRequest(BaseModel):
    design: str
    params: dict


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


@router.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    question: str = Form(""),
    chart_format: str = Form("png"),
    palette: str = Form("default"),
) -> StreamingResponse:
    """AI 看懂数据 → 写分析代码 → 本地执行 → 流式输出结论(SSE)。"""
    from ..dataanalysis import analyze_data

    content = await _read_capped(file)
    filename = file.filename or "data.csv"

    if content is None:
        async def too_big():
            yield _sse("error", {"message": "文件过大（超过 30MB），请上传更小的数据文件。"})
        return StreamingResponse(too_big(), media_type="text/event-stream")

    async def gen():
        async for event, data in analyze_data(filename, content, question, chart_format, palette):
            yield _sse(event, data)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/figure-captions")
async def figure_captions(req: FigCapRequest) -> dict:
    """为数据分析的每张图生成规范图注(基于代码/输出/结论, 不编造)。"""
    from ..figcaptions import caption

    return await caption(req.model_dump())


@router.post("/api/extract")
async def extract(file: UploadFile = File(...)) -> dict:
    """抽取上传文档(Word/PDF/Excel/CSV/txt)的纯文本, 供分析或润色。"""
    from ..extract import extract_text

    content = await _read_capped(file)
    if content is None:
        return {"ok": False, "error": "文件过大（超过 30MB），请上传更小的文件。"}
    return extract_text(file.filename or "file", content)


@router.post("/api/flow-diagram")
async def flow_diagram(req: FlowRequest) -> dict:
    """确定性绘制 PRISMA 2020 / CONSORT 2025 流程图(本地 matplotlib, 导出 png/svg/pdf)。"""
    from ..flowdiagram import render_flow

    return render_flow(req.kind, req.counts)


@router.post("/api/statcheck")
async def statcheck_ep(req: StatcheckRequest) -> dict:
    """statcheck 式统计一致性自查: LLM 抽取统计量 → scipy 确定性重算 p → 标不一致。"""
    from ..statcheck import check_stats

    return await check_stats(req.text)


@router.post("/api/sample-size")
async def sample_size(req: SampleSizeRequest) -> dict:
    """确定性计算样本量 / 检验效能(不经 LLM, 零额度)。"""
    from ..samplesize import compute

    return compute(req.design, req.params)


@router.post("/api/randomize")
async def randomize_ep(req: SampleSizeRequest) -> dict:
    """确定性生成随机化分组表(简单/置换区组, 固定种子可复现, 零额度)。"""
    from ..randomize import generate

    return generate(req.params)


# ----- 医学图表三件套 -----

class ForestRequest(BaseModel):
    studies: list[dict]
    effect: str = "OR"
    format: str = "png"  # 前端要哪种主图: png/svg/pdf(其余仍随响应附带)


@router.post("/api/analyze/forest")
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

    from ..analysis import forest_plot

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


@router.post("/api/analyze/km")
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

    from ..analysis import km_curve

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


@router.post("/api/analyze/roc")
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

    from ..analysis import roc_curve_plot

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


@router.post("/api/samplesize/sweep")
async def samplesize_sweep(req: SampleSizeSweepRequest) -> dict:
    """单参数 sweep, 返回 [{value, n}, ...]。"""
    from ..samplesize import sweep

    try:
        pts = sweep(req.scenario, req.fixed_params, req.vary, req.range_values)
        return {"ok": True, "points": [{"value": v, "n": n} for v, n in pts]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"sweep 失败: {e}"}
