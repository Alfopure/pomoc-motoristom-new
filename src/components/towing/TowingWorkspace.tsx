"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Plus, RefreshCw, Save, Wallet } from "lucide-react";
import type { TowingFields, TowingOrder, TowingView, TowingWorkspace as Workspace } from "@/domain/towing/types";
import { towingClient, TowingRequestError } from "./client";
import { Button, Field, Notice, Panel, Shell, TextArea, usePendingChanges, type PendingChangesReporter } from "./primitives";
import { blankFields, dateTime, euro, orderTitle, parseCents, paymentLabels, serviceLabels, workLabels, workTone } from "./model";
import { BookOverview, emptyBookFilters } from "./BookOverview";
import { TowingParties } from "./TowingParties";
import { OrderFields } from "./OrderFields";
import { OrderDetail, type RunOperation, type SendCommand } from "./OrderDetail";
import { Members } from "./Members";
import { FinancialReports, ReconcileReceipt, ParkingSettings } from "./administration";
import styles from "./towing.module.css";
import { protectDraftBeforeUnload } from "@/lib/draft-unload";

export function TowingWorkspace({ view, initialData, initialOrderId, sourceCaseId, canDispatch, canPartner, embedded = false, onPendingChangesChange }: { view: TowingView; initialData?: Workspace; initialOrderId?: string; sourceCaseId?: string; canDispatch?: boolean; canPartner?: boolean; embedded?: boolean; onPendingChangesChange?: PendingChangesReporter }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(initialData ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId ?? null);
  const [selectedOrder, setSelectedOrder] = useState<TowingOrder | null>(initialData?.orders.find(order => order.id === initialOrderId) ?? null);
  const [mode, setMode] = useState<"orders" | "create" | "cash" | "members" | "settings" | "reports">(sourceCaseId ? "create" : "orders");
  const [filters, setFilters] = useState<Record<string, string>>({ ...emptyBookFilters });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [offset, setOffset] = useState(0); const [loading, setLoading] = useState(!initialData); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  const attempts = useRef(new Map<string, string>()); const loadSequence = useRef(0); const operationRunning = useRef(false);
  const workspaceStart = useRef<HTMLDivElement>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [cashPending, setCashPending] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [pendingOperations, setPendingOperations] = useState<Set<string>>(() => new Set());
  const retries = useRef(new Map<string, { operation: Parameters<RunOperation>[1]; message: Parameters<RunOperation>[2] }>());
  const pending = busy || pendingOperations.size > 0 || detailPending || createPending || cashPending || settingsPending;
  usePendingChanges(pending, onPendingChangesChange);
  useEffect(() => {
    if (!pending) return;
    window.addEventListener("beforeunload", protectDraftBeforeUnload);
    return () => window.removeEventListener("beforeunload", protectDraftBeforeUnload);
  }, [pending]);
  const clearOperation = (key: string) => {
    retries.current.delete(key);
    setPendingOperations(current => {
      if (!current.has(key)) return current;
      const next = new Set(current); next.delete(key); return next;
    });
  };
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const result = await towingClient.workspace(view, { ...Object.fromEntries(Object.entries(appliedFilters).filter(([, value]) => value)), offset: String(offset), limit: "50" });
      if (sequence !== loadSequence.current) return;
      setWorkspace(result);
      if (selectedId) {
        const current = result.orders.find(order => order.id === selectedId);
        if (current) setSelectedOrder(current);
        else if (view === "driver") { setSelectedId(null); setSelectedOrder(null); }
        else {
          const detail = await towingClient.workspace(view, { orderId: selectedId });
          if (sequence === loadSequence.current) setSelectedOrder(detail.orders.find(order => order.id === selectedId) ?? null);
        }
      }
    } catch (cause) { if (sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : "Údaje sa nepodarilo načítať."); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [view, appliedFilters, offset, selectedId]);
  const firstLoad = useRef(true);
  useEffect(() => { if (firstLoad.current && initialData && !initialOrderId) { firstLoad.current = false; return; } firstLoad.current = false; void refresh(); }, [initialData, initialOrderId, refresh]);
  const run: RunOperation = async (key, operation, message) => {
    if (operationRunning.current) return false;
    // Keep the original request and acknowledgment handler even if a read or
    // later edits change the form's revision and payload before recovery.
    const attempt = retries.current.get(key) ?? { operation, message };
    retries.current.set(key, attempt);
    setPendingOperations(current => new Set(current).add(key));
    operationRunning.current = true; setBusy(true); setError(""); setSuccess("");
    try {
      const result = await attempt.operation();
      setSuccess(typeof attempt.message === "function" ? attempt.message(result) : attempt.message);
      await refresh();
      clearOperation(key);
      attempts.current.delete(key);
      return true;
    } catch (cause) {
      if (cause instanceof TowingRequestError && cause.status >= 400 && cause.status < 500) clearOperation(key);
      setError(cause instanceof Error ? cause.message : "Zmenu sa nepodarilo potvrdiť."); return false;
    }
    finally { operationRunning.current = false; setBusy(false); }
  };
  const send: SendCommand = async (command, message) => {
    const key = JSON.stringify(command);
    let id = attempts.current.get(key);
    if (!id) { id = crypto.randomUUID(); attempts.current.set(key, id); }
    const ok = await run(key, () => towingClient.command({ ...command, commandId: id! }), message);
    if (ok) attempts.current.delete(key);
    return ok;
  };
  const open = (order: TowingOrder) => { setSelectedId(order.id); setSelectedOrder(order); setMode("orders"); setError(""); setSuccess(""); if (embedded) workspaceStart.current?.scrollIntoView({ block: "start", behavior: "smooth" }); else window.scrollTo({ top: 0, behavior: "smooth" }); };
  const back = () => { if (pendingOperations.size) { setError("Výsledok odoslanej zmeny ešte nie je potvrdený. Zopakujte rovnaký pokus pred opustením zákazky."); return; } setSelectedId(null); setSelectedOrder(null); setMode("orders"); };
  const can = (capability: Workspace["actor"]["capabilities"][number]) => workspace?.actor.capabilities.includes(capability) ?? false;
  const driver = view === "driver";
  const canOffice = workspace?.actor.capabilities.some(capability => ["operate", "price", "bill", "documents", "report", "members"].includes(capability));
  const total = workspace?.totalCount ?? workspace?.orders.length ?? 0;
  const ListHeading = embedded ? "h2" : "h1";
  return <Shell view={view} canOffice={canOffice} canDriver={can("drive")} canDeliver={can("deliver")} canDispatch={canDispatch} canPartner={canPartner} embedded={embedded}>
    <div ref={workspaceStart} />
    {error && <Notice kind="error">{error}<div className={styles.actions}><Button disabled={busy || loading} onClick={() => { setError(""); void refresh(); }}><RefreshCw size={16} /> Načítať aktuálne údaje</Button>{error.includes("prihlás") && <a className={styles.button} href={driver ? "/vodic" : "/zakazky"}>Obnoviť prihlásenie</a>}</div></Notice>}
    {pendingOperations.size > 0 && !busy && <Notice>Výsledok pôvodného zápisu ešte nie je potvrdený. Overte ho pred odchodom; vaše novšie úpravy zostanú zachované.<div className={styles.actions}>{[...pendingOperations].map(key => <Button key={key} disabled={loading} onClick={() => {
      const attempt = retries.current.get(key);
      if (attempt) void run(key, attempt.operation, attempt.message);
    }}>Overiť pôvodný zápis</Button>)}</div></Notice>}
    {success && <Notice kind="success">{success}</Notice>}
    {!workspace ? <Panel title={loading ? "Načítavam zákazky…" : "Zákazky sú nedostupné"}><p className={styles.muted}>{loading ? "Overujem oprávnenia a načítavam aktuálne údaje." : "Skontrolujte spojenie a skúste načítanie znova."}</p>{!loading && <Button onClick={() => void refresh()}>Skúsiť znova</Button>}</Panel> : selectedOrder ? <OrderDetail key={selectedOrder.id} order={selectedOrder} workspace={workspace} send={send} run={run} busy={busy} onBack={back} onPendingChangesChange={setDetailPending} /> : mode === "create" ? <CreateOrder workspace={workspace} busy={busy} send={send} onBack={back} sourceCaseId={sourceCaseId} onPendingChangesChange={setCreatePending} /> : mode === "cash" ? <><Button onClick={back}><ArrowLeft size={16} /> Späť na zákazky</Button><Cash workspace={workspace} busy={busy} send={send} run={run} onPendingChangesChange={setCashPending} /></> : mode === "members" ? <><Button onClick={back}><ArrowLeft size={16} /> Späť na zákazky</Button><Members workspace={workspace} busy={busy} run={run} /></> : mode === "settings" ? <><Button onClick={back}><ArrowLeft size={16} /> Späť na zákazky</Button><Settings workspace={workspace} busy={busy} send={send} onPendingChangesChange={setSettingsPending} /><ParkingSettings workspace={workspace} busy={busy} send={send} /></> : mode === "reports" ? <><Button onClick={back}><ArrowLeft size={16} /> Späť na zákazky</Button><FinancialReports workspace={workspace} /></> : <>
      <div className={styles.titleRow}><div><ListHeading className={styles.title}>{driver ? "Moje zákazky" : "Zákazky"}</ListHeading><p className={styles.subtitle}>{driver ? `${workspace.actor.displayName} · pridelená práca na jednom mieste` : "Od prijatia zásahu po kontrolu, fakturáciu a úhradu."}</p></div><div className={styles.actions} style={{ marginTop: 0 }}><Button aria-label="Obnoviť zákazky" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={17} /></Button>{can("cash") || driver ? <Button onClick={() => setMode("cash")}><Wallet size={17} /> Hotovosť</Button> : null}{!driver && can("operate") && <Button primary onClick={() => setMode("create")}><Plus size={17} /> Nová zákazka</Button>}</div></div>
      {driver ? <><div className={styles.stats}><div className={styles.stat}>Aktívne zákazky<strong>{total}</strong></div><div className={styles.stat}>Potvrdená hotovosť<strong>{euro(workspace.cashAccounts.find(account => account.driverId === workspace.actor.id)?.balanceCents ?? 0)}</strong></div></div><div className={styles.cards}>{workspace.orders.map(order => <OrderCard key={order.id} order={order} workspace={workspace} onOpen={() => open(order)} />)}</div>{!workspace.orders.length && <div className={styles.empty}>Momentálne nemáte pridelenú aktívnu zákazku.</div>}</> : <>
        <BookOverview workspace={workspace} filters={filters} setFilters={setFilters} apply={next => { setError(""); setOffset(0); setAppliedFilters({ ...next }); }} loading={loading} offset={offset} setOffset={setOffset} open={open} /><div className={styles.actions}>{can("report") && <Button onClick={() => setMode("reports")}>Finančné výkazy</Button>}{can("members") && <Button onClick={() => setMode("members")}>Prístupy a vodiči</Button>}{can("correct") && <Button onClick={() => setMode("settings")}>Dane a parkoviská</Button>}</div>
      </>}
      {loading && <p role="status" className={styles.muted}>Načítavam aktuálne údaje…</p>}
    </>}
    <p className={styles.footer}>Zákazky odťahovej služby · potvrdené údaje zo servera</p>
  </Shell>;
}

