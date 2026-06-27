import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 渲染 Markdown, 其中链接(文献引用)可点击, 在新标签打开。
// remark-gfm: 支持 GitHub 风格表格(空白矩阵)、删除线、任务列表等; 否则表格会显示为原始 | 文本。
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          // 表格外包一层容器, 窄屏可横向滚动而不撑破布局。
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
