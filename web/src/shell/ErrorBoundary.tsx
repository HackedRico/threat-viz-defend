import { Component, type ErrorInfo, type ReactNode } from "react";

// =============================================================================
// Module Overview
// =============================================================================
// A net under each screen. A value the page cannot draw, such as an odd shape
// in a model's map, would otherwise unmount the whole app and leave a blank
// page mid-demo; here it shows a message and a way to reload instead.

/** Catches a render error in `children` and offers a reload; key it by what it shows so it resets on navigation. */
export class ErrorBoundary extends Component<{ children: ReactNode; what: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.what} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="board-loading" role="alert">
        <p>This {this.props.what} hit a display error. Your work is saved on the server.</p>
        <button type="button" className="btn" onClick={() => location.reload()}>
          Reload the page
        </button>
      </section>
    );
  }
}
