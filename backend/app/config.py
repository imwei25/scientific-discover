"""集中读取环境配置。"""
import os
from pathlib import Path

from dotenv import load_dotenv

# 优先加载 backend/.env, 不存在则使用系统环境变量
_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_ENV_PATH)


def _bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
    """健壮地读取整数环境变量: 空/非法/越界时回退默认值, 避免启动时崩溃。"""
    val = os.getenv(name)
    if val is None or not val.strip():
        return default
    try:
        n = int(val.strip())
    except ValueError:
        return default
    if (lo is not None and n < lo) or (hi is not None and n > hi):
        return default
    return n


class Settings:
    provider: str = os.getenv("LLM_PROVIDER", "openai").strip().lower()
    api_key: str = os.getenv("LLM_API_KEY", "").strip()
    base_url: str = os.getenv("LLM_BASE_URL", "https://api.deepseek.com").strip().rstrip("/")
    model: str = os.getenv("LLM_MODEL", "deepseek-chat").strip()
    mock: bool = _bool("MOCK_LLM", False)
    port: int = _int("PORT", 8756, lo=1, hi=65535)
    # 监听地址：127.0.0.1=仅本机；0.0.0.0=同时允许局域网访问
    host: str = os.getenv("HOST", "127.0.0.1").strip()
    # 可选: 提供给 NCBI E-utilities 的联系邮箱(礼貌且可提高限速容忍度)
    ncbi_email: str = os.getenv("NCBI_EMAIL", "").strip()

    # 备用供应商: 主供应商额度用完(余额不足/配额超限)时自动切换。
    # 留空则不启用自动降级。
    fallback_provider: str = os.getenv("FALLBACK_PROVIDER", "openai").strip().lower()
    fallback_api_key: str = os.getenv("FALLBACK_API_KEY", "").strip()
    fallback_base_url: str = os.getenv("FALLBACK_BASE_URL", "").strip().rstrip("/")
    fallback_model: str = os.getenv("FALLBACK_MODEL", "").strip()

    @property
    def has_fallback(self) -> bool:
        return bool(self.fallback_api_key and self.fallback_base_url and self.fallback_model)


settings = Settings()
