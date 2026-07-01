"""配置写入 + 在线测试 key 的辅助模块 (W2-1 OnboardingWizard 后端)。

- write_env_file: 安全地原子写入 backend/.env (替换/追加 LLM_PROVIDER/LLM_API_KEY/LLM_BASE_URL/LLM_MODEL)
- test_provider_key: 临时构造 LLM 客户端发一条 ping, 捕获各类网络/鉴权错误, 给中文友好信息
- PROVIDER_PRESETS: 各 provider 的默认 base_url + 推荐 model
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Iterable

import httpx


# .env 位置: 复用 config 已解析好的同一路径, 保证"在线写 key"与"读配置"指向同一文件。
# 开发态 = backend/.env; 打包态(PyInstaller frozen) = %APPDATA%\科研助手\.env。
# 若各自硬编码, 打包版会把 key 写进 PyInstaller 临时解压目录, 而 config 从 %APPDATA% 读 → 在线改 key 不生效。
from .config import _ENV_PATH as ENV_PATH


# ── 各 provider 预设(default base_url + 推荐 model) ──────────────
# 用户在向导里选 provider 时, 前端可拿这个默认值带入, 不必要求用户手填 base_url。
PROVIDER_PRESETS: dict[str, dict[str, str]] = {
    "deepseek": {
        "provider": "openai",  # 兼容 OpenAI /chat/completions 协议
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
    },
    "siliconflow": {
        "provider": "openai",
        "base_url": "https://api.siliconflow.cn/v1",
        "model": "deepseek-ai/DeepSeek-V3",
    },
    "openai": {
        "provider": "openai",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
    },
    "anthropic": {
        "provider": "anthropic",
        "base_url": "https://api.anthropic.com",
        "model": "claude-3-5-sonnet-latest",
    },
}


# 我们管理的 .env 键集合; 写入时只替换这些键, 其它键(NCBI_EMAIL 等)原样保留。
_MANAGED_KEYS = ("LLM_PROVIDER", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "MOCK_LLM")


def _format_env_value(v: str) -> str:
    """对值做最小化引用: 含空格/特殊字符时加双引号, 内部双引号转义。"""
    if v == "":
        return ""
    if any(c in v for c in [" ", "\t", "#", "'", "\"", "$", "\\"]):
        escaped = v.replace("\\", "\\\\").replace("\"", "\\\"")
        return f"\"{escaped}\""
    return v


def write_env_file(
    updates: dict[str, str],
    env_path: Path | None = None,
) -> None:
    """原子写入 .env: 替换 updates 里的键, 没有的就追加, 其它键保持原样。

    参数:
        updates: 要写入的键值对 (例如 {"LLM_PROVIDER": "openai", "LLM_API_KEY": "sk-xxx"})。
                 值为空字符串时, 该行会被删除(等价于"取消该键")。
        env_path: 可选, 测试时用 tmp 路径; 默认 backend/.env。
    """
    path = env_path or ENV_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    # 1. 读取现有内容(行级保留注释/空行)
    existing_lines: list[str] = []
    if path.exists():
        existing_lines = path.read_text(encoding="utf-8").splitlines()

    keys_to_write = {k: v for k, v in updates.items() if k.strip()}
    seen_keys: set[str] = set()
    new_lines: list[str] = []

    for line in existing_lines:
        stripped = line.lstrip()
        # 注释 / 空行原样保留
        if not stripped or stripped.startswith("#"):
            new_lines.append(line)
            continue
        # 解析 KEY=...
        if "=" not in stripped:
            new_lines.append(line)
            continue
        k = stripped.split("=", 1)[0].strip()
        if k in keys_to_write:
            seen_keys.add(k)
            v = keys_to_write[k]
            if v == "":
                # 空值 = 删除该行
                continue
            new_lines.append(f"{k}={_format_env_value(v)}")
        else:
            new_lines.append(line)

    # 2. 没出现过的 key 追加在末尾
    for k, v in keys_to_write.items():
        if k in seen_keys or v == "":
            continue
        new_lines.append(f"{k}={_format_env_value(v)}")

    # 3. 原子写入(先写 tmp 再 rename, 避免半截文件)
    body = "\n".join(new_lines).rstrip() + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


async def test_provider_key(
    provider: str,
    api_key: str,
    base_url: str = "",
    model: str = "",
    timeout: float = 10.0,
) -> tuple[bool, str]:
    """临时构造 LLM 客户端, 发一条 ping 消息, 返回 (ok, 中文消息)。

    - 401/403: key 无效
    - 402/429: 余额/配额相关
    - 超时 / 连接失败: 网络问题
    - 其它非 200: 返回上游消息片段
    """
    provider_id = (provider or "").strip().lower()
    api_key = (api_key or "").strip()
    if not api_key:
        return False, "未填写 API key"

    # 从预设解析 协议/base_url/model, 与 /api/config/save 保持一致。
    # 关键: 前端"测试连接"通常只传 provider+key(base_url 选填、不传 model),
    # 必须按 provider 取预设 base_url; 否则会拿默认值把 硅基流动/OpenAI 的 key
    # 打到 DeepSeek 端点上 → 一律 401 假失败(历史 bug)。
    preset = PROVIDER_PRESETS.get(provider_id, {})
    # 协议(openai 兼容 / anthropic): 优先预设; 未知供应商按 id 兜底
    protocol = (preset.get("provider") or ("anthropic" if provider_id == "anthropic" else "openai")).strip().lower()
    base = (base_url or preset.get("base_url") or "").strip()
    model = (model or preset.get("model") or "").strip()

    if protocol == "anthropic":
        base = base or "https://api.anthropic.com"
        url = base.rstrip("/") + "/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model or "claude-3-5-sonnet-latest",
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
        }
    else:
        # openai 兼容协议。已知 provider 的 base 已由预设解析; 未知且无 base 则
        # 拒绝猜测端点(避免把 key 打到错误服务上导致误报), 提示补 base_url。
        if not base:
            return False, "未知供应商且未填写 base_url, 无法确定测试端点, 请在高级里填写 base_url"
        url = base.rstrip("/") + "/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model or "deepseek-chat",
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
        }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException:
        return False, "请求超时(网络较慢或服务不可达), 请检查网络后重试"
    except httpx.ConnectError as e:
        return False, f"无法连接到服务({e.__class__.__name__}), 请检查 base_url 与网络"
    except httpx.RequestError as e:
        return False, f"网络请求失败({e.__class__.__name__})"
    except Exception as e:  # noqa: BLE001
        return False, f"测试失败: {e}"

    code = resp.status_code
    if code == 200:
        return True, "连接成功"
    if code in (401, 403):
        return False, "key 无效或未授权(401/403), 请检查 key 是否正确"
    if code == 402:
        return False, "余额不足(402), 请充值后重试"
    if code == 429:
        return False, "请求过于频繁或配额耗尽(429), 请稍后重试"

    body = ""
    try:
        body = resp.text[:200]
    except Exception:  # noqa: BLE001
        body = ""
    return False, f"上游返回 {code}: {body}"
