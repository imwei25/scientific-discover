// 模块工作流定义：每个受限模块「走哪几步、每步要用户填什么、产出什么、怎么渲染」的唯一事实来源。
//
// 【为什么单独一个文件】它同时喂三处，写在 server.mjs 里会被淹掉：
//   ① 模块的技能白名单 —— MODULE_DEFS.skills 由 skillsOf() 从 steps 展开（此前是手写数组，
//      结果与 AGENTS.md §三 的路由表漂了：paper 缺了脱敏/统计/作图整个前半段、litread 缺排版）。
//      一份定义两用，从此不会再漂。
//   ② 前端表单 —— /api/modules/<id>/workflow 下发 schema，前端只当渲染器。改流程走「界面包」
//      热更新即可，不用重发桌面安装包。
//   ③ 任务卡 —— 表单值经 taskCard() 序列化成 【任务卡 · …】 文本块，拼在用户第一条消息前面。
//      这条路是抄 index.html 的 zScopePrefix()（Zotero 检索范围前缀），实测有效、零 opencode 改动。
//
// 【设计铁律：只灌初值 + 观察呈现，不做硬状态机】
// agent 会合并步骤、会跳步、会按 AGENTS.md §二 自己回退。服务端若强行卡「必须按序」，就会与它的
// 自主推进正面打架，产生「它已经做完了但界面卡在第 3 步」的死结。所以本模块【不阻断】任何东西：
// 表单填完 → 拼进消息；产物出现 → 反推进度；闸不过 → 给个返工按钮。用户随时可以跳过表单直接打字。
//
// 【系统综述 / Meta 不在此列】systematic-review 技能不属于任何模块，只能从「自由对话」调用
// （2026-08-04 决定）。综述模块的表单底部有一行固定指路，别让它成为哑失败。

// ---- 条件表达式（声明式，不用 eval）----
// 形如 { field:"hasRawData", has:"rawdata" } / { field:"studyType", in:["rct","prospective"] }
// / { field:"deidDone", eq:false }。前端与服务端共用同一套判定，行为必然一致。
export function condOk(cond, values) {
  if (!cond) return true
  if (Array.isArray(cond)) return cond.every((c) => condOk(c, values))   // 数组 = 全部成立（AND）
  const v = values?.[cond.field]
  if ("eq" in cond) return v === cond.eq
  if ("ne" in cond) return v !== cond.ne
  if ("in" in cond) return cond.in.includes(v)
  if ("has" in cond) return Array.isArray(v) && v.includes(cond.has)   // 多选题里勾了某项
  if ("hasNot" in cond) return !Array.isArray(v) || !v.includes(cond.hasNot)
  // 勾了 exempt 之外的【任何】一项。"只勾了免除项"与"免除项 + 别的"必须分得开 ——
  // 用 hasNot 表达"只勾了样本量就不用传数据"是错的：那会变成"只要勾了样本量，
  // 哪怕同时勾了生存分析也不用传数据"，一个没有数据的 KM/Cox 请求就这么放行了。
  if ("hasOther" in cond) return Array.isArray(v) && v.some((x) => !cond.hasOther.includes(x))
  // 空数组按"没填"算（与 withDefaults 同口径）：files/multi/tags 的值是数组，且前端建卡时
  // 会把它们补成 []——不折算的话「传了附件就不必填工作基础」这类互免判定永远不成立。
  if ("truthy" in cond) { const t = Array.isArray(v) ? v.length > 0 : !!v; return cond.truthy ? t : !t }
  return true
}

/** 字段/步骤是否显示：when 全部成立（AND）且 whenAny 至少一条成立（OR）。两者都可缺省。 */
export const visible = (f, values) =>
  condOk(f?.when, values) && (!f?.whenAny || f.whenAny.some((c) => condOk(c, values)))
/** 是否必填：required 恒真，或 requiredWhen 条件成立（如"勾了数据完整性才必须传数值表"） */
export const isRequired = (f, values) => !!f?.required || (!!f?.requiredWhen && condOk(f.requiredWhen, values))
/**
 * 步骤是不是"可选"。optional 恒可选；optionalUnless 表示"除非该条件成立，否则可选"——
 * 用于同一步在不同研究设计下的分量不同（回顾性里新颖性裁定可跳过，前瞻性/RCT 里它是必做的
 * 预注册锁）。既然把它提到了最前，就不能还标"可选"，那等于告诉用户这步能跳。
 */
export const isOptional = (s, values) =>
  !!s?.optional || (!!s?.optionalUnless && !condOk(s.optionalUnless, values))

// ---- 字段类型 ----
// text/textarea/number/select/multi/bool ：常规控件
// range      ：两个数字（min/max），值形如 {min,max}
// files      ：从本会话 uploads/ 里挑（前端拉 /api/uploads 填充）
// columns    ：从某个已上传数据表的表头里挑（前端拉 /api/data/headers 填充，见下方说明）
//
// ★ columns 是 stats/paper 最值钱的一个控件：「列名猜错/写错」是当前最高频的失败模式，
//   从真实表头下拉能从根上消灭它。source 指向同表单里那个 files 字段的 id。

// section 一旦起了标题，后面的字段就都被视觉上归进去了。所以凡是排在 JOURNAL_FILTER 之后的
// 字段都要自带一个新 section 来"收尾"，否则"输出语言"会被读成一条文献筛选条件。
const LANG = { id: "lang", label: "输出语言", type: "select", default: "zh", section: "成稿与输出",
  options: [{ v: "zh", t: "中文" }, { v: "en", t: "English" }] }

// 期刊筛选：一组字段，多个模块复用。**筛的是"检索到的文献发表在什么刊上"，不是"你想投哪本刊"。**
//
// ⚠️ 两条必须守住的措辞：
// ① 官方 JCR IF 与中科院分区是授权数据，本产品没有、也不能内置分发。默认档用 OpenAlex 的
//    两年篇均被引作近似分级，所以标签一律写「影响力（近似）」，绝不写成 IF / 分区 ——
//    那等于凭空造数（不虚构是本平台的硬性规定）。用户传了本机构的分区表才切精确档并标明来源。
// ② 在 SCI 论文表单里，这组字段紧跟在"目标期刊梯队/具体期刊"后面，实测会被百分之百读成
//    "我想投的刊影响因子几到几"。靠 section 分组（"检索到的文献要满足什么条件"）把它和目标
//    期刊隔开——**这个分组标题是唯一的防误读手段，必须始终挂在本组第一个字段上**。
//
// 【2026-08-08 删了 jImpact】原来第一项是「文献来源期刊的影响力（两年篇均被引，近似）」区间输入框，
// 按用户要求移除：它填的是一个连自己都要在 help 里解释三行"不是影响因子、可能不生效"的近似数，
// 用户读不懂、填了还常常静默失效。档位（jQuartile）留着够用了。
const JOURNAL_FILTER = [
  // 标题里【不能出现「影响因子」四个字】，连「非影响因子」这种否定式也不行 ——
  // 任务卡会原样带上这个标签，测试里有专门的守卫防止把近似指标说成影响因子。
  { id: "jQuartile", label: "影响力档位（近似）", section: "检索到的文献要满足什么条件",
    type: "multi", options: [
    // 分档要写成互不重叠的区间：原来 Q2「前50%」、Q3「后50%」看着像两段重叠（实测反馈）
    { v: "Q1", t: "前 25%（Q1）" }, { v: "Q2", t: "25%–50%（Q2）" },
    { v: "Q3", t: "50%–75%（Q3）" }, { v: "Q4", t: "后 25%（Q4）" }],
    help: "筛的是检索结果发表在什么刊上，不是你想投的刊。"
        + "按检索结果内部排序分的四档，不是中科院或 JCR 分区，别直接当分区汇报。留空 = 不筛。"
        // ★ 这句必须留着（原挂在已删除的 jImpact 上）。档位的取数口只有 OpenAlex，而它已改成
        //   按额度计费；没配额度时取数恒 429，本项**静默不生效**——实测勾了 Q1，结果池里混着
        //   Cureus 和一堆 Frontiers，而模型只轻描淡写说了句"OpenAlex 限流未能获取指标"，
        //   没说"你勾的筛选没起作用"。界面上不写清楚，用户就会把一份没筛过的结果当成筛过的。
        // ★ 这里【不能写 **粗体**】：字段的 help 是 textContent 渲染的（index.html 的 wfhelp2、
        //   reader.html 的 .sh），星号会原样显示成「取不到时**本项不生效**」。要强调就用「」。
        //   能吃 **粗体** 的只有 notice 与 footnote 两处（走 wfInlineMd）。
        + "⚠️ 档位取自 OpenAlex，需要该服务的可用额度；取不到时「本项不生效」"
        + "（结果不会按它过滤），届时报告里会注明。" },
  { id: "jOA", label: "只保留开放获取（OA）的文献", type: "bool", default: false,
    help: "OA = 不用订阅就能看全文。勾上能明显提高后续拿到原文的成功率（需要原文的模块才走这一步）。" },
]

// ============================================================
// 阅读器型模块（ui:"reader"）—— 四个「专项技能」模块共用的一套定义
// ------------------------------------------------------------
// 【什么样的模块适合它】输入是【一份东西】（一篇文献 / 一份稿件 / 一张数据表），
// 用户想对它做的事有好几种、彼此没有先后、随时来回切。这类模块套进通用壳（首屏表单 →
// 步骤条 → 一条对话流）是别扭的：步骤条永远停在"共 N 步、已完成 1 步"，而那份东西本身
// 没地方摆。阅读器壳给它：左边常驻那份东西，右边是助手，最右一列模式按钮。
//
// 【前端只是渲染器】下面这份 reader 配置由 /api/modules/<id>/workflow 整份下发，
// web/reader.html 不认识任何一个具体模块 —— 它只会照着 modes 画按钮、照着 prompt 发消息。
// 所以改模式、改措辞、加一个新模式，都只动这个文件，走「界面包」热更新即可，不用重发安装包。
//
// 【mark 是模式信号，且只有这一处定义】用户点某个按钮 → 前端把 `mark` 拼在消息最前面 →
// 模型照 `tell` 里教的去做 → 刷新页面时前端又靠 `mark` 把每一轮认回对应的面板。
// 三处用途、一个来源。此前 mark 在 reader.html 和 flow 文案里各写了一份，漂了的症状是
// "能跑，但刷新后所有轮次都掉进智能助手"——从界面上完全看不出是标记对不上。
// ============================================================

/** 自由问答那一格：四个模块都有，且都【没有 mark】——没有标记就是普通提问。
 *  位置：四个模块一律【排在模式条第一个】。它是唯一一个"随时都能用、不依赖前面跑没跑过"的入口，
 *  摆在第一格用户一眼就能找到；排在第二、三格时它看起来像是某条流程中间的一步。
 *  ★ 这只改按钮顺序，不改"点开始跑哪一个"——那个由 reader.first 单独指定（guide / profile / refs / polish）。 */
const chatMode = (badge, big, sub) => ({
  id: "chat", label: "智能助手", icon: "chat", badge, empty: [big, sub],
})

/**
 * 追问标记：`【文献导读】` → `【文献导读 · 追问】`。
 *
 * 【为什么要单独一个标记】结果跑完之后用户十有八九还有话说（"第 3 条能不能再细一点"、
 * "这个 p 值怎么来的"）。此前这类问题只能切去「智能助手」问 —— 而那一格与结果不在同一屏，
 * 问完还得自己记住是在谈哪一份结果。现在每一格结果下面就能接着问，答在原地。
 *
 * 它与 mark 一样【只有这一处定义】（由 mark 派生），三处共用：前端发消息时拼在最前面、
 * 前言里教模型认它、刷新页面后靠它把这一轮认回【那一格的追问区】而不是主结果。
 * ★ 派生而不是各写一份：mark 与 askMark 漂开的症状是"能跑，但刷新后追问全掉进智能助手"，
 *   从界面上完全看不出是标记对不上。
 * ★ `【X · 追问】` 不会 startsWith `【X】`（收尾的 `】` 位置不同），所以两种标记不会互相误认。
 */
export const askMarkOf = (mark) => (mark ? String(mark).replace(/】\s*$/, " · 追问】") : "")
const withAsk = (modes) => modes.map((m) => (m.mark ? { ...m, askMark: askMarkOf(m.mark) } : m))

/**
 * 由 modes 生成模块前言里那段「界面有几种模式、标记是什么、各自该做什么」。
 * tell 是写给模型看的一句话；prompt 是前端真正发出去的那段话。两者都要有：
 * 前言每一轮都在（用户切到自由问答、或直接打字时它仍然生效），prompt 只在点按钮那一次出现。
 */
function readerModeLines(modes) {
  const marked = modes.filter((m) => m.mark)
  return `\n- **界面有 ${modes.length} 种模式，用户消息开头的方括号标记就是他点的那个按钮**，照它做：`
    + marked.map((m) => `\n  · \`${m.mark}\`＝${m.tell}`).join("")
    // 追问：只用一行覆盖全部模式（每个模式各写一行会把前言撑长一倍，而规矩是同一条）。
    // 最要紧的是"别重跑"：模型看到 `【文献导读 · 追问】` 很容易把它当成又一次导读请求，
    // 于是重写一遍 reading_guide.md、再花十分钟 —— 而用户只是想问一句话。
    + `\n  · 标记里带 \` · 追问】\` 的（如 \`${marked.length ? marked[0].askMark : ""}\`）＝用户在**那一格已经跑出来的结果**下面追问：`
    + `直接基于那份结果与本会话上下文回答，**不要重跑那个模式、不要重写它的产物文件**，除非他明确要求重做；`
    + `答案写进回答里即可，别为一句追问再产出一份文件。`
    + `\n  · 没有标记的就是自由问答，基于已有上下文直接回答，**不要再重跑上面任何一件事**。`
}

// prompt 里的占位符由前端替换：{doc}=左栏那份文件名（带反引号）、{data}=配套数值表、
// {vars}=stats 的「变量对应」面板填了什么。占位符没有对应值时前端会整句删掉，不会留下 "{data}"。

const LITREAD_MODES = withAsk([
  chatMode("基于本文", "对着这篇文章随便问",
    "它读的是你左边这一篇；前面的导读、翻译、做 PPT 都还在上下文里，可以接着问。"),
  { id: "guide", label: "文献导读", icon: "guide", mark: "【文献导读】", badge: "抽取核心 · 梳理逻辑",
    file: "^reading_guide.*\\.md$",
    // out = 面板下方列哪些产物。fulltext.md 归导读：它是"读入原文"的成果，
    // 用户想核对"它到底读到了什么"时找的就是这个文件。
    out: "^(reading_guide|fulltext)[^/]*\\.(md|docx|pdf)$",
    empty: ["还没有导读", "点上方的「开始」，让它把这篇文章的核心与论证逻辑理一遍，并出一份 Word。"],
    // ★ 导读多一步「出 Word」：md 是界面渲染要用的载体（file 认的就是它），docx 是用户
    //   拿去传阅 / 存档的交付物。两个都要，别用 docx 顶掉 md —— 顶掉的话面板正文就空了。
    tell: "抽取核心重点、梳理论证逻辑，正文写进回答里，同时存一份 `reading_guide.md`，"
      + "并再用 `render-docx` 把它转成 `reading_guide.docx`（默认 `--journal generic-submission`）交付",
    prompt: "请研读我上传的这篇文献 {doc}，做一份**导读**：抽出它的核心重点，把论证逻辑梳理清楚。\n\n"
      + "按这个结构写：\n"
      + "1. **一句话结论** —— 这篇文章做了什么、最重要的发现是什么；\n"
      + "2. **背景与缺口** —— 它要解决的问题是什么，此前卡在哪；\n"
      + "3. **研究设计** —— 研究类型、对象与样本量、分组与干预、主要终点、统计或实验手段；\n"
      + "4. **主要结果** —— 按图表逐条给关键数字（效应量、95%CI、p 值……原文有多少给多少）；\n"
      + "5. **论证链条** —— 从问题 → 假设 → 证据 → 结论一步一步串起来，指出哪一步最关键、哪一步最薄弱；\n"
      + "6. **局限与存疑**；\n"
      + "7. **这篇能用在哪** —— 对读者课题的意义。\n\n"
      + "只依据原文：数字与结论一律照抄，原文没写的写「原文未报告」，不许拿背景知识补，也不许引入原文之外的参考文献。"
      + "引用具体数据时带上出处（第几节 / 哪张图表）。\n"
      + "写完把这份导读同时存一份 `reading_guide.md`。\n\n"
      + "**最后一步：出 Word。** 用 `render-docx` 技能把它转成 `reading_guide.docx`：\n"
      + "```bash\n"
      + "bash \"${REPO_ROOT:-/app}/.opencode/skills/render-docx/scripts/render_docx.sh\" "
      + "-i reading_guide.md -o reading_guide.docx --journal generic-submission\n"
      + "```\n"
      + "两个文件都要留（md 给界面渲染，docx 给我拿走）；转完在回答末尾说一句 Word 已出好。"
      + "万一 pandoc 不可用导致转换失败，如实说明并把 `reading_guide.md` 照常交付，别假装出了 Word。" },
  // ★ 按【上传文件的格式】分流，别再一律出 markdown。
  //   实测踩到：用户传了一份 .docx 进来点「全文翻译」，拿回的是 translation_zh.md ——
  //   站在他的角度"我传了个 Word 让你翻译，凭什么给我 md"完全合理。而同一个动作在
  //   【文章润色】模块里（稿件翻译）却保排版，两处结果不一致，用户没法预期。
  //   .pdf 仍走 markdown：PDF 本来就没有可回填的排版载体。
  { id: "translate", label: "全文翻译", icon: "translate", mark: "【全文翻译】", badge: "逐段全文 · Word 保排版",
    file: "^translation.*\\.(md|docx)$", out: "^translation[^/]*\\.(md|docx|pdf)$",
    empty: ["还没有译文", "点上方的「开始」，逐段译成中文（不是摘要）。Word 原稿会保着排版译回 Word。整篇要花几分钟。"],
    tell: "**逐段全文**翻译（不是摘要、不许跳段）：Word 稿就地译回 `translation_zh.docx`（保排版），"
      + "其余格式译成 `translation_zh.md`；回答里只报一句\"已完成、共几节\"，"
      + "**不要把整篇译文再贴进对话**（界面直接渲染那个文件给用户看）",
    prompt: "把我上传的文献 {doc} **全文**翻译成中文。\n\n"
      + "**先看格式分流：**\n"
      + "- 原文是 **`.docx`** → 走**就地翻译**，产物是 Word、排版原样不动"
      + "（用 `humanize-academic` 技能里的脚本，路径 `.opencode/skills/humanize-academic/scripts/`）：\n"
      + "  ① `docx_extract.py <原文>` → `<原名>_para.md`，每行 `[[p0007]] 原文`；\n"
      + "  ② **逐行翻译**，写成 `<原名>_trans.md`——行首 `[[id]]` 一个字符都不动、不增删行；"
      + "`⟦…⟧` 里是引文域 / 交叉引用 / 页码，**原样保留不翻译**；\n"
      + "  ③ `docx_translate.py <原文> <原名>_trans.md -o translation_zh.docx "
      + "--set-lang zh-CN --cjk-font 宋体`（译成英文则用 `--set-lang en-US --latin-font \"Times New Roman\"`）；\n"
      + "  ④ `docx_verify.py <原文> translation_zh.docx --mode translate --expect-lang zh`，四道闸全过才算完。\n"
      + "  这条路**不重建文件**，所以图、表、公式、页眉页脚、引文域全都不会动；"
      + "交付时把校验打印的「图 N → N、表 M → M」和「多少段段内格式被统一」照实转告我。\n"
      + "- 原文是 **`.pdf`** 或其他格式 → 没有可保的排版载体，按下面的要求译成 `translation_zh.md`。\n\n"
      + "要求（两条路都适用）：\n"
      + "- **逐段译全文**，保留原文的章节结构与标题层级（Abstract / Introduction / Methods / Results / Discussion…）；"
      + "**这是翻译不是摘要**，不许概括、不许跳段、不许只译摘要；\n"
      + "- 学术书面语；专业术语用规范中文译名，并在**首次出现**时括注英文原文；\n"
      + "- 图表题注一并译出，表格用 markdown 表格；公式、基因 / 蛋白 / 药物名、统计量符号保留原样；\n"
      + "- 参考文献列表不用翻译，按原样保留即可。\n\n"
      + "**产物**：Word 原稿 → `translation_zh.docx`；其余 → `translation_zh.md`（完整全文）。"
      + "文件写完后，回答里**只回一句话**说明已完成、共几节，"
      + "**不要把译文再贴进对话**——界面会直接把那个文件渲染给我看。" },
  // ---- 演示 PPT：本模块唯一的【两阶段】模式（见下面 stage2 与 reader.html 的阶段卡）----
  // 【为什么非得分两步、并且让界面知道】原来这一格是一句话发出去："先把大纲写成 ppt_outline.md
  //   （我要先审一遍），再导出 .pptx"。三件事叠在一起把它变成了一格半成品：
  //   ① 那句"我要先审一遍"本身就是个停顿信号，模型写完大纲就合理地结束了这一轮；
  //   ② `ppt-master` 内部还有一道 ⛔ BLOCKING 的 Strategist 三段确认闸，默认走 localhost:5050
  //      的 Confirm UI —— 网页版用户在容器外根本打不开那个页面，于是它必然停下等确认；
  //   ③ reader 的面板正文一律【优先画产物文件】，大纲一落盘就把模型那一轮说的话整段顶掉。
  //   三者合起来的实际观感是："我点了「演示 PPT」，它给我一篇文字，然后就说完成了。"
  //   而用户唯一能想到的续跑办法（在输入框回一句"确认，出片"）会被打上追问标记，
  //   追问的规矩恰恰是"不要重跑、不要产出文件"—— 唯一的通道被自己的前言堵死。
  //   所以：第一步只出大纲与出片方向（快、便宜、可反复改），界面画一张阶段卡 + 一颗
  //   「按这份大纲出片」按钮；那颗按钮发的是 stage2.prompt（带同一个 mark，仍算本格主结果，
  //   不是追问），并把三段确认的值一次性交齐，让第二步一路跑到 .pptx。
  { id: "ppt", label: "演示 PPT", icon: "ppt", mark: "【演示 PPT】", badge: "分两步 · 先审大纲再出片",
    file: "(^|/)ppt_outline.*\\.md$",
    // ppt-master 把导出的 .pptx 放在 <项目名>/exports/ 下，所以要允许一层子目录。
    // ★ /api/outputs 现在整棵树都列（按目录折叠），<项目名>/exports/x.pptx 也看得见了；
    //   但 stage2.prompt 里"把最终 .pptx 复制一份到会话根目录"那条要求仍然留着 ——
    //   折叠块要点开才展开，而这是本格的【交付物】，它该在最外层第一眼就看到，不该藏在两层目录里。
    out: "(^|/)(ppt_outline[^/]*\\.md|[^/]*\\.pptx)$",
    empty: ["还没有 PPT", "点上方的「开始」——先出一份大纲与出片方向（一两分钟）；你确认之后再生成 .pptx（那一步慢，十分钟上下）。"],
    tell: "**分两步走，这一轮只做第一步**：只出大纲与出片方向、写进 `ppt_outline.md`"
      + "（**不建工程、不调 `ppt-master`、不生成任何 .svg / .pptx**），写完就结束这一轮；"
      + "用户在界面上点「按这份大纲出片」时，第二步的指令会自己发给你",
    prompt: "基于我上传的文献 {doc}，先为一套**组会汇报用**的演示 PPT 做**大纲与出片方向**。\n\n"
      + "**这一轮只做大纲：不要建工程、不要调 `ppt-master`、不要生成任何 .svg / .pptx。**\n\n"
      + "写成一个文件 `ppt_outline.md`，含两部分：\n"
      + "**一、逐页大纲**（12–18 页）：封面 / 背景与问题 / 研究设计 / 主要结果（按图表分页）/ 结论 / 局限 / 对我们课题的启发。"
      + "每页给标题 + 该页要点；结果页带原文的关键数字，**不许编数据**，原文没有的写「原文未报告」。\n"
      + "**二、出片方向**：视觉风格、主色与配色、中英文字体、总页数、配图策略（AI 生成主视觉 / 只用原文图表 / 不配图）。"
      + "每项**给一个明确的推荐值**并一句话说明为什么——下一步就直接按它出片，只列选项不给结论会把我卡住。\n\n"
      + "回答里把这两部分讲一遍（我要在界面上审），末尾提一句：想改哪一项就在输入框说，改完点「按这份大纲出片」。",
    // ---- 第二阶段：界面上那颗按钮发的就是它 ----
    // done  = 会话目录里出现这个文件 ⇒ 已出片（阶段卡据此从"待确认"翻到"已完成"）
    // note / running / doneNote = 阶段卡在三种状态下说的话（markdown）
    stage2: {
      done: "\\.pptx$",
      btn: "按这份大纲出片",
      note: "**这是第 1 步 / 2：大纲**。确认之后才会生成可下载的 .pptx（十分钟上下）。\n\n"
        + "想改风格 / 配色 / 页数 / 配图，**先在下方输入框说一句**，改完再点这颗按钮。",
      running: "**正在出片**：建工程 → 逐页画 SVG → 导出 .pptx。这一步慢，十分钟上下，中途别关页面。",
      doneNote: "**已出片**。点「预览幻灯片」就地翻一遍，或下载到本机改（下方产物栏里也能取）。",
      prompt: "大纲与出片方向我看过了，**确认就按 `ppt_outline.md` 这份出**。现在用 `ppt-master` 技能把它做成 .pptx。\n\n"
        + "- `ppt_outline.md` 的「出片方向」那一节，就是我对**风格 / 配色 / 字体 / 页数 / 配图策略**的**明确确认值**——"
        + "Strategist 那道确认闸按它直接落定，其余细节按你的推荐值走，**不要再停下等我回话**，一路跑到导出 .pptx。\n"
        + "- **不要启动 Confirm UI**：本部署是远程容器 / 无 GUI，那个页面我打不开，启动只会让我们对着它白等。\n"
        + "- 素材用会话目录里的 `fulltext.md` 与 `ppt_outline.md`，**必须各复制一份再交给技能**——"
        + "`import-sources --move` 会把源文件移进 `sources/`，而界面靠根目录这两份显示原文与大纲，移走了这一格就白屏。\n"
        + "- 导出之后**把最终 .pptx 复制一份到会话根目录**（当前目录，裸文件名，例如 `汇报_<简短题名>.pptx`）："
        + "`exports/` 在子目录里，界面的产物栏只列一层，不复制上来用户既看不见也下载不到。\n"
        + "- 全程只依据 `fulltext.md` 与大纲，**不许编数据**。做完只回一句话：文件名 + 共几页。",
    } },
])

const REFCHECK_MODES = withAsk([
  chatMode("基于这份稿件", "对着这份稿子随便问",
    "前面跑过的核查报告都还在上下文里——可以追问某一条为什么判黄，或让它把某一段重写。"),
  { id: "refs", label: "引用核查", icon: "check", mark: "【引用核查】", badge: "查假引用 · 核 DOI · 撤稿",
    file: "^(refcheck_report|reference_check).*\\.md$",
    out: "^(refcheck_report|reference_check)[^/]*\\.(md|csv|docx|pdf)$",
    empty: ["还没核查引用", "点上方的「开始」，逐条去线上核实这份稿子的参考文献是否真实存在、DOI 对不对、有没有引到撤稿文献。"],
    tell: "用 `reference-check` 技能逐条核实参考文献，报告写成 `refcheck_report.md`",
    prompt: "请核查我上传的稿件 {doc} 的参考文献，用 `reference-check` 技能。\n\n"
      + "逐条核这四件事：\n"
      + "1. 这篇文献**是否真实存在**（标题 / 作者 / 期刊 / 年份 / 卷页对不对得上）；\n"
      + "2. **DOI 是否正确**、能否解析到同一篇；\n"
      + "3. 是否引用了**已撤稿**文献；\n"
      + "4. 正文角标与文末条目**是否一一对应**（有引无据 / 有据无引）。\n\n"
      + "逐条给结论，用 🟢 / 🟡 / 🔴 三档：绿＝核实无误，黄＝有出入需我复核（写清哪一项对不上），红＝查无此文献 / DOI 错 / 已撤稿。\n"
      + "**查不到 ≠ 不存在**：网络受限或数据库没收录时如实写「未能核实」并说明原因，不许判成假引用。\n"
      + "报告写成 `refcheck_report.md`，末尾给一行汇总（共几条、绿黄红各几条、几条未能核实）。" },
  { id: "review", label: "方法与统计审校", icon: "review", mark: "【方法与统计审校】", badge: "投稿前自查 · 找硬伤",
    file: "^review_report.*\\.md$", out: "^review_report[^/]*\\.(md|docx|pdf)$",
    empty: ["还没审校", "点上方的「开始」，按审稿人的眼光找研究设计与统计上的硬伤。"],
    tell: "用 `peer-review` 技能做投稿前自查，报告写成 `review_report.md`",
    prompt: "请用 `peer-review` 技能审校我上传的稿件 {doc}，按**审稿人**的眼光找硬伤。\n\n"
      + "重点看：研究设计与问题是否匹配、样本量与把握度、统计方法选得对不对（含多重比较、生存分析的前提、"
      + "回归的共线性与过拟合）、结果与结论是否一致、有没有过度解读因果、图表与正文数字是否对得上。\n"
      + "每条问题给：**严重度（致命 / 重大 / 一般 / 建议）+ 在稿件哪一处 + 为什么是问题 + 具体怎么改**。\n"
      + "**不许只夸不批**，也不许把\"我没看出问题\"写成\"没有问题\"——看不出来的地方如实说看不出来。\n"
      + "报告写成 `review_report.md`。" },
  { id: "integrity", label: "数据完整性", icon: "table", mark: "【数据完整性自查】", badge: "需配套数值表",
    file: "^integrity_report.*\\.md$", out: "^(integrity_report[^/]*\\.md|audit/.*)$",
    need: ["data"],
    needHint: "这一项要对着源数据查，请先上传配套的数值表（.xlsx / .csv）。",
    empty: ["还没做数据自查", "点上方的「开始」，对源数据做一遍数值 sanity check（需要先传数值表）。"],
    tell: "用 `data-integrity` 技能对配套数值表做数值完整性自查，报告写成 `integrity_report.md`",
    prompt: "请用 `data-integrity` 技能，对我上传的数值表 {data} 做一遍**投稿前的数值完整性自查**"
      + "（稿件是 {doc}，可对照它报告的数字）。\n\n"
      + "查：复制粘贴错误、整列常数偏移、跨表重复使用同一段数据、均值/SD 与样本量不自洽（GRIM / GRIMMER）、"
      + "小数位与有效数字异常、末位数字分布异常、稿件正文里的数字与表里对不对得上。\n"
      + "**铁律：只出「待核信号」，不下「造假」结论**（signal not verdict）。每条写清：在哪一格 / 哪一列、"
      + "为什么值得核、**最可能的良性解释是什么**、你该去核哪份原始记录。\n"
      + "报告写成 `integrity_report.md`。" },
])

