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
