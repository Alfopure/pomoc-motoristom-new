import "server-only";
import { completeTaskSourceIfSupported } from "./task-source-completion";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  createLocationShareToken,
  hashLocationShareToken,
  publicLocationLinkStatus,
  validatePublicLocationPayload,
  type ValidatedPublicLocation,
} from "@/lib/sms/location-share";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type Row<TableName extends keyof Tables> = Tables[TableName]["Row"];
type LinkRow = Row<"motorist_location_share_links">;
type LocationRow = Row<"motorist_locations">;

export type CreateLocationShareLinkInput = {
  supabase: AdminClient;
  organizationId: string;
  caseId: string;
  actorProfileId: string | null;
  publicBaseUrl: string;
  taskId?: string | null;
  expiresInHours?: number;
};

export type PublicRequestMetadata = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

export class LocationShareError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

export async function createCaseLocationShareLink(input: CreateLocationShareLinkInput) {
  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 24) * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const { token, tokenHash } = createLocationShareToken();

  await input.supabase
    .from("motorist_location_share_links")
    .update({ status: "expired" })
    .eq("organization_id", input.organizationId)
    .eq("case_id", input.caseId)
    .eq("scope", "pickup_location")
    .eq("status", "active")
    .lt("expires_at", now);

  const linkRow = await insertSingle<LinkRow>(
    input.supabase
      .from("motorist_location_share_links")
      .insert({
        organization_id: input.organizationId,
        case_id: input.caseId,
        scope: "pickup_location",
        token_hash: tokenHash,
        status: "active",
        expires_at: expiresAt,
        created_by: input.actorProfileId,
        metadata: {
          source: "sms_location_request",
          task_id: input.taskId ?? null,
          task_association: input.taskId ? "explicit" : null,
        },
      })
      .select("*")
      .single(),
  );

  return {
    linkId: linkRow.id,
    token,
    tokenHash,
    url: buildLocationShareUrl(input.publicBaseUrl, token),
    expiresAt: linkRow.expires_at,
  };
}

export async function getPublicLocationLinkState(token: string) {
  const supabase = createSupabaseAdminClient();
  const link = await findLinkByToken(supabase, token);

  if (!link) {
    throw new LocationShareError("Link na odoslanie polohy nie je platny.", 404);
  }

  const status = publicLocationLinkStatus(link.status, link.expires_at);

  if (status === "expired" && link.status !== "expired") {
    await supabase.from("motorist_location_share_links").update({ status: "expired" }).eq("id", link.id).eq("status", "active").lt("expires_at", new Date().toISOString());
  }

  return {
    status,
    expiresAt: link.expires_at,
  };
}

export async function submitPublicLocation(token: string, payload: unknown, metadata: PublicRequestMetadata = {}) {
  const supabase = createSupabaseAdminClient();
  const link = await findLinkByToken(supabase, token);

  if (!link) {
    throw new LocationShareError("Link na odoslanie polohy nie je platny.", 404);
  }

  const status = publicLocationLinkStatus(link.status, link.expires_at);
  let location: ValidatedPublicLocation;
  try { location = validatePublicLocationPayload(payload); }
  catch (error) { throw new LocationShareError(error instanceof Error ? error.message : "Poloha nie je platná.", 400); }

  if (status === "used") {
    const accepted = await supabase.from("motorist_location_submissions").select("*")
      .eq("organization_id", link.organization_id).eq("case_id", link.case_id).eq("link_id", link.id)
      .eq("accepted", true).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
    await throwOnResult(accepted);
    const previous = accepted.data;
    // Retry only the same normalized coordinates. The used bearer link cannot
    // create a second location or replace the accepted submission.
    if (!previous?.location_id || previous.lat !== location.lat || previous.lng !== location.lng
      || previous.accuracy_meters !== location.accuracy) {
      throw new LocationShareError("Link na odoslanie polohy už nie je aktívny.", 410);
    }
    await finishAcceptedLocation(supabase, link, location, previous.id);
    return { locationId: previous.location_id, status: "stored" as const, submittedAt: previous.submitted_at };
  }

  if (status !== "active") {
    if (status === "expired" && link.status !== "expired") {
      await supabase.from("motorist_location_share_links").update({ status: "expired" }).eq("id", link.id).eq("status", "active").lt("expires_at", new Date().toISOString());
    }

    throw new LocationShareError("Link na odoslanie polohy uz nie je aktivny.", 410);
  }

  const submittedAt = new Date().toISOString();
  const locationRow = await createSubmittedLocation(supabase, link, location, submittedAt);

  const submissionResult = await supabase
      .from("motorist_location_submissions")
      .insert({
        organization_id: link.organization_id,
        case_id: link.case_id,
        link_id: link.id,
        location_id: locationRow.id,
        lat: location.lat,
        lng: location.lng,
        accuracy_meters: location.accuracy,
        source: "browser_geolocation",
        user_agent_hash: hashOptional(metadata.userAgent),
        ip_hash: hashOptional(metadata.ipAddress),
        submitted_at: submittedAt,
        accepted: true,
        raw_payload_safe: {
          accuracy_meters: location.accuracy,
          client_timestamp: location.clientTimestamp,
          source: "browser_geolocation",
        },
      })
      .select("*")
      .single();
  if (submissionResult.error?.code === "P0001" && ["location_link_inactive", "location_link_invalid"].includes(submissionResult.error.message)) {
    // The database trigger rejected this insert, so this newly created location
    // has no accepted submission. Do not clean up after ambiguous network errors.
    await supabase.from("motorist_locations").delete().eq("organization_id", link.organization_id).eq("id", locationRow.id);
    throw new LocationShareError("Link na odoslanie polohy už nie je aktívny.", 410);
  }
  await throwOnResult(submissionResult);
  const submission = submissionResult.data;
  if (!submission) throw new LocationShareError("Polohu sa nepodarilo uložiť.");

  await throwOnResult(
    supabase
      .from("motorist_location_share_links")
      .update({ status: "used", used_at: submittedAt })
      .eq("id", link.id)
      .eq("status", "active"),
  );
  await finishAcceptedLocation(supabase, link, location, submission.id);

  return {
    locationId: locationRow.id,
    status: "stored" as const,
    submittedAt,
  };
}

