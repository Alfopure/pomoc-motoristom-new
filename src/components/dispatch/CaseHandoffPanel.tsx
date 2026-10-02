"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, Link2, MessageSquareText, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { isHandoffReceipt, handoffDate, handoffEventLabels, handoffIsActive, handoffLabels, type CaseHandoff, type HandoffCommand, type HandoffContext, type HandoffReceipt } from "@/domain/case-handoff";
import { HandoffSummary } from "./HandoffSummary";
import { SmsComposerDialog } from "./SmsComposerDialog";
import { readHandoff, useHandoffRead } from "./use-handoff-read";
import { previewEditablePhone } from "@/lib/telephony/phone-entry";
import { PhoneNumberHint, PhoneNumberInput } from "./PhoneNumberInput";
import "./case-handoff.css";

export function CaseHandoffPanel(props: { caseId: string; caseNumber: string; active?: boolean }) {
  return <CaseHandoffSession key={props.caseId} {...props} />;
}
function CaseHandoffSession({ caseId, caseNumber, active = true }: { caseId: string; caseNumber: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false), [context, setContext] = useState<HandoffContext | null>(null);
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [instructions, setInstructions] = useState(""), [scheduled, setScheduled] = useState(""), [hours, setHours] = useState(24);
  const [comment, setComment] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [pending, setPending] = useState<HandoffCommand | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; phone: string; name: string; generation?: number } | null>(null), [smsOpen, setSmsOpen] = useState(false);
