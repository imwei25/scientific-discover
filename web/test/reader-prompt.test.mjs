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
  // promptFor 依赖的整条链都要抠进来（少一个就是 ReferenceError，不是"测出问题"）：
  // docListStr = {data} 的取值；settingsBlock/fmtSetting = 每轮跟着发的齿轮设定。
  const src = ["varsBlock", "docListStr", "settingsBlock", "fmtSetting", "promptFor"].map(grabFn).join("\n")
    + "\nreturn { promptFor, varsBlock, settingsBlock }"
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

// 自动认列（界面读表的前几行替用户填好那六个下拉）之后，「机器认的」和「用户指的」必须分两段发。
// 混成一段写"以我指定的为准"，等于给一个可能认错的列名披上用户的权威 —— 而列名认错不会报错，
// 只会产出一条看着很正常的错 KM 曲线，这正是整块变量面板存在的理由。
test("变量对应：机器自动填的、用户还没确认的列，不能冒充「用户指定」", () => {
  const auto = makeEnv({
    mod: "stats", docName: "cohort.xlsx",
    settings: { groupCol: "组别", eventCol: "是否死亡", timeCol: "随访月数",
      __varsBy: { groupCol: "ai", eventCol: "rule", timeCol: "user" }, __varsOK: false },
  }).varsBlock()
  assert.match(auto, /自动认出来的，我还没核对/, "自动填的那几列必须如实标明来路")
  assert.ok(auto.includes("组别") && auto.includes("是否死亡"))
  // 用户自己指的那一列仍然进「以我指定的为准」那一段
  assert.match(auto, /以我指定的为准[^【]*随访月数/)
  // 且必须明确要求模型自己再核一遍形状、对不上要停下来
  assert.match(auto, /先自己核一遍/)
  assert.match(auto, /别将就着算/)

  // 用户点过确认 → 全部升级成「以我指定的为准」，不再有"还没核对"那一段
  const okd = makeEnv({
    mod: "stats", docName: "cohort.xlsx",
    settings: { groupCol: "组别", __varsBy: { groupCol: "ai" }, __varsOK: true },
  }).varsBlock()
  assert.doesNotMatch(okd, /还没核对/, "用户确认之后不该还说他没核对")
  assert.match(okd, /以我指定的为准[^【]*组别/)
})

// 齿轮弹层里的设定【每一轮都要跟着发】。后端只把 pin:true 的字段钉进模块前言，而阅读器四个
// 模块的设定大多不是 pin —— 不在消息里带上的话，用户拨了开关（输出语言、顺便出投稿级图）
// 模型那边一个字都收不到，界面上却完全看不出没生效。
test("齿轮设定要进提示词：改了开关模型才收得到", () => {
  const { promptFor, settingsBlock } = makeEnv({
    mod: "stats", docName: "cohort.csv", settings: { figs: true, lang: "en" },
  })
  const blk = settingsBlock()
  assert.match(blk, /顺便出投稿级图＝是/, "布尔开关要发成人话，不是 true")
  assert.match(blk, /输出语言＝English/, "选项要发它的标签，不是内部值 en")
  for (const id of ["profile", "table1", "analyze"])
    assert.ok(promptFor(id).includes(blk), `${id} 的提示词末尾没带上本次设定`)

  // 用户没动过设置时要发【默认值】，不是什么都不发 —— 默认值同样作数（见 settingsLine 的注释：
  // "用户跳过表单时也照样生效，不要因为他没明说就自行其是"）。
  const dflt = makeEnv({ mod: "stats", docName: "cohort.csv", settings: {} }).settingsBlock()
  assert.match(dflt, /顺便出投稿级图＝否/, "没动过开关时要发它的默认值")
  assert.match(dflt, /输出语言＝中文/)
})

