import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createViptelClient,
  serializeViptelError,
  type ViptelCdrRecord,
  type ViptelClient,
} from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type RecordingRow = Tables["motorist_call_recordings"]["Row"];
type CallRow = Tables["motorist_calls"]["Row"];

export const RECORDINGS_BUCKET = "motorist-call-recordings";

const MAX_DOWNLOADS_PER_RUN = 25;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RETRIES = 3;

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";
const DEFAULT_RETENTION_DAYS = 90;
const DISCOVERY_LIMIT = 200;
const DISCOVERY_WINDOW_HOURS = 48;

export type RecordingsSyncOptions = {
  dryRun?: boolean;
  dateFrom?: string;
  maxDownloads?: number;
};

export type RecordingsSyncSummary = {
  status: "ok" | "failed";
  organizationId: string | null;
  cdrWithRecording: number;
  discovered: number;
  processed: number;
  failed: number;
  pendingLeft: number;
  errors: string[];
};

export class RecordingsSyncError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "RecordingsSyncError";
  }
}

export async function syncRecordings(options: RecordingsSyncOptions = {}): Promise<RecordingsSyncSummary> {
  const supabase = createSupabaseAdminClient();
  const viptel = createViptelClient();
  const organization = await resolveOrganization(supabase);

  const summary: RecordingsSyncSummary = {
    status: "ok",
    organizationId: organization.id,
    cdrWithRecording: 0,
    discovered: 0,
    processed: 0,
    failed: 0,
    pendingLeft: 0,
    errors: [],
  };

  try {
    if (!options.dryRun) {
      await ensureBucket(supabase);
    }

    const cdrRecords = await viptel.listCdrRecordings({
      dateFrom: options.dateFrom ?? defaultDateFrom(),
      limit: DISCOVERY_LIMIT,
    });
    const withRecording = cdrRecords.filter((record) => record.hasRecording && record.cdrId);
    summary.cdrWithRecording = withRecording.length;

    if (!options.dryRun) {
      summary.discovered = await discoverNewRecordings(supabase, organization.id, withRecording);
      const processed = await processPendingRecordings(supabase, viptel, organization.id, options.maxDownloads ?? MAX_DOWNLOADS_PER_RUN);
      summary.processed = processed.processed;
      summary.failed = processed.failed;
      summary.errors.push(...processed.errors);
      summary.pendingLeft = await countPending(supabase, organization.id);
    }
  } catch (error) {
    summary.status = "failed";
    summary.errors.push(serializeViptelError(error).message);
  }

  if (!options.dryRun) {
    await writeSummaryEvent(supabase, organization.id, summary);
  }

  return summary;
}

// Prod migrations run manually (docs/deployment-vercel.md), so the runtime creates the
// private bucket itself; the SQL migration adds the defense-in-depth select policy.
async function ensureBucket(supabase: AdminClient) {
  const existing = await supabase.storage.getBucket(RECORDINGS_BUCKET);

  if (existing.data) {
    return;
  }

  const created = await supabase.storage.createBucket(RECORDINGS_BUCKET, {
    public: false,
    fileSizeLimit: 31_457_280,
    allowedMimeTypes: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "application/octet-stream"],
  });

  if (created.error && !/already exists/i.test(created.error.message)) {
    throw new RecordingsSyncError(`Bucket setup failed: ${created.error.message}`);
  }
}

/** @internal exported for unit tests */
export async function discoverNewRecordings(supabase: AdminClient, organizationId: string, records: ViptelCdrRecord[]) {
  if (records.length === 0) {
    return 0;
  }

  const cdrIds = records.map((record) => String(record.cdrId));
  const existing = await supabase
    .from("motorist_call_recordings")
    .select("provider_recording_id")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .in("provider_recording_id", cdrIds);
  throwOnError(existing.error);

  const known = new Set((existing.data ?? []).map((row) => row.provider_recording_id));
  const fresh = records.filter((record) => !known.has(String(record.cdrId)));
  let inserted = 0;

  for (const record of fresh) {
    const callId = await upsertCallForCdr(supabase, organizationId, record);
    const insert = await supabase.from("motorist_call_recordings").insert({
      organization_id: organizationId,
      provider: "viptel",
      provider_recording_id: String(record.cdrId),
      cdr_id: String(record.cdrId),
      viptel_unique_id: record.viptelUniqueId ?? null,
      call_id: callId,
      recording_file: record.recordingFile ?? null,
      status: "pending",
      duration_seconds: record.durationSeconds ?? null,
      retention_until: retentionUntil(),
      metadata: { cdr: record.raw as Json, retry_count: 0 } as Json,
    });

    // A concurrent run may have inserted the same provider_recording_id; the partial
    // unique index rejects the duplicate and we simply move on.
    if (insert.error) {
      if (!isUniqueViolation(insert.error)) {
        throwOnError(insert.error);
      }
    } else {
      inserted += 1;
    }
  }

  return inserted;
}

