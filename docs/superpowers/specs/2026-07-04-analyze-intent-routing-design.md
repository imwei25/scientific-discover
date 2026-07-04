# 数据分析:意图分流与结论净化 — 设计文档

- 日期:2026-07-04
- 涉及模块:`backend/app/dataanalysis.py`、`backend/app/routes/analysis_routes.py`、`frontend/src/modules/analyze/**`、`frontend/src/lib/sse.ts`
- 相关 issue / 讨论:用户反馈"画个简单柱状图,AI 输出一堆无关废话"

## 1 · 背景与问题

现有 `/api/analyze` 是**单一路径**:无论用户请求"画个柱状图"还是"跑 t 检验",后端都强制走完整的 5 步统计流水线(profile → T2 探索 → T3 方法规格 → T1 带三大透明化区块的代码 → 结论)。结果:

1. **纯画图请求被塞满统计废话**——LLM 依 prompt 强制打印 `『【方法选择】』/『【假设检查】』/『【数据质量】』`,再让"结论 LLM"复述这些块并按医学论文四段式写结论,pipeline 明显重于用户意图。
2. **结论区噪声大**——结论 prompt 强制 4 段(①方法与前提复述假设检查 ②核心发现 ③解读 ④局限),即便是真正的统计分析,①和后台已打印的透明化块高度重复;且 prompt 未禁止开场白,模型常加"我为您总结如下"等寒暄。
3. **无过滤管道**——`stream_chat → SSE delta → setConclusion(p => p + t) → EditableMarkdown`,前端零解析、原样渲染。

## 2 · 设计目标

- **G1 意图分流**:让"只画图"和"数据分析"走两条不同的后端流水线,画图路径**只出图,不出统计话术**。
- **G2 结论净化**:分析路径的结论区只保留"核心发现 / 解读 / 局限"三段,禁止开场白;假设检查、方法选择、数据质量、原始输出分别独立、默认折叠。
- **G3 兼容与最小改动**:不破坏现有 `/api/analyze` 契约(增字段,不改字段);不改代码生成 prompt(保留 `『【…】』` 分隔符);现有 refine 流程平移。
- **G4 鲁棒**:LLM 输出格式漂移时(缺全角括号、多加 markdown 标题、序号前缀、顺序颠倒),透明化切分要能优雅退化。

## 3 · 用户体验

### 3.1 前端模式开关

`DataPane.tsx` 顶部加**常驻单选按钮组**(不做隐藏 toggle,状态一眼可见):

```
  ⦿ 📊 数据分析      ⦾ 🎨 只画图
     跑统计+透明化+结论   只画图,不做统计不写结论
```

- 默认选 `📊 数据分析`(向后兼容,老用户无感)。
- 状态字段 `mode: "analyze" | "draw"`,存 `DataPane` 本地 state,和 `file/question` 一起提交后端。
- **Refine 继承同一 mode**——首次 analyze 的后续 refine 仍是 analyze;首次 draw 的仍是 draw。不允许中途切;想切请重新开始一次分析。避免"draw 出的极简代码被塞进三大区块 + 统计检验"式的上下文错乱。
- Refine 输入框的 placeholder 随 mode 变:
  - analyze:"换图型 / 加显著性 / 换分析方法……"
  - draw:"换成箱线图 / 加标题 / 换配色……"

### 3.2 结论区新版布局

`GeneralResults.tsx` 左栏顶部加一排 chip(每个都是可折叠元素,默认关闭,内容为空不渲染):

```
[▶ 方法选择]  [▶ 假设检查]  [▶ 数据质量]  [▶ 原始输出]
────────────────────────────────────────
## 核心发现
    …由 delta 流式追加…
## 结果解读与意义
    …
## 主要局限
    …
```

`draw` 模式下:整条 chip 栏、结论主区都不渲染,只显示图表面板。

## 4 · 后端设计

### 4.1 路由改动

`backend/app/routes/analysis_routes.py`:

- `/api/analyze` 和 `/api/analyze/refine` 各增一个 form 字段 `mode: Literal["analyze","draw"] = "analyze"`。
- 路由在 gen() 之前按 mode 分发:
  - `analyze` → `analyze_data(...)`(现有)
  - `draw`   → `draw_chart(...)`(新增)
  - refine 同理:`refine_analysis` / `refine_draw`

字段默认值兼容旧客户端。

### 4.2 新增 `draw_chart()` 流水线

写在 `backend/app/dataanalysis.py`,函数签名与 `analyze_data()` 对齐:

```
async def draw_chart(filename, content, question, chart_format, palette)
  → AsyncIterator[tuple[str, dict]]
```

流水线:

