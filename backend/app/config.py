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
LLM_MODEL=deepseek-v4-flash

# 可选: 备用供应商(主供应商额度用尽时自动切换), 不用可留空。
# FALLBACK_API_KEY=
# FALLBACK_BASE_URL=
# FALLBACK_MODEL=

# 可选: 视觉模型(VLM), 用于「学术海报」的排版审阅(看渲染出的海报图找排版问题)。
# DeepSeek 无视觉能力, 需配一个多模态模型, 例如硅基流动的 GLM-4.5V / Qwen-VL。留空则不启用。
# VLM_API_KEY=
# VLM_BASE_URL=https://api.siliconflow.cn/v1
# VLM_MODEL=THUDM/GLM-4.1V-9B-Thinking
# VLM_PROVIDER=openai

# 可选: 按环节使用不同模型(不配则所有环节都用上面的默认模型)。
# 环节键与当前生效配置可访问 http://127.0.0.1:8756/api/config/stages 查看。
# 例: 让「标书评审」用推理模型, 其余环节不变:
# LLM_STAGE_GRANT_REVIEW_MODEL=deepseek-reasoner
# 该环节还可单独指定服务商(不填则沿用主配置的 key 与地址):
# LLM_STAGE_GRANT_REVIEW_BASE_URL=
# LLM_STAGE_GRANT_REVIEW_API_KEY=
# LLM_STAGE_GRANT_REVIEW_PROVIDER=

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
            # Notepad 保存的 .env 常含 UTF-8 BOM (\ufeff), 导致 dotenv 解析出的第一个 key
            # 变成 "\ufeffLLM_MODEL" 而非 "LLM_MODEL", 沉默回退到默认 model, 用户"填了 key
            # 却报 401"排查困难. 检测到 BOM 时先剥离并写回, 再加载.
            try:
                raw = p.read_bytes()
                if raw.startswith(b"\xef\xbb\xbf"):
                    p.write_bytes(raw[3:])
            except Exception:  # noqa: BLE001
                pass
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


# 出厂内置默认供应商(硅基流动): 打包版随 exe 附带一把 key, 让客户不配任何 key 也能开箱即用。
# 该模块被 .gitignore 忽略、只存在于打包机器上(公开仓库里没有它), 缺失时降级为"无内置默认"。
try:
    from .default_provider import DEFAULT_LLM as _BUNDLED_LLM  # type: ignore
except Exception:  # noqa: BLE001  源码仓库/CI 上没有该文件 → 无内置默认
    _BUNDLED_LLM = None


def _bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


# 每环节模型覆盖: LLM_STAGE_<环节大写>_MODEL / _API_KEY / _BASE_URL / _PROVIDER。
# 环节键即 llm.stream_chat(task=...) 传入的标识(如 GRANT_REVIEW → grant_review)。
_STAGE_PREFIX = "LLM_STAGE_"
# 后缀按长度降序匹配, 避免 _API_KEY 被 _MODEL 之类误切。
_STAGE_SUFFIXES = ("_API_KEY", "_BASE_URL", "_PROVIDER", "_MODEL")