async function upsertCallForCdr(supabase: AdminClient, organizationId: string, record: ViptelCdrRecord): Promise<string | null> {
  if (!record.viptelUniqueId) {
    return null;
  }

  const found = await supabase
    .from("motorist_calls")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("viptel_unique_id", record.viptelUniqueId)
    .maybeSingle();
  throwOnError(found.error);

  if (found.data) {
    return found.data.id;
  }

  const created = await supabase
    .from("motorist_calls")
    .insert({
      organization_id: organizationId,
      provider: "viptel",
      viptel_unique_id: record.viptelUniqueId,
      direction: record.direction ?? "inbound",
      status: "ended",
      caller_number: record.callerNumber ?? null,
      called_number: record.calledNumber ?? null,
      started_at: record.startedAt ?? null,
      duration_seconds: record.durationSeconds ?? null,
      recording_status: "pending",
      recording_file: record.recordingFile ?? null,
      raw_payload: record.raw as Json,
    })
    .select("id")
    .single();

  if (created.error) {
    // The live event bridge may have created the call in the meantime.
    if (isUniqueViolation(created.error)) {
      const retry = await supabase
        .from("motorist_calls")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("provider", "viptel")
        .eq("viptel_unique_id", record.viptelUniqueId)
        .maybeSingle();
      throwOnError(retry.error);
      return retry.data?.id ?? null;
    }

    throwOnError(created.error);
  }

  return created.data?.id ?? null;
}

