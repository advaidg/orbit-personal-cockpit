import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; label?: string }
interface State { failed: boolean }

/** Keeps a bug in one screen from blanking the whole app. The rest of Orbit keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Only the message reaches the console, so nothing from the page content is echoed anywhere.
    console.error(`[orbit] ${this.props.label ?? 'screen'} crashed: ${error.message}`, info.componentStack?.split('\n')[1]?.trim());
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice bad" role="alert">
        <div><strong>This screen hit a problem.</strong><span>Nothing was lost and the rest of Orbit still works. Try another screen, or reload the page.</span></div>
        <button className="btn plain" onClick={() => this.setState({ failed: false })}>Try again</button>
      </div>
    );
  }
}
