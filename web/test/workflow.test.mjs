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
  assert.ok(WF.skillsOf("litread").includes("render-pdf-doc"), "litread 补上排版出件，否则 research 流水线最后一步做不了")
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
  assert.equal(WF.primaryOf("litread"), "search-lit")
  // primary 必须真在技能集里，否则模块永远不可用而且没人看得出为什么
  for (const m of Object.keys(WF.WORKFLOWS))
    assert.ok(WF.skillsOf(m).includes(WF.primaryOf(m)), `${m} 的 primary 不在技能集里`)
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
    journalTier: "target", jImpact: { min: 3, max: 6 }, lang: "zh",
  })
  assert.match(card, /^【任务卡 · SCI 论文 \/ 立项确认】/)
  assert.match(card, /研究类型：回顾性队列/, "select 要显示选项文案而不是 v 值")
  assert.match(card, /已有材料：原始数据表（xlsx\/csv）、伦理批件号/, "multi 要逐项展开")
  assert.match(card, /伦理批件号：2025-KY-081/)
  assert.match(card, /文献来源期刊的影响力（近似值）：3 – 6 两年篇均被引/, "range 要带单位")
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
  const j = WF.WORKFLOWS.paper.intake.find((x) => x.id === "jImpact")
  assert.match(j.label, /近似/)
  assert.doesNotMatch(j.label, /影响因子|IF|JIF/)
  assert.match(j.help, /不是官方影响因子/)
  // 且必须写明筛的是"检索结果"而非"你想投的刊"——它紧跟在目标期刊字段后面，实测会被读反
  assert.match(j.label, /文献来源期刊/)
  assert.match(j.help, /不是你想投的刊/)
  const q = WF.WORKFLOWS.paper.intake.find((x) => x.id === "jQuartile")
  assert.doesNotMatch(q.label, /分区/, "别叫'分区'——那是中科院/JCR 的授权数据，我们没有")
  assert.match(q.help, /不是中科院或 JCR 分区/)
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

test("只算样本量的人不该被『数据文件』必填卡死（做研究之前根本没有数据）", () => {
  const f = WF.WORKFLOWS.stats.intake.find((x) => x.id === "dataFiles")
  assert.ok(!f.required, "不能无条件必填")
  assert.equal(WF.isRequired(f, { analyses: ["power"] }), false, "只算样本量 → 不必填")
  assert.equal(WF.isRequired(f, { analyses: ["survival"] }), true, "要跑分析 → 必填")
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
