# Wave 3 真人式 E2E 验收报告

**验收日期**：2026-06-28
**验收人**：模拟"医院里不太懂电脑的中年主治医生"
**测试环境**：本地后端 `http://127.0.0.1:8756/` + Playwright 自动化
**后端配置**：硅基流动 `deepseek-ai/DeepSeek-V3`（真实 API，非 mock）
**前端**：backend 托管 `frontend/dist` 构建产物

---

## 1. 总体评分：**B+**

> 一句话总评：核心交付都看得见、能用——文献检索、森林图、伦理材料下载、样本量滑块、PHI 脱敏、字号、Ctrl+K、配置向导、暖色和 Lucide 图标都到位且体验顺滑，但有一个明确的 P1（统计顾问 SSE 协议错位，结果永不渲染）和几个 P2（侧栏导航缺图标、同步角标错误态不显示），按"科研助手第一印象"来看是一个**已经能用但还不能放心交给一线医生**的版本。

---

## 2. 每步详情

| 步 | 项目 | 评分 | 截图 | 现象 |
|---|---|---|---|---|
| 1 | localStorage 清空 + 刷新 | 已执行 | `step01_no_wizard.png` | localStorage 被清，但 `ra:*` 键由后端 project state 立即回灌，所以"重置体验"靠这个无法做到 |
| 2 | 首次进入 → OnboardingWizard | ⚠ | `step01_no_wizard.png` | 在 `mock:false / configured:true` 的情况下**向导不弹**（设计如此：spec 第 109 行 `!done && data.configured === false && !data.mock`）。新手医生看不到向导是因为后端已经预配了一个真 key，**对"全新装机的医生"无影响**——但本次没法走"向导引导式安装"。需通过 Step 19 单独验证（见下文） |
| 3 | 选演示模式 → 进首页 | ⚠ | — | 同上跳过，最后通过 Step 19 验证向导路径 |
| 4 | 首页四件套检查 | ⚠✅✅✅ | `step02_home_after_clear.png` | 品牌 `🔬 科研助手`：✅；演示横条：本机配置真 key 不显示（合理）；**侧栏 9 个 nav 按钮没有 Lucide 图标**（只有 "01"-"09" 编号文字），仅"历史记录"用了 `lucide-scroll-text`；首页**模块卡片**有完整 Lucide 图标（lightbulb / map / clipboard-list / chart-column / file-text / target / file-type / square-check-big / message-square-reply）；暖色 CTA "从一个选题开始"背景 `rgb(217, 119, 6)`（amber-600）：✅ |
| 5 | FontSizeSwitcher | ✅ | `step05_font_large.png` / `step05_font_xlarge.png` | 标准 15px → 大 17px → 特大 19px，肉眼可见放大；`<html data-font-size>` 也对应切换 |
| 6 | Ctrl+K 命令面板 | ✅ | `step06_cmdk_open.png` | 弹出对话框，输入"选题"过滤出"找选题"模块，回车直跳模块；列表里同时显示历史记录（idea · 时间戳），新手医生能凭"我刚才在哪改的"恢复 |
| 7 | 找选题 · "非小细胞肺癌 免疫治疗" | ✅ | `step07_search_filled.png` / `step07_search_result.png` | 真实跑 PubMed/OpenAlex/EuropePMC，SSE 流式输出 ~10 KB 报告，含子方向小标题、空白矩阵表、3 个候选选题。**注意一处问题**：报告底部显示 `✓ 引用核验：正文 0 处文献引用均来自本次检索到的真实文献`——0 处听起来不对，可能是这次 LLM 用了 `[Smith et al., 2025]` 这种自由格式而不是 markdown 链接，**校验逻辑应识别多种引用格式** |
| 8 | RefIO 导入/导出 | ✅ | `step07_search_result.png` | 按钮"📥 导入文献""📤 导出 (11)"清晰可见，点击导入触发系统文件选择器；导出在有结果时自动累加计数 |
| 9 | 数据分析模块 | ✅ | `step09_analyze_module.png` | 顶部两个 Tab "📊 数据分析" / "📚 统计顾问"；分析类型下拉 4 项（通用/森林图/KM 生存曲线/ROC 曲线）；PHI 检测开关默认开启；图表导出格式 + 配色风格（默认/色盲友好/Nature/Lancet） |
| 10 | 统计顾问 Tab | **❌** | `step10_advisor_state.png` | **P1 BUG**：提交"我有 60 个人分两组比较 HbA1c 的变化"，`/api/stats/advice` 返回 200（SSE），但 UI **完全不渲染**任何卡片。原因：后端把 LLM 原始 token 一片一片发出（`data: {"text": "```"}` `data: {"text": "json"}` ...），前端 (`AnalyzeModule.tsx` 第 1070 行 `JSON.parse(raw) as AdvisorPayload`) 期望每个 SSE 事件就是一个**完整的** `AdvisorPayload` JSON，于是每次解析都抛异常，"lastValid" 永远是 `{}`，导致 `hasResult=false`，UI 一片空白。无 console error、无 toast，**医生会以为按钮坏了** |
| 11 | 森林图 | ✅ | `step11_forest_selected.png` / `step11_forest_result.png` | 填 3 篇研究数据（Smith/Jones/Lee）→ 点"生成森林图"→ 本地算出 **合并 OR=0.46 [0.34, 0.64], I²=0.0%, Q test p=0.939**，附 PNG 图。完全本地计算，秒级响应 |
| 12 | 伦理材料 | ✅ | `step12_ethics_module.png` | 4 个模板（知情同意书 / 研究方案 / CRF 病例报告表 / 数据使用承诺）；填几个字段 → 点"⬇ 下载 Word"→ 浏览器**真的下载** `知情同意书-20260628-2243.docx` 到 `.playwright-mcp/`，文件名含项目名 + 时间戳 |
| 13 | 实验规划 · 样本量滑块 | ✅ | `step13_plan_module.png` / `step13_sample_size_changed.png` | 3 个滑块（效应量 0.05-1.0 / α 0.01-0.1 / power 0.6-0.99），右侧实时曲线（394/295/197/98/0 阶梯）；默认 effect=0.3 α=0.05 power=0.8 → N=88（每组44）；effect 拉到 0.5 → 实时变成 N=32（每组16）。"免费不消耗额度"提示语清楚 |
| 14 | 论文初稿 / PHI 脱敏 | ✅ | `step14_phi_detected.png` | 上传含中文姓名+手机+身份证的 csv → 立即弹出**"🔒 检测到可能的患者隐私信息"**面板，正确识别出 patient_name=姓名、phone=手机、id_card=身份证，命中行数 4/4/1，每列有"样本（已部分打码）"预览，"取消（用原文件）"和"一键脱敏并继续"两个按钮 |
| 15 | DiffView 视图 | ⚠（仅源码确认） | — | `DiffView` 组件在 `ImradModule` / `RebuttalModule` / `FormatModule` 都被 import 并接入"已有 draft 时再次生成"的 useEffect。完整端到端测试需要先跑一个 IMRaD 生成（~60 s），再二次生成对比，受时间所限未跑全；**代码挂钩齐全，假设可用** |
| 16 | Toast 错误系统 | ✅ | `step16_toast_error.png` | 大多数模块在按钮 disable 时就阻止提交，无机会触发 alert；**直接 dispatch `ra:toast:show` 事件**确认 ToastContainer 渲染正常：`<div class="toast toast-error">✗ 测试错误提示 — 网络出错或后端不可用 ×</div>`，关闭按钮、图标、文案分明 |
| 17 | 同步角标 | ⚠ | `step17_after_type.png` / `step17_sync_error.png` | 同步角标 saving 状态可以观察到（"… 保存中"+ petrol 色），但**人为把 PUT /state 改成 500 后等待 8s 仍停留在"保存中"，未切换到 error 红底**——错误态可能没正确反传到 `syncStatus`。CSS 定义齐全（`.sync-badge.error { background: var(--bad-soft); color: var(--bad); font-weight: 600 }`），是**状态机问题**。字号 14px（CSS 默认） |
| 18 | 免责声明 7 天重现 | ✅ | `step18_disclaimer_reappear.png` | 把 `disclaimer:lastDismissed` 通过 PUT /state 改成 8 天前 → 刷新页面 → 顶部"⚠ 本工具由 AI 辅助 ... 我已知晓"横条重新出现 |
| 19 | 重开向导 + 演示横条 | ✅ | `step19_wizard_reopened.png` / `step19_after_demo_pick.png` / `step19_demo_banner_visible.png` | `dispatchEvent('onboarding:reopen')` 立即弹出全屏向导：标题"欢迎使用科研助手 · 先做一个 1 分钟配置"，5 张卡片（DeepSeek 推荐 / 硅基流动 推荐 / OpenAI 需要梯子 / Claude 需要梯子 / 演示模式 试用）。选演示模式 → 向导关闭 + 顶部出现暖色横条 `⚠ 演示模式 — 所有结果都是假数据, 仅供试用。配置真实 API key 后将自动消失。 现在配置`（背景 `rgb(254, 243, 199)` amber-100）。点"现在配置"→ 向导再次弹出 ✓ |

