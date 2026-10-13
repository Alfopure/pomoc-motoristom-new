"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, FileDown, MapPin, Phone, Plus, Save, Trash2 } from "lucide-react";
import type { TowingCommand, TowingFields, TowingLine, TowingOrder, TowingWorkspace } from "@/domain/towing/types";
import { towingClient, documentUrl, fileUrl, deliveryStatus } from "./client";
import { Button, Field, Notice, Panel, Select, TextArea } from "./primitives";
import { OrderFields } from "./OrderFields";
import { billingLabels, dateTime, euro, inputMoney, navigationUrl, orderTitle, parseCents, paymentLabels, workLabels, workTone } from "./model";
import styles from "./towing.module.css";
import { calculateTowingLine } from "@/domain/towing/money";
import { prepareTowingImage } from "./images";

export type SendCommand = (command: Omit<TowingCommand, "commandId">, success: string | ((result: unknown) => string)) => Promise<boolean>;
export type RunOperation = (key: string, operation: () => Promise<unknown>, success: string | ((result: unknown) => string)) => Promise<boolean>;

export function OrderDetail({ order, workspace, send, run, busy, onBack }: { order: TowingOrder; workspace: TowingWorkspace; send: SendCommand; run: RunOperation; busy: boolean; onBack: () => void }) {
  const driver = workspace.view === "driver";
  const caps = workspace.actor.capabilities;
  const [tab, setTab] = useState("details");
  const [fields, setFields] = useState<TowingFields>(order.fields);
  const [officeNotes, setOfficeNotes] = useState(order.officeNotes ?? "");
  const [collection, setCollection] = useState(inputMoney(order.authorizedCollectionCents));
  const [reason, setReason] = useState("");
  const [driverId, setDriverId] = useState(order.driverId ?? "");
  const [conflict, setConflict] = useState(false);
  const previousOrder = useRef(order);
  const serializeFields = (value: TowingFields) => JSON.stringify(value, (_key, item) => item === null ? undefined : item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  useEffect(() => {
    const previous = previousOrder.current;
    if (previous.revision === order.revision) return;
    const fieldsEdited = serializeFields(fields) !== serializeFields(previous.fields);
    if (!fieldsEdited || serializeFields(fields) === serializeFields(order.fields)) setFields(order.fields);
    else if (serializeFields(previous.fields) !== serializeFields(order.fields)) setConflict(true);
    if (officeNotes === (previous.officeNotes ?? "") || officeNotes === (order.officeNotes ?? "")) setOfficeNotes(order.officeNotes ?? "");
    else if (previous.officeNotes !== order.officeNotes) setConflict(true);
    if (collection === inputMoney(previous.authorizedCollectionCents) || collection === inputMoney(order.authorizedCollectionCents)) setCollection(inputMoney(order.authorizedCollectionCents));
    else if (previous.authorizedCollectionCents !== order.authorizedCollectionCents) setConflict(true);
    setDriverId(order.driverId ?? "");
    previousOrder.current = order;
  }, [collection, fields, officeNotes, order]);
  const dirty = serializeFields(fields) !== serializeFields(order.fields) || officeNotes !== (order.officeNotes ?? "") || collection !== inputMoney(order.authorizedCollectionCents);
  const canEdit = driver || caps.includes("operate");
  const blocked = busy || dirty || conflict;
  const base = { targetId: order.id, expectedRevision: order.revision, ...(driver ? { assignmentGeneration: order.assignmentGeneration } : {}) };
  const change = (type: TowingCommand["type"], payload: Record<string, unknown>, success: string | ((result: unknown) => string)) => send({ ...base, type, payload }, success);
  const save = async () => {
    const amount = collection === "" ? null : parseCents(collection);
    if (!driver && collection !== "" && amount === null) return;
    const driverFields = Object.fromEntries(["startedAt", "finishedAt", "driverNotes", "performedQuantity", "photoException", "destination"].map(key => [key, fields[key as keyof TowingFields] ?? null]));
    await change("update_order", driver ? { fields: driverFields } : { fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null])), officeNotes, authorizedCollectionCents: amount }, "Údaje zákazky sú uložené.");
  };
  const tabs = [{ id: "details", label: "Údaje" }, { id: "photos", label: `Fotografie (${order.attachments.filter(attachment => attachment.status !== "abandoned").length})` }, ...(!driver && caps.includes("price") ? [{ id: "price", label: "Nacenenie" }] : []), ...(driver || caps.includes("bill") ? [{ id: "payments", label: "Úhrady" }] : []), ...(!driver && caps.includes("documents") ? [{ id: "documents", label: "Doklady" }] : []), ...(!driver ? [{ id: "history", label: "História" }] : [])];
  return <>
    <Button onClick={() => { if (!dirty || window.confirm("Máte neuložené údaje. Opustiť zákazku a zahodiť tieto úpravy?")) onBack(); }} disabled={busy}><ArrowLeft size={16} /> Späť na zákazky</Button>
    <div className={styles.titleRow} style={{ marginTop: 22 }}><div><p className={styles.muted}>{order.number}</p><h1 className={styles.title}>{orderTitle(order)}</h1></div><div className={styles.stack}><span className={styles.badge} data-tone={workTone(order.workStatus)}>{workLabels[order.workStatus]}</span><span className={styles.badge}>{billingLabels[order.billingStatus]}</span><span className={styles.badge} data-tone={order.paymentStatus === "paid" ? "green" : "amber"}>{paymentLabels[order.paymentStatus]}</span></div></div>
    {order.reconciliationRequired && <Notice kind="error">Finančná výnimka vyžaduje kontrolu kancelárie. Potvrdené platby ostávajú v evidencii.</Notice>}
    <div className={styles.route}><div><MapPin size={18} /><span><strong>Nakládka</strong><br />{order.fields.pickup || "Miesto zatiaľ chýba"}</span></div>{order.fields.destination && <div><MapPin size={18} /><span><strong>Vykládka</strong><br />{order.fields.destination}</span></div>}</div>
    <div className={styles.actions}>{order.fields.contact && <a className={styles.button} href={`tel:${order.fields.contact.replace(/[^+\d]/g, "")}`}><Phone size={17} /> {order.fields.contact}</a>}{order.fields.pickup && <a className={styles.button} target="_blank" rel="noreferrer" href={navigationUrl(order.fields.pickup)}><MapPin size={17} /> Navigovať na nakládku</a>}{order.fields.destination && <a className={styles.button} target="_blank" rel="noreferrer" href={navigationUrl(order.fields.destination)}>Navigovať na vykládku</a>}</div>
    {driver && <p className={styles.footer}>Navigácia otvorí mapy v samostatnom okne; vyžaduje dostupné mapové údaje.</p>}
    {dirty && <Notice>Máte neuložené údaje. Pred ďalšou akciou ich uložte. <Button onClick={() => void save()} disabled={busy || conflict}><Save size={16} /> Uložiť zmeny</Button></Notice>}
    {conflict && <Notice kind="error">Aktuálna serverová verzia sa líši od vašich úprav. Údaje vo formulári ostali zachované. Porovnajte ich pred uložením.<details className={styles.details}><summary>Aktuálne údaje zo servera (verzia {order.revision})</summary><div className={styles.stack}>{Object.entries(order.fields).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([key, value]) => <div className={styles.break} key={key}><strong>{fieldNames[key] ?? key}: </strong>{typeof value === "object" ? Object.values(value).filter(Boolean).join(" · ") : String(value)}</div>)}</div></details><div className={styles.actions}><Button onClick={() => { setFields(order.fields); setOfficeNotes(order.officeNotes ?? ""); setCollection(inputMoney(order.authorizedCollectionCents)); setConflict(false); }}>Prevziať serverovú verziu</Button><Button onClick={() => setConflict(false)}>Údaje som porovnal(a), zachovať moje úpravy</Button></div></Notice>}
    <div className={styles.tabs} role="tablist" aria-label="Časti zákazky">{tabs.map(item => <button key={item.id} className={styles.tab} role="tab" aria-selected={tab === item.id} aria-controls={`order-tab-${item.id}`} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
    <div role="tabpanel" id={`order-tab-${tab}`}>
      {tab === "details" && <>
        {canEdit ? <OrderFields fields={fields} onChange={setFields} workspace={workspace} driver={driver} /> : <Panel title="Údaje realizácie"><dl>{Object.entries(order.fields).filter(([, value]) => typeof value === "string" && value).map(([key, value]) => <div key={key}><dt className={styles.muted}>{key}</dt><dd>{String(value)}</dd></div>)}</dl></Panel>}
        {!driver && canEdit && <Panel title="Kancelárske údaje"><div className={styles.grid}><TextArea label="Interná poznámka kancelárie" value={officeNotes} onChange={event => setOfficeNotes(event.target.value)} /><Field label="Autorizovaná suma na výber (€)" inputMode="decimal" value={collection} onChange={event => setCollection(event.target.value)} /></div>{collection !== "" && parseCents(collection) === null && <Notice kind="error">Zadajte nezápornú sumu s najviac dvomi desatinnými miestami.</Notice>}</Panel>}
        {canEdit && <div className={styles.actions}><Button primary disabled={busy || conflict || !dirty || (!driver && collection !== "" && parseCents(collection) === null)} onClick={() => void save()}><Save size={17} /> Uložiť údaje</Button><span className={styles.muted}>Uložená verzia {order.revision}</span></div>}
        {!driver && caps.includes("operate") && <Panel title="Pridelenie a kontrola">{order.sourceCaseId && <div className={styles.actions}><Button disabled={blocked} onClick={() => { if (window.confirm("Prevziať aktuálne údaje zdrojového prípadu? Prepíšu prevzaté polia zákazky a zrušia aktuálne schválenie ceny.")) void change("refresh_source", {}, "Aktuálne údaje zdrojového prípadu boli vedome prevzaté. Skontrolujte zákazku a nacenenie."); }}>Prevziať aktuálne údaje prípadu</Button></div>}<div className={styles.grid}><Select label="Zodpovedný vodič" value={driverId} onChange={event => setDriverId(event.target.value)}><option value="">Vyberte vodiča</option>{workspace.members.filter(member => member.active && member.capabilities.includes("drive")).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</Select><TextArea label="Dôvod vrátenia / storna" value={reason} onChange={event => setReason(event.target.value)} /></div><div className={styles.actions}><Button primary disabled={blocked || !driverId || order.workStatus === "cancelled"} onClick={() => void change("assign", { driverId }, "Pridelenie je potvrdené.")}>{order.driverId ? "Prepriradiť" : "Prideliť vodičovi"}</Button><Button disabled={blocked || !reason.trim() || order.workStatus !== "submitted"} onClick={() => void change("return", { reason }, "Zákazka bola vrátená na doplnenie.")}>Vrátiť na doplnenie</Button><Button danger disabled={blocked || !reason.trim() || order.workStatus === "cancelled"} onClick={() => void change("cancel", { reason }, "Storno zákazky je potvrdené.")}>Stornovať s dôvodom</Button></div></Panel>}
        {driver && <div className={styles.actions}><a className={styles.button} href={`/vodic/offline?orderId=${encodeURIComponent(order.id)}`}>Pripraviť na prácu offline</a></div>}{driver && <Panel title="Priebeh práce"><p className={styles.muted}>Dokončenie potvrdí server po kontrole údajov, fotografií a prijatých úhrad.</p><div className={styles.actions}>{order.workStatus === "assigned" && <Button primary disabled={blocked} onClick={() => void change("start", {}, "Začiatok práce je potvrdený.")}>Začať prácu</Button>}<Button primary disabled={blocked || !["in_progress", "needs_changes", "assigned"].includes(order.workStatus)} onClick={() => void change("submit", { receiptIds: (order.payments ?? []).filter(payment => payment.driverId === workspace.actor.id).map(payment => payment.receiptId) }, "Dokončenie je potvrdené. Zákazka bola odovzdaná kancelárii.")}><Check size={17} /> Dokončiť a odovzdať</Button></div></Panel>}
      </>}
      {tab === "photos" && <Photos key={order.revision} order={order} fields={fields} setFields={setFields} blocked={blocked} run={run} driver={driver} change={change} />}
      {tab === "price" && <Pricing key={order.revision} order={order} workspace={workspace} blocked={blocked} change={change} />}
      {tab === "payments" && <Payments key={order.revision} order={order} workspace={workspace} blocked={blocked} change={change} />}
      {tab === "documents" && <Documents key={order.revision} order={order} workspace={workspace} blocked={blocked} run={run} />}
      {tab === "history" && <Panel title="História zákazky">{order.events?.length ? order.events.map(event => <div key={event.id} className={styles.photo}><span>{dateTime(event.createdAt)}</span><strong>{eventLabels[event.action] ?? event.action}</strong><span className={styles.muted}>{workspace.members.find(member => member.id === event.actorId)?.displayName ?? "Kancelária"}</span></div>) : <p className={styles.muted}>Zatiaľ bez ďalších udalostí.</p>}</Panel>}
    </div>
  </>;
}

const fieldNames: Record<string, string> = { serviceType: "Výkon", subjectType: "Predmet", subjectDescription: "Opis", plate: "EČV", vin: "VIN", pickup: "Nakládka", destination: "Vykládka", contact: "Kontakt", noContactReason: "Dôvod chýbajúceho kontaktu", plannedAt: "Plánovaný termín", startedAt: "Začiatok", finishedAt: "Koniec", driverNotes: "Poznámka vodiča", performedQuantity: "Množstvo", photoException: "Výnimka fotografií", requester: "Objednávateľ", owner: "Majiteľ", customer: "Odberateľ", recipient: "Príjemca", assistanceReference: "Referencia", branchId: "Pobočka", fleetAssetId: "Technika", parkingId: "Parkovisko", startSource: "Pôvod začiatku" };

const eventLabels: Record<string, string> = { create_order: "Zákazka vytvorená", update_order: "Údaje upravené", assign: "Pridelenie zmenené", start: "Práca začala", submit: "Odovzdané na kontrolu", return: "Vrátené na doplnenie", cancel: "Zákazka stornovaná", set_lines: "Položky uložené", approve_price: "Cena schválená", receive_payment: "Úhrada zaevidovaná", set_invoice: "Externá faktúra zaevidovaná", correct_payment: "Úhrada opravená", refund_payment: "Refundácia zaevidovaná" };

function Photos({ order, fields, setFields, blocked, run, driver, change }: { order: TowingOrder; fields: TowingFields; setFields: (fields: TowingFields) => void; blocked: boolean; run: RunOperation; driver: boolean; change: Change }) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState("work");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false); const [abandonReason, setAbandonReason] = useState("");
  const attempts = useRef(new Map<File, { attachmentId: string; commandId: string }>());
  const upload = async () => {
    setError(""); setUploading(true);
    try {
      // Send one file per acknowledged revision. Refresh remounts the detail;
      // keeping the remainder selected would race a stale base revision.
      const file = files[0];
      if (!file) return;
      if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) { setError("Podporované sú JPG, PNG a PDF. HEIC najprv exportujte ako JPG."); return; }
      if (file.size > 10 * 1024 * 1024) { setError("Súbor je väčší ako 10 MB. Zmenšite ho pred odoslaním."); return; }
      let ids = attempts.current.get(file);
      if (!ids) { ids = { attachmentId: crypto.randomUUID(), commandId: crypto.randomUUID() }; attempts.current.set(file, ids); }
      const prepared = await prepareTowingImage(file);
      const body = new FormData(); body.set("file", prepared); body.set("attachmentId", ids.attachmentId); body.set("commandId", ids.commandId); body.set("expectedRevision", String(order.revision)); body.set("kind", kind);
      if (driver) body.set("assignmentGeneration", String(order.assignmentGeneration));
      await run(`upload:${ids.attachmentId}`, () => towingClient.upload(order.id, body), "Súbor je uložený a potvrdený.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Fotografiu sa nepodarilo pripraviť."); } finally { setUploading(false); }
  };
  return <Panel title="Fotografie a podpísaný papier"><p className={styles.muted}>Priložte fotografiu predmetu alebo výkonu. Pri preprave aj odovzdanie, prípadne vysvetlite výnimku. Scan podpísaného papiera je samostatná príloha.</p><div className={styles.photoList}>{order.attachments.filter(attachment => attachment.status !== "abandoned").map(attachment => <a key={attachment.id} className={styles.photo} href={attachment.status === "ready" ? fileUrl(order.id, attachment.id) : undefined} target="_blank" rel="noreferrer"><FileDown size={17} /><span>{attachment.name}<br /><small>{attachment.kind === "scan" ? "Scan papiera" : attachment.kind === "handover" ? "Odovzdanie" : "Výkon"} · {attachment.status === "ready" ? "Uložené" : "Čaká na uloženie"}</small></span></a>)}</div>{order.attachments.some(attachment => attachment.status === "pending") && <Notice>Neuložené prílohy blokujú dokončenie. Neúspešný pokus možno vyradiť s dôvodom; jeho história zostane zachovaná.<Field label="Dôvod vyradenia neuloženej prílohy" value={abandonReason} onChange={event => setAbandonReason(event.target.value)} />{order.attachments.filter(attachment => attachment.status === "pending").map(attachment => <Button key={attachment.id} danger disabled={blocked || !abandonReason.trim()} onClick={() => void change("abandon_attachment", { id: attachment.id, reason: abandonReason }, "Neuložená príloha bola vyradená s auditovaným dôvodom.")}>Vyradiť neuložený súbor {attachment.name}</Button>)}</Notice>}<div className={styles.grid} style={{ marginTop: 22 }}><Select label="Typ prílohy" value={kind} onChange={event => setKind(event.target.value)}><option value="work">Predmet / výkon</option><option value="handover">Odovzdanie</option><option value="scan">Podpísaný papier / pečiatka</option></Select><Field label="Fotografia alebo súbor" type="file" accept="image/jpeg,image/png,application/pdf" capture={kind === "scan" ? undefined : "environment"} onChange={event => setFiles(Array.from(event.target.files ?? []))} /></div>{error && <Notice kind="error">{error}</Notice>}<div className={styles.actions}><Button primary disabled={blocked || uploading || !files.length} onClick={() => void upload()}><Camera size={17} /> {uploading ? "Ukladám fotografiu…" : "Nahrať a potvrdiť"}</Button></div><div style={{ marginTop: 22 }}><TextArea label="Výnimka z fotografií — konkrétny dôvod" value={fields.photoException ?? ""} onChange={event => setFields({ ...fields, photoException: event.target.value })} /></div></Panel>;
}

