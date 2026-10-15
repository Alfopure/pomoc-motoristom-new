import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { MobileToolFleet, MobileToolFleetFilter } from "../../../src/lib/mobile-tools";
import { MOBILE_TOOL_FLEET_STATUSES } from "../../../src/lib/mobile-tools";
import type { ToolsApi } from "./api";
import type { ToolMapView } from "./route";
import { useToolRequest } from "./use-request";
import { fleetFreshness } from "./fleet-model";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { Choice } from "../cases/form";
import { formatTime } from "../lib/display";

const statusLabels = { all: "Všetky stavy", available: "Dostupné", reserved: "Rezervované", rented: "Prenajaté", assigned: "Priradené", busy: "Obsadené", service: "V servise", offline: "Mimo prevádzky" };
const availabilityLabels = { free: "Overená voľná kapacita", occupied: "Obsadené podľa zdroja", stale: "Starší údaj o obsadenosti", unverified: "Dostupnosť neoverená" };
export function FleetTool({ api, active, view }: { api: ToolsApi; active: boolean; view: (request: ToolMapView) => void }) {
  const [filter, setFilter] = useState<MobileToolFleetFilter>({ q: "", kind: "all", status: "all", offset: 0 });
  const [statusPicker, setStatusPicker] = useState(false), [now, setNow] = useState(Date.now);
  const result = useToolRequest<MobileToolFleet>(active);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, [active]);
  const change = (patch: Partial<MobileToolFleetFilter>) => { result.request.invalidate(); setFilter(previous => ({ ...previous, ...patch, offset: 0 })); };
  const load = (offset = 0) => { if (active) { const next = { ...filter, offset }; setNow(Date.now()); setFilter(next); void result.request.run(signal => api.fleet(next, signal)); } };
  const page = result.data;
  return <>
    <Text style={styles.subheading}>Prehľad flotily</Text>
    <Text style={styles.muted}>Uložené údaje organizácie. Načítanie nevyžiada novú polohu od GPS poskytovateľa.</Text>
    <TextInput accessibilityLabel="Hľadať vozidlo vo flotile" value={filter.q} maxLength={80} editable={active} autoCorrect={false} placeholder="EČV, názov, značka alebo model" style={styles.input} onChangeText={q => change({ q })} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {([['all','Všetky vozidlá'],['tow_truck','Odťahové'],['replacement_car','Náhradné']] as const).map(([kind,label]) => <Choice key={kind} label={label} selected={filter.kind === kind} onPress={() => change({ kind })} />)}
    </View>
    <Button label={`Stav: ${statusLabels[filter.status]}`} secondary disabled={!active} onPress={() => setStatusPicker(true)} />
    {active && statusPicker && <Card><Text style={styles.subheading}>Stav flotily</Text>
      <Button label="Zatvoriť výber stavu" secondary onPress={() => setStatusPicker(false)} />
      {(["all", ...MOBILE_TOOL_FLEET_STATUSES] as const).map(status => <Button key={status} label={statusLabels[status]} secondary disabled={!active} onPress={() => { change({ status }); setStatusPicker(false); }} />)}
    </Card>}
    <Button label={result.busy ? "Načítavam flotilu…" : "Načítať vozidlá"} disabled={!active || result.busy || result.remaining > 0} onPress={() => load()} />
    {result.remaining > 0 && <Text accessibilityRole="alert" style={styles.muted}>Ďalšie načítanie môžete spustiť o {result.remaining} s.</Text>}
    {result.busy && <Loading />}{result.error && <ErrorNotice message={result.error} />}
    {page && <>
      <Text style={styles.muted}>Zobrazené {page.assets.length ? page.selection.offset + 1 : 0}–{page.selection.offset + page.assets.length} z {page.total} · načítané {formatTime(page.checkedAt)}</Text>
      <Text style={styles.muted}>Posledná úspešná GPS synchronizácia: {page.gpsLastSuccessAt ? formatTime(page.gpsLastSuccessAt) : "nezistená"}</Text>
      {page.assets.some(asset => asset.point) && <Button label="Vozidlá tejto strany na mape" secondary disabled={!active} onPress={() => view({ title: "Uložené polohy flotily", seed: { address: "", selection: null, preview: { points: page.assets.flatMap(asset => asset.point ? [{ ...asset.point, label: `${asset.licensePlate || asset.label}${fleetFreshness(asset, now).gpsFresh ? "" : " · staršia/neoverená poloha"}`.slice(0, 200) }] : []) } } })} />}
      {!page.assets.length && <Card><Text style={styles.text}>Pre tento výber nie sú uložené vozidlá.</Text></Card>}
      {page.assets.map(asset => {
        const freshness = fleetFreshness(asset, now);
        return <Card key={asset.id}><Text style={styles.subheading}>{asset.licensePlate || asset.label}</Text>
          <Text style={styles.text}>{[asset.label, asset.make, asset.model].filter(Boolean).join(" · ")}</Text>
          <Text style={styles.muted}>{asset.kind === "tow_truck" ? "Odťahové vozidlo" : "Náhradné vozidlo"} · interný stav: {statusLabels[asset.internalStatus]}</Text>
          <Text style={styles.text}>{availabilityLabels[freshness.availability]}</Text>
          <Text style={styles.muted}>Obsadenosť overená: {asset.occupancyCheckedAt ? formatTime(asset.occupancyCheckedAt) : "čas nie je známy"}</Text>
          <Text style={styles.text}>{!asset.point ? "Poloha nie je známa" : freshness.gpsFresh ? "Aktuálna uložená GPS poloha" : "Staršia alebo neoverená GPS poloha"}</Text>
          {asset.gps && <Text style={styles.muted}>{asset.gps.source} · poloha {asset.gps.positionTime ? formatTime(asset.gps.positionTime) : "bez času"} · synchronizácia {asset.gps.syncedAt ? formatTime(asset.gps.syncedAt) : "bez času"}</Text>}
          {asset.point && <Button label={`Zobraziť uloženú polohu ${asset.licensePlate || asset.label}`} secondary disabled={!active} onPress={() => view({ title: "Uložená poloha vozidla", seed: { address: "", selection: null, preview: { points: [{ ...asset.point!, label: `${asset.licensePlate || asset.label}${freshness.gpsFresh ? "" : " · staršia/neoverená poloha"}`.slice(0, 200) }] } } })} />}
        </Card>;
      })}
      <View style={{ gap: 8 }}>
        {page.selection.offset > 0 && <Button label="Predchádzajúce vozidlá" secondary disabled={!active || result.busy || result.remaining > 0} onPress={() => load(Math.max(0, page.selection.offset - 25))} />}
        {page.nextOffset !== null && <Button label="Ďalšie vozidlá" secondary disabled={!active || result.busy || result.remaining > 0} onPress={() => load(page.nextOffset!)} />}
      </View>
    </>}
  </>;
}
