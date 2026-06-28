# 改进日志 (LOG)

> 每完成一个改进方向追加一条。最新在最上。

## 2026-06-28 — 稳定性（全改·C3）：/api/run 必填校验 + 修复错误流潜伏 bug
- **审查**：逐个 JSON 端点(check-refs/format-refs/statcheck/journal-match/sample-size/flow-diagram/figure-captions/imrad/rebuttal)确认**都已**有 `{ok, error}` 空输入/异常守卫(前几轮已加固)。唯一缺口是 `/api/run` 文本模块——缺必填时白白调用一次 LLM 并产出空泛输出。
- **改动**：`prompts.py` 加 `_REQUIRED` 映射(每模块关键字段+友好名)，`build_messages` 缺必填即抛友好 `ValueError`(由 /api/run 转 SSE error，省额度)。
- **抓到真实 bug**：`/api/run` 捕获 ValueError 后，`err_gen` 闭包里引用了 `e`，但 Python 在 except 块结束时清除异常变量 `e`，而该生成器是流式时才执行 → `NameError: free variable 'e'`，使"未知模块/缺字段"错误**根本无法显示**(前端拿到的是崩溃而非提示)。改为先把 `str(e)` 存进 `err_msg` 再用。
- **测试**：新增 `test_run_validation.py`(空必填/未知模块→友好 error、有效输入→done)；后端 18 套测试全过。mock 零额度。
- **commit**：见本次提交

## 2026-06-28 — 稳定性（全改·C2）：降级链路可观测性(日志)
- **动机**：主→备用供应商的重试/降级此前完全静默，线上一旦出现"AI 无响应/慢"无任何日志可查，无法判断是主供应商额度耗尽、瞬时网络、还是备用也挂了。
- **改动**：`llm.py` 新增 `_log`(打到 stdout→server.log)，在关键转换点各记一条：① 主供应商瞬时错误退避重试(含状态码/第几次)；② 流式中途出错(已产出内容→不重试)；③ 切换到备用供应商(标注原因：额度不足 vs 网络不可达)；④ 备用成功接管 / 无输出 / 也失败。备用供应商异常也显式包成 LLMError 上抛并记录。
- **测试**：test_fallback / test_network_retry 回归通过；手工构造"主配额错误→备用成功"确认日志按序输出、最终拿到备用结果。纯日志增量, 不改控制流。
- **commit**：见本次提交

## 2026-06-28 — 检索质量（全改·E3）：相关性词面排序 + 非研究条目去噪
- **动机**：原 `_rank_papers` 相关性只看"各源返回位置"，跨源合并后偶然靠前的离题命中会顶掉真正切题的文献；且 PubMed 常混入 Erratum/Correction/Comment/Retraction Note 等非研究条目，污染综述选篇。
- **改动**：`literature.py` ① 新增 `_query_terms` 从 PubMed 检索式提主题词(剔除 AND/OR/字段标签[Title/Abstract]/MeSH 记号)，`_lexical_rel` 算主题词在标题(0.7)/摘要(0.3)的命中比；排序相关性改为 `0.6×位置 + 0.4×词面`(无主题词时退回纯位置, 向后兼容)；② 新增 `_is_noise`(正则匹配 erratum/corrigendum/correction/retraction/comment on/reply/editorial 等题首)，在 `_merge_all` 合并阶段剔除这些非研究条目。
- **测试**：新增 `test_literature_rank.py`(主题词提取/去噪识别/词面分/合并后切题置顶+噪声剔除)全过；test_openalex / test_searchfilters / test_ncbi_throttle 回归通过。离线零额度。
- **commit**：见本次提交

## 2026-06-28 — 数据分析正确性（全改·B1/B2/B3）：方法选择/假设检查/数据质量透明化
- **动机**：分析过程对用户是黑盒——选了什么检验、为什么、前提满不满足、缺失/异常怎么处理都看不见，非专业用户无从判断结果可信度。
- **改动**：`_gen_code_messages` 要求生成代码**先 print 三个固定标题区块**——『【方法选择】』(逐问题说明变量是连续/有序/分类、各组样本量→选哪种检验/模型+理由)、『【假设检查】』(实跑 Shapiro-Wilk/Levene 并 print 数值, 据结果决定参数/非参数)、『【数据质量】』(每个变量缺失数+处理策略、IQR 异常值)；出图要求**标题/带单位轴标签/组间显著性标注(* p<0.05 或精确 p)**；`_conclusion_messages` 增『方法与前提』段, 复述假设检查关键结果。
- **测试**：mock 下校验三区块指令均在 prompt；**真实执行路径**——手写符合新要求的代码(scipy Shapiro/Levene + 箱线图)走 `_execute` 沙箱跑通, stdout 含三区块、产出 1 张图；test_analyze_retry / test_danger_guard 回归通过。纯 prompt + 沙箱验证, 不消耗额度。
- **commit**：见本次提交

## 2026-06-28 — 生成质量（全改·A1/A2/A3）：找选题候选题结构化 + 可行性/创新性自评分
- **动机**：找选题报告的候选选题此前是自由段落，字段时有时无、长报告读起来费力；非专业用户也难判断"哪个更值得做"。
- **改动**：research.py 三处综述 prompt(`_reduce_messages_deep` 深度Reduce / `_synthesis_messages` 浅层 / `_synthesis_messages_deep` 深度)与 `prompts.build_idea` 统一为：① 每个候选选题用 `### 候选选题N：题名` 小标题(结构化契约, 前端/阅读都更稳, 也天然分段降低等待焦虑)；② 字段分点(科学问题/创新点/可行性/新颖性/文献链接)；③ **强制单列一行自评分** `> 可行性 ★N/5(理由)｜创新性 ★N/5(理由)`，理由须基于检索证据与空白、非套话。
- **测试**：MOCK 下 `build_messages('idea')` 与 `_reduce_messages_deep` 均含评分指令(★/N/5)；test_endpoints 全过(/api/idea 无 500)；纯 prompt 增量、向后兼容。真实 LLM 遵循度依赖模型(旗舰找选题链路前多轮已真实验证), 本轮按规则用 mock 默认不消耗额度。
- **commit**：见本次提交

## 2026-06-28 — 评估与放缓（loop 第15轮）：暂无高价值改动，循环转低频
- **健康基线**：后端 17 套测试全过、doctor OK；前端 48 条 e2e 全绿。
- **客观评估（不为凑数硬改）**：剩余候选均判定低价值——窄屏/移动端(本品是桌面本地应用,非移动场景)、M1 ResultPanel testid 命名空间(纯测试整洁、对用户零收益、且牵动现有 e2e)、再做付费真实冒烟(旗舰链路已多轮真实验证, 边际信息低)。结论：**现状已足够好, 本轮不做改动**。
- **决策**：循环放缓到 1 小时/次(ScheduleWakeup 3600s), 保持可被新指令唤醒；有新需求即恢复高频, 或随时暂停 loop。
- 经 14 轮: 产品从"四大能力"扩展为 8 模块全流程工作台 + 大量实用工具 + 3 轮审查加固; 后端 17 套测试、48 e2e、doctor 全绿。

## 2026-06-28 — 修复(loop 第14轮)：数据分析持久化补全(M4)
- **问题**：AnalyzeModule 只持久化了 `analyze:conclusion`，代码/图表/原始输出/图注是普通 useState——切换模块或从历史恢复后，结论还在但**配图/代码/原始输出全丢**，呈现误导(以为分析完整实则缺图)。
- **改动**：code/charts/output/captions 改为 `usePersistentState`(analyze:code/charts/output/captions)；历史记录条目也带上这四项, 恢复时完整重现。
- **测试**：新增 e2e(跑分析→切到找选题→切回, 断言 chart-0/代码/原始输出/结论仍在)；Playwright 48/48; dist 已重建。
- **commit**：见本次提交

