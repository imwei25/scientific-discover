// 定时任务的【模板】：基础档（tasksMode=preset）用户不能写自由指令，只能挑一个模板、填几个参数。
//
// 【为什么模板 prompt 必须在服务端拼】界面上给填空表单只是"看起来受限"——/api/tasks/save 是个
// 普通 HTTP 接口，改一行 JSON 就能塞进任意 prompt。所以：preset 档的存盘接口【只收模板 id 与参数】，
// prompt 由这里生成，客户端传什么 prompt 都丢掉。界面限制不是限制，服务端拼装才是。
//
// 【为什么模板要写得这么啰嗦】它是在没人看着的时候跑的：没人能回答"你要几篇"，也没人能在
// 跑偏时叫停。所以范围、篇数、产物文件名、"一篇都没有时怎么办"都必须写死在模板里。
//
// 加新模板：往 PRESETS 里加一项即可（客户端界面按 fields 自动渲染表单，不用改 UI 代码）。

/** 单个参数值的清洗：模板参数最终会拼进发给模型的正文，不能让它夹带指令或撑爆长度。 */
const clean = (v, max) => String(v == null ? "" : v)
  .replace(/[\u0000-\u001f\u007f]/g, " ")   // 控制字符（含换行）一律压成空格，理由见下
  .trim().slice(0, max)

export const PRESETS = {
  "lit-push": {
    id: "lit-push",
    name: "文献推送",
    desc: "定期检索你指定领域的新文献，筛出相关的，写成一份带要点和 DOI 的清单。",
    fields: [
      { key: "topic", label: "领域 / 检索词", type: "text", max: 120, required: true,
        placeholder: "例：胰腺癌 早期诊断 生物标志物", hint: "越具体越好；太宽泛会推来一堆不相关的。" },
      { key: "context", label: "你的课题一句话（可不填，用来筛掉不相关的）", type: "text", max: 200, required: false,
        placeholder: "例：我在做基于外泌体 miRNA 的早筛 panel 开发" },
      { key: "limit", label: "每次最多几篇", type: "number", min: 3, max: 20, default: 8 },
    ],
    /** 参数 → 真正发给模型的那条消息。产物文件名固定，用户改不了（无人值守时没人能确认"是哪个文件"）。 */
    build(p) {
      const topic = clean(p.topic, 120)
      const ctx = clean(p.context, 200)
      const n = Math.max(3, Math.min(20, Number(p.limit) || 8))
      return [
        `检索最近 7 天发表的、关于「${topic}」的新文献。`,
        ctx ? `我的课题是：${ctx}。请据此筛掉不相关的。` : "",
        `最多保留 ${n} 篇，按相关度从高到低排序。`,
        "每篇给出：标题（中文一句话意译）、研究设计/类型、一句话核心发现、期刊与发表日期、DOI。",
        "写成当前目录下的 `weekly.md`，用表格或分条列出，开头写明检索日期、检索式与命中总数。",
        "**只写真实检索到的文献**：DOI 与标题必须来自本次检索结果，一条都不许编。",
        "如果这段时间一篇相关的都没有，也要建好 `weekly.md` 并在里面写明「本期无新增」与你用的检索式——不要因为没结果就什么都不产出。",
      ].filter(Boolean).join("\n")
    },
    /** 列表里显示成一句人话 */
    summary: (p) => `文献推送：${clean(p.topic, 40) || "（未填领域）"}`,
  },
}

export const presetList = () => Object.values(PRESETS).map((p) => ({ id: p.id, name: p.name, desc: p.desc, fields: p.fields }))

/**
 * 校验并生成。返回 {ok, prompt, params, title} 或 {ok:false, err}。
 * 【不放过缺必填项】到点跑的时候没人能补，缺了就是白跑一轮、白花钱。
 */
export function buildPreset(presetId, params) {
  const def = PRESETS[String(presetId || "")]
  if (!def) return { ok: false, err: "不认识这个任务模板" }
  const out = {}
  for (const f of def.fields) {
    const raw = (params || {})[f.key]
    if (f.type === "number") {
      const n = Number(raw)
      out[f.key] = Number.isFinite(n) ? Math.max(f.min ?? 0, Math.min(f.max ?? 9999, Math.floor(n))) : (f.default ?? f.min ?? 0)
      continue
    }
    const v = clean(raw, f.max || 200)
    if (f.required && !v) return { ok: false, err: `请填「${f.label}」` }
    out[f.key] = v
  }
  return { ok: true, prompt: def.build(out), params: out, title: def.summary(out) }
}
