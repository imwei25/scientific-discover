import { useEffect, useMemo, useRef, useState } from "react";
import {
  streamGrant, planGrant, grantStyle, streamGrantRevise, streamGrantReview,
  Reference, Verification, GrantScheme, GrantOutlineItem,
  GrantReviewData, GrantReviewIssue,
} from "../lib/sse";
import Markdown, { CiteInfo, normCiteUrl } from "../components/Markdown";
import { reportLLMError } from "../lib/errorToast";
import { addHistory } from "../lib/history";
import EditableMarkdown from "../components/EditableMarkdown";
import RefineEditor from "../components/RefineEditor";
import { CanvasSlot } from "../components/Canvas";
import Dropzone from "../components/Dropzone";
import RefIO from "../components/RefIO";
import ZoteroPanel from "../components/ZoteroPanel";
import { HelpButton } from "../components/HelpButton";
import { usePersistentState } from "../lib/usePersistentState";
import { downloadText, downloadDocxFromText, tsName } from "../lib/download";
import { prepareForExport } from "../lib/exportPrep";

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

const GRANT_TYPES: { key: string; label: string }[] = [
  { key: "general", label: "国家自然科学基金·面上项目" },
  { key: "youth", label: "国家自然科学基金·青年科学基金" },
  { key: "regional", label: "国家自然科学基金·地区科学基金" },
  { key: "general_other", label: "通用申请书（省部级/校级/横向等）" },
];

// 各资助类型对应的封面大标题(NSFC 三类共用同一标题, 仅"资助类别"不同; 通用类标题可变)。
const COVER_TITLE: Record<string, string> = {
  general: "国家自然科学基金申请书",
  youth: "国家自然科学基金申请书",
  regional: "国家自然科学基金申请书",
  general_other: "科研项目申请书",
};
// 封面"资助类别"栏取值。
const FUND_CATEGORY: Record<string, string> = {
  general: "面上项目",
  youth: "青年科学基金",
  regional: "地区科学基金",
  general_other: "通用申请书（省部级/校级/横向等）",
};

// 生成申请书封面(大标题 + 基本信息表)。作为导出时的文档抬头, 不进入屏幕编辑区。
// 无法由 AI 推断的字段(申请人/依托单位/未填的研究期限)统一留 [需申请人补充] 占位, 绝不杜撰。
function buildCover(opts: {
  grantType: string;
  projectName: string;
  periodStart: string;
  periodEnd: string;
}): string {
  const title = COVER_TITLE[opts.grantType] || "科研项目申请书";
  const category = FUND_CATEGORY[opts.grantType] || "通用申请书";
  const s = opts.periodStart.trim();
  const e = opts.periodEnd.trim();
  const period = s || e ? `${s || "____"} — ${e || "____"}` : "[需申请人补充]";
  const name = opts.projectName.trim() || "[需申请人补充]";
  return [
    `# ${title}`,
    "",
    `| **资助类别** | ${category} |`,
    "| --- | --- |",
    `| **项目名称** | ${name} |`,
    `| **研究期限** | ${period} |`,
    "| **申请人** | [需申请人补充] |",
    "| **依托单位** | [需申请人补充] |",
    "",
  ].join("\n");
}

// 写作中的章节: 标题用于 ## 大标题, text 为正文。review 节也用同结构存。
interface DocSection { key: string; title: string; text: string }
// 大纲项额外带 include 开关(用户可在确认阶段勾掉某节)。
type EditableOutline = GrantOutlineItem & { include: boolean };

const emptyScheme: GrantScheme = {
  title: "", question: "", hypothesis: "", goal: "", contents: [], innovations: [], route: "",
};

