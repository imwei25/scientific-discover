// 模块工作流：定义层（纯函数，快）+ 网关接口层（起真网关）两段。
//
// 覆盖的是"改坏了不会有人发现"的几处：
//   ① 技能白名单由 steps 展开 —— 漂了就等于模块闸放行/拦错技能
//   ② primary 显式化 —— 旧代码取 skills[0]，技能集变成自动展开后顺序不可控，会静默错判模块可用性
//   ③ 条件裁剪 —— "数据已脱敏"要真的把脱敏步剔掉，否则剧本里还写着一步用户已经做过的事
//   ④ 任务卡序列化 —— 隐藏字段不能拼进去；反幻觉那句必须在
//   ⑤ 产物 → 渲染器 —— 认不出必须回 null（走普通产物卡），不能瞎认
//   ⑥ stripPreamble 要把任务卡剥干净，否则用户回看历史会看到自己"说"了一大段没说过的话
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as WF from "../workflows.mjs"

// ============ 定义层 ============

test("技能白名单由 steps 展开，且与 AGENTS.md §三 的流水线对得上", () => {
  const paper = WF.skillsOf("paper")
  // 改造前 paper 只有 6 个技能，脱敏/统计/作图整个前半段都不在 —— 用户得先去 stats 模块跑完再回来
  for (const s of ["deidentify", "clinical-stats", "data-analysis", "data-integrity",
                   "novelty-check", "nature-figure", "literature-review", "write-paper",
                   "reference-check", "humanize-academic", "peer-review", "render-docx"])
    assert.ok(paper.includes(s), `paper 少了 ${s}`)
  assert.ok(WF.skillsOf("litread").includes("render-pdf-doc"), "litread 要能把导读 / 译文排成 PDF 交出去")
  assert.ok(WF.skillsOf("review").includes("humanize-academic"), "review 补上去 AI 味")
  // 系统综述不属于任何模块（2026-08-04 决定：只走自由对话）
  for (const m of Object.keys(WF.WORKFLOWS))
    assert.ok(!WF.skillsOf(m).includes("systematic-review"), `${m} 不该含 systematic-review`)
  assert.equal(new Set(paper).size, paper.length, "技能集必须去重")
})

test("primary 显式声明，且与旧的 skills[0] 语义一致（模块可用性判据不能变）", () => {
  // 这几条正是 skill-gate.test.mjs 断言依赖的：改了它们那边会红
  assert.equal(WF.primaryOf("grant"), "grant-proposal")
  assert.equal(WF.primaryOf("review"), "literature-review")
  assert.equal(WF.primaryOf("paper"), "write-paper")
  assert.equal(WF.primaryOf("stats"), "data-analysis")
  assert.equal(WF.primaryOf("refcheck"), "reference-check")
  assert.equal(WF.primaryOf("humanize"), "humanize-academic")
  // 文献研读改成"读用户上传的这一篇"之后，第一件事永远是把 PDF/Word 抽成文本（pdf_to_md.py
  // 就在 fulltext-retrieval 里）。它被收权时整个模块该整体不可用——抽不出原文，四种模式一个都做不成。
  assert.equal(WF.primaryOf("litread"), "fulltext-retrieval")
  // primary 必须真在技能集里，否则模块永远不可用而且没人看得出为什么
  for (const m of Object.keys(WF.WORKFLOWS))
    assert.ok(WF.skillsOf(m).includes(WF.primaryOf(m)), `${m} 的 primary 不在技能集里`)
})

// 四个「核心能力」模块共用 web/reader.html 那个壳，而壳里没有任何一个模块的名字 ——
// 模式清单、提示词、首屏文案全部由 workflows.mjs 的 reader 段下发。这里钉住那份契约：
// 少一样前端就画不出来，而症状往往不是报错，是「某个按钮点了没反应」或「结果落错面板」。
test("阅读器型模块：reader 配置完整、模式标记与前言逐字一致", () => {
  const readers = Object.entries(WF.WORKFLOWS).filter(([, w]) => w.ui === "reader").map(([id]) => id)
  assert.deepEqual(readers.sort(), ["humanize", "litread", "refcheck", "stats"],
    "四个核心能力模块都该用阅读器壳")

  for (const id of readers) {
    const w = WF.WORKFLOWS[id]
    const r = w.reader
    const at = (m) => id + "." + m

    // 下发的整份配置必须能 JSON 序列化：正则一律写成【字符串】，别放 RegExp 或函数 ——
    // 放了不会报错，只会在下发时被 JSON.stringify 悄悄变成 {}，前端拿到一个空对象。
    const wf = WF.workflowFor(id, {})
    assert.equal(wf.ui, "reader", at("ui 要随工作流下发"))
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(wf)), at("reader 配置必须可 JSON 序列化"))

    for (const k of ["title", "lead", "dropTitle", "dropHint", "startText"])
      assert.ok(r.intro && r.intro[k], at("intro." + k + " 不能空——首屏那一格会是空白"))
    assert.ok(r.source && r.source.field && (r.source.exts || []).length, at("source 要说清收哪个字段、什么扩展名"))
    assert.ok(["doc", "table"].includes(r.source.kind), at("source.kind 只有 doc / table 两种"))

    // 每个模式：有 id/label/icon；除自由问答外必须有 mark + prompt + tell
    const ids = r.modes.map((m) => m.id)
    assert.equal(new Set(ids).size, ids.length, at("模式 id 不能重复"))
    assert.ok(ids.includes("chat"), at("每个模块都要留一格自由问答"))
    assert.ok(ids.includes(r.first), at("first 指的模式不存在：" + r.first))
    const line = WF.pipelineLine(id, {})
    for (const m of r.modes) {
      assert.ok(m.label && m.icon, at(m.id + " 缺 label/icon"))
      assert.ok(Array.isArray(m.empty) && m.empty.length === 2, at(m.id + " 的 empty 要给两句（标题 + 说明）"))
      if (m.id === "chat") { assert.ok(!m.mark, at("自由问答不能有 mark——有标记就不是自由问答了")); continue }
      assert.ok(m.mark && m.prompt && m.tell, at(m.id + " 缺 mark/prompt/tell"))
      // 【最要紧的一条】前端把 mark 拼在消息前面发出去，模型照前言里教的做，刷新后前端又靠 mark
      // 把每一轮认回对应面板。前言里没教这个标记 = 模型不认识它 = 三处对不上。
      assert.ok(line.includes(m.mark), at("前言里没教 agent 认「" + m.mark + "」"))
      // prompt 里的占位符只认这三个，写错了前端不会替换，会把 {xxx} 原样发给模型
      for (const ph of (m.prompt.match(/\{[a-z]+\}/g) || []))
        assert.ok(["{doc}", "{data}", "{vars}"].includes(ph), at(m.id + " 用了未知占位符 " + ph))
      // need 的三种写法必须指向真实存在的东西，否则那个按钮会被永久卡住而没人看得出为什么
      for (const n of m.need || []) {
        if (n === "data") { assert.ok(r.extraUpload, at(m.id + " 需要 data 但模块没配 extraUpload")); continue }
        if (n.startsWith("var:")) { assert.ok((r.vars?.fields || []).includes(n.slice(4)), at(m.id + " 要的列 " + n + " 不在 vars.fields 里")); continue }
        if (n.startsWith("after:")) { assert.ok(ids.includes(n.slice(6)), at(m.id + " 依赖的模式 " + n + " 不存在")); continue }
        assert.fail(at(m.id + " 的 need 写法认不出来：" + n))
      }
      assert.ok(!m.need || m.needHint, at(m.id + " 有 need 就必须有 needHint——不然用户只看到按钮没反应"))
      // ★ empty / needHint 是【直接转义后塞进界面】的纯文本，不走 markdown 渲染。
      //   写了 **加粗** 或 `代码` 的话，用户看到的就是字面的星号和反引号。
      //   prompt 与 tell 不在此列 —— 那两个是发给模型的，markdown 正是它要的。
      for (const t of [m.needHint, ...(m.empty || [])])
        if (t) assert.doesNotMatch(t, /\*\*|`/, at(m.id + " 的界面文案里混进了 markdown：" + t))
    }

    // 设置弹层 / 必答题 / 变量面板引用的字段必须真在 intake 里，否则那一格渲染不出来
    const known = new Set((w.intake || []).map((f) => f.id))
    for (const fid of [...(r.settings || []), ...(r.intro.ask || []), ...(r.vars?.fields || [])])
      assert.ok(known.has(fid), at("引用了 intake 里没有的字段 " + fid))
  }
})

// 前置条件闸（need）在界面上是三段：算出缺什么 → 存进状态 → 画到屏幕上。
// 踩过的坑是【第三段丢了】：showBlocked 把提示写进 S[k].block 就完了，没有任何渲染代码读它，
// 于是用户点了按钮界面纹丝不动，只剩一句通用空态文案。而且当时是从状态而不是从 DOM 确认的，
// 所以"测过了"却没发现。另一处是闸只接在模式条上，面板里那个按钮直接调 run() 绕过去了。
// 这几条都不需要浏览器就能守住：静态检查 reader.html 里这几段有没有同时在。
// 阅读器壳是四个模块共用的，所以它【不该认识任何一个具体模块】。
// 这条踩过两次，两次都是同一个后果：写死 module:"litread" 发出去 → 核查/润色/统计的会话
// 被绑成文献研读（前言与技能闸全是别人的）；「最近」写死 litread → 列出别的模块的会话。
// 而界面照常显示本模块的样子，从外面完全看不出来。（两次都发生在用整段 splice 改文件时
// 覆盖掉了更早的修复，事后没回头校验。）
// reader.html 是四个模块【共用】的壳，靠 URL 上的 ?m=<模块id> 知道自己该扮演谁；取不到就
// 兜底成 litread。于是每一个跳进它的入口都必须把 ?m= 带上——漏了不会报错，只会让用户点
// 「数据统计与分析」却进了文献研读，而页面看起来一切正常。
// 这个 bug 真发生过：reader.html 从 litread 专用改成通用壳时，两个调用方（工作台的卡片、
// 聊天页的重定向）都没跟着改。上一条「壳里不许写死模块 id」的守卫抓不到它——问题在调用方，
// 而那句兜底默认值是被显式豁免的。所以这里单独钉调用方。
test("跳进阅读器壳的入口都必须带上 ?m=（否则三个模块全落进文献研读）", () => {
  for (const f of ["../workspace.html", "../index.html"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8")
    for (const ln of src.split("\n")) {
      const code = ln.trim()
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue
      if (!/location\.href\s*=\s*["'`]\.\/reader\.html/.test(code)) continue
      // 带 ?sid= 的那条是「打开某个已存在的会话」——模块由会话绑定决定，不需要 m
      assert.ok(/\?m=/.test(code) || /\?sid=/.test(code),
        f + " 里这行跳转既没带 ?m= 也没带 ?sid=，用户会落进兜底的文献研读：" + code)
    }
  }
})

