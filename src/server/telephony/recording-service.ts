import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { ConfigServiceError } from "./config-service";
import { QUALITY_CRITERIA, QUALITY_RUBRIC_VERSION, type CallRecordingDetail, type CallQualityAnalysis, type QualityCriterion, type QualityDashboardResponse, type RecordingContentState } from "@/lib/telephony/recording-quality";
import { communicationMetrics, intervalSeconds, intersectIntervals, subtractIntervals, validateOperatorEvaluation, type ModelCriterion } from "@/lib/telephony/quality-scoring";
import { buildQualitySource, dateMilliseconds, jsonObject, loadRecordingSourceRows, sourceRestricted, type RecordingSourceRows } from "./recording-source";
import { summarizeSessionRecording } from "./state/recording-types";
import { readMeta } from "./state/types";
import { readRecordingPolicy } from "./recording-policy-service";

type Admin = SupabaseClient<Database>;
export function recordingError(message: string, status = 400, code = "recording_invalid"): never { throw new ConfigServiceError(message, status, code); }
export function recordingUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return recordingError("Neplatný identifikátor.");
  return value;
}
export function recordingRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2147483647) return recordingError("Chýba platná verzia záznamu.");
  return value;
}
function note(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) return recordingError("Doplň dôvod (najviac 2 000 znakov).");
  return value.trim();
}
export async function recordingPermissions(admin: Admin, actor: MotoristActor) {
  const manager = actor.role === "manager" || actor.role === "admin";
  if (manager) return { full: true, review: true, manager: true };
  if (actor.role !== "senior_dispatcher") return { full: false, review: false, manager: false };
  const { data, error } = await admin.from("motorist_call_recording_access").select("audio_read,quality_review")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).maybeSingle();
  if (error) return recordingError("Oprávnenie sa nepodarilo overiť.", 503, "recording_access_unavailable");
  return { full: data?.audio_read === true, review: data?.audio_read === true && data?.quality_review === true, manager: false };
}
export async function requireRecordingSource(admin: Admin, actor: MotoristActor, callId: string): Promise<RecordingSourceRows> {
  recordingUuid(callId);
  const rows = await loadRecordingSourceRows(admin, actor.organizationId, callId);
  if (!rows) return recordingError("Hovor sa nenašiel.", 404, "recording_not_found");
  return rows;
}
function assertAvailable(rows: RecordingSourceRows) {
  if (sourceRestricted(rows)) recordingError("Obsah už nie je dostupný.", 410, "recording_restricted");
}
function checkedRevision(rows: RecordingSourceRows, value: unknown) {
  const revision = recordingRevision(value);
  if (revision !== rows.call.recording_source_revision) recordingError("Záznam sa zmenil. Načítaj ho znova.", 409, "stale_recording_source");
  return revision;
}
function rpcError(error: { code?: string } | null) {
  if (error) recordingError(error.code === "40001" ? "Záznam medzitým zmenil kolega. Načítaj ho znova." : "Zmenu sa nepodarilo uložiť.", error.code === "40001" ? 409 : 503, error.code === "40001" ? "stale_recording_source" : "recording_write_failed");
}
function recordingState(r: RecordingSourceRows["recordings"][number]): RecordingContentState {
  if (r.deleted_at || r.status === "deleted") return "deleted";
  if (r.restricted_at || r.expires_at && Date.parse(r.expires_at) <= Date.now()) return "restricted";
  return r.status === "available" ? jsonObject(r.participant_manifest).timingVerified === true ? "ready" : "partial" : r.status === "failed" ? "failed" : "processing";
}