def _parse_stage_overrides() -> dict[str, dict[str, str]]:
    """从环境变量收集每环节的模型覆盖; 只有配了 _MODEL 的环节才生效。"""
    raw: dict[str, dict[str, str]] = {}
    for key, val in os.environ.items():
        if not key.startswith(_STAGE_PREFIX) or not val.strip():
            continue
        rest = key[len(_STAGE_PREFIX):]
        for suf in _STAGE_SUFFIXES:
            if rest.endswith(suf) and len(rest) > len(suf):
                stage = rest[: -len(suf)].lower()
                raw.setdefault(stage, {})[suf[1:].lower()] = val.strip()
                break
    return {s: v for s, v in raw.items() if v.get("model")}


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
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        """重新从 backend/.env(或系统环境变量)读取配置。"""
        # 重新加载 .env 文件; override=True 让最新值覆盖旧的 process env
        load_dotenv(_ENV_PATH, override=True)
        self.provider = os.getenv("LLM_PROVIDER", "openai").strip().lower()
        self.api_key = os.getenv("LLM_API_KEY", "").strip()
        self.base_url = os.getenv("LLM_BASE_URL", "https://api.deepseek.com").strip().rstrip("/")
        self.model = os.getenv("LLM_MODEL", "deepseek-v4-flash").strip()
        self.mock = _bool("MOCK_LLM", False)

        # 出厂默认: 客户没在设置里填自己的 LLM_API_KEY 时, 套用打包内置的硅基流动 key,
        # 让应用开箱即用(作主供应商)。客户一旦填了自己的 key(env 非空), 就走客户自己的,
        # 这里不覆盖。provider/base_url/model 一并取内置默认(否则会拿 DeepSeek 的默认地址,
        # 把硅基流动 key 打到 DeepSeek 端点 → 401)。
        self.using_bundled_key = False
        if not self.api_key and not self.mock and _BUNDLED_LLM and _BUNDLED_LLM.get("api_key"):
            self.provider = (_BUNDLED_LLM.get("provider") or "openai").strip().lower()
            self.api_key = _BUNDLED_LLM["api_key"].strip()
            self.base_url = (_BUNDLED_LLM.get("base_url") or "").strip().rstrip("/")
            self.model = (_BUNDLED_LLM.get("model") or "").strip()
            self.using_bundled_key = True
        self.port = _int("PORT", 8756, lo=1, hi=65535)
        # 监听地址：127.0.0.1=仅本机；0.0.0.0=同时允许局域网访问
        self.host = os.getenv("HOST", "127.0.0.1").strip()
        # 可选: 提供给 NCBI E-utilities 的联系邮箱(礼貌且可提高限速容忍度)
        self.ncbi_email = os.getenv("NCBI_EMAIL", "").strip()

        # 备用供应商: 主供应商额度用完(余额不足/配额超限)时自动切换。
        # 留空则不启用自动降级。
        self.fallback_provider = os.getenv("FALLBACK_PROVIDER", "openai").strip().lower()
        self.fallback_api_key = os.getenv("FALLBACK_API_KEY", "").strip()
        self.fallback_base_url = os.getenv("FALLBACK_BASE_URL", "").strip().rstrip("/")
        self.fallback_model = os.getenv("FALLBACK_MODEL", "").strip()

        # 每环节模型覆盖(LLM_STAGE_*): stage → {model, api_key?, base_url?, provider?}。
        # 缺省字段沿用主配置; 用于让"标书评审"等环节走另一个(如推理/异构)模型。
        self.stage_overrides = _parse_stage_overrides()

        # 视觉模型(VLM): 用于「学术海报」排版审阅。纯文本主模型(如 DeepSeek)看不了图,
        # 需单独配一个多模态模型(硅基流动 GLM-4.5V / Qwen-VL 等, OpenAI 兼容)。留空不启用。
        self.vlm_provider = os.getenv("VLM_PROVIDER", "openai").strip().lower()
        self.vlm_api_key = os.getenv("VLM_API_KEY", "").strip()
        self.vlm_base_url = os.getenv("VLM_BASE_URL", "").strip().rstrip("/")
        self.vlm_model = os.getenv("VLM_MODEL", "").strip()

    def stage_override(self, task: str | None) -> dict[str, str] | None:
        """取某环节的模型覆盖配置; 未配置返回 None。"""
        if not task:
            return None
        return self.stage_overrides.get(task.strip().lower())

    @property
    def has_fallback(self) -> bool:
        return bool(self.fallback_api_key and self.fallback_base_url and self.fallback_model)

    @property
    def has_vlm(self) -> bool:
        return bool(self.vlm_api_key and self.vlm_base_url and self.vlm_model)


settings = Settings()
