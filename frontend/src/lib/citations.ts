import type { Reference } from "./sse";

// 把正文里的 Markdown 文献链接 [作者, 年](url) 转成规范的数字引用 [n]，
// 并在文末生成「参考文献」章节（GB/T 7714 数字著录风格）。
// 用于导出（Word/PDF/Markdown）与需要正规著录的预览：编号按正文首次出现顺序分配，
// 同一文献重复引用共用同一编号；解析不到对应 Reference 的链接也会据链接文本兜底编号。

const stripSlash = (u: string) => (u || "").replace(/\/+$/, "").trim();

// 从 Reference 生成一条 GB/T 7714 风格著录（信息缺失则跳过对应片段，绝不编造）。
function formatRef(n: number, r: Reference | { first_author?: string; year?: string; title?: string; journal?: string; url?: string }): string {
  const author = (r.first_author || "").trim();
  const title = (r.title || "").trim();
  const journal = (r.journal || "").trim();
  const year = (r.year || "").toString().trim();
  const parts: string[] = [];
  if (author) parts.push(author.endsWith(".") ? author : author + ".");
  if (title) parts.push(title.endsWith(".") ? `${title}[J].` : `${title}[J].`);
  const tail: string[] = [];
  if (journal) tail.push(journal);
  if (year) tail.push(year);
  let line = `[${n}] ` + parts.join(" ");
  if (tail.length) line += " " + tail.join(", ") + ".";
  if (r.url) line += ` ${r.url}`;
  return line.replace(/\s+/g, " ").trim();
}

// 把 refs 建成 url→Reference 的索引（含尾斜杠归一 + pmid 兜底）。
function indexRefs(refs: Reference[]): { byUrl: Map<string, Reference>; byPmidTail: Map<string, Reference> } {
  const byUrl = new Map<string, Reference>();
  const byPmidTail = new Map<string, Reference>();
  for (const r of refs) {
    if (r.url) byUrl.set(stripSlash(r.url), r);
    if (r.pmid) byPmidTail.set(r.pmid, r);
  }
  return { byUrl, byPmidTail };
}

export interface NumberedResult {
  body: string;        // 正文（引用已替换为 [n]）
  references: string;  // 「参考文献」章节的 Markdown（无引用时为空串）
  count: number;       // 参考文献条数
}

// 主函数：转换正文 + 生成参考文献章节。sectionTitle 允许按标书类型定制（默认「参考文献」）。
export function numberCitations(markdown: string, refs: Reference[], sectionTitle = "参考文献"): NumberedResult {
  const { byUrl, byPmidTail } = indexRefs(refs);
  const order: { key: string; ref: Reference | { first_author?: string; year?: string; title?: string; journal?: string; url?: string } }[] = [];
  const numByKey = new Map<string, number>();

  const resolve = (url: string, label: string) => {
    const u = stripSlash(url);
    let ref = byUrl.get(u);
    if (!ref) {
      for (const [pmid, r] of byPmidTail) if (u.endsWith("/" + pmid)) { ref = r; break; }
    }
    const key = ref ? stripSlash(ref.url || u) : u;
    if (!numByKey.has(key)) {
      numByKey.set(key, order.length + 1);
      // 解析不到 Reference 时用链接文本兜底一条最小著录（作者/年从 label 猜）。
      order.push({ key, ref: ref || { title: label, url } });
    }
    return numByKey.get(key)!;
  };

  // [label](url "optional title") → [n]
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const body = markdown.replace(re, (_m, label: string, url: string) => {
    const n = resolve(url, (label || "").trim());
    return `[${n}]`;
  });

  if (order.length === 0) return { body, references: "", count: 0 };
  const lines = order.map((o, i) => formatRef(i + 1, o.ref));
  const references = `## ${sectionTitle}\n\n` + lines.join("\n\n");
  return { body, references, count: order.length };
}

// 便捷封装：把正文与参考文献拼成一整篇（导出用）。
export function withNumberedReferences(markdown: string, refs: Reference[], sectionTitle = "参考文献"): string {
  const { body, references } = numberCitations(markdown, refs, sectionTitle);
  return references ? `${body}\n\n${references}` : body;
}
