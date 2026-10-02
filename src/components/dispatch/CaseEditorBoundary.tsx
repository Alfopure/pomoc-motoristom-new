'use client';
import { Component, type ReactNode } from 'react';
import { captureDiagnosticError } from '@/lib/diagnostics/errors';
import { ErrorFallback } from '@/lib/diagnostics/ErrorFallback';

/** Keep an editor render/effect failure inside the case panel, below the phone owner. */
export class CaseEditorBoundary extends Component<{ children: ReactNode; onFailure?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error('Editor rendering failed') }; }
  componentDidCatch(error: Error) {
    captureDiagnosticError(error, 'ui_error', true);
    this.props.onFailure?.();
  }
  render() {
    return this.state.error
      ? <ErrorFallback error={this.state.error} scope="case" retry={() => this.setState({ error: null })} />
      : this.props.children;
  }
}
