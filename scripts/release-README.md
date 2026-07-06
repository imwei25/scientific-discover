# 发布 Windows 版（打包 + 推 GitHub Release）

本机（首次配置于 2026-07-06）已装好全部工具链，日常发布只需 3 步。

## 日常发布（3 步）

1. **对齐版本号**：把 `src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 的 `version`
   改成同一个新版本号（如 `5.0.1`）。两者必须一致，`release.ps1` 会校验。
2. **写发布说明**：在 `scripts/release-notes.md` 顶部加一段本版更新点（面向用户的体验变化）。
3. **一键发布**：
   ```powershell
   powershell -File scripts\release.ps1
   ```
   它会：打 Python sidecar → `cargo tauri build`（带签名）→ 上传安装包 + `latest.json` 到
   GitHub Release（tag = `v<version>`）。

   - 只想本地打包验证、先不上传：`powershell -File scripts\release.ps1 -SkipPublish`
   - sidecar 没改、复用上次的：加 `-SkipSidecar`

## 一次性前置（本机已完成，换机器时重做）

- **Rust + MSVC**：`winget install Rustlang.Rustup` + VS Build Tools（VCTools 工作负载 + Win11 SDK）。
- **Tauri CLI**：`cargo install tauri-cli --version ^2 --locked`（提供 `cargo tauri` 子命令）。
- **GitHub CLI 登录**：`winget install GitHub.cli` 后 **`gh auth login`（需人工交互，一次即可）**。
  > ⚠️ 这一步 AI 无法代做，必须你本人在终端跑一次 `gh auth login`（选 HTTPS、用浏览器授权）。
- **Python 依赖**：`backend/.venv` 已装齐 `requirements.txt` + `pyinstaller`。
- **更新器签名密钥**：`%USERPROFILE%\.tauri\research-assistant.key`，密码存在同目录的
  `research-assistant.key.pw`（不入库；`release.ps1` 自动读取）。
  > 密码**必须非空**：Windows 无法把空字符串环境变量传给子进程（PowerShell `$env:X=""` 等于未设置），
  > 空密码会让 `cargo tauri build` 退回交互式密码提示并在后台挂死。

## ⚠️ 重要：本机的签名密钥是「新」的

发布过 v5.0.0 的原始签名私钥已丢失。本机于 2026-07-06 **重新生成了一对新密钥**，并把
`tauri.conf.json` 里 `plugins.updater.pubkey` 换成了新公钥。

后果：
- **已安装 v3.0.0 ~ v5.0.0 的老用户，自动更新会验签失败**（他们 App 内置的是旧公钥，
  无法验证新密钥签出的包）。他们需要**手动去 Release 页下载新安装包**覆盖安装一次。
- 从本次新版起，**新装/覆盖安装的用户**内置的是新公钥，之后的自动更新恢复正常。

建议在本次 Release 说明里写一句：「老用户请手动下载本安装包覆盖安装，之后即可正常自动更新。」

**务必备份** `%USERPROFILE%\.tauri\research-assistant.key` **和** `research-assistant.key.pw`（异地各留一份）——
私钥或密码任丢一个都签不了更新包，又要重演上面的中断。

## 产物位置

- 安装包：`src-tauri/target/release/bundle/nsis/*_<ver>_x64-setup.exe`
- 上传时会另存一个 ASCII 名 `ResearchAssistant_<ver>_x64-setup.exe`（下载链接更干净）。
- 更新器清单：`latest.json`（App 轮询 `releases/latest/download/latest.json`）。