const HUMANIZE_MODES = withAsk([
  chatMode("基于这份稿件", "对着这份稿子随便问",
    "润色稿和改动清单都还在上下文里——可以让它把某一段再改一版，或问某处为什么这么改。"),
  { id: "polish", label: "润色改写", icon: "wand", mark: "【润色改写】", badge: "去 AI 味 · 保住原意",
    file: "(^|/)[^/]*humanized[^/]*\\.(md|docx)$", out: "(^|/)[^/]*humanized[^/]*\\.(md|docx|pdf)$",
    empty: ["还没润色", "点上方的「开始」，按期刊写作范式改一遍行文，同时把生成式文本的痕迹去掉。"],
    tell: "Word 稿走就地改写（只改字、原格式不动，落成 Word 修订）；PDF / md 稿走 `ingest_doc.py` 那条",
    prompt: "请用 `humanize-academic` 技能润色我上传的稿件 {doc}。\n\n"
      + "**第一步：按格式分流（见技能第零步）。**\n"
      + "- 稿件是 **`.docx`** → 走 **A 路就地改写**，别转 markdown：\n"
      + "  ① `.venv/bin/python .opencode/skills/humanize-academic/scripts/docx_extract.py <稿件>` "
      + "→ `<原名>_para.md`（每行 `[[p0007]] 正文`）；\n"
      + "  ② 逐行改写正文，写成 `<原名>_edited.md`——**行首 `[[id]]` 不动、不增删行、不合并或拆分段落**，"
      + "`⟦…⟧` 里是引文域 / 交叉引用 / 页码，可整体挪位置但**一个字都不许改**；\n"
      + "  ③ `docx_apply.py <稿件> <原名>_edited.md -o <原名>_humanized.docx --track-changes`；\n"
      + "  ④ `docx_verify.py <稿件> <原名>_humanized.docx --auto-terms`，**四道闸全过才算完**。\n"
      + "  这条路不重新生成文件，所以我的排版、表格合并单元格、EndNote 引文域、页眉页脚全都不会动；"
      + "**做完不要再跑 render-docx**，那会把我的格式换掉。\n"
      + "- 稿件是 **`.pdf` / `.md`** → 走 B 路：`ingest_doc.py <稿件>` 得到 `<原名>_src.md` 与 "
      + "`<原名>_files/`，记下它报的「图 N 张 / 表 M 张」；成稿写 `<原名>_humanized.md`，"
      + "再跑 `check_invariants.py --before <原名>_src.md --after <原名>_humanized.md`。\n"
      + "别自己拿 pandoc / python-docx 随手抽文本——那样抽出来的稿子没有图，而且后面一路不会报错。\n\n"
      + "**底线（比任何润色目标都优先）**：\n"
      + "- 不许改动任何**数字、单位、统计量、样本量、p 值、置信区间**；\n"
      + "- 不许改动结论的**强度**——「显著低于」不许变成「低于」，「证实」不许变成「提示」，反之亦然；\n"
      + "- 参考文献角标与其所在句子的事实主张一字不动；\n"
      + "- B 路还要**把图和表原样搬进润色稿**：`![alt](路径)` 整行照抄（含 `{width=...}`），"
      + "pipe 表整块照抄，图题表题的措辞可以改但**序号不许动**。\n\n"
      + "在回答里**只报一句**改了多少段、主要改了哪几类问题，外加一句对账："
      + "A 路报「修订 X 处插入 / Y 处删除，四道闸全过」并告诉我在 Word「审阅」里可逐条接受或拒绝，"
      + "**若有「跨可见格式边界」的告警一定要转告我**；B 路报「原稿 N 图 M 表，润色稿同样 N 图 M 表」。\n"
      + "逐句对照放到「改动对照」那个模式里，这里不用铺开。" },
  // ★ 这个「稿件翻译」跟【文献研读】模块里那个「全文翻译」不是一回事，别合并：
  //   那边是【读者向】——输入多为 PDF 文献，先抽成 fulltext.md，产物是 translation_zh.md，
  //   目的是"帮我读懂这篇外文文献"，本来就没有格式要保。
  //   这边是【投稿向】——输入必须是用户自己的 .docx，第一要务是把排版原封不动地留住。
  { id: "translate", label: "稿件翻译", icon: "translate", mark: "【稿件翻译】", badge: "保原格式 · 逐段全文",
    file: "(^|/)[^/]*_translated\\.docx$", out: "(^|/)[^/]*_translated\\.docx$",
    empty: ["还没翻译", "点上方的「开始」，把这份稿子整篇译成另一种语言——排版、图表、引文域原样不动。"],
    tell: "用 `docx_extract.py` → 逐段译 → `docx_translate.py` 就地写回，产物 `<原名>_translated.docx`",
    prompt: "把我上传的稿件 {doc} **整篇翻译**，就地写回 Word，**不要重新生成文件**。\n\n"
      + "**目标语言**：中文稿译成英文、英文稿译成中文；两种语言混排或判不准时，"
      + "先用编号选项问我（回一个数字即可），别自己拍板。\n\n"
      + "**步骤（用 `humanize-academic` 技能里的三个脚本，路径 `.opencode/skills/humanize-academic/scripts/`）**：\n"
      + "① `docx_extract.py <稿件>` → `<原名>_para.md`，每行 `[[p0007]] 原文`；\n"
      + "② **逐行翻译正文**，写成 `<原名>_trans.md`——行首 `[[id]]` 一个字符都不动、"
      + "不增删行、不合并或拆分段落；`⟦…⟧` 里是引文域 / 交叉引用 / 页码，**原样保留不翻译**"
      + "（它们由 Word 按域代码重算，翻了也会被 F9 刷回去）；\n"
      + "③ `docx_translate.py <稿件> <原名>_trans.md -o <原名>_translated.docx "
      + "--set-lang en-US --latin-font \"Times New Roman\"`"
      + "（译成中文则用 `--set-lang zh-CN --cjk-font 宋体`）——**这两个参数不能省**："
      + "不设语言标记，Word 会拿原语言的词典校对译文、全篇红波浪线；不设西文字体，"
      + "英文会用宋体渲染；\n"
      + "④ `docx_verify.py <稿件> <原名>_translated.docx --mode translate --expect-lang en`，"
      + "**四道闸全过才算完**。\n\n"
      + "**底线**：\n"
      + "- **一段都不许跳**。漏译闸会逐段点名"
      + "（判据是「译文与原文一字不差且原文含源语言字符」），被点名就补译重跑；\n"
      + "- 数字、单位、统计量、p 值、置信区间、`[n]` 角标、DOI/PMID **原样搬过去**，"
      + "一个字符都不许变；\n"
      + "- 基因名 / 缩写 / 检测项目名（TP53、SGLT2、FT3）**不要翻译**，保持原样；\n"
      + "- 同一术语全篇用同一个译法，别一会儿一个说法。\n\n"
      + "**交付时必须说清四件事**（脚本会把数字打给你，照实转告）：\n"
      + "1. 译了多少段、四道闸的结果，外加一句**图表的账**"
      + "（校验的结构层会打印「图 N → N、表 M → M」，照抄给我——图和表根本没离开过原文件，"
      + "但我看不到这句话时无从判断你有没有弄丢）；\n"
      + "2. **有多少段原本段内有多种格式（加粗/斜体/颜色），译文按主导格式统一了**——"
      + "这一条无法回避（译文里那个词落在哪儿机器判断不了），要保住得人工在 Word 里补；\n"
      + "3. **篇幅涨/缩了百分之多少**——原表格列宽是固定的，中译英常涨 40–60%，"
      + "窄列里的长句会把行撑高、页数也会变。\n\n"
      + "稿件是 `.pdf` / `.md` 时**这条路不适用**（没有可保的排版载体）：如实告诉我，"
      + "并建议改用【文献研读】模块的「全文翻译」，或先把稿子存成 .docx。" },
  { id: "changes", label: "改动对照", icon: "diff", mark: "【改动对照】", badge: "逐条列 · 可回退",
    file: "^changes.*\\.md$", out: "^changes[^/]*\\.(md|csv|docx)$",
    need: ["after:polish"],
    needHint: "改动对照是拿润色稿和原稿逐句比出来的。",
    empty: ["还没有改动清单", "润色完点这里，逐条看它到底改了什么、为什么改——不同意的地方可以让它回退。"],
    tell: "把润色稿与原稿逐条对照，清单写成 `changes.md`",
    prompt: "把你刚才的润色稿与**原稿**逐条对照，列出改动清单"
      + "（A 路就地改写比 `<原名>_para.md` 与 `<原名>_edited.md`；B 路比 `<原名>_src.md`；都没有就用 {doc}）。\n\n"
      + "每条一行，给：**原句 → 改后句 + 为什么改（属于哪一类：语法 / 冗余 / AI 味 / 术语统一 / 逻辑连接）**。\n"
      + "按段落顺序排，**带上段落编号**（A 路就是 `[[p0007]]` 那个 id，我照它能在 Word 里定位）。"
      + "**只改了标点或空格的不用列**。\n"
      + "如果有任何一处你动了数字、单位或结论强度，**或者少了一张图 / 一张表**，"
      + "**单独拎出来放在最前面并标红说明**——那是不该发生的，我要第一时间看到。\n"
      + "清单末尾附一行对账：A 路给「修订 X 处插入 / Y 处删除，校验四道闸结果」，"
      + "B 路给「原稿 N 图 M 表 / 润色稿 N 图 M 表」。\n"
      + "**A 路请在开头写一句**：这些改动已经以 Word 修订的形式记在 `<原名>_humanized.docx` 里，"
      + "在「审阅」里可逐条接受或拒绝，这份清单只是便于通读。\n"
      + "清单写成 `changes.md`。" },
  { id: "render", label: "排版出件", icon: "doc", mark: "【排版出件】", badge: "默认送审格式",
    file: null, out: "(^|/)[^/]*\\.(docx|pdf)$",
    need: ["after:polish"],
    needHint: "排版排的是润色后的稿子，不是你传上来的原稿。",
    empty: ["还没出件", "润色完点这里，排成可直接送审的 Word / PDF。"],
    tell: "用 `render-docx` / `render-pdf-doc` 按默认送审格式出件",
    prompt: "把润色后的稿子排版出件。\n\n"
      + "**先判断有没有必要**：如果上一步走的是 **A 路就地改写**（产物已经是 `.docx`，"
      + "保着我原稿的排版），**默认不要重排**——直接告诉我「已保留原格式，无需重排；"
      + "确实要换成送审格式请说一声」，然后停下。只有我明确要求换格式、或上一步是 B 路"
      + "（产物是 `.md`）时，才真的排版。\n\n"
      + "没指定期刊就用默认送审格式：`--journal generic-submission`"
      + "（Times New Roman 12pt、1.5 倍行距、页码、首行缩进 4 字符、三线表、1in 边距）。\n"
      + "**如果我在设置里填了目标期刊**，先查该刊的 Instructions for Authors 再落参数；"
      + "查不到就如实说明并退回默认预设，**不许凭印象编该刊格式**。\n"
      + "排版脚本若报「稿件引用的图片找不到」，那是硬错误：把图补齐再出件，"
      + "**别改成把图删掉了事**。\n"
      + "出件后告诉我文件名，并说明图表都在（几张图、几张表）。" },
])

const STATS_MODES = withAsk([
  chatMode("基于这份数据", "对着你的数据随便问",
    "前面跑过的体检、基线表、统计结果都还在上下文里——可以追问某个 p 值怎么来的，或让它换个方法再算一次。"),
  { id: "profile", label: "数据体检", icon: "stethoscope", mark: "【数据体检】", badge: "先查再算",
    // file 只认体检报告本身：loadDocFor 命中多份时取【排序后第一份】，把 cleaning_log 也算进来的话
    // 字母序让它排在 data_profile 前面 —— 两份都在时面板正文显示的是清洗日志，而标题写着「数据体检」。
    // 清洗日志仍在 out 里，作为产物列在面板下方（该下载下载、该预览预览）。
    file: "^data_profile.*\\.md$", out: "^(data_profile|cleaning_log)[^/]*\\.(md|csv)$",
    empty: ["还没体检", "点上方的「开始」。重复 ID 没去、分类水平没归一时，后面每一个 p 值都是错的，而表面看不出来——所以这一步值得先做。"],
    tell: "用 `data-analysis` 做数据体检（缺失 / 异常 / 重复 ID / 分类水平不一致），报告写成 `data_profile.md`",
    prompt: "请对我上传的数据表 {data} 做一遍**数据体检**（`data-analysis` 技能）。{vars}\n\n"
      + "查：每列的缺失率与缺失模式、重复 ID / 重复行、分类变量的水平是否需要归一（如「男 / 男性 / M」）、"
      + "连续变量的分布与离群值、日期与数值列的类型是否被读错、组间样本量是否悬殊。\n"
      + "**先别做任何推断统计**。发现的问题逐条列出并给出建议的处理方式；"
      + "**不要自己替我把数据改掉**，要改也先告诉我改哪些、为什么。\n"
      + "报告写成 `data_profile.md`。" },
  { id: "table1", label: "基线表", icon: "table", mark: "【基线表 Table 1】", badge: "分组对比 · 三线表",
    file: "^table1.*\\.csv$", out: "^table1[^/]*\\.(csv|md|docx)$",
    need: ["var:groupCol"],
    needHint: "基线表的本质是「按组分列对比」，先在上面的「变量对应」里指一下分组列。",
    empty: ["还没有基线表", "点上方的「开始」，按分组列出各组的人口学与临床特征，含组间检验与 SMD。"],
    tell: "用 `clinical-stats` 出 Table 1（含组间检验与 SMD），存成 `table1.csv`",
    prompt: "请用 `clinical-stats` 技能，按 {data} 出一张基线表 Table 1。{vars}\n\n"
      + "连续变量按分布选均值±SD 或中位数(IQR) 并注明用了哪个；分类变量给 n(%)。"
      + "给组间检验的 p 值（写清用的是什么检验）与标准化均数差 SMD。\n"
      + "**这份研究如果没有人口学基线协变量（诊断准确性 / 方法比对 / 纯实验室验证常常如此），"
      + "就直接告诉我「本研究无对应的基线数据，Table 1 不适用」，不要把检测值硬塞成基线表。**\n"
      // 模式条随点随跑（这是本壳的设计），所以技能里"体检没做完不许进 Table 1"那道闸在这里没有
      // 强制力。做成【软提醒】而不是硬闸：数据干净的人不该被拦住，但"每个 n(%) 都建在虚高分母上"
      // 这件事必须有人说出来 —— 同一个会话，模型知道体检跑没跑过。
      + "**如果本会话还没跑过数据体检，先用一句话提醒我**（重复 ID 没去、分类水平没归一时，"
      + "这张表的每个 n(%) 和每个组间 p 都是错的），然后照常把表出出来，别因此停下不做。\n"
      + "**标识列（ID / 住院号 / 编号）、原始日期列、自由文本列不要进表**——它们不是基线特征；"
      + "跳过了哪几列要告诉我。\n"
      + "存成 `table1.csv`。" },
  { id: "analyze", label: "统计分析", icon: "chart", mark: "【统计分析】", badge: "组间 / 生存 / ROC / 回归",
    // 同上，且 file 不收 .csv：结果表（stats_*.csv）是给下游用的，正文该显示 analysis.md。
    // 面板正文按 markdown 渲染，csv 落进来会被渲染成一坨逗号（表头和数据全糊在一行）。
    file: "^(analysis|sample_size).*\\.md$", out: "^(analysis|stats_|sample_size)[^/]*\\.(md|csv)$",
    empty: ["还没跑分析", "点上方的「开始」。要做哪些分析、用哪几列，在上面的「变量对应」里指一下。"],
    tell: "用 `data-analysis` 跑推断统计（组间比较 / 生存 / ROC / 回归 / 样本量），结果写成 `analysis.md` + `stats_*.csv`",
    prompt: "请用 `data-analysis` 技能对 {data} 做统计分析。{vars}\n\n"
      + "**每一步都要写清用了什么方法、为什么选它、前提是否满足**（正态性 / 方差齐性 / 比例风险假定 / 共线性…）；"
      + "前提不满足就换稳健方法并说明。报结果时给**效应量与 95%CI**，不要只给一个 p 值。\n"
      + "多重比较要校正并说明用了哪种校正。\n"
      + "**不许编数字**：算不出来的、数据不支持的，直接说算不出来和缺什么。\n"
      + "**如果本会话还没跑过数据体检，先用一句话提醒我**（重复 ID / 分类水平不一致会让下面每个 p 都是错的），"
      + "然后照常把分析做完。\n"
      + "**我要做的分析缺关键列时（生存分析缺随访时间或终点事件、ROC 缺待评价指标或金标准），"
      + "先告诉我缺哪一列、表里有哪几列可选，别自己挑一列凑上去算。**\n"
      + "结果写成 `analysis.md`（含方法与解读）+ `stats_*.csv`（可复用的结果表）。" },
  { id: "figure", label: "出版级图", icon: "image", mark: "【出版级图】", badge: "300dpi + 矢量",
    file: null, out: "(^|/)(fig[^/]*|figures/.*)\\.(png|pdf|svg)$",
    empty: ["还没出图", "点上方的「开始」，把结果画成可直接投稿的图（300dpi + 矢量）。"],
    tell: "用 `nature-figure` 出投稿级图（300dpi + 矢量），文件名用 `fig1.png` 这类约定名",
    prompt: "请用 `nature-figure` 技能，把上面的分析结果画成**可直接投稿**的图。{vars}\n\n"
      + "300dpi 位图 + 一份矢量（pdf/svg）；字号、线宽、配色按投稿规范；坐标轴与图例要有单位；"
      + "**中文标签注意别出豆腐块**（缺字体时换英文标签并告诉我）。\n"
      + "**图上的每一个数字都必须来自前面真实算出来的结果**，不许为了好看造点。\n"
      + "文件名用 `fig1.png` / `fig1.pdf` 这类约定名，并告诉我每张图画的是什么。" },
  { id: "integrity", label: "源数据自查", icon: "shield", mark: "【源数据完整性自查】", badge: "只出待核信号",
    file: "^integrity_report.*\\.md$", out: "^(integrity_report[^/]*\\.md|audit/.*)$",
    empty: ["还没自查", "投稿前可以点这里，对源数据做一遍数值 sanity check——目的是主动发现要补说明的地方，不是指控谁。"],
    tell: "用 `data-integrity` 对源数据做数值完整性自查（signal not verdict），报告写成 `integrity_report.md`",
    prompt: "请用 `data-integrity` 技能，对 {data} 做一遍**投稿前的数值完整性自查**。\n\n"
      + "查：复制粘贴错误、整列常数偏移、跨表重复使用同一段数据、均值/SD 与样本量不自洽（GRIM / GRIMMER）、"
      + "小数位与有效数字异常、末位数字分布异常。\n"
      + "**铁律：只出「待核信号」，不下「造假」结论**（signal not verdict）。每条写清：在哪一格 / 哪一列、"
      + "为什么值得核、**最可能的良性解释是什么**、该去核哪份原始记录。\n"
      + "报告写成 `integrity_report.md`。" },
])

