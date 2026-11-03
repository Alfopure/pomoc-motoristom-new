import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import type { CasesApi } from "./api";
import type { MapRequest, MapSeed } from "./map-bridge";
import { CaseMapFrame } from "./map-frame";
import { DeviceLocation } from "./device-location";
import { prepareDeviceLocation } from "./device-location-adapter";
import { Button, styles } from "../ui";

/** This owner survives its own iOS permission sheet; only the guarded inner
 * map is remounted after a deliberate new phone-position seed. */
export function CasePlacePicker({ api, caseId, target, seed, active, visible, title, selectionNotice, deviceLocationNotice, onClose, onApply }: {
  api: CasesApi; caseId: string | null; target: MapRequest["target"]; seed: MapSeed; active: boolean; visible: boolean;
  title?: string; selectionNotice?: string; deviceLocationNotice?: string;
  onClose: () => void; onApply: (selection: MobileCasePlaceSelection) => void;
}) {
  const [activity, setActivity] = useState<string>(AppState.currentState ?? "active");
  const context = useRef({ active, visible, activity });
  const location = useMemo(() => new DeviceLocation(
    () => prepareDeviceLocation(Platform.OS, Platform.OS !== "web" && requireOptionalNativeModule("ExpoLocation") !== null, () => import("expo-location"))
  ), []);
  const state = useSyncExternalStore(location.subscribe, location.snapshot, location.snapshot);
  const [map, setMap] = useState({ generation: 0, seed });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", value => {
      context.current.activity = value;
      location.context(context.current.visible, value === "inactive" && Platform.OS !== "ios" ? "background" : value);
      setActivity(value);
    });
    return () => { subscription.remove(); location.dispose(); };
  }, [location]);
  useLayoutEffect(() => {
    context.current = { active, visible, activity };
    location.context(visible, activity === "inactive" && Platform.OS !== "ios" ? "background" : activity);
  }, [location, active, visible, activity]);
  const ownPermissionSheet = Platform.OS === "ios" && activity === "inactive" && state.phase === "permission";
  if (!visible || !active && !ownPermissionSheet) return null;
  const busy = state.phase === "permission" || state.phase === "locating";
  const controls = <View style={{ gap: 8 }}>
    <Text style={styles.muted}>{deviceLocationNotice ?? "Poloha tohto telefónu, nie zákazníka. Použite ju iba vtedy, keď ste na mieste zásahu."}</Text>
    <Button label={busy ? "Zisťujem polohu telefónu…" : "Použiť polohu telefónu"} secondary disabled={busy || !active} onPress={() => {
      if (context.current.active && context.current.visible) void location.request();
    }} />
    {busy && <Button label="Zrušiť zisťovanie polohy" secondary onPress={() => location.cancel()} />}
    {state.message && <Text accessibilityRole="alert" style={styles.muted}>{state.message}</Text>}
    {state.fix && <>
      <Text style={styles.text}>Približná presnosť polohy telefónu: {Math.ceil(state.fix.accuracy)} m</Text>
      <Button label="Zobraziť polohu na mape" disabled={!active} onPress={() => {
        if (!context.current.active || !context.current.visible) return;
        const selection = location.selection();
        if (selection) setMap(previous => ({ generation: previous.generation + 1, seed: { selection, address: selection.address } }));
      }} />
    </>}
  </View>;
  return <CaseMapFrame key={map.generation} api={api} caseId={caseId} mode="pick" target={target} seed={map.seed} controls={controls} title={title} selectionNotice={selectionNotice}
    onClose={() => { location.cancel(); onClose(); }} onApply={selection => {
      if (context.current.active && context.current.visible && context.current.activity === "active") onApply(selection);
    }} />;
}
