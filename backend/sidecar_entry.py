"""PyInstaller 打包入口: 启动 sidecar 服务。

打包成单文件 exe 后, Tauri 会在应用启动时拉起它。
"""
from app.main import run_server

if __name__ == "__main__":
    run_server()
