"use client";

import { Plus, Trash2 } from "lucide-react";
import type { TowingFields, TowingWorkspace } from "@/domain/towing/types";
import { Button, Field, Panel, Select, TextArea } from "./primitives";
import { isoDateInput, localDateInput, paymentIntentLabels, serviceLabels } from "./model";
import styles from "./towing.module.css";

export function RealizationFields({ fields, onChange, workspace }: { fields: TowingFields; onChange: (fields: TowingFields) => void; workspace: TowingWorkspace }) {
  const items = fields.realizedItems ?? [];
  const update = (index: number, patch: Partial<NonNullable<TowingFields["realizedItems"]>[number]>) => onChange({ ...fields, realizedItems: items.map((item, position) => position === index ? { ...item, ...patch } : item) });
  return <><Panel title="Realizované úkony a úhrada">
    <div className={styles.grid3}>
      <Select label="Dohodnutá forma úhrady" value={fields.paymentIntent ?? ""} onChange={event => onChange({ ...fields, paymentIntent: event.target.value as TowingFields["paymentIntent"] || null })}><option value="">Zatiaľ neurčená</option>{Object.entries(paymentIntentLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
      <Field label="Stav tachometra (km)" inputMode="decimal" value={fields.odometer ?? ""} onChange={event => onChange({ ...fields, odometer: event.target.value.replace(",", ".") })} />
    </div>
    <p className={styles.footer}>Vykonané úkony sú podklad na nacenenie kanceláriou. Dohodnutá forma úhrady nepotvrdzuje prijatie peňazí.</p>
    <div className={styles.realizedList}>{items.map((item, index) => <div key={item.id} className={styles.realizedItem}>
      <div className={styles.realizedRow}>
        <Select label={`Úkon ${index + 1}: druh`} value={item.kind} onChange={event => update(index, { kind: event.target.value as typeof item.kind })}>{Object.entries(serviceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Field label={`Úkon ${index + 1}: opis`} value={item.description} onChange={event => update(index, { description: event.target.value })} />
        <Field label={`Úkon ${index + 1}: množstvo`} inputMode="decimal" value={item.quantity} onChange={event => update(index, { quantity: event.target.value.replace(",", ".") })} />
        <Field label={`Úkon ${index + 1}: jednotka`} value={item.unit} onChange={event => update(index, { unit: event.target.value })} />
        <Button aria-label={`Odstrániť realizovaný úkon ${index + 1}`} onClick={() => onChange({ ...fields, realizedItems: items.filter((_, position) => position !== index) })}><Trash2 size={16} /></Button>
      </div>
      {item.kind === "storage" && <div className={styles.grid}><Select label={`Úkon ${index + 1}: parkovisko`} value={item.parkingId ?? ""} onChange={event => { const site = workspace.parking?.find(site => site.id === event.target.value); update(index, { parkingId: site?.id, destination: site?.address ?? "" }); }}><option value="">Vyberte parkovisko</option>{workspace.parking?.map(site => <option key={site.id} value={site.id} disabled={!site.active}>{site.name} · {site.address}</option>)}</Select><Field label={`Úkon ${index + 1}: miesto uloženia`} value={item.destination ?? ""} onChange={event => update(index, { destination: event.target.value })} /></div>}
      {["tow", "transport", "relocation"].includes(item.kind) && <Field label={`Úkon ${index + 1}: cieľ`} value={item.destination ?? ""} onChange={event => update(index, { destination: event.target.value })} />}
    </div>)}</div>
    <div className={styles.actions}><Select label="Pridať realizovaný úkon" value="" disabled={items.length >= 50} onChange={event => { const kind = event.target.value as keyof typeof serviceLabels; if (kind) onChange({ ...fields, realizedItems: [...items, { id: crypto.randomUUID(), kind, description: serviceLabels[kind], quantity: "1", unit: "úkon", ...(["tow", "transport", "relocation"].includes(kind) && fields.destination ? { destination: fields.destination } : {}) }] }); }}><option value="">+ Vybrať úkon…</option>{Object.entries(serviceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select><span className={styles.muted}><Plus size={14} aria-hidden="true" /> Každý úkon má vlastné množstvo a miesto.</span></div>
  </Panel><Panel title="Odovzdanie vozidla"><div className={styles.grid}>
    <Field label="Komu bolo vozidlo odovzdané" placeholder="Meno príjemcu / servis" value={fields.handoverRecipientName ?? ""} maxLength={300} onChange={event => onChange({ ...fields, handoverRecipientName: event.target.value })} />
    <Field label="Čas odovzdania vozidla" type="datetime-local" value={localDateInput(fields.handedOverAt)} onChange={event => onChange({ ...fields, handedOverAt: isoDateInput(event.target.value) })} />
    </div><details className={styles.details} open={Boolean(fields.handoverException) || undefined}><summary>Výnimka z potvrdenia odovzdania</summary><TextArea label="Dôvod výnimky pri odovzdaní" value={fields.handoverException ?? ""} maxLength={2000} onChange={event => onChange({ ...fields, handoverException: event.target.value })} /></details>
  </Panel></>;
}
