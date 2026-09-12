"use client";

import { useLayoutPreview } from "./LayoutPreview";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Loader2, MessageSquareText, Send, X } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import type { SmsCaseOption, SmsTaskOption, SmsInboxMessage, SmsPrepareInput, SmsPreview } from "@/lib/sms/contracts";
import { MAX_CUSTOM_SMS_LENGTH, validateCustomSmsDraft } from "@/lib/sms/custom-message";
import { smsSegments, stripSmsDiacritics } from "@/lib/sms/segments";
import { SMS_TEMPLATES, validateTemplateMessage } from "@/lib/sms/templates";
import { smsStatusLabel } from "@/lib/sms/status";
import { SmsHistory } from "./SmsHistory";
import { SmsInbox } from "./SmsInbox";

export type SmsComposerResult = {
  dispatchData?: DispatchData;
  sms?: { smsMessageId?: string; status?: string; statusDetail?: string | null; reused?: boolean };
};
type Props = {
  caseId?: string;
  caseNumber?: string;
  initialPhone?: string;
  initialMessage?: string;
  /** Standalone custom SMS for a colleague; attaching a case would select its client phone. */
  externalRecipientLabel?: string;
  locationPhone?: string;
  initialTemplate?: SmsPrepareInput["template"];
  initialTab?: "editor" | "inbox";
  onCreateCase?: () => void;
  onClose: () => void;
  onSent?: (result: SmsComposerResult) => void;
  open: boolean;
};

export function SmsComposerDialog(props: Props) {
  const [started, setStarted] = useState(props.open);
  if (props.open && !started) setStarted(true);
  // Keep an attempted request alive across closing the modal. Refreshing case
  // props cannot replace the recipient or body of that request.
  return started ? <SmsComposerSession {...props} /> : null;
}

