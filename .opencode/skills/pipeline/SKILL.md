---
name: pipeline
description: 完整目标（从零到成稿/成书、把数据做成投稿）的流水线细则：调度规划怎么写、质量闸与回退路径、判级铁律、grant/paper 各步的位置与跳过条件。主控判定为"完整目标"时先加载本技能再出调度规划；单步请求不需要。
---

# 流水线细则（完整目标专用）

主控（AGENTS.md）§三 的表是权威顺序；本文补每步的位置、可选条件、跳过条件与闸的处理。产物一律写当前会话目录，作下一步输入。

## 一、开工前先出「调度规划」
接下完整目标后先不动手，向用户展示：
1. **步骤清单**：依次调用哪些技能、每步产物是什么。
2. **检查闸**：哪几步是质量闸（`reference-check` 假引用/DOI、`peer-review` 方法与结果硬伤、systematic 的 PRISMA/RoB 与筛选量）及各闸通过标准。
3. **回退机制**：开工前写清"哪个闸不合格 → 退到哪步返工 → 从哪继续"，别等出错才临时决定：
   - reference-check 查出假引用 / DOI 错 → 回写作步（write-paper / literature-review）改引用 → 重跑 reference-check。
   - peer-review 发现设计 / 统计 / 结果硬伤 → 回对应上游步（novelty-check / clinical-stats / data-analysis / write-paper）返工 → 再评审。
   - write-paper 的引言 / 讨论综述单薄、文献覆盖不足或引用撑不住主张 → 回 literature-review 补综述与证据表 → 基于新综述重跑 write-paper。
   - systematic 的 PRISMA / RoB 暴露纳入不足或筛选漏项 → 回检索 / 筛选步补检索去重 → 重出图。
   - humanize-academic 改动动了引用文字 → 重跑 reference-check 兜底。
4. **判级铁律**：凡"需要用户补充输入"才能闭合的项（伦理批号 / 注册号 / 基金号 / 原始数据文件 / 目标期刊未定 / 某条数据需用户核原始记录）一律 Minor，不得记 Major / Critical、不触发回退——返工改不掉"用户还没给"，只会把交付卡死。照常判通过往下走，把它们列进交付时的「待补充」清单，能列成选项的给编号候选。Major / Critical 只留给我方可修的硬伤（设计 / 统计错误、假引用与错 DOI、结果与数据不符、方法学缺失）。
   「待补充」分两级写（两级都是 Minor、都不阻塞交付、都不触发回退，区别只在提示强度）：**一般待补**（伦理批号 / 注册号 / 基金号 / 目标刊未定——补不补都不影响工作成立）与 **⚠ 承重待补**（该事实若不成立，某个 Aim / 整份分析就是空的，如"回顾队列里够不够主结局事件数""关键检测是否真的做过"）。承重待补单列一栏「这几项若为否，需重做什么」，逐条点名后果 + 给一条最省事的核实动作；别把它和"缺伦理批号"混成一句"待你补充"。
5. **决策点**：标出需停下问用户的方向性 / 不可逆节点（AGENTS.md §五）。
6. 展示后即开工（除非用户要改）；每命中一个闸就报结果，触发回退时说明退回哪步、为什么、重做什么。同一闸反复回退 ≥2 次仍不过 → 停下找用户，别无限返工。

