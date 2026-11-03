import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { Button, Card, styles } from "../ui";
import type { ErrorReporter } from "../lib/error-reporting";

/** The reporter of the signed-in app, for boundaries deeper in the tree. */
export const ErrorReporterContext = createContext<ErrorReporter | null>(null);

/** A part that failed to draw shows a way back instead of an empty app. Trying again
 * first forgets loaded data (`onReset`), since the same data would fail the same way.
 * `fallback` replaces the default notice, e.g. for the call screen. */
export class AppErrorBoundary extends Component<{
  reporter: ErrorReporter | null; onReset: () => void; fallback?: (retry: () => void) => ReactNode;
  /** The default notice's text, e.g. at the root where there is no bottom bar. */
  message?: string;
  /** A new value (another screen) clears the failure without forgetting data. */
  resetKey?: string;
  /** Extra handling, e.g. keeping a crash on the device where no reporter exists yet. */
  onCatch?: (error: Error) => void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    try { this.props.onCatch?.(error); this.props.reporter?.report("render", error, info.componentStack ?? null); } catch { /* Reporting never fails the fallback. */ }
  }
  // Only a change after the failure resets it; the update that failed may itself have moved the key.
  componentDidUpdate(previous: { resetKey?: string }, previousState: { failed: boolean }) {
    if (previousState.failed && this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  retry = () => { try { this.props.onReset(); } finally { this.setState({ failed: false }); } };
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry);
    return <View style={styles.content}><Card>
      <Text accessibilityRole="header" style={styles.subheading}>Niečo sa pokazilo</Text>
      <Text style={styles.text}>{this.props.message ?? "Táto obrazovka sa nedala zobraziť. Skúste to znova alebo prejdite inam v spodnej lište. Ak sa chyba opakuje, zatvorte aplikáciu a otvorte ju znova, prípadne napíšte podpore."}</Text>
      <Button label="Skúsiť znova" onPress={this.retry} />
    </Card></View>;
  }
}

/** One module's own boundary. Modules that stay mounted on other tabs (Prípady, Úlohy,
 * Nástroje) fail alone, so the dispatcher can still use the others. Trying again forgets
 * the module's own data (`forget`) and the request that opened it (`onReset`), so it
 * starts from its list instead of failing on the same record again. */
export function ModuleBoundary({ children, forget, onReset }: { children: ReactNode; forget?: (key: readonly unknown[]) => boolean; onReset?: () => void }) {
  const reporter = useContext(ErrorReporterContext);
  const queryClient = useQueryClient();
  return <AppErrorBoundary reporter={reporter} onReset={() => { onReset?.(); if (forget) queryClient.removeQueries({ predicate: query => forget(query.queryKey) }); }}>{children}</AppErrorBoundary>;
}
