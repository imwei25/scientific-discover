// 质量闸「到底过没过」的判据 —— 这套用例全部来自真实跑批，别删、别简化。
//
// 这个判据改过四轮，每轮都是被实测打脸后才改对的：
//   ① 只要报告落盘就打绿勾（peer-review 白纸黑字 Major revision，步骤条照样绿）
//   ② 加了关键词匹配 → 裸 critical 太宽，peer-review 报告哪怕通过也有「### Critical」小节标题
//      → 每份报告都被标"需返工"
//   ③ 收窄成"只在结论行算数"→ 模型习惯把结论写成 `## 一、总体结论：**不通过**`（markdown 标题），
//      被整行跳过 → 漏判
//   ④ 纯子串匹配把否定式当肯定式：「无需返工」含「需返工」→ 一份明确写着"通过"的报告被判红，
//      实测 7 条真实通过措辞全中招
//
// 两个方向的代价不对称，但都真实存在：
//   · 误判红 → 用户白跑一轮返工，而且会把「未过闸交付物警示」变成狼来了，久了就没人看
//   · 漏判   → 带着 Major 硬伤 / 编造引用的稿子被打绿勾，医生据此投出去
// 所以本文件两个方向都要守住。
import test from "node:test"
import assert from "node:assert/strict"
// 状态机抽成 wf-state.mjs 之后，文本判定层（gateTextFailed）是导出的具名函数，
// 直接 import —— 测的就是跑的那一份，不必再从 server.mjs 源码里抠字符串重新求值
// （那套抠法对函数结构的每次重排都很脆，改判据先改测试胶水的日子到此为止）。
import { gateTextFailed as failed } from "../wf-state.mjs"

test("闸判据：真实的『通过』措辞一条都不许判红", () => {
  const PASS = [
    ["闸结论：通过。无需返工，可进入下游写作与出图。", "实测原文——「无需返工」曾被读成「需返工」"],
    ["不需返工", "否定式"],
    ["全部通过，无未通过项", "否定式"],
    ["无假引用", "否定式"],
    ["未发现假引用", "否定式（否定词两字）"],
    ["未见伪造引用", "否定式"],
    ["## 核查结论\n8/8 条 DOI 与标题均一致，通过。", "引用核查全绿"],
    ["统计：FABRICATED 0，RETRACTED 0，MISMATCH 0，OK 8", "全绿统计行——不能裸匹配关键词"],
    ["### Critical（不改会被拒/结论不成立）\n（无）", "只有小节标题，没有条目"],
    ["- 本节 **Major** 问题：无", "否定词在标记【之后】"],
    ["- **Critical**: none", "英文后置否定"],
    ["我们 rejected the null hypothesis（P<0.05）", "统计术语，不是评审结论"],
    // ---- 英文报告。改判据之前这一组【6 条全判红】，而它们全是「通过」的写法。
    //      模型用哪种语言写报告纯属偶然（用户一句"用英文写"就够），闸不该因此把人锁死。
    ["Recommendation: Accept. No critical issues were identified.", "结论行 + 前置否定"],
    ["Decision: Accept as is. No major revision required.", "英文 No 挡不住中文词表"],
    ["Verdict: Pass. No rejection grounds found.", "reject 是 rejection 的子串"],
    ["Recommendation: The manuscript does not require major revision.", "否定词与裁定语之间隔着动词"],
    ["Checklist\nCheck 1: sample size reported\nCheck 2: CONSORT followed", "编号清单，不是机器统计行"],
    ["- **Critical** — IRB approval number to be provided by the applicant", "等用户补材料的英文写法"],
    ["- **Critical** — trial registration pending, to be supplied by the author", "同上"],
    ["结论：未发现严重问题，可以出件。", "中文结论行的否定式——改之前同样判红"],
    ["评审闸已通过。", "最朴素的一句通过——「已通过」里没有任何否定裁定词，不能因为带「闸」「过」就红"],
    // ---- 明确写了通过裁定 → 正文的 Major/Critical 条目让位。评审里的 Major 有相当一部分是
    //      「用户还没交的材料」（伦理批号、注册号、原始记录），措辞穷举不完，靠词表补不齐。
    ["- **Major** 伦理批准文件尚未提供\n- **Major** 代表作清单待定\n\n评审闸已通过。", "条目让位于明确的通过裁定"],
    ["## 裁定\n判定：通过\n\n### 问题\n- M1 **Critical** 注册号缺失", "「判定：通过」同样算明确裁定"],
    ["Verdict: Accept.\n\n- **Critical** IRB approval letter not yet on file", "英文的明确通过裁定"],
    ["Major revision: none", "否定写在裁定语【后面】"],
    ["Major revision — N/A", "同上，破折号 + N/A"],
    ["需返工：无", "中文的后缀否定式"],
    ["Verdict: Accept. Major revision is not necessary.", "否定与裁定语之间隔着 is"],
    ["建议：接收，不存在严重问题。", "中文结论行的否定式"],
    ["总体评价：无硬伤。", "中文结论行的否定式"],
    // ---- 复审报告的历史回顾。实测原文（grant 会话 ws_msobe2n26dfdf10d，2026-08-11）：
    //      模型完整照做了"返工→重跑闸→写新报告"，新报告结论「✅ 评审自查闸通过」，
    //      却因回顾初评的那半句「（初评 Major revision → 返工 → 复审）」被判红、出件被拦 ——
    //      复审报告【必然】要转述上一轮裁定，回顾语不是本轮结论。
    ["**复审日期：** 2026-08-11（初评 Major revision → 返工 → 复审）\n\n" +
     "**当前无 Critical / Major 项**（方法学硬伤已清除）。\n\n## 闸判\n**✅ 评审自查闸通过**（Major 硬伤已修复；残留项均为 Minor 待补事实，不阻塞）。",
     "复审报告回顾初评裁定——历史转述不是本轮结论"],
    ["上一轮判定为需返工；本轮复核：问题已全部解决，判定：通过。", "中文回顾语+新裁定"],
    ["The initial review recommended major revision. All issues were addressed. Decision: Accept.", "英文回顾语+新裁定"],
  ]
  for (const [t, why] of PASS)
    assert.equal(failed(t), false, `误判红：${why}\n  原文：${t.slice(0, 60)}`)
})

