"use client";
import { useEffect, useRef, useState } from "react";
import type { MonitorInvitationView } from "@/lib/telephony/monitor-invitations";

type Inbox = { enabled: boolean; invitations: MonitorInvitationView[]; targets: { profileId: string; displayName: string; available: boolean }[] };
const empty: Inbox = { enabled: false, invitations: [], targets: [] };
const control = "min-h-11 rounded-lg border border-white/30 bg-zinc-800 px-3 py-2 text-base text-white disabled:opacity-50";

/** No microphone controls: provider monitor role is the authority for receive-only audio. */
export function CallMonitorInvitations({ sessionId, listeningSessionId, onStop, onAccept }: {
  sessionId: string | null; listeningSessionId: string | null; onStop: (sessionId: string) => void; onAccept?: (sessionId: string, invitationId: string) => Promise<void>;
}) {
  const [inbox, setInbox] = useState<Inbox>(empty);
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef({ value: 0 });
  const alive = useRef(true);
  async function refresh() {
    const current = ++sequence.current.value;
    try {
      const response = await fetch("/api/telephony/monitor-invitations", { cache: "no-store" });
      if (!alive.current || current !== sequence.current.value) return;
      if (!response.ok) { setInbox(empty); return; }
      const data = await response.json() as Inbox;
      if (alive.current && current === sequence.current.value) setInbox(data);
    } catch { if (alive.current && current === sequence.current.value) setInbox(empty); }
  }
  useEffect(() => {
    alive.current = true;
    const requestCounter = sequence.current;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 8_000);
    const focus = () => { setInbox(empty); void refresh(); };
    window.addEventListener("focus", focus);
    return () => { alive.current = false; requestCounter.value++; clearTimeout(initial); clearInterval(timer); window.removeEventListener("focus", focus); };
  }, []);
  async function act(callId: string, payload: Record<string, string>) {
    setBusy(true); setError(null);
    try {
      if (payload.action === "accept") {
        if (!onAccept) throw new Error("Telefón nie je pripravený na prijatie pozvánky.");
        await onAccept(callId, payload.invitationId); await refresh(); return;
      }
      const response = await fetch(`/api/telephony/calls/${encodeURIComponent(callId)}/monitor-invitations`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Pozvané počúvanie sa nepodarilo zmeniť.");
      setRecipient(""); await refresh();
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Počúvanie sa nepodarilo zmeniť."); }
    finally { if (alive.current) setBusy(false); }
  }
  const visible = inbox.invitations.filter(invitation => invitation.status === "pending" || invitation.status === "listening" || invitation.status === "disconnecting");
  const received = visible.filter(invitation => !invitation.mine);
  const sent = visible.filter(invitation => invitation.mine && (invitation.sessionId === sessionId || invitation.status === "disconnecting"));
  if (!inbox.enabled && !visible.length) return null;
  return <div className="w-full shrink-0 bg-zinc-900 px-3 py-2 text-sm text-white" data-testid="call-monitor-invitations">
    {(sessionId || received.length > 0 || sent.length > 0) && <button type="button" className={control} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      Pozvané počúvanie{received.length ? ` (${received.length})` : ""}
    </button>}
    {(open || received.length > 0 || sent.some(invitation => invitation.status === "disconnecting")) && <section aria-label="Pozvané počúvanie" className="mt-2 flex flex-wrap items-start gap-3 rounded-xl border border-white/20 p-3">
      {sessionId && inbox.enabled && <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (recipient) void act(sessionId, { action: "invite", recipientProfileId: recipient }); }}>
        <label className="min-w-0">Poslucháč<select aria-label="Pozvať poslucháča" className={`${control} mt-1 block max-w-full`} value={recipient} onChange={event => setRecipient(event.target.value)}>
          <option value="">Vyber operátora</option>{inbox.targets.map(target => <option key={target.profileId} value={target.profileId} disabled={!target.available}>{target.displayName}{!target.available ? " – nedostupný" : ""}</option>)}
        </select></label>
        <button className={control} disabled={!recipient || busy}>Pozvať na počúvanie</button>
      </form>}
      {sent.map(invitation => <div key={invitation.id} className="flex flex-wrap items-center gap-2"><span>{invitation.recipientName}: {invitation.status === "disconnecting" ? "odpojenie sa potvrdzuje" : invitation.status === "listening" ? "počúva" : "čaká na prijatie (2 min)"}</span>
        <button type="button" className={control} disabled={busy} onClick={() => void act(invitation.sessionId, { action: "revoke", invitationId: invitation.id })}>{invitation.status === "disconnecting" ? "Zopakovať odpojenie" : invitation.status === "listening" ? "Odpojiť poslucháča" : "Odvolať pozvánku"}</button></div>)}
      {received.map(invitation => <div key={invitation.id} className="min-w-0 space-y-2"><p>{invitation.inviterName} {invitation.status === "disconnecting" ? "– odpojenie sa potvrdzuje. Počúvanie ešte môže byť pripojené." : invitation.status === "listening" ? "– počúvaš jeho hovor. Tvoj mikrofón ostatní nepočujú." : "ťa pozýva počúvať vlastný hovor. Pozvánka platí 2 minúty."}</p>
        {invitation.status === "pending" && <button type="button" className={control} disabled={busy || !inbox.enabled || Boolean(listeningSessionId || sessionId)} onClick={() => void act(invitation.sessionId, { action: "accept", invitationId: invitation.id })}>Prijať počúvanie</button>}
        {["listening", "disconnecting"].includes(invitation.status) && <button type="button" className={control} onClick={() => onStop(invitation.sessionId)}>{invitation.status === "disconnecting" ? "Zopakovať moje odpojenie" : "Ukončiť moje počúvanie"}</button>}
      </div>)}
      {error && <p role="alert" className="w-full text-amber-200">{error}</p>}
    </section>}
  </div>;
}
