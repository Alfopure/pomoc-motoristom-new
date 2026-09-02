import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createViptelSmsClient,
  getViptelSmsConfig,
  normalizeViptelSmsMsisdn,
  type ViptelSmsClient,
  type ViptelSmsConfig,
} from "@/lib/integrations/viptel/sms-client";
import { calculateAssetArrivalEta, distanceKm } from "@/lib/dispatch-calculations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { publicLocationLinkStatus } from "@/lib/sms/location-share";
import { validateCustomSmsDraft } from "@/lib/sms/custom-message";
import { renderSmsTemplate, type SmsTemplateKey } from "@/lib/sms/templates";
import { createCaseLocationShareLink } from "@/server/location-share-links";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type Row<TableName extends keyof Tables> = Tables[TableName]["Row"];
type BranchRow = Row<"motorist_branches">;
type CaseEventRow = Row<"motorist_case_events">;
type CaseRow = Row<"motorist_cases">;
type ContactRow = Row<"motorist_contacts">;
type FleetAssetRow = Row<"motorist_fleet_assets">;
type LocationRow = Row<"motorist_locations">;
type OrganizationProfileRow = Row<"motorist_organization_profiles">;
type OrganizationRow = Row<"motorist_organizations">;
type SmsAttemptRow = Row<"motorist_sms_attempts">;
type SmsMessageRow = Row<"motorist_sms_messages">;

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";

export type SendCaseSmsInput = {
  caseId: string;
  template: SmsTemplateKey;
  publicBaseUrl: string;
  taskId?: string | null;
  resend?: boolean;
};

export type SendCustomSmsInput = {
  actorProfileId: string;
  body: string;
  caseId?: string | null;
  organizationId: string;
  toNumber: string;
};

export class SmsWorkflowError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
  }
}

