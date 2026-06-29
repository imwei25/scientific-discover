# 医生视角 UX 大改造 设计文档

**日期**：2026-06-28
**背景**：从 AI 小白 + 临床医生视角对项目做完整 review，识别出 25+ 改进项。剔除工作量过大或本会话内不可行的 5 项（Tauri 打包、多人协作、离线大模型、医学影像、中文期刊版式），剩余分三波实施。

## 总体策略

| 波次 | 性质 | 执行方式 |
|---|---|---|
| Wave 1 | 6 个独立新功能，文件不冲突 | 6 个 subagent 并行（git worktree 隔离） |
| Wave 2 | UI/UX 综合改造，共享 App.tsx / styles.css | 1 个 subagent 顺序完成 |
| Wave 3 | 真人式 e2e 验收 | 1 个 Playwright agent，不 mock 后端 |

## 全局设计决策

- **D1**：脱敏映射表只本地保存（不入 state.json，不上服务端）
- **D2**：统计顾问做 `AnalyzeModule` 子 Tab，不是独立左侧导航项
- **D3**：伦理材料是新左侧导航项（介于 plan 和 analyze 之间）
- **D4**：Ctrl+K 命令面板支持模块跳转 + 历史记录搜索
- **D5**：emoji icons 一次性替换为 Lucide 单色图标
- **D6**：暖色强调色 = `#d97706`（琥珀），仅用于 CTA / 成功 toast
- **D7**：字体可调 3 档（标准 15px / 大 17px / 特大 19px），ThemeSwitcher 旁边的下拉，localStorage 持久化，全局生效
- **D8**：图表三件套依赖 `lifelines` + `scikit-learn`，加入 requirements.txt
- **D9**：新增需求 — 全局字体可调（D7 已覆盖）

---

## 🌊 Wave 1：6 个独立新功能（并行）

### W1-1 病例数据脱敏

**入口**：上传 Excel/CSV 时（`AnalyzeModule`、`ImradModule` 的 Dropzone），自动调用脱敏检测 API，弹窗"检测到 N 条可能的患者标识，是否一键脱敏？"

**新模块**：`backend/app/deidentify.py`
- 检测规则：
  - 姓名：列名包含"姓名/患者/姓/Name/Patient" + 单元格 2-4 字中文
  - 身份证：18 位正则（含 X）+ 校验位
  - 手机号：1[3-9]\d{9}
  - 住院号/MRN：列名匹配 `住院号|MRN|病案号|Patient ID`
  - 出生日期：精度降为年（保留年龄分析能力）
- 替换策略：PT0001…PT9999 顺序编号，同一原值映射同一新值
- 输出：脱敏后的字节流 + 映射表 JSON（仅返回到前端，不落服务端磁盘）

**新 API**：
- `POST /api/deidentify`：multipart 上传 csv/xlsx，响应 `{ data: base64, report: {...}, mapping: {...} }`

**新前端组件**：`components/DeidentifyDialog.tsx`
- 列出每列检出类型与计数，可逐列勾选是否脱敏
- 接受后用脱敏后的字节继续走原 `/api/analyze` 流程

**测试**：
- `backend/test_deidentify.py`：覆盖 4 种 PHI 类型 + 边界（空值、纯英文、混合）
- e2e：上传含姓名 + 身份证的 CSV，应弹对话框，接受后继续分析

### W1-2 EndNote/Zotero 双向导入导出

**新模块**：`backend/app/refio.py`
- import：解析 `.ris` / `.bib` / `.enw` → 内部 `Reference[]` 结构（与 `IdeaModule` 现有 Reference 类型对齐）
- export：`Reference[]` → 三种格式字节流
- 用 `rispy`（.ris）+ `bibtexparser`（.bib），自己实现 `.enw`（格式简单）

**新 API**：
- `POST /api/refs/import`：multipart，响应 `Reference[]`
- `POST /api/refs/export`：`{ refs, format }` → 字节流

**挂载点**：
- `IdeaModule` 文献列表上方加 "📥 导入" + "📤 导出" 按钮组
- `FormatModule` 参考文献区同样加双按钮

**测试**：
- `backend/test_refio.py`：3 种格式各 round-trip 一次
- e2e：导入一个 sample.ris，验证文献数量增加

### W1-3 医学图表三件套

