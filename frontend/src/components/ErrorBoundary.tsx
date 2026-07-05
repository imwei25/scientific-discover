import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  err: Error | null;
  info: ErrorInfo | null;
}

// 全局错误边界: 捕获任何模块渲染异常, 避免单个组件抛错导致整个 SPA 白屏。
// 非技术用户看到的是可操作的重试/刷新提示, 而不是空白页面。
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: null };

  static getDerivedStateFromError(err: Error): State {
    return { err, info: null };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    this.setState({ err, info });
    try {
      console.error("[ErrorBoundary]", err, info?.componentStack);
    } catch {
      /* ignore */
    }
  }

  private reset = () => this.setState({ err: null, info: null });

  private reload = () => {
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  render() {
    if (!this.state.err) return this.props.children;
    const title = this.props.fallbackTitle || "页面出现意外错误";
    const msg = this.state.err?.message || String(this.state.err);
    return (
      <div style={{ padding: 24, maxWidth: 820, margin: "40px auto" }}>
        <div style={{ padding: 20, border: "1px solid #f3a", borderRadius: 8, background: "#fff5f7" }}>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>⚠ {title}</div>
          <div style={{ color: "#a33", marginBottom: 12, wordBreak: "break-word" }}>
            {msg}
          </div>
          <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
            可以先尝试「重试当前模块」；若仍有问题请点「重新载入页面」。您之前保存的内容不会丢失。
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={this.reset}>重试当前模块</button>
            <button onClick={this.reload}>重新载入页面</button>
          </div>
        </div>
      </div>
    );
  }
}
