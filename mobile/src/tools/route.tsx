import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Text, TextInput, View } from "react-native";
import type { MobileToolRoute } from "../../../src/lib/mobile-tools";
import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { formatDrivingDistance, formatDrivingDuration, MAX_ROUTE_INTERMEDIATES } from "../../../src/lib/driving-route";
import type { ToolsApi } from "./api";
import { useToolRequest } from "./use-request";
import { chooseStop, confirmCoordinates, editStop, routeInput, routeNavigationUrl, type RouteStop } from "./route-model";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { formatTime } from "../lib/display";
import type { MapSeed } from "../cases/map-bridge";

export type ToolMapPick = { title: string; seed: MapSeed; onApply: (selection: MobileCasePlaceSelection) => void };
export type ToolMapView = { title: string; seed: MapSeed };
export function RouteTool({ api, active, pick, view }: { api: ToolsApi; active: boolean; pick: (request: ToolMapPick) => void; view: (request: ToolMapView) => void }) {
  const [stops, setStops] = useState<RouteStop[]>([{ id: 1, address: "", selection: null }, { id: 2, address: "", selection: null }]);
  const nextId = useRef(3), context = useRef({ active, generation: 0, navigationEpoch: 0 });
  useLayoutEffect(() => { const state = context.current; state.active = active; return () => { state.active = false; state.navigationEpoch++; }; }, [active]);
  const [error, setError] = useState<string | null>(null);
  const result = useToolRequest<MobileToolRoute>(active);
  const change = (next: RouteStop[]) => { context.current.generation++; result.request.invalidate(); setError(null); setStops(next); };
  const replace = (id: number, next: RouteStop) => change(stops.map(stop => stop.id === id ? next : stop));
  const ready = stops.every(stop => stop.selection !== null);
  const points = () => stops.flatMap((stop, index) => stop.selection ? [{ lat: stop.selection.lat, lng: stop.selection.lng, label: `${index + 1}. ${stop.address}`.slice(0, 200) }] : []);
  return <>
    <Text style={styles.subheading}>Výpočet jazdnej trasy</Text>
    <Text style={styles.muted}>Zvoľte miesta v poradí jazdy. Zmena adresy alebo bodu zruší predchádzajúci výpočet.</Text>
    {stops.map((stop, index) => <RouteStopFields key={stop.id} stop={stop} title={index === 0 ? "Štart" : index === stops.length - 1 ? "Cieľ" : `Bod prejazdu ${index}`} active={active}
      change={next => replace(stop.id, next)} pick={() => {
        const generation = context.current.generation;
        pick({ title: index === 0 ? "Vybrať štart trasy" : index === stops.length - 1 ? "Vybrať cieľ trasy" : `Vybrať bod prejazdu ${index}`, seed: { address: stop.address, selection: stop.selection }, onApply: selection => {
          if (context.current.active && generation === context.current.generation) replace(stop.id, chooseStop(stop, selection));
        } });
      }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {index > 0 && <Button label="Posunúť vyššie" secondary disabled={!active} onPress={() => { const next = [...stops]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; change(next); }} />}
        {index < stops.length - 1 && <Button label="Posunúť nižšie" secondary disabled={!active} onPress={() => { const next = [...stops]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; change(next); }} />}
        {stops.length > 2 && <Button label="Odstrániť bod" secondary disabled={!active} onPress={() => change(stops.filter(item => item.id !== stop.id))} />}
      </View>
    </RouteStopFields>)}
    <Button label="Pridať bod prejazdu" secondary disabled={!active || stops.length >= MAX_ROUTE_INTERMEDIATES + 2} onPress={() => change([...stops.slice(0, -1), { id: nextId.current++, address: "", selection: null }, stops[stops.length - 1]])} />
    <Button label="Otočiť trasu" secondary disabled={!active} onPress={() => change([...stops].reverse())} />
    <Button label={result.busy ? "Počítam trasu…" : "Vypočítať trasu"} disabled={!active || !ready || result.busy || result.remaining > 0} onPress={() => {
      try { const input = routeInput(stops); setError(null); void result.request.run(signal => api.route(input, signal)); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "Skontrolujte body trasy."); }
    }} />
    {!ready && <Text style={styles.muted}>Každé miesto potvrďte na mape alebo zadajte jeho súradnice. Samotná adresa nestačí na výpočet.</Text>}
    {result.remaining > 0 && <Text accessibilityRole="alert" style={styles.muted}>Ďalší výpočet môžete spustiť o {result.remaining} s.</Text>}
    {result.busy && <Loading label="Počítam jazdnú vzdialenosť…" />}
    {(error || result.error) && <ErrorNotice message={error || result.error!} />}
    {result.data && <Card>
      <Text style={styles.subheading}>{formatDrivingDistance(result.data.route.distanceMeters)}</Text>
      <Text style={styles.text}>Čas jazdy približne {formatDrivingDuration(result.data.route.durationSeconds)}</Text>
      <Text style={styles.muted}>Google Maps · {formatTime(result.data.route.calculatedAt)}. Odhad pri odchode teraz podľa dostupnej dopravy, bez prestávok.</Text>
      {result.data.route.legs.map((leg, index) => <Text key={index} style={styles.muted}>Úsek {index + 1}: {formatDrivingDistance(leg.distanceMeters)} · {formatDrivingDuration(leg.durationSeconds)}</Text>)}
      <Button label="Zobraziť vypočítanú trasu" secondary disabled={!active} onPress={() => view({ title: "Vypočítaná trasa", seed: { address: "", selection: null, preview: { points: points(), encodedPolyline: result.data!.route.encodedPolyline } } })} />
      <Button label="Otvoriť navigáciu" disabled={!active} onPress={() => {
        const generation = context.current.generation, navigationEpoch = context.current.navigationEpoch;
        try { const url = routeNavigationUrl(stops); if (context.current.active) void Linking.openURL(url).catch(() => { if (context.current.active && context.current.generation === generation && context.current.navigationEpoch === navigationEpoch) setError("Navigáciu sa nepodarilo otvoriť."); }); }
        catch (caught) { setError(caught instanceof Error ? caught.message : "Navigáciu sa nepodarilo otvoriť."); }
      }} />
    </Card>}
  </>;
}