**扩展**：`backend/app/analysis.py` 新增 3 个高层函数（不动现有函数）
- `forest_plot(studies, effect='OR')`：输入 `[{study, n_treat, event_treat, n_ctrl, event_ctrl}]`，计算 OR/RR + 95% CI，输出 PNG/SVG/PDF
- `km_curve(df, time_col, event_col, group_col=None)`：lifelines.KaplanMeierFitter，输出曲线 + log-rank p（若 group）
- `roc_curve_plot(y_true, y_score)`：sklearn.metrics.roc_curve，AUC + bootstrap 95% CI

**新依赖**：`lifelines`、`scikit-learn` 加入 `requirements.txt`

**新 API**：
- `POST /api/analyze/forest`：`{ studies, effect, format }` → 图字节 + 文字解读
- `POST /api/analyze/km`：multipart 上传 + 列映射 → 图 + log-rank
- `POST /api/analyze/roc`：multipart 上传 + 列映射 → 图 + AUC

**UI**：`AnalyzeModule` 头部加"分析类型"下拉：通用 / 森林图 / KM 曲线 / ROC，选择后渲染对应输入表单

**测试**：
- `backend/test_medical_charts.py`：3 个函数各跑一次小数据
- e2e：上传 meta 数据 → 选森林图 → 出图

### W1-4 样本量交互式探索

**扩展**：`backend/app/samplesize.py` 新增 `sweep(params, vary, range)` 返回 `[(value, N)]`

**UI**：`PlanModule` 样本量区改造
- 左侧三个滑块：效应量 / α / power
- 右侧实时曲线（D3 或 Chart.js，用现有依赖优先）
- 滑动时纯前端 JS 计算（双比例 / 双均值公式），免网络往返
- 后端 API 保留供精确验证（点"使用此参数"时调用一次）

**测试**：
- e2e：拖动滑块，N 数应实时变化

### W1-5 伦理审查文书模板

**新前端模块**：`modules/EthicsModule.tsx`
- 左侧目录：知情同意书 / 研究方案 / CRF / 数据使用承诺
- 右侧 Word 模板预览（占位符高亮）
- "从实验规划导入"按钮：把 `PlanModule` 的已有方案字段（研究目的、入排标准、主要终点）自动填入

**新后端**：`backend/app/ethics.py` 用 python-docx 生成
- 4 个模板文件存于 `backend/templates/ethics/*.docx`

**新 API**：
- `POST /api/ethics/render`：`{ template, fields }` → docx 字节

**导航**：插在 `plan` 和 `analyze` 之间，title "伦理材料"，desc "知情同意/方案/CRF"

**测试**：
- e2e：进入 → 生成知情同意书 → 下载 → 文件名含 .docx

### W1-6 统计顾问 Q&A

**新前端**：`AnalyzeModule` 内加子 Tab "📚 统计顾问"
- 对话框输入：研究问题（如"60 人分两组比较 HbA1c"）
- 可选上传当前数据描述（自动从已分析的数据提取列类型）
- 输出结构化卡片：推荐方法 / 前置假设 / 注意事项 / 替代方法

**新 prompt**：`backend/app/prompts.py` 新增 `build_stats_advice(question, data_meta?)`
- 输出 JSON schema：`{ recommended: {test, why}, assumptions: [...], cautions: [...], alternatives: [{test, when}] }`

**新 API**：
- `POST /api/stats/advice`：流式 SSE

**测试**：
- backend `test_stats_advice.py`：mock LLM 返回结构化 JSON 验证解析
- e2e：输入问题，渲染推荐卡片

---

## 🌊 Wave 2：UI/UX 综合改造（串行）

### W2-1 首次配置向导

**新组件**：`components/OnboardingWizard.tsx`
- 触发：`/api/health` 返回 `configured=false` 且 localStorage 无 `onboarding:done`
- 步骤：
  1. 选供应商（卡片网格：DeepSeek 推荐 / 硅基流动 / OpenAI / Claude / 演示模式 5 选 1）
  2. 粘贴 key + "测试连接"按钮（调 `POST /api/config/test-key`）
  3. 测通 → 自动写入 `.env`（新 API `POST /api/config/save`）→ 标记完成

**新后端 API**：
- `POST /api/config/test-key`：`{ provider, key }` → `{ ok: bool, msg }`
- `POST /api/config/save`：`{ provider, key, base_url? }` → 写 `.env` + 重载配置

**安全**：写 `.env` 只允许本地（127.0.0.1）调用

### W2-2 错误 / 等待 / 同步反馈系统化

**新组件**：`components/Toast.tsx`
- 顶部居中堆叠，自动消失 4 秒（错误类不自动消失）
- 支持操作按钮（"去充值" / "换 key" / "重试"）
- 全局 `useToast()` hook

