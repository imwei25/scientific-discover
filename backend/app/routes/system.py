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


@router.get("/api/health")
async def health() -> dict:
    return {
        "status": "ok",
        "provider": settings.provider,
        "model": settings.model,
        "mock": settings.mock,
        "configured": settings.mock or bool(settings.api_key),
    }


@router.get("/api/usage")
async def usage() -> dict:
    data = await get_balance()
    data["tokens"] = get_session_usage()
    return data


def _is_localhost(request: Request) -> bool:
    """只允许 127.0.0.1 / ::1 调用敏感配置接口。"""
    client = request.client
    if client is None:
        return False
    host = (client.host or "").strip()
    return host in {"127.0.0.1", "::1", "localhost"}


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
