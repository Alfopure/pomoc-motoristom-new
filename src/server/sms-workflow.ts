import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { PreparedSms, SmsActor, SmsPrepareInput, SmsPreview } from "@/lib/sms/contracts";
import { createLocationShareToken, hashLocationShareToken } from "@/lib/sms/location-share";
import { validateCustomSmsDraft } from "@/lib/sms/custom-message";
import { isSmsTemplateKey, renderSmsTemplate, SMS_TEMPLATE_VERSION, validateTemplateMessage } from "@/lib/sms/templates";
import { smsSegments } from "@/lib/sms/segments";
import { SMS_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { createTelnyxSmsTransport } from "@/lib/integrations/telnyx/sms-client";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { buildLocationShareUrl } from "@/server/location-share-links";
import { signSmsDraft, verifySmsDraft } from "@/server/sms-draft-proof";
import { normalizeSmsRecipient, SmsWorkflowError } from "./sms-errors";
import { smsSender } from "./sms-channel";
import { loadSmsReplyContext } from "./sms-inbox";
export { normalizeSmsRecipient, SmsWorkflowError } from "./sms-errors";

type AdminClient = SupabaseClient<Database>;
type SmsRow = Database["public"]["Tables"]["motorist_sms_messages"]["Row"];
export const SMS_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
export type SmsTransportSendInput = { to: string; from?: string; body: string; idempotencyKey: string; organizationId: string };
export type SmsTransportSendResult = {
  providerMessageId: string | null;
  status: "queued" | "sent" | "failed";
  providerStatus?: string | null;
  fromSender?: string | null;
  messagingProfileId?: string | null;
};
export type SmsTransport = {
  send(input: SmsTransportSendInput): Promise<SmsTransportSendResult>;
  preflight?(input: { organizationId: string; to?: string }): Promise<void>;
};
export type SmsSendOptions = { transport?: SmsTransport };
export const notConfiguredTransport: SmsTransport = {
  async send() { throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503); },
};
export function resolveSmsTransport(): SmsTransport {
  return getTelnyxConfig().configured ? createTelnyxSmsTransport() : notConfiguredTransport;
}
export function validateSmsRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new SmsWorkflowError("Chýba platné ID požiadavky. Otvorte nový SMS koncept.", 400);
  }
}

export async function getSmsCaseContext(admin: AdminClient, organizationId: string, caseId: string) {
  const result = await admin.from("motorist_cases").select("*").eq("organization_id", organizationId).eq("id", caseId).maybeSingle();
  if (result.error) throw new SmsWorkflowError("Prípad sa nepodarilo načítať.");
  if (!result.data) throw new SmsWorkflowError("Prípad sa nenašiel.", 404);
  const caseRow = result.data;
  const contact = caseRow.contact_id
    ? await admin.from("motorist_contacts").select("*").eq("organization_id", organizationId).eq("id", caseRow.contact_id).maybeSingle()
    : null;
  if (contact?.error) throw new SmsWorkflowError("Kontakt sa nepodarilo načítať.");
  if (!contact?.data?.phone) throw new SmsWorkflowError("Uložený prípad nemá telefón klienta. Najprv uložte platný kontakt.", 400);
  return { caseRow, contact: contact.data, toNumber: normalizeSmsRecipient(contact.data.phone, "Telefón klienta") };
}

