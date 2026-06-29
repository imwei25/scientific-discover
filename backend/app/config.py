"""集中读取环境配置。"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_ENV_TEMPLATE = """# 科研助手配置 —— 填好下面的密钥后保存, 重新打开应用即可。
# 必填: 你的大模型 API key(默认 DeepSeek; 也可换硅基流动/OpenAI 兼容/Claude)。
LLM_API_KEY=
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# 可选: 备用供应商(主供应商额度用尽时自动切换), 不用可留空。
# FALLBACK_API_KEY=
# FALLBACK_BASE_URL=
# FALLBACK_MODEL=

# 可选: 仅本机访问填 127.0.0.1; 想让局域网其它设备访问填 0.0.0.0。
HOST=127.0.0.1
# PORT=8756
"""


def _user_config_dir() -> Path:
    """打包(分发)版的用户配置目录: Windows=%APPDATA%\\科研助手, 其它平台=~/.research-assistant。

    放在用户可写目录而非安装目录(Program Files 需管理员)，重装也不丢配置。
    """
    base = os.getenv("APPDATA")
    if base:
        return Path(base) / "科研助手"
    return Path.home() / ".research-assistant"


def _load_env() -> Path:
    """加载 .env 并返回最终采用的路径。

    - 开发态(源码运行): 用 backend/.env(与历史一致)。
    - 打包态(PyInstaller, sys.frozen): 优先 exe 同级 .env, 其次 %APPDATA%\\科研助手\\.env;
      都没有则在用户配置目录生成一份模板, 提示用户填 key 后重启。
    系统环境变量始终优先(load_dotenv 默认 override=False), 便于自用时用环境变量覆盖。
    """
    frozen = getattr(sys, "frozen", False)
    candidates: list[Path] = []
    if frozen:
        candidates.append(Path(sys.executable).resolve().parent / ".env")
        candidates.append(_user_config_dir() / ".env")
    else:
        candidates.append(Path(__file__).resolve().parent.parent / ".env")

    for p in candidates:
        if p.is_file():
            load_dotenv(p)
            return p

    # 打包态且哪儿都没有 .env: 生成模板, 方便非技术用户填 key。
    if frozen:
        target = _user_config_dir() / ".env"
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(_ENV_TEMPLATE, encoding="utf-8")
            print(f"[config] 已生成配置模板: {target}\n"
                  f"[config] 请在其中填写 LLM_API_KEY 后重新打开应用。", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[config] 无法生成配置模板({target}): {e}", flush=True)
        return target

    return candidates[0]


_ENV_PATH = _load_env()


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