export async function getCallRecordingDetail(admin: Admin, actor: MotoristActor, callId: string): Promise<CallRecordingDetail> {
  const [rows, permissions] = await Promise.all([requireRecordingSource(admin, actor, callId), recordingPermissions(admin, actor)]);
  const call = rows.call;
  const session = call.session_id ? await admin.from("motorist_call_sessions").select("metadata,answered_by_profile_id")
    .eq("organization_id", actor.organizationId).eq("id", call.session_id).maybeSingle() : { data: null, error: null };
  if (session.error) return recordingError("Stav hovoru sa nepodarilo načítať.", 503);
  const owner = call.operator_id === actor.profileId || session.data?.answered_by_profile_id === actor.profileId
    || rows.intervals.some((i) => i.profile_id === actor.profileId && i.role === "operator");
  const live = summarizeSessionRecording(session.data?.metadata);
  const unavailable = sourceRestricted(rows);
  const deleted = rows.recordings.some((r) => r.deleted_at || r.status === "deleted");
  const full = permissions.full && !unavailable;
  const result: CallRecordingDetail = {
    callId, sourceRevision: call.recording_source_revision, access: full ? "full" : owner && !unavailable ? "own_review" : "restricted",
    state: unavailable ? deleted ? "deleted" : "restricted" : "pending", stateReason: unavailable ? "Obsah bol odstránený alebo uplynula jeho lehota uchovania." : null,
    liveState: owner || permissions.manager ? live.state : "off", suppressed: owner || permissions.manager ? live.suppressed : false,
    segments: [], gaps: [], transcript: { status: "pending", language: null, spans: [] }, analysis: null, metrics: null,
    capabilities: { canReview: full && permissions.review && Boolean(call.ended_at), canAppeal: owner && !unavailable,
      canCorrect: full && permissions.review && Boolean(call.ended_at), canDelete: full && permissions.manager && Boolean(call.ended_at) && rows.recordings.length > 0,
      canControl: Boolean(call.session_id && !call.ended_at && (owner || permissions.manager)), canRetry: false },
  };
  if (unavailable || !full && !owner) {
    if (!unavailable) { result.state = "restricted"; result.stateReason = "Na obsah tohto hovoru nemáš oprávnenie."; }
    result.transcript.status = result.state; result.analysisState = result.state; return result;
  }
  const source = buildQualitySource(rows);
  const [analyses, reviews, effective, jobs, policy] = await Promise.all([
    admin.from("motorist_call_analyses").select("*").eq("organization_id", actor.organizationId).eq("call_id", callId).is("deleted_at", null).order("created_at", { ascending: false }).limit(1),
    admin.from("motorist_call_quality_reviews").select("*").eq("organization_id", actor.organizationId).eq("call_id", callId).order("created_at", { ascending: false }),
    admin.from("motorist_call_effective_reviews").select("*").eq("organization_id", actor.organizationId).eq("call_id", callId),
    admin.from("motorist_call_processing_jobs").select("kind,state,paid_submit_started,input_revision").eq("organization_id", actor.organizationId).eq("call_id", callId),
    readRecordingPolicy(admin, actor.organizationId),
  ]);
  if (analyses.error || reviews.error || effective.error || jobs.error) return recordingError("Spracovanie záznamu sa nepodarilo načítať.", 503, "recording_detail_unavailable");
  const states = rows.recordings.map(recordingState);
  result.state = states.length === 0 ? (policy?.recording_enabled || live.state !== "off" ? "pending" : "disabled")
    : states.every((s) => s === "ready") ? source.gaps.length ? "partial" : "ready"
    : states.some((s) => s === "ready" || s === "partial") ? "partial" : states.some((s) => s === "failed") ? "failed" : "processing";
  if (rows.recordings.some((r) => r.status === "available" && jsonObject(r.participant_manifest).timingVerified !== true)) result.stateReason = "Úplnosť alebo globálne časovanie zvuku nie sú overené. Prehrávanie je dostupné; záznam sa nepoužije na číselné hodnotenie operátora.";
  if (session.data && readMeta(session.data).recording?.coverageUnconfirmed) {
    if (result.state === "ready") result.state = "partial";
    result.stateReason = "Rozhovor sa spojil pred potvrdením nahrávania. Časť zvuku môže chýbať; neskoršie obnovenie nahrávania ju nedoplní.";
  }
  const analysis = analyses.data?.[0];
  const analysisJobs = jobs.data?.filter((job) => job.kind === "analysis" && job.input_revision === call.recording_source_revision) ?? [];
  result.analysisState = analysis && analysis.input_revision === call.recording_source_revision && ["draft", "complete"].includes(analysis.status) ? "ready"
    : !policy?.analysis_enabled ? "disabled" : analysisJobs.some((job) => ["queued", "processing", "waiting"].includes(job.state)) ? "processing"
    : analysisJobs.some((job) => job.state === "failed" || job.state === "submission_unknown") ? "failed" : "pending";
  if (analysis && (!analysis.expires_at || Date.parse(analysis.expires_at) > Date.now()) && analysis.status !== "deleted") {
    const stored = jsonObject(analysis.result);
    if (Array.isArray(stored.operators) && typeof stored.summary === "string") {
      const content = structuredClone(stored) as unknown as Omit<CallQualityAnalysis, "id" | "status" | "model" | "createdAt">;
      const retained = (effective.data ?? []).filter((pointer) => pointer.source_revision === call.recording_source_revision && pointer.rubric_cohort_id === analysis.rubric_version)
        .map((pointer) => reviews.data?.find((review) => review.id === pointer.review_id && review.status === "approved"))
        .filter((review): review is NonNullable<typeof review> => Boolean(review));
      const olderIds = [...new Set(retained.filter((review) => !content.operators.some((operator) => operator.operatorId === review.operator_profile_id)).map((review) => review.analysis_id))];
      if (olderIds.length) {
        const older = await admin.from("motorist_call_analyses").select("id,result,expires_at").eq("organization_id", actor.organizationId).eq("call_id", callId)
          .eq("input_revision", call.recording_source_revision).is("deleted_at", null).in("id", olderIds);
        if (older.error) return recordingError("Schválenú kontrolu sa nepodarilo načítať.", 503);
        for (const row of older.data ?? []) {
          if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) continue;
          const previous = jsonObject(row.result).operators;
          if (!Array.isArray(previous)) continue;
          for (const raw of previous) {
            const previousOperator = raw as CallQualityAnalysis["operators"][number];
            if (retained.some((review) => review.analysis_id === row.id && review.operator_profile_id === previousOperator.operatorId)
              && !content.operators.some((operator) => operator.operatorId === previousOperator.operatorId)) content.operators.push({ ...previousOperator, analysisId: row.id });
          }
        }
      }
      result.analysis = { ...content, id: analysis.id, model: analysis.model, createdAt: analysis.created_at,
        status: analysis.input_revision !== call.recording_source_revision ? "stale" : analysis.status,
        operators: content.operators.map((operator) => {
          const pointer = effective.data?.find((r) => r.operator_profile_id === operator.operatorId && r.rubric_cohort_id === analysis.rubric_version && r.source_revision === call.recording_source_revision);
          const review = reviews.data?.find((r) => r.id === pointer?.review_id) ?? reviews.data?.find((r) => r.operator_profile_id === operator.operatorId && r.analysis_id === analysis.id);
          const connected = rows.intervals.filter((i) => i.profile_id === operator.operatorId && i.audible_to_customer && i.ended_at)
            .map((i) => ({ start: (Date.parse(i.started_at) - (dateMilliseconds(call.started_at) ?? 0)) / 1000, end: (Date.parse(i.ended_at!) - (dateMilliseconds(call.started_at) ?? 0)) / 1000 }));
          const active = subtractIntervals(connected, [...source.holds, ...source.gaps]);
          const speech = source.spans.filter((s) => s.operatorId === operator.operatorId && s.identityVerified).map((s) => ({ start: s.startSeconds, end: s.endSeconds }));
          const customer = source.spans.filter((s) => s.role === "customer" && s.identityVerified).map((s) => ({ start: s.startSeconds, end: s.endSeconds }));
          const seconds = intervalSeconds(intersectIntervals(speech, active));
          const total = seconds + intervalSeconds(intersectIntervals(customer, active));
          return { ...operator, analysisId: operator.analysisId ?? analysis.id, operatorName: rows.profiles.find((p) => p.id === operator.operatorId)?.display_name ?? operator.operatorName,
            speechSeconds: speech.length && active.length ? seconds : null, speechShare: total > 0 ? seconds / total : null, connectedSeconds: active.length ? intervalSeconds(connected) : null,
            review: review ? { id: review.id, status: review.source_revision === call.recording_source_revision && pointer?.review_id === review.id ? review.status : "stale" as const,
              reviewerName: rows.profiles.find((p) => p.id === review.reviewer_profile_id)?.display_name ?? "Vedúci",
              reviewedAt: review.created_at, note: review.note, score: review.score, coverage: review.coverage, criteria: review.criteria as unknown as QualityCriterion[] } : null };
        }),
      };
    }
  }
  if (!full) {
    const approved = result.analysis?.operators.filter((o) => o.operatorId === actor.profileId && o.review?.status === "approved") ?? [];
    result.analysis = approved.length && result.analysis ? { ...result.analysis, topic: "", reason: null, summary: "", outcome: "unknown", facts: [], actions: [], nextSteps: [], warnings: [],
      operators: approved.map((o) => ({ ...o, criteria: [], coaching: [], score: o.review!.score, coverage: o.review!.coverage,
        eligibilityReasons: [], speechSeconds: undefined, speechShare: undefined, connectedSeconds: undefined,
        review: { ...o.review!, criteria: o.review!.criteria.map((c) => ({ ...c, evidence: [] })) } })) } : null;
    result.state = approved.length ? "ready" : "pending";
    result.transcript.status = "disabled";
    return result;
  }
  result.metrics = communicationMetrics(source);
  result.gaps = source.gaps.map((g) => ({ startSeconds: g.start, endSeconds: g.end, reason: "Nezachytený úsek rozhovoru" }));
  result.segments = rows.recordings.map((r, index) => ({ id: r.id, index,
    startSeconds: Math.max(0, ((dateMilliseconds(r.started_at) ?? (dateMilliseconds(call.started_at) ?? 0)) - (dateMilliseconds(call.started_at) ?? 0)) / 1000),
    durationSeconds: typeof jsonObject(r.participant_manifest).audioDurationSeconds === "number" ? Math.max(0, Number(jsonObject(r.participant_manifest).audioDurationSeconds))
      : Math.max(0, r.duration_seconds ?? ((dateMilliseconds(r.ended_at) ?? 0) - (dateMilliseconds(r.started_at) ?? 0)) / 1000),
    state: recordingState(r), channels: jsonObject(r.participant_manifest).channelMappingVerified === true ? 2 : null,
    canPlay: r.status === "available" && Boolean(r.storage_path && r.storage_bucket), error: r.status === "failed" ? "Spracovanie zvuku zlyhalo." : null }));
  const transcripts = rows.transcripts;
  result.transcript = { language: source.language, spans: source.spans,
    status: transcripts.length === 0 ? policy?.transcription_enabled ? "pending" : "disabled"
      : transcripts.every((t) => t.status === "complete") && transcripts.length >= rows.recordings.length ? "ready"
      : source.spans.length ? "partial" : transcripts.some((t) => t.status === "failed") ? "failed" : "processing" };
  result.capabilities.canRetry = permissions.manager && Boolean(call.ended_at) && Boolean(jobs.data?.some((j) => j.state === "failed"))
    && !jobs.data?.some((j) => j.state === "submission_unknown" || j.paid_submit_started && ["queued", "processing", "waiting"].includes(j.state));
  return result;
}

