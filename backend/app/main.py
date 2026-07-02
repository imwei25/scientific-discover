"""科研助手本地 sidecar —— FastAPI 服务(装配层)。

前端(Tauri webview)通过 http://127.0.0.1:<PORT> 访问。
端点实现按领域拆在 app/routes/ 下:
  routes/system.py     GET /api/health /api/usage, POST /api/config/*
  routes/text_gen.py   POST /api/run /api/idea* /api/grant* /api/imrad /api/rebuttal
                            /api/deai/* /api/stats/advice (LLM 文本流式)
  routes/analysis_routes.py  POST /api/analyze* /api/extract /api/statcheck
                            /api/sample-size /api/randomize /api/samplesize/sweep
                            /api/flow-diagram /api/figure-captions
  routes/manuscript.py GET /api/journals, POST /api/check-refs /api/format-refs
                            /api/refs/* /api/docx /api/latex /api/bundle
                            /api/readiness /api/journal-match /api/deidentify/*
                            /api/ethics/render
  projects.py          /api/projects* (多项目工作区)
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .http_common import MAX_UPLOAD_BYTES, _read_capped, _sse  # noqa: F401 — 测试与旧代码从 main 导入
from .projects import router as projects_router
from .routes.analysis_routes import router as analysis_router
from .routes.manuscript import router as manuscript_router
from .routes.system import router as system_router
from .routes.text_gen import router as text_gen_router

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

app.include_router(system_router)
app.include_router(text_gen_router)
app.include_router(analysis_router)
app.include_router(manuscript_router)
app.include_router(projects_router)


# 若前端已构建(frontend/dist 存在), 由本服务直接托管, 实现“单进程”部署:
# 用户只需启动本服务并打开浏览器即可, 无需单独的前端服务器。
_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


class _NoCacheHtmlStatic(StaticFiles):
    """入口 index.html 禁用缓存, 其余带内容 hash 的资源(js/css)仍可长缓存。

    解决"更新/pull 后浏览器仍显示旧界面": 入口 HTML 不缓存 → 每次都取到最新的、
    指向新 hash 资源的 index.html; 而 hash 资源名一变就自然 miss, 无需强刷。
    """

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.headers.get("content-type", "").startswith("text/html"):
            resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp


if _DIST.is_dir():
    app.mount("/", _NoCacheHtmlStatic(directory=str(_DIST), html=True), name="static")


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