// ---- 各模块工作流 ----
export const WORKFLOWS = {

  // ============ SCI 论文（样板：最复杂的一条，12 步）============
  paper: {
    primary: "write-paper",
    intakeTitle: "立项确认",
    intake: [
      // ---- 起点分叉（2026-08-11 加）：从零成稿 vs 打磨已有初稿 ----
      // 【为什么要分】手里已有初稿的用户以前也被按"从零"那条线带着走，填完一屏表单得到的
      // 第一步却是"帮你从头成稿"。裁剪机制现成（when / requiredWhen），分叉只是表单 + 条件。
      // 不设 default：这一下选择正是本字段存在的意义，替用户预选等于没问。
      // 跳过表单直接打字时 entry 为 undefined → 各处 ne/eq 条件按"未填"求值 → 走完整流程，fail-safe。
      // 选项文案与 grant 同款走短标签；help 一并砍掉（"看着密密麻麻全是字"），行为即说明。
      { id: "entry", label: "从哪里开始", type: "select", required: true, chips: true, seg: true, col2: true,
        options: [
          { v: "scratch", t: "从零成稿" },
          { v: "draft", t: "打磨已有初稿" }],
        errMsg: "请先选从哪里开始" },
      // ★ 必填只对从零路线：打磨已有初稿时这些信息稿子里多半都有，逼用户重填一遍毫无意义
      //   （requiredWhen ne:"draft" —— 跳过表单 entry 为 undefined 时仍按必填算，方向 fail-safe）。
      { id: "studyType", label: "研究类型", type: "select", requiredWhen: { field: "entry", ne: "draft" }, options: [
        { v: "retrospective", t: "回顾性队列" }, { v: "prospective", t: "前瞻性队列" },
        { v: "rct", t: "随机对照试验（RCT）" }, { v: "diagnostic", t: "诊断准确性研究" },
        { v: "casecontrol", t: "病例对照" }, { v: "crosssection", t: "横断面" },
        { v: "caseseries", t: "病例系列 / 个案" }, { v: "basic", t: "体外 / 动物实验" }],
        help: "决定流程走法：前瞻性 / RCT 会先锁定假设；诊断准确性研究无人口学基线，会跳过 Table 1。" },
      { id: "articleType", label: "稿件类型", type: "select", default: "original", options: [
        // 加中文：临床医生未必都对得上这几个英文体裁名（评审反馈）
        { v: "original", t: "原著（Original Article）" }, { v: "brief", t: "简报（Brief Report）" },
        { v: "case", t: "个案报道（Case Report）" }, { v: "letter", t: "通讯（Letter）" }] },
      { id: "topic", label: "研究主题一句话", type: "textarea", requiredWhen: { field: "entry", ne: "draft" },
        placeholder: "例：术前中性粒细胞/淋巴细胞比值对胃癌根治术后 3 年生存的预测价值" },
      { id: "materials", label: "已有材料", type: "multi", options: [
        { v: "rawdata", t: "原始数据表（xlsx/csv）" }, { v: "draft", t: "已有初稿" },
        { v: "figures", t: "已有图表" }, { v: "ethics", t: "伦理批件号" },
        { v: "registry", t: "临床试验注册号" }, { v: "refs", t: "参考文献库（bib/Zotero）" }],
        help: "没有的不用勾，缺的会在对应步骤问你要，绝不替你编。" },
      { id: "dataFiles", label: "原始数据表", type: "files", when: { field: "materials", has: "rawdata" },
        uploadText: "上传数据表", accept: ".xlsx / .csv",
        help: "从「上传数据」里挑。没上传的先去左侧上传。" },
      // ★ help 的方向以前是【反的】，而且反向不安全：写的是"选「是」会先脱敏再分析"，
      //   而实际逻辑是 deidDone=true → 把脱敏步【剔掉】。一个手里拿着带姓名住院号原始表的医生，
      //   照字面意思勾「是」，得到的是【跳过脱敏、PHI 直接进统计】——正好是这道闸要防的事。
      //   默认「否」（fail-safe）本身是对的，坏的只有这句文案。
      { id: "deidDone", label: "这份数据已经脱敏过了", type: "bool", default: false,
        when: { field: "materials", has: "rawdata" },
        help: "勾「是」= 这份表你已经处理过（姓名/住院号/身份证/电话都去掉了），会【跳过脱敏步】直接分析；"
            + "没处理过就留「否」，系统先脱敏再统计。拿不准就留「否」——未脱敏的患者数据不得进入统计。" },
      // 「打磨已有初稿」路线没有稿子就无从打磨 —— 该路线下必显示、必填；从零路线维持原条件
      { id: "draftFiles", label: "已有的初稿 / 图表 / 文献库文件", type: "files",
        uploadText: "上传初稿 / 图表 / 文献库", accept: ".docx / .pdf / 图片 / .bib",
        whenAny: [{ field: "entry", eq: "draft" }, { field: "materials", has: "draft" }, { field: "materials", has: "figures" }, { field: "materials", has: "refs" }],
        requiredWhen: { field: "entry", eq: "draft" },
        help: "上面勾了已有初稿 / 图表 / 文献库的，把对应文件传上来。",
        errMsg: "「打磨已有初稿」路线要先把初稿传上来" },
      { id: "ethicsNo", label: "伦理批件号", type: "text", when: { field: "materials", has: "ethics" },
        placeholder: "原样填写，没有就留空（会标『待补充』，不会编造）" },
      { id: "registryNo", label: "临床试验注册号", type: "text", when: { field: "materials", has: "registry" },
        placeholder: "如 NCT01234567 / ChiCTR2400000000；没有就留空（会标『待补充』，不会编造）" },
      { id: "journalName", label: "已经想好具体期刊", type: "text",
        placeholder: "填了就按该刊稿约排版；留空则用通用送审格式" },
      ...JOURNAL_FILTER,
      LANG,
    ],
    steps: [
      { id: "deid", name: "数据脱敏", skill: "deidentify",
        // ★ deps：本步【直接消费谁的产物】（step id 列表）。staleUp 只沿这条真实依赖链判"过期"，
        //   不按数组下标 —— 并行分支（基线表 vs 统计分析、作图 vs 综述）互不消费对方产物，
        //   按下标比会把"后一轮重跑了统计"连坐成"基线表已过期"（模拟用户测试抓到的 Major）。
        //   规矩：凡是有 steps 的模块【每一步都要显式标 deps】（根步骤标 []）——留空不标会退回
        //   "所有在前步骤都算上游"的旧行为，而 first/when 会重排、裁剪步骤，下标顺序靠不住。
        deps: [],
        // ★ 用 truthy:false 而不是 eq:false —— 它同时覆盖 undefined。
        //   用户没碰过"已脱敏"这个开关时值是 undefined，若写 eq:false 就判不成立、脱敏步被整个剔掉，
        //   而这恰恰是最该插脱敏的情形（含患者信息且未声明脱敏）。方向必须 fail-safe：
        //   没明说脱敏过 = 当作没脱敏（AGENTS.md §五 硬规矩）。
        when: [{ field: "materials", has: "rawdata" }, { field: "deidDone", truthy: false }],
        // ⚠️ 不要写成 deid_*.csv：那会把 deid_*_mapping.csv（真实姓名/住院号 ↔ 假名的【还原表】）
        //    也当成本步产物渲染成卡片并可一键下载，而会话目录整包分享时它跟着走。
        //    还原表照常留在磁盘上供用户自己取，但不进产物契约、不主动推给他。
        emits: ["deid_report.md"], render: "report",
        hint: "含患者信息的数据未脱敏不得进入统计" },
      { id: "stats", name: "数据体检与统计分析", skill: "data-analysis",
        deps: ["deid"],
        when: { field: "materials", has: "rawdata" },
        form: [
          { id: "analyses", label: "要做的分析", type: "multi", options: [
            { v: "desc", t: "描述性统计" }, { v: "compare", t: "组间比较" },
            { v: "corr", t: "相关 / 回归" }, { v: "survival", t: "生存分析（KM / Cox）" },
            { v: "roc", t: "ROC / 诊断效能" }, { v: "agreement", t: "方法比对（Bland-Altman / Passing-Bablok）" },
            { v: "repeated", t: "重复测量 / 纵向" }] },
          { id: "groupCol", label: "分组列", type: "columns", source: "dataFiles",
            help: "区分组别的那一列，如 治疗组/对照组、手术方式。" },
          { id: "outcomeCol", label: "结局列", type: "columns", source: "dataFiles",
            requiredWhen: { field: "analyses", hasOther: ["desc"] },
            help: "你要解释或预测的那个结果，如 是否复发、住院天数。" },
          // 生存分析缺了这两列就根本算不出来 —— 必填，别让用户提交一个注定失败的请求
          { id: "timeCol", label: "随访时间列（生存分析用）", type: "columns", source: "dataFiles",
            when: { field: "analyses", has: "survival" }, required: true,
            help: "从起点到终点事件或末次随访的时长。" },
          { id: "eventCol", label: "终点事件列（生存分析用）", type: "columns", source: "dataFiles",
            when: { field: "analyses", has: "survival" }, required: true,
            help: "1 = 事件发生，0 = 删失。" },
          { id: "covars", label: "需要校正的协变量", type: "columns", source: "dataFiles", multiple: true,
            help: "多因素分析里要一并放进模型的因素，如 年龄、性别、分期。" },
        ],
        emits: ["data_profile.md", "cleaning_log.md", "stats_*.csv", "*_results.csv"], render: "table" },
      { id: "table1", name: "基线表 Table 1", skill: "clinical-stats",
        // 与 stats 并行：都只吃（脱敏后的）原始数据，互不消费对方产物 —— 所以 deps 是 deid 不是 stats
        deps: ["deid"],
        // AGENTS.md §三 表下注：诊断准确性 / 方法比对 / 纯实验室验证类研究常无人口学基线协变量，
        // 此时 Table 1 无对应数据，整步跳过，别把检测值硬塞成"基线表"制造误导。
        when: [{ field: "materials", has: "rawdata" }, { field: "studyType", in: ["retrospective", "prospective", "rct", "casecontrol", "crosssection"] }],
        emits: ["table1.csv"], render: "table" },
      // gateBy:"signals" / failLabel 的理由见 refcheck 模块同名步骤的长注释：data-integrity 被铁律
      // 禁止写裁定语，通用判据（server.mjs 的 GATE_FAIL_*）永远命中不了，不写 gateBy 这道闸恒绿。
      // 三处 data-integrity 步骤必须一起带上，此前只有 refcheck 有 —— stats 与本步都漏了。
      { id: "integrity", name: "源数据完整性自查", skill: "data-integrity", optional: true, gate: true,
        deps: ["deid"],
        gateBy: "signals", failLabel: "有待核信号",
        when: { field: "materials", has: "rawdata" },
        emits: ["integrity_report.md", "audit/*"], render: "integrity", onFail: "stats",
        hint: "投稿前主动核对补说明，只出待核信号、不下造假结论" },
      // ★ 2026-08-11：故事线锻打（idea-forge，可选）插在图表之前，novelty 格随之上移与它相邻 ——
      //   编排是「锻打先行、裁定押后」（理由见 AGENTS.md §三 表下注），且图该画哪几张本来就该由
      //   定稿的故事线决定（design_brief 里带图表清单）。三种情况才做：没想好讲什么故事 / 投哪、
      //   核心主张明显 overclaim、用户主动要求被拷问；无人值守（AUTO）时整步跳过（optional，不卡条）。
      { id: "forge", name: "故事线锻打", skill: "idea-forge", optional: true,
        deps: ["stats"],
        sub: "对话锻定主张梯度 / 目标刊 / 故事线",
        emits: ["design_brief.md"], render: "report",
        hint: "主张压到数据撑得住的级别、定目标刊三梯队；产出 design_brief.md，作图 / 综述 / 成文照单干" },
      { id: "novelty", name: "新颖性裁定 / 预注册", skill: "novelty-check",
        deps: ["forge"],
        // 回顾性研究里这步可选（已有数据，无法再"采数前预注册"）；前瞻性 / RCT 里它是【必做】的
        // 预注册锁 —— 既然把它提到了最前，就不能同时标"可选"，那等于说这步可以跳。
        optionalUnless: { field: "studyType", in: ["prospective", "rct"] },
        // 前瞻性与 RCT：必须在采数前把假设与主分析计划冻住 → 提到最前；回顾性研究已有数据，
        // 无法再"采数前预注册"，这步降级为可选的新颖性裁定（AGENTS.md §三 表下注），
        // 且做了故事线锻打的，对 design_brief 定稿的主张裁定（锻打在前、裁定在后）。
        first: { field: "studyType", in: ["prospective", "rct"] },
        emits: ["novelty_report.md", "novelty_*.md", "preregistration.md", "analysis_plan.md"], render: "report" },
      { id: "figure", name: "出版级图表", skill: "nature-figure",
        deps: ["stats", "forge"],
        form: [
          { id: "figTypes", label: "要出的图", type: "multi", options: [
            { v: "forest", t: "森林图" }, { v: "km", t: "生存曲线 KM" }, { v: "volcano", t: "火山图" },
            { v: "roc", t: "ROC 曲线" }, { v: "bar", t: "柱状 / 箱线" }, { v: "flow", t: "流程图" }] },
          { id: "figDpi", label: "分辨率", type: "select", default: "300", options: [
            { v: "300", t: "300 dpi（多数期刊最低要求）" }, { v: "600", t: "600 dpi（线条图）" }] },
        ],
        emits: ["fig*.png", "fig*.pdf", "fig*.svg", "figures/*"], render: "figure" },
      { id: "litreview", name: "文献综述", skill: "literature-review",
        // 综述吃的是检索与（可选的）故事线，与统计/作图无依赖 —— 后一轮补张图不许把它标过期
        deps: ["forge"],
        // 打磨已有初稿时，引言与讨论的文献底子多半已经在稿里 —— 综述降级为可选的补强步。
        // （综述单薄仍是回退触发点：refcheck / review 发现引用撑不住主张时照样回来补做。）
        optionalUnless: { field: "entry", ne: "draft" },
        form: [
          { id: "query", label: "检索式 / 关键词", type: "textarea",
            placeholder: "留空则由 AI 依据研究主题自拟检索式" },
          { id: "years", label: "时间范围", type: "select", default: "10", options: [
            { v: "5", t: "近 5 年" }, { v: "10", t: "近 10 年" }, { v: "0", t: "不限" }] },
          // 【2026-08-08 删了 limit】原来这里有个「最多检索多少篇」（默认 40）。写综述没有理由
          // 给召回设上限——上限只会让"这个方向到底有多少文献"这个问题得到一个由输入框决定的假答案。
          // 检索脚本现在默认不限条数（命中多少取多少），要收窄就收窄检索式，不靠这个数字。
        ],
        emits: ["evidence_table.csv", "evidence.md", "refs.bib"], render: "evidence",
        hint: "引言与讨论的文献部分基于本步综述撰写；综述单薄是回退触发点" },
      { id: "write", name: "撰写正文", skill: "write-paper",
        deps: ["stats", "table1", "figure", "litreview", "forge", "novelty"],
        form: [{ id: "sections", label: "要写的章节", type: "multi",
          default: ["title", "abstract", "intro", "methods", "results", "discussion"],
          options: [{ v: "title", t: "标题" }, { v: "abstract", t: "摘要" }, { v: "intro", t: "引言" },
            { v: "methods", t: "方法" }, { v: "results", t: "结果" }, { v: "discussion", t: "讨论" },
            { v: "limitations", t: "局限性" }, { v: "cover", t: "投稿信 Cover Letter" }] }],
        // ★ emitsNot：`manuscript_*.md` 会把润色步的产物 manuscript_humanized.md 一起收走
        //   （globMatch 对不含 / 的 glob 按 basename 比，躲不开）。实测后果：用户自带初稿、
        //   只想润色，产物只有 manuscript_humanized.md —— AI 一个字没写，「撰写正文 ✓已完成」。
        emits: ["manuscript.md", "manuscript_*.md"], emitsNot: ["*_humanized.*"], render: "manuscript",
        note: "用户从「打磨已有初稿」进来时（任务卡里「从哪里开始＝打磨已有初稿」并附了初稿文件），这一步是**以他的初稿为底本逐节补强改写**：先通读初稿，站得住的结构与内容尽量保留，缺的章节才新写，数字与结论一律以本会话统计结果为准逐处核对；改了什么要能对得回原稿（交付时给一份按章节的改动说明），**不许把初稿扔掉另起炉灶重写**。从零路线照常基于综述与统计结果成文，本条不适用。" },
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        deps: ["write"],
        emits: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"],
        // 裁定只认 md 报告：csv 是机器结果表（不进措辞判定），单列出来是让"csv 先落盘、md 未写出"
        // 的窗口里闸停在未开始等报告，而不是拿一份读不了的文件谈通过（emits 照收 csv 供渲染与判完成）。
        gateReport: ["refcheck_report.md", "reference_check*.md"],
        render: "refcheck", onFail: "write",
        hint: "查假引用 / 核 DOI，全绿才往下排版" },
      { id: "humanize", name: "语言润色", skill: "humanize-academic",
        deps: ["write"],
        form: [
          { id: "strength", label: "润色强度", type: "select", default: "standard", options: [
            { v: "light", t: "保守（只动明显 AI 腔）" }, { v: "standard", t: "标准（推荐）" },
            { v: "heavy", t: "激进（重写句式节奏）" }] },
          { id: "protectRefs", label: "保持引用处的文字原样不动", type: "bool", default: true,
            help: "默认保持。关掉的话，润色后会自动把引用重新核一遍兜底。" },
        ],
        emits: ["manuscript_humanized.md", "*_humanized.md"], render: "diff",
        // 与 review 模块同款：markdown 稿必须另存 _humanized 副本，就地改原稿会让这一步"做了不亮"
        hint: "润色稿必须另存「原名_humanized.md」（如 manuscript_humanized.md），不要就地改原稿" },
      { id: "review", name: "投稿前自审", skill: "peer-review", gate: true,
        deps: ["write", "humanize"],
        form: [{ id: "roles", label: "审稿视角", type: "multi",
          default: ["method", "stats"], options: [
            { v: "method", t: "方法学审稿人" }, { v: "stats", t: "统计审稿人" },
            { v: "clinical", t: "临床审稿人" }, { v: "editor", t: "编辑（是否送审）" }] }],
        // ★ 通配而不是精确名。模型第二轮返工常换名写 review_report_v2.md，精确名一条 glob 都不匹配
        //   → 新报告既不进 done 判定、也不被 gateFailed 读到，第一轮那份红报告永远说了算：
        //   闸永久红、重跑不管用，唯一出路是「仍要出件」。带上通配符它才落进 gateFailed 里
        //   「同一通配组只认最新那份」的逻辑。（不加 peer_review*.md：那会把"给审稿人的回复信"
        //   也读成裁定书。）
        emits: ["review_report*.md"], render: "review", onFail: "write",
        hint: "发现设计/统计/结果硬伤则回上游返工" },
      // ★ 两个渲染技能必须互认。这一格的输出格式由用户在 fmt 里选，选 PDF 时 agent 调的是
      //   render-pdf-doc（模块 extra 里放行了它）—— 不认的话 markStepBySkill / stepOfParts
      //   都找不到认领者：这一轮不开分组、进度条不动，最后产物把格子涂绿了却点不动
      //   （canJump 靠"这一步开过框没有"判定），整条流水线只有最后一格点了没反应。
      { id: "render", name: "排版出件", skill: "render-docx", skillAlias: ["render-pdf-doc"],
        deps: ["write", "humanize"],
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        // ★ *_humanized：render_docx.sh 不带 -o 时输出=输入名换后缀，润色稿走 *_humanized.md 契约
        //   （humanize 步的通配允许非 manuscript 前缀），排出来的 <名>_humanized.docx 不收的话
        //   这一格永远灰（2026-08-13 综述模块同类缺口实测，见 wf-state.test.mjs 出件契约组）。
        emits: ["manuscript*.docx", "manuscript*.pdf", "*_humanized.docx", "*_humanized.pdf"], render: "doc",
        hint: "没指定期刊就用通用送审格式，交付时附查重工具推荐" },
    ],
    // mechanism-figure：论文常要一张图形摘要 / 机制示意图，它不是流程里的固定步骤（可选配图），
    // 但不放进白名单的话，用户在本模块里一提"画个机制图"就会被技能闸中止本轮。
    extra: ["search-lit", "fulltext-retrieval", "render-pdf-doc", "mechanism-figure"],
  },

  // ============ 综述撰写（叙述性）============
  review: {
    primary: "literature-review",
    intakeTitle: "选题与检索范围",
    // ★ 体裁声明必须在【首屏第一眼】就说，不能只放在卡片底部的脚注里 —— 本模块用的
    //   「纳入的研究设计」「PICO」这些全是系统综述的标配语汇，医生会理所当然以为这里能做 Meta，
    //   填完一整屏才发现没有 PRISMA / 双人筛选 / 偏倚风险，那时已经白填了。
    notice: "本模块做的是**叙述性综述**（传统文献综述）。不做双人独立筛选、PRISMA 流程图、偏倚风险评估与 Meta 合并 —— 要那些请回工作台选「自由对话」，在那里说明你要做系统综述 / Meta 分析。",
    // ⚠️ 这一行会显示在表单底部：系统综述不属于任何模块，必须给用户指路，别成哑失败。
    footnote: "需要双人独立筛选 / PRISMA 流程图 / 偏倚风险 RoB / GRADE 这类方法学强度的**系统综述或 Meta 分析**，请到「自由对话」模块 —— 本模块做的是叙述性综述。\n"
      + "检索源为 Europe PMC / PubMed / Crossref，**不含 CNKI / 万方 / 维普**：中文期刊文献基本检索不到。投中文核心期刊时，中文参考文献需要你自己补充（或让我从你本机的 Zotero 文献库里取）。",
    intake: [
      { id: "topic", label: "综述主题", type: "textarea", required: true,
        placeholder: "例：PD-1 抑制剂在肝细胞癌一线治疗中的进展与争议" },
      { id: "pico", label: "研究问题的四要素（填了检索会精准很多）", type: "textarea",
        placeholder: "人群：晚期肝细胞癌初治患者　干预：PD-1 抑制剂联合靶向　对照：单药靶向　结局：总生存期",
        help: "不确定就留空，照样能检索。" },
      // 标签写全称「参考文献时间范围」：孤零零一个"时间范围"在综述语境里有歧义
      // （医生会读成"综述要覆盖的研究年代"），而它实际管的是【检索这批参考文献】的发表年限。
      // 默认收到近 3 年：综述的常态是"讲这个方向最近的进展"，近 10 年会把一堆已被推翻的旧结论
      // 拉进池子，用户再一篇篇剔。要回溯经典文献的选「近 10 年 / 不限」即可。
      { id: "years", label: "参考文献时间范围", type: "select", default: "3", options: [
        { v: "3", t: "近 3 年" }, { v: "5", t: "近 5 年" }, { v: "10", t: "近 10 年" }, { v: "0", t: "不限" }] },
      { id: "designs", label: "纳入的研究设计", type: "multi", options: [
        { v: "rct", t: "随机对照试验" }, { v: "cohort", t: "队列研究" }, { v: "casecontrol", t: "病例对照" },
        { v: "crosssection", t: "横断面" }, { v: "review", t: "综述 / 指南" }, { v: "basic", t: "基础研究" }] },
      // 【2026-08-08 删了 limit】同 paper 模块：综述的召回不设条数上限（见 JOURNAL_FILTER 上方说明）。
      // 收窄范围靠时间范围 / 研究设计 / 下面这组期刊条件，不靠"最多多少篇"这个数字。
      ...JOURNAL_FILTER,
      // 【2026-08-11 从三档下拉改成自由输入】篇幅是投稿方/导师给死的数字（"不超过 5000 字"
      // "3500 字左右"），三个档位覆盖不了；用户以前只能挑一个最接近的，再在对话里补一句改口。
      // 直接给输入框，min/max 只兜住明显填错的量级（脚本 nCheck 会就地提示，不拦提交）。
      { id: "length", label: "目标篇幅", type: "number", default: 4000, unit: "字",
        section: "成稿与输出", min: 800, max: 30000, step: 100, placeholder: "例如：4000",
        help: "常见量级：2000 字（短综述）· 4000 字（推荐）· 8000 字（长篇）。留空则由 AI 按主题体量自定。" },
      LANG,
    ],
    steps: [
      { id: "search", name: "文献检索", skill: "search-lit",
        // ★ literature-review 也算这一步：本模块的检索实际跑的是
        //   `literature-review/search.py`，模型加载的技能名就叫 literature-review。
        //   不写这条别名，「正在做哪一步」的推断会把检索期算成后面那格「综述成文」——
        //   2026-08-21 复测实测：开跑头 20 分钟条子一直指着"综述成文"，而实际在检索。
        //   （多格共用一个技能名由 wf-state 的 stepForSkill 按"最早未完成"消歧。）
        // ★ 用 liveAlias 而不是 skillAlias：skillAlias 是【正式绑定】，同时喂着"按技能补记
        //   完成"（wfAttribute）与"历史消息按技能分组"（stepOfParts）——把 literature-review
        //   正式绑到检索步，会让"跑了 literature-review 就算检索做完了"这类推断跟着变，
        //   而那两处的语义本来是对的（成文才是 literature-review 的正主）。
        //   liveAlias 只被"现在正在做哪一步"的实时推断读，其余一概不看。
        liveAlias: ["literature-review"],
        deps: [],
        emits: ["evidence_table.csv", "evidence.md", "refs.bib"], render: "evidence",
        // ★ 这两句都是实测欠账（2026-08-21）：① 用户勾的「研究设计」「时间范围」没被带进检索式，
        //   106 篇里 RCT 只有 8 篇、19 篇越界，用户会认为这两个表单项是摆设；
        //   ② 检索源不含中文数据库，而用户明说投中文核心，全程没人告诉他这件事。
        hint: "每条引用都经 API 核实，不凭记忆造引用；首屏勾的研究设计与时间范围必须落进检索式"
            + "（literature-review/search.py 的 --design / --since）；本检索源不含 CNKI/万方，"
            + "投中文期刊时要当面告诉用户中文文献需自行补充" },
      // 【2026-08-08 删了「纳入 / 排除筛选」这一步】它做的是系统综述那套双人筛选的形，
      //   而本模块明写了不做系统综述（见上面的 notice/footnote）。实际跑起来的样子是：
      //   agent 一路把综述写完了，这一步的表单才在回复末尾弹出来让用户勾"排除哪几篇"——
      //   稿子都成文了，勾了也没有意义（那张卡是"下一步未完成的带表单步骤"才给的，见
      //   index.html 的 offerStepForm）。叙述性综述的取舍本来就在 write 那步由检索范围
      //   （时间 / 研究设计 / 期刊条件）与成文时的论证决定，不必再让用户逐篇点一遍。
      // 【2026-08-11 删了「全文获取」这一步】它挂在首屏那个「尝试下载开放获取全文」勾选上，
      //   而那一项已随本次改动去掉 —— 条件永远不成立，留着就是一个永不点亮的灰格子。
      //   叙述性综述靠检索得到的题录 + 摘要成文；确实要原文 PDF 的，去「文献研读」模块。
      { id: "write", name: "综述成文", skill: "literature-review",
        deps: ["search"],
        emits: ["review.md", "literature_review.md", "*_review.md"], render: "manuscript" },
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        deps: ["write"],
        emits: ["refcheck_report.md", "reference_check*.md"], render: "refcheck", onFail: "write" },
      { id: "humanize", name: "语言润色", skill: "humanize-academic", optional: true,
        deps: ["write"],
        // ★ hint 会随任务卡发给模型。写死这句是因为实测（2026-08-21 综述模块打包版）模型
        //   把 review.md【就地】改了、没留 `_humanized` 副本 —— 这一步于是"做了不亮"，
        //   用户以为跳过了润色，会要求重跑一遍白花钱。契约与技能文档本来就写的是另存。
        emits: ["*_humanized.md"], render: "diff",
        hint: "润色稿必须另存「原名_humanized.md」（如 review_humanized.md），不要就地改原稿" },
      // 同上：fmt 默认就是 docx，走 render-docx 的次数比 pdf 还多，两个都要认（见 paper 那格的说明）
      { id: "render", name: "排版出件", skill: "render-pdf-doc", skillAlias: ["render-docx"],
        deps: ["write", "humanize"],
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        // ★ emitsNot：review*.docx 会把【评审/核查报告转的 docx】也收走（review_report.docx、
        //   refcheck_report.docx），agent 顺手把报告排成 Word 给用户看，「排版出件」就凭空绿了 ——
        //   而真正的综述成稿一个字还没排。终稿在（review.docx / manuscript.docx），报告不算。
        // ★ 通配要覆盖【成文步契约的全部命名系】换后缀的结果：render_docx.sh 不带 -o 时输出=
        //   输入名换后缀，成文步允许 literature_review.md / *_review.md、润色步允许 *_humanized.md，
        //   于是 literature_review.docx / PD1_review.docx / literature_review_humanized.docx 都是
        //   合规出件 —— 原来只收 review* 开头，这些全灰、前端当前步永远钉在「排版出件」
        //   （2026-08-13 模拟实测：单轮全流程 + literature_review 命名 = 全部做完条子说还没出件）。
        //   *_review.docx 不会误收报告：review_report / refcheck_report 都不以 _review 结尾，
        //   emitsNot 再兜一层。
        emits: ["manuscript*.docx", "manuscript*.pdf", "review*.docx", "review*.pdf", "proposal*.docx", "proposal*.pdf",
          "literature_review*.docx", "literature_review*.pdf", "*_review.docx", "*_review.pdf",
          "*_humanized.docx", "*_humanized.pdf"],
        emitsNot: ["review_report*", "refcheck_report*"], render: "doc" },
    ],
    extra: ["render-docx"],
  },

  // ============ 基金申报 ============
  grant: {
    primary: "grant-proposal",
    intakeTitle: "基础信息录入",
    intakeSub: "填写申报类别、研究问题与撰写要求",
    // ★ 本表按设计稿「基金申报页面_单列流程版.html」重排：三张区块卡（项目基本信息 / 申请人信息 /
    //   撰写要求与工作基础），字段两列。section / sectionSub / sectionIcon 三项只影响前端画法。
    intake: [
      // ---- 区块 0：从哪里开始（2026-08-11 加）：从零选题 vs 打磨已有 idea ----
      // 已有大致想法的申请人以前只能陪跑「方向调研 → 选题细化」两步 —— 那两步的产出他早有了，
      // 整个模块读起来就是"从零开始"。选「打磨已有 idea」= 这两步整格裁掉，流程从「立意锻打」
      // 起步，锻打对象就是下面那段设想。不设 default（替用户预选等于没问）；跳过表单直接打字时
      // entry 为 undefined → scan/topic 的 ne 条件成立 → 走完整流程，fail-safe。
      // 2026-08-11 按用户要求砍掉了本组的 help 与 sectionSub（"看着密密麻麻全是字"）：
      // 选「打磨立意」会当场弹出设想输入框、流程条前两格变灰，行为本身就是说明。
      // seg：两个选项画成等宽大按钮占满整行（index.html 的 .wfseg），比两粒小 chip 醒目。
      // first: {} —— 恒真，把本组钉在最顶上（「打磨已有」路线会把「撰写要求与工作基础」
      // 整块提前，见那三个字段的 first；不钉住的话本组会被挤下去）。
      { id: "entry", label: "从哪里开始", type: "select", required: true, chips: true, seg: true, col2: true,
        section: "从哪里开始", sectionIcon: "lines", first: {},
        options: [
          { v: "scratch", t: "定选题" },
          { v: "idea", t: "打磨已有" }],
        errMsg: "请先选从哪里开始" },
      { id: "ideaDesc", label: "你的研究设想", type: "textarea", first: {},
        when: { field: "entry", eq: "idea" }, requiredWhen: { field: "entry", eq: "idea" },
        placeholder: "例：想用本院 XX 队列做 XX 对 XX 结局的预测；预实验发现 XX……科学问题 / 假设 / 打算怎么做，写到哪算哪",
        errMsg: "「打磨已有」路线要先把你的设想写几句" },

      // ---- 区块 1：项目基本信息 ----
      // ★★ 这一项【直接决定成稿对不对】，所以选项必须覆盖 grant-proposal 有内置要求卡的渠道。
      //   技能第 1 步就是"定渠道 → Read 对应要求卡"，结构提纲、逐节字数硬限、格式规定、
      //   形式审查清单全部按卡对齐（SKILL.md 开头原话）；渠道选错 = 加载错的卡 = 整篇作废。
      //   references/ 下现有 17 张卡，其中省卫健委、院级、博士后、学会临床都是【只有卡、
      //   界面上却没有入口】—— 那些用户只能挑一个最像的，等于系统亲手给他配错模板。
      //   「其它」+ 自由填写也必须留着：它触发技能的第 1.5 步（先问官方文件、再联网调研出
      //   要求卡，不凭常识硬写），是表外渠道唯一正确的出口。
      // chips:true —— 11 个选项本会掉进原生下拉，而这是全表最要紧的一项，收起来等于把
      //   "有哪些渠道可选"藏了。摊开占两行，值这个地方。
      // ★ 2026-08-11「打磨已有」路线（entry=idea）下，本区块的每一项都转选填
      //   （requiredWhen ne:"idea"）——已有材料里多半都写着这些；缺的会标"待补充"问用户要。
      //   entry 未填（跳过表单）时 ne 条件成立 → 仍按必填算，方向 fail-safe。
      //   （「申请人信息」那一块 2026-08-19 起【无论哪条路线都全选填】，不再受 entry 影响。）
      // dropdown：2026-08-11 按用户要求从摊开的 chips 改回原生下拉（11 个选项占两行太吵）。
      { id: "funder", label: "申请类型", type: "select", requiredWhen: { field: "entry", ne: "idea" }, dropdown: true, col2: false,
        section: "项目基本信息", sectionIcon: "lines",
        options: [
          { v: "nsfc-general", t: "国家自然科学基金·面上项目" }, { v: "nsfc-young", t: "青年科学基金" },
          { v: "nsfc-region", t: "地区科学基金" }, { v: "nsfc-key", t: "重点项目" },
          { v: "provincial", t: "省自然科学基金" }, { v: "health-commission", t: "省 / 市卫健委课题" },
          { v: "hospital", t: "院级 / 校级课题" }, { v: "postdoc", t: "博士后基金" },
          { v: "society", t: "学会临床基金" }, { v: "industry", t: "企业横向合作" },
          { v: "other", t: "其它" }],
        // 2026-08-11 按用户要求删光了本表全部 help（"看着密密麻麻全是字"）。其中承载的硬约束
        // （渠道决定要求卡、选错整篇返工；邮箱电话 noCard 不进提示词……）都在代码注释与技能文档里，
        // 别因为界面上没字了就把机制也删了。
      },
      { id: "funderOther", label: "申请类型", type: "text", when: { field: "funder", eq: "other" },
        requiredWhen: { field: "entry", ne: "idea" }, col2: true,
        placeholder: "例：中华医学会临床医学科研专项 / 某某市卫健委面上项目 / 国家重点研发计划某专项" },
      { id: "keywords", label: "项目关键字", type: "tags", requiredWhen: { field: "entry", ne: "idea" },
        placeholder: "输入后回车添加，如：单细胞测序、生物标志物",
        errMsg: "请至少添加一个项目关键字" },
      // ★ 研究问题（2026-08-18 加，定选题路线必填）：此前第一屏只收几个关键字、方向全靠 AI
      //   依据关键字初拟 —— 用户反馈"AI 推荐的课题 / 痛点 / 创新点都浮于表面"，根因就在这：
      //   选题的主体必须是用户自己带来的问题，AI 只负责结合调研到的文献给细节调整建议
      //   （收窄人群 / 换结局 / 改设计……）供他挑。哪怕只写一两句，也比关键字多出
      //   "他到底想解决什么"。「打磨已有」路线上被「你的研究设想」顶替，不显示。
      //   下游消费：scan 格以它为锚做调研（不自拟替代方向）、topic 格的候选=原样推进+细节
      //   调整变体（见那两格的 note）。空着（跳过表单直接打字）时两格退回旧行为，fail-safe。
      { id: "researchQ", label: "研究问题 / 想解决的痛点", type: "textarea",
        when: { field: "entry", ne: "idea" }, requiredWhen: { field: "entry", ne: "idea" },
        placeholder: "例：XX 人群的 XX 并发症缺乏早期预测手段，想基于本院队列建立并验证预测模型。写清你想解决什么问题 / 痛点，有初步假设也写上，一两句即可 —— AI 会结合文献帮你打磨细节，但不会替你另选课题",
        errMsg: "请把你的研究问题 / 痛点写上一两句 —— 选题以它为准，AI 只做细节调整建议" },
      { id: "discipline", label: "领域分类", type: "select", dropdown: true, options: [
        { v: "肿瘤学", t: "肿瘤学" }, { v: "免疫学", t: "免疫学" }, { v: "神经科学", t: "神经科学" },
        { v: "心血管", t: "心血管" }, { v: "代谢与内分泌", t: "代谢与内分泌" },
        { v: "感染与微生物", t: "感染与微生物" }, { v: "基础医学", t: "基础医学" },
        { v: "临床医学", t: "临床医学" }, { v: "预防医学", t: "预防医学" },
        { v: "药学", t: "药学" }, { v: "生物信息学", t: "生物信息学" }] },
      // ★ 申请代码单独留一格，别指望上面那个 11 项的粗分类顶替它。
      //   grant-proposal 的硬闸里有一条是「研究方向属该渠道受理范围（NSFC 代码分流）」，
      //   而 references/nsfc-medical-h.md 是一整张 H01–H35 代码表 + 分流规则 ——
      //   拿"肿瘤学"是判不了分流的，代码错会在形式审查阶段被打回。
      //   示范值必须用【2026 新码表】里真实存在的组合：H16 现在是急重症医学，消化系统是 H03，
      //   肿瘤一律 H18（旧表的"H16 肿瘤学"已失效）。示范值是最容易被照抄的东西，给错比不给更糟。
      { id: "applyCode", label: "申请代码 / 学部方向", type: "text", col2: false,
        placeholder: "例：H18 肿瘤学 / H03 消化系统" },
      { id: "amount", label: "申请金额（万元）", type: "number", requiredWhen: { field: "entry", ne: "idea" }, min: 0, step: 1,
        col2: false, placeholder: "例如：60",
        errMsg: "请填写有效的申请金额" },
      // 起止年【手填】，不用下拉：可选年份是随申报年度滚动的，写死成 2026/2027 这种候选表
      // 一到下一年就全错，而用户又没法选表外的年份（延续项目、跨年度周期都超出这几项）。
      // 仍给默认值：设计稿里这两格是预选好的，研究周期留空对标书没有任何意义。
      // 默认值写成【数字】而非字符串 —— number 控件回写的是 Number，写成 "2026" 的话用户原样
      // 重敲一遍 2026 就会和初始快照对不上，被判成"动过表单"，切走时白弹一次清空确认。
      { id: "yearStart", label: "研究起始年", type: "number", col2: false, default: 2026,
        min: 2000, max: 2100, step: 1, placeholder: "例如：2026" },
      { id: "yearEnd", label: "研究终止年", type: "number", col2: false, default: 2029,
        min: 2000, max: 2100, step: 1, placeholder: "例如：2029", gteField: "yearStart" },

      // ---- 区块 2：申请人信息（★ 2026-08-19 起【整块选填】）----
      // ⚠️ 姓名 / 单位会随任务卡交给模型（封面与研究基础一节要用），而【邮箱和电话它一个字都用不上】
      //   —— 标了 noCard，只留在本地表单里，不进提示词。个人联系方式没有任何理由送进模型上下文。
      // ★ 2026-08-19 按用户要求，本区块的每一项（姓名 / 职称身份 / 依托单位 / 邮箱 / 电话）
      //   全部转为选填：这些是【个人身份信息】，不该成为拿到稿子的硬门槛（前端缺必填不放行提交），
      //   而且缺了也不影响正文成稿 —— 封面、研究基础里用得上的部分照 §五 标"待补充"向用户要即可。
      //   注：职称 / 身份原本参与 topic-selection 第 3.5 步「按申请人类型分流可行路径」，
      //   现在留空时该步不分流、按通用路径给候选；想要分流建议照旧填一下。
      { id: "applicantName", label: "申请人姓名", type: "text", col2: false,
        section: "申请人信息", sectionIcon: "user",
        placeholder: "请输入真实姓名（选填）" },
      //   标签写「职称 / 身份」：在读研究生没有职称，只叫"职称"会让人不知道该选哪个。
      { id: "applicant", label: "职称 / 身份", type: "select", dropdown: true, col2: false,
        options: [
          { v: "student", t: "在读研究生" }, { v: "postdoc", t: "博士后" },
          { v: "lecturer", t: "主治医师 / 助理研究员" }, { v: "associate", t: "副研究员 / 副教授" },
          { v: "professor", t: "研究员 / 教授" }, { v: "other", t: "其他" }] },
      // col2:false —— 与联系邮箱同宽（2026-08-11 用户要求两者输入框长度一致）
      { id: "org", label: "依托单位", type: "text", col2: false,
        placeholder: "例如：某某大学附属医院（选填）" },
      // ★ 这两项此前就【不设必填】（标了 noCard、一个字都不进提示词，对成稿没有任何贡献），
      //   现在整块都跟它们一样了。
      { id: "email", label: "联系邮箱", type: "text", col2: false, noCard: true,
        placeholder: "name@hospital.com" },
      { id: "phone", label: "联系电话", type: "text", col2: false, noCard: true,
        placeholder: "11 位手机号" },

      // ---- 区块 3：撰写要求与工作基础（均选填）----
      // ★ 这一项在技能里是【优先级最高】的输入（grant-proposal SKILL.md 第 1.5 步①、第 2 步）：
      //   拿到当年官方文件就不必联网调研，且其结构提纲/字数硬限【压过】内置要求卡。
      //   省市级、卫健委、院级这些渠道的模板常年锁在申报平台内、网上根本查不到，只有申请人手里有。
      // ★「打磨已有」路线（entry=idea）下这一块整体提前成第一个区块（first，三个字段一起挪，
      //   区块继承才不断），且「已有工作基础」与「上传材料」二选一至少填一个：
      //   requiredWhen 互相盯着对方 —— 对方空着我就必填，对方填了我就转选填（truthy 已把
      //   空数组折算成"没填"，files 建卡补的 [] 不会误判成"已传"）。定选题路线维持全选填。
      { id: "reqDesc", label: "基金申请书撰写要求", type: "textarea",
        section: "撰写要求与工作基础", sectionIcon: "fileText",
        first: { field: "entry", eq: "idea" },
        placeholder: "例如：正文不超过 4000 字，需含立项依据、研究内容、研究方案、创新点、预期成果、研究基础；参考文献限 30 篇以内……" },
      { id: "baseDesc", label: "已有工作基础", type: "textarea",
        first: { field: "entry", eq: "idea" },
        requiredWhen: [{ field: "entry", eq: "idea" }, { field: "attachFiles", truthy: false }],
        errMsg: "「打磨已有」路线：已有工作基础与上传材料至少填一个",
        placeholder: "可填写已有工作基础，例如：代表作 / 已发表论文、预试验数据、平台 / 设备条件、已有样本库 / 队列等" },
      // divider：上传区前面加一条分隔线（设计稿 v3 在「上传参考资料」之前有一条 <hr>）——
      // 上面两项是"你自己写点什么"，这一项是"你交点什么给我"，两件事该断开
      { id: "attachFiles", label: "申请课题要求文件 / 代表作 / 预实验数据", type: "files", divider: true,
        first: { field: "entry", eq: "idea" },
        requiredWhen: [{ field: "entry", eq: "idea" }, { field: "baseDesc", truthy: false }],
        errMsg: "「打磨已有」路线：已有工作基础与上传材料至少填一个",
        uploadText: "上传材料", accept: ".pdf / .docx / .xlsx / .png，单个 ≤ 20MB" },
    ],
    steps: [
      // ★ 步骤名与 sub 按设计稿「基金申报页面_单列流程版.html」的六格流程改写。
      //   sub 是流程条上那行小字，只给界面用，不进给 agent 的流程线（那条线要的是步骤名与闸）。
      // ★ 第 0 格「标的确认」（2026-08-11 加）：标的要求决定后面每一步（文体家族/评审评价维/
      //   指南方向/经费档位），此前它藏在「标书初稿生成」里、快写正文才查——方向生成/选题/锻打
      //   全在没有标的约束下跑完。本格走 grant-proposal 的【定标模式】：用户没给文件就联网查
      //   当年申报通知，查到的候选编号列给用户确认，落 requirement_card.md 即停。
      //   同一技能占两格（本格与 write 都是 grant-proposal）——stepOfParts 按 seen 集取
      //   "还没用过的那一步"，与综述模块两格共用 literature-review 同一先例。
      { id: "intake", name: "标的确认", skill: "grant-proposal",
        sub: "查当年申报通知，确认按哪份要求写",
        emits: ["requirement_card.md"], render: "report",
        hint: "没给文件就联网查当年通知/指南，候选列给用户确认；确认后落 requirement_card.md，全流程照它写",
        note: "本格走 grant-proposal 的【定标模式】，产出只有 `requirement_card.md`，落盘即停 —— 不选题、不起草。用户上传了申报通知/模板（或表单填了撰写要求）→ 摄入即视同确认；**没有 → 联网查当年申报通知/指南（内置渠道也要查），把查到的候选文件编号列出（文件名/发布机构/年份/URL），让用户回数字确认按哪份写，问完本轮结束**。查到的只有往年版本要如实说明并标注风险。**无人值守（AUTO）时不等确认**：选最可信官方来源落卡，卡头显著标注「自动选定、未经用户确认」。后续所有格都读这张卡：方向生成限定在受理范围内、选题打 funder-fit、锻打按评审评价维定议程。" },
      // ★ 2026-08-18 从「研究方向生成」改名重定位：不再是"AI 依据关键字初拟方向"，而是
      //   围绕用户填的「研究问题」做文献调研 —— 用户反馈 AI 自拟的方向浮于表面，方向必须
      //   由用户带来，本格只负责把该问题周边的格局 / 竞争 / 空白摸清，给下一格的
      //   细节调整建议当证据底座。研究问题空着（跳过表单）才退回旧行为，fail-safe。
      { id: "scan", name: "方向调研", skill: "research-scan",
        deps: [],
        when: { field: "entry", ne: "idea" },   // 打磨已有 idea：方向他已经有了，整格裁掉
        sub: "围绕你的研究问题调研文献、摸清格局",
        emits: ["research_scan*.md", "landscape*.csv"], render: "report",
        hint: "以用户填的研究问题为锚做调研，不自拟替代方向；没搜到 ≠ 研究空白，四象限采样后再下判断",
        note: "任务卡里有「研究问题 / 想解决的痛点」时，整份调研以它为锚：检索式、主线表、争议与空白清单都围绕这个问题及其紧邻领域展开，**不自拟替代方向、不把简报泛化成上位领域的通识综述**——产出定位是给下一格「选题细化」的细节调整建议当证据底座。确有更值得做的邻近方向可以提，但标注「供参考的转向候选」，不混进主线。研究问题空着（用户跳过表单）才退回旧行为：按关键字初拟 2–3 个方向候选。" },
      // ★ 2026-08-07 曾把「选题收敛」与「新颖性裁定」并成本格；2026-08-11 编排改为「锻打先行、
      //   裁定押后」（A/B 实验实测：先裁后锻会因立意转向而过期、漏掉在研竞争试验，见 AGENTS.md
      //   §三 表下注），novelty-check 移去下一格跟随 idea-forge —— 裁定对象从"选定的题"
      //   变成"锻定的那句科学问题"。本格只管把候选列出来、让用户挑定一个。
      // ★ 2026-08-18 从「选题遴选确认」改名重定位：不再让 AI 另拟一批候选题打分遴选
      //   （用户反馈那些题浮于表面）—— 选题主体恒为用户填的「研究问题」，AI 的全部角色是
      //   结合上一格调研到的文献，给若干**细节调整变体**（收窄人群 / 换主结局 / 改设计……）
      //   供用户对照挑选；候选 1 固定是「按你写的原样推进」。
      { id: "topic", name: "选题细化确认", skill: "topic-selection",
        deps: ["scan"],
        when: { field: "entry", ne: "idea" },   // 同上：题是用户带来的，不用再遴选
        sub: "AI 按文献给细节调整建议，选题由你拍板",
        emits: ["topic_candidates*.csv", "topics.md"], render: "report",
        hint: "选题主体是用户写的研究问题；候选 = 原样推进 + 若干带引文的细节调整变体，让用户挑定",
        note: "**本格不是让 AI 另选一批题** —— 选题的主体是用户在表单「研究问题 / 想解决的痛点」里写的那个问题。`topic_candidates*.csv` 必须**真的落盘**（界面靠它渲染候选卡片）：第 1 条固定为「按你写的原样推进」（把用户的问题按 PICO 规整成一句可评估的课题，不改立意）；其后 2–4 条是**结合上一格调研文献对该问题的细节调整变体**（收窄人群 / 亚型、换或加主结局、改研究设计、加对照臂、换机制层……），每条写清「调了什么、为什么这样调、支撑文献（真实 DOI）」——没有文献支撑的调整不许列。用户挑定一条再进下一格。研究问题空着（跳过表单）才退回旧行为：从调研结果里拟 3–5 个候选题遴选。**无人值守（AUTO）时不等确认**：研究问题非空 → 按第 1 条「原样推进」往下（调整变体照样写进 CSV 供事后参考）；为空 → 选推荐项并显著标注「AI 自选、未经确认」。本格**不做**新颖性裁定：裁定在「立意锻打」格里对锻定的科学问题做。" },
      // ★「立意锻打」+「新颖性裁定」两半并一格（沿用本文件"连贯两半并一格"的原则，配对按
      //   2026-08 A/B 实验换了）：idea-forge 多轮对话把立意/创新点/方案锻定 → 对定稿的那句
      //   科学问题跑 novelty-check 严格裁定 + 预注册锁。
      //   【守住的东西】① 它是闸：裁定"已被回答"→ onFail 回 scan 换题；② emits 只收裁定产物 ——
      //   design_brief.md 一落盘锻打才到一半，收它这格就提前绿了（design_brief / closest_work
      //   照常进产物侧栏）；③ 科学问题在锻打中转向 → 旧裁定作废、对新问题重跑（AGENTS.md
      //   「裁定过期护栏」）。
      // ★ skillAlias 里的 deep-research（2026-08-18 加）：锻打对话里承重节点可按需升级调一发
      //   deep-research 深挖（idea-forge SKILL.md「深挖升级」节，每场 ≤2 发）；「打磨已有」路线
      //   进场还会先跑一发入口对表。不进 alias 的话，深挖那几轮会掉出本格归因、进度条熄灭
      //   （多技能轮不归因的老坑，见 wf-state 大修记录）。
      { id: "forge", name: "立意锻打", skill: "idea-forge", skillAlias: ["novelty-check", "deep-research"], gate: true,
        deps: ["topic"],
        sub: "多轮对话磨立意，锻定后做新颖性裁定",
        // design_brief.md / closest_work.md 是锻打这半步的正经产物（note 里点名要求它们落盘），
        // 此前没写进 emits —— 于是产物分级把标书里最值钱的那份设计定案判成"中间文件"折起来。
        // 加进来对步骤条无害：本步的完成判定另有 gateReport（只读裁定书），不看这两个。
        emits: ["novelty_report.md", "novelty_*.md", "preregistration.md", "analysis_plan.md",
                "design_brief.md", "closest_work.md"], render: "report", onFail: "scan",
        // ★ gateReport：闸的裁定只读裁定书。emits 里的 preregistration.md / analysis_plan.md 是
        //   同步产物不是裁定 —— 拿它们当报告读有两种翻车（都实测过）：裁定书还没写出来的窗口里
        //   闸提前变绿；预注册文件里的假设句（"缺氧不通过甲基化…"）被措辞正则误读成"未通过"。
        gateReport: ["novelty_report.md", "novelty_*.md"],
        hint: "空白节点先检索后发散、未验证主张拿证据拷问；锻定的科学问题当场做严格裁定，不过退回领域扫描",
        note: "两件事连着做完，顺序不能颠倒：先用 idea-forge 按其 SKILL.md 跑锻打对话（一轮只问一个问题、编号候选、每轮落盘 `forge_log.md`，产出 `design_brief.md` + `closest_work.md`），**再**对 design_brief 里定稿的那句关键科学问题跑 novelty-check（以 closest_work.md 为最接近文献表起点补严，不重做）。裁定完**在回话里点名说清档位（真新 / 增量 / 已被回答）与依据**；判「已被回答」退回「方向调研」换题，不许带着已被回答的题写标书。**无人值守（AUTO）时跳过锻打对话**，直接对用户选定的题做裁定 —— 本格靠裁定产物判完成，不会卡死。用户从「打磨已有」进来时（任务卡里「从哪里开始＝打磨已有」，设想在「你的研究设想」/「已有工作基础」/上传材料里），流程里没有前两格：锻打对象就是那段设想，且**议程第 0 项是入口对表深检**（idea-forge 阶段 0 第 5 条：用 deep-research 对他的设想查清领域真实进展与在研竞争，落 `idea_landscape.md`，用户点头才跑、AUTO 自动做）——他自带的设想往往几年没对过表，这一发省不得；判「已被回答」时没有「方向调研」可退 —— 当场给 2–3 个带引文的转向候选（换人群 / 换机制层 / 换结局），按编号让用户挑定再继续锻打，同样不许带着已被回答的题往下写。" },
      // ★「摸清申报要求」原本是独立的一步，2026-08-07 按用户要求并进本步 —— 基金申报的流程条
      //   本来就有 6~7 格，而这两步同属 grant-proposal 技能、在同一轮里连着做完是常态，
      //   拆成两格只是把一条本来连贯的工作切开数。
      //   【合并要守住的东西】要求卡【仍然必须先落盘】：它决定后面每一节怎么写、写多长，
      //   按错版本整篇作废。原来靠"流程条上单独一格"让用户在动笔前就看见「它按的是去年口径」，
      //   现在这个提醒点没有了 → 改由 note 强制它把要求卡写成文件、并在回话里报出年份与来源口径，
      //   用户在产出侧栏里照样能第一时间核对。
      //   【emits 为什么不收要求卡】判完成靠"约定产物出现了没有"（server.mjs 的 wfSyncDone）。
      //   把 `要求卡*.md` 也列进来的话，要求卡一落盘这一步就打绿勾 —— 而正文还没写。
      //   要求卡的结构化卡片渲染改由 RENDER_RULES 的 report 组兜住，不走 step.emits。
      { id: "write", name: "标书初稿生成", skill: "grant-proposal",
        deps: ["topic", "forge"],
        sub: "产出立项依据 / 研究内容 / 方案等",
        form: [{ id: "sections", label: "要写的章节", type: "multi",
          default: ["basis", "content", "route", "feature", "foundation", "condition"],
          options: [{ v: "basis", t: "立项依据" }, { v: "content", t: "研究内容与目标" },
            { v: "route", t: "研究方案与技术路线" }, { v: "feature", t: "特色与创新" },
            { v: "foundation", t: "研究基础" }, { v: "condition", t: "工作条件" },
            { v: "budget", t: "经费预算说明" }] }],
        emits: ["proposal.md", "grant_proposal*.md"], render: "manuscript",
        hint: "先定渠道、取当年结构提纲与逐节字数硬限，再按它逐节动笔；传了官方模板就以它为准",
        note: "**「标的确认」格已落 `requirement_card.md` 的，本步以它为底充实（结构提纲全文、逐节硬限），不另起一份与它打架；冲突以用户确认过的那份为准。**没有那张卡（用户跳过了第 0 格）才从头做：**动笔写正文之前，先把本次实际采用的要求写成 `要求卡-<渠道>.md` 落盘**，然后才逐节起草 —— 两件事在同一步里做完，但顺序不能颠倒。要求卡**用内置卡的渠道也要写**，不能因为「卡在 references/ 里读过了」就跳过；至少包含：章节结构提纲（标题原文）、逐节字数/页数硬限、格式规定、形式审查与附件清单、以及每一项的来源与年份口径（内置卡写明卡的年份，联网查的附 URL，没查到的写「未找到官方来源」）。用户传了当年官方模板 / 申报通知的，以用户文件为准，并把它与内置卡的差异逐条列出来 —— 那正是发现「今年又改版了」的地方。落盘之后**在回话里点名说清本次按的是哪个渠道、哪一年的口径**：流程条上不再单列这一步，用户只能从你这句话和产出侧栏里的要求卡去核对，含糊过去他就只能等成稿之后才发现按错了版本。" },
      { id: "review", name: "评审自查校验", skill: "peer-review", gate: true,
        deps: ["write"],
        sub: "完整性、格式与逻辑核查",
        emits: ["review_report*.md"], render: "review", onFail: "write" },   // 通配理由见 paper 的同名步
      // ★ 设计稿把最后一格写作「标书最终成稿 · 语言润色与定稿输出」——既然界面上承诺了"润色"，
      //   白名单里就得给 humanize-academic（见下面 extra），否则 agent 一动手就撞模块闸，
      //   用户看着流程条上写着润色、拿到的却是没润色的稿子。
      // 这一格实际会调三个技能：润色 + 两个渲染器（fmt 默认 docx 走 render-docx）。
      // 只认一个的话，另外两个跑起来时进度条熄灭、那一轮掉出所有分组（见 paper 那格的说明）。
      { id: "render", name: "标书最终成稿", skill: "render-pdf-doc",
        deps: ["write"],
        skillAlias: ["render-docx", "humanize-academic"],
        sub: "语言润色与定稿输出",
        form: [{ id: "fmt", label: "输出格式", type: "select", default: "docx", options: [
          { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }, { v: "both", t: "两种都要" }] }],
        // ★ 不收 review*：标书的终稿是 proposal / manuscript，review_report.docx 是评审报告转的 Word
        //   （agent 常顺手排一份给用户看），收进来会让「标书最终成稿」在正文一字未排时就打绿勾。
        // ★ grant_proposal*：写作步的契约明确允许 grant_proposal*.md，而 render_docx.sh 不带 -o 时
        //   输出=输入名换后缀 → grant_proposal.docx 不中 proposal*.docx（glob 从头匹配），
        //   这一格在最常见命名下永远灰（2026-08-13 实测，综述模块同类缺口一并修）。
        emits: ["manuscript*.docx", "manuscript*.pdf", "proposal*.docx", "proposal*.pdf",
          "grant_proposal*.docx", "grant_proposal*.pdf"], render: "doc" },
    ],
    // ★ research-scan（领域扫描）与 novelty-check（新颖性裁定）本质上都要【检索文献】——
    //   白名单里不给检索技能，它们一动手就撞模块闸、整轮作废（实测在另一会话里复现过：
   //    "网关把 literature-review 的脚本当越权拦了"）。标书的立项依据本来就建立在文献之上。
    //   同理必须给 reference-check：CLAUDE.md §五 明令"写完综述/论文自动跑 reference-check 查假引用"，
    //   而标书立项依据的假引用风险不比论文低（评审看的就是那几十条文献）。此前没给的实测后果是
    //   **干完活才被打断**：agent 写完标书正要核引用，整轮被模块闸掐掉 → peer-review 与排版出件
    //   都没跑成，用户拿到一份没过任何闸的 proposal.md，十分钟的活丢了后半截。
    //   拦在最贵的时刻，是所有拦法里最差的一种。
    // mechanism-figure：标书的"研究方案总览图 / 技术路线示意图"是本技能最合适的场景
    // （标书不投期刊，期刊那套 AI 生成图限制不适用），同样属可选配图、不进固定步骤。
    // ocr：申报口的官方材料【大量以图片发布】——NSFC 的申请代码表与学部注意事项只有 JPG，
    //   没有文字版（见 grant-proposal/references/nsfc-medical-h.md 开头那条警告），
    //   本技能 references/ 下那张 382 个二级码的表本身就是 OCR 出来的，且注明"官方图片每年更新，
    //   本表须随之重跑 OCR 刷新"。用户手上的申报通知、限项说明、模板截图同理。
    //   此前白名单里没有它 → agent 拿到一张代码表截图只能干看着，或者更糟：照印象编一个代码。
    extra: ["render-docx", "search-lit", "literature-review", "fulltext-retrieval", "reference-check",
            "mechanism-figure", "humanize-academic", "ocr"],
  },

  // ============ 文献研读（单篇）============
  //
  // 【它和别的模块不是一个形状】其余模块都是"一条线性流水线 + 首屏表单 + 步骤条"，共用
  // index.html 那个通用壳。本模块是【一篇文献 × 四种看法】：导读 / 自由问答 / 全文翻译 /
  // 演示 PPT —— 用户在这四者之间来回切，没有先后、也没有"跑到第几步"。硬塞进步骤条的话，
  // 条子上永远显示"共 N 步、已完成 1 步"，而用户其实哪一步都可以随时再来一遍。
  // 所以它自带一个专用界面（web/reader.html：左边原文、右边助手、最右四个模式按钮），
  // `ui: "reader"` 就是那层路由信号 —— 工作台与聊天页看到它就把用户送去那个页面，
  // 不再渲染表单与步骤条。除此之外的一切（会话、技能闸、前言注入、产物侧栏）都走原有那套。
  //
  // 【一篇文献 = 一个会话】四种模式共享同一个 opencode 会话，所以原文只抽一次，
  // 切到"智能助手"时前面翻译 / 做 PPT 的上下文原样都在，接着问就是了（这正是产品要的
  // "保留最近那个会话"）。换一篇 = 新开会话。
  litread: {
    // 主技能取 fulltext-retrieval：本模块干的第一件事永远是"把上传的 PDF/Word 抽成文本"
    //（pdf_to_md.py 就在这个技能里）。它被技能白名单收权时整个模块该整体不可用 —— 因为
    // 抽不出原文，导读 / 翻译 / PPT 一个都做不成，让模块半开着只会让用户白等一轮。
    primary: "fulltext-retrieval",
    ui: "reader",
    intakeTitle: "上传要研读的文献",
    // intake 仍然声明：reader.html 自己画上传界面，但 /api/workflow/form 那条路（落盘表单值、
    // 拼任务卡）与服务端的必填体检都读这份 schema，缺了它这些机制就整段失效。
    intake: [
      { id: "docFile", label: "文献原文", type: "files", required: true,
        uploadText: "上传文献", accept: ".pdf / .docx",
        help: "一次只研读一篇。图片型扫描件会先走 OCR，识别不准的地方会如实标出来。" },
      LANG,
    ],
    steps: [
      { id: "ingest", name: "读入原文", skill: "fulltext-retrieval",
        deps: [],
        // 后三个不是这一步产的（导读 / 翻译两种模式没有对应的技能，也就没有对应的 step），
        // 但 artifactLine 只从 steps[].emits 收集"产物用约定名"那句话。挂在这里，是为了让
        // 这三个名字每一轮都随前言到模型手上 —— reader.html 正是按这几个名字去把正文捞回来渲染的
        //（见 MODES[*].file），名字漂了界面就只剩一句"已完成"、正文不知去向。
        emits: ["fulltext.md", "fulltext_*.md", "reading_guide.md", "reading_guide.docx",
                "translation_zh.md", "translation_zh.docx"], render: "report",
        hint: "PDF 走 pdf_to_md.py，Word 走 ingest_doc.py（图和表一起抽出来）；抽不动的扫描件再走 ocr",
        note: "抽出来的正文必须落成 `fulltext.md`——后面导读、翻译、做 PPT 全都读它，"
            + "别每种模式各抽一遍（既慢又可能三份内容不一致）。" },
      { id: "ppt", name: "演示 PPT", skill: "ppt-master", optional: true,
        deps: ["ingest"],
        emits: ["ppt_outline.md", "*.pptx", "exports/*.pptx"], render: "doc" },
    ],
    // ocr：图片型扫描件（pdf_to_md 抽出来是空的）唯一的出路。
    // render-docx / render-pdf-doc：翻译稿、导读稿用户常要一份 Word/PDF 拿走。
    // humanize-academic：Word 原稿的读入（ingest_doc.py）与【就地翻译】（docx_extract /
    //   docx_translate / docx_verify）三个脚本都在它名下。不加进白名单的话，模块闸会把
    //   bash 直呼这些脚本挡掉，模型只能退回自己写 python-docx 临时脚本——正是要修的那条路。
    extra: ["ocr", "render-docx", "render-pdf-doc", "humanize-academic"],
    // ---- 专用界面的配置（整份下发给 reader.html，见文件上方「阅读器型模块」那段说明）----
    reader: {
      intro: {
        title: "文献研读",
        lead: "上传一篇 PDF 或 Word 文献，点「开始研读」——先自动出一份导读，理清它的核心与论证逻辑；之后随时可以对着原文追问、要全文翻译，或让它做一套汇报 PPT。",
        dropTitle: "点击或拖拽文献到此处",
        dropHint: "支持 PDF / Word（.pdf · .docx · .doc）　·　一次研读一篇",
        startText: "上传并进入",
        // 图标写死在文案旁边（{t,i}）：模式条的顺序调过之后，按位置取图标会让这几个小标签集体错位
        chips: [{ t: "文献导读", i: "guide" }, { t: "对着原文追问", i: "chat" }, { t: "全文翻译", i: "translate" }, { t: "汇报 PPT", i: "ppt" }],
        tip: "图片型扫描件会先走 OCR，识别不准的地方会如实标出来。<br>所有结论只依据这篇原文——原文没写的，它会写「原文未报告」，不会替你补。",
      },
      source: { kind: "doc", field: "docFile", accept: ".pdf,.docx,.doc,.odt", exts: ["pdf", "docx", "doc", "odt"] },
      first: "guide",          // 传完点「开始」自动跑哪一个
      settings: ["lang"],      // 齿轮弹层里放哪些 intake 字段
      // 智能助手那一格的文案（输入框提示 + 会话第一轮补的那句上下文）。四个阅读器模块各写各的：
      // 壳里原来写死的是文献版，数据模块因此会对着一张 Excel 说"我上传了一篇文献"。
      chat: { placeholder: "对着左边这篇文献随便问，例如：第 3 组的样本量是多少？",
        firstTurn: "我上传了一篇文献 {doc}，请先按前言把它抽成文本再回答。我的问题是：" },
      modes: LITREAD_MODES,
    },
    // ---- 用 flow 顶掉通用的"标准流程"那段话 ----
    // 通用版会写成「读入原文 → 演示 PPT(可选)。按此顺序推进」，而本模块根本没有这个顺序：
    // 用户可能一上来就点翻译，也可能导读看完直接问问题。照通用版说，模型会去"按流程推进"，
    // 甚至在用户只想问一句话时自作主张跑起 ppt-master。
    flow: `\n- **本模块 = 研读【用户上传的这一篇】文献**，不检索、不找别的文献、不写综述。用户问的一切都以这篇原文为准。`
      // ★ Word 的抽法【不要】再写成"用 python-docx"。实测后果：模型照这句自己写了一个
      //   `import docx; for p in d.paragraphs` 的临时脚本 —— 那条路取不到表（表在 doc.tables 里）、
      //   也取不到图，而且全程不报错。改点名 ingest_doc.py（pandoc + --extract-media，图与表一并抽出）。
      + `\n- **第一步永远是把原文抽成文本**：PDF 用 \`fulltext-retrieval\` 技能里的 \`pdf_to_md.py\`；`
      + `Word(.docx) 用 \`humanize-academic\` 技能里的 \`ingest_doc.py\`（它会把图抽到 \`<稿件名>_files/\`、`
      + `把表转成 pipe 表）；抽出来几乎没有正文（图片型扫描件）才转 \`ocr\` 技能。`
      + `**不许自己写 \`import docx\` 的临时脚本抽段落**——\`doc.paragraphs\` 里既没有表也没有图，`
      + `丢了还不报错。抽好的正文写成 \`fulltext.md\`，**本会话后续所有模式都直接读它，不要重复抽取**。`
      + `\n- **但「全文翻译」遇到 \`.docx\` 时不要用 \`fulltext.md\`**：那一格走就地翻译`
      + `（\`docx_extract.py\` → 逐行译 → \`docx_translate.py\`），直接在原文件上改字，`
      + `产物是保着排版的 \`translation_zh.docx\`。用 markdown 转一圈等于把用户的排版扔了。`
      + readerModeLines(LITREAD_MODES)
      + `\n- **一切结论只能来自这篇原文**：数字、剂量、样本量、p 值、结论一律照抄原文；`
      + `原文没写的就写「原文未报告」，**不许拿你的背景知识补齐，也不许引入原文没有的参考文献**。`
      + `引用具体数据时带上出处（第几节 / 哪张图表）。`
      + `\n- 用户想让你去检索别的文献、写综述、查引用真伪 → 那不是本模块的事，按下面那张表指路。`,
  },

  // ============ 文献管理 ============
  // 输入不是"一份文件"而是【用户电脑上的一个文件夹】：靠既有的「工作目录」机制拿到它 ——
  // 用户在 intake 里选目录 → 会话的 cwd 就是那个目录 → 技能脚本原地读原文件、原地出 Excel、
  // 原地建分类子文件夹。不复制、不上传，几百篇也是秒选。
  //（曾考虑过用浏览器的「上传整个文件夹」兜住多用户网页版，2026-08-14 用户明确那一档已废弃，不做。）
  litmanage: {
    primary: "literature-manage",
    intakeTitle: "选择要整理的文件夹",
    intake: [
      // type:"dir" 是本模块引入的新控件：点开就是既有的「选择工作目录」弹窗（/api/fs/list），
      // 选定后既填进表单、又成为本会话的工作目录。所以它【必须在发第一条消息前选好】——
      // opencode 的 directory 建会话时定死，之后改不了（见 server.mjs createSession 的注释）。
      { id: "libDir", label: "要整理的文件夹", type: "dir", required: true,
        help: "选你电脑上放这批文件的那个文件夹（文献，或笔记 / 报告 / 记录这类文档都行）。"
            + "AI 直接读里面的原文件，不会复制、不会上传；生成的 Excel 台账也写在这个文件夹里。",
        errMsg: "先选一个文件夹——这是本模块唯一的输入" },
      // 要整理哪些格式。默认只勾 PDF / Word —— 一个文献文件夹里常年躺着 readme.txt、笔记.md
      // 这类东西，默认全收会把它们混进台账。md / txt 摆成可勾项、再给一个自定义框，
      // 让"整理的不是文献"（笔记库、报告、字幕、导出的记录……）这类用法也走得通。
      { id: "formats", label: "要整理的文件格式", type: "multi",
        default: ["pdf", "docx"],
        options: [
          { v: "pdf", t: "PDF (.pdf)" },
          { v: "docx", t: "Word (.docx/.doc)" },
          { v: "md", t: "Markdown (.md)" },
          { v: "txt", t: "纯文本 (.txt)" },
        ],
        help: "默认只整理 PDF 与 Word。勾上 Markdown / 纯文本后，笔记、报告这类非文献文件也会被读入——"
            + "它们没有作者与杂志，台账里改用「主要内容」一列。" },
      { id: "formatsCustom", label: "其他格式（自己填）", placeholder: "例：rtf, html, csv, srt",
        help: "上面没列到的扩展名填这里，逗号分隔，AI 会按【文本文件】读它的开头若干行。"
            + "xlsx / pptx / 图片等二进制格式读不了内容，会如实标出来，不会替你编。" },
      { id: "recursive", label: "连子文件夹一起读", type: "bool", default: false,
        help: "默认只读你选的这一层。文件分散在若干子文件夹里才勾——注意勾了之后再做「按分类归档」，"
            + "会把它们从原来的子文件夹搬到分类子文件夹里。" },
      { id: "classify", label: "分类", type: "bool", default: true,
        help: "分类后一类占 Excel 的一个 sheet（sheet 名 = 类名）。不分类就全部放在一个 sheet 里。" },
      { id: "rule", label: "分类标准", type: "textarea", when: { field: "classify", eq: true },
        placeholder: "例：按研究类型分（RCT / 队列 / 病例对照 / 综述 / 基础研究）；留空则由 AI 读完后自定口径",
        help: "留空 = AI 读完这批文件后自己定一个一致的分法，并在交付时说明按什么分的。" },
      LANG,
    ],
    steps: [
      { id: "scan", name: "读取文件", skill: "literature-manage",
        deps: [],
        emits: ["library_index.json", "library_texts/*"], render: "report",
        hint: "只按勾选的格式扫，每份抽开头几页 / 几行（默认 3 页 · 200 行 · 4000 字），"
            + "够填台账即可；图片型扫描件与读不了的格式会被标出来" },
      { id: "table", name: "台账与分类", skill: "literature-manage",
        deps: ["scan"],
        emits: ["library.json", "library.xlsx"], render: "table",
        hint: "一类一个 sheet；抽不到的字段写「原文未标注」，不猜年份 / 期刊" },
      // 归档会动用户硬盘上的原始文件 —— 永远可选、永远先预演再执行（见 flow 与技能里的铁律）
      { id: "archive", name: "按分类归档", skill: "literature-manage", optional: true,
        deps: ["table"],
        emits: ["archive_log.json"], render: "report",
        hint: "把原文件移进以类名命名的子文件夹；执行前必须先给用户看预演清单" },
    ],
    // 扫描件抽不出字时的唯一出路（篇数不多时值得补，否则如实标注）
    extra: ["ocr"],
    flow: `\n- **本模块 = 把【用户选的那个文件夹】里的文件整理成一张多 sheet 的 Excel 台账**。`
      + `不检索、不下载、不写综述，也不读这个文件夹之外的任何文件。`
      + `\n- **当前工作目录就是用户选的那个文件夹**：脚本一律不带 \`--dir\`（默认就是当前目录），`
      + `产物 \`library_index.json\` / \`library.json\` / \`library.xlsx\` 也都写在这里。`
      + `\n- **只整理用户在表单里勾的格式**：把「要整理的文件格式」与「其他格式」合起来传给`
      + ` \`scan_library.py --ext\`（例：\`--ext pdf,docx,md,txt\`；自定义框里填的扩展名原样追加）。`
      + `**没勾的格式不许自作主张扫进来**——用户只要 PDF 时，目录里的 readme.txt 不该出现在台账里。`
      + `md / txt 及任何自定义文本格式按【前若干行】读（\`--lines\`，默认 200），道理与 PDF 只读前几页一样。`
      + `xlsx / pptx / 图片这类二进制格式脚本会标 err：先如实告诉用户读不了，**不许按文件名编内容**；`
      + `他确实要整理这类文件，再按技能文档自己写一小段读取脚本补进 \`library_texts/\`（仍只取开头一小段）。`
      + `\n- **第一步跑 \`scan_library.py\` 抽内容，之后只读 \`library_texts/*.txt\`**，`
      + `不要再去打开原始文件（内容已经抽好，重复读只是烧钱又慢）。`
      + `\n- **列不是写死的六列，按这批文件是什么定**（写进 \`library.json\` 的 \`columns\`/\`fields\`）：`
      + `\n  · 全是文献 → 文件名 / 标题 / 年份 / 作者 / 杂志 / 核心观点（\`file,title,year,authors,journal,point\`）。`
      + `\n  · **不是文献**（笔记、报告、会议记录、草稿、说明文档、字幕……）→ 别硬凑作者与杂志，`
      + `那只会得到一整列「原文未标注」。用 文件名 / 标题 / 日期 / **主要内容**`
      + `（\`file,title,date,summary\`），主要内容写"这份文件讲的是什么、有什么结论或待办"，两三句。`
      + `\n  · **两者混在一个文件夹** → 文献六列后面补一列「主要内容」，各行填自己有的那一列，`
      + `另一边留空（别写"不适用"以外的编造内容）。`
      + `\n- **年份 / 作者 / 杂志抽不到就写「原文未标注」**：文件名叫 \`Nature_2021.pdf\` 既不证明它发在 Nature、`
      + `也不证明是 2021 年。核心观点写"做了什么 + 结论是什么"，不许写"本文研究了 XX 的相关问题"这种空话。`
      + `\n- **台账写成 \`library.json\` 再跑 \`build_workbook.py\` 出 \`library.xlsx\`**，`
      + `不要自己写临时脚本拼 Excel —— 界面上的「改分类」「按分类归档」都按这两个文件的约定读写，`
      + `名字或字段一漂，那两个功能当场失效。`
      + `\n- **「按分类归档」会移动用户硬盘上的原始文献**：一律先跑不带 \`--apply\` 的预演，`
      + `把"哪些文件移到哪个子文件夹、共几个"给用户看，**等他明确说执行**再加 \`--apply\`。`
      + `他担心动原件就给 \`--copy\`（复制过去、原件留原地）这个选项。`
      + `\n- 出完 Excel 告诉用户：产出栏点开 \`library.xlsx\` 可以按 sheet 预览，`
      + `并直接在预览里把某一篇改到别的分类、或一键按分类归档。`
      + `\n- 用户想读透其中某一篇 → 指路「文献研读」模块；想据此写综述 → 指路「综述撰写」模块。`,
  },

  // ============ 数据统计与分析 ============
  stats: {
    primary: "data-analysis",
    intakeTitle: "数据与分析设置",
    intake: [
      { id: "dataFiles", label: "数据文件", type: "files",
        uploadText: "上传数据表", accept: ".xlsx / .csv",
        // ★ 不能无条件必填：「样本量 / 把握度」是【做研究之前】算要收多少例的，此时根本没有数据。
        //   写死 required 的结果是——设计课题的医生一进来就被"还没填：数据文件"挡住，
        //   等于"想算样本量？先去伪造一份数据"。
        // ★ 但也不能写成 hasNot:"power"：那变成"只要勾了样本量就一律不必填"，于是
        //   「生存分析 + 样本量」这种很常见的组合（先看现有队列的曲线、顺便算扩样本要多少例）
        //   会让一个没有任何数据的 KM/Cox 请求静默通过 —— 比过度拦截更危险。
        //   判据是"除样本量之外还勾了别的吗"。
        requiredWhen: { field: "analyses", hasOther: ["power"] },
        help: "选好后下面的列名会自动读出来。只算样本量 / 把握度可以不传。" },
      // ★ 这题【不能有默认值】：默认「否」等于替用户声明「本数据不含身份信息」，
      //   而他表里就摆着 300 个姓名和住院号。改成必答，两个都不预选。
      // pin：钉进模块前言、每一轮都发。阅读器壳里用户是在首屏答的这一题，之后每次点某个分析模式
      // 都是一轮新对话 —— 不 pin 的话，"这份数据含身份信息"只在第一轮出现过，后面几轮模型完全不知情，
      // 照样把姓名住院号拿去做统计。这正是 §五「未脱敏不得进入统计」那条铁律的落点。
      { id: "hasPHI", label: "数据里含患者身份信息（姓名/住院号/身份证/住址等）", type: "bool", required: true, pin: true,
        options: [
          { v: true, t: "是", pinNote: "**在做任何统计之前先用 `deidentify` 技能脱敏**，之后所有分析、出图、"
            + "出表一律基于脱敏后的表；还原表只留在本会话目录，不许写进任何报告或图表" },
          { v: false, t: "否", pinNote: "用户已声明本表不含可识别身份的字段；若你在表里【实际看到】姓名 / 住院号 / "
            + "身份证 / 住址这类列，**停下来告诉用户**，不要闷头继续算" }],
        help: "选「是」会先脱敏再分析。未脱敏的患者数据不得进入统计。" },
      { id: "analyses", label: "要做的分析", type: "multi", required: true, options: [
        { v: "profile", t: "数据体检（缺失 / 异常 / 重复 ID）" },
        { v: "desc", t: "描述性统计" }, { v: "table1", t: "基线表 Table 1" },
        { v: "compare", t: "组间比较" }, { v: "corr", t: "相关 / 回归" },
        { v: "survival", t: "生存分析（KM / Cox）" }, { v: "roc", t: "ROC / 诊断效能" },
        { v: "agreement", t: "方法比对（Bland-Altman / Passing-Bablok）" },
        { v: "repeated", t: "重复测量 / 纵向" }, { v: "power", t: "样本量 / 把握度" }],
        help: "建议先勾「数据体检」—— 重复 ID 没去、分类水平没归一时，后面每个 p 值都是错的，而表面看不出来。" },
      // 六个"列"长得一模一样，各自属于哪个分析必须写在 help 里，否则一定填串
      { id: "groupCol", label: "分组列", type: "columns", source: "dataFiles",
        section: "把分析用到的变量对到你表里的列",
        // Table 1 的本质就是"按组分列对比"，勾了它却不给选分组列是说不通的
        whenAny: [{ field: "analyses", has: "compare" }, { field: "analyses", has: "table1" }],
        help: "区分组别的那一列，如 治疗组/对照组、手术方式。用于基线表与组间比较。" },
      { id: "outcomeCol", label: "结局列", type: "columns", source: "dataFiles",
        help: "要解释或预测的结果，如 是否复发、住院天数。选好数据文件后这里会读出真实列名。" },
      // 这四个是对应分析的必要输入，缺了那一步跑不出来 —— 勾了该分析就必填
      { id: "timeCol", label: "随访时间列（生存分析用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "survival" }, required: true,
        help: "从起点到终点事件或末次随访的时长，如 随访月数。" },
      { id: "eventCol", label: "终点事件列（生存分析用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "survival" }, required: true,
        help: "1 = 事件发生（死亡/复发），0 = 删失（失访或随访结束时仍无事件）。" },
      { id: "testCol", label: "待评价指标列（ROC 用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "roc" }, required: true,
        help: "你想评价诊断效能的那个检测值，如 某标志物浓度、某评分。" },
      { id: "goldCol", label: "金标准列（ROC 用）", type: "columns", source: "dataFiles",
        when: { field: "analyses", has: "roc" }, required: true,
        help: "公认的确诊依据，如 病理结果。1 = 有病，0 = 无病。" },
      { id: "covars", label: "需要校正的协变量", type: "columns", source: "dataFiles", multiple: true,
        help: "要一并放进模型的因素，如 年龄、性别、分期。可不选。" },
      { id: "figs", label: "顺便出投稿级图", type: "bool", default: false,
        help: "300dpi + 矢量，可直接投稿；不勾则只给 150dpi 预览图。" },
      LANG,
    ],
    steps: [
      { id: "deid", name: "数据脱敏", skill: "deidentify", when: { field: "hasPHI", eq: true },
        deps: [],
        emits: ["deid_report.md"], render: "report" },   // 同上：还原表不进产物契约
      { id: "profile", name: "数据体检", skill: "data-analysis",
        deps: ["deid"],
        // 只算样本量（做研究之前）时没有任何数据，这几步永不可能完成 —— 留在条上等于让进度
        // 永远停在第一步。判据用 hasOther：勾了样本量【之外】的分析才需要真数据。
        // ★ 第二条 whenAny 是给【跳过表单直接打字】那条路的：`analyses` 此时为空，hasOther 恒假，
        //   于是步骤条只剩「统计分析」一格 —— 而实测那一轮它做完了体检、基线表、组间比较三件事，
        //   用户看到的却是"1 步，已完成"。体检恰恰是"没有它后面每个 p 都是错的"那一步，
        //   空表单时默认排上它比漏掉安全。（table1/figure 这类无从推断的仍然不猜。）
        whenAny: [{ field: "analyses", hasOther: ["power"] }, { field: "analyses", truthy: false }],
        emits: ["data_profile.md", "cleaning_log.md"], render: "report",
        hint: "重复 ID / 分类水平不一致 / 分组缺失必须先清，否则后面每个 p 都是错的" },
      { id: "table1", name: "基线表 Table 1", skill: "clinical-stats",
        // 体检只是软提醒（模式条随点随跑），table1/analyze 都不依赖它的产物 —— 重跑体检不许把它们标过期
        deps: ["deid"],
        when: { field: "analyses", has: "table1" },
        emits: ["table1.csv"], render: "table" },
      { id: "analyze", name: "统计分析", skill: "data-analysis",
        deps: ["deid"],
        // 样本量/把握度也归这一步做（它就是 clinical-stats/data-analysis 的活），所以无条件保留
        emits: ["stats_*.csv", "*_results.csv", "analysis*.md", "sample_size*.md"], render: "table" },
      { id: "figure", name: "出版级图表", skill: "nature-figure", when: { field: "figs", eq: true },
        deps: ["analyze"],
        emits: ["fig*.png", "fig*.pdf", "fig*.svg", "figures/*"], render: "figure" },
      // gateBy:"signals"：同 refcheck / paper 两处，缺了它这道闸永远判不了红（见那边的长注释）
      { id: "integrity", name: "源数据完整性自查", skill: "data-integrity", optional: true, gate: true,
        deps: ["deid"],
        gateBy: "signals", failLabel: "有待核信号",
        when: { field: "analyses", hasOther: ["power"] },   // 没有源数据就无从自查
        emits: ["integrity_report.md", "audit/*"], render: "integrity", onFail: "analyze" },
    ],
    // 出完基线表/结果表，用户下一句多半是"导成 Word 给我" —— 不放行排版技能就会被模块闸掐掉，
    // 报"模块限制"。这两个不进 steps（不是规定流程的一环），只作为随时可用的配套。
    extra: ["render-docx", "render-pdf-doc"],
    ui: "reader",
    reader: {
      intro: {
        title: "数据统计与分析",
        lead: "上传数据表（可以一次传好几张），先做体检把脏数据挑出来，再出基线表、跑统计、画投稿级图。左边始终摆着你的原表，算出来的每个数都能对回去。",
        dropTitle: "点击或拖拽数据表到此处",
        dropHint: "支持 Excel / CSV（.xlsx · .xlsm · .csv · .tsv）　·　可多选，进去以后还能加、能删",
        startText: "上传并进入",
        chips: [{ t: "数据体检", i: "stethoscope" }, { t: "基线表 Table 1", i: "table" }, { t: "生存 / ROC / 回归", i: "chart" }, { t: "投稿级图表", i: "image" }],
        tip: "建议先跑「数据体检」——重复 ID 没去、分类水平没归一时，后面每个 p 值都是错的，而表面看不出来。<br>算不出来的它会说算不出来，不会给你一个编的数字。",
        // 首屏就要答的必答题（不是设置，是安全闸）。未脱敏的患者数据不得进入统计，
        // 这一题没答之前「开始分析」是灰的。
        ask: ["hasPHI"],
      },
      // multi:true —— 本模块【收一组表】而不是一张：一份研究的数据常常分散在主表 + 随访表 +
      // 检验表里，只收一张的话用户只能反复覆盖，传错了还删不掉、只能整个会话重来。
      // 阅读器壳据此：首屏可多选、左栏顶上出一条文件 chip（点着换看、× 删除、＋ 再传一张），
      // 发给模型的是【全部】文件名，而"变量对应"的列名读的是当前在看的那张。
      source: { kind: "table", field: "dataFiles", multi: true,
        accept: ".xlsx,.xlsm,.csv,.tsv,.xls", exts: ["xlsx", "xlsm", "csv", "tsv", "xls"] },
      first: "profile",
      settings: ["figs", "lang"],
      chat: { placeholder: "对着你的数据随便问，例如：治疗组的中位随访时间是多少？",
        firstTurn: "我上传了数据表 {doc}，请先把表读进来、看清有哪些列和多少行，再回答。我的问题是：" },
      // ---- 变量对应面板（只有本模块有）----
      // 【为什么必须留着】「列名猜错 / 写错」是这个模块最高频的失败模式，而它不会报错 ——
      // 医生表里 `随访时间` 和 `入院时间` 并排，认错了只会给出一份看起来很正常的错 KM 曲线。
      // 从真实表头下拉能从根上消灭它，所以哪怕界面改成了按钮式，这几个下拉也得留下来，
      // 只是收进一张默认折叠的面板：不做生存分析的人根本不用展开它。
      vars: {
        title: "变量对应",
        sub: "把分析用到的变量对到你表里的列。点某个分析时若缺了它必需的列，这里会自动展开。",
        fields: ["groupCol", "outcomeCol", "timeCol", "eventCol", "testCol", "goldCol", "covars"],
      },
      modes: STATS_MODES,
    },
    flow: `\n- **本模块 = 分析【用户上传的数据表】**（可能不止一张），不写论文、不查文献、不润色。`
      + `\n- **多张表时**：消息里会把本会话的全部表都列出来。**先弄清每张表是什么、能不能按 ID 关联**，`
      + `再决定用哪张/怎么合；**合表前后的行数变化要报出来**（合错了最常见的症状就是行数悄悄变了）。`
      + `每个结果都要写清用的是哪张表。用户只提了其中一张时就只用那张，别自作主张把别的表并进去。`
      + `\n- **一切结果只能来自这些表**：算不出来的、数据不支持的，直接说算不出来和缺什么。`
      + `**绝不许编造样本量、p 值、置信区间或任何一个数字** —— 这里编的数会一路进到投稿稿件里。`
      + readerModeLines(STATS_MODES)
      + `\n- **用户在界面上指定了哪一列是什么，就以他指定的为准**（消息里会带一段「变量对应」）。`
      + `他没指的列你可以推断，但**必须在回答里写清你把哪一列当成了什么**，让他能一眼发现认错了。`
      // 「自动认列」：界面会读表的前几行，先把分组/终点事件/随访时间这些替用户填好（他多半答不上
      // 这些词，见 data-analysis 技能「第零步」）。但【自动填 ≠ 用户确认】—— 没核对过的那几列
      // 会单独成一段发过来，模型必须自己再核一遍，不能当成用户的指令照做。
      + `\n- **消息里若出现「这几列是系统读了表的前几行自动认出来的，我还没核对」那一段**：`
      + `那不是用户的指令，是机器的猜测。**动手前自己核一遍取值形状**——终点事件该是两值、`
      + `随访时间该是非负时长而不是日期、金标准该是两值、分组列该只有少数几个水平。`
      + `对不上就**停下来**告诉他是哪一列、表里还有哪几列可选，别将就着算；核对结论写进回答。`
      // xlsx 的列名此前是用户【手打】的（读不了 xlsx 表头时下拉会降级成输入框），打错是常态。
      // 静默挑一个近似列替上去 → 一份看起来完全正常、实际分错了组的表，用户和审稿人都看不出来。
      + `\n- **他指定的列名在表里找不到 → 停下来告诉他实际列名，让他改**（列名相近的两列并存极常见，`
      + `如「手术方式」与「组别」）。**绝不许自己挑一个像的替上去**——哪怕在回答里写了，`
      + `那也是一份看起来完全正常、实际分错组的表。`
      + `\n- **方法要交代**：用了什么检验 / 模型、为什么选它、前提是否满足（正态性 / 方差齐性 / 比例风险假定 / `
      + `共线性…）。前提不满足就换稳健方法并说明。报结果给**效应量与 95%CI**，不要只给一个 p 值；`
      + `多重比较要校正并说明用了哪种。`
      + `\n- **不要替用户改数据**：体检发现的问题逐条列出来、给建议，改不改由他定。`
      // 界面上那个开关的语义要写清楚，否则"顺便出投稿级图＝是"传过去了模型也不知道该做什么。
      + `\n- 消息末尾的「本次设定」里，**「顺便出投稿级图＝是」= 统计分析这一步直接出 300dpi + 矢量`
      + `（\`nature-figure\`，可直接投稿）；＝否 = 只给 150dpi 预览图**（\`data-analysis\` 自带的即可）。`
      + `「输出语言」管的是报告、表头与解读文字用什么语言写。`,
  },

  // ============ 文稿核查与审校 ============
  refcheck: {
    primary: "reference-check",
    intakeTitle: "核查设置",
    intake: [
      { id: "docFiles", label: "待核查的稿件", type: "files", required: true,
        uploadText: "上传稿件", accept: ".docx / .pdf / .md" },
      { id: "dataFiles", label: "配套的数值表", type: "files",
        uploadText: "上传数值表", accept: ".xlsx / .csv",
        requiredWhen: { field: "checks", has: "integrity" },
        help: "只有勾了「数据完整性」才需要 —— 没有数值表这一项做不了。" },
      { id: "checks", label: "核查项", type: "multi", required: true,
        // 默认必须把「统计陷阱」也勾上：模块副标题与流程条都写着会查统计方法，
        // 而默认不勾等于按介绍点「开始」的人拿到一份没查统计的报告，自己还不知道。
        default: ["refs", "doi", "retracted", "stats"],
        options: [{ v: "refs", t: "假引用（文献是否真实存在）" }, { v: "doi", t: "DOI 是否正确" },
          { v: "retracted", t: "是否引用了已撤稿文献" }, { v: "stats", t: "统计陷阱与方法硬伤" },
          { v: "format", t: "格式与体例（章节结构、图表题注、参考文献格式）" },
          { v: "integrity", t: "数据完整性（需一并上传数值表）" }],
        help: "勾了「数据完整性」就必须把配套的数值表也传上来，否则这一项没法做。" },
      { id: "strict", label: "严格度", type: "select", default: "standard", options: [
        { v: "standard", t: "标准（推荐）" }, { v: "strict", t: "严格（宁可多报，把可疑的都列出来让你自己判断）" }] },
      { ...LANG, label: "核查报告用什么语言", help: "只影响报告，不改动你的稿件。" },
    ],
    steps: [
      // ★ 三个勾选项由【同一个脚本一次跑完】（verify_refs.py 本来就同时验 DOI、比标题、查撤稿），
      //   所以条件必须是 whenAny。此前只认 refs：用户想"我的文献都读过、只验一下 DOI 抄错没有"
      //   而取消勾选「假引用」，整条流水线就退化成零步骤 —— 没有闸、没有流程线、没有产物契约，
      //   而界面上什么异常都看不出来。
      { id: "refcheck", name: "引用核查", skill: "reference-check", gate: true,
        deps: [],
        whenAny: [{ field: "checks", has: "refs" }, { field: "checks", has: "doi" },
                  { field: "checks", has: "retracted" }],
        // ★ 本模块【故意不写 onFail】：它核的是用户自带的稿件，闸红时要改的是那份稿子本身，
        //   流程里没有上游步骤可退。界面读不到 onFail 就退回"改完要重跑本闸"，那句话在这里是对的
        //   —— 硬指一个步骤名反而误导（指回自己就成了循环）。
        emits: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"], render: "refcheck" },
      { id: "review", name: "方法与统计审校", skill: "peer-review", gate: true,
        deps: [],
        // 格式与体例也由这一步顺带查（peer-review 的清单里本就含体例）—— 别让选项勾了却没有任何一步走它
        whenAny: [{ field: "checks", has: "stats" }, { field: "checks", has: "format" }],
        emits: ["review_report*.md"], render: "review" },   // 通配理由见 paper 的同名步
      // ★ gateBy:"signals" —— 这道闸【不能】按裁定语判。data-integrity 的铁律是"只出待核信号、
      //   不下造假结论"，也就是它被明令禁止写出 gateFailed 认得的那些措辞，于是通用判据永远判不了红。
      //   实测：报告里 6 条硬性不自洽（含生理不可能的 eGFR=1220），步骤条照打绿勾。改按信号条数判。
      //   failLabel：界面上别写"需返工"——那等于替它下了"数据有问题"的结论，与 signal-not-verdict 打架。
      { id: "integrity", name: "数据完整性自查", skill: "data-integrity", gate: true, gateBy: "signals",
        deps: [],
        failLabel: "有待核信号",
        when: { field: "checks", has: "integrity" },
        emits: ["integrity_report.md", "audit/*"], render: "integrity",
        hint: "只出待核信号、不下造假结论" },
    ],
    // reference-check / peer-review 的技能文档都写着"出 PDF：交给 render-pdf-doc"，
    // 而医生拿到核查报告最自然的下一步就是发给通讯作者。此前 extra 是空的，这条路直接堵死。
    extra: ["render-pdf-doc", "render-docx"],
    ui: "reader",
    reader: {
      intro: {
        title: "文稿核查与审校",
        lead: "上传一份稿件，逐条核实参考文献是否真实存在、DOI 与撤稿情况；再按审稿人的眼光找研究设计与统计上的硬伤。带上配套数值表还能做一遍源数据自查。",
        dropTitle: "点击或拖拽稿件到此处",
        dropHint: "支持 Word / PDF / Markdown（.docx · .pdf · .md）　·　一次一份",
        startText: "上传并进入",
        chips: [{ t: "假引用与 DOI", i: "check" }, { t: "撤稿检索", i: "review" }, { t: "统计陷阱", i: "review" }, { t: "数据完整性", i: "table" }],
        tip: "查不到 ≠ 不存在：网络受限或数据库没收录时它会写「未能核实」，不会判成假引用。<br>数据完整性只出「待核信号」，不下造假结论——目的是投稿前主动补说明。",
      },
      source: { kind: "doc", field: "docFiles", accept: ".docx,.pdf,.md,.doc,.txt", exts: ["docx", "pdf", "md", "doc", "txt"] },
      // 第二份可选上传：数值表。只有「数据完整性」那个模式要用，所以不摆在首屏挡路，
      // 点到那个模式发现缺了再就地要（见 modes[].need / needHint）。
      extraUpload: { field: "dataFiles", key: "data", label: "配套数值表", accept: ".xlsx,.csv,.tsv", exts: ["xlsx", "csv", "tsv"] },
      first: "refs",
      settings: ["strict", "lang"],
      chat: { placeholder: "对着这份稿件随便问，例如：第 12 条引用为什么判黄？",
        firstTurn: "我上传了一份稿件 {doc}，请先读它再回答。我的问题是：" },
      modes: REFCHECK_MODES,
    },
    flow: `\n- **本模块 = 核查【用户上传的这一份稿件】**，不写稿、不润色、不做统计分析。`
      + `\n- **核查结论必须建立在真的查过之上**：引用要真的去线上核（\`reference-check\` 技能），`
      + `不许凭印象说"这篇我知道，是真的"。`
      + readerModeLines(REFCHECK_MODES)
      + `\n- **查不到 ≠ 不存在**：网络受限、数据库没收录、检索被阻断时，如实写「未能核实」并说明原因，`
      + `**绝不能因此判成假引用** —— 那会让用户去删掉一条真文献。`
      + `\n- **数据完整性只出「待核信号」，不下「造假」结论**（signal not verdict）。每条都要给出`
      + `「最可能的良性解释」和「你该去核哪份原始记录」。`
      + `\n- **不许只报喜**：没查出问题要说清"查了什么、都过了"；查不动的部分要说查不动，`
      + `不许把"我没看出问题"写成"没有问题"。`,
  },

  // ============ 文章润色 ============
  humanize: {
    primary: "humanize-academic",
    intakeTitle: "润色设置",
    intake: [
      { id: "docFiles", label: "待润色的稿件", type: "files", required: true,
        uploadText: "上传稿件", accept: ".docx / .pdf / .md" },
      { id: "goals", label: "润色目标", type: "multi", required: true, default: ["deai"],
        options: [{ v: "deai", t: "去除生成式文本痕迹（去 AI 味）" },
          { v: "language", t: "语言润色（语法 / 措辞 / 流畅度）" },
          { v: "style", t: "对齐目标期刊写作风格" },
          { v: "logic", t: "梳理段落逻辑与衔接" }] },
      // ★ 不能只挂在「对齐期刊风格」上：出 Word/PDF 的【排版】同样要期刊（render-docx --journal 预设）。
      //   实测一个"只想去 AI 味 + 出中华系列格式 Word"的用户，表单里没有任何地方能填期刊，
      //   模型只好在交付之后反问 —— 而那时稿子已经按通用送审格式排完了。
      { id: "journalName", label: "目标期刊", type: "text",
        whenAny: [{ field: "goals", has: "style" }, { field: "outFmt", ne: "md" }],
        placeholder: "填了会去查该刊稿约；查不到会如实说明，不凭印象编" },
      { id: "strength", label: "润色强度", type: "select", default: "standard", options: [
        { v: "light", t: "保守（只动明显问题）" }, { v: "standard", t: "标准（推荐）" },
        { v: "heavy", t: "激进（重写句式节奏）" }] },
      // ★ 别用「否定式标题 + 是/否」：那是双重否定（是=不改、否=可以改），实测医生要停下来想一遍。
      //   改成中性字段名 + 正向选项，选项文字自己把话说完。
      // pin：钉进模块前言、每轮都发。默认值传达不到时后果不可逆（替别人的论文改了统计学结论），
      // 而跳过表单那条路根本不生成任务卡 —— 只有前言能兜住。见 settingsLine 的说明。
      { id: "protectRefs", label: "带文献角标的句子怎么处理", type: "select", default: true, pin: true,
        options: [
          { v: true, t: "原句一字不动（推荐）",
            // ★ 这段话是【专门用来压住去 AI 味清单的】，不是设定的复述。实测两轮：只陈述设定时，
            //   模型把「Meta 分析明确指出…显著优于后者[2]」改成「提示…可能更具优势」，
            //   推理原文是"'充分证明'和'显著改善'是过度绝对，去绝对化"——它在照清单办事。
            //   所以必须点名"这些句子不适用去绝对化"，并给出替代动作（写进改动说明而不是改原句）。
            pinNote: "带 `[n]` 角标的**整句逐字保留**，包括「显著」「明确指出」「充分证明」这类看起来"
              + "「过度绝对」的措辞——那是原作者在**转述别人研究的结论**，去 AI 味清单里的"
              + "「去绝对化 / 按证据强度校准」**不适用于这些句子**，改一个「显著」就等于替别人的论文"
              + "改了统计学结论。觉得某句确实过度绝对，**写进改动说明提醒用户自己定**，不要动原句" },
          { v: false, t: "允许改写，改完自动重查引用",
            pinNote: "用户明确允许改写带角标的句子；改完必须跑一遍 `reference-check` 兜底" }],
        // ★ 措辞是踩出来的：原来写"保持引用处的文字原样不动"，AI 把"引用处"理解成【只有 [n] 这个编号】，
        //   于是 4 条带引用的句子全被改写 —— 其中「显著低于」→「低于」、「Meta 分析提示」→「显示」，
        //   等于替别人的论文改了统计学结论，投稿会被审稿人抓"引用失实"。标签必须说死是【整句】。
        help: "指含 [1][2] 角标的【整句话】，不只是角标本身 —— 这些句子在转述别人的结论，"
            + "改一个「显著」就变成了另一个意思。默认不动。关掉的话，润色后会自动把引用重新核一遍兜底。" },
      { id: "outFmt", label: "输出格式", type: "select", default: "docx", options: [
        { v: "md", t: "只要 Markdown" }, { v: "docx", t: "Word（.docx）" }, { v: "pdf", t: "PDF" }] },
      // ★ 这里【不能】用通用的 LANG。润色模块里"输出语言=中文"会被理解成"把我的英文稿翻成中文"，
      //   而那是不可逆的后果（拿回来一篇中文稿）。默认改成"保持原文语言"。
      // pin：同上。"改写成中文"是不可逆的——用户会拿回一篇被翻译过的稿子。
      { id: "lang", label: "润色后稿件用什么语言", type: "select", default: "keep", pin: true, options: [
        { v: "keep", t: "保持原文语言（推荐）" }, { v: "zh", t: "改写成中文" }, { v: "en", t: "改写成英文" }],
        help: "选「保持原文语言」只润色不翻译；选另外两个等于要求翻译改写，改动会大得多。" },
    ],
    steps: [
      // ★ 这一步是补的，别再合并回润色步。原来本模块【没有】读入原文这一步，agent 自己发挥，
      //   而它手边每条现成的路都丢图：裸 pandoc 不带 --extract-media（链接留着、文件没落盘）、
      //   pdf_to_md.py 写死 ignore_images=True、python-docx 的 paragraphs 里既没图也没表。
      //   丢了之后全链路无声：排版时 pandoc 只打一句 WARNING 就退 0，用户打开 Word 才发现图没了。
      // ★ emits 必须同时认两条路的产物：A 路（docx 就地改写）出 <原名>_para.md，
      //   B 路（pdf/md）才出 <原名>_src.md。只写 *_src.md 的话，Word 稿走 A 路时这一步
      //   永远不变绿 —— 用户看到"读入原文"一直是灰的，会以为它根本没读稿子。
      { id: "ingest", name: "读入原文", skill: "humanize-academic",
        deps: [],
        emits: ["*_para.md", "*_src.md"], render: "manuscript",
        // 脚本名要留着（有测试盯着它：不点名 ingest_doc.py，模型就会顺手用裸 pandoc 把图表抽丢）；
        // 但 hint 是【给用户看的】、前端 textContent 渲染，反引号会原样显示成 `xxx`，所以只去反引号。
        hint: "Word 稿用 docx_extract.py 抽成带编号的段落清单（就地改写用）；PDF / md 稿用 ingest_doc.py 抽，"
            + "别自己拿 pandoc / python-docx 抽——那几条路会把原稿的图和表丢掉",
        note: "B 路的脚本会报「抽出 图 N 张 / 表 M 张」，**把这个数记住**：它是润色后校验的基准，"
            + "也是交付时要跟用户对的账。A 路不需要这个数——图和表根本没离开过原文件。" },
      // ★ 必须含 *_humanized.docx：A 路就地改写的产物【本身就是 docx】，不写的话这一步不变绿，
      //   而下面的「排版出件」步（emits 里有 *_humanized.docx）会把它认走 ——
      //   于是界面显示成"润色没做、排版做了"，与事实正好相反。
      { id: "humanize", name: "润色改写", skill: "humanize-academic",
        deps: ["ingest"],
        emits: ["*_humanized.md", "humanized*.md", "*_humanized.docx"], render: "diff",
        // 同上：只去反引号，脚本名与动作照留（hint 走 textContent，反引号会原样显示给用户）
        hint: "Word 稿走就地改写：docx_apply.py 落 Word 修订，再跑 docx_verify.py 四道闸，原格式一个字节不动；"
            + "PDF / md 稿要把图与表原样搬进润色稿，改完跑 check_invariants.py 比对，图表丢失判 FAIL" },
      // ★ 不标 optional：本步只在【用户主动关掉引用保护】时才出现，存在即必做。
      //   标成可选时 pipelineLine 会往模块前言里写"引用兜底核查(可选)"，等于亲口告诉 AI 这步能跳 ——
      //   实测它就跳了：直接出 docx，事后才反问"要不要核查引用"。而这正是那个开关存在的唯一意义。
      { id: "refcheck", name: "引用兜底核查", skill: "reference-check", gate: true,
        deps: ["humanize"],
        when: { field: "protectRefs", eq: false },
        emits: ["refcheck_report.md", "reference_check*.md"], render: "refcheck", onFail: "humanize",
        hint: "必须核【润色后的稿件】而不是原稿——润色引入的引用漂移只有核新稿才看得出来；"
            + "本步没跑完不许进排版出件" },
      { id: "render", name: "排版出件", skill: "render-docx", skillAlias: ["render-pdf-doc"],
        deps: ["humanize"],
        optional: true, when: { field: "outFmt", ne: "md" },
        // ★ 必须含 *_humanized.*：render-docx 的输出名是「输入名.docx」，而本模块的输入叫
        //   humanized.md / draft_humanized.md → 输出 humanized.docx / draft_humanized.docx。
        //   只写 manuscript*/proposal*/review* 的话，这步在本模块永远不会变绿（用户看到
        //   "跑完了但进度条差一格"，以为排版没做）。
        emits: ["*_humanized.docx", "*_humanized.pdf", "humanized*.docx", "humanized*.pdf",
                "manuscript*.docx", "manuscript*.pdf"], render: "doc" },
    ],
    extra: ["render-pdf-doc"],
    ui: "reader",
    reader: {
      intro: {
        title: "文章润色",
        lead: "上传一份稿件，按期刊写作范式优化行文逻辑与专业表述，消除生成式文本痕迹。改完能逐条看它动了什么、为什么动，不同意的可以让它回退。",
        dropTitle: "点击或拖拽稿件到此处",
        dropHint: "支持 Word / PDF / Markdown（.docx · .pdf · .md）　·　一次一份",
        startText: "上传并进入",
        chips: [{ t: "去 AI 味", i: "wand" }, { t: "语言润色", i: "wand" }, { t: "逻辑衔接", i: "doc" }, { t: "图表原样保留", i: "image" }, { t: "改动逐条可查", i: "diff" }, { t: "整篇翻译不动排版", i: "translate" }],
        tip: "数字、统计量与结论强度一律不动——「显著低于」不会被改成「低于」。<br>带 [n] 角标的整句默认逐字保留：那是在转述别人的结论，改一个词就变成了另一个意思。<br>原稿里的图和表会原样带进润色稿，交付时按「几张图、几张表」跟你对账。",
      },
      source: { kind: "doc", field: "docFiles", accept: ".docx,.pdf,.md,.doc,.txt", exts: ["docx", "pdf", "md", "doc", "txt"] },
      first: "polish",
      // protectRefs / lang 都是 pin:true —— 它们进齿轮弹层，改完立刻回写 _workflow.json，
      // 于是 settingsLine 每一轮都把它们钉进前言（这条路是踩出来的，见 protectRefs 的注释）。
      settings: ["goals", "strength", "protectRefs", "journalName", "outFmt", "lang"],
      chat: { placeholder: "对着这份稿子随便问，例如：把讨论第二段再改一版",
        firstTurn: "我上传了一份稿件 {doc}，请先读它再回答。我的问题是：" },
      modes: HUMANIZE_MODES,
    },
    flow: `\n- **本模块 = 润色【用户上传的这一份稿件】**，不替他写新内容、不做统计、不查文献真伪`
      + `（除非他关掉了引用保护，那时润色完要跑一遍 \`reference-check\` 兜底）。`
      + `\n- **改写的底线，优先级高于任何润色目标**：数字、单位、统计量、样本量、p 值、置信区间一律不动；`
      + `结论的**强度**不许变（「显著低于」↛「低于」，「证实」↛「提示」）；`
      + `带 \`[n]\` 角标的整句按用户的设定处理（默认逐字保留）。`
      // ★ 第一条铁律是【按格式分流】，别再改回"一律先 ingest_doc.py"。
      //   这里踩过一次：模式提示词已经改成 .docx 走就地改写了，但本前言仍无条件写着
      //   "第一步先用 ingest_doc.py 读入原文" —— 前言是模块的常驻指令、每轮都注入，
      //   于是模型照前言执行，Word 稿照旧被抽成 markdown，用户拿回来的还是重排过的文件。
      //   模式提示词管不住前言，两边必须同时改。
      + `\n- **第一步先看稿件格式，按格式分流**：`
      + `\n  · **\`.docx\` → 就地改写（A 路，默认）**：`
      + `\`.venv/bin/python .opencode/skills/humanize-academic/scripts/docx_extract.py <稿件>\` `
      + `得到 \`<原名>_para.md\`（每行 \`[[p0007]] 正文\`），逐行改写成 \`<原名>_edited.md\`，`
      + `再用 \`docx_apply.py <稿件> <原名>_edited.md -o <原名>_humanized.docx --track-changes\` 写回，`
      + `最后 \`docx_verify.py\` 四道闸。**这条路只改文字、不重建文件**，所以用户的排版、`
      + `表格合并单元格、EndNote 引文域、页眉页脚、图表全都不会动 —— 也就【不存在】搬运图表这回事。`
      + `**做完不要再跑 render-docx**，那会把刚保住的格式换掉。`
      + `\n  · **\`.pdf\` / \`.md\` → markdown（B 路）**：这些格式没有可回填的结构，只能重排。`
      // ★ 下面这几行是"润色完图表就没了"那个 bug 的正面修复，别删。B 路三层缺一层就会重新静默丢图：
      //   ①入口不抽媒体 → ②整篇重写时漏掉那几行 → ③排版时 pandoc 只警告不报错。
      + `走 \`ingest_doc.py <稿件>\`，它会把图抽到 \`<稿件名>_files/\`、把表转成 pipe 表，`
      + `并报出「图 N 张 / 表 M 张」。**别自己拿 pandoc 或 python-docx 抽文本**：`
      + `不带 \`--extract-media\` 的 pandoc 会留下指向空气的图片链接，python-docx 则连表都取不到。`
      + `\n- **B 路改写时**，\`![alt](路径)\` 整行照抄（连 \`{width=... height=...}\` 都不要动）、`
      + `pipe 表整块照抄；图题表题的措辞可以润色，但**序号不许动**。改完必须跑 \`check_invariants.py\` `
      + `比对原稿与润色稿，**它对图表丢失打 \`[FAIL]\`——没补回去不许进排版出件**。`
      + readerModeLines(HUMANIZE_MODES)
      + `\n- **改了什么必须能说清楚**：用户会点「改动对照」逐条看。凡是你动了数字 / 单位 / 结论强度的地方，`
      + `主动拎到最前面标出来 —— 那本来就不该发生，藏起来比改错本身更糟。`
      + `\n- **不要替校验脚本夸大结论**：不变量校验只比对数字与角标这些「集合」，查不出「显著低于→低于」`
      + `这种措辞漂移。校验通过只能说「数字与角标未变」，**不许说成「内容未改」**。`,
  },

  // ============ 科研作图（文生图示意图）============
  // 【与「数据统计与分析」的分界，这是本模块最容易被用错的地方】
  //   图上的形状由【数字】决定 → `nature-figure`（在 stats / paper 模块里，出 300dpi + 矢量，可投稿）；
  //   由【生物学关系】决定、根本没有数据 → 本模块（文生图，出 AI 位图）。
  //   派错技能是这类需求最常见的浪费，所以这条边界在模块简介、intake 的 notice、步骤 note 三处
  //   都写了一遍 —— 用户在进来前、动手前、拿到图时各有一次机会发现自己走错了门。
  // 【为什么用通用壳而不是阅读器壳】阅读器壳的前提是"左边常驻用户传上来的那份东西"，
  //   而本模块【不要求任何上传】：用户打字描述 → 出图。硬套阅读器壳的结果是首屏卡在一个
  //   传不了也跳不过的上传区。通用壳（表单 → 步骤条 → 对话流）正好：图作为产物由
  //   rendererFor→"figure" 渲染成缩略图卡片，正文里的 `![](figures/fig1.png)` 也会被直接渲染。
  figure: {
    primary: "mechanism-figure",
    intakeTitle: "作图设置",
    intakeSub: "描述你要画的机制或流程，不用传数据",
    // notice 渲染在表单卡【顶部】：这几条必须在他动手【之前】看到。出完图才说"这图不能投稿"，
    // 那张图已经白出了 —— 而且实打实扣掉了他当天的生图张数（按档位限量，见 mechanism-figure 技能）。
    notice: "这里出的是 **AI 生成的位图示意图**（不是矢量图），适合组会汇报、标书插图与投稿前的构思稿。"
      + "多数期刊对生成式 AI 制图有限制（Nature 系基本禁止入稿，Cell Press / Elsevier 要求披露），"
      + "投稿终稿建议照它给出的规格在 BioRender / Illustrator 里重绘成矢量图。"
      + "另外，生图模型写字不可靠，图上的英文标签**必然有一部分被画错或画糊**，出图后要逐个核 —— "
      + "这一步会替你列成清单。由数值画出来的统计图（森林图 / KM 曲线 / 火山图 / ROC）不归这里，"
      + "请到「数据统计与分析」模块。",
    intake: [
      { id: "desc", label: "要画什么", type: "textarea", required: true,
        placeholder: "把机制或流程按【步骤】讲清楚：分几步，每一步在哪里发生、有哪些分子或结构参与、"
          + "谁激活谁、谁抑制谁，最后的结局是什么。\n"
          + "例：① 高草酸尿使肾小管上皮细胞发生 ER 应激，PERK-ATF4 通路激活；"
          + "② ATF4 上调 CHAC1，降解 GSH；③ GSH 耗竭使 GPX4 失活，脂质过氧化累积、发生铁死亡；"
          + "④ 死亡的上皮细胞成为草酸钙结晶的黏附位点。",
        // ★ 反编造闸的用户侧说明。技能里 build_prompt.py 会拿这段描述（或上传的稿件）逐个核对图上的
        //   实体标签，找不到就中止 —— 这不是"画得不够好看"，是刻意的：给每张图补一个用户没测的
        //   经典通路成员，就是在图里编数据，而审稿人一眼能看出来。
        // help 是【纯文本】渲染的（前端不过 markdown），写 **粗体** 会原样显示成两个星号
        help: "写得越具体，图越准。只写你材料里真有的分子 —— 图上每一个名字都会被逐个核对，"
            + "缺的那一环宁可不画，也不会替你补一个经典通路成员上去。" },
      // 【删掉了原来的「画哪一类」】它和「画风」讲的是同一件事的两半，而"通路图 / 技术路线图 /
      // 图形摘要"这层意思已经由左卡那排「快捷模板」表达了（点一下就把该体裁的描述填进去）。
      // 两个下拉并排问"画哪一类"和"什么画风"，实测用户要停下来想它们的区别。
      { id: "style", label: "画风", type: "select", default: "flat", options: [
        { v: "flat", t: "扁平学术风（推荐）" },
        { v: "realistic", t: "高拟真 3D" },
        { v: "structure", t: "结构生物学风" }] },
      // 画幅五档【必须与 render_figure.py 的 SIZES 表逐字对齐】：那边认不出的比例会回落成
      // 默认方图，而界面上仍显示用户选的 9:16 —— 出来一张方图，没人看得出是哪里错了。
      { id: "ratio", label: "画幅", type: "select", default: "1:1", options: [
        { v: "1:1", t: "方图 1:1" }, { v: "16:9", t: "横图 16:9" },
        { v: "9:16", t: "竖图 9:16" }, { v: "4:3", t: "横图 4:3" }, { v: "3:4", t: "竖图 3:4" }] },
      // 标签里不用再写「（可选）」：非必填字段前端自动挂一枚「选填」角标，写了就是「（可选）选填」
      { id: "srcFiles", label: "你的稿件 / 摘要", type: "files",
        uploadText: "上传材料", accept: ".md / .docx / .pdf / .txt",
        // 传了才谈得上"逐字核对"：不传的话闸只能拿表单里那段描述当依据，覆盖面小得多。
        help: "传了就用它做核对依据：图上出现的分子名必须能在材料里找到，找不到就会停下来问你，"
            + "而不是照画。图片型扫描件会先走 OCR。" },
      { id: "n", label: "出几张候选", type: "select", default: "2", options: [
        { v: "1", t: "1 张" }, { v: "2", t: "2 张（推荐）" }, { v: "3", t: "3 张" }],
        help: "构图有随机性，同一份提示词两张图可能一张规整一张翻车。每张都计入你当天的生图张数。" },
      // pin：用途决定要不要去查期刊政策，而这件事漏掉的后果是用户拿一张不能用的图去投稿。
      // 跳过表单那条路不生成任务卡，只有前言兜得住（见 settingsLine 的说明）。
      { id: "usage", label: "这张图拿去做什么", type: "select", default: "meeting", pin: true, options: [
        { v: "meeting", t: "组会 / 答辩汇报",
          pinNote: "汇报场景，AI 生图限制不适用，出完图把标签必核清单过一遍即可" },
        { v: "grant", t: "标书插图",
          pinNote: "标书不投期刊，AI 生图限制不适用 —— 这是本技能最合适的场景，不用反复提醒期刊政策" },
        { v: "paper", t: "论文配图（要投稿）",
          // 实测的反面：模型会顺口说一句"多数期刊允许披露后使用"就把图交了。那是替期刊编政策。
          pinNote: "**交付前必须先查目标期刊的 Instructions for Authors 里关于 generative AI images 的规定"
            + "并如实转述（禁用 / 需披露 / 需许可），查不到就说查不到，绝不许凭印象替期刊编一条政策**；"
            + "同时给一份可交给美编的重绘规格（栏数与顺序、每栏实体、每条箭头的起止与类型、配色、字号），"
            + "让用户在 BioRender / Illustrator 里落成矢量图" }] },
      { id: "journalName", label: "目标期刊", type: "text", when: { field: "usage", eq: "paper" },
        placeholder: "填了会去查该刊稿约；查不到会如实说明，不凭印象编" },
    ],
    steps: [
      { id: "spec", name: "作图方案", skill: "mechanism-figure",
        deps: [],
        emits: ["*.spec.json", "*.prompt.txt"], render: "report",
        hint: "栏数按机制的真实步数来（1–6 栏），每栏 ≤ 8 个标签、全图 ≤ 24",
        note: "spec 由你自己读懂用户的描述来填，**不要再去调一个「提示词改写模型」** —— 那一步只会顺手"
            + "把用户没提的经典通路成员补进来。三条硬规矩：**栏数按机制真实步数来（1–6 栏），"
            + "不要为了凑版面编内容**；每栏 ≤ 8 个标签、全图 ≤ 24（超了就拆成两张图，不是缩字号）；"
            + "`labels` 只写实体名，关系写进 `arrows[].label`。"
            + "**用户传了材料就必须带 `--source` 过反编造闸**，被拦下来照报错改 spec（中文全称对国际缩写"
            + "用 `--allow` 显式声明；确实没测的分子直接删掉），不要绕开它。" },
      { id: "draw", name: "生成图", skill: "mechanism-figure",
        deps: ["spec"],
        // *.built.json 也收：技能约定它是「明天重跑用同一份」的关键中间件（同一份 spec 复现出图），
        // 不收的话它只作为无名附件出现，用户不知道那是能拿来复现的东西。.meta.json 都收了，它更该收。
        emits: ["figures/*.png", "fig*.png", "figures/*.meta.json", "*.built.json", "figures/*.built.json"], render: "figure",
        hint: "先 --dry-run 看要发什么（不花钱），再按候选张数出图",
        note: "图写进 `figures/`，用 `fig1.png` 这类约定名；`.meta.json`（模型、完整 prompt、负面词、"
            + "标签清单、AI 披露说明）跟着一起留下，半年后要改版全靠它。"
            + "**出完在回答里用 `![图注](figures/fig1.png)` 把图贴出来**，界面会直接渲染，"
            + "别只报一句「图已生成」让用户自己去产出栏翻。"
            + "遇到 `今天的生图张数已用完（N/M 张）`：**那不是故障，不要重试**，按档位每天 0 点(UTC) 重置，"
            + "提示词已经做好了，如实告诉用户明天拿同一份 `.built.json` 重跑即可。" },
      { id: "check", name: "标签核对", skill: "mechanism-figure",
        deps: ["draw"],
        emits: ["figure_check.md"], render: "report",
        hint: "生图模型必然拼错一部分标签，逐个核是必做步骤，不是可选建议",
        note: "照脚本输出的必核清单**逐条核对**，把哪些标签画对了、哪些画错 / 画糊 / 画漏如实写进"
            + "`figure_check.md` 并报给用户 —— **不许只说一句「图已生成」**。发现错字只能改 spec 重出，"
            + "**不要手动 PS 掉**，那正是各刊明令禁止的图像操作。"
            + "同时把这张图的性质讲清楚：AI 生成的位图、不是矢量、不能直接当投稿终稿。" },
    ],
    // ocr：用户传的材料是图片型扫描件时（标书评审意见、翻拍的机制图）唯一的出路。
    // 【刻意不含 nature-figure】用户要的是由数值画出来的统计图时，正确做法是把他指到
    // 「数据统计与分析」模块去（那里有数据表、有变量对应面板），而不是在这里硬画一张。
    extra: ["ocr"],

    // ---- 生成器界面（web/figure.html）----
    // 【为什么另起一个壳，而不是用通用表单或阅读器壳】
    //   通用壳是「填一张表 → 一条对话流」，而出图是【写一句 → 看一张图 → 改一句再来一版】，
    //   最该占版面的是图本身；阅读器壳的前提又正好相反 —— 它左边常驻的是【用户传上来的】那份
    //   东西，而这个模块根本不要求上传。所以给它一个自己的两栏生成器：左边写提示词，右边调
    //   出图设置，出完图在同一页看图、追问、再来一版。
    // 【前端仍然只是渲染器】下面这份 gen 配置由 /api/modules/figure/workflow 整份下发，
    //   figure.html 不认识任何一句具体文案 —— 改模板、改措辞、加一档画幅都只动这里。
    //   （代价要认：figure.html 归「界面包」热更，本文件是 .mjs，改它必须重发安装包。
    //    所以经常要动的文案宁可放这儿一次性想好，也别为了图快写死进 html。）
    ui: "figure",
    gen: {
      intro: {
        eyebrow: "AI 生图 · 面向组会汇报与标书插图",
        title: "科研作图",
        lead: "用一段文字描述机制、通路或技术路线，直接生成示意图与图形摘要。不用传数据，也不用会画图。",
      },
      // 右卡按这个顺序把 intake 字段画成一排排 pill（值域来自各字段的 options）
      pills: ["ratio", "style", "n", "usage"],
      // 条件字段：when 成立时才出现（目标期刊只在「论文配图」时问）
      extraFields: ["journalName"],
      promptField: "desc",
      uploadField: "srcFiles",
      // 【不设「快捷模板」chips】按用户 2026-08-08 的要求去掉：一排预置的通路名（PI3K/AKT、
      // PD-1/PD-L1…）看着省事，实际是在替他挑内容 —— 点一下就把一整段【不是他研究的】机制填进
      // 提示词框，而这个模块的头号铁律恰恰是"图上每个分子名都必须来自用户自己的材料"。
      // 提示词框的 placeholder 里已经有一个写到什么颗粒度的范例，那个够了。
      // 【生成条上方的两段提示已按用户 2026-08-09 的要求删掉】原来那里有「出的是 AI 生成的位图 /
      // 期刊政策」与「要画森林图请去数据统计」两段横幅，占掉小半屏，而首屏本该让人一眼看到
      // "在哪写字、在哪点生成"。这两件事并没有丢，只是换了个更该说的时机：
      //   · AI 位图 / 不是矢量 / 不能当投稿终稿 → steps.check 的 note 要求出图后【连着必核清单一起讲】；
      //     选了「论文配图（要投稿）」时，usage 的 pinNote 还会强制去查目标期刊的 AI 制图政策。
      //   · 数据图不归这里 → 模块卡片的简介里写着，且技能集里刻意不含 nature-figure（真让它画
      //     统计图会被模块闸拦下并指路）。
      // 所以别再往这个页面上加横幅了；要提醒就加在【出图之后】那一步的 note 里。
      // 发给模型的那一段。{desc}/{ratio}/{n}/{style}/{src} 由前端替换；没值的整句删掉。
      // 模块前言里已经有三步的详细规矩（steps[].note），这里只交代"这一次要画什么、什么设置"。
      prompt: "请用 `mechanism-figure` 技能画一张机制示意图。\n\n**要画的内容（只依据这一段，我没提的分子一个都不许补）**：\n{desc}\n\n"
        + "出图设置：画幅 {ratio}，画风 {style}，出 {n} 张候选。{src}\n\n"
        + "按技能的三步走：① 你自己读懂上面这段话填 spec（栏数按真实步数，1–6 栏；每栏 ≤ 8 个标签、全图 ≤ 24）；"
        + "② `build_prompt.py` 编译并过反编造闸；③ `render_figure.py --outdir figures --n {n}` 出图。\n"
        + "出完在回答里用 `![图注](figures/fig1.png)` 把图贴出来，再逐条走必核清单，"
        + "把画错 / 画糊 / 画漏的标签如实告诉我，并写进 `figure_check.md`。",
      srcLine: "核对材料：{files}（图上出现的名字必须能在这里面找到，`build_prompt.py` 记得带 `--source`）。",
      followPlaceholder: "接着说，例如：第 3 栏太挤了，把 GSH 那条拆出去再来一版",
      // 追问时的前缀：让模型知道这是"改上一版"，别从头再走一遍三步（也别再重填一份 spec）。
      followPrefix: "接着改上一版的图（沿用同一份 spec，只改我说的地方，然后重新出图）：",
    },
  },
}

