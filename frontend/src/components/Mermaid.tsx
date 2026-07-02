import { useEffect, useRef, useState } from "react";

// mermaid 很大(~1MB), 动态 import 让 vite 单独分包, 只在真的遇到图表时才加载。
let seq = 0;
let initialized = false;

async function loadMermaid() {
  const mermaid = (await import("mermaid")).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "inherit",
    });
    initialized = true;
  }
  return mermaid;
}

// 渲染 ```mermaid 代码块(技术路线图/甘特图)。
// 流式生成中代码不完整是常态: 渲染失败时保留上一次成功的图; 从未成功过则显示代码原文。
export default function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const lastGood = useRef("");

  useEffect(() => {
    let alive = true;
    // 防抖 300ms: 避免流式期间每个 token 都触发一次渲染。
    const t = window.setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        await mermaid.parse(code); // 先校验, 避免 render 失败在 DOM 留残渣
        const { svg: out } = await mermaid.render(`mmd-${++seq}`, code);
        if (alive) {
          lastGood.current = out;
          setSvg(out);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true); // 保留 lastGood, 只在从未成功时露出代码
      }
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [code]);

  if (lastGood.current) {
    return (
      <div className="mermaid-figure">
        {/* mermaid strict 模式已对内容消毒, svg 可信 */}
        <div dangerouslySetInnerHTML={{ __html: svg || lastGood.current }} />
        {failed && <div className="mermaid-note">（图表代码有改动但暂未通过校验，显示的是上一版）</div>}
      </div>
    );
  }
  return (
    <div className="mermaid-fallback">
      {failed && <div className="mermaid-note">图表代码未能渲染（可能仍在生成或有语法瑕疵），原文如下：</div>}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
