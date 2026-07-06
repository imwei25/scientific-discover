# 前端聊天框 ↔ 云端 Claude Code / Codex 接入方案

> 目标：前端提供一个聊天框，后端驱动云端的 Claude Code 或 Codex（有工具、能读写文件、能跑命令的 agent），
> 支持文字、图片、文件的双向传输，并把 agent 的工作过程实时流式展示给用户。

---

## 一、总体架构

```
浏览器/Tauri 前端                云端服务器
┌──────────────┐   HTTPS    ┌─────────────────────────────┐
│  聊天 UI      │──────────▶│  FastAPI 网关                │
│  - 消息流展示 │◀──SSE─────│  ├─ 会话管理(session store)  │
│  - 文件上传   │           │  ├─ 文件存储(workspace/)     │
│  - 文件下载   │           │  ├─ 文件登记表(file registry)│
└──────────────┘           │  └─ Agent 运行器             │
                           │      ├─ Claude Agent SDK     │
                           │      └─ Codex SDK / exec     │
                           └─────────────────────────────┘
```

核心思想：

1. **后端不直接调 LLM API，而是把 Claude Code / Codex 当成"有工具的 agent 进程"来驱动**，前端只负责渲染事件流。
2. **文件传输的本质是"共享工作目录"**：上传 = 把文件放进 agent 的 workspace；下发 = 把 workspace 里的产物登记后推 URL 给前端。

---

## 二、后端怎么接 Claude Code / Codex

两条路，推荐方案 A：

### 方案 A（推荐）：官方 Agent SDK

**Claude Code**：`pip install claude-agent-sdk`，内部封装了 Claude Code 的 headless 模式，
天然支持流式事件、多轮会话、工具调用、权限控制。

```python
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions

options = ClaudeAgentOptions(
    cwd=f"/data/workspaces/{session_id}",   # 每个会话一个工作目录
    permission_mode="acceptEdits",           # 云端无人值守，不能弹权限框
    allowed_tools=["Read", "Write", "Bash", "Glob", "Grep"],
)
async with ClaudeSDKClient(options=options) as client:
    await client.query(user_message)
    async for msg in client.receive_response():
        yield msg   # 转成 SSE 事件推给前端
```

**Codex**：Node 侧用 `@openai/codex-sdk`（Thread API），
或 Python 侧子进程跑 `codex exec --json "..."`，逐行解析 JSONL 事件。

### 方案 B：headless CLI 子进程

```bash
claude -p "<prompt>" --output-format stream-json --resume <session_id>
```

stdout 逐行读 JSON。好处是零依赖，且 Claude 和 Codex 可以统一成"子进程 + JSONL"一套抽象；
坏处是要自己管进程生命周期。

### 统一抽象

如果要同时支持两家，后端抽一个 `AgentRunner` 接口，两个实现（SDK 或 CLI 均可），
把各家事件归一化成自己的协议（见第三节），前端完全不感知底下是谁。

```python
class AgentRunner(Protocol):
    async def run(self, session_id: str, prompt: str) -> AsyncIterator[AgentEvent]: ...
    async def interrupt(self, session_id: str) -> None: ...
```

---

## 三、前后端通信协议

**推荐：POST 发消息 + SSE 收流**。比 WebSocket 省事：无状态、浏览器自动重连、过代理/CDN 友好。

