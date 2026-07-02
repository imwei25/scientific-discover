# 写标书 · 文风样例模仿 — 设计文档

日期：2026-07-02
状态：已与用户确认设计方向，待用户复核本文档

## 一、目标与动机

在「写标书」模块新增能力：允许用户上传一份 Word/PDF/txt 作为**文风样例**，让 AI 撰写申请书时**模仿其语言风格**（句式节奏、用词偏好、语气、连接词、段落展开习惯等）。这同时起到**去 AI 味**的作用——向真人样例的写法靠拢，天然弱化模型腔。

非目标（明确排除）：
- 不学样例的**内容/事实/数据/结论**，只学"怎么写"。
- 不做逐节不同风格、不做多样例融合、不做风格强度调节。
- 不上传样例时，行为与现状完全一致。

## 二、关键设计决策（已确认）

1. **风格表示 = 提炼「文风档案」**：上传样例后，由 AI 先把它压成一份简短（约 200 字）中文文风档案，撰写时注入这份**档案**，而不是把样例原文塞进 prompt。理由：干净、可复用、显著降低把样例内容当事实写进标书的风险、省 token。
2. **生效位置 = 写作期 + 去 AI 味都用**：
   - 分节撰写 / 逐节重写时注入文风档案，让 AI 一开始就照该风格写；
   - 同一份档案接到已有但**休眠**的「去 AI 味」`style` 参数上（现在前端固定传 `""`），全链路都能向样例靠拢。
3. **档案可编辑 + 开关**：提炼出的档案显示在可编辑文本框，用户可微调；旁边一个开关「撰写时模仿此文风」（默认开）。与现有"方案骨架确认"交互一致。

## 三、现有基础（复用，不重造）

- **上传与解析**：`frontend/src/components/Dropzone.tsx`（`mode="text"`）+ `lib/extract.ts` 已能把 Word/PDF/txt 解析成文本。文风样例上传直接复用。
- **去 AI 味 style 参数（休眠）**：`backend/app/deai.py` 的 `_rewrite_messages(block_text, style)` 与 `stream_rewrite(..., style=...)` 已支持"作者个人风格档案"；端点 `POST /api/deai/rewrite` 已接收 `style`。但前端 `DeaiPanel` 调 `streamDeai(value, blocks, "", ...)` 一直传空。本设计负责把 grant 的文风档案接上去。
- **非流式 LLM 调用范式**：`grant.py` 的 `_converge_scheme` / `_complete` 已是"喂材料→非流式返回结构化结果"的样板，文风提炼照此写。
- **引用/支持句核验**：不受影响，照常运行。

## 四、架构与数据流

### 4.1 后端

**新增：文风提炼（`backend/app/grant.py`）**
- `async def extract_style_profile(sample_text: str) -> str`
  - system prompt 铁律：
    - 输出**只能是对"怎么写"的抽象描述**（句长与节奏、用词书面/口语倾向、常用连接方式、段落展开习惯、人称、是否爱用排比/套话等）；
    - **严禁**复述或引用样例里的**任何具体研究对象、数据、结论、专有名词、句子原文**；
    - 若样例是别的学科/主题，也只提取通用语言风格。
  - 输入：`sample_text[:6000]`（截断控成本）。
  - 非流式，`task="grant_style"`（新环节键，未配置则用主模型）。
  - 失败/空样例返回 `""`（降级=不影响撰写）。
- 新环节键 `grant_style` 加进 `llm.STAGES` 注册表（供 `/api/config/stages` 展示）。

**新端点（`backend/app/routes/text_gen.py` 或 grant 路由所在文件）**
- `POST /api/grant/style`，body `{sample: str}` → `{profile: str}`。非流式 JSON。

**撰写注入（`backend/app/grant.py`）**
- `_section_messages(...)` 与 `_revise_messages(...)` 增加可选参数 `style_profile: str = ""`。
  当非空时，在 system 的铁律**之后**追加：
  > 【文风指引：在不违反上述铁律与基金申请书规范的前提下，模仿以下语言风格来遣词造句与安排节奏。它只影响"怎么写"，不提供任何事实、不改变研究内容、不新增/删改引用与数据。】\n<文风档案>
