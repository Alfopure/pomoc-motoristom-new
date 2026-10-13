import type { PropsWithChildren } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, NAVIGATION_CONTENT_BOTTOM } from "./ui/theme";
export { colors, NAVIGATION_CONTENT_BOTTOM } from "./ui/theme";

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 18, paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  heading: { fontSize: 32, fontWeight: "700", letterSpacing: -0.8, color: colors.ink },
  subheading: { fontSize: 19, fontWeight: "600", letterSpacing: -0.3, color: colors.ink },
  text: { fontSize: 16, color: colors.ink, lineHeight: 24 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 21 },
  label: { fontSize: 14, color: colors.ink, fontWeight: "600", marginBottom: 7 },
  input: { backgroundColor: colors.white, borderColor: colors.border, borderWidth: 1, borderRadius: 16, padding: 16, minHeight: 54, fontSize: 16, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  card: { backgroundColor: colors.white, padding: 20, borderRadius: 24, borderWidth: 1, borderColor: colors.border, gap: 10 },
  button: { backgroundColor: colors.ink, borderRadius: 17, padding: 16, minHeight: 52, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  secondary: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.ink },
  disabled: { backgroundColor: "#D4D4D8" },
  disabledText: { color: colors.muted },
});
export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) { return <View style={[styles.card, style]}>{children}</View>; }
export function Button({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, disabled && styles.disabled, pressed && { opacity: 0.7 }]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText, disabled && styles.disabledText]}>{label}</Text>
  </Pressable>;
}
export function Loading({ label = "Načítavam…" }: { label?: string }) {
  return <View style={{ padding: 20, gap: 14, alignItems: "center" }}><ActivityIndicator color={colors.ink} /><Text style={styles.muted}>{label}</Text></View>;
}
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card><Text accessibilityRole="alert" style={[styles.text, { color: colors.danger }]}>{message}</Text>
    {onRetry && <Button label="Skúsiť znova" onPress={onRetry} secondary />}</Card>;
}
