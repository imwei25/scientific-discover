import { useEffect, useRef, useState } from "react";
import { streamIdea, streamIdeaFollowup, runModule, clarifyTopic, refineTopic, Reference, Trial, EvidenceItem, Verification, RewritePayload, TopicCard, ClarifyQuestion, RefineOption } from "../lib/sse";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import Markdown from "../components/Markdown";
import EditableMarkdown from "../components/EditableMarkdown";
import { CanvasSlot } from "../components/Canvas";
import Dropzone from "../components/Dropzone";
import { HelpButton } from "../components/HelpButton";
import RefIO from "../components/RefIO";
import { downloadText, downloadCsv, downloadDocxFromText, tsName } from "../lib/download";
import { usePersistentState } from "../lib/usePersistentState";
import type { Goto } from "../App";

// 合并导入的 references 到现有列表, 按 DOI 优先去重, 缺 DOI 则按 (title|year) 兜底。
// 返回 [合并后列表, 实际新增数, 跳过的重复数]
function mergeRefs(existing: Reference[], incoming: Reference[]): { merged: Reference[]; added: number; dup: number } {
  const norm = (s: string) => (s || "").trim().toLowerCase();
  const keyOf = (r: Reference) => {
    const doi = norm(r.pmid && r.pmid.startsWith("10.") ? r.pmid : "");
    if (doi) return `doi:${doi}`;
    // pmid 也作为强键
    if (r.pmid) return `pmid:${norm(r.pmid)}`;
    return `tit:${norm(r.title)}|${norm(r.year)}`;
  };
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  let added = 0;
  let dup = 0;
  for (const r of incoming) {
    if (!r || (!r.title && !r.pmid)) { dup += 1; continue; }
    const k = keyOf(r);
    if (seen.has(k)) { dup += 1; continue; }
    seen.add(k);
    merged.push(r);
    added += 1;
  }
  return { merged, added, dup };
}

const PAPER_SOURCES: { key: string; label: string; hint: string }[] = [
  { key: "pubmed", label: "PubMed", hint: "NCBI 权威医学库" },
  { key: "europepmc", label: "Europe PMC", hint: "含 bioRxiv/medRxiv 预印本" },
  { key: "openalex", label: "OpenAlex", hint: "覆盖最广 + 被引数" },
  { key: "crossref", label: "Crossref", hint: "跨学科 DOI + 被引数" },
];
const TRIAL_SOURCE = { key: "clinicaltrials", label: "ClinicalTrials.gov", hint: "在研临床试验（旁路）" };
// Unpaywall 不是检索源, 而是给结果补"合法免费全文(OA)"链接的富集开关。
const OA_SOURCE = { key: "unpaywall", label: "免费全文", hint: "Unpaywall 找 OA 全文（需配置邮箱）" };
const STUDY_TYPES: { key: string; label: string }[] = [
  { key: "rct", label: "随机对照试验" },
  { key: "meta", label: "Meta 分析" },
  { key: "systematic", label: "系统综述" },
  { key: "review", label: "综述" },
];

const Q_RANK: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };

// 取影响力数值; 未知/缺失返回 -1(用于排序沉底与过滤判定)。
function impactOf(r: Reference): number {
  return typeof r.journal_impact === "number" ? r.journal_impact : -1;
}
// 取分区档位 1..4; 未知返回 99(排序沉底、分区过滤时不达标)。
function quartileRank(r: Reference): number {
  return r.journal_quartile ? Q_RANK[r.journal_quartile] ?? 99 : 99;
}
// 文献列表排序: 相关性(原序) / 被引 / 年份 / 影响力 / 分区
function sortRefs(refs: Reference[], by: string): Reference[] {
  if (by === "cited") return [...refs].sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0));
  if (by === "year") return [...refs].sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
  if (by === "impact") return [...refs].sort((a, b) => impactOf(b) - impactOf(a));
  if (by === "quartile")
    return [...refs].sort((a, b) => quartileRank(a) - quartileRank(b) || impactOf(b) - impactOf(a));
  return refs;
}

// 从整篇调研报告里只截取【研究现状 + 研究空白】部分, 砍掉"候选选题(各方向)/首选推荐"。
// 理由: 从某个具体方向进标书时, 报告里其它候选方向对写"这一份"标书是噪声(还白占截断额度);
// 有用的是现状/空白(标书立项依据要综述的共享背景), 选中的方向另由 grant:idea 传入。
// 找不到"候选选题"标题(格式漂移)时原样返回整篇, 保证不误删。
function reportBackgroundOnly(full: string): string {
  const m = full.match(/(^|\n)#{1,6}[^\n]*候选选题/);
  if (!m || m.index == null) return full;
  const cut = full.slice(0, m.index).trimEnd();
  // 安全兜底: 若截得近乎为空(如报告没有现状/空白、开头就是候选选题), 宁可返回整篇。
  return cut.length >= 20 ? cut : full;
}

// 从候选方向正文里挑出【被它引用到的那几篇】文献(按正文 Markdown 链接的 URL/PMID 匹配)。
// 用于"用此方向写标书"时只带入与该方向直接相关的文献, 而不是把整池 40 篇全塞进去;
// 标书里需要更多文献时, 由标书模块的"逐节重写·重新检索"另行深度补检。
function refsCitedIn(body: string, all: Reference[]): Reference[] {
  const strip = (u: string) => u.replace(/\/+$/, "");
  const urls = new Set<string>();
  const re = /\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) urls.add(strip(m[1]));
  if (urls.size === 0) return [];
  return all.filter((r) => {
    const u = strip(r.url || "");
    if (u && urls.has(u)) return true;
    // PMID 兜底: 正文链接末段 == pmid(兼容 URL 尾斜杠差异)
    if (r.pmid) {
      for (const cu of urls) if (cu.endsWith("/" + r.pmid)) return true;
    }
    return false;
  });
}