## 二、grant 流水线各步细则
- **第 0 步 定标模式 → `requirement_card.md`（全流水线公共输入）**：标的要求决定后面每一步（文体家族、评审评价维、指南方向、经费档位）。先定渠道；用户没提供文件就联网查当年申报通知 / 指南（内置渠道也查，通知才管得住改版与指南方向），查到的候选编号列给用户确认（无人值守才自动选官方来源并显著标注未确认），落卡即停。下游消费：research-scan 把扫描范围限定在受理方向内；topic-selection 评分加 funder-fit 维；idea-forge 阶段 0 从卡取评审评价维定议程权重、取指南方向做对表；grant-proposal 起草不再问渠道。用户单步直呼 grant-proposal 起草时不强制定标（技能内部自载卡）。
- **research-scan / topic-selection**：用户给了自己的研究问题 / 痛点（grant 模块表单必填，或对话里说了）→ research-scan 以它为锚做调研（不自拟替代方向），topic-selection 走细化模式：候选 1 固定"按你写的原样推进"，其余是结合文献的细节调整变体（收窄人群 / 换结局 / 改设计……，每条带真实引文），选哪条恒由用户拍板；AI 自拟课题只在用户什么都没给时兜底。
- **idea-forge（默认做）**：开工第一轮先摸底（把决策节点排成清单让用户一次性自答，填掉的直接销账），剩下的节点：用户有答案就基于它拷问，空手才检索发散给带引文候选；任何检索先过三闸（值不值查 / 查什么先给用户过目 / 用户点名的只核实不泛查），唯一不可省的是会写进正文的"首次·没人做过"类断言。产出 `design_brief.md` + `closest_work.md`，是 grant-proposal 第 3.5 步的直接输入。可跳的两种情况：目录里已有完整 design_brief.md；用户赶时间明说跳过（此时 grant-proposal 第 3.5 步自行补检索）。对话式技能，无人值守时整步跳过。承重墙节点（最接近工作拥挤 / 矛盾、机制链承重环判不清、gap 归因选"证据互斥"）快筛撑不住时可升级 deep-research 深挖一发（每场 ≤2 发、先问用户、AUTO 自动采推荐；细则见 idea-forge「深挖升级」）——deep-research 在 grant 里是锻打的弹药库，不单列流程步。
- **novelty-check（idea-forge 之后、grant-proposal 之前；别调顺序、别跳）**：锻打中方向常因用户资源现实转向，先做的裁定会过期。分工：锻打内嵌快筛负责早杀与定向（"最接近工作"节点必检文献 + 注册库快查）；novelty-check 对定稿科学问题做严格裁定（诚实性清单 + 注册库全查）+ 预注册锁。上游做过 idea-forge 时，以 design_brief.md 的关键科学问题为裁定对象、closest_work.md 为最接近文献表起点（补严不重做）。锻打被跳过时它直接跟在 topic-selection 后。
- **novelty-check → grant-proposal 是硬接口**：novelty-check 的《新颖性裁定记录》（最接近文献表含"它在什么条件下失效"一列 + gap 归因四选一 + 差异点陈述）是 grant-proposal 第 3.5 步「论证内核」的直接输入，立项依据主体段与创新点从它长出来；跳过它立项依据必然写成文献罗列（"A 报道了…然而机制尚不清楚"）。用户直呼 grant-proposal 时该技能会自己补一轮针对性检索，但成本更高、覆盖更窄。
- **裁定过期护栏（任何路径都适用）**：已有裁定记录但之后立意 / 科学问题转向（换人群 / 换干预 / 换主结局 / 换机制层）→ 视为过期，必须对新问题重跑 novelty-check 再进 grant-proposal——旧裁定的注册库结论对新问题不成立。
- **已有立意的起点**：跳过 research-scan 与 topic-selection，直接从 idea-forge 锻打用户设想起步（其余步骤与闸不变）；进场先做入口对表深检——用 deep-research 对他的设想查领域真实进展与在研竞争，落 `idea_landscape.md`（用户点头才跑、无人值守自动做、不占锻打深挖配额）；判「已被回答」时没有选题步可退，当场给 2–3 个带引文的转向候选让用户挑定再继续。

## 三、paper 流水线各步细则
- **novelty-check 的位置随数据来源变**：前瞻性研究 / 尚未采数（假设待冻结）→ 放最前先做预注册锁（把假设与主分析计划冻结在采数前）；用户已提供数据（回顾性）→ 可选，置 data-analysis 之后、且做了 idea-forge 就排在它后面，对定稿主张只裁定、不再预注册。
- **write-paper 前必跑 literature-review 成文综述**，write-paper 据此撰写引言与讨论的文献部分；综述不足属回退触发点。
- **idea-forge（可选）**：三种情况才做——用户没想好讲什么故事 / 投哪；write-paper 发现核心主张含糊或明显 overclaim；用户主动要求被拷问。产出 design_brief.md 供 write-paper 引言与讨论使用。无人值守时跳过。
- **data-integrity（可选自查闸）**：用户提供了原始数值表（xlsx/csv）时，在 data-analysis 后对源数据跑一遍数值完整性自查（复制粘贴错误 / 常数偏移 / 跨表复用 / GRIM 不自洽）；目的是投稿前主动核对补说明，非指控（signal not verdict）。默认 review 档假阳性低；纯理论 / 无数值原始表的稿件跳过。发现需核对的项属回退触发点：回 data-analysis 或让用户核原始记录后再往下。
- **已有初稿的起点**：write-paper 以初稿为底本逐节补强改写（不另起炉灶重写，改动要能对得回原稿）；literature-review 降为可选补强（引用撑不住主张时仍回来补做）；reference-check / peer-review 等质量闸照过。
- **clinical-stats 何时跳过**：诊断准确性 / 方法比对 / 纯实验室验证类研究常无人口学基线协变量（年龄 / 性别 / 分期）→ Table 1 无对应数据，整步跳过、全走 data-analysis，别把检测值 / 生存时间硬塞成"基线表"。

## 四、review / systematic / research
- review：首步 search-lit 与 literature-review 二选一或并用；humanize-academic 可选；出件 render-pdf-doc。
- systematic：systematic-review 完成方法学八步（含 PRISMA / RoB 出图）后交 write-paper 成稿 → reference-check → render-docx。
- research：deep-research → reference-check（查报告引用真伪）→ render-pdf-doc。
