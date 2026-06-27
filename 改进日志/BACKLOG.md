# 改进待办清单 (BACKLOG)

> 由 /loop 自动维护。状态：`[ ]` 待办 / `[~]` 进行中 / `[x]` 完成 / `[-]` 放弃(附原因)
> 循环每次从顶部取一个未完成项处理。方向在被选中时才深入调研，下面是初始假设。

## 任务拆解 (子任务)

### 子任务A：生成质量（找选题/实验规划/写作 prompts.py, research.py）
- [ ] A1：提示词加入"结构化输出契约"，减少跑题/缺字段，便于前端稳定解析
- [ ] A2：找选题结果增加可行性/创新性自评分与理由，帮非专业用户判断
- [ ] A3：长输出做分段流式与小标题，降低等待焦虑

### 子任务B：数据分析正确性（dataanalysis.py, samplesize.py）
- [ ] B1：自动识别变量类型并选对统计检验（t/Mann-Whitney/卡方等），给出选择理由
- [ ] B2：前置假设检查（正态性/方差齐性/样本量）并在结果中提示
- [ ] B3：缺失值/异常值处理策略透明化，出图增加可读性（标题/单位/显著性标注）
- [x] B4：CSV 编码健壮性——中文用户从 Excel 导出的 GBK/带BOM CSV 现在能正常读取（原默认 utf-8 会崩）

### 子任务C：稳定性与错误处理（llm.py 降级, main.py）
- [x] C1：LLM 超时/网络错误现包装成友好中文 LLMError，瞬时错误自动重试2次，重试耗尽再切备用供应商；已产出内容则不重试避免重复。新增 test_network_retry.py 回归。
- [ ] C2：降级链路（主→FALLBACK）边界情况覆盖与日志可观测
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
- [ ] E3：检索结果相关性排序与去噪

### 子任务F：部署易用性（scripts, .bat, 使用说明）
- [ ] F1：启动脚本对"未装依赖/端口被占/未配 key"给明确引导
- [ ] F2：一键自检命令（环境/依赖/key 连通性）
- [ ] F3：使用说明随功能更新，常见问题 FAQ

### 子任务F：部署易用性（scripts, .bat, 使用说明）
- [x] F-a：修复 .env 中 PORT 为空/非法/越界时服务器导入期崩溃（`int("")` ValueError）。config.py 新增健壮 `_int()`（空/非法/越界回退默认），PORT 走它并限定 1~65535。新增 test_config.py。

## 遗留问题 (测试中发现，需修复)

- [x] P1：参考文献页码范围渲染异常——`1-10` 渲染成 `1–0`。修复：`_resolve_style` 把 minimal 样式强制为 expanded，输出完整区间，永不出错。已真实 LLM 端到端验证。
