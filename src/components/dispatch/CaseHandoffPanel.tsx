"use client";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCaseCollaboration } from "./CaseCollaborationProvider";
import { useLayoutPreview } from "./LayoutPreview";
import { Copy, Link2, MapPin, MessageSquareText, RefreshCw, Send, ShieldCheck, Smartphone, X } from "lucide-react";
import { isHandoffDeliveryReceipt, isHandoffReceipt, handoffDate, handoffEventLabels, handoffIsActive, handoffLabels, type CaseHandoff, type HandoffCommand, type HandoffContext } from "@/domain/case-handoff";
import type { WorkRequestKind } from "@/domain/work-groups";
import { CaseWorkPanel } from "./CaseWorkPanel";
import { BranchWorkspace } from "@/components/branches/BranchWorkspace";
import { HandoffSummary } from "./HandoffSummary";
import { SmsComposerDialog } from "./SmsComposerDialog";
import { readHandoff, useHandoffRead } from "./use-handoff-read";
import { previewEditablePhone } from "@/lib/telephony/phone-entry";
import { PhoneNumberHint, PhoneNumberInput } from "./PhoneNumberInput";
import "./case-handoff.css";

type CaseHandoffPanelProps = { caseId: string; caseNumber: string; active?: boolean; initiallyExpanded?: boolean; presentation?: "accordion" | "drawer"; onWorkCommitted?: () => void; initialWorkKinds?: WorkRequestKind[] };

