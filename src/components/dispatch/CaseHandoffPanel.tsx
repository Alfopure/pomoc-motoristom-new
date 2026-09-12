"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Link2, MessageSquareText, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { isHandoffReceipt, handoffEventLabels, handoffIsActive, handoffLabels, type CaseHandoff, type HandoffCommand, type HandoffContext, type HandoffReceipt } from "@/domain/case-handoff";
import { HandoffSummary } from "./HandoffSummary";
import { SmsComposerDialog } from "./SmsComposerDialog";
import "./case-handoff.css";

export function CaseHandoffPanel(props: { caseId: string; caseNumber: string; active?: boolean }) {
  return <CaseHandoffSession key={props.caseId} {...props} />;
}
function CaseHandoffSession({ caseId, caseNumber, active = true }: { caseId: string; caseNumber: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false), [context, setContext] = useState<HandoffContext | null>(null);
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [instructions, setInstructions] = useState(""), [scheduled, setScheduled] = useState(""), [hours, setHours] = useState(24);
  const [comment, setComment] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [pending, setPending] = useState<HandoffCommand | null>(null);
  const [link, setLink] = useState<{ id: string; url: string; phone: string; name: string } | null>(null), [smsOpen, setSmsOpen] = useState(false);
const [smsIntent, setSmsIntent] = useState<{ phone: string; message: string } | null>(null);
  const inFlight = useRef(false), detailsDirty = useRef(false), sectionRef = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const data = await response.json();
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) { setContext(null); setLink(null); } throw new Error(data.error || "Odovzdania sa nepodarilo načítať."); }
      setContext(data);
      const activeGrant = (data as HandoffContext).handoffs.find(handoffIsActive);
      if (!detailsDirty.current) {
        setInstructions(activeGrant?.published?.instructions || "");
        const value = activeGrant?.published?.scheduledAt;
        if (value) { const date = new Date(value); setScheduled(new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)); } else setScheduled("");
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Odovzdania sa nepodarilo načítať."); }
    finally { inFlight.current = false; setBusy(false); }
  }, [caseId]);
  useEffect(() => { if (!active || !expanded) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [active, expanded, load]);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);
  async function command(action: string, grant?: CaseHandoff) {
    if (!context || inFlight.current) return;
    const payload: HandoffCommand = pending ?? {
      action, commandId: crypto.randomUUID(), ...(grant ? { handoffId: grant.id, expectedRevision: grant.revision } : {}),
      ...(["issue", "publish"].includes(action) ? { previewVersion: context.previewVersion, instructions, scheduledAt: scheduled ? new Date(scheduled).toISOString() : null } : {}),
      ...(action === "issue" ? { recipientName: name, recipientPhone: phone } : {}), ...(["issue", "renew"].includes(action) ? { hours } : {}), ...(action === "revoke" ? { comment } : {}),
    };
    setPending(payload); inFlight.current = true; setBusy(true); setError(""); setNotice("");
    if (["issue", "renew", "revoke"].includes(payload.action)) setLink(null);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/handoffs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
      const data = await response.json() as HandoffReceipt & { error?: string };
      if (!response.ok) { if ([401, 403, 404].includes(response.status)) { setContext(null); setLink(null); setSmsOpen(false); } if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setPending(null); throw new Error(data.error || "Zmenu sa nepodarilo potvrdiť."); }
      if (!isHandoffReceipt(data, payload)) throw new Error("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.");
      setPending(null); setContext(current => current ? { ...current, handoffs: [data.handoff, ...current.handoffs.filter(item => item.id !== data.handoff.id)] } : current);
      if (["issue", "publish"].includes(payload.action)) detailsDirty.current = false;
      setComment("");
      if (data.url) { setLink({ id: data.handoff.id, url: data.url, phone: data.handoff.recipientPhone || phone, name: data.handoff.recipientName }); setNotice("Odkaz je pripravený. Môžete ho skopírovať alebo otvoriť SMS pre kolegu."); }
      else setNotice(["issue", "renew"].includes(payload.action) ? "Odovzdanie je uložené. Tajný odkaz sa z prvej odpovede nepodarilo obnoviť; použite Obnoviť odkaz." : "Zmena odovzdania je uložená.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Výsledok nie je overený. Zopakujte tú istú požiadavku."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const current = context?.handoffs.find(handoffIsActive);
  const disabled = busy || !!pending;
  return <section className="case-handoff-panel" ref={sectionRef} hidden={!active} aria-label="Externé odovzdanie prípadu">
    <button type="button" className="handoff-panel-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Link2 size={17} /><span><strong>Odovzdať prípad</strong><small>Odkaz pre stredisko alebo pristavovača bez plného účtu</small></span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    <div hidden={!expanded} className="handoff-panel-body">
      <p className="handoff-access-note"><ShieldCheck size={16} />Držiteľ odkazu uvidí iba potvrdené údaje nižšie. Prijatie ani dokončenie úkonu samo neuzavrie interný prípad.</p>
      {context && <>
        <div className="handoff-sender-grid"><div className="handoff-sender-form">
          {!current && <><label>Stredisko alebo kolega<input maxLength={160} value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder="Napr. Peter · Bratislava" /></label><label>Telefón príjemcu odkazu<input type="tel" maxLength={30} value={phone} disabled={disabled} onChange={event => setPhone(event.target.value)} placeholder="+421…" /></label></>}
          <label>Pokyny pre kolegu<textarea aria-label="Pokyny pre kolegu" maxLength={2000} rows={3} value={instructions} disabled={disabled} onChange={event => { detailsDirty.current = true; setInstructions(event.target.value); }} placeholder="Iba pokyny určené príjemcovi odkazu" /></label>
          <label>Dohodnutý čas<input type="datetime-local" value={scheduled} disabled={disabled} onChange={event => { detailsDirty.current = true; setScheduled(event.target.value); }} /></label>
          <label>Platnosť nového alebo obnoveného odkazu<select value={hours} disabled={disabled} onChange={event => setHours(Number(event.target.value))}><option value={12}>12 hodín</option><option value={24}>24 hodín</option><option value={48}>48 hodín</option><option value={72}>72 hodín</option></select></label>
          {!current ? <button type="button" className="handoff-primary" disabled={disabled || !name.trim() || !phone.trim()} onClick={() => void command("issue")}><Send size={15} />Vytvoriť odkaz pre kolegu</button> : <button type="button" disabled={disabled} onClick={() => void command("publish", current)}>Zverejniť tento výber údajov</button>}
        </div><div className="handoff-share-preview"><h3>Príjemca uvidí</h3><strong>{context.preview.caseNumber} · {context.preview.action}</strong><HandoffSummary value={{ ...context.preview, instructions, scheduledAt: scheduled || null }} /></div></div>
        {context.handoffs.map(grant => <article key={grant.id} className="handoff-grant"><div className="handoff-grant-heading"><strong>{grant.recipientName}</strong><span className="handoff-status" data-status={grant.status}>{handoffLabels[grant.status]}</span></div><p>{grant.recipientPhone} · platnosť do {new Date(grant.expiresAt).toLocaleString("sk-SK")}</p><p>{grant.openedAt ? `Karta otvorená ${new Date(grant.openedAt).toLocaleString("sk-SK")}` : "Karta zatiaľ nebola otvorená"} · verzia údajov {grant.publishedVersion}</p>
          {grant.published && <details><summary>Zverejnené údaje tohto odovzdania</summary><HandoffSummary value={grant.published} /></details>}
          {link?.id === grant.id && <div className="handoff-link"><label>Odkaz pre {link.name}<input readOnly value={link.url} onFocus={event => event.target.select()} /></label><div className="handoff-actions"><button type="button" onClick={() => { if (!navigator.clipboard) { setNotice("Označte a skopírujte zobrazený odkaz."); return; } void navigator.clipboard.writeText(link.url).then(() => setNotice("Odkaz je skopírovaný.")).catch(() => setNotice("Označte a skopírujte zobrazený odkaz.")); }}><Copy size={14} />Kopírovať</button><button type="button" onClick={() => { setSmsIntent({ phone: link.phone, message: `Prípad ${caseNumber} pre ${link.name}: ${link.url}` }); setSmsOpen(true); }}><MessageSquareText size={14} />Otvoriť SMS pre kolegu</button></div></div>}
          {(["offered", "accepted", "en_route", "arrived"].includes(grant.status) || (grant.canRenew && !current)) && <><div className="handoff-actions"><button type="button" disabled={disabled} onClick={() => void command("renew", grant)}><RefreshCw size={14} />Obnoviť odkaz</button></div><p className="handoff-small">Obnovenie zruší predchádzajúci odkaz aj jeho otvorené prístupy.</p><label>Dôvod zrušenia<textarea value={comment} rows={2} maxLength={1000} disabled={disabled} onChange={event => setComment(event.target.value)} /></label><button type="button" disabled={disabled || !comment.trim()} onClick={() => void command("revoke", grant)}>Zrušiť odovzdanie</button></>}
          {grant.events.length > 0 && <details className="handoff-history"><summary>Priebeh ({grant.events.length})</summary>{grant.events.map(event => <div key={event.id}><strong>{event.actor} · {handoffEventLabels[event.action] || "Zmena odovzdania"}</strong><span>{new Date(event.createdAt).toLocaleString("sk-SK")}</span>{event.comment && <p>{event.comment}</p>}</div>)}</details>}
        </article>)}
      </>}
      {notice && <p role="status" className="handoff-notice">{notice}</p>}{error && <p role="alert" className="handoff-error">{error}</p>}
      {pending ? <button type="button" disabled={busy} onClick={() => void command(pending.action)}>{busy ? "Overujem výsledok…" : "Overiť výsledok tej istej požiadavky"}</button> : <button type="button" className="handoff-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />{busy ? "Načítavam…" : "Obnoviť odovzdania"}</button>}
    </div>
    <SmsComposerDialog externalRecipientLabel={`SMS pre kolegu · ${caseNumber}`} initialPhone={smsIntent?.phone ?? ""} initialMessage={smsIntent?.message ?? ""} initialTemplate="custom" open={smsOpen} onClose={() => setSmsOpen(false)} />
  </section>;
}
