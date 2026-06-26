# 桌面打包（Tauri）

本目录是把科研助手打包成 Windows 桌面安装包（.exe 安装程序）的 Tauri 工程。

## 工作原理

- Tauri 用系统自带的 WebView2 显示前端（`frontend/dist`）。
- 应用启动时拉起打包好的 Python 后端 sidecar（`binaries/sidecar-*.exe`），前端通过
  `http://127.0.0.1:8756/api` 访问它；退出时自动关闭 sidecar。

## 构建前提（重要）

本机当前**缺少以下两项**，需先安装才能成功打包：

1. **Visual Studio C++ 生成工具（MSVC）** —— Rust 在 Windows 上用 `x86_64-pc-windows-msvc`
   工具链编译，必须有 MSVC 链接器。下载「Visual Studio Build Tools」，勾选
   “使用 C++ 的桌面开发”。（这是 Tauri 能否编译的关键，本机暂未安装。）
2. **Tauri CLI**：`cargo install tauri-cli --version "^2"`（或 `npm i -g @tauri-apps/cli`）。

WebView2 已具备（本机已检测到），无需额外安装。

## 还需补充的文件

- **图标**：`icons/icon.ico`（及多尺寸 png）。可用一张 1024×1024 的 logo.png 生成：
  `cargo tauri icon path\to\logo.png`
- **sidecar 二进制**：运行 `scripts\build-sidecar.ps1` 生成
  `binaries\sidecar-x86_64-pc-windows-msvc.exe`。
  注意：PyInstaller 打包 scipy/matplotlib/pandas 需要 `--collect-all`（脚本已包含），
  首次打包后请实测 exe 能独立启动（`sidecar.exe` 后访问 `/api/health`）。

## 构建步骤

```powershell
# 1. 构建前端
cd frontend; npm run build; cd ..

# 2. 打包后端 sidecar
powershell -ExecutionPolicy Bypass -File scripts\build-sidecar.ps1

# 3. 生成图标(若还没有)
cargo tauri icon path\to\logo.png

# 4. 打包桌面安装程序
cargo tauri build
```

产物在 `src-tauri\target\release\bundle\nsis\` 下，是一个 `.exe` 安装程序，
双击即可安装，最终用户无需安装 Python 或任何依赖。

## 在装好 MSVC 之前如何使用

无需打包也能完整使用本应用：见仓库根目录 `使用说明.md` 的「单进程模式」——
双击 `启动科研助手.bat` 即可（需本机有 Python，开发者环境已满足）。
