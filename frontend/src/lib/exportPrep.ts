// 导出前的正文预处理：去掉引用里的『支持句』、把 ```mermaid 代码块渲染成图片。
// 「支持句」只是屏幕上悬停查看的写作辅助（AI 标注的原文佐证句），不应进入导出的成稿；
// mermaid 代码块在导出的 Word/Markdown 里应是渲染好的图，而不是一段代码。
import { loadMermaid } from "../components/Mermaid";

// 去掉 Markdown 链接里的 title（即『支持句』）：[text](url "支持句：…") → [text](url)。
export function stripSupportQuotes(md: string): string {
  return md.replace(/\]\((https?:\/\/[^)\s]+)\s+"[^"]*"\)/g, "]($1)");
}

// 从 mermaid 渲染出的 SVG 里取尺寸，并强制写死 width/height（否则某些 SVG 宽高为 100%，
// 光栅化时 Image 尺寸会取到 0）。返回定尺寸后的 SVG 与像素宽高。
function sizeSvg(svg: string): { svg: string; w: number; h: number } {
  let w = 800;
  let h = 600;
  const vb = svg.match(/viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.\-]+)\s+([\d.\-]+)"/);
  if (vb) {
    w = Math.max(1, Math.ceil(parseFloat(vb[1])));
    h = Math.max(1, Math.ceil(parseFloat(vb[2])));
  }
  const sized = svg.replace(/<svg([^>]*)>/, (_m, attrs) => {
    const a = String(attrs)
      .replace(/\swidth="[^"]*"/, "")
      .replace(/\sheight="[^"]*"/, "")
      .replace(/style="[^"]*"/, "");
    return `<svg${a} width="${w}" height="${h}">`;
  });
  return { svg: sized, w, h };
}

// 把一段 SVG 光栅化为 PNG dataURL（白底、2x 提升清晰度）。失败返回 null。
async function svgToPng(svg: string): Promise<string | null> {
  const { svg: sized, w, h } = sizeSvg(svg);
  const blob = new Blob([sized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.width = w;
    img.height = h;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg load failed"));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MERMAID_BLOCK = /```mermaid[^\n]*\n([\s\S]*?)```/g;

// 把正文里的 ```mermaid 代码块替换成渲染好的 PNG 图片（Markdown 图片语法，data URL 内嵌，
// 自包含）。渲染失败的块保留原代码，不影响导出。无 mermaid 块时原样返回。
export async function inlineMermaid(md: string, alt = "图示"): Promise<string> {
  const blocks = [...md.matchAll(MERMAID_BLOCK)];
  if (!blocks.length) return md;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return md;
  }
  // 从后往前替换，保证前面 block 的字符偏移不失效。
  let out = md;
  let seq = 0;
  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const m = blocks[bi];
    const code = m[1].trim();
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let replacement = m[0];
    try {
      await mermaid.parse(code);
      const { svg } = await mermaid.render(`mmd-export-${Date.now()}-${seq++}`, code);
      const png = await svgToPng(svg);
      if (png) replacement = `![${alt}](${png})`;
    } catch {
      /* 保留原代码块 */
    }
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

// 导出正文一站式预处理：去支持句 + 内嵌 mermaid 图。
export async function prepareForExport(md: string, mermaidAlt = "图示"): Promise<string> {
  return inlineMermaid(stripSupportQuotes(md), mermaidAlt);
}