export async function sendCaseSms(input: SendCaseSmsInput) {
  if (!input.caseId.trim()) {
    throw new SmsWorkflowError("Chyba pripad.", 400);
  }

  if (!isSmsTemplateKey(input.template)) {
    throw new SmsWorkflowError("Nepodporovana SMS sablona.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const caseRow = await getCase(supabase, organizationId, input.caseId);
  const [contact, organizationProfile] = await Promise.all([
    caseRow.contact_id ? getContact(supabase, organizationId, caseRow.contact_id) : Promise.resolve(null),
    getOrganizationProfile(supabase, organizationId),
  ]);

  if (!contact?.phone) {
    throw new SmsWorkflowError("Pripad nema telefon klienta.", 400);
  }

  const baseIdempotencyKey =
    input.template === "eta_update"
      ? `case:${caseRow.id}:sms:${input.template}`
      : `case:${caseRow.id}:sms:${input.template}:${input.taskId ?? "quick_action"}`;
  const existing = input.resend ? null : await findSmsByIdempotencyKey(supabase, organizationId, baseIdempotencyKey);

  if (existing && existing.status !== "failed") {
    const payload = objectJson(existing.raw_payload);

    if (input.template === "location_request") {
      const linkStatus = await existingLocationLinkStatus(supabase, organizationId, stringFromJson(payload.location_link_id));

      if (linkStatus === "active" || linkStatus === "used") {
        return {
          etaMinutes: numberFromJson(payload.eta_minutes),
          locationLinkExpiresAt: stringFromJson(payload.location_link_expires_at),
          providerMessageId: existing.provider_message_id,
          reused: true,
          smsMessageId: existing.id,
          status: existing.status,
          statusDetail: existing.status_detail,
        };
      }
    } else {
      return {
        etaMinutes: numberFromJson(payload.eta_minutes),
        locationLinkExpiresAt: stringFromJson(payload.location_link_expires_at),
        providerMessageId: existing.provider_message_id,
        reused: true,
        smsMessageId: existing.id,
        status: existing.status,
        statusDetail: existing.status_detail,
      };
    }
  }

  const config = getViptelSmsConfig();

  if (!config.liveSendsEnabled) {
    throw new SmsWorkflowError("VIPTel SMS realne odosielanie je vypnute. Nastav VIPTEL_SMS_LIVE_SENDS=true.", 503);
  }

  const client = createViptelSmsClient(config);
  const fromIdentity = await resolveFromIdentity(client, config);
  const toNumber = normalizeViptelSmsMsisdn(contact.phone, "contact.phone");
  const actorProfileId = caseRow.owner_id ?? (await resolveDefaultOwnerId(supabase, organizationId));
  const locationLink =
    input.template === "location_request"
      ? await createCaseLocationShareLink({
          supabase,
          organizationId,
          caseId: caseRow.id,
          actorProfileId,
          publicBaseUrl: input.publicBaseUrl,
          taskId: input.taskId ?? null,
        })
      : null;
  const etaContext = input.template === "eta_update" ? await resolveEtaSmsContext(supabase, organizationId, caseRow) : null;
  const body = renderSmsTemplate(input.template, {
    brandName: organizationProfile?.brand_name ?? organization.name,
    caseNumber: caseRow.case_number,
    etaMinutes: etaContext?.etaMinutes,
    link: locationLink?.url,
  });
  const idempotencyKey = input.resend || existing ? `${baseIdempotencyKey}:retry:${Date.now()}` : baseIdempotencyKey;
  const requestFingerprint = hashJson({
    body,
    caseId: caseRow.id,
    fromIdentity,
    template: input.template,
    toNumber,
  });

  const smsMessage = await insertSingle<SmsMessageRow>(
    supabase
      .from("motorist_sms_messages")
      .insert({
        organization_id: organizationId,
        provider: "viptel_sms",
        case_id: caseRow.id,
        call_id: null,
        to_number: toNumber,
        from_label: "Pomoc motoristom",
        from_identity: fromIdentity,
        direction: "outbound",
        status: "queued",
        status_detail: "queued_for_send",
        template_key: input.template,
        body,
        raw_payload: {
          asset_id: etaContext?.assetId ?? null,
          asset_label: etaContext?.assetLabel ?? null,
          eta_minutes: etaContext?.etaMinutes ?? null,
          location_link_id: locationLink?.linkId ?? null,
          location_link_expires_at: locationLink?.expiresAt ?? null,
          source: input.template === "eta_update" ? "case_eta_action" : "case_quick_action",
          task_id: input.taskId ?? null,
        },
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        queued_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
        retry_count: 0,
      })
      .select("*")
      .single(),
  );
  const attempt = await insertSmsAttempt(supabase, smsMessage, requestFingerprint, {
    body_length: body.length,
    from_identity: fromIdentity,
    to_number: toNumber,
  });

  try {
    const result = await client.sendMessage({
      body,
      destMsisdn: toNumber,
      fromIdentity,
    });
    const providerMessageId = extractProviderMessageId(result.providerResponse);
    const sentAt = new Date().toISOString();

    await throwOnResult(
      supabase
        .from("motorist_sms_attempts")
        .update({
          status: "accepted",
          provider_status_code: result.normalizedStatus.providerStatusCode,
          provider_message_id: providerMessageId,
          provider_response_safe: safeJson(result.providerResponse),
          finished_at: sentAt,
        })
        .eq("id", attempt.id),
    );
    await throwOnResult(
      supabase
        .from("motorist_sms_messages")
        .update({
          status: result.normalizedStatus.status,
          status_detail: result.normalizedStatus.statusDetail,
          provider_message_id: providerMessageId,
          raw_payload: {
            ...objectJson(smsMessage.raw_payload),
            provider_request_id: result.requestId,
            provider_status_code: result.normalizedStatus.providerStatusCode,
          },
          last_attempt_at: sentAt,
          sent_at: result.normalizedStatus.status === "sent" || result.normalizedStatus.status === "delivered" ? sentAt : null,
          delivered_at: result.normalizedStatus.status === "delivered" ? sentAt : null,
        })
        .eq("id", smsMessage.id),
    );
    await completeSmsTask(supabase, organizationId, caseRow.id, input.taskId ?? null, input.template);
    await insertSmsEvent(supabase, {
      actorProfileId,
      assetLabel: etaContext?.assetLabel ?? null,
      caseId: caseRow.id,
      etaMinutes: etaContext?.etaMinutes ?? null,
      locationLinkId: locationLink?.linkId ?? null,
      organizationId,
      smsMessageId: smsMessage.id,
      statusDetail: result.normalizedStatus.statusDetail,
      template: input.template,
      toNumber,
    });

    return {
      etaMinutes: etaContext?.etaMinutes ?? null,
      locationLinkExpiresAt: locationLink?.expiresAt ?? null,
      providerMessageId,
      reused: false,
      smsMessageId: smsMessage.id,
      status: result.normalizedStatus.status,
      statusDetail: result.normalizedStatus.statusDetail,
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : "VIPTel SMS odoslanie zlyhalo.";

    await throwOnResult(
      supabase
        .from("motorist_sms_attempts")
        .update({
          status: "failed",
          provider_response_safe: safeJson(providerErrorPayload(error)),
          error_class: error instanceof Error ? error.name : "Error",
          error: errorMessage,
          finished_at: failedAt,
        })
        .eq("id", attempt.id),
    );
    await throwOnResult(
      supabase
        .from("motorist_sms_messages")
        .update({
          status: "failed",
          status_detail: "send_failed",
          error: errorMessage,
          last_attempt_at: failedAt,
        })
        .eq("id", smsMessage.id),
    );

    throw new SmsWorkflowError(errorMessage, 502);
  }
}

export async function sendCustomSms(input: SendCustomSmsInput) {
  let draft: ReturnType<typeof validateCustomSmsDraft>;

  try {
    draft = validateCustomSmsDraft({ message: input.body, toNumber: input.toNumber });
  } catch (error) {
    throw new SmsWorkflowError(error instanceof Error ? error.message : "SMS údaje nie sú platné.", 400);
  }

  if (!input.organizationId.trim() || !input.actorProfileId.trim()) {
    throw new SmsWorkflowError("Odosielateľa SMS sa nepodarilo bezpečne overiť.", 403);
  }

  const supabase = createSupabaseAdminClient();
  const caseRow = input.caseId?.trim() ? await getCase(supabase, input.organizationId, input.caseId.trim()) : null;
  const config = getViptelSmsConfig();

  if (!config.liveSendsEnabled) {
    throw new SmsWorkflowError("VIPTel SMS reálne odosielanie je vypnuté. Nastav VIPTEL_SMS_LIVE_SENDS=true.", 503);
  }

  const client = createViptelSmsClient(config);
  const fromIdentity = await resolveFromIdentity(client, config);
  let toNumber: string;

  try {
    toNumber = normalizeViptelSmsMsisdn(draft.toNumber, "Telefónne číslo");
  } catch (error) {
    throw new SmsWorkflowError(error instanceof Error ? error.message : "Telefónne číslo nie je platné.", 400);
  }

  const idempotencyKey = `custom-sms:${input.actorProfileId}:${randomUUID()}`;
  const requestFingerprint = hashJson({
    actorProfileId: input.actorProfileId,
    body: draft.message,
    caseId: caseRow?.id ?? null,
    fromIdentity,
    toNumber,
  });
  const smsMessage = await insertSingle<SmsMessageRow>(
    supabase
      .from("motorist_sms_messages")
      .insert({
        organization_id: input.organizationId,
        provider: "viptel_sms",
        case_id: caseRow?.id ?? null,
        call_id: null,
        to_number: toNumber,
        from_label: "Pomoc motoristom",
        from_identity: fromIdentity,
        direction: "outbound",
        status: "queued",
        status_detail: "queued_for_send",
        template_key: "custom",
        body: draft.message,
        raw_payload: {
          actor_profile_id: input.actorProfileId,
          source: caseRow ? "case_custom_sms" : "global_custom_sms",
        },
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        queued_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
        retry_count: 0,
      })
      .select("*")
      .single(),
  );
  const attempt = await insertSmsAttempt(supabase, smsMessage, requestFingerprint, {
    body_length: draft.message.length,
    from_identity: fromIdentity,
    to_number: toNumber,
  });

  try {
    const result = await client.sendMessage({ body: draft.message, destMsisdn: toNumber, fromIdentity });
    const providerMessageId = extractProviderMessageId(result.providerResponse);
    const sentAt = new Date().toISOString();

    await throwOnResult(
      supabase
        .from("motorist_sms_attempts")
        .update({
          status: "accepted",
          provider_status_code: result.normalizedStatus.providerStatusCode,
          provider_message_id: providerMessageId,
          provider_response_safe: safeJson(result.providerResponse),
          finished_at: sentAt,
        })
        .eq("id", attempt.id),
    );
    await throwOnResult(
      supabase
        .from("motorist_sms_messages")
        .update({
          status: result.normalizedStatus.status,
          status_detail: result.normalizedStatus.statusDetail,
          provider_message_id: providerMessageId,
          raw_payload: {
            ...objectJson(smsMessage.raw_payload),
            provider_request_id: result.requestId,
            provider_status_code: result.normalizedStatus.providerStatusCode,
          },
          last_attempt_at: sentAt,
          sent_at: result.normalizedStatus.status === "sent" || result.normalizedStatus.status === "delivered" ? sentAt : null,
          delivered_at: result.normalizedStatus.status === "delivered" ? sentAt : null,
        })
        .eq("id", smsMessage.id),
    );

    if (caseRow) {
      await insertCustomSmsEvent(supabase, {
        actorProfileId: input.actorProfileId,
        caseId: caseRow.id,
        organizationId: input.organizationId,
        smsMessageId: smsMessage.id,
        statusDetail: result.normalizedStatus.statusDetail,
        toNumber,
      });
    }

    return {
      providerMessageId,
      smsMessageId: smsMessage.id,
      status: result.normalizedStatus.status,
      statusDetail: result.normalizedStatus.statusDetail,
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : "VIPTel SMS odoslanie zlyhalo.";

    await throwOnResult(
      supabase
        .from("motorist_sms_attempts")
        .update({
          status: "failed",
          provider_response_safe: safeJson(providerErrorPayload(error)),
          error_class: error instanceof Error ? error.name : "Error",
          error: errorMessage,
          finished_at: failedAt,
        })
        .eq("id", attempt.id),
    );
    await throwOnResult(
      supabase
        .from("motorist_sms_messages")
        .update({
          status: "failed",
          status_detail: "send_failed",
          error: errorMessage,
          last_attempt_at: failedAt,
        })
        .eq("id", smsMessage.id),
    );

    throw new SmsWorkflowError(errorMessage, 502);
  }
}

async function resolveOrganization(supabase: AdminClient): Promise<OrganizationRow> {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("*").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("*")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG)
        .maybeSingle();
  const result = await query;
  await throwOnResult(result);

  if (!result.data?.active) {
    throw new SmsWorkflowError("Aktivna organizacia sa nenasla.", 404);
  }

  return result.data;
}

async function resolveDefaultOwnerId(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_profiles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  await throwOnResult(result);
  return result.data?.id ?? null;
}

async function getCase(supabase: AdminClient, organizationId: string, id: string): Promise<CaseRow> {
  const result = await supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);

  if (!result.data) {
    throw new SmsWorkflowError("Pripad sa nenasiel.", 404);
  }

  return result.data;
}

async function getContact(supabase: AdminClient, organizationId: string, id: string): Promise<ContactRow> {
  const result = await supabase.from("motorist_contacts").select("*").eq("organization_id", organizationId).eq("id", id).maybeSingle();
  await throwOnResult(result);

  if (!result.data) {
    throw new SmsWorkflowError("Kontakt sa nenasiel.", 404);
  }

  return result.data;
}

async function getOrganizationProfile(supabase: AdminClient, organizationId: string): Promise<OrganizationProfileRow | null> {
  const result = await supabase.from("motorist_organization_profiles").select("*").eq("organization_id", organizationId).maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function findSmsByIdempotencyKey(supabase: AdminClient, organizationId: string, idempotencyKey: string) {
  const result = await supabase
    .from("motorist_sms_messages")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel_sms")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  await throwOnResult(result);
  return result.data ?? null;
}

async function existingLocationLinkStatus(supabase: AdminClient, organizationId: string, locationLinkId: string | null) {
  if (!locationLinkId) {
    return null;
  }

  const result = await supabase
    .from("motorist_location_share_links")
    .select("status, expires_at")
    .eq("organization_id", organizationId)
    .eq("id", locationLinkId)
    .maybeSingle();
  await throwOnResult(result);

  return result.data ? publicLocationLinkStatus(result.data.status, result.data.expires_at) : null;
}

async function resolveEtaSmsContext(supabase: AdminClient, organizationId: string, caseRow: CaseRow) {
  if (!caseRow.pickup_location_id) {
    throw new SmsWorkflowError("Pripad nema miesto incidentu pre vypocet ETA.", 400);
  }

  const [pickupResult, assetsResult, branchesResult, locationsResult] = await Promise.all([
    supabase.from("motorist_locations").select("*").eq("organization_id", organizationId).eq("id", caseRow.pickup_location_id).maybeSingle(),
    supabase.from("motorist_fleet_assets").select("*").eq("organization_id", organizationId),
    supabase.from("motorist_branches").select("*").eq("organization_id", organizationId).eq("active", true),
    supabase.from("motorist_locations").select("*").eq("organization_id", organizationId),
  ]);
  await Promise.all([throwOnResult(pickupResult), throwOnResult(assetsResult), throwOnResult(branchesResult), throwOnResult(locationsResult)]);

  if (!pickupResult.data) {
    throw new SmsWorkflowError("Miesto incidentu sa nenaslo.", 404);
  }

  const locationsById = new Map((locationsResult.data ?? []).map((location) => [location.id, location]));
  const branchesById = new Map((branchesResult.data ?? []).map((branch) => [branch.id, branch]));
  const selected = caseRow.selected_asset_id ? (assetsResult.data ?? []).find((asset) => asset.id === caseRow.selected_asset_id) : undefined;
  const selectedWithPoint = selected && pointForAsset(selected, locationsById, branchesById) ? selected : undefined;
  const asset = selectedWithPoint ?? nearestEtaAsset(pickupResult.data, assetsResult.data ?? [], locationsById, branchesById);

  if (!asset) {
    throw new SmsWorkflowError("Pre ETA SMS nie je dostupna ziadna odtahovka.", 400);
  }

  const assetPoint = pointForAsset(asset, locationsById, branchesById);

  if (!assetPoint) {
    throw new SmsWorkflowError("Vozidlo nema polohu pre vypocet ETA.", 400);
  }

  const eta = calculateAssetArrivalEta(assetPoint, pointFromLocation(pickupResult.data));

  return {
    assetId: asset.id,
    assetLabel: asset.label,
    etaMinutes: eta.eta,
  };
}

async function resolveFromIdentity(client: ViptelSmsClient, config: ViptelSmsConfig) {
  if (config.fromIdentity?.trim()) {
    return config.fromIdentity.trim();
  }

  const identities = await client.listIdentities();
  const preferred = identities.find((identity) => identity.value.startsWith("00") || identity.name?.startsWith("00")) ?? identities[0];
  const fromIdentity = preferred?.name ?? preferred?.value ?? preferred?.id;

  if (!fromIdentity) {
    throw new SmsWorkflowError("VIPTel SMS nema nastavenu odosielaciu identitu.", 503);
  }

  return fromIdentity;
}

async function insertSmsAttempt(
  supabase: AdminClient,
  smsMessage: SmsMessageRow,
  requestFingerprint: string,
  requestPayloadSafe: Json,
): Promise<SmsAttemptRow> {
  return insertSingle<SmsAttemptRow>(
    supabase
      .from("motorist_sms_attempts")
      .insert({
        organization_id: smsMessage.organization_id,
        sms_message_id: smsMessage.id,
        provider: "viptel_sms",
        attempt_number: smsMessage.retry_count + 1,
        claim_id: randomUUID(),
        idempotency_key: smsMessage.idempotency_key ?? smsMessage.id,
        request_fingerprint: requestFingerprint,
        status: "sending",
        request_payload_safe: requestPayloadSafe,
        started_at: new Date().toISOString(),
      })
      .select("*")
      .single(),
  );
}

async function completeSmsTask(supabase: AdminClient, organizationId: string, caseId: string, taskId: string | null, template: SmsTemplateKey) {
  if (taskId) {
    await throwOnResult(
      supabase.from("motorist_case_tasks").update({ status: "done" }).eq("organization_id", organizationId).eq("case_id", caseId).eq("id", taskId),
    );
    return;
  }

  const titlePattern = template === "eta_update" ? "%ETA%" : "%lokaliza%SMS%";

  await throwOnResult(
    supabase
      .from("motorist_case_tasks")
      .update({ status: "done" })
      .eq("organization_id", organizationId)
      .eq("case_id", caseId)
      .eq("status", "open")
      .ilike("title", titlePattern),
  );
}

async function insertSmsEvent(
  supabase: AdminClient,
  input: {
    actorProfileId: string | null;
    assetLabel: string | null;
    caseId: string;
    etaMinutes: number | null;
    locationLinkId: string | null;
    organizationId: string;
    smsMessageId: string;
    statusDetail: string;
    template: SmsTemplateKey;
    toNumber: string;
  },
) {
  const isEta = input.template === "eta_update";

  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: input.organizationId,
        case_id: input.caseId,
        actor_profile_id: input.actorProfileId,
        event_type: isEta ? "sms_eta_update_sent" : "sms_location_request_sent",
        title: isEta ? "ETA SMS odoslana" : "Lokalizacna SMS odoslana",
        body: isEta
          ? `SMS s pribliznym prichodom ${input.etaMinutes ?? "?"} min bola odoslana na ${maskPhone(input.toNumber)}.`
          : `SMS s linkom na polohu bola odoslana na ${maskPhone(input.toNumber)}.`,
        payload: {
          asset_label: input.assetLabel,
          eta_minutes: input.etaMinutes,
          location_link_id: input.locationLinkId,
          sms_message_id: input.smsMessageId,
          source: isEta ? "case_eta_action" : "case_quick_action",
          status_detail: input.statusDetail,
        },
      })
      .select("*")
      .single(),
  );
}