### 接口设计

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/chat/{session_id}/messages` | 发一条消息（含文件引用） |
| GET  | `/api/chat/{session_id}/stream` | SSE 长连接收事件 |
| POST | `/api/chat/{session_id}/interrupt` | 中断当前生成 |
| POST | `/api/chat/{session_id}/files` | 上传文件（multipart） |
| GET  | `/api/files/{file_id}` | 下载/预览文件（见第五节） |

### SSE 事件协议（归一化）

```json
{"type": "text_delta",  "text": "正在分析..."}
{"type": "tool_start",  "tool": "Bash", "detail": "npm test"}
{"type": "tool_result", "tool": "Bash", "summary": "3 passed"}
{"type": "file_output", "file": {"file_id": "f_8f2a", "name": "report.docx",
                                  "size": 24576, "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                  "url": "/api/files/f_8f2a"}}
{"type": "done",        "session_id": "...", "cost": {"input_tokens": 1200, "output_tokens": 800}}
{"type": "error",       "message": "..."}
```

要点：

- **`tool_start` / `tool_result` 必须有**。agent 干活可能几分钟，前端要实时展示"它正在做什么"
  （类似 Claude Code 终端里的工具调用行），否则用户以为卡死了。
- 只有需要**双向实时交互**（agent 中途反问、权限批准）时才升级 WebSocket；
  SSE 场景也可以用"agent 暂停 + 前端 POST 回答"模拟。

---

## 四、前端 → 后端：文字 / 图片 / 文件上传

关键认知：**Claude Code / Codex 是"文件系统型" agent，传文件 = 把文件放进它的工作目录，
再在 prompt 里告诉它路径**，而不是塞进消息体。

1. **文字**：直接放 POST body 的 `text` 字段。
2. **文件（PDF、CSV、代码等）**：
   - 前端 `POST /api/chat/{session_id}/files`（multipart/form-data）先上传；
   - 后端存到该会话的 workspace：`/data/workspaces/{session_id}/uploads/数据.csv`；
   - 返回 `{file_id, path}` 给前端；
   - 用户发消息时，后端把 prompt 组装成：
     `用户上传了文件 uploads/数据.csv\n\n{用户消息}`；
   - agent 自己用 Read/Bash 工具去读——这正是它擅长的，大文件也不会撑爆上下文。
3. **图片**：两种都通，推荐落盘方式（与文件统一）：
   - 落盘到 `uploads/`，Claude Code 的 Read 工具原生支持读图（视觉理解），prompt 里给路径即可；
   - 或走 SDK 时直接构造多模态消息（base64 image content block）。

---

## 五、后端 → 前端：文件下发方案

agent 会产出文件（图表 PNG、分析报告 docx、修改后的代码等），需要一条可靠的"回传"链路。
整体分三步：**发现 → 登记 → 下发**。

### 5.1 怎么发现 agent 产出了文件

推荐组合使用：

- **约定输出目录（主）**：在 system prompt 里约定"所有交付物写到 `outputs/` 目录"。
  每轮 agent 运行结束后，后端扫描 `outputs/`，对比上一轮快照（mtime + 哈希），新增/变更的就是本轮产物。
  简单、可靠、可控。
- **解析工具事件（辅）**：SDK/CLI 的事件流里能看到 `Write` 工具调用的目标路径，
  实时捕获后立即登记，用户不用等本轮结束就能看到文件卡片。
- 不推荐纯 filesystem watcher（inotify）：agent 写临时文件很频繁，噪音大。

### 5.2 文件登记表（file registry）

发现文件后不直接暴露路径，而是登记进数据库，换取一个不透明的 `file_id`：

```
file_id | session_id | 绝对路径 | 文件名 | mime | size | sha256 | created_at | expires_at
```

好处：

- 前端拿到的永远是 `file_id`，**服务器真实路径不外泄**；
- 天然防目录穿越（下载接口只查表，不拼路径）；
- 可以做过期清理、访问审计。

### 5.3 怎么推给前端

**元数据走 SSE，文件内容走 HTTP 下载**——不要把文件 base64 塞进 SSE 流（阻塞事件流、内存爆炸、无法断点续传）。

1. 登记完成后，通过 SSE 推 `file_output` 事件（含 `file_id / name / size / mime / url`，见第三节）；
2. 前端根据 mime 决定渲染方式：
   - `image/*` → 直接 `<img src="/api/files/f_8f2a">` 内联展示；
   - `text/markdown`、`text/csv` 小文件 → 可以先 fetch 内容做内联预览；
   - 其余（docx/pdf/zip）→ 渲染成下载卡片（文件名 + 大小 + 下载按钮）。
3. 唯一的例外：**几 KB 以内的小图**（如 agent 画的迷你图标）可以 base64 内联在事件里省一次请求，
   但要设硬上限（如 64 KB），超过一律走 URL。

### 5.4 下载接口

```
GET /api/files/{file_id}
    Authorization: Bearer <token>      # 或签名 URL，见 5.5
```

实现要点：

- 用流式响应（FastAPI `FileResponse` / nginx `X-Accel-Redirect`），不要整文件读进内存；
- 支持 `Range` 请求头（HTTP 天然支持断点续传，大文件必备）；
- 响应头带 `Content-Disposition: attachment; filename*=UTF-8''...`（中文文件名要 RFC 5987 编码）；
- 校验：`file_id` 对应的 `session_id` 必须属于当前登录用户。

### 5.5 鉴权：两种方式

| 方式 | 做法 | 适用 |
|------|------|------|
| Bearer token | 下载请求带用户 token，接口里校验归属 | 前端用 fetch 下载时最简单 |
| 签名 URL | `/api/files/{file_id}?expires=...&sig=HMAC(...)`，短时效（如 10 分钟） | `<img>` 标签、新标签页打开、分享链接——这些场景带不了自定义 header |

实践中通常两个都要：API 调用走 token，内联图片和"在浏览器中打开"走签名 URL
（SSE 事件里的 `url` 字段直接下发已签名的 URL 即可）。

### 5.6 生命周期

- workspace 和登记的文件设 TTL（如 7 天），定时任务清理，登记表标记 `expired`；
- 用户明确"保存"的文件（如导出的报告）可以复制到持久存储区，脱离会话生命周期；
- 文件下发后 SSE 事件已含全部元数据，前端把文件卡片持久化进聊天记录，
  历史消息里的文件只要没过期就能重新下载。

---

## 六、会话与并发

- **会话 = session_id + workspace 目录 + agent 会话 ID** 三元组，存 Redis/SQLite。
- 多轮对话：SDK client 常驻，或 CLI 用 `--resume <session_id>`（Codex 用 thread resume）。
  agent 自己带完整上下文，后端不用重放历史。
- 每个会话一个隔离 workspace；并发多用户 = 多个子进程/SDK client，用信号量限流。
- SSE 断线重连：事件带自增 `id`，后端缓存最近事件，重连时用 `Last-Event-ID` 补发。

---

## 七、云端安全要点

无人值守跑 agent，以下是必须项：

- 权限模式用 `acceptEdits` 或工具白名单，**绝不开全权 Bash 又不加沙箱**——
  建议每个会话跑在 Docker 容器里（只挂载各自 workspace、无宿主机访问、限制出网）；
- LLM API key 只存后端环境变量，前端永远拿不到；
- 上传文件校验类型和大小上限，存储文件名用生成的 ID，不用用户原始文件名拼路径；
- 下载走 file registry（第 5.2 节），杜绝路径拼接；
- 给单次运行设 `max_turns` / 超时 / 费用上限，防止 agent 跑飞烧钱。

---

## 八、建议落地顺序

1. **最小链路**：FastAPI + `claude-agent-sdk` + 纯文字 SSE 流（一两天可见效果）；
2. 加文件上传 → workspace → prompt 引用路径；
3. 加工具调用过程展示 + 产物文件回传（`outputs/` 约定 + file registry + 下载接口）；
4. 容器隔离、断线重连、签名 URL、TTL 清理；
5. 多 agent（Codex）适配：实现第二个 `AgentRunner`。