function OrderCard({ order, workspace, onOpen }: { order: TowingOrder; workspace: Workspace; onOpen: () => void }) {
  return <article className={styles.card}><div className={styles.row}><strong>{order.number}</strong><span className={styles.badge} data-tone={workTone(order.workStatus)}>{workLabels[order.workStatus]}</span></div><h2>{orderTitle(order)}</h2><TowingParties fields={order.fields} /><p className={styles.muted}>{serviceLabels[order.fields.serviceType]} · {dateTime(order.fields.plannedAt)}</p><div className={styles.route}><div><span>●</span><span>{order.fields.pickup || "Nakládka zatiaľ chýba"}</span></div><div><span>○</span><span>{order.fields.destination || "Cieľ zatiaľ neurčený"}</span></div></div><div className={styles.row}><span className={styles.badge}>{paymentLabels[order.paymentStatus]}</span><strong>{euro(workspace.view === "driver" ? order.authorizedCollectionCents : order.dueCents)}</strong></div><div className={styles.actions}><Button primary onClick={onOpen}>Otvoriť zákazku <ChevronRight size={17} /></Button></div></article>;
}

function CreateOrder({ workspace, busy, send, onBack, sourceCaseId, onPendingChangesChange }: { workspace: Workspace; busy: boolean; send: SendCommand; onBack: () => void; sourceCaseId?: string; onPendingChangesChange?: PendingChangesReporter }) {
  const [fields, setFields] = useState<TowingFields>({ ...blankFields }); const [officeNotes, setOfficeNotes] = useState(""); const id = useRef(crypto.randomUUID());
  const [source, setSource] = useState<{ id: string; number: string; fields: TowingFields } | null>(null);
  usePendingChanges(JSON.stringify(fields) !== JSON.stringify(blankFields) || Boolean(officeNotes || source), onPendingChangesChange);
  const [sourceQuery, setSourceQuery] = useState(""); const [sources, setSources] = useState<{ id: string; number: string; fields: TowingFields }[]>([]); const [sourceError, setSourceError] = useState(""); const [sourceLoading, setSourceLoading] = useState(Boolean(sourceCaseId));
  const search = async (sourceId?: string) => { setSourceLoading(true); setSourceError(""); try { const result = await towingClient.sources(sourceId ? { sourceId } : { query: sourceQuery }); setSources(result.sources); if (sourceId && result.sources[0]) { setSource(result.sources[0]); setFields(result.sources[0].fields); } else if (sourceId) setSourceError("Zdrojový prípad sa nepodarilo načítať. Zákazku môžete založiť samostatne."); } catch (cause) { setSourceError(cause instanceof Error ? cause.message : "Prípad sa nepodarilo načítať."); } finally { setSourceLoading(false); } };
  useEffect(() => {
    if (!sourceCaseId) return;
    let live = true;
    void towingClient.sources({ sourceId: sourceCaseId }).then(result => {
      if (!live) return;
      setSources(result.sources);
      if (result.sources[0]) { setSource(result.sources[0]); setFields(result.sources[0].fields); }
      else setSourceError("Zdrojový prípad sa nepodarilo načítať. Zákazku môžete založiť samostatne.");
    }).catch(cause => { if (live) setSourceError(cause instanceof Error ? cause.message : "Prípad sa nepodarilo načítať."); }).finally(() => { if (live) setSourceLoading(false); });
    return () => { live = false; };
  }, [sourceCaseId]);
  return <><Button onClick={onBack} disabled={busy}><ArrowLeft size={16} /> Späť</Button><h1 className={styles.title} style={{ marginTop: 20 }}>Nová zákazka</h1><p className={styles.subtitle}>Uložte aj neúplný návrh. Kontakt, nakládku a pobočku doplňte pred pridelením.</p>{workspace.actor.roles.some(role => role === "dispatch" || role === "manager") && <Panel title="Zdrojový prípad (voliteľné)">{source ? <Notice>Prípad {source.number} · údaje boli prevzaté ako východisková kópia. <Button disabled={busy} onClick={() => setSource(null)}>Odpojiť zdroj</Button></Notice> : <><div className={styles.row}><Field label="Hľadať existujúci prípad" value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} /><Button disabled={sourceLoading || !sourceQuery.trim()} onClick={() => void search()}>Hľadať prípady</Button></div>{sourceLoading && <p role="status">Načítavam prípady…</p>}{sourceError && <Notice kind="error">{sourceError}</Notice>}{sources.map(item => <div key={item.id} className={styles.row}><span>{item.number} · {item.fields.subjectDescription} · {item.fields.pickup}</span><Button onClick={() => { setSource(item); setFields(item.fields); }}>Prevziať údaje prípadu</Button></div>)}</>}</Panel>}<OrderFields fields={fields} onChange={setFields} workspace={workspace} allowOriginSelection /><Panel title="Interná poznámka"><TextArea label="Poznámka kancelárie" value={officeNotes} onChange={event => setOfficeNotes(event.target.value)} /></Panel><div className={styles.actions}><Button primary disabled={busy || sourceLoading} onClick={async () => { if (await send({ type: "create_order", targetId: id.current, payload: { fields, officeNotes, ...(source ? { sourceCaseId: source.id } : {}) } }, "Návrh zákazky je uložený.")) onBack(); }}><Save size={17} /> {busy ? "Ukladám návrh…" : "Uložiť návrh zákazky"}</Button></div></>;
}