export function CaseHandoffPanel(props: CaseHandoffPanelProps) {
  return <CaseHandoffSession key={props.caseId} {...props} />;
}
function CaseHandoffSession({ caseId, caseNumber, active = true, initiallyExpanded = false, presentation = "accordion", onWorkCommitted, initialWorkKinds }: CaseHandoffPanelProps) {
  const drawer = presentation === "drawer";
  const titleId = useId();
  const [drawerStarted, setDrawerStarted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null), drawerRef = useRef<HTMLDivElement>(null);
  const { state: caseAccess } = useCaseCollaboration();
  const { mode: layoutMode } = useLayoutPreview();
  const [expanded, setExpanded] = useState(initiallyExpanded), [context, setContext] = useState<HandoffContext | null>(null);
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [instructions, setInstructions] = useState(""), [scheduled, setScheduled] = useState(""), [hours, setHours] = useState(24);
  const [recipientMemberId, setRecipientMemberId] = useState(""), [deliveryMemberId, setDeliveryMemberId] = useState("");
  const [channel, setChannel] = useState<"app" | "branch" | "link">("app");
  const [branchGroupId, setBranchGroupId] = useState(""), [branchPending, setBranchPending] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [comment, setComment] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [pending, setPending] = useState<HandoffCommand | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; phone: string; name: string; generation?: number } | null>(null), [smsOpen, setSmsOpen] = useState(false);
  const [smsIntent, setSmsIntent] = useState<{ phone: string; message: string } | null>(null);
  const inFlight = useRef(false), detailsDirty = useRef(false), sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (drawer || !active || !initiallyExpanded) return;
    const frame = requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [active, initiallyExpanded, drawer]);
  const reader = useHandoffRead({
    enabled: active && expanded,
    read: signal => readHandoff<HandoffContext>(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, signal),
    accept: data => {
      setContext(data);
      if (!context && !data.delivery) setChannel(current => current === "app" ? "link" : current);
      const activeGrant = data.handoffs.find(handoffIsActive);
      if (!detailsDirty.current) {
        setInstructions(activeGrant?.published?.instructions || "");
        const value = activeGrant?.published?.scheduledAt;
        if (value) { const date = new Date(value); setScheduled(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)); } else setScheduled("");
      }
      // An inactive grant must not keep offering a cached bearer link.
      setLink(current => current && data.handoffs.some(grant => grant.id === current.id && handoffIsActive(grant) && grant.tokenGeneration === current.generation) ? current : null);
    },
    onDenied: () => { setContext(null); setLink(null); setSmsOpen(false); setSmsIntent(null); setRecipientMemberId(""); setDeliveryMemberId(""); },
  });
  useEffect(() => {
    if (!active || !expanded) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active, expanded]);
  useEffect(() => {
    if (!active || !expanded || !context) return;
    const time = Date.now();
    const expiry = Math.min(...context.handoffs.map(grant => Date.parse(grant.expiresAt)).filter(value => value > time));
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expiry - time + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [active, expanded, context, now]);
  useEffect(() => {
    if (!link || !context) return;
    const grant = context.handoffs.find(item => item.id === link.id);
    if (!grant) return;
    const timer = setTimeout(() => setLink(null), Math.max(0, new Date(grant.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [link, context]);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);
  function closeDrawer() {
    // A submitted request stays mounted, including its command ID and retry state.
    if (!busy && !smsOpen) setExpanded(false);
  }
  const handleDrawerKeys = useEffectEvent((event: KeyboardEvent) => {
    if (smsOpen) return; // The nested SMS composer owns focus while open.
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary') ?? []).filter(element => element.getClientRects().length > 0);
    const first = elements[0], last = elements.at(-1);
    if (!drawerRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  const keepDrawerFocus = useEffectEvent((event: FocusEvent) => {
    if (!smsOpen && event.target instanceof Node && !drawerRef.current?.contains(event.target)) drawerRef.current?.focus();
  });
  useEffect(() => {
    // An initially open case also renders on the server; mount its portal only
    // after hydration, while user-triggered opening can mount it immediately.
    if (!drawer || !expanded || drawerStarted) return;
    const frame = requestAnimationFrame(() => setDrawerStarted(true));
    return () => cancelAnimationFrame(frame);
  }, [drawer, expanded, drawerStarted]);
  useEffect(() => {
    if (!drawer || !drawerStarted || !expanded || !active || caseAccess.hidden) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    const trigger = triggerRef.current;
    document.body.style.overflow = "hidden";
    drawerRef.current?.focus();
    document.addEventListener("keydown", handleDrawerKeys, true);
    document.addEventListener("focusin", keepDrawerFocus);
    return () => {
      document.removeEventListener("keydown", handleDrawerKeys, true);
      document.removeEventListener("focusin", keepDrawerFocus);
      document.body.style.overflow = previousOverflow;
      const restore = previousFocus instanceof HTMLElement && previousFocus.isConnected ? previousFocus : trigger;
      restore?.focus();
    };
  }, [drawer, drawerStarted, expanded, active, caseAccess.hidden]);
  async function command(action: string, grant?: CaseHandoff, memberId?: string) {
    if (!context || inFlight.current || reader.halted) return;
    if (!pending && context.enhanced && action === "renew" && !window.confirm("Zneplatniť pôvodný odkaz a všetky jeho otvorené prístupy? Príjemcovi bude treba poslať nový odkaz.")) return;
    if (!pending && action === "extend" && grant && !handoffIsActive(grant) && !window.confirm("Predĺženie znovu sprístupní pôvodný odkaz jeho držiteľom. Pokračovať?")) return;
    const payload: HandoffCommand = pending ?? {
      action, commandId: crypto.randomUUID(), ...(grant ? { handoffId: grant.id, expectedRevision: grant.revision } : {}),
      ...(["issue", "publish"].includes(action) ? { previewVersion: context.previewVersion, instructions, scheduledAt: scheduled ? new Date(scheduled).toISOString() : null } : {}),
      ...(action === "issue" ? { recipientName: name, recipientPhone: phone, ...(recipientMemberId ? { recipientMemberId } : {}) } : {}),
      ...(action === "deliver" ? { recipientMemberId: memberId } : {}),
      ...(["issue", "renew", "extend"].includes(action) ? { hours } : {}), ...(action === "revoke" ? { comment } : {}),
    };
    reader.pause();
    setPending(payload); inFlight.current = true; setBusy(true); setError(""); setNotice("");
    if (["issue", "renew", "revoke"].includes(payload.action)) setLink(null);
    let refreshAfterWrite = false;
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) { if ([401, 403, 404, 410].includes(response.status)) reader.stop(); if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setPending(null); throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Zmenu sa nepodarilo potvrdiť."); }
      if (reader.isHalted()) return;
      if (payload.action === "deliver") {
        if (!isHandoffDeliveryReceipt(data, payload)) throw new Error("Odoslanie do aplikácie sa nepodarilo potvrdiť. Overte tú istú požiadavku.");
        setPending(null);
        setContext(current => current ? { ...current, handoffs: current.handoffs.map(item => item.id === data.handoffId ? { ...item, revision: Math.max(item.revision, data.currentRevision), app: item.app?.memberId === data.memberId ? item.app : { memberId: data.memberId, lastPosition: null } } : item) } : current);
        setNotice("Odovzdanie je pridelené v aplikácii pristavovača. Prevzatie uvidíte v priebehu.");
        refreshAfterWrite = true;
        return;
      }
      if (!isHandoffReceipt(data, payload)) throw new Error("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.");
      setPending(null); setContext(current => current ? { ...current, handoffs: [{ ...data.handoff, app: data.delivery?.status === "sent" ? { memberId: data.delivery.memberId, lastPosition: null } : current.handoffs.find(item => item.id === data.handoff.id)?.app }, ...current.handoffs.filter(item => item.id !== data.handoff.id)] } : current);
      if (["issue", "publish"].includes(payload.action)) detailsDirty.current = false;
      setComment("");
      if (data.url) { setLink({ id: data.handoff.id, url: data.url, phone: data.handoff.recipientPhone || phone, name: data.handoff.recipientName, generation: data.handoff.tokenGeneration }); setNotice("Odkaz je pripravený. Môžete ho skopírovať alebo otvoriť SMS pre kolegu."); }
      else setNotice(["issue", "renew"].includes(payload.action) ? "Odovzdanie je uložené. Tajný odkaz sa z prvej odpovede nepodarilo obnoviť; použite Obnoviť odkaz." : "Zmena odovzdania je uložená.");
      if (data.delivery?.status === "sent") setNotice("Odovzdanie je pridelené v aplikácii pristavovača. Prevzatie uvidíte v priebehu. " + (data.url ? "Odkaz môžete zdieľať aj samostatne." : "Odkaz sa nepodarilo načítať; skúste ho získať znova."));
      if (data.delivery?.status === "failed") {
        setNotice("Odovzdanie je uložené. Jeho pridelenie do aplikácie zatiaľ nie je potvrdené.");
        setError("Overte odoslanie tej istej požiadavky. Nové odovzdanie nevytvárajte.");
        setPending({ action: "deliver", commandId: payload.commandId, handoffId: data.handoff.id, expectedRevision: Number(data.committedRevision), recipientMemberId: data.delivery.memberId });
      }
      if (data.linkWarning) setError(current => current ? `${current} Odkaz sa nepodarilo načítať.` : "Odkaz sa nepodarilo načítať. Odovzdanie zostáva uložené; skúste získať rovnaký odkaz znova.");
      refreshAfterWrite = true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Výsledok nie je overený. Zopakujte tú istú požiadavku."); }
    finally { inFlight.current = false; setBusy(false); reader.resume(); if (refreshAfterWrite) reader.retry(); }
  }
  const current = context?.handoffs.find(handoffIsActive);
  const members = context?.delivery?.members ?? [];
  const selectedMember = members.find(member => member.id === recipientMemberId);
  const disabled = busy || !!pending;
  const validRecipientPhone = !phone.trim() || Boolean(previewEditablePhone(phone));
  const appChannel = channel === "app";
  const body = <div hidden={!expanded} className="handoff-panel-body">
      <CaseWorkPanel caseId={caseId} active={active && expanded} onCommitted={onWorkCommitted} initialKinds={initialWorkKinds} />
      <details className="case-work-legacy"><summary>Externý odkaz a pôvodné odovzdania</summary>
      {context && <label>Príjemca odovzdania<select value={channel === "branch" ? `branch:${branchGroupId}` : current ? "existing" : channel === "app" ? recipientMemberId : "link"} disabled={disabled || branchPending} onChange={event => {
        const value = event.target.value;
        if (value.startsWith("branch:")) { setBranchGroupId(value.slice(7)); setChannel("branch"); setRecipientMemberId(""); }
        else if (value === "existing") { setChannel("app"); }
        else if (value === "link") { setChannel("link"); setRecipientMemberId(""); setName(""); setPhone(""); }
        else { const member = members.find(item => item.id === value); setChannel("app"); setRecipientMemberId(value); setName(member?.displayName ?? ""); setPhone(member?.lastPhone ?? ""); }
      }}>
        <option value="">Vyberte pobočku alebo človeka</option>
        {current && <option value="existing">Aktuálne odovzdanie · {current.recipientName}</option>}
        <optgroup label="Pobočky">{context.branches?.map(branch => <option key={branch.id} value={`branch:${branch.id}`}>{branch.name}</option>)}</optgroup>
        <optgroup label="Ľudia" disabled={Boolean(current)}>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</optgroup>
        {!current && <option value="link">Iný príjemca · odkaz / SMS</option>}
      </select></label>}
      {context?.branchesError && <p role="alert" className="handoff-error">{context.branchesError} <button type="button" disabled={busy || branchPending} onClick={reader.retry}>Obnoviť príjemcov</button></p>}
      <div hidden={channel !== "branch"}>
        {branchGroupId && <><p className="handoff-small">Vyberte pobočku. Požiadavku uvidia jej miestni dispečeri, ktorí ju prevezmú a pridelia konkrétnemu pracovníkovi. Telefón sa nevyžaduje.</p><BranchWorkspace key={branchGroupId} targetGroupId={branchGroupId} caseId={caseId} initiallyCreating onPendingChange={setBranchPending} initialRequest={{ pickup: context?.preview.pickup?.address, destination: context?.preview.destination?.address, dueAt: scheduled || null, note: instructions }} /></>}
      </div>
      <div hidden={channel === "branch"}>
      <p className="handoff-access-note"><ShieldCheck size={16} />Držiteľ odkazu uvidí iba potvrdené údaje nižšie. Prijatie ani dokončenie úkonu samo neuzavrie interný prípad.</p>
      {context && <>
        <div className="handoff-sender-grid"><div className="handoff-sender-form">
          {!current && <>
            {recipientMemberId && !selectedMember && <p role="alert" className="handoff-error">Vybraný pristavovač už nie je dostupný. Vyberte príjemcu znova.</p>}
            <label>{appChannel ? "Pristavovač" : "Stredisko alebo kolega"}<input maxLength={160} value={name} disabled={disabled} readOnly={!!recipientMemberId} onChange={event => setName(event.target.value)} placeholder="Napr. Peter · Bratislava" /></label>
            <label>{appChannel ? "Telefón pristavovača (nepovinné, pre SMS)" : "Telefón príjemcu odkazu (nepovinné, pre SMS)"}<PhoneNumberInput maxLength={30} value={phone} disabled={disabled} onChange={setPhone} /><PhoneNumberHint value={phone} className="text-xs font-normal text-slate-500" /></label>
            {recipientMemberId && <p className="handoff-small">Pristavovač ho uvidí vo svojej aplikácii. Ak má povolené upozornenia, odošle sa aj notifikácia.</p>}
          </>}
          <label>Pokyny pre kolegu<textarea aria-label="Pokyny pre kolegu" maxLength={2000} rows={3} value={instructions} disabled={disabled} onChange={event => { detailsDirty.current = true; setInstructions(event.target.value); }} placeholder="Iba pokyny určené príjemcovi odkazu" /></label>
          <label>Dohodnutý čas<input type="datetime-local" value={scheduled} disabled={disabled} onChange={event => { detailsDirty.current = true; setScheduled(event.target.value); }} /></label>
          <label>Platnosť pri vytvorení alebo predĺžení<select value={hours} disabled={disabled} onChange={event => setHours(Number(event.target.value))}><option value={12}>12 hodín</option><option value={24}>24 hodín</option><option value={48}>48 hodín</option><option value={72}>72 hodín</option></select></label>
          {!current ? <button type="button" className="handoff-primary" disabled={disabled || !name.trim() || !validRecipientPhone || appChannel && !selectedMember || !!recipientMemberId && !selectedMember} onClick={() => void command("issue")}><Send size={15} />{appChannel ? "Odovzdať do aplikácie" : "Vytvoriť odkaz pre kolegu"}</button> : <button type="button" disabled={disabled} onClick={() => void command("publish", current)}>Zverejniť tento výber údajov</button>}
        </div><div className="handoff-share-preview"><h3>Príjemca uvidí</h3><strong>{context.preview.caseNumber} · {context.preview.action}</strong><HandoffSummary value={{ ...context.preview, instructions, scheduledAt: scheduled || null }} /></div></div>
        {context.handoffs.map(grant => <article key={grant.id} className="handoff-grant"><div className="handoff-grant-heading"><strong>{grant.recipientName}</strong><span className="handoff-status" data-status={grant.status}>{handoffLabels[grant.status]}</span></div><p>{grant.recipientPhone || "Telefón nezadaný"} · platnosť do {handoffDate(grant.expiresAt)}</p><p>{grant.openedAt ? `Karta otvorená ${handoffDate(grant.openedAt)}` : "Karta zatiaľ nebola otvorená"} · verzia údajov {grant.publishedVersion}</p>
          {grant.app && <p className="handoff-app-status"><Smartphone size={14} />V aplikácii</p>}
          {grant.app && grant.status !== "offered" && handoffIsActive(grant) && Date.parse(grant.expiresAt) > now && <div className="handoff-position">
            <p>{grant.app.lastPosition ? `Posledná poloha · pred ${Math.max(0, Math.floor((now - Date.parse(grant.app.lastPosition.recordedAt)) / 60_000))} min · ${handoffDate(grant.app.lastPosition.recordedAt)}` : "Poloha pristavovača zatiaľ neprišla."}</p>
            {grant.app.lastPosition && <><p>{grant.app.lastPosition.accuracy !== null ? `Presnosť ±${Math.round(grant.app.lastPosition.accuracy)} m` : "Presnosť polohy nie je známa."}</p><a href={`https://www.google.com/maps/search/?api=1&query=${grant.app.lastPosition.lat},${grant.app.lastPosition.lng}`} target="_blank" rel="noopener noreferrer"><MapPin size={14} />Ukázať pristavovača na mape</a></>}
          </div>}
          {!grant.app && grant.status === "offered" && handoffIsActive(grant) && Date.parse(grant.expiresAt) > now && members.length > 0 && <div className="handoff-delivery-choice">
            <label>Pristavovač pre {grant.recipientName}<select value={deliveryMemberId} disabled={disabled} onChange={event => setDeliveryMemberId(event.target.value)}><option value="">Vyberte pristavovača</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>
            <button type="button" disabled={disabled || !members.some(member => member.id === deliveryMemberId)} onClick={() => void command("deliver", grant, deliveryMemberId)}><Smartphone size={14} />Poslať do aplikácie pristavovača</button>
          </div>}
          <p className="handoff-small">Vytvorené {handoffDate(grant.createdAt)}{grant.createdBy ? ` · ${grant.createdBy}` : ""}{grant.publishedAt ? ` · údaje zverejnené ${handoffDate(grant.publishedAt)}` : ""}</p>
          {grant.published && <details><summary>Zverejnené údaje tohto odovzdania</summary><HandoffSummary value={grant.published} /></details>}
          {context.enhanced && handoffIsActive(grant) && grant.recoverable && link?.id !== grant.id && <button type="button" disabled={disabled} onClick={() => void command("recover", grant)}><Link2 size={14} />Získať rovnaký odkaz</button>}
          {context.enhanced && grant.canRenew && !grant.recoverable && <p className="handoff-small">Tento starší odkaz sa nedá spätne získať. Pôvodný odkaz stále platí; nový vytvorte iba výslovnou rotáciou.</p>}
          {link?.id === grant.id && <div className="handoff-link"><label>Odkaz pre {link.name}<input readOnly value={link.url} onFocus={event => event.target.select()} /></label><div className="handoff-actions"><button type="button" onClick={() => { if (!navigator.clipboard) { setNotice("Označte a skopírujte zobrazený odkaz."); return; } void navigator.clipboard.writeText(link.url).then(() => setNotice("Odkaz je skopírovaný.")).catch(() => setNotice("Označte a skopírujte zobrazený odkaz.")); }}><Copy size={14} />Kopírovať</button><button type="button" onClick={() => { setSmsIntent({ phone: link.phone, message: `Prípad ${caseNumber} pre ${link.name}: ${link.url}` }); setSmsOpen(true); }}><MessageSquareText size={14} />Otvoriť SMS pre kolegu</button></div></div>}
          {(["offered", "accepted", "en_route", "arrived"].includes(grant.status) || (grant.canRenew && !current)) && <><div className="handoff-actions">{context.enhanced && <button type="button" disabled={disabled} onClick={() => void command("extend", grant)}>Predĺžiť platnosť bez zmeny odkazu</button>}<button type="button" disabled={disabled} onClick={() => void command("renew", grant)}><RefreshCw size={14} />{context.enhanced ? "Zneplatniť a vytvoriť nový odkaz" : "Obnoviť odkaz"}</button></div><p className="handoff-small">Nový odkaz zruší predchádzajúci odkaz aj jeho otvorené prístupy. Predĺženie platnosti odkaz nemení.</p><label>Dôvod zrušenia<textarea value={comment} rows={2} maxLength={1000} disabled={disabled} onChange={event => setComment(event.target.value)} /></label><button type="button" disabled={disabled || !comment.trim()} onClick={() => void command("revoke", grant)}>Zrušiť odovzdanie</button></>}
          {grant.events.length > 0 && <details className="handoff-history"><summary>Priebeh ({grant.events.length})</summary>{grant.events.map(event => <div key={event.id}><strong>{event.actor} · {handoffEventLabels[event.action] || "Zmena odovzdania"}</strong><span>{new Date(event.createdAt).toLocaleString("sk-SK")}</span>{event.comment && <p>{event.comment}</p>}</div>)}</details>}
        </article>)}
      </>}
      </div>
      {notice && <p role="status" className="handoff-notice">{notice}</p>}{error && <p role="alert" className="handoff-error">{error}</p>}
      {reader.loading && !context && <p role="status">Načítavam odovzdania…</p>}
      {reader.error && <p role="alert" className="handoff-error">{reader.error}{!reader.halted && <button type="button" disabled={reader.loading || busy} onClick={reader.retry}>Skúsiť znova načítať</button>}</p>}
      {pending && !reader.halted && <button type="button" disabled={busy} onClick={() => void command(pending.action)}>{busy ? "Overujem výsledok…" : "Overiť výsledok tej istej požiadavky"}</button>}
    </details></div>;
  const smsComposer = !reader.halted && <SmsComposerDialog externalRecipientLabel={`SMS pre kolegu · ${caseNumber}`} initialPhone={smsIntent?.phone ?? ""} initialMessage={smsIntent?.message ?? ""} initialTemplate="custom" open={smsOpen && (!drawer || active)} onClose={() => setSmsOpen(false)} />;
  if (!drawer) return <section className="case-handoff-panel" ref={sectionRef} hidden={!active} aria-label="Externé odovzdanie prípadu">
    <button type="button" className="handoff-panel-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Link2 size={17} /><span><strong>Odovzdať prípad</strong><small>Pobočke alebo človeku do aplikácie; odkaz a SMS podľa potreby</small></span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    {body}{smsComposer}
  </section>;
  return <>
    <button ref={triggerRef} type="button" hidden={!active} className="handoff-drawer-trigger" aria-haspopup="dialog" aria-expanded={expanded} onClick={() => { setDrawerStarted(true); setExpanded(true); }}><Send size={16} aria-hidden="true" />Odovzdať prípad</button>
    {drawerStarted && typeof document !== "undefined" && createPortal(<div data-layout-preview={layoutMode} inert={caseAccess.hidden || !active || !expanded} style={caseAccess.hidden || !active || !expanded ? { display: "none" } : undefined} className="handoff-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeDrawer(); }}>
      <div ref={drawerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} inert={smsOpen} className="case-handoff-panel handoff-drawer">
        <header className="handoff-drawer-header"><div><h2 id={titleId}>Odovzdať prípad</h2><p>{caseNumber} · pobočke alebo človeku do aplikácie</p></div><button type="button" disabled={busy} aria-label="Zavrieť odovzdanie" onClick={() => closeDrawer()}><X size={18} aria-hidden="true" /></button></header>
        {body}
      </div>
    </div>, document.body)}
    {smsComposer}
  </>;
}