function fullDoc(sections: DocSection[]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.text}`).join("\n\n");
}

export default function GrantModule() {
  // 这些字段可由「找选题」一键带入(写入对应持久化键后切换过来)。
  const [title, setTitle] = usePersistentState("grant:title", "");
  const [idea, setIdea] = usePersistentState("grant:idea", "");
  const [report, setReport] = usePersistentState("grant:report", "");
  const [background, setBackground] = usePersistentState("grant:background", "");
  const [grantType, setGrantType] = usePersistentState("grant:type", "general");
  // 研究期限(起止, 如 2026.01 / 2028.12); 仅用于导出封面, 留空则封面填 [需申请人补充]。
  const [periodStart, setPeriodStart] = usePersistentState("grant:periodStart", "");
  const [periodEnd, setPeriodEnd] = usePersistentState("grant:periodEnd", "");
  const [refs, setRefs] = usePersistentState<Reference[]>("grant:refs", []);
  // 撰写前是否按方向重新检索文献并入池(默认开): 让立项依据据新鲜、针对本方向的文献来写。
  const [preResearch, setPreResearch] = usePersistentState<boolean>("grant:preResearch", true);

  // 文风样例: 上传样例原文 → 提炼文风档案(可编辑) → 撰写/去AI味时按开关注入。
  const [styleSample, setStyleSample] = usePersistentState("grant:styleSample", "");
  const [styleProfile, setStyleProfile] = usePersistentState("grant:styleProfile", "");
  const [styleOn, setStyleOn] = usePersistentState<boolean>("grant:styleOn", true);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleErr, setStyleErr] = useState("");

  // phase: idle(未开始) | planned(大纲待确认) | writing | done
  const [phase, setPhase] = usePersistentState<string>("grant:phase", "idle");
  const [scheme, setScheme] = usePersistentState<GrantScheme | null>("grant:scheme", null);
  const [outline, setOutline] = usePersistentState<EditableOutline[]>("grant:outline", []);
  const [sections, setSections] = usePersistentState<DocSection[]>("grant:sections", []);
  const [verify, setVerify] = usePersistentState<Verification | null>("grant:verify", null);
  // 评审组结构化结果: 摘要卡 + 「按评审意见修订」联动
  const [review, setReview] = usePersistentState<GrantReviewData | null>("grant:review", null);

  const [status, setStatus] = useState("");
  const [planning, setPlanning] = useState(false);
  const [outlineNote, setOutlineNote] = useState(""); // 大纲修改意见(交 AI 调整大纲)
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);
  const [docxErr, setDocxErr] = useState("");
  const ctrl = useRef<AbortController | null>(null);

  // 逐节重写
  const [reviseNote, setReviseNote] = useState<Record<string, string>>({});
  const [revisingKey, setRevisingKey] = useState<string | null>(null);
  const [reviseErr, setReviseErr] = useState<string | null>(null);
  const [reviseStatus, setReviseStatus] = useState("");
  const rctrl = useRef<AbortController | null>(null);
  // 重新评审 / 一键修订薄弱章节
  const [rereviewing, setRereviewing] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const rvctrl = useRef<AbortController | null>(null);

  const text = fullDoc(sections);

  // 封面(大标题 + 基本信息表): 屏幕 Canvas 顶部与导出抬头共用同一份, 不进入可编辑正文,
  // 让画布上也能看到申请书标题/项目名等信息, 而不是直接从第一章节开始。
  const coverMd = useMemo(
    () => buildCover({ grantType, projectName: scheme?.title || title, periodStart, periodEnd }),
    [grantType, scheme?.title, title, periodStart, periodEnd],
  );

  // 引用悬浮卡数据: 按 URL 索引文献题名, 悬停正文引用即可看 AI 标注的原文支持句。
  const citeInfo = useMemo(() => {
    const m: Record<string, CiteInfo> = {};
    for (const r of refs) {
      if (r.url) m[normCiteUrl(r.url)] = { label: `${r.first_author} (${r.year}). ${r.title}`.slice(0, 140) };
    }
    return m;
  }, [refs]);

  // 去 AI 味采纳/撤回: 正文由 fullDoc(sections) 拼成, 去AI味不动 `## 标题`,
  // 故按 `## ` 切回、按序写回各节正文(解析失败的节保持原样, 不破坏文档)。
  const applyDeai = (newDoc: string) => {
    const parts = newDoc.split(/\n(?=## )/);
    setSections((prev) =>
      prev.map((s, i) => {
        const p = parts[i];
        if (p === undefined) return s;
        const m = p.match(/^##\s+(.+?)\r?\n+([\s\S]*)$/);
        return m ? { ...s, title: m[1].trim(), text: m[2].trim() } : s;
      }),
    );
  };

  const savedRef = useRef("");
  useEffect(() => {
    if (phase === "done" && !running && !error && text && savedRef.current !== text) {
      savedRef.current = text;
      addHistory({
        module: "grant",
        icon: "📜",
        title: (scheme?.title || title || "标书初稿").slice(0, 40),
        data: {
          "grant:title": title, "grant:idea": idea, "grant:report": report,
          "grant:background": background, "grant:type": grantType,
          "grant:periodStart": periodStart, "grant:periodEnd": periodEnd, "grant:refs": refs,
          "grant:scheme": scheme, "grant:outline": outline, "grant:sections": sections,
          "grant:phase": "done", "grant:verify": verify, "grant:review": review,
        },
      });
    }
  }, [phase, running, error, text, title, scheme]);

  const hasInput = !!(title.trim() || report.trim());

  const [copied, setCopied] = useState(false); // 复制全文的短暂反馈

  // 生效的文风档案: 关掉开关或没档案时为空串(=不模仿, 维持现状)。
  const effStyle = styleOn ? styleProfile : "";

  const extractStyle = async () => {
    if (!styleSample.trim() || styleBusy) return;
    setStyleErr("");
    setStyleBusy(true);
    try {
      const { profile } = await grantStyle(styleSample);
      if (profile) setStyleProfile(profile);
      else setStyleErr("未能提炼出文风档案，请换一份更完整的样例或重试。");
    } catch {
      setStyleErr("提炼文风失败（网络或服务错误），请重试。");
    } finally {
      setStyleBusy(false);
    }
  };

  // —— 第一步: 生成可编辑大纲(两段式); 传 note 时只按意见调整大纲, 不动已确认的方案骨架 ——
  const genPlan = async (note?: string) => {
    if (!hasInput || planning || running) return;
    setError(null);
    setPlanning(true);
    setStatus(note ? "正在按修改意见调整大纲…" : "正在凝练研究方案与大纲…");
    try {
      const plan = await planGrant(
        note
          ? { title, idea, report, grant_type: grantType, outline_note: note, outline }
          : { title, idea, report, grant_type: grantType },
      );
      // planGrant 失败会静默返回空大纲: 视为失败, 不清空已有大纲、不进空的确认面板。
      if (!plan.outline || plan.outline.length === 0) {
        setError("生成大纲失败（网络或服务波动），已保留你现有的内容，请重试。");
        return;
      }
      if (note) {
        // 只更新大纲, 保留用户已编辑的方案骨架与阶段。
        setOutline(plan.outline.map((o) => ({ ...o, include: true })));
        setOutlineNote("");
      } else {
        setScheme({ ...emptyScheme, ...plan.scheme });
        setOutline(plan.outline.map((o) => ({ ...o, include: true })));
        setSections([]);
        setVerify(null);
        setPhase("planned");
      }
      window.dispatchEvent(new Event("usage-updated"));
    } catch {
      setError("生成大纲失败（网络或服务错误），已保留你现有的内容，请重试。");
    } finally {
      setStatus("");
      setPlanning(false);
    }
  };

  // —— 第二步(或一步到位): 撰写 ——
  // confirmed=true 时带上用户确认过的 scheme/sections; 否则让后端现凝练(跳过确认)。
  const startWrite = async (confirmed: boolean) => {
    if (!hasInput || running) return;
    setError(null);
    setSections([]);
    setVerify(null);
    setReview(null);
    setReviseErr(null);
    setPhase("writing");
    setRunning(true);
    ctrl.current = new AbortController();
    const payload: Record<string, unknown> = {
      title, idea, report, background, grant_type: grantType, references: refs,
      research: preResearch, // 撰写前是否按方向重检索文献(默认开)
      style_profile: effStyle,
    };
    if (confirmed) {
      if (scheme) payload.scheme = scheme;
      payload.sections = outline
        .filter((o) => o.include)
        .map((o) => ({ key: o.key, title: o.title, budget: o.budget }));
    }
    await streamGrant(payload, {
      signal: ctrl.current.signal,
      onStatus: setStatus,
      onScheme: (s) => setScheme(s),
      onOutline: (items) => setOutline(items.map((o) => ({ ...o, include: true }))),
      onReferences: (items) => setRefs(items), // 撰写前重检索扩充的文献池写回

      onSection: (key, secTitle) =>
        setSections((prev) => [...prev, { key, title: secTitle, text: "" }]),
      onDelta: (t) =>
        setSections((prev) => {
          if (!prev.length) return prev;
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, text: last.text + t };
          return next;
        }),
      onReviewData: setReview,
      onVerify: setVerify,
      onError: (m) => {
        setError(m);
        setStatus("");
        setRunning(false);
        setPhase("done");
        window.dispatchEvent(new Event("usage-updated"));
        reportLLMError(m);
      },
      onDone: () => {
        setStatus("");
        setRunning(false);
        setPhase("done");
        window.dispatchEvent(new Event("usage-updated"));
      },
    });
    setRunning(false);
  };

  const stop = () => {
    ctrl.current?.abort();
    setRunning(false);
    setPhase("done");
  };

  // —— 逐节重写 —— research=true 时先按新方向重新检索文献再写。返回是否成功(供批量修订串行)。
  const reviseSectionWith = async (sec: DocSection, note: string, research: boolean): Promise<boolean> => {
    if (!note.trim() || running) return false;
    setReviseErr(null);
    setRevisingKey(sec.key);
    rctrl.current = new AbortController();
    const budget = outline.find((o) => o.key === sec.key)?.budget || "";
    let buf = "";
    let ok = false;
    await streamGrantRevise(
      {
        title, report, background, grant_type: grantType, references: refs, scheme,
        section: { key: sec.key, title: sec.title, budget },
        current: sec.text,
        note: note.trim(),
        research,
        style_profile: effStyle,
      },
      {
        signal: rctrl.current.signal,
        onStatus: setReviseStatus,
        onReferences: (items) => setRefs(items), // 重新调研: 把扩充后的文献池写回
        onDelta: (t) => {
          buf += t;
          setSections((prev) => prev.map((s) => (s.key === sec.key ? { ...s, text: buf } : s)));
        },
        onVerify: setVerify,
        onError: (m) => {
          setReviseErr(`《${sec.title}》修改失败：${m}`);
          setRevisingKey(null);
          setReviseStatus("");
          reportLLMError(m);
        },
        onDone: () => {
          ok = true;
          setReviseNote((prev) => ({ ...prev, [sec.key]: "" }));
          setRevisingKey(null);
          setReviseStatus("");
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRevisingKey(null);
    return ok;
  };

  const reviseSection = (sec: DocSection, research: boolean) =>
    reviseSectionWith(sec, (reviseNote[sec.key] || "").trim(), research);

  // 评审组给某章节的问题清单(结构化 review_data 联动)。
  const issuesFor = (key: string): GrantReviewIssue[] =>
    review?.sections.find((s) => s.key === key)?.issues ?? [];

  // 把评审问题拼成"修改意见", 喂给逐节重写。
  const noteFromIssues = (issues: GrantReviewIssue[]) =>
    issues
      .map((i) => `${i.severity ? `【${i.severity}】` : ""}${i.problem}${i.advice ? `（建议：${i.advice}）` : ""}`)
      .join("\n")
      .slice(0, 1500);

  const anyBusy = running || !!revisingKey || rereviewing || batchBusy;

  // 评审认定的薄弱章节(均分 <8 且有问题), 供一键修订。
  const weakTargets = () => {
    if (!review) return [] as { sec: DocSection; note: string }[];
    const out: { sec: DocSection; note: string }[] = [];
    for (const rs of review.sections) {
      if (!rs.issues.length) continue;
      if (rs.score != null && rs.score >= 8) continue;
      const sec = sections.find((s) => s.key === rs.key && s.key !== "review");
      if (sec) out.push({ sec, note: noteFromIssues(rs.issues) });
    }
    return out;
  };

  // 一键按评审意见依次修订薄弱章节(串行, 出错即停)。改完建议点「重新评审」看改进。
  const batchRevise = async () => {
    if (anyBusy) return;
    const targets = weakTargets();
    if (!targets.length) return;
    setBatchBusy(true);
    setReviseErr(null);
    let done = 0;
    for (const t of targets) {
      setReviseStatus(`按评审意见修订薄弱章节（${done + 1}/${targets.length}）：《${t.sec.title}》…`);
      const ok = await reviseSectionWith(t.sec, t.note, false);
      if (!ok) break;
      done += 1;
    }
    setReviseStatus(done ? `已修订 ${done}/${targets.length} 个薄弱章节，建议点「重新评审」看看分数变化。` : "");
    setBatchBusy(false);
  };

  // 重新评审: 把当前全文(不含旧评审节)交回评审组重打分。
  const reReview = async () => {
    if (anyBusy) return;
    const body = sections
      .filter((s) => s.key !== "review" && s.text.trim())
      .map((s) => ({ key: s.key, title: s.title, text: s.text }));
    if (!body.length) return;
    setRereviewing(true);
    setError(null);
    setSections((prev) => prev.filter((s) => s.key !== "review")); // 移除旧评审, 新评审节会流式追加
    rvctrl.current = new AbortController();
    await streamGrantReview(
      { title: scheme?.title || title, grant_type: grantType, scheme, references: refs, sections: body },
      {
        signal: rvctrl.current.signal,
        onStatus: setStatus,
        onSection: (key, secTitle) =>
          setSections((prev) => [...prev, { key, title: secTitle, text: "" }]),
        onDelta: (t) =>
          setSections((prev) => {
            if (!prev.length) return prev;
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, text: last.text + t };
            return next;
          }),
        onReviewData: setReview,
        onError: (m) => {
          setError(`重新评审失败：${m}`);
          setStatus("");
          setRereviewing(false);
          reportLLMError(m);
        },
        onDone: () => {
          setStatus("");
          setRereviewing(false);
          window.dispatchEvent(new Event("usage-updated"));
        },
      },
    );
    setRereviewing(false);
  };

  const reset = () => {
    // 有输入或已生成内容时二次确认, 避免一键抹掉辛苦写的整份申请书
    const hasWork = title.trim() || report.trim() || idea.trim() || scheme || sections.length > 0;
    if (hasWork && !confirm("将清空全部输入与已生成的方案/初稿，且不可撤销。确定清空？")) return;
    if (running) stop();
    rctrl.current?.abort();
    rvctrl.current?.abort();
    setTitle(""); setIdea(""); setReport(""); setBackground(""); setRefs([]);
    setPeriodStart(""); setPeriodEnd("");
    setScheme(null); setOutline([]); setSections([]); setVerify(null); setReview(null);
    setReviseNote({}); setRevisingKey(null); setReviseErr(null);
    setRereviewing(false); setBatchBusy(false);
    setStyleSample(""); setStyleProfile(""); setStyleOn(true); setStyleErr("");
    setStatus(""); setError(null); setPhase("idle");
  };

  // 导出用全文 = 封面(大标题 + 基本信息表) + 正文各章节。屏幕编辑区仍只显示正文。
  const exportBody = () => {
    const cover = buildCover({
      grantType,
      projectName: scheme?.title || title,
      periodStart,
      periodEnd,
    });
    return cover + "\n" + text;
  };

  const exportMd = async () => {
    if (docxBusy) return;
    setDocxBusy(true);
    setDocxErr("");
    try {
      const refMd = refs.length
        ? "\n\n## 参考文献\n" + refs.map((r) => `- [${r.first_author} (${r.year}). ${r.title}](${r.url})`).join("\n")
        : "";
      // 导出前处理：去支持句 + 把技术路线图/甘特图渲染成图片，正文再拼参考文献。
      const body = await prepareForExport(exportBody(), "技术路线图/计划图");
      downloadText(tsName("标书初稿", "md"), body + refMd);
    } catch (e) {
      setDocxErr(`导出 Markdown 失败：${(e as Error).message}`);
    } finally {
      setDocxBusy(false);
    }
  };

  const exportDocx = async () => {
    if (!text || docxBusy) return;
    setDocxBusy(true);
    setDocxErr("");
    try {
      const body = await prepareForExport(exportBody(), "技术路线图/计划图");
      await downloadDocxFromText(tsName("标书初稿", "docx"), body);
    } catch (e) {
      setDocxErr(`导出 Word 失败：${(e as Error).message}`);
    } finally {
      setDocxBusy(false);
    }
  };

  const updateScheme = (patch: Partial<GrantScheme>) =>
    setScheme((prev) => ({ ...(prev || emptyScheme), ...patch }));

  return (
    <div className="module">
      <header className="module-head">
        <h1>📜 写标书 · 中文基金申请书</h1>
        <p>
          接着「找选题」往下走：先把选题<strong>凝练成方案骨架 + 大纲</strong>交你确认/修改，再按
          <strong>立项依据 → 研究内容与目标 → 研究方案与可行性 → 特色创新 → 年度计划 → 研究基础</strong>分节撰写，
          最后给一份<strong>评审视角自查</strong>；写完每节都可<strong>按意见单独重写</strong>。立项依据只引用选题阶段检索到的真实文献；
          申请人/经费等无法推断的事实用 <code>[需申请人补充]</code> 占位，绝不杜撰。产出为<strong>初稿</strong>，请人工核对后使用。
        </p>
      </header>

      <div className="form">
        <label className="field">
          <span className="field-label">项目题名 / 研究方向</span>
          <input
            data-testid="grant-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：肠道菌群代谢物 TMAO 通过 NLRP3 炎症小体促进动脉粥样硬化的机制研究"
          />
        </label>
        <label className="field">
          <span className="field-label">资助类型</span>
          <select data-testid="grant-type" value={grantType} onChange={(e) => setGrantType(e.target.value)}>
            {GRANT_TYPES.map((g) => (
              <option key={g.key} value={g.key}>{g.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">研究期限（可选，用于导出封面；留空则封面标 [需申请人补充]）</span>
          <div className="grant-period-row">
            <input
              data-testid="grant-period-start"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              placeholder="起，如 2026.01"
            />
            <span className="grant-period-sep">—</span>
            <input
              data-testid="grant-period-end"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              placeholder="止，如 2028.12"
            />
          </div>
        </label>
        <label className="field">
          <span className="field-label">研究想法 / 核心思路（可选，建议从「找选题」带入）</span>
          <textarea
            data-testid="grant-idea"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="拟解决的科学问题、创新点、初步设想等"
            rows={3}
          />
        </label>
        <label className="field">
          <span className="field-label">选题调研报告（可选，强烈建议带入——用于综述现状/空白并据实引用文献）</span>
          <textarea
            data-testid="grant-report"
            value={report}
            onChange={(e) => setReport(e.target.value)}
            placeholder="从「找选题」点“用此结果写标书 →”会自动带入这里；也可手动粘贴你的调研综述。"
            rows={4}
          />
        </label>
        <label className="field">
          <span className="field-label">研究基础 / 工作条件（可选）</span>
          <textarea
            data-testid="grant-background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            placeholder="例如：团队前期相关工作、已有平台/设备/样本来源、合作单位等（缺失处会标注 [需申请人补充]）"
            rows={3}
          />
        </label>
        <Dropzone
          testId="grant-upload"
          accept=".docx,.pdf,.txt,.md"
          label="附加材料（可选：已有综述/前期工作/预实验）"
          hint="支持 Word/PDF/txt；内容会作为研究基础补充"
          mode="text"
          onText={(t, name) =>
            setBackground((prev) => (prev ? prev + "\n\n" : "") + `[附加材料：${name}]\n` + t)
          }
        />

        <div className="field" data-testid="grant-style">
          <span className="field-label">文风样例（可选）</span>
          <p className="field-hint">
            上传一份你满意的 Word / PDF / txt（如你以往的标书或论文），AI 会<strong>提炼它的语言风格</strong>并在撰写时模仿，
            兼起去 AI 味的作用。<strong>只学“怎么写”，不会把样例里的内容或事实写进你的标书。</strong>
          </p>
          <Dropzone
            testId="grant-style-upload"
            accept=".docx,.pdf,.txt,.md"
            label="拖入文风样例"
            hint="支持 Word / PDF / txt；仅用于学习语言风格"
            mode="text"
            onText={(t) => setStyleSample(t)}
          />
          {styleSample && (
            <div className="grant-style-body">
              <div className="form-actions">
                <button
                  className="btn-secondary btn-sm"
                  data-testid="grant-style-extract-btn"
                  onClick={extractStyle}
                  disabled={styleBusy}
                >
                  {styleBusy ? "提炼中…" : styleProfile ? "重新提炼文风" : "提炼文风"}
                </button>
                <label className="type-chip" title="撰写与去 AI 味时是否模仿此文风">
                  <input
                    type="checkbox"
                    data-testid="grant-style-toggle"
                    checked={styleOn}
                    onChange={(e) => setStyleOn(e.target.checked)}
                  />
                  撰写时模仿此文风
                </label>
              </div>
              {styleErr && <div className="result-error" data-testid="grant-style-error">{styleErr}</div>}
              {styleProfile && (
                <label className="field">
                  <span className="field-label">文风档案（可编辑）</span>
                  <textarea
                    data-testid="grant-style-profile"
                    value={styleProfile}
                    rows={5}
                    onChange={(e) => setStyleProfile(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="field" data-testid="grant-refs-info">
          <span className="field-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            可引用文献 · Zotero
            <HelpButton helpKey="zotero" />
          </span>
          <span className="field-hint">
            共 {refs.length} 篇。可来自找选题带入，也可从 Zotero 或文件(.ris/.bib/.enw)导入。
            立项依据会据实引用这些文献；若想在写作前按方向补充新文献，勾选下方“撰写前重新检索”。
          </span>
          <RefIO
            currentRefs={refs}
            exportFilename="标书-文献"
            onImport={(imported) => {
              const { merged } = mergeRefs(refs, imported);
              setRefs(merged);
            }}
          />
          <ZoteroPanel
            currentRefs={refs}
            onImport={(imported) => {
              const { merged } = mergeRefs(refs, imported);
              setRefs(merged);
            }}
          />
        </div>

        <label className="type-chip" data-testid="grant-preresearch" title="开启后, 撰写前会按本方向再检索一遍 PubMed 等, 把新文献并入后据此写立项依据(更贴合、稍慢)">
          <input
            type="checkbox"
            data-testid="grant-preresearch-toggle"
            checked={preResearch}
            onChange={(e) => setPreResearch(e.target.checked)}
          />
          撰写前重新检索文献（推荐）
        </label>

        <div className="form-actions">
          <button
            className="btn-primary"
            onClick={() => genPlan()}
            disabled={!hasInput || planning || running}
            data-testid="grant-plan-btn"
          >
            {planning ? "生成中…" : "① 生成大纲（推荐先确认）"}
          </button>
          <button
            className="btn-secondary"
            onClick={() => startWrite(false)}
            disabled={!hasInput || running}
            data-testid="grant-oneshot-btn"
          >
            一步到位直接写完
          </button>
          <button className="btn-ghost" onClick={reset} data-testid="grant-reset-btn">
            清空
          </button>
        </div>
        {!hasInput && (
          <p className="field-hint" data-testid="grant-gate-hint" style={{ marginTop: 6 }}>
            开始前，请至少填写<strong>项目题名</strong>，或在上方粘贴一份<strong>选题调研报告</strong>——两者填其一即可生成。
          </p>
        )}
        {phase === "idle" && scheme && outline.length > 0 && (
          <p className="field-hint" style={{ marginTop: 6 }}>
            你有一份已生成的方案骨架与大纲还在。
            <button
              className="btn-ghost btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => setPhase("planned")}
              data-testid="grant-resume-plan-btn"
            >
              继续上次生成的大纲 →
            </button>
          </p>
        )}
      </div>

      {status && (
        <div className="status-line" data-testid="grant-status">
          <span className="spinner" /> {status}
        </div>
      )}

      {error && <div className="result-error" data-testid="grant-error">{error}</div>}

      {/* —— 大纲确认面板(两段式第二步) —— */}
      {phase === "planned" && scheme && (
        <div className="topic-card" data-testid="grant-confirm">
          <div className="topic-card-head">🧭 确认方案骨架与大纲（可直接编辑，确认后再撰写）</div>
          <div className="form" style={{ marginTop: 8 }}>
            <label className="field">
              <span className="field-label">凝练后的项目题名</span>
              <input
                data-testid="grant-scheme-title"
                value={scheme.title}
                onChange={(e) => updateScheme({ title: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">关键科学问题</span>
              <textarea value={scheme.question} rows={2} onChange={(e) => updateScheme({ question: e.target.value })} />
            </label>
            <div className="ss-row">
              <label className="field">
                <span className="field-label">科学假设</span>
                <textarea value={scheme.hypothesis} rows={2} onChange={(e) => updateScheme({ hypothesis: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">总体目标</span>
                <textarea value={scheme.goal} rows={2} onChange={(e) => updateScheme({ goal: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">研究内容（每行一条）</span>
              <textarea
                value={scheme.contents.join("\n")}
                rows={3}
                onChange={(e) => updateScheme({ contents: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="field">
              <span className="field-label">创新点（每行一条）</span>
              <textarea
                value={scheme.innovations.join("\n")}
                rows={2}
                onChange={(e) => updateScheme({ innovations: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </label>
            <label className="field">
              <span className="field-label">技术路线主线</span>
              <textarea value={scheme.route} rows={2} onChange={(e) => updateScheme({ route: e.target.value })} />
            </label>

            <div className="field">
              <span className="field-label">大纲章节（可改标题与篇幅；如需增删/改结构，用下方“修改意见”交给 AI 调整）</span>
              <ol className="grant-outline-edit" data-testid="grant-outline-edit">
                {outline.map((o, i) => (
                  <li key={o.key} className="grant-outline-row">
                    <input
                      className="grant-outline-title"
                      value={o.title}
                      onChange={(e) =>
                        setOutline((prev) => prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                      }
                    />
                    <input
                      className="grant-outline-budget"
                      value={o.budget}
                      onChange={(e) =>
                        setOutline((prev) => prev.map((x, j) => (j === i ? { ...x, budget: e.target.value } : x)))
                      }
                    />
                  </li>
                ))}
              </ol>
            </div>

            <div className="field">
              <span className="field-label">修改意见（可选，让 AI 调整大纲：增删章节 / 改结构 / 改篇幅）</span>
              <div className="grant-outline-note-row">
                <input
                  data-testid="grant-outline-note"
                  value={outlineNote}
                  onChange={(e) => setOutlineNote(e.target.value)}
                  placeholder="例如：加一节“前期工作基础”；把技术路线并入研究方案；每节再精简些"
                  disabled={planning || running}
                />
                <button
                  className="btn-secondary btn-sm"
                  data-testid="grant-outline-adjust-btn"
                  onClick={() => genPlan(outlineNote.trim())}
                  disabled={planning || running || !outlineNote.trim()}
                >
                  {planning ? "调整中…" : "按意见调整大纲"}
                </button>
              </div>
            </div>

            <div className="form-actions">
              <button
                className="btn-primary"
                data-testid="grant-confirm-write-btn"
                onClick={() => startWrite(true)}
                disabled={running || planning || outline.length === 0}
              >
                ② 确认大纲并撰写 →
              </button>
              <button
                className="btn-ghost"
                onClick={() => setPhase("idle")}
                disabled={running}
                title="返回上方表单继续修改；已填内容与已生成的大纲都会保留"
              >
                ← 返回修改（内容不丢）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* —— 只读方案骨架(撰写中/已完成时折叠展示) —— */}
      {scheme && phase !== "planned" && (text || running) && (
        <details className="refs" data-testid="grant-scheme-view">
          <summary>🧭 研究方案骨架</summary>
          <div className="result-text">
            {scheme.question && <p><strong>关键科学问题：</strong>{scheme.question}</p>}
            {scheme.hypothesis && <p><strong>科学假设：</strong>{scheme.hypothesis}</p>}
            {scheme.goal && <p><strong>总体目标：</strong>{scheme.goal}</p>}
            {scheme.contents.length > 0 && (
              <div><strong>研究内容：</strong><ol>{scheme.contents.map((c, i) => <li key={i}>{c}</li>)}</ol></div>
            )}
            {scheme.innovations.length > 0 && (
              <div><strong>创新点：</strong><ul>{scheme.innovations.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
            )}
            {scheme.route && <p><strong>技术路线主线：</strong>{scheme.route}</p>}
          </div>
        </details>
      )}

      <CanvasSlot>
        <div className="result-panel">
          <div className="result-toolbar">
            <span className="result-status">{running ? "撰写中…" : text ? "已完成" : "等待开始"}</span>
            <div className="result-actions">
              {running && (
                <button className="btn-ghost" onClick={stop} data-testid="grant-stop-btn">停止</button>
              )}
              {text && !running && (
                <button
                  className="btn-ghost"
                  data-testid="grant-copy-btn"
                  title="复制申请书全文到剪贴板"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1800);
                    } catch {
                      /* 剪贴板未授权: 忽略 */
                    }
                  }}
                >
                  {copied ? "已复制 ✓" : "复制全文"}
                </button>
              )}
              {text && !running && phase === "done" && (
                <button
                  className="btn-ghost"
                  data-testid="grant-rereview-btn"
                  onClick={reReview}
                  disabled={anyBusy}
                  title="把当前全文（含你手动编辑/逐节修订后的版本）交回评审组重新打分合议"
                >
                  {rereviewing ? "评审中…" : "🔁 重新评审"}
                </button>
              )}
              {text && !running && (
                <button className="btn-ghost" data-testid="grant-export-md" onClick={exportMd}>导出 Markdown</button>
              )}
              {text && !running && (
                <button className="btn-ghost" data-testid="grant-export-docx" onClick={exportDocx} disabled={docxBusy}>
                  {docxBusy ? "导出中…" : "导出 Word"}
                </button>
              )}
            </div>
          </div>
          {docxErr && <div className="result-error">{docxErr}</div>}
          {phase === "done" && sections.length > 0 && (
            <div className="grant-cover" data-testid="grant-cover">
              <Markdown>{coverMd}</Markdown>
            </div>
          )}
          <EditableMarkdown
            value={text}
            onSave={applyDeai}
            running={running}
            refInfo={citeInfo}
            deaiStyle={effStyle}
            placeholder={running ? "正在撰写…" : "填好题名（或从「找选题」带入）后，点“生成大纲”确认，再撰写；申请书初稿会显示在这里。"}
            testId="grant-result"
          />
          {phase === "done" && sections.length > 0 && !running && (
            <RefineEditor
              text={text}
              onChange={applyDeai}
              refs={refs}
              refInfo={citeInfo}
              testid="grant-refine"
            />
          )}
        </div>
      </CanvasSlot>

      {/* —— 评审组摘要卡: 资助建议 + 均分 + 各节得分 + 覆盖度 —— */}
      {review && !running && phase === "done" && (
        <div className="grant-review-summary" data-testid="grant-review-summary">
          <span className={`grant-grade-badge grant-grade-${review.grade}`}>
            资助建议 {review.grade} · {review.grade_label}
          </span>
          {review.overall != null && (
            <span>总体均分 <strong>{review.overall}</strong>/10（{review.personas.length} 位评审专家）</span>
          )}
          {review.sections.filter((s) => s.score != null).map((s) => (
            <span key={s.key} className="grant-score-chip" title={s.title}>
              {s.title.replace(/^[一二三四五六七八九十]+、/, "").slice(0, 8)} {s.score}
            </span>
          ))}
          {review.coverage.length > 0 && (
            <span className="grant-score-chip" title="申报要求覆盖度（详见评审节内表格）">
              覆盖度 ✅{review.coverage.filter((c) => c.status === "covered").length}
              {" ⚠️"}{review.coverage.filter((c) => c.status === "partial").length}
              {" ❌"}{review.coverage.filter((c) => c.status === "missing").length}
            </span>
          )}
        </div>
      )}

      {verify && !running && (
        verify.unverified.length === 0 ? (
          <div className="verify-ok" data-testid="grant-verify">
            ✓ 引用核验：正文 {verify.total} 处文献引用均来自选题阶段检索到的真实文献。
            {(verify.quotes_total ?? 0) > 0 && (
              <span className="verify-quote-note">
                　其中 {verify.quotes_total} 处附有原文支持句（悬停引用即可查看）
                {(verify.quotes_ok ?? 0) < (verify.quotes_total ?? 0) &&
                  `；有 ${(verify.quotes_total ?? 0) - (verify.quotes_ok ?? 0)} 处未能在摘要中逐字定位，请核对`}
                。
              </span>
            )}
          </div>
        ) : (
          <div className="verify-bad" data-testid="grant-verify">
            ⚠ 引用核验：发现 {verify.unverified.length} 处引用未出现在带入的文献中，可能不准确，请核实：
            {verify.unverified.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">{u}</a>
            ))}
          </div>
        )
      )}

      {/* —— 逐节修改 —— */}
      {phase === "done" && sections.length > 0 && !running && (
        <div className="followup" data-testid="grant-revise">
          <div className="followup-head">逐节修改</div>
          <p className="followup-tip">
            对某一章节不满意？写下修改意见，让 AI 只重写这一节（不动其它章节）。普通重写只用现有文献；
            <strong>立项依据</strong>可选「🔍 重新调研重写」——按你的新方向再检索 PubMed 等并把新文献并入后重写（更慢、更耗额度）。
            评审组指出问题的章节还可直接「按评审意见修订」；改完点上方「🔁 重新评审」看分数变化。
          </p>
          {review && weakTargets().length > 0 && (
            <div className="form-actions" style={{ marginBottom: 8 }}>
              <button
                className="btn-secondary btn-sm"
                data-testid="grant-batch-revise-btn"
                onClick={batchRevise}
                disabled={anyBusy}
                title="把评审组打分低于 8 分且有具体问题的章节，按评审意见依次自动重写"
              >
                {batchBusy ? "批量修订中…" : `⚡ 一键修订评审认定的薄弱章节（${weakTargets().length} 节）`}
              </button>
            </div>
          )}
          {reviseErr && <div className="result-error">{reviseErr}</div>}
          {reviseStatus && (
            <div className="status-line" data-testid="grant-revise-status">
              <span className="spinner" /> {reviseStatus}
            </div>
          )}
          <ol className="grant-revise-list">
            {sections.map((s) => (
              <li key={s.key} className="grant-revise-item" data-testid={`grant-revise-${s.key}`}>
                <div className="grant-revise-title">{s.title}</div>
                {s.key !== "review" && issuesFor(s.key).length > 0 && (
                  <div className="grant-revise-issues" data-testid={`grant-review-issues-${s.key}`}>
                    {issuesFor(s.key).map((it, i) => (
                      <div key={i}>
                        • 【{it.severity || "中"}】{it.problem}
                        {it.advice ? `　建议：${it.advice}` : ""}
                        {it.by ? `（${it.by}）` : ""}
                      </div>
                    ))}
                  </div>
                )}
                <div className="grant-revise-controls">
                  <input
                    data-testid={`grant-revise-note-${s.key}`}
                    value={reviseNote[s.key] || ""}
                    onChange={(e) => setReviseNote((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    placeholder="例如：补一段技术路线图说明 / 创新点更聚焦机制 / 这节再精简些"
                    disabled={anyBusy}
                  />
                  <button
                    className="btn-ghost btn-sm"
                    data-testid={`grant-revise-btn-${s.key}`}
                    onClick={() => reviseSection(s, false)}
                    disabled={anyBusy || !(reviseNote[s.key] || "").trim()}
                  >
                    {revisingKey === s.key ? "重写中…" : "重写本节"}
                  </button>
                  {s.key !== "review" && issuesFor(s.key).length > 0 && (
                    <button
                      className="btn-secondary btn-sm"
                      data-testid={`grant-revise-by-review-btn-${s.key}`}
                      onClick={() => reviseSectionWith(s, noteFromIssues(issuesFor(s.key)), false)}
                      disabled={anyBusy}
                      title="把评审组对本节的问题与建议作为修改意见，重写本节"
                    >
                      按评审意见修订
                    </button>
                  )}
                  {s.key === "rationale" && (
                    <button
                      className="btn-secondary btn-sm"
                      data-testid={`grant-research-btn-${s.key}`}
                      onClick={() => reviseSection(s, true)}
                      disabled={anyBusy || !(reviseNote[s.key] || "").trim()}
                      title="按你的修改意见作为新方向，重新检索文献后再写"
                    >
                      🔍 重新调研重写
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
