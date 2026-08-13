// 流程状态机 —— 会话步骤条的唯一裁定者（从 server.mjs 抽出成模块）。
//
// 【为什么单独一个文件】这台状态机此前埋在 server.mjs 四千行里，零测试覆盖 —— 闸的措辞正则
// 有 gate-verdict.test.mjs 用真实案例锁着，而 done/failed/implied/stale/staleUp 的推导逻辑
// 每次只能靠线上实测发现回退。抽出来之后 test/wf-state.test.mjs 直接 import 本文件对临时目录跑，
// 「测的就是跑的那一份」。server.mjs 里只留 HTTP 与会话解析，状态推导全在这里。
//
// 【设计不变】进度由"产物文件出现了没有"反推（不问 agent），闸由报告内容裁定。本次抽出时
// 一并修的四类系统性误报（每条都有线上实测）：
//   ① staleUp 改按【轮次批次】比较而不是裸 mtime —— agent 在同一轮里天然乱序写文件
//      （出完 table1 又补一份 stats_extra.csv），mtime 级联会把整段下游误标"已过期"；
//   ② 闸支持 gateReport：裁定只读裁定书，不再把 preregistration.md 这类同步产物当报告读
//      （报告还没写出来的窗口里闸会提前变绿）；
//   ③ 闸支持结构化裁定 .gate/<skill>.json：脚本型闸（verify_refs.py）直接落机器可读结论，
//      绕开报告措辞正则的先天误判；措辞判定退为兜底；
//   ④ emits 的裸 glob 只认【会话根目录】的文件（带 / 的照旧整条比）—— basename 全树匹配
//      会让深层缓存/素材文件误点亮步骤；产物契约本来就要求交付物放根目录。
import fs from "node:fs"
import path from "node:path"
import * as WF from "./workflows.mjs"

// ---- 会话的工作流状态（表单值 + 步骤进度）----
// 落在【会话产物目录】而不是全局表：它天然随会话建、随会话删（删会话会整目录清掉），
// 也跟着产物一起被打包/迁移。下划线前缀 → server 的产物列表里排掉它。
// 【谁写】服务端。进度由"产物文件出现了没有"反推（见 wfSyncDone），不依赖模型自觉汇报。
// 【不是防篡改边界】这个文件就在会话产物目录里，agent 有 shell、对该目录有写权，它想改就能改
// （把 done 全填上、或把 form.deidDone 置真把脱敏步从自己的剧本里剔掉）。这不构成提权——技能白名单
// 来自 MODULE_DEFS，压根不看这个文件——但别把它当权威账本用。真正的强制在事件流那道闸上。
// 故 wfLoad 对形状做基本校验：坏数据（如 done 写成字符串）会被 new Set("abc") 拆成 ["a","b","c"] 写回。
export const WF_STATE = "_workflow.json"
export const wfLoad = (outDir) => {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(outDir, WF_STATE), "utf8"))
    if (!st || typeof st !== "object" || Array.isArray(st)) return null
    if (typeof st.module !== "string") return null
    if (!Array.isArray(st.done)) st.done = []
    else st.done = st.done.filter((x) => typeof x === "string")
    if (!st.form || typeof st.form !== "object" || Array.isArray(st.form)) st.form = {}
    return st
  } catch { return null }
}
export const wfSave = (outDir, st) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, WF_STATE), JSON.stringify(st, null, 2)) }
  catch (e) { console.warn(`[workflow] 状态写入失败：${e.message}`) }
}
/**
 * 表单值（intake + 各步 form 合并成一张平表，供 when 条件判定与跨步继承）。
 * 【要求传 modId 并核对】这个文件落在会话产物目录里，而 agent 对该目录有读写权（它有 shell）。
 * 不核对的话，一份 module 对不上的簿子会被拿去裁剪【另一个模块】的步骤链，前言就成了胡话。
 * 必须过 withDefaults：跳过表单直接打字这条路服务端拿到的是 {}，而所有 when 条件按
 * "字段未填"求值 —— refcheck 会因此退化成【零步骤】（没有任何闸）。
 */
export const wfValues = (outDir, modId) => {
  const st = wfLoad(outDir)
  return WF.withDefaults(modId, (st && st.module === modId && st.form) ? st.form : {})
}

// ---- emits 命中判定 ----
// ★ 裸 glob（不含 /）只认【会话根目录】的文件。原来是按 basename 在整棵产物树（深 8 层）里比，
//   于是深层的素材/缓存文件也能点亮步骤：文献全文目录里一份 review.md、图表工程里的 fig_draft.png
//   都会把对应步骤误标"已完成"，且 done 一经写入极难被用户发现是假的。
//   产物契约（CLAUDE.md §五 + artifactLine 前言）本来就要求交付物放会话根目录，
//   带目录的 emits（audit/*、figures/*）照旧整条路径比 —— 显式声明的子目录不受影响。
export const emitMatch = (glob, rel) => {
  if (!glob || !rel) return false
  if (glob.includes("/")) return WF.globMatch(glob, rel)
  return !String(rel).includes("/") && WF.globMatch(glob, rel)
}
// 一份文件算不算某一步的产物：emits 命中【且】不在 emitsNot 里。
// emitsNot 是因为 emits 的通配互相重叠：manuscript_*.md 会把润色步的 manuscript_humanized.md
// 收走，让"撰写正文"凭空变绿（用户自带初稿只想润色的实测案例）。
export const emitHit = (s, f) => (s.emits || []).some((g) => emitMatch(g, f))
  && !(s.emitsNot || []).some((g) => emitMatch(g, f))