// ---- 派生：技能白名单 ----
// 模块的技能集 = steps 的 skill（含 skillAlias）∪ extra。MODULE_DEFS.skills 由它展开，不再手写。
//
// ★ skillAlias：一格流程条里实际会调起【不止一个】技能时用（如基金申报的「选题遴选」＝
//   topic-selection + novelty-check）。合并步骤时最容易漏的就是这里 —— 副技能不在白名单里，
//   agent 一调它就撞模块闸、整轮作废，而界面上什么异常都看不出来。
export function skillsOf(mod) {
  const w = WORKFLOWS[mod]
  if (!w) return null
  return [...new Set([...w.steps.flatMap((s) => [s.skill, ...(s.skillAlias || [])]), ...(w.extra || [])])]
}
export const primaryOf = (mod) => WORKFLOWS[mod]?.primary || null

/**
 * 把 intake 里声明的 default 回填进表单值。
 *
 * 【为什么必须有】默认值此前【只】在前端建卡时播种（index.html 的 buildFormCard）。
 * 而"跳过表单直接打字"是设计上允许、且实测最常见的路径 —— 那条路根本不经过前端表单，
 * 于是服务端拿到的是 `{}`，所有 when 条件按"字段未填"求值：
 *   · refcheck：三个步骤的 when 全部不成立 → stepsFor 回【空数组】→ 步骤条一片空白、
 *     pipelineLine/artifactLine 退化成空串、三道闸一道都没排上 → 这一轮实际上【没有任何闸】。
 *   · humanize：protectRefs 默认"带角标整句一字不动"这条保护【压根没进上下文】，
 *     模型只能自己猜要不要改别人论文里的"显著低于"。
 * 两处都是哑失败：界面看不出少了东西，用户以为流程照常走完了。
 *
 * 只填 undefined，绝不覆盖用户的显式选择 —— protectRefs 的默认是 true，
 * 用 `||` 之类的写法会把用户特意选的 false 又翻回 true。
 */
