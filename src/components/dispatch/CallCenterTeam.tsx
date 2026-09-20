"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import type { Operator } from "@/domain/types";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";
import type { TelephonyTeamOperator, TelephonyTeamPayload } from "@/lib/telephony/team";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { lastOnlineLabel } from "./team-display";
import styles from "./CallCenterModule.module.css";

const LABELS: Record<string, string> = { available: "Dostupný", ringing: "Zvoní", on_call: "Telefonuje", paused: "Pauza", after_call_work: "Dokončuje hovor", offline: "Mimo radu", unassigned: "Nezaradený", unregistered: "Offline", stale: "Overuje sa", error: "Chyba spojenia" };
const TEAM_LEASE_MS = 30_000;
function contactTime(value: string | null) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short", timeZone: MOTORIST_TIME_ZONE }).format(new Date(time)) : "Bez dostupného záznamu";
}
function talkTime(seconds: number) {
  return seconds > 0 && seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

function OperatorCard({ operator, presence, verified, now }: { operator: TelephonyTeamOperator; presence?: TelephonyOperatorPresence; verified: boolean; now: number }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presenceAge = now - Date.parse(presence?.checkedAt ?? "");
  const freshPresence = presence && presenceAge >= -1_000 && presenceAge < TEAM_LEASE_MS ? presence : undefined;
  const online = verified && operator.online;
  let status = verified ? freshPresence?.state ?? operator.status : "stale";
  if (!online && status === "available") status = "unregistered";
  const stateLabel = LABELS[status] ?? "Neznámy stav";
  const recency = lastOnlineLabel(online, operator.lastOnlineAt, now, verified);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = ref.current;
      const detail = detailRef.current;
      if (!anchor || !detail) return;
      const rect = anchor.getBoundingClientRect();
      const width = detail.offsetWidth;
      detail.style.left = `${Math.max(12 - rect.left, Math.min(0, window.innerWidth - 12 - rect.left - width))}px`;
      const fitsBelow = rect.bottom + 5 + detail.offsetHeight <= window.innerHeight - 12;
      const preferredTop = !fitsBelow && rect.top >= detail.offsetHeight + 12 ? rect.top - detail.offsetHeight - 5 : rect.bottom + 5;
      const top = Math.max(12, Math.min(preferredTop, window.innerHeight - 12 - detail.offsetHeight));
      detail.style.top = `${top - rect.top}px`;
    };
    const dismiss = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [open, operator, verified]);

  return <details ref={ref} className={styles.teamMember} data-testid="operator-card" onToggle={(event) => setOpen(event.currentTarget.open)} onKeyDown={(event) => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}>
    <summary>
      <span aria-hidden="true" className={`${styles.presenceDot} ${verified && ["on_call", "ringing"].includes(status) ? styles.callingDot : online && status === "available" ? styles.availableDot : online && ["paused", "after_call_work"].includes(status) ? styles.pausedDot : ""}`} />
      <span className={styles.teamIdentity}><strong>{operator.name}</strong><span className={styles.teamMeta}><small>{stateLabel}</small><small className={online ? styles.teamOnline : undefined} data-testid="operator-last-online">{recency}</small></span></span>
      <ChevronDown size={12} aria-hidden="true" />
    </summary>
    <div ref={detailRef} className={styles.teamDetail} data-testid="operator-detail">
      <strong>{operator.name}</strong><p>{online ? "Telefón je aktuálne pripojený." : recency}</p>
      {operator.call && verified && ["on_call", "ringing"].includes(status) && <p>Hovor: {operator.call.callerName || formatPhoneNumberForDisplay(operator.call.callerNumber) || "Neznámy volajúci"}{operator.call.lineLabel ? ` · ${operator.call.lineLabel}` : ""}</p>}
      <dl>
        <dt>Nastavený stav</dt><dd>{verified ? LABELS[operator.status] ?? "Neznámy stav" : "Overuje sa"}</dd>
        <dt>Stav nastavený od</dt><dd>{verified ? contactTime(operator.statusSince) : "Overuje sa"}</dd>
        <dt>Prijaté hovory dnes</dt><dd>{verified ? operator.answeredToday : "Overuje sa"}</dd>
        <dt>Čas prijatých hovorov dnes</dt><dd>{verified ? talkTime(operator.talkSecondsToday) : "Overuje sa"}</dd>
        <dt>Naposledy online cez počítač</dt><dd>{verified ? contactTime(operator.lastDeviceContactAt) : "Overuje sa"}</dd>
        <dt>Naposledy online cez mobil</dt><dd>{verified ? contactTime(operator.lastMobileContactAt) : "Overuje sa"}</dd>
      </dl>
    </div>
  </details>;
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
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    const load = async () => {
      if (stopped || controller) return;
      const startedAt = Date.now();
      controller = new AbortController();
      const result = await telephonyJson<TelephonyTeamPayload>("/api/telephony/team", { label: "prehľad operátorov", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read }).catch(() => null);
      controller = null;
      if (stopped) return;
      const receivedAt = Date.now();
      setNow(receivedAt);
      const checkedAt = Date.parse(result?.body?.checkedAt ?? "");
      const deadline = Math.min(startedAt + TEAM_LEASE_MS, checkedAt + TEAM_LEASE_MS);
      if (result?.ok && result.body && Number.isFinite(deadline) && deadline > receivedAt) {
        setPayload(result.body); setError(false);
        clearTimeout(lease);
        lease = setTimeout(() => { setPayload(null); setError(true); }, deadline - receivedAt);
      } else {
        setError(true);
        if (result?.status === 401 || result?.status === 403 || (result?.ok && deadline <= receivedAt)) setPayload(null);
      }
      clearTimeout(timer); timer = setTimeout(() => void load(), 25_000);
    };
    const onFocus = () => void load();
    void load(); window.addEventListener("focus", onFocus); window.addEventListener("online", onFocus);
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); clearTimeout(lease); clearInterval(clock); window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus); };
  }, []);
  const rows: TelephonyTeamOperator[] = payload?.operators ?? operators.map((operator) => ({ profileId: operator.id, name: operator.name, status: "offline", statusSince: null, answeredToday: 0, online: false, lastOnlineAt: null, lastDeviceContactAt: null, lastMobileContactAt: null, talkSecondsToday: 0, availableSecondsToday: 0, pausedSecondsToday: 0 }));
  return <section className={styles.teamStrip} aria-label="Operátori">
    <div className={styles.teamStripHeading}><Users size={16} /><h2>Operátori</h2><span>{rows.length}</span>{error && <span className="text-amber-800">Spojenie sa overuje</span>}</div>
    <div className={styles.teamMembers}>
      {rows.map(operator => <OperatorCard key={operator.profileId} operator={operator} presence={presences.find(item => item.profileId === operator.profileId)} verified={payload !== null} now={now} />)}
      {!rows.length && <p className="text-xs text-zinc-500">Zatiaľ nie sú priradení žiadni operátori.</p>}
    </div>
  </section>;
}
