"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BarChart3, Building2, CalendarClock, Car, ClipboardList, Inbox, Plus, RefreshCw, Send, Users, X } from "lucide-react";
import { Button, Field, Notice, Select, TextArea } from "@/components/towing/primitives";
import styles from "@/components/operations/operations.module.css";
import own from "./branches.module.css";
import { formatDuration, workKinds, workState, type BranchCommand, type BranchReport, type BranchView, type BranchWorkspace as Workspace, type WorkGroup, type WorkRequest, type WorkRequestKind } from "@/domain/work-groups";

type Tab = "overview" | "work" | "reports" | "team";
const states: Record<ReturnType<typeof workState>, string> = { queued: "Čaká na prevzatie", claimed: "Prevzaté · na pridelenie", assigned: "Pridelené vykonávateľovi", in_progress: "Prebieha", done: "Vykonané", cancelled: "Zrušené" };
const executionStatuses: Record<string, string> = { draft: "Na naplánovanie", assigned: "Pridelené", accepted: "Prijaté vodičom", en_route: "Na ceste", arrived: "Na mieste", collected: "Vozidlo prevzaté", completed: "Vykonané", cancelled: "Zrušené", in_progress: "Prebieha", submitted: "Odovzdané na kontrolu", needs_changes: "Na doplnenie" };
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Bratislava" }).format(new Date(value)) : "Bez termínu";
const localDate = (value: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
const iso = (value: FormDataEntryValue | null) => typeof value === "string" && value ? new Date(value).toISOString() : null;
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const day = (offset: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

export function BranchWorkspace({ caseId, cases = [], onOpenCase, standalone = false }: { caseId?: string; cases?: { id: string; caseNumber: string }[]; onOpenCase?: (id: string) => void; standalone?: boolean }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tab, setTab] = useState<Tab>(caseId ? "work" : "overview");
  const [groupId, setGroupId] = useState("");
  const [view, setView] = useState<BranchView>("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<BranchCommand | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ view, limit: "100", ...(groupId ? { groupId } : {}), ...(caseId ? { caseId } : {}) });
    const response = await fetch(`/api/pobocky?${query}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Pobočky sa nepodarilo načítať.");
    return body as Workspace;
  }, [caseId, groupId, view]);
  const refresh = useCallback(async () => { setWorkspace(await load()); }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(setWorkspace).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    // The queue is the first pilot's notification channel: refresh while visible.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && !inFlight.current) void load().then(setWorkspace).catch(() => undefined); }, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  async function run(command: BranchCommand, success: string) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice(""); setPending(command);
    try {
      const response = await fetch("/api/pobocky", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setPending(null); setError(body.error ?? "Príkaz sa nepodarilo vykonať."); await refresh().catch(() => undefined); return; }
      setPending(null); setNotice(success); setShowCreate(false);
      if (body.request?.id) setSelectedId(body.request.id);
      await refresh();
    } catch { setError("Výsledok príkazu sa nepodarilo overiť. Skúste ten istý príkaz zopakovať – nevytvorí sa druhýkrát."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const command = (action: BranchCommand["action"], payload: Record<string, unknown>, success: string, request?: WorkRequest, expectedRevision?: number) =>
    void run({ commandId: crypto.randomUUID(), action, payload, ...(request ? { requestId: request.id, expectedRevision: request.revision } : expectedRevision !== undefined ? { expectedRevision } : {}) }, success);

  if (loading) return <section className={styles.module}><p role="status">Načítavam pobočky…</p></section>;
  if (!workspace) return <section className={styles.module}><Notice kind="error">{error || "Modul Pobočky nie je dostupný."}</Notice></section>;
  const { actor } = workspace;
  const selected = workspace.requests.find(item => item.id === selectedId) ?? null;
  const scopeName = groupId ? workspace.groups.find(group => group.id === groupId)?.name : actor.central ? "Všetky pobočky" : "Moje pobočky";
  const blocked = busy || Boolean(pending);
  const queued = workspace.groups.reduce((sum, group) => sum + (groupId && group.id !== groupId ? 0 : group.counts.queued), 0);
  const tabs: [Tab, string, typeof Inbox][] = [["overview", "Prehľad", Inbox], ["work", "Prípady a práca", ClipboardList], ["reports", "Reporty", BarChart3], ...(actor.manage ? [["team", "Tím a nastavenie", Users] as [Tab, string, typeof Inbox]] : [])];

  return <section className={`${styles.module} ${standalone ? own.standalone : ""}`} aria-label="Pobočky">
    {!caseId && <div className={styles.heading}><div><div className={styles.eyebrow}><Building2 size={15} /> {actor.central ? "Centrála" : "Pobočka"}</div><h1>{scopeName}</h1><p>{actor.central ? "Odovzdanie práce pobočkám, ich priebeh a výsledky." : `Prihlásený: ${actor.displayName}. Vidíte iba prácu svojich pobočiek.`}</p></div>
      <div className={styles.actions}>{(actor.central || workspace.groups.length > 1) && <Select label="Pobočka" value={groupId} onChange={event => { setGroupId(event.target.value); setSelectedId(null); }}><option value="">{actor.central ? "Všetky pobočky" : "Všetky moje pobočky"}</option>{workspace.groups.map(group => <option key={group.id} value={group.id}>{group.name}{group.active ? "" : " (neaktívna)"}</option>)}</Select>}
        <Button disabled={busy} onClick={() => { setError(""); void refresh().catch(reason => setError(reason.message)); }} aria-label="Obnoviť"><RefreshCw size={16} /> Obnoviť</Button>
        {actor.central && <Button primary disabled={blocked || workspace.groups.length === 0} onClick={() => { setShowCreate(!showCreate); setTab("work"); }}><Send size={16} /> Odoslať pobočke</Button>}</div></div>}
    {caseId && <div className={styles.actions}>{actor.central && <Button primary disabled={blocked || workspace.groups.length === 0} onClick={() => setShowCreate(!showCreate)}><Send size={16} /> Odoslať pobočke</Button>}<Button disabled={busy} onClick={() => void refresh().catch(reason => setError(reason.message))}><RefreshCw size={16} /> Obnoviť</Button></div>}
    {!caseId && <nav className={own.tabs} aria-label="Časti modulu Pobočky">{tabs.map(([key, label, Icon]) => <button type="button" key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}><Icon size={15} /> {label}{key === "overview" && queued > 0 && <span className={own.badge}>{queued}</span>}</button>)}</nav>}
    {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {pending && !busy && <Notice>Výsledok predchádzajúceho príkazu nie je potvrdený. <Button disabled={busy} onClick={() => void run(pending, "Príkaz bol overený.")}>Zopakovať ten istý príkaz</Button></Notice>}
    {workspace.groups.length === 0 && <Notice>{actor.manage ? "Zatiaľ nie je nastavená žiadna pobočka. Vytvorte ju v časti Tím a nastavenie." : "Zatiaľ nie je nastavená žiadna pobočka. Požiadajte vedúceho o nastavenie."}</Notice>}
    {showCreate && actor.central && <CreateRequest workspace={workspace} caseId={caseId} cases={cases} groupId={groupId} disabled={blocked} onClose={() => setShowCreate(false)} onSubmit={payload => command("create", payload, "Požiadavka bola odoslaná pobočke.", undefined, 0)} />}
    {tab === "overview" && !caseId && <Overview workspace={workspace} groupId={groupId} onOpen={id => { setSelectedId(id); setView("open"); setTab("work"); }} onGroup={id => { setGroupId(id); setTab("work"); setView("queue"); }} />}
    {tab === "work" && <>
      <div className={styles.toolbar}><Select label="Zobraziť" value={view} onChange={event => { setView(event.target.value as BranchView); setSelectedId(null); }}><option value="open">Otvorená práca</option><option value="queue">Čaká na prevzatie a pridelenie</option><option value="active">Pridelená a prebiehajúca</option><option value="done">Vykonaná a zrušená</option><option value="all">Všetko</option></Select><span className={styles.muted}>{workspace.requests.length} z {workspace.totalCount} požiadaviek</span></div>
      <div className={`${styles.layout} ${selected ? styles.layoutWithDetail : ""}`}><div className={styles.list}>
        {workspace.requests.length === 0 && <div className={styles.empty}><ClipboardList size={28} /><h2>Žiadna práca v tomto zobrazení</h2><p>Požiadavka môže prísť aj bez vybraného auta; konkrétny výkon vznikne až pri pridelení.</p></div>}
        {workspace.requests.map(item => <RequestRow key={item.id} request={item} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />)}
      </div>{selected && <RequestDetail key={selected.id} request={selected} workspace={workspace} disabled={blocked} onClose={() => setSelectedId(null)} onOpenCase={onOpenCase} onCommand={(action, payload, success) => command(action, payload, success, selected)} />}</div>
    </>}
    {tab === "reports" && !caseId && <Reports groupId={groupId} />}
    {tab === "team" && actor.manage && !caseId && <Team workspace={workspace} disabled={blocked} onCommand={(action, payload, success, revision) => command(action, payload, success, undefined, revision)} />}
  </section>;
}

function RequestRow({ request, selected, onSelect }: { request: WorkRequest; selected: boolean; onSelect: () => void }) {
  const state = workState(request);
  const overdue = request.dueAt && new Date(request.dueAt) < new Date() && ["queued", "claimed", "assigned"].includes(state);
  return <button type="button" className={`${styles.row} ${selected ? styles.selected : ""}`} onClick={onSelect}>
    <div className={styles.rowTop}><span className={styles.kind}>{workKinds[request.kind]} · {request.groupName}</span><span className={`${styles.status} ${state === "queued" ? own.attention : ""}`}>{states[state]}</span></div>
    <strong>{request.pickup || "Miesto vyzdvihnutia"} <ArrowRight size={14} /> {request.destination || "Cieľ"}</strong>
    <span><Car size={14} /> {request.vehicle ?? "Vozidlo neurčené"} · {request.caseNumber ?? "Bez prípadu"}</span>
    <span><CalendarClock size={14} /> {date(request.dueAt)}{overdue && <b className={styles.waiting}> · po termíne</b>}</span>
    <span>{request.execution?.assignee ? `Vykonáva: ${request.execution.assignee}` : request.claimedByName ? `Prevzal: ${request.claimedByName}` : "Nikto ešte neprevzal"}</span>
  </button>;
}

function Overview({ workspace, groupId, onOpen, onGroup }: { workspace: Workspace; groupId: string; onOpen: (id: string) => void; onGroup: (id: string) => void }) {
  const groups = workspace.groups.filter(group => !groupId || group.id === groupId);
  const waiting = workspace.requests.filter(item => item.status === "queued").slice(0, 8);
  return <div className={own.overview}>
    <div className={own.cards}>{groups.map(group => <button type="button" key={group.id} className={own.card} onClick={() => onGroup(group.id)}>
      <span className={styles.eyebrow}>{group.branchName ?? "Fyzická pobočka neurčená"}</span><strong>{group.name}</strong>
      <dl><div><dt>Čaká na prevzatie</dt><dd className={group.counts.queued ? own.attention : ""}>{group.counts.queued}</dd></div><div><dt>Na pridelenie</dt><dd>{group.counts.claimed}</dd></div><div><dt>V realizácii</dt><dd>{group.counts.active}</dd></div><div><dt>Po termíne</dt><dd className={group.counts.overdue ? own.attention : ""}>{group.counts.overdue}</dd></div></dl>
      <span className={styles.muted}>{group.members.filter(member => member.role === "lead").map(member => member.name).join(", ") || "Bez miestneho dispečera"}</span>
    </button>)}</div>
    <div className={styles.panel}><div className={styles.panelHeading}><h3><Inbox size={16} /> Nová práca na prevzatie</h3></div>
      {waiting.length === 0 ? <p className={styles.muted}>Momentálne nič nečaká na prevzatie.</p> : <div className={styles.list}>{waiting.map(item => <RequestRow key={item.id} request={item} selected={false} onSelect={() => onOpen(item.id)} />)}</div>}
      <p className={styles.muted}>Zoznam sa obnovuje každých 30 sekúnd. Systémové upozornenia na mobile prídu v ďalšej verzii aplikácie.</p></div>
  </div>;
}

function CreateRequest({ workspace, caseId, cases, groupId, disabled, onClose, onSubmit }: { workspace: Workspace; caseId?: string; cases: { id: string; caseNumber: string }[]; groupId: string; disabled: boolean; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => void }) {
  const [kind, setKind] = useState<WorkRequestKind>("delivery");
  const [target, setTarget] = useState(groupId || workspace.groups.find(group => group.active)?.id || "");
  const group = workspace.groups.find(item => item.id === target);
  const cycles = workspace.cycles.filter(cycle => !caseId || cycle.caseId === caseId);
  return <form className={styles.panel} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
    onSubmit({ groupId: target, kind, caseId: caseId ?? (text(form, "caseId") || null), pickup: text(form, "pickup"), destination: text(form, "destination"), dueAt: iso(form.get("dueAt")), note: text(form, "note"), fleetAssetId: text(form, "fleetAssetId") || null, cycleId: text(form, "cycleId") || null }); }}>
    <div className={styles.panelHeading}><h2>Odoslať prácu pobočke</h2><Button type="button" onClick={onClose} aria-label="Zavrieť"><X size={16} /></Button></div>
    <div className={styles.fields}>
      <Select label="Pobočka" value={target} onChange={event => { const next = workspace.groups.find(item => item.id === event.target.value); setTarget(event.target.value); if (next && !next.serviceKinds.includes(kind)) setKind(next.serviceKinds[0]); }} required><option value="">Vyberte pobočku</option>{workspace.groups.filter(item => item.active).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
      <Select label="Druh práce" value={kind} onChange={event => setKind(event.target.value as WorkRequestKind)} required>{(Object.keys(workKinds) as WorkRequestKind[]).filter(item => !group || group.serviceKinds.includes(item)).map(item => <option key={item} value={item}>{workKinds[item]}</option>)}</Select>
      {!caseId && <Select label="Súvisiaci prípad" name="caseId"><option value="">Bez prípadu</option>{cases.map(item => <option key={item.id} value={item.id}>{item.caseNumber}</option>)}</Select>}
      <Field label="Odkiaľ" name="pickup" maxLength={1000} /><Field label="Kam" name="destination" maxLength={1000} /><Field label="Požadovaný termín" type="datetime-local" name="dueAt" />
      {kind === "delivery" && <Select label="Náhradné vozidlo (nepovinné)" name="fleetAssetId"><option value="">Vyberie pobočka / zatiaľ neurčené</option>{workspace.fleet.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>}
      {kind === "collection" && <Select label="Vozidlo u zákazníka" name="cycleId" required><option value="">Vyberte používané vozidlo</option>{cycles.map(item => <option key={item.id} value={item.id}>{item.vehicle}</option>)}</Select>}
    </div>
    <TextArea label="Pokyny pre pobočku" name="note" maxLength={4000} />
    <div className={styles.actions}><Button primary type="submit" disabled={disabled || !target}><Send size={16} /> Odoslať</Button><span className={styles.muted}>Pobočka uvidí iba údaje potrebné na vykonanie, nie celý spis prípadu.</span></div>
  </form>;
}

function RequestDetail({ request, workspace, disabled, onClose, onCommand, onOpenCase }: { request: WorkRequest; workspace: Workspace; disabled: boolean; onClose: () => void; onCommand: (action: BranchCommand["action"], payload: Record<string, unknown>, success: string) => void; onOpenCase?: (id: string) => void }) {
  const { actor } = workspace;
  const [cancelOpen, setCancelOpen] = useState(false);
  const group = workspace.groups.find(item => item.id === request.groupId);
  const mine = request.claimedBy === actor.userId;
  const executors = (group?.members ?? []).filter(member => member.active && (request.kind === "tow" ? member.canDrive : member.canDeliver));
  const execution = request.execution;
  const logistics = execution?.owner === "logistics";
  const live = execution && !execution.done && !execution.cancelled;
  const operate = (action: string, payload: Record<string, unknown>, success: string) => onCommand("operate", { command: { action, expectedRevision: execution?.revision, payload } }, success);
  return <aside className={styles.detail} aria-label="Detail požiadavky">
    <div className={styles.panelHeading}><div><span className={styles.eyebrow}>{workKinds[request.kind]} · {request.groupName}</span><h2>{states[workState(request)]}</h2></div><Button onClick={onClose} aria-label="Zavrieť detail"><X size={16} /></Button></div>
    <p className={styles.route}>{request.pickup || "Miesto neurčené"} <ArrowRight size={16} /> {request.destination || "Cieľ neurčený"}</p>
    <p>{request.vehicle ?? "Vozidlo neurčené"} · {request.caseNumber ?? "Bez prípadu"} · termín {date(request.dueAt)}</p>
    {request.customer && (request.customer.name || request.customer.phone) && <p className={styles.muted}>Kontakt: {request.customer.name || "Zákazník"}{request.customer.phone && <> · <a href={`tel:${request.customer.phone}`}>{request.customer.phone}</a></>}</p>}
    {request.note && <p className={own.note}>{request.note}</p>}
    <p className={styles.muted}>Prišlo do pobočky {date(request.routedAt)}{request.claimedByName && <> · prevzal {request.claimedByName} {date(request.claimedAt)}</>}</p>
    {actor.central && request.caseId && (onOpenCase ? <Button onClick={() => onOpenCase(request.caseId!)}>Otvoriť prípad {request.caseNumber}</Button> : <a href={`/?case=${request.caseId}`}>Otvoriť prípad {request.caseNumber}</a>)}

    {request.status === "queued" && <div className={styles.actions}><Button primary disabled={disabled} onClick={() => onCommand("claim", {}, "Požiadavku ste prevzali.")}>Prevziať</Button></div>}
    {request.status === "claimed" && !mine && <p className={styles.muted}>Požiadavku rieši {request.claimedByName}.{actor.central && " Centrála ju môže vrátiť do frontu."}</p>}
    {request.status === "claimed" && mine && request.kind !== "tow" && <form className={styles.form} onSubmit={event => { event.preventDefault(); onCommand("materialize", { assigneeId: text(new FormData(event.currentTarget), "assigneeId") }, "Práca bola pridelená vykonávateľovi."); }}>
      <Select label="Prideliť vykonávateľovi" name="assigneeId" required><option value="">Vyberte človeka z pobočky</option>{executors.map(member => <option key={member.id} value={member.id}>{member.name}{member.id === actor.memberId ? " (ja)" : ""}</option>)}</Select>
      {executors.length === 0 && <p className={styles.muted}>V pobočke nie je nikto s oprávnením pristavovať. Správca ho doplní v časti Tím a nastavenie.</p>}
      <Button primary type="submit" disabled={disabled || executors.length === 0}>Prideliť</Button></form>}
    {request.status === "claimed" && mine && request.kind === "tow" && <div className={styles.form}><p>Odťah vedie odťahová zákazka: vodiča, priebeh a vyúčtovanie určíte v nej. Zakladá ju odťahová kancelária.</p><Button primary disabled={disabled || !actor.canOperateTowing} onClick={() => onCommand("materialize", {}, "Odťahová zákazka bola založená.")}>Založiť odťahovú zákazku</Button>{!actor.canOperateTowing && <p className={styles.muted}>Na založenie potrebujete oprávnenie odťahovej kancelárie.</p>}</div>}
    {request.status === "claimed" && (mine || actor.central) && <div className={styles.actions}><Button disabled={disabled} onClick={() => onCommand("release", {}, "Požiadavka je opäť vo fronte pobočky.")}>Vrátiť do frontu</Button></div>}
    {actor.central && ["queued", "claimed"].includes(request.status) && <form className={styles.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("route", { groupId: text(form, "groupId"), reason: text(form, "reason") }, "Požiadavka bola presunutá do inej pobočky."); }}>
      <Select label="Presunúť do inej pobočky" name="groupId" required><option value="">Vyberte pobočku</option>{workspace.groups.filter(item => item.active && item.id !== request.groupId && item.serviceKinds.includes(request.kind)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
      <Field label="Dôvod presunu" name="reason" maxLength={1000} /><Button type="submit" disabled={disabled}>Presunúť</Button></form>}
    {["queued", "claimed"].includes(request.status) && <><Button danger disabled={disabled} onClick={() => setCancelOpen(!cancelOpen)}>Zrušiť požiadavku</Button>
      {cancelOpen && <form className={styles.form} onSubmit={event => { event.preventDefault(); onCommand("cancel", { reason: text(new FormData(event.currentTarget), "reason") }, "Požiadavka bola zrušená."); }}><TextArea label="Dôvod zrušenia" name="reason" required maxLength={1000} /><Button danger type="submit" disabled={disabled}>Potvrdiť zrušenie</Button></form>}</>}

    {execution && <div className={styles.panel}><div className={styles.panelHeading}><h3>Vykonanie</h3><span className={styles.status}>{executionStatuses[execution.status] ?? execution.status}</span></div>
      <p>{execution.assignee ? `Vykonáva ${execution.assignee}` : "Vodič zatiaľ nepridelený"} · {date(execution.scheduledAt)}{execution.startedAt && <> · štart {date(execution.startedAt)}</>}{execution.finishedAt && <> · koniec {date(execution.finishedAt)}</>}</p>
      {!logistics && <a href={`/zakazky?orderId=${execution.ownerId}`} target="_blank" rel="noreferrer">Otvoriť odťahovú zákazku ↗</a>}
      {logistics && live && !execution.startedAt && <>
        <form className={styles.form} onSubmit={event => { event.preventDefault(); operate("assign", { assigneeId: text(new FormData(event.currentTarget), "assigneeId") }, "Vykonávateľ bol zmenený."); }}><Select label="Zmeniť vykonávateľa" name="assigneeId" defaultValue={execution.assigneeId ?? ""} required>{executors.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select><Button type="submit" disabled={disabled}>Zmeniť</Button></form>
        <form className={styles.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); operate("reschedule", { scheduledAt: iso(form.get("scheduledAt")), plannedEndAt: iso(form.get("plannedEndAt")) }, "Plán bol uložený."); }}><Field label="Dohodnutý začiatok" type="datetime-local" name="scheduledAt" defaultValue={localDate(execution.scheduledAt)} /><Field label="Predpokladaný koniec" type="datetime-local" name="plannedEndAt" defaultValue={localDate(execution.plannedEndAt)} /><Button type="submit" disabled={disabled}>Uložiť plán</Button></form>
        <div className={styles.actions}>{!execution.confirmedAt && execution.scheduledAt && execution.plannedEndAt && <Button disabled={disabled} onClick={() => operate("confirm", {}, "Termín bol potvrdený.")}>Potvrdiť termín</Button>}<Button danger disabled={disabled} onClick={() => setCancelOpen(!cancelOpen)}>Zrušiť jazdu</Button></div>
        {cancelOpen && <form className={styles.form} onSubmit={event => { event.preventDefault(); operate("cancel", { reason: text(new FormData(event.currentTarget), "reason") }, "Jazda bola zrušená."); }}><TextArea label="Dôvod zrušenia jazdy" name="reason" required maxLength={1000} /><Button danger type="submit" disabled={disabled}>Potvrdiť zrušenie</Button></form>}
      </>}
      {execution.cancelled && <div className={styles.actions}><Button disabled={disabled} onClick={() => onCommand("reopen", {}, "Požiadavka je opäť vo fronte pobočky.")}>Vrátiť požiadavku do frontu</Button></div>}
      {logistics && <p className={styles.muted}>Priebeh potvrdzuje vykonávateľ v časti Moje jazdy. Doklady a kontrolu vozidla vedie centrála vo Výjazdoch a odvozoch.</p>}
    </div>}
    {request.related.length > 0 && <div className={styles.panel}><h3>Súvisiaca práca v tom istom prípade</h3>{request.related.map(item => <p key={item.id} className={styles.muted}>{workKinds[item.kind]} · {item.groupName} · {item.executionStatus ? executionStatuses[item.executionStatus] ?? item.executionStatus : states[item.status === "assigned" ? "assigned" : item.status]}</p>)}<p className={styles.muted}>Vidíte iba druh, stav a zodpovednú pobočku; údaje inej pobočky zostávajú u nej.</p></div>}
  </aside>;
}

function Reports({ groupId }: { groupId: string }) {
  const [from, setFrom] = useState(day(-30));
  const [to, setTo] = useState(day(1));
  const [kind, setKind] = useState("");
  const [report, setReport] = useState<BranchReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T00:00:00`).toISOString(), ...(groupId ? { groupId } : {}), ...(kind ? { kind } : {}) });
    void fetch(`/api/pobocky/report?${query}`, { cache: "no-store", signal: controller.signal }).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Report sa nepodarilo načítať."); setReport(body); setError(""); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [from, to, kind, groupId]);
  return <div className={own.overview}>
    <div className={styles.toolbar}><Field label="Od" type="date" value={from} onChange={event => setFrom(event.target.value)} /><Field label="Do (bez tohto dňa)" type="date" value={to} onChange={event => setTo(event.target.value)} /><Select label="Druh práce" value={kind} onChange={event => setKind(event.target.value)}><option value="">Všetky</option>{(Object.keys(workKinds) as WorkRequestKind[]).map(item => <option key={item} value={item}>{workKinds[item]}</option>)}</Select></div>
    {error && <Notice kind="error">{error}</Notice>}
    {!report ? <p role="status">Načítavam report…</p> : <>
      <div className={own.tableWrap}><table className={own.table}><thead><tr><th>Pobočka</th><th>Prijaté</th><th>Jedinečné prípady</th><th>Čaká teraz</th><th>Na pridelenie</th><th>V realizácii</th><th>Vykonané</th><th>Reakcia (medián)</th><th>Do pridelenia (medián)</th></tr></thead>
        <tbody>{report.groups.map(row => <tr key={row.groupId}><td><strong>{row.groupName}</strong><br /><span className={styles.muted}>{row.branchName ?? "Fyzická pobočka neurčená"}</span></td>
          <td>{row.received}{row.received !== row.uniqueRequests && <span className={styles.muted}> ({row.uniqueRequests} požiadaviek)</span>}</td><td>{row.uniqueCases}{row.withoutCase > 0 && <span className={styles.muted}> + {row.withoutCase} bez prípadu</span>}</td>
          <td>{row.waitingNow}</td><td>{row.unassignedNow}</td><td>{row.inProgressNow}</td><td>{row.completed}{row.completedUnknownTime > 0 && <span className={styles.muted}> + {row.completedUnknownTime} bez času</span>}</td>
          <td>{formatDuration(row.reaction.medianSeconds)}<br /><span className={styles.muted}>{row.reaction.samples} meraní{row.reaction.unclaimed ? `, ${row.reaction.unclaimed} neprevzatých` : ""}</span></td>
          <td>{formatDuration(row.assignment.medianSeconds)}<br /><span className={styles.muted}>{row.assignment.samples} meraní</span></td></tr>)}</tbody></table></div>
      <p className={styles.muted}>Prijaté počítajú každé odovzdanie do pobočky; presunutá požiadavka sa započíta aj pôvodnej pobočke. Časy počítame iba zo zaznamenaných udalostí – chýbajúce ostávajú „neznáme“, nie nula.</p>
      <div className={styles.panel}><h3><Users size={16} /> Aktuálne zaťaženie vykonávateľov</h3>{report.workload.length === 0 ? <p className={styles.muted}>Nikto nemá otvorenú pridelenú prácu.</p> : report.workload.map(item => <p key={item.memberId}>{item.name}: {item.open} otvorených · {item.inProgress} prebieha</p>)}</div>
    </>}
  </div>;
}