type Change = (type: TowingCommand["type"], payload: Record<string, unknown>, success: string | ((result: unknown) => string)) => Promise<boolean>;

function Pricing({ order, workspace, blocked, change }: { order: TowingOrder; workspace: TowingWorkspace; blocked: boolean; change: Change }) {
  const [lines, setLines] = useState<TowingLine[]>(order.lines ?? []);
  const [taxDate, setTaxDate] = useState(workspace.taxDate ?? "");
  const [reason, setReason] = useState("");
  let total = 0; let valid = lines.length > 0;
  for (const line of lines) { try { total += calculateTowingLine(line).totalCents; if (!line.description.trim() || !line.unit.trim()) valid = false; } catch { valid = false; } }
  const saved = JSON.stringify(lines) === JSON.stringify(order.lines ?? []);
  const update = (index: number, patch: Partial<TowingLine>) => setLines(lines.map((line, lineIndex) => index === lineIndex ? { ...line, ...patch } : line));
  return <Panel title="Položkové nacenenie">
    {!workspace.taxConfigured && <Notice>Daňové nastavenie organizácie chýba. Návrh môžete uložiť; finálnu cenu a nacenený doklad schváľte až po potvrdení nastavenia správcom.</Notice>}
    <Field label="Dátum pre daňové pravidlá" type="date" value={taxDate} onChange={event => setTaxDate(event.target.value)} />
    <div style={{ marginTop: 22 }}>{lines.map((line, index) => <div key={line.id} className={styles.line}><Field label={`Položka ${index + 1}`} value={line.description} onChange={event => update(index, { description: event.target.value })} /><Field label="Množstvo" inputMode="decimal" value={line.quantity} onChange={event => update(index, { quantity: event.target.value.replace(",", ".") })} /><Field label="Jednotka" value={line.unit} onChange={event => update(index, { unit: event.target.value })} /><Field label="Cena bez dane (€)" inputMode="decimal" value={line.unitPrice} onChange={event => update(index, { unitPrice: event.target.value.replace(",", ".") })} /><Select label="Daň (%)" value={line.taxRate} onChange={event => update(index, { taxRate: event.target.value })}><option value="">Vyberte sadzbu</option>{workspace.taxRates.map(rate => <option key={rate} value={rate}>{rate} %</option>)}</Select><Button aria-label={`Odstrániť položku ${index + 1}`} disabled={blocked} onClick={() => setLines(lines.filter((_, lineIndex) => index !== lineIndex))}><Trash2 size={17} /></Button></div>)}</div>
    <div className={styles.row}><Button disabled={blocked} onClick={() => setLines([...lines, { id: crypto.randomUUID(), description: "", quantity: "1", unit: "", unitPrice: "", taxRate: "" }])}><Plus size={17} /> Pridať položku</Button><strong>Spolu s daňou: {valid ? euro(total) : "doplňte položky"}</strong></div>
    <div className={styles.actions}><Button primary disabled={blocked || !valid || !taxDate} onClick={() => void change("set_lines", { lines, taxDate }, "Cenové položky sú uložené.")}><Save size={17} /> Uložiť nacenenie</Button><Button disabled={blocked || !saved || !valid || !workspace.taxConfigured || order.workStatus !== "submitted"} onClick={() => void change("approve_price", {}, "Cena bola schválená. Zákazka je pripravená na fakturáciu.")}><Check size={17} /> Schváliť cenu a pripraviť</Button></div>
    {workspace.actor.capabilities.includes("bill") && <details className={styles.details}><summary>Zákazka bez fakturácie</summary><TextArea label="Dôvod bez fakturácie" value={reason} onChange={event => setReason(event.target.value)} /><Button disabled={blocked || !reason.trim()} onClick={() => void change("not_required", { reason }, "Dôvod bez fakturácie je zaevidovaný.")}>Potvrdiť bez fakturácie</Button></details>}
  </Panel>;
}

