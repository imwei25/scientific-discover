# 项目（多工作区）设计

**日期**：2026-06-28
**作者**：Claude × 用户协作（brainstorming）
**背景**：当前所有模块的输入/产出共享单一 `ra:*` localStorage 命名空间。用户做第二篇论文必须手动清空所有模块，且无法回切到上一篇。本设计引入"项目"概念：一篇论文 = 一个项目，8 个模块的全部数据整体打包，可创建/切换/重命名/删除，后端文件落盘以避免 localStorage 容量限制。

---

## 1. 目标与非目标

**目标**：
- 用户可创建多个项目，每个项目独立承载 8 个模块（选题/规划/分析/初稿/选刊/排版/核对/回复）的全部输入与产出。
- 任意时刻只有一个"当前项目"，所有模块读写都对应该项目。
- 切换项目无需任何额外操作（自动保存当前 → 加载目标）。
- 项目数据落盘到本地文件，数量不受 localStorage 容量限制。
- 已有用户老数据无感知迁移为"默认项目"。

**非目标**（YAGNI）：
- 项目导出/导入（zip、share-link）——本期不做。
- 项目级模板（"临床试验类项目"预填）——本期不做。
- 多用户/云同步——单机桌面应用，不需要。
- 项目复制/克隆——可后续按需加。
- 项目内的 git 式版本历史——已有的"历史记录"足够。
- 项目级权限/锁——单用户。
- 实时多窗口协作——单窗口设定下无意义。

---

## 2. 用户需求来源

用户原话："为了方便用户使用,设计一个新建项目的选项,也允许用户切换到之前的项目中,并加载之前的缓存."

经 3 轮校准确定：
- **颗粒度**：一篇论文 = 一个项目（8 模块整体切换），而非单模块多份草稿。
- **存储**：后端文件落盘（避开 localStorage ~5 MB 限制；保证数据分析含 base64 图的项目能稳定保存）。
- **入口**：侧栏顶部 brand 行下拉触发器（常驻、切换路径最短）。

---

## 3. 架构

### 3.1 新增文件

**后端**：
- `backend/app/projects.py`：项目存储层 + FastAPI 路由。
- `backend/test_projects.py`：单元/端到端测试。

**前端**：
- `frontend/src/lib/projects.ts`：项目 API 客户端 + `ProjectContext`（React Context）+ `useProjects`/`useCurrentProject` hooks。
- `frontend/src/components/ProjectPicker.tsx`：侧栏顶部下拉组件（含新建/重命名/删除对话框）。

**前端改造**：
- `frontend/src/App.tsx`：
  - 用 `ProjectProvider` 包裹整个 App。
  - brand 行下方插入 `<ProjectPicker />`。
  - 主内容容器加 `key={currentProject.id}` 强制重挂载所有模块。
  - 侧栏底部新增"保存状态"角标（`✓ 已保存` / `…保存中` / `⚠ 未同步`）。
- `frontend/src/lib/usePersistentState.ts`：**最小改动**。在 setItem 后多 dispatch 一个 `ra:state-changed` 自定义事件（供 ProjectProvider 监听触发防抖同步）。现有调用方完全无感。

### 3.2 数据模型

每个项目存为一个 JSON 文件：

```json
{
  "id": "uuid-v4",
  "name": "COVID-19 综述",
  "created_at": 1719500000,
  "updated_at": 1719600000,
  "state": {
    "idea:field": "...",
    "idea:result": "...",
    "plan:idea": "...",
    "analyze:code": "...",
    "...": "..."
  },
  "history": [
    { "id": "...", "module": "idea", "icon": "💡", "title": "...", "time": 1719500000, "data": { } }
  ]
}
```

- `id`：UUID v4，**前端生成**，后端校验格式后接受（避免后端额外依赖）。
- `name`：用户输入字符串。允许空格/中文/Emoji；后端裁剪首尾空白并限长 80。
- `state`：键即 `usePersistentState` 的 storageKey（去掉 `ra:` 前缀），值为 JSON 化后的字符串。装下当前 30+ 个键的全部内容。
- `history`：原全局 `ra:history` 改为**每项目独立**。结构与 `HistoryEntry` 一致。
- 文件路径：`<DATA_DIR>/projects/<id>.json`。`DATA_DIR` 解析顺序：
  1. 环境变量 `RA_DATA_DIR`（测试/CI 用）。
  2. Tauri 提供的 app-data 目录（生产）。
  3. 默认：`backend/data/`（dev 模式 fallback）。