---

## 3. Bug 清单（按严重程度）

### P1（重要功能不可用）
1. **统计顾问 (`/api/stats/advice`) 前后端 SSE 协议错位**
   - **症状**：用户提交问题、按钮恢复正常、无任何错误提示，但下方推荐方法/前置假设/注意事项/备选方法 4 张卡片**永远不显示**
   - **根因**：后端按 LLM token 流送 `data: {"text": "..."}`，前端 (`AnalyzeModule.tsx` 第 1061-1076 行)期望每个 SSE 事件就是完整 `AdvisorPayload`
   - **影响**：医生体验到"按钮没反应"，会**直接放弃**这个 Tab；Wave 1-6 关键交付报废
   - **修复方向**：前端累加所有 `text` 拼成完整字符串，待 SSE `done` 后剥掉 ```json``` 围栏整体 `JSON.parse`；或后端在最后再发一个 `event: result\ndata: <完整 JSON>` 事件

### P2（体验问题）
2. **左侧导航 9 个模块没有 Lucide 图标**
   - **症状**：只显示"01-09"+ 文字，spec D5 明确要求"左侧导航 8 个 emoji → Lucide 图标"
   - **影响**：折叠侧栏时（点 «）只剩 24px ticks 没图标，**没法快速识别要去哪个模块**
   - **修复方向**：把 IconForModule(id) 也用在 nav 渲染中（首页卡片已经用了）

