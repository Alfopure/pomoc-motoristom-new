import { Component, createContext, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Button, Card, styles } from "../ui";
import type { ErrorReporter } from "../lib/error-reporting";

/** The reporter of the signed-in app, for boundaries deeper in the tree. */
export const ErrorReporterContext = createContext<ErrorReporter | null>(null);

/** A part that failed to draw shows a way back instead of an empty app. Trying again
 * first forgets loaded data (`onReset`), since the same data would fail the same way.
 * `fallback` replaces the default notice, e.g. for the call screen. */
export class AppErrorBoundary extends Component<{ reporter: ErrorReporter | null; onReset: () => void; fallback?: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { try { this.props.reporter?.report("render", error, info.componentStack ?? null); } catch { /* Reporting never fails the fallback. */ } }
  retry = () => { try { this.props.onReset(); } finally { this.setState({ failed: false }); } };
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry);
    return <View style={styles.content}><Card>
      <Text accessibilityRole="header" style={styles.subheading}>Niečo sa pokazilo</Text>
      <Text style={styles.text}>Táto obrazovka sa nedala zobraziť. Skúste to znova alebo prejdite inam v spodnej lište. Ak sa chyba opakuje, zatvorte aplikáciu a otvorte ju znova, prípadne napíšte podpore.</Text>
      <Button label="Skúsiť znova" onPress={this.retry} />
    </Card></View>;
  }
}
