import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid";

// AI 精修高亮: 用私有区哨兵字符包住"改动过的文本片段", 由 remarkHighlight 插件渲染成
// <mark class="ai-edit">(背景标黄)。选私有区码位(U+E000/U+E001), 避免与正文任何字符冲突。
export const HL_OPEN = String.fromCharCode(0xe000);
export const HL_CLOSE = String.fromCharCode(0xe001);

// 把若干 [start,end) 原文偏移区间用哨兵包起来(从后往前插, 保证前面的偏移不失效)。
export function wrapHighlights(text: string, ranges: { start: number; end: number }[]): string {
  if (!ranges.length) return text;
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of sorted) {
    out = out.slice(0, r.start) + HL_OPEN + out.slice(r.start, r.end) + HL_CLOSE + out.slice(r.end);
  }
  return out;
}

// remark 插件: 按文档顺序遍历, 遇到 HL_OPEN 开始高亮、HL_CLOSE 结束; 高亮区间内的文本节点
// 包成 mark 节点(通过 data.hName 让 mdast→hast 渲染为 <mark>)。可跨加粗/链接等行内格式。
function remarkHighlight() {
  return (tree: unknown) => {
    let on = false;
    const walk = (node: { children?: unknown[] }) => {
      if (!Array.isArray(node.children)) return;
      const out: unknown[] = [];
      for (const child of node.children as { type?: string; value?: string; children?: unknown[] }[]) {
        if (child.type === "text" && typeof child.value === "string" && (on || child.value.includes(HL_OPEN) || child.value.includes(HL_CLOSE))) {
          let buf = "";
          const flush = () => {
            if (!buf) return;
            if (on) {
              out.push({
                type: "emphasis",
                data: { hName: "mark", hProperties: { className: ["ai-edit"] } },
                children: [{ type: "text", value: buf }],
              });
            } else {
              out.push({ type: "text", value: buf });
            }
            buf = "";
          };
          for (const ch of child.value) {
            if (ch === HL_OPEN) { flush(); on = true; }
            else if (ch === HL_CLOSE) { flush(); on = false; }
            else buf += ch;
          }
          flush();
        } else {
          if (Array.isArray(child.children)) walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree as { children?: unknown[] });
  };
}

// 引用悬浮卡数据: 按归一化 URL 索引。
//   label   —— 文献题名(第一作者+年份+标题), 作悬浮卡标题;
//   finding —— 该文献要点(选题阶段的证据表 finding), 作『无支持句』时的兜底。
export interface CiteInfo {
  label?: string;
  finding?: string;
}

// 归一化 URL 作 refInfo 的键(去掉结尾斜杠), 与后端 rstrip("/") 对齐。
export function normCiteUrl(u: string): string {
  return (u || "").replace(/\/+$/, "");
}

// 渲染 Markdown, 其中链接(文献引用)可点击, 在新标签打开。
// remark-gfm: 支持 GitHub 风格表格(空白矩阵)、删除线、任务列表等; 否则表格会显示为原始 | 文本。
// ```mermaid 代码块(标书技术路线图/甘特图等)渲染成图。
// refInfo: 传入时, 引用链接悬停会浮出"支持此观点的原文句子"(取自链接 title 的『支持句』),
//   无支持句则回退显示该文献要点(finding); 二者皆无则为普通链接。
// highlight: 传入 true 时启用 AI 精修高亮插件(children 里的哨兵区间渲染成标黄)。
// 提取段落第一段可读文本, 用于识别后端返回的"占位段"警告(例如
// "[本节缺少必要材料, 请补充: …]" / "[待补充: …]")。这些是给作者看的提醒,
// 若与正文样式混同, 用户可能漏看直接投稿, 因此渲染时需要视觉突出。
function paragraphLeadingText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { value?: string; children?: unknown[] };
  if (typeof n.value === "string") return n.value;
  if (Array.isArray(n.children)) {
    for (const c of n.children) {
      const s = paragraphLeadingText(c);
      if (s) return s;
    }
  }
  return "";
}
function isPlaceholderParagraph(text: string): boolean {
  const t = (text || "").trimStart();
  return t.startsWith("[本节缺少必要材料") || t.startsWith("[待补充");
}

function MarkdownInner({
  children,
  refInfo,
  highlight,
  highlightPlaceholders,
}: {
  children: string;
  refInfo?: Record<string, CiteInfo>;
  highlight?: boolean;
  highlightPlaceholders?: boolean;
}) {
  // components 必须 memo 化: react-markdown 把这些函数当作组件"类型"使用,
  // 若每次渲染都新建函数, 其 <Mermaid> 子树会在每个 token 被 remount, debounce 计时器
  // 反复清零, 导致流式期间图表永远不渲染(要等流停下)。仅在 refInfo 变化时重建。
  const components = useMemo<Components>(
    () => {
      const base: Components = {
        a: ({ href, title, children }) => {
          const link = (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
          const info = href ? refInfo?.[normCiteUrl(href)] : undefined;
          // title 里的『支持句：…』是 AI 标注的、支持此处论断的原文原句。
          const quote = title ? title.replace(/^支持句[:：]\s*/, "").trim() : "";
          const body = quote || info?.finding || "";
          if (!body) return link;
          return (
            <span className="cite-wrap" tabIndex={0}>
              {link}
              <span className="cite-pop" role="tooltip">
                {info?.label && <span className="cite-pop-head">{info.label}</span>}
                <span className="cite-pop-tag">{quote ? "原文支持句" : "文献要点"}</span>
                <span className="cite-pop-body">{body}</span>
              </span>
            </span>
          );
        },
        // 表格外包一层容器, 窄屏可横向滚动而不撑破布局。
        table: ({ children }) => (
          <div className="md-table-wrap">
            <table>{children}</table>
          </div>
        ),
        code: ({ className, children, ...props }) => {
          if (/language-mermaid/.test(className || "")) {
            return <Mermaid code={String(children ?? "").replace(/\n$/, "")} />;
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      };
      // 占位段视觉标注: 只在需要时才注册 p override —— 注意 react-markdown 会把
      // components.p 当组件类型 createElement, 若为 undefined 会触发 React #130 崩溃.
      if (highlightPlaceholders) {
        base.p = ({ node, children }) => {
          const text = paragraphLeadingText(node);
          if (isPlaceholderParagraph(text)) {
            return <div className="imrad-placeholder">{children}</div>;
          }
          return <p>{children}</p>;
        };
      }
      return base;
    },
    [refInfo, highlightPlaceholders],
  );

  const plugins = useMemo(
    () => (highlight ? [remarkGfm, remarkHighlight] : [remarkGfm]),
    [highlight],
  );

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

// memo: 父组件 re-render 但 children 未变 (常见于 useStream delta 快速累积,
// 父组件 setState 触发但同一 delta 会被 setText 合并为一次 children 变化) 时
// 跳过 ReactMarkdown 全量 AST 解析. R19 性能审计估算 delta 期间 CPU -60%.
const Markdown = memo(MarkdownInner, (a, b) =>
  a.children === b.children &&
  a.refInfo === b.refInfo &&
  a.highlight === b.highlight &&
  a.highlightPlaceholders === b.highlightPlaceholders,
);

export default Markdown;
