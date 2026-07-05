# 深度调研模块 · 设计规格

- 日期: 2026-07-05
- 作者: wei25 + Claude 协同
- 状态: 待实施

---

## 1. 背景与目标

现有"找选题"模块以研究方向为输入,产出候选选题卡。用户需要一个平行流程,以**研究问题**为输入,由 AI 综合当前检索到的文献回答"这些文献做了什么、结论如何、相互矛盾在哪、留有哪些空白"。区别于找选题:

- 输入是**研究问题**(自然语言,非关键词)
- 不需要输入关键词
- 支持批量上传文献(用户已有的 20 篇),这些文献**不再下载**,进入文献池后由用户/AI 选择是否深读全文
- Zotero 沿用 collection + 勾选导入
- 产出偏"循证综述"风格:共识 / 矛盾 / 空白 + 逐文献贡献表
- 部分文献需要读全文,而非只用摘要

同时新增**开发者模式**开关,深度调研作为首个"开发中"模块隐藏在其后。

---

## 2. 范围

### 做

- 新增前端模块 `ResearchModule.tsx`,4 步向导:研究问题 → 检索设置 → 文献复核(含深读推荐)→ 调研产出
- 新增 Step 1 "上传文献" 上传框,与现有"相关资料"框语义分离
- 新增后端合成层 `deep_research.py`(推荐分 + 深读全文 + 合成 + 贡献表 + 追问)
- 复用检索层 `literature.search_literature()`、Unpaywall OA 补全、Zotero 导入、`LiteraturePicker`、`extract.extract_text`
- 从 `IdeaModule.tsx` 抽出 3 个公用组件:`AttachmentUploadBox`, `FollowupPanel`, `ReportExportBar`(纯提取,不改行为)
- 新增开发者模式开关,深度调研位于其后

### 不做(YAGNI)