```
1. load_dataframe + _build_profile(df)          → profile
2. code = extract_code(_complete(_gen_draw_messages(profile, question)))
   yield ("code", {code})
3. run = _execute(code, df, chart_format, palette)
4. 自动修错(复用 _fix_code_messages,最多 3 次;不注入 fresh 分支)
5. if run.charts:  yield ("charts", {items})
   if run.stdout:  yield ("output", {text})   # 空则不发
6. 若失败:yield ("error", ...)
7. yield ("done", {})
```

**不调用** `_gen_explore_messages`、`_extract_spec_messages`、`_conclusion_messages`,**不发** `delta / transparency_*` 事件。

### 4.3 新增 `_gen_draw_messages()` prompt

```
系统:
你是数据可视化专家。用户想**只看图**,不做任何统计检验、不写文字结论。
请根据【数据画像】和【绘图请求】写一段 Python 代码,只画图。
{_LIBS_NOTE}

严格要求:
① 只使用已加载的 df,列名务必来自【数据画像】,严禁臆造;
② **只画图**——不做 t 检验/方差分析/相关/回归/生存分析等任何统计推断;
③ **绝对不要** print 『【方法选择】』/『【假设检查】』/『【数据质量】』等透明化区块;
④ 不要 print 结论性文字;必要时可 print 一两句极简说明(如"已生成条形图")便于日志;
⑤ 图要出版级质量:标题、带单位的轴标签、必要时图例;matplotlib 默认样式,不用 LaTeX,不 plt.show();
⑥ 若数据涉及分组,直接呈现即可(无需组间显著性标注,除非用户显式要求);
⑦ 柱状图/条形图数值轴从 0 开始;折线/散点可按需收紧范围。
只输出一个 Python 代码块,不要额外解释。

用户: 【数据画像】\n{profile}\n\n【绘图请求】\n{question}
```

### 4.4 `_split_transparency(stdout: str)` — 鲁棒切分工具

**目标**:把三大透明化区块从主分析结果里剥出来,LLM 输出格式漂移时能兜住。

```python
_TRANSPARENCY_MARKERS = {
    "method":     r"(?:^|\n)\s*[#>]*\s*[\d①-⑨]*[.、\s]*[『「]?\s*[【\[]?\s*方法选择\s*[】\]]?\s*[』」]?\s*[::]?",
    "assumption": r"(?:^|\n)\s*[#>]*\s*[\d①-⑨]*[.、\s]*[『「]?\s*[【\[]?\s*假设检查\s*[】\]]?\s*[』」]?\s*[::]?",
    "quality":    r"(?:^|\n)\s*[#>]*\s*[\d①-⑨]*[.、\s]*[『「]?\s*[【\[]?\s*数据质量\s*[】\]]?\s*[』」]?\s*[::]?",
}

def _split_transparency(stdout: str) -> dict[str, str]:
    """
    返回 {"method": str, "assumption": str, "quality": str, "main": str}。
    - 每个 marker 在 stdout 中找**首次**匹配位置
    - 按位置排序,相邻两个 marker 之间就是前一个 marker 的区块内容
    - 最后一个 marker 之后的内容 = 主分析结果("main")
    - 三个 marker 都不出现 → 全部塞进 "main",三段返回空串(优雅退化)
    - 只出现 1-2 个 → 已识别的进对应桶,其它保持空;主分析结果 = 最后 marker 之后 或 未匹配到时全部
    - 顺序颠倒也不预设,按实际位置切
    """
```

**兼容变体清单**(测试用例覆盖):
- `『【方法选择】』` — 标准
- `【方法选择】` — 缺外层
- `方法选择:` / `方法选择:` — 无括号 + 中英文冒号
- `# 方法选择` / `## 方法选择` / `### 【方法选择】` — markdown 标题
- `1. 方法选择` / `① 方法选择` — 序号前缀
- `--- 方法选择 ---` — 分割线包围(靠松散的前后空白吸收)
- 三个 marker 顺序不同 — 按 stdout 里出现位置切,不预设顺序
- 0-2 个 marker 出现 — 优雅退化到 "main"

### 4.5 改 `_conclusion_messages()` — 3 段 + 硬约束 + 前置裁剪

新 system prompt:

```
你是医学/药学/生物医学论文写作助手。基于以下【真实输出】撰写结论,严禁编造或改动其中的数字;
若某结论缺乏数据支撑请说明。

【输出格式硬约束】
- 严格 Markdown,直接从『## 核心发现』开始
- **绝对禁止**任何开场白/寒暄/"我为您总结如下"之类前言
- **绝对禁止**复述【方法选择】/【假设检查】/【数据质量】(这些已在其他区块单独展示,重复即为噪声)
- 只输出以下三个二级标题及其内容,不多不少:

## 核心发现
引用输出中的具体数值/统计量/p 值(精确值,如 p=0.003),区分相关与因果。

## 结果解读与意义
临床/研究含义。审慎措辞:统计显著(如 p<0.05)不等于临床意义或因果,不要夸大;
观察性数据只能谈关联。

## 主要局限
样本量、缺失/异常值处理、偏倚、混杂、假设是否满足等。
```