export function withDefaults(mod, values = {}) {
  const w = WORKFLOWS[mod]
  if (!w) return values || {}
  const out = { ...(values || {}) }
  for (const f of w.intake || []) {
    if (f.default === undefined) continue
    const v = out[f.id]
    // 空数组 / null 也算"没填"。多选题的值是数组，`checks: []`（用户把默认勾选全取消）
    // 与 `checks` 缺失在语义上是一回事，而只判 undefined 会让前者继续退化成零步骤。
    const blank = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)
    if (!blank) continue
    out[f.id] = Array.isArray(f.default) ? [...f.default] : f.default
  }
  return out
}

/**
 * 「本次生效的关键设定」——钉进模块前言，每一轮都跟着走。
 *
 * 【为什么不能只靠任务卡】任务卡只在【第一条消息】里出现一次，而前言是每轮重新注入的
 * （server.mjs 的 startJob(sid, preamble + q, modId)）。更要命的是「跳过表单」这条路
 * 压根不调 /api/workflow/form —— 任务卡根本不存在，无论怎么改 taskCard 都到不了模型。
 * 实测后果：humanize 的 protectRefs 默认「带角标的整句一字不动」传达不到，模型自行把
 * 「Meta 分析明确指出…显著优于后者[2]」改成了「存在优势」—— 替别人的论文改了统计学结论。
 * 上一轮它碰巧扛住了，这一轮没扛住，说明一直在靠运气。
 *
 * 只渲染打了 `pin: true` 的字段：这类字段的共同点是**默认值一旦没传达，后果不可逆**
 * （改了内容、翻译了语言）。别一次性铺开——每加一个都该有实测证据。
 */
