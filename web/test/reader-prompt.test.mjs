// 阅读器的提示词拼装层：配置 → 模型真正收到的那段话。
//
// 【为什么单独测它】modes[].prompt 里有 {doc} / {data} / {vars} 三个占位符，前端替换后才发出去。
// 有值就替换；没值就把【占位符所在的那一句整句删掉】——那条正则是这层里唯一有风险的东西：
// 删多了会把相邻的要求一起吃掉（而剩下的话读起来仍然通顺，从产物上完全看不出少了要求），
// 删少了会把字面的 "{data}" 发给模型。两种都不会报错。
//
// 【怎么测的】直接从 reader.html 里把 promptFor / varsBlock 两个函数的源码抠出来，注入它们
// 依赖的几个全局后执行。测的是【线上那份代码本身】，不是它的复刻——复刻一份来测等于自己
// 给自己出题（这一点在本次改造里已经吃过亏：所有浏览器测试都把 run() 打了桩，于是
// "发出去的 module 写死成 litread" 这种错一路活到了第五轮）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import * as WF from "../workflows.mjs"

const html = fs.readFileSync(new URL("../reader.html", import.meta.url), "utf8")

/** 从 reader.html 里抠一个顶层函数的完整源码（按大括号配平找结尾） */
function grabFn(name) {
  const start = html.indexOf("function " + name + "(")
  assert.notEqual(start, -1, `reader.html 里找不到 ${name}()`)
  let depth = 0, i = html.indexOf("{", start)
  const from = i
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++
    else if (html[i] === "}") { depth--; if (depth === 0) break }
  }
  return html.slice(start, i + 1)
}

/** 造一个跑得动 promptFor 的最小环境。
 *  docName   ：当前在左栏看的那一份
 *  docFiles  ：左栏那一组（多文件模块用，形如 [{ name, size }]）；不给就按只有 docName 一份算
 *  dataFiles ：配套数值表【可以有好几份】，promptFor 要把它们全列进去 */
function makeEnv({ mod, docName = "", docFiles = null, dataFiles = [], settings = {} }) {
  const w = WF.WORKFLOWS[mod]
  const cfg = WF.workflowFor(mod, {}).reader
  const MODES = {}
  for (const m of cfg.modes) MODES[m.id] = m
  const fieldDef = (id) => (cfg.intake || []).find((f) => f.id === id) || null
  const src = grabFn("varsBlock") + "\n" + grabFn("promptFor") + "\nreturn { promptFor, varsBlock }"
  const make = new Function("MODES", "CFG", "docName", "docFiles", "dataFiles", "SETTINGS", "fieldDef", src)
  const docs = docFiles || (docName ? [{ name: docName }] : [])
  return { ...make(MODES, cfg, docName, docs, dataFiles, settings, fieldDef), cfg, MODES }
}

const READER_MODS = Object.entries(WF.WORKFLOWS).filter(([, w]) => w.ui === "reader").map(([id]) => id)

test("占位符都有值时：全部替换掉，不留任何 {xxx}", () => {
  for (const mod of READER_MODS) {
    const cfg = WF.workflowFor(mod, {}).reader
    const settings = {}
    for (const f of cfg.vars?.fields || []) settings[f] = "某一列"
    const { promptFor } = makeEnv({ mod, docName: "原件.pdf", dataFiles: [{ name: "数据.csv" }], settings })
    for (const m of cfg.modes) {
      if (!m.prompt) continue
      const out = promptFor(m.id)
      assert.match(out, new RegExp("^" + m.mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${mod}.${m.id} 的输出没有以模式标记开头`)
      assert.doesNotMatch(out, /\{(doc|data|vars)\}/,
        `${mod}.${m.id} 还留着没替换的占位符：${out.match(/\{[a-z]+\}/g)}`)
      // 只在真的声明了文件占位符时才要求文件名出现。{vars} 不算——像 stats 的「出版级图」
      // 画的是"上面的分析结果"，靠同一会话的上下文，本来就不该再点一次文件名。
      if (/\{(doc|data)\}/.test(m.prompt))
        assert.ok(out.includes("原件.pdf") || out.includes("数据.csv"),
          `${mod}.${m.id} 声明了文件占位符却没把文件名带进去`)
    }
  }
})

test("占位符没值时：只删掉它所在的那一句，别把相邻的要求一起吃掉", () => {
  for (const mod of READER_MODS) {
    const cfg = WF.workflowFor(mod, {}).reader
    // 什么都不给：docName 空、一份数值表都没传、变量一个没指
    const { promptFor } = makeEnv({ mod })
    for (const m of cfg.modes) {
      if (!m.prompt) continue
      const out = promptFor(m.id)
      assert.doesNotMatch(out, /\{(doc|data|vars)\}/, `${mod}.${m.id} 没值时把字面占位符发了出去`)
      // 【关键】提示词的主体不能被那条正则吃掉。占位符通常只出现在开头一两句里，
      // 后面那一大段"要求 / 铁律"必须原样还在 —— 少了它们，模型照样会输出东西，
      // 只是没有了不许编数据、不许改结论强度这些约束，而产物看起来完全正常。
      const body = m.prompt.split("\n\n").slice(1).join("\n\n")
      if (body.trim()) assert.ok(out.includes(body.trim().slice(0, 40)),
        `${mod}.${m.id} 占位符没值时，正文里的要求被一起删掉了`)
    }
  }
})

// 配套数值表是【一组】：一篇稿子的数据常常分散在主表 + 附表 + 随访表里。只把第一份发出去的话，
// 界面上明明写着"已上传 3 份"，模型却只看得见一份 —— 它不会报错，只会把没看见的当作不存在，
// 而核查报告读起来完全正常。
test("配套数值表有多份时：提示词里要全部列出", () => {
  const { promptFor } = makeEnv({
    mod: "refcheck", docName: "稿件.docx",
    dataFiles: [{ name: "主表.xlsx" }, { name: "附表.csv" }],
  })
  const out = promptFor("integrity")
  assert.ok(out.includes("主表.xlsx"), "少了第 1 份数值表")
  assert.ok(out.includes("附表.csv"), "少了第 2 份数值表 —— 只发第一份等于悄悄漏掉数据")
})

test("变量对应：指了的列要原样进提示词，没指的不许瞎编", () => {
  const { promptFor, varsBlock } = makeEnv({
    mod: "stats", docName: "cohort.csv",
    settings: { groupCol: "组别", timeCol: "随访月数", eventCol: "死亡" },
  })
  const blk = varsBlock()
  for (const [label, col] of [["分组列", "组别"], ["随访时间列", "随访月数"], ["终点事件列", "死亡"]])
    assert.ok(blk.includes(col), `变量对应里少了 ${label}=${col}`)
  // 没指的列不该出现（哪怕字段定义里有）
  assert.doesNotMatch(blk, /金标准列|待评价指标列/, "没指定的列不该出现在变量对应里")
  // 必须明确告诉模型"以我指定的为准 + 推断了要说出来"，否则认错列不会有任何提示
  assert.match(blk, /以我指定的为准/)
  assert.match(blk, /写清你把哪一列当成了什么/)
  assert.ok(promptFor("table1").includes("组别"), "基线表的提示词里要带上分组列")

  // 一个都没指时，整块不该出现（而不是留一个空的【变量对应】）
  const empty = makeEnv({ mod: "stats", docName: "cohort.csv" })
  assert.equal(empty.varsBlock(), "", "没指定任何列时不该拼出空的变量对应块")
})
