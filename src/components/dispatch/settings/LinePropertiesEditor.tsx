"use client";

import type { RoutingDocument } from "@/server/telephony/config-service";
import type { LineProperties } from "./line-workspace-model";
import styles from "./incoming-flow.module.css";

export function LinePropertiesEditor({ value, lineId, document, disabled, hasFlow = false, onChange }: { value: LineProperties; lineId: string; document: RoutingDocument; disabled: boolean; hasFlow?: boolean; onChange: (value: LineProperties) => void }) {
  const set = (patch: Partial<LineProperties>) => onChange({ ...value, ...patch });
  return <section className={styles.lineProperties} aria-label="Nastavenie vybranej linky">
    <div className={styles.propertyFields}>
      <label>Názov linky<input maxLength={180} disabled={disabled} value={value.label} onChange={event => set({ label: event.target.value })} /></label>
      <label>Partner<input maxLength={180} disabled={disabled} value={value.partnerName ?? ""} placeholder="Bez partnera" onChange={event => set({ partnerName: event.target.value || null })} /></label>
    </div>
    <label className={styles.toggle}><input type="checkbox" disabled={disabled} checked={value.active} onChange={event => set({ active: event.target.checked })} />Linka je aktívna</label>
    <details className={styles.advancedProperties}><summary>Pokročilé nastavenia linky</summary><div className={styles.propertyFields}>
      <label>Otváracie hodiny<select disabled={disabled} value={value.businessHoursId ?? ""} onChange={event => set({ businessHoursId: event.target.value || null })}><option value="">Nonstop</option>{document.businessHours.map(hours => <option key={hours.id} value={hours.id}>{hours.name}{hours.active ? "" : " (vypnuté)"}</option>)}</select></label>
      <label>Prostredie<select disabled={disabled} value={value.environment} onChange={event => set({ environment: event.target.value as LineProperties["environment"] })}><option value="production">Produkcia</option><option value="development">Test / vývoj</option></select></label>
      {!hasFlow && <>
        <label>Spoločné smerovanie<select disabled={disabled} value={value.returnLineId ?? ""} onChange={event => set({ returnLineId: event.target.value || null })}><option value="">Vlastné smerovanie</option>{document.lines.filter(line => line.id !== lineId && line.active && !line.returnLineId && line.environment === value.environment).map(line => <option key={line.id} value={line.id}>{line.label} · {line.phoneNumber}</option>)}</select></label>
        <label>Plán zvonenia<select disabled={disabled} value={value.ringPlanId ?? ""} onChange={event => set({ ringPlanId: event.target.value || null })}><option value="">Bez plánu</option>{document.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}{plan.active ? "" : " (vypnutý)"}</option>)}</select></label>
        <label>Hlasové menu<select disabled={disabled} value={value.ivrMenuId ?? ""} onChange={event => set({ ivrMenuId: event.target.value || null })}><option value="">Bez hlasového menu</option>{document.ivrMenus.map(menu => <option key={menu.id} value={menu.id}>{menu.name}{menu.active ? "" : " (vypnuté)"}</option>)}</select></label>
        <label>Prijatie hovoru<select disabled={disabled} value={value.inboundCallMode ?? ""} onChange={event => set({ inboundCallMode: (event.target.value || null) as LineProperties["inboundCallMode"] })}><option value="">Predvolené nastavenie</option><option value="ring_first">Podľa plánu zvonenia</option><option value="ring_all">Všetci naraz</option><option value="ring_ordered">Postupne</option><option value="queue_first">Najprv čakáreň</option></select></label>
      </>}
    </div>{hasFlow && <p className={styles.note}>Zvonenie nastavuješ v krokoch nižšie.</p>}</details>
  </section>;
}