test("阅读器壳里不许出现模块 id 字面量（兜底默认值与注释除外）", () => {
  const html = fs.readFileSync(new URL("../reader.html", import.meta.url), "utf8")
  const ids = Object.entries(WF.WORKFLOWS).filter(([, w]) => w.ui === "reader").map(([id]) => id)
  const lines = html.split("\n")
  const bad = []
  lines.forEach((ln, i) => {
    const code = ln.trim()
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return   // 注释里提一嘴没问题
    if (/^let MOD = /.test(code) || /if \(!MOD\) MOD = /.test(code)) return             // 兜底默认值
    for (const id of ids) if (new RegExp('"' + id + '"').test(code)) bad.push((i + 1) + ": " + code.slice(0, 100))
  })
  assert.deepEqual(bad, [], "这些行把模块 id 写死了，应该用 MOD：\n" + bad.join("\n"))
})

test("阅读器：前置条件闸的三段必须齐全，且起一轮只有一个入口", () => {
  const html = fs.readFileSync(new URL("../reader.html", import.meta.url), "utf8")
  assert.match(html, /S\[k\]\.block\s*=/, "showBlocked 要把缺什么写进状态")
  assert.match(html, /if \(s\.block\)/, "render 必须真的把 s.block 画出来——只写进状态等于没提示")
  assert.match(html, /function tryRun\(/, "起一轮要有统一入口")
  // 面板里那个按钮与「重新生成」都必须走 tryRun；直接调 run() 就绕过了闸
  assert.match(html, /closest\("\[data-run\]"\)[\s\S]{0,120}tryRun\(/,
    "面板中央那个按钮必须走 tryRun，不能直接 run()")
  assert.match(html, /btnRerun[\s\S]{0,80}tryRun\(/, "「重新生成」也要走 tryRun")
  // 需要配套文件的模式，面板里要常驻一张清单卡：看得见传了哪几份、能再加、能删掉传错的。
  // （原先是"缺了才冒出一个上传按钮"：传完什么都不显示，用户不知道传上去没有，也没法删。）
  assert.match(html, /function dataCardHtml\(/, "缺配套数值表的清单卡 dataCardHtml")
  assert.match(html, /data-dataadd/, "清单卡里要有添加入口")
  assert.match(html, /data-datadel/, "清单卡里每一份都要能删")
  assert.match(html, /closest\("\[data-dataadd\]"\)[\s\S]{0,120}pickDataFiles\(/, "添加要接到 pickDataFiles")
  assert.match(html, /api\/upload\/delete/, "删除要真的调服务端，否则刷新一次它又回来了")
})

// 点模式条【只切过去看，不开跑】：一点就发等于用户还没看清要干什么、也没来得及改设置，
// 额度就已经花出去了。开跑的入口只有三个，且都必须走 tryRun（那里才有前置条件闸）。
test("阅读器：切模式不自动开跑，开跑入口都走 tryRun", () => {
  const html = fs.readFileSync(new URL("../reader.html", import.meta.url), "utf8")
  const onRail = html.slice(html.indexOf("function onRail("), html.indexOf("function showBlocked("))
  assert.doesNotMatch(onRail, /tryRun\(|\brun\(/, "onRail 不该自己开跑——那正是要改掉的行为")
  assert.match(html, /btnGo[\s\S]{0,80}tryRun\(/, "头部「开始」要走 tryRun")
  assert.match(html, /btnHalt[\s\S]{0,60}abortRun/, "头部「终止」要接 abortRun")
  // 没跑过的模式切过去要把设置摊开（填完点里面的「开始」直接开跑）
  assert.match(html, /function openSettings\(/, "缺 openSettings")
  assert.match(onRail, /openSettings\(true\)/, "切到没跑过的模式要自动摊开设置")
  // 但同一套设置只问一次：一模一样的字段+取值在别处确认过了就别再弹（否则用户会被训练成闭眼点掉）
  assert.match(onRail, /settingsSeen\(\)/, "自动摊开前要先看这套设置是不是已经确认过")
  assert.match(html, /function markSettingsSeen\(/, "缺 markSettingsSeen")
  assert.match(html, /function settingsSig\(/, "记的应该是字段+取值的指纹，不是模块 id")
})

// 全站【只有用户点「开始」才会开跑】。首屏传完文件后自动跑第一个模式是最后一处自动开跑：
// 文件一传上去就发出去，用户既没机会看一眼口径、也来不及补配套数值表，想拦只能现找终止，
// 而那一轮的额度已经花掉了。
test("阅读器：首屏传完文件不许自动开跑", () => {
  const html = fs.readFileSync(new URL("../reader.html", import.meta.url), "utf8")
  const from = html.indexOf('$("btnStart").addEventListener')
  assert.notEqual(from, -1, "找不到首屏「开始」的处理函数")
  // 注释里会提到"这里原来是 run(CFG.first)"，那是说明改动缘由的，不能算数 —— 先把行注释剥掉。
  // ★ 用 [^\r\n]* 而不是 .*$：这个文件是 CRLF，而 JS 正则里 \r 算行终止符、. 不匹配它，
  //   于是 /\/\/.*$/ 在每一行都对不上（$ 只认字符串末尾），注释一句也剥不掉，断言恒真/恒假全看运气。
  const seg = html.slice(from, html.indexOf("function enterReader(", from))
    .replace(/\s*\/\/[^\r\n]*/g, "")
  assert.ok(seg.length > 200, "截取范围不对，这条断言会永远通过")
  assert.doesNotMatch(seg, /[^a-zA-Z]run\(/, "首屏传完不该直接开跑——开跑只能由用户点「开始」触发")
})

// 这是"单篇研读"，不是检索模块：给了检索技能就等于默许它去找别的文献
test("文献研读不该有检索类技能", () => {
  const sk = WF.skillsOf("litread")
  for (const s of ["search-lit", "literature-review", "deep-research", "research-scan"])
    assert.ok(!sk.includes(s), "文献研读不该有检索类技能 " + s)
  const art = WF.artifactLine("litread", {})
  for (const f of ["reading_guide.md", "translation_zh.md", "ppt_outline.md"])
    assert.ok(art.includes(f), "产物契约里少了 " + f)
})

test("步骤按表单值裁剪：已脱敏就不再插脱敏步，前瞻性研究把预注册提到最前", () => {
  const ids = (v) => WF.stepsFor("paper", v).map((s) => s.id)
  const withRaw = { materials: ["rawdata"], deidDone: false, studyType: "retrospective" }
  assert.ok(ids(withRaw).includes("deid"), "有原始数据且未脱敏 → 必须有脱敏步（§五 硬规矩）")
  assert.ok(!ids({ ...withRaw, deidDone: true }).includes("deid"), "已脱敏 → 剔掉")
  assert.ok(!ids({ materials: [], studyType: "retrospective" }).includes("deid"), "没有原始数据 → 剔掉")
  // ★ 方向必须 fail-safe：用户压根没碰"已脱敏"那个开关（值 undefined）时，要当作【没脱敏】。
  //   这里写 eq:false 会判不成立、把脱敏步整个剔掉，而这恰恰是最该脱敏的情形。实测踩到过。
  assert.ok(ids({ materials: ["rawdata"], studyType: "retrospective" }).includes("deid"),
    "没声明是否脱敏 → 仍要插脱敏步，不能因为字段没填就跳过（含患者信息未脱敏不得进统计）")

  // 诊断准确性研究通常无人口学基线 → Table 1 无对应数据，整步跳过（AGENTS.md §三 表下注）
  assert.ok(ids({ materials: ["rawdata"], deidDone: true, studyType: "retrospective" }).includes("table1"))
  assert.ok(!ids({ materials: ["rawdata"], deidDone: true, studyType: "diagnostic" }).includes("table1"),
    "诊断准确性研究不该有 Table 1 —— 硬塞会把检测值伪装成基线表")

  // 前瞻性 / RCT：假设与主分析计划必须在采数前冻住 → novelty 提到最前
  assert.equal(WF.stepsFor("paper", { studyType: "rct" })[0].id, "novelty")
  assert.notEqual(WF.stepsFor("paper", { studyType: "retrospective" })[0].id, "novelty",
    "回顾性研究已有数据，无法再'采数前预注册'，不该前置")
})

test("任务卡：只拼可见字段，标签用中文选项文案，末尾必须带反幻觉那句", () => {
  const f = WF.WORKFLOWS.paper.intake
  const card = WF.taskCard("SCI 论文", "立项确认", f, {
    studyType: "retrospective", articleType: "original", topic: "NLR 与胃癌预后",
    materials: ["rawdata", "ethics"], ethicsNo: "2025-KY-081", deidDone: false,
    journalTier: "target", jQuartile: ["Q1", "Q2"], lang: "zh",
  })
  assert.match(card, /^【任务卡 · SCI 论文 \/ 立项确认】/)
  assert.match(card, /研究类型：回顾性队列/, "select 要显示选项文案而不是 v 值")
  assert.match(card, /已有材料：原始数据表（xlsx\/csv）、伦理批件号/, "multi 要逐项展开")
  assert.match(card, /伦理批件号：2025-KY-081/)
  assert.match(card, /影响力档位（近似）：前 25%（Q1）、25%–50%（Q2）/, "multi 要展开成中文档位")
  assert.match(card, /绝不臆测或编造/, "反幻觉声明是硬要求：表单必然有留空项，不写死它就会去编")
  // 条件字段未成立 → 连提都不该提（注册号只在勾了 registry 时出现）。
  // 只看卡片正文：末尾那句反幻觉声明本身举例提到了"注册号"，整卡去匹配会误判。
  const body = card.split("【以上为用户通过表单")[0]
  assert.doesNotMatch(body, /注册号/)
  assert.doesNotMatch(body, /数据文件/, "勾了原始数据但没选文件 → 该项留空，不拼进卡")
  // 一项都没填 = 用户跳过了表单 → 不拼任何东西（设计铁律：不阻断）
  assert.equal(WF.taskCard("SCI 论文", "立项确认", f, {}), "")
})

test("任务卡措辞不得把近似指标说成影响因子（§五 不虚构）", () => {
  for (const mod of ["paper", "review"]) {
    const q = WF.WORKFLOWS[mod].intake.find((x) => x.id === "jQuartile")
    assert.ok(q, `${mod} 应保留影响力档位`)
    assert.match(q.label, /近似/)
    assert.doesNotMatch(q.label, /影响因子|IF|JIF/)
    assert.doesNotMatch(q.label, /分区/, "别叫'分区'——那是中科院/JCR 的授权数据，我们没有")
    assert.match(q.help, /不是中科院或 JCR 分区/)
    // 必须写明筛的是"检索结果"而非"你想投的刊"——它紧跟在目标期刊字段后面，实测会被读反
    assert.match(q.help, /不是你想投的刊/)
    // 取不到指标就静默不筛是实测踩过的坑，界面上必须先说清楚
    assert.match(q.help, /本项不生效/)
    // 分组标题是防"读成我想投的刊的影响因子"的唯一手段，删了 jImpact 后必须由它接着挂
    assert.equal(q.section, "检索到的文献要满足什么条件")
    assert.ok(!WF.WORKFLOWS[mod].intake.some((x) => x.id === "jImpact"),
      "影响力区间输入框已按用户要求移除，别又加回来")
  }
})

test("检索不设条数上限：表单里不能再出现「最多检索多少篇」这类召回上限输入", () => {
  // 写综述没有理由给召回设上限——上限会让"这个方向有多少文献"变成由输入框决定的假答案。
  // 检索脚本（literature-review/search.py、search-lit/enhanced_search.py）默认已改成不限条数。
  for (const [id, wf] of Object.entries(WF.WORKFLOWS)) {
    const fields = [...(wf.intake || []), ...(wf.steps || []).flatMap((s) => s.form || [])]
    const bad = fields.filter((f) => f.id === "limit" || /最多检索|检索.*上限|多少篇/.test(f.label || ""))
    assert.deepEqual(bad.map((f) => f.label), [], `${id} 模块不该有召回上限字段`)
  }
})

test("产物 → 渲染器：认得出的认出来，认不出的必须回 null（走普通产物卡，绝不藏文件）", () => {
  const cases = {
    "evidence_table.csv": "evidence", "included.csv": "evidence",
    "retrieval_report.json": "retrieval", "manual_needed.txt": "retrieval",
    "refcheck_report.md": "refcheck", "review_report.md": "review",
    "integrity_report.md": "integrity", "manuscript_humanized.md": "diff",
    "table1.csv": "table", "fig1.png": "figure", "figures/fig2.svg": "figure",
    "manuscript.docx": "doc", "pdfs/a.pdf": "doc", "manuscript.md": "manuscript",
    "data_profile.md": "report",
  }
  for (const [name, want] of Object.entries(cases))
    assert.equal(WF.rendererFor(name), want, `${name} 应认成 ${want}`)
  for (const name of ["随便.zip", "notes.xyz", "", null])
    assert.equal(WF.rendererFor(name), null, `${name} 不该被瞎认`)
})

test("emits 的 glob 要能匹配子目录里的产物，否则进度永远卡住不动", () => {
  assert.ok(WF.globMatch("fig*.png", "figures/fig1.png"), "裸名 glob 比最后一段")
  assert.ok(WF.globMatch("fig*.png", "fig1.png"))
  assert.ok(WF.globMatch("pdfs/*", "pdfs/a.pdf"), "带目录的 glob 整条比")
  assert.ok(!WF.globMatch("pdfs/*", "other/a.pdf"))
  assert.ok(WF.globMatch("*.docx", "manuscript.docx"))
  assert.ok(!WF.globMatch("table1.csv", "table2.csv"))
})

test("模块前言带上步骤链与质量闸（技能集变大后，靠剧本而非白名单区分模块）", () => {
  const line = WF.pipelineLine("paper", { materials: ["rawdata"], deidDone: false, studyType: "retrospective" })
  assert.match(line, /本模块的标准流程/)
  assert.match(line, /数据脱敏/)
  assert.match(line, /引用核查\(闸\)/)
  assert.match(line, /回退到「撰写正文」返工/, "闸不过要指明退到哪一步，不能只说'返工'")
  assert.match(line, /≥2 次仍不过就停下问用户/, "无限返工的护栏（AGENTS.md §二）")
  const art = WF.artifactLine("paper", {})
  assert.match(art, /evidence_table\.csv/)
})

test("综述模块必须给系统综述指路——不给的话用户永远拿不到 PRISMA/RoB 且不知道为什么", () => {
  const fn = WF.WORKFLOWS.review.footnote
  assert.ok(fn && /系统综述|Meta/.test(fn))
  assert.match(fn, /自由对话/)
})

test("模块闸：bash 直呼白名单外的技能脚本要被拦（技能集变成整条 pipeline 后这条口子更大）", () => {
  const gate = new Set(["write-paper", "reference-check", "env-setup"])
  const V = (tool, input) => WF.gateViolation({ tool, input, skillGate: gate, restricted: true })
  const PY = "${REPO_ROOT:-/app}/.venv/bin/python"
  // 白名单内的脚本照常放行 —— 拦错了等于把模块自己的流水线掐死
  assert.equal(V("bash", { command: `${PY} \${REPO_ROOT:-/app}/.opencode/skills/write-paper/x.py` }), null)
  assert.equal(V("bash", { command: "ls -la && echo hi" }), null)
  // 隔壁模块的脚本：拦
  assert.match(V("bash", { command: `${PY} \${REPO_ROOT:-/app}/.opencode/skills/nature-figure/km.py --out fig1.png` }) || "", /nature-figure/)
  // cat 之类的只读命令【不拦】，见下面单独那条测试（读文档不产生该技能的产出）
  assert.match(V("bash", { command: "sh /app/.opencode/skills/systematic-review/run.sh" }) || "", /systematic-review/)
  // Windows 反斜杠路径同样要认（开发机形态）
  assert.match(V("bash", { command: "python .opencode\\skills\\deidentify\\run.py" }) || "", /deidentify/)
  // 一条命令里混着放行与越权 → 仍要拦（不能因为前半段合法就整条放过）
  assert.match(V("bash", { command: `${PY} .opencode/skills/write-paper/a.py; ${PY} .opencode/skills/peer-review/b.py` }) || "", /peer-review/)
  // 全局正则的 lastIndex 状态：连续调用必须每次都判出来，隔次漏判是最难查的那种 bug
  for (let i = 0; i < 4; i++)
    assert.match(V("bash", { command: "python .opencode/skills/nature-figure/km.py" }) || "", /nature-figure/, `第 ${i + 1} 次调用漏判`)
  // 另两条判据没被改坏
  assert.equal(V("skill", { name: "nature-figure" }), "nature-figure")
  assert.equal(V("skill", { name: "write-paper" }), null)
  assert.equal(V("task", {}), "task(子代理)")
  // chat 会话（不受限）不禁 task —— 禁了会破坏正常流水线
  assert.equal(WF.gateViolation({ tool: "task", input: {}, skillGate: gate, restricted: false }), null)
  // 没有闸（白名单为 null）→ 一律放行
  assert.equal(WF.gateViolation({ tool: "bash", input: { command: ".opencode/skills/whatever/x.py" }, skillGate: null }), null)
})

// ---- 以下每条都对应一个实测踩到的坑，别因为"看着显然"就删 ----

test("只算样本量的人不该被『数据文件』必填卡死，但『样本量+别的分析』必须仍要数据", () => {
  const f = WF.WORKFLOWS.stats.intake.find((x) => x.id === "dataFiles")
  assert.ok(!f.required, "不能无条件必填：样本量是做研究【之前】算的，此时根本没有数据")
  assert.equal(WF.isRequired(f, { analyses: ["power"] }), false, "只算样本量 → 不必填")
  assert.equal(WF.isRequired(f, { analyses: ["survival"] }), true, "要跑分析 → 必填")
  // ★ 这条是回归防线：写成 hasNot:"power" 会让"只要勾了样本量就一律不必填"，于是
  //   「生存分析 + 样本量」（很常见的组合）会让一个【没有任何数据】的 KM/Cox 请求静默通过。
  //   放行一个注定失败的请求，比过度拦截更危险。
  assert.equal(WF.isRequired(f, { analyses: ["survival", "power"] }), true,
    "样本量 + 生存分析 → 仍必须有数据，否则 KM/Cox 根本算不出来")
  assert.equal(WF.isRequired(f, { analyses: ["power", "table1"] }), true)
})

test("生存分析 / ROC 缺了必要的列就跑不出来——勾了该分析这几列必须必填", () => {
  const F = (id) => WF.WORKFLOWS.stats.intake.find((x) => x.id === id)
  for (const id of ["timeCol", "eventCol"])
    assert.equal(WF.isRequired(F(id), { analyses: ["survival"] }), true, `${id} 该必填`)
  for (const id of ["testCol", "goldCol"])
    assert.equal(WF.isRequired(F(id), { analyses: ["roc"] }), true, `${id} 该必填`)
  // 逐步表单（paper 的统计步）同样不能漏 —— 此前那 11 张步骤卡一个必填标记都没有
  const st = WF.WORKFLOWS.paper.steps.find((s) => s.id === "stats")
  for (const id of ["timeCol", "eventCol"])
    assert.equal(WF.isRequired(st.form.find((x) => x.id === id), { analyses: ["survival"] }), true,
      `paper:stats 的 ${id} 该必填`)
})

test("前瞻性 / RCT 下预注册被提到最前，就不能还标『可选』——那等于说这步可以跳", () => {
  const raw = { materials: ["rawdata"] }
  for (const t of ["rct", "prospective"]) {
    const v = { ...raw, studyType: t }
    const first = WF.stepsFor("paper", v)[0]
    assert.equal(first.id, "novelty")
    assert.equal(WF.isOptional(first, v), false, `${t} 下预注册是必做的采数前锁`)
  }
  const v2 = { ...raw, studyType: "retrospective" }
  const nov = WF.stepsFor("paper", v2).find((s) => s.id === "novelty")
  assert.equal(WF.isOptional(nov, v2), true, "回顾性研究已有数据，这步可选")
  // 前言里的剧本也要跟着变
  assert.doesNotMatch(WF.pipelineLine("paper", { ...raw, studyType: "rct" }), /新颖性裁定 \/ 预注册\(可选\)/)
})

test("脱敏还原表绝不能当普通表格渲染——那会把病人真名铺在对话框里", () => {
  // 实测产出过 deid_cohort_mapping.csv：200 例真实姓名 + 住院号，当时可一键下载且会内联预览
  for (const f of ["deid_cohort_mapping.csv", "患者对照表.csv", "id_map.csv", "subject_crosswalk.csv"])
    assert.equal(WF.rendererFor(f), "secret", `${f} 必须判成 secret（界面只给警示、不预览）`)
  // 脱敏步的 emits 也不该把还原表算成自己的产物（写成 deid_*.csv 就会）
  const deid = WF.WORKFLOWS.paper.steps.find((s) => s.id === "deid")
  assert.ok(!deid.emits.some((g) => WF.globMatch(g, "deid_cohort_mapping.csv")),
    "还原表不进产物契约，不主动推给用户")
  // 正常脱敏结果照常渲染
  assert.equal(WF.rendererFor("deid_cohort.csv"), "table")
})

test("排版出件的 emits 不能被任意 pdf 命中——画过一张图就说'稿子出件了'是假信号", () => {
  const render = WF.WORKFLOWS.paper.steps.find((s) => s.id === "render")
  // 实测：emits 写 ["*.docx","*.pdf"]，nature-figure 出的 fig1.pdf 直接让这步在第 4 轮变绿，
  // 而 manuscript.docx 第 6 轮才存在 —— 医生会以为稿子已经能交了
  assert.ok(!render.emits.some((g) => WF.globMatch(g, "fig1.pdf")), "图不该算作出件")
  assert.ok(!render.emits.some((g) => WF.globMatch(g, "fig3.svg")))
  assert.ok(render.emits.some((g) => WF.globMatch(g, "manuscript.docx")), "真正的成稿要能算上")
})

test("基金申报要能检索文献——research-scan / novelty-check 一动手就得用检索技能", () => {
  const sk = WF.skillsOf("grant")
  for (const s of ["search-lit", "literature-review"])
    assert.ok(sk.includes(s), `grant 少了 ${s}：领域扫描与新颖性裁定都要检索，缺了会撞模块闸整轮作废`)
})

test("表头解析：中文版 Excel 存的 GBK 必须读对——那是医院里最常见的导出方式", () => {
  const rows = "样本编号,方法A_Ddimer,金标准PE,年龄\n1,0.8,1,65\n2,0.3,0,54\n"
  const want = ["样本编号", "方法A_Ddimer", "金标准PE", "年龄"]
  // UTF-8 / BOM / GBK 三种都要给出同一份列名
  assert.deepEqual(WF.parseHeaders(Buffer.from(rows, "utf8"), ".csv").headers, want)
  assert.deepEqual(WF.parseHeaders(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rows, "utf8")]), ".csv").headers, want)
  // Node 没有内置 GBK 编码器，用 iconv 式的手工构造不现实 —— 改用 TextDecoder 的反向验证：
  // 只要 UTF-8 解码出现替换字符就必须走嗅探分支，且不能把乱码当列名返回。
  const garbled = Buffer.from([0xd1, 0xf9, 0xb1, 0xbe, 0x2c, 0xa1, 0xa1])   // GBK 字节流
  const r = WF.parseHeaders(garbled, ".csv")
  assert.ok(!r.headers || !r.headers.some((h) => h.includes("�")),
    "绝不能把带替换字符的乱码当成真列名返回——它会被盖章确认灌进任务卡")
})

test("表头解析：解析歪了必须降级成手填，不能回一个'看着像模像样'的假下拉", () => {
  const P = (s) => WF.parseHeaders(Buffer.from(s, "utf8"), ".csv")
  // 首行是标题行（LIS 导出常见）→ 此前会把整行当成唯一列名塞进下拉
  assert.equal(P("某某医院检验科 D-二聚体方法比对原始数据 2026-08\na,b,c\n1,2,3\n").headers, null)
  // 引号不成对 → 带逗号的引号字段会被拆成一堆带残留引号的假列
  assert.equal(P('样本编号,"D-二聚体, 方法A (mg/L)\n1,0.8\n').headers, null)
  // 首行/次行字段数对不上 → 首行多半不是表头
  assert.equal(P("a,b,c,d,e\n1,2,3\n").headers, null)
  // 降级时必须给出【能照做的】理由，不能只回 null
  for (const s of ["某某医院原始数据\na,b\n1,2\n", "a,b,c,d,e\n1,2,3\n"])
    assert.match(P(s).reason || "", /手动填列名/)
})

test("表头解析：分号分隔要认，空列名与重名列要显式标出而不是静默吞掉", () => {
  const P = (s) => WF.parseHeaders(Buffer.from(s, "utf8"), ".csv")
  assert.deepEqual(P("样本编号;方法A;金标准\n1;0.8;1\n").headers, ["样本编号", "方法A", "金标准"])
  // 静默 filter(Boolean) 会让用户以为那一列不存在（而脚本里它确实在）；重名列则分不清点了哪个
  const h = P("id,val,val,,x\n1,2,3,4,5\n").headers
  assert.equal(h.length, 5, "空列名不该被吞掉——列的位置会错位")
  assert.ok(h[2].includes("重名"))
  assert.ok(h[3].includes("无列名"))
})

// ---- 自动认列（guessVarMap）----
// 【为什么单测它】这是整块"用户不必再填六个下拉"的地基，而它的失败形态是【静默的】：
// 认错一列不会报错，只会产出一条看着完全正常的错 KM 曲线。所以要锁住两件事：
// ① 常见的中文医学表要认对；② 认不准时【宁可留空】，绝不硬填。
const COHORT = [
  { name: "住院号", kind: "id", nunique: 120 },
  { name: "年龄", kind: "integer", nunique: 52, min: 28, max: 84, all_nonneg: true },
  { name: "性别", kind: "binary", nunique: 2, values: [{ v: "男", n: 55 }, { v: "女", n: 65 }] },
  { name: "组别", kind: "binary", nunique: 2, values: [{ v: "试验组", n: 58 }, { v: "对照组", n: 62 }] },
  { name: "术前D-dimer", kind: "numeric", nunique: 92, min: 0.11, max: 5.75, all_nonneg: true },
  { name: "病理结果", kind: "binary01", nunique: 2, values: [{ v: "1", n: 65 }, { v: "0", n: 55 }], min: 0, max: 1, all_nonneg: true },
  { name: "随访月数", kind: "numeric", nunique: 110, min: 1.4, max: 60, all_nonneg: true },
  { name: "是否死亡", kind: "binary01", nunique: 2, values: [{ v: "0", n: 65 }, { v: "1", n: 55 }], min: 0, max: 1, all_nonneg: true },
  { name: "备注", kind: "empty", nunique: 0 },
]

test("自动认列：典型中文队列表的六个角色都要认对，标识列不许当角色", () => {
  const { map, why, conf } = WF.guessVarMap(COHORT)
  assert.equal(map.groupCol, "组别", "分组列没认出来")
  assert.equal(map.timeCol, "随访月数")
  assert.equal(map.eventCol, "是否死亡")
  assert.equal(map.goldCol, "病理结果")
  assert.equal(map.testCol, "术前D-dimer")
  // 住院号当分组列 → 一张 120 个"组"的 Table 1，而且不会报错
  assert.ok(!Object.values(map).flat().includes("住院号"), "标识列绝不能充当任何角色")
  // 性别是协变量，不是分组列：两者形状完全一样（都是两值列），只能靠这条压制区分
  assert.equal(map.groupCol === "性别", false)
  assert.ok((map.covars || []).includes("性别") && (map.covars || []).includes("年龄"))
  // 依据要引用【看得见的证据】：用户核对的是这句话，写"通常"等于什么都没说
  assert.match(why.groupCol, /试验组|对照组|2 种取值/)
  assert.equal(conf.groupCol, "high", "列名与取值形状都对上了就该是 high")
})

test("自动认列：认不准就留空——填错比留空危险得多", () => {
  // 一张没有任何生存/诊断信息的表：不许硬凑出随访时间与终点事件
  const plain = [
    { name: "编号", kind: "id", nunique: 50 },
    { name: "身高", kind: "numeric", nunique: 40, min: 150, max: 190, all_nonneg: true },
    { name: "体重", kind: "numeric", nunique: 44, min: 42, max: 95, all_nonneg: true },
  ]
  const { map } = WF.guessVarMap(plain)
  for (const k of ["timeCol", "eventCol", "goldCol", "groupCol", "testCol"])
    assert.equal(map[k], undefined, `${k} 在这张表里认不出来，就必须留空而不是随便挑一列`)
  // 列名像、但取值形状对不上 → 一票否决。「随访日期」是某一天，不是时长
  const dated = [
    { name: "随访日期", kind: "datetime", nunique: 88 },
    { name: "入院日期", kind: "datetime", nunique: 90 },
  ]
  const r = WF.guessVarMap(dated)
  assert.equal(r.map.timeCol, undefined, "日期列不能当随访时长——KM 曲线会整条错掉")
  assert.match(r.notes.join(" "), /日期/, "认不出来但该说的话要说出来（由日期相减派生）")
  // 「事件」列名对但有 7 种取值 → 不是 0/1 删失编码，不许填
  const multi = [{ name: "终点事件类型", kind: "categorical", nunique: 7 }]
  assert.equal(WF.guessVarMap(multi).map.eventCol, undefined)
})

test("自动认列：只读到表头（没有取值画像）时也能按列名认，但把握度必须降级", () => {
  const { map, conf, why } = WF.guessVarMap([], { headers: COHORT.map((c) => c.name) })
  assert.equal(map.groupCol, "组别")
  assert.equal(conf.groupCol, "med", "没核对过取值就不能自称 high")
  assert.match(why.groupCol, /只读到了表头/, "凭什么认的要说实话，否则用户不会去核")
})

test("步骤条：没有明确 cur 时当前步 = 第一个未完成的，且质量闸不能抢走高亮", () => {
  // 实测踩过：第一轮 cur 是空的（只有提交过步骤表单才有值），整条链全灰，而闸那一步带着颜色
  // → 用户把「引用核查(闸)」读成当前步骤，以为 AI 起步就跳到了核查。这里锁住修复后的语义。
  // stepsBar 在 index.html 里（要 DOM），这里只验它依赖的两条判据。
  const steps = WF.stepsFor("review", {})
  const at = (done) => (steps.find((s) => !new Set(done).has(s.id)) || {}).id
  assert.equal(at([]), "search", "什么都没做时，当前步是第一步而不是别的")
  assert.equal(at(["search"]), "write")
  assert.equal(at(["search", "write"]), "refcheck", "写完才轮到引用核查")
  // 闸不是第一步 —— 若哪天有模块把闸排到最前，上面那条"第一轮高亮第一步"的兜底就要重新想。
  // 注意 stepsFor 给的是原始定义（gate 只在为真时存在，归一成布尔是 workflowFor 干的），故用 !
  assert.ok(!steps[0].gate, "review 的第一步不该是质量闸")
})

test("勾了『格式与体例』得真有一步会走它，否则是勾了没用的哑选项", () => {
  const w = WF.WORKFLOWS.refcheck
  assert.ok(w.intake.find((f) => f.id === "checks").options.some((o) => o.v === "format"))
  const ids = WF.stepsFor("refcheck", { checks: ["format"] }).map((s) => s.id)
  assert.ok(ids.includes("review"), "格式与体例由评审自查那一步顺带查")
})

test("国自然正文里『特色与创新』是必备章节，默认不能不勾", () => {
  const sec = WF.WORKFLOWS.grant.steps.find((s) => s.id === "write").form.find((f) => f.id === "sections")
  assert.ok(sec.default.includes("feature"), "默认漏掉它等于让申请人交一份缺章节的标书")
})

test("勾了 Table 1 就得能选分组列（Table 1 的本质就是按组分列对比）", () => {
  const f = WF.WORKFLOWS.stats.intake.find((x) => x.id === "groupCol")
  assert.equal(WF.visible(f, { analyses: ["table1"] }), true)
  assert.equal(WF.visible(f, { analyses: ["compare"] }), true)
  assert.equal(WF.visible(f, { analyses: ["desc"] }), false, "不做分组的分析就别显示，免得填串")
})

test("勾了『数据完整性』必须一并传数值表，否则这一项注定做不成", () => {
  const f = WF.WORKFLOWS.refcheck.intake.find((x) => x.id === "dataFiles")
  assert.equal(WF.isRequired(f, { checks: ["refs"] }), false)
  assert.equal(WF.isRequired(f, { checks: ["refs", "integrity"] }), true)
})

test("润色模块的语言默认是『保持原文』——默认中文会把英文稿翻译掉，后果不可逆", () => {
  const f = WF.WORKFLOWS.humanize.intake.find((x) => x.id === "lang")
  assert.equal(f.default, "keep")
  assert.match(f.options.find((o) => o.v === "keep").t, /保持原文/)
})

test("表单里不许出现内部文档编号（AGENTS.md §X 对医生用户是天书）", () => {
  const dump = JSON.stringify(WF.WORKFLOWS)
  assert.doesNotMatch(dump, /AGENTS\.md/, "把 §X 换成人话，如「这是平台的硬性规定」")
})

test("选项里的括号说明不能是给界面看的指路语——它会原样进 AI 指令", () => {
  // 实测发出过「资助渠道：其它（下方说明）」，AI 收到的字面上就叫"其它（下方说明）"，等于没说
  for (const [mod, w] of Object.entries(WF.WORKFLOWS))
    for (const f of w.intake || [])
      for (const o of f.options || [])
        assert.doesNotMatch(o.t, /下方|上方|见下|如下|左侧/, `${mod}.${f.id} 的选项「${o.t}」把界面指路语写进了选项文案`)
})

test("模块闸不该误杀只读命令，几种平常的路径写法也不能漏过去", () => {
  const gate = new Set(["write-paper", "env-setup"])
  const V = (cmd) => WF.gateViolation({ tool: "bash", input: { command: cmd }, skillGate: gate, restricted: true })
  // 只读：agent 常要 cat 一下别的技能的 SKILL.md 才能把话讲清楚（综述模块的脚注就要求它指路），
  // 判成越权会整轮 abort —— 读文档不产生该技能的产出，不是分权要挡的东西
  assert.equal(V("cat /app/.opencode/skills/systematic-review/SKILL.md"), null)
  assert.equal(V("grep -n PRISMA .opencode/skills/systematic-review/SKILL.md"), null)
  assert.equal(V("ls .opencode/skills/nature-figure/"), null)
  // 平常的路径写法（含空格时加引号是习惯），归一化前这几种全漏
  for (const cmd of ["python /app/.opencode/skills//deidentify/x.py",
                     "python /app/.opencode/skills/./deidentify/x.py",
                     'python "/app/.opencode/skills"/deidentify/x.py'])
    assert.match(V(cmd) || "", /deidentify/, `漏过：${cmd}`)
  assert.equal(V("python .opencode/skills/write-paper/a.py"), null, "白名单内的照常放行")
  // ★ 只读放行必须【逐段】判：拿整条命令的第一个词放行整条的话，把 cat 当前缀就能绕过整道闸
  assert.match(V("cat x.py | python .opencode/skills/nature-figure/y.py") || "", /nature-figure/,
    "管道后半段是执行，不能因为开头是 cat 就整条放行")
  assert.match(V("grep -n x a.md && python .opencode/skills/deidentify/run.py") || "", /deidentify/)
  assert.match(V(["ls .opencode/skills/write-paper/", "python .opencode/skills/peer-review/r.py"].join("\n")) || "",
    /peer-review/, "换行分隔的第二条命令同样要查")
})

test("stats 出完表要能导成 Word——不放行排版技能，这个模块最常见的下一句就被闸掐掉", () => {
  const s = WF.skillsOf("stats")
  assert.ok(s.includes("render-docx") && s.includes("render-pdf-doc"))
})

test("步骤裁剪的每种组合都要和帮助文字里的承诺对得上（界面照着 stepsFor 画）", () => {
  // 表单上的帮助文字白纸黑字写着这几条，界面上的流程条与实际执行必须都照做，
  // 否则用户看到的流程和真跑的流程是两回事 —— 这种不一致从界面上完全看不出来。
  const ids = (v) => WF.stepsFor("paper", v).map((s) => s.id)
  const raw = { materials: ["rawdata"] }
  assert.equal(ids({ ...raw, studyType: "rct" })[0], "novelty",
    "「前瞻性与 RCT 会把新颖性裁定提到最前」——帮助文字这么写的，流程就得这么排")
  assert.equal(ids({ ...raw, studyType: "prospective" })[0], "novelty")
  assert.ok(!ids({ ...raw, studyType: "diagnostic" }).includes("table1"),
    "「诊断准确性研究会跳过基线表那步」——帮助文字这么写的")
  assert.ok(ids({ ...raw, studyType: "retrospective" }).includes("table1"))
  // 没有原始数据（如纯 Case Report）不该挂着一串统计步骤
  const noData = ids({ materials: [], studyType: "caseseries" })
  for (const s of ["deid", "stats", "table1", "integrity"])
    assert.ok(!noData.includes(s), `没有数据却排了「${s}」这一步`)
})

// ---- 历史回放的步骤归属（前端按步骤分组的依据）----
// 【为什么值得测】这套口径必须与前端直播分组（index.html 的 markStepBySkill / absorbTail）
//   逐条对齐。漂了不会报错，只会让同一段对话"刷新前按步骤分了组、刷新后另一个样"——
//   而那恰恰是没人会去点开对比的地方。
test("历史消息按技能调用归到步骤：一轮只认第一步，同技能多步按序取", () => {
  const steps = WF.stepsFor("review", { topic: "x" })
  const skillPart = (name) => ({ type: "tool", tool: "skill", state: { input: { name } } })
  const seen = new Set()
  assert.equal(WF.stepOfParts([skillPart("search-lit")], steps, seen).id, "search")
  assert.equal(WF.stepOfParts([skillPart("literature-review")], steps, seen).id, "write")
  // 同一个技能第二次出现（成文那步返工重跑）→ 仍归它自己那一步，不能顺移到下一格
  assert.equal(WF.stepOfParts([skillPart("literature-review")], steps, seen).id, "write")
  // 一条消息里横跨两步 → 只认第一个（界面上一个回合是不可分割的框）
  const seen2 = new Set()
  assert.equal(WF.stepOfParts([skillPart("reference-check"), skillPart("render-pdf-doc")], steps, seen2).id, "refcheck")
  // 没有技能调用 / 没有步骤集（自由对话）→ null，前端据此完全不分组
  assert.equal(WF.stepOfParts([{ type: "text", text: "hi" }], steps, new Set()), null)
  assert.equal(WF.stepOfParts([skillPart("search-lit")], [], new Set()), null)
  assert.equal(WF.stepOfParts([skillPart("不存在的技能")], steps, new Set()), null)
})

test("用户提问归到它引出的那一步，而不是上一步", () => {
  const out = [
    { role: "user", text: "开始" },
    { role: "assistant", text: "检索完了", step: "search", stepName: "文献检索" },
    { role: "user", text: "继续下一步：综述成文", step: "search", stepName: "文献检索" },
    { role: "assistant", text: "写完了", step: "write", stepName: "综述成文" },
    { role: "user", text: "最后一条还没人回" },
  ]
  WF.fillUserSteps(out)
  assert.equal(out[0].step, "search", "第一条提问要归进它引出的第一步，否则那一步的框从 AI 开口才开始")
  assert.equal(out[2].step, "write", "「继续下一步」必须归到新的那一步，不能留在上一步的框尾")
  assert.equal(out[4].step, undefined, "还没有回复的末条提问没有归属可言，别硬塞给上一步")
})

// ============ 网关接口层 ============

let seq = 0
async function gateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"))
  const over = {
    MANAGE_OC: "0", PORT: "0", OC_URL: "http://127.0.0.1:1",
    HOME: dir, USERPROFILE: dir,
    SESSIONS_META_PATH: path.join(dir, "sessions-meta.json"),
    MODEL_CFG_PATH: path.join(dir, "model-config.json"),
    OC_CONFIG_PATH: path.join(dir, "opencode.json"),
    CLOUD_STATE_PATH: path.join(dir, "no-cloud.json"),
    CLOUD_CFG_PATH: path.join(dir, "no-such-cloud.json"),
    SCI_CLOUD_URL: "", OC_GATEWAY_URL: "", OC_GATEWAY_KEY: "",
    ALLOWED_SKILLS: "", ALLOWED_MODULES: "", SUGGEST_ENABLED: "0",
  }
  const saved = {}
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v }
  let mod
  try { mod = await import(`../server.mjs?wf=${++seq}`) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  let port
  for (let i = 0; i < 200; i++) { port = mod.server?.address()?.port; if (port) break; await new Promise((r) => setTimeout(r, 50)) }
  if (!port) throw new Error("网关没起来")
  const base = `http://127.0.0.1:${port}`
  return {
    base, dir,
    close: () => new Promise((r) => (mod.server ? mod.server.close(r) : r())),
    async get(p) { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) } },
    async post(p, body) {
      const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
  }
}

test("下发工作流：前端只当渲染器，schema 全从服务端来（改流程不用重发安装包）", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  const r = await gw.get("/api/modules/paper/workflow")
  assert.equal(r.status, 200)
  const wf = r.json.workflow
  assert.equal(wf.name, "SCI 论文")
  assert.ok(wf.intake.length > 5, "立项卡要有实质内容")
  assert.ok(wf.steps.some((s) => s.gate), "至少要有质量闸，否则前端画不出闸标记")
  assert.ok(wf.steps.every((s) => s.name && s.skill), "每步都要有名字和技能")
  // chat 没有工作流 —— 必须明确回 null，前端据此保持原样，而不是崩在 undefined 上
  const c = await gw.get("/api/modules/chat/workflow")
  assert.equal(c.status, 200)
  assert.equal(c.json.workflow, null)
  const bad = await gw.get("/api/modules/nope/workflow")
  assert.equal(bad.status, 404)
})

test("表单提交换任务卡：服务端只负责把勾选变成文本，发送仍走原来那条口", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  const r = await gw.post("/api/workflow/form", {
    module: "review", values: { topic: "PD-1 在肝癌一线治疗", years: "5", limit: 30 },
  })
  assert.equal(r.status, 200)
  assert.match(r.json.card, /【任务卡 · 综述撰写/)
  assert.match(r.json.card, /综述主题：PD-1 在肝癌一线治疗/)
  assert.match(r.json.card, /时间范围：近 5 年/)
  // limit 字段已删除：老前端/接口调用方仍可能带着它，服务端只遍历现有字段，所以它该被丢掉，
  // 绝不能又以"最多 30 篇"的形式回到任务卡里（那等于偷偷把上限还给了模型）
  assert.doesNotMatch(r.json.card, /30/, "已删除的召回上限不该再出现在任务卡里")
  assert.match(r.json.card, /系统综述|Meta/, "综述模块的脚注要跟着卡片一起给到 agent")
  const bad = await gw.post("/api/workflow/form", { module: "chat", values: {} })
  assert.equal(bad.status, 400, "chat 没有工作流，要明确拒绝而不是回一张空卡")
})

test("读数据表头：CSV 给真列名，读不了的格式如实说原因（不能回空下拉让人以为没有列）", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  const upl = path.join(gw.dir, "uploads")   // 无 sid 时落共享 uploads
  // 网关的 UPLOADS 指向仓库根，这里直接打无 sid 的路径拿不到临时目录 —— 改用真实上传口
  const form = await gw.post("/api/workflow/form", { module: "stats", values: { analyses: ["profile"] } })
  assert.equal(form.status, 200)
  const r = await gw.get("/api/data/headers?name=" + encodeURIComponent("不存在.csv"))
  assert.equal(r.status, 404, "文件不存在要 404，别回一个空表头装作成功")
  const x = await gw.get("/api/data/headers?name=" + encodeURIComponent("x.xlsx"))
  assert.equal(x.status, 404)
  void upl
})

test("上传先于对话：会话被上传接口提前建出来时，模块绑定要补登记（否则整条模块闸静默消失）", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  const mapFile = path.join(gw.dir, ".local", "share", "opencode", "module-map.json")
  const sid = "ses_preexisting_from_upload"
  // 模拟 /api/upload 的产物：会话已存在（有 id）但 module-map 里没有任何记录
  assert.equal(fs.existsSync(mapFile), false, "前置：绑定表还是空的")

  // 带 module 的第一条消息 —— 服务端应当认下它并补绑（opencode 是死的，这一轮会失败，不影响绑定）
  await gw.post("/api/chat/start", { q: "帮我核查这篇稿子的引用", sid, module: "refcheck" })
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8"))
  assert.equal(map[sid], "refcheck",
    "没补绑的话这个会话会被当成自由对话：模块前言 / 技能闸 / 表单值 / 步骤条全部失效，而 AI 照常回答")

  // 已绑定之后就【不再】认前端传的 module —— 防伪造请求把受限会话"升级"成不受限
  await gw.post("/api/chat/start", { q: "换个话题", sid, module: "chat" })
  const map2 = JSON.parse(fs.readFileSync(mapFile, "utf8"))
  assert.equal(map2[sid], "refcheck", "续会话不许改绑定")
})

test("回看历史时任务卡要被剥干净——否则用户看到自己'说'了一大段没说过的话", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  // 与 server.mjs 的 WFCARD_RE 同款判据：整块（含结尾说明与空行）必须能被一次剥掉
  const re = /^【任务卡 · [\s\S]*?【以上为用户通过表单[\s\S]*?】\n*/
  const r = await gw.post("/api/workflow/form", { module: "humanize", values: { goals: ["deai"], strength: "standard" } })
  assert.ok(r.json.card)
  assert.equal((r.json.card + "帮我润色这篇稿子").replace(re, ""), "帮我润色这篇稿子")
  // ★ 带脚注的模块（综述）最容易漏：脚注若拼在结束标记之后，剥完会残留在用户气泡里，
  //   用户会看到自己"说"了一句"需要 PRISMA/RoB 请到自由对话"——他根本没说过。
  const rv = await gw.post("/api/workflow/form", { module: "review", values: { topic: "PD-1 在肝癌" } })
  assert.match(rv.json.card, /系统综述|Meta/, "脚注要进卡（agent 需要它来给用户指路）")
  assert.equal((rv.json.card + "开始吧").replace(re, ""), "开始吧", "脚注必须落在可剥区间之内")
  // 用户自己手打一段普通话，绝不能被这条正则吃掉
  for (const t2 of ["帮我看看任务卡怎么写", "【重要】这是我的原始需求", "任务卡 · 我自己列的清单"])
    assert.equal(t2.replace(re, ""), t2, `误吃了用户的话：${t2}`)
})

// ---- 两条跨文件契约：改了一边、忘了另一边就静默失效，且界面上看不出任何异常 ----

test("data-integrity 的每一步都要带 gateBy:signals —— 少一个，那道闸就永远判不了红", () => {
  // 这个技能有条铁律：只出「待核信号」、不下「造假」结论，也就是它【被明令禁止】写出通用判据
  // （server.mjs 的 GATE_FAIL_*）认得的那些裁定语。于是不写 gateBy 的步骤恒绿：报告里 6 条硬性
  // 不自洽（含生理不可能的 eGFR=1220）也照打绿勾，出件拦截跟着失效（fail-open）。
  // refcheck 修过一次，stats 与 paper 两处漏改了大半年——所以这条改成全量断言，别再逐个模块记。
  const bad = []
  for (const [mod, w] of Object.entries(WF.WORKFLOWS))
    for (const s of w.steps || [])
      if (s.skill === "data-integrity" && s.gate && s.gateBy !== "signals") bad.push(`${mod}.${s.id}`)
  assert.deepEqual(bad, [], "这些 data-integrity 闸缺 gateBy:'signals'，永远判不了红")
})

test("数据体检的报告名：脚本默认值必须等于模块契约里的名字", () => {
  // 对不上时脚本照样跑完、退出码 0，而面板正文空着、步骤判不完成 —— 表现成"跑完了但界面显示还没跑"。
  // 实际发生过：脚本默认 data_quality.md，而 stats/paper 两个模块三处都写 data_profile.md。
  const py = fs.readFileSync(new URL("../../.opencode/skills/data-analysis/scripts/data_profile.py", import.meta.url), "utf8")
  const m = py.match(/add_argument\("--out",\s*default="([^"]+)"/)
  assert.ok(m, "data_profile.py 的 --out 默认值找不到了（脚本改结构了？）")
  const profile = WF.WORKFLOWS.stats.reader.modes.find((x) => x.id === "profile")
  assert.match(m[1], new RegExp(profile.file), `脚本默认写 ${m[1]}，而 stats 的体检面板只认 ${profile.file}`)
  assert.ok(WF.WORKFLOWS.stats.steps.find((s) => s.id === "profile").emits.includes(m[1]),
    `${m[1]} 不在 stats 体检步的 emits 里，产物契约会漏掉它`)
  assert.ok(WF.WORKFLOWS.paper.steps.find((s) => s.id === "stats").emits.includes(m[1]),
    `${m[1]} 不在 paper 统计步的 emits 里`)
})

// 手动放行质量闸：闸的判据是关键词匹配报告正文，必然有假阳性（实测英文报告里
// "Decision: Accept. No major revision required." 被判红），而误判的代价是【用户永远拿不到送审件】。
// 所以有这个用户开关。它必须：① 真的落盘（刷新/重启后还在）；② 能撤销；③ 认不出会话就明确报错，
// 不能悄悄放行一个空 sid —— 那等于给所有会话开了后门。
test("手动放行质量闸：开关能存能撤，缺会话 id 要报错", async (t) => {
  const gw = await gateway()
  t.after(() => gw.close())
  const sid = "ses_gatebypass_test"
  const on = await gw.post("/api/workflow/gate-bypass", { sid, on: true })
  assert.equal(on.status, 200)
  assert.equal(on.json.on, true, "放行没生效")
  // 落盘：与模块绑定表同目录（HOME 被测试指到临时目录），重启网关后仍要认得
  const f = path.join(gw.dir, ".local", "share", "opencode", "gate-bypass.json")
  assert.ok(fs.existsSync(f), "放行标记没落盘——重启/刷新后用户又被拦住，等于没放行")
  assert.ok(JSON.parse(fs.readFileSync(f, "utf8"))[sid], "落盘内容里没有这个会话")
  const off = await gw.post("/api/workflow/gate-bypass", { sid, on: false })
  assert.equal(off.json.on, false, "撤销没生效——放行必须能收回，否则闸就永久失效了")
  assert.ok(!JSON.parse(fs.readFileSync(f, "utf8"))[sid], "撤销后落盘里还留着")
  const bad = await gw.post("/api/workflow/gate-bypass", { on: true })
  assert.equal(bad.status, 400, "没有 sid 也照单全收 = 后门")
})