- 向量检索/嵌入(用简单章节截断;后续任务 #7 再评估)
- BibTeX/RIS 导出(现有期刊排版模块已可处理)
- 多研究问题同时问(用户跑多轮)
- 深读结果跨会话缓存
- 深度调研独立报告风格开关(沿用 englishReport)

---

## 3. 用户流程

### Step 1 · 研究问题(输入)

| 字段 | 必填 | 类型 | 用途 |
|-----|-----|-----|-----|
| `question` 研究问题 | ✓ | 2-4 行 text | 检索词生成 + 合成 prompt |
| `field` 研究领域 | | 短 text | 消歧,缩窄检索 |
| `background` 相关资料 | | text + 拖入解析 | **全量注入 prompt** 做背景 |
| `uploaded_refs` 上传文献 | | 拖入 pdf/docx | **进入 refs 池**,不注入 prompt |

上传文献解析管线:

```
拖入 → POST /api/deep_research/parse_upload (multipart)
     ↓ extract_text + 首页 title/作者/年份 regex
返回: { upload_id, title, first_author, year, abstract(首500字),
        full_text_available: true, page_count, parse_confidence: "high"|"low" }
```

- 全文缓存: `<project_data_dir>/deep_research/uploads/<upload_id>.txt`,项目删除时清理
- 生成的 `Reference` 对象加 `source: "upload"` 徽标,进入 refs 池置顶
- `parse_confidence=low` 时 UI 提示 "❓ 请核对题名"
- title 抽取完全失败时:前端行内提示用户手输题名,填了 → 后端用题名反查 crossref/pubmed/openalex 补摘要;点跳过 → 丢弃
- 反查也失败时,该条留在 refs 池但摘要为空,复核步显示 "⚠ 无摘要,仅凭全文深读"

### Step 2 · 检索设置

- 沿用 IdeaModule 相同的:调研深度(fast/deep)、年份范围、证据等级、影响力/分区筛选、报告语言
- 检索词:后端从 `question + field` 自动生成(复用 `literature.search_literature` 已有的 query 规划)
- 不呈现"关键词"字段

### Step 3 · 文献复核(核心新逻辑)

**列表来源合并**:
- 上传文献(source=upload,置顶)
- Zotero 导入(现有 ZoteroPanel)
- 检索结果(pubmed/europepmc/openalex/crossref/unpaywall/clinicaltrials)
- 按 title(normalize 后小写去空格)+ DOI 双键去重

**深读推荐**:

- 触发时机:refs 全部到位、evidence 摘要抽取完成后,自动 `POST /api/deep_research/recommend`
- 输入:摘要 + 用户研究问题;单次批量 LLM 调用
- 输出: `{ ref_key, score: "high"|"medium"|"none", reason }[]`
- 上限:`high ≤ 8`, `medium ≤ 5`(避免全标 high)
- UI 新列:⭐ 推荐(hover 看理由)+ ☐ 深读复选框
- 默认自动勾选所有 `high`
- 顶部横条:"AI 推荐深读 X 篇,已勾 N 篇,预计 token 成本 ~M"(前端本地估算)
- 无摘要的上传文献推荐分显示灰,允许手动勾深读

**下一步语义**:允许 0 篇深读(纯摘要合成模式);至少勾 1 篇 refs 才能进入 Step 4。

### Step 4 · 调研产出

**报告 Markdown 结构(强模板)**:

```markdown
# 调研问题
{原样 question}

## 一、当前解答
{子问题拆解并逐个回答,句尾带 [ref-N]}

## 二、文献共识
- 结论 A(3 篇支持:[ref-1][ref-3][ref-7])
- 结论 B ...

## 三、矛盾与不一致
### 矛盾点 1: XXX
- [ref-1] 结论 / 样本量 / 关键局限
- [ref-4] 结论 / 样本量 / 关键局限
- 可能原因: {方法学差异 / 人群差异 / ...}

## 四、研究空白
- 空白 1: XXX(原因: ...)
- 空白 2: XXX
```

Prompt 明确"若无矛盾/空白,该段写'未发现',不要凑数"。

**逐文献贡献表**(独立于报告正文,渲染在 EditableMarkdown 下方):

```
| # | 作者/年份 | 期刊 | 设计 | 样本 | 主要发现 | 与研究问题相关性 | 深读 |
```

- 相关性等级: 直接 / 间接 / 支持性
- 深读列: 是否用了全文
- 可导出 CSV

**追问 / 修改报告**:完全复用 IdeaModule 追问机制,endpoint `POST /api/deep_research/followup/stream`,复用 `FollowupPanel`。

**下游跳转**:一个通用 "→ 送到实验规划" / "→ 针对空白写标书" 按钮,传 report + refs;无"选题卡",无多方向跳转。

**导出**:复用 `ReportExportBar`(Markdown / Word / PDF / 复制);贡献表可单独导 CSV。

---

## 4. 架构

### 4.1 目录结构

**新增(前端)**:
```
frontend/src/modules/ResearchModule.tsx           # 主模块 ~700 行
frontend/src/components/AttachmentUploadBox.tsx   # 从 IdeaModule Step1 抽出
frontend/src/components/FollowupPanel.tsx         # 从 IdeaModule Step4 抽出
frontend/src/components/ReportExportBar.tsx       # 从 IdeaModule Step4 抽出
frontend/src/lib/uploadedLit.ts                   # 上传文献前端解析辅助
```

**新增(后端)**:
```
backend/app/deep_research.py                       # 推荐分 + 深读 + 合成 + 贡献表
backend/app/routes/deep_research_routes.py         # SSE endpoints
```

**改动**:
- `frontend/src/App.tsx`: NAV 加 dev 字段 + 过滤逻辑 + 设置齿轮改下拉;`ModuleId` union 加 "research"
- `frontend/src/modules/IdeaModule.tsx`: 用抽出的 3 个组件替换原 inline 代码(不改行为)
- `frontend/src/lib/sse.ts`: 新增 `streamDeepResearch`, `streamDeepResearchFollowup` + 事件类型
- `backend/app/main.py`: 挂载新路由

### 4.2 开发者模式

- 持久化 key: `dev:mode`(localStorage,默认 false)
- NAV 数组新增 `dev?: boolean`,`dev_mode=false` 时过滤:侧栏、首页卡片、命令面板
- 右上角 "⚙ 设置" 改为下拉菜单:
  - "API/模型设置" → 触发现有 onboarding wizard
  - "开发者模式" → toggle 开关
- Deep Research 是第一个 `dev: true` 项,位置紧跟 `idea`

### 4.3 SSE 事件(新增)

```ts
type DeepResearchEvent =
  | { type: "status"; message: string }
  | { type: "references"; items: Reference[] }
  | { type: "evidence"; items: EvidenceItem[] }
  | { type: "recommend"; items: { ref_key: string; score: "high"|"medium"|"none"; reason: string }[] }
  | { type: "deep_read_progress"; done: number; total: number; current_title: string }
  | { type: "delta"; text: string }
  | { type: "contribution_table"; rows: ContributionRow[] }
  | { type: "verify"; data: Verification }
  | { type: "warning"; message: string }
  | { type: "error"; message: string }
  | { type: "done" }
```

### 4.4 合成管线(两次 LLM 调用)

phase=generate 的服务端流程:

```
1. 加载 deep_read_targets 全文 (并发3, 单篇20s, 全局90s, 8k 截断)
   → 推 deep_read_progress 事件
2. 组装合成 prompt:
   - system: "循证综述助手,严格基于给定文献回答;无矛盾/空白时写'未发现'"
   - user: question + refs 摘要表 + 深读章节 + 强制模板(一/二/三/四)
3. 第一次 LLM stream → 推 delta 事件(Markdown 报告)
4. 第一次结束后,verify_references 核对引用真伪 → 推 verify
5. 第二次 LLM 调用(非 stream, JSON mode)生成 ContributionRow[]
   → 推 contribution_table
6. done
```

两次分离的原因:结构化输出与自由文本合并一次生成时,LLM 常"就近截断"表格或把表格塞进正文;分离更稳定。模型统一沿用 `llm.py` 默认(与 IdeaModule 一致)。

### 4.5 深读全文获取顺序

1. `source=upload` → 读 project 缓存 `<upload_id>.txt`
2. `source` 有 `oa_url`(Unpaywall/EuropePMC 补全)→ HTTP GET PDF → `extract_text`
3. `source` DOI 且 EuropePMC full-text 可用 → 拿全文 XML
4. 都不行 → 降级为仅摘要,贡献表标注"仅摘要"

限制:
- 单篇预算 8k tokens(超出优先保留 Results + Discussion 段,简单正则切段)
- 并发 3,单篇超时 20s,全局深读超时 90s

---

## 5. 数据模型

### 5.1 前端持久化 key(usePersistentState,按 project 隔离)

```
research:question, research:field, research:background, research:depth,
research:yearsBack, research:studyTypes, research:impactMin, research:minQuartile,
research:keepUnknownImpact, research:englishReport,
research:step, research:maxStep,
research:refs, research:selectedKeys, research:deepReadKeys,
research:uploadedRefs,
research:trials, research:evidence,
research:result, research:contribution, research:verify, research:qa,
research:refSort
```

### 5.2 后端数据类型

```python
class UploadedRef(TypedDict):
    upload_id: str
    title: str
    first_author: str
    year: str
    abstract: str
    full_text_available: bool
    page_count: int
    parse_confidence: Literal["high", "low"]

class RecommendItem(TypedDict):
    ref_key: str
    score: Literal["high", "medium", "none"]
    reason: str

class ContributionRow(TypedDict):
    n: int
    author_year: str
    journal: str
    design: str
    sample: str
    finding: str
    relevance: Literal["direct", "indirect", "supporting"]
    deep_read: bool
```

---

## 6. API

### 6.1 `POST /api/deep_research/parse_upload`

- multipart form, 单文件 pdf/docx
- 响应: `UploadedRef` + `upload_id` (缓存 key)

### 6.2 `POST /api/deep_research/lookup_title`

- 请求: `{ title: str }`
- 响应: `{ found: bool, abstract, first_author, year, url, doi }`
- 用于手输题名反查

### 6.3 `POST /api/deep_research/recommend`

- 请求: `{ question, refs: [{ ref_key, title, abstract }] }`
- 响应: `{ items: RecommendItem[] }`
- 单次 LLM 批量调用

### 6.4 `POST /api/deep_research/stream`(SSE)

- 请求:
  ```json
  {
    "question": "...",
    "field": "...",
    "background": "...",
    "depth": "deep",
    "sources": ["pubmed", "..."],
    "filters": {...},
    "phase": "search" | "generate",
    "references": [...],
    "evidence": [...],
    "deep_read_targets": [{ "ref_key": "...", "upload_id": "...", "oa_url": "...", "source": "..." }],
    "english_report": false
  }
  ```
- phase=search: 走检索,推 references / evidence / warning
- phase=generate: 走深读+合成,推 deep_read_progress / delta / contribution_table / verify

### 6.5 `POST /api/deep_research/followup/stream`(SSE)

- 与 IdeaModule 追问对齐: `{ mode: "ask" | "revise", question, report, references, evidence, english_report }`

---

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 上传解析失败 | 前端提示手输题名 or 跳过 |
| 手输题名反查也失败 | 保留条目,摘要空,复核步显示 "⚠ 无摘要,仅凭全文深读" |
| 深读单篇超时/下载失败 | 该篇降级仅摘要,贡献表标注"仅摘要",报告继续 |
| 全部深读失败 | 显示 warning banner,允许仅摘要合成 |
| 检索零命中 | 沿用 rewrite-suggest(将 question 当 field 走同一路径) |
| LLM 流中断 | 沿用现有:正文追加 "…(生成中断)",告警 |
| 引用核验发现幻觉 | 沿用 verify-bad 面板 |
| 项目切换 | 卸载时清理未提交的解析 tempdir |

---

## 8. 测试

后端 pytest(与现有 pattern 一致):
- `test_deep_research_parse_upload.py` — 上传 PDF/DOCX,title/abstract 抽取,含解析失败 case
- `test_deep_research_recommend.py` — mock LLM,断言 high/medium 上限、参数 schema
- `test_deep_research_deep_read.py` — mock fetch,超时降级、并发上限、8k 截断
- `test_deep_research_synthesize.py` — 4 段模板结构、引用核验、贡献表 JSON schema、"未发现"占位
- `test_deep_research_followup.py` — 追问流 ask/revise
- `test_dev_mode_gate.py`(可选) — 若有 e2e 框架,断言 dev 关闭时 nav 隐藏

前端手动测试清单(实施计划里落地):
- PDF/DOCX 混合上传 5 篇(含解析失败样本)
- Zotero 导入 + 检索 + 上传三路混合去重
- 深度 fast/deep × 深读 0/3/8 篇
- 中断 / 超时 / 零命中 / 全部深读失败四条失败路径
- 开发者模式开关的显隐(nav / 首页 / 命令面板三处)
- 项目切换时上传缓存清理

---

## 9. 兼容性

- 不改 `state.json` schema
- 不改后端 project schema
- 关闭 dev 模式后 `research:*` key 保留不清
- IdeaModule 抽 3 个公用组件时,data-testid 与 CSS class 保留原名,不打破现有 e2e

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| PDF title 抽取误判(尤其扫描件) | parse_confidence 字段 + UI 醒目提示 |
| LLM 编造矛盾(强模板凑数) | prompt 强制"无则写未发现";verify_references 兜底 |
| 深读把预算烧完仍无结论 | 前端 token 预估;fast 默认限 3 篇深读 |
| 上传缓存膨胀 | 按 project 目录清理 + 沿用现有 upload_limit |
| RAG 简单截断遗漏关键结论 | 已记为 task #7,首版上线后依 case 改进 |

---

## 11. 未来工作(不在本次范围)

- **task #7**: 改进深读全文的段落截取策略(章节切分 + 关键词打分 + 评估向量检索)
- 支持多研究问题批量调研
- 深读结果缓存(在项目内跨会话复用)
- 循证等级评级(GRADE-like),需要额外的口径评审
