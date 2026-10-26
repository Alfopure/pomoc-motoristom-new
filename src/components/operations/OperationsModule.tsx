"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CalendarClock, Car, CheckCircle2, ClipboardList, Plus, RefreshCw, Route, X } from "lucide-react";
import type { Operation, OperationAction, OperationCommand, OperationsWorkspace } from "@/domain/operations";
import { Button, Field, Notice, Select, TextArea } from "@/components/towing/primitives";
import styles from "./operations.module.css";

const kinds = { tow: "Odťah", delivery: "Pristavenie", collection: "Odvoz vozidla", transfer: "Presun" };
const statuses: Record<string, string> = { draft: "Na naplánovanie", assigned: "Pridelené", accepted: "Prijaté", en_route: "Na ceste", arrived: "Na mieste", collected: "Vozidlo prevzaté", completed: "Vykonané", cancelled: "Zrušené", submitted: "Vykonané · na kontrolu", needs_changes: "Na doplnenie", in_progress: "Prebieha", review: "Na kontrolu", approved: "Schválené", invoiced: "Vyfakturované", paid: "Uhradené" };
const date = (value: string | null) => value ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Bez dohodnutého termínu";
const localDate = (value: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
const iso = (value: FormDataEntryValue | null) => typeof value === "string" && value ? new Date(value).toISOString() : null;
const value = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const storageKey = (workspace: OperationsWorkspace) => `motorist:operation-command:v1:${workspace.actor.organizationId}:${workspace.actor.userId}`;

export function OperationsModule({ caseId, cases = [], mine = false, onOpenCase }: { caseId?: string; cases?: { id: string; caseNumber: string }[]; mine?: boolean; onOpenCase?: (id: string) => void }) {
  const [workspace, setWorkspace] = useState<OperationsWorkspace | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("open");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<OperationCommand | null>(null);
  const pendingRef = useRef<OperationCommand | null>(null);
  const inFlight = useRef(false);
  const workspaceRef = useRef<OperationsWorkspace | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: "50", offset: String(offset), ...(caseId ? { caseId } : {}), ...(mine ? { mine: "true" } : {}) });
    const response = await fetch(`/api/operations?${query}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Jazdy sa nepodarilo načítať.");
    return body as OperationsWorkspace;
  }, [caseId, mine, offset]);

  async function refreshWorkspace() {
    const data = await load();
    workspaceRef.current = data;
    setWorkspace(data);
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(data => {
      if (controller.signal.aborted) return;
      workspaceRef.current = data;
      setWorkspace(data);
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey(data)) ?? "null");
        if (saved?.commandId && typeof saved.action === "string") { pendingRef.current = saved; setPending(saved); }
      } catch { /* Session storage is optional. */ }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  async function run(command: OperationCommand) {
    if (inFlight.current) return;
    inFlight.current = true;
    pendingRef.current = command;
    setPending(command); setBusy(true); setError(""); setNotice("");
    const currentWorkspace = workspaceRef.current;
    if (currentWorkspace) { try { sessionStorage.setItem(storageKey(currentWorkspace), JSON.stringify(command)); } catch { /* Optional persistence. */ } }
    try {
      const response = await fetch("/api/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status < 500) clearPending();
        if (response.status === 409) await refreshWorkspace();
        throw new Error(body.message ?? body.error ?? "Zmenu sa nepodarilo uložiť.");
      }
      clearPending();
      setSelectedId(body.operation.id); setShowCreate(false); setNotice("Zmena bola uložená.");
      await refreshWorkspace();
    } catch (error) { setError(error instanceof Error ? error.message : "Výsledok uloženia sa nepodarilo overiť."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  function clearPending() {
    pendingRef.current = null; setPending(null);
    if (workspaceRef.current) { try { sessionStorage.removeItem(storageKey(workspaceRef.current)); } catch { /* Optional persistence. */ } }
  }
  function command(action: OperationAction, payload: Record<string, unknown> = {}, operation?: Operation) {
    if (pendingRef.current) return;
    void run({ commandId: crypto.randomUUID(), action, expectedRevision: operation?.revision ?? 0, ...(operation ? { operationId: operation.id } : {}), payload });
  }
  const selected = workspace?.operations.find(item => item.id === selectedId);
  const rows = workspace?.operations.filter(item => (filter === "all" || (filter === "done" ? ["completed", "cancelled", "paid"].includes(item.status) : !["completed", "cancelled", "paid"].includes(item.status))) && `${item.caseNumber ?? ""} ${item.vehicle ?? ""} ${item.from} ${item.to} ${item.assignee ?? ""}`.toLocaleLowerCase("sk").includes(search.toLocaleLowerCase("sk"))) ?? [];
  const blocked = busy || Boolean(pending);

  return <section className={styles.module} aria-label={mine ? "Moje jazdy" : "Výjazdy a odvozy"}>
    <div className={styles.heading}><div><div className={styles.eyebrow}><Route size={15} /> Spoločná prevádzka</div><h1>{mine ? "Moje jazdy" : "Výjazdy a odvozy"}</h1><p>Pristavenia, návraty a presuny vozidiel na jednom mieste.</p></div><div className={styles.actions}><Button disabled={loading || busy} onClick={() => { setError(""); void refreshWorkspace().catch(error => setError(error.message)); }} aria-label="Obnoviť jazdy"><RefreshCw size={16} /> Obnoviť</Button>{workspace?.actor.canDispatch && <Button primary disabled={blocked} onClick={() => setShowCreate(!showCreate)}><Plus size={16} /> Nová jazda</Button>}</div></div>
    {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {pending && <Notice>Výsledok predchádzajúceho príkazu ešte nie je potvrdený. <Button disabled={busy} onClick={() => void run(pending)}>Overiť a zopakovať ten istý príkaz</Button></Notice>}
    {showCreate && workspace && <form className={styles.panel} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); command("create", { kind: value(form, "kind"), caseId: caseId ?? (value(form, "caseId") || null), fleetAssetId: value(form, "fleetAssetId") || null, cycleId: value(form, "cycleId") || null, from: value(form, "from"), to: value(form, "to"), scheduledAt: iso(form.get("scheduledAt")), plannedEndAt: iso(form.get("plannedEndAt")), returnMode: "undecided" }); }}><div className={styles.panelHeading}><h2>Nová logistická jazda</h2><Button onClick={() => setShowCreate(false)} aria-label="Zavrieť novú jazdu"><X size={16} /></Button></div><div className={styles.fields}><Select label="Druh jazdy" name="kind" required><option value="delivery">Pristavenie náhradného vozidla</option><option value="collection">Odvoz vozidla</option><option value="transfer">Presun vozidla</option></Select>{!caseId && <Select label="Súvisiaci prípad" name="caseId"><option value="">Samostatná jazda</option>{cases.map(item => <option key={item.id} value={item.id}>{item.caseNumber}</option>)}</Select>}<Select label="Vozidlo" name="fleetAssetId" required><option value="">Vyberte vozidlo</option>{workspace.fleet.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select label="Cyklus používania (pri odvoze povinné)" name="cycleId"><option value="">Nové pristavenie alebo samostatný presun</option>{(workspace.cycles ?? []).map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.vehicle ?? cycle.fleetAssetId} · {cycle.caseNumber ?? "bez prípadu"}</option>)}</Select><Field label="Odkiaľ" name="from" required maxLength={500} /><Field label="Kam" name="to" required maxLength={500} /><Field label="Dohodnutý začiatok (voliteľné)" name="scheduledAt" type="datetime-local" /><Field label="Predpokladaný koniec (voliteľné)" name="plannedEndAt" type="datetime-local" /></div><p className={styles.muted}>Pridelenie vodičovi ešte nepotvrdzuje čas ani dostupnosť. Odťah vytvorte z prípadu v časti Odťahové zákazky.</p><Button primary type="submit" disabled={blocked}>Vytvoriť jazdu</Button></form>}
    <div className={styles.toolbar}><Field label="Hľadať jazdu" value={search} onChange={event => setSearch(event.target.value)} placeholder="Prípad, vozidlo, miesto, vodič…" /><Select label="Zobraziť" value={filter} onChange={event => setFilter(event.target.value)}><option value="open">Otvorené jazdy</option><option value="done">Dokončené a zrušené</option><option value="all">Všetky jazdy</option></Select><span className={styles.muted}>{rows.length} z {workspace?.totalCount ?? 0} jázd</span></div>
    <div className={styles.actions}><Button disabled={offset === 0 || busy} onClick={() => setOffset(Math.max(0, offset - 50))}>Predchádzajúce</Button><span className={styles.muted}>{workspace?.totalCount ? `${offset + 1}–${offset + workspace.operations.length} z ${workspace.totalCount}` : "0 jázd"}</span><Button disabled={!workspace || offset + workspace.operations.length >= workspace.totalCount || busy} onClick={() => setOffset(offset + 50)}>Ďalšie</Button></div>
    {loading ? <p role="status">Načítavam jazdy…</p> : <div className={styles.layout}><div className={styles.list}>{rows.length === 0 && <div className={styles.empty}><ClipboardList size={28} /><h2>Žiadne jazdy v tomto zobrazení</h2><p>Nová jazda môže čakať v poradí aj bez dohodnutého termínu.</p></div>}{rows.map(item => <button type="button" className={`${styles.row} ${selectedId === item.id ? styles.selected : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}><div className={styles.rowTop}><span className={styles.kind}>{kinds[item.kind]}</span><span className={styles.status}>{statuses[item.status] ?? item.status}</span></div><strong>{item.from || "Miesto vyzdvihnutia"} <ArrowRight size={14} /> {item.to || "Cieľ jazdy"}</strong><span><Car size={14} /> {item.vehicle ?? "Vozidlo neurčené"} · {item.caseNumber ?? "Samostatná jazda"}</span><span><CalendarClock size={14} /> {date(item.scheduledAt)}</span><div className={styles.rowTop}><span>{item.assignee ?? "Bez vodiča"}{item.startedAt ? " · skutočný štart zaznamenaný" : item.confirmedAt ? " · termín potvrdený" : " · čaká v poradí"}</span>{item.status === "completed" && item.evidenceState !== "complete" && <span className={styles.waiting}>Dôkazy čakajú</span>}</div></button>)}</div>{selected && workspace && <OperationDetail key={`${selected.id}:${selected.revision}`} operation={selected} workspace={workspace} disabled={blocked} onCommand={(action, payload) => command(action, payload, selected)} onOpenCase={onOpenCase} onClose={() => setSelectedId(null)} />}</div>}
  </section>;
}

