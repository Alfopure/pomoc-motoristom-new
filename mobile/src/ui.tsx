import type { PropsWithChildren } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

// Match the web dispatch: brand yellow, zinc surfaces and black actions.
export const colors = {
  brand: "#FCD703", ink: "#09090B", muted: "#52525B", border: "#E4E4E7",
  background: "#F4F4F5", surfaceMuted: "#F4F4F5", white: "#FFFFFF",
  danger: "#B91C1C", success: "#059669", notice: "#FEFCE8", noticeBorder: "#FDE047",
};
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 18, paddingBottom: 32 },
  heading: { fontSize: 28, fontWeight: "700", color: colors.ink },
  subheading: { fontSize: 18, fontWeight: "700", color: colors.ink },
  text: { fontSize: 16, color: colors.ink, lineHeight: 24 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 21 },
  label: { fontSize: 14, color: colors.ink, fontWeight: "600", marginBottom: 7 },
  input: { backgroundColor: colors.white, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14, minHeight: 52, fontSize: 16, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  card: { backgroundColor: colors.white, padding: 18, borderRadius: 18, borderWidth: 1, borderColor: colors.border, gap: 10 },
  button: { backgroundColor: colors.ink, borderRadius: 12, padding: 14, minHeight: 50, alignItems: "center", justifyContent: "center" },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  secondary: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.ink },
  disabled: { backgroundColor: "#D4D4D8" },
  disabledText: { color: colors.muted },
});
export function Card({ children }: PropsWithChildren) { return <View style={styles.card}>{children}</View>; }
export function Button({ label, onPress, disabled, secondary }: { label: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, disabled && styles.disabled, pressed && { opacity: 0.7 }]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText, disabled && styles.disabledText]}>{label}</Text>
  </Pressable>;
}
export function Loading({ label = "Načítavam…" }: { label?: string }) {
  return <View style={[styles.content, { alignItems: "center" }]}><ActivityIndicator color={colors.ink} /><Text style={styles.muted}>{label}</Text></View>;
}
export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card><Text accessibilityRole="alert" style={[styles.text, { color: colors.danger }]}>{message}</Text>
    {onRetry && <Button label="Skúsiť znova" onPress={onRetry} secondary />}</Card>;
}