function Payments({ order, workspace, blocked, change }: { order: TowingOrder; workspace: TowingWorkspace; blocked: boolean; change: Change }) {
  const driver = workspace.view === "driver";
  const [amount, setAmount] = useState(""); const [method, setMethod] = useState("cash"); const [cashDriverId, setCashDriverId] = useState(driver ? workspace.actor.id : order.driverId ?? "");
  const receipt = useRef(crypto.randomUUID());
  const [confirmed, setConfirmed] = useState(false);
  const cents = parseCents(amount);
  const account = workspace.cashAccounts.find(item => item.driverId === cashDriverId);
  const receive = async () => { if (cents === null) return; if (await change("receive_payment", { receiptId: receipt.current, amountCents: cents, method, ...(method === "cash" ? { driverId: cashDriverId, accountRevision: account?.revision ?? 1 } : {}) }, "Úhrada bola potvrdená a zapísaná v evidencii.")) { receipt.current = crypto.randomUUID(); setAmount(""); setConfirmed(false); } };
  return <>
    <Panel title="Platby zákazky"><div className={styles.stats}><div className={styles.stat}>Autorizované na výber<strong>{euro(order.authorizedCollectionCents)}</strong></div><div className={styles.stat}>Prijaté úhrady<strong>{euro(order.receivedCents)}</strong></div><div className={styles.stat}>Zostáva / preplatok<strong>{euro(order.dueCents === null ? null : order.dueCents - order.receivedCents)}</strong></div></div>{order.payments?.length ? <div className={styles.stack}>{order.payments.map(payment => <div key={payment.id} className={styles.photo}><strong>{euro(payment.amountCents)}</strong><span>{({ cash: "Hotovosť", card: "Karta", bank: "Bankový prevod", other: "Iná úhrada" })[payment.method]}</span><span className={styles.muted}>{dateTime(payment.createdAt)}</span>{payment.reversalOf && <span className={styles.badge}>Oprava</span>}</div>)}</div> : <p className={styles.muted}>Zatiaľ bez potvrdených úhrad.</p>}
      {order.paymentStatus === "unpriced" && <Notice>Príjem pred schválením ceny sa eviduje ako záloha.</Notice>}
      <div className={styles.grid}><Field label="Prijatá suma (€)" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} /><Select label="Spôsob úhrady" value={method} onChange={event => { setMethod(event.target.value); setConfirmed(false); }}><option value="cash">Hotovosť</option>{!driver && <><option value="card">Karta</option><option value="bank">Bankový prevod</option><option value="other">Iná úhrada</option></>}</Select>{!driver && method === "cash" && <Select label="Kto prevzal hotovosť" value={cashDriverId} onChange={event => setCashDriverId(event.target.value)}><option value="">Vyberte vodiča</option>{workspace.members.filter(member => member.capabilities.includes("drive")).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</Select>}</div><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Potvrdzujem skutočne prijatú úhradu {cents !== null ? euro(cents) : ""}.</label><Button primary disabled={blocked || !confirmed || cents === null || cents <= 0 || (method === "cash" && !cashDriverId)} onClick={() => void receive()}>Zaevidovať prijatú úhradu</Button>
    </Panel>
    {!driver && workspace.actor.capabilities.includes("bill") && <Invoice order={order} blocked={blocked} change={change} />}
    {!driver && workspace.actor.capabilities.includes("correct") && <Corrections order={order} workspace={workspace} blocked={blocked} change={change} />}
  </>;
}