export function buildLocationShareUrl(publicBaseUrl: string, token: string) {
  const baseUrl = publicBaseUrl.trim().replace(/\/+$/, "");

  if (!baseUrl) {
    throw new LocationShareError("Verejna URL aplikacie nie je dostupna.", 500);
  }

  return `${baseUrl}/l/${encodeURIComponent(token)}`;
}

async function findLinkByToken(supabase: AdminClient, token: string) {
  let tokenHash: string;

  try {
    tokenHash = hashLocationShareToken(token);
  } catch {
    return null;
  }

  const result = await supabase.from("motorist_location_share_links").select("*").eq("token_hash", tokenHash).maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function createSubmittedLocation(supabase: AdminClient, link: LinkRow, location: ValidatedPublicLocation, submittedAt: string) {
  const accuracyText = location.accuracy === null ? "" : `, presnost ${Math.round(location.accuracy)} m`;

  return insertSingle<LocationRow>(
    supabase
      .from("motorist_locations")
      .insert({
        organization_id: link.organization_id,
        label: "Poloha od klienta",
        address: `GPS poloha od klienta (${location.lat}, ${location.lng}${accuracyText})`,
        lat: location.lat,
        lng: location.lng,
        place_id: null,
        provider: "browser_geolocation",
        confidence: location.accuracy === null ? 0.82 : location.accuracy <= 100 ? 0.98 : 0.85,
        metadata: {
          source: "public_location_link",
          link_id: link.id,
          submitted_at: submittedAt,
          accuracy_meters: location.accuracy,
          client_timestamp: location.clientTimestamp,
        },
      })
      .select("*")
      .single(),
  );
}

async function completeLocationTask(supabase: AdminClient, link: LinkRow) {
  const metadata = objectJson(link.metadata);
  const taskId = stringFromJson(metadata.task_id);
  // New composer links preserve an explicit "no task" choice even on the old
  // database. Historical unmarked links retain their pre-migration fallback.
  if (!taskId && "task_association" in metadata) return;

  if (taskId) {
    await throwOnResult(
      supabase
        .from("motorist_case_tasks")
        .update({ status: "done" })
        .eq("organization_id", link.organization_id)
        .eq("case_id", link.case_id)
        .eq("id", taskId),
    );
    return;
  }

  await throwOnResult(
    supabase
      .from("motorist_case_tasks")
      .update({ status: "done" })
      .eq("organization_id", link.organization_id)
      .eq("case_id", link.case_id)
      .eq("status", "open")
      .ilike("title", "%lokaliza%SMS%"),
  );
}

async function finishAcceptedLocation(supabase: AdminClient, link: LinkRow, location: ValidatedPublicLocation, submissionId: string) {
  if (!await completeTaskSourceIfSupported(supabase, link.organization_id, "location", submissionId)) await completeLocationTask(supabase, link);
  await insertLocationSubmittedEvent(supabase, link, location, submissionId);
  await insertLocationSubmittedNotification(supabase, link, location, submissionId);
}

async function insertLocationSubmittedEvent(supabase: AdminClient, link: LinkRow, location: ValidatedPublicLocation, submissionId: string) {
  const existing = await supabase.from("motorist_case_events").select("id")
    .eq("organization_id", link.organization_id).eq("case_id", link.case_id)
    .eq("event_type", "location_submitted").contains("payload", { submission_id: submissionId }).limit(1).maybeSingle();
  await throwOnResult(existing);
  if (existing.data) return;
  const accuracy = location.accuracy === null ? "bez presnosti" : `presnost ${Math.round(location.accuracy)} m`;

  const result = await supabase
      .from("motorist_case_events")
      .insert({
        // Stable across retries, including two requests racing after acceptance.
        id: submissionId,
        organization_id: link.organization_id,
        case_id: link.case_id,
        actor_profile_id: null,
        event_type: "location_submitted",
        title: "Poloha od klienta prijata",
        body: `Klient povolil zdielanie GPS polohy (${accuracy}).`,
        payload: {
          source: "public_location_link",
          link_id: link.id,
          submission_id: submissionId,
          lat: location.lat,
          lng: location.lng,
          accuracy_meters: location.accuracy,
        },
      })
      .select("*")
      .single();
  if (result.error?.code !== "23505") await throwOnResult(result);
}

async function insertLocationSubmittedNotification(supabase: AdminClient, link: LinkRow, location: ValidatedPublicLocation, submissionId: string) {
  try {
    const existing = await supabase.from("motorist_notifications").select("id")
      .eq("organization_id", link.organization_id).contains("payload", { source: "public_location_link", submission_id: submissionId })
      .limit(1).maybeSingle();
    await throwOnResult(existing);
    if (existing.data) return;
    const caseResult = await supabase
      .from("motorist_cases")
      .select("case_number, owner_id")
      .eq("organization_id", link.organization_id)
      .eq("id", link.case_id)
      .maybeSingle();
    await throwOnResult(caseResult);

    const recipientProfileId = caseResult.data?.owner_id ?? link.created_by ?? null;
    const accuracy = location.accuracy === null ? "bez údaja o presnosti" : `s presnosťou približne ${Math.round(location.accuracy)} m`;
    const result = await supabase
      .from("motorist_notifications")
      .insert({
        organization_id: link.organization_id,
        case_id: link.case_id,
        task_id: null,
        reminder_id: null,
        recipient_profile_id: recipientProfileId,
        visibility: recipientProfileId ? "private" : "team",
        kind: "system",
        severity: "info",
        title: `${caseResult.data?.case_number ?? "Prípad"}: klient poslal polohu`,
        body: `GPS poloha bola prijatá ${accuracy}. Pôvodné miesto incidentu zostalo nezmenené.`,
        status: "unread",
        delivery_status: "in_app",
        dedupe_key: `location-submitted:${submissionId}:${recipientProfileId ?? "team"}`,
        payload: {
          source: "public_location_link",
          submission_id: submissionId,
          lat: location.lat,
          lng: location.lng,
          accuracy_meters: location.accuracy,
        },
      });
    if (result.error?.code !== "23505") await throwOnResult(result);
  } catch (error) {
    // Uloženie GPS je primárna operácia. Výpadok upozornenia nesmie klientovi
    // zobraziť neúspech po tom, čo už bola poloha bezpečne prijatá.
    console.warn("Location submission notification could not be created:", error instanceof Error ? error.message : "unknown error");
  }
}

async function insertSingle<Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row> {
  const result = await query;

  if (result.error) {
    throw new LocationShareError(result.error.message);
  }

  if (!result.data) {
    throw new LocationShareError("Supabase nevratil vytvoreny zaznam.");
  }

  return result.data as Row;
}

async function throwOnResult(result: PromiseLike<{ error: { message: string } | null }> | { error: { message: string } | null }) {
  const resolved = await result;

  if (resolved.error) {
    throw new LocationShareError(resolved.error.message);
  }
}

function hashOptional(value: string | null | undefined) {
  const input = value?.trim();
  return input ? createHash("sha256").update(input, "utf8").digest("hex") : null;
}

function objectJson(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFromJson(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
