"""PyInstaller 打包入口: 启动 sidecar 服务。

打包成单文件 exe 后, Tauri 会在应用启动时拉起它。

例外: 数据分析沙箱需要一个"干净的 python 子进程"来执行 AI 代码, 但打包态下
sys.executable 是本 exe 而非 python 解释器。主进程会用
`kyzs-sidecar.exe --da-runner <runner.py> <data> <code> <out> <fmt> <pal>` 再拉起自身,
命中哨兵时本入口只执行 runner 后退出, 绝不进入 run_server()——否则第二个实例会去抢
已占用的服务端口(8756), 报 [Errno 10048] 并让分析"无结果"。
"""
import sys


def _run_da_runner_and_exit() -> None:
    """打包态数据分析运行器: 执行 runner 脚本后退出, 不启动服务。"""
    runner_path = sys.argv[2]
    # 让 runner 看到的 argv 与开发态 `python runner.py <data> <code> <out> <fmt> <pal>` 完全一致:
    # 去掉本 exe 名与 "--da-runner", 使 argv[1..5] 恰为 data/code/out/fmt/pal。
    sys.argv = sys.argv[2:]
    with open(runner_path, "r", encoding="utf-8") as f:
        src = f.read()
    exec(compile(src, runner_path, "exec"), {"__name__": "__main__", "__file__": runner_path})


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--da-runner":
        _run_da_runner_and_exit()
    else:
        from app.main import run_server

        run_server()
