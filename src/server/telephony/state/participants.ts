import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { isOpenLeg, readMeta, type LegRow, type SessionRow } from "./types";

type Admin = SupabaseClient<Database>;
type Interval = Database["public"]["Tables"]["motorist_call_participant_intervals"]["Row"];

export type ParticipantManifest = {
  version: 1;
  topologyEpoch: number;
  identitySource: "authenticated_leg_binding";
  coverage: "verified" | "unverified";
  channelMappingVerified: boolean;
  openingComplete: boolean;
  conversationComplete: boolean;
  closingComplete: boolean;
  gaps: Array<{ startSeconds: number; endSeconds: number; reason: string }>;
  recordingStartedAt: string | null;
  recordingEndedAt: string | null;
  intervals: Array<{ legId: string | null; profileId: string | null; role: string; startedAt: string; endedAt: string | null; audibleToCustomer: boolean; reason: string; channel: number | null; verified: boolean; identityVerified: boolean; sourceEventId: string }>;
};

function audible(session: SessionRow, leg: LegRow): boolean {
  if (!isOpenLeg(leg) || !leg.answered_at || session.ended_at || !["talking", "conference"].includes(session.state)) return false;
  if (leg.role === "consult") return false;
  if (leg.role === "supervisor") return readMeta(session).supervise?.[leg.profile_id ?? ""]?.mode === "barge";
  if (leg.role !== "customer" && !session.conference_id) return leg.profile_id ? leg.profile_id === session.answered_by_profile_id : leg.to_number === readMeta(session).answered_external;
  return true;
}

/** Provider/command observations, never voice/name guesses. Replays cannot create duplicate open intervals. */
export async function observeParticipants(admin: Admin, session: SessionRow, sourceEventId: string, at: string, providerConfirmed: boolean): Promise<void> {
  const recording = readMeta(session).recording;
  // A frozen silent call can never start recording later. Avoid recording-only
  // lookups and interval writes on its bridge/hold/hangup critical path. Keep
  // observing historical, active and uncertain capture so existing evidence
  // is closed correctly even after the live recording switch is turned off.
  if (recording && recording.policy.enabled === false && recording.recorders.length === 0 &&
    !recording.barrier && !recording.pendingAudio) return;
  const call = await admin.from("motorist_calls").select("id").eq("organization_id", session.organization_id).eq("session_id", session.id).maybeSingle();
  if (call.error) throw new Error("participant call lookup failed");
  if (!call.data) return;
  const [legsResult, intervalsResult] = await Promise.all([
    admin.from("motorist_call_legs").select("*").eq("organization_id", session.organization_id).eq("session_id", session.id),
    admin.from("motorist_call_participant_intervals").select("*").eq("organization_id", session.organization_id).eq("session_id", session.id).is("ended_at", null),
  ]);
  if (legsResult.error || intervalsResult.error) throw new Error("participant observations unavailable");
  const legs = legsResult.data ?? [];
  const open = intervalsResult.data ?? [];
  const epoch = readMeta(session).recording?.epoch ?? 0;
  const audibleLegs = legs.filter((leg) => audible(session, leg));
  const mapped = readMeta(session).recording?.policy.channelMappingVerified && audibleLegs.length === 2 && audibleLegs.some((leg) => leg.role === "customer") && audibleLegs.some((leg) => leg.role === "operator" && leg.profile_id);
  const channelFor = (leg: LegRow) => mapped ? leg.role === "customer" ? 0 : 1 : null;
  for (const interval of open) {
    const leg = legs.find((item) => item.id === interval.leg_id);
    const remains = leg && audible(session, leg) && interval.topology_epoch === epoch;
    if (!remains) {
      const end = new Date(Math.max(Date.parse(interval.started_at), Date.parse(at))).toISOString();
      const changed = await admin.from("motorist_call_participant_intervals").update({ ended_at: end }).eq("organization_id", session.organization_id).eq("id", interval.id).is("ended_at", null);
      if (changed.error) throw new Error("participant interval close failed");
    } else if (providerConfirmed && !interval.verified) {
      const activeRecorder = readMeta(session).recording?.recorders.find((recorder) => recorder.epoch === epoch);
      const canBackdate = activeRecorder?.startedAt && Date.parse(at) >= Date.parse(activeRecorder.startedAt);
      const changed = await admin.from("motorist_call_participant_intervals").update({ verified: true, channel: channelFor(leg),
        ...(canBackdate ? { started_at: new Date(Math.min(Date.parse(interval.started_at), Date.parse(at))).toISOString() } : {}) }).eq("organization_id", session.organization_id).eq("id", interval.id);
      if (changed.error) throw new Error("participant interval confirmation failed");
    }
  }
  for (const leg of audibleLegs) {
    if (open.some((interval) => interval.leg_id === leg.id && interval.topology_epoch === epoch)) continue;
    const inserted = await admin.from("motorist_call_participant_intervals").insert({ organization_id: session.organization_id, call_id: call.data.id, session_id: session.id,
      leg_id: leg.id, profile_id: leg.profile_id, role: leg.role, started_at: at, ended_at: null, audible_to_customer: true,
      reason: session.conference_id ? "customer_conference" : "customer_bridge", channel: channelFor(leg), verified: providerConfirmed || open.some((row) => row.leg_id === leg.id && row.verified && row.channel === channelFor(leg)), topology_epoch: epoch, source_event_id: sourceEventId });
    if (inserted.error && inserted.error.code !== "23505") throw new Error("participant interval insert failed");
  }
}

