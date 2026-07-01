import { StrictMode, Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "katex/dist/katex.min.css";
import App from "./App";

/**
 * 全局 Error Boundary：捕获 React 渲染阶段的错误，打印完整组件栈到 console。
 * 生产环境下 React 的 minified error 只显示编号，这里能拿到 componentStack 帮助定位。
 */
class GlobalErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error; info?: ErrorInfo }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 打印完整错误 + 组件栈到 console（DevTools 可见）
    console.error("=== React Error Boundary caught ===");
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
    console.error("Component Stack:", info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, fontFamily: "monospace", fontSize: 12, color: "#dc2626", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "100vh" }}>
          <h2 style={{ margin: "0 0 12px" }}>⚠️ 渲染错误（详情见 Console）</h2>
          <p><strong>{this.state.error?.message}</strong></p>
          <pre style={{ fontSize: 11, opacity: 0.8 }}>{this.state.error?.stack}</pre>
          <button onClick={() => this.setState({ hasError: false })} style={{ marginTop: 12, padding: "6px 12px", cursor: "pointer" }}>尝试恢复</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>
);
