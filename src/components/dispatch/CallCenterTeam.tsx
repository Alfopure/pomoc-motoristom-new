"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import type { Operator } from "@/domain/types";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";
import type { TelephonyTeamPayload } from "@/lib/telephony/team";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import styles from "./CallCenterModule.module.css";

const LABELS: Record<string, string> = { available: "Dostupný", ringing: "Zvoní", on_call: "Telefonuje", paused: "Pauza", after_call_work: "Dokončuje hovor", offline: "Mimo radu", unassigned: "Nezaradený", unregistered: "Telefón nepripojený", stale: "Overuje sa", error: "Chyba spojenia" };
function elapsed(since: string | null | undefined, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since ?? "")) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60 ? "< 1 min" : seconds < 3600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
}
function contactTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short", timeZone: MOTORIST_TIME_ZONE }).format(new Date(value)) : "Nezaznamenaný";
}
export function CallCenterTeam({ operators, presences }: { operators: Operator[]; presences: TelephonyOperatorPresence[] }) {
  const [payload, setPayload] = useState<TelephonyTeamPayload | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let lease: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const load = async () => {
      if (stopped || controller) return;
      const startedAt = Date.now();
      controller = new AbortController();
      const result = await telephonyJson<TelephonyTeamPayload>("/api/telephony/team", { label: "prehľad operátorov", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read }).catch(() => null);
      controller = null;
      if (stopped) return;
      setNow(Date.now());
      if (result?.ok && result.body) {
        setPayload(result.body); setError(false);
        clearTimeout(lease);
        lease = setTimeout(() => { setPayload(null); setError(true); }, Math.max(0, 30_000 - (Date.now() - startedAt)));
      } else { setError(true); if (result?.status === 401 || result?.status === 403) setPayload(null); }
      clearTimeout(timer); timer = setTimeout(() => void load(), 25_000);
    };
    const onFocus = () => void load();
    void load(); window.addEventListener("focus", onFocus); window.addEventListener("online", onFocus);
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); clearTimeout(lease); window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, []);
  const rows = payload?.operators ?? operators.map((operator) => ({ profileId: operator.id, name: operator.name, status: "offline" as const, statusSince: null, answeredToday: null, call: undefined, lastDeviceContactAt: null, lastMobileContactAt: null, talkSecondsToday: null, availableSecondsToday: null, pausedSecondsToday: null }));
  return <section className={styles.teamStrip} aria-label="Operátori">
    <div className={styles.teamStripHeading}><Users size={16} /><h2>Operátori</h2><span>{rows.length}</span>{error && <span className="text-amber-800">Štatistiky sa overujú</span>}</div>
    <div className={styles.teamMembers}>
      {rows.map((operator) => {
        const presence = presences.find((item) => item.profileId === operator.profileId);
        const status = presence?.state ?? operator.status;
        const stateLabel = LABELS[status] ?? "Neznámy stav";
        return <details className={styles.teamMember} key={operator.profileId} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
          <summary><span className={`${styles.presenceDot} ${["on_call", "ringing"].includes(status) ? styles.callingDot : status === "available" ? styles.availableDot : ["paused", "after_call_work"].includes(status) ? styles.pausedDot : ""}`} /><span><strong>{operator.name}</strong><small>{stateLabel}{operator.statusSince && status === operator.status ? ` · ${elapsed(operator.statusSince, now)}` : ""}</small></span><span className={styles.teamToday} title="Prijaté prichádzajúce hovory dnes">{operator.answeredToday ?? "—"}<small>dnes</small></span><ChevronDown size={12} /></summary>
          <div className={styles.teamDetail}>
            <strong>{operator.name}</strong><p>{presence?.detail ?? stateLabel}</p>
            {operator.call && ["on_call", "ringing"].includes(status) && <p>Hovor: {operator.call.callerName || formatPhoneNumberForDisplay(operator.call.callerNumber) || "Neznámy volajúci"}{operator.call.lineLabel ? ` · ${operator.call.lineLabel}` : ""}</p>}
            <dl><dt>Prijaté dnes</dt><dd>{operator.answeredToday ?? "Overuje sa"}</dd><dt>Hovory dnes</dt><dd>{operator.talkSecondsToday === null ? "Overuje sa" : `${Math.floor(operator.talkSecondsToday / 60)} min`}</dd><dt>Posledný kontakt počítača</dt><dd>{contactTime(operator.lastDeviceContactAt)}</dd><dt>Posledný kontakt mobilu</dt><dd>{contactTime(operator.lastMobileContactAt)}</dd></dl>
          </div>
        </details>;
      })}
      {!rows.length && <p className="text-xs text-zinc-500">Zatiaľ nie sú priradení žiadni operátori.</p>}
    </div>
  </section>;
}
