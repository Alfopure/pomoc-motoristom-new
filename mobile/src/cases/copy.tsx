import { useLayoutEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { Button, styles } from "../ui";
import { writeClipboard } from "./clipboard";

export function CopyValue({ label, value, scopeKey, active }: { label: string; value: string | null; scopeKey: string; active: boolean }) {
  // A changed value or screen scope remounts the child and invalidates old work.
  const identity = JSON.stringify([scopeKey, value, active]);
  return <ScopedCopyValue key={identity} label={label} value={value} active={active} />;
}

function ScopedCopyValue({ label, value, active }: { label: string; value: string | null; active: boolean }) {
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  if (!value?.trim()) return null;
  return <View style={{ gap: 4 }}><Button label={label} secondary disabled={!active} onPress={() => {
    const current = () => alive.current && active;
    if (busy.current || !current()) return;
    busy.current = true;
    void writeClipboard(value, current, {
      platform: Platform.OS,
      native: () => import("expo-clipboard"),
      web: value => {
        if (!globalThis.navigator?.clipboard?.writeText) return Promise.reject(new Error("Clipboard unavailable"));
        return globalThis.navigator.clipboard.writeText(value);
      },
    }).then(saved => { if (saved && current()) setNotice("Skopírované"); }, () => {
      if (current()) setNotice("Kopírovanie sa nepodarilo. Text môžete označiť a skopírovať ručne.");
    }).finally(() => { if (current()) busy.current = false; });
  }} />{notice && <Text accessibilityRole="alert" style={styles.muted}>{notice}</Text>}</View>;
}
