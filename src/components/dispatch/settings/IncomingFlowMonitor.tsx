"use client";

import { useState } from "react";
import { ArrowDown, Clock3, GitBranch, LockKeyhole, Phone, RefreshCw } from "lucide-react";
import { incomingFlowSignature, type CallJourney, type CallJourneysResponse } from "@/lib/telephony/call-journey";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { CallJourneyCard } from "../CallJourney";
import { currentJourneyOccurrence, JOURNEY_STALE_MS, journeyDisplayNow, journeyRouteGroups, journeyStageLabel, journeyTimer, occurrenceElapsed } from "../call-journey-model";
import { useCallJourneyClock, useCallJourneyResource } from "../use-call-journey";
import styles from "./incoming-flow-monitor.module.css";

export function IncomingFlowMonitor({ lineId, savedFlow, dirty }: { lineId: string; savedFlow: IncomingFlow | null; dirty: boolean }) {
  const resource = useCallJourneyResource<CallJourneysResponse>(`/api/telephony/calls/journeys?lineId=${encodeURIComponent(lineId)}`);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const calls = resource.data?.calls ?? [];
  const groups = journeyRouteGroups(calls);
  const now = useCallJourneyClock(calls.length > 0);
  const stale = Boolean(resource.error || (resource.observedAt !== null && now - resource.observedAt > JOURNEY_STALE_MS));
  const selected = selectedId ?? calls[0]?.sessionId ?? null;
  const signature = savedFlow ? incomingFlowSignature(savedFlow) : null;
  const chip = (call: CallJourney) => {
    const occurrence = currentJourneyOccurrence(call);
    const seconds = occurrence ? occurrenceElapsed(occurrence, journeyDisplayNow(call, resource.observedAt, now, stale)) : null;
    const number = formatPhoneNumberForDisplay(call.callerNumber ?? "") || "Neznáme číslo";
    return <button type="button" key={call.sessionId} className={styles.callChip} aria-pressed={selected === call.sessionId} aria-label={`${number}: ${journeyStageLabel(call)}`} onClick={() => setSelectedId(call.sessionId)}><Phone size={12} aria-hidden="true" /><span>{number}</span>{seconds !== null && <time>{journeyTimer(seconds)}</time>}</button>;
  };
  return <section className={styles.monitor} aria-label="Hovory v uloženom postupe" data-stale={stale}>
    <header className={styles.header}><div><h3>Kde sa hovory nachádzajú</h3><p>Vyber číslo pri kroku a zobrazí sa jeho priebeh.</p></div><span className={styles.freshness}><span />{stale ? "Posledný potvrdený stav" : resource.loading && !resource.data ? "Načítavam" : "Naživo"}</span></header>
    {dirty && <p className={styles.notice}><LockKeyhole size={14} aria-hidden="true" />Sleduješ uložený postup. Rozpracované zmeny sa prejavia až po uložení, pri nových hovoroch.</p>}
    {resource.error && <div className={styles.notice} role="status"><p>{resource.error} Posledné údaje nemusia byť aktuálne.</p><button type="button" onClick={resource.refresh}><RefreshCw size={13} aria-hidden="true" />Obnoviť</button></div>}
    {resource.data?.truncated && <p className={styles.notice}>Zobrazuje sa iba časť prebiehajúcich hovorov na tejto linke.</p>}
    {!calls.length && !resource.loading && !resource.error && <p className={styles.empty}>Na tejto linke práve neprebieha hovor.</p>}
    <div className={styles.layout} data-has-detail={Boolean(selected)}>
      <div className={styles.routes}>{groups.map(group => {
        const first = group.calls[0];
        const reference = group.calls.reduce((best, call) => call.occurrences.length > best.occurrences.length ? call : best, first);
        const currentSaved = Boolean(signature && group.signature === signature);
        // Execution index only aligns within the same frozen route signature.
        const rowKey = (call: CallJourney) => currentJourneyOccurrence(call)?.executionIndex ?? null;
        const elsewhere = group.calls.filter(call => rowKey(call) === null || call.phase !== "routing");
        return <section className={styles.route} key={group.key} aria-label={currentSaved ? "Aktuálne uložený postup" : "Postup pri prijatí hovoru"}>
          <p className={styles.routeLabel}><LockKeyhole size={12} aria-hidden="true" />{currentSaved ? "Aktuálne uložený postup" : "Postup pri prijatí hovoru"}{!currentSaved && <span>{new Date(first.startedAt).toLocaleTimeString("sk-SK", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit" })}</span>}</p>
          {!currentSaved && <p className={styles.versionNote}>Tento priebeh zobrazujeme samostatne; nemusí zodpovedať dnešnému nastaveniu.</p>}
          <ol className={styles.rail}>{reference.occurrences.map((occurrence, index) => {
            const here = group.calls.filter(call => call.phase === "routing" && rowKey(call) === occurrence.executionIndex);
            const active = here.length > 0;
            return <li className={styles.step} key={occurrence.id} data-active={active} data-kind={occurrence.kind}>
              <span className={styles.number}>{index + 1}</span><div className={styles.stepCard}><div className={styles.stepHeader}><div>{occurrence.kind === "wait" ? <Clock3 size={16} aria-hidden="true" /> : <GitBranch size={16} aria-hidden="true" />}<h4>{occurrence.label}</h4></div>{occurrence.configuredSeconds !== null && <small>Najviac {journeyTimer(occurrence.configuredSeconds)}</small>}</div>{occurrence.repeatRound && <p className={styles.repeat}>Opakovanie {occurrence.repeatRound}</p>}{active && <div className={styles.chips}>{here.map(chip)}</div>}</div>{index < reference.occurrences.length - 1 && <span className={styles.connector} aria-hidden="true"><ArrowDown size={12} /></span>}
            </li>;
          })}</ol>
          {elsewhere.length > 0 && <div className={styles.otherCalls}>{elsewhere.map(call => <div key={call.sessionId}><span>{journeyStageLabel(call)}</span>{chip(call)}</div>)}</div>}
        </section>;
      })}</div>
      {selected && <aside className={styles.detail}><CallJourneyCard key={selected} id={selected} identity="session" live /></aside>}
    </div>
  </section>;
}