export function validateReviewCriteria(value: unknown, rows: RecordingSourceRows, operatorId: string) {
  if (!Array.isArray(value) || value.length !== QUALITY_CRITERIA.length) return recordingError("Hodnotenie musí obsahovať všetkých sedem kritérií.");
  const source = buildQualitySource(rows);
  const criteria: ModelCriterion[] = value.map((raw) => {
    const c = jsonObject(raw);
    if (!QUALITY_CRITERIA.some((d) => d.id === c.id) || !["met", "partial", "not_met", "not_applicable", "unknown"].includes(String(c.verdict))
      || typeof c.reason !== "string" || c.reason.length > 2000 || !Array.isArray(c.evidence) || c.evidence.length > 12
      || ![null, "opening", "conversation", "closing"].includes(c.absenceWindow as null)
      || ![c.applicabilityReason, c.uncertaintyReason].every((v) => v === null || typeof v === "string" && v.length <= 2000)) return recordingError("Neplatné kritérium hodnotenia.");
    const ids = c.evidence.map((rawEvidence) => {
      const e = jsonObject(rawEvidence), span = source.spans.find((s) => s.id === e.id);
      if (!span || e.segmentId !== span.segmentId || e.text !== span.text || e.startSeconds !== span.startSeconds || e.endSeconds !== span.endSeconds || e.operatorId !== span.operatorId) return recordingError("Dôkaz sa zmenil. Načítaj prepis znova.", 409, "stale_recording_evidence");
      return span.id;
    });
    return { id: c.id, verdict: c.verdict, reason: c.reason, spanIds: ids, absenceWindow: c.absenceWindow, applicabilityReason: c.applicabilityReason, uncertaintyReason: c.uncertaintyReason } as ModelCriterion;
  });
  try { return validateOperatorEvaluation({ operatorId, criteria, coaching: [] }, source); }
  catch { return recordingError("Hodnotenie obsahuje neplatného účastníka alebo kritériá."); }
}