**改造**：
- `lib/sse.ts`：所有错误统一抛 `LLMError` 子类（余额不足 / key 无效 / 超时 / 限流），UI 层映射到 Toast 操作
- `lib/sse.ts`：新增 `onProgress(stage, detail)` 回调，例如"正在检索 PubMed…"、"AI 已读 12/30 篇文献"
- 各模块的等待区显示动态进度文案，配 spinner
- 同步角标：字号 11→14，背景色加深，5 秒未恢复时弹 Toast"未同步到本地数据库，点击重试"

### W2-3 Diff 视图

**新组件**：`components/DiffView.tsx`
- 用 `diff` npm 包（已 lightweight），inline 模式红/绿高亮
- 顶部"接受全部 / 拒绝全部 / 逐句决定"
- 逐句模式：每段加 ✓/✗ 按钮

**挂载**：
- `ImradModule`：AI 润色按钮 → 弹 Diff
- `RebuttalModule`：AI 改写回复 → 弹 Diff
- `FormatModule`：AI 重排参考 → 弹 Diff

### W2-4 视觉打磨（一次性）

- **字体可调**：`components/FontSizeSwitcher.tsx`，3 档（标准 15px / 大 17px / 特大 19px），下拉，挂在 ThemeSwitcher 旁，localStorage `ui:fontSize`，全局 CSS 变量 `--font-base` 控制
- **行高**：1.7（之前 ~1.5）
- **暖色强调**：CSS 变量 `--accent-warm: #d97706`，应用于：
  - 主 CTA 按钮（home-cta、各模块的"生成"按钮）
  - 成功 Toast 边框
  - 演示模式横条背景
- **Lucide 图标**：`npm i lucide-react`，替换：
  - 左侧导航 8 个 emoji → Lucide 图标
  - 首页卡片 emoji → Lucide
  - 状态指示符（●○⚠💰🔢）保留（信息密度高）
- **项目选择器位置**：从 main 内容区右上角移到左侧 brand 下方，breadcrumb 风格 "🔬 科研助手 / 当前项目名"
- **演示模式横条**：health.mock === true 时，所有页面顶部固定一行 `⚠ 演示模式 — 所有结果都是假数据，仅供试用` 暖色背景
- **免责声明重现**：localStorage 记 `disclaimer:lastDismissed` 时间戳，超过 7 天再次显示
- **Ctrl+K 命令面板**：`components/CommandPalette.tsx`
  - Cmd/Ctrl+K 触发
  - 模糊搜索：模块名 + 历史记录标题
  - 选中后跳转或恢复历史
- **导航 desc 白话化**：
  - "装配 IMRaD 初稿与摘要" → "把材料拼成医学论文标准格式（IMRaD）"
  - "STROBE/CONSORT/PRISMA 自查" → "按医学研究报告规范逐条自查"
  - "匹配适合投稿的期刊" → "AI 推荐适合投稿的期刊"

---

## 🌊 Wave 3：真人式 e2e 验收

**派遣**：1 个 general-purpose agent，使用 `mcp__playwright` 工具，启动真实 dev server（演示模式，避免花 API 额度）。

**测试场景**：模拟新手医生首次使用
1. 清空 localStorage → 打开 → **应见首次配置向导**
2. 选"演示模式" → 完成 → 进首页
3. 按 `Ctrl+K` → 搜"选题"→ 跳"找选题"
4. 填"非小细胞肺癌 免疫治疗" → 触发 idea 流程 → 验证文献列表渲染
5. 跳"数据分析" → 上传带"姓名 + 身份证"的 CSV → **应弹脱敏对话框** → 接受 → 继续
6. 切到"森林图"模板 → 上传 meta 数据 → 出图
7. 切到"统计顾问"Tab → 问问题 → 渲染推荐卡片
8. 跳"伦理材料" → 生成知情同意书 → 验证下载
9. 跳"论文初稿" → AI 润色 → 验证 Diff 视图
10. 跳"期刊排版" → 导入 sample.ris → 验证引用列表增加
11. 改字体到"特大" → 验证全局字号变化
12. 全程检查：错误 Toast 触发与样式、等待进度文案、同步角标、暖色 CTA、Lucide 图标渲染、命令面板可用

**测试 agent 输出**：结构化报告
- 每步 ✅ / ⚠️ / ❌ + 截图（保存到 `.playwright-mcp/wave3/`）
- 发现的问题清单（按严重程度排序）
- 性能观察（首屏时间、SSE 等待时间）

