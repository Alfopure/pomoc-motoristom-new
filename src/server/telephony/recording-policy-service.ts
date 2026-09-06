import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import type { RecordingPolicyDocument, RecordingPolicyResponse } from "@/lib/telephony/recording-quality";
import { ConfigServiceError } from "./config-service";
import type { RecordingRoutingPolicy } from "./state/recording-types";

type Admin = SupabaseClient<Database>;
type PolicyRow = Database["public"]["Tables"]["motorist_call_recording_policies"]["Row"];

export const DEFAULT_RECORDING_POLICY: RecordingPolicyDocument = {
  revision: 0, recordingEnabled: false, transcriptionEnabled: false, analysisEnabled: false, qualityEnabled: false,
  inboundEnabled: true, outboundEnabled: true, audioRetentionDays: 30, transcriptRetentionDays: 30, reviewRetentionDays: 90,
  maxRecordingsPerHour: 10, maxRecordingBytes: 134217728, maxSegmentSeconds: 1800,
  controllerName: "", contactEmail: "", privacyNoticeUrl: "", serviceLegalBasis: "", qualityLegalBasis: "", approvedAt: null,
};

export function recordingPolicyDocument(row: PolicyRow | null): RecordingPolicyDocument {
  if (!row) return { ...DEFAULT_RECORDING_POLICY };
  return {
    revision: row.revision, recordingEnabled: row.recording_enabled, transcriptionEnabled: row.transcription_enabled,
    analysisEnabled: row.analysis_enabled, qualityEnabled: row.quality_enabled, inboundEnabled: row.inbound_enabled,
    outboundEnabled: row.outbound_enabled, audioRetentionDays: row.audio_retention_days,
    transcriptRetentionDays: row.transcript_retention_days, reviewRetentionDays: row.review_retention_days,
    maxRecordingsPerHour: row.max_recordings_per_hour, maxRecordingBytes: row.max_recording_bytes,
    maxSegmentSeconds: row.max_segment_seconds, controllerName: row.controller_name ?? "", contactEmail: row.contact_email ?? "",
    privacyNoticeUrl: row.privacy_notice_url ?? "", serviceLegalBasis: row.service_legal_basis ?? "",
    qualityLegalBasis: row.quality_legal_basis ?? "", approvedAt: row.approved_at,
  };
}
export async function readRecordingPolicy(admin: Admin, organizationId: string): Promise<PolicyRow | null> {
  const { data, error } = await admin.from("motorist_call_recording_policies").select("*").eq("organization_id", organizationId).maybeSingle();
  if (error) {
    // Old deployments remain operable while additive migrations are staged.
    if (error.code === "42P01" || error.code === "PGRST205") return null;
    throw new ConfigServiceError("Nastavenia nahrávania sa nepodarilo načítať.", 503, "recording_policy_unavailable");
  }
  return data;
}

export function recordingReadiness(policy: RecordingPolicyDocument, env: NodeJS.ProcessEnv = process.env): RecordingPolicyResponse["readiness"] {
  const reasons: string[] = [];
  const processing = env.RECORDING_PROCESSING_ENABLED === "true";
  const recording = processing && env.TELNYX_RECORDING_ENABLED === "true" && env.TELNYX_RECORDING_CONTRACT_VERIFIED === "true";
  const transcription = processing && env.TRANSCRIPTS_ENABLED === "true" && Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_SCRIBE_WEBHOOK_ID && env.ELEVENLABS_SCRIBE_WEBHOOK_SECRET);
  const analysis = processing && env.AI_TRANSCRIPT_ENABLED === "true" && Boolean(env.OPENAI_API_KEY) && ["gpt-5.6-luna", "gpt-5.6-terra"].includes(env.OPENAI_CALL_ANALYSIS_MODEL?.trim() || "gpt-5.6-luna");
  if (!recording) reasons.push("Nahrávanie čaká na dokončenie a overenie telefonického zapojenia.");
  if (!transcription) reasons.push("Prepis čaká na zapojenie služby a overeného spätného oznámenia.");
  if (!analysis) reasons.push("Automatická analýza ešte nie je prevádzkovo zapnutá.");
  if (!policy.approvedAt) reasons.push("Pred zapnutím potvrď účely, informovanie a lehoty uchovania.");
  return { recording, transcription, analysis, reasons };
}
export async function getRecordingPolicy(admin: Admin, actor: MotoristActor): Promise<RecordingPolicyResponse> {
  const policy = recordingPolicyDocument(await readRecordingPolicy(admin, actor.organizationId));
  return { policy, canEdit: actor.role === "admin" || actor.role === "manager", readiness: recordingReadiness(policy) };
}
export async function resolveSessionRecordingPolicy(admin: Admin, organizationId: string): Promise<RecordingRoutingPolicy> {
  const disabled: RecordingRoutingPolicy = { enabled: false, inbound: false, outbound: false, policyId: null, noticeVersion: "recording-notice-v2", maxSegmentSeconds: 1800, reason: "recording_disabled" };
  if (process.env.TELNYX_RECORDING_ENABLED !== "true" || process.env.TELNYX_RECORDING_CONTRACT_VERIFIED !== "true" || process.env.RECORDING_PROCESSING_ENABLED !== "true") return disabled;
  try {
    const policy = recordingPolicyDocument(await readRecordingPolicy(admin, organizationId));
    return { enabled: Boolean(policy.recordingEnabled && policy.approvedAt), inbound: policy.inboundEnabled, outbound: policy.outboundEnabled,
      qualityEnabled: Boolean(policy.qualityEnabled && policy.approvedAt),
      conferenceVerified: process.env.TELNYX_RECORDING_CONFERENCE_VERIFIED === "true", transferVerified: process.env.TELNYX_RECORDING_TRANSFER_VERIFIED === "true",
      channelMappingVerified: process.env.TELNYX_RECORDING_CHANNELS_VERIFIED === "true",
      policyId: `${organizationId}:${policy.revision}`, noticeVersion: "recording-notice-v2", maxSegmentSeconds: policy.maxSegmentSeconds,
      ...(policy.recordingEnabled && policy.approvedAt ? {} : { reason: "recording_policy_not_approved" }) };
  } catch {
    // Recording configuration must never block answering the caller.
    return { ...disabled, reason: "recording_policy_unavailable" };
  }
}