// 壳里写死过"这篇文献"，于是数据模块对着一张 Excel 说"我上传了一篇文献"。文案归模块管之后，
// 每个阅读器模块都必须自带这两句，否则又会退回壳里那个中性兜底。
test("智能助手的文案归模块管，四个阅读器模块都要有", () => {
  for (const mod of READER_MODS) {
    const cfg = WF.workflowFor(mod, {}).reader
    assert.ok(cfg.chat && cfg.chat.placeholder && cfg.chat.firstTurn, `${mod} 缺 reader.chat 文案`)
    assert.match(cfg.chat.firstTurn, /\{doc\}/, `${mod}.chat.firstTurn 里没有 {doc}，文件名带不进去`)
  }
  // 数据模块不许再自称"文献"
  const stats = WF.workflowFor("stats", {}).reader.chat
  assert.doesNotMatch(stats.placeholder + stats.firstTurn, /文献/, "数据模块的文案还在说「文献」")
})

/* ============================================================
   两阶段模式（「演示 PPT」）：先出大纲 → 用户点按钮 → 才出片
   ------------------------------------------------------------
   【为什么值得单独测】这一格此前是"点了只出大纲、看着像做完了"：
     ① 提示词把"写大纲"和"出片"塞进一句话，还带一句"我要先审一遍"——模型写完大纲就结束；
     ② `ppt-master` 内部那道 ⛔ BLOCKING 的 Strategist 确认闸默认要开 Confirm UI，
        网页版用户打不开那个页面，于是它必然停在那里等确认；
     ③ 就算跑完，成品在 `<项目名>/exports/` 里（两层深），/api/outputs 只列一层 → 界面上不存在。
   三个坑都不会报错，都只表现为"它给了我一篇文字"。下面每条断言各钉住其中一个。
   ============================================================ */
const PPT = () => WF.workflowFor("litread", {}).reader.modes.find((m) => m.id === "ppt")

test("演示 PPT：第一步的提示词只许出大纲，不许顺手把片子做了", () => {
  const m = PPT()
  const { promptFor } = makeEnv({ mod: "litread", docName: "原件.pdf" })
  const out = promptFor("ppt")
  assert.ok(out.startsWith(m.mark), "第一步那段话没带模式标记，服务端认不出它归哪一格")
  // 这三句是"只做大纲"的全部约束。少任何一句，模型都会顺着往下把 ppt-master 跑起来，
  // 然后停在 Confirm UI 那道闸上 —— 症状与改造前一模一样。
  assert.ok(out.includes("不要建工程"), "第一步没写明不许建工程")
  assert.ok(out.includes("不要调 `ppt-master`"), "第一步没写明这一轮不许调 ppt-master")
  assert.match(out, /不要生成任何 \.svg \/ \.pptx/, "第一步没写明不许出片")
  // 第一步必须要来"出片方向的推荐值"：第二步就是拿它当用户的确认值去满足 Strategist 那道闸的，
  // 只列选项不给结论的话，第二步无从"按已确认值继续"，又会停下来问。
  assert.ok(out.includes("出片方向"), "第一步没要求给出片方向")
  assert.match(out, /明确的推荐值/, "出片方向必须给推荐值，否则第二步没有可确认的东西")
})

test("演示 PPT：第二步那段话带同一个 mark（不是追问标记），且把三个死结都解开", () => {
  const m = PPT()
  const { promptFor } = makeEnv({ mod: "litread", docName: "原件.pdf" })
  const out = promptFor("ppt", true)
  assert.ok(out.startsWith(m.mark), "第二步没带模式标记 → 会被当成自由对话，产物落回聊天格")
  assert.ok(!out.startsWith(m.askMark), "第二步不能用追问标记：追问的规矩是「不要产出文件」，那等于禁止出片")
  assert.ok(out.includes("ppt-master"), "第二步没说用哪个技能")
  // ① Strategist 那道 BLOCKING 闸：用户的确认值一次交齐，别再停下来
  assert.match(out, /不要再停下等我回话/, "第二步没交代「别再停下」，它会卡在确认闸上等一个打不开的页面")
  assert.ok(out.includes("Confirm UI"), "第二步没交代不要开 Confirm UI（远程容器里那个页面用户打不开）")
  // ② 成品要复制到会话根目录，否则 exports/ 在两层深处，界面列不出来
  assert.match(out, /复制一份到会话根目录/, "第二步没要求把 .pptx 复制到会话根目录 → 界面上看不见也下载不到")
  // ③ import-sources --move 会把根目录那两份素材移走，导读/翻译/大纲三格会一起白屏
  assert.match(out, /必须各复制一份再交给技能/, "第二步没防住 --move 把 fulltext.md / ppt_outline.md 移进 sources/")
})

