import type { ReactNode } from "react";
import { MapPinned } from "lucide-react-native";
import type { MobileCaseJobType, MobileCasePriority } from "../../../src/lib/mobile-api";
import { ChoiceField, Field, FieldAction, FormSection } from "../design/form";
import { Choice, fields, jobTypes, priorities, type CaseFieldKey } from "./form";

const sections = ["Kontakt", "Vozidlo", "Miesto", "Problém"] as const;
type Place = "pickup" | "destination";

/** The text fields of a new or edited case, grouped as on the case detail. */
export function CaseFieldSections({ value, onChange, editable, onMap, mapDisabled, footers }: {
  value: (key: CaseFieldKey) => string; onChange: (key: CaseFieldKey, text: string) => void; editable: boolean;
  onMap: (target: Place) => void; mapDisabled: boolean; footers?: Partial<Record<(typeof sections)[number], string>>;
}) {
  return <>{sections.map(section => <FormSection key={section} title={section} footer={footers?.[section]}>
    {fields.filter(field => field.section === section).map(field => {
      const place: Place | null = field.key === "manualPickupAddress" ? "pickup" : field.key === "manualDestinationAddress" ? "destination" : null;
      return <Field key={field.key} label={field.label} placeholder={field.placeholder} value={value(field.key)} onChangeText={text => onChange(field.key, text)} editable={editable}
        maxLength={field.max} multiline={field.multiline} keyboardType={field.key === "contactPhone" ? "phone-pad" : "default"}
        autoCapitalize={field.key === "licensePlate" ? "characters" : "sentences"} autoCorrect={field.key !== "licensePlate" && field.key !== "contactPhone"}
        action={place && <FieldAction icon={MapPinned} label="Na mape" accessibilityLabel={"Vybrať miesto na mape: " + field.label} disabled={mapDisabled} onPress={() => onMap(place)} />} />;
    })}
  </FormSection>)}</>;
}

/** Service and priority chips; the editor adds the status below them. */
export function CaseServiceSection({ selectedJobs, priority, disabled, onJobs, onPriority, footer, children }: {
  selectedJobs: readonly MobileCaseJobType[]; priority: MobileCasePriority | undefined; disabled: boolean;
  onJobs: (value: MobileCaseJobType[]) => void; onPriority: (value: MobileCasePriority) => void; footer?: string | null; children?: ReactNode;
}) {
  return <FormSection title="Služba a priorita" footer={footer}>
    <ChoiceField label="Služba">{jobTypes.map(item => {
      const selected = selectedJobs.includes(item.value);
      return <Choice key={item.value} label={item.label} selected={selected} disabled={disabled}
        onPress={() => onJobs(selected ? selectedJobs.filter(value => value !== item.value) : [...selectedJobs, item.value])} />;
    })}</ChoiceField>
    <ChoiceField label="Priorita">{priorities.map(item => <Choice key={item.value} label={item.label} selected={priority === item.value} disabled={disabled}
      onPress={() => onPriority(item.value)} />)}</ChoiceField>
    {children}
  </FormSection>;
}