async function insertCustomSmsEvent(
  supabase: AdminClient,
  input: {
    actorProfileId: string;
    caseId: string;
    organizationId: string;
    smsMessageId: string;
    statusDetail: string;
    toNumber: string;
  },
) {
  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: input.organizationId,
        case_id: input.caseId,
        actor_profile_id: input.actorProfileId,
        event_type: "sms_custom_sent",
        title: "Vlastná SMS odoslaná",
        body: `SMS bola odoslaná na ${maskPhone(input.toNumber)}.`,
        payload: {
          sms_message_id: input.smsMessageId,
          source: "case_custom_sms",
          status_detail: input.statusDetail,
        },
      })
      .select("*")
      .single(),
  );
}

async function insertSingle<Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row> {
  const result = await query;

  if (result.error) {
    throw new SmsWorkflowError(result.error.message);
  }

  if (!result.data) {
    throw new SmsWorkflowError("Supabase nevratil vytvoreny zaznam.");
  }

  return result.data as Row;
}

async function throwOnResult(result: PromiseLike<{ error: { message: string } | null }> | { error: { message: string } | null }) {
  const resolved = await result;

  if (resolved.error) {
    throw new SmsWorkflowError(resolved.error.message);
  }
}

function isSmsTemplateKey(value: string): value is SmsTemplateKey {
  return value === "location_request" || value === "eta_update";
}