export async function approveCallQuality(admin: Admin, actor: MotoristActor, callId: string, body: Record<string, unknown>) {
  const [rows, permissions] = await Promise.all([requireRecordingSource(admin, actor, callId), recordingPermissions(admin, actor)]);
  if (!permissions.review) recordingError("Na kontrolu hodnotenia nemáš oprávnenie.", 403);
  assertAvailable(rows);
  const revision = checkedRevision(rows, body.sourceRevision), analysisId = recordingUuid(body.analysisId), operatorId = recordingUuid(body.operatorId);
  const expected = body.expectedReviewId === null ? null : recordingUuid(body.expectedReviewId);
  const analysis = await admin.from("motorist_call_analyses").select("result,rubric_version").eq("organization_id", actor.organizationId).eq("call_id", callId).eq("id", analysisId).maybeSingle();
  const candidates = jsonObject(analysis.data?.result).operators;
  if (analysis.error || !analysis.data || !Array.isArray(candidates) || !candidates.some((o) => jsonObject(o).operatorId === operatorId)) recordingError("Hodnotenie sa nenašlo.", 404);
  if (analysis.data.rubric_version !== QUALITY_RUBRIC_VERSION) recordingError("Táto verzia hodnotenia vyžaduje pôvodnú rubriku.", 409);
  const evaluation = validateReviewCriteria(body.criteria, rows, operatorId);
  const { error } = await admin.rpc("motorist_call_quality_approve", { p_organization_id: actor.organizationId, p_call_id: callId,
    p_analysis_id: analysisId, p_operator_profile_id: operatorId, p_rubric_cohort_id: QUALITY_RUBRIC_VERSION, p_source_revision: revision,
    p_expected_effective_review_id: expected, p_criteria: evaluation.criteria as unknown as Json, p_score: evaluation.score,
    p_coverage: evaluation.coverage, p_reviewer_profile_id: actor.profileId, p_note: note(body.note) });
  rpcError(error);
  return getCallRecordingDetail(admin, actor, callId);
}