export function participantManifest(rows: Interval[], epoch: number, proof?: { session: SessionRow; startedAt: string; endedAt: string; recorderId: string }): ParticipantManifest {
  const ordered = [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.source_event_id.localeCompare(b.source_event_id));
  const recording = proof ? readMeta(proof.session).recording : undefined;
  const channelMappingVerified = recording?.policy?.channelMappingVerified === true && ordered.length > 0 && ordered.every((row) => row.verified && row.channel != null && (row.role === "customer" || row.role === "operator" && row.profile_id != null));
  const verified = channelMappingVerified;
  const recorder = recording?.recorders.find((item) => item.id === proof?.recorderId);
  const first = ordered[0]?.started_at;
  const last = ordered.reduce<string | null>((end, row) => row.ended_at && (!end || row.ended_at > end) ? row.ended_at : end, null);
  const openingComplete = Boolean(proof && verified && recording?.noticeCompletedAt && first && Date.parse(recording.noticeCompletedAt) <= Date.parse(proof.startedAt) && Date.parse(proof.startedAt) <= Date.parse(first));
  const closingComplete = Boolean(proof && verified && proof.session.ended_at && last && !ordered.some((row) => row.ended_at == null) && Date.parse(proof.endedAt) >= Date.parse(last));
  const conversationComplete = Boolean(proof && verified && recorder && !recorder.error && recording?.suppressionReason !== "objection" && ordered.every((row) => Date.parse(row.started_at) >= Date.parse(proof.startedAt) && row.ended_at != null && Date.parse(row.ended_at) <= Date.parse(proof.endedAt)));
  const gaps: ParticipantManifest["gaps"] = [];
  if (proof && (!verified || !conversationComplete)) gaps.push({ startSeconds: Math.max(0, (Date.parse(proof.startedAt) - Date.parse(proof.session.started_at)) / 1000), endSeconds: Math.max(0, (Date.parse(proof.endedAt) - Date.parse(proof.session.started_at)) / 1000), reason: verified ? "capture_incomplete" : "participant_identity_unverified" });
  return { version: 1, topologyEpoch: epoch, identitySource: "authenticated_leg_binding", coverage: verified ? "verified" : "unverified", channelMappingVerified, openingComplete, conversationComplete, closingComplete, gaps,
    recordingStartedAt: proof?.startedAt ?? null, recordingEndedAt: proof?.endedAt ?? null,
    intervals: ordered.map((row) => ({ legId: row.leg_id, profileId: row.profile_id, role: row.role, startedAt: row.started_at, endedAt: row.ended_at,
      audibleToCustomer: row.audible_to_customer, reason: row.reason, channel: row.channel, verified: row.verified, identityVerified: row.verified && row.channel != null && (row.role === "customer" || Boolean(row.profile_id)), sourceEventId: row.source_event_id })) };
}

export async function loadParticipantManifest(admin: Admin, session: SessionRow, proof?: { startedAt: string; endedAt: string; recorderId: string }, signal?: AbortSignal): Promise<ParticipantManifest> {
  const query = admin.from("motorist_call_participant_intervals").select("*").eq("organization_id", session.organization_id).eq("session_id", session.id).order("started_at", { ascending: true });
  const result = await (signal ? query.abortSignal(signal) : query);
  if (result.error) throw new Error("participant manifest unavailable");
  const recorder = readMeta(session).recording?.recorders.find((item) => item.id === proof?.recorderId);
  return participantManifest((result.data ?? []).filter((row) => !recorder || row.topology_epoch === recorder.epoch), recorder?.epoch ?? readMeta(session).recording?.epoch ?? 0, proof ? { session, ...proof } : undefined);
}