function nearestEtaAsset(
  pickup: LocationRow,
  assets: FleetAssetRow[],
  locationsById: Map<string, LocationRow>,
  branchesById: Map<string, BranchRow>,
) {
  const usableAssets = assets.filter((asset) => asset.kind === "tow_truck" && asset.status !== "service" && asset.status !== "offline");
  const preferredAssets = usableAssets.filter((asset) => asset.status === "available");
  const candidates = preferredAssets.length ? preferredAssets : usableAssets;
  const pickupPoint = pointFromLocation(pickup);

  return candidates
    .map((asset) => {
      const assetPoint = pointForAsset(asset, locationsById, branchesById);

      return {
        asset,
        distance: assetPoint ? distanceKm(pickupPoint, assetPoint) : Number.MAX_SAFE_INTEGER,
      };
    })
    .sort((left, right) => left.distance - right.distance)[0]?.asset;
}

function pointForAsset(asset: FleetAssetRow, locationsById: Map<string, LocationRow>, branchesById: Map<string, BranchRow>) {
  const currentLocation = asset.current_location_id ? locationsById.get(asset.current_location_id) : undefined;

  if (currentLocation) {
    return pointFromLocation(currentLocation);
  }

  const branch = asset.branch_id ? branchesById.get(asset.branch_id) : undefined;
  const branchLocation = branch?.location_id ? locationsById.get(branch.location_id) : undefined;

  return branchLocation ? pointFromLocation(branchLocation) : null;
}

function pointFromLocation(location: LocationRow) {
  return {
    lat: Number(location.lat),
    lng: Number(location.lng),
  };
}

function extractProviderMessageId(payload: unknown) {
  const record = asRecord(payload);
  return stringFromJson(record.hash_id) ?? stringFromJson(record.message_id) ?? stringFromJson(record.id) ?? stringFromJson(record.transaction_key);
}

function providerErrorPayload(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;

    return {
      message: error instanceof Error ? error.message : stringFromJson(record.message),
      name: error instanceof Error ? error.name : stringFromJson(record.name),
      provider_response: safeJson(record.providerResponse),
      provider_status: record.providerStatus,
    };
  }

  return { message: String(error) };
}

function safeJson(value: unknown): Json {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(safeJson);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key, safeJson(item)]),
    ) as Json;
  }

  return String(value);
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.length <= 6) {
    return value;
  }

  return `${digits.slice(0, 5)}***${digits.slice(-3)}`;
}

function objectJson(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFromJson(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromJson(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