function Invoice({ order, blocked, change }: { order: TowingOrder; blocked: boolean; change: Change }) {
  const [number, setNumber] = useState(""); const [date, setDate] = useState(""); const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const id = useRef(crypto.randomUUID()); const cents = parseCents(amount); const previous = order.invoices?.at(-1);
  return <Panel title="Externá faktúra"><p className={styles.muted}>Tu evidujete doklad vystavený v účtovnom systéme.</p>{order.invoices?.map(invoice => <div key={invoice.id} className={styles.photo}><strong>{invoice.number}</strong><span>{invoice.date}</span><strong>{euro(invoice.amountCents)}</strong>{invoice.supersedesId && <span className={styles.badge}>Nahrádzajúci doklad</span>}</div>)}<div className={styles.grid3} style={{ marginTop: 20 }}><Field label="Číslo externého dokladu" value={number} onChange={event => setNumber(event.target.value)} /><Field label="Dátum dokladu" type="date" value={date} onChange={event => setDate(event.target.value)} /><Field label="Celková suma (€)" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></div>{previous && <TextArea label="Dôvod nahradenia predchádzajúcej faktúry" value={reason} onChange={event => setReason(event.target.value)} />}<div className={styles.actions}><Button primary disabled={blocked || !number.trim() || !date || cents === null || (Boolean(previous) && !reason.trim())} onClick={() => void change("set_invoice", { id: id.current, number, date, amountCents: cents, ...(previous ? { supersedesId: previous.id, reason } : {}) }, "Externá faktúra je zaevidovaná.")}>Zaevidovať externú faktúru</Button></div></Panel>;
}