/** Read-only preparation: even the location token is not persisted until Send. */
export async function prepareSms(input: SmsPrepareInput & SmsActor & { publicBaseUrl: string }): Promise<SmsPreview> {
  validateSmsRequestId(input.requestId);
  for (const value of [input.caseId, input.toNumber, input.callbackNumber, input.towAddress, input.message, input.taskId, input.replyToMessageId]) {
    if (value != null && typeof value !== "string") throw new SmsWorkflowError("SMS obsahuje neplatné údaje.", 400);
  }
  if (input.template !== "custom" && !isSmsTemplateKey(input.template)) throw new SmsWorkflowError("Nepodporovaná SMS šablóna.", 400);
  if (!input.actorProfileId || !input.organizationId) throw new SmsWorkflowError("Odosielateľa sa nepodarilo overiť.", 403);
  const admin = createSupabaseAdminClient();
  const reply = input.replyToMessageId ? await loadSmsReplyContext(admin, input.organizationId, input.replyToMessageId) : null;
  if (reply && (input.template !== "custom" || input.taskId)) throw new SmsWorkflowError("Odpoveď pripravte ako vlastnú SMS v konverzácii.", 400);
  if (reply && ((input.caseId && input.caseId !== reply.row.case_id)
    || (input.toNumber && normalizeSmsRecipient(input.toNumber) !== reply.toNumber))) {
    throw new SmsWorkflowError("Príjemca alebo prípad nezodpovedá prijatej SMS.", 409);
  }
  const caseId = reply ? reply.row.case_id : input.caseId?.trim() || null;
  if (!caseId && input.template !== "custom") throw new SmsWorkflowError("Najprv vyberte a uložte prípad s platným kontaktom.", 400);
  const context = caseId && !reply ? await getSmsCaseContext(admin, input.organizationId, caseId) : null;
  const profile = await admin.from("motorist_organization_profiles").select("*").eq("organization_id", input.organizationId).maybeSingle();
  if (profile.error) throw new SmsWorkflowError("Nastavenia organizácie sa nepodarilo načítať.");
  if (input.taskId) {
    const task = await admin.from("motorist_case_tasks").select("id").eq("organization_id", input.organizationId).eq("case_id", caseId!).eq("id", input.taskId).maybeSingle();
    if (task.error || !task.data) throw new SmsWorkflowError("Úloha nepatrí k vybranému prípadu.", 400);
  }
  let taskId = input.taskId ?? null;
  if (!taskId && caseId && (input.template === "location_request" || input.template === "eta_update")) {
    const task = await admin.from("motorist_case_tasks").select("id").eq("organization_id", input.organizationId)
      .eq("case_id", caseId).eq("status", "open").ilike("title", input.template === "eta_update" ? "%ETA%" : "%lokaliza%SMS%")
      .order("created_at").limit(1).maybeSingle();
    if (task.error) throw new SmsWorkflowError("Úlohu prípadu sa nepodarilo načítať.");
    taskId = task.data?.id ?? null;
  }
  if (input.template === "eta_update" && input.technicianDeparted !== true) {
    throw new SmsWorkflowError("Potvrďte, že technik skutočne vyrazil. Výpočet trasy nestačí.", 400);
  }
  const config = getTelnyxConfig();
  const toNumber = reply?.toNumber ?? context?.toNumber ?? normalizeSmsRecipient(input.toNumber);
  const channel = smsSender(input.organizationId, toNumber);
  const locationToken = input.template === "location_request" ? createLocationShareToken().token : null;
  const templateContext = {
    caseNumber: context?.caseRow.case_number ?? "",
    brandName: profile.data?.brand_name || "Pomoc motoristom",
    callbackNumber: input.template === "custom" ? undefined : normalizeSmsRecipient(input.callbackNumber || profile.data?.primary_phone, "Kontaktný telefón"),
    etaMinutes: input.etaMinutes,
    towAddress: input.towAddress?.trim(),
    link: locationToken ? buildLocationShareUrl(input.publicBaseUrl, locationToken) : undefined,
    repliesEnabled: channel.repliesEnabled,
  };
  let message: string;
  try {
    message = validateCustomSmsDraft({ toNumber, message: input.template === "custom" ? input.message : renderSmsTemplate(input.template, templateContext) }).message;
  } catch (error) { throw new SmsWorkflowError(error instanceof Error ? error.message : "Skontrolujte údaje SMS.", 400); }
  // JSON round-trip gives the proof exactly the same shape the browser receives.
  const draft: PreparedSms = JSON.parse(JSON.stringify({
    version: 1, requestId: input.requestId, organizationId: input.organizationId, actorProfileId: input.actorProfileId,
    caseId, contactId: context?.contact.id ?? null, caseNumber: reply?.caseNumber ?? context?.caseRow.case_number ?? null,
    recipientName: reply ? "Odosielateľ prijatej SMS" : context?.contact.name ?? "Ručne zadaný príjemca", toNumber, template: input.template, templateContext, message,
    ...channel, replyToMessageId: reply?.row.id ?? null,
    messagingProfileId: config.configured ? config.messagingProfileId : null,
    locationToken, locationLinkId: locationToken ? randomUUID() : null, taskId,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  return { draft, proof: signSmsDraft(draft) };
}

export type SendPreparedSmsInput = SmsActor & SmsPreview & { message: string };
export async function sendPreparedSms(input: SendPreparedSmsInput, options: SmsSendOptions = {}) {
  const { draft } = input;
  if (!draft || typeof input.proof !== "string" || !verifySmsDraft(draft, input.proof)
    || draft.organizationId !== input.organizationId || draft.actorProfileId !== input.actorProfileId) {
    throw new SmsWorkflowError("SMS náhľad sa nepodarilo overiť. Pripravte ho znovu.", 403);
  }
  validateSmsRequestId(draft.requestId);
  let body: string;
  try {
    body = validateCustomSmsDraft({ message: input.message, toNumber: draft.toNumber }).message;
    if (draft.template !== "custom") validateTemplateMessage(draft.template, draft.templateContext, body);
  } catch (error) { throw new SmsWorkflowError(error instanceof Error ? error.message : "Text SMS nie je platný.", 400); }
  const idempotencyKey = `sms:${input.actorProfileId}:${draft.requestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify({ draft, body })).digest("hex");
  const admin = createSupabaseAdminClient();
  const existing = await findRequest(admin, input.organizationId, idempotencyKey);
  // Retry consults the durable row even if the preview expired or the contact changed.
  if (existing) return reuse(existing, fingerprint);
  if (Date.parse(draft.expiresAt) <= Date.now()) throw new SmsWorkflowError("Platnosť náhľadu vypršala. Pripravte ho znovu.", 409);
  if (draft.replyToMessageId) {
    const reply = await loadSmsReplyContext(admin, input.organizationId, draft.replyToMessageId);
    if (reply.toNumber !== draft.toNumber || reply.row.to_number !== draft.sender || reply.row.case_id !== draft.caseId
      || reply.caseNumber !== draft.caseNumber || reply.row.messaging_profile_id !== draft.messagingProfileId) {
      throw new SmsWorkflowError("Priradenie prijatej SMS sa zmenilo. Pripravte nový náhľad.", 409);
    }
  } else if (draft.caseId) {
    const current = await getSmsCaseContext(admin, input.organizationId, draft.caseId);
    if (current.contact.id !== draft.contactId || current.toNumber !== draft.toNumber
      || current.caseRow.case_number !== draft.caseNumber || current.contact.name !== draft.recipientName) {
      throw new SmsWorkflowError("Kontakt prípadu sa zmenil. Skontrolujte nový náhľad; SMS nebola odoslaná.", 409);
    }
  }
  const config = getTelnyxConfig();
  const channel = smsSender(input.organizationId, draft.toNumber);
  if (config.configured && (draft.sender !== channel.sender || draft.messagingProfileId !== config.messagingProfileId
    || Boolean(draft.repliesEnabled) !== channel.repliesEnabled || Boolean(draft.repliesPendingVerification) !== channel.repliesPendingVerification)) {
    throw new SmsWorkflowError("SMS kanál sa zmenil. Pripravte nový náhľad.", 409);
  }
  const transport = options.transport ?? resolveSmsTransport();
  if (transport === notConfiguredTransport) throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503);
  await transport.preflight?.({ organizationId: input.organizationId, to: draft.toNumber });
  const now = new Date().toISOString();
  const locationExpiresAt = draft.locationToken ? new Date(Date.now() + 24 * 3600_000).toISOString() : null;
  const inserted = await admin.from("motorist_sms_messages").insert({
    organization_id: input.organizationId, provider: "telnyx_sms", case_id: draft.caseId, call_id: null,
    to_number: draft.toNumber, from_label: draft.sender, from_sender: draft.sender, messaging_profile_id: draft.messagingProfileId,
    direction: "outbound", status: "queued", status_detail: "sending_to_provider", template_key: draft.template, body,
    raw_payload: {
      actor_profile_id: input.actorProfileId, recipient_name: draft.recipientName, case_number: draft.caseNumber,
      template_version: SMS_TEMPLATE_VERSION, template_context: draft.templateContext as Json, source: "sms_composer",
      task_id: draft.taskId, location_link_id: draft.locationLinkId, location_link_expires_at: locationExpiresAt,
      encoding: smsSegments(body).encoding, segments: smsSegments(body).segments,
      reply_to_message_id: draft.replyToMessageId ?? null,
    },
    idempotency_key: idempotencyKey, request_fingerprint: fingerprint, queued_at: now, next_attempt_at: null, retry_count: 0,
  }).select("*").single();
  if (inserted.error?.code === "23505") {
    const winner = await findRequest(admin, input.organizationId, idempotencyKey);
    if (winner) return reuse(winner, fingerprint);
  }
  if (inserted.error || !inserted.data) throw new SmsWorkflowError("Požiadavku sa nepodarilo uložiť. Zopakujte tú istú požiadavku.");
  const row = inserted.data;
  // Only the winner of the unique insert may create a link and contact Telnyx.
  try {
    if (draft.locationToken && draft.locationLinkId && draft.caseId) {
      const link = await admin.from("motorist_location_share_links").insert({
        id: draft.locationLinkId, organization_id: input.organizationId, case_id: draft.caseId,
        scope: "pickup_location", token_hash: hashLocationShareToken(draft.locationToken), status: "active",
        expires_at: locationExpiresAt!, created_by: input.actorProfileId,
        metadata: { source: "sms_location_request", task_id: draft.taskId, sms_message_id: row.id },
      });
      if (link.error) throw new SmsWorkflowError("Lokalizačný link sa nepodarilo uložiť. SMS nebola odoslaná.", 400);
    }
    const attempt = await admin.from("motorist_sms_attempts").insert({
      organization_id: input.organizationId, sms_message_id: row.id, provider: "telnyx_sms", attempt_number: 1,
      claim_id: randomUUID(), idempotency_key: idempotencyKey, request_fingerprint: fingerprint,
      status: "sending", started_at: now, request_payload_safe: { to_number: draft.toNumber, body_length: body.length },
    }).select("id").single();
    if (attempt.error || !attempt.data) throw new SmsWorkflowError("Pokus sa nepodarilo uložiť. SMS nebola odoslaná.", 400);
  } catch (error) {
    await finishFailure(admin, row, error, false);
    return { ...resultFromRow(row), status: "failed" as const, statusDetail: "send_failed" };
  }
  let delivery: SmsTransportSendResult;
  try {
    delivery = await transport.send({ to: draft.toNumber, from: draft.sender, body, idempotencyKey, organizationId: input.organizationId });
  } catch (error) {
    const uncertain = !(error instanceof SmsWorkflowError && [400, 401, 403, 404, 422, 423, 429].includes(error.status));
    await finishFailure(admin, row, error, uncertain);
    return { ...resultFromRow(row), status: uncertain ? "sent" as const : "failed" as const, statusDetail: uncertain ? "send_unconfirmed" : "send_failed" };
  }
  const finishedAt = new Date().toISOString();
  const statusDetail = delivery.providerStatus ?? (delivery.status === "sent" ? "sent_to_provider" : delivery.status === "queued" ? "queued_at_provider" : "send_failed");
  const update = await admin.from("motorist_sms_messages").update({
    status: delivery.status, status_detail: statusDetail, provider_message_id: delivery.providerMessageId,
    from_sender: delivery.fromSender ?? draft.sender, messaging_profile_id: delivery.messagingProfileId ?? draft.messagingProfileId,
    error: delivery.status === "failed" ? "Poskytovateľ SMS správu neprijal." : null,
    last_attempt_at: finishedAt, sent_at: delivery.status === "sent" ? finishedAt : null,
  }).eq("id", row.id).eq("status_detail", "sending_to_provider");
  if (update.error) throw new SmsWorkflowError("Výsledok odoslania sa nepodarilo uložiť. Overte históriu; nevytvárajte ďalšiu SMS.");
  const attemptUpdate = await admin.from("motorist_sms_attempts").update({
    status: delivery.status === "failed" ? "failed" : "accepted", provider_message_id: delivery.providerMessageId,
    finished_at: finishedAt, provider_response_safe: { status: delivery.status, provider_status: statusDetail },
  }).eq("sms_message_id", row.id).eq("organization_id", input.organizationId);
  if (attemptUpdate.error) console.error("SMS attempt audit update failed", { smsMessageId: row.id });
  if (draft.caseId) {
    const event = await admin.from("motorist_case_events").insert({
      organization_id: input.organizationId, case_id: draft.caseId, actor_profile_id: input.actorProfileId,
      event_type: "sms_sent", title: "SMS požiadavka spracovaná", body,
      payload: { sms_message_id: row.id, template: draft.template, status_detail: statusDetail, location_link_id: draft.locationLinkId },
    });
    if (event.error) console.error("SMS timeline audit failed", { smsMessageId: row.id });
    if (draft.template === "eta_update" && delivery.status !== "failed" && draft.taskId) {
      await admin.from("motorist_case_tasks").update({ status: "done" }).eq("organization_id", input.organizationId).eq("case_id", draft.caseId).eq("id", draft.taskId);
    }
  }
  return { providerMessageId: delivery.providerMessageId, smsMessageId: row.id, status: delivery.status, statusDetail, reused: false };
}

async function finishFailure(admin: AdminClient, row: SmsRow, error: unknown, uncertain: boolean) {
  const errorMessage = error instanceof Error ? error.message : "Odoslanie zlyhalo.";
  const now = new Date().toISOString();
  const result = await admin.from("motorist_sms_messages").update({
    status: uncertain ? "sent" : "failed", status_detail: uncertain ? "send_unconfirmed" : "send_failed",
    error: errorMessage, last_attempt_at: now,
  }).eq("id", row.id).eq("status_detail", "sending_to_provider");
  if (result.error) throw new SmsWorkflowError("Výsledok je nejasný. Overte históriu a neopakujte odoslanie ako novú SMS.");
  await admin.from("motorist_sms_attempts").update({ status: "failed", error: errorMessage, finished_at: now,
    error_class: uncertain ? "SendUnconfirmed" : "SendRejected" }).eq("sms_message_id", row.id);
  if (!uncertain) {
    const payload = row.raw_payload as Record<string, Json>;
    if (typeof payload?.location_link_id === "string") {
      await admin.from("motorist_location_share_links").update({ status: "revoked", revoked_at: now })
        .eq("organization_id", row.organization_id).eq("id", payload.location_link_id).eq("status", "active");
    }
  }
}
async function findRequest(admin: AdminClient, organizationId: string, key: string) {
  const found = await admin.from("motorist_sms_messages").select("*").eq("organization_id", organizationId).eq("provider", "telnyx_sms").eq("idempotency_key", key).maybeSingle();
  if (found.error) throw new SmsWorkflowError("Históriu požiadavky sa nepodarilo overiť. SMS nebola znova odoslaná.");
  return found.data;
}
function reuse(row: SmsRow, fingerprint: string) {
  if (row.request_fingerprint !== fingerprint) throw new SmsWorkflowError("Toto ID už patrí inému textu alebo príjemcovi. Skontrolujte históriu.", 409);
  return { ...resultFromRow(row), reused: true };
}
function resultFromRow(row: SmsRow) {
  return { providerMessageId: row.provider_message_id ?? null, smsMessageId: row.id, status: row.status, statusDetail: row.status_detail, reused: false };
}

// Both HTTP entry points use the same signed context, actor, roles and retry policy.
export const sendCustomSms = sendPreparedSms;
export async function sendCaseSms(input: SendPreparedSmsInput & { caseId: string }, options: SmsSendOptions = {}) {
  if (!input.caseId?.trim()) throw new SmsWorkflowError("Chýba prípad.", 400);
  if (input.draft?.caseId !== input.caseId) throw new SmsWorkflowError("Náhľad patrí inému prípadu.", 400);
  return sendPreparedSms(input, options);
}
