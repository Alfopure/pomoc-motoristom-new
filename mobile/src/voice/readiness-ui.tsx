import { useState } from "react";
import { Linking, Text, View } from "react-native";
import type { MobileConsole, MobileVoiceReadiness } from "../../../src/lib/mobile-api";
import { Button, Card, colors, ErrorNotice, styles } from "../ui";
import type { PhoneState } from "./phone";
import { phoneReadiness } from "./readiness";

export function PhoneReadinessCard({ state, configuration, configurationError, presence, checking, onRefresh, onConnect, onTakeover }: {
  state: PhoneState; configuration?: MobileVoiceReadiness; configurationError: boolean;
  presence?: MobileConsole["presence"]["status"]; checking: boolean;
  onRefresh: () => void; onConnect: () => void; onTakeover: () => void;
}) {
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const status = phoneReadiness({ state, configuration, configurationError, presence });
  return <Card>
    <Text style={styles.label}>Stav telefónu</Text>
    <Text accessibilityRole="header" style={styles.subheading}>{status.title}</Text>
    <Text style={styles.muted}>{status.message}</Text>
    {status.checks.map(check => <View key={check.key} style={{ gap: 3 }}>
      <Text style={styles.label}>{check.label}</Text>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <View accessible={false} style={{ marginTop: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: check.tone === "success" ? colors.success : colors.muted }} />
        <Text style={[styles.muted, { flex: 1 }]}>{check.value}</Text>
      </View>
    </View>)}
    {state.error && <ErrorNotice message={state.error} />}
    {state.diagnosticsError && <ErrorNotice message={state.diagnosticsError} />}
    {settingsError && <ErrorNotice message={settingsError} />}
    {state.supported && state.microphonePermission === "denied" && <Button label="Otvoriť nastavenia mikrofónu" secondary onPress={() => {
      setSettingsError(null); void Linking.openSettings().catch(() => setSettingsError("Nastavenia sa nepodarilo otvoriť. Otvorte ich ručne na iPhone."));
    }} />}
    {status.canConnect && !status.canTakeover && <Button label="Pripojiť telefón" onPress={onConnect} />}
    {status.canTakeover && <Button label="Prevziať telefón na tomto iPhone" secondary onPress={onTakeover} />}
    <Button label={checking ? "Overujem stav…" : "Obnoviť stav telefónu"} secondary disabled={checking} onPress={onRefresh} />
  </Card>;
}
