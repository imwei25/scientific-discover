# 科研助手

> 📦 **下载安装包（Windows）**：[最新 Release](https://github.com/imwei25/scientific-discover/releases/latest)
> → 下载 `ResearchAssistant_*_x64-setup.exe` 双击安装，无需 Python。
> 首次打开在 `%APPDATA%\科研助手\.env` 填入 `LLM_API_KEY` 即可。
> （开发者发布新版本：设好签名密钥 `$env:TAURI_SIGNING_PRIVATE_KEY_PATH="$env:USERPROFILE\.tauri\research-assistant.key"`，
> `cargo tauri build` 后跑 `scripts\publish-release.ps1`；已装 v0.2.13+ 的用户启动时会收到自动更新提示。）

面向普通（非 IT）科研人员的 AI 科研助手桌面应用。覆盖"选题→投稿"全流程：

| 模块 | 作用 |
|---|---|
| 💡 找选题 | 多源检索真实文献，梳理现状/空白矩阵，给出有文献支撑的候选课题 |
| 🗺️ 实验规划 | 把研究想法变成可执行的实验方案与时间表（含样本量计算器） |
| 📊 数据分析与写作 | 上传数据 → 本地统计分析+出图（PNG/SVG/PDF）→ AI 提炼核心观点、写论文 |
| 📝 论文初稿 | 把已有材料装配成 IMRaD 初稿 + 结构式摘要（只据真实材料、不编造） |
| 🎯 智能选刊 | 用摘要匹配适合投稿的候选期刊（OpenAlex 相似刊聚合） |
| 📄 期刊排版 | 按目标期刊要求重排稿件并导出 Word；参考文献核验/格式化、投稿包 |
| ✅ 报告规范核对 | 按 STROBE/CONSORT/PRISMA/SPIRIT/ARRIVE 逐条自查稿件，标出缺失项 |
| ✍️ 回复审稿 | 拆解审稿意见，逐条生成 point-by-point 回复信（本地处理、数据不出网） |

## 技术架构

```
Tauri 桌面外壳(Rust)  ──加载──▶  前端 (Vite + React + TS)
                                      │ HTTP /api
                                      ▼
                         本地 sidecar (Python FastAPI)
                          · LLM 适配层 (OpenAI/Anthropic 格式 + mock)
                          · 数据分析 (pandas/scipy/matplotlib, 本地执行)
                          · 期刊排版 (python-docx)
```

设计原则：
- **双格式兼容**：通过 `LLM_PROVIDER` 在 OpenAI 兼容格式（DeepSeek / 硅基流动 / OpenAI）与 Anthropic 格式间切换，改 `backend/.env` 一处即可。
- **自动降级**：主供应商余额不足/配额超限时，自动切到 `FALLBACK_*` 配置的备用供应商（如硅基流动）继续，无需人工干预。回归测试见 `backend/test_fallback.py`。
- **不让 LLM 算数字**：数据分析的所有统计量、p 值由本地 Python 计算，AI 仅基于这些既成事实写作。
- **隐私友好**：数据分析在用户本机完成，不上传。

## 目录结构

```
backend/        Python sidecar
  app/
    config.py       读取 .env 配置
    llm.py          LLM 适配层(OpenAI/Anthropic/mock)
    prompts.py      四大模块的提示词构建
    analysis.py     本地数据分析引擎
    formatting.py   Word(.docx) 生成
    journals.py     内置期刊格式规则库
    main.py         FastAPI 入口(也托管已构建的前端)
  selftest.py       LLM 适配层自测
  requirements.txt
  .env.example
frontend/       Vite + React 前端
  src/
    App.tsx
    modules/        四大模块界面
    lib/            SSE 流式 + 运行 hook
    components/
  tests/e2e.spec.ts Playwright 端到端测试(mock 后端)
scripts/        安装与启动脚本
src-tauri/      Tauri 桌面打包(可选)
```

## 快速开始（开发）

一次性安装：

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

配置模型 key：复制 `backend/.env.example` 为 `backend/.env`，填入你的 DeepSeek（或硅基流动 / OpenAI / Anthropic）key。

> 遇到“起不来 / AI 不工作”？双击根目录的 **「检查环境.bat」**（或运行 `backend/.venv/Scripts/python.exe backend/doctor.py`）一键自检：会逐项检查 Python、依赖、`.env`/key、端口，并给出修复建议。

开发模式（前后端分别热更新）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev.ps1
```

单进程模式（先构建前端，由后端一并托管，最接近最终体验）：

```powershell
# 构建前端
cd frontend; npm run build; cd ..
# 启动（随后浏览器打开 http://127.0.0.1:8756）
双击 "启动科研助手.bat"
```

## 测试

像真实用户一样在浏览器里操作；UI 测试把后端 `/api` 用 Playwright route 拦截 mock 掉，保证确定性、零 API 花费：

```powershell
cd frontend
npx playwright install chromium   # 首次需要
npm test
```

LLM 适配层自测（mock 不花钱；real 花极少额度）：

```powershell
cd backend
.venv/Scripts/python.exe selftest.py mock
.venv/Scripts/python.exe selftest.py real
```

## 桌面打包（Tauri）

见 `src-tauri/README.md`。核心思路：用 PyInstaller 把 `backend` 打成单文件 sidecar，Tauri 启动时拉起它，前端通过 `127.0.0.1` 访问。
