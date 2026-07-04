# 实验规划 / 伦理材料 / 论文初稿 · 两阶段化 + 单一附加材料框

**日期**: 2026-07-04  
**范围**: 前端 3 个模块 UI 重构 + 后端 3 个 follow-up 端点 + 选题卡跳转载荷调整

## 背景与动机

用户反馈:三个「产出型」模块(实验规划 / 伦理材料 / 论文初稿)填写体验过于繁杂 —— 很多"可选"字段实际很少填、看着压力大。写标书环节已经采用"一个附加材料 combo 框(拖入 + 粘贴)+ 提示可放什么"的极简做法,用户希望这三个模块同样处理:

1. **去除所有"可选"字段框**,合并成一个统一的「附加材料」combo 输入框(参考 `GrantModule.tsx` L423–437 的实现)
2. 输入框旁只用**提示语**列出建议放入的内容(选题调研、既往草案、预实验数据、参考文献…)
3. 三个模块统一改成**两步向导**(Step 1 填写 → Step 2 预览 & 精修),与找选题 / 写标书对齐
4. Step 2 支持**追问 / 修改**(客户端调用后端 followup 端点),与找选题的交互对齐
5. 选题卡上的 `用此方向做实验规划 →` 按钮传参需要相应调整(废弃 `plan:field` / `plan:resources`,合并到新的 `plan:materials`)

## 目标 (In-Scope)

- 前端 `PlanModule.tsx`、`EthicsModule.tsx`、`ImradModule.tsx` UI 两步向导化
- 三个模块 Step 1 单一「附加材料」combo 框(文本 + 多文件拖入/选择,附件文本追加到同一个 textarea 内)
- 三个模块 Step 2 提供「追问 / 按此修改」两个按钮,与找选题体验一致
- 后端新增 `/api/plan/followup`、`/api/imrad/followup`、`/api/ethics/followup` 三个 SSE 流式端点
- `IdeaModule.tsx` L892–898 传参调整(选题卡 → 实验规划)
- 迁移已存在的 `usePersistentState` key,让老数据不至于在升级后失踪

## 非目标 (Out-of-Scope)

- 不改 `/api/ethics/render`(Word 模板占位符仍照旧填充,只是 UI 层把可选字段折叠进附加材料)
- 不改 PlanModule 里样本量计算器 / 随机化分组表功能(它们仍保留在 Step 2 底部)
- 不改 ImradModule 里的结构式摘要 / 关键词 / 一键投稿包功能(仍保留在 Step 2 底部)
- 不做 EthicsModule 完全 LLM 化的重构(改动过大,后续独立评估)
- 不改历史记录 (`addHistory`) 的数据结构

---

## 详细设计

### 一、PlanModule 两步向导

**Step 1 · 准备材料** 保留的字段:

- `plan:idea` **必填**「你的研究想法 / 课题」textarea rows=4
- **新增** `plan:materials` combo 框:  
  提示语:`可粘贴或上传:学科领域、可用资源(经费/设备/样本量/时间/团队)、已有草案/预实验数据、既往文献 等。支持 Word/PDF/txt,可多选。`  
  实现照抄 GrantModule L423–437 的 `combo-input` 结构(textarea + `📎 添加附件` + 拖入)。附件解析结果以 `[附加材料:<文件名>]\n…` 追加到 `plan:materials` textarea。
- **移除**:`plan:field` 单独框、`plan:resources` 单独框、独立的 `Dropzone`。

Step 1 底部两个按钮:
- `清空`
- `下一步:生成方案 →`(点击后进入 Step 2 并**立即触发**「生成实验计划」;若已有产出,则弹二次确认再重跑)

**Step 2 · 预览 & 精修**:

- 顶部 4 个产出按钮(全部保留):
  - `重新生成实验计划`
  - `生成 SAP`
  - `生成 DMP`  
  - `生成知情同意书`
  (原有 SAP/DMP/Consent 独立按钮从"和生成计划并列"改成"在预览区顶部作为二级按钮"。)
- 4 个 `ResultPanel`(plan / sap / dmp / consent)保留,顺序不变
- **新增** `plan:followups` QA 面板(仿 IdeaModule L927–958):textarea + `追问` + `按此修改主方案` 按钮
- 保留 `样本量交互式探索` 与 `随机化分组表` 两个 details 折叠区,位置放到追问面板之下
- 底部:`← 返回准备` / `重新开始`

**后端调用变化**:

- 生成时把 `plan:materials` 作为 `resources` 字段传给 `/api/run?module=plan` (兼容现有 prompt,避免改后端 prompt)。SAP / DMP / Consent 同理。
- `withSampleSize()` 逻辑不动。

