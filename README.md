# scientific-agent (opencode-agent branch)

自托管科研 Agent 后端验证分支。基于 **OpenCode**（`opencode serve`）+ **DeepSeek**（OpenAI 格式），
复用本目录 `backend/.venv` 里的科学计算环境（pandas/numpy/scipy/matplotlib/scikit-learn 等）作为“技能”。

- Agent 技能：`.opencode/skills/`（`data-analysis` 会调用 `backend/.venv` 的 Python）
- 启动后端：`opencode serve --port 4098`
- 前端：见 `web/`（流式对话 + 文件上传/下载）
- 上传目录 `uploads/`，产出目录 `outputs/`

> 旧的 scientific-discover 产品代码保留在 `main` 分支（提交 cc5fc33）。
