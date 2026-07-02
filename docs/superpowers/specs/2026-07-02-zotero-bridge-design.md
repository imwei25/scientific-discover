# 打通 Zotero:找选题 / 写标书 文献互通设计

**日期**: 2026-07-02
**范围**: 第一步(文件互导补齐) + 本地活连接 B+C(读本地库 / 回写 Zotero)
**不含**: 云端 Web API(方案 D)—— 作为未来可选,本次不做

---

## 1. 目标与动机

让"找选题(IdeaModule)"和"写标书(GrantModule)"的文献环节与用户本机的 Zotero 打通,支持:

- **导入**:把 Zotero 里的文献拉进当前页面的文献池;
- **导出/回写**:把当前页面检索/带入的文献推回 Zotero;
- **文献来源可选**:自动检索 / 从 Zotero(或文件)导入 / 导入后再补检索 / 跳过检索只用导入。

用户画像是医生/科研人员,多数机器上 Zotero 桌面端常驻。本应用是 Tauri 桌面端 + 本地 Python sidecar,后端已用 `httpx`,访问 `localhost:23119` 无障碍。

## 2. 现状(已有基础)

- 通用引用互导已存在:`RefIO.tsx` 组件 + 后端 `/api/refs/import`、`/api/refs/export`(走 `refio.py`),支持 **RIS / BibTeX / EndNote**。RIS/BibTeX 即 Zotero 标准进出格式。
- **找选题**已挂 `RefIO`(文件导入合并进 `refs`,`mergeRefs` 按 DOI/标题去重)。但 `deep_research_idea` **总是**自己检索,没有"跳过检索用带入文献"的路径。
- **写标书**未挂 `RefIO`;但 `write_grant` **已接受** `references`,且已有 `research` 开关(`True`=撰写前重检索并入池,`False`=只用带入文献)。即"跳过/额外检索"后端已具备,缺的只是导入 UI。

## 3. Zotero 本地端点能力(已核实)

| 能力 | 端点 | 结论 |
|---|---|---|
| 读本地库(分类/条目/搜索/全文) | `http://localhost:23119/api/users/0/...`(Zotero 7 本地 API,GET-only,无需 key,离线,无限速) | ✅ 可用于**读分类/条目** |
| 回写(把条目存进运行中的 Zotero) | `POST http://localhost:23119/connector/saveItems` | ✅ 可用于**推送** |
| 健康探测 | `GET .../connector/ping` 或 `GET .../api/` | ✅ 用于探测 Zotero 是否在运行 |
| **读"当前选中条目"** | 无内置端点 | ❌ 需 Better BibTeX 插件或自研插件,本次**不做**;用文件/拖拽路径替代 |

**前提**:用户需在 Zotero 里勾选 *设置 → 高级 → 允许本机其它应用与 Zotero 通信*;且 Zotero 正在运行。未满足时,后端探测失败,前端优雅回退到**文件互导**。

## 4. 架构

新增一个后端模块 `backend/app/zotero.py`,把本地 Zotero 端点封装成本应用统一的 Reference 结构(复用 `refio.py` 的统一字段),再由 `routes/manuscript.py`(引用 IO 已在此)暴露 4 个端点。前端新增一个 `ZoteroPanel` 组件,与现有 `RefIO` 并列在两个模块的"文献来源"区。

```
前端 ZoteroPanel ──► 后端 /api/zotero/*  ──httpx──►  localhost:23119
     │                    │                              (Zotero 本地 API / connector)
     └── RefIO(文件) ──► /api/refs/*  ── refio.py
                 └────────────► 统一 Reference 结构 ◄──── zotero.py
```

### 4.1 后端端点(新增,挂在 manuscript 路由)

- `GET  /api/zotero/status` → `{ ok, running: bool, api: bool, connector: bool }`。探测本地 Zotero;超时(≤1.5s)即视为未运行。
- `GET  /api/zotero/collections` → `{ ok, collections: [{key, name, count}] }`。读 `/api/users/0/collections`。
- `POST /api/zotero/import` `{ collection_key }` → `{ ok, refs: [统一Reference] }`。读该分类条目(`/api/users/0/collections/<key>/items`),用 `zotero.py` 映射为统一结构。省略 `collection_key` 时可导入"My Library"顶层(可选,先不做以免过量)。
- `POST /api/zotero/push` `{ refs: [统一Reference] }` → `{ ok, saved: n }`。把统一结构转为 connector 期望的条目 JSON,`POST /connector/saveItems`,存进用户当前在 Zotero 里选中的分类。`refs` 由前端决定是整池还是勾选子集。

`zotero.py` 只负责:探测、读分类/条目、结构映射(Zotero item ↔ 统一 Reference)、connector 载荷构造。网络与超时复用 `http_common.py` 风格。

### 4.2 前端组件

