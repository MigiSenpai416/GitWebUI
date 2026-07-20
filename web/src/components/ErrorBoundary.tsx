import { Component, type ErrorInfo, type ReactNode } from "react";
import "./ErrorBoundary.css";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so one bad component can't blank the whole
 * app. Shows a recoverable message with Try again (re-render) and Reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[gitwebui] render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="eb">
        <div className="eb-card">
          <div className="eb-title">Something went wrong</div>
          <p className="eb-msg">
            The interface hit an unexpected error. Your repositories and history are safe — this
            only affects the current view.
          </p>
          <pre className="eb-detail">{this.state.error.message}</pre>
          <div className="eb-actions">
            <button className="eb-btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="eb-btn eb-btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
