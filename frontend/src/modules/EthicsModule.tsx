import { useState, useRef } from "react";
import { apiUrl } from "../lib/api";
import { usePersistentState, readPersisted } from "../lib/usePersistentState";
import { downloadBlob, tsName } from "../lib/download";
import { addHistory } from "../lib/history";
import { CanvasSlot } from "../components/Canvas";

// ── 模板定义 ────────────────────────────────────────────────────────
// 4 套伦理材料的占位符字段。后端 /api/ethics/render 据此填充 .docx 模板。
type TemplateId = "informed_consent" | "protocol" | "crf" | "data_use_commitment";

interface FieldDef {
  key: string;          // 后端占位符名（中文 key, 与模板保持一致）
  label: string;        // UI 标签
  rows?: number;        // > 1 → textarea, 否则 input
  placeholder?: string;
}

interface TemplateDef {
  id: TemplateId;
  icon: string;
  title: string;
  desc: string;
  fields: FieldDef[];
}

const TEMPLATES: TemplateDef[] = [
  {
    id: "informed_consent",
    icon: "📋",
    title: "知情同意书",
    desc: "受试者签字版，伦理委员会必交",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "完整正式的研究项目名称" },
      { key: "研究目的", label: "研究目的", rows: 3, placeholder: "用通俗语言说明本研究希望解决的问题" },
      { key: "研究流程", label: "研究流程", rows: 4, placeholder: "受试者将经历哪些访视、检查、干预" },
      { key: "风险", label: "潜在风险与不适", rows: 3, placeholder: "已知与预期的不良反应、风险等级" },
      { key: "受益", label: "可能的获益", rows: 3, placeholder: "对受试者本人或社会的潜在获益" },
      { key: "隐私保护", label: "隐私与数据保护", rows: 3, placeholder: "去标识化、访问权限、保存期限等" },
      { key: "自愿原则", label: "自愿参加与退出", rows: 2, placeholder: "可随时退出，不影响常规医疗等说明" },
      { key: "研究者", label: "主要研究者（PI）", placeholder: "姓名 · 职称" },
      { key: "联系方式", label: "联系电话/邮箱", placeholder: "受试者咨询/投诉通道" },
      { key: "机构", label: "研究机构", placeholder: "医院/科室全称" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "protocol",
    icon: "📜",
    title: "研究方案",
    desc: "详细的科研方案，供伦理审查与立项",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "项目正式名称" },
      { key: "研究背景", label: "研究背景与意义", rows: 4, placeholder: "国内外现状、未解决的问题、本研究的必要性" },
      { key: "研究目的", label: "研究目的", rows: 3, placeholder: "主要目的与次要目的" },
      { key: "研究假设", label: "研究假设", rows: 2, placeholder: "可被检验的科学假设" },
      { key: "研究设计", label: "研究设计", rows: 3, placeholder: "如随机对照/前瞻队列/横断面等" },
      { key: "入组标准", label: "入组标准", rows: 3, placeholder: "受试者纳入条件" },
      { key: "排除标准", label: "排除标准", rows: 3, placeholder: "排除条件" },
      { key: "样本量", label: "样本量估算", rows: 2, placeholder: "样本量及计算依据（α、power、效应量）" },
      { key: "干预措施", label: "干预/暴露因素", rows: 3, placeholder: "干预方案、剂量、疗程或暴露的定义" },
      { key: "主要终点", label: "主要终点指标", rows: 2, placeholder: "如治疗有效率、生存期等" },
      { key: "次要终点", label: "次要终点指标", rows: 2, placeholder: "如安全性、生活质量等" },
      { key: "统计方法", label: "统计分析方法", rows: 3, placeholder: "采用的统计模型、缺失数据处理等" },
      { key: "研究时间", label: "研究时间表", rows: 2, placeholder: "起止时间、关键节点" },
      { key: "研究者", label: "主要研究者", placeholder: "姓名 · 职称" },
      { key: "机构", label: "研究机构", placeholder: "牵头单位" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "crf",
    icon: "📊",
    title: "CRF 病例报告表",
    desc: "标准化数据采集模板",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "对应方案名称" },
      { key: "受试者编号", label: "受试者编号规则", rows: 2, placeholder: "如 中心号-序号，例 01-001" },
      { key: "访视计划", label: "访视计划", rows: 4, placeholder: "V1 基线 / V2 4 周 / V3 12 周 等" },
      { key: "基线数据", label: "基线数据字段", rows: 4, placeholder: "人口学、既往史、合并用药等需采集字段" },
      { key: "疗效指标", label: "疗效评价字段", rows: 4, placeholder: "每个访视采集的主/次要终点字段" },
      { key: "安全性指标", label: "安全性字段", rows: 3, placeholder: "不良事件、实验室检查、生命体征" },
      { key: "脱落终止", label: "脱落/终止字段", rows: 2, placeholder: "退出原因、终止访视等" },
      { key: "研究者", label: "数据负责人", placeholder: "姓名 · 职称" },
      { key: "机构", label: "研究机构", placeholder: "所属单位" },
      { key: "日期", label: "版本日期", placeholder: "YYYY-MM-DD" },
    ],
  },
  {
    id: "data_use_commitment",
    icon: "🔒",
    title: "数据使用承诺",
    desc: "研究者签署的数据使用与保密承诺",
    fields: [
      { key: "研究名称", label: "研究名称", placeholder: "项目名称" },
      { key: "数据来源", label: "数据来源", rows: 3, placeholder: "病历系统/检验/影像/问卷等" },
      { key: "使用范围", label: "数据使用范围", rows: 3, placeholder: "仅用于本研究的哪些分析" },
      { key: "保密措施", label: "保密与去标识化措施", rows: 3, placeholder: "如何脱敏、存储位置、访问控制" },
      { key: "保存期限", label: "数据保存期限", rows: 2, placeholder: "依据法规与机构要求" },
      { key: "销毁方式", label: "数据销毁/归档方式", rows: 2, placeholder: "研究结束后的处理流程" },
      { key: "研究者", label: "承诺人（PI）", placeholder: "姓名 · 职称" },
      { key: "联系方式", label: "联系方式", placeholder: "电话/邮箱" },
      { key: "机构", label: "所在机构", placeholder: "单位全称" },
      { key: "日期", label: "签署日期", placeholder: "YYYY-MM-DD" },
    ],
  },
];

