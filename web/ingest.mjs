// 上传的文献 → 正文 markdown：由【网关】直接跑，不再让模型现场摸索。
//
// 【为什么要有这一层】抽正文是一件完全确定的事：输入是一份 PDF / Word，输出是一份 md。
// 但它原先只写在前言里（"PDF 用 pdf_to_md.py"），真正执行靠模型自己去试 —— 三轮实测：
//   第 1 轮：ls 找文件 → `--help` 问参数 → 跑 → 产物叫 `<原名>.md` 不是约定名，再 mv → read
//            = 5 次 LLM 往返、50 秒，其中脚本真正干活只有 5.5 秒；
//   第 3 轮：它把 `-o` 当成目录，写出一个叫 `fulltext.md/` 的【文件夹】，再 ls / wc / 两次 mv
//            收拾残局 = 8 次往返、69 秒。
// 每一次试探都是一轮完整的模型往返（光首字节就 4~6 秒）。而且每次跑法都不一样 ——
// 慢只是表象，真正的问题是这一步不可复现：出了错没法照着日志重放。
//
// 搬到这里之后：0 次模型往返，10 秒出结果，命令行固定。模型那边只收到一句"正文已抽好，在 X"。
// 抽不出来（图片型扫描件 / 脚本缺依赖）不在这里硬扛：如实告诉模型，它照旧可以去走 ocr 技能。
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const pexec = promisify(execFile)

// 抽取子进程的环境：把几个数值库的线程数钉成 1。
// 【为什么】pymupdf 那条链上挂着 numpy/OpenBLAS，默认按核数起线程、每条线程各占一块内存池。
// 真机实测（2026-09-21，本机余量不足 1GB 时）：抽一份 6 页的 PDF 直接倒在
// 「OpenBLAS error: Memory allocation still failed after 10 retries」上 —— 用户那边看到的
// 是"抽不出正文"，而原因与 PDF、与技能都没关系。抽正文是纯 IO+解析的活，单线程足够，
// 还顺带不去抢用户的 CPU（他可能正开着 Word 等着看结果）。
const CHILD_ENV = { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", MKL_NUM_THREADS: "1" }

/** 文献类的上传（能抽正文的那几种）。csv/xlsx 这些不在此列，它们归数据模块。 */
export const isDoc = (name) => /\.(pdf|docx|doc|odt)$/i.test(name)

/**
 * 产物名。与「多篇研读」的命名规则对齐（见 workflows.mjs litread 的 flow）：
 * 单篇 `fulltext.md`，多篇 `fulltext_<短名>.md`。这里一律带短名 ——
 * 会话里随时可能再传第二篇，而先传的那篇已经落盘，届时没法回头改名；
 * 带后缀的名字两种情形都成立，面板的 `^(reading_guide|fulltext)[^/]*\.(md|docx|pdf)$` 也照样认。
 */
export const fulltextName = (docName) => {
  const base = path.basename(docName).replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|\s]+/g, "_")   // 文件名里带空格/冒号的很常见，落盘前统一掉
    .slice(0, 60)
  return `fulltext_${base}.md`
}

/** 正文抽出来是不是"基本空的"（图片型扫描件的典型表现：只剩页码和零星水印） */
const looksEmpty = (text) => text.replace(/\s|[-—_=·．.]|^\d+$/gm, "").length < 200

/**
 * 把 upDir 里还没抽过的文献抽成正文 md，写进 outDir。
 * 已经有同名产物的跳过（用户可能只是又发了一轮）。
 * 返回每一篇的结果，调用方据此拼给模型的那句话；任何一篇失败都不抛。
 */