export async function appealCallQuality(admin: Admin, actor: MotoristActor, callId: string, body: Record<string, unknown>) {
  const rows = await requireRecordingSource(admin, actor, callId); assertAvailable(rows);
  const reviewId = body.reviewId === null ? null : recordingUuid(body.reviewId);
  if (!reviewId || ![rows.call.operator_id, ...rows.intervals.map((i) => i.profile_id)].includes(actor.profileId)) recordingError("Možno požiadať len o kontrolu vlastného schváleného hodnotenia.", 403);
  const review = await admin.from("motorist_call_quality_reviews").select("id").eq("organization_id", actor.organizationId).eq("call_id", callId)
    .eq("operator_profile_id", actor.profileId).eq("id", reviewId).eq("status", "approved").eq("source_revision", rows.call.recording_source_revision).maybeSingle();
  if (review.error || !review.data) recordingError("Hodnotenie už nie je aktuálne.", 409);
  const { error } = await admin.from("motorist_call_review_requests").insert({ organization_id: actor.organizationId, call_id: callId,
    operator_profile_id: actor.profileId, requester_profile_id: actor.profileId, review_id: reviewId, note: note(body.note) });
  rpcError(error);
  return getCallRecordingDetail(admin, actor, callId);
}

export async function correctCallTranscript(admin: Admin, actor: MotoristActor, callId: string, body: Record<string, unknown>) {
  const [rows, permissions] = await Promise.all([requireRecordingSource(admin, actor, callId), recordingPermissions(admin, actor)]);
  if (!permissions.review) recordingError("Na opravu prepisu nemáš oprávnenie.", 403);
  assertAvailable(rows); const revision = checkedRevision(rows, body.sourceRevision), transcriptId = recordingUuid(body.transcriptId);
  const transcript = rows.transcripts.find((t) => t.id === transcriptId && t.status === "complete");
  const source = buildQualitySource(rows).spans.filter((s) => s.transcriptId === transcriptId);
  if (!rows.call.ended_at || !transcript || source.length === 0 || !Array.isArray(body.segments) || body.segments.length !== source.length) recordingError("Prepis zatiaľ nemožno upraviť.", 409);
  const segments = body.segments.map((raw, index) => {
    const span = jsonObject(raw), original = source[index];
    const immutable = ["id", "transcriptId", "segmentId", "startSeconds", "endSeconds", "speakerLabel", "role", "operatorId", "identityVerified"] as const;
    if (immutable.some((key) => span[key] !== original[key]) || typeof span.text !== "string" || span.text.length > 12000 || !span.text.trim()) recordingError("Možno opraviť iba text; časy a účastníci musia zostať zachované.");
    return { ...original, text: span.text.trim() };
  });
  const text = segments.map((s) => s.text).join(" ");
  if (text.length > 600000 || typeof body.text !== "string" || body.text.trim().replace(/\s+/g, " ") !== text.replace(/\s+/g, " ")) recordingError("Text nesúhlasí s úsekmi prepisu.");
  const { error } = await admin.rpc("motorist_call_transcript_correct", { p_organization_id: actor.organizationId, p_transcript_id: transcriptId,
    p_expected_source_revision: revision, p_transcript_text: text, p_speaker_segments: segments as unknown as Json, p_edited_by: actor.profileId, p_reason: note(body.reason) });
  rpcError(error); return getCallRecordingDetail(admin, actor, callId);
}