test("演示 PPT：阶段判定的两个契约（谁算成品、成品名进不进产物栏）", () => {
  const m = PPT()
  assert.ok(m.stage2, "ppt 模式没有 stage2 配置，界面就画不出阶段卡")
  for (const k of ["done", "btn", "note", "running", "doneNote", "prompt"])
    assert.ok(m.stage2[k], `stage2 缺 ${k}`)
  const done = new RegExp(m.stage2.done, "i")
  assert.ok(done.test("汇报_某研究.pptx"), "会话根目录的 pptx 没被判成成品 → 阶段卡永远停在第 1 步")
  assert.ok(!done.test("ppt_outline.md"), "大纲被误判成成品 → 第一步一跑完就显示「已出片」")
  // 成品还得被产物契约收着，否则面板下方那一栏列不出它（阶段卡里有按钮，但下载入口不该只有一处）
  assert.ok(new RegExp(m.out, "i").test("汇报_某研究.pptx"), "根目录的 pptx 不在 out 契约里")
})

test("演示 PPT：「分两步」这件事必须进模块前言，不能只写在界面上", () => {
  // 界面画了阶段卡、而模型手上的前言还写着"走 ppt-master 做 PPT" → 它第一轮就会去出片，
  // 用户点「按这份大纲出片」时片子早已在做（或已停在确认闸上）。两边必须说同一件事。
  const flow = WF.pipelineLine("litread", {})
  assert.match(flow, /分两步走，这一轮只做第一步/, "模块前言里没说清 PPT 分两步")
  assert.ok(flow.includes("按这份大纲出片"), "前言里没提那颗按钮，模型不知道第二步的指令会自己来")
})

/* ---- 阶段卡本身的三态（直接跑 reader.html 里那两个函数，不复刻）----
   判据全落在【产物】上：没大纲→不画卡；有大纲无 pptx→"第 1 步"+出片按钮；有 pptx→"已完成"+预览。
   最要紧的是最后一条：成品都出来了还挂着一颗「按这份大纲出片」，用户会再点一次，
   白烧十分钟额度再出一份一模一样的片子。 */
function makeStageEnv({ mode = "ppt", doc = null, raw = "", files = [], RUN = null, dropped = null, pulling = false } = {}) {
  const cfg = WF.workflowFor("litread", {}).reader
  const MODES = {}
  for (const m of cfg.modes) MODES[m.id] = { ...m, stage2: m.stage2 ? { ...m.stage2, done: new RegExp(m.stage2.done, "i") } : undefined }
  const S = { [mode]: { doc, raw, status: doc == null ? "idle" : "done", files: [], qa: [], dropped, pulling } }
  const outputs = files.map((n) => ({ name: n }))
  const src = ["stageFinals", "stageCardHtml", "dropNoteHtml"].map(grabFn).join("\n")
    + "\nreturn { stageFinals, stageCardHtml, dropNoteHtml }"
  const make = new Function("MODES", "S", "RUN", "outputs", "renderMd", "esc", "ICON", "canPv", "sidQ", "busy", src)
  return make(MODES, S, RUN, outputs, (t) => String(t), (t) => String(t),
    { eye: "<eye/>", download: "<dl/>", play: "<play/>" }, () => true, () => "", () => false)
}