**流式裁剪**(双保险):

- **后端**:在流式发 `delta` 事件前,维护一个 `seen_hash: bool` 状态,只有当累计缓冲中出现 `##` 之后才真正把当轮 delta 转发出去(之前的字符即使 LLM 输出了寒暄也不落到前端)。累计缓冲能天然处理 `##` 跨 delta chunk 拆开的情况。伪代码:

  ```python
  buf = ""
  seen = False
  async for piece in stream_chat(...):
      if seen:
          yield ("delta", {"text": piece})
      else:
          buf += piece
          idx = buf.find("##")
          if idx >= 0:
              yield ("delta", {"text": buf[idx:]})
              seen = True
  # 兜底:LLM 全程没输出 `##`(比如它选择 `# ` 或纯文本),把缓冲原样送出,总比空白好。
  if not seen and buf.strip():
      yield ("delta", {"text": buf})
  ```

- **前端**:兜底再做一次相同裁剪(`setConclusion` 之前),防后端漏改。前端不做"never-seen 兜底"——后端已保证收尾必有内容。

### 4.6 `analyze_data()` 改动点

`_execute` 完成后、`_sanity_checks` 之前,插入:

```python
parts = _split_transparency(run.get("stdout", ""))
if parts["method"]:     yield ("transparency_method",     {"text": parts["method"]})
if parts["assumption"]: yield ("transparency_assumption", {"text": parts["assumption"]})
if parts["quality"]:    yield ("transparency_quality",    {"text": parts["quality"]})
if parts["main"]:       yield ("output",                   {"text": parts["main"]})  # 现有事件复用
```

去掉原本 "if run.stdout: yield (output, ...)" 的整段推送(被上面细分取代)。

`_sanity_checks` 仍拿完整 stdout(不是拆分后的),确保数字体检覆盖全部输出。

### 4.7 Refine 分支

- `refine_analysis()`(现有):同 4.6 加透明化切分。
- `refine_draw()`(新增):调用新增 `_refine_draw_messages()` (基于 `_refine_code_messages()` 精简版,删掉三大透明化区块与统计规范要求),不生成结论。
- **Mode 一致性由前端负责**——后端 refine 路由是无状态的(只接受本轮 FormData 里的 `mode + base_code`),不做跨请求校验。前端在 UI 层保证 refine 输入框只允许提交与首轮同 mode 的请求;若前端提交 `mode="draw" + base_code=分析代码`,后端仍按 draw prompt 处理(不会崩,但结果可能不合意)——这是可接受的边界情况。

## 5 · SSE 事件契约

| 事件名 | 载荷 | 何时发 | 前端行为 | mode |
|---|---|---|---|---|
| `status` | `{message}` | 各阶段进入 | 顶部提示条 | 两者 |
| `plan` | `{cards}` | T3 后 | 计划卡片 | analyze |
| `code` | `{code}` | 每次 codegen/fix 后 | 代码区 | 两者 |
| `charts` | `{items}` | 执行成功后 | 图表面板 | 两者 |
| `transparency_method` | `{text}` | 切分后 | 方法选择 chip | analyze |
| `transparency_assumption` | `{text}` | 切分后 | 假设检查 chip | analyze |
| `transparency_quality` | `{text}` | 切分后 | 数据质量 chip | analyze |
| `output`(复用) | `{text}` | 切分后(仅剩主分析结果段) | 原始输出 chip | analyze |
| `delta` | `{text}` | 结论流式(已裁剪) | 追加结论主区 | analyze |
| `error` | `{message}` | 失败 | 报错提示 | 两者 |
| `done` | `{}` | 结束 | 停 loading | 两者 |

`draw` 模式**永远不发** `plan/transparency_*/output/delta`。

## 6 · 前端改动

### 6.1 `frontend/src/lib/sse.ts`

`streamAnalyze` / `streamAnalyzeRefine` 签名增:
- `mode: "analyze" | "draw"`(和 FormData 一起发)
- 回调新增 `onTransparency?: (kind: "method"|"assumption"|"quality", text: string) => void`

在 event 分发处新增三个 case:
```typescript
else if (ev.event === "transparency_method")     h.onTransparency?.("method",     data.text ?? "")
else if (ev.event === "transparency_assumption") h.onTransparency?.("assumption", data.text ?? "")
else if (ev.event === "transparency_quality")    h.onTransparency?.("quality",    data.text ?? "")
```

### 6.2 `frontend/src/modules/analyze/DataPane.tsx`

- 加 `mode` state,顶部单选按钮
- 请求前把 `mode` 传进 `streamAnalyze / streamAnalyzeRefine`
- 新增 `transparency` state:`{ method: string; assumption: string; quality: string }`,注册 `onTransparency` 回调追加/覆盖
- `onDelta` 前置裁剪:未见 `##` 之前缓冲丢弃,见到后正常追加
- `refineInput` placeholder 与 `mode` 挂钩
- 切换 mode 时清空当前结论 + 透明化 state(避免混淆)