### 3.3 后端 API

| Method | Path | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| `GET`    | `/api/projects`               | —                                  | `[{id, name, updated_at}]` | 列表，按 `updated_at` 降序 |
| `POST`   | `/api/projects`               | `{id, name}`                       | `{id, name, created_at, updated_at, state:{}, history:[]}` | 新建空项目 |
| `GET`    | `/api/projects/{id}`          | —                                  | 完整项目 JSON | 切项目时调用 |
| `PUT`    | `/api/projects/{id}/state`    | `{state, history}`                 | `{updated_at}` | 全量保存；防抖触发 |
| `PATCH`  | `/api/projects/{id}`          | `{name}`                           | `{id, name, updated_at}` | 改名 |
| `DELETE` | `/api/projects/{id}`          | —                                  | `204` | 删除文件 |

**约束**：
- 单文件 JSON 上限 50 MB；`PUT` 时超出返回 `413 Payload Too Large` + 提示 "项目过大，建议清理历史"。
- `GET /api/projects` 只读每个文件的 meta（`id/name/updated_at`），不读全量；目标 < 50 ms（200 个项目内）。
  - 实现：维护一个 `<DATA_DIR>/projects/index.json` 元数据缓存，`POST/PUT/PATCH/DELETE` 时增量更新；启动时若 index 缺失或损坏则扫描全部 JSON 重建。
- `name` 在保存时去除首尾空白；允许同名（不强制唯一，由 `id` 区分）。
- 写入采用 `write-temp + rename` 原子模式，避免崩溃损坏文件。

### 3.4 前端 ProjectContext

```ts
interface Project {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface ProjectContextValue {
  projects: Project[];                     // 列表（不含 state/history）
  current: Project | null;                 // 当前项目 meta
  syncStatus: "idle" | "saving" | "error"; // 角标用
  switchTo: (id: string) => Promise<void>; // 自动先存当前再切
  create: (name: string) => Promise<Project>; // 新建并自动切过去
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;   // 删完了自动新建"未命名项目"
}
```

实现要点：
- Provider 内部维护防抖 timer（1000 ms），监听 `storage` 事件 + `usePersistentState` 触发的同源改动；任一变化重置 timer，timer 到期则 `PUT /state`。
  - "同源改动"检测：`usePersistentState` 的 useEffect 已经写入 localStorage；Provider 用 `window.addEventListener('ra:state-changed', ...)` 监听一个自定义事件，由 `usePersistentState` 写入后 dispatch（**新增 4 行**：写完 setItem 后 `window.dispatchEvent(new Event('ra:state-changed'))`）。
- 切项目时：
  1. 取消防抖 timer 并强制 flush（同步保存当前）。
  2. `GET /api/projects/{id}` 取目标项目。
  3. 清空属于项目状态的 `ra:*` 键（豁免清单见 §5.7）。
  4. 写入目标项目的 `state` 到 `ra:*`（每个 key 加 `ra:` 前缀回去）。
  5. 写入 `history` 到 `ra:history`。
  6. 更新 context；外层 `key={projectId}` 自然触发模块重挂载。

### 3.5 数据流

```
用户编辑 ─▶ usePersistentState ─▶ localStorage (ra:foo)
                                      │
                                      └─▶ dispatch('ra:state-changed')
                                                │
                                                ▼
                                       ProjectProvider 防抖 timer (1s)
                                                │
                                                ▼
                                       PUT /api/projects/{id}/state
                                                │
                                                ▼
                                       后端原子写文件
```

切项目时反向：

```
点击下拉中的另一个项目
   ▼
flush 当前防抖
   ▼
PUT /api/projects/{currentId}/state  (确保最新)
   ▼
GET /api/projects/{targetId}
   ▼
清空 ra:* (保留 ra:ui:*)
   ▼
写入目标项目 state + history
   ▼
setCurrent(target) ─▶ key 变化 ─▶ 所有模块重挂载
```

