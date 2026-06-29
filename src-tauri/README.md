# 桌面打包（Tauri）

本目录是把科研助手打包成 Windows 桌面安装包（.exe 安装程序）的 Tauri 工程。

## 工作原理

- Tauri 用系统自带的 WebView2 显示前端（`frontend/dist`）。
- 应用启动时拉起打包好的 Python 后端 sidecar（`binaries/sidecar-*.exe`），前端通过
  `http://127.0.0.1:8756/api` 访问它；退出时自动关闭 sidecar。

> ✅ 本工程已**完整跑通**一次打包：产物 `target\release\bundle\nsis\科研助手_0.1.0_x64-setup.exe`。

## 构建前提

1. **Visual Studio C++ 生成工具（MSVC）** —— Rust 在 Windows 上用 `x86_64-pc-windows-msvc`
   工具链编译，需要 MSVC 链接器。本机**已安装**（VS 生成工具 2026 / MSVC 14.5x，cargo 自动定位，无需手动配 PATH）。
   换机器时：装「Visual Studio Build Tools」，勾选“使用 C++ 的桌面开发”。
2. **Tauri CLI**：`cargo install tauri-cli --version "^2" --locked`（本机已装，命令 `cargo tauri`）。

WebView2 为 Win11 内置，无需安装。

## 一次性素材（已就绪）

- **图标** `icons/`（含 `icon.ico`，已生成）。换 logo：用一张 1024×1024 png 跑
  `cargo tauri icon path\to\logo.png` 重新生成。仓库 `logo.png` 是占位图。
- **sidecar 二进制**：`scripts\build-sidecar.ps1` 生成 `binaries\sidecar-x86_64-pc-windows-msvc.exe`
  （约 140MB，含 scipy/matplotlib/pandas；已 gitignore，不入库，每次打包现打）。

## 构建步骤

```powershell
# 1. 打包后端 sidecar（前端由下面的 tauri build 自动构建）
powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1

# 2. 务必先独立自测 sidecar 能起来（最常见的失败点）
.\src-tauri\binaries\sidecar-x86_64-pc-windows-msvc.exe
#   另开一个窗口： curl http://127.0.0.1:8756/api/health  → 应返回 {"status":"ok"}

# 3. 打包桌面安装程序（首次编译 Rust 约 3 分钟）
cd src-tauri; cargo tauri build
```

产物：`src-tauri\target\release\bundle\nsis\科研助手_<版本>_x64-setup.exe`，
双击即可安装，最终用户无需 Python 或任何依赖。

## 打包时踩过的坑（已修，换环境时注意）

- **前端构建路径**：`tauri.conf.json` 的 `beforeBuildCommand` 用 `npm --prefix frontend run build`
  （Tauri 从**项目根**跑钩子，早期写成 `../frontend` 会多上跳一级导致 ENOENT）。
- **NSIS 打包阶段会从 GitHub 下载** `nsis-3.11.zip` 与 `nsis_tauri_utils.dll`。国内网络可能 `timeout: global`，
  **直接重跑 `cargo tauri build` 即可**（Rust 已缓存，秒进下载步；下好后缓存在 `%LOCALAPPDATA%\tauri\NSIS`）。

## 最终用户怎么填 API key（正式分发关键）

打包版的 `config.py` 在“冻结态(PyInstaller)”下按此顺序找 `.env`：exe 同级目录 → `%APPDATA%\科研助手\.env`；
都没有时会**在 `%APPDATA%\科研助手\.env` 自动生成一份模板**并提示。用户首次打开后，
编辑该文件填入 `LLM_API_KEY` 再重开应用即可（系统环境变量始终优先，便于自用）。

## 不打包也能用

见仓库根目录 `使用说明.md`：双击 `启动科研助手.bat` 走“单进程模式”（需本机有 Python）。