export function RouteStopFields({ stop, title, active, change, pick, children }: { stop: RouteStop; title: string; active: boolean; change: (stop: RouteStop) => void; pick: () => void; children?: ReactNode }) {
  const [coordinates, setCoordinates] = useState(false), [lat, setLat] = useState(""), [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  return <Card><Text style={styles.subheading}>{title}</Text>
    <TextInput accessibilityLabel={`${title} – adresa`} placeholder="Adresa alebo názov miesta" value={stop.address} maxLength={500} editable={active} style={styles.input} onChangeText={text => { setError(null); change(editStop(stop, text)); }} />
    {stop.selection && <Text style={styles.muted}>Potvrdený bod: {stop.selection.lat.toFixed(6)}, {stop.selection.lng.toFixed(6)}{stop.selection.provider === "approximate" ? " · približná poloha telefónu" : ""}</Text>}
    <Button label={`${title} – vybrať na mape`} secondary disabled={!active} onPress={pick} />
    <Button label={coordinates ? "Skryť súradnice" : "Zadať súradnice"} secondary disabled={!active} onPress={() => setCoordinates(value => !value)} />
    {coordinates && <>
      <TextInput accessibilityLabel={`${title} – zemepisná šírka`} placeholder="Zemepisná šírka, napr. 48.1486" value={lat} editable={active} maxLength={24} style={styles.input} onChangeText={value => { setLat(value); setError(null); change(editStop(stop, stop.address)); }} />
      <TextInput accessibilityLabel={`${title} – zemepisná dĺžka`} placeholder="Zemepisná dĺžka, napr. 17.1077" value={lng} editable={active} maxLength={24} style={styles.input} onChangeText={value => { setLng(value); setError(null); change(editStop(stop, stop.address)); }} />
      <Button label="Potvrdiť súradnice" disabled={!active} onPress={() => { try { change(confirmCoordinates(stop, lat, lng)); setError(null); } catch (caught) { setError(caught instanceof Error ? caught.message : "Skontrolujte súradnice."); } }} />
    </>}
    {error && <Text accessibilityRole="alert" style={styles.text}>{error}</Text>}{children}
  </Card>;
}