### 6.3 `frontend/src/modules/analyze/GeneralResults.tsx`

- props 新增 `mode`、`transparency`、`rawOutput`
- 顶部渲染 chip 栏:`method / assumption / quality / rawOutput` 四个,均为 `<details>`,内容为空的不渲染
- `mode === "draw"`:不渲染 chip 栏、不渲染 conclusion 区,只保留 charts 面板

## 7 · 错误处理

| 场景 | 行为 |
|---|---|
| draw 模式代码执行失败 | 复用 3 次自动修错,失败则 `error` 事件 + `done` 结束 |
| analyze 模式 stdout 无任何透明化 marker | 全部塞 `output` 事件,不发 3 个 `transparency_*`,前端 chip 只显 "原始输出" 一个 |
| analyze 模式结论 LLM 输出始终没出现 `##` | 后端在流结束前把累计缓冲整体作为一条 delta 送出(见 4.5 兜底);前端照常渲染 |
| refine 请求 mode 与首轮不一致 | 前端 UI 层已阻止;后端不校验(无状态设计),按提交 mode 处理 |
| 旧客户端不传 `mode` | 默认 `"analyze"`,行为完全兼容 |

## 8 · 测试

### 8.1 后端单测(新)

- `test_split_transparency.py`:
  - 标准三段
  - 缺全角括号
  - markdown 标题包裹(`##`)
  - 序号前缀(`1./①`)
  - 顺序颠倒
  - 只有 1 段/2 段
  - 0 段(全都无) → 全落 `main`
  - 空串
- `test_draw_chart.py`(mock LLM):draw 模式不发 `delta / transparency_*`
- `test_conclusion_prompt.py`:模拟 LLM 前部含寒暄,断言后端裁剪后前端只看到 `## 核心发现` 起

### 8.2 前端 e2e / component

- DataPane 模式切换 → 后续请求的 FormData 里 `mode` 变化
- 收到 4 个透明化事件 → 4 个 chip 展开可见对应内容
- draw 模式回包只有 `charts + status` → 界面仅显示图
- Refine 与首轮 mode 强绑定

## 9 · 迁移与回滚

- 后端 form 字段带默认值,兼容不传 `mode` 的老客户端
- 前端 chip 栏只在有对应事件时才渲染,老流程若因故不发新事件也不破坏 UI
- 回滚:恢复旧 `_conclusion_messages` 和 `analyze_data` 的 stdout 单事件推送;前端删 chip 栏与 mode 单选;后端 `draw_chart` 与 `refine_draw` 保留不影响。

## 10 · 非目标(明确不做)

- 不做"自动意图识别"(LLM 分类或关键词兜底)——用户在 UI 显式选,避免误判翻车。
- 不改 T2 探索 / T3 spec / T1 代码生成 prompt(除结论 prompt 外),避免大范围回归。
- 不改现有配色/图表 API,不改 `_LIBS_NOTE`。
- Draw 模式不做 refine 转 analyze 的"升级",反之亦然;需切请新开一次分析。

## 11 · 落地文件清单

**后端**
- `backend/app/routes/analysis_routes.py` — `/api/analyze` 和 `/api/analyze/refine` 加 `mode` 分发
- `backend/app/dataanalysis.py`:
  - 新增 `_gen_draw_messages()`、`draw_chart()`、`refine_draw()`、`_refine_draw_messages()`
  - 新增 `_split_transparency()`
  - 改 `_conclusion_messages()`
  - 改 `analyze_data()` / `refine_analysis()` 的 stdout 推送段
  - 新增结论 `delta` 前置裁剪逻辑

**前端**
- `frontend/src/lib/sse.ts` — `streamAnalyze` / `streamAnalyzeRefine` 加 `mode` + `onTransparency`
- `frontend/src/modules/analyze/DataPane.tsx` — mode 单选、透明化 state、delta 裁剪
- `frontend/src/modules/analyze/GeneralResults.tsx` — chip 栏、draw 模式简化布局

**测试**
- 后端:`test_split_transparency.py`、`test_draw_chart.py`、`test_conclusion_prompt.py`
- 前端:补 DataPane / GeneralResults 组件 / e2e 用例

**部署提示**
- 前端改完必须 `npm run build`(参见 `MEMORY.md` — 后端托管 dist,不 build 用户看不到变化)。