test("闸判据：真实的『没过』措辞一条都不许漏", () => {
  const FAIL = [
    ["裁定：**闸不过（回退 #1）**", "标书实测——不含「不通过」三字"],
    ["闸判定：条件性通过（需返工）", "标书实测"],
    ["倾向 **Major revision**", "论文实测"],
    ["本闸判定 **不通过**", "正文里的裁定"],
    ["## 一、总体结论：**不通过**", "结论写在 markdown 标题里"],
    ["统计：ERROR 1，OK 11", "1 条未能核实，不该算通过"],
    ["统计：UNVERIFIED 19", "裸 DOI 只验了存在性"],
    ["RETRACTED 1，FABRICATED 2，NOT_FOUND 1，MISMATCH 1", "机器统计行"],
    ["| [7] | 张三 | **FABRICATED** | 高 |", "表格里的裁定单元格"],
    // ★ 这条与上面「条目让位于通过裁定」是一对，边界就划在这里：让位只认【明确的通过裁定】，
    //   总评被写软（Minor to moderate revision 不是"通过"）不算，照旧按条目判红。
    ["## 总评\nMinor to moderate revision\n\n### 问题\n- M1 **Major** 3年生存声称与随访不符\n- M2 **Major** 切点循环论证",
     "总评被写软、正文却列了 Major——只认总评就被绕过"],
    ["评审闸未通过。\n\n- **Major** 样本量计算缺失", "「未通过」不能被读成通过裁定，否则闸就是永远绿的摆设"],
    ["裁定：不予通过\n\n- **Critical** 主要结局在揭盲后被更换", "同上，另一种否定裁定"],
    // ---- 放宽否定判定之后，这一组是【防放过头】的对照：英文的真·没过一条都不许溜。
    ["Decision: Reject. The primary endpoint was changed after unblinding.", "英文拒稿结论"],
    ["Recommendation: Major revision before further consideration.", "英文大修"],
    ["- **Critical** — endpoint definition changed after unblinding", "英文硬伤条目"],
    ["统计：CHECK 3", "全大写机器统计行——CHECK 限定大写后仍要命中"],
    ["统计：unverified 3", "模型转述统计行时写成小写——这几个词不会在散文里当普通词用，仍要认"],
    ["Major revision required; none of the analyses account for clustering",
     "后缀否定不许跨句读——分号后面那个 none 说的是另一件事，不能拿它把大修放行"],
    ["Verdict: Not acceptable in the present form; critical flaws in the analysis.",
     "句号断句：前半句的 Not 不该把后半句的 critical 放行"],
  ]
  for (const [t, why] of FAIL)
    assert.equal(failed(t), true, `漏判：${why}\n  原文：${t.slice(0, 60)}`)
})
