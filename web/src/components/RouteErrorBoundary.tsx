import { Component, type ReactNode } from "react";

// RouteErrorBoundary — a production safety net around the routed page area. A page that throws (e.g. a
// view that needs backend data unavailable on a static deploy) degrades to a small, calm fallback while
// the dashboard chrome (sidebar, nav, header) keeps rendering — never a white-screen. Resets on
// navigation so moving to another view recovers automatically.
interface Props {
  children: ReactNode;
  /** Change this (e.g. the route pathname) to auto-clear the error on navigation. */
  resetKey?: unknown;
}
interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[50vh] w-full flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-sm font-medium text-foreground">This view couldn’t be displayed</div>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