function Team({ workspace, disabled, onCommand }: { workspace: Workspace; disabled: boolean; onCommand: (action: BranchCommand["action"], payload: Record<string, unknown>, success: string, revision?: number) => void }) {
  const kinds = Object.keys(workKinds) as WorkRequestKind[];
  const save = (event: FormEvent<HTMLFormElement>, group?: WorkGroup) => { event.preventDefault(); const form = new FormData(event.currentTarget);
    onCommand("group_save", { ...(group ? { groupId: group.id, active: form.get("active") === "on" } : {}), name: text(form, "name"), branchId: text(form, "branchId") || null, serviceKinds: kinds.filter(item => form.get(`kind-${item}`) === "on") }, group ? "Pobočka bola uložená." : "Pobočka bola vytvorená.", group?.revision); };
  const groupForm = (group?: WorkGroup) => <form className={styles.form} onSubmit={event => save(event, group)}>
    <div className={styles.fields}><Field label="Názov pobočky / prijímacej skupiny" name="name" defaultValue={group?.name} required maxLength={120} /><Select label="Fyzická pobočka pre reporty" name="branchId" defaultValue={group?.branchId ?? ""}><option value="">Neurčená</option>{workspace.branches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div>
    <fieldset className={own.checks}><legend>Prijíma</legend>{kinds.map(item => <label key={item}><input type="checkbox" name={`kind-${item}`} defaultChecked={group ? group.serviceKinds.includes(item) : item !== "tow"} /> {workKinds[item]}</label>)}{group && <label><input type="checkbox" name="active" defaultChecked={group.active} /> Aktívna</label>}</fieldset>
    <Button type="submit" disabled={disabled}>{group ? "Uložiť" : <><Plus size={16} /> Vytvoriť pobočku</>}</Button></form>;
  return <div className={own.overview}>
    <Notice>Pobočkový dispečer potrebuje účet s rolou „Pobočkový dispečer“ (správa účtov v odťahovej kancelárii). Vykonávatelia potrebujú rolu Pristavovač, pri odťahoch Vodič. Členstvo v pobočke tu iba určuje, kto prijíma a komu sa dá práca prideliť.</Notice>
    <div className={styles.panel}><h3><Plus size={16} /> Nová pobočka</h3>{groupForm()}</div>
    {workspace.groups.map(group => <div className={styles.panel} key={group.id}><h3><Building2 size={16} /> {group.name}{!group.active && " (neaktívna)"}</h3>{groupForm(group)}
      <form className={own.memberRow} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("group_settings", { groupId: group.id, escalateAfterMinutes: Number(form.get("minutes")), escalateToCentral: form.get("central") === "on" }, "Upozornenia pobočky boli uložené.", group.revision); }}>
        <Field label="Pripomenúť, ak práca čaká na prevzatie dlhšie ako (min)" name="minutes" type="number" min={5} max={1440} step={5} defaultValue={group.escalateAfterMinutes ?? 10} />
        <label><input type="checkbox" name="central" defaultChecked={group.escalateToCentral ?? false} /> Upozorniť aj vedúcich centrály</label><span /><Button type="submit" disabled={disabled}>Uložiť upozornenia</Button></form>
      <div className={styles.form}><strong>Ľudia v pobočke</strong>{group.members.length === 0 && <p className={styles.muted}>Zatiaľ nikto.</p>}
        {group.members.map(member => <form key={member.id} className={own.memberRow} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("group_member", { groupId: group.id, memberId: member.id, role: text(form, "role"), receivesNew: form.get("receivesNew") === "on" }, "Člen pobočky bol uložený."); }}>
          <span>{member.name}{!member.active && " (neaktívny účet)"}<br /><small className={styles.muted}>{[member.canDeliver && "pristavuje", member.canDrive && "odťahuje"].filter(Boolean).join(", ") || "bez výkonu"}</small></span>
          <Select label="Úloha" name="role" defaultValue={member.role}><option value="lead">Miestny dispečer</option><option value="member">Vykonávateľ</option><option value="none">Odobrať z pobočky</option></Select>
          <label><input type="checkbox" name="receivesNew" defaultChecked={member.receivesNew} /> Prijíma novú prácu</label><Button type="submit" disabled={disabled}>Uložiť</Button></form>)}
        <form className={own.memberRow} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); onCommand("group_member", { groupId: group.id, memberId: text(form, "memberId"), role: text(form, "role"), receivesNew: text(form, "role") === "lead" }, "Člen bol pridaný do pobočky."); }}>
          <Select label="Pridať účet" name="memberId" required><option value="">Vyberte účet</option>{workspace.people.filter(person => !group.members.some(member => member.id === person.id)).map(person => <option key={person.id} value={person.id}>{person.name}{person.email ? ` · ${person.email}` : ""}</option>)}</Select>
          <Select label="Úloha" name="role" defaultValue="member"><option value="lead">Miestny dispečer</option><option value="member">Vykonávateľ</option></Select><Button type="submit" disabled={disabled}><Plus size={16} /> Pridať</Button></form>
      </div></div>)}
  </div>;
}

export function CaseBranchPanel({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return <section className={styles.casePanel}><button type="button" className={styles.caseToggle} aria-expanded={open} onClick={() => { setOpen(!open); setVisited(true); }}><Building2 size={17} /> Pobočky – odovzdaná práca <span>{open ? "Zavrieť" : "Otvoriť"}</span></button>{visited && <div hidden={!open}><BranchWorkspace caseId={caseId} /></div>}</section>;
}