export async function deleteOrRetryRecording(admin: Admin, actor: MotoristActor, callId: string, body: Record<string, unknown>, action: "delete" | "retry") {
  if (actor.role !== "manager" && actor.role !== "admin") recordingError("Na túto zmenu nemáš oprávnenie.", 403);
  const rows = await requireRecordingSource(admin, actor, callId), revision = checkedRevision(rows, body.sourceRevision);
  if (action === "retry") assertAvailable(rows);
  const args = { p_organization_id: actor.organizationId, p_call_id: callId, p_source_revision: revision, p_actor_id: actor.profileId };
  const result = action === "delete" ? await admin.rpc("motorist_recording_delete_call", { ...args, p_reason: note(body.reason) }) : await admin.rpc("motorist_recording_retry_call", args);
  rpcError(result.error); return getCallRecordingDetail(admin, actor, callId);
}

export async function getQualityDashboard(admin: Admin, actor: MotoristActor, params: URLSearchParams): Promise<QualityDashboardResponse> {
  if (!(await recordingPermissions(admin, actor)).review) recordingError("Na prehľad hodnotení nemáš oprávnenie.", 403);
  const to = params.get("to") ?? new Date().toISOString(), from = params.get("from") ?? new Date(Date.now() - 30 * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000) recordingError("Vyber obdobie najviac 366 dní.");
  const page = Number(params.get("page") ?? 1), pageSize = Number(params.get("pageSize") ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) recordingError("Neplatná strana prehľadu.");
  const status = params.get("status") || null, language = params.get("language") || null, rubric = params.get("rubricVersion") || QUALITY_RUBRIC_VERSION;
  if (status && !["draft", "approved", "stale", "unscorable"].includes(status) || language && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language) || rubric !== QUALITY_RUBRIC_VERSION) recordingError("Neplatný filter prehľadu.");
  const { data, error } = await admin.rpc("motorist_call_quality_dashboard", { p_organization_id: actor.organizationId, p_from: from, p_to: to,
    p_operator_id: params.get("operatorId") ? recordingUuid(params.get("operatorId")) : null, p_language: language, p_status: status,
    p_page: page, p_page_size: pageSize, p_rubric_version: rubric });
  if (error || !data) recordingError("Prehľad hodnotení sa nepodarilo načítať.", 503);
  return data as unknown as QualityDashboardResponse;
}
