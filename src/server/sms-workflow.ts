import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateAssetArrivalEta, distanceKm } from "@/lib/dispatch-calculations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { publicLocationLinkStatus } from "@/lib/sms/location-share";
import { validateCustomSmsDraft } from "@/lib/sms/custom-message";
import { renderSmsTemplate, type SmsTemplateKey } from "@/lib/sms/templates";
import { SMS_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { createTelnyxSmsTransport } from "@/lib/integrations/telnyx/sms-client";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
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
/** Provider literal persisted on every outbound SMS row and attempt. */
const SMS_PROVIDER = "telnyx_sms";
const SMS_FROM_LABEL = "Pomoc motoristom";

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

export type SmsSendOptions = {
  /** Test/injection seam; server routes rely on `resolveSmsTransport()`. */
  transport?: SmsTransport;
};

export class SmsWorkflowError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "SmsWorkflowError";
  }
}

export type SmsTransportSendInput = {
  /** E.164 recipient, see `normalizeSmsRecipient`. */
  to: string;
  body: string;
  idempotencyKey: string;
  /** Owning organisation; the transport reads its DB kill switch. */
  organizationId: string;
};

export type SmsTransportSendResult = {
  providerMessageId: string | null;
  status: "queued" | "sent" | "failed";
  /** Raw provider status, mirrored into `status_detail` when present. */
  providerStatus?: string | null;
  /** Sender and profile actually used, persisted for the audit trail. */
  fromSender?: string | null;
  messagingProfileId?: string | null;
};

/**
 * Provider-neutral seam between the SMS workflow (audit rows, idempotency,
 * case events, task completion) and whatever actually delivers the message.
 */
export type SmsTransport = {
  send(input: SmsTransportSendInput): Promise<SmsTransportSendResult>;
  /** Optional gate run before any audit row is written (kill switches). */
  preflight?(input: { organizationId: string }): Promise<void>;
};

/** Fails closed while no SMS provider is wired in; never touches the network. */
export const notConfiguredTransport: SmsTransport = {
  async send() {
    throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503);
  },
};

/**
 * Transport used by the server routes: Telnyx as soon as `TELNYX_API_KEY` is
 * present, otherwise the fail-closed stub. The live-send switches are enforced
 * inside the Telnyx transport (423), so a configured-but-disabled stack is
 * reported as a kill switch rather than as "not configured".
 */
export function resolveSmsTransport(): SmsTransport {
  return getTelnyxConfig().configured ? createTelnyxSmsTransport() : notConfiguredTransport;
}

/**
 * Canonical E.164 recipient for the transport: Slovak local numbers get +421,
 * `00`/`+` international prefixes are kept, anything else is rejected with 400.
 */
export function normalizeSmsRecipient(value: unknown, fieldName = "Telefónne číslo") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new SmsWorkflowError(`${fieldName}: chýba telefónne číslo.`, 400);
  }

  if (!/^\+?[\d ()/.-]{1,40}$/.test(input)) {
    throw new SmsWorkflowError(`${fieldName}: telefónne číslo nie je platné.`, 400);
  }

  const digits = input.replace(/\D/g, "");
  const international = digits.startsWith("00")
    ? digits.slice(2)
    : input.startsWith("+") || digits.startsWith("421")
      ? digits
      : digits.startsWith("0")
        ? `421${digits.slice(1)}`
        : "";

  if (!/^[1-9]\d{6,14}$/.test(international)) {
    throw new SmsWorkflowError(`${fieldName}: použite slovenské číslo alebo medzinárodný tvar s +/00.`, 400);
  }

  return `+${international}`;
}