---

## 4. UI 设计

### 4.1 侧栏顶部

```
┌──────────────────────────────────────┐
│ 🔬 科研助手                  «       │   ← brand-row 保留
├──────────────────────────────────────┤
│ 📁 COVID-19 综述              ▾      │   ← ProjectPicker 触发器（新增）
├──────────────────────────────────────┤
│ 01 找选题   发现研究方向...         │
│ 02 实验规划 ...                      │
│ ...                                  │
```

折叠态下：触发器仅显示 📁 图标，hover 时浮出当前项目名 tooltip。

### 4.2 下拉面板

```
┌─────────────────────────────────────┐
│ ● COVID-19 综述         （当前）    │
│   糖尿病队列分析                    │
│   药代动力学初稿                    │
│ ─────────────────────────────────── │
│ + 新建项目                          │
│ ✎ 重命名当前                        │
│ 🗑 删除当前                          │
└─────────────────────────────────────┘
```

- 项目列表全部显示（按 `updated_at` 降序，预期数量 ≤ 50；超过后再考虑虚拟滚动）。
- 点击非"当前"项目立即切换，无二次确认。
- 点击"+ 新建项目"：弹出最小输入框 → 提交后**新空白项目**并自动切换过去。
- 点击"✎ 重命名当前"：原地输入框，回车提交。
- 点击"🗑 删除当前"：二次确认对话框（"将永久删除项目「X」及其所有数据，无法恢复"）→ 确认后切到列表第一个；列表为空则自动建"未命名项目"。

### 4.3 保存状态角标

侧栏底部 `sidebar-foot`，紧邻 health/balance/token 信息：

| 状态 | 显示 | 触发 |
|---|---|---|
| idle | `✓ 已保存` | 同步完成或无修改 |
| saving | `… 保存中` | 防抖触发后到 PUT 响应前 |
| error | `⚠ 未同步`（红色，hover 显示原因） | 3 次重试均失败 |

---

## 5. 迁移与边界情况

### 5.1 首次启动

- **检测顺序**：
  1. `GET /api/projects` 返回非空 → 选 `updated_at` 最新的作为当前项目。
  2. 返回空，且 `localStorage` 有任意 `ra:*` 键（排除 §5.7 中的 UI 偏好与 `ra:history` 本身）→ 把所有"项目状态键"打包为 `state`，把 `ra:history` 内容作为 `history`，上传为"默认项目"。
  3. 返回空且 localStorage 也无 `ra:*` → 静默创建"未命名项目"（空白）。

- 老数据迁移完成后**不删** localStorage 的 `ra:*`，因为：
  - 新项目切换会主动覆写 `ra:*`，无冲突；
  - 留作保险，万一首次同步失败用户没丢东西。
  - 第二次启动时 step 1 已命中后端，不会重复迁移。

### 5.2 后端不可达

- ProjectPicker 显示 `⚠ 离线`，禁用切换/新建/重命名/删除（按钮置灰 + tooltip）。
- 当前项目继续可编辑（`usePersistentState` 走 localStorage）。
- 同步失败：静默重试 3 次（间隔 1s/3s/10s），仍失败则角标变 `⚠ 未同步`。
- 网络恢复后下次防抖触发自动补传；用户也可点击角标手动重试。

### 5.3 跨模块复制（`writePersisted`）

不改逻辑。`writePersisted` 仍写 `ra:*`，由 `ra:state-changed` 事件触发同步。

### 5.4 数据过大

- 后端 `PUT` 收到 > 50 MB 直接 `413`。
- 前端捕获后弹提示："项目「X」过大（含大量分析图），请到历史记录中清理后再保存。"
- 局部状态不丢（localStorage 已经写完），用户可手动清理后下次防抖自动重传。

### 5.5 删除当前项目

- 删完后切到 `projects[0]`（列表第一个，即剩余项目中最新的）。
- 若删除前只有一个项目 → 删除完后自动新建"未命名项目"并切过去，跳回首页。

### 5.6 同名项目

