import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { ConfigServiceError } from "./service-errors";

type RecordingRead = {
  kind: "audio" | "detail" | "own_review";
  callId: string;
  recordingId?: string;
  sourceRevision: number;
};

/** Confirm access before releasing content. The primary key coalesces Range
 * requests and detail polling across instances without an in-memory cache.
 * A row means access was authorized in that minute, not that playback finished.
 */
export async function auditRecordingRead(admin: SupabaseClient<Database>, actor: MotoristActor, read: RecordingRead): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const action = `telephony.recording.${read.kind}.read`;
  const entityId = read.recordingId ?? read.callId;
  const digest = createHash("sha256").update(JSON.stringify([
    "recording-read-v1", actor.organizationId, actor.profileId, action, entityId, read.sourceRevision, windowStart,
  ])).digest();
  // UUIDv8: application-defined, domain-separated SHA-256 identity.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex").slice(0, 32);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  try {
    const { error } = await admin.from("motorist_audit_log").upsert({
      id, organization_id: actor.organizationId, actor_profile_id: actor.profileId,
      action, entity_type: read.kind === "audio" ? "telephony_recording" : "telephony_call",
      entity_id: entityId, source: "recording_read_v1",
      after_payload: { callId: read.callId, sourceRevision: read.sourceRevision, windowStart, windowSeconds: 60 },
    }, { onConflict: "id", ignoreDuplicates: true }).abortSignal(AbortSignal.timeout(5_000));
    if (!error) return;
  } catch {
    // An ambiguous transport result cannot establish that access was audited.
  }
  throw new ConfigServiceError("Prístup k záznamu sa nepodarilo zaevidovať. Skúste to znova.", 503, "recording_read_audit_unavailable");
}
