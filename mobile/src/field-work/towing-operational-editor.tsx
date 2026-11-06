import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { TowingFields } from "../../../src/domain/towing/types";
import type { MobileTowingDriverFields, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { formLayout } from "../design/form";
import { Button, ErrorNotice } from "../ui";
import type { FieldWorkSession } from "./session";
import { TowingFieldsForm } from "./towing-form";

const editable = ["serviceType", "subjectType", "subjectDescription", "plate", "vin", "odometer", "pickup", "destination", "contact", "noContactReason", "branchId", "fleetAssetId", "plannedAt", "requesterType", "requester", "requesterId", "assistancePartnerId", "assistanceReference", "parkingId"] as const;
export function operationalTowingFields(order: MobileTowingOrder): TowingFields {
  return Object.fromEntries(Object.entries(order.fields).filter(([, value]) => value !== undefined && value !== null)) as unknown as TowingFields;
}
export function TowingOperationalEditor({ session, order, disabled, onSave, onDirtyChange }: {
  session: FieldWorkSession; order: MobileTowingOrder; disabled: boolean;
  onSave: (fields: MobileTowingDriverFields) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<TowingFields | null>(null), [base, setBase] = useState<TowingFields | null>(null), [revision, setRevision] = useState(order.revision);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [valid, setValid] = useState(true);
  const options = useQuery({ queryKey: [...session.key, "towing-options", session.memberId], queryFn: ({ signal }) => session.api.towingOptions(signal), enabled: draft !== null, staleTime: 300000 });
  const changed = draft && base ? editable.filter(key => JSON.stringify(draft[key] ?? null) !== JSON.stringify(base[key] ?? null)) : [];
  useEffect(() => { onDirtyChange(changed.length > 0); }, [changed.length, onDirtyChange]);
  const open = () => { const current = operationalTowingFields(order); setDraft(current); setBase(current); setRevision(order.revision); setError(null); };
  return <>
    <View style={formLayout.actions}><Button secondary label={draft ? "Zavrieť úpravu zadania" : "Upraviť objednávateľa, trasu a techniku"} disabled={disabled || saving} onPress={() => {
      if (!draft) open();
      else if (changed.length) Alert.alert("Zahodiť zmeny zadania?", "Tieto zmeny ešte nie sú uložené.", [{ text: "Pokračovať v úprave", style: "cancel" }, { text: "Zahodiť", style: "destructive", onPress: () => setDraft(null) }]);
      else setDraft(null);
    }} /></View>
    {draft ? <>
      {error || options.isError ? <View style={formLayout.notices}><ErrorNotice message={error ?? "Výbery sa nepodarilo načítať."} onRetry={() => { void options.refetch(); }} />
        {error && order.revision !== revision ? <Button secondary label="Načítať aktuálne údaje" onPress={() => Alert.alert("Nahradiť rozpracované údaje?", "Vaše neuložené zmeny zadania sa zahodia.", [{ text: "Zostať", style: "cancel" }, { text: "Načítať", onPress: open }])} /> : null}</View> : null}
      <TowingFieldsForm value={draft} onChange={setDraft} options={options.data} disabled={disabled || saving} complete={false} onValidityChange={setValid} />
      <View style={formLayout.actions}><Button primary label={saving ? "Ukladám…" : "Uložiť údaje zadania"} disabled={disabled || saving || !valid || !changed.length} onPress={() => {
        if (revision !== order.revision) { setError("Zákazka sa počas úpravy zmenila. Pred uložením načítajte aktuálne údaje."); return; }
        setSaving(true); setError(null);
        const fields = Object.fromEntries(changed.map(key => [key, draft[key] ?? null])) as MobileTowingDriverFields;
        void onSave(fields).then(ok => { if (ok) setDraft(null); }).catch(cause => setError(cause instanceof Error ? cause.message : "Údaje sa nepodarilo uložiť." )).finally(() => setSaving(false));
      }} /></View>
    </> : null}
  </>;
}
