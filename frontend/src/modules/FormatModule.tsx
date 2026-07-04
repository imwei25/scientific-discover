import { useEffect, useRef, useState } from "react";
import { useStream } from "../lib/useStream";
import { usePersistentState } from "../lib/usePersistentState";
import { addHistory } from "../lib/history";
import { apiUrl } from "../lib/api";
import ResultPanel from "../components/ResultPanel";
import Dropzone from "../components/Dropzone";
import type { Reference } from "../lib/sse";
import { downloadDocxFromText, downloadBase64, openInOverleaf } from "../lib/download";
import { copyToClipboard } from "../lib/clipboard";
import DiffView from "../components/DiffView";
import { LiteraturePicker, pickerKey } from "../components/LiteraturePicker";
import { consume as consumeHandoff, REFHANDOFF_EVENT } from "../lib/refHandoff";


interface Journal {
  id: string;
  name: string;
  summary: string;
}

interface RefCheckItem {
  raw: string;
  doi: string;
  pmid: string;
  title: string;
  status: string; // real | not_found | retracted | unverifiable
  note: string;
  completed: string;
  duplicate_of?: number;
}

const REFCHECK_BADGE: Record<string, { label: string; cls: string }> = {
  real: { label: "✓ 真实", cls: "rc-real" },
  not_found: { label: "✗ 查无此文献", cls: "rc-bad" },
  retracted: { label: "⚠ 已撤稿", cls: "rc-warn" },
  unverifiable: { label: "? 无法核验", cls: "rc-gray" },
};

interface ReadinessItem {
  key: string;
  label: string;
  status: string; // pass | warn | fail | info
  detail: string;
  suggestion: string;
}
interface ReadinessResult {
  ok: boolean;
  journal?: string;
  summary?: { pass: number; warn: number; fail: number };
  items?: ReadinessItem[];
  error?: string;
}
const READINESS_BADGE: Record<string, { label: string; cls: string }> = {
  pass: { label: "✅ 通过", cls: "rc-real" },
  warn: { label: "⚠️ 注意", cls: "rc-warn" },
  fail: { label: "❌ 缺失", cls: "rc-bad" },
  info: { label: "ℹ️ 提示", cls: "rc-gray" },
};

