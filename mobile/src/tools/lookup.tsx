import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { MobileToolLookup } from "../../../src/lib/mobile-tools";
import { isCzechPlate, isSlovakPlate, isVin, normalizeVehicleIdentifier, preferredVehicleFacts, vehicleFactConflicts, vehicleFieldLabels, vehicleSourceLabels, type VehicleCountry, type VehicleField, type VehicleLookupResult } from "../../../src/lib/vehicle-lookup";
import type { ToolsApi } from "./api";
import { useToolRequest } from "./use-request";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { Choice } from "../cases/form";
import { formatTime } from "../lib/display";

const sourceStatus = { found: "Údaje nájdené", not_found: "Zdroj nenašiel záznam", ambiguous: "Viac možných vozidiel", challenge_required: "Vyžaduje sa overenie u zdroja", rate_limited: "Zdroj dočasne obmedzil požiadavky", unavailable: "Zdroj nie je dostupný", unsupported: "Zdroj tento dotaz nepodporuje" };
export function VehicleLookup({ api, active }: { api: ToolsApi; active: boolean }) {
  const [value, setValue] = useState(""), [country, setCountry] = useState<VehicleCountry>("SK");
  const [expanded, setExpanded] = useState<string[]>([]);
  const result = useToolRequest<MobileToolLookup>(active);
  const normalized = normalizeVehicleIdentifier(value);
  const valid = isVin(normalized) || (country === "CZ" ? isCzechPlate(normalized) : isSlovakPlate(normalized));
  const clear = () => { result.request.invalidate(); setExpanded([]); };
  const sourceResult: VehicleLookupResult | null = result.data ? { version: 1, query: result.data.query, ...result.data.result, sources: result.data.result.sources.map(source => ({ ...source, url: "" })) } : null;
  const facts = sourceResult ? preferredVehicleFacts(sourceResult) : {}, conflicts = sourceResult ? vehicleFactConflicts(sourceResult, true) : {};
  const description = !result.data?.conflict && [!conflicts.make && facts.make?.value, !conflicts.model && facts.model?.value].filter(Boolean).join(" ");
  return <>
    <Text style={styles.subheading}>Overenie EČV / VIN</Text>
    <Text style={styles.muted}>Technické údaje slovenských a českých vozidiel. Dostupnosť PZP závisí od zdroja.</Text>
    <Text style={styles.label}>Krajina evidencie</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {(["SK", "CZ"] as const).map(item => <Choice key={item} label={item === "SK" ? "Slovensko" : "Česko"} selected={country === item} onPress={() => { clear(); setCountry(item); }} />)}
    </View>
    <TextInput accessibilityLabel="EČV alebo VIN" value={value} maxLength={30} editable={active} autoCapitalize="characters" autoCorrect={false} placeholder="EČV alebo 17-miestny VIN" style={styles.input}
      onChangeText={text => { clear(); setValue(text.toUpperCase()); }} />
    <Button label={result.busy ? "Overujem vozidlo…" : "Overiť vozidlo"} disabled={!active || !valid || result.busy || result.remaining > 0} onPress={() => {
      if (active && valid) void result.request.run(signal => api.lookup({ kind: isVin(normalized) ? "vin" : "plate", value: normalized, country }, signal));
    }} />
    {result.remaining > 0 && <Text accessibilityRole="alert" style={styles.muted}>Ďalšie overenie môžete spustiť o {result.remaining} s.</Text>}
    {result.busy && <Loading label="Načítavam dostupné zdroje…" />}
    {result.error && <ErrorNotice message={result.error} />}
    {result.data && <>
      <Card><Text style={styles.subheading}>{result.data.query.value}</Text>
        {description && <Text style={styles.text}>{description}</Text>}
        <Text style={styles.muted}>{result.data.cached ? "Predchádzajúce overenie" : "Získané údaje"}: {formatTime(result.data.result.fetchedAt)}</Text>
        <Text style={styles.muted}>Overované ku dňu {result.data.query.checkedForDate}</Text>
        {result.data.conflict && <Text accessibilityRole="alert" style={styles.text}>Overte identitu vozidla: {result.data.conflict} PZP tohto vozidla nie je potvrdené.</Text>}
        <Text style={styles.text}>Chýbajúci alebo nedostupný výsledok neznamená, že vozidlo nie je poistené.</Text>
      </Card>
      {result.data.result.sources.map(source => <Card key={source.source}>
        <Text style={styles.subheading}>{vehicleSourceLabels[source.source]}</Text>
        <Text style={styles.text}>{sourceStatus[source.status]}</Text>
        <Text style={styles.muted}>{formatTime(source.fetchedAt)}</Text>
        {source.source === "haka" && <Text style={styles.muted}>Hlásenie HAKA nie je overením technických údajov ani poistenia.</Text>}
        {source.warnings.map((warning, index) => <Text key={index} accessibilityRole="alert" style={styles.muted}>{warning}</Text>)}
        {source.candidates.length > 0 && <Text style={styles.text}>Možné identity: {source.candidates.map(candidate => [candidate.plate, candidate.vin, candidate.country].filter(Boolean).join(" · ")).join("; ")}</Text>}
        {Object.keys(source.facts).length > 0 && <Button secondary label={expanded.includes(source.source) ? "Skryť údaje zdroja" : "Zobraziť údaje zdroja"} onPress={() => setExpanded(previous => previous.includes(source.source) ? previous.filter(item => item !== source.source) : [...previous, source.source])} />}
        {expanded.includes(source.source) && Object.entries(source.facts).map(([field, fact]) => {
          if (!fact) return null;
          const alternatives = conflicts[field as VehicleField]?.filter(other => other.source !== source.source) ?? [];
          return <View key={field} style={{ gap: 3 }}><Text style={styles.label}>{vehicleFieldLabels[field as VehicleField]}</Text><Text selectable style={styles.text}>{fact.value}</Text>
            <Text style={styles.muted}>{fact.quality === "partial" ? "Čiastočný údaj / návrh" : fact.quality === "decoded" ? "Dekódovaný údaj" : "Údaj zdroja"}</Text>
            {source.source !== "haka" && alternatives.length > 0 && <Text accessibilityRole="alert" style={styles.muted}>Rozdielne údaje: {alternatives.map(other => vehicleSourceLabels[other.source]).join(", ")}. Overte ich pred použitím.</Text>}
          </View>;
        })}
      </Card>)}
      {!result.data.result.sources.length && <Card><Text style={styles.text}>Žiadny zdroj neposkytol výsledok. Vozidlo ani poistenie sa nepodarilo overiť.</Text></Card>}
    </>}
  </>;
}