const booleanFields = ["recordingEnabled", "transcriptionEnabled", "analysisEnabled", "qualityEnabled", "inboundEnabled", "outboundEnabled"] as const;
const textFields = ["controllerName", "contactEmail", "privacyNoticeUrl", "serviceLegalBasis", "qualityLegalBasis"] as const;
export function parseRecordingPolicy(value: unknown): RecordingPolicyDocument {
  const invalid = (): never => { throw new ConfigServiceError("Nastavenie nahrávania obsahuje neplatné údaje.", 400, "recording_policy_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !(key in DEFAULT_RECORDING_POLICY))) return invalid();
  const result = { ...DEFAULT_RECORDING_POLICY };
  for (const field of booleanFields) { if (typeof row[field] !== "boolean") return invalid(); result[field] = row[field]; }
  for (const field of textFields) { if (typeof row[field] !== "string" || row[field].length > 2000) return invalid(); result[field] = row[field].trim(); }
  const bounds = { revision: [0, 2147483647], audioRetentionDays: [1, 365], transcriptRetentionDays: [1, 365], reviewRetentionDays: [1, 365], maxRecordingsPerHour: [1, 10], maxRecordingBytes: [1024, 134217728], maxSegmentSeconds: [1, 1800] } as const;
  for (const [name, range] of Object.entries(bounds)) {
    const field = name as keyof typeof bounds, n = row[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < range[0] || n > range[1]) return invalid();
    result[field] = n;
  }
  if (result.transcriptionEnabled && !result.recordingEnabled || result.analysisEnabled && !result.transcriptionEnabled || result.qualityEnabled && !result.analysisEnabled) return invalid();
  if (result.privacyNoticeUrl) {
    try { const u = new URL(result.privacyNoticeUrl); if (u.protocol !== "https:" || u.username || u.password || u.hash) return invalid(); } catch { return invalid(); }
  }
  if (result.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contactEmail)) return invalid();
  if (result.recordingEnabled && (!result.controllerName || !result.contactEmail || !result.privacyNoticeUrl || !result.serviceLegalBasis)) return invalid();
  if (result.qualityEnabled && !result.qualityLegalBasis) return invalid();
  return result;
}

export async function saveRecordingPolicy(admin: Admin, actor: MotoristActor, body: Record<string, unknown>): Promise<RecordingPolicyResponse> {
  if (actor.role !== "admin" && actor.role !== "manager") throw new ConfigServiceError("Na úpravu nemáš oprávnenie.", 403, "recording_policy_forbidden");
  const policy = parseRecordingPolicy(body.policy);
  if (typeof body.approvePolicy !== "boolean") throw new ConfigServiceError("Potvrď nastavenie spracovania.", 400, "recording_policy_confirmation_required");
  const current = recordingPolicyDocument(await readRecordingPolicy(admin, actor.organizationId));
  const sameScope = textFields.every((field) => current[field] === policy[field])
    && current.audioRetentionDays === policy.audioRetentionDays && current.transcriptRetentionDays === policy.transcriptRetentionDays
    && current.reviewRetentionDays === policy.reviewRetentionDays && !booleanFields.some((field) => policy[field] && !current[field]);
  const approved = body.approvePolicy || Boolean(current.approvedAt && sameScope);
  if (policy.recordingEnabled && !approved) throw new ConfigServiceError("Zmenené účely alebo lehoty vyžadujú nové potvrdenie.", 422, "recording_policy_confirmation_required");
  const ready = recordingReadiness(policy);
  if (policy.recordingEnabled && !ready.recording || policy.transcriptionEnabled && !ready.transcription || policy.analysisEnabled && !ready.analysis) {
    throw new ConfigServiceError("Zapojenie ešte neprešlo prevádzkovým overením. Nastavenia môžeš uložiť s vypnutým spracovaním.", 409, "recording_not_ready");
  }
  const { error } = await admin.rpc("motorist_recording_policy_save", {
    p_organization_id: actor.organizationId, p_expected_revision: policy.revision,
    p_actor_id: actor.profileId, p_approved: approved, p_policy: policy as unknown as Json,
  });
  if (error) throw new ConfigServiceError(error.code === "40001" ? "Nastavenia medzitým zmenil kolega. Načítaj ich znova." : "Nastavenia sa nepodarilo uložiť.", error.code === "40001" ? 409 : 503, error.code === "40001" ? "stale_recording_policy" : "recording_policy_save_failed");
  return getRecordingPolicy(admin, actor);
}