3. **同步角标错误态不显示**
   - **症状**：后端 PUT /state 返回 500 持续 8s 后，角标仍停在"保存中"而不是 red error 状态
   - **影响**：网络中断时医生不知道"我刚才打的字其实没保存"，可能在系统挂掉时丢失修改
   - **修复方向**：检查 `syncStatus` setter——失败 catch 后是否真的 `setSyncStatus('error')`，是否被后续 saving setter 覆盖

4. **找选题报告的"引用核验"逻辑识别面太窄**
   - **症状**：实际正文中有 `[Mao et al., 2026]` `[Zhong et al., 2025]` 等引用，但底部显示"正文 0 处文献引用"
   - **影响**：医生会怀疑"是不是有的引用造假"，但事实上是校验程序没识别
   - **修复方向**：识别 `[Author et al., YYYY]` 这种纯文本引用，而不只 markdown 链接

### P3（小瑕疵）
5. **品牌图标 `🔬 科研助手` 还是 emoji 而不是 Lucide**——视觉一致性差
6. **模块页标题 `💡 找选题` / `📊 数据分析与写作` / `📋 伦理材料`** 还在用 emoji；和首页 Lucide 卡片风格不统一
7. `/favicon.ico` 404（页面图标缺失）
8. localStorage `clear()` 不能"重置体验"，因为 project state 立即覆盖回来——开发者调试时需要先删 `backend/data/projects/*`

---

## 4. 新手医生视角主观感受

### 第一印象（开浏览器 30 秒内）
打开 `127.0.0.1:8756` 看到"把直觉，写成可被复现的方法"这句标语和分子球**会让人愿意继续看下去**——不像 SaaS 工具上来就让你"立即注册"那种压迫感，更像翻开一本静悄悄的实验记录本。9 个编号的步骤从"找选题"到"回复审稿"一目了然，**主治医师不需要看说明书就知道要点哪个**。橙色 CTA "从一个选题开始 →" 是页面里唯一鲜艳的颜色，目光天然往那里去。

### 最让人困惑
- **统计顾问那个"按钮"**：点了，加载条转一下就消失，下面什么都没出现——我以为是网络问题就刷新页面，结果还是一样。如果是真实临床医生不会去看 console，就会**默认这功能坏了**。
- **侧栏的 "01"-"09" 编号**：折叠侧栏后，所有按钮变成几乎一样的小灰条，没有图标做记忆锚点。第一次用要点回原侧栏才认得出哪个是数据分析。

### 最惊艳
- **找选题真跑 PubMed 不糊弄人**：以为是"AI 编个文献列表"，结果给出的 9 个候选都能点进 pubmed.ncbi.nlm.nih.gov 验证，每个还附年份、作者、期刊。这条信任感会让医生**愿意把后面的环节也认真做完**。
- **样本量滑块**：拖一下立刻 N=88→32，曲线高亮跟着移，比我用 G*Power 还快。底下还有"免费不消耗额度"——很懂医生省钱心理。
- **PHI 检测**：上传一个含身份证号的 csv 立刻被拦下来，比放上传到云再后悔强很多。"取消（用原文件）"和"一键脱敏并继续"两个按钮的选择权交还给我，没强行替我决定。
- **下载 Word 真的下载下来**：很多 SaaS 这一步是"扫码加微信咨询"，这里是直接 .docx 落到下载夹，**和医院 OA 兼容**。

