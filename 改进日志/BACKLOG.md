# 改进待办清单 (BACKLOG)

> 由 /loop 自动维护。状态：`[ ]` 待办 / `[~]` 进行中 / `[x]` 完成 / `[-]` 放弃(附原因)
> 循环每次从顶部取一个未完成项处理。方向在被选中时才深入调研，下面是初始假设。

## 任务拆解 (子任务)

### 子任务A：生成质量（找选题/实验规划/写作 prompts.py, research.py）
- [x] A1+A2+A3：找选题候选题改为 `### 候选选题N：题名` 结构化小标题(契约化, 前端稳定解析+降低等待焦虑)，并强制每个选题单列一行 `> 可行性 ★N/5(理由)｜创新性 ★N/5(理由)` 自评分，帮非专业读者快速判断。research.py 三处综述 prompt(deep reduce / shallow synthesis / deep synthesis) 与 prompts.build_idea 全部统一。

### 子任务B：数据分析正确性（dataanalysis.py, samplesize.py）
- [x] B5：数据分析自动纠错重试 2→3 次（共4次执行）——真实 LLM 端到端测试发现旗舰分析会间歇性失败（AI 写的 pingouin 代码首次常报错，2次重试边缘不够、整次失败）。多给一次显著提高成功率。新增 test_analyze_retry.py。
- [x] B1+B2+B3：数据分析透明化——代码生成 prompt 强制先 print 三个标题区块『【方法选择】』(变量类型/样本量→选检验+理由)、『【假设检查】』(实跑 Shapiro/Levene 并据结果决定参/非参)、『【数据质量】』(缺失/异常值处理策略透明)；出图要求标题/带单位轴标签/组间显著性标注；结论 prompt 增『方法与前提』段复述。沙箱实测此类代码(scipy 假设检验+作图)跑通。
- [x] B4：CSV 编码健壮性——中文用户从 Excel 导出的 GBK/带BOM CSV 现在能正常读取（原默认 utf-8 会崩）

### 子任务C：稳定性与错误处理（llm.py 降级, main.py）
- [x] C1：LLM 超时/网络错误现包装成友好中文 LLMError，瞬时错误自动重试2次，重试耗尽再切备用供应商；已产出内容则不重试避免重复。新增 test_network_retry.py 回归。
- [x] C2：降级链路（主→FALLBACK）日志可观测——llm.py 新增 `_log`(打到 server.log)，在①主供应商瞬时错误重试、②中途出错不重试、③切换到备用(标注原因:额度/网络)、④备用成功接管/失败 各打一条日志；备用供应商失败也包成 LLMError 上抛并记录。此前整条降级链路静默, 线上排查无据。
- [x] C3-a：数据分析安全护栏修复误杀——`_DANGER` 之前用 `\b` 会把合法的 pandas `df.eval()` 当危险拦掉；改为负向后顾仅拦内置 eval/open（并新增拦 exec），合法 pandas 方法/re.compile/含open列名不再误伤。新增 test_danger_guard.py。
- [x] C3-b：上传文件大小校验——Dropzone 对 >30MB 文件直接拒绝并提示，避免超大文件读入内存/上传卡死。e2e 新增 31MB 文件被拒用例。
- [x] C3-c：后端上传大小上限——main.py 新增 _read_capped 分块读取(超 30MB 即停并返回 None)，/api/analyze 与 /api/extract 都用它，超限给友好错误而非 500/OOM。新增 test_upload_limit.py（单元 + TestClient 端到端）。
- [ ] C3：上传文件/参数校验，非法输入给友好提示（其余参数校验）

### 子任务D：前端体验（App.tsx, styles.css）
- [ ] D1：错误态/空态/加载态统一与可读
- [x] D2：修复局域网 http(非安全上下文)下复制按钮失效——新增 lib/clipboard.ts（navigator.clipboard 失败/不可用时回退 execCommand），并给“复制失败”反馈；ResultPanel 与 FormatModule 复制全部均改用它。e2e 新增非安全上下文复制用例。
- [ ] D3：移动端/窄屏与无障碍（对比度、focus）基本可用
- [x] D4：历史记录 localStorage 配额不足时不再静默丢弃最新记录——addHistory 改为写失败时逐步淘汰最旧记录后重试，保证最新结果总能存下。e2e 新增配额压力用例。
- [x] D6：流式出错(已有部分输出)不再误存历史——四个模块的历史保存 effect 之前只判 `!running && text`，中途报错会把残缺结果当成功存入；改为加 `!error` 守卫。e2e 新增用例。
- [x] D5：文件下载健壮性——downloadText 把锚点挂载到 DOM 并延迟 revoke 对象URL，避免大文件(内嵌图表报告)下载被立即 revoke 中断。新增 e2e 真实下载用例(校验文件名+内容)，此前下载路径完全无测试。

### 子任务E：检索与引用（literature.py, citations.py, extract.py）
- [x] E1：引用 DOI 归一化（去 https://doi.org/、doi: 前缀）+ 自动去重（DOI 或 标题+年+作者），并提示去重条数
- [x] E2：文档提取编码健壮性——新增共享 textio.py(decode_text/read_csv_bytes)；修复 extract.py 中 GBK CSV 崩溃、GBK txt 被 utf-8+ignore 静默丢字(14中文字→只剩1)；dataanalysis 复用同一工具去重。新增 test_textio.py。
- [x] E3-a：PubMed 检索加 NCBI 限速节流——深度调研连发多次 esearch/efetch 会超 3次/秒被 429 静默丢结果；新增全局 _throttle 保证请求间隔>=0.34s。新增 test_ncbi_throttle.py。
- [x] E3：检索结果相关性排序与去噪——已有 _rank_papers(位置相关0.5+被引0.3+新近0.2)基础上，新增**主题词词面相关性**(_query_terms 从检索式提主题词、_lexical_rel 算标题/摘要命中比, 相关性=0.6位置+0.4词面)，把跨源合并后"真正切题"的文献顶到前面；新增 **_is_noise 去噪**(更正/勘误/撤稿声明/评论/回复等非研究条目在合并阶段剔除)。新增 test_literature_rank.py。

### 子任务F：部署易用性（scripts, .bat, 使用说明）
- [ ] F1：启动脚本对"未装依赖/端口被占/未配 key"给明确引导
- [x] F2：一键环境自检——新增 backend/doctor.py（检查 Python/依赖/.env+key/端口并给修复建议）+ 根目录「检查环境.bat」双击即用 + README 说明 + test_doctor.py。真实环境运行全 ✓。
- [ ] F3：使用说明随功能更新，常见问题 FAQ

### 子任务F：部署易用性（scripts, .bat, 使用说明）
- [x] F-a：修复 .env 中 PORT 为空/非法/越界时服务器导入期崩溃（`int("")` ValueError）。config.py 新增健壮 `_int()`（空/非法/越界回退默认），PORT 走它并限定 1~65535。新增 test_config.py。

## 遗留问题 (测试中发现，需修复)

- [x] P1：参考文献页码范围渲染异常——`1-10` 渲染成 `1–0`。修复：`_resolve_style` 把 minimal 样式强制为 expanded，输出完整区间，永不出错。已真实 LLM 端到端验证。