function Corrections({ order, workspace, blocked, change }: { order: TowingOrder; workspace: TowingWorkspace; blocked: boolean; change: Change }) {
  const [paymentId, setPaymentId] = useState(""); const [kind, setKind] = useState("correct_payment"); const [amount, setAmount] = useState(""); const [driverReduction, setDriverReduction] = useState(""); const [officeReduction, setOfficeReduction] = useState(""); const [reason, setReason] = useState(""); const [evidence, setEvidence] = useState(""); const [verified, setVerified] = useState(false);
  const payment = order.payments?.find(item => item.id === paymentId); const driverAccount = workspace.cashAccounts.find(item => item.driverId === payment?.driverId); const officeAccount = workspace.cashAccounts.find(item => item.driverId === null);
  const cents = parseCents(amount); const driverCents = parseCents(driverReduction); const officeCents = parseCents(officeReduction); const receipt = useRef(crypto.randomUUID());
  const cash = payment?.method === "cash";
  const valid = payment && cents !== null && reason.trim() && evidence.trim() && verified && (!cash || (driverCents !== null && officeCents !== null));
  const correct = async () => {
    let resolved = false;
    const ok = await change(kind as TowingCommand["type"], {
      paymentId, ...(kind === "correct_payment" ? { replacementReceiptId: receipt.current } : { receiptId: receipt.current }),
      amountCents: cents, driverReductionCents: cash ? driverCents : 0, officeReductionCents: cash ? officeCents : 0,
      driverRevision: driverAccount?.revision ?? 1, officeRevision: officeAccount?.revision ?? 1, reason, evidence,
    }, result => {
      resolved = (result as import("@/domain/towing/types").TowingCommandResult).result?.reconciliationStatus === "resolved";
      return resolved ? "Finančná operácia je potvrdená." : "Finančná výnimka je zaevidovaná. Pôvodná úhrada sa nezmenila; doplňte overené podklady.";
    });
    if (ok) {
      setVerified(false);
      if (resolved) { receipt.current = crypto.randomUUID(); setPaymentId(""); setAmount(""); setDriverReduction(""); setOfficeReduction(""); setReason(""); setEvidence(""); }
    }
  };
  return <Panel title="Manažérska oprava alebo refundácia"><Notice>Potvrdené platby sa nemažú. Oprava vytvorí nové zápisy. Pri hotovosti overte skutočnú držbu peňazí u vodiča aj kancelárie; nedostupnú alebo nedoloženú sumu server odmietne.</Notice><div className={styles.grid}><Select label="Pôvodná úhrada" value={paymentId} onChange={event => { setPaymentId(event.target.value); setVerified(false); }}><option value="">Vyberte úhradu</option>{order.payments?.filter(item => !item.reversalOf && item.amountCents > 0).map(item => <option key={item.id} value={item.id}>{euro(item.amountCents)} · {item.method} · {dateTime(item.createdAt)}</option>)}</Select><Select label="Druh operácie" value={kind} onChange={event => { setKind(event.target.value); setVerified(false); }}><option value="correct_payment">Oprava zaevidovaného príjmu</option><option value="refund_payment">Skutočná refundácia</option></Select><Field label={kind === "correct_payment" ? "Správna výška pôvodnej úhrady (€)" : "Skutočne vrátená suma (€)"} inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setVerified(false); }} />{cash && <><Field label={`Zníženie držby vodiča (€), dostupné ${euro(driverAccount ? driverAccount.balanceCents - driverAccount.reservedCents : null)}`} inputMode="decimal" value={driverReduction} onChange={event => { setDriverReduction(event.target.value); setVerified(false); }} /><Field label={`Zníženie držby kancelárie (€), dostupné ${euro(officeAccount?.balanceCents)}`} inputMode="decimal" value={officeReduction} onChange={event => { setOfficeReduction(event.target.value); setVerified(false); }} /></>}<TextArea label="Konkrétny dôvod" value={reason} onChange={event => setReason(event.target.value)} /><TextArea label="Overený dôkaz / referencia podkladu" value={evidence} onChange={event => setEvidence(event.target.value)} /></div><label className={styles.check}><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} /> Overil(a) som podklady a rozdelenie skutočnej držby peňazí.</label><Button danger disabled={blocked || !valid} onClick={() => void correct()}>Potvrdiť doloženú operáciu</Button></Panel>;
}