---

## 文件影响矩阵

| 文件 | Wave 1 | Wave 2 |
|---|---|---|
| `backend/app/main.py` | 加 8 个 API 路由 | 加 3 个配置 API |
| `backend/app/deidentify.py` | 新建 | - |
| `backend/app/refio.py` | 新建 | - |
| `backend/app/ethics.py` | 新建 | - |
| `backend/app/analysis.py` | 加 3 个图表函数 | - |
| `backend/app/samplesize.py` | 加 sweep 函数 | - |
| `backend/app/prompts.py` | 加 stats_advice | - |
| `backend/templates/ethics/*.docx` | 新建 4 个 | - |
| `backend/requirements.txt` | + lifelines, sklearn, rispy, bibtexparser | - |
| `frontend/src/App.tsx` | 加 EthicsModule 路由 + 项目选择器位置 | 大改（向导触发、字体、命令面板、演示横条） |
| `frontend/src/styles.css` | - | 大改（暖色、字号变量、行高） |
| `frontend/src/components/*` | DeidentifyDialog | OnboardingWizard, Toast, DiffView, FontSizeSwitcher, CommandPalette |
| `frontend/src/modules/EthicsModule.tsx` | 新建 | - |
| `frontend/src/modules/AnalyzeModule.tsx` | 加图表类型 + 统计顾问 Tab | - |
| `frontend/src/modules/PlanModule.tsx` | 加滑块 | - |
| `frontend/src/modules/IdeaModule.tsx` | 加 refio 按钮 | - |
| `frontend/src/modules/FormatModule.tsx` | 加 refio 按钮 | Diff 挂载 |
| `frontend/src/modules/ImradModule.tsx` | - | Diff 挂载 |
| `frontend/src/modules/RebuttalModule.tsx` | - | Diff 挂载 |
| `frontend/src/lib/sse.ts` | - | 加 onProgress + LLMError 分类 |
| `frontend/package.json` | - | + lucide-react, diff |

**Wave 1 实际并行策略（修正版）**：原计划 6 个 agent 按功能拆，但 `AnalyzeModule.tsx` 被 W1-1/W1-3/W1-6 三方同时改、`App.tsx` 被 W1-5 改后续 Wave 2 也要改，会冲突。改为按**文件归属**重新切：

- **Agent A（后端全包）** — 工作目录 `backend/`，无前端文件冲突
  - 实现：deidentify.py / refio.py / ethics.py / analysis.py 扩展 / samplesize.py sweep / prompts.py stats_advice / templates/ethics/ / requirements.txt / main.py 所有新 API
  - 产出 `docs/api-contracts.md` 列出新 API 的请求/响应 schema 供前端 agent 对照
- **Agent B（AnalyzeModule 统包）** — 一并完成 W1-1 dropzone hook + W1-3 图表类型下拉 + W1-6 统计顾问 Tab + 新建 `DeidentifyDialog.tsx`
- **Agent C（ImradModule + 引用组件）** — W1-1 dropzone hook for Imrad
- **Agent D（IdeaModule + FormatModule）** — W1-2 双向导入导出按钮
- **Agent E（PlanModule）** — W1-4 样本量滑块
- **Agent F（EthicsModule 新建 + nav 挂载）** — W1-5 新模块 + 极小的 App.tsx 改动（只加导航条目，不动其他）

并行度：6 个 worktree，A/B/C/D/E 完全独立无冲突；F 对 App.tsx 的改动限定在 NAV 数组追加一行 + 模块路由追加一行，Wave 2 后续改 App.tsx 时只需处理这两处增量。

Wave 1 全部合并后启动 Wave 2（单 agent 串行）。Wave 2 完成后启动 Wave 3（验收）。

---

## 风险与回滚

- **依赖膨胀**：lifelines + sklearn 约 +200MB，可接受（医学场景必备）。如果安装失败 → 该 agent 标记 W1-3 failed，其他不受影响
- **Lucide 替换可能破坏现有样式**：用 CSS class 控制颜色/大小，保留 emoji 作为 fallback（首轮不删除 emoji 引用，只新增 icon import）
- **Diff 视图与流式响应冲突**：Diff 只在最终结果出现后显示，流式期间显示原样
- **首次向导可能错挡老用户**：localStorage 兼容性检查 — 老用户若已配 key（health.configured=true），跳过向导自动标记 onboarded
- **回滚**：每个 wave 一个独立 commit，Wave 1 是 6 个独立 commit，方便单点 revert