### 二、EthicsModule 两步向导

保持后端 `/api/ethics/render` 不变。Word 模板占位符字段拆成两档:

- **必填(REQUIRED[])** 字段照旧显示,红星标记(见现有 L119–124)
- **可选字段**从表单中**移除**,提示语合并进「附加材料」框:
  例:informed_consent 的可选字段有「研究流程 / 受益 / 自愿原则」,则附加材料框的提示为「可粘贴或上传:研究流程、可能的获益、自愿参加与退出、隐私保护、既往方案 等」

**Step 1 · 准备材料**:

- 模板选择 tab(informed_consent / protocol / crf / data_use_commitment)保留
- 每个模板显示"必填字段"表单(仅 REQUIRED 中列出的字段)
- **新增** `ethics:<id>:materials` combo 框,提示语根据当前模板的**可选字段清单**动态生成
- 「⬇ 从实验规划导入」按钮:导入必填字段,其余原本会导入的字段现在**追加**到 `ethics:<id>:materials`(带 `[从实验规划导入]` 前缀)
- 底部:`清空字段` / `下一步:预览 & 下载 →`(需必填字段无缺失才可进入)

**Step 2 · 预览 & 下载**:

- Markdown 预览沿用 `renderPreview()`,但优先渲染:必填字段 + 一段"附加材料"段(把 combo 框内容以 `## 附加材料` 拼进预览末尾)
- `⬇ 下载 Word` 按钮位置不变;向后端传送时,把 `materials` 拼接到某个可选字段(例:`informed_consent` 拼进「研究流程」,`protocol` 拼进「研究背景」)以确保 Word 模板不留空 `{{占位符}}`  
  → 后端 `ethics.py::render` 遇到空占位符会用 `[待补充]` 填,能兼容;但用户主动填的附加材料**必须**用起来,所以采取"目标字段还没被必填占用时,把附加材料转填过去"的策略。为保证可预测性,前端在 `submitEthics()` 里做拼接。
- **新增** 追问/修改面板(调用新的 `/api/ethics/followup`):产出 **Markdown 修订版**,写回预览区;下载 Word 时以修订版为准(优先级:修订版预览 > 原始表单)。
- 底部:`← 返回填写` / `重新开始`

### 三、ImradModule 两步向导

**Step 1 · 准备材料**:

- `imrad:topic` 可选题目字段 —— 移除单独框,合并进附加材料提示
- **新增** `imrad:materials` combo 框(唯一填写区):  
  提示语:`可粘贴或上传:论文题目、引言/综述要点、方法(设计/对象/样本量/统计)、结果(真实数字)、讨论要点、参考文献、已有草案/表格等。支持 Word/PDF/CSV/xlsx/txt,可多选。表格类会自动检测 PHI。`
- **移除**:`topic` / `background` / `methods` / `results` / `discussion` / `refs` 六个 textarea 独立框
- **保留** PHI 检测开关和 DeidentifyDialog 逻辑(附加材料如果是表格,仍走 `handleUpload` 检测流程)
- **保留** 「↩ 从各模块导入」按钮:导入内容全部追加到 `imrad:materials`(而非分散到各字段)
- 底部:`清空` / `下一步:装配初稿 →`(点击后进入 Step 2 并立即调用 `/api/imrad`)

**Step 2 · 预览 & 精修**:

- `EditableMarkdown` 预览初稿(原 `imrad:draft` key 复用)
- 导出按钮 / 用此初稿去选刊 / 用此初稿去排版 —— 保留
- **新增** 追问/修改面板(仿 IdeaModule):`追问` 与 `按此修改主稿` 两个按钮
- **保留** 结构式摘要 + 关键词 + 一键投稿包三个 section
- 底部:`← 返回填写` / `重新开始`

**后端调用变化**:

前端拆分 `imrad:materials` 时,不再尝试解析成 6 个字段;直接把整段材料以 `methods` 参数(现有 prompt 里 methods 字段最灵活)传给 `/api/imrad`,或者更保险地把它同时填入 `background` / `methods` / `results` / `discussion` 四个参数(prompt 里没内容就不写)。**推荐**:后端 `imrad.py::assemble_imrad` 增加一个 `materials` 字段,prompt 里让 LLM 自行分栏;若考虑最小改动,前端可以简单地把整段塞进 `background` 字段。**选定方案:前端全塞入 `background`,prompt 层不变**。

### 四、选题卡 → 实验规划 传参

`IdeaModule.tsx` L892–898 `candidate-to-plan` 按钮当前的载荷:
```ts
goto("plan", { "plan:idea": `${c.title}\n\n${c.body}`, "plan:field": card.field, "plan:resources": background })
```

