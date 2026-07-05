"""系统与配置端点: 健康检查、额度用量、首次配置向导的 key 测试/写入。"""
from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..config import settings
from ..llm import get_balance, get_session_usage

router = APIRouter()


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


class SaveVlmConfigRequest(BaseModel):
    """视觉模型(VLM)配置: 用于「学术海报」排版审阅。留空 key 视为清除(停用 VLM)。"""
    provider: str = "openai"
    key: str = ""
    base_url: str | None = None
    model: str | None = None


@router.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "provider": settings.provider,
        "model": settings.model,
        "mock": settings.mock,
        "configured": settings.mock or bool(settings.api_key),
        "vlm_configured": settings.has_vlm,
        "vlm_model": settings.vlm_model,
    }


@router.get("/api/usage")
async def usage() -> dict:
    data = await get_balance()
    data["tokens"] = get_session_usage()
    # mock 模式下不打真实 API, balance 恒为 0 / available=false; 显式标注避免用户误判"额度耗尽"
    if settings.mock:
        data["mock"] = True
        data["notice"] = "演示模式：未调用真实 LLM，无额度/用量数据。请配置真实密钥后才有真实统计。"
    return data


def _is_localhost(request: Request) -> bool:
    """只允许 127.0.0.1 / ::1 调用敏感配置接口。"""
    client = request.client
    if client is None:
        return False
    host = (client.host or "").strip()
    return host in {"127.0.0.1", "::1", "localhost"}


@router.get("/api/config/stages")
async def config_stages() -> dict:
    """列出每个环节(stage)当前生效的模型, 便于核对 LLM_STAGE_* 配置。不回传 key。"""
    from ..llm import STAGES

    items = []
    for key, label in STAGES.items():
        ov = settings.stage_override(key) or {}
        items.append({
            "stage": key,
            "label": label,
            "provider": ov.get("provider") or settings.provider,
            "model": ov.get("model") or settings.model,
            "base_url": ov.get("base_url") or settings.base_url,
            "overridden": bool(ov),
        })
    # 配置了覆盖但不在注册表里的环节键(多半是拼写错误或 /api/run 的模块名)也列出来。
    unknown = sorted(s for s in settings.stage_overrides if s not in STAGES)
    return {"items": items, "unknown_stages": unknown}


@router.post("/api/config/test-key")
async def config_test_key(req: TestKeyRequest) -> dict:
    """测试一个 LLM key 是否可用; 返回 {ok, msg}。"""
    from ..config_io import test_provider_key

    ok, msg = await test_provider_key(
        req.provider or "",
        req.key or "",
        (req.base_url or ""),
        (req.model or ""),
    )
    return {"ok": ok, "msg": msg}


@router.post("/api/config/save")
async def config_save(req: SaveConfigRequest, request: Request) -> dict:
    """写入 backend/.env 并热重载配置。仅允许 127.0.0.1 调用。"""
    from fastapi.responses import JSONResponse

    if not _is_localhost(request):
        # 用 JSONResponse 返回 403, 不让远端写入 .env
        return JSONResponse(status_code=403, content={"ok": False, "error": "禁止: 仅允许本机访问该接口"})

    from ..config_io import PROVIDER_PRESETS, write_env_file

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
            new_key = (req.key or "").strip()
            # 防护: 空 key 会把用户已配的真实 key 静默清除, 拒绝该操作.
            # 若用户想切换到"演示模式", 应显式发 mock:true.
            if not new_key:
                return {
                    "ok": False,
                    "error": "API key 不能为空。若想暂时不配 key, 请选择「演示模式」(mock:true)。",
                }
            # 防护: preset 未识别的 provider 会把 base_url/model 写成空串, 破坏配置.
            if not preset:
                return {
                    "ok": False,
                    "error": f"未知的供应商「{req.provider}」。请从下拉选一个已支持的供应商(deepseek/siliconflow/openai/anthropic 等)。",
                }
            updates["MOCK_LLM"] = "0"
            updates["LLM_PROVIDER"] = (preset.get("provider") or "openai")
            updates["LLM_API_KEY"] = new_key
            updates["LLM_BASE_URL"] = (req.base_url or preset.get("base_url", "")).strip()
            updates["LLM_MODEL"] = (req.model or preset.get("model", "")).strip()

        write_env_file(updates)
        # 热重载, 让运行时立即拿到新值
        settings.reload()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "保存失败, 请确认 backend/.env 可写入。", "detail": f"{type(e).__name__}: {e}"}


@router.post("/api/config/save-vlm")
async def config_save_vlm(req: SaveVlmConfigRequest, request: Request) -> dict:
    """写入视觉模型(VLM)配置到 .env 并热重载。仅允许 127.0.0.1 调用。

    key 留空 = 清除 VLM 配置(停用海报排版审阅)。
    """
    from fastapi.responses import JSONResponse

    if not _is_localhost(request):
        return JSONResponse(status_code=403, content={"ok": False, "error": "禁止: 仅允许本机访问该接口"})

    from ..config_io import PROVIDER_PRESETS, write_env_file

    try:
        key = (req.key or "").strip()
        if not key:
            # 清除: 三个键置空(write_env_file 空值=删除该行)
            write_env_file({"VLM_API_KEY": "", "VLM_BASE_URL": "", "VLM_MODEL": "", "VLM_PROVIDER": ""})
            settings.reload()
            return {"ok": True, "cleared": True}
        preset = PROVIDER_PRESETS.get((req.provider or "").strip().lower(), {})
        # 防护: 未知 provider 会把 VLM_BASE_URL/MODEL 写成空串, 后续调用必 401
        if not preset:
            return {
                "ok": False,
                "error": f"未知的视觉模型供应商「{req.provider}」。请从预设列表中选择。",
            }
        write_env_file({
            "VLM_PROVIDER": (preset.get("provider") or "openai"),
            "VLM_API_KEY": key,
            "VLM_BASE_URL": (req.base_url or preset.get("base_url", "")).strip(),
            "VLM_MODEL": (req.model or "").strip(),
        })
        settings.reload()
        return {"ok": True, "vlm_configured": settings.has_vlm}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "保存失败, 请确认 backend/.env 可写入。", "detail": f"{type(e).__name__}: {e}"}
