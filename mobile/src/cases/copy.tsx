import { useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Platform, Text, View } from "react-native";
import { Check, Copy } from "lucide-react-native";
import { Button, styles } from "../ui";
import { IconButton } from "../design/detail";
import { writeClipboard } from "./clipboard";

export function CopyValue({ label, value, scopeKey, active, compact }: { label: string; value: string | null; scopeKey: string; active: boolean; compact?: boolean }) {
  // A changed value or screen scope remounts the child and invalidates old work.
  const identity = JSON.stringify([scopeKey, value, active]);
  return <ScopedCopyValue key={identity} label={label} value={value} active={active} compact={compact} />;
}

function ScopedCopyValue({ label, value, active, compact }: { label: string; value: string | null; active: boolean; compact?: boolean }) {
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  if (!value?.trim()) return null;
  const copy = () => {
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
    }).then(saved => {
      if (!saved || !current()) return;
      setNotice("Skopírované");
      if (compact) AccessibilityInfo.announceForAccessibility?.("Skopírované");
    }, () => {
      if (!current()) return;
      if (compact) Alert.alert("Kopírovanie sa nepodarilo", "Text môžete označiť podržaním a skopírovať ručne.");
      else setNotice("Kopírovanie sa nepodarilo. Text môžete označiť a skopírovať ručne.");
    }).finally(() => { if (current()) busy.current = false; });
  };
  // Compact form for detail rows: the icon turns into a check after a copy.
  if (compact) return <IconButton icon={notice === "Skopírované" ? Check : Copy} label={label} disabled={!active} onPress={copy} />;
  return <View style={{ gap: 4 }}><Button label={label} secondary disabled={!active} onPress={copy} />{notice && <Text accessibilityRole="alert" style={styles.muted}>{notice}</Text>}</View>;
}