function Documents({ order, workspace, blocked, run }: { order: TowingOrder; workspace: TowingWorkspace; blocked: boolean; run: RunOperation }) {
  const [kind, setKind] = useState<"work" | "priced">("work"); const [documentId, setDocumentId] = useState(""); const [recipient, setRecipient] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const attempts = useRef(new Map<string, { commandId: string; documentId: string }>());
  const emailAttempts = useRef(new Map<string, string>());
  const createDocument = async (retry?: { id: string; kind: "work" | "priced" }) => {
    const key = retry ? `retry:${retry.id}` : `${kind}:${order.revision}`;
    let ids = attempts.current.get(key); if (!ids) { ids = { commandId: crypto.randomUUID(), documentId: retry?.id ?? crypto.randomUUID() }; attempts.current.set(key, ids); }
    const ok = await run(key, () => towingClient.document(order.id, { commandId: ids!.commandId, documentId: ids!.documentId, expectedRevision: order.revision, kind: retry?.kind ?? kind, ...(retry ? { retry: true } : {}) }), "Verzia dokumentu bola spracovaná. Skontrolujte stav PDF.");
    if (ok) attempts.current.delete(key);
  };
  const emailDocument = async () => {
    const key = `${documentId}:${recipient}`; let commandId = emailAttempts.current.get(key); if (!commandId) { commandId = crypto.randomUUID(); emailAttempts.current.set(key, commandId); }
    const ok = await run(key, async () => { const result = await towingClient.email(order.id, { commandId: commandId!, documentId, recipient, confirmed: true }); const status = deliveryStatus(result); if (status === "failed") throw new Error("Odoslanie e-mailu zlyhalo. Skontrolujte adresu a konfiguráciu."); if (status !== "accepted") throw new Error("Výsledok odoslania je neznámy alebo nepotvrdený. Pred novým pokusom overte stav u poskytovateľa."); return result; }, "Poskytovateľ prijal e-mail. Doručenie do schránky tým nie je potvrdené.");
    if (ok) { emailAttempts.current.delete(key); setConfirmed(false); }
  };
  return <Panel title="Verzie zákazkového listu"><p className={styles.muted}>Každá verzia zachová údaje v čase vydania. Podpisové polia sú prázdne; podpísaný papier pridajte ako scan.</p><div className={styles.stack}>{order.documents?.map(document => <div className={styles.row} key={document.id}><span><strong>Verzia {document.version}</strong> · {document.kind === "work" ? "Realizačný list" : "Nacenený list"} · {dateTime(document.createdAt)}</span>{document.status === "ready" ? <a className={styles.button} target="_blank" rel="noreferrer" href={documentUrl(order.id, document.id)}><FileDown size={17} /> Stiahnuť PDF</a> : <span className={styles.badge} data-tone={document.status === "failed" ? "red" : "amber"}>{document.status === "failed" ? "Generovanie zlyhalo" : "PDF sa pripravuje"}</span>}</div>)}</div><div className={styles.grid} style={{ marginTop: 22 }}><Select label="Nová verzia" value={kind} onChange={event => setKind(event.target.value as "work" | "priced")}><option value="work">Realizačný list bez ceny</option><option value="priced">Finálny nacenený list</option></Select></div><div className={styles.actions}><Button primary disabled={blocked || (kind === "priced" && (!workspace.taxConfigured || !["ready", "invoiced"].includes(order.billingStatus)))} onClick={() => void createDocument()}>Vytvoriť novú verziu PDF</Button>{order.documents?.filter(document => document.status === "failed").map(document => <Button key={document.id} disabled={blocked} onClick={() => void createDocument(document)}>Zopakovať PDF v{document.version}</Button>)}</div><details className={styles.details}><summary>Poslať konkrétnu verziu e-mailom</summary><div className={styles.grid}><Select label="Verzia PDF" value={documentId} onChange={event => { setDocumentId(event.target.value); setConfirmed(false); }}><option value="">Vyberte hotový dokument</option>{order.documents?.filter(document => document.status === "ready").map(document => <option key={document.id} value={document.id}>Verzia {document.version} · {document.kind === "work" ? "bez ceny" : "s cenou"}</option>)}</Select><Field label="Výslovne potvrdený príjemca" type="email" value={recipient} onChange={event => { setRecipient(event.target.value); setConfirmed(false); }} /></div><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Potvrdzujem adresu príjemcu a odoslanie vybranej verzie.</label><Button disabled={blocked || !documentId || !recipient.includes("@") || !confirmed} onClick={() => void emailDocument()}>Odoslať vybranú verziu</Button></details></Panel>;
}