function OperationDetail({ operation: item, workspace, disabled, onCommand, onOpenCase, onClose }: { operation: Operation; workspace: OperationsWorkspace; disabled: boolean; onCommand: (action: OperationAction, payload?: Record<string, unknown>) => void; onOpenCase?: (id: string) => void; onClose: () => void }) {
  const office = workspace.actor.canDispatch;
  const local = item.owner === "logistics";
  const finished = ["completed", "cancelled"].includes(item.status);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [upload, setUpload] = useState({ busy: false, reference: "", error: "" });
  const fieldEvidenceDisabled = disabled || (!office && finished);
  return <aside className={styles.detail} aria-label="Detail jazdy"><div className={styles.panelHeading}><div><span className={styles.eyebrow}>{kinds[item.kind]}</span><h2>{statuses[item.status] ?? item.status}</h2></div><Button onClick={onClose} aria-label="Zavrieť detail jazdy"><X size={16} /></Button></div><p className={styles.route}>{item.from} <ArrowRight size={16} /> {item.to}</p><p>{item.vehicle ?? "Bez vozidla"} · {item.assignee ?? "Nepridelené"}</p>{item.customer && <p className={styles.muted}>Kontakt: {item.customer.name ?? "Zákazník"}{item.customer.phone && <> · <a href={`tel:${item.customer.phone}`}>{item.customer.phone}</a></>}</p>}<p className={styles.muted}>{date(item.scheduledAt)}{item.startedAt && <> · Skutočný štart {date(item.startedAt)}</>}</p>{office && item.caseId && (onOpenCase ? <Button onClick={() => onOpenCase(item.caseId!)}>Otvoriť prípad {item.caseNumber}</Button> : <a href={`/?case=${item.caseId}`}>Otvoriť prípad {item.caseNumber}</a>)}
    {!local && <div className={styles.panel}><p>Priebeh odťahu a vyúčtovanie vedie odťahová zákazka.</p><a href={`/zakazky?orderId=${item.ownerId}`} target="_blank" rel="noreferrer">Otvoriť odťahovú zákazku ↗</a></div>}{(local || (office && Boolean(item.cycle))) && <>
      {local && !finished && office && <form className={styles.form} onSubmit={event => { event.preventDefault(); onCommand("assign", { assigneeId: value(new FormData(event.currentTarget), "assigneeId") }); }}><Select label="Prideliť do poradia vodiča" name="assigneeId" defaultValue={item.assigneeId ?? ""} required><option value="">Vyberte vodiča</option>{workspace.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select><Button type="submit" disabled={disabled}>Prideliť</Button></form>}
      {local && !finished && office && <form className={styles.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("reschedule", { scheduledAt: iso(form.get("scheduledAt")), plannedEndAt: iso(form.get("plannedEndAt")) }); }}><Field label="Dohodnutý začiatok" type="datetime-local" name="scheduledAt" defaultValue={localDate(item.scheduledAt)} /><Field label="Predpokladaný koniec" type="datetime-local" name="plannedEndAt" defaultValue={localDate(item.plannedEndAt)} /><Button type="submit" disabled={disabled}>Uložiť plán</Button></form>}
      {local && !finished && <div className={styles.actions}>{item.status === "assigned" && <Button disabled={disabled} onClick={() => onCommand("accept")}>Prijať jazdu</Button>}{office && item.assigneeId && !item.confirmedAt && item.scheduledAt && item.plannedEndAt && <Button disabled={disabled} onClick={() => onCommand("confirm")}>Potvrdiť termín</Button>}{["assigned", "accepted"].includes(item.status) && <Button primary disabled={disabled} onClick={() => onCommand("start")}>Začať jazdu</Button>}{item.status === "en_route" && <Button primary disabled={disabled} onClick={() => onCommand("arrive")}>Som na mieste</Button>}{item.kind === "collection" && item.status === "arrived" && <Button primary disabled={disabled} onClick={() => onCommand("collect")}>Vozidlo prevzaté</Button>}{(item.kind === "collection" ? item.status === "collected" : item.status === "arrived") && <Button primary disabled={disabled} onClick={() => onCommand("complete")}>Dokončiť jazdu</Button>}{office && <Button danger disabled={disabled} onClick={() => setCancelOpen(!cancelOpen)}>Zrušiť jazdu</Button>}</div>}
      {local && cancelOpen && <form className={styles.form} onSubmit={event => { event.preventDefault(); onCommand("cancel", { reason: value(new FormData(event.currentTarget), "reason") }); }}><TextArea label="Dôvod zrušenia jazdy" name="reason" required maxLength={1000} /><Button type="submit" danger disabled={disabled}>Potvrdiť zrušenie</Button></form>}<div className={styles.panel}><div className={styles.panelHeading}><h3><CheckCircle2 size={16} /> Doklady o prevzatí a odovzdaní</h3><Button disabled={fieldEvidenceDisabled} onClick={() => setEvidenceOpen(!evidenceOpen)}>Doplniť</Button></div><p className={styles.muted}>{item.evidenceState === "complete" ? "Požadované dôkazy sú doplnené." : "Dôkazy čakajú. Fyzicky vykonanú jazdu netreba dokončovať znova."}</p>{item.evidence.map(evidence => <div className={styles.evidence} key={evidence.id}><strong>{({ pickup: "Prevzatie", handover: "Odovzdanie", inspection: "Kontrola", damage: "Poškodenie" })[evidence.stage]}</strong><span>{date(evidence.observedAt)} · {evidence.source === "observed" ? "Priame pozorovanie" : evidence.source === "reported" ? "Nahlásené" : "Zaznamenaná výnimka"}</span><p>{evidence.person} {evidence.note}{evidence.odometer !== null && ` · ${evidence.odometer} km`}{evidence.fuel && ` · palivo ${evidence.fuel}`}</p>{evidence.photoReference && <a href={`/api/operations/${item.id}/files?reference=${encodeURIComponent(evidence.photoReference)}`} target="_blank" rel="noreferrer">Stiahnuť doklad</a>}{evidence.missingReason && <p>Výnimka: {evidence.missingReason}</p>}</div>)}{evidenceOpen && <form className={styles.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("evidence", { stage: value(form, "stage"), source: value(form, "source"), observedAt: iso(form.get("observedAt")), person: value(form, "person") || null, note: value(form, "note"), photoReference: upload.reference || null, odometer: value(form, "odometer") === "" ? null : Number(value(form, "odometer")), fuel: value(form, "fuel") || null, missingReason: value(form, "missingReason") || null }); }}><Select label="Časť jazdy" name="stage"><option value="pickup">Prevzatie</option><option value="handover">Odovzdanie</option><option value="inspection">Kontrola vozidla</option><option value="damage">Poškodenie</option></Select><Select label="Pôvod údaja" name="source" defaultValue={office ? "reported" : "observed"}><option value="observed">Osobne zistené</option><option value="reported">Nahlásené inou osobou</option><option value="exception">Výnimka s odôvodnením</option></Select><Field label="Skutočný čas zistenia" name="observedAt" type="datetime-local" required /><Field label="Odovzdávajúca / preberajúca osoba" name="person" maxLength={200} /><Field label="Stav kilometrov" name="odometer" type="number" min={0} /><Field label="Palivo" name="fuel" maxLength={100} /><Field label="Fotografia alebo doklad (do 4 MB)" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={upload.busy || fieldEvidenceDisabled} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 4 * 1024 * 1024) { setUpload({ busy: false, reference: "", error: "Najväčšia veľkosť súboru je 4 MB." }); return; } setUpload({ busy: true, reference: "", error: "" }); try { const response = await fetch(`/api/operations/${item.id}/files`, { method: "POST", headers: { "Content-Type": file.type }, body: file }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error ?? "Doklad sa nepodarilo nahrať."); setUpload({ busy: false, reference: body.reference, error: "" }); } catch (error) { setUpload({ busy: false, reference: "", error: error instanceof Error ? error.message : "Nahratie sa nepodarilo." }); } }} />{upload.busy && <p role="status">Nahrávam doklad…</p>}{upload.error && <Notice kind="error">{upload.error}</Notice>}{upload.reference && <p role="status">Doklad je nahratý. Uložte dôkaz.</p>}<TextArea label="Zistenia vrátane poškodenia" name="note" required maxLength={2000} /><TextArea label="Dôvod chýbajúceho údaja alebo dokladu" name="missingReason" maxLength={1000} /><Button type="submit" primary disabled={fieldEvidenceDisabled || upload.busy}>Uložiť dôkaz</Button></form>}</div>
      {item.cycle && <div className={styles.panel}><div className={styles.panelHeading}><h3>Návrat a pripravenosť vozidla</h3>{local && office && <Button disabled={disabled} onClick={() => setReturnOpen(!returnOpen)}>Upraviť návrat</Button>}</div><p>{({ collect: "Odvoz vozidla", customer_returns: "Zákazník vozidlo vráti", undecided: "Spôsob návratu sa dohodne", continues: "Používanie pokračuje" })[item.cycle.returnMode]} · {date(item.cycle.returnAt)}</p>{item.cycle.returnOperationOwner === "towing_order" && <p className={styles.muted}>Návrat vykonáva prepojená odťahová zákazka. Termín upravte v nej.</p>}<p className={styles.muted}>Zodpovedná osoba: {item.cycle.nextOwner ?? "Neurčená"} · {item.cycle.readiness === "ready" ? "Pripravené" : item.cycle.readiness === "blocked" ? "Blokované" : "Pripravenosť neoverená"}</p>{local && returnOpen && <form className={styles.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("return", { returnMode: value(form, "returnMode"), returnAt: iso(form.get("returnAt")), nextOwner: value(form, "nextOwner") }); }}><Select label="Spôsob návratu" name="returnMode" defaultValue={item.cycle.returnMode}><option value="collect">Odvoz vozidla</option><option value="customer_returns">Zákazník vozidlo vráti</option><option value="undecided">Zatiaľ sa nevie</option><option value="continues">Používanie pokračuje</option></Select><Field label="Dohodnutý návrat" name="returnAt" type="datetime-local" defaultValue={localDate(item.cycle.returnAt)} /><Field label="Kto zabezpečí ďalší krok" name="nextOwner" defaultValue={item.cycle.nextOwner ?? ""} required maxLength={200} /><Button primary type="submit" disabled={disabled}>Uložiť návrat</Button></form>}{local && office && item.cycle.status === "open" && item.cycle.returnMode === "customer_returns" && <Button disabled={disabled} onClick={() => onCommand("return", { returnMode: "customer_returns", returnAt: item.cycle!.returnAt, nextOwner: item.cycle!.nextOwner, returned: true })}>Zákazník vozidlo skutočne vrátil</Button>}{office && item.cycle.status === "returned" && <form className={styles.form} onSubmit={event => { event.preventDefault(); onCommand("inspect", { note: value(new FormData(event.currentTarget), "note") }); }}><p className={styles.muted}>Najprv doplňte dôkaz typu Kontrola vozidla s kilometrami, palivom a fotografiou alebo vysvetlenou výnimkou.</p><TextArea label="Výsledok kontroly vráteného vozidla" name="note" required maxLength={2000} /><Button disabled={disabled} type="submit">Potvrdiť kontrolu a pripravenosť</Button></form>}</div>}
    </>}
  </aside>;
}

export function CaseOperationsPanel({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return <section className={styles.casePanel}><button type="button" className={styles.caseToggle} aria-expanded={open} onClick={() => { setOpen(!open); setVisited(true); }}><Route size={17} /> Pristavenia, odvozy a návraty <span>{open ? "Zavrieť" : "Otvoriť"}</span></button>{visited && <div hidden={!open}><OperationsModule caseId={caseId} /></div>}</section>;
}