function Cash({ workspace, busy, send, run, onPendingChangesChange }: { workspace: Workspace; busy: boolean; send: SendCommand; run: RunOperation; onPendingChangesChange?: PendingChangesReporter }) {
  const driver = workspace.view === "driver"; const own = workspace.cashAccounts.find(account => account.driverId === workspace.actor.id); const office = workspace.cashAccounts.find(account => account.driverId === null);
  const [amount, setAmount] = useState(""); const [reason, setReason] = useState(""); const id = useRef(crypto.randomUUID()); const cents = parseCents(amount);
  usePendingChanges(Boolean(amount || reason), onPendingChangesChange);
  return <><h1 className={styles.title} style={{ marginTop: 24 }}>Evidencia hotovosti</h1><p className={styles.subtitle}>Odovzdanie zmení držbu až po potvrdení kanceláriou.</p><div className={styles.stats}>{(driver ? own ? [own] : [] : workspace.cashAccounts).map(account => <div key={account.id} className={styles.stat}>{account.driverId ? workspace.members.find(member => member.id === account.driverId)?.displayName ?? "Vodič" : "Kancelária"}<strong>{euro(account.balanceCents)}</strong><small className={styles.muted}>Rezervované {euro(account.reservedCents)} · dostupné {euro(account.balanceCents - account.reservedCents)}</small></div>)}</div>{driver && <Panel title="Navrhnúť odovzdanie"><Field label="Suma na odovzdanie (€)" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /><div className={styles.actions}><Button primary disabled={busy || !own || cents === null || cents <= 0 || cents > own.balanceCents - own.reservedCents} onClick={async () => { if (await send({ type: "propose_handover", targetId: id.current, payload: { amountCents: cents, accountRevision: own?.revision } }, "Návrh odovzdania čaká na prijatie kanceláriou.")) { id.current = crypto.randomUUID(); setAmount(""); } }}>Navrhnúť odovzdanie hotovosti</Button></div></Panel>}<Panel title="Odovzdania hotovosti"><TextArea label="Dôvod odmietnutia / zrušenia" value={reason} onChange={event => setReason(event.target.value)} />{workspace.handovers.length ? workspace.handovers.map(handover => { const account = workspace.cashAccounts.find(item => item.driverId === handover.driverId); return <div key={handover.id} className={styles.row} style={{ padding: "16px 0", borderBottom: "1px solid #e5e7eb" }}><div><strong>{euro(handover.amountCents)}</strong> · {workspace.members.find(member => member.id === handover.driverId)?.displayName ?? "Vodič"}<br /><span className={styles.muted}>{dateTime(handover.createdAt)} · {({ pending: "Čaká na prijatie", accepted: "Prijaté kanceláriou", rejected: "Odmietnuté", cancelled: "Zrušené" })[handover.status]}</span>{handover.reason && <p>{handover.reason}</p>}</div>{handover.status === "pending" && <div className={styles.actions} style={{ marginTop: 0 }}>{!driver && workspace.actor.capabilities.includes("cash") && <><Button primary disabled={busy || !account || !office} onClick={() => void send({ type: "accept_handover", targetId: handover.id, expectedRevision: handover.revision, payload: { accountRevision: account?.revision, officeRevision: office?.revision } }, "Hotovosť bola prijatá kanceláriou.")}>Potvrdiť prevzatie</Button><Button danger disabled={busy || !reason.trim()} onClick={async () => { if (await send({ type: "reject_handover", targetId: handover.id, expectedRevision: handover.revision, payload: { reason } }, "Odovzdanie bolo odmietnuté, rezervácia uvoľnená.")) setReason(""); }}>Odmietnuť</Button></>}{workspace.actor.capabilities.includes("correct") && <Button danger disabled={busy || !reason.trim()} onClick={async () => { if (await send({ type: "cancel_handover", targetId: handover.id, expectedRevision: handover.revision, payload: { reason } }, "Odovzdanie bolo zrušené, rezervácia uvoľnená.")) setReason(""); }}>Zrušiť s dôvodom</Button>}</div>}</div>; }) : <p className={styles.empty}>Zatiaľ bez odovzdaní.</p>}</Panel>{!driver && workspace.actor.capabilities.includes("correct") && <ReconcileReceipt workspace={workspace} busy={busy} run={run} />}</>;
}

