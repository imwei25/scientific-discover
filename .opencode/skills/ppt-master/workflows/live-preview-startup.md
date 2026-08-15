# Live Preview Auto-Startup (Step 6 detail)

> Loaded **on demand**. **In every shipped deployment this whole path is disabled** —
> the editor binds `127.0.0.1:5050` inside the container while only 3000 is published, and
> flask is deliberately not installed (`packaging/requirements.txt`). Retained for other
> deployments and for `workflows/live-preview.md`, which owns the annotation/edit flow.

---

**Live Preview Auto-Startup (Mandatory)**: before the first SVG, automatically start the browser editor in live mode and keep it running continuously through Executor + Step 7 export:
```bash
python3 ${SKILL_DIR}/scripts/svg_editor/server.py <project_path> --live --daemon
```
> 🛑 **本部署（Web 容器）覆盖规则 —— 本小节整体停用：不要执行上面这条命令。**
> 该编辑器绑定的是**容器内**的 `127.0.0.1:5050`，而容器只对外发布 3000 端口 ——
> 用户浏览器里的 `localhost:5050` 指向的是用户自己的电脑，**没有任何人能打开它**。
> 唯一还能用到这个服务的是 `visual_review.py`（AI 逐页看图自查），但它另需
> playwright + chromium（实测 +1.00 GB 镜像体积），本部署也未安装，故整条链路停用。
> 因此在本部署里：
> - **不要**启动 `svg_editor/server.py`（本部署未装 flask，启动也只会 ModuleNotFoundError）；
> - **不要**向用户播报任何 `localhost:5050` 地址或"实时预览已就绪 / 可以在浏览器里编辑"之类的话
>   —— 那是个永远打不开的链接，只会让用户以为是自己网络有问题；
> - **不要**因为预览缺失就停下来问用户或反复排查 —— 直接继续生成 SVG，这不是错误状态。
>
> **替代做法**：用户想看效果 → 引导其在界面"产出"侧栏下载 Step 7 导出的 `.pptx`；
> 用户想改 → 让其在**对话里**直接描述（"第 3 页标题改成 X"），你直接编辑 `svg_output/`
> 下对应的 SVG 后重新导出。下面关于"保持服务运行 / 应用注解"的条目在本部署里一并失效。

下面四条在本部署【全部不适用】，保留仅为说明其它部署的原始行为——尤其前两条与上面的覆盖规则
直接冲突（它们要求"把 URL 报给用户"和"把 URL 当检查点、否则明确报告启动失败"），**以覆盖规则为准**：

- ~~Start it immediately when Executor begins; `svg_output/` may be empty. Editor opens at `http://localhost:5050`; if another project already holds it, the launcher **auto-advances to the next free port** — read the actual URL from the launch log and report that.~~ ← **本部署不适用：不启动、不播报**
- ~~Treat the launch URL as a checkpoint value: before writing the first SVG, either report the actual URL from the launcher or state the launch failure explicitly. Do not silently continue while claiming preview is available.~~ ← **本部署不适用：预览缺失是预期状态，不是需要报告的失败，直接继续生成**
- ~~Run it as a long-running side process/session; do not wait for it to exit before generating SVG pages. Do not wait for user confirmation after startup.~~
- ~~**Service must keep running** until one of: (a) the user clicks **Exit preview** in the browser, or (b) the user explicitly asks in chat to stop it. Generation continues even if the user closes the editor.~~
- **Do NOT read or apply submitted annotations during generation.** Users may annotate at any time, but Executor proceeds without touching them. The window to apply annotations opens only after Step 7 completes — see [`workflows/live-preview.md`](workflows/live-preview.md).
- The editor also supports **staged direct edits** (text content + SVG element attributes previewed immediately, then written to `svg_output/` only when the user clicks **Apply changes**; `Ctrl+Z` / Undo drops staged edits) alongside annotation; re-export stays chat-driven. Full scope and editor details: see [`workflows/live-preview.md`](workflows/live-preview.md) Notes.
