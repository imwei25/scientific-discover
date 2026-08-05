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
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, "..", "server.mjs"), "utf8")

// 直接从 server.mjs 抠出判据与判定逻辑：保证测的就是跑的那一份，
// 手抄一遍正则的话，转义一错就变成测了个假的（这个坑本轮踩过）。
function loadGate() {
  const grab = (name) => {
    const i = SRC.indexOf(`const ${name} =`)
    assert.ok(i >= 0, `server.mjs 里找不到 ${name}`)
    const rest = SRC.slice(i)
    const end = rest.indexOf("\nconst ", 1)
    return rest.slice(0, end > 0 ? end : 400)
  }
  const decls = ["NEG_PREFIX", "GATE_FAIL_SURE", "GATE_FAIL_CTX",
                 "GATE_FAIL_COUNT", "GATE_FAIL_CELL", "VERDICT_LINE"].map(grab).join("\n")
  const fnStart = SRC.indexOf("function gateFailed(")
  assert.ok(fnStart >= 0, "找不到 gateFailed")
  const body = SRC.slice(fnStart, SRC.indexOf("\n}", fnStart))
  const from = body.indexOf("if (GATE_FAIL_SURE.test(t)")
  const to = body.indexOf("      } catch")
  assert.ok(from >= 0 && to > from, "gateFailed 的判定段落抠不出来（函数结构变了？）")
  const decide = body.slice(from, to).split("\n").map((l) => l.replace(/^ {8}/, "  ")).join("\n")
  const ctx = {}
  new Function("ctx", decls + "\nctx.failed = (t) => {\n" + decide + "\n  return false\n}")(ctx)
  return ctx.failed
}

const failed = loadGate()

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
    ["## 总评\nMinor to moderate revision\n\n### 问题\n- M1 **Major** 3年生存声称与随访不符\n- M2 **Major** 切点循环论证",
     "总评被写软、正文却列了 Major——只认总评就被绕过"],
  ]
  for (const [t, why] of FAIL)
    assert.equal(failed(t), true, `漏判：${why}\n  原文：${t.slice(0, 60)}`)
})