// 文件名（中文 → 下载 .docx 的前缀）
const FILE_PREFIX: Record<TemplateId, string> = {
  informed_consent: "知情同意书",
  protocol: "研究方案",
  crf: "CRF病例报告表",
  data_use_commitment: "数据使用承诺",
};

// 各材料「必填」字段：缺失最易被伦理委员会退回的核心项。
// 用于下载前校验 + 红星标记，帮首次送审的用户看清哪些不能空。
const REQUIRED: Record<TemplateId, string[]> = {
  informed_consent: ["研究名称", "研究目的", "风险", "隐私保护", "研究者", "联系方式", "机构", "日期"],
  protocol: ["研究名称", "研究目的", "研究设计", "研究者", "机构", "日期"],
  crf: ["研究名称", "研究者", "机构", "日期"],
  data_use_commitment: ["研究名称", "保密措施", "研究者", "机构", "日期"],
};

// ── 从实验规划字段尝试自动填充 ──────────────────────────────────────
// plan 模块持久化字段: plan:idea / plan:field / plan:resources / plan:result
// 这里做尽力匹配, 不强求完美; 没匹配到的留空让用户填。
function importFromPlan(
  template: TemplateId,
  current: Record<string, string>,
): { fields: Record<string, string>; planFilled: number } {
  const idea = readPersisted<string>("plan:idea", "");
  const field = readPersisted<string>("plan:field", "");
  const resources = readPersisted<string>("plan:resources", "");
  const planResult = readPersisted<string>("plan:result", "");

  const next: Record<string, string> = { ...current };
  // 只填空字段, 不覆盖用户已填的; 统计「真正来自实验规划内容」的填充数
  let planFilled = 0;
  const fill = (key: string, value: string) => {
    if (value && !next[key]?.trim()) { next[key] = value; planFilled++; }
  };

  // 通用映射（均来自 plan 的真实内容）
  fill("研究名称", idea);
  fill("研究目的", idea);
  fill("研究背景", field ? `研究领域：${field}\n\n${planResult.slice(0, 400)}` : planResult.slice(0, 400));
  fill("研究设计", extractSection(planResult, ["研究设计", "设计"]));
  fill("入组标准", extractSection(planResult, ["入组", "纳入"]));
  fill("排除标准", extractSection(planResult, ["排除"]));
  fill("样本量", extractSection(planResult, ["样本量"]));
  fill("干预措施", extractSection(planResult, ["干预", "暴露"]));
  fill("主要终点", extractSection(planResult, ["主要终点", "主要疗效"]));
  fill("次要终点", extractSection(planResult, ["次要终点", "次要疗效"]));
  fill("统计方法", extractSection(planResult, ["统计分析", "统计方法"]));
  fill("研究时间", extractSection(planResult, ["时间", "里程碑"]));
  if (resources) fill("研究背景", resources);

  // 仅当确有 plan 内容被导入时, 才补通用样板默认（否则保持「未找到可导入内容」的诚实反馈,
  // 也避免 plan 为空却因样板默认而虚报「已导入 N 项」）。样板默认不计入 planFilled。
  if (planFilled > 0) {
    const fillDefault = (key: string, value: string) => {
      if (value && !next[key]?.trim()) next[key] = value;
    };
    fillDefault("自愿原则", "您参加本研究完全出于自愿，可随时退出且不影响您接受其他常规医疗服务。");
    fillDefault("隐私保护", "您的个人信息将被严格保密，仅授权研究人员可访问；数据将去标识化后用于研究分析。");
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    fillDefault("日期", ymd);
  }

  // 仅返回本模板需要的字段
  const def = TEMPLATES.find((t) => t.id === template)!;
  const result: Record<string, string> = {};
  for (const f of def.fields) result[f.key] = next[f.key] ?? "";
  return { fields: result, planFilled };
}

