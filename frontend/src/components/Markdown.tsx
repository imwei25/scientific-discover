import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import Mermaid from "./Mermaid";

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
export default function Markdown({
  children,
  refInfo,
}: {
  children: string;
  refInfo?: Record<string, CiteInfo>;
}) {
  // components 必须 memo 化: react-markdown 把这些函数当作组件"类型"使用,
  // 若每次渲染都新建函数, 其 <Mermaid> 子树会在每个 token 被 remount, debounce 计时器
  // 反复清零, 导致流式期间图表永远不渲染(要等流停下)。仅在 refInfo 变化时重建。
  const components = useMemo<Components>(
    () => ({
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
    }),
    [refInfo],
  );

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