function SmsComposerSession({ caseId, caseNumber, initialPhone = "", initialMessage = "", externalRecipientLabel, initialTemplate = "custom", initialTab = "editor", onCreateCase, onClose, onSent, open }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const caseRef = useRef<HTMLSelectElement>(null);
  const busyRef = useRef(false);
  const [selectedCaseId, setSelectedCaseId] = useState(caseId ?? "");
  const [cases, setCases] = useState<SmsCaseOption[]>([]);
  const [tasks, setTasks] = useState<SmsTaskOption[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [phone, setPhone] = useState(initialPhone);
  const [template, setTemplate] = useState<SmsPrepareInput["template"]>(initialTemplate);
  const [callbackNumber, setCallbackNumber] = useState("");
  const [eta, setEta] = useState("");
  const [departed, setDeparted] = useState(false);
  const [towAddress, setTowAddress] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [preview, setPreview] = useState<SmsPreview | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SmsComposerResult | null>(null);
  const { mode: layoutMode } = useLayoutPreview();
  const modernLayout = layoutMode === "modern";
  const [tab, setTab] = useState<"editor" | "history" | "inbox">(initialTab);
  const [reply, setReply] = useState<SmsInboxMessage | null>(null);
  const [repliesEnabled, setRepliesEnabled] = useState(false);
  const [historyAll, setHistoryAll] = useState(!caseId);
  const [sender, setSender] = useState("PomocMotor");
  const [previousOpen, setPreviousOpen] = useState(open);
  const [openingIntent, setOpeningIntent] = useState(() => JSON.stringify([caseId, initialTemplate, initialPhone, initialMessage]));
  const [incomingHandoff, setIncomingHandoff] = useState(false);
  const selectedCase = cases.find((entry) => entry.id === selectedCaseId);
  const caseAvailable = Boolean(selectedCaseId && (selectedCase?.validPhone || (caseId === selectedCaseId && !selectedCase)));
  const requiresCase = template !== "custom";
  const segments = smsSegments(message.trim());
  const unresolved = result?.sms?.statusDetail === "send_unconfirmed" || result?.sms?.statusDetail === "sending_to_provider";
  // A later explicit quick action may request another template/case. Apply it
  // only on reopening, and never discard an unresolved send or change an open draft.
  if (open !== previousOpen) {
    setPreviousOpen(open);
    if (open) setTab(initialTab);
    const intent = JSON.stringify([caseId, initialTemplate, initialPhone, initialMessage]);
    if (open && intent !== openingIntent && initialMessage && attempted && (!result || unresolved)) setIncomingHandoff(true);
    if (open && intent !== openingIntent && (!attempted || (result && !unresolved))) {
      if (initialMessage && message.trim() && !result) {
        setIncomingHandoff(true);
      } else {
      setOpeningIntent(intent);
      setSelectedCaseId(caseId ?? ""); setTemplate(initialTemplate); setPhone(initialPhone);
      setPreview(null); setMessage(initialMessage); setResult(null); setAttempted(false);
      setRequestId(crypto.randomUUID()); setDeparted(false); setEta(""); setError("");
      setReply(null); setSelectedTaskId("");
      }
    }
  }
  const locked = preparing || sending || attempted;
  let validation = "";
  if (preview) {
    try {
      validateCustomSmsDraft({ message, toNumber: preview.draft.toNumber });
      if (preview.draft.template !== "custom") validateTemplateMessage(preview.draft.template, preview.draft.templateContext, message.trim());
    } catch (error) { validation = error instanceof Error ? error.message : "Skontrolujte text."; }
  }

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/sms/context", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Prípady sa nepodarilo načítať.");
      setTasks(data.tasks ?? []); setCases(data.cases); setCallbackNumber((current) => current || data.callbackNumber); setSender(data.sender); setLoaded(true);
      setRepliesEnabled(Boolean(data.repliesEnabled));
    }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [open]);
  if (!open) return null;

  function editContext() { setPreview(null); setError(""); }
  async function prepare() {
    if (busyRef.current || attempted) return;
    busyRef.current = true; setPreparing(true); setError("");
    try {
      const response = await fetch("/api/sms/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ requestId, caseId: externalRecipientLabel ? null : selectedCaseId || null, toNumber: phone, template, callbackNumber,
          taskId: !reply && (template === "eta_update" || template === "location_request") ? selectedTaskId || null : null,
          etaMinutes: eta ? Number(eta) : undefined, technicianDeparted: departed, towAddress, message, replyToMessageId: reply?.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Náhľad sa nepodarilo pripraviť.");
      setPreview(data); setMessage(data.draft.message);
    } catch (error) { setError(error instanceof Error ? error.message : "Náhľad sa nepodarilo pripraviť."); }
    finally { busyRef.current = false; setPreparing(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || !preview || validation) return;
    busyRef.current = true; setSending(true); setAttempted(true); setError("");
    try {
      const response = await fetch("/api/sms/send", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25_000), body: JSON.stringify({ ...preview, message: message.trim() }) });
      const data = await response.json();
      if (!response.ok) {
        // These failures happen before the durable send claim; a new preview is safe.
        if ([400, 403, 409, 423, 429].includes(response.status)) setAttempted(false);
        throw new Error(data.error || "Výsledok odoslania je nejasný. Overte tú istú požiadavku.");
      }
      setResult(data); onSent?.(data); window.dispatchEvent(new Event("sms-history-changed"));
    } catch (error) { setError(error instanceof Error && error.name !== "TimeoutError" ? error.message : "Spojenie sa prerušilo. Overte výsledok tej istej požiadavky; text ani príjemca sa nemenia."); }
    finally { busyRef.current = false; setSending(false); }
  }
  function newMessage() {
    setAttempted(false); setResult(null); setPreview(null); setMessage(""); setRequestId(crypto.randomUUID()); setError("");
    setDeparted(false); setEta(""); setSelectedTaskId("");
  }
  function handleKeys(event: React.KeyboardEvent) {
    if (event.key === "Escape" && !sending && !preparing) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') ?? []);
    const first = elements[0]; const last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const field = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-950 outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-200 disabled:bg-zinc-100 disabled:text-zinc-600";
  const button = "rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold disabled:opacity-40";
  return createPortal(<div data-layout-preview={layoutMode} className="fixed inset-0 z-[2147483640] grid place-items-center bg-zinc-950/60 p-3 text-zinc-950 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending && !preparing) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sms-title" onKeyDown={handleKeys} className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none">
      <div className="flex items-center gap-3 border-b border-yellow-200 bg-yellow-50 p-4"><MessageSquareText size={24} /><div className="flex-1"><h2 id="sms-title" className="text-lg font-black">SMS</h2><p className="text-xs text-zinc-600">Vlastné správy, šablóny a žiadosti o polohu</p></div><button type="button" aria-label="Zavrieť SMS" disabled={sending || preparing} onClick={onClose} className="rounded-lg p-2 hover:bg-white"><X size={20} /></button></div>
      <div className="live-sms-tabs flex flex-wrap gap-2 border-b px-4 py-2">
        <button type="button" aria-pressed={tab === "editor"} onClick={() => setTab("editor")} className={`${button} ${tab === "editor" ? "bg-yellow-100" : ""}`}>{modernLayout ? "Napísať SMS" : "Editor"}</button>
        {!modernLayout && <button type="button" onClick={() => setTab("inbox")} className={`${button} ${tab === "inbox" ? "bg-yellow-100" : ""}`}>Prijaté SMS</button>}
        <button type="button" aria-pressed={tab === "history"} onClick={() => setTab("history")} className={`${button} ${tab === "history" ? "bg-yellow-100" : ""}`}>{modernLayout ? "Odoslané SMS" : "História SMS"}</button>
        {modernLayout && <details className="live-sms-secondary"><summary>Ďalšie možnosti</summary><button type="button" aria-pressed={tab === "inbox"} onClick={() => setTab("inbox")} className={`${button} ${tab === "inbox" ? "bg-yellow-100" : ""}`}>Prijaté SMS</button></details>}
      </div>
      <div className="overflow-y-auto p-4 sm:p-5">
        {tab === "inbox" ? <SmsInbox cases={cases} repliesEnabled={loaded ? repliesEnabled : null} replyDisabled={preparing || sending || Boolean(attempted && (!result || unresolved))}
          onCreateCase={onCreateCase ? () => { onClose(); onCreateCase(); } : undefined}
          onReply={(incoming) => { newMessage(); setReply(incoming); setPhone(incoming.from); setSelectedCaseId(incoming.caseId ?? ""); setTemplate("custom"); setTab("editor"); }} />
          : tab === "history" ? <div className="grid gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={historyAll || !selectedCaseId} disabled={!selectedCaseId} onChange={(event) => setHistoryAll(event.target.checked)} />Všetky SMS vrátane správ bez prípadu</label><SmsHistory key={historyAll ? "all" : selectedCaseId} caseId={historyAll ? undefined : selectedCaseId || undefined} /></div> : <form onSubmit={submit} className="grid gap-4">
          {incomingHandoff && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6"><strong>Máte rozpracovanú SMS.</strong><p>Nový odkaz sa zatiaľ nepridal. Pripojiť ho k textu a nastaviť príjemcu na {initialPhone}?</p><button type="button" disabled={locked || message.length + initialMessage.length + 1 > MAX_CUSTOM_SMS_LENGTH} className="mt-2 font-semibold underline" onClick={() => { setMessage(current => current.includes(initialMessage) ? current : `${current}\n${initialMessage}`); setPhone(initialPhone); setTemplate("custom"); setSelectedCaseId(caseId ?? ""); setSelectedTaskId(""); setReply(null); setPreview(null); setError(""); setIncomingHandoff(false); setOpeningIntent(JSON.stringify([caseId, initialTemplate, initialPhone, initialMessage])); }}>Pripojiť odkaz a nastaviť príjemcu</button></div>}
          {reply && <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm leading-6"><strong>Odpoveď na prijatú SMS od {reply.from}</strong><p>{reply.caseNumber || "Bez prípadu"} · Z nášho čísla {reply.to}</p><p className="whitespace-pre-wrap break-words text-xs">{reply.body}</p>{!attempted && <button type="button" className="mt-2 text-xs font-semibold underline" disabled={preparing || sending} onClick={() => { newMessage(); setReply(null); setSelectedTaskId(""); setPhone(initialPhone); setSelectedCaseId(caseId ?? ""); }}>Zrušiť odpoveď a napísať inú SMS</button>}</div>}
          {!preview && !reply && <>
          <label className="grid gap-1.5 text-sm font-semibold">Prípad
            <select ref={caseRef} aria-label="Prípad SMS" value={selectedCaseId} disabled={locked || !loaded || !!externalRecipientLabel} onChange={(event) => { setSelectedCaseId(event.target.value); setSelectedTaskId(""); editContext(); }} className={field}>
              <option value="">Bez prípadu</option>
              {selectedCaseId && !selectedCase && <option value={selectedCaseId}>{caseNumber || selectedCaseId}</option>}
              {cases.map((entry) => <option key={entry.id} value={entry.id}>{entry.caseNumber} · {entry.name} · {entry.phone || "chýba telefón"}</option>)}
            </select>
          </label>
          {externalRecipientLabel && <p className="rounded-lg bg-sky-50 p-3 text-sm"><strong>{externalRecipientLabel}</strong><br />Samostatná SMS na uvedený telefón kolegu. Číslo prípadu je v texte; kontakt klienta sa nepoužije.</p>}
          {selectedCaseId ? <p className="rounded-lg bg-zinc-50 p-3 text-sm"><strong>{selectedCase?.caseNumber || caseNumber}</strong><br />{selectedCase?.name || "Kontakt overí server"} · {selectedCase?.phone || "Kontakt nie je dostupný"}</p>
            : <label className="grid gap-1.5 text-sm font-semibold">Telefón príjemcu<input type="tel" value={phone} disabled={locked} onChange={(event) => { setPhone(event.target.value); editContext(); }} placeholder="0904 123 456" className={field} /></label>}
          <label className="grid gap-1.5 text-sm font-semibold">Šablóna<select value={template} disabled={locked || !!externalRecipientLabel} onChange={(event) => { setTemplate(event.target.value as SmsPrepareInput["template"]); setSelectedTaskId(""); setMessage(""); editContext(); }} className={field}><option value="custom">Vlastná SMS</option>{SMS_TEMPLATES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          {requiresCase && !caseAvailable && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">Najprv vyberte uložený prípad s platným kontaktom. Rozpracovaný prípad treba výslovne uložiť.<div className="mt-2 flex gap-2"><button type="button" className={button} disabled={locked} onClick={() => caseRef.current?.focus()}>Vybrať prípad</button>{onCreateCase && <button type="button" className={button} disabled={locked} onClick={() => { onClose(); onCreateCase(); }}>Vytvoriť prípad</button>}</div></div>}
          {requiresCase && <label className="grid gap-1.5 text-sm font-semibold">Kontaktný telefón pre spätné volanie<input type="tel" value={callbackNumber} disabled={locked} onChange={(event) => { setCallbackNumber(event.target.value); editContext(); }} className={field} /></label>}
          {(template === "eta_update" || template === "delay") && <label className="grid gap-1.5 text-sm font-semibold">Aktuálny odhad príchodu (minúty)<input type="number" min={1} max={1440} value={eta} disabled={locked} onChange={(event) => { setEta(event.target.value); editContext(); }} className={field} /></label>}
          {selectedCaseId && (template === "eta_update" || template === "location_request") && <label className="grid gap-1.5 text-sm font-semibold">Úloha na dokončenie (voliteľné)
            <select aria-label="Úloha na dokončenie" value={selectedTaskId} disabled={locked} onChange={(event) => { setSelectedTaskId(event.target.value); editContext(); }} className={field}>
              <option value="">Bez dokončenia úlohy</option>
              {tasks.filter(task => task.caseId === selectedCaseId).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select><span className="text-xs font-normal text-zinc-600">{template === "eta_update" ? "Vybraná úloha sa dokončí po prijatí ETA SMS poskytovateľom." : "Vybraná úloha sa dokončí až po prijatí polohy klienta."}</span>
          </label>}
          {template === "eta_update" && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={departed} disabled={locked} onChange={(event) => { setDeparted(event.target.checked); editContext(); }} className="mt-1" />Potvrdzujem, že technik vyrazil. Samotný výpočet trasy to nepotvrdzuje.</label>}
          {template === "tow_destination" && <label className="grid gap-1.5 text-sm font-semibold">Dohodnutý cieľ odťahu<input value={towAddress} disabled={locked} onChange={(event) => { setTowAddress(event.target.value); editContext(); }} className={field} /></label>}
          {template === "location_request" && <p className="rounded-lg bg-sky-50 p-3 text-xs leading-5 text-sky-950">Link sa aktivuje odoslaním a platí 24 hodín na jedno odovzdanie polohy. Nové úmyselné vyžiadanie vytvorí ďalší link; staršie zostávajú platné do použitia alebo vypršania. Prijatú GPS použijete ako miesto incidentu výslovnou akciou v detaile.</p>}
          </>}
          {preview && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6"><strong>Overený príjemca: {preview.draft.recipientName}</strong><p>{preview.draft.caseNumber || "Bez prípadu"} · {preview.draft.toNumber}</p><p className="text-xs">Odosielateľ: {preview.draft.sender}. Zobrazený finálny text sa odošle presne v tomto znení.</p></div>}
          {preview?.draft.taskId && <p className="rounded-lg bg-zinc-50 p-3 text-sm">Úloha na dokončenie: <strong>{tasks.find(task => task.id === preview.draft.taskId)?.title ?? "Vybraná úloha"}</strong></p>}
          {preview && <div className="flex items-center justify-between gap-2 text-sm"><strong>{SMS_TEMPLATES.find((item) => item.key === preview.draft.template)?.label || "Vlastná SMS"}</strong>{!attempted && <button type="button" disabled={preparing || sending} onClick={editContext} className="text-xs font-semibold underline">Upraviť údaje</button>}</div>}
          {(template === "custom" || preview) && <label className="grid gap-1.5 text-sm font-semibold">{preview ? "Finálny text na odoslanie" : "Text správy"}<textarea value={message} disabled={attempted || preparing || sending} onChange={(event) => setMessage(event.target.value)} maxLength={MAX_CUSTOM_SMS_LENGTH} rows={5} className={`${field} resize-y leading-6`} /><span className="text-right text-xs font-normal text-zinc-500">{segments.segments} SMS segmentov · {segments.encoding} · {segments.units} jednotiek</span></label>}
          {message && !attempted && <button type="button" disabled={preparing || sending} onClick={() => setMessage(stripSmsDiacritics(message))} className="justify-self-start text-xs font-semibold underline">Odstrániť diakritiku v zobrazenom texte</button>}

          {preview?.draft.template === "location_request" && <p className="rounded-lg bg-sky-50 p-3 text-xs leading-5 text-sky-950">Žiadosť je pripravená. Link platí 24 hodín od odoslania; staršie linky zostávajú platné do použitia alebo vypršania. GPS použijete ako miesto incidentu výslovne v detaile prípadu.</p>}
          <p className="flex items-start gap-2 rounded-lg bg-zinc-50 p-3 text-xs leading-5 text-zinc-600"><Info size={16} className="mt-0.5 shrink-0" /><span>Odosielateľ <strong>{preview?.draft.sender || reply?.to || sender}</strong>. {(preview?.draft.repliesEnabled ?? repliesEnabled) ? "Klient môže odpovedať na toto číslo. Odpoveď nájdete v Prijatých SMS." : preview?.draft.repliesPendingVerification || reply ? "Číselný SMS kanál sa overuje. Príjem odpovedí zatiaľ nie je potvrdený živým testom." : "Príjem odpovedí SMS nie je aktívny. Na túto SMS sa nedá odpovedať; klient má použiť kontaktný telefón."}</span></p>
          {(error || validation) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error || validation}</p>}
          {result?.sms && <div role="status" className="rounded-lg border border-zinc-200 p-3 text-sm leading-6"><strong>{smsStatusLabel(result.sms.status || "", result.sms.statusDetail)}</strong><p>{result.sms.reused ? "Zobrazujeme výsledok pôvodnej požiadavky. Ďalšia SMS sa neodoslala." : "Požiadavka je zapísaná v histórii."}</p>{unresolved && <p>Výsledok zatiaľ nie je potvrdený. Nevytvárajte ďalšiu SMS; overte stav tejto požiadavky.</p>}</div>}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            {!attempted && <button type="button" disabled={preparing || sending || !loaded || (requiresCase && !caseAvailable) || Boolean(!reply && selectedCaseId && selectedCase && !selectedCase.validPhone) || (template === "eta_update" && !departed)} onClick={() => void prepare()} className={button}>{preparing ? "Pripravujem…" : preview ? "Obnoviť náhľad" : "Pripraviť náhľad"}</button>}
            {preview && (!result || unresolved) && <button type="submit" disabled={sending || preparing || Boolean(validation)} className="inline-flex items-center gap-2 rounded-lg bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}{sending ? "Overujem a odosielam…" : attempted ? "Overiť tú istú požiadavku" : "Odoslať SMS"}</button>}
            {result && !unresolved && <button type="button" onClick={newMessage} className={button}>{template === "location_request" ? "Úmyselne vyžiadať novú polohu" : "Napísať novú SMS"}</button>}
          </div>
        </form>}
      </div>
    </div>
  </div>, document.body);
}