// 极简段落抽取: 在长文里找包含关键词的段落首句, 用作初始建议
function extractSection(text: string, keywords: string[]): string {
  if (!text) return "";
  const paras = text.split(/\n{2,}|\r\n{2,}/);
  for (const p of paras) {
    for (const k of keywords) {
      if (p.includes(k)) return p.trim().slice(0, 300);
    }
  }
  return "";
}

// ── 主组件 ─────────────────────────────────────────────────────────
export default function EthicsModule() {
  const [active, setActive] = usePersistentState<TemplateId>("ethics:active", "informed_consent");
  const tpl = TEMPLATES.find((t) => t.id === active)!;

  return (
    <div className="module ethics-module">
      <header className="module-head">
        <h1>📋 伦理材料 · 知情同意 / 方案 / CRF / 数据承诺</h1>
        <p>填空式生成伦理委员会审查必交的 Word 文件。可从"实验规划"一键导入已有信息。</p>
      </header>

      <div className="ethics-layout">
        <nav className="ethics-tabs" data-testid="ethics-nav" role="tablist" aria-label="伦理材料类型">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className={`ethics-tab ${active === t.id ? "active" : ""}`}
              onClick={() => setActive(t.id)}
              data-testid={`ethics-nav-${t.id}`}
              role="tab"
              aria-selected={active === t.id}
              title={t.desc}
            >
              <span className="ethics-tab-icon" aria-hidden="true">{t.icon}</span>
              <span className="ethics-tab-title">{t.title}</span>
            </button>
          ))}
        </nav>

        <section className="ethics-main">
          <p className="ethics-active-desc" data-testid="ethics-active-desc">
            <span aria-hidden="true">{tpl.icon}</span> {tpl.desc}
          </p>
          <EthicsEditor key={active} template={tpl} />
        </section>
      </div>
    </div>
  );
}