export function settingsLine(mod, rawValues) {
  const w = WORKFLOWS[mod]
  if (!w) return ""
  const values = withDefaults(mod, rawValues)
  const parts = []
  for (const f of w.intake || []) {
    if (!f.pin || !visible(f, values)) continue
    const s = fmtVal(f, values[f.id])
    if (s === null) continue
    // ★ 光说"设定是什么"不管用，必须把【优先级】和【具体不许怎么做】一起说。
    //   实测：只写"带角标的句子怎么处理＝原句一字不动"，模型照样把
    //   「Meta 分析明确指出…显著优于后者[2]」改成「提示…可能更具优势」——
    //   它的推理原文是"「充分证明」和「显著改善」是过度绝对，去绝对化"，
    //   也就是它在执行 humanize-academic 的【去 AI 味清单】。两条规则打架时具体的清单赢了。
    //   所以 pinNote 要直接压在那条清单上，而不是再重复一遍设定。
    const note = (f.options || []).find((o) => o.v === values[f.id])?.pinNote
    parts.push(`**${f.label}＝${s}**${note ? "。" + note : ""}`)
  }
  if (!parts.length) return ""
  return `\n- **【本次生效的关键设定，优先级高于技能文档里的一般规则】**（用户没改就是默认值，同样作数；`
    + `用户跳过表单时也照样生效，不要因为"他没明说"就自行其是）：${parts.join("　")}`
}