export default function FormatModule() {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [journalId, setJournalId] = usePersistentState("format:journal", "");
  const [manuscript, setManuscript] = usePersistentState("format:manuscript", "");
  const [downloading, setDownloading] = useState(false);
  // LaTeX / Overleaf 出口
  const [latexBusy, setLatexBusy] = useState(false);
  const [latexErr, setLatexErr] = useState<string | null>(null);
  const [latexZip, setLatexZip] = useState("");
  const [latexNote, setLatexNote] = useState("");
  const [latexCompiler, setLatexCompiler] = useState("");
  const { text, running, error, start, stop, setText } = useStream("format:result");
  // 投稿包: 投稿就绪检查(确定性) + 投稿信(LLM 流)
  const [readiness, setReadiness] = usePersistentState<ReadinessResult | null>("format:readiness", null);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [readinessErr, setReadinessErr] = useState<string | null>(null);
  const cover = useStream("format:cover");
  const [coverDocxBusy, setCoverDocxBusy] = useState(false);

  // 参考文献格式化(CSL)
  const [refsInput, setRefsInput] = usePersistentState("format:refs", "");
  const [fmtRefs, setFmtRefs] = usePersistentState<string[]>("format:fmtRefs", []);
  const [refsBusy, setRefsBusy] = useState(false);
  const [refsErr, setRefsErr] = useState<string | null>(null);

  // 参考文献核验(真实性/撤稿/去重/补全)
  const [checkResult, setCheckResult] = usePersistentState<RefCheckItem[]>("format:refcheck", []);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);

  // 引用文件双向导入导出: 用户从 EndNote/Zotero 导入的结构化引用 + 用于导出.
  const [importedRefs, setImportedRefs] = usePersistentState<Reference[]>("format:importedRefs", []);

  // 结构化参考文献面板: 勾选 keys、handoff 通知
  // NOTE: 期刊排版只关心引用条目, 不显示核心发现, 也不做 evidence extraction.
  const [structuredSelectedKeys, setStructuredSelectedKeys] = usePersistentState<string[]>("format:selectedKeys", []);
  // 生成 fmtRefs 时用到的结构化源, 与 fmtRefs[i] 一一对应。
  // 走文本路径 (无结构化输入) 时为空数组; 下载 Word/LaTeX 时用它反查真正的结构化数据。
  const [fmtSourceRefs, setFmtSourceRefs] = usePersistentState<Reference[]>("format:fmtSourceRefs", []);
  const [handoffToast, setHandoffToast] = useState<string | null>(null);
  // handoff 到达后, 若期刊模板已选好, 自动跑一次「按该期刊格式化参考文献」。
  const [pendingAutoFormat, setPendingAutoFormat] = useState(false);

  // 三个分页: refs 参考文献 | manuscript 正文排版(上传+触发) | preview 正文预览(输出+下载)
  type FormatTab = "refs" | "manuscript" | "preview";
  const [activeTab, setActiveTab] = usePersistentState<FormatTab>("format:tab", "manuscript");

  // 正文排版分页上, 用户可勾选参考文献分页已排版好的条目, 附到 Word 下载末尾。
  const [selectedFmtIdxs, setSelectedFmtIdxs] = usePersistentState<number[]>("format:selectedFmtIdxs", []);
  // fmtRefs 变化时, 默认全选新的条目 (只有当当前选择为空 或 长度和 fmtRefs 不匹配时才重置, 避免覆盖手动微调)。
  useEffect(() => {
    if (!fmtRefs.length) {
      if (selectedFmtIdxs.length) setSelectedFmtIdxs([]);
      return;
    }
    // 上次和这次都非空但条目变了 (通常是重新格式化), 或本来就没选过 → 全选。
    const allValid = selectedFmtIdxs.every((i) => i >= 0 && i < fmtRefs.length);
    if (!allValid || selectedFmtIdxs.length === 0) {
      setSelectedFmtIdxs(fmtRefs.map((_, i) => i));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmtRefs.length]);

  // 结构化参考文献优先: 若有勾选条目则以 CSL-JSON 送后端(跳过 LLM 解析), 否则退回 textarea
  const structuredCheckedRefs = (): Reference[] => {
    if (!structuredSelectedKeys.length) return [];
    const s = new Set(structuredSelectedKeys);
    return importedRefs.filter((r) => s.has(pickerKey(r)));
  };

  /** 从 Reference 构造 CSL-JSON 条目, 缺失字段自动省略, 不产生空占位。 */
  const refToCsl = (r: Reference, i: number): Record<string, unknown> => {
    const it: Record<string, unknown> = { id: `ref${i + 1}`, type: "article-journal" };
    if (r.title) it.title = r.title;
    if (r.first_author) {
      // 后端 CSL 期望 [{family, given}]; 只有一个"first_author"字符串时按整字符串放 family, given 留空。
      // 前端拿不到多作者列表, 这里作为可接受的近似; 如需精确, 让用户后续在 textarea 中粘贴完整作者。
      const name = r.first_author.trim();
      const parts = name.split(/\s+/);
      const family = parts.length > 1 ? parts.slice(-1)[0] : name;
      const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
      it.author = [given ? { family, given } : { family }];
    }
    if (r.journal) it["container-title"] = r.journal;
    if (r.year) {
      const yr = parseInt(String(r.year), 10);
      if (!Number.isNaN(yr)) it.issued = { "date-parts": [[yr]] };
    }
    if (r.doi) it.DOI = r.doi;
    if (r.url && !r.doi) it.URL = r.url;
    return it;
  };

  /** 从 Reference 序列化成可读文本, 缺失字段整段丢弃, 不出现 ". . ." 空占位。 */
  const refToLine = (r: Reference, i: number): string => {
    const parts: string[] = [];
    if (r.first_author) parts.push(r.first_author);
    if (r.title) parts.push(r.title);
    if (r.journal) parts.push(r.journal);
    if (r.year) parts.push(String(r.year));
    if (r.doi) parts.push(`DOI:${r.doi}`);
    else if (r.url) parts.push(r.url);
    return `${i + 1}. ${parts.join(". ")}${parts.length ? "." : ""}`;
  };

  /** 供 /api/format-refs: 结构化勾选时同时送 csl_json (跳过 LLM) 和文本兜底。 */
  const refsBodyForFormat = (): { references: string; csl_json?: Record<string, unknown>[] } => {
    const struct = structuredCheckedRefs();
    if (struct.length) {
      return {
        references: struct.map((r, i) => refToLine(r, i)).join("\n"),
        csl_json: struct.map((r, i) => refToCsl(r, i)),
      };
    }
    return { references: refsInput };
  };

  /** 供 /api/check-refs 和 /api/latex: 只送文本 (后端目前不接受 csl_json)。 */
  const refsTextForApi = (): string => {
    const struct = structuredCheckedRefs();
    if (struct.length) return struct.map((r, i) => refToLine(r, i)).join("\n");
    return refsInput;
  };

  const checkRefs = async () => {
    if (!refsInput.trim() && !structuredCheckedRefs().length) return;
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckErr(null);
    setCheckResult([]);
    try {
      const resp = await fetch(apiUrl("/api/check-refs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ references: refsTextForApi() }),
      });
      const d = await resp.json();
      if (d.ok) setCheckResult(d.items || []);
      else setCheckErr(d.error || "核验失败");
    } catch (e) {
      setCheckErr(`核验失败：${(e as Error).message}`);
    } finally {
      setCheckBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "format",
        icon: "📄",
        title: manuscript.slice(0, 40) || "期刊排版",
        data: { "format:manuscript": manuscript, "format:journal": journalId, "format:result": text },
      });
    }
  }, [running, error, text, manuscript, journalId]);

  // 消费来自 IdeaModule / GrantModule 的参考文献 handoff
  useEffect(() => {
    const drain = () => {
      const stash = consumeHandoff();
      if (!stash) return;
      setImportedRefs((prev) => {
        const keyMap = new Map(prev.map((r) => [pickerKey(r), r]));
        for (const r of stash.refs) keyMap.set(pickerKey(r), r);
        return Array.from(keyMap.values());
      });
      setStructuredSelectedKeys((prev) => {
        const s = new Set(prev);
        for (const r of stash.refs) s.add(pickerKey(r));
        return Array.from(s);
      });
      const src = stash.from === "idea" ? "找选题" : "写标书";
      setHandoffToast(`已从 ${src} 带入 ${stash.refs.length} 篇文献`);
      setTimeout(() => setHandoffToast(null), 4000);
      // 带入的文献落在「参考文献」分页; 自动切过去让用户看到发生了什么。
      setActiveTab("refs");
      // 一键格式化: 若期刊模板已选好, 立刻跑; 否则挂待办, 等 journals 加载完再触发。
      setPendingAutoFormat(true);
    };
    drain(); // consume stash that arrived before mount
    window.addEventListener(REFHANDOFF_EVENT, drain);
    return () => window.removeEventListener(REFHANDOFF_EVENT, drain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatRefs = async () => {
    if (!refsInput.trim() && !structuredCheckedRefs().length) return;
    if (refsBusy) return;
    setRefsBusy(true);
    setRefsErr(null);
    setFmtRefs([]);
    // 快照本次格式化用到的结构化源, 供 LaTeX / Word 下载时反查真正的 CSL-JSON。
    // 走 textarea 路径 (无结构化输入) 时快照为空数组。
    const snap = structuredCheckedRefs();
    setFmtSourceRefs(snap);
    try {
      const resp = await fetch(apiUrl("/api/format-refs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...refsBodyForFormat(), journal_id: journalId }),
      });
      const d = await resp.json();
      if (d.ok) setFmtRefs(d.formatted || []);
      else setRefsErr(d.error || "格式化失败");
    } catch (e) {
      setRefsErr(`格式化失败：${(e as Error).message}`);
    } finally {
      setRefsBusy(false);
    }
  };

  // handoff 到达 + 期刊模板已选 → 自动跑一次「按该期刊格式化参考文献」。
  // 若 handoff 时 journalId 还没加载完, 等 journals 到位后触发。
  useEffect(() => {
    if (!pendingAutoFormat) return;
    if (!journalId) return;
    if (!structuredCheckedRefs().length) return;
    setPendingAutoFormat(false);
    formatRefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoFormat, journalId, structuredSelectedKeys.length, importedRefs.length]);

  useEffect(() => {
    fetch(apiUrl("/api/journals"))
      .then((r) => r.json())
      .then((d) => {
        setJournals(d.journals || []);
        // 仅在尚未选择(或上次选择已失效)时, 默认选第一个
        setJournalId((prev) =>
          prev && d.journals?.some((j: Journal) => j.id === prev) ? prev : d.journals?.[0]?.id ?? "",
        );
      })
      .catch(() => setJournals([]));
  }, [setJournalId]);

  // W2-3 Diff: 排版前快照原稿, 完成后弹 DiffView 让用户接受/拒绝。
  const [diffOpen, setDiffOpen] = useState(false);
  const [originalSnapshot, setOriginalSnapshot] = useState("");
  const prevRunning = useRef(running);
  useEffect(() => {
    // 从 running 真→假 且无错误 且 text 非空 → 弹 diff
    if (prevRunning.current && !running && !error && text && originalSnapshot) {
      setDiffOpen(true);
    }
    prevRunning.current = running;
  }, [running, error, text, originalSnapshot]);

  const submit = () => {
    if (!manuscript.trim() || !journalId || running) return;
    setOriginalSnapshot(manuscript);  // 记录原文, 用于稍后 diff
    start("format", { manuscript, journal_id: journalId });
    setActiveTab("preview");  // 触发后立刻跳到预览页, 输出边流边显示
  };

  // 投稿就绪检查: 确定性(后端纯规则), 即时、零额度、不调 LLM。
  const runReadiness = async () => {
    if (!manuscript.trim() || !journalId || readinessBusy) return;
    setReadinessBusy(true);
    setReadinessErr(null);
    setReadiness(null);
    try {
      const resp = await fetch(apiUrl("/api/readiness"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manuscript, journal_id: journalId }),
      });
      const d: ReadinessResult = await resp.json();
      if (d.ok) setReadiness(d);
      else setReadinessErr(d.error || "检查失败");
    } catch (e) {
      setReadinessErr(`检查失败：${(e as Error).message}`);
    } finally {
      setReadinessBusy(false);
    }
  };
  const runCover = () => {
    if (!manuscript.trim() || !journalId || cover.running) return;
    cover.start("coverletter", { manuscript, journal_id: journalId });
  };
  const downloadCover = async () => {
    if (!cover.text || coverDocxBusy) return;
    setCoverDocxBusy(true);
    setDlErr(null);
    try {
      await downloadDocxFromText("cover-letter.docx", cover.text);
    } catch (e) {
      setDlErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setCoverDocxBusy(false);
    }
  };

  const reset = () => {
    if (running) stop();
    if (cover.running) cover.stop();
    setManuscript("");
    setText("");
    setReadiness(null);
    setReadinessErr(null);
    cover.setText("");
    setRefsInput("");
    setFmtRefs([]);
    setRefsErr(null);
    setCheckResult([]);
    setCheckErr(null);
    setImportedRefs([]);
    setStructuredSelectedKeys([]);
    setSelectedFmtIdxs([]);
    setFmtSourceRefs([]);
    // 顺手清掉遗留的 format:evidence（老版本可能留下的 localStorage 键）
    try { localStorage.removeItem("format:evidence"); } catch { /* no-op */ }
    setHandoffToast(null);
    setLatexZip("");
    setLatexErr(null);
    setLatexNote("");
    setLatexCompiler("");
  };

  const [dlErr, setDlErr] = useState<string | null>(null);
  /** 已勾选的 fmtRefs 子集 (若 selectedFmtIdxs 为空则视为空)。 */
  const checkedFmtRefs = (): string[] => {
    const s = new Set(selectedFmtIdxs);
    return fmtRefs.filter((_, i) => s.has(i));
  };
  const downloadDocx = async () => {
    if (!text || downloading) return;
    setDownloading(true);
    setDlErr(null);
    try {
      await downloadDocxFromText("manuscript.docx", text, { journal_id: journalId, references: checkedFmtRefs() });
    } catch (e) {
      setDlErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  /** 已勾选的结构化 refs (基于 fmtRefs 对应的 fmtSourceRefs 快照)。 */
  const checkedSourceRefs = (): Reference[] => {
    if (!fmtSourceRefs.length || !selectedFmtIdxs.length) return [];
    const s = new Set(selectedFmtIdxs);
    return fmtSourceRefs.filter((_, i) => s.has(i));
  };

  // 生成 LaTeX 工程(.tex+.bib),拿到 base64 zip 供下载 / 在 Overleaf 打开。
  const exportLatex = async () => {
    if (!text.trim() || latexBusy) return;
    setLatexBusy(true);
    setLatexErr(null);
    setLatexZip("");
    setLatexNote("");
    setLatexCompiler("");
    try {
      // 优先用「正文排版」页勾选的已排版条目 (fmtSourceRefs + selectedFmtIdxs);
      // 没有就退回结构化面板 / textarea 文本。
      const picked = checkedSourceRefs();
      const body: Record<string, unknown> = { text, journal_id: journalId };
      if (picked.length) {
        body.csl_json = picked.map((r, i) => refToCsl(r, i));
        body.references = picked.map((r, i) => refToLine(r, i)).join("\n");  // 兜底
      } else {
        body.references = refsTextForApi();
      }
      const resp = await fetch(apiUrl("/api/latex"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 若后端未启动/崩溃, resp.ok 会为 false 或 resp.json() 抛异常, 需明确提示
      if (!resp.ok) {
        const rawText = await resp.text().catch(() => "");
        throw new Error(`后端返回 ${resp.status}: ${rawText.slice(0, 200) || "无响应体"}`);
      }
      const d = await resp.json();
      if (d.ok) {
        setLatexZip(d.b64zip || "");
        setLatexNote(d.note || "");
        setLatexCompiler(d.compiler || "");
      } else {
        setLatexErr(d.error || "生成失败");
      }
    } catch (e) {
      setLatexErr(
        `生成失败：${(e as Error).message}。` +
        `请确认后端正在运行(端口 8756);若刚更新过代码,需要重启后端并强制刷新浏览器(Ctrl+Shift+R)。`
      );
    } finally {
      setLatexBusy(false);
      window.dispatchEvent(new Event("usage-updated"));
    }
  };

  const selected = journals.find((j) => j.id === journalId);

  // LaTeX 预检: 检测稿件里的"LaTeX 不友好"内容, 在导出前给用户提示。
  const latexWarnings = (() => {
    if (!text || running) return [] as string[];
    const w: string[] = [];
    const hasEmoji = /[\u{1F000}-\u{1FFFF}\u2600-\u27BF]/u.test(text);
    if (hasEmoji) w.push("检测到 emoji/装饰符号 — 导出时会自动剥离");
    const tableCount = (text.match(/^\s*\|.+\|\s*$/gm) || []).length;
    if (tableCount >= 2) w.push(`检测到约 ${Math.floor(tableCount / 2)} 处 markdown 表格 — 会转成 LaTeX tabular, 可能需要手工微调列宽`);
    const codeFences = (text.match(/^```/gm) || []).length;
    if (codeFences >= 2) w.push(`检测到 ${Math.floor(codeFences / 2)} 处代码块 — 会转成 verbatim 环境`);
    const hasCjk = /[\u4e00-\u9fff]/.test(text);
    if (hasCjk && journalId === "ieee") {
      w.push("稿件含中文, 但 IEEEtran 官方类不支持中文 — 会自动降级到 article+ctex, 需在 Overleaf 选 XeLaTeX");
    } else if (hasCjk && (journalId === "general_cn" || journalId === "")) {
      w.push("稿件含中文 — 在 Overleaf 请选 XeLaTeX 编译器");
    } else if (hasCjk) {
      w.push(`稿件含中文 — 在 Overleaf 请选 XeLaTeX 编译器`);
    } else {
      w.push("纯英文稿件 — 在 Overleaf 用默认 pdfLaTeX 即可");
    }
    return w;
  })();

  return (
    <div className="module">
      <DiffView
        open={diffOpen}
        original={originalSnapshot}
        modified={text}
        title="AI 重排后的稿件 · 对比"
        onAccept={() => {
          // 接受: 把重排后的稿件回填到 manuscript 输入框, 关闭 diff
          setManuscript(text);
          setDiffOpen(false);
        }}
        onReject={() => {
          // 拒绝: 保留原稿, 清空 text(不影响 history 已存的旧记录)
          setText("");
          setDiffOpen(false);
        }}
      />
      <header className="module-head">
        <h1>📄 期刊排版</h1>
        <p>
          粘贴你的稿件，选择目标期刊，我按该刊的结构与格式要求重排；可导出按该刊版式
          （页边距/字体/行距/连续行号）排好的 Word 投稿稿，或生成 LaTeX 工程（IEEE 用官方 IEEEtran）一键在 Overleaf 打开。
        </p>
      </header>

      {/* 共享: 目标期刊 (两个 tab 都用) */}
      <div className="form">
        <label className="field">
          <span className="field-label">目标期刊</span>
          <select
            data-testid="input-journal"
            value={journalId}
            onChange={(e) => setJournalId(e.target.value)}
          >
            {journals.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          {selected && <span className="field-hint">{selected.summary}</span>}
          <span className="field-hint">
            期刊库目前只内置少数通用/示例模板。<strong>没有你的目标刊？</strong>先选「通用英文 IMRaD」或
            「中文核心 GB/T 7714」作为基础，投稿前再对照目标刊官网 Author Guidelines 微调即可。
          </span>
        </label>
      </div>

      {/* 分页栏: 参考文献 | 正文排版 */}
      <div className="format-tabs" role="tablist" data-testid="format-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "refs"}
          className={`format-tab${activeTab === "refs" ? " active" : ""}`}
          onClick={() => setActiveTab("refs")}
          data-testid="format-tab-refs"
        >
          📚 参考文献{importedRefs.length > 0 && <span className="format-tab-badge">{importedRefs.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "manuscript"}
          className={`format-tab${activeTab === "manuscript" ? " active" : ""}`}
          onClick={() => setActiveTab("manuscript")}
          data-testid="format-tab-manuscript"
        >
          📝 正文排版
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "preview"}
          className={`format-tab${activeTab === "preview" ? " active" : ""}`}
          onClick={() => setActiveTab("preview")}
          disabled={!text && !running}
          title={!text && !running ? "先在「正文排版」页跑一次重排" : ""}
          data-testid="format-tab-preview"
        >
          👀 正文预览{text && !running && <span className="format-tab-badge">已就绪</span>}
        </button>
      </div>

      {activeTab === "manuscript" && (
      <>
      <div className="form">
        <Dropzone
          testId="upload-manuscript"
          accept=".docx,.pdf,.txt,.md"
          label="上传稿件文件（可选，自动填入下方）"
          hint="支持 Word(.docx) / PDF / txt；也可直接在下方粘贴"
          mode="text"
          onText={(t) => setManuscript(t)}
        />
        <label className="field">
          <span className="field-label">稿件内容 <em>必填</em></span>
          <textarea
            data-testid="input-manuscript"
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
            placeholder="把你的论文正文粘贴到这里，或用上方上传 Word/PDF 自动填入"
            rows={8}
          />
        </label>
        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={submit}
            disabled={!manuscript.trim() || !journalId || running}
            data-testid="run-btn"
          >
            {running ? "重排中…" : "按该期刊重排"}
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
        {!manuscript.trim() && (
          <p className="field-hint" data-testid="format-gate-hint" style={{ marginTop: 6 }}>
            开始前请先在上方粘贴稿件正文（或上传 Word/PDF 自动填入），才能按目标期刊重排。
          </p>
        )}
      </div>
      {/* 投稿包放在左列, 与稿件输入相关的所有控制在一处 */}
      <h2 className="section-title">🚀 投稿包（投稿就绪检查 + 投稿信）</h2>
      <p className="section-hint">
        基于上面的稿件与目标期刊：一键做<strong>投稿就绪检查</strong>（必需章节/字数/参考文献/必备声明/图表，
        本地规则即时判断、不消耗 AI 额度），并自动生成<strong>投稿信（Cover Letter）</strong>。
      </p>
      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={runReadiness}
          disabled={!manuscript.trim() || !journalId || readinessBusy}
          data-testid="precheck-btn"
        >
          {readinessBusy ? "检查中…" : "投稿就绪检查"}
        </button>
        <button
          className="btn-secondary"
          onClick={runCover}
          disabled={!manuscript.trim() || !journalId || cover.running}
          data-testid="cover-btn"
        >
          {cover.running ? "生成中…" : "生成投稿信"}
        </button>
      </div>
      {readinessErr && <div className="result-error" data-testid="readiness-error">{readinessErr}</div>}
      {readiness?.items && (
        <div className="result-panel" data-testid="readiness">
          <h3 className="section-title" data-testid="precheck-title">✅ 投稿就绪检查</h3>
          <div className="result-toolbar">
            <span className="result-status">
              ✅ 通过 {readiness.summary?.pass ?? 0}
              {" "}· ⚠️ 注意 {readiness.summary?.warn ?? 0}
              {" "}· ❌ 缺失 {readiness.summary?.fail ?? 0}
            </span>
          </div>
          <ol className="ref-list" data-testid="readiness-list">
            {readiness.items.map((it) => {
              const b = READINESS_BADGE[it.status] || READINESS_BADGE.info;
              return (
                <li key={it.key}>
                  <span className={`ref-badge ${b.cls}`}>{b.label}</span>
                  {it.label}
                  {it.detail && <span className="ref-journal"> — {it.detail}</span>}
                  {it.suggestion && <span className="refcheck-note">{it.suggestion}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {(cover.text || cover.running || cover.error) && (
        <>
          <h3 className="section-title" data-testid="cover-title">✉️ 投稿信</h3>
          <ResultPanel
            text={cover.text}
            running={cover.running}
            error={cover.error}
            onStop={cover.stop}
            exportName="投稿信"
            placeholder="投稿信草稿会显示在这里。"
            onExportDocx={downloadCover}
            exportingDocx={coverDocxBusy}
            panelTestId="cover-panel"
          />
        </>
      )}
      </>
      )}

      {activeTab === "preview" && (
      <>
      {/* 预览顶部工具区: 折叠的参考文献勾选表 + 下载 / LaTeX / Overleaf */}
      <div className="format-preview-toolbar">
        {/* 附上参考文献: 默认折叠, summary 只显示数目 */}
        {fmtRefs.length > 0 ? (
          <details className="format-attach-refs" data-testid="format-attach-refs">
            <summary className="adv-summary">
              <span className="adv-summary-main">📎 附上已排版的参考文献（已勾选 {selectedFmtIdxs.length} / {fmtRefs.length} 篇）</span>
            </summary>
            <div className="adv-body">
              <div className="format-attach-toolbar">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setSelectedFmtIdxs(fmtRefs.map((_, i) => i))} disabled={selectedFmtIdxs.length === fmtRefs.length}>
                  全选
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setSelectedFmtIdxs([])} disabled={!selectedFmtIdxs.length}>
                  全不选
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setActiveTab("refs")}>
                  去「参考文献」页编辑
                </button>
              </div>
              <ol className="format-attach-list">
                {fmtRefs.map((r, i) => {
                  const checked = selectedFmtIdxs.includes(i);
                  return (
                    <li key={i}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setSelectedFmtIdxs((prev) => checked ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b))}
                        />
                        <span>{r}</span>
                      </label>
                    </li>
                  );
                })}
              </ol>
            </div>
          </details>
        ) : (
          <div className="field-hint" data-testid="format-refs-note">
            📎 下载的 Word / LaTeX <strong>暂不含参考文献</strong>——请到「参考文献」页点「按该期刊格式化参考文献」后再回来。
          </div>
        )}

        <div className="format-preview-actions">
          <button className="btn-secondary" onClick={downloadDocx} disabled={!text || running || downloading} data-testid="download-btn">
            {downloading ? "正在生成…" : selectedFmtIdxs.length ? `⬇ 下载 Word（附 ${selectedFmtIdxs.length} 条参考文献）` : "⬇ 下载 Word"}
          </button>
          <button className="btn-secondary" onClick={exportLatex} disabled={!text || running || latexBusy} data-testid="latex-btn">
            {latexBusy ? "生成中…" : "📐 生成 LaTeX 工程"}
          </button>
          {latexZip && (
            <>
              <button className="btn-secondary" onClick={() => downloadBase64("manuscript-latex.zip", latexZip, "application/zip")} data-testid="latex-download-btn">
                ⬇ 下载 LaTeX (zip)
              </button>
              <button className="btn-primary" onClick={() => openInOverleaf(latexZip)} data-testid="overleaf-btn">
                ↗ 在 Overleaf 打开
              </button>
            </>
          )}
          <button className="btn-ghost" onClick={() => setActiveTab("manuscript")} data-testid="back-to-input-btn">
            ← 返回编辑
          </button>
        </div>
        {dlErr && <div className="result-error" data-testid="dl-error">{dlErr}</div>}
      </div>

      {/* 排版稿预览: 独立的可滚动容器 */}
      <div className="format-preview-scroll" data-testid="format-preview-scroll">
        <ResultPanel
          text={text}
          running={running}
          error={error}
          onStop={stop}
          exportName="排版稿"
          placeholder="点「按该期刊排版」后重排后的稿件会显示在这里，并附上格式变更说明。"
          hideMdActions
        />
      </div>

      {latexCompiler && latexZip && (
        <div
          data-testid="latex-compiler-hint"
          style={{
            marginTop: 10,
            padding: "12px 16px",
            borderLeft: "5px solid #f59e0b",
            background: "#fffbeb",
            borderRadius: 6,
            fontSize: "1.05rem",
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "1.15rem", color: "#92400e" }}>
            ⚠️ Overleaf 编译器请选：
            <code
              style={{
                padding: "3px 10px",
                background: "#fde68a",
                borderRadius: 4,
                marginLeft: 8,
                fontSize: "1.2rem",
                fontWeight: 800,
                color: "#7c2d12",
                border: "1px solid #f59e0b",
              }}
            >
              {latexCompiler === "xelatex" ? "XeLaTeX" : latexCompiler === "lualatex" ? "LuaLaTeX" : "pdfLaTeX"}
            </code>
          </div>
          <div style={{ marginTop: 6, fontWeight: 600, color: "#78350f" }}>
            切换路径：Overleaf 项目左上「Menu」→「Compiler」下拉。
          </div>
          {latexCompiler === "xelatex" && (
            <div style={{ marginTop: 4, fontWeight: 700, color: "#b91c1c" }}>
              ‼️ 稿件含中文或需要 fontspec，<u>必须</u>用 XeLaTeX，否则会中文乱码或字体报错。
            </div>
          )}
        </div>
      )}
      {latexWarnings.length > 0 && !latexZip && (
        <div className="field-hint" data-testid="latex-precheck" style={{ marginTop: 6 }}>
          <strong>LaTeX 预检提示：</strong>
          <ul style={{ margin: "4px 0 0 20px", padding: 0 }}>
            {latexWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {latexErr && <div className="result-error" data-testid="latex-error">{latexErr}</div>}
      {latexNote && <div className="field-hint" data-testid="latex-note">{latexNote}</div>}
      </>
      )}

      {activeTab === "refs" && (
      <>
      <h2 className="section-title">参考文献格式化</h2>
      <p className="section-hint">
        粘贴你的参考文献，按所选期刊的引用规范（如 Vancouver、GB/T 7714、IEEE 等）自动排好。
        采用标准 CSL 引用引擎渲染，格式准确。
      </p>
      {handoffToast && (
        <div className="format-handoff-toast">{handoffToast}</div>
      )}
      {importedRefs.length > 0 && (
        <details className="format-structured-refs" data-testid="format-structured-refs">
          <summary className="adv-summary">
            <span className="adv-summary-main">📚 带入的参考文献（{importedRefs.length} 篇；已勾选 {structuredCheckedRefs().length} 条）</span>
            <span className="adv-summary-sub">从「找选题 / 写标书」带入或从 Zotero / 文件导入；勾选后直接作为格式化/核验/推送的输入</span>
          </summary>
          <div className="adv-body">
            <LiteraturePicker
              refs={importedRefs}
              evidenceByKey={{}}
              selectedKeys={structuredSelectedKeys}
              onSelectionChange={setStructuredSelectedKeys}
              mode="list"
              showEvidence={false}
              onImport={(imported) => {
                // 合并到 importedRefs (按 pickerKey 去重; 有摘要时升级)。期刊排版不做 evidence 抽取。
                const keyMap = new Map(importedRefs.map((r) => [pickerKey(r), r]));
                for (const imp of imported) {
                  const k = pickerKey(imp);
                  const existing = keyMap.get(k);
                  if (!existing) keyMap.set(k, imp);
                  else if (!existing.abstract && imp.abstract) keyMap.set(k, { ...existing, ...imp, abstract: imp.abstract });
                }
                setImportedRefs(Array.from(keyMap.values()));
                // 新导入的条目默认勾上, 与 handoff 行为一致。
                setStructuredSelectedKeys((prev) => {
                  const s = new Set(prev);
                  for (const r of imported) s.add(pickerKey(r));
                  return Array.from(s);
                });
              }}
              exportFilename="format-refs"
              showZotero={true}
            />
          </div>
        </details>
      )}
      <div className="form">
        <label className="field">
          <span className="field-label">参考文献（每条一行，或整段粘贴；无结构化文献时直接用此输入）</span>
          <textarea
            data-testid="input-refs"
            value={refsInput}
            onChange={(e) => setRefsInput(e.target.value)}
            placeholder="例如：Cortes J, et al. Pembrolizumab plus chemotherapy ... Lancet 2020;396(10265):1817-1828."
            rows={5}
          />
        </label>
        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={formatRefs}
            disabled={(!refsInput.trim() && !structuredCheckedRefs().length) || refsBusy}
            data-testid="format-refs-btn"
          >
            {refsBusy ? "格式化中…" : "按该期刊格式化参考文献"}
          </button>
          <button
            className="btn-secondary"
            onClick={checkRefs}
            disabled={(!refsInput.trim() && !structuredCheckedRefs().length) || checkBusy}
            data-testid="check-refs-btn"
          >
            {checkBusy ? "核验中…" : "核验真实性 / 撤稿 / 去重"}
          </button>
        </div>
      </div>

      {checkErr && (
        <div className="result-error" data-testid="refcheck-error">
          {checkErr}
        </div>
      )}

      {checkResult.length > 0 && (
        <div className="result-panel" data-testid="refcheck">
          <div className="result-toolbar">
            <span className="result-status">
              核验 {checkResult.length} 条 ·
              {" "}真实 {checkResult.filter((x) => x.status === "real" && !x.duplicate_of).length}
              {" "}/ 问题 {checkResult.filter((x) => x.status === "not_found" || x.status === "retracted" || x.duplicate_of).length}
            </span>
          </div>
          <ol className="ref-list" data-testid="refcheck-list">
            {checkResult.map((it, i) => {
              const b = it.duplicate_of
                ? { label: `⧉ 与第${it.duplicate_of}条重复`, cls: "rc-gray" }
                : REFCHECK_BADGE[it.status] || REFCHECK_BADGE.unverifiable;
              return (
                <li key={i}>
                  <span className={`ref-badge ${b.cls}`}>{b.label}</span>
                  {it.title || it.raw}
                  {it.doi && <span className="ref-journal"> — {it.doi}</span>}
                  {it.note && <span className="refcheck-note">{it.note}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {refsErr && (
        <div className="result-error" data-testid="refs-error">
          {refsErr}
        </div>
      )}

      {fmtRefs.length > 0 && (
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">已格式化 {fmtRefs.length} 条</span>
            <button
              className="btn-ghost"
              data-testid="copy-refs-btn"
              onClick={() => copyToClipboard(fmtRefs.join("\n"))}
            >
              复制全部
            </button>
          </div>
          <div className="fmt-refs" data-testid="fmt-refs">
            {fmtRefs.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