// 单模板编辑器: 持久化 / 表单 / 预览 / 下载
function EthicsEditor({ template }: { template: TemplateDef }) {
  const storageKey = `ethics:${template.id}:fields`;
  const [fields, setFields] = usePersistentState<Record<string, string>>(storageKey, {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState(""); // 中性反馈（导入结果等），区别于红色 err
  const [copied, setCopied] = useState(false); // 复制预览的短暂反馈
  const lastSavedRef = useRef("");

  const requiredKeys = REQUIRED[template.id];
  const missingRequired = template.fields.filter(
    (f) => requiredKeys.includes(f.key) && !(fields[f.key] || "").trim()
  );

  const setField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const doImport = () => {
    const { fields: next, planFilled } = importFromPlan(template.id, fields);
    setFields(next);
    setMsg(
      planFilled > 0
        ? `已从「实验规划」导入 ${planFilled} 项`
        : "未找到可导入内容——请先在「实验规划」里填写或生成方案，再回来导入"
    );
    window.setTimeout(() => setMsg(""), 5000);
  };

  const clearAll = () => {
    if (busy) return;
    if (!confirm(`确定清空"${template.title}"的全部字段?`)) return;
    const empty: Record<string, string> = {};
    for (const f of template.fields) empty[f.key] = "";
    setFields(empty);
  };

  // 简易 Markdown 预览
  const preview = renderPreview(template, fields);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      const resp = await fetch(apiUrl("/api/ethics/render"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: template.id, fields }),
      });
      if (!resp.ok) {
        // 后端错误正文是 text/plain（如「生成失败: 某字段…」），直接读文本, 别当 JSON 吞掉
        let detail = "";
        try { detail = (await resp.text()).trim(); } catch { /* 忽略 */ }
        throw new Error(`服务返回 ${resp.status}${detail ? ` · ${detail}` : ""}`);
      }
      const blob = await resp.blob();
      const filename = tsName(FILE_PREFIX[template.id], "docx");
      downloadBlob(filename, blob);

      // 记入历史: 字段快照, 便于回看
      const key = `${template.id}:${preview.slice(0, 60)}`;
      if (lastSavedRef.current !== key) {
        lastSavedRef.current = key;
        addHistory({
          module: "ethics",
          icon: template.icon,
          title: `${template.title} · ${fields["研究名称"]?.slice(0, 30) || "未命名"}`,
          data: { [storageKey]: fields, "ethics:active": template.id },
        });
      }
    } catch (e) {
      setErr(`下载 Word 失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // 已填字段数 → 进度提示
  const filled = template.fields.filter((f) => (fields[f.key] || "").trim()).length;
  const total = template.fields.length;

  return (
    <div className="ethics-editor">
      <div className="ethics-toolbar">
        <button className="btn-secondary" onClick={doImport} data-testid="ethics-import-btn">
          ⬇ 从实验规划导入
        </button>
        <span className="ethics-progress" data-testid="ethics-progress">
          已填 {filled} / {total} 项
        </span>
        <button className="btn-ghost btn-sm" onClick={clearAll} data-testid="ethics-clear-btn">
          清空字段
        </button>
      </div>
      {msg && (
        <div className="field-hint" data-testid="ethics-import-msg" style={{ marginBottom: 8 }}>
          {msg}
        </div>
      )}

        <div className="ethics-form form">
          {template.fields.map((f) => (
            <label className="field" key={f.key}>
              <span className="field-label">
                {f.label}
                {requiredKeys.includes(f.key) && <em>必填</em>}
              </span>
              {f.rows && f.rows > 1 ? (
                <textarea
                  data-testid={`ethics-field-${f.key}`}
                  value={fields[f.key] || ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  rows={f.rows}
                />
              ) : (
                <input
                  data-testid={`ethics-field-${f.key}`}
                  value={fields[f.key] || ""}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
              )}
            </label>
          ))}
        </div>

        <CanvasSlot>
          <div className="ethics-preview" data-testid="ethics-preview">
            <div className="ethics-preview-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>以下为填写内容速览，正式排版以下载的 Word 为准</span>
              {preview && (
                <button
                  className="btn-ghost btn-sm"
                  data-testid="ethics-copy-btn"
                  title="复制预览全文到剪贴板"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(preview);
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
            </div>
            <pre className="ethics-preview-body">{preview || "（填写左侧字段后这里会显示预览）"}</pre>
          </div>
        </CanvasSlot>

      {err && <div className="result-error" data-testid="ethics-error">{err}</div>}

      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={download}
          disabled={busy || missingRequired.length > 0}
          data-testid="ethics-download-btn"
        >
          {busy ? "生成中…" : "⬇ 下载 Word"}
        </button>
        <span className="field-hint">下载后请人工核对每一项；最终版本须经伦理委员会审核通过方可使用。</span>
      </div>
      {missingRequired.length > 0 && (
        <p className="field-hint" data-testid="ethics-required-hint" style={{ marginTop: 6, color: "var(--danger, #c0392b)" }}>
          还有 {missingRequired.length} 个必填项未填，补齐后才能下载：{missingRequired.map((f) => f.label).join("、")}
        </p>
      )}
    </div>
  );
}

// ── 预览渲染: 把字段拼成可读的 Markdown/纯文本 ──────────────────────
function renderPreview(tpl: TemplateDef, fields: Record<string, string>): string {
  const lines: string[] = [];
  const title = fields["研究名称"] || tpl.title;
  lines.push(`# ${tpl.title}`);
  if (fields["研究名称"]) lines.push(`\n研究: ${title}\n`);
  for (const f of tpl.fields) {
    if (f.key === "研究名称") continue; // 已作为标题
    const val = (fields[f.key] || "").trim();
    if (!val) continue;
    lines.push(`\n## ${f.label}\n${val}`);
  }
  return lines.join("\n");
}