允许。下拉里若出现重名，在 `updated_at` 后追加日期辅助识别（视觉上 `COVID-19 综述 · 06-28`）。

### 5.7 UI 偏好不跟项目走

以下 localStorage 键属于全局 UI 偏好，**不**被项目切换覆盖：

```ts
const UI_PREF_KEYS = new Set([
  "ra:theme",                  // theme.ts (key: "theme")
  "ra:sidebar",                // sidebar.ts (key: "sidebar")
  "ra:ui:disclaimerDismissed", // App.tsx
]);
```

Provider 切项目时仅清理 `ra:` 开头但**不在** `UI_PREF_KEYS` 集合中、且**不是** `ra:history` 的键（`ra:history` 单独按目标项目重写）。后续若新增全局 UI 偏好，需同步加入此集合。

---

## 6. 测试策略

### 6.1 后端单测（`backend/test_projects.py`）

- `test_create_get_delete`：基本 CRUD 闭环。
- `test_list_sorted_by_updated_at`：列表按降序。
- `test_atomic_write`：模拟写入中途崩溃，文件不损坏（mock `rename` 抛异常前后状态）。
- `test_payload_too_large`：超 50 MB 返回 413。
- `test_index_rebuild`：删掉 `index.json` 后启动能从 JSON 文件重建。
- `test_name_trim_and_limit`：name 去空白 + 限 80 字符。

### 6.2 前端 e2e（`frontend/tests/projects.spec.ts`）

mock `/api/projects*` 路由，断言：
- `test_picker_visible`：默认渲染 picker 触发器，显示当前项目名。
- `test_create_project`：点"+ 新建" → 输入 → 切到新项目 → 所有模块输入为空。
- `test_switch_preserves_data`：A 项目填了"找选题"，切到 B 后 A 数据消失；切回 A 数据复现。
- `test_rename`：改名后下拉里立即反映。
- `test_delete_last_creates_unnamed`：删完所有项目后自动出现"未命名项目"。
- `test_sync_indicator`：编辑 → "…保存中" → 1s 后 "✓ 已保存"。
- `test_offline_disables_picker`：后端 mock 503 时 picker 禁用，编辑仍 OK。

### 6.3 迁移测试

- `test_migration_from_legacy`：预置 localStorage `ra:idea:field=X`，后端空，启动后应见"默认项目"且 X 出现在找选题模块。

---

## 7. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 防抖 1s 内崩溃丢最后 1s 修改 | 接受。localStorage 已即时写入，重启后下次防抖会同步。 |
| 用户在两个浏览器标签编辑同一项目 | 不支持。Tauri 单窗口设定下不会发生；浏览器开发模式下后写覆盖先写。 |
| index.json 与单文件不一致 | 启动时若 index 损坏自动重建；每次写也会更新 index。 |
| 50 MB 上限过小 | 数据分析图按需保留；提示用户清理历史后通常足够。后续可调。 |
| 切换项目期间用户继续编辑 | 切换流程是同步的（await），期间 UI 阻塞 < 200 ms（一次 GET）。可接受。 |
| `ra:state-changed` 事件依赖修改 `usePersistentState` | 仅 4 行改动；既有调用方完全无感。 |

---

## 8. 落地范围

| 层 | 改动量 |
|---|---|
| 后端 (FastAPI) | 新增 `app/projects.py`（≈ 180 行）+ 路由挂载到 `main.py`（5 行）+ `test_projects.py`（≈ 150 行） |
| 前端 lib | 新增 `lib/projects.ts`（≈ 200 行） |
| 前端组件 | 新增 `components/ProjectPicker.tsx`（≈ 200 行）+ CSS（≈ 80 行） |
| 前端 App | `App.tsx` 加 Provider/Picker/key（≈ 20 行）；`usePersistentState.ts` 加事件 dispatch（4 行） |
| 测试 | `tests/projects.spec.ts`（≈ 250 行） |

约 1100 行净增。

---

## 9. 不在本期范围

- 项目导出为 zip / 分享链接。
- 项目模板（"临床试验"预填表单）。
- 项目级标签/分组/搜索。
- 项目复制。
- 项目快照/版本历史。
- 云同步。