- `write_grant(inputs)` 与 `revise_section(inputs)` 从 `inputs` 读取 `style_profile`（前端传入），透传给上面两个构造器。
- mock 分支保持可用（忽略 style 或原样体现）。

### 4.2 前端

**`GrantModule.tsx` 新增状态（均持久化）**
- `styleSample: string`（样例解析出的原文，供"重新提炼"）
- `styleProfile: string`（文风档案，可编辑）
- `styleOn: boolean`（是否在撰写时模仿，默认 true）
- `styleBusy`（提炼中）

**表单区新增（独立于"研究基础/工作条件"）**
- 一个 `Dropzone`（`mode="text"`）「文风样例（可选）」+ 明确提示：**只学语言风格，不会把里面的内容写进标书**。
- 上传成功后存入 `styleSample`；由用户**点「提炼文风」按钮**触发 `POST /api/grant/style` → 填充 `styleProfile`（不在上传时自动调用，避免意外消耗额度）。
- 可编辑 `<textarea>` 显示 `styleProfile`；一个开关「撰写时模仿此文风」。

**撰写请求带上档案**
- `startWrite` 的 payload 增加 `style_profile: styleOn ? styleProfile : ""`。
- `reviseSectionWith` 同样带上。

**接到去 AI 味**
- `EditableMarkdown` 增加可选 prop `deaiStyle?: string`，透传给内部 `DeaiPanel`。
- `DeaiPanel` 的 `streamDeai(value, blocks, style, ...)` 用传入的 `deaiStyle`（缺省 `""`，保持其它模块不变）。
- `GrantModule` 把 `styleOn ? styleProfile : ""` 作为 `deaiStyle` 传给正文的 `EditableMarkdown`。

### 4.3 类型（`frontend/src/lib/sse.ts` / api 层）
- 新增 `grantStyle(sample) -> {profile: string}` 调用封装。
- `streamGrant` / `streamGrantRevise` 的 inputs 类型加可选 `style_profile`。

## 五、防串（内容不泄漏）三重护栏

1. **独立上传槽 + UI 明示**：文风样例与"研究基础/工作条件"分开，界面明确"只学风格不学内容"。
2. **提炼 prompt 铁律**：档案只能是抽象风格描述，严禁出现样例的专有名词/数据/结论/原句。
3. **写作注入语**：明确"只影响遣词造句与节奏，不提供事实、不改研究内容与引用"。引用与支持句核验照常兜底。

## 六、边界与降级

- 不上传样例 / 未提炼 / 开关关闭 → `style_profile=""`，行为与现状完全一致。
- 提炼失败或样例为空 → 返回空档案，不阻断撰写。
- 一份档案作用于整份标书；换样例＝重新上传并重新提炼。

## 七、测试计划

**后端**
- `extract_style_profile` 对一段样例产出**非空**档案；启发式断言档案**不含**样例里刻意植入的专有名词/数字（防串冒烟）。
- `_section_messages`/`_revise_messages` 传入 `style_profile` 后，system 里出现"文风指引"段且铁律仍在。
- 真实 API 抽查：同一节"有/无文风档案"两版对比，确认风格向样例靠拢且引用/支持句核验照常通过、未串入样例内容。

**前端**
- e2e（playwright，mock SSE）：上传文风样例 → 提炼 → 档案框可见可编辑 → 开关 → `startWrite` 请求体带 `style_profile`；关闭开关时带空串。
- 现有 grant e2e 全绿（回归）。

**构建**
- `npm run build` 通过（tsc + vite）。

## 八、涉及文件清单

- 后端：`backend/app/grant.py`（提炼函数 + 两处 prompt 注入 + 两处入参透传）、`backend/app/routes/text_gen.py`（新端点）、`backend/app/llm.py`（STAGES 加 `grant_style`）。
- 前端：`frontend/src/modules/GrantModule.tsx`（状态 + 上传区 + 提炼 + 开关 + 请求透传）、`frontend/src/components/EditableMarkdown.tsx`（`deaiStyle` 透传）、`frontend/src/components/DeaiPanel.tsx`（用传入 style）、`frontend/src/lib/sse.ts`（api 封装 + 类型）、`frontend/src/styles.css`（如需样式）。
- 文档：本 spec；实现后按 CHANGELOG 流程记一条用户可感知变化。