// 闸的【裁定书】命中判定：有 gateReport 就只认它 —— 闸的 emits 里常混着同步产物
// （preregistration.md / analysis_plan.md / 机器 csv），拿它们当报告读，要么在裁定书
// 还没写出来的窗口里让闸提前变绿，要么把预注册文件里的假设句（"缺氧不通过甲基化…"）
// 误读成裁定（两种都实测踩过）。没有 gateReport 的闸退回 emits（老行为）。
export const reportHit = (s, f) => ((s.gateReport || s.emits) || []).some((g) => emitMatch(g, f))
  && !(s.emitsNot || []).some((g) => emitMatch(g, f))

// ---- 质量闸的报告到底判没判过 ----
// 只认【明确写出的否定结论】，其余一律当通过 —— 宁可漏判也不能误判：把一份其实通过了的稿子
// 标成"需返工"，用户会白白多跑一轮。所以这里的词表是各技能报告里真实用的定论措辞，不做泛化匹配。
// 判据分两层，都是踩出来的：
// ① 单看关键词会【反向误报】—— peer-review 的报告哪怕结论是通过，也照样有一节标题叫
//    "### Critical（不改会被拒/结论不成立）"。拿裸 critical 判失败，等于每份评审报告都标"需返工"。
// ② 只列书面词又会【漏判】—— 模型实际写的是「裁定：**闸不过（回退 #1）**」「条件性通过（需返工）」，
//    这两句都不含"不通过"三个字。
// 所以：无歧义的定论词全文匹配；容易误伤的词（reject / 不通过 / critical）只在【结论行】上算数，
// 而"结论行"要排除 markdown 标题 —— 小节标题里出现"结论"二字太常见（上面那个 Critical 标题就是）。
// 否定前缀：这些词一旦被否定，含义就反过来了 —— 「无需返工」「未发现假引用」「无未通过项」
// 都是【通过】的意思。纯子串匹配会把它们全判成红（实测 7 条真实通过措辞全中招）。
// 用变长负向后顾把它们挡掉。宁可漏判也不能误判：假红会让用户白跑一轮，还会把交付物警示变成狼来了。
// ★ 英文同样要挡，而且【不能只挡紧挨着的那个词】。实测：
//   `Decision: Accept as is. No major revision required.` 被判红 —— "major revision" 前面那个
//   英文 No 不在词表里，一个字都挡不住。11 条"其实通过"的英文写法里 6 条中招。
//   而真实写法还有 `does not require major revision` 这种否定词与裁定语之间隔着动词的，
//   所以英文这一支允许中间夹最多 24 个【非句末】字符（句号/分号/问号/换行不跨，免得把上一句的
//   否定算到下一句头上）。
// ★ 中文那一支保持"紧邻"不变：中文里"不/未"与裁定语之间基本不插词，放宽反而会把
//   "未做敏感性分析，需返工"这类【否定在前、裁定在后】的句子误放行 —— 那是两件事，不是否定。
// ★ 历史回顾也要挡（第三组前缀）。复审报告的常态写法是回顾上一轮裁定：实测原句
//   「**复审日期：** 2026-08-11（初评 Major revision → 返工 → 复审）」—— 报告结论明明是
//   「✅ 评审自查闸通过」，却因这句对初评的转述被判红，模型完整照做了"返工→重跑闸→写新报告"
//   的解锁流程仍然出不了件（正是 gateFailed 头注里"把人带进死胡同"的那种）。
//   初评/上一轮/此前 这类回顾词后面跟的裁定语是【在转述历史】，不是本轮结论。
//   代价（可接受）：「此前的问题仍在，Major revision」会被放过 —— 但真复不过的报告必然还写
//   未通过/需返工（自带裁定词，不受此前缀影响），条目计数与结论行判据也都还在兜底。
export const NEG_PREFIX = "(?<!无|不|未|毋|没|没有|未见|未发现|不存在|未出现|无任何|不含|零" +
  "|\\b(?:no|not|none|without|free of)\\b[^.;!?\\n]{0,24}" +
  "|(?:初评|初审|首轮|上一轮|上轮|前一轮|前一版|此前|原判|复审前)[^。.;!?\\n]{0,24}" +
  "|\\b(?:initial|previous|prior|earlier|first)\\s+(?:review|round|assessment|verdict)\\b[^.;!?\\n]{0,24})"
export const GATE_FAIL_SURE = new RegExp(NEG_PREFIX +
  // ★ 「不通过」后面必须跟句读或行尾。医学写作里它极常见地当【普通动宾】用 ——
  //   "不通过血脑屏障""不通过静脉给药"，实测踩到的原句是预注册文件里的假设：
  //   "缺氧**不通过**甲基化改变促进复发"。裁定语本来就有 未通过 / 不予通过 / 闸不过 覆盖，
  //   这一条只需堵住动宾用法。收尾字符里【必须带上 markdown 标记】：真实写法是
  //   「本闸判定 **不通过**」，`不通过` 后面紧跟的是 `**` 而不是句读。
  "(闸不过|闸未过|不予通过|未通过|不通过(?=[\\s，。；、）)\\]】*_`~]|$)|需返工|需要返工|退回返工|条件性通过|major\\s*revision|需要?重大修改" +
  "|假引用|伪造引用|编造的?引用|查无此文|未能核实|该文献不存在)", "i")