export async function sendCaseSms(input: SendCaseSmsInput, options: SmsSendOptions = {}) {
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

  const transport = requireConfiguredTransport(options.transport);
  // Kill switches refuse before any audit row exists, like the not-configured gate.
  await transport.preflight?.({ organizationId });
  const toNumber = normalizeSmsRecipient(contact.phone, "Telefón klienta");
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
    template: input.template,
    toNumber,
  });

  const smsMessage = await insertSingle<SmsMessageRow>(
    supabase
      .from("motorist_sms_messages")
      .insert({
        organization_id: organizationId,
        provider: SMS_PROVIDER,
        case_id: caseRow.id,
        call_id: null,
        to_number: toNumber,
        from_label: SMS_FROM_LABEL,
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
  const delivery = await deliverSms(supabase, transport, {
    body,
    requestFingerprint,
    requestPayloadSafe: { body_length: body.length, to_number: toNumber },
    smsMessage,
    toNumber,
  });

  if (delivery.status !== "failed") {
    await completeSmsTask(supabase, organizationId, caseRow.id, input.taskId ?? null, input.template);
    await insertSmsEvent(supabase, {
      actorProfileId,
      assetLabel: etaContext?.assetLabel ?? null,
      caseId: caseRow.id,
      etaMinutes: etaContext?.etaMinutes ?? null,
      locationLinkId: locationLink?.linkId ?? null,
      organizationId,
      smsMessageId: smsMessage.id,
      statusDetail: delivery.statusDetail,
      template: input.template,
      toNumber,
    });
  }

  return {
    etaMinutes: etaContext?.etaMinutes ?? null,
    locationLinkExpiresAt: locationLink?.expiresAt ?? null,
    providerMessageId: delivery.providerMessageId,
    reused: false,
    smsMessageId: smsMessage.id,
    status: delivery.status,
    statusDetail: delivery.statusDetail,
  };
}

export async function sendCustomSms(input: SendCustomSmsInput, options: SmsSendOptions = {}) {
  let draft: ReturnType<typeof validateCustomSmsDraft>;

  try {
    draft = validateCustomSmsDraft({ message: input.body, toNumber: input.toNumber });
  } catch (error) {
    throw new SmsWorkflowError(error instanceof Error ? error.message : "SMS údaje nie sú platné.", 400);
  }

  if (!input.organizationId.trim() || !input.actorProfileId.trim()) {
    throw new SmsWorkflowError("Odosielateľa SMS sa nepodarilo bezpečne overiť.", 403);
  }

  // Gate before any read or write so an unconfigured SMS stack leaves no trace.
  const transport = requireConfiguredTransport(options.transport);
  await transport.preflight?.({ organizationId: input.organizationId });
  const toNumber = normalizeSmsRecipient(draft.toNumber, "Telefónne číslo");
  const supabase = createSupabaseAdminClient();
  const caseRow = input.caseId?.trim() ? await getCase(supabase, input.organizationId, input.caseId.trim()) : null;
  const idempotencyKey = `custom-sms:${input.actorProfileId}:${randomUUID()}`;
  const requestFingerprint = hashJson({
    actorProfileId: input.actorProfileId,
    body: draft.message,
    caseId: caseRow?.id ?? null,
    toNumber,
  });
  const smsMessage = await insertSingle<SmsMessageRow>(
    supabase
      .from("motorist_sms_messages")
      .insert({
        organization_id: input.organizationId,
        provider: SMS_PROVIDER,
        case_id: caseRow?.id ?? null,
        call_id: null,
        to_number: toNumber,
        from_label: SMS_FROM_LABEL,
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
  const delivery = await deliverSms(supabase, transport, {
    body: draft.message,
    requestFingerprint,
    requestPayloadSafe: { body_length: draft.message.length, to_number: toNumber },
    smsMessage,
    toNumber,
  });

  if (caseRow && delivery.status !== "failed") {
    await insertCustomSmsEvent(supabase, {
      actorProfileId: input.actorProfileId,
      caseId: caseRow.id,
      organizationId: input.organizationId,
      smsMessageId: smsMessage.id,
      statusDetail: delivery.statusDetail,
      toNumber,
    });
  }

  return {
    providerMessageId: delivery.providerMessageId,
    smsMessageId: smsMessage.id,
    status: delivery.status,
    statusDetail: delivery.statusDetail,
  };
}

function requireConfiguredTransport(override?: SmsTransport): SmsTransport {
  const transport = override ?? resolveSmsTransport();

  if (transport === notConfiguredTransport) {
    // Same contract as the former live-sends gate: refuse before any audit row exists.
    throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503);
  }

  return transport;
}

/**
 * Records one attempt, hands the message to the transport and mirrors the
 * outcome onto the attempt and message rows. Throws `SmsWorkflowError` after
 * marking both rows failed when the transport rejects.
 */
async function deliverSms(
  supabase: AdminClient,
  transport: SmsTransport,
  input: {
    body: string;
    requestFingerprint: string;
    requestPayloadSafe: Json;
    smsMessage: SmsMessageRow;
    toNumber: string;
  },
) {
  const { smsMessage } = input;
  const attempt = await insertSmsAttempt(supabase, smsMessage, input.requestFingerprint, input.requestPayloadSafe);
  let result: SmsTransportSendResult;

  try {
    result = await transport.send({
      body: input.body,
      idempotencyKey: smsMessage.idempotency_key ?? smsMessage.id,
      organizationId: smsMessage.organization_id,
      to: input.toNumber,
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : "SMS odoslanie zlyhalo.";

    await throwOnResult(
      supabase
        .from("motorist_sms_attempts")
        .update({
          status: "failed",
          provider_response_safe: providerErrorPayload(error),
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

    throw error instanceof SmsWorkflowError ? error : new SmsWorkflowError(errorMessage, 502);
  }

  const finishedAt = new Date().toISOString();
  const statusDetail = result.providerStatus ?? transportStatusDetail(result.status);
  const rejected = result.status === "failed";

  await throwOnResult(
    supabase
      .from("motorist_sms_attempts")
      .update({
        status: rejected ? "failed" : "accepted",
        provider_message_id: result.providerMessageId,
        provider_response_safe: {
          provider_message_id: result.providerMessageId,
          provider_status: result.providerStatus ?? null,
          status: result.status,
        },
        error: rejected ? PROVIDER_REJECTED_MESSAGE : null,
        finished_at: finishedAt,
      })
      .eq("id", attempt.id),
  );
  await throwOnResult(
    supabase
      .from("motorist_sms_messages")
      .update({
        status: result.status,
        status_detail: statusDetail,
        provider_message_id: result.providerMessageId,
        from_sender: result.fromSender ?? null,
        messaging_profile_id: result.messagingProfileId ?? null,
        error: rejected ? PROVIDER_REJECTED_MESSAGE : null,
        last_attempt_at: finishedAt,
        sent_at: result.status === "sent" ? finishedAt : null,
      })
      .eq("id", smsMessage.id),
  );

  return { providerMessageId: result.providerMessageId, status: result.status, statusDetail };
}

const PROVIDER_REJECTED_MESSAGE = "Poskytovateľ SMS správu neprijal.";

function transportStatusDetail(status: SmsTransportSendResult["status"]) {
  switch (status) {
    case "sent":
      return "sent_to_provider";
    case "queued":
      return "queued_at_provider";
    default:
      return "send_failed";
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
    .eq("provider", SMS_PROVIDER)
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
        provider: SMS_PROVIDER,
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

function providerErrorPayload(error: unknown): Json {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
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

function stringFromJson(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromJson(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