async function processPendingRecordings(supabase: AdminClient, viptel: ViptelClient, organizationId: string, maxDownloads: number) {
  const result = { processed: 0, failed: 0, errors: [] as string[] };
  const pending = await supabase
    .from("motorist_call_recordings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(maxDownloads, MAX_DOWNLOADS_PER_RUN)));
  throwOnError(pending.error);

  for (const row of pending.data ?? []) {
    const claimed = await claimRecording(supabase, row);

    if (!claimed) {
      continue;
    }

    try {
      await downloadAndStore(supabase, viptel, organizationId, row);
      result.processed += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${row.provider_recording_id}: ${message}`);
      await markFailure(supabase, row, message);
    }
  }

  return result;
}

/** @internal exported for unit tests */
export async function claimRecording(supabase: AdminClient, row: RecordingRow) {
  const metadata = jsonRecord(row.metadata);
  const claimedAt = typeof metadata.claimed_at === "string" ? Date.parse(metadata.claimed_at) : NaN;

  // Another run's claim is honoured for 15 minutes; a stale claim is reclaimed.
  if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 15 * 60 * 1000) {
    return false;
  }

  const update = await supabase
    .from("motorist_call_recordings")
    .update({ metadata: { ...metadata, claimed_at: new Date().toISOString() } as Json })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  throwOnError(update.error);

  return (update.data ?? []).length > 0;
}

async function downloadAndStore(supabase: AdminClient, viptel: ViptelClient, organizationId: string, row: RecordingRow) {
  const downloadRef = row.cdr_id ?? row.provider_recording_id;

  if (!downloadRef) {
    throw new RecordingsSyncError("Recording row has no download reference.");
  }

  const recording = await viptel.downloadRecording(downloadRef);

  if (recording.sizeBytes > MAX_FILE_BYTES) {
    throw new RecordingsSyncError(`Recording exceeds the ${MAX_FILE_BYTES} byte cap (${recording.sizeBytes}).`);
  }

  const bytes = Buffer.from(recording.data);
  const storagePath = storagePathFor(organizationId, row);
  const mimeType = resolveMimeType(recording.contentType, row.recording_file);
  const upload = await supabase.storage.from(RECORDINGS_BUCKET).upload(storagePath, bytes, {
    contentType: mimeType,
    upsert: true,
  });

  if (upload.error) {
    throw new RecordingsSyncError(`Storage upload failed: ${upload.error.message}`);
  }

  const metadata = jsonRecord(row.metadata);
  delete metadata.claimed_at;
  delete metadata.last_error;

  const update = await supabase
    .from("motorist_call_recordings")
    .update({
      status: "available",
      storage_bucket: RECORDINGS_BUCKET,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: recording.sizeBytes,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      fetched_at: new Date().toISOString(),
      metadata: metadata as Json,
    })
    .eq("id", row.id);
  throwOnError(update.error);

  if (row.call_id) {
    const call = await supabase
      .from("motorist_calls")
      .update({ recording_status: "available", recording_file: row.recording_file } satisfies Partial<CallRow>)
      .eq("id", row.call_id);
    throwOnError(call.error);
  }
}

async function markFailure(supabase: AdminClient, row: RecordingRow, message: string) {
  const metadata = jsonRecord(row.metadata);
  const retryCount = (typeof metadata.retry_count === "number" ? metadata.retry_count : 0) + 1;
  delete metadata.claimed_at;
  const exhausted = retryCount >= MAX_RETRIES;

  const update = await supabase
    .from("motorist_call_recordings")
    .update({
      status: exhausted ? "failed" : "pending",
      metadata: { ...metadata, retry_count: retryCount, last_error: message.slice(0, 500) } as Json,
    })
    .eq("id", row.id);
  throwOnError(update.error);

  if (exhausted && row.call_id) {
    const call = await supabase.from("motorist_calls").update({ recording_status: "failed" }).eq("id", row.call_id);
    throwOnError(call.error);
  }
}

async function countPending(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_call_recordings")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "pending");
  throwOnError(result.error);
  return result.count ?? 0;
}

async function writeSummaryEvent(supabase: AdminClient, organizationId: string, summary: RecordingsSyncSummary) {
  const result = await supabase.from("motorist_integration_raw_events").insert({
    organization_id: organizationId,
    provider: "viptel",
    channel: "internal",
    direction: "inbound",
    event_type: "recordings.sync_summary",
    status_code: summary.status === "ok" ? 200 : 500,
    payload: summary as unknown as Json,
  });

  if (result.error) {
    summary.errors.push(`summary event: ${result.error.message}`);
  }
}

/** @internal exported for the CDR probe QA helper (org-scoped storedRecording check) */
export async function resolveOrganization(supabase: AdminClient) {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("id, active").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("id, active")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG)
        .maybeSingle();
  const result = await query;
  throwOnError(result.error);

  if (!result.data?.active) {
    throw new RecordingsSyncError("Active organization was not found.", 404);
  }

  return result.data;
}

export function storagePathFor(organizationId: string, row: Pick<RecordingRow, "call_id" | "provider_recording_id" | "recording_file">) {
  const extension = row.recording_file?.match(/\.(mp3|wav|ogg)$/i)?.[0]?.toLowerCase() ?? ".mp3";
  return `${organizationId}/${row.call_id ?? "call-unlinked"}/${row.provider_recording_id}${extension}`;
}

export function resolveMimeType(contentType: string | null, recordingFile: string | null) {
  if (contentType && contentType !== "application/octet-stream") {
    return contentType;
  }

  const file = recordingFile?.toLowerCase() ?? "";

  if (file.endsWith(".wav")) {
    return "audio/wav";
  }

  if (file.endsWith(".ogg")) {
    return "audio/ogg";
  }

  return "audio/mpeg";
}

export function defaultDateFrom(now = new Date()) {
  const from = new Date(now.getTime() - DISCOVERY_WINDOW_HOURS * 60 * 60 * 1000);
  return `${from.toISOString().slice(0, 10)} 00:00:00`;
}

function retentionUntil(now = new Date()) {
  const days = Number(process.env.RECORDINGS_RETENTION_DAYS);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function jsonRecord(value: Json | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function isUniqueViolation(error: { code?: string; message: string }) {
  return error.code === "23505" || /duplicate key/i.test(error.message);
}

function throwOnError(error: { message: string } | null): asserts error is null {
  if (error) {
    throw new RecordingsSyncError(error.message);
  }
}