// 否定写在裁定语【后面】的写法：`Major revision: none` / `Major revision — N/A` /
// `Major revision is not necessary.` / `需返工：无`。GATE_FAIL_SURE 是纯前缀否定（NEG_PREFIX），
// 这四句实测【全判红】，而它们全是通过。所以再加一道后缀否定，由 sureFailed 逐行配合使用。
// 距离限制 16 字符且不跨句读（`;`/`。`/`.` 都在排除集里）—— 不限的话，
// `Major revision required; none of the analyses account for clustering` 会被后半句的 none 放行。
export const SURE_TAIL_NEG = /^[^。.;!?\n]{0,16}(无|没有|none|n\/?a|unnecessary|not\s+(required|necessary|needed|warranted|recommended)|0\s*[条项个]?\s*$)/i
// GATE_FAIL_SURE 的实际用法：【逐行】判，并放过后缀被否定掉的那一行。
// 裁定语不会跨行，所以逐行与整篇在检出侧等价，只是多了否定的判断余地。
export const sureFailed = (t) => {
  for (const ln of t.split(/\r?\n/)) {
    const m = ln.match(GATE_FAIL_SURE)
    if (!m) continue
    if (SURE_TAIL_NEG.test(ln.slice(m.index + m[0].length))) continue
    return true
  }
  return false
}
// g 标志是给【逐个匹配、逐个查否定】用的（见 gateTextFailed 末尾那段）：整行 test 一下就返回红，
// 会把 `Recommendation: Accept. No critical issues.` 这类【否定过的】判成未通过。用前必须归零 lastIndex。
export const GATE_FAIL_CTX = /(reject|critical|严重问题|硬伤)/gi
// 「这个词是不是被否定掉了」：只看它【前面】那一小段。中英都收；`[^。.;!?\n]{0,24}` 限制作用距离，
// 且不跨句 —— 不限距离的话，"未做敏感性分析。结论：存在硬伤"会被上一句的"未"放行。
export const NEG_NEAR = /(无|没有|未见|未发现|不存在|未出现|不含|零|\b(?:no|not|none|without|free of)\b)[^。.;!?\n]{0,24}$/i
// reference-check / data-integrity 的裁定是结构化词，不是散文。两种真实写法：
//   统计行  `RETRACTED 1，FABRICATED 2，NOT_FOUND 1，MISMATCH 1`（全绿时是 0，不能裸匹配）
//   表格行  `| [7] | … | **FABRICATED** | 高 |`
// ★ CHECK / UNVERIFIED 必须在列表里（理由见 server.mjs 抽出前的详注：CHECK 是"没人能确认真假"、
//   UNVERIFIED 是"只验了存在性没比对标题"，两种都恰恰最该让作者自己去核）。
// ★ 按词分成两条，是因为大小写敏感性不能一刀切：
//   · 这几个词不会在散文里当普通词用，保留 i —— 模型转述统计行时写成 `unverified 3` 也要认。
export const GATE_FAIL_COUNT = /(FABRICATED|RETRACTED|MISMATCH|NOT[_\s]?FOUND|UNVERIFIED)\s*[:：=]?\s*[1-9]/i
//   · CHECK / ERROR 则是英文散文里的日常词，带 i 就会把 `Check 1: sample size reported`
//     （英文报告里再普通不过的编号清单）读成"有 1 条待核引用"→ 整份报告判红（实测中招）。
//     它们在真报告里只以【全大写机器裁定词】出现（verify_refs.py 吐的），所以限定大写。
export const GATE_FAIL_COUNT_CAPS = /\b(CHECK|ERROR)\s*[:：=]?\s*[1-9]/
// 技能在报告里主动写的"别据此宣布通过"——它比任何计数都更明确，直接认。
export const GATE_SELF_WARN = /不要据此宣布|不能据此宣布|不应据此宣布|别据此宣布/
export const GATE_FAIL_CELL = /\|\s*\*{0,2}(FABRICATED|RETRACTED|MISMATCH|NOT[_\s]?FOUND|CHECK)\*{0,2}\s*\|/i
export const VERDICT_LINE = /(判定|裁定|结论|总体评价|总评|倾向|建议|verdict|recommendation|decision)/i
// 报告里【明确写出的通过裁定】。出现它时，正文里的 Major/Critical 条目不再单独把闸判红。
// 【为什么让位】评审报告里的 Major 有相当一部分根本不是稿件的方法学缺陷，而是"用户还没交的材料"
// —— 伦理批号、注册号、原始记录、代表作清单。这类条目的措辞五花八门，靠词表永远补不全。
// 【让位的边界，三条都要】① 只有明确的通过裁定才让位（总评写软不算）；② 只让位给条目计数
// （sureFailed / 机器统计行 / GATE_SELF_WARN / 结论行照旧）；③ 「通过」前面不能是 未/不。
export const GATE_PASS_SURE = new RegExp(
  "(闸\\s*(?:已|均|全部)?\\s*(?<![未不])通过" +
  "|(?:判定|裁定|结论|总评|总体评价)\\s*[:：]?\\s*\\**\\s*(?:已|均)?\\s*(?<![未不])通过" +
  "|(?:verdict|recommendation|decision)\\s*[:：]\\s*\\**\\s*(?:accept|pass)\\b)", "i")