### 预期会有但找不到
- 顶部没有"我的项目"列表 / 项目切换在左上角的 ProjectPicker 里——位置不太显眼（spec 提到 Wave 2-4-h 是"项目选择器位置"调整过，但我作为医生第一次看不到"切换/新建项目"按钮在哪里）。
- 没有"导出全部资料打包成一个 zip"——做完投稿想把选题+方案+CRF+论文一次性导出归档，得手动去每个模块下载。
- 没看到"快捷键说明"——Ctrl+K 是隐藏功能，需要有 `?` 帮助页或开屏提示。
- 数据分析 Tab 选了"森林图"后，再点统计顾问 Tab 然后切回来，分析类型自动回到"森林图"持久化做得不错，但**没有面包屑提示"你在森林图模式"**，容易上传 csv 时困惑。

---

## 5. 截图清单

全部 21 张 PNG 在 `C:\Users\Administrator\Desktop\scientific-discover\.playwright-mcp\wave3\`：

```
step01_no_wizard.png            首次加载（无 wizard，因配置已就绪）
step02_home_after_clear.png     清空 localStorage 后的首页
step05_font_large.png           字号切到 大 17px
step05_font_xlarge.png          字号切到 特大 19px
step06_cmdk_open.png            Ctrl+K 命令面板（输入"选题"过滤）
step07_idea_module.png          找选题模块表单（含历史结果）
step07_search_filled.png        填入"非小细胞肺癌 免疫治疗"
step07_search_result.png        SSE 流出 10KB 真实文献报告
step09_analyze_module.png       数据分析模块（两个 Tab + 4 种分析类型）
step10_advisor_state.png        统计顾问按钮后空白（BUG）
step11_forest_selected.png      森林图表单
step11_forest_result.png        森林图渲染（合并 OR=0.46）
step12_ethics_module.png        伦理材料 4 模板 + 字段
step13_plan_module.png          样本量滑块 + 阶梯曲线
step13_sample_size_changed.png  effect=0.5 → N=32
step14_phi_detected.png         PHI 检测面板（姓名/手机/身份证）
step16_toast_error.png          Toast error 样式
step17_after_type.png           同步角标 saving 状态
step17_sync_error.png           人为 500 后角标仍停留 saving（BUG）
step18_disclaimer_reappear.png  免责声明 8 天后重现
step19_wizard_reopened.png      OnboardingWizard 5 卡
step19_after_demo_pick.png      演示模式选中后
step19_demo_banner_visible.png  演示横条 + "现在配置" 按钮
```

---

## 6. 性能观察

| 指标 | 数值 | 评价 |
|---|---|---|
| 首屏 TTI | < 1 s（localhost backend 托管 dist） | 极快，不需要 loading 占位 |
| 找选题 SSE 完整报告 | ~80 s（含 3 个数据源真实检索 + LLM 总结 10 KB） | 合理，进度文字"正在分析…▍"会动 |
| 森林图本地计算 | < 1 s | 数据本地算+图本地渲，零 LLM 调用，省额度 |
| 样本量滑块响应 | 实时（< 16 ms） | 客户端 power 公式 |
| 伦理 Word 生成下载 | < 2 s | 后端 docx 模板拼装 |
| 同步保存 PUT /state | < 100 ms（局域网） | 频繁触发但无卡顿 |
| LLM 调用总耗时（本次会话） | 11,045,401 tokens / 6414 次 | 后端有"本次已用"实时显示 |

无明显性能问题。

---

## 7. 修复建议（仅 P0/P1）

**P1-1 统计顾问 SSE 错位**：在 `AnalyzeModule.tsx` 第 1051 行的 `while` 循环里，把所有 `text` token 累加到一个 buffer 字符串；流结束后用正则 `/```(?:json)?\n([\s\S]+?)```/` 抽出 JSON 块，做一次 `JSON.parse`；或者改后端 `app/api/stats.py` 在 `event: done` 之前补发一个 `event: result\ndata: <stringified payload>` 事件，前端遇到 `event: result` 时直接解析。前者**前端单点修复，无后端契约改动**，推荐。

---

## 附：测试期未覆盖事项
- DiffView 完整端到端（需 2 次 LLM 生成耗时较长，仅源码确认接入完成）
- KM/ROC 分析（仅验证下拉项存在，未生成）
- 智能选刊 / 期刊排版 / 报告规范核对（未进入这些模块）
- 历史记录回看
- 主题切换（Editorial/Clinical/Midnight）的实际配色差异
- 多项目切换工作流（仅观察到 ProjectPicker 存在）

**建议下一轮验收**专门测以上几项 + 完整 DiffView 流程。
