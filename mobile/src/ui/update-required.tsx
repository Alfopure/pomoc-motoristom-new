import { Linking, Text, View } from "react-native";
import { Button, Card, ErrorNotice, styles } from "../ui";
import { versionLabel, type AppVersion } from "../lib/app-version";
import { useState } from "react";

/** Shown instead of the app when the server no longer supports this version. */
export function UpdateRequired({ version, minimum, updateUrl, onRetry }: { version: AppVersion; minimum: string; updateUrl: string | null; onRetry: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return <View style={styles.content}><Card>
    <Text accessibilityRole="header" style={styles.subheading}>Aktualizujte aplikáciu</Text>
    <Text style={styles.text}>Táto verzia ({versionLabel(version)}) už nie je podporovaná. Nainštalujte verziu {minimum} alebo novšiu a potom aplikáciu otvorte znova.</Text>
    {updateUrl && <Button primary label="Otvoriť aktualizáciu" onPress={() => { void Linking.openURL(updateUrl).catch(() => setError("Odkaz na aktualizáciu sa nepodarilo otvoriť.")); }} />}
    <Button secondary label="Skontrolovať znova" onPress={onRetry} />
    {error && <ErrorNotice message={error} />}
  </Card></View>;
}