// ---- 派生：按 intake 值裁剪出本次实际要走的步骤 ----
// when 不成立的整步剔除；first 成立的步骤提到最前（前瞻性研究的预注册锁）。
export function stepsFor(mod, rawValues = {}) {
  const w = WORKFLOWS[mod]
  if (!w) return []
  const values = withDefaults(mod, rawValues)
  const keep = w.steps.filter((s) => visible(s, values))
  const head = [], rest = []
  for (const s of keep) (condOk(s.first, values) && s.first ? head : rest).push(s)
  return [...head, ...rest]
}

// ---- 派生：一段历史消息属于哪一步（前端把对话按步骤分组回显时用）----
// 【为什么要在服务端算】步骤归属藏在消息的 tool part 里，而 /api/history 只回文本；
//   前端刷新后拿不到这些 part，只能得到一条没有段落的流水。直播时前端是靠 SSE 的 skill 事件
//   分的组（index.html 的 markStepBySkill），这里必须用【同一套口径】重放 —— 否则同一段对话
//   "刷新前按步骤分了组、刷新后糊成一片"。
// 【纯函数】不碰 IO，回归测试见 test/workflow.test.mjs。

/**
 * 一条消息调了哪些技能 → 它属于哪一步。
 * 口径：取消息里【第一个】认得出步骤的技能。一轮可能横跨两步（agent 会合并步骤），而界面上
 *   一个回合是一个不可分割的框，只能整体归给一步；前端也是"本轮第一个说了算"，两边必须一致。
 * 同一技能对应多步时（综述的"筛选"与"成文"都用 literature-review）取【还没用过的】那一步，
 *   与前端 markStepBySkill 的"取第一个还没完成的"同序。用过的记进 seen（调用方持有，跨消息累积）。
 * @param parts 消息的 parts 数组
 * @param steps stepsFor() 的结果（已按表单裁剪）
 * @param seen  Set<stepId>，被本函数就地更新
 * @returns 命中的 step 对象；认不出回 null
 */
export function stepOfParts(parts, steps, seen) {
  if (!steps?.length) return null
  for (const p of parts || []) {
    if (p?.type !== "tool" || p.tool !== "skill") continue
    const sk = p.state?.input?.name        // 技能名的取法与直播那条一致（server.mjs 的 broadcast("tool")）
    if (!sk) continue
    // skillAlias 也要认：合并出来的步骤（如「选题遴选」）一格里会调两个技能，
    // 只认主技能的话，副技能那一轮的对话会掉出所有分组，回放时糊成一片。
    const own = (s) => s.skill === sk || (s.skillAlias || []).includes(sk)
    const hit = steps.find((s) => own(s) && !seen.has(s.id)) || steps.find(own)
    if (hit) { seen.add(hit.id); return hit }
  }
  return null
}

/**
 * 用户的提问归到它【引出的】那一步（紧随其后那条助手消息的步骤），而不是上一步。
 * 【为什么】直播时分组是在这一轮开跑之后才识别出来的，前端会把提问气泡一起收进新分组
 * （index.html 的 absorbTail）。不做这一步，刷新后每个步骤框都从"AI 已经开口"的中间开始，
 * 用户的提问被留在上一步的框里，读起来像张冠李戴。就地修改并返回同一个数组。
 */
export function fillUserSteps(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue
    const nx = msgs[i + 1]
    if (nx?.role === "assistant" && nx.step) { msgs[i].step = nx.step; msgs[i].stepName = nx.stepName }
  }
  return msgs
}

