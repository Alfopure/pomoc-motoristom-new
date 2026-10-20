import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Button, Card, styles } from "../ui";
import type { ErrorReporter } from "../lib/error-reporting";

/** A screen that failed to draw shows a way back instead of an empty app. Trying again
 * first forgets loaded data (`onReset`), since the same data would fail the same way. */
export class AppErrorBoundary extends Component<{ report: ErrorReporter; onReset: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { this.props.report("render", error, info.componentStack ?? null); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={styles.content}><Card>
      <Text accessibilityRole="header" style={styles.subheading}>Niečo sa pokazilo</Text>
      <Text style={styles.text}>Táto obrazovka sa nedala zobraziť. Chybu sme zaznamenali. Skúste to znova; ak sa opakuje, napíšte podpore.</Text>
      <Button label="Skúsiť znova" onPress={() => { this.props.onReset(); this.setState({ failed: false }); }} />
    </Card></View>;
  }
}