改为:
```ts
goto("plan", {
  "plan:idea": `${c.title}\n\n${c.body}`,
  "plan:materials": buildPlanMaterials(card.field, background, c),
  "plan:step": 1,
})
```

其中 `buildPlanMaterials()` 把领域、原始背景资料、候选方向的正文/引用文献拼成一段:
```
[学科领域] 肿瘤免疫治疗

[相关资料 · 来自找选题]
<background 原文>

[候选方向补充]
<c.body 剩余细节>
```

### 五、后端新增三个 followup 端点

**统一签名**(参考 `idea_followup` in `research.py` L1198):

```python
# app/plan_followup.py 新增(独立文件,不放进 app/plan.py)
async def plan_followup(inputs: dict) -> AsyncIterator[tuple[str, dict]]:
    mode = inputs.get("mode") or "ask"      # "ask" | "revise"
    question = inputs.get("question", "")
    draft = inputs.get("draft", "")         # 当前主方案(用作上下文)
    idea = inputs.get("idea", "")
    materials = inputs.get("materials", "")
    # revise 模式:输出完整修订版方案;ask 模式:回答具体问题
    # 严格基于 draft/materials,不新增编造数据
    ...
```

`ethics_followup`、`imrad_followup` 结构类似,把 `draft` 换成对应的当前预览/初稿。三个端点全部走 SSE (`delta` + `done`),路由路径沿用 `/api/idea-followup` 的**连字符**风格,即 `/api/plan-followup`、`/api/imrad-followup`、`/api/ethics-followup`,注册到 `text_gen.py`。

### 六、迁移与兼容

- 老的 `plan:field` / `plan:resources` / `imrad:background` / `imrad:methods` 等 usePersistentState key **不删除**(用户浏览器可能还有内容)——只是新代码不再读它们。在 Step 1 首次挂载时做一次性合并:调用 `mergeLegacyIntoMaterials("<module>:materials", [{key, label}, ...])`,把老 key 内容以 `[来自 <label>]\n<value>` 前缀追加到 `<module>:materials`,并置 sentinel `<module>:materials:migrated=true`。**老 key 保留不清空**——sentinel 保证只合并一次。这样即使用户 revert 到旧版本仍能看到自己的数据。
- `EthicsModule` 的模板 fields 定义中,把可选字段的 `key`(如 `研究流程`)从表单渲染中筛掉,但保留在 `TEMPLATES[].fields` 数组供 `renderPreview` 用。也就是新增一个 `visibleInForm(f)` helper:`REQUIRED[template.id].includes(f.key)`。

---

## 数据流示意

```
                            Step 1                 Step 2
IdeaModule (选题卡)         ─────────────>         生成/预览
                          plan:idea               plan/sap/dmp/consent 4 个 ResultPanel
                          plan:materials          追问/修改 → /api/plan/followup
                          plan:step=1             样本量 / 随机化 (折叠)
```

## 测试要点

- **单元级**(前端):Step 切换幂等;Step 1 表单校验;combo 框拖入解析
- **集成**(E2E,playwright 已在项目内):
  - 从选题卡进入实验规划:第 1 步表单已带入 idea + materials
  - 填写附加材料 → 生成 → Step 2 显示预览 → 输入追问 → 按此修改 → 预览更新
  - 老 key 存在时挂载后自动合并到 materials
- **后端**(pytest):3 个 followup 端点的 mock/正常路径

## 风险与回退

- **风险 1**:EthicsModule 的 Word 模板占位符若因附加材料合并出错,可能导致 `.docx` 生成失败。缓解:附加材料只拼进"目标字段还没被必填占用时"的可选占位符;若目标为空则用 `[附加材料]<内容>` 前缀;后端本就有 `[待补充]` 兜底。
- **风险 2**:老用户已有的 `plan:field` 内容如果未被合并成功,会在升级后"看似消失"。缓解:合并逻辑在 Step 1 挂载时执行,写入 `plan:materials` 后再清空老 key,确保只合并一次。
- **回退**:UI 层改动全部在 3 个模块文件内,回退只需 revert 这 3 个文件 + `IdeaModule.tsx` 的 1 处按钮 + 后端 3 个端点删除。

## 里程碑

1. 后端 3 个 followup 端点 + 单测
2. `PlanModule` 两步向导 + combo 框 + 追问面板 + 老数据合并
3. `ImradModule` 同上
4. `EthicsModule` 同上(注意附加材料 → 模板占位符的映射)
5. `IdeaModule` 选题卡按钮载荷调整
6. E2E playwright 走一遍三个模块的 Step1 → Step2 → 追问路径