const [smsIntent, setSmsIntent] = useState<{ phone: string; message: string } | null>(null);
  const inFlight = useRef(false), detailsDirty = useRef(false), sectionRef = useRef<HTMLElement>(null);
  const reader = useHandoffRead({
    enabled: active && expanded,
    read: signal => readHandoff<HandoffContext>(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, signal),
    accept: data => {
      setContext(data);
      const activeGrant = data.handoffs.find(handoffIsActive);
      if (!detailsDirty.current) {
        setInstructions(activeGrant?.published?.instructions || "");
        const value = activeGrant?.published?.scheduledAt;
        if (value) { const date = new Date(value); setScheduled(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)); } else setScheduled("");
      }
      // An inactive grant must not keep offering a cached bearer link.
      setLink(current => current && data.handoffs.some(grant => grant.id === current.id && handoffIsActive(grant) && grant.tokenGeneration === current.generation) ? current : null);
    },
    onDenied: () => { setContext(null); setLink(null); setSmsOpen(false); setSmsIntent(null); },
  });
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
  async function command(action: string, grant?: CaseHandoff) {
    if (!context || inFlight.current || reader.halted) return;
    if (!pending && context.enhanced && action === "renew" && !window.confirm("Zneplatniť pôvodný odkaz a všetky jeho otvorené prístupy? Príjemcovi bude treba poslať nový odkaz.")) return;
    if (!pending && action === "extend" && grant && !handoffIsActive(grant) && !window.confirm("Predĺženie znovu sprístupní pôvodný odkaz jeho držiteľom. Pokračovať?")) return;
    const payload: HandoffCommand = pending ?? {
      action, commandId: crypto.randomUUID(), ...(grant ? { handoffId: grant.id, expectedRevision: grant.revision } : {}),
      ...(["issue", "publish"].includes(action) ? { previewVersion: context.previewVersion, instructions, scheduledAt: scheduled ? new Date(scheduled).toISOString() : null } : {}),
      ...(action === "issue" ? { recipientName: name, recipientPhone: phone } : {}), ...(["issue", "renew", "extend"].includes(action) ? { hours } : {}), ...(action === "revoke" ? { comment } : {}),
    };
    reader.pause();
    setPending(payload); inFlight.current = true; setBusy(true); setError(""); setNotice("");
    if (["issue", "renew", "revoke"].includes(payload.action)) setLink(null);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      const data = await response.json().catch(() => ({})) as HandoffReceipt & { error?: string };
      if (!response.ok) { if ([401, 403, 404, 410].includes(response.status)) reader.stop(); if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setPending(null); throw new Error(data.error || "Zmenu sa nepodarilo potvrdiť."); }
      if (reader.isHalted()) return;
      if (!isHandoffReceipt(data, payload)) throw new Error("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.");
      setPending(null); setContext(current => current ? { ...current, handoffs: [data.handoff, ...current.handoffs.filter(item => item.id !== data.handoff.id)] } : current);
      if (["issue", "publish"].includes(payload.action)) detailsDirty.current = false;
      setComment("");
      if (data.url) { setLink({ id: data.handoff.id, url: data.url, phone: data.handoff.recipientPhone || phone, name: data.handoff.recipientName, generation: data.handoff.tokenGeneration }); setNotice("Odkaz je pripravený. Môžete ho skopírovať alebo otvoriť SMS pre kolegu."); }
      else setNotice(["issue", "renew"].includes(payload.action) ? "Odovzdanie je uložené. Tajný odkaz sa z prvej odpovede nepodarilo obnoviť; použite Obnoviť odkaz." : "Zmena odovzdania je uložená.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Výsledok nie je overený. Zopakujte tú istú požiadavku."); }
    finally { inFlight.current = false; setBusy(false); reader.resume(); }
  }
  const current = context?.handoffs.find(handoffIsActive);
  const disabled = busy || !!pending;
  const validRecipientPhone = Boolean(previewEditablePhone(phone));
  return <section className="case-handoff-panel" ref={sectionRef} hidden={!active} aria-label="Externé odovzdanie prípadu">
    <button type="button" className="handoff-panel-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Link2 size={17} /><span><strong>Odovzdať prípad</strong><small>Odkaz pre stredisko alebo pristavovača bez plného účtu</small></span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    <div hidden={!expanded} className="handoff-panel-body">
      <p className="handoff-access-note"><ShieldCheck size={16} />Držiteľ odkazu uvidí iba potvrdené údaje nižšie. Prijatie ani dokončenie úkonu samo neuzavrie interný prípad.</p>
      {context && <>
        <div className="handoff-sender-grid"><div className="handoff-sender-form">
          {!current && <><label>Stredisko alebo kolega<input maxLength={160} value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder="Napr. Peter · Bratislava" /></label><label>Telefón príjemcu odkazu<PhoneNumberInput maxLength={30} value={phone} disabled={disabled} onChange={setPhone} /><PhoneNumberHint value={phone} className="text-xs font-normal text-slate-500" /></label></>}
          <label>Pokyny pre kolegu<textarea aria-label="Pokyny pre kolegu" maxLength={2000} rows={3} value={instructions} disabled={disabled} onChange={event => { detailsDirty.current = true; setInstructions(event.target.value); }} placeholder="Iba pokyny určené príjemcovi odkazu" /></label>
          <label>Dohodnutý čas<input type="datetime-local" value={scheduled} disabled={disabled} onChange={event => { detailsDirty.current = true; setScheduled(event.target.value); }} /></label>
          <label>Platnosť pri vytvorení alebo predĺžení<select value={hours} disabled={disabled} onChange={event => setHours(Number(event.target.value))}><option value={12}>12 hodín</option><option value={24}>24 hodín</option><option value={48}>48 hodín</option><option value={72}>72 hodín</option></select></label>
          {!current ? <button type="button" className="handoff-primary" disabled={disabled || !name.trim() || !validRecipientPhone} onClick={() => void command("issue")}><Send size={15} />Vytvoriť odkaz pre kolegu</button> : <button type="button" disabled={disabled} onClick={() => void command("publish", current)}>Zverejniť tento výber údajov</button>}
        </div><div className="handoff-share-preview"><h3>Príjemca uvidí</h3><strong>{context.preview.caseNumber} · {context.preview.action}</strong><HandoffSummary value={{ ...context.preview, instructions, scheduledAt: scheduled || null }} /></div></div>
        {context.handoffs.map(grant => <article key={grant.id} className="handoff-grant"><div className="handoff-grant-heading"><strong>{grant.recipientName}</strong><span className="handoff-status" data-status={grant.status}>{handoffLabels[grant.status]}</span></div><p>{grant.recipientPhone} · platnosť do {handoffDate(grant.expiresAt)}</p><p>{grant.openedAt ? `Karta otvorená ${handoffDate(grant.openedAt)}` : "Karta zatiaľ nebola otvorená"} · verzia údajov {grant.publishedVersion}</p>
          <p className="handoff-small">Vytvorené {handoffDate(grant.createdAt)}{grant.createdBy ? ` · ${grant.createdBy}` : ""}{grant.publishedAt ? ` · údaje zverejnené ${handoffDate(grant.publishedAt)}` : ""}</p>
          {grant.published && <details><summary>Zverejnené údaje tohto odovzdania</summary><HandoffSummary value={grant.published} /></details>}
          {context.enhanced && handoffIsActive(grant) && grant.recoverable && link?.id !== grant.id && <button type="button" disabled={disabled} onClick={() => void command("recover", grant)}><Link2 size={14} />Získať rovnaký odkaz</button>}
          {context.enhanced && grant.canRenew && !grant.recoverable && <p className="handoff-small">Tento starší odkaz sa nedá spätne získať. Pôvodný odkaz stále platí; nový vytvorte iba výslovnou rotáciou.</p>}
          {link?.id === grant.id && <div className="handoff-link"><label>Odkaz pre {link.name}<input readOnly value={link.url} onFocus={event => event.target.select()} /></label><div className="handoff-actions"><button type="button" onClick={() => { if (!navigator.clipboard) { setNotice("Označte a skopírujte zobrazený odkaz."); return; } void navigator.clipboard.writeText(link.url).then(() => setNotice("Odkaz je skopírovaný.")).catch(() => setNotice("Označte a skopírujte zobrazený odkaz.")); }}><Copy size={14} />Kopírovať</button><button type="button" onClick={() => { setSmsIntent({ phone: link.phone, message: `Prípad ${caseNumber} pre ${link.name}: ${link.url}` }); setSmsOpen(true); }}><MessageSquareText size={14} />Otvoriť SMS pre kolegu</button></div></div>}
          {(["offered", "accepted", "en_route", "arrived"].includes(grant.status) || (grant.canRenew && !current)) && <><div className="handoff-actions">{context.enhanced && <button type="button" disabled={disabled} onClick={() => void command("extend", grant)}>Predĺžiť platnosť bez zmeny odkazu</button>}<button type="button" disabled={disabled} onClick={() => void command("renew", grant)}><RefreshCw size={14} />{context.enhanced ? "Zneplatniť a vytvoriť nový odkaz" : "Obnoviť odkaz"}</button></div><p className="handoff-small">Nový odkaz zruší predchádzajúci odkaz aj jeho otvorené prístupy. Predĺženie platnosti odkaz nemení.</p><label>Dôvod zrušenia<textarea value={comment} rows={2} maxLength={1000} disabled={disabled} onChange={event => setComment(event.target.value)} /></label><button type="button" disabled={disabled || !comment.trim()} onClick={() => void command("revoke", grant)}>Zrušiť odovzdanie</button></>}
          {grant.events.length > 0 && <details className="handoff-history"><summary>Priebeh ({grant.events.length})</summary>{grant.events.map(event => <div key={event.id}><strong>{event.actor} · {handoffEventLabels[event.action] || "Zmena odovzdania"}</strong><span>{new Date(event.createdAt).toLocaleString("sk-SK")}</span>{event.comment && <p>{event.comment}</p>}</div>)}</details>}
        </article>)}
      </>}
      {notice && <p role="status" className="handoff-notice">{notice}</p>}{error && <p role="alert" className="handoff-error">{error}</p>}
      {reader.loading && !context && <p role="status">Načítavam odovzdania…</p>}
      {reader.error && <p role="alert" className="handoff-error">{reader.error}{!reader.halted && <button type="button" disabled={reader.loading || busy} onClick={reader.retry}>Skúsiť znova načítať</button>}</p>}
      {pending && !reader.halted && <button type="button" disabled={busy} onClick={() => void command(pending.action)}>{busy ? "Overujem výsledok…" : "Overiť výsledok tej istej požiadavky"}</button>}
    </div>
    {!reader.halted && <SmsComposerDialog externalRecipientLabel={`SMS pre kolegu · ${caseNumber}`} initialPhone={smsIntent?.phone ?? ""} initialMessage={smsIntent?.message ?? ""} initialTemplate="custom" open={smsOpen} onClose={() => setSmsOpen(false)} />}
  </section>;
}