- `ZoteroPanel.tsx`(新):挂载时静默 `GET /api/zotero/status`。
  - Zotero 在线:显示"🔗 从 Zotero 导入"(点开→拉分类列表→选分类→导入合并进 `refs`,复用 `mergeRefs`)与"🔗 推送到 Zotero"。
    - **推送支持两种粒度**:文献列表每条前加一个可选勾选框;点"推送到 Zotero"时——**有勾选**则只推勾选子集,**无勾选**则推整池。按钮文案随选中数变化(如"推送到 Zotero(全部 40)"/"推送到 Zotero(已选 6)")。
  - Zotero 离线:整块折叠为一行灰字提示"未检测到运行中的 Zotero",并引导用户用旁边的 `RefIO` 文件互导 / 去 Zotero 勾选设置。
- `RefIO`(现有):保持不变,作为**始终可用**的兜底(含"当前选中条目"经由 Zotero 拖拽/导出文件的路径)。

### 4.3 "文献来源"选择

两个模块顶部新增一个轻量分段选择 `文献来源`,四选一:

1. **自动检索**(默认,现状行为)
2. **从 Zotero / 文件导入**(展开 ZoteroPanel + RefIO;不自动检索)
3. **导入后再补检索**(导入 + 仍跑一轮检索,合并)
4. **跳过检索,只用导入的文献**

- **写标书**:此选择直接映射到已有的 `research` 布尔——(1)(3)=`research:true`;(2)(4)=`research:false`。带入 `references` 已支持。**无需后端改动**,仅接 UI + ZoteroPanel。
- **找选题**:需**后端小改**。`deep_research_idea` 增加对 `inputs`:
  - `source_mode ∈ {auto, import_then_search, import_only}`(缺省 `auto`,保持向后兼容);
  - `references`(前端回传的带入文献池)。
  - `import_only`:跳过 `search_literature`,把带入 `references` 规整成 `papers`(已有 title/authors/journal/year/doi/url/abstract 足够),直接进入现有下游:证据抽取 `_extract_evidence` → 综述 → 选题卡。缺 abstract 的条目仍可用(标题+期刊+年参与,证据要点降级)。
  - `import_then_search`:先检索得到 papers,再 `_merge_papers` 并入带入 references,后续不变。

## 5. 数据流:找选题"跳过检索只用导入"

```
用户在 Zotero 选好一个分类
  → 前端 ZoteroPanel 导入 → refs 池(mergeRefs 去重)
  → 文献来源=跳过检索 → POST /api/idea { source_mode: "import_only", references: refs, field, ... }
  → deep_research_idea: 不检索,refs→papers→证据抽取→综述→选题卡(SSE 照旧)
  → 生成的选题卡引用均来自用户 Zotero 文献(可点链接)
```

## 6. 错误处理与边界

- **Zotero 未运行 / 未勾设置**:`/api/zotero/status` 超时→前端隐藏活按钮,提示走文件互导。绝不阻塞主流程。
- **import_only 但 refs 为空**:前端禁用"开始",提示"请先导入文献或改用自动检索"。
- **导入条目缺字段**(无 DOI/摘要):`mergeRefs` 用标题+年兜底去重;综述阶段容忍缺摘要。
- **推送失败**(connector 超时/用户未选分类):toast 报错,不影响页面文献池。
- **大分类**:导入设上限(如 200 篇)并提示截断,避免一次拉爆。
- **超时**:所有 `localhost:23119` 请求超时 ≤ 2s,探测 ≤ 1.5s。

## 7. 测试

- 后端 `test_zotero.py`:mock httpx,验证 (a) status 探测在线/离线;(b) collections 解析;(c) import 条目→统一 Reference 映射;(d) push 载荷构造;(e) 超时→优雅失败。
- 后端 `research.py`:`import_only` 跳过检索、`import_then_search` 合并的单测(mock `search_literature`)。
- 前端:ZoteroPanel 在 status=离线时回退渲染;文献来源四态切换对请求体的影响(Playwright 或组件测)。

## 8. 分期与优先级

- **P0(先做,零外部依赖)**:写标书接 `RefIO` + 四态"文献来源"UI(映射到已有 `research`);找选题后端 `import_only`/`import_then_search` + 前端四态。→ 立即满足用户全部功能诉求。
- **P1(本地活连接)**:`zotero.py` + 4 端点 + `ZoteroPanel`,读分类 / 回写。Zotero 在线时免倒文件。
- **暂不做**:云端 Web API(方案 D)、"当前选中条目"直读(需插件)。

## 9. 已确认决策(2026-07-02)

1. **推送方式**:手动按钮,存进 Zotero 当前选中分类;支持**整池推送**与**勾选部分推送**两种粒度(文献列表加勾选框,有勾选推子集、无勾选推整池)。✅
2. **"当前选中条目"**:接受用**文件/拖拽**路径替代(built-in 端点不支持读取 Zotero 面板选中项),**不**引入 Better BibTeX 依赖。✅
3. **导入上限**:单次分类导入上限 **200 篇**,超出截断并提示。✅