// 「信号型」闸的判据。data-integrity 是唯一一个【被铁律明令禁止写裁定语】的闸
// （signal not verdict）。上面那些判据全在找裁定语，两个设计天然互斥 —— 不单列的话
// 这道闸永远判不了红（实测：报告列了 6 条硬性不自洽，步骤条照打绿勾）。
// 按【信号条数】判：audit/REPORT.md 的机器统计行 + 人工核对条目锚点 + 小节计数短语。
export const SIGNAL_MED_HIGH = /(High|Medium|高|中)\s*[:：]?\s*([1-9]\d*)/g
// ★ 条目锚点必须写宽：实测模型写的是 `### ★1. …` 或压根不用 ★ 而写「重大信号（5 项）」。
//   两条锚点并列：① 条目符号（★/⭐，允许前面有标题号/列表符/加粗）；② 小节计数短语。
export const SIGNAL_ITEM = /(^|\n)\s*(?:#{1,6}\s*)?(?:[-*•]\s*)?(?:\*\*\s*)?[★⭐]\s*\d+/
export const SIGNAL_COUNT_PHRASE = /(?<![无未没])(重大信号|严重信号|待核信号|需核对|需要核对|待核对|人工核对)[^\n]{0,12}?[（(：:\s]\s*([1-9]\d*)\s*[项条个]/
export function signalGateFailed(t) {
  if (SIGNAL_ITEM.test(t) || SIGNAL_COUNT_PHRASE.test(t)) return true
  let m
  SIGNAL_MED_HIGH.lastIndex = 0
  while ((m = SIGNAL_MED_HIGH.exec(t))) {
    // 只在"信号统计"这类计数行上算数，避免把正文里的"中位数 3"之类误读成信号数
    const line = t.slice(t.lastIndexOf("\n", m.index) + 1, t.indexOf("\n", m.index) < 0 ? undefined : t.indexOf("\n", m.index))
    if (/信号|signal|统计|统计：/i.test(line)) return true
  }
  return false
}
/**
 * 一份报告【正文】判没判过 —— 纯文本层，不碰文件系统。
 * 抽成独立函数是为了 gate-verdict.test.mjs 能直接 import（原来靠从 server.mjs 源码里
 * 抠字符串重新求值，函数结构一变测试就瞎）。
 */
export function gateTextFailed(t) {
  if (sureFailed(t) || GATE_FAIL_COUNT.test(t) || GATE_FAIL_COUNT_CAPS.test(t)
      || GATE_FAIL_CELL.test(t) || GATE_SELF_WARN.test(t)) return true
  // 正文里的严重条目：结论行的措辞可能被模型写软（实测正文 4 条 **Major**，总评却是
  // "Minor to moderate revision"），只认总评就被绕过。只数【条目行】，标题行不算。
  // 带否定的条目（"无 Major 问题"）不计。
  let sev = 0
  for (const ln of t.split(/\r?\n/)) {
    if (/^\s*#/.test(ln)) continue
    if (!/^\s*([-*•]|\d+[.)]|\|)/.test(ln)) continue
    // ★ 严重度标记不能要求"这个词【单独】被加粗"。实测 peer-review 写的是整行加粗的表头式条目：
    //   `**M1 | Critical | H18 … | 缺乏申请人自己的科学证据**`。收两种形态：
    //   ① 行内任一加粗段里出现该词；② 表格单元格 `| Critical |`。
    if (!/\*\*[^*\n]*\b(major|critical)\b[^*\n]*\*\*/i.test(ln)
        && !/\*\*[^*\n]*严重[^*\n]*\*\*/.test(ln)
        && !/\|\s*\**\s*(major|critical|严重)\s*\**\s*\|/i.test(ln)) continue
    // ★ 放宽检出侧之后，【否定侧必须同步放宽】：`- 未发现 **Major** 问题` 这类中间隔着
    //   markdown 标记的否定也要认，否则同一句话加不加粗结果相反。
    if (/(无|没有|未发现|未见|不存在|none|no|not|without)\s*[*_`]*\s*(major|critical|严重)/i.test(ln)) continue
    // 否定词也可能在标记【之后】：`- 本节 **Major** 问题：无` / `Critical: none` / `严重问题：0`
    if (/[:：]\s*[*_`]*\s*(无|没有|none|n\/?a|0)\s*[条项个]?\s*$/i.test(ln)) continue
    // ★ 分级说明 / 图例行不是条目。三级并列出现（Critical、Major、Minor 同在一行）
    //   就是在解释 severity 分级，不是在报告一条问题。
    if (/critical/i.test(ln) && /major/i.test(ln) && /minor/i.test(ln)) continue
    // ★★ 「等用户补事实」不是稿件缺陷，不能计入。AI 协助写的稿子几乎必然以"伦理批号待补充"
    //   收尾，而称职的评审必然把它标 Critical —— 计入的话 render 被硬拦、用户永远拿不到 Word
    //   （完整因果链见 CLAUDE.md §二 判级铁律）。中英文两套豁免都要有。
    if (/(待补充|待填|需你|只能由你|无法代为编造|不能代填|由你(方|们)?提供|需(用户|作者|申请人)提供|投稿前(必办|补齐|填入))/.test(ln)) continue
    if (/\b(to be (provided|supplied|filled|completed|confirmed|obtained|added)|pending (irb|ethic|approval|registration|submission)|awaiting (irb|ethic|approval)|not yet (provided|obtained|available)|tbd|to be determined|only you can provide)\b/i.test(ln)) continue
    // ★ 计数为零的表格行放行：`| Critical | 不改则拒 | 0 |`（严重度图例表）
    if (/^\s*\|/.test(ln) && /\|\s*\**\s*(0|无|未使用|未命中|none)\s*[条项个]?\s*\**\s*\|?\s*$/i.test(ln)) continue
    sev++
  }
  // ★ 报告已经明确写了"通过"裁定 → 条目计数让位（见 GATE_PASS_SURE 的三条边界）。
  if (sev && !GATE_PASS_SURE.test(t)) return true
  for (const ln of t.split(/\r?\n/)) {
    if (/^\s*#/.test(ln)) continue                       // markdown 标题不是结论行
    if (!VERDICT_LINE.test(ln)) continue
    // ★★ 结论行恰恰是最爱写否定式的地方（`Recommendation: Accept. No critical issues.`），
    //   逐个匹配、逐个查它前面有没有否定词；全被否定掉才算这行没问题。
    GATE_FAIL_CTX.lastIndex = 0
    let m
    while ((m = GATE_FAIL_CTX.exec(ln))) if (!NEG_NEAR.test(ln.slice(0, m.index))) return true
  }
  return false
}

// ---- 结构化裁定（.gate/<skill>.json）----
// 脚本型闸（verify_refs.py / audit_report.py）在写报告的同时落一份机器可读结论：
//   { "skill": "reference-check", "verdict": "pass" | "fail", ... }
// 网关优先读它 —— 措辞正则的先天误判（假红让用户白跑返工、假绿放走硬伤）在脚本自己
// 已经数清楚了的场合根本不必发生。措辞判定退为兜底（没有 json、或 json 过期时）。
// 【新鲜度按轮次批次比】json 躺在点目录里不进产物列表，wfNoteBatch 单独给它记批次
// （mtime 变了就算当轮写的）。裁定所描述的报告若在【更晚的轮次】里被重写过（改稿后模型
// 重写了报告但没重跑脚本），旧裁定作废、退回措辞判定 —— 拿 mtime 直接比做不到这一点：
// 模型在同一轮里紧跟着脚本重写报告是常态，按 mtime 判 json 永远是"过期"的。
// 【信号型闸只认 fail】data-integrity 的闸结论 = 机器扫描 + 模型人工核对两半，json 只描述
// 机器那半 —— json 说 pass 不能豁免人工报告里列出的信号，否则又是 fail-open。
// 【不是防篡改边界】agent 有 shell，铁了心能自己写一份 pass json —— 与它直接改
// _workflow.json 同级，本模块从头到尾防的是"失真"不是"恶意"（见 WF_STATE 头注）。
function gateVerdict(outDir, step, files, st) {
  const names = [step.skill, ...(step.skillAlias || [])]
  let best = null
  for (const n of names) {
    const fp = path.join(outDir, ".gate", n + ".json")
    try {
      const stat = fs.statSync(fp)
      const j = JSON.parse(fs.readFileSync(fp, "utf8"))
      if (!j || (j.verdict !== "pass" && j.verdict !== "fail")) continue
      if (!best || stat.mtimeMs > best._mtime) best = { ...j, _mtime: stat.mtimeMs, _name: n + ".json" }
    } catch { /* 没有 / 读不了 / 不是 JSON → 当作没有结构化裁定 */ }
  }
  if (!best) return null
  const curBatch = (st?.batchN || 0) + 1          // 未记批次 = 本轮进行中
  const jb = st?.gateBatches?.[best._name] ?? curBatch
  let rb = -1
  for (const f of files) if (reportHit(step, f) && /\.(md|txt)$/i.test(f)) rb = Math.max(rb, st?.batches?.[f] ?? curBatch)
  if (rb > jb) return null                         // 报告比裁定新一轮 → 裁定过期
  return best
}

export function gateFailed(outDir, step, files, fstate, st) {
  // 结构化裁定优先（见 gateVerdict 头注）。fail 恒生效；pass 只对措辞型闸生效 ——
  // 信号型闸（gateBy:"signals"）的人工报告不受 json 描述，pass 不能替它作保。
  const v = gateVerdict(outDir, step, files, st)
  if (v) {
    if (v.verdict === "fail") return true
    if (step.gateBy !== "signals") return false
  }
  for (const g of (step.gateReport || step.emits) || []) {
    // ★ 一个通配下有多份报告时，【只认最新的那一份】—— 模型第二轮换个文件名写新报告
    //   （reference_check_round2.md）是完全合规的，第一轮那份红报告不能永久卡红。
    //   只在【同一个 pattern 内】取最新，不跨 pattern：跨组取最新会读到不含裁定的那份
    //   → 闸静默变绿，那是 fail-open，比卡红严重得多。
    let cand = files.filter((f) => emitMatch(g, f) && /\.(md|txt)$/i.test(f))
    if (cand.length > 1 && /[*?]/.test(g)) {
      const newest = cand.reduce((a, b) => ((fstate?.[b] || 0) > (fstate?.[a] || 0) ? b : a))
      const dropped = cand.filter((f) => f !== newest)
      if (dropped.length) console.warn(`[workflow] 闸 ${step.id}：${g} 命中多份报告，以最新的 ${newest} 为准（忽略 ${dropped.join("、")}）`)
      cand = [newest]
    }
    for (const f of cand) {
      if (!/\.(md|txt)$/i.test(f)) continue   // 只读文本报告
      try {
        // ★ 实测 kimi 把 reference_check_report.md 写成了同名【目录】，里面才是真报告。
        //   直接 readFileSync 会抛 EISDIR → 落进 catch → "读不到就按通过处理" → 闸静默变绿。
        //   命中目录就往里找一层文本报告，找不到再放弃。
        let fp = path.join(outDir, f)
        if (fs.statSync(fp).isDirectory()) {
          const inner = fs.readdirSync(fp).filter((x) => /\.(md|txt)$/i.test(x))
          if (!inner.length) { console.warn(`[workflow] 闸产物 ${f} 是个空目录，无法裁定`); continue }
          fp = path.join(fp, inner[0])
        }
        const t = fs.readFileSync(fp, "utf8").slice(0, 20000)
        // 信号型闸（data-integrity）：它被铁律禁止写裁定语，只能按信号条数判。
        // 仍然把通用判据一并跑一遍：万一模型确实写了"未通过"，没有理由放过。
        if (step.gateBy === "signals" && signalGateFailed(t)) return true
        if (gateTextFailed(t)) return true
      } catch { /* 读不到就别拦，按通过处理 */ }
    }
  }
  return false
}

// ---- 轮次批次记账 ----
/**
 * 轮末调用：本轮新建/改动的文件统一记成同一个批次号。staleUp 靠它比"谁比谁新"——
 * 【为什么不能用裸 mtime】agent 在一轮里天然乱序写文件：出完 table1.csv 又回头补一份
 * stats_extra.csv（命中上游 stats 步的通配），上游时间戳一后移，中间所有步骤瞬间全被
 * 误标「上游改过之后没重做」。同一轮写出来的东西互相之间没有"谁过期"可言，
 * 只有跨轮（改了稿没重跑闸）才是真过期。未记批次的文件（本轮进行中 / 老会话）
 * 一律按"当前批次"算 —— 方向是宁可漏标不误标。
 */
export function wfNoteBatch(outDir, modId, changed, fstate) {
  try {
    let st = wfLoad(outDir)
    if (!st) st = { module: modId, form: {}, done: [] }
    if (st.module !== modId) return          // 簿子记的是别的模块（agent 乱写过）→ 不动它
    st.batchN = (st.batchN || 0) + 1
    st.batches = st.batches || {}
    // 清掉已不存在的文件，簿子别无限膨胀（改名/被 agent 清理的文件对进度也不再有意义）
    if (fstate) for (const k of Object.keys(st.batches)) if (!(k in fstate)) delete st.batches[k]
    for (const f of changed || []) st.batches[f] = st.batchN
    // .gate/*.json 在点目录里、不进产物列表，批次单独记：mtime 变了就算本轮写的。
    // gateVerdict 拿它判断"裁定描述的是哪一轮的报告"（见其头注）。
    st.gateSeen = st.gateSeen || {}; st.gateBatches = st.gateBatches || {}
    try {
      for (const e of fs.readdirSync(path.join(outDir, ".gate"))) {
        if (!/\.json$/i.test(e)) continue
        const mt = fs.statSync(path.join(outDir, ".gate", e)).mtimeMs
        if (st.gateSeen[e] !== mt) { st.gateSeen[e] = mt; st.gateBatches[e] = st.batchN }
      }
    } catch { /* 没有 .gate 目录是常态 */ }
    wfSave(outDir, st)
  } catch (e) { console.warn(`[workflow] 批次记账失败：${e.message}`) }
}

// ---- 兜底归因 ----
// 归因只认交付物体裁 —— 脚本 / 日志 / 临时文件不算"这一步做出了东西"
const DELIVER_EXT = /\.(md|csv|tsv|xlsx|docx|pdf|pptx|png|jpe?g|svg|webp|bib|ris)$/i
/**
 * 轮末调用（只在正常收场的轮）：本轮调过技能、也写出了新产物，但产物名不合任何步骤的
 * emits 契约 → 把本轮调过的技能对应的步骤记进 attributed，wfSyncDone 把它们并进 done。
 * 【为什么需要】步骤判完成的唯一判据是 emits 命中，而模型写 `综述初稿.md` 这类不合契约名
 * 是高频事件 —— 那一步永远灰，若收尾步骤也不合名，整条全灰，用户看到的是
 * "AI 明明干完了，条子还停在第一步"。
 * 【边界】① 只归因本轮真调过的技能；② 只在确有"无主"交付物时归因（有合约产物的照常走
 * emits 那条路）；③ 闸永不归因 —— 闸的结论只能由报告得出；④ 该步已有合约产物的不归因；
 * ⑤ **单技能轮任意交付体裁都可归因；多技能轮只做「扩展名唯一映射」归因**。
 * 多技能轮里把孤儿算给每个调过的技能是连坐（模拟用户测试抓到的 Major：render 正常出件 +
 * humanize 一字未动 + 一份 random_notes.md，「语言润色」被打了绿勾——假绿比假灰危险得多）。
 * 但一刀切不归因又把【最常见的跑法】漏了：综述/标书常常一轮跑完全流程（检索+成文+核查+出件
 * 四技能同轮），模型给出件取个自由名（PD-1综述.docx），出件步就永远灰（2026-08-13 实测）。
 * 折中：多技能轮只对 docx/pdf/pptx 这三种【重交付体裁】归因，且要求"本轮调过的技能里，
 * 契约声明收这个扩展名的候选步恰好一个"——.md 人人都写，永远歧义、永远不归因，
 * random_notes.md 那类连坐照旧被挡住；而 .docx 在一条流水线里几乎只有出件步收。
 * 归因是弱于 emits 命中的旁证推断 —— 它错的时候错在"提前打勾"，emits 缺席时错的是"永远不打勾"。
 */
export function wfAttribute(outDir, modId, skills, changed, fstate) {
  if (!skills?.length || !changed?.length) return
  try {
    const st = wfLoad(outDir)
    if (!st || st.module !== modId) return
    const steps = WF.stepsFor(modId, st.form || {})
    if (!steps.length) return
    const claimed = (f) => steps.some((s) => emitHit(s, f))
    // ★ 被【任何一步】的 emitsNot 点名的文件不是"自由命名的孤儿"，是契约里明写【不算产物】
    //   的东西（refcheck_report.docx = 核查报告转的 Word）。不剔掉的话，归因会从侧门把 emitsNot
    //   防住的假绿原样放回来：报告一转 docx，「排版出件」就凭空绿了（2026-08-13 场景 8 实测）。
    //   注意判据是 emitsNot 单独命中即拉黑，不要求同一步的 emits 也命中 —— refcheck_report* 这类
    //   条目本来就是纯黑名单（它不命中该步任何 emits，纯防御地点名"这名字不是成稿"）。
    const blocked = (f) => steps.some((s) => (s.emitsNot || []).some((g) => emitMatch(g, f)))
    const orphans = changed.filter((f) => DELIVER_EXT.test(f) && !claimed(f) && !blocked(f))
    if (!orphans.length) return
    const files = Object.keys(fstate || {})
    const attributed = new Set(st.attributed || [])
    let added = false
    const ownedBy = (s) => skills.some((sk) => s.skill === sk || (s.skillAlias || []).includes(sk))
    // 候选步四条件：本轮调过它的技能、不是闸、没归因过、还没有任何合约产物（边界①③④）
    const open = (s) => ownedBy(s) && !s.gate && !attributed.has(s.id) && !files.some((f) => emitHit(s, f))
    if (skills.length === 1) {
      // 单技能轮："孤儿是它写的"这条推断站得住（原边界⑤），保持旧行为
      const hit = steps.find(open)
      if (hit) { attributed.add(hit.id); added = true }
    } else {
      // 多技能轮：扩展名唯一映射。ext 取孤儿文件后缀；候选步的 emits 里必须显式声明过该后缀
      //（"figures/*" 这类无后缀通配不算声明 —— 宁可少归因，别把歧义当唯一）。
      const declares = (s, ext) => (s.emits || []).some((g) => g.toLowerCase().endsWith("." + ext))
      for (const f of orphans) {
        const m = /\.(docx|pdf|pptx)$/i.exec(f)
        if (!m) continue
        const ext = m[1].toLowerCase()
        const cands = steps.filter((s) => open(s) && declares(s, ext))
        if (cands.length === 1) { attributed.add(cands[0].id); added = true }
      }
    }
    if (added) { st.attributed = [...attributed]; wfSave(outDir, st) }
  } catch (e) { console.warn(`[workflow] 兜底归因失败：${e.message}`) }
}

/** 按"产物文件是否已出现"反推已完成的步骤（权威判据，不问 agent）。
 * @param fstate dirState(outDir) 的结果：{相对路径: mtimeMs}。由调用方传入 ——
 *   目录遍历（含 PHI 过滤）留在 server.mjs，本模块不重复实现，测试则直接构造。
 */
export function wfSyncDone(outDir, modId, fstate) {
  let st = wfLoad(outDir)
  // ★ 状态簿不存在就地建一份。【直接在输入框打字】是最常见的路径（表单本来就设计成可跳过），
  //   那条路下这个文件原来永远不存在 → 进度永远是空的 → 步骤条从第一步纹丝不动。
  if (!st) { st = { module: modId, form: {}, done: [] }; wfSave(outDir, st) }
  if (st.module !== modId) return st   // 簿子记的是别的模块（agent 乱写过）→ 不拿它算，也不覆盖
  fstate = fstate || {}
  const files = Object.keys(fstate)
  // ★ done【每次从产物重算】，不吃上一轮落盘的缓存。原来非闸步骤 done 一经写入永不撤销 ——
  //   一个临时文件误点亮一次、或 agent 事后把产物改名/移走，绿勾都会永远挂着（假绿比假灰
  //   难被用户发现得多）。重算的代价只是每次多扫几遍文件名列表，可忽略。
  //   "跑了但成功时没有产物"的步骤照旧由下面的单调补齐（implied）兜住，不受影响。
  const done = new Set()
  const failed = new Set()
  const ordered = WF.stepsFor(modId, st.form || {})
  for (const s of ordered) {
    if (!files.some((f) => emitHit(s, f))) continue
    // ★ 质量闸不能"有文件就算过"（实测：报告白纸黑字 Major revision，步骤条照样绿勾）。
    if (s.gate) {
      // ★ 闸还得【有一份可裁定的文本报告】才谈得上"过"——且只认 gateReport（裁定书）那组：
      //   机器 csv / 预注册文件先落盘的窗口里闸不许提前变绿（实测两条路径：audit/scan.json
      //   先于 REPORT.md；reference_check.csv 先于 .md 且 csv 里写着 3 条 FABRICATED）。
      //   没有报告就【不记 done】（停在未开始，等报告），绝不记成通过。
      //   注：这只影响显示。出件硬拦看的是 failed（红），灰着的闸本来就不拦。
      const hasReport = files.some((f) => reportHit(s, f) && /\.(md|txt)$/i.test(f))
      if (!hasReport) continue
      if (gateFailed(outDir, s, files, fstate, st)) { failed.add(s.id); continue }
    }
    done.add(s.id)
  }
  // ★ 兜底归因的步骤并进 done（见 wfAttribute 头注）。闸与已被判红的不并；
  //   步骤后来有了合约产物的，归因记录自然冗余、无副作用。
  for (const id of st.attributed || []) {
    const s = ordered.find((x) => x.id === id)
    if (s && !s.gate && !failed.has(id)) done.add(id)
  }
  // ★ 闸红之后，排在它后面的已完成步骤要标成"已过期"，不能继续打绿勾 —— 不论其产物比闸
  //   报告早还是晚（"闸红着还把件出了"比"拿旧件充数"更要命，两种都实测出现过）。
  const stale = new Set()
  const hasArtifact = (s) => files.some((f) => emitHit(s, f))
  ordered.forEach((g, gi) => {
    if (!failed.has(g.id)) return
    for (let i = gi + 1; i < ordered.length; i++) {
      const s = ordered[i]
      if (!done.has(s.id)) continue
      if (!hasArtifact(s)) continue       // 这一步压根没有产物 → 交给下面的 implied 处理
      done.delete(s.id); stale.add(s.id)
    }
  })
  // ★ 另一半：【上游改过之后没重做】。比较用【轮次批次】而不是裸 mtime ——
  //   同一轮里 agent 乱序写文件是常态（出完 table1 又补一份 stats_extra.csv），按 mtime 比
  //   会把整段下游误标"已过期"（本次抽出模块时修的头号误报源，见文件头注 ①）。
  //   批次由 wfNoteBatch 在每轮收尾统一记；未记批次的文件（本轮进行中 / 老会话）按当前批次算。
  //   某步的产物批次比它【真实依赖的上游】小 = 这一步是拿旧输入做的 → 标过期（不打绿勾，但也不算红）。
  //   实测覆盖的两个假绿：① 出了 docx → 改稿 → 重跑闸转绿：整排绿而 Word 是旧版；
  //   ② 闸绿之后稿子又改了：「引用核查 ✓」纹丝不动 —— 闸绿的是另一份稿子。
  // ★★ "上游"按 step.deps 声明的【真实数据依赖】算，不按数组下标。模拟用户测试抓到的 Major：
  //   paper 的「基线表」与「统计分析」只是先后写在数组里，实际是并行分支（都只吃原始数据、
  //   互不消费对方产物）——按下标比的话，后一轮补写一份 stats csv 会把毫无关系的基线表连带
  //   标成"已过期"，前端当前步兜底还会让进度条倒退到那个假过期的格子上。
  //   deps 是【直接上游】的 step id 列表；比较沿依赖链传递（上游的上游改了同样算旧）。
  //   引用了被 when 剔掉的步骤就地跳过；【没声明 deps 的步骤退回旧行为】（所有在前步骤都算上游）
  //   —— 对真正线性的流水线两者等价，所以未标注的模块不会因此变糟。
  const staleUp = new Set()
  const curBatch = (st.batchN || 0) + 1
  const batchesMap = st.batches || {}
  const batchMemo = new Map()
  const batchOf = (s) => {
    if (batchMemo.has(s.id)) return batchMemo.get(s.id)
    let b = -1
    for (const f of files) if (emitHit(s, f)) b = Math.max(b, batchesMap[f] ?? curBatch)
    batchMemo.set(s.id, b)
    return b   // -1 = 没有产物
  }
  const byId = new Map(ordered.map((s) => [s.id, s]))
  const posOf = new Map(ordered.map((s, i) => [s.id, i]))
  const effUp = new Map()
  const upBatchOf = (s, guard) => {          // 该步全部上游（传递闭包）里最新的产物批次
    if (effUp.has(s.id)) return effUp.get(s.id)
    guard = guard || new Set()
    if (guard.has(s.id)) return -1           // 环是声明错误，断开比栈溢出好
    guard.add(s.id)
    const list = Array.isArray(s.deps)
      ? s.deps.map((id) => byId.get(id)).filter(Boolean)
      : ordered.slice(0, posOf.get(s.id))
    let u = -1
    for (const d of list) u = Math.max(u, batchOf(d), upBatchOf(d, guard))
    effUp.set(s.id, u)
    return u
  }
  for (const s of ordered) {
    if (batchOf(s) < 0) continue                      // 无产物的步骤不参与（implied 那条线管它）
    if (!done.has(s.id)) continue
    const u = upBatchOf(s)
    if (u >= 0 && batchOf(s) < u) { done.delete(s.id); stale.add(s.id); staleUp.add(s.id) }
  }
  // ★ 单调补齐：后面的步骤已完成 ⇒ 它前面的非闸步骤也一定跑过了。
  //   有些步骤**成功时也可能不产出文件**（零结果检索是成功，不是未完成）。
  //   补齐的步骤单独记进 implied，界面标"无产物"而不是绿勾 —— 成因可能是"真跑了但没产物"，
  //   也可能是"用户明说跳过"，服务端分不清，两种都标中性的"无产物"比一律绿勾诚实。
  //   **闸不补**：凭"后面做完了"推断闸通过是 fail-open。
  //   **可选步不补**：可选步的常态是【被跳过】，"后面做完了"推不出"它跑过了"——综述的
  //   「语言润色(可选)」被跳过后照补 implied，界面那句"跑过了但没有产物文件"就是在撒谎
  //   （2026-08-13 实测：每一次跳过润色直接出件都触发）。不补 = 保持灰 +「可选」，诚实。
  //   判据必须是"这一步有没有产物"而不是"它在不在 done 里"（幂等，防补齐标记被擦除）。
  const vals = WF.withDefaults(modId, st.form || {})
  const implied = new Set()
  let lastDone = -1
  ordered.forEach((s, i) => { if (done.has(s.id)) lastDone = i })
  for (let i = 0; i < lastDone; i++) {
    const s = ordered[i]
    // 排除 stale：那一步刚被上面从 done 里摘出去，这里再加回来会把"已过期"的提示挤掉。
    if (!s.gate && !failed.has(s.id) && !stale.has(s.id) && !hasArtifact(s) && !done.has(s.id)
        && !WF.isOptional(s, vals)) {
      done.add(s.id); implied.add(s.id)
    }
  }
  const arr = [...done], farr = [...failed], iarr = [...implied], sarr = [...stale], uarr = [...staleUp]
  // ★ 完成即退位。st.cur 只有提交表单时写入，没有别的清除点 —— 产物出来了就说明那步过了，
  //   当前位置交给前端的兜底（第一个未完成步）去推，比一个陈旧的值准。
  const curStale = !!st.cur && done.has(st.cur)
  if (curStale || arr.join() !== (st.done || []).join() || farr.join() !== (st.failed || []).join()
      || iarr.join() !== (st.implied || []).join() || sarr.join() !== (st.stale || []).join()
      || uarr.join() !== (st.staleUp || []).join()) {
    // 落盘前重读一次再只覆盖进度字段：本函数在轮次收尾跑，而用户可能正好同一时刻提交下一步表单
    //（/api/workflow/form 也写这个文件）。拿本函数开头那份旧快照整体写回，会把刚提交的表单值抹掉。
    // batches / attributed / gateSeen 等簿记字段也靠这一步保留。
    const fresh = wfLoad(outDir) || st
    fresh.done = arr; fresh.failed = farr; fresh.implied = iarr; fresh.stale = sarr; fresh.staleUp = uarr
    // 重读之后再判一次：中间用户可能刚提交了下一步的表单，此时 fresh.cur 是新的、不该清
    if (fresh.cur && done.has(fresh.cur)) fresh.cur = null
    wfSave(outDir, fresh)
    return fresh
  }
  return st
}