test("演示 PPT 的阶段卡：三种状态各画什么", () => {
  // ① 还没跑过 → 不画卡（空态里那颗「演示 PPT」就是入口，两个按钮反而让人不知道点哪个）
  assert.equal(makeStageEnv().stageCardHtml("ppt"), "")

  // ② 有大纲、没成品 → 说清"这只是第 1 步"，并给出片按钮
  const step1 = makeStageEnv({ doc: "# 大纲", files: ["ppt_outline.md"] }).stageCardHtml("ppt")
  assert.match(step1, /第 1 步 \/ 2/)
  assert.ok(step1.includes('data-stage2="ppt"'), "第 1 步的卡上没有出片按钮 —— 这一格又回到了「没有下一步」")
  assert.ok(step1.includes("按这份大纲出片"))

  // ③ 成品出来了 → 翻成"已完成"，给预览/下载，且【不再】有出片按钮
  const step2 = makeStageEnv({ doc: "# 大纲", files: ["汇报_某研究.pptx", "ppt_outline.md"] }).stageCardHtml("ppt")
  assert.match(step2, /第 2 步 \/ 2 · 已完成/)
  assert.ok(step2.includes('data-pv="汇报_某研究.pptx"'), "已出片却没有预览入口")
  assert.ok(step2.includes("api/download?name="), "已出片却没有下载入口")
  assert.ok(!step2.includes("data-stage2"), "成品都出来了还挂着出片按钮，用户会再点一次白烧十分钟")

  // ④ 正在出片（含刷新页面后 attach 起来的那一轮：RUN 上没有 stage2 旗子，靠"大纲已在手"判定）
  const running = makeStageEnv({ doc: "# 大纲", files: ["ppt_outline.md"], RUN: { mode: "ppt", ask: false } }).stageCardHtml("ppt")
  assert.match(running, /出片中/)
  assert.ok(!running.includes("data-stage2"), "正在出片时还给按钮 → 连点会排队再跑一轮")

  // ⑤ 别的模式不该被这套东西影响（它们没有 stage2，一张卡都不该画）
  for (const id of ["guide", "translate"])
    assert.equal(makeStageEnv({ mode: id, doc: "正文" }).stageCardHtml(id), "", `${id} 不该出现阶段卡`)
})

/* ---- 断线之后：给「继续」，不给「重跑」----
   这条路径此前的提示是"点「重新生成」可以再来一次"，而后台那一轮【已经跑完了】——
   照着做等于把已经做好的东西再花十分钟做一遍。最危险的是阶段卡：断线时产物目录还没重读，
   stageFinals 看到的是旧的，卡片会显示成"第 1 步、请出片"，那颗按钮一点就是白跑一遍。 */
test("断线后的阶段卡：不许下「到第几步」的结论，也不许给出片按钮", () => {
  const env = makeStageEnv({ doc: "# 大纲", files: ["ppt_outline.md"], dropped: { ask: false } })
  const card = env.stageCardHtml("ppt")
  assert.ok(!card.includes("data-stage2"), "断线时还挂着出片按钮 —— 片子可能早出好了，点下去白跑十分钟")
  assert.ok(card.includes('data-resume="ppt"'), "断线时没给「继续」入口")
  assert.doesNotMatch(card, /第 1 步 \/ 2/, "产物没重读就宣布「停在第 1 步」，而那可能是旧状态")

  // 取回中：卡片让位给"正在取回"，别再摆任何可点的下一步
  const pulling = makeStageEnv({ doc: "# 大纲", files: ["ppt_outline.md"], pulling: true })
  assert.equal(pulling.dropNoteHtml("ppt").includes("正在把那一轮的结果取回来"), true)
})

test("断线提示条：主结果给就地「继续」；追问那一路不重复画", () => {
  const main = makeStageEnv({ doc: "# 大纲", dropped: { ask: false } }).dropNoteHtml("ppt")
  assert.ok(main.includes('data-resume="ppt"'), "报错条里没有就地可点的「继续」")
  assert.match(main, /不用重跑/, "没说清「不用重跑」，用户还是会去点重新生成")
  assert.doesNotMatch(main, /重新生成/, "断线提示里不该再指向「重新生成」")

  // 追问断线的通知已经落在追问串里了，这里再画一条 = 同一句话说两遍，看着像断了两次
  const ask = makeStageEnv({ doc: "# 大纲", dropped: { ask: true } }).dropNoteHtml("ppt")
  assert.equal(ask, "")
})