// ---- 产物 → 渲染器 ----
// 认产物文件名，不要求 agent 输出 JSON（模型格式会漂，脆）。认不出的返回 null，
// 由前端按既有逻辑当普通产物展示 —— 绝不能因为"没匹配上渲染器"就把文件藏起来。
// 编译结果缓存：产物分级会拿每个文件去比一遍全部 emits（一次打包可能是几千个文件 × 几十条
// glob），不缓存就是十万次 RegExp 编译。glob 集合是有限且固定的，缓存永远不会涨。
const _globCache = new Map()
const globRe = (g) => {
  let re = _globCache.get(g)
  if (!re) { re = new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$", "i"); _globCache.set(g, re) }
  return re
}
/**
 * emits 里的 glob 是否匹配某个产物路径。
 * 产物路径可能带一层子目录（"pdfs/a.pdf"、"figures/fig1.png"），而 emits 里既有裸名（"table1.csv"）
 * 也有带目录的（"pdfs/*"、"audit/*"）。规则：glob 里带 "/" 就整条比；不带就只比最后一段
 * —— 否则 "fig*.png" 永远匹配不上 agent 写进 figures/ 的图，进度会卡住不动。
 */
export function globMatch(glob, name) {
  if (!glob || !name) return false
  const re = globRe(glob)
  if (glob.includes("/")) return re.test(String(name))
  return re.test(String(name).split("/").pop())
}
/** 脱敏还原表（真实姓名/住院号 ↔ 假名）的文件名判据 —— **只有一份定义**。
 *
 * ★ 原来这套判据散在三处且互不相同：server.mjs 的 dirState 只排 `*_mapping.csv`，
 *   本文件的 RENDER_RULES 与 index.html 的 isSecret 收的是下面这一整组。结果是
 *   **纵深防御只挡住了六分之一**：deid_crosswalk.csv / 姓名对照表.csv / patient_keyfile.csv
 *   照常出现在"产出"侧栏、可一键下载 —— 而它们第一列就是真实姓名与住院号。
 *   现在 dirState 也引这一份（server.mjs 用 WF.isSecretName）。
 */
export const SECRET_GLOBS = ["*mapping*.csv", "*_map.csv", "*crosswalk*.csv", "*对照表*.csv", "*还原表*.csv", "*keyfile*.csv"]
export const isSecretName = (name) => SECRET_GLOBS.some((g) => globMatch(g, String(name)))

// ---- 产物分级：主产物 / 中间文件 ----
//
// 【要解决的问题】产出侧栏此前是把工作目录整棵树平铺出来，没有任何"主/副"之分：一次成稿
// 十几个中间 md、几个临时 py、一堆抽出来的正文 txt，和真正要交付的 docx 摆在同一个平面上，
// 交付物被淹掉。（用户原话：副产物太多、界面也不区分。）
//
// 【判据为什么用 emits】每个 step 的 `emits` 本来就是"这一步该交出什么"的契约，已经喂着
// 任务卡、步骤条、产物渲染器三处 —— 侧栏再用它，就是同一份事实第四次复用：以后加模块只要
// 把 emits 写对，侧栏自动就对，不需要再维护第二张"什么算主产物"的表（那种表必然漂）。
//
// 【兜底与取舍】emits 不可能写全（模型常写出契约之外的合理产物），所以两条兜底：
//   · 成品扩展名（docx/pdf/xlsx/pptx/图）即使没命中 emits 也算主产物 —— 宁可多留一个在主区，
//     也不要把用户真正要的 Word 折叠起来；
//   · 反过来，脚本 / 日志 / json 这类【确定的中间态】即使命中了 emits 也算副产物。
// 代价：契约之外的 .md / .csv 会被折进"中间文件"。这是有意的取舍 —— 折叠块带着计数、点一下
// 就展开，没有任何东西被隐藏；而不折的话，侧栏就还是今天这个样子。
//
// 【chat 没有契约】自由对话没有 steps，用它兜底会把一切 .md 都判成副产物 —— 那是最不该收窄的
// 模块。所以无契约时只把"确定的中间态"判为副，其余一律主（≈ 保持它今天的样子）。
//
// 【为什么按目录降级、而不是按扩展名】ppt-master 一次 8 页 PPT 会写出 24 个 SVG
//（svg_output/ 草稿、svg_final/ 定稿、backup/<时间戳>/ 整份副本），外加素材 png。
// 它们全都命中"成品扩展名"兜底，于是 24 个中间 SVG 和唯一那份 .pptx 并排站在主区。
// 但 svg/png **不能**从 DELIVERABLE_EXT 里删——figure 模块的交付物本来就是 svg/png。
// 所以降级判据放在目录上：svg_output / svg_final / backup / … 这些名字本身就说明了
// "这里面装的是中间态"，而 figure 模块的图落在 figures/ 与根目录，不受影响。
const BULK_DIRS = /^(pdfs|zotero_lib|library_texts|audit|figures_src|tmp|temp|svg_output|svg_final|backup|analysis|sources|templates|icons|images|notes)$/i
const DELIVERABLE_EXT = /\.(docx?|pdf|xlsx?|xlsm|pptx?|png|jpe?g|svg|tiff?|eps|zip)$/i
const SCRATCH_EXT = /\.(py|log|sh|ps1|bat|cmd|ipynb|json|tmp|bak|lock)$/i
/**
 * 一个产物该进主区还是"中间文件"折叠块。
 * @param modId  会话绑定的模块（chat / 未知 = 无契约）
 * @param values 该会话的表单值（决定哪些步骤在场；拿不到就按全部步骤算，宁可宽）
 * @param name   相对产物目录的路径，可含子目录（"figures/fig1.png"）
 * @returns "main" | "aux"
 */
export function artifactKind(modId, values, name) {
  const s = String(name || "").replace(/\\/g, "/")
  if (!s) return "aux"
  const segs = s.split("/")
  const base = segs[segs.length - 1]
  // 成批素材目录（下载来的全文、抽出来的正文、自查中间件）永远是副产物，
  // 哪怕某一步把它写进了 emits（library_texts/* 与 audit/* 正是这种情况）。
  //
  // ★ 判**任意一段**，不是只判第一段。原来只看 s.split("/")[0]，而 ppt-master 把一切都放在
  //   `<项目名>/` 底下（`稿件/svg_output/page-01.svg`），于是这些目录名一个都匹配不到，
  //   降级规则整个失效。backup/<时间戳>/svg_output/ 这种嵌套副本同理，只有逐段比才拦得住。
  if (segs.slice(0, -1).some((d) => BULK_DIRS.test(d))) return "aux"
  if (SCRATCH_EXT.test(base)) return "aux"
  const w = WORKFLOWS[modId]
  if (!w) {
    if (DELIVERABLE_EXT.test(base)) return "main"
    if (/\.(txt|tsv)$/i.test(base)) return "aux"
    // 无契约时"其余一律主"只对【根目录】成立。技能自己开的工作目录（ppt-master 的
    // `<项目名>/design_spec.md`、`spec_lock.md`）是它的施工现场，不是交到用户手上的东西——
    // 而根目录那一层才是它主动摆出来的成果。仍是按目录判，没有第二张"什么算主产物"的名字表。
    return segs.length > 1 ? "aux" : "main"
  }
  const steps = values ? stepsFor(modId, values) : w.steps
  for (const st of steps) for (const g of st.emits || []) if (globMatch(g, s)) return "main"
  return DELIVERABLE_EXT.test(base) ? "main" : "aux"
}

// ---- 聊天接入（微信 / 企微）该把哪些产物真的推给用户 ----
//
// 【为什么要单独一层】界面侧栏是"列出来"，聊天是"推过去"：侧栏把中间文件折叠起来即可，
// 聊天里每一个文件都是一条到手机上的消息。此前 oc-wrap 的兜底补发只按扩展名排掉 py/log/tmp，
// 于是一次成稿会把十几个中间 md、抽出来的 txt、下载的全文 PDF 一并轰给用户（用户反馈的正是这个），
// 还会把脱敏还原表（真名 ↔ 假名）推出微信——那是不可逆的泄露。
//
// 【判据不另立一套】主/副仍以 artifactKind（各步 emits 契约）为准，这里只加聊天特有的三条排除：
// 用户自己刚上传的 uploads\、网关簿子、PHI 还原表；再按"成品优先"排个序、限个条数。
const CHAT_SKIP_NAMES = new Set(["_workflow.json", "_lasterror.json", "AGENTS.md", "OPENCODE.md"])
/** 这个产物能不能推进聊天。name = 相对会话目录的路径（可含子目录），大小/条数上限由调用方管。 */
export function chatSendable(modId, values, name) {
  const rel = String(name || "").replace(/\\/g, "/").replace(/^\.\//, "")
  if (!rel || rel.startsWith("../")) return false
  const segs = rel.split("/")
  if (segs.some((s) => s.startsWith("."))) return false      // .cc-connect\ .private\ .preview\ 等
  if (segs[0].toLowerCase() === "uploads") return false        // 用户自己刚发来的文件，不回发给他
  const base = segs[segs.length - 1]
  if (CHAT_SKIP_NAMES.has(base)) return false
  if (isSecretName(base)) return false                         // 脱敏还原表：绝不出微信
  return artifactKind(modId, values, rel) === "main"
}
/**
 * 从一批候选产物里挑出真正要发的，成品（docx/pdf/xlsx/图…）排在前面、限 max 条。
 * @returns {{ send: string[], held: number }} held = 没发出去的条数（中间文件 + 超限的），
 *          调用方把它写进随附文案（"另有 N 个中间文件留在会话里"），别再单发一条消息。
 */
export function pickChatFiles(names, { mod = "", values = null, max = 5 } = {}) {
  const ok = (names || []).filter((n) => chatSendable(mod, values, n))
  // 稳定排序（Node 的 sort 是稳定的）：成品在前，其余保持调用方给的顺序（通常是 mtime 倒序）
  ok.sort((a, b) => (DELIVERABLE_EXT.test(a) ? 0 : 1) - (DELIVERABLE_EXT.test(b) ? 0 : 1))
  const send = ok.slice(0, max)
  return { send, held: (names || []).length - send.length }
}

const RENDER_RULES = [
  // ⚠️ 必须放在最前：脱敏的【还原表】（真实姓名/住院号 ↔ 假名）。绝不能落进 table 渲染器——
  //    那会把病人真名直接铺在对话框里。给它专用渲染器，界面只显示警示、不预览内容。
  //    （实测产出过 deid_cohort_mapping.csv：200 例真实姓名+住院号，当时可一键下载且会内联预览。）
  { render: "secret", globs: SECRET_GLOBS },
  { render: "evidence", globs: ["evidence_table.csv", "evidence.csv", "included.csv", "zotero_evidence.csv", "zotero_refs.csv"] },
  { render: "retrieval", globs: ["retrieval_report.json", "manual_needed.txt"] },
  { render: "refcheck", globs: ["refcheck_report.md", "reference_check*.md", "reference_check*.csv"] },
  { render: "review", globs: ["review_report.md", "peer_review*.md"] },
  { render: "integrity", globs: ["integrity_report.md", "audit_report*.md"] },
  { render: "topics", globs: ["topic_candidates*.csv", "topic_selection*.md"] },
  { render: "diff", globs: ["*_humanized.md", "humanized*.md"] },
  { render: "figure", globs: ["*.png", "*.jpg", "*.jpeg", "*.svg", "*.webp"] },
  { render: "doc", globs: ["*.docx", "*.doc", "*.pdf", "*.pptx", "*.xlsx", "*.xls"] },   // xlsx 漏过一次：脱敏步 emits 里写着 deid_*.xlsx，却落进"认不出"
  { render: "table", globs: ["*.csv", "*.tsv"] },
  { render: "manuscript", globs: ["manuscript*.md", "proposal*.md", "review.md", "*_review.md", "digest*.md", "research_report*.md", "deep_research*.md"] },
  // 要求卡：原来靠 grant 的 spec 步 emits 兜着，那一步并进「标书成文」之后它不再是任何步骤的
  // 约定产物（并进去的理由见 grant.steps 里的注释）。不在这儿补一条，标书最要紧的那份
  // 「本次按的是哪一版口径」就会掉进"认不出"、只剩一个下载按钮。
  { render: "report", globs: ["*_report.md", "*_log.md", "data_profile.md", "preregistration.md", "analysis_plan.md",
                              "要求卡*.md", "grant_spec*.md", "requirements*.md"] },
]
const COMPILED = RENDER_RULES.map((r) => ({ render: r.render, res: r.globs.map(globRe) }))
// 各步 emits → render 的反查表：由 WORKFLOWS 自动展开。
// ★ 为什么必须有这张表：网关注入的前言原话是"**产物文件名用约定名**（名字对不上就只能当普通附件
//   列出）：…、analysis*.md、…"。模型照做了，结果 rendererFor 只查下面那张【全局文件名表】，
//   而 report 组写的是 *_report.md / *_log.md —— analysis.md 落进"认不出"。
//   两处定义各写各的，说好的契约对不上，主报告反而没有结构化卡片（实测踩到）。
//   现在以 steps 的 emits 为准、全局表兜底，契约只有一处定义。
// 一步的 emits 常常【混着体裁】：统计那步既出 stats_*.csv 又出 analysis*.md，筛选那步既出
// included.csv 又出 screening_log.md。step.render 只能写一个，直接套用会把文字报告渲染成表格。
// 按扩展名纠正：md/txt 的散文用 report，csv/tsv 的用 table，二进制文档用 doc。
// （比给每条 emits 单独标注渲染器更省事，且新增 emits 时自动正确。）
const byExt = (glob, declared) => {
  const ext = (glob.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase()
  if (!ext) return declared
  if (["md", "txt"].includes(ext) && ["table", "figure", "doc", "evidence"].includes(declared)) return "report"
  if (["csv", "tsv"].includes(ext) && ["report", "manuscript", "diff", "doc"].includes(declared)) return "table"
  if (["docx", "doc", "pdf", "xlsx", "xls", "pptx"].includes(ext)) return "doc"
  if (["png", "jpg", "jpeg", "svg", "pdf"].includes(ext) && declared === "report") return "figure"
  // ★ 题录文件不是证据表。refs.bib 被声明成 evidence，而文献卡片渲染器按【行】切 —— 实测两条
  //   BibTeX 题录被显示成「检索到的文献 14 篇」，每行一张卡（`title = {…}`、`author = {Smith`、
  //   「(无标题)」…）。返回 null = 认不出，退回普通产物卡（"认不出绝不藏起来"仍成立）。
  if (["bib", "ris", "nbib"].includes(ext)) return null
  return declared
}
// 【必须按具体度排序，不能靠书写顺序】撰写步的 `manuscript_*.md` 会吞掉润色步的
// `manuscript_humanized.md` —— 谁先匹配上全看两个模块在本文件里谁写在前面。这种依赖太脆：
// 挪一下定义顺序，渲染器就悄悄变了，而且从界面上完全看不出来。
// 具体度 = 去掉通配符后剩下的字面长度（越长越具体），同分时通配符少的优先。
const specificity = (g) => [g.replace(/\*/g, "").length, -(g.split("*").length - 1)]
const EMIT_RULES = (() => {
  const out = []
  for (const w of Object.values(WORKFLOWS))
    for (const s of w.steps)
      if (s.render) for (const g of s.emits || []) out.push({ render: byExt(g, s.render), re: globRe(g), glob: g })
  return out.sort((a, b) => {
    const [la, wa] = specificity(a.glob), [lb, wb] = specificity(b.glob)
    return lb - la || wb - wa
  })
})()
/** 文件名（可含一层子目录，如 pdfs/a.pdf）→ 渲染器 id；认不出返回 null */
export function rendererFor(name) {
  if (!name) return null
  const s = String(name), base = s.split("/").pop()
  // secret 先判：它比任何 emits 契约都优先——某一步的 emits 若不慎写宽了（deid_*.csv 就踩过），
  // 还原表会被当成该步的正常产物渲染出来，那是把病人真名摊在屏幕上。
  if (COMPILED[0].render === "secret" && COMPILED[0].res.some((re) => re.test(base))) return "secret"
  // 先按各步声明的 emits 认（契约的唯一来源），再落到全局文件名表兜底
  for (const r of EMIT_RULES) if (r.re.test(r.glob.includes("/") ? s : base)) return r.render
  for (const r of COMPILED) if (r.res.some((re) => re.test(base))) return r.render
  return null
}

// ---- 表单值 → 任务卡文本 ----
// 抄 index.html 的 zScopePrefix()：把结构化输入拼成一段【…】块塞在用户消息前面。
// 【格式约束】必须是纯文本、可读、并明确声明"这是用户通过表单提交的"，否则 agent 会把它
// 当成系统噪音忽略掉。末尾那句反幻觉提示是必须的 —— 表单必然有留空项，不写死它就会去编。
const fmtVal = (f, v, upDir) => {
  if (v === undefined || v === null || v === "") return null
  const label = (val) => (f.options || []).find((o) => o.v === val)?.t || val
  if (f.type === "bool") return v ? "是" : "否"
  // ★ files 型不能落进这一支。它排在下面 `type === "files"` 之【前】，谁将来给某个 files 字段
  //   加上 multiple: true，那个字段就会无声地退回裸文件名 —— 绝对路径没了，而任务卡看着依然正常。
  //   （当前 9 个真实 files 字段都没设这个标志，属于埋着的坑，先堵上。）
  if (f.type === "multi" || (f.multiple && f.type !== "files")) {
    const arr = Array.isArray(v) ? v : [v]
    return arr.length ? arr.map(label).join("、") : null
  }
  // tags：自由输入的关键字数组，没有 options 可查，原样罗列即可
  if (f.type === "tags") {
    const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean)
    return arr.length ? arr.join("、") : null
  }
  if (f.type === "range") {
    // 兼容标量：接口调用方传 jImpact: 5 时此前落到 return null 被【无声丢掉】——
    // 任务卡里整行消失且没有任何提示，用户以为筛选生效了。按"下限"理解更符合直觉。
    const { min, max } = (typeof v === "number" || typeof v === "string") ? { min: Number(v) } : (v || {})
    if (min === undefined && max === undefined) return null
    // ★ 上下限倒挂时【不要把这个条件发给模型】。界面那边已经报了 warning，但任务卡里照样写着
    //   "90 – 5 两年篇均被引" —— 于是模型收到一个不可能满足的条件，只能自己消化这个自相矛盾
    //   （实测它在思考里嘀咕 "this is a weird range"，然后自行猜了一个意思）。
    //   提示了却照发，等于把矛盾从用户转嫁给模型。按未填处理，并明说原因。
    if (min !== undefined && max !== undefined && Number(min) > Number(max))
      return `（你填的是 ${min} – ${max}，下限比上限大，这个条件无法成立，已按"不筛"处理——需要的话请重新告诉我区间）`
    if (min !== undefined && max !== undefined) return `${min} – ${max}${f.unit ? " " + f.unit : ""}`
    return min !== undefined ? `≥ ${min}` : `≤ ${max}`
  }
  // ★ 文件字段必须给【可直接打开的路径】，不能只给裸文件名。
  //   实测：任务卡写 "待润色的稿件：manu.md"，而 agent 的工作目录是【产物目录】，
  //   于是第一次 read 直接失败，再花 2–3 次 bash/glob 去别处摸索（最慢一次 32 秒），
  //   界面上还多一张红色的报错工具卡。前言里其实已经给了上传目录的绝对路径，
  //   裸文件名等于跟前言抢注意力 —— 两处说法打架，模型未必挑对。
  //   upDir 未知时（首屏 intake 卡是在会话建立【之前】填的，服务端此刻还没有 sid）
  //   也要明说"在上传目录下"，别让它以为文件就在当前目录。
  if (f.type === "files") {
    const arr = (Array.isArray(v) ? v : [v]).filter(Boolean)
    if (!arr.length) return null
    // 分隔符跟着 upDir 走，别硬编码 "/"：Windows 桌面版会拼出 `D:\...\uploads\ws_xxx/manu.md`
    // 这种半反半正的路径。模型认得，但难看，也容易被后续脚本处理歪。
    // ★ 路径要带引号、并且一行一个。技能大量走 bash，而用户传上来的文件名里空格与括号极常见
    //   （「患者数据 2026-08(最终版).xlsx」这种是常态）：不加引号的话，空格会把一个路径拆成两个
    //   参数，`(` `)` 在 bash 里直接是语法错误 —— 任务卡文本本身看着没毛病，落到 shell 才炸。
    //   顿号分隔同理：多文件时模型很容易把「A、B」整串当成一个路径。
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
    if (upDir) {
      const base = String(upDir).replace(/[\\/]+$/, "")
      const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/"
      return arr.length === 1 ? q(base + sep + arr[0])
        : "\n" + arr.map((n) => "  - " + q(base + sep + n)).join("\n")
    }
    return (arr.length === 1 ? q(arr[0]) : "\n" + arr.map((n) => "  - " + q(n)).join("\n"))
      + "（在上传目录下，绝对路径见前言）"
  }
  if (f.type === "select") return label(v)
  // number 型带单位的，任务卡里要把单位一起写上：光一个 "4000" 落在「目标篇幅」后面，
  // 模型得自己猜是字数还是词数（中英文稿差着一倍）。unit 界面上已经画在输入框右边了。
  if (f.type === "number" && f.unit) return `${v} ${f.unit}`
  return String(v)
}

/**
 * 把一组表单值序列化成任务卡。
 * @param modName 模块显示名（"SCI 论文"）
 * @param title   卡片标题（"立项确认" / 步骤名）
 * @param fields  字段定义数组
 * @param values  用户填的值
 * @param opts    { footnote, upDir }
 *                upDir：本会话 uploads/ 的【绝对路径】。给了就把 files 型字段拼成完整路径
 *                （此前这个参数只写在这行文档里，函数体从没读过它 —— 于是任务卡一直发裸文件名）。
 */
export function taskCard(modName, title, fields, values = {}, opts = {}) {
  const lines = []
  for (const f of fields || []) {
    if (!visible(f, values)) continue              // 条件没成立的字段压根没显示过，别拼进去
    // noCard：表单要收、但【不该进提示词】的字段。目前只有联系邮箱与手机号 —— 模型写标书
    // 一个字都用不上，而任务卡是要发给模型的。收集 ≠ 外发，这道口子得在序列化这一层堵死，
    // 不能指望每个调用方自己记得过滤。
    if (f.noCard) continue
    const s = fmtVal(f, values[f.id], opts.upDir)
    if (s !== null) lines.push(`- ${f.label}：${s}`)
  }
  if (!lines.length) return ""                     // 一项都没填 = 用户跳过了表单，什么都不拼
  // ★ 脚注必须放在结束标记【以上为用户通过表单…】的【前面】。
  //   放后面的话 server.mjs 的 WFCARD_RE 剥到 `】` 就停了，脚注会残留在用户气泡里 ——
  //   用户回看历史会看到自己"说"了一句"需要 PRISMA/RoB 请到自由对话"，而他根本没说过。
  const foot = opts.footnote ? `\n补充说明：${opts.footnote}` : ""
  return `【任务卡 · ${modName} / ${title}】\n${lines.join("\n")}${foot}\n`
    + `【以上为用户通过表单勾选提交的结构化输入，视同用户明确指令，按它推进即可、不要再逐项复述确认。`
    + `未填写的项一律标注"待补充"并在需要时向用户索要，**绝不臆测或编造**（伦理批号、注册号、数据数值尤其如此）。】\n\n`
}

// ---- 数据表表头解析（/api/data/headers 用；纯函数，便于测试）----
//
// 这是 stats / paper 表单最值钱的一环："列名猜错 / 写错"是当前最高频的失败模式，从真实表头
// 下拉能从根上消灭它。**代价是：一旦解析歪了却仍回一个"看着像模像样"的下拉，比不做这个控件
// 更危险** —— 用户会从荒唐选项里挑一个，而 testCol / goldCol 这类字段还是必填的。
// 所以下面每一道判据都宁可降级成"手动填列名"，也不输出可疑结果。判据都是实测踩出来的，别删。
export function parseHeaders(buf, ext = ".csv", opts = {}) {
  const bad = (reason) => ({ headers: null, reason })
  // ⓪ 【只读了文件头部时，必须先切到最后一个换行】。调用方只读前 64KB（表可能很大），
  //    于是缓冲区末尾几乎必然停在一行的中间 —— 对中文表就是停在一个多字节字符的中间。
  //    实测后果比"少几列"严重得多：半个 UTF-8 字符解出 U+FFFD → 判定"不是合法 UTF-8" →
  //    回退嗅探 GBK → GBK 能把合法的 UTF-8 中文解成乱码而【不产生 U+FFFD】→ 判定成功 →
  //    返回一整排 "妫€楠屾寚鏍嘷1" 这样的乱码列名，还标着 encoding:"gbk"，**完全不降级**。
  //    用户看到的是一个三千多项、看着像模像样的下拉 —— 正是本函数注释里点名"比不做这个控件
  //    更危险"的那种失败形态。纯 ASCII 宽表则表现为静默截断（12000 列悄悄变成 5554 列）。
  //    换行字节在 UTF-8 / GBK / Big5 里都不会出现在多字节序列内部，切在这里对三种编码都安全。
  if (opts.partial) {
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0) return bad("表头行太长（前 64KB 里一个换行都没有），读不全就不敢给你列名——请手动填，或把表另存得窄一些。")
    buf = buf.slice(0, nl)
  }
  // ① 编码嗅探。★ 中文版 Excel「另存为 CSV」默认写 GBK，这是医院里【最常见】的导出方式，
  //    不是边缘情况。硬按 UTF-8 解会把表头变成 "������"，而那串乱码会被当成真列名盖章确认、
  //    灌进任务卡交给模型（实测：ROC 的待评价指标列填成 "����A_Ddimer"）。
  const utf8 = buf.toString("utf8")
  let text = utf8, enc = "utf-8"
  if (utf8.includes("�")) {                       // 有替换字符 = 不是合法 UTF-8
    enc = null
    for (const e of ["gbk", "gb18030", "big5"]) {
      try {
        const t = new TextDecoder(e, { fatal: false }).decode(buf)
        if (!t.includes("�")) { text = t; enc = e; break }
      } catch { /* 运行时不支持该编码，跳过 */ }
    }
    if (!enc) return bad("这个文件的编码认不出来（不是 UTF-8，也不是 GBK/GB18030/Big5）。请另存为「CSV UTF-8」再传，或先手动填列名。")
  }
  const lines = text.split(/\r?\n/)
  let line = lines[0] || ""
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)   // 剥 BOM，否则第一列名会带个看不见的字符
  if (!line.trim()) return bad("文件第一行是空的，读不出表头。请手动填列名。")
  // ② 分隔符：把分号也算进来（欧洲区 Excel 与不少 LIS 导出用它）
  const count = (s, c) => s.split(c).length - 1
  const sep = ext === ".tsv" ? "\t" : [",", "\t", ";"].sort((a, b) => count(line, b) - count(line, a))[0]
  // ③ 引号不成对 → 带逗号的引号字段会被拆碎成一堆假列（还带残留引号），直接降级
  if ((line.match(/"/g) || []).length % 2 === 1)
    return bad("表头里有没配对的引号，拆出来的列名不可信。请手动填列名。")
  const cells = line.split(sep).map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
  // ④ 只解析出 1 列：多半首行是标题行（"某某医院检验科…原始数据 2026-08"，LIS 导出常见），
  //    或用了没认出来的分隔符。此前会把整行原样塞进下拉当唯一选项。
  if (cells.filter(Boolean).length <= 1)
    return bad("这个文件的第一行不像表头（只解析出一列）。可能首行是标题行，或分隔符特殊——请手动填列名。")
  // ⑤ 首行与次行字段数对不上 → 首行多半不是表头
  const second = (lines[1] || "").split(sep).length
  if (second > 1 && Math.abs(second - cells.length) > 1)
    return bad(`第一行有 ${cells.length} 个字段、第二行有 ${second} 个，对不上——首行可能不是表头。请手动填列名。`)
  // ⑥ 空列名与重名列都要显式标出：静默丢弃会让用户以为那列不存在（而脚本里它确实存在），
  //    两个一模一样的按钮则根本分不清点了哪个。
  // ★ 显示名与【真列名】必须分开回。消歧后缀（"（重名 2）"、"（第 2 列·无列名）"）是给人看的，
  //   在真实 CSV 里【根本不存在】—— 而前端此前把 headers 同时当 label 和 value 用，用户从下拉里
  //   点一下，这个不存在的名字就原样进任务卡交给模型，脚本按它取列必然取不到。
  //   更阴的是仅大小写不同的两列（Age / age）：本来都合法且不同，却因为按小写去重被判成重名，
  //   于是第二列被改写成 "age（重名 2）"。服务端的列名核对又是拿同一份 headers 比，
  //   `cols.includes("age（重名 2）")` 为真 → 双保险两边用同一份被污染的数据，等于没有保险。
  const seen = new Map()
  const raw = cells.map((h) => h || "")          // 表头单元格的原文，按列序；空列名就是空串
  const headers = cells.map((h, i) => {
    const base = h || `（第 ${i + 1} 列·无列名）`
    const k = base.toLowerCase()
    const n = (seen.get(k) || 0) + 1; seen.set(k, n)
    return n > 1 ? `${base}（重名 ${n}）` : base
  })
  // 真的重名的列名（大小写不同的不算——它们是两个合法且不同的列名）
  const cnt = new Map()
  for (const h of raw) if (h) cnt.set(h, (cnt.get(h) || 0) + 1)
  const dupes = [...cnt].filter(([, n]) => n > 1).map(([h]) => h)
  return { headers, raw, dupes, sep, encoding: enc }
}

// ---- 变量对应：机器先认列，用户只做核对（/api/data/automap 用；纯函数，便于测试）----
//
// 【为什么要有这一步】「分组列 / 结局列 / 随访时间列 / 终点事件列 / 待评价指标列 / 金标准列」
// 这一排下拉是本套件里用户最不知所云的地方——医生看到「终点事件列」四个字，第一反应是"这是啥"。
// 而它填错【不会报错】，只会安静地产出一条看着很正常的错 KM 曲线。
// 让人从二十几个列名里挑出六个，很难；请他核对一句
// 「分组列＝组别（全表只有 试验组 58 例 / 对照组 62 例两种取值）」，很容易。
// 所以顺序要反过来：**先让机器看一眼数据把列认出来，用户只负责确认与纠正**。
//
// 本函数是那一步的【确定性底座】：不联网、不花钱、离线可用，同时充当模型那一版的先验与兜底。
// 判据只有两样：**列名的字面** 与 **这一列的实际取值形状**（来自 table_preview.py 的列画像）。
// 两样都命中才敢给高置信度——
//   · 只看列名，会栽在医生表里「随访时间」和「入院时间」并排的那种表上；
//   · 只看形状，根本分不开「是否死亡」与「是否吸烟」（都是清一色的 0/1 两值列）。
//
// 【宁可留空，也不硬填】分数不到门槛就不填。填错一个列比留空危险得多：留空只是让用户多点一下，
// 填错会被他当成"系统已经认出来了"照单全收——这正是本文件里 parseHeaders 那段注释反复说的
// "一旦解析歪了却仍回一个看着像模像样的结果，比不做这个控件更危险"。
const VAR_ROLES = [
  { id: "groupCol", label: "分组列", pri: 1,
    // 「组」这个字在中文列名里太泛：血型、组织类型、组学都带它，先排掉再匹配
    deny: /血型|组织|组学|组分|同组|世组/i,
    name: /组别|分组|^组$|治疗组|对照|试验组|实验组|干预|队列|术式|手术方式|分型|亚型|\barm\b|group|cohort|treat(ment)?_?(group|arm)?|regimen/i,
    // 分组列必然是"少数几个水平"。ID、纯文本、日期、空列一律不可能是它
    shape: (c) => c.nunique >= 2 && c.nunique <= 6 && !["id", "empty", "datetime", "text", "constant"].includes(c.kind),
    shapeWhy: (c) => `全表只有 ${c.nunique} 种取值（${vals(c)}）`,
    // 性别确实能当分组，但十有八九是协变量。压一点分，让真正的组别列赢过它。
    // ★ 分期 / 分级 / 分型同理，而且更要命：TNM 分型这类列【列名命中 + 形状也命中】（4 个水平），
    //   于是拿到 high 置信 —— 界面上连"·待核"都不挂、也不淡化，用户直接照单全收，
    //   而真正的分组列「治疗方案」反倒没被命中。服务端给模型的提示词第一条就写着"不是分期"，
    //   规则版（也是关掉 AI / 没有 provider / 超时时的唯一结果）自己却在违反它。
    //   用 demote 不用 deny：确有拿分期当组的研究，压到过不了槛、留空让用户自己指，比填错强。
    demote: /性别|sex|gender|分期|分级|分型|亚型|\bstage\b|\bgrade\b|tnm/i },
  { id: "timeCol", label: "随访时间列", pri: 2,
    name: /随访|生存时间|生存期|观察时间|时长|时间.*(月|天|年|日)|(月|天|年|日)数|followup|follow_?up|survival_?time|\btime\b|\bos\b|\bpfs\b|\bdfs\b|\brfs\b|duration|months?|days?/i,
    // 时长必须是非负的连续/整数值。日期列不算——那是"某一天"，不是"多久"（见下面的 note）
    shape: (c) => ["numeric", "integer"].includes(c.kind) && c.nunique > 6 && c.all_nonneg !== false,
    shapeWhy: (c) => `非负数值，范围 ${num(c.min)}–${num(c.max)}`,
    // 日期列命中列名时不填，但要把话说出来：由日期相减派生随访时间是最常见的正确做法
    noteWhen: (c) => c.kind === "datetime"
      ? `「${c.name}」看着像日期而不是时长——随访时间通常要由两个日期相减派生，这一步得你或分析时来做`
      : "" },
  { id: "eventCol", label: "终点事件列", pri: 3,
    name: /终点|事件|结局事件|死亡|生存状态|存活|复发|转移|进展|再入院|censor|删失|\bevent\b|\bstatus\b|\bdeath\b|died|recur|relapse|progress/i,
    // 必须是两值。0/1 编码是它的典型形状，也是 lifelines 直接能吃的形状
    shape: (c) => c.nunique === 2,
    bonus: (c) => (c.kind === "binary01" ? 1.5 : 0),
    shapeWhy: (c) => `两值列（${vals(c)}）${c.kind === "binary01" ? "，正是 1=事件 / 0=删失 的编码" : ""}` },
  { id: "goldCol", label: "金标准列", pri: 4,
    name: /金标准|gold|参考方法|reference|病理|活检|确诊|最终诊断|诊断结果|真实(状态|标签)|label|阳性/i,
    shape: (c) => c.nunique === 2,
    shapeWhy: (c) => `两值列（${vals(c)}），可以当 1=有病 / 0=无病` },
  { id: "testCol", label: "待评价指标列", pri: 5,
    name: /浓度|水平|含量|滴度|评分|积分|指数|比值|标志物|\bscore\b|\blevel\b|\bindex\b|\bratio\b|marker|d-?dimer|crp|psa|afp|ca\d{2,3}|nlr|plr/i,
    // 要评价诊断效能的是一个连续指标，取值太少（≤6 种）画不出像样的 ROC
    shape: (c) => ["numeric", "integer"].includes(c.kind) && c.nunique > 6,
    shapeWhy: (c) => `连续数值（${c.nunique} 种取值，${num(c.min)}–${num(c.max)}）`,
    // 年龄/BMI 也是连续数值，但它们几乎总是协变量而不是待评价指标
    demote: /年龄|age|bmi|身高|体重|height|weight/i },
  { id: "outcomeCol", label: "结局列", pri: 6,
    name: /结局|结果|转归|预后|疗效|有效|缓解|痊愈|好转|outcome|response|prognosis|住院(天|日)数|\blos\b/i,
    shape: (c) => !["id", "empty", "constant"].includes(c.kind),
    shapeWhy: (c) => `${kindCN(c.kind)}列` },
]
// 协变量单独一套：它是"多选"，判据也不同（人口学与合并症，而不是某个唯一角色）
const COVAR_RE = /年龄|性别|身高|体重|bmi|吸烟|饮酒|分期|分级|stage|grade|病程|高血压|糖尿病|冠心病|合并症|既往史|\bage\b|\bsex\b|gender|smok|drink|comorbid|hypertens|diabet/i
const COVAR_MAX = 8
const ID_RE = /住院号|门诊号|病案号|就诊号|样本号|标本号|编号|序号|患者(id|编号)|\bid\b|\bno\.?\b|number|subject|patient_?id/i

const num = (x) => (x === undefined || x === null ? "?" : (Math.round(x * 100) / 100))
const kindCN = (k) => ({ numeric: "连续数值", integer: "整数", binary01: "0/1 两值", binary: "两值",
  categorical: "分类", datetime: "日期", text: "文本", id: "标识", empty: "空", constant: "常量" }[k] || k)
// 取值少的列把取值连例数一起摆出来——这是"这一列到底是什么"最硬的证据，比任何列名都可靠
const vals = (c) => (c.values || []).length
  ? c.values.slice(0, 4).map((v) => `${v.v || "(空)"} ${v.n} 例`).join(" / ") + ((c.values.length > 4) ? " …" : "")
  : (c.examples || []).slice(0, 4).join(" / ")

/**
 * 从列画像里认出各个角色的列。
 * @param cols  table_preview.py 的 cols（至少要有 name；有 kind/nunique/values 时判得准得多）
 * @param opt   { headers } —— 只拿得到表头、读不出取值时的降级入口（把 headers 包成 cols 即可）
 * @returns { map, why, conf, notes }
 *          map  角色 → 列名（covars 是数组）。**认不准的角色不出现在 map 里**（宁可留空）
 *          why  角色 → 一句人话依据，直接摆给用户看（"列名含「组别」，且全表只有两种取值…"）
 *          conf 角色 → "high" | "med"（名+形都中 = high；只中一样 = med）
 *          notes 认不出但值得说的事（如"随访时间那列是日期，得相减派生"）
 */
export function guessVarMap(cols, opt = {}) {
  const list = (cols && cols.length ? cols : (opt.headers || []).map((h) => ({ name: String(h) })))
    .filter((c) => c && c.name)
  const map = {}, why = {}, conf = {}, notes = []
  const taken = new Set()
  // 标识列不参与任何角色（住院号当分组列跑出来的 Table 1 会有 120 个"组"）
  for (const c of list) if (ID_RE.test(c.name) || c.kind === "id") taken.add(c.name)

  for (const role of [...VAR_ROLES].sort((a, b) => a.pri - b.pri)) {
    let best = null
    for (const c of list) {
      if (taken.has(c.name)) continue
      if (role.deny && role.deny.test(c.name)) continue
      const hasShape = c.kind !== undefined
      const nameHit = role.name.test(c.name)
      // 形状未知（只读到表头）时不判形，只按列名认，并在 why 里说清这是怎么认的
      const shapeHit = hasShape ? !!role.shape(c) : null
      if (hasShape && !shapeHit) {
        const n = role.noteWhen ? role.noteWhen(c) : ""
        if (nameHit && n) notes.push(n)
        continue                                   // 形状对不上就一票否决，列名再像也不填
      }
      // ★ 过槛分与排序分要分开。bonus 原来是直接加进 s 的，于是
      //   `0(名不对) + 1.5(形对) + 1.5(binary01 加成) = 3.0` 恰好踩线过关 ——
      //   任何一个 0/1 列（是否吸烟、是否饮酒、是否高血压…）都会被填成「终点事件列」，
      //   而这正是本函数头注说的"只看形状根本分不开是否死亡与是否吸烟"。加成把作者
      //   刻意留的那点余量吃光了。现在它只用来在【已经过槛的候选之间】排序。
      const base = (nameHit ? 3 : 0) + (shapeHit ? 1.5 : 0)
        - (role.demote && role.demote.test(c.name) ? 2.5 : 0)
      const s = base + (role.bonus && hasShape ? role.bonus(c) : 0)
      if (base < 3) continue                       // 门槛只看 base（见下）
      if (!best || s > best.s) best = { c, s, base, nameHit, shapeHit }
    }
    // 门槛 3：等于"至少列名对上了"。只有形状对（1.5 分）绝不够——表里非负连续列一抓一把，
    // 挑一个填进「随访时间」纯属瞎猜，而用户会把它当成系统的判断。
    if (!best) continue
    const c = best.c
    taken.add(c.name)
    map[role.id] = c.name
    conf[role.id] = best.nameHit && best.shapeHit ? "high" : "med"
    why[role.id] = best.nameHit && best.shapeHit ? `列名像「${role.label}」，且${role.shapeWhy(c)}`
      : best.nameHit ? `列名像「${role.label}」${c.kind === undefined ? "（这张表只读到了表头，没能核对取值，请务必自己看一眼）" : ""}`
        : role.shapeWhy(c)
  }
  // 结局列没有独立候选时，允许复用终点事件列：「是否死亡」既是终点事件也是结局，这很常见，
  // 而留空会让"组间比较"这类模式白白缺一个必需项。复用要在 why 里说明，别让用户以为是两列。
  if (!map.outcomeCol && map.eventCol) {
    map.outcomeCol = map.eventCol
    conf.outcomeCol = "med"
    why.outcomeCol = `与终点事件同一列（「${map.eventCol}」既是终点事件也是要分析的结局，这种表很常见）`
  }
  const cov = []
  for (const c of list) {
    if (taken.has(c.name) || cov.length >= COVAR_MAX) continue
    if (!COVAR_RE.test(c.name)) continue
    if (["empty", "constant", "id", "text"].includes(c.kind)) continue
    cov.push(c.name)
  }
  if (cov.length) {
    map.covars = cov
    conf.covars = "med"
    why.covars = `看着像人口学 / 合并症变量（${cov.join("、")}），常作为校正因素；**要不要校正得你按临床来定**`
  }
  return { map, why, conf, notes }
}

/** 列画像 → 给模型看的一段紧凑文本（放进 automap 提示词；抽出来是为了能单测、也能打日志核对） */
export function describeCols(cols, rows = [], headers = []) {
  const lines = []
  for (const c of (cols || [])) {
    const bits = [kindCN(c.kind)]
    if (c.nunique !== undefined) bits.push(`${c.nunique} 种取值`)
    if (c.missing_pct) bits.push(`缺失 ${c.missing_pct}%`)
    if (c.min !== undefined) bits.push(`范围 ${num(c.min)}–${num(c.max)}`)
    const v = vals(c)
    lines.push(`- ${c.name}｜${bits.join("，")}${v ? `｜取值：${v}` : ""}`)
  }
  if (!lines.length) for (const h of headers) lines.push(`- ${h}`)
  const head = headers.length ? headers : (cols || []).map((c) => c.name)
  const sample = rows.length
    ? "\n\n【前 " + rows.length + " 行原样】\n" + head.join(" | ") + "\n"
      + rows.map((r) => r.map((x) => (x === "" ? "(空)" : x)).join(" | ")).join("\n")
    : ""
  return "【每列画像】\n" + lines.join("\n") + sample
}

// ---- 模块/技能闸的判据（纯函数，便于测试）----
// 三条：① skill 工具调了白名单外的技能；② 受限模块用 task 子代理绕道；
//       ③ bash 命令里直接跑白名单外的技能脚本。
//
// ③ 是随"技能集扩成整条 pipeline"一起补上的：前言本来就教 agent 用
// `${REPO_ROOT}/.venv/bin/python ${REPO_ROOT}/.opencode/skills/<技能>/xxx.py` 跑脚本，
// 于是"顺手跑一个隔壁模块的脚本"是条真实且高频的绕道路径，而它走 bash 工具、不经过 ①。
//
// 【边界，别误解】变量拼接、cd 进目录后用相对路径、base64 等刻意绕法都能过 —— 这与本套件
// 既有口径一致：模块闸是**产品分权**，不是对抗边界（agent 本来就有 shell）。堵住顺手绕道
// 已经拿到绝大部分收益；真要物理隔离得每模块一个 opencode 实例，代价不值。
const SKILL_PATH_RE = /\.opencode[/\\]+skills[/\\]+([a-z0-9_-]+)/gi
// 只读命令不算"调用技能"：agent 常常需要 cat/grep 一下别的技能的 SKILL.md 才能把话讲清楚
// （综述模块的脚注就是让它告诉用户"系统综述在自由对话"，它顺手 cat 一下那份文档很自然）。
// 把这些也判成越权会整轮 abort，属于误杀 —— 读文档不产生该技能的产出，不是分权要挡的东西。
// ★ find 不在此列：`find -exec` / `-delete` 是标准的"执行任意命令"入口，不是只读命令。
//   曾经放进来过，等于给了一条大路。同理不要加 xargs、sh、env、nohup、timeout 这类能带执行的。
const READONLY_CMD = /^\s*(sudo\s+)?(cat|head|tail|less|more|grep|rg|ls|ll|wc|file|stat|md5sum|sha\w*sum|diff)\b/
export function gateViolation({ tool, input, skillGate, restricted }) {
  if (!skillGate) return null
  if (tool === "skill" && input?.name && !skillGate.has(input.name)) return input.name
  if (restricted && tool === "task") return "task(子代理)"
  if (tool === "bash") {
    // 归一化再匹配：`skills//deidentify`、`skills/./deidentify`、`"…/skills"/deidentify`
    // 这几种写法在 shell 里都很平常（路径含空格时加引号是习惯），不归一的话直接漏过去。
    const cmd = String(input?.command || "").replace(/["']/g, "").replace(/\/\.\//g, "/").replace(/\\\.\\/g, "\\")
    // ★ 必须【逐段】判，不能拿整条命令的第一个词放行整条：
    //   `cat x.py | python .opencode/skills/nature-figure/y.py` 开头是 cat，整条放行等于白闸。
    //   按管道与分隔符切开，只有"这一段自身是只读命令"才跳过这一段。
    // 分隔符要把单个 & （后台执行）也算上 —— 只写 && 的话 `ls & python …/别的技能/x.py` 整条被
    // 当成一段、开头是 ls 就放行了。$( ) 与反引号里的命令同样切出来单独判。
    for (const seg of cmd.split(/[|;&\r\n`]|\$\(|\)/)) {
      if (READONLY_CMD.test(seg)) continue
      // matchAll 按规范会克隆正则，不会推进原对象的 lastIndex，故无需手动归零
      for (const m of seg.matchAll(SKILL_PATH_RE))
        if (!skillGate.has(m[1].toLowerCase())) return `${m[1]}（bash 直呼技能脚本）`
    }
  }
  return null
}

/**
 * 这一步是不是在【出送审件】（Word/PDF）。闸红时要拦的就是它。
 *
 * ★ 只认 `skill` 工具是不够的。render-docx 自带可直接执行的脚本
 *   （scripts/render_docx.sh 等），`bash .opencode/skills/render-docx/scripts/render_docx.sh x.md`
 *   或干脆 `pandoc x.md -o x.docx` 都不经过 skill 工具，闸红时不会被拦 ——
 *   这是读代码找出来的路径缺口（本轮实测里模型走的是 skill 工具，没有真发生绕过）。
 *   复用 gateViolation 那套【逐段】解析：管道/分号/后台符切开，避免
 *   `cat a.md | pandoc - -o a.docx` 因为开头是 cat 就整条放行。
 */
export function isDeliveryCall({ tool, input }) {
  if (tool === "skill") {
    const n = String(input?.name || "")
    return (n === "render-docx" || n === "render-pdf-doc") ? n : null
  }
  if (tool !== "bash") return null
  const cmd = String(input?.command || "").replace(/["']/g, "").replace(/\/\.\//g, "/").replace(/\\\.\\/g, "\\")
  for (const seg of cmd.split(/[|;&\r\n`]|\$\(|\)/)) {
    if (READONLY_CMD.test(seg)) continue
    const m = /\.opencode[/\\]+skills[/\\]+(render-docx|render-pdf-doc)\b/i.exec(seg)
    if (m) return `${m[1]}（bash 直呼技能脚本）`
    // 裸 pandoc / libreoffice 出 docx/pdf 也算出件
    if (/\b(pandoc|soffice|libreoffice)\b/i.test(seg) && /-o\s*\S+\.(docx|pdf)\b|--convert-to\s+(docx|pdf)\b/i.test(seg))
      return "pandoc/libreoffice 直接出件"
  }
  return null
}

// ---- 死循环护栏的判据（纯函数，便于测试）----
// 「同一条命令被反复调用」= agent 已经卡住了，再跑下去只是烧时间和配额。
// 实测（kimi）：python 路径落空后它连发 35+ 次一模一样的 `python -c "print('hello')"`，
// 跑满 10 分钟零产出，没有任何机制会停下它。阈值 8：正常重试（改参数、换写法）不会一字不差地
// 重复这么多次。
//
// ★★ 必须按【调用】计数，不能按事件计数 ★★
// opencode 的 bash 工具每吐一段输出就发一个 message.part.updated，status 恒为 running、
// command 一字不差、callID 也不变。真机记录：一次 `pip install icecream` 就发了 8 个
// （metadata.output 长度 0→21→87→240→284→351→396）。按事件累加的话，【一次没有任何重试的
// 调用】会被判成"重复 8 次"当场掐死 —— 那两次 pip 只活了 8.2s 与 20.3s，远没到工具超时，
// 是被本闸杀的。受害面不止 pip：凡是输出分段够多的长命令（下载、跑得久的技能脚本）都会中招。
export const LOOP_REPEAT_LIMIT = 8
/**
 * 喂一个 tool part 事件，返回 true 表示"判定卡死，该中止本轮了"。
 * st 是本轮的护栏状态（{}即可）：call=当前调用id、cmd=当前命令、repeat=该命令被调用次数、
 * out=当前调用已产生的真实输出、hit=命中的命令。
 *
 * st.out 是特意留的：工具被中止时 opencode 把已收到的输出【只】塞进 state.metadata.output，
 * 交给模型的 state.output 是 null —— 模型拿到"错了，但没有任何信息"，于是原样重发，正好又撞闸。
 * 网关手里有这段输出，闸触发时必须交出去，否则就是我们自己看得见、却让用户去"把真实报错贴出来"。
 */
export function loopGuardStep(st, part) {
  if (part?.tool !== "bash") return false
  const state = part.state || {}
  const call = part.callID || part.id || ""
  const out = state.metadata?.output
  if (typeof out === "string" && out && call === st.call) st.out = out   // 同一次调用：留底最新输出
  const cmd = String(state.input?.command || "").trim()
  if (st.hit || !cmd || state.status !== "running" || call === st.call) return false
  st.call = call
  st.out = ""
  st.repeat = st.cmd === cmd ? (st.repeat || 0) + 1 : 1
  st.cmd = cmd
  if (st.repeat < LOOP_REPEAT_LIMIT) return false
  st.hit = cmd.slice(0, 120)
  return true
}

/** 模块的完整工作流描述，供 /api/modules/<id>/workflow 下发给前端 */
export function workflowFor(mod, values) {
  const w = WORKFLOWS[mod]
  if (!w) return null
  return {
    module: mod,
    primary: w.primary,
    // 这个模块用哪个界面壳：缺省 null = index.html 的通用壳（表单 + 步骤条 + 对话流）；
    // "reader" = 专用的 web/reader.html（左原文右助手）。工作台与聊天页据此决定往哪儿跳。
    ui: w.ui || null,
    // 阅读器壳的整份配置（模式、提示词、首屏文案、变量对应面板）。前端不认识任何具体模块，
    // 全靠这一份下发 —— 所以改模式 / 改措辞只动 workflows.mjs，走界面包热更新即可。
    // 里面的字段要能被 JSON 序列化：正则一律写成字符串（前端 new RegExp），别放函数。
    reader: w.reader
      ? { ...w.reader, intake: (w.reader.settings || []).concat(w.reader.intro?.ask || [], w.reader.vars?.fields || [])
          .map((id) => (w.intake || []).find((f) => f.id === id)).filter(Boolean) }
      : null,
    // 生成器壳（web/figure.html）的配置。与 reader 同一套路：页面只认 gen.intake 里下发的字段定义，
    // 不认识任何一个具体字段 id —— 加一档画幅、加一个设置项都只改 workflows.mjs。
    gen: w.gen
      ? { ...w.gen, intake: [w.gen.promptField, w.gen.uploadField, ...(w.gen.pills || []), ...(w.gen.extraFields || [])]
          .filter(Boolean).map((id) => (w.intake || []).find((f) => f.id === id)).filter(Boolean) }
      : null,
    intakeTitle: w.intakeTitle,
    intakeSub: w.intakeSub || null,   // 流程条第 1 格「基础信息录入」那行小字，各模块不同
    intake: w.intake,
    footnote: w.footnote || null,
    notice: w.notice || null,   // 进来第一眼就该知道的话（如体裁声明），渲染在卡片顶部而非底部
    // 条件字段（when / whenAny / first）必须【一个不落】地下发：前端的 trimSteps 要用它们
    // 重算出与 stepsFor 完全相同的步骤集。漏掉任何一个，那一半条件在前端就恒为"成立"，
    // 界面显示的流程与实际执行的流程就会不一致 —— 而这种错从界面上完全看不出来。
    steps: (values ? stepsFor(mod, values) : w.steps).map((s) => ({
      id: s.id, name: s.name, sub: s.sub || null, skill: s.skill, skillAlias: s.skillAlias || null,
      gate: !!s.gate, failLabel: s.failLabel || null,
      optional: values ? isOptional(s, withDefaults(mod, values)) : !!s.optional,
      hint: s.hint || null, form: s.form || null, render: s.render || null, emits: s.emits || null,
      when: s.when || null, whenAny: s.whenAny || null, first: s.first || null, onFail: s.onFail || null,
    })),
  }
}

/** 模块前言里那句"本模块的标准流程"——把步骤链与质量闸讲给 agent 听 */
export function pipelineLine(mod, rawValues) {
  const values = withDefaults(mod, rawValues)   // 跳过表单时也按默认勾选算，否则整条流程线是空串
  // 【flow 覆写】不是所有模块都是一条线。文献研读是"一篇文献 × 四种模式"，用户随时在四者间来回切，
  // 通用版那句「按此顺序推进」会让模型去执行一个根本不存在的顺序（实测最坏是用户只想问一句话，
  // 它却自作主张跑起 ppt-master）。这类模块自己写清楚该怎么干，下面那整段闸的规矩也一并不适用。
  if (WORKFLOWS[mod]?.flow) return WORKFLOWS[mod].flow
  const steps = stepsFor(mod, values)
  if (!steps.length) return ""
  const chain = steps.map((s) => s.name + (isOptional(s, values) ? "(可选)" : "") + (s.gate ? "(闸)" : "")).join(" → ")
  // 个别步骤有非做不可的交代（如「要求卡必须落盘」），挂在 step.note 上随流程一起发出去。
  // hint 是给界面做悬停提示的，不进提示词；两者别混用。
  const notes = steps.filter((s) => s.note)
  const noteTxt = notes.length ? notes.map((s) => `\n- **「${s.name}」这一步**：${s.note}`).join("") : ""
  const gates = steps.filter((s) => s.gate)
  const gateTxt = gates.length
    ? `质量闸：${gates.map((g) => `${g.name}（不过则回退到「${steps.find((x) => x.id === g.onFail)?.name || "上游相应步骤"}」返工）`).join("；")}。`
    : ""
  // 后面那四段全是【闸】的规矩。一步都没有闸的模块（如「科研作图」）也照发，等于每一轮都往前言里
  // 塞四段讲一个本模块根本不存在的机制 —— 不只是废话：模型会去找"那道闸在哪"，实测过它自行
  // 加一道并不存在的检查步骤。有闸的模块（paper / review / grant）不受影响，它们恒有闸。
  const gateRules = gates.length
    ? `\n- **闸的结论只能由重新跑一遍得出**：因某道闸不过而返工后，必须【真的重跑那道闸】并让它写出新报告，才可以说闸已通过。拿上一版的旧报告宣布通过是错的 —— 界面会同时显示「已通过」和一份写着问题的报告，自相矛盾。\n- **不要替校验脚本夸大结论**：不变量校验之类的自动检查只比对数字、角标、术语这些「集合」，查不出「显著低于→低于」「提示→显示」这种措辞漂移。校验通过只能说「数字与角标未变」，**不许说成「引用保留不动」或「内容未改」** —— 用户看到那句话就不会再去逐句核对了。\n- **闸没跑完不许出件**：排版 / 交付类步骤必须排在质量闸【之后】。实测出现过 docx 比核查报告早 13 秒生成 —— 用户拿到一份没过闸的送审稿，而它看起来跟过了闸的一模一样。\n- **闸红着的时候不许用话术放行**：不得说「通常可以放心使用」「来源可靠的话就没问题」这类话。闸没过就如实说没过、说清要改什么；把判断推回给用户，等于替他把闸抹平了。`
    : ""
  const loopRule = gates.length ? "同一闸反复回退 ≥2 次仍不过就停下问用户，别无限返工。" : ""
  return `${noteTxt}\n- **本模块的标准流程**：${chain}。${gateTxt}按此顺序推进；确有理由跳步或合并要先向用户说明。${loopRule}${gateRules}`
}

/** 产物契约：告诉 agent 用约定文件名，界面才认得出并渲染成表格/卡片 */
export function artifactLine(mod, values) {
  const names = [...new Set(stepsFor(mod, values).flatMap((s) => s.emits || []))]
  if (!names.length) return ""
  return `\n- **产物文件名用约定名**（界面按文件名把产物渲染成表格/文献卡片/报告，名字对不上就只能当普通附件列出）：${names.join("、")}。确有额外产物照常写，不受此限。`
}
