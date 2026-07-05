export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const CHART_FORMATS = [
  { key: "png", label: "高清 PNG (300dpi)" },
  { key: "svg", label: "SVG 矢量" },
  { key: "pdf", label: "PDF 矢量" },
];
export const PALETTES = [
  { key: "default", label: "默认" },
  { key: "colorblind", label: "色盲友好" },
  { key: "nature", label: "Nature 风格" },
  { key: "lancet", label: "Lancet 风格" },
];

export type ChartType = "general" | "forest" | "km" | "roc";
export const CHART_TYPES: { key: ChartType; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "forest", label: "森林图" },
  { key: "km", label: "KM 生存曲线" },
  { key: "roc", label: "ROC 曲线" },
];

// 森林图单行
export interface ForestRow {
  study: string;
  n_treat: string;
  event_treat: string;
  n_ctrl: string;
  event_ctrl: string;
}
export const emptyForestRow = (): ForestRow => ({ study: "", n_treat: "", event_treat: "", n_ctrl: "", event_ctrl: "" });

export type ForestFieldKey = "study" | "n_treat" | "event_treat" | "n_ctrl" | "event_ctrl";
export interface ForestRowIssue {
  field: ForestFieldKey;
  message: string;
}

// 判空: 一行所有字段都空视为占位行, 不校验也不提交
export function isForestRowBlank(r: ForestRow): boolean {
  return !r.study.trim() && !r.n_treat && !r.event_treat && !r.n_ctrl && !r.event_ctrl;
}

/**
 * 前端预校验一行数据. 覆盖后端 forest_plot 已知会崩的输入 (event > n, 样本量 <= 0 等),
 * 让用户在提交前就能看到具体哪一格错了, 而不是等后端抛 ValueError 再兜底显示"生成失败"。
 */
export function validateForestRow(r: ForestRow): ForestRowIssue[] {
  const issues: ForestRowIssue[] = [];
  if (isForestRowBlank(r)) return issues;
  if (!r.study.trim()) issues.push({ field: "study", message: "研究名不能为空" });

  const nT = Number(r.n_treat);
  const eT = Number(r.event_treat);
  const nC = Number(r.n_ctrl);
  const eC = Number(r.event_ctrl);

  if (r.n_treat === "" || !Number.isFinite(nT) || nT <= 0)
    issues.push({ field: "n_treat", message: "治疗 N 必须 > 0" });
  if (r.n_ctrl === "" || !Number.isFinite(nC) || nC <= 0)
    issues.push({ field: "n_ctrl", message: "对照 N 必须 > 0" });
  if (r.event_treat === "" || !Number.isFinite(eT) || eT < 0)
    issues.push({ field: "event_treat", message: "治疗事件必须 ≥ 0" });
  if (r.event_ctrl === "" || !Number.isFinite(eC) || eC < 0)
    issues.push({ field: "event_ctrl", message: "对照事件必须 ≥ 0" });
  if (Number.isFinite(nT) && nT > 0 && Number.isFinite(eT) && eT > nT)
    issues.push({ field: "event_treat", message: `治疗事件(${eT}) 不能大于 治疗 N(${nT})` });
  if (Number.isFinite(nC) && nC > 0 && Number.isFinite(eC) && eC > nC)
    issues.push({ field: "event_ctrl", message: `对照事件(${eC}) 不能大于 对照 N(${nC})` });
  return issues;
}

// 森林图结果
export interface ForestSummary {
  pooled: number;
  ci_low: number;
  ci_high: number;
  i2: number;
  q_pvalue: number;
}
export interface ForestResult {
  image_base64: string;
  summary: ForestSummary;
}

// KM/ROC 结果
export interface KMResult {
  image_base64: string;
  logrank_p: number;
  groups: string[];
}
export interface ROCResult {
  image_base64: string;
  auc: number;
  auc_ci: [number, number];
  threshold: number;
}
