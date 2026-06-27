"""科研助手 · 环境自检（doctor）。

面向非 IT 用户：当应用起不来 / AI 不工作时，一条命令快速定位问题。
逐项检查并打印 ✓/✗ 与修复建议；关键项有问题时退出码为 1。

运行：
  backend/.venv/Scripts/python.exe backend/doctor.py
或双击仓库根目录的「检查环境.bat」。
"""
from __future__ import annotations

import importlib
import socket
import sys
from pathlib import Path

OK = "[OK]"
BAD = "[X ]"
WARN = "[! ]"

_BACKEND = Path(__file__).resolve().parent


class Report:
    def __init__(self) -> None:
        self.failed = 0

    def ok(self, msg: str) -> None:
        print(f"{OK} {msg}")

    def warn(self, msg: str, hint: str = "") -> None:
        print(f"{WARN} {msg}" + (f"  -> {hint}" if hint else ""))

    def bad(self, msg: str, hint: str = "") -> None:
        self.failed += 1
        print(f"{BAD} {msg}" + (f"  -> {hint}" if hint else ""))


# 关键依赖（缺失则相应功能不可用）。
_DEPS = [
    ("fastapi", "Web 服务"),
    ("uvicorn", "Web 服务器"),
    ("httpx", "调用 LLM/检索"),
    ("dotenv", "读取 .env 配置"),
    ("pandas", "数据分析"),
    ("numpy", "数据分析"),
    ("scipy", "统计"),
    ("matplotlib", "出图"),
    ("pingouin", "统计(效应量/置信区间)"),
    ("statsmodels", "样本量/统计"),
    ("docx", "Word 排版导出"),
    ("citeproc", "参考文献格式化"),
    ("pypdf", "PDF 文本提取"),
]


def _check_python(r: Report) -> None:
    v = sys.version_info
    if v >= (3, 9):
        r.ok(f"Python 版本 {v.major}.{v.minor}.{v.micro}")
    else:
        r.bad(f"Python 版本过低 {v.major}.{v.minor}", "需要 3.9+，请用项目 .venv 的 Python 运行")


def _check_venv(r: Report) -> None:
    # 是否在某个 venv 中（sys.prefix != base_prefix）。
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    venv = _BACKEND / ".venv"
    if in_venv:
        r.ok("正在使用虚拟环境运行")
    elif venv.exists():
        r.warn("未用 .venv 运行（当前是全局/其他 Python）", "请用 backend/.venv/Scripts/python.exe 运行")
    else:
        r.bad("未找到 backend/.venv", "先运行 scripts/setup.ps1 安装依赖")


def _check_deps(r: Report) -> None:
    missing = []
    for mod, _use in _DEPS:
        try:
            importlib.import_module(mod)
        except Exception:  # noqa: BLE001
            missing.append(mod)
    if not missing:
        r.ok(f"核心依赖齐全（{len(_DEPS)} 个）")
    else:
        r.bad(f"缺少依赖：{', '.join(missing)}", "运行 scripts/setup.ps1，或 backend/.venv/Scripts/pip.exe install -r backend/requirements.txt")


def _check_env(r: Report) -> None:
    env_path = _BACKEND / ".env"
    if not env_path.exists():
        r.bad("backend/.env 不存在", "复制 backend/.env.example 为 backend/.env 并填入模型 key")
        return
    r.ok("backend/.env 存在")
    try:
        from app.config import settings
    except Exception as e:  # noqa: BLE001
        r.bad(f"读取配置失败：{e}")
        return
    if settings.mock:
        r.warn("当前为演示模式（MOCK_LLM=true）", "正式使用请在 .env 关闭 MOCK_LLM 并配置 key")
    elif settings.api_key:
        masked = settings.api_key[:4] + "***" if len(settings.api_key) > 4 else "***"
        r.ok(f"已配置 LLM key（{settings.provider} / {settings.model}，{masked}）")
    else:
        r.bad("未配置 LLM_API_KEY 且未开启 MOCK_LLM", "在 backend/.env 填写 LLM_API_KEY（DeepSeek/硅基流动/OpenAI 等）")
    if settings.has_fallback:
        r.ok("已配置备用供应商（主供应商额度用尽可自动降级）")
    else:
        r.warn("未配置备用供应商", "可选：在 .env 配置 FALLBACK_* 以便额度用尽时自动切换")
    return settings


def _check_port(r: Report) -> None:
    try:
        from app.config import settings
        port, host = settings.port, settings.host
    except Exception:
        port, host = 8756, "127.0.0.1"
    bind_host = "0.0.0.0" if host == "0.0.0.0" else "127.0.0.1"
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((bind_host, port))
        r.ok(f"端口 {port} 可用")
    except OSError:
        r.warn(f"端口 {port} 已被占用", "可能服务已在运行；或在 .env 改 PORT 后重启")
    finally:
        s.close()


def main() -> int:
    print("=" * 56)
    print("  科研助手 · 环境自检")
    print("=" * 56)
    r = Report()
    _check_python(r)
    _check_venv(r)
    _check_deps(r)
    _check_env(r)
    _check_port(r)
    print("-" * 56)
    if r.failed == 0:
        print("结论：环境就绪，可以启动科研助手。")
        return 0
    print(f"结论：发现 {r.failed} 个需要处理的问题，请按上面的 -> 提示修复后重试。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