export default function IdeaModule({ goto }: { goto: Goto }) {
  const [field, setField] = usePersistentState("idea:field", "");
  const [keywords, setKeywords] = usePersistentState("idea:keywords", "");
  const [background, setBackground] = usePersistentState("idea:background", "");
  const [depth, setDepth] = usePersistentState("idea:depth", "deep");
  const [sources, setSources] = usePersistentState<string[]>("idea:sources", [
    "pubmed",
    "europepmc",
    "openalex",
    "crossref",
    "clinicaltrials",
    "unpaywall",
  ]);
  const [yearFrom, setYearFrom] = usePersistentState("idea:yearFrom", "");
  const [studyTypes, setStudyTypes] = usePersistentState<string[]>(
    "idea:studyTypes",
    STUDY_TYPES.map((s) => s.key),
  );

  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false); // 复制报告到剪贴板的短暂反馈
  const [refs, setRefs] = usePersistentState<Reference[]>("idea:refs", []);
  const [refSort, setRefSort] = usePersistentState("idea:refSort", "relevance");
  // 影响力过滤: 阈值(空=不过滤) / 至少保留篇数 / 是否保留无影响力数据的文献
  // 质量预筛(高级检索设置内, 检索时生效): 默认不筛选(空=不限, 保留未知)。
  const [impactMin, setImpactMin] = usePersistentState("idea:impactMin", "");
  const [minQuartile, setMinQuartile] = usePersistentState("idea:minQuartile", ""); // ""=不限, "1".."4"=最低到 Qn
  const [keepUnknownImpact, setKeepUnknownImpact] = usePersistentState("idea:keepUnknownImpact", true);
  const [trials, setTrials] = usePersistentState<Trial[]>("idea:trials", []);
  const [evidence, setEvidence] = usePersistentState<EvidenceItem[]>("idea:evidence", []);
  const [text, setText] = usePersistentState("idea:result", "");
  const [verify, setVerify] = usePersistentState<Verification | null>("idea:verify", null);
  const [card, setCard] = usePersistentState<TopicCard | null>("idea:card", null);
  // 折叠报告: 让下方"选题卡"更突出(每次新检索重置为展开)。
  const [reportCollapsed, setReportCollapsed] = useState(false);
  const [wordBusy, setWordBusy] = useState(false); // 导出 Word 进行中
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState<RewritePayload | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // 检索前澄清: 方向不够具体时弹出问题卡, 用户可带着回答检索或直接检索
  const [clarifyQs, setClarifyQs] = useState<ClarifyQuestion[] | null>(null);
  const [clarifyAns, setClarifyAns] = useState<Record<number, string>>({});
  const [clarifying, setClarifying] = useState(false);

  // 澄清回答后的「方向优化」: AI 给几个研究方向/关键词候选, 用户选一个再检索
  const [refineOpts, setRefineOpts] = useState<RefineOption[] | null>(null);
  const [refining, setRefining] = useState(false);
  const [pendingBg, setPendingBg] = useState("");

  // 追问 / 修改报告
  const [followups, setFollowups] = usePersistentState<{ q: string; a: string }[]>("idea:qa", []);
  const [followupInput, setFollowupInput] = useState("");
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [fRunning, setFRunning] = useState(false);
  const [fError, setFError] = useState<string | null>(null);
  const fctrl = useRef<AbortController | null>(null);

  const savedRef = useRef("");
  useEffect(() => {
    if (!running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "idea",
        icon: "💡",
        title: field || "选题调研",
        data: {
          "idea:field": field,
          "idea:keywords": keywords,
          "idea:background": background,
          "idea:result": text,
          "idea:refs": refs,
          "idea:trials": trials,
          "idea:evidence": evidence,
          "idea:qa": followups,
          "idea:verify": verify,
          "idea:card": card,
        },
      });
    }
  }, [running, error, text, field, keywords, background, refs, verify]);

  const submit = async (override?: { field?: string; keywords?: string; background?: string }) => {
    const f = override?.field ?? field;
    const k = override?.keywords ?? keywords;
    const b = override?.background ?? background;
    if (!f.trim() || running) return;
    // 避免与进行中的 追问/PICO 流交叉写入
    fctrl.current?.abort();
    picoCtrl.current?.abort();
    setFRunning(false);
    setPicoRunning(false);
    setClarifyQs(null);
    setRefineOpts(null);
    setStatus("");
    setRefs([]);
    setTrials([]);
    setEvidence([]);
    setText("");
    setVerify(null);
    setCard(null);
    setReportCollapsed(false);
    setError(null);
    setRewrite(null);
    setFollowups([]);
    setCurrentAnswer("");
    setFError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    await streamIdea(
      {
        field: f,
        keywords: k,
        background: b,
        depth,
        sources,
        filters: {
          year_from: yearFrom,
          study_types: studyTypes,
          min_quartile: minQuartile,
          min_impact: impactMin,
          keep_unknown: keepUnknownImpact,
        },
      },
      {
        signal: ctrl.current.signal,
        onStatus: setStatus,
        onReferences: setRefs,
        onTrials: setTrials,
        onEvidence: setEvidence,
        onDelta: (t) => setText((p) => p + t),
        onVerify: setVerify,
        onRewriteSuggestion: setRewrite,
        onTopicCard: setCard,
        onError: (m) => {
          setError(m);
          setStatus("");
          setRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
          reportLLMError(m);
        },
        onDone: () => {
          setStatus("");
          setRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRunning(false);
  };

  // 点「开始」先做一次廉价澄清: 方向够具体→直接检索; 不够→弹问题卡(可跳过)。
  const onStart = async () => {
    if (!field.trim() || running || noPaperSource || clarifying) return;
    setClarifyQs(null);
    setClarifying(true);
    setStatus("正在为你聚焦研究方向…"); // 复用 status-line 给出「在动」的反馈
    try {
      const res = await clarifyTopic({ field, keywords, background });
      if (res.ready || res.questions.length === 0) {
        submit(); // 方向够具体 → 直接检索(submit 接管 status)
      } else {
        setStatus(""); // 弹澄清卡, 收起 spinner
        setClarifyAns({});
        setClarifyQs(res.questions);
      }
    } catch {
      // 澄清只是可跳过的增强步骤: 失败不锁死入口, 回退到直接检索(错误由 submit 的 onError 呈现)
      setStatus("");
      submit();
    } finally {
      setClarifying(false);
    }
  };

  // 把澄清回答拼进背景, 再让 AI 给方向优化候选(选一个再检索)。
  const goRefine = async () => {
    if (!clarifyQs) return;
    const lines = clarifyQs
      .map((q, i) => {
        const a = (clarifyAns[i] || "").trim();
        return a ? `${q.q} ${a}` : "";
      })
      .filter(Boolean);
    const composed = lines.length
      ? (background ? background + "\n\n" : "") + "[检索前澄清]\n" + lines.join("\n")
      : background;
    // 注意: 只把澄清回答拼进 composed 发给后端(经 pendingBg / refineTopic),
    // 不写回可见的「已有研究/相关资料」输入框, 否则会污染用户原始输入。
    setPendingBg(composed);
    setClarifyQs(null);
    setRefining(true);
    setStatus("正在优化研究方向…");
    try {
      const res = await refineTopic({ field, keywords, background: composed });
      if (res.options.length === 0) {
        submit({ background: composed }); // 没有优化建议 → 直接检索
      } else {
        setStatus("");
        setRefineOpts(res.options);
      }
    } catch {
      // 优化失败不锁死: 直接用已拼好的背景检索
      setStatus("");
      submit({ background: composed });
    } finally {
      setRefining(false);
    }
  };

  // 采纳某个优化候选: 替换方向/关键词后检索。
  const acceptRefine = (o: RefineOption) => {
    setField(o.field);
    setKeywords(o.keywords);
    setRefineOpts(null);
    submit({ field: o.field, keywords: o.keywords, background: pendingBg });
  };

  // 保持原方向(带上澄清回答)直接检索。
  const keepOriginal = () => {
    setRefineOpts(null);
    submit({ background: pendingBg });
  };

  const skipClarify = () => {
    setClarifyQs(null);
    submit();
  };

  const acceptRewrite = () => {
    if (!rewrite?.suggestion) return;
    const next = rewrite.suggestion;
    setField(next.field);
    setKeywords(next.keywords);
    setRewrite(null);
    setError(null);
    submit({ field: next.field, keywords: next.keywords });
  };

  const dismissRewrite = () => {
    setRewrite(null);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
    setStatus(""); // 同时清掉状态行, 否则 spinner 会一直转
  };

  const runFollowup = async (mode: "ask" | "revise") => {
    const q = followupInput.trim();
    if (!q || fRunning || running) return;
    setFError(null);
    setFRunning(true);
    fctrl.current = new AbortController();
    const baseReport = text; // revise 以当前报告为基准
    let buf = "";
    if (mode === "ask") setCurrentAnswer("…");
    else setText(""); // revise: 流式重写报告
    await streamIdeaFollowup(
      { mode, question: q, report: baseReport, references: refs, evidence },
      {
        signal: fctrl.current.signal,
        onDelta: (t) => {
          buf += t;
          if (mode === "ask") setCurrentAnswer(buf);
          else setText((p) => p + t);
        },
        onVerify: (v) => {
          if (mode === "revise") setVerify(v);
        },
        onError: (m) => {
          setFError(m);
          setFRunning(false);
          if (mode === "revise") setText(baseReport); // 修改失败则回滚
          reportLLMError(m);
        },
        onDone: () => {
          if (mode === "ask") {
            setFollowups((prev) => [...prev, { q, a: buf }]);
            setCurrentAnswer("");
          }
          setFollowupInput("");
          setFRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setFRunning(false);
  };

  // PICO / 纳排标准提取
  const [pico, setPico] = usePersistentState("idea:pico", "");
  const [picoRunning, setPicoRunning] = useState(false);
  const [picoErr, setPicoErr] = useState<string | null>(null);
  const picoCtrl = useRef<AbortController | null>(null);

  const genPico = async () => {
    if (!field.trim() || picoRunning) return;
    setPico("");
    setPicoErr(null);
    setPicoRunning(true);
    picoCtrl.current = new AbortController();
    await runModule(
      "pico",
      { field, keywords, background },
      {
        signal: picoCtrl.current.signal,
        onDelta: (t) => setPico((p) => p + t),
        onError: (m) => {
          setPicoErr(m);
          setPicoRunning(false);
          reportLLMError(m);
        },
        onDone: () => {
          setPicoRunning(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setPicoRunning(false);
  };

  const toggleSource = (key: string) => {
    setSources((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };
  const toggleStudyType = (key: string) => {
    setStudyTypes((prev) => (prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]));
  };
  // 至少要选一个论文源, 否则无文献可综述。
  const noPaperSource = !PAPER_SOURCES.some((s) => sources.includes(s.key));

  // 质量筛选已在检索时(高级检索设置)完成; 列表仅按所选规则排序展示。
  const shownRefs = sortRefs(refs, refSort);

  const reset = () => {
    if (running) stop();
    fctrl.current?.abort();
    picoCtrl.current?.abort();
    setPico("");
    setFollowups([]);
    setCurrentAnswer("");
    setFollowupInput("");
    setFError(null);
    setField("");
    setKeywords("");
    setBackground("");
    setRefs([]);
    setTrials([]);
    setEvidence([]);
    setText("");
    setVerify(null);
    setCard(null);
    setClarifyQs(null);
    setRefineOpts(null);
    setStatus("");
    setError(null);
    setRewrite(null);
  };

  return (
    <div className="module">
      <header className="module-head">
        <h1>💡 找选题 · 医学/药学/生物</h1>
        <p>
          我会实际检索 <strong>PubMed / Europe PMC / OpenAlex / Crossref</strong> 多源真实文献（按相关性+被引+新近择优纳入），
          梳理该方向已有哪些工作、还缺什么，再给出有文献支撑的候选选题。文中引用均为可点击的文献链接，可选开启 Unpaywall 找免费全文。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">研究领域 / 方向 <em>必填</em></span>
          <input
            data-testid="input-field"
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="例如：PD-1 抑制剂在三阴性乳腺癌中的应用、肠道菌群与阿尔茨海默病"
          />
        </label>
        <label className="field">
          <span className="field-label">关键词（可选，建议英文，利于检索）</span>
          <input
            data-testid="input-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="逗号分隔，例如：immunotherapy, biomarker, resistance"
          />
        </label>
        <div className="field" data-testid="background-field">
          <span className="field-label">已有研究 / 相关资料（可选）</span>
          <p className="field-hint">
            可在此直接粘贴你<strong>之前的研究、综述、标书或草案</strong>，或把 Word / PDF / txt 文件拖到下方——
            都会作为背景，让 AI 更懂你的工作基础与限制条件。
          </p>
          <textarea
            data-testid="input-background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="例如：我们前期已发现 XX 与 YY 相关（把你之前的研究粘贴进来）；偏临床回顾性研究，可获取本院病理样本；不做动物实验"
            rows={4}
          />
          <Dropzone
            testId="upload-doc"
            accept=".docx,.pdf,.txt,.md"
            label="或拖入文件一起作为背景"
            hint="支持 Word / PDF / txt；解析后的文本会追加到上方输入框"
            mode="text"
            onText={(t, name) =>
              setBackground((prev) => (prev ? prev + "\n\n" : "") + `[附加文档：${name}]\n` + t)
            }
          />
        </div>
        <details className="adv-settings" data-testid="adv-settings">
          <summary className="adv-summary" data-testid="adv-settings-summary">
            <span className="adv-summary-main">⚙ 高级检索设置</span>
            <span className="adv-summary-sub">来源 · 深度 · 过滤 —— 默认已为你优选（深入 + 全部来源），一般无需改动</span>
          </summary>
          <div className="adv-body">
        <label className="field">
          <span className="field-label">调研深度</span>
          <select data-testid="input-depth" value={depth} onChange={(e) => setDepth(e.target.value)}>
            <option value="deep">深入（多子方向 + 空白补检索 + 空白矩阵，推荐）</option>
            <option value="fast">快速（单轮检索，省额度更快）</option>
          </select>
        </label>
        <div className="field" data-testid="source-selector">
          <span className="field-label">检索来源（可多选）</span>
          <div className="source-grid">
            {PAPER_SOURCES.map((s) => (
              <label key={s.key} className={`source-chip${sources.includes(s.key) ? " on" : ""}`}>
                <input
                  type="checkbox"
                  data-testid={`source-${s.key}`}
                  checked={sources.includes(s.key)}
                  onChange={() => toggleSource(s.key)}
                />
                <span className="source-name">{s.label}</span>
                <span className="source-hint">{s.hint}</span>
              </label>
            ))}
            <label className={`source-chip trial${sources.includes(TRIAL_SOURCE.key) ? " on" : ""}`}>
              <input
                type="checkbox"
                data-testid={`source-${TRIAL_SOURCE.key}`}
                checked={sources.includes(TRIAL_SOURCE.key)}
                onChange={() => toggleSource(TRIAL_SOURCE.key)}
              />
              <span className="source-name">{TRIAL_SOURCE.label}</span>
              <span className="source-hint">{TRIAL_SOURCE.hint}</span>
            </label>
            <label className={`source-chip oa${sources.includes(OA_SOURCE.key) ? " on" : ""}`}>
              <input
                type="checkbox"
                data-testid={`source-${OA_SOURCE.key}`}
                checked={sources.includes(OA_SOURCE.key)}
                onChange={() => toggleSource(OA_SOURCE.key)}
              />
              <span className="source-name">🔓 {OA_SOURCE.label}</span>
              <span className="source-hint">{OA_SOURCE.hint}</span>
            </label>
          </div>
          {noPaperSource && (
            <span className="source-warn" data-testid="source-warn">
              请至少选择一个论文源（PubMed / Europe PMC / OpenAlex / Crossref），否则没有文献可供综述。
            </span>
          )}
        </div>
        <div className="field" data-testid="filters">
          <span className="field-label">检索过滤（可选）</span>
          <div className="filter-row">
            <label className="filter-year">
              起始年份
              <select data-testid="filter-year" value={yearFrom} onChange={(e) => setYearFrom(e.target.value)}>
                <option value="">不限</option>
                <option value="2021">近 5 年</option>
                <option value="2019">近 7 年</option>
                <option value="2014">近 10 年</option>
              </select>
            </label>
            <div className="filter-types">
              <span className="filter-types-label">证据等级</span>
              {STUDY_TYPES.map((s) => (
                <label key={s.key} className={`type-chip${studyTypes.includes(s.key) ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    data-testid={`type-${s.key}`}
                    checked={studyTypes.includes(s.key)}
                    onChange={() => toggleStudyType(s.key)}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
          <span className="filter-hint">
            勾选后<strong>仅保留所勾的发表类型</strong>；想纳入队列/病例对照/横断面/机制等观察性或基础研究，
            请<strong>取消全部勾选（= 不限类型）</strong>。此过滤主要作用于 PubMed / Europe PMC，
            OpenAlex 仅能近似匹配综述、Crossref 不按类型过滤。
          </span>
        </div>
        <div className="field" data-testid="quality-filters">
          <span className="field-label">
            文献质量（检索时预筛，喂给 AI 前生效）
            <HelpButton helpKey="quartile" />
          </span>
          <div className="filter-row">
            <label className="filter-quartile-label" title="按 Scimago(SJR) 分区过滤; 仅医学期刊有分区数据">
              分区≥
              <select data-testid="filter-quartile" value={minQuartile} onChange={(e) => setMinQuartile(e.target.value)}>
                <option value="">不限</option>
                <option value="1">仅 Q1</option>
                <option value="2">Q1–Q2</option>
                <option value="3">Q1–Q3</option>
              </select>
            </label>
            <label title="滤掉影响力低于该值的文献(影响力指数=OpenAlex 近2年篇均被引, 非官方影响因子)">
              影响力≥
              <input
                type="number"
                min="0"
                step="0.5"
                placeholder="不限"
                data-testid="filter-impact"
                value={impactMin}
                onChange={(e) => setImpactMin(e.target.value)}
                style={{ width: "4.5em" }}
              />
            </label>
            <label className="type-chip" title="既无影响力也无分区数据的文献(如新刊/部分会议/中文刊/预印本)是否保留">
              <input
                type="checkbox"
                data-testid="filter-keep-unknown"
                checked={keepUnknownImpact}
                onChange={(e) => setKeepUnknownImpact(e.target.checked)}
              />
              保留无指标数据
            </label>
          </div>
          <span className="filter-hint">
            默认不筛选。设门槛后仅剔除“已知低于门槛”的期刊；高质量文献太少时会自动放宽并提示。
          </span>
        </div>
          </div>
        </details>
        <div className="form-actions">
          <button className="btn-primary" onClick={onStart} disabled={!field.trim() || running || noPaperSource || clarifying || refining} data-testid="run-btn">
            {clarifying ? "聚焦方向中…" : refining ? "优化方向中…" : running ? "调研中…" : "开始文献调研"}
          </button>
          <button className="btn-secondary" onClick={genPico} disabled={!field.trim() || picoRunning} data-testid="pico-btn">
            {picoRunning ? "提取中…" : "提取 PICO / 纳排标准"}
          </button>
          <HelpButton helpKey="pico" />
          <button className="btn-ghost" onClick={reset} data-testid="reset-btn">
            清空
          </button>
        </div>
      </div>

      {picoErr && <div className="result-error" data-testid="pico-error">{picoErr}</div>}
      {(pico || picoRunning) && (
        <details className="refs" open data-testid="pico-panel">
          <summary>🔬 PICO 与纳入/排除标准</summary>
          {picoRunning && (
            <div className="ref-toolbar">
              <button className="btn-ghost" data-testid="pico-stop-btn" onClick={() => { picoCtrl.current?.abort(); setPicoRunning(false); }}>停止</button>
            </div>
          )}
          <div className="result-text">
            {pico ? <Markdown>{pico}</Markdown> : <span className="result-placeholder">正在提取…</span>}
            {picoRunning && <span className="cursor-blink">▍</span>}
          </div>
        </details>
      )}

      {clarifyQs && !running && (
        <div className="clarify-card" data-testid="clarify-card">
          <div className="clarify-title">先聚焦一下方向（{clarifyQs.length} 个问题，可选答）</div>
          <p className="clarify-tip">方向较宽或较模糊时，回答下面问题能让检索更准；也可直接跳过。</p>
          {clarifyQs.map((q, i) => (
            <div key={i} className="clarify-q" data-testid={`clarify-q-${i}`}>
              <div className="clarify-q-text">{q.q}</div>
              {q.options.length > 0 && (
                <div className="clarify-opts">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className={`clarify-chip${clarifyAns[i] === o ? " on" : ""}`}
                      onClick={() => setClarifyAns((p) => ({ ...p, [i]: p[i] === o ? "" : o }))}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="clarify-input"
                data-testid={`clarify-input-${i}`}
                value={clarifyAns[i] ?? ""}
                onChange={(e) => setClarifyAns((p) => ({ ...p, [i]: e.target.value }))}
                placeholder="或自行填写…"
              />
            </div>
          ))}
          <div className="form-actions">
            <button className="btn-primary" data-testid="clarify-go-btn" onClick={goRefine} disabled={refining}>
              {refining ? "优化方向中…" : "下一步：AI 优化方向"}
            </button>
            <button className="btn-ghost" data-testid="clarify-skip-btn" onClick={skipClarify} disabled={refining}>
              直接检索
            </button>
          </div>
        </div>
      )}

      {refineOpts && !running && (
        <div className="refine-card" data-testid="refine-card">
          <div className="refine-title">AI 建议的方向优化（选一个采纳，或保持原方向）</div>
          <p className="refine-tip">基于你的方向与澄清回答，AI 给出更聚焦、更易检索的候选。引用与检索仍以真实文献为准。</p>
          <div className="refine-opts">
            {refineOpts.map((o, i) => (
              <div key={i} className="refine-opt" data-testid={`refine-opt-${i}`}>
                <div className="refine-opt-field">{o.field}</div>
                {o.keywords && <div className="refine-opt-kw">关键词：{o.keywords}</div>}
                {o.reason && <div className="refine-opt-reason">{o.reason}</div>}
                <button className="btn-primary" data-testid={`refine-pick-${i}`} onClick={() => acceptRefine(o)}>
                  采纳并检索
                </button>
              </div>
            ))}
          </div>
          <div className="form-actions">
            <button className="btn-ghost" data-testid="refine-keep-btn" onClick={keepOriginal}>
              保持我的原方向检索
            </button>
          </div>
        </div>
      )}

      {status && (
        <div className="status-line" data-testid="status-line">
          <span className="spinner" /> {status}
        </div>
      )}

      {rewrite && !running && (
        <div className="rewrite-suggest" data-testid="rewrite-suggest">
          <div className="rewrite-title">PubMed 零命中 · AI 改写建议</div>
          {rewrite.tried_queries.length > 0 && (
            <details className="rewrite-tried">
              <summary>本次实际跑过的检索式（{rewrite.tried_queries.length} 个，均零命中）</summary>
              <ul>
                {rewrite.tried_queries.map((q, i) => (
                  <li key={i}><code>{q}</code></li>
                ))}
              </ul>
            </details>
          )}
          {rewrite.suggestion ? (
            <>
              <div className="rewrite-row">
                <span className="rewrite-label">建议方向</span>
                <span className="rewrite-value" data-testid="rewrite-field">{rewrite.suggestion.field}</span>
              </div>
              <div className="rewrite-row">
                <span className="rewrite-label">建议关键词</span>
                <span className="rewrite-value" data-testid="rewrite-keywords">{rewrite.suggestion.keywords || "（无）"}</span>
              </div>
              {rewrite.suggestion.reason && (
                <div className="rewrite-row">
                  <span className="rewrite-label">为什么这样改</span>
                  <span className="rewrite-value">{rewrite.suggestion.reason}</span>
                </div>
              )}
              <div className="rewrite-actions">
                <button className="btn-primary" onClick={acceptRewrite} data-testid="rewrite-accept">
                  采纳并重试
                </button>
                <button className="btn-ghost" onClick={dismissRewrite} data-testid="rewrite-dismiss">
                  我自己改
                </button>
              </div>
            </>
          ) : (
            <div className="rewrite-row">AI 未能生成有效建议，请手动调整方向或关键词后重试。</div>
          )}
        </div>
      )}

      {error && (
        <div className="result-error" data-testid="result-error">
          {error}
        </div>
      )}

      <RefIO
        currentRefs={refs}
        exportFilename="找选题-文献"
        onImport={(imported) => {
          const { merged, added, dup } = mergeRefs(refs, imported);
          setRefs(merged);
          setStatus(`导入 ${added} 篇，去重 ${dup} 篇`);
          window.setTimeout(() => setStatus((s) => (s.startsWith("导入") ? "" : s)), 4000);
        }}
      />

      {refs.length > 0 && (
        <details className="refs" open data-testid="refs">
          <summary>检索到的文献（显示 {shownRefs.length} / 共 {refs.length} 篇，点击打开原文）</summary>
          <div className="ref-toolbar">
            <label>
              排序
              <select data-testid="ref-sort" value={refSort} onChange={(e) => setRefSort(e.target.value)}>
                <option value="relevance">相关性</option>
                <option value="cited">被引最多</option>
                <option value="year">最新</option>
                <option value="impact">影响力</option>
                <option value="quartile">分区</option>
              </select>
            </label>
            <span className="filter-hint">质量筛选请在上方「⚙ 高级检索设置 → 文献质量」中设置（检索时生效）。</span>
          </div>
          <ol className="ref-list">
            {shownRefs.map((r, i) => (
              <li key={r.pmid || r.url || i}>
                {r.source === "preprint" && <span className="ref-badge ref-badge-preprint">预印本</span>}
                {r.source === "europepmc" && <span className="ref-badge ref-badge-epmc">Europe PMC</span>}
                {r.source === "openalex" && <span className="ref-badge ref-badge-openalex">OpenAlex</span>}
                {r.source === "crossref" && <span className="ref-badge ref-badge-crossref">Crossref</span>}
                {r.journal_quartile && (
                  <span
                    className={`ref-badge ref-badge-q ref-badge-${r.journal_quartile.toLowerCase()}`}
                    title="Scimago 医学分区(SJR Best Quartile)"
                  >
                    {r.journal_quartile}
                  </span>
                )}
                {typeof r.journal_impact === "number" && (
                  <span className="ref-badge ref-badge-impact" title="影响力指数: OpenAlex 近2年篇均被引(非官方影响因子)">
                    影响力 {r.journal_impact.toFixed(1)}
                  </span>
                )}
                {(r.cited_by_count ?? 0) > 0 && (
                  <span className="ref-badge ref-badge-cited">被引 {r.cited_by_count}</span>
                )}
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.first_author} ({r.year}). {r.title}
                </a>
                {r.journal && <span className="ref-journal"> — {r.journal}</span>}
                {r.oa_url && (
                  <a className="ref-oa" href={r.oa_url} target="_blank" rel="noreferrer">🔓 免费全文</a>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}

      {trials.length > 0 && (
        <details className="refs trials" open data-testid="trials">
          <summary>🧪 相关在研临床试验（{trials.length} 项 · ClinicalTrials.gov，点击查看登记信息）</summary>
          <ol className="ref-list">
            {trials.map((t, i) => (
              <li key={t.nct_id || i}>
                {t.status && <span className="ref-badge ref-badge-trial">{t.status}</span>}
                {t.phase && <span className="ref-badge ref-badge-phase">{t.phase}</span>}
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.title}
                </a>
                {t.conditions && <span className="ref-journal"> — {t.conditions}</span>}
                <span className="trial-nct"> （{t.nct_id}{t.year ? `, ${t.year}` : ""}）</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {evidence.length > 0 && (
        <details className="refs evidence" data-testid="evidence">
          <summary>📋 证据表（{evidence.length} 篇 · 对象/设计/发现/局限，可导出）</summary>
          <div className="ref-toolbar">
            <button
              className="btn-ghost"
              data-testid="export-evidence-btn"
              onClick={() => {
                const headers = ["序号", "第一作者", "年份", "标题", "期刊", "来源", "被引", "研究对象", "设计/方法", "主要发现", "局限/空白", "链接", "免费全文"];
                const rows = evidence.map((e) => [
                  e.index, e.first_author, e.year, e.title, e.journal, e.source, e.cited_by_count,
                  e.pop, e.design, e.finding, e.gap, e.url, e.oa_url || "",
                ]);
                downloadCsv(tsName("证据表", "csv"), headers, rows);
              }}
            >
              导出 CSV
            </button>
          </div>
          <div className="md-table-wrap">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>#</th><th>文献</th><th>对象</th><th>设计</th><th>主要发现</th><th>局限/空白</th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((e) => (
                  <tr key={e.index}>
                    <td>{e.index}</td>
                    <td>
                      <a href={e.url} target="_blank" rel="noreferrer">
                        {e.first_author} ({e.year})
                      </a>
                    </td>
                    <td>{e.pop || "—"}</td>
                    <td>{e.design || "—"}</td>
                    <td>{e.finding || "—"}</td>
                    <td>{e.gap || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <CanvasSlot>
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "生成中…" : text ? "已完成" : "等待开始"}</span>
            <div className="result-actions">
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="stop-btn">
                  停止
                </button>
              )}
              {/* 折叠调研报告, 让下方选题卡更突出 */}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="toggle-report-btn"
                  onClick={() => setReportCollapsed((v) => !v)}
                  title={reportCollapsed ? "展开调研报告" : "折叠调研报告, 突出下方选题卡"}
                >
                  {reportCollapsed ? "展开报告 ▾" : "折叠报告 ▴"}
                </button>
              )}
              {/* 无结构化选题卡时, 提供整篇报告送规划的兜底入口; 有候选方向时改用每个方向后的按钮 */}
              {text && !running && (!card || card.candidates.length === 0) && (
                <button
                  className="btn-ghost"
                  data-testid="send-to-plan-btn"
                  onClick={() => goto("plan", { "plan:idea": text })}
                >
                  用此结果做实验规划 →
                </button>
              )}
              {/* 无结构化选题卡时, 提供整篇报告写标书的兜底入口; 有候选方向时改用每个方向后的按钮 */}
              {text && !running && (!card || card.candidates.length === 0) && (
                <button
                  className="btn-ghost"
                  data-testid="send-to-grant-btn"
                  onClick={() =>
                    goto("grant", {
                      "grant:title": (card?.field || field || "").trim(),
                      "grant:idea": "",
                      "grant:report": text,
                      "grant:background": background,
                      "grant:refs": refs,
                      "grant:phase": "idle",
                      "grant:scheme": null,
                      "grant:outline": [],
                      "grant:sections": [],
                      "grant:verify": null,
                    })
                  }
                >
                  用此结果写标书 →
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="copy-report-btn"
                  onClick={async () => {
                    const refMd = refs.length
                      ? "\n\n## 参考文献\n" +
                        refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
                      : "";
                    try {
                      await navigator.clipboard.writeText(text + refMd);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1800);
                    } catch {
                      setStatus("复制失败：浏览器未授权剪贴板，请手动选择复制");
                      window.setTimeout(() => setStatus((s) => (s.startsWith("复制失败") ? "" : s)), 4000);
                    }
                  }}
                  title="把调研报告（含参考文献）复制到剪贴板"
                >
                  {copied ? "已复制 ✓" : "复制"}
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-md-btn"
                  onClick={() => {
                    const refMd = refs.length
                      ? "\n\n## 参考文献\n" +
                        refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
                      : "";
                    downloadText(tsName("选题调研", "md"), text + refMd);
                  }}
                >
                  导出 Markdown
                </button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="export-docx-btn"
                  disabled={wordBusy}
                  onClick={async () => {
                    setWordBusy(true);
                    try {
                      const refMd = refs.length
                        ? "\n\n## 参考文献\n" +
                          refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
                        : "";
                      await downloadDocxFromText(tsName("选题调研", "docx"), text + refMd);
                    } catch (e) {
                      setStatus(`导出 Word 失败：${(e as Error).message}`);
                      window.setTimeout(() => setStatus((s) => (s.startsWith("导出 Word 失败") ? "" : s)), 5000);
                    } finally {
                      setWordBusy(false);
                    }
                  }}
                >
                  {wordBusy ? "导出中…" : "导出 Word"}
                </button>
              )}
            </div>
          </div>
          {reportCollapsed && text && !running && (
            <button
              className="report-collapsed-bar"
              data-testid="report-collapsed"
              onClick={() => setReportCollapsed(false)}
              title="点击展开调研报告"
            >
              📄 调研报告已折叠 —— 点此展开（下方为 AI 候选选题）
            </button>
          )}
          <div className={reportCollapsed && text && !running ? "report-body is-collapsed" : "report-body"}>
            <EditableMarkdown
              value={text}
              onSave={setText}
              running={running}
              placeholder={running ? "正在分析…" : "填好左侧信息后点击“开始文献调研”，调研报告会显示在这里。"}
              testId="result-text"
            />
          </div>
        </div>
      </CanvasSlot>

      {verify && !running && (
        verify.unverified.length === 0 ? (
          <div className="verify-ok" data-testid="verify">
            ✓ 引用核验：正文 {verify.total} 处文献引用均来自本次检索到的真实文献。
          </div>
        ) : (
          <div className="verify-bad" data-testid="verify">
            ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在检索结果中，可能不准确，请核实：
            {verify.unverified.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                {u}
              </a>
            ))}
          </div>
        )
      )}

      {/* 选题卡也送进右画布, 紧贴报告下方: 候选方向 + 每个方向的「做实验规划/写标书」按钮 */}
      <CanvasSlot>
      {card && card.candidates.length > 0 && !running && (
        <div className="topic-card" data-testid="topic-card">
          <div className="topic-card-head">🧭 选题卡 · AI 给出的候选方向，挑一个直接做实验规划或写标书</div>
          {card.facets.length > 0 && (
            <div className="topic-facets" data-testid="topic-facets">
              <span className="topic-facets-label">子方向：</span>
              {card.facets.map((f) => (
                <span key={f} className="facet-chip">{f}</span>
              ))}
            </div>
          )}
          <ol className="candidate-list" data-testid="candidate-list">
            {card.candidates.map((c, i) => (
              <li key={i} className="candidate-item" data-testid={`candidate-${i}`}>
                <div className="candidate-main">
                  <div className="candidate-title">
                    方向{c.n}：{c.title}
                    {c.feasibility != null && (
                      <span className="candidate-scores">可行★{c.feasibility}｜创新★{c.innovation ?? "-"}</span>
                    )}
                  </div>
                  {c.body && <div className="candidate-body">{c.body}</div>}
                </div>
                <div className="candidate-actions">
                  <button
                    className="btn-primary candidate-to-plan"
                    data-testid={`candidate-to-plan-${i}`}
                    onClick={() =>
                      goto("plan", {
                        "plan:idea": `${c.title}\n\n${c.body}`,
                        "plan:field": card.field,
                        "plan:resources": background,
                      })
                    }
                  >
                    用此方向做实验规划 →
                  </button>
                  <button
                    className="btn-ghost candidate-to-grant"
                    data-testid={`candidate-to-grant-${i}`}
                    onClick={() => {
                      // 只带入该方向正文引用到的那几篇文献; 解析不到时才兜底全带。
                      const cited = refsCitedIn(c.body, refs);
                      goto("grant", {
                        "grant:title": c.title,
                        "grant:idea": `${c.title}\n\n${c.body}`,
                        // 只带研究现状+空白(共享背景); 砍掉其它竞争方向, 选中方向由 grant:idea 承载。
                        "grant:report": reportBackgroundOnly(text),
                        "grant:background": background,
                        "grant:refs": cited.length ? cited : refs,
                        "grant:phase": "idle",
                        "grant:scheme": null,
                        "grant:outline": [],
                        "grant:sections": [],
                        "grant:verify": null,
                      });
                    }}
                  >
                    用此方向写标书 →
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      </CanvasSlot>

      {text && !running && (
        <div className="followup" data-testid="followup">
          <div className="followup-head">追问 / 修改意见</div>
          <p className="followup-tip">
            可针对某篇文献或某条结论追问，或提出意见让 AI 修订报告。回答仍只基于本次检索到的真实文献。
          </p>
          {followups.length > 0 && (
            <div className="qa-list" data-testid="qa-list">
              {followups.map((qa, i) => (
                <div key={i} className="qa-item">
                  <div className="qa-q">❓ {qa.q}</div>
                  <div className="qa-a">
                    <Markdown>{qa.a}</Markdown>
                  </div>
                </div>
              ))}
            </div>
          )}
          {fRunning && currentAnswer && (
            <div className="qa-item">
              <div className="qa-a">
                <Markdown>{currentAnswer}</Markdown>
                <span className="cursor-blink">▍</span>
              </div>
            </div>
          )}
          <textarea
            data-testid="followup-input"
            value={followupInput}
            onChange={(e) => setFollowupInput(e.target.value)}
            placeholder="例如：第 3 篇的样本量是多少？/ 请把候选选题三改成偏机制研究 / 研究空白这部分再具体些"
            rows={2}
            disabled={fRunning}
          />
          {fError && <div className="result-error">{fError}</div>}
          <div className="form-actions">
            <button
              className="btn-primary"
              data-testid="ask-btn"
              onClick={() => runFollowup("ask")}
              disabled={!followupInput.trim() || fRunning}
            >
              追问
            </button>
            <button
              className="btn-ghost"
              data-testid="revise-btn"
              onClick={() => runFollowup("revise")}
              disabled={!followupInput.trim() || fRunning}
            >
              按此修改报告
            </button>
            {fRunning && (
              <button className="btn-ghost" data-testid="followup-stop-btn" onClick={() => { fctrl.current?.abort(); setFRunning(false); }}>
                停止
              </button>
            )}
            {fRunning && (
              <span className="status-line">
                <span className="spinner" /> 处理中…
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