function Settings({ workspace, busy, send, onPendingChangesChange }: { workspace: Workspace; busy: boolean; send: SendCommand; onPendingChangesChange?: PendingChangesReporter }) {
  const [rates, setRates] = useState(workspace.taxRates.join(", ")); const [validFrom, setValidFrom] = useState(""); const [validUntil, setValidUntil] = useState(""); const [label, setLabel] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const parsedRates = rates.split(",").map(rate => rate.trim()).filter(Boolean); const valid = parsedRates.length && parsedRates.every(rate => /^\d+(\.\d{1,4})?$/.test(rate));
  usePendingChanges(parsedRates.join(",") !== workspace.taxRates.join(",") || Boolean(validFrom || validUntil || label || confirmed), onPendingChangesChange);
  return <Panel title="Daňová konfigurácia organizácie"><Notice>Sadzby nastavte iba podľa potvrdených podkladov vlastníka. Aplikácia nepredvyplní zákonnú sadzbu. Testovacie pravidlo zreteľne označte.</Notice><div className={styles.grid}><Field label="Sadzby v percentách, oddelené čiarkou" value={rates} onChange={event => { setRates(event.target.value); setConfirmed(false); }} /><Field label="Názov / referencia schváleného pravidla" value={label} onChange={event => setLabel(event.target.value)} /><Field label="Platnosť od" type="date" value={validFrom} onChange={event => setValidFrom(event.target.value)} /><Field label="Platnosť do (voliteľné)" type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} /></div><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Potvrdzujem schválený daňový podklad pre uvedené obdobie.</label><Button primary disabled={busy || !valid || !validFrom || !label.trim() || !confirmed} onClick={async () => { if (await send({ type: "set_tax_config", targetId: workspace.actor.organizationId, payload: { rates: parsedRates, validFrom, ...(validUntil ? { validUntil } : {}), label } }, "Daňové pravidlá sú uložené.")) { setRates(parsedRates.join(", ")); setValidFrom(""); setValidUntil(""); setLabel(""); setConfirmed(false); } }}>Uložiť schválenú konfiguráciu</Button></Panel>;
}
