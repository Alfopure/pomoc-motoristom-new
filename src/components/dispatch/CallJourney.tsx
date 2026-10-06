"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, GitBranch, MonitorSmartphone, Phone, PhoneForwarded, RefreshCw, X } from "lucide-react";
import { journeyElapsedSeconds, type CallJourney as Journey, type CallJourneyResponse, type JourneyOccurrence } from "@/lib/telephony/call-journey";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { currentJourneyOccurrence, ENDPOINT_CHANNELS, endpointAttemptSeconds, endpointStateLabel, JOURNEY_STALE_MS, journeyDisplayNow, journeyReason, journeyStageLabel, journeyTerminalKey, journeyTimer, occurrenceElapsed } from "./call-journey-model";
import { useCallJourneyClock, useCallJourneyResource } from "./use-call-journey";
import styles from "./call-journey.module.css";

function eventTime(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString("sk-SK", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

function Occurrence({ occurrence, journey, now }: { occurrence: JourneyOccurrence; journey: Journey; now: number }) {
  const active = occurrence.state === "active";
  const elapsed = occurrenceElapsed(occurrence, now);
  const limit = occurrence.configuredSeconds;
  const Icon = occurrence.kind === "wait" ? Clock3 : occurrence.kind === "ending" ? PhoneForwarded : Phone;
  return <li className={styles.occurrence} data-state={occurrence.state} data-kind={occurrence.kind}>
    <span className={styles.visitMark} aria-hidden="true">{occurrence.state === "completed" ? <Check size={12} /> : <Icon size={12} />}</span>
    <div className={styles.visitHeader}><h4>{occurrence.label}{occurrence.repeatRound ? <small>Opakovanie {occurrence.repeatRound}</small> : null}</h4><span className={styles.duration}>{active && <span className={styles.activeLabel}>teraz</span>} {journeyTimer(elapsed)}{active && limit !== null ? <small> / {journeyTimer(limit)}</small> : null}</span></div>
    {occurrence.reason && <p className={styles.reason}>{journeyReason(occurrence.reason)}</p>}
    {occurrence.state === "pending" && <p className={styles.reason}>Ďalší krok, ak sa hovor dovtedy nespojí.</p>}
    {occurrence.state === "not_reached" && <p className={styles.reason}>Tento krok sa nepoužil.</p>}
    {occurrence.state === "skipped" && !occurrence.reason && <p className={styles.reason}>Krok bol vynechaný.</p>}
    {occurrence.timingBasis === "offer_interval" && elapsed !== null && <p className={styles.timingNote}>Čas zaznamenaných pokusov o spojenie.</p>}
    {active && elapsed !== null && limit !== null && elapsed >= limit && <p className={styles.timingNote}>Limit uplynul; čakáme na potvrdenie ďalšieho stavu.</p>}
    {occurrence.endpoints.length > 0 && <details className={styles.endpointDetails}>
      <summary>Komu a kam sa volalo <span>{occurrence.endpoints.length}</span></summary>
      <ul>{occurrence.endpoints.map(endpoint => {
        const seconds = endpointAttemptSeconds(endpoint, active, now);
        return <li key={endpoint.id} className={styles.endpoint}>
          <span className={styles.endpointIcon} aria-hidden="true">{endpoint.channel === "personal_number" || endpoint.channel === "external_number" ? <Phone size={14} /> : <MonitorSmartphone size={14} />}</span>
          <div><strong>{endpoint.displayName ?? (endpoint.profileId ? "Operátor" : "Externý príjemca")}</strong><p>{ENDPOINT_CHANNELS[endpoint.channel]}{endpoint.number ? ` · ${formatPhoneNumberForDisplay(endpoint.number)}` : ""}</p><small>{endpointStateLabel(endpoint, journey)}</small></div>
          <time>{journeyTimer(seconds)}</time>
        </li>;
      })}</ul>
    </details>}
  </li>;
}

/** The same evidence presentation is used for live and historical calls. */
export function CallJourneyTimeline({ journey, now, stale = false, compact = false }: { journey: Journey; now: number; stale?: boolean; compact?: boolean }) {
  const [showUnused, setShowUnused] = useState(false);
  const unused = journey.occurrences.filter(occurrence => ["not_reached", "pending"].includes(occurrence.state));
  const visited = journey.occurrences.filter(occurrence => !["not_reached", "pending"].includes(occurrence.state));
  const duration = journeyElapsedSeconds(journey.startedAt, journey.endedAt, now);
  const current = currentJourneyOccurrence(journey);
  const customerNumber = journey.direction === "outbound" ? journey.calledNumber : journey.callerNumber;
  return <div className={styles.timelineBody} data-compact={compact} data-stale={stale}>
    <div className={styles.journeyIdentity}><strong>{customerNumber ? formatPhoneNumberForDisplay(customerNumber) : "Číslo nie je dostupné"}</strong><span>{journey.sessionActive ? stale ? "Posledný stav" : "Naživo" : "Ukončený hovor"}</span></div>
    <div className={styles.currentStatus} data-kind={current?.kind} data-phase={journey.phase}><span className={styles.statusDot} /><p aria-live="polite">{journeyStageLabel(journey)}</p><time>{journeyTimer(duration)} <small>celkom</small></time></div>
    {journey.callback?.kind === "requested" && <div className={styles.callbackNote}><PhoneForwarded size={15} aria-hidden="true" /><p>Spätné volanie vyžiadal volajúci{journey.callback.digit ? ` stlačením ${journey.callback.digit}` : ""}{journey.callback.requestedAt ? ` o ${eventTime(journey.callback.requestedAt)}` : ""}. Ďalšie smerovanie sa zastavilo.</p></div>}
    {(journey.coverage !== "complete" || journey.truncated) && <p className={styles.coverage}><AlertCircle size={14} aria-hidden="true" />{journey.coverage === "unavailable" ? "Podrobný priebeh tohto hovoru nie je dostupný." : "Časť priebehu nie je zaznamenaná. Chýbajúce časy ani dôvody neodhadujeme."}{journey.truncated ? " Zobrazuje sa len časť záznamov." : ""}</p>}
    <ol className={styles.visits} aria-label="Priebeh hovoru">{visited.map(occurrence => <Occurrence key={occurrence.id} occurrence={occurrence} journey={journey} now={now} />)}</ol>
    {unused.length > 0 && <><button type="button" className={styles.unusedButton} aria-expanded={showUnused} onClick={() => setShowUnused(value => !value)}>{showUnused ? "Skryť" : "Zobraziť"} {journey.sessionActive ? "ďalšie" : "nepoužité"} kroky ({unused.length})</button>{showUnused && <ol className={styles.visits} aria-label="Ďalšie kroky">{unused.map(occurrence => <Occurrence key={occurrence.id} occurrence={occurrence} journey={journey} now={now} />)}</ol>}</>}
    {journey.events.length > 0 && <details className={styles.events}><summary>Udalosti hovoru ({journey.events.length})</summary><ol>{journey.events.map(event => <li key={event.id}><time dateTime={event.at}>{eventTime(event.at)}</time><div><strong>{event.label}</strong>{event.reason && <p>{journeyReason(event.reason)}</p>}</div></li>)}</ol></details>}
    <p className={styles.evidenceNote}>Časy pokusov nepotvrdzujú zvuk na zariadení. Súčasné pokusy sa do celkového času nesčítavajú.</p>
  </div>;
}

export function CallJourneyCard({ id, identity = "call", live = false, heading = true }: { id: string; identity?: "call" | "session"; live?: boolean; heading?: boolean }) {
  const url = `/api/telephony/calls/${encodeURIComponent(id)}/journey${identity === "session" ? "?identity=session" : ""}`;
  const resource = useCallJourneyResource<CallJourneyResponse>(url, live ? 5_000 : 0, live ? terminalResponseKey : undefined);
  return <CallJourneySnapshotCard journey={resource.data?.journey} {...resource} live={live} heading={heading} />;
}

function terminalResponseKey(response: CallJourneyResponse): string | null {
  return journeyTerminalKey(response.journey);
}

/** Renders a confirmed snapshot without starting another request loop. */
export function CallJourneySnapshotCard({ journey, observedAt, loading, error, refresh, settled = false, live = false, heading = true }: {
  journey?: Journey; observedAt: number | null; loading: boolean; error: string | null; refresh: () => void;
  settled?: boolean; live?: boolean; heading?: boolean;
}) {
  const clock = useCallJourneyClock(live && Boolean(journey?.sessionActive));
  const stale = Boolean(error || (live && !settled && observedAt !== null && clock - observedAt > JOURNEY_STALE_MS));
  const now = journey ? journeyDisplayNow(journey, observedAt, clock, stale || !live || settled) : clock;
  return <section className={styles.card} aria-label="Priebeh hovoru">
    {heading && <header className={styles.cardHeader}><h3><GitBranch size={16} aria-hidden="true" />Priebeh hovoru</h3>{journey && <small>{journey.sessionActive ? "Postup pri prijatí hovoru" : "Uložený priebeh"}</small>}</header>}
    {loading && !journey && <p className={styles.empty} role="status">Načítavam priebeh hovoru…</p>}
    {(error || stale) && <div className={styles.resourceNotice} role="status"><p>{error ?? "Údaje sa neobnovujú."}{journey ? ` Posledný stav o ${eventTime(journey.asOf)}.` : ""}</p><button type="button" onClick={refresh}><RefreshCw size={13} aria-hidden="true" />Obnoviť</button></div>}
    {journey && <CallJourneyTimeline journey={journey} now={now} stale={stale} />}
    {settled && !stale && <div className={styles.settledActions}><button type="button" className={styles.openButton} onClick={refresh}><RefreshCw size={13} aria-hidden="true" />Obnoviť</button></div>}
  </section>;
}

export function CallJourneyButton({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={styles.openButton} onClick={() => setOpen(true)}><GitBranch size={13} aria-hidden="true" />Priebeh<ChevronRight size={12} aria-hidden="true" /></button>{open && <JourneyDialog sessionId={sessionId} onClose={() => setOpen(false)} />}</>;
}

function JourneyDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.dialogHeader}><h2 id={titleId}>Priebeh hovoru</h2><button type="button" onClick={onClose} aria-label="Zavrieť priebeh hovoru"><X size={20} aria-hidden="true" /></button></header>
    <div className={styles.dialogBody}><CallJourneyCard id={sessionId} identity="session" live heading={false} /></div>
  </dialog>;
}
