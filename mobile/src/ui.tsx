import type { PropsWithChildren } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { type } from "./design/tokens";
import { colors, NAVIGATION_CONTENT_BOTTOM } from "./ui/theme";
export { colors, NAVIGATION_CONTENT_BOTTOM } from "./ui/theme";

// Compact standard: grouped white surfaces on the system background, capsule buttons.
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 16, paddingTop: 6, gap: 12, paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  heading: { ...type.title, color: colors.ink },
  subheading: { ...type.headline, color: colors.ink },
  text: { ...type.body, color: colors.ink },
  muted: { ...type.subhead, color: colors.muted },
  label: { fontSize: 13, lineHeight: 18, color: colors.ink, fontWeight: "600", marginBottom: 6 },
  input: { backgroundColor: colors.white, borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, minHeight: 44, fontSize: 16, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  card: { backgroundColor: colors.white, padding: 14, borderRadius: 16, gap: 8 },
  button: { backgroundColor: colors.ink, borderRadius: 22, paddingVertical: 11, paddingHorizontal: 16, minHeight: 44, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.white, fontSize: 15, lineHeight: 20, fontWeight: "600", maxWidth: "100%", textAlign: "center" },
  // The one main action of a form or list (design standard, principle 3).
  primary: { backgroundColor: colors.brand },
  primaryText: { color: colors.ink },
  secondary: { backgroundColor: "rgba(118,118,128,0.12)" },
  secondaryText: { color: colors.ink },
  disabled: { backgroundColor: "#E5E5EA" },
  disabledText: { color: "#8E8E93" },
});
export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) { return <View style={[styles.card, style]}>{children}</View>; }
/** Black by default; `primary` is yellow, at most once per screen; `secondary` is gray. */
export function Button({ label, onPress, disabled, secondary, primary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, primary && styles.primary, secondary && styles.secondary, disabled && styles.disabled, pressed && { opacity: 0.7 }]}>
    <Text style={[styles.buttonText, primary && styles.primaryText, secondary && styles.secondaryText, disabled && styles.disabledText]}>{label}</Text>
  </Pressable>;
}
export function Loading({ label = "Načítavam…" }: { label?: string }) {
  return <View style={{ padding: 16, gap: 10, alignItems: "center" }}><ActivityIndicator color={colors.ink} /><Text style={styles.muted}>{label}</Text></View>;
}
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card><Text accessibilityRole="alert" style={[styles.text, { color: colors.danger }]}>{message}</Text>
    {onRetry && <Button label="Skúsiť znova" onPress={onRetry} secondary />}</Card>;
}