export async function ingestUploads(upDir, outDir, { pyBin, skillsRoot, timeoutMs = 120000, onDone } = {}) {
  if (!pyBin) return []
  let names = []
  try { names = fs.readdirSync(upDir).filter((n) => !n.startsWith(".") && isDoc(n)) } catch { return [] }
  const out = []
  for (const name of names) {
    const dst = path.join(outDir, fulltextName(name))
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { out.push({ name, file: path.basename(dst), cached: true }); continue }
    const src = path.join(upDir, name)
    const t0 = Date.now()
    try {
      if (/\.pdf$/i.test(name)) {
        // pdf_to_md.py 的产物名固定是 `<原名>.md`、且只认输出【目录】—— 这正是模型每次都要
        // 多花一次往返去 mv 的原因。我们知道规则，直接抽到临时目录再搬过去。
        const tmp = path.join(outDir, ".ingest")
        fs.mkdirSync(tmp, { recursive: true })
        // ★ 这个脚本【抽失败时也退 0】（它把异常吞成一行 "FAIL: ..." 打在 stderr 上），
        //   所以不能只看退出码 —— 得自己检查产物在不在，并且把它说了什么一并带出来，
        //   否则现场只剩一句"没有产出 md"，真正的原因（缺依赖、内存不够、PDF 加密）全丢了。
        const r = await pexec(pyBin, [path.join(skillsRoot, "fulltext-retrieval", "pdf_to_md.py"), src, "-o", tmp, "--force"], { timeout: timeoutMs, windowsHide: true, env: CHILD_ENV })
        const got = fs.readdirSync(tmp).filter((f) => f.toLowerCase().endsWith(".md"))[0]
        if (!got) throw new Error("脚本没有产出 md：" + (String(r?.stderr || r?.stdout || "").trim().split("\n").slice(-2).join(" / ") || "它什么也没说"))
        fs.renameSync(path.join(tmp, got), dst)
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      } else {
        // .docx/.doc/.odt：ingest_doc.py（pandoc + --extract-media，图与表一并抽出）
        await pexec(pyBin, [path.join(skillsRoot, "humanize-academic", "scripts", "ingest_doc.py"), src, "--out", dst], { timeout: timeoutMs, windowsHide: true, env: CHILD_ENV })
      }
      const text = fs.readFileSync(dst, "utf8")
      const r = { name, file: path.basename(dst), chars: text.length, ms: Date.now() - t0, empty: looksEmpty(text) }
      // 空的不留在盘上：留着会让模型以为"已经抽好了"从而不去走 ocr，而那份文件里什么都没有。
      if (r.empty) { try { fs.unlinkSync(dst) } catch {} }
      out.push(r)
    } catch (e) {
      // stderr 要收进来：脚本失败的真正原因写在那里（缺依赖、文件损坏、超时），
      // 只报 "Command failed: <一长串命令行>" 等于什么都没说，排查时还得自己重跑一遍。
      const why = String(e?.stderr || "").trim().split("\n").filter(Boolean).slice(-3).join(" / ")
        || String(e?.shortMessage || e?.message || e)
      out.push({ name, err: why.slice(0, 300), ms: Date.now() - t0 })
    }
    onDone?.(out[out.length - 1])
  }
  return out
}

/** 拼给模型的那段话。没有任何成功的抽取时返回 ""（前言里就当没这回事，走老路） */
export function ingestPreamble(results) {
  const ok = results.filter((r) => r.file && !r.empty)
  const bad = results.filter((r) => r.err || r.empty)
  if (!ok.length && !bad.length) return ""
  let s = ""
  if (ok.length) {
    s += `\n- **原文已经由系统抽好了，直接读下面这些文件，不要再自己跑抽取脚本、也不要改名**：`
      + ok.map((r) => `\`${r.name}\` → \`${r.file}\``).join("；")
      + `。它们就在你的当前目录下。`
  }
  // 失败的必须说，而且要说清"下一步去哪"，否则模型只会重跑一遍同样会失败的命令
  if (bad.length) {
    s += `\n- 这几份没能抽出正文：`
      + bad.map((r) => `\`${r.name}\`（${r.empty ? "抽出来几乎是空的，多半是图片型扫描件" : r.err}）`).join("；")
      + `。扫描件请走 \`ocr\` 技能；其它原因可以自己再试一次抽取脚本。`
  }
  return s
}
