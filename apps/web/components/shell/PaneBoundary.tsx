'use client';

import { Component, type ReactNode } from 'react';

/**
 * A boundary around one pane, so a pane that cannot draw itself costs a pane.
 *
 * The route boundary below this one (`app/(app)/error.tsx`) keeps the shell
 * when a page throws; this keeps the rest of the *page* when one panel throws,
 * which is what a chart fed a body it did not expect does. It is a class
 * because React has no hook for this.
 */
export class PaneBoundary extends Component<
  { children: ReactNode; label: string; testId?: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('pane failed', this.props.label, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p
        role="status"
        data-testid={this.props.testId ?? 'pane-failed'}
        className="rounded-ctl border-1.5 border-edge bg-surface px-3 py-2.5 text-[13px] text-ink2"
      >
        {this.props.label} could not be drawn. Everything else on this page is unaffected.
      </p>
    );
  }
}
