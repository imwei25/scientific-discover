# 桌面版（路线2：原生 Windows 移植 + Tauri 安装器）

给客户本地部署用的一键安装 exe：本地跑完整 agent 栈（opencode + web 网关 + 技能 + Python 科研环境），
云端只做 LLM 网关（one-api 按 key 管额度 = token 管控/计费/kill switch）。

## 构建（开发机上两步）

```powershell
# ① 组装自包含 bundle（下载便携 Node/嵌入式 Python/PortableGit/pandoc，装科研 Python 栈；
#    国内镜像优先，下载缓存在 desktop\dist\cache，重跑不重下）
powershell -ExecutionPolicy Bypass -File desktop\bundle.ps1

# ② 出 NSIS 安装器（产物在 desktop\launcher\target\release\bundle\nsis\*.exe）
cd desktop\launcher
cargo tauri build
```

> **`bundle.ps1` 读的是【工作区文件】，不是某个 commit。** 组装完之后落地的提交不会进包，
> 而包从外表看不出任何异常——0.1.15 就是这么废掉的（bundle 17:48 组装完，一个 reader.html
> 的修复 18:20 才提交，包里是旧版）。所以：**先把要发的都提交掉、确认 `git status` 干净，
> 再跑 bundle.ps1**；打完顺手核一下包里的文件与工作区一致（例如
> `grep -c <本次改动的特征串> desktop\dist\bundle\app\web\<文件>`）。
>
> **别往 `tauri.conf.json` 里加 `"//"` 注释键。** 那份配置是强校验的（未知字段直接拒），
> 加了之后 `cargo tauri build` 第一步就报
> `error on 'bundle > windows > nsis': ... is not valid under any of the schemas listed in the 'anyOf' keyword`，
> 而这个错误只在真正打包时才暴露 —— 改配置的那次提交看不出任何异常。要写说明就写在这里。
>
> 已经栽过的一处：`bundle.windows.nsis.installerIcon`。它配的是**安装包自己**的图标；
> 上面 `bundle.icon` 只管【应用】的图标，是另一个键。不配的话 NSIS 用自带的通用安装图标，
> 用户下到手的 setup.exe 顶着一个跟产品毫无关系的图标。

## 架构与关键决策

- **进程链**：安装器装到 `%LOCALAPPDATA%\Programs\SciAgent`（per-user，免管理员）。
  启动器（Tauri）→ 便携 `node.exe web/server.mjs`（网关）→ 网关拉起 `opencode serve`。
  就绪后窗口指向 `http://127.0.0.1:27821/`，退出时 `taskkill /T` 清进程树。
- **技能零改动**：23 个技能写死的 `.venv/bin/python` 由 `.venv\bin\`（真实目录，含 exe+dll+
  改向 `_pth`）兜住；`${REPO_ROOT:-/app}` 靠启动器注入 `REPO_ROOT`（正斜杠）+ PortableGit 的
  bash 展开；裸 `python3` 靠 PATH 里的 `.venv\Scripts\python3.exe`。详见技能 POSIX 依赖
  摸底结论（2026-07-28）：16 技能仅需此 shim，peer-review 纯净，硬二进制依赖只有 pandoc。
- **中文图表**：Windows 自带微软雅黑/宋体，`app\matplotlibrc`（`MATPLOTLIBRC` env 指入）
  用 `font.family` 多族列表做逐字形回退。**关键点**：逐字形回退**只在 `font.family` 写多族列表时才有**——
  写成 `font.sans-serif` 列表是没有的（它只取第一个能解析的字体就不再往后找，实测推翻过这个想当然）。
  链里每个字体都得真的装了：没装的不影响渲染，但 matplotlib 会为每次查找往 stderr 刷
  `findfont: Font family 'X' not found.`，实测曾达 41 行/图，agent 很容易误读成故障去"修"。
- **云端接入**：`app\cloud.json`（模板 `cloud.json.example`）→ 启动器注入
  `OC_GATEWAY_URL/OC_GATEWAY_KEY/OC_MODEL` → server.mjs 自动写 opencode provider。
  或者客户直接在界面「模型设置」里填网关地址+key（写 `web/model-config.json`）。
  额度/停用都在云端 one-api 上按 key 操作，客户端不落长期凭据以外的东西。
- **端口**：网关 27821、opencode 27822（避开常见端口；server.mjs 启动自清残留）。

## v1 已知降级（刻意不打包，因为体积）

| 功能 | 状态 | 说明 |
|---|---|---|
| render-docx（论文排版出 docx） | ✅ 完整 | pandoc.exe 已打包 |
| render-pdf-doc（出版级 PDF） | ⚠️ 降级 | 需 xelatex/texlive（数 GB）。脚本会明确报缺依赖；客户机装 [MiKTeX](https://miktex.org/download) 后自动恢复 |
| pptx/doc 在线预览 | ⚠️ 降级 | 需 LibreOffice（数百 MB）。不影响 ppt-master 生成 pptx（纯 Python），只是网关里预览不了、仍可下载；装 LibreOffice 后自动恢复（server.mjs 会探测标准安装路径） |
| fulltext-retrieval 的 PDF 标题护栏 | ⚠️ 轻降级 | 缺 poppler/pdftotext 时按既有降级路径走（代码已 gate） |

## 客户机要求

Win10/11 x64；能上网（LLM 网关 + PubMed/Europe PMC 检索）。不需要管理员权限、不需要预装任何东西
（WebView2 缺失时 NSIS 会自动装）。

## 尚未做（后续硬化方向）

- 登录换短时效 token（现为长期 key 落盘）；云端 kill switch 已天然具备（one-api 停 key）。
- 自动更新（tauri-updater）与技能热更新（从云端拉）。
- IP 保护：技能全明文，护城河在云端网关与持续更新，见主项目讨论。
