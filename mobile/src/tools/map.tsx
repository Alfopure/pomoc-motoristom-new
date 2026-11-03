import { useLayoutEffect, useRef, useState } from "react";
import { Linking, Text } from "react-native";
import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { CopyValue } from "../cases/copy";
import { directionsUrl } from "../cases/maps";
import { Button, Card, ErrorNotice, styles } from "../ui";
import type { ToolMapPick } from "./route";

export function MapTool({ active, scopeKey, pick }: { active: boolean; scopeKey: string; pick: (request: ToolMapPick) => void }) {
  const [selection, setSelection] = useState<MobileCasePlaceSelection | null>(null), [error, setError] = useState<string | null>(null);
  const context = useRef({ active, generation: 0 });
  useLayoutEffect(() => { const state = context.current; state.active = active; return () => { state.active = false; state.generation++; }; }, [active]);
  return <>
    <Text style={styles.muted}>Vyhľadajte adresu alebo označte miesto na mape. Polohu telefónu použijeme až na váš pokyn.</Text>
    <Button label={selection ? "Vybrať iné miesto" : "Otvoriť mapu a vybrať miesto"} disabled={!active} onPress={() => pick({ title: "Vybrať miesto na mape", seed: { selection, address: selection?.address ?? "" },
      onApply: next => { if (context.current.active) { context.current.generation++; setError(null); setSelection(next); } } })} />
    {error && <ErrorNotice message={error} />}
    {selection && <Card><Text style={styles.subheading}>{selection.address}</Text>
      <Text selectable style={styles.text}>{selection.lat.toFixed(6)}, {selection.lng.toFixed(6)}</Text>
      <Text style={styles.muted}>{selection.provider === "approximate" ? "Približná poloha tohto telefónu" : selection.provider === "google_places" ? "Vybrané miesto Google Maps" : "Ručne vybrané miesto"}</Text>
      <Button label="Navigovať na vybrané miesto" disabled={!active} onPress={() => {
        const generation = context.current.generation;
        if (context.current.active) void Linking.openURL(directionsUrl(`${selection.lat},${selection.lng}`)).catch(() => { if (context.current.active && context.current.generation === generation) setError("Navigáciu sa nepodarilo otvoriť."); });
      }} />
      <CopyValue label="Kopírovať adresu" value={selection.address} scopeKey={scopeKey} active={active} />
      <CopyValue label="Kopírovať súradnice" value={`${selection.lat}, ${selection.lng}`} scopeKey={scopeKey} active={active} />
    </Card>}
  </>;
}
