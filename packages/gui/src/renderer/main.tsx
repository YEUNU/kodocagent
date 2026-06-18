import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

/** 렌더 오류가 화면을 통째로 비우지 않도록 잡아서 표시한다. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: "#f1f3f7",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            fontSize: 13,
          }}
        >
          <h2 style={{ color: "#d96b6b", marginBottom: 12 }}>렌더 오류</h2>
          <div>{this.state.error.message}</div>
          <pre style={{ marginTop: 12, opacity: 0.8 }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