## 2026-06-28 — UX 一致性/稳健性（loop 第13轮）：前端审查后修一致性缺陷
- 派 agent 做前端可用性/一致性审查(确认 #7 跨模块 localStorage key 全部一致, 无 bug)。修复其报告的真实缺陷：
  - **H1 缺停止按钮**：PICO / 追问改写 / 摘要 / 关键词 4 个流式操作此前只有 spinner 无法中止——补停止按钮(abort+复位)。
  - **H2 出错静默冻结**：genPico/genKeywords 失败仅复位 running、无错误显示, 面板永远卡"提取/推荐中…"——补 picoErr/kwErr 状态与红字提示。
  - **H3 下载静默损坏**：所有 docx/zip 下载 `fetch().blob()` 无 `resp.ok` 检查、无 catch——500 时会把错误体存成 .docx。新增 `download.ts` 集中助手 `downloadBlob`(安全锚点)+`downloadDocxFromText`(查 resp.ok、失败抛错)，Plan/Imrad/Format×2/Checklist/Rebuttal 全部改用并 catch→红字; bundle 加 resp.ok 检查。
  - **M2/L1**：ImradModule.reset 现也中止并清空摘要/关键词流; IdeaModule.submit 开始新检索前中止进行中的 追问/PICO 流(防交叉写入)。
  - M1(ResultPanel 内层 testid 未命名空间) 改动面大且动现有测试, 本轮暂不改。
- **测试**：新增 e2e(PICO 出错显示错误而非卡住); Playwright 47/47; dist 已重建。
- **commit**：见本次提交

## 2026-06-28 — 实验规划增强（loop 第12轮）：数据管理计划(DMP) + 知情同意书草案
- **动机**：标书必交 DMP、伦理申请必交知情同意书；属立项工作台范畴, 增强现有"实验规划"模块(非新模块)。
- **改动**：prompts 加 `build_dmp`(NIH/Horizon/FAIR 框架: 数据类型/采集组织/存储备份/安全隐私合规/共享归档/角色责任, 缺失标[需研究者明确]) 与 `build_consent`(知情同意书草案: 目的/流程/风险获益/隐私/自愿退出/补偿/签字栏, 具体数值机构用[需研究者补充]占位, 注明需 IRB 审核, 不杜撰)，注册 module dmp/consent(走 /api/run)。PlanModule 加"数据管理计划(DMP)""知情同意书草案"两个按钮 + 独立结果面板(panelTestId dmp-panel/consent-panel)，均支持 Word 导出。
- **测试**：真实生成 DMP(1346字含数据类型分节) 与 consent(1220字含风险/伦理委员会/[需研究者补充] 安全占位)；Playwright 46/46(新增 DMP/consent 生成+导出用例)；dist 已重建。
- **commit**：见本次提交

## 2026-06-28 — 抓bug（loop 第11轮）：核心模块审查，修复 4 个真实问题
- 派 agent 审查核心模块(research/dataanalysis/literature/europepmc/openalex/citations/extract/llm)，修复 4 处：
  - **(中)引用核验子串误判**：`_verify_citations` 用 `pmid in u` 子串匹配，PMID 456 会把伪造的 `.../4567890/` 判为已核验——削弱核心抗幻觉保证。改为**末尾路径段精确匹配**。
  - **(中)重复列名崩溃**：`profile_data`/`df[col]` 遇重复列头(脏临床表常见)返回 DataFrame→`.dtype` AttributeError, 整次分析失败。新增 `_dedup_columns` 在主进程 `_load` 与子进程 runner 都重命名重复列(g→g.1)。实测含重复列文件端到端跑通。
  - **(低)沙箱护栏漏 os.popen**：`_DANGER` 正则补 `os\.popen`。
  - **(低)OpenAlex 检索式含逗号/冒号失效**：PubMed 检索式的逗号/冒号破坏 OpenAlex filter 语法致整源 4xx; `_params` 把 search 值里的逗号/冒号替换为空格。
  - 审查确认 asyncio.gather 兜底、子进程超时、citeproc 非法 CSL、extract 损坏文件、llm 中断/usage 解析均已正确处理(无须改)。
- **测试**：新增 `test_review_fixes.py`(4 项)全过; test_endpoints/danger/analyze_retry 回归通过; 含重复列文件 _execute 实测跑通。纯后端, 无前端变更。
- **commit**：见本次提交

## 2026-06-28 — 抓bug（loop 第10轮）：派 agent 代码审查发现并修复 2 个真实 bug
- **主题**：质量/抓 bug。派 agent 对近期新增的 10+ 模块做正确性审查，确认 2 个真实 bug：
  - **HIGH 修复**：`randomize.py` 区组随机当 `block_size="0"`(或负的单位倍数)时——"0" 为真值绕过 `or` 默认、`0%unit==0` 绕过取整 → base 为空、per=0 → `while len(seq)<n` **死循环/服务挂起(DoS)**。修复：取整后加 `bs = max(bs, unit)` 钳制。加回归 test(block_size 0/负不死循环)。
  - **LOW-MED 修复**：`refcheck.py` DOI 补全的标题匹配 `A and B or C` 运算符优先级——标题守卫只护住 B，CrossRef 命中无标题时 C(`""[:40] in title` 恒真) → 给文献错配 DOI。修复：改为 `nh and (nt[:40] in nh or nh[:40] in nt)`。
  - 审查同时确认 statcheck 除零/自由度、flowdiagram 空值、imrad/rebuttal SSE 兜底、前端可选字段/JSON.parse 等均已正确处理。
- **测试**：test_randomize(新增 0/负区组)、test_endpoints 全过。纯后端改动, 无前端/ dist 变更。
- **commit**：见本次提交

## 2026-06-28 — 稳健性加固（loop 第9轮）：依赖审计 + 全端点冒烟测试
- **主题**：质量/稳健性，不加功能。
- **① 依赖审计**：grep app/ 全部第三方 import 比对 requirements.txt——全部覆盖(citeproc/docx/dotenv/fastapi/scipy/statsmodels/matplotlib/pandas 等；cycler 随 matplotlib 自带；其余为标准库)，新机器可正常安装，无缺漏，无需修改。doctor 自检 exit 0、13 项依赖齐全。
- **② 全端点冒烟测试**：新增 `test_endpoints.py`(TestClient + mock 模式, 零额度)：逐个打 18 个 HTTP 端点(health/journals/usage + run/idea/imrad/rebuttal/idea-followup SSE + check-refs/journal-match/statcheck/figure-captions + sample-size/randomize/flow-diagram + docx/bundle)，断言无 500、关键结构正确(随机化 6 行、PRISMA png、bundle 为 PK)。锁死 8 模块+工具端点接线，防后续静默回归。
- **测试**：test_endpoints 全过；既有 14 套后端测试 + doctor 均健康。纯后端改动, 无前端/ dist 变更。
- **commit**：见本次提交

## 2026-06-28 — 质量打磨/一致性（loop 第8轮）：历史记录覆盖新模块 + 文档更新
- **主题**：功能已全，转向一致性/文档/稳健性自查。
- **自查结论**：后端 14 套测试全过、app.main 导入正常(健康)。发现并修复两处一致性问题：
  - **历史记录模块名缺失**：HistoryView 的 NAMES 只含旧 4 模块，新模块(imrad/journal/checklist/rebuttal)在历史里显示英文 id。补全 8 模块中文名；并给"论文初稿"模块补上 addHistory(此前唯一未写历史的模块)，history.ts 注释同步。
  - **使用说明过期**：仍写"四大功能"。改为完整流程介绍 + 8 模块功能表 + 更新拖拽/串联/历史说明。
- **测试**：新增 e2e"历史记录新模块显示中文名并可恢复"(rebuttal→回复审稿、可恢复 input-reviews)；Playwright 45/45；dist 已重建。
- **commit**：见本次提交

## 2026-06-28 — 实用增强（loop 第7轮）：图注生成 + PICO/纳排提取
- **① 数据分析图注生成**：新增 `figcaptions.py` + `/api/figure-captions`(JSON)：基于研究目的/代码/真实输出/结论为每张图生成规范中文图注(『图N. ……』, 不编造数字, 数量对齐)。AnalyzeModule 图表区加"生成规范图注"按钮, 图注显示在每张图下。
- **② PICO/纳排提取（找选题）**：prompts 加 `build_pico`(PICOTS 表格 + 建议纳入/排除标准, 信息不足标 [需明确])，module=pico。IdeaModule 加"提取 PICO/纳排标准"按钮 + 折叠面板(复用现有 field/keywords/background 输入)。
- **测试**：真实图注(2 图各 1 句、描述箱线/散点)、真实 PICO(含 PICO+纳入+排除)；Playwright 44/44(新增 图注生成、PICO 提取 用例)；dist 已重建。极低额度。
- **commit**：见本次提交

## 2026-06-28 — 实用增强（loop 第6轮）：随机化分组表 + 关键词/MeSH 推荐
- **主题**：增强现有模块、小而高频。
- **① 随机化分组表（实验规划）**：新增 `randomize.py` + `/api/randomize`(确定性零额度)：简单随机/置换区组随机，固定种子可复现，支持多臂与分配比例，区组大小自动取整为比例和的整数倍。PlanModule 加折叠式生成器(n/分组/比例/方法/区组/种子 → 计数+前 20 行预览+导出 CSV)。test_randomize 离线(可复现/区组均衡/取整/校验)全过。
- **② 关键词/MeSH 推荐（论文初稿）**：prompts 加 `build_keywords`(中英关键词 + 规范 MeSH 主题词, 不确定标注需核对)，module=keywords。ImradModule 摘要区加"推荐关键词/MeSH"按钮 + 结果面板。
- **测试**：真实关键词生成(含关键词+MeSH 两段)；后端随机化逻辑(区组 6:6 均衡、种子可复现)；Playwright 42/42(新增 随机化生成+导出、关键词推荐 用例)；dist 已重建。零/极低额度。
- **commit**：见本次提交

## 2026-06-28 — 打磨/打通（loop 第5轮）：首页工作流总览 + 一键投稿包 ZIP
- **主题**：导航已 8 模块，本轮不加新模块，转向"可发现性 + 跨模块贯通"。
- **A 首页工作流总览**：原首页仅一个 CTA→找选题，其余 7 模块无从发现。在 hero 下方新增"完整工作流"卡片区(读 NAV，8 张带序号/图标/简介的卡片，点击直达对应模块)，保留原 hero 设计与美学。
- **B 一键投稿包 ZIP**：跨模块贯通收尾。后端 `/api/bundle`(zipfile)：文本项原样写入、docx 项用 build_docx 转 Word，文件名做防穿越清理。前端 ImradModule 加"打包投稿包 ZIP"——从 localStorage 汇总各模块产出(选题/方案/SAP/分析结论/初稿→docx/摘要/投稿信/排版稿/参考文献/规范核对/审稿回复)打成 research-package.zip。
- **测试**：后端 TestClient 验证 zip(空文件跳过、docx 为 PK 有效)；Playwright 40/40(新增 首页卡片导航 + 投稿包打包(校验收集到 draft.docx 与 选题.md) 用例)；dist 已重建。
- **commit**：见本次提交（本轮可继续：质量/grounding 复核、PICO/MeSH 等小增强）

## 2026-06-28 — 新模块 / 论文初稿 IMRaD 装配 + 结构式摘要（loop 第4轮·方向①，本轮收官）
- **动机**：约半数研究者把"准备投稿稿件"列为最难环节；通用 AI 写作的致命伤是幻觉，而本产品独有解药——初稿每块都来自用户已产出的真实材料。这是把前面 8 个模块成果"变现"为论文的临门一脚。
- **改动**：
  - 后端 `imrad.py` + `/api/imrad`(SSE)：把 引言/方法/结果/讨论 四块材料**分段**(每段独立 prompt, 过去时, 铁律只据材料、禁编造数字/文献、缺失标 [待补充])流式拼成 IMRaD 初稿。prompts.py 加 `build_abstract`(结构式/非结构式摘要 + 目标字数硬约束, 结果数字必来自要点), 注册 module=abstract。
  - 前端新模块 ImradModule：四块材料输入 + **"从各模块导入"**(读 localStorage：找选题综述→引言、实验规划/SAP→方法、数据分析结论→结果) + IMRaD 流式装配 + Word 导出；内置"结构式摘要+字数核对"区(中英文混排字数统计 + 超限提示)。usePersistentState 加 readPersisted 跨模块读取。App 加第 8 个 nav(分析→论文初稿→选刊)；README 更新。
- **测试**：真实装配(二甲双胍×NAFLD)：4 段、引言/方法/结果/讨论齐全、**真实数字 2.1kPa/p=0.003 原样保留**(grounding 生效)；摘要结构式 204 字；Playwright 38/38(新增 IMRaD 装配+导入+摘要字数用例)；dist 已重建。
- **commit**：见本次提交
- **第4轮收官**：④PRISMA/CONSORT流程图 + ①IMRaD初稿装配/摘要 全部完成；产品达 **8 模块**。下一轮重新调研。

## 2026-06-28 — PRISMA/CONSORT 流程图生成（loop 第4轮·方向④，确定性绘制）
- **动机**：每篇 SR/Meta 必交 PRISMA 流程图、每个 RCT 必交 CONSORT 流程图，手画繁琐、期刊审查严；CONSORT 2025-04 刚改版。确定性绘图、零幻觉、与报告规范核对同源。
- **改动**：新增 `flowdiagram.py` + `/api/flow-diagram`(JSON)：用 matplotlib 在本地**确定性绘制**(布局写死、数字来自用户表单，LLM 不参与) PRISMA 2020 / CONSORT 2025 两套模板(FancyBboxPatch 盒+箭头+阶段侧标)，一次导出 PNG(300dpi)/SVG/PDF base64，全离线。前端 ChecklistModule 增"流程图生成"区：类型选择 + 按类型动态数字表单 + 图片预览 + 逐格式下载。
- **测试**：后端真实渲染 PRISMA(png 262KB/svg/pdf 魔数正确) 与 CONSORT(png 248KB) 均 ok；Playwright 37/37(新增流程图用例：PRISMA 生成+CONSORT 字段切换+SVG 下载)；dist 已重建。零额度。
- **commit**：见本次提交（本轮还将做 ①IMRaD 初稿装配、结构式摘要+字数核对）

## 2026-06-28 — statcheck 统计一致性自查（loop 第3轮·方向③，本轮收官）
- **动机**：论文里 t/F/χ²/r/z + 自由度 + p 三者算不上对极常见，越来越多期刊投稿环节直接跑 statcheck，作者却无自查工具；纯算法、范围可控、复用统计栈。
- **改动**：新增 `statcheck.py` + `/api/statcheck`(JSON)：LLM 仅抽取统计量(type/df/value/p_text)，**p 值用 scipy 确定性重算**(t/F/chi2/z/r 双侧)，比对报告值——一致 / 不一致(数值不符但显著性同) / 严重(显著性在 .05 翻转) / 无法核验。前端 ChecklistModule 增"统计一致性自查"区(结果文字输入 + 徽章清单 + 报告值vs重算值)。
- **测试**：离线 test_statcheck(重算 t(38)=2.10→0.0424、chi2(1)=3.84→0.05、z=1.96→0.05、r=0.5,df18→0.0248；分类 一致/不一致/严重 正确)；Playwright 36/36(新增 statcheck 用例)；dist 已重建。额度零消耗。
- **commit**：见本次提交
- **第3轮收官**：①参考文献核验 + ②智能选刊匹配 + ③statcheck 三方向全部完成；下一轮重新调研。

## 2026-06-28 — 新模块 / 智能选刊匹配（loop 第3轮·方向②，OpenAlex 相似刊聚合）
- **动机**：「投哪本期刊」是每篇必经决策，选错→拒稿/拖周期；同类(JANE/Elsevier Finder)无公开 API，用 OpenAlex 自建是稳妥路径，且与已有投稿包闭环。
- **改动**：新增 `journalmatch.py` + `/api/journal-match`(JSON)：用摘要在 OpenAlex `search` 检索近 6 年、primary_location.source.type=journal 的相近文献(per_page 50)，按发表期刊聚合频次排序，取期刊 OA/DOAJ/ISSN 元数据(规避影响因子版权)，再用一次 LLM 给每本候选≤40字匹配理由。前端新模块 JournalMatchModule(摘要输入/上传 → 候选期刊卡片：排名/频次条/OA·DOAJ 徽章/匹配理由/相近文献样例)；App 加第 7 个 nav(位次：分析→选刊→排版)/路由/rail-tick。
- **测试**：真实 TNBC 摘要 → Annals of Oncology/Cancers 等相关肿瘤刊+OA 标记+理由、额度零消耗(¥1.42)；Playwright 新增选刊用例通过；dist 已重建。
- **commit**：见本次提交（本轮还剩 ③statcheck）

## 2026-06-28 — 参考文献核验中心（loop 第3轮·方向①：真实性/撤稿/去重/补全）
- **动机**：派 agent 调研第3轮方向，锚点=参考文献核验(复用基建最高、痛点最硬)。LLM 时代最大投稿事故是 AI 杜撰出不存在的 DOI/文献、误引撤稿文献。
- **改动**：新增 `refcheck.py` + `/api/check-refs`(JSON)：LLM 仅做一次半结构化解析(抽 doi/pmid/title)，核验全走确定性网络——① 真实性：CrossRef /works/{doi}，404=疑似杜撰；② 撤稿：PubMed esummary 出版类型含 "Retracted Publication"(医学域覆盖好)；③ 去重：DOI/PMID/归一化标题任一相同即判重(指向首次)；④ 补全：缺 DOI 用 CrossRef 题名反查回填。复用 literature 的 NCBI 全局节流。前端 FormatModule"参考文献"区加"核验真实性/撤稿/去重"按钮 + 结果清单(✓真实/✗查无/⚠已撤稿/⧉重复 徽章 + 说明)。
- **测试**：真实核验(KEYNOTE-355 Lancet=真实✓、假 DOI=查无✗、同文无DOI=判重)；test_refcheck 离线(归一化+跨键去重)全过；Playwright 34/34(新增核验徽章用例)；dist 已重建。额度零消耗(¥1.42)。
- **commit**：见本次提交（本轮还将做 ②智能选刊匹配 ③statcheck 统计自查）

## 2026-06-27 — 投稿包 / 预提交体检 + 投稿信（loop 第2轮·方向②，本轮收官）
- **动机**：研究者每稿中位 ~14h 花在格式合规上；投稿前最易漏的是必备声明(伦理/COI/数据可得性/资助/作者贡献/注册号)与必需章节、字数超限；投稿信也是高频刚需。落点选在期刊排版模块(已有稿件+目标期刊上下文)。
- **改动**：prompts.py 加 `build_precheck`(对照所选期刊规则逐项体检→Markdown 表格 ✅通过/⚠️注意/❌缺失，覆盖必需章节/结构顺序/字数/必备声明/参考文献/图表，前置必须修复项)与 `build_coverletter`(基于稿件生成 250-350 字投稿信：标题与类型/创新点/契合度/原创未一稿多投等声明，缺失信息用[占位]，不编造)，注册 module precheck/coverletter 走 /api/run。前端 FormatModule 加"投稿包"区：预提交体检 + 生成投稿信两个按钮 + 各自独立 ResultPanel(panelTestId 区分)，投稿信支持 Word 导出。
- **测试**：真实生成 precheck(1720 字表格+状态) 与 cover letter(447 字含编辑称呼)、额度零消耗(¥1.42)；Playwright 33/33(新增投稿包用例)；dist 已重建。
- **commit**：见本次提交
- **本轮(第2轮)收官**：③SAP + ①报告规范核对 + ②投稿包 三方向全部完成；下一轮将重新调研新方向。

## 2026-06-27 — 新模块 / 报告规范核对 STROBE·CONSORT·PRISMA（loop 第2轮·方向①）
- **动机**：顶刊投稿强制提交报告规范清单(EQUATOR)，偏倚/样本量/缺失数据/敏感性分析等条目最常被审稿人挑、最易被退稿；适合 LLM 做"条目↔正文位置"结构化核对。
- **改动**：prompts.py 加 `build_checklist`(按所选规范逐条核对 → Markdown 表格 列=条目/要求/状态(✅已报告/⚠️不充分/❌缺失)/正文位置/修改建议，前置高优先级待补项、后附合规度小结；只据稿件不臆造)，注册 module="checklist"。前端新增 ChecklistModule(规范选择 STROBE/CONSORT/PRISMA/SPIRIT/ARRIVE + 稿件输入/上传 + 结果面板 + Word 导出，复用 useStream/ResultPanel)；App 加第 6 个 nav/路由/rail-tick(位次：排版→规范核对→回复审稿)；README 更新为 6 模块。
- **测试**：真实核对 CONSORT(2384 字、表格+状态图标)、额度零消耗(¥1.42)；Playwright 32/32(新增规范核对用例：表格渲染+❌缺失+Word 导出)；dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 实验规划升级 / 统计分析计划 SAP + Word 导出（loop 第2轮·方向③）
- **动机**：实验规划是最单薄模块(仅一段文本)。本轮规则=多方向逐个做；先做最可控、医学/药学刚需的 SAP。
- **改动**：prompts.py 加 `build_sap`(按 ICH E9/E9(R1) + Gamble 2017：研究设计与终点/estimand/ITT-mITT-PP 分析集/主要终点分析/次要探索性/预设协变量与亚组/多重性控制/缺失数据(机制+多重插补敏感性)/敏感性分析/期中分析/样本量依据/软件版本；信息不足标“需研究者确认”不臆造)，注册 module="sap" 走现有 /api/run。前端 PlanModule 加“生成统计分析计划(SAP)”按钮+独立 SAP 结果面板；ResultPanel 加可选 onExportDocx/panelTestId——实验计划与 SAP 均可一键导出 Word(复用 /api/docx)。
- **测试**：真实 SAP 生成 2255 字、含 ITT/PP/缺失/多重/敏感性等要素、额度零消耗(¥1.43)；Playwright 31/31(新增 SAP 生成+Word 导出用例)；dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 新模块 / 回复审稿意见 Rebuttal 助手（loop 第1轮）
- **来源**：自主 loop——派 agent 联网调研"下一步最强需求"，结论 ROI 最高的是"回复审稿(Rebuttal)"：返修频率高、对录用是决定性因素、且同时涉及未发表稿件+保密审稿意见（最契合本工具"本地运行、数据不出网"定位），还能复用现有 SSE/改写/Word 导出。它是研究流程自然的第 5 环（找选题→实验规划→数据分析→期刊排版→回复审稿）。
- **改动**：
  - 后端 `rebuttal.py` + `/api/rebuttal`(SSE)：先把审稿意见拆解为结构化条目(按审稿人/编号+类型标签，emit comments)，再基于稿件(节选)与意见流式生成 point-by-point 回复信(每条：意见摘要→回应→正文修改建议)；铁律=只据稿件、不编造数据，需补做的实验/分析用"我们将补充…"。语气可选 谦逊建设性/礼貌坚定。
  - 前端新增 RebuttalModule（审稿意见+稿件 textarea/上传、语气选择、意见清单、流式回复信、导出 Markdown/Word）；sse.ts 加 streamRebuttal；App 加第 5 个 nav/路由/rail-tick；README 模块表更新为 5 项。
- **测试**：① 真实端到端：3 条意见(R1×2/R2×1)正确拆解+类型标签、point-by-point 回复 1138 字、额度零消耗(¥1.43)；② Playwright 30/30(新增回复审稿用例：意见拆解+逐条回复+导出按钮)，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 数据分析画图增强 / 多格式导出 + 期刊配色 + 紧凑上传 + 画图提示
- **动机**：用户问"能否让用户画图/以某种格式作图"。现状：能在研究目的里自然语言要求画图(AI 用 matplotlib)，但①不可发现②只产 ~120dpi PNG、无矢量/高清、不能逐图下载。用户选择：导出格式+逐图下载、期刊配色、输入框提示可画图、把大文件框改紧凑可拖拽。
- **改动**：
  - **多格式导出+逐图下载**：runner 每张图始终产展示用 PNG(120dpi)，另产用户所选格式的可下载资产——高清 PNG(300dpi)/SVG 矢量/PDF 矢量；charts 事件改为 `{png,data,ext}` 对象。前端每张图加"下载 XX"按钮(downloadBase64)，AnalyzeModule 加图表格式选择器。sse.ts normalizeCharts 兼容新旧两种 charts 形态。
  - **期刊配色**：runner 按 palette 设 axes.prop_cycle——色盲友好(Okabe-Ito)/Nature(NPG)/Lancet；前端配色选择器。/api/analyze 增 chart_format、palette 两个 Form 字段，全程透传。
  - **画图提示**：研究目的 placeholder 提示"可直接要求画图(箱线图/KM曲线/相关热图/ROC…)"；codegen 提示词要求"用户明确要求某图则务必画出、配色已统一无需手动指定"。
  - **紧凑上传**：去掉数据分析页的大 Dropzone，改为"文件 chip + 提问"合一的紧凑输入区，可把文件拖到整块输入区或点击选择(保留 input-file/-info/-error testid 与 30MB 限制)。
- **测试**：① 直接跑 _execute 验证 png/svg/pdf 三格式导出(SVG=`<?xml`、PDF=`%PDF` 魔数正确)、调色板不崩；② 真实 analyze 端到端(要求画箱线图+svg+lancet)：1 图 ext=svg、结论 1764 字、额度零消耗(¥1.43)；③ 后端测试修复 fake 签名后全过；④ Playwright 29/29(分析用例加格式/配色选择、文件 chip、逐图 SVG 下载断言)，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 找选题增强 IV / 按子方向 Map-Reduce + 报告追问/修改
- **动机**：用户要求 ①map-reduce 按子方向分组（更贴合空白矩阵结构）②允许对某篇文献/某条结论追问，或提意见让 LLM 修改报告。
- **改动**：
  - **按子方向分组**：deep 流改为 `_facet_grouped_search`——并发逐子方向检索、跨子方向去重(先到先得)、保留子方向归属；空白补检索作为「空白补充角度」独立组。Map 步 `_map_summaries_by_facet` 每个子方向各自归纳现状小结（`_summarize_chunk` 带 facet_name），Reduce 按子方向组织（`_reduce_messages_deep` 输入改为 [(子方向名, 小结)]）。证据抽取用全局 index 对齐。
  - **追问/修改**：新增 `/api/idea-followup`(SSE) + `research.idea_followup`：ask=基于回传的真实文献+原报告回答追问；revise=按意见产出修改后完整报告。均严格 grounding、复用抽出的 `_verify_citations` 做引用核验。前端 IdeaModule 加「追问/修改意见」区：追问追加问答串(持久化 idea:qa)、修改流式重写报告(失败回滚)；sse.ts 加 streamIdeaFollowup。
  - 重构：把引用核验逻辑抽成 `_verify_citations(full, items)`，deep/fast/followup 三处共用。
- **测试**：① 真实 deep(肠道菌群×结直肠癌)：按子方向归纳→汇总，引用核验 6/6 全真、空白矩阵表格在；② 真实 followup：ask 基于文献作答、revise 重写报告引用核验 7/7 全真，额度几乎零消耗(¥1.47)；③ 5 套后端测试无回归；④ Playwright 29/29(新增追问追加问答+修改替换报告用例)，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 找选题增强 III / 8 项优化(Map-Reduce/被引/过滤/证据表导出/中文/试验入空白/token/缓存)
- **动机**：用户在"进一步优化方向"菜单里选"除 OCR/需 key 源/Tauri/E2B 外其余全做"。E2B 因需 key+数据上云、违背本地隐私定位，跳过。
- **改动**：
  - **A1 Map-Reduce**：deep 综述改为先按批(每 18 篇)并发归纳现状小结(`_map_summaries`/`_summarize_chunk`)，再汇总成结构化报告(`_reduce_messages_deep`)，保证每篇都被读到、抗"中段忽略"；分批失败兜底退回整表。
  - **A2 被引展示+排序**：references 事件带 `cited_by_count`；前端文献列表显示"被引 N"徽标 + 相关性/被引/最新 排序切换。
  - **A3 检索过滤器**：新增 `searchfilters.py`，把 年份/证据等级(RCT/Meta/系统综述/综述) 翻译到 PubMed([pdat]/[pt])、Europe PMC(FIRST_PDATE/PUB_TYPE)、OpenAlex(from_publication_date/type:review)；前端起始年份下拉 + 证据等级 chip。
  - **A4 导出证据表**：deep 抽取后发 `evidence` 事件(对象/设计/发现/局限+元数据)；前端证据表面板 + 导出 CSV(`downloadCsv`，带 BOM)。
  - **B6 中文适配**：query/facet 生成提示词显式要求中文概念先转规范英文/MeSH。
  - **B7 试验入空白判断**：在研试验摘要(`_trials_note`)喂给 reduce，用于判断哪些方向已有团队布局/仍空白(不作文献引用)。
  - **C8 token 用量**：llm.py 累计每次调用 usage(OpenAI `stream_options.include_usage` + Anthropic message_delta)；/api/usage 增 tokens；侧栏显示"本次已用 N tokens·M 次调用"，任务完成时刷新。
  - **C9 检索缓存**：新增 `searchcache.py`(15min TTL)，缓存 search_literature/search_trials 成功结果(不缓存全失败)。
- **测试**：① `test_searchfilters.py`(过滤翻译+缓存)全 PASS；既有 10 套后端测试无回归；② 真实联网验证：过滤(2022/RCT 命中均≥2022)、缓存(二次 0.000s 命中)、token 用量(13→14 累加)；③ **真实 deep 端到端**(二甲双胍×NAFLD，2019+RCT)：16 篇→证据 16/16→map-reduce→引用核验 7/7 全真，¥1.48 几乎零消耗；④ Playwright **28/28**(新增被引排序/证据表导出/过滤UI/token 显示用例)，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 找选题增强 II / ClinicalTrials 旁路 + 源选择器 + 空白矩阵表格渲染
- **现状/动机**：用户要求加 ClinicalTrials 旁路、让用户自选检索源；并反馈"空白矩阵几乎不可读"。
- **改动**：
  - 新增 `backend/app/clinicaltrials.py`：ClinicalTrials.gov v2 客户端（`query.term` 检索，解析 protocolSection→nct/状态/期相/适应症/简介），**作为"在研试验"旁路独立 normalize/事件，不混进论文去重池**。
  - `literature.py`：`search_literature` 加 `sources` 参数，按所选论文源子集动态 gather（保持 PubMed→EPMC→OpenAlex 合并优先级）；空选兜底全开。
  - `research.py`：`_parse_sources`（列表/逗号串/非法→全开）、`_src_label`、`_emit_trials`；deep/fast 两条流均按 sources 检索 + 启用时发 `trials` 事件；mock 流加 trials 样例。
  - 前端：IdeaModule 加**检索来源多选器**（3 论文源 chip + ClinicalTrials 旁路 chip，持久化 `idea:sources`），无论文源时禁用按钮+提示；新增**在研试验面板**（状态/期相徽标、NCT 链接）；sse.ts 加 Trial 类型与 `trials` 事件。
  - **空白矩阵不可读根因**：Markdown 组件未启用 `remark-gfm`，GFM 表格被当原始 `|` 文本。修复：安装并启用 remark-gfm，表格外包 `.md-table-wrap` 可横向滚动。
- **测试**：① `test_clinicaltrials.py`（CT 归一化/`_parse_sources`/`_src_label`/sources 过滤，离线）全 PASS；② 真实 CT.gov v2 检索 TNBC 返回 5 项（状态/期相/适应症解析正确）；③ 新增 2 条 e2e（trials 旁路面板 + 空白矩阵渲染成真 `<table>`、源选择器禁用守卫）；Playwright **26/26 全绿**，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 找选题增强 / 多源(OpenAlex)+排序选篇+结构化证据表(调研驱动)
- **现状/动机**：两份联网调研结论——①在 PubMed+Europe PMC 之上，**OpenAlex** 是最该加的源（免费无 key、覆盖最广、独有被引数），可支撑“排序选篇”；②“摘要全量拼接一次性塞 64K”是当前最弱环节（Lost-in-the-Middle/NoLiMa），同类系统普遍用结构化抽取/分批降本；纳入量 18-34 篇对“范围综述式选题”偏保守，建议快速档 25-30、深度档 60-80。
- **改动**：
  - 新增 `backend/app/openalex.py`：OpenAlex 客户端，倒排索引摘要重建、带 `cited_by_count`，与 europepmc.py 同构。
  - `literature.py`：`search_literature` 升级为 **PubMed+Europe PMC+OpenAlex 三源 gather**；新 `_merge_all`（三键去重、被引取 max、缺摘要/缺 pmid 互补、PubMed 版本优先链接）+ `_rank_papers`（相关性 0.5 + 被引 0.3 + 新近 0.2 加权选篇）。
  - `research.py`：deep 档纳入量 34→**70**（首轮 per_query 10/cap 50，空白补检索 6/24，合并 70）、fast 档 18→**28**；综述前新增**结构化证据表**抽取 `_extract_evidence`（批量并发 map，把 1200 字摘要压成 对象/设计/发现/局限 要点行，token 降 5-8 倍、抗中段忽略、更难编造），deep 综述改吃证据表。
  - 前端：IdeaModule 加 OpenAlex 徽标 + 多源文案；styles 加 `.ref-badge-openalex`；sse.ts 类型注释；mock 流加 OpenAlex 样例。
- **测试**：① `test_openalex.py`（倒排重建/归一化/合并取max/排序，离线）全 PASS；② 6 个既有后端测试套件无回归；③ 真实联网 3 源检索 TNBC 主题：OpenAlex 贡献摘要+被引、合并 20 篇按相关性+被引排序合理；④ 真实 DeepSeek 证据表抽取 3 篇 pop/design/finding/gap 全填、JSON 解析正常，额度几乎零消耗（¥1.48）；⑤ Playwright 24/24 全绿，dist 已重建。
- **commit**：见本次提交

## 2026-06-27 — 循环收尾判定：暂停
- **结论**：经多轮“拆解→调研→改进→真实用户测试→记录→commit/push”，已完成 16 项实质改进（15 个真实缺陷修复 + 1 个易用性功能），覆盖编码健壮性、引用、网络韧性、安全护栏、配置、持久化、下载、检索限速、上传限制、跨模块历史、分析可靠性、环境自检。
- **真实用户测试**：三大旗舰链路均用真实服务端到端验证——数据分析（发现并修复间歇失败）、找选题 fast+deep（PubMed+LLM，引用核验全真、节流无 429）。
- **测试资产**：9 个后端测试套件 + 23 个 Playwright e2e，全部通过；前端 dist 已随改动重建。
- **为何暂停**：复盘剩余 BACKLOG 项（A 提示词语气/结构、B 统计方法措辞、D1/D3 UX/无障碍、E3 排序、F1/F3 文档）——要么是**主观、无法用“像真实用户那样”的确定性测试验证**的提示词/体验调整，要么已被现有实现覆盖。按本循环“证据先于断言、不做臆测性改动”的硬性规则，继续改动风险大于收益，故暂停而非强行制造低价值变更。
- **再次启动**：若有新需求或发现新缺陷，会作为“遗留问题”优先处理；可随时重新 /loop 继续。

<!-- 模板：
## YYYY-MM-DD HH:MM — <子任务> / <方向标题>
- **现状/动机**：为什么要改
- **改动**：具体做了什么（文件、关键逻辑）
- **测试**：像真实用户那样验证的步骤与结果
- **commit**：<short-hash>
-->

## 2026-06-27 — 子任务F 部署易用性 / F2 一键环境自检 doctor（+ 找选题真实端到端验证）
- **真实端到端验证（本轮测试上下文）**：用真实 PubMed + 真实 LLM 跑“找选题”旗舰链路，两种深度均**干净通过**：
  - fast：3 检索式 → 15 篇 PubMed 文献 → 7488 字综述 → 引用核验 13/13 全部为真（0 编造）；
  - deep（默认）：5 子方向 + 空白补检索 → 16 篇 → 8207 字 → 引用核验 15/15 全真；55s，NCBI 节流下无 429。
  说明检索/综述/引用核验链路在真实环境健康，E3-a 节流生效。
- **改动（本轮交付）**：非 IT 用户在“起不来/AI 不工作”时缺乏自查手段。新增 `backend/doctor.py`：逐项检查 Python 版本、是否用 .venv、13 个核心依赖可导入、`backend/.env` 存在与 key/MOCK 配置、备用供应商、端口可用性，打印 ✓/✗ 与修复建议，关键项失败退出码 1；根目录新增双击即用的「检查环境.bat」；README 增加排查提示。
- **测试**：① 真实环境运行 doctor 全 ✓、退出码 0；② 以 .bat 的方式（仓库根 `backend\\doctor.py`，无 PYTHONPATH）运行，app 导入正常；③ 新增 `test_doctor.py`：健康环境 main()==0、缺依赖被识别为失败、Report 计数语义，全 PASS。
- **commit**：见下次提交

## 2026-06-27 — 子任务B 数据分析 / B5 自动纠错重试 2→3(真实端到端测试发现)
- **现状/动机**：按 LOOP 指令“像真实用户那样测试”，用**真实 deepseek LLM** 端到端跑数据分析（小血压数据集，含 GBK 编码）。发现旗舰分析**间歇性失败**：AI 生成的统计代码（尤其 pingouin 的 `power_ttest`/`CI95` 等版本相关用法）首次常报错，自动纠错只重试 2 次（共 3 次执行），边缘情况下 3 次用尽仍失败 → 用户看到“分析代码执行失败”。多次实测：有的恰好第 3 次才成功、有的 3 次全失败。
- **改动**：`backend/app/dataanalysis.py` 自动纠错 `range(2)`→`range(3)`（共 4 次执行），并更新注释说明原因。
- **测试**（.venv 离线，mock LLM+执行，确定性）：① 新增 `test_analyze_retry.py`：mock `_execute` 失败 3 次后第 4 次成功→整体 done 且恰好执行 4 次；4 次全失败→报错且不超过 4 次。均 PASS；② 全部 8 个后端测试 + `import app.main` 通过；③ 另用真实 LLM 端到端验证分析能跑通（生成代码→本地执行→真实输出→结论），并确认 GBK 编码修复在真实链路生效。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D6 流式出错不再误存历史
- **现状/动机**：四个模块（idea/plan/analyze/format）的“完成后存历史” effect 守卫都是 `!running && text && savedRef!==text`，**没判 error**。当流式过程中先产出了部分内容再报错时，`running` 翻 false、`text/conclusion` 是残缺内容 → 被当成功结果存进历史，用户在历史里看到断章且不知其失败。
- **改动**：四个模块的 effect 守卫统一加 `!error`，并把 `error` 加入依赖数组：`AnalyzeModule`、`PlanModule`、`IdeaModule`、`FormatModule`。
- **测试**（Playwright）：① `tsc --noEmit` 通过；② 新增 e2e：mock `/api/run` 先发 delta 残缺内容再发 error，跑实验规划后断言显示错误、且历史里**不出现**该标题（修复前会出现）；③ **全量 23 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-c 后端上传大小上限(防直连绕过)
- **现状/动机**：前端已挡 30MB（C3-b），但 LAN/直连 API 会绕过前端。`/api/analyze`、`/api/extract` 用 `await file.read()` 一次性读全部，超大文件可拖垮内存/磁盘。需后端再设一道。
- **改动**：`backend/app/main.py` 新增 `MAX_UPLOAD_BYTES=30MB` 与 `_read_capped()`（按 1MB 分块读，累计超限立即停并返回 None，不把超大文件整体读入）。两个上传端点改用之：超限时 analyze 返回 SSE error 事件、extract 返回 `{ok:False,error}`，都给“文件过大”友好提示。limit 改为调用时读模块全局，便于测试覆盖。
- **测试**（.venv 离线）：① 新增 `test_upload_limit.py`：`_read_capped` 单元（小文件完整/超限 None/恰好等于/空文件）+ **TestClient 端到端** `/api/extract`（临时把上限调 1KB，超限返 ok=False+“过大”、正常小文件 ok=True）；② 全部 7 个后端测试 + `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-b 上传文件大小校验
- **现状/动机**：`Dropzone` 对选中的文件不做任何大小校验。用户拖入超大文件（如几百 MB 的 CSV/PDF）会被整个读入内存（前端抽取或后端 `file.read()`），导致页面卡死/上传巨慢/后端 OOM，且全程无提示。四个模块都用 Dropzone，缺口一致。
- **改动**：`frontend/src/components/Dropzone.tsx` 加 `MAX_UPLOAD_BYTES=30MB`；`handle()` 先查大小，超限即 `setErr("文件过大（X MB），请上传小于 30MB 的文件。")` 并 return，不进入 onFile/onText（不交给上层与后端）。
- **测试**（Playwright）：① `tsc --noEmit` 通过；② 新增 e2e：向数据分析的 input-file `setInputFiles` 一个 31MB 文件，断言显示 `input-file-error` 含“文件过大”、且无 `input-file-info`（未进入“已选择”）——无此守卫该用例会失败；③ **全量 22 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **遗留**：后端 `/api/analyze`、`/api/extract` 也应加大小上限防直连绕过（记入 BACKLOG C3-c）。
- **commit**：见下次提交

## 2026-06-27 — 子任务E 检索与引用 / E3-a PubMed 检索 NCBI 限速节流
- **现状/动机**：`literature.py` 的 docstring 自己写了“限速 3 次/秒”，但代码没有任何节流。深度调研流程会连发 4-5 个 facet 的 esearch + gap 查询 + efetch，紧挨着发出，轻松超过 3 次/秒。NCBI 超限返回 429（甚至临时封 IP），而调用处 `except: continue` 会**静默吞掉**——表现为“未检索到文献”时有时无，损害旗舰“找选题”功能可靠性。
- **改动**：`backend/app/literature.py` 新增全局异步节流 `_throttle()`（`asyncio.Lock` + `time.monotonic`，间隔 `_NCBI_MIN_INTERVAL=0.34s`），在每次 esearch/efetch 的 GET 前 `await _throttle()`。并发与顺序都被串行拉开。
- **测试**（.venv 本地计时，零成本）：① 新增 `test_ncbi_throttle.py`：顺序 6 次耗时≥5×0.34s、相邻瞬时速率≤3/秒、并发 4 次也被串行拉开≥3 间隔，全 PASS；② 既有 5 个后端测试全过、`import app.main` 通过，无回归。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D5 文件下载健壮性 + 首个真实下载测试
- **现状/动机**：`downloadText` 创建对象 URL、`a.click()` 后**同步立即** `URL.revokeObjectURL`，且锚点未挂到 DOM。这是已知陷阱：部分浏览器要求锚点在 DOM 中才触发下载；大文件（数据分析报告内嵌多张 base64 图，可达数 MB）在 click 后被立即 revoke 会中断下载。导出按钮此前只有“可见”断言，真实下载路径零覆盖。
- **改动**：`frontend/src/lib/download.ts` 的 `downloadText`：锚点 `appendChild` 到 body、`display:none`，click 后用 `setTimeout(…,1000)` 延迟 `revokeObjectURL` 并移除锚点。
- **测试**（Playwright，mock 后端）：① `tsc --noEmit` 通过；② 新增 e2e：实验规划出结果后点“导出 Markdown”，用 `page.waitForEvent('download')` 捕获下载，断言文件名匹配 `实验计划-YYYYMMDD-HHMM.md` 且读取文件内容含正文——真正走通 downloadText；③ **全量 21 个 e2e 全过**。
- **部署**：已 `npm run build` 重建 dist。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D4 历史记录配额不足时静默丢失修复
- **现状/动机**：`history.addHistory` 写 localStorage 失败时 `catch{}` 直接忽略——新记录被静默丢弃。30 条历史每条都存整段结果文本（idea/plan/analyze 结论可达数十 KB），叠加各模块自身的结果持久化键，localStorage 容易撑满，此后历史**默默停止记录**，用户却以为存上了。（注：复盘发现历史 data 实际不含 base64 图，仅含文本；早先描述有误，特此更正——修复本身不受影响。）
- **改动**：`frontend/src/lib/history.ts` 的 `addHistory` 改为：写失败时逐步把列表减半（`Math.ceil(len/2)`，保留含最新的较新一半）后重试，直到写入成功或只剩 1 条仍放不下才放弃。最新记录因始终在 index 0 而总能存下（只要它本身不超额）。
- **测试**（Playwright，mock 后端零成本）：① `tsc --noEmit` 通过；② 新增 e2e 用例：预置 8 条较大旧历史并 override `Storage.setItem` 对 `ra:history` 施加 1200 字节上限触发淘汰，跑一次实验规划后断言历史第一条是“最新研究课题”（证明没被丢）且总条数 <9（证明发生淘汰）——旧实现此用例会失败；③ **全量 20 个 e2e 全过**，无回归。
- **部署**：已 `npm run build` 重建 `frontend/dist`。
- **commit**：见下次提交

## 2026-06-27 — 子任务F 部署易用性 / F-a PORT 配置健壮性（修复启动崩溃）
- **现状/动机**：`config.py` 用 `int(os.getenv("PORT","8756"))`，在**模块导入期**执行。若用户在 `.env` 把 PORT 写空（`PORT=`）或写成非数字，`int("")` 抛 ValueError，`from .config import settings` 直接崩，服务器起不来、只在 server.log 留个天书 traceback。项目有大量端口相关脚本，用户改 .env 改坏 PORT 是真实场景。
- **改动**：`backend/app/config.py` 新增 `_int(name, default, lo, hi)`：空/纯空格/非法/越界都回退默认；`port` 改为 `_int("PORT", 8756, lo=1, hi=65535)`，顺带限定合法端口范围。
- **测试**（.venv 离线）：① `test_config.py` 9 例全过（空/空格/非数字/越界/合法/带空格/未设置）；② 复现场景：`PORT=""` 时 import app.config 不再崩、port 回退 8756；③ 既有 4 个后端测试（fallback/network_retry/textio/danger_guard）全过；④ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C3-a 数据分析安全护栏误杀修复
- **现状/动机**：`dataanalysis._DANGER` 用 `\b(...|eval\s*\(|open\s*\()` 判危险。`\b` 是零宽词边界，`df.eval("a+b")`（合法 pandas）里 `.` 与 `eval` 间也算边界，于是被当成危险调用**误杀**，正常分析被拒并弹“包含不被允许的操作”。同时内置 `exec(` 当时未拦（注入面）。
- **改动**：`backend/app/dataanalysis.py` 重写 `_DANGER`：模块/名称类仍用 `\b`；`eval/exec/open` 改为 `(?<![\w.])(?:eval|exec|open)\s*\(`——仅匹配“前面不是 . 或字母”的内置函数形式。这样挡住注入/读文件，又放行 `df.eval()`、`df.query()`、`re.compile()`、含 open 的列名。
- **测试**（.venv 离线）：① `test_danger_guard.py` 12 例全过（合法 5 放行 / 危险 7 拦截，含新增 exec）；② **端到端** `_execute`：`df.eval` 代码 ok=True 输出 sum_c=21（修复前会被拒），`subprocess` 仍被拦并给友好中文；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务E 检索与引用 / E2 文档提取编码健壮性
- **现状/动机**：`extract.py` 抽取上传文档文本。两处编码缺陷：① `.csv` 用 `pd.read_csv` 默认 utf-8，GBK 文件崩溃；② `.txt/.md` 用 `content.decode("utf-8","ignore")`，GBK 文件里每个中文都是非法 utf-8 被 ignore **静默丢弃**——实测 14 个中文字只剩 1 个、正文变乱码，比报错更危险（用户拿到空/garbage 稿件却不知情）。
- **改动**：新增共享模块 `backend/app/textio.py`，提供 `decode_text()` 与 `read_csv_bytes()`，统一编码回退链 `utf-8-sig→utf-8→gb18030→latin-1`。`extract.py` 的 csv/txt 改用之；`dataanalysis.py` 删除自己的重复实现、改 import 共享工具（DRY）。
- **测试**（.venv 离线）：① 新增 `test_textio.py`：txt 的 GBK/带BOM/utf-8 均保留全文、GBK csv 正确提取、`_load` GBK 回归、decode 任意字节不抛错，全 PASS；② `test_fallback.py`/`test_network_retry.py` 全过（确认 dataanalysis 重构无回归）；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 子任务D 前端体验 / D2 复制按钮在局域网 http 下失效修复
- **现状/动机**：`navigator.clipboard` 仅在安全上下文（https/localhost）可用。本应用主推**局域网 http 访问**（仓库带 `允许局域网访问.bat`/`诊断局域网.bat`），此时 `navigator.clipboard` 为 undefined，复制按钮直接抛错、静默失效。两处中招：`ResultPanel.tsx`（四大模块共用的复制）与 `FormatModule.tsx` 的“复制全部”。
- **改动**：新增 `frontend/src/lib/clipboard.ts` 的 `copyToClipboard()`：安全上下文用现代异步 API，否则/失败时回退到临时 textarea + `execCommand('copy')`，返回布尔成功值。两处调用改用它；`ResultPanel` 复制状态从布尔改为 `ok|fail|null`，失败显示“复制失败”。
- **测试**（前端 Playwright，mock 后端零成本）：① `tsc --noEmit` 通过；② 新增 e2e 用例：`addInitScript` 把 `window.isSecureContext=false` 且 `navigator.clipboard=undefined` 模拟局域网 http，点击复制后断言按钮显示“已复制”（证明 execCommand 兜底生效、不抛错）；③ **全量 19 个 e2e 全过**，无回归。
- **部署**：仓库版本管理 `frontend/dist`，已 `npm run build` 重建 dist，确保 `git pull` 即获修复界面。
- **commit**：见下次提交

## 2026-06-27 — 子任务C 稳定性 / C1 网络错误友好化 + 重试 + 降级
- **现状/动机**：`llm._stream_openai/_anthropic` 用 httpx，网络超时/连不上会抛**原始 httpx 异常**，绕过 `LLMError`，在 `/api/run` 落到 `except Exception` → 用户看到 “内部错误: ConnectTimeout(...)” 之类天书；且无任何重试，弱网下一闪断就整次失败；也不会切备用。
- **调研**：读 `main.py` 确认三个端点的错误路径；读 `test_fallback.py` 确认改动需保持其 4 个断言（401 非配额不降级、mid-stream 不重复降级等）不破。
- **改动**：`backend/app/llm.py`：① `LLMError` 增 `retryable` 标志；② `_stream_with` 捕获 `httpx.TimeoutException/ConnectError/RequestError`，包装成友好中文且 `retryable=True` 的 `LLMError`；③ `stream_chat` 改为带重试循环：未产出内容时对瞬时错误退避重试 `_MAX_RETRIES=2` 次，重试耗尽后“配额错误 **或** 网络持续不可达”都尝试备用供应商；已产出内容则直接抛出不重试（防重复）。
- **测试**（.venv 离线零成本）：① `test_fallback.py` 4 项全过，无回归；② 新增 `backend/test_network_retry.py` 4 项全过：httpx 错误→友好可重试 LLMError、持续超时→重试2次再降级、第二次成功不降级、mid-stream 断网不重试不重复；③ `import app.main` 通过。
- **commit**：见下次提交

## 2026-06-27 — 遗留 P1 / 参考文献页码区间渲染修复
- **现状/动机**：Vancouver CSL 用 `page-range-format="minimal"`，citeproc-py 的 minimal 实现对“尾页位数多于首页”的区间出错：`1-10`→`1–0`、`99-100`→`99–0`，给用户错误页码。
- **调研**：读 Vancouver CSL 确认是 minimal 缩写规则；逐一测试不同页码，定位仅“尾页位数 > 首页”这一类出错，其余（1234-1245→1234–45 等 ICMJE 缩写）本是正确行为。验证 `style.root.set('page-range-format', …)` 可在样式对象上覆盖。
- **改动**：`backend/app/citations._resolve_style` 检测到 `minimal` 时强制改为 `expanded`，输出完整页码区间——永不产生错误，用户粘贴的本就多是完整区间。
- **测试**：① 渲染 6 组页码全 PASS（1-10→1–10、99-100→99–100、100-110→100–110、e123 不变等）；② **真实 LLM 端到端** `format_references`：3 条（含 URL-DOI vs 裸DOI 重复）→ 去重 1 条 + note 提示 + 页码 1–10/100–110 正确。
- **commit**：见下次提交

## 2026-06-26 — 子任务E 检索与引用 / E1 引用去重 + DOI 归一化
- **现状/动机**：`format_references` 把 LLM 解析出的 CSL-JSON 直接渲染。真实用户常粘贴重复条目（同一篇 DOI 一次写成 `https://doi.org/…` 一次写成裸 DOI），结果会重复列出；DOI 前缀也不统一。
- **调研/测试发现**：离线用 citeproc 复现，确认重复条目原样输出、无任何归一化。顺带发现页码 `1-10` 被渲染成 `1–0`（见遗留 P1）。
- **改动**：`backend/app/citations.py` 新增 `_normalize_doi`（去 `https://doi.org/`、`doi:` 等前缀）、`_dedup_key`（优先 DOI，否则 标题+年份+第一作者；无可识别信息则不参与去重，避免误删）、`_normalize_and_dedup`（规整+去重+重排连续 id）。`format_references` 在渲染前调用，并在去重时返回 `note` 提示去掉了几条。
- **测试**（.venv 离线）：① DOI 三种写法归一化 PASS；② URL-DOI 与裸 DOI 判同、无 DOI 靠元数据判同、独特条目保留、无信息条目不误删，全 PASS；③ 真实链路 `_parse_json_array→_normalize_and_dedup→render`：3 条→去重 2 条，Vancouver 渲染正常；④ `import app.main` 通过。
- **遗留**：P1 页码范围渲染（1-10→1–0）记入 BACKLOG 待后续修。
- **commit**：见下次提交

## 2026-06-26 — 子任务B 数据分析 / B4 CSV 编码健壮性
- **现状/动机**：`dataanalysis._load` 用 `pd.read_csv` 默认 utf-8 读取。中文用户从 Excel“另存为 CSV”得到的多是 GBK/ANSI 或带 BOM 的 utf-8-sig，上传后直接 `UnicodeDecodeError` 崩溃，对非 IT 用户是致命体验问题。子进程沙箱里的 `_load` 同样有此缺陷。
- **调研**：确认 Python 标准编码名是 `gb18030`（gbk/gb2312 超集），不是 gb18031；latin-1 解码任意字节、作兜底。复现脚本证实默认读取对 GBK 字节抛 0xd7 错误。
- **改动**：`backend/app/dataanalysis.py` 新增 `_CSV_ENCODINGS=(utf-8-sig, utf-8, gb18030, latin-1)` 与 `_read_csv_bytes()`，`_load` 改走它；子进程 `_RUNNER._load` 同步加同样的编码回退链。Excel 路径不变。
- **测试**（.venv，离线零成本）：① `_load` 对 GBK / utf-8-sig / utf-8 三种 CSV + .xlsx 全部 PASS，列名/行数正确；② `_execute` 子进程沙箱用 GBK 文件跑 groupby(中文列名) ok=True 输出正确；③ `import app.main` 通过；④ `test_fallback.py` 全过，无回归。
- **commit**：见下次提交

- **动机**：建立自动改进循环的状态与日志基础设施。
- **改动**：新增 `改进日志/`（LOOP改进指令.md、BACKLOG.md、LOG.md）；把"持续改进科研助手"拆成 6 个子任务（生成质量/数据分析/稳定性/前端/检索引用/部署），每个列 3 个初始改进方向。
- **测试**：本轮为拆解，无功能改动；确认 git 仓库可 commit/push。
- **commit**：见下次提交
