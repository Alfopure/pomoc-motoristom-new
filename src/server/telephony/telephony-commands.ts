import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";
import type { Database, Json } from "@/lib/supabase/database.types";
import { buildDtmfTransferPlan, type DtmfTransferMode } from "@/lib/telephony/dtmf-transfer";
import { sameDialNumber } from "@/lib/telephony/phone";
import { MutationError } from "@/server/motorist-mutations";
import { providerCallUsesExtension } from "./provider-call-state";
import {
  parseAssignmentGuard,
  releaseTerminalCommandAssignmentGuard,
  type TelephonyAssignmentGuard,
  withAssignmentGuard,
} from "./assignment-interlock";
import { assertTelephonyLiveMutationEnabled } from "./live-mutation-gate";
import {
  authorizeViptelMutationCommand,
  VIPTEL_LISTENER_MUTATION_COMMAND_TYPES,
  verifyViptelMutationCommandIntegrity,
} from "./mutation-command-authority";
import { isSystemFallbackRedirectPayload } from "./fallback-settings";

type BeginTelephonyCommandInput = {
  organizationId: string;
  requestedBy: string;
  commandType: TelephonyCommandType;
  requestPayload: Record<string, unknown>;
  idempotencyKey?: string;
  callId?: string;
  queueId?: string;
  extensionId?: string;
  initialStatus?: "queued" | "accepted";
  uniqueConflictMessage?: string;
  assignmentGuard?: TelephonyAssignmentGuard;
  /** Server-only queue fallback; never accepted from a browser request. */
  systemFallback?: boolean;
};

type TelephonyCommandRow = Database["public"]["Tables"]["motorist_telephony_commands"]["Row"];

const DTMF_INTENT_ACTION = "telephony.command.browser_dtmf.intent";
const DTMF_DELIVERY_ACTION = "telephony.command.browser_dtmf.delivery";
const DTMF_AUDIT_SCHEMA_VERSION = 1;
const DTMF_AUDIT_SCAN_LIMIT = 100;
const BROWSER_SIP_INVITE_NOT_SENT = "browser_sip_invite_not_sent";
const BROWSER_SIP_RECONCILED_NO_CALL = "browser_sip_reconciled_no_call";
const BROWSER_SIP_RECONCILED_PROVIDER_CALL = "browser_sip_reconciled_provider_call";
const BROWSER_SIP_CONFIRMATION_TIMEOUT = "provider_confirmation_timeout";
const BROWSER_SIP_RECONCILIATION_WINDOW_MS = 2 * 60_000;

type DtmfIntentProof = {
  schemaVersion: 1;
  intentId: string;
  commandId: string;
  organizationId: string;
  requestedBy: string;
  callId: string;
  extensionId: string;
  authorizedViptelUniqueId: string;
  destination: string;
  mode: DtmfTransferMode;
  toneCount: number;
  tonePlanHash: string;
  parentIntentId: string | null;
  assignmentGuard: TelephonyAssignmentGuard;
  requestedAt: string;
};

type DtmfDeliveryProof = {
  schemaVersion: 1;
  intentId: string;
  commandId: string;
  organizationId: string;
  requestedBy: string;
  callId: string;
  extensionId: string;
  delivery: Record<string, unknown>;
};

export type PendingTelephonyCommand = {
  id: string;
  idempotencyKey: string;
};

export type TelephonyCommandType =
  | "call.create"
  | "call.hangup"
  | "call.redirect"
  | "call.transfer.dtmf"
  | "call.transfer.sip_refer"
  | "queue.add"
  | "queue.remove"
  | "queue.pause"
  | "queue.unpause";

export async function beginTelephonyCommand(
  input: BeginTelephonyCommandInput,
): Promise<PendingTelephonyCommand> {
  assertTelephonyLiveMutationEnabled(input.commandType);
  const systemFallback = input.systemFallback === true &&
    input.commandType === "call.redirect" &&
    !input.extensionId &&
    isSystemFallbackRedirectPayload(input.requestPayload);
  if (input.systemFallback === true && !systemFallback) {
    throw new MutationError("Záložné presmerovanie nemá platný serverový príkaz.", 409);
  }
  const assignmentGuard = callCommandType(input.commandType) && !systemFallback
    ? requiredAssignmentGuard(input)
    : input.assignmentGuard ? requiredAssignmentGuard(input) : undefined;
  const requestPayload = assignmentGuard
    ? withAssignmentGuard(input.requestPayload, assignmentGuard)
    : input.requestPayload;
  // VIPTel's call_random_id accepts at most 64 alphanumeric characters. Using
  // one compact value for both the DB uniqueness guard and provider
  // correlation makes call.create safe to match without exposing DB ids.
  const commandId = randomUUID();
  const idempotencyKey = input.idempotencyKey ?? randomUUID().replaceAll("-", "");
  const storedRequestPayload = (VIPTEL_LISTENER_MUTATION_COMMAND_TYPES as readonly string[]).includes(input.commandType)
    ? authorizeViptelMutationCommand({
        callId: input.callId,
        commandId,
        commandType: input.commandType,
        executionTarget: input.initialStatus === "accepted"
          ? "event_correlation_only"
          : input.commandType.startsWith("queue.") ? "listener_rest" : "listener_websocket",
        extensionId: input.extensionId,
        idempotencyKey,
        organizationId: input.organizationId,
        queueId: input.queueId,
        requestPayload,
        requestedBy: input.requestedBy,
      }).requestPayload
    : toJson(requestPayload);
  const client = createSupabaseAdminClient();
  const result = await client
    .from("motorist_telephony_commands")
    .insert({
      id: commandId,
      organization_id: input.organizationId,
      provider: "viptel",
      command_type: input.commandType,
      requested_by: input.requestedBy,
      call_id: input.callId ?? null,
      queue_id: input.queueId ?? null,
      extension_id: input.extensionId ?? null,
      request_payload: storedRequestPayload,
      status: input.initialStatus ?? "queued",
      sent_at: input.initialStatus === "accepted" ? new Date().toISOString() : null,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();

  if (result.error || !result.data) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, requestPayload);
    if (result.error && input.uniqueConflictMessage && isUniqueViolation(result.error)) {
      throw new MutationError(input.uniqueConflictMessage, 409);
    }
    throw new Error(`Telephony command audit could not be created: ${result.error?.message ?? "no row returned"}`);
  }

  return { id: result.data.id, idempotencyKey };
}

export type BeginBrowserDtmfTransferIntentInput = {
  organizationId: string;
  requestedBy: string;
  callId: string;
  extensionId: string;
  authorizedViptelUniqueId: string;
  destination: string;
  mode: DtmfTransferMode;
  assignmentGuard: TelephonyAssignmentGuard;
};

export type BrowserDtmfTransferDeliveryReport =
  | {
      outcome: "complete";
    }
  | {
      outcome: "failed";
      sentToneCount: 0;
      failedToneIndex: 0;
      error?: string;
    }
  | {
      outcome: "partial";
      sentToneCount: number;
      error?: string;
    };

export async function beginBrowserDtmfTransferIntent(
  input: BeginBrowserDtmfTransferIntentInput,
): Promise<PendingTelephonyCommand & { authorizedViptelUniqueId: string; tonePlan: string[] }> {
  if (!isUuid(input.extensionId)) {
    throw new MutationError("Osobná klapka nemá platný identifikátor.", 400);
  }
  const authorizedViptelUniqueId = requiredProviderUniqueId(input.authorizedViptelUniqueId);
  let plan: ReturnType<typeof buildDtmfTransferPlan>;
  try {
    plan = buildDtmfTransferPlan(input.mode, input.destination);
  } catch (error) {
    throw new MutationError(error instanceof Error ? error.message : "Cieľ prepojenia nie je platný.", 400);
  }

  assertTelephonyLiveMutationEnabled("call.transfer.dtmf");
  const supabase = createSupabaseAdminClient();
  const chain = await loadImmutableDtmfChain(
    supabase,
    input.organizationId,
    input.callId,
    input.extensionId,
  );
  const latestIntent = chain.intents.at(-1);
  const latestDelivery = latestIntent ? chain.deliveries.get(latestIntent.intentId) : undefined;
  if (latestIntent && (
    latestIntent.extensionId !== input.extensionId ||
    latestIntent.requestedBy !== input.requestedBy ||
    !isRetryableImmutableZeroToneFailure(latestDelivery)
  )) {
    throw new MutationError(
      "Pre tento hovor už existuje prepojenie bez bezpečne potvrdenej možnosti opakovania.",
      409,
    );
  }

  const fenceParent = latestIntent?.intentId ?? "root";
  const idempotencyKey = deterministicCommandFence("browser-dtmf-transfer", [
    input.callId,
    input.extensionId,
    authorizedViptelUniqueId,
    fenceParent,
  ]);
  const requestedAt = new Date().toISOString();
  const command = await beginTelephonyCommand({
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    callId: input.callId,
    extensionId: input.extensionId,
    commandType: "call.transfer.dtmf",
    assignmentGuard: input.assignmentGuard,
    idempotencyKey,
    initialStatus: "accepted",
    uniqueConflictMessage: "Súbežná požiadavka už vytvorila pokus o prepojenie pre tento hovor.",
    requestPayload: {
      destination: plan.target,
      authorizedViptelUniqueId,
      mode: plan.mode,
      toneCount: plan.tones.length,
      requestedAt,
      transport: "browser_dtmf",
      confirmationModel: "unconfirmed",
      autoRetryAllowed: false,
    },
  });
  const intent: DtmfIntentProof = {
    schemaVersion: DTMF_AUDIT_SCHEMA_VERSION,
    intentId: command.id,
    commandId: command.id,
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    callId: input.callId,
    extensionId: input.extensionId,
    authorizedViptelUniqueId,
    destination: plan.target,
    mode: plan.mode,
    toneCount: plan.tones.length,
    tonePlanHash: deterministicCommandFence("browser-dtmf-tone-plan", plan.tones),
    parentIntentId: latestIntent?.intentId ?? null,
    assignmentGuard: requiredDtmfAssignmentGuard(input.assignmentGuard, input.extensionId, input.requestedBy),
    requestedAt,
  };
  await insertImmutableDtmfIntent(supabase, intent);
  return { ...command, authorizedViptelUniqueId, tonePlan: plan.tones };
}

export async function recordBrowserDtmfTransferDelivery(input: {
  callId: string;
  commandId: string;
  organizationId: string;
  requestedBy: string;
  report: BrowserDtmfTransferDeliveryReport;
}) {
  const supabase = createSupabaseAdminClient();
  const existing = await supabase
    .from("motorist_telephony_commands")
    .select("id, organization_id, requested_by, call_id, extension_id, command_type, status, provider_response, request_payload, updated_at")
    .eq("id", input.commandId)
    .eq("organization_id", input.organizationId)
    .eq("provider", "viptel")
    .eq("command_type", "call.transfer.dtmf")
    .eq("call_id", input.callId)
    .eq("requested_by", input.requestedBy)
    .maybeSingle();

  if (existing.error) {
    throw new MutationError("Audit prepojenia sa nepodarilo načítať.", 500);
  }
  if (!existing.data) {
    throw new MutationError("Audit prepojenia sa nenašiel alebo patrí inému používateľovi.", 404);
  }
  const requestPayload = jsonRecord(existing.data.request_payload);
  const chain = await loadImmutableDtmfChain(
    supabase,
    input.organizationId,
    input.callId,
    readUuidValue(existing.data.extension_id, "Osobná klapka"),
  );
  const intent = chain.intents.find((candidate) => candidate.commandId === input.commandId);
  if (!intent || !commandMatchesImmutableDtmfIntent(existing.data, requestPayload, intent)) {
    throw new MutationError("Uložený DTMF príkaz nezodpovedá nemennému serverovému zámeru.", 409);
  }
  const plannedToneCount = intent.toneCount;
  const mode = intent.mode;

  const report = input.report;
  validateDtmfDeliveryReport(report, plannedToneCount);
  const attemptedAt = new Date().toISOString();
  const delivery = report.outcome === "complete"
    ? {
        outcome: report.outcome,
        sentToneCount: plannedToneCount,
        totalToneCount: plannedToneCount,
        deliveryUncertain: false,
        confirmationModel: "unconfirmed",
        autoRetryAllowed: false,
        attemptedAt,
      }
    : report.outcome === "failed"
      ? {
          outcome: report.outcome,
          sentToneCount: 0,
          totalToneCount: plannedToneCount,
          failedToneIndex: 0,
          deliveryUncertain: false,
          confirmationModel: "unconfirmed",
          autoRetryAllowed: true,
          error: safeDeliveryText(report.error),
          attemptedAt,
        }
      : {
          outcome: report.outcome,
          sentToneCount: report.sentToneCount,
          totalToneCount: plannedToneCount,
          failedToneIndex: report.sentToneCount,
          deliveryUncertain: true,
          confirmationModel: "unconfirmed",
          autoRetryAllowed: false,
          recoveryInstruction: recoveryInstruction(mode),
          error: safeDeliveryText(report.error),
          attemptedAt,
        };
  const immutableDelivery = chain.deliveries.get(intent.intentId);
  if (immutableDelivery) {
    if (!sameDtmfDelivery(immutableDelivery.delivery, delivery)) {
      throw new MutationError("Výsledok tohto prepojenia už bol nemenne zaznamenaný.", 409);
    }
  }

  const nextStatus = report.outcome === "failed" ? "failed" : "accepted";
  const deliveryUncertain = report.outcome === "partial";
  const deliveryProof: DtmfDeliveryProof = {
    schemaVersion: DTMF_AUDIT_SCHEMA_VERSION,
    intentId: intent.intentId,
    commandId: intent.commandId,
    organizationId: intent.organizationId,
    requestedBy: intent.requestedBy,
    callId: intent.callId,
    extensionId: intent.extensionId,
    delivery,
  };
  const persistedDelivery = immutableDelivery ?? await insertImmutableDtmfDelivery(supabase, deliveryProof);
  if (!sameDtmfDelivery(persistedDelivery.delivery, delivery)) {
    throw new MutationError("Súbežná požiadavka zapísala iný nemenný výsledok prepojenia.", 409);
  }
  const updated = await supabase
    .from("motorist_telephony_commands")
    .update({
      provider_response: toJson({
        autoRetryAllowed: report.outcome === "failed",
        browserDtmfDelivery: delivery,
        deliveryUncertain,
        error: report.outcome === "complete" ? undefined : safeDeliveryText(report.error),
      }),
      status: nextStatus,
    })
    .eq("id", existing.data.id)
    .eq("status", "accepted")
    .eq("updated_at", existing.data.updated_at)
    .select("id, status, provider_response")
    .maybeSingle();

  if (updated.error) {
    throw new MutationError("Výsledok DTMF prepojenia sa uložil do auditu, ale príkaz sa nepodarilo uzavrieť. Zopakuj potvrdenie.", 500);
  }
  await releaseTerminalCommandAssignmentGuard(supabase, input.organizationId, requestPayload);
  if (!updated.data) {
    return { id: existing.data.id, status: nextStatus };
  }

  return updated.data;
}

export type BeginBrowserSipReferTransferIntentInput = {
  organizationId: string;
  requestedBy: string;
  callId: string;
  extensionId: string;
  authorizedViptelUniqueId: string;
  destination: string;
  destinationKind: "operator" | "phone";
  destinationExtensionId?: string;
  destinationLifecycleEpoch?: string;
  destinationProfileId?: string;
  assignmentGuard: TelephonyAssignmentGuard;
};

export async function beginBrowserSipReferTransferIntent(
  input: BeginBrowserSipReferTransferIntentInput,
): Promise<PendingTelephonyCommand & { authorizedTarget: string; authorizedViptelUniqueId: string }> {
  const authorizedViptelUniqueId = requiredProviderUniqueId(input.authorizedViptelUniqueId);
  const authorizedTarget = numericCommandEndpoint(input.destination);
  if (!authorizedTarget || !isUuid(input.extensionId)) {
    throw new MutationError("SIP prepojenie nemá platný zdroj alebo cieľ.", 400);
  }
  const command = await beginTelephonyCommand({
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    callId: input.callId,
    extensionId: input.extensionId,
    commandType: "call.transfer.sip_refer",
    assignmentGuard: input.assignmentGuard,
    initialStatus: "accepted",
    requestPayload: {
      authorizedViptelUniqueId,
      destination: authorizedTarget,
      destinationKind: input.destinationKind,
      destinationExtensionId: input.destinationExtensionId,
      destinationLifecycleEpoch: input.destinationLifecycleEpoch,
      destinationProfileId: input.destinationProfileId,
      requestedAt: new Date().toISOString(),
      transport: "browser_sip_refer",
      confirmationModel: "sip_final_response",
      autoRetryAllowed: false,
    },
  });
  return { ...command, authorizedTarget, authorizedViptelUniqueId };
}

export type BrowserSipReferDeliveryReport =
  | { outcome: "accepted"; sipStatus: number }
  | { outcome: "failed"; error?: string };

export async function recordBrowserSipReferTransferDelivery(input: {
  callId: string;
  commandId: string;
  organizationId: string;
  requestedBy: string;
  report: BrowserSipReferDeliveryReport;
}) {
  const supabase = createSupabaseAdminClient();
  const existing = await supabase
    .from("motorist_telephony_commands")
    .select("id, organization_id, requested_by, call_id, extension_id, command_type, status, provider_response, request_payload, updated_at")
    .eq("id", input.commandId)
    .eq("organization_id", input.organizationId)
    .eq("provider", "viptel")
    .eq("command_type", "call.transfer.sip_refer")
    .eq("call_id", input.callId)
    .eq("requested_by", input.requestedBy)
    .maybeSingle();
  if (existing.error) throw new MutationError("Audit SIP prepojenia sa nepodarilo načítať.", 500);
  if (!existing.data) throw new MutationError("Audit SIP prepojenia sa nenašiel alebo patrí inému používateľovi.", 404);

  const requestPayload = jsonRecord(existing.data.request_payload);
  const guard = parseAssignmentGuard(requestPayload.assignmentGuard);
  const storedDestination = numericCommandEndpoint(requestPayload.destination);
  const storedProviderUniqueId = readProviderUniqueId(requestPayload.authorizedViptelUniqueId);
  if (
    requestPayload.transport !== "browser_sip_refer" ||
    !guard ||
    guard.extensionId !== existing.data.extension_id ||
    guard.profileId !== input.requestedBy ||
    !storedDestination ||
    !storedProviderUniqueId
  ) {
    throw new MutationError("Uložený SIP príkaz nezodpovedá autorizovanému prepojeniu.", 409);
  }
  if (existing.data.status === "confirmed_by_event" || existing.data.status === "failed") {
    return { id: existing.data.id, status: existing.data.status };
  }
  if (existing.data.status !== "accepted") {
    throw new MutationError("SIP prepojenie už nie je v stave, ktorý možno bezpečne uzavrieť.", 409);
  }

  const finishedAt = new Date().toISOString();
  const acceptedReport = input.report.outcome === "accepted" ? input.report : undefined;
  const failedReport = input.report.outcome === "failed" ? input.report : undefined;
  const sipStatus = acceptedReport &&
    Number.isInteger(acceptedReport.sipStatus) &&
    acceptedReport.sipStatus >= 200 &&
    acceptedReport.sipStatus < 300
    ? acceptedReport.sipStatus
    : undefined;
  if (acceptedReport && !sipStatus) throw new MutationError("SIP potvrdenie nemá platný finálny stav.", 400);
  const updated = await supabase
    .from("motorist_telephony_commands")
    .update({
      status: acceptedReport ? "confirmed_by_event" : "failed",
      confirmed_at: acceptedReport ? finishedAt : null,
      provider_response: toJson(acceptedReport
        ? {
            delivery: "browser_sip_refer",
            confirmation: "sip_final_response",
            sipStatus,
            confirmedAt: finishedAt,
          }
          : {
            delivery: "browser_sip_refer",
            deliveryUncertain: false,
            error: safeDeliveryText(failedReport?.error) ?? "SIP REFER nebol prijatý ústredňou.",
            failedAt: finishedAt,
          }),
    })
    .eq("id", existing.data.id)
    .eq("status", "accepted")
    .eq("updated_at", existing.data.updated_at)
    .select("id, status")
    .maybeSingle();
  if (updated.error) throw new MutationError("Výsledok SIP prepojenia sa nepodarilo uložiť.", 500);
  if (!updated.data) throw new MutationError("Súbežná požiadavka už zmenila výsledok SIP prepojenia.", 409);
  await releaseTerminalCommandAssignmentGuard(supabase, input.organizationId, requestPayload);
  return updated.data;
}

type TelephonyAdminClient = ReturnType<typeof createSupabaseAdminClient>;

async function loadImmutableDtmfChain(
  client: TelephonyAdminClient,
  organizationId: string,
  callId: string,
  extensionId: string,
) {
  const result = await client
    .from("motorist_audit_log")
    .select("id, action, after_payload, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_calls")
    .eq("entity_id", callId)
    .in("action", [DTMF_INTENT_ACTION, DTMF_DELIVERY_ACTION])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(DTMF_AUDIT_SCAN_LIMIT);
  if (result.error) {
    throw new MutationError("Nemennú históriu DTMF prepojenia sa nepodarilo overiť.", 500);
  }
  if ((result.data ?? []).length >= DTMF_AUDIT_SCAN_LIMIT) {
    throw new MutationError("História DTMF prepojenia prekročila bezpečný limit.", 409);
  }

  const intentsById = new Map<string, DtmfIntentProof>();
  const deliveries = new Map<string, DtmfDeliveryProof>();
  for (const row of result.data ?? []) {
    if (row.action === DTMF_INTENT_ACTION) {
      const intent = parseDtmfIntentProof(jsonRecord(row.after_payload).browser_dtmf_intent);
      if (
        !intent ||
        intent.organizationId !== organizationId ||
        intent.callId !== callId ||
        intent.extensionId !== extensionId ||
        intentsById.has(intent.intentId)
      ) {
        throw new MutationError("Nemenná história obsahuje neplatný DTMF zámer.", 409);
      }
      intentsById.set(intent.intentId, intent);
      continue;
    }
    if (row.action === DTMF_DELIVERY_ACTION) {
      const delivery = parseDtmfDeliveryProof(jsonRecord(row.after_payload).browser_dtmf_delivery);
      if (
        !delivery ||
        delivery.organizationId !== organizationId ||
        delivery.callId !== callId ||
        delivery.extensionId !== extensionId ||
        deliveries.has(delivery.intentId)
      ) {
        throw new MutationError("Nemenná história obsahuje neplatný DTMF výsledok.", 409);
      }
      deliveries.set(delivery.intentId, delivery);
    }
  }

  const ordered: DtmfIntentProof[] = [];
  let parent: string | null = null;
  while (ordered.length < intentsById.size) {
    const children = [...intentsById.values()].filter((intent) => intent.parentIntentId === parent);
    if (children.length !== 1) {
      throw new MutationError("Nemenné DTMF zámery netvoria jednoznačný pokusový reťazec.", 409);
    }
    const intent = children[0] as DtmfIntentProof;
    if (ordered.length > 0) {
      const previous = ordered.at(-1) as DtmfIntentProof;
      if (!isRetryableImmutableZeroToneFailure(deliveries.get(previous.intentId))) {
        throw new MutationError("Nemenný DTMF reťazec obsahuje neoprávnené opakovanie.", 409);
      }
    }
    ordered.push(intent);
    parent = intent.intentId;
  }
  for (const delivery of deliveries.values()) {
    const intent = intentsById.get(delivery.intentId);
    if (
      !intent ||
      delivery.commandId !== intent.commandId ||
      delivery.requestedBy !== intent.requestedBy ||
      delivery.extensionId !== intent.extensionId
    ) {
      throw new MutationError("Nemenný DTMF výsledok nepatrí k autorizovanému zámeru.", 409);
    }
  }
  return { deliveries, intents: ordered };
}

async function insertImmutableDtmfIntent(client: TelephonyAdminClient, intent: DtmfIntentProof) {
  const inserted = await client.from("motorist_audit_log").insert({
    id: deterministicAuditUuid(
      "browser-dtmf-intent",
      intent.organizationId,
      intent.callId,
      intent.parentIntentId ?? "root",
    ),
    organization_id: intent.organizationId,
    actor_profile_id: intent.requestedBy,
    action: DTMF_INTENT_ACTION,
    entity_type: "motorist_calls",
    entity_id: intent.callId,
    source: "web",
    after_payload: toJson({ browser_dtmf_intent: intent }),
  }).select("id").single();
  if (inserted.error) {
    if (isUniqueViolation(inserted.error)) {
      throw new MutationError("Súbežná požiadavka už autorizovala DTMF pokus pre tento hovor.", 409);
    }
    throw new MutationError("Nemenný DTMF zámer sa nepodarilo zapísať.", 500);
  }
  if (!inserted.data) throw new MutationError("Nemenný DTMF zámer sa po zápise nenašiel.", 500);
}

async function insertImmutableDtmfDelivery(
  client: TelephonyAdminClient,
  proof: DtmfDeliveryProof,
): Promise<DtmfDeliveryProof> {
  const inserted = await client.from("motorist_audit_log").insert({
    id: deterministicAuditUuid("browser-dtmf-delivery", proof.organizationId, proof.intentId),
    organization_id: proof.organizationId,
    actor_profile_id: proof.requestedBy,
    action: DTMF_DELIVERY_ACTION,
    entity_type: "motorist_calls",
    entity_id: proof.callId,
    source: "web",
    after_payload: toJson({ browser_dtmf_delivery: proof }),
  }).select("id").single();
  if (!inserted.error && inserted.data) return proof;
  if (!inserted.error) throw new MutationError("Nemenný DTMF výsledok sa po zápise nenašiel.", 500);
  if (!isUniqueViolation(inserted.error)) {
    throw new MutationError("Nemenný DTMF výsledok sa nepodarilo zapísať.", 500);
  }
  const chain = await loadImmutableDtmfChain(client, proof.organizationId, proof.callId, proof.extensionId);
  const existing = chain.deliveries.get(proof.intentId);
  if (!existing) throw new MutationError("Súbežný nemenný DTMF výsledok sa nepodarilo overiť.", 409);
  return existing;
}

function parseDtmfIntentProof(value: unknown): DtmfIntentProof | undefined {
  const record = jsonRecord(value);
  const guard = parseAssignmentGuard(record.assignmentGuard);
  const mode = record.mode === "blind" || record.mode === "attended" ? record.mode : undefined;
  const parentIntentId = record.parentIntentId === null ? null : readUuid(record.parentIntentId);
  const toneCount = readPositiveInteger(record.toneCount);
  if (
    record.schemaVersion !== DTMF_AUDIT_SCHEMA_VERSION ||
    !readUuid(record.intentId) ||
    record.commandId !== record.intentId ||
    !readUuid(record.organizationId) ||
    !readUuid(record.requestedBy) ||
    !readUuid(record.callId) ||
    !readUuid(record.extensionId) ||
    !readProviderUniqueId(record.authorizedViptelUniqueId) ||
    !readNumericEndpoint(record.destination) ||
    !mode ||
    !toneCount ||
    !readSha256(record.tonePlanHash) ||
    parentIntentId === undefined ||
    !guard ||
    guard.extensionId !== record.extensionId ||
    guard.profileId !== record.requestedBy ||
    !readIso(record.requestedAt)
  ) return undefined;
  const rebuilt = buildDtmfTransferPlan(mode, record.destination as string);
  if (
    rebuilt.tones.length !== toneCount ||
    deterministicCommandFence("browser-dtmf-tone-plan", rebuilt.tones) !== record.tonePlanHash
  ) return undefined;
  return record as DtmfIntentProof;
}

function parseDtmfDeliveryProof(value: unknown): DtmfDeliveryProof | undefined {
  const record = jsonRecord(value);
  const delivery = jsonRecord(record.delivery);
  if (
    record.schemaVersion !== DTMF_AUDIT_SCHEMA_VERSION ||
    !readUuid(record.intentId) ||
    record.commandId !== record.intentId ||
    !readUuid(record.organizationId) ||
    !readUuid(record.requestedBy) ||
    !readUuid(record.callId) ||
    !readUuid(record.extensionId) ||
    !validStoredDtmfDelivery(delivery)
  ) return undefined;
  return { ...(record as Omit<DtmfDeliveryProof, "delivery">), delivery };
}

function commandMatchesImmutableDtmfIntent(
  command: {
    id: string;
    organization_id: string;
    requested_by: string | null;
    call_id: string | null;
    extension_id: string | null;
    command_type: string;
  },
  request: Record<string, unknown>,
  intent: DtmfIntentProof,
) {
  const guard = parseAssignmentGuard(request.assignmentGuard);
  return command.id === intent.commandId &&
    command.organization_id === intent.organizationId &&
    command.requested_by === intent.requestedBy &&
    command.call_id === intent.callId &&
    command.extension_id === intent.extensionId &&
    command.command_type === "call.transfer.dtmf" &&
    request.authorizedViptelUniqueId === intent.authorizedViptelUniqueId &&
    request.destination === intent.destination &&
    request.mode === intent.mode &&
    request.toneCount === intent.toneCount &&
    request.requestedAt === intent.requestedAt &&
    request.transport === "browser_dtmf" &&
    guard !== undefined &&
    JSON.stringify(guard) === JSON.stringify(intent.assignmentGuard);
}

function requiredDtmfAssignmentGuard(
  value: TelephonyAssignmentGuard,
  extensionId: string,
  requestedBy: string,
) {
  const guard = parseAssignmentGuard(value);
  if (!guard || guard.extensionId !== extensionId || guard.profileId !== requestedBy) {
    throw new MutationError("DTMF zámer nemá platný assignment interlock.", 409);
  }
  return guard;
}

function isRetryableImmutableZeroToneFailure(proof: DtmfDeliveryProof | undefined) {
  const delivery = proof?.delivery;
  return delivery?.outcome === "failed" &&
    delivery.sentToneCount === 0 &&
    delivery.failedToneIndex === 0 &&
    delivery.deliveryUncertain === false &&
    delivery.autoRetryAllowed === true;
}

function validStoredDtmfDelivery(delivery: Record<string, unknown>) {
  const outcome = delivery.outcome;
  const sentToneCount = delivery.sentToneCount;
  const totalToneCount = readPositiveInteger(delivery.totalToneCount);
  if (!totalToneCount || !readIso(delivery.attemptedAt)) return false;
  if (outcome === "complete") return sentToneCount === totalToneCount && delivery.autoRetryAllowed === false;
  if (outcome === "failed") {
    return sentToneCount === 0 && delivery.failedToneIndex === 0 &&
      delivery.deliveryUncertain === false && delivery.autoRetryAllowed === true;
  }
  return outcome === "partial" && typeof sentToneCount === "number" &&
    Number.isInteger(sentToneCount) && sentToneCount > 0 && sentToneCount < totalToneCount &&
    delivery.failedToneIndex === sentToneCount && delivery.deliveryUncertain === true &&
    delivery.autoRetryAllowed === false;
}

export type BeginSerializedOutboundCallInput = {
  organizationId: string;
  requestedBy: string;
  extensionId: string;
  requestPayload: Record<string, unknown>;
  initialStatus?: "queued" | "accepted";
  assignmentGuard: TelephonyAssignmentGuard;
  providerActiveCalls: ViptelActiveCall[];
  providerSnapshotCapturedAt?: string;
};

/**
 * Serializes call.create per personal extension without a schema change.
 *
 * The read checks provide useful fail-closed diagnostics. The deterministic
 * unique key is the actual race fence: concurrent requests that observed the
 * same last terminal command (or no command at all) compete for one existing
 * (organization, provider, idempotency_key) slot.
 */
export async function beginSerializedOutboundCall(
  input: BeginSerializedOutboundCallInput,
): Promise<PendingTelephonyCommand> {
  if (!isUuid(input.extensionId)) {
    throw new MutationError("Osobná klapka nemá platný identifikátor.", 400);
  }
  assertTelephonyLiveMutationEnabled("call.create");

  const supabase = createSupabaseAdminClient();
  const callerExtension = numericCommandEndpoint(input.requestPayload.caller);
  if (!callerExtension) {
    throw new MutationError("Zdroj odchádzajúceho hovoru nie je platná osobná klapka.", 400);
  }
  if (input.providerActiveCalls.some((call) => providerCallUsesExtension(call, callerExtension))) {
    throw new MutationError("VIPTel už na osobnej klapke vedie aktívny hovor.", 409);
  }
  let activeCallQuery = supabase
    .from("motorist_calls")
    .select("id, status")
    .eq("organization_id", input.organizationId)
    .eq("provider", "viptel")
    .in("status", ["incoming", "ringing_agent", "answered", "outbound"])
    .is("ended_at", null)
    // The provider snapshot above is the authority on whether the extension is
    // genuinely busy; this stored-row check exists only to catch a call the
    // listener knows about that the snapshot has not caught up with yet. An
    // unbounded check let a single row that missed its terminal event block
    // outbound calls from that workstation forever.
    .gte("updated_at", new Date(Date.now() - 120_000).toISOString());
  activeCallQuery = callerExtension
    ? activeCallQuery.or([
        `extension_id.eq.${input.extensionId}`,
        `caller_extension.eq.${callerExtension}`,
        `received_extension.eq.${callerExtension}`,
        `destination_extension.eq.${callerExtension}`,
      ].join(","))
    : activeCallQuery.eq("extension_id", input.extensionId);

  const [activeCall, latestCommand] = await Promise.all([
    activeCallQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("motorist_telephony_commands")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("provider", "viptel")
      .eq("command_type", "call.create")
      .eq("extension_id", input.extensionId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (activeCall.error || latestCommand.error) {
    throw new MutationError("Stav osobnej klapky sa nepodarilo bezpečne overiť.", 500);
  }
  if (activeCall.data) {
    throw new MutationError("Na osobnej klapke už prebieha aktívny hovor.", 409);
  }
  if (latestCommand.data && !isTerminalCallCreateStatus(latestCommand.data.status)) {
    throw new MutationError("Na osobnej klapke už čaká odchádzajúci hovor.", 409);
  }
  if (
    latestCommand.data?.status === "failed" &&
    jsonRecord(latestCommand.data.provider_response).deliveryUncertain === true
  ) {
    if (!isRecoverableTimedOutBrowserSipCommand(
      latestCommand.data,
      input.organizationId,
      input.providerSnapshotCapturedAt,
    )) {
      throw new MutationError(
        "Predchádzajúci odchádzajúci hovor mohol byť odoslaný do VIPTel. Pred ďalším volaním treba stav manuálne zosúladiť.",
        409,
      );
    }
  }

  const fenceParent = latestCommand.data?.id ?? "root";
  const idempotencyKey = deterministicCommandFence("personal-extension-call-create", [
    input.extensionId,
    fenceParent,
  ]);

  return beginTelephonyCommand({
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    extensionId: input.extensionId,
    commandType: "call.create",
    assignmentGuard: input.assignmentGuard,
    requestPayload: input.requestPayload,
    initialStatus: input.initialStatus,
    idempotencyKey,
    uniqueConflictMessage: "Súbežná požiadavka už vytvorila odchádzajúci hovor na tejto klapke.",
  });
}

export async function recordUnsentBrowserSipInvite(input: {
  commandId: unknown;
  organizationId: string;
  requestedBy: string;
}) {
  const commandId = readUuidValue(input.commandId, "Audit odchádzajúceho hovoru");
  const client = createSupabaseAdminClient();
  const loadCommand = async () => {
    const result = await client
      .from("motorist_telephony_commands")
      .select("*")
      .eq("id", commandId)
      .eq("organization_id", input.organizationId)
      .eq("requested_by", input.requestedBy)
      .eq("provider", "viptel")
      .eq("command_type", "call.create")
      .maybeSingle();
    if (result.error) {
      throw new MutationError("Audit odchádzajúceho hovoru sa nepodarilo bezpečne načítať.", 500);
    }
    if (!result.data) {
      throw new MutationError("Audit odchádzajúceho hovoru sa nenašiel.", 404);
    }
    return result.data;
  };

  const command = await loadCommand();
  let authority: ReturnType<typeof verifyViptelMutationCommandIntegrity>;
  try {
    authority = verifyViptelMutationCommandIntegrity(command, input.organizationId);
  } catch {
    throw new MutationError("Audit odchádzajúceho hovoru nemá platnú bezpečnostnú autoritu.", 409);
  }
  const requestPayload = jsonRecord(command.request_payload);
  if (
    command.command_type !== "call.create" ||
    authority.executionTarget !== "event_correlation_only" ||
    requestPayload.transport !== "browser_sip"
  ) {
    throw new MutationError("Audit nepatrí priamemu hovoru z prehliadača.", 409);
  }

  if (isRecordedUnsentBrowserSipInvite(command.status, command.provider_response)) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, command.request_payload);
    return { id: command.id, status: "failed" as const };
  }
  if (command.status !== "accepted") {
    throw unsafeBrowserSipFailureRace(command.status, command.provider_response);
  }

  const update = await client
    .from("motorist_telephony_commands")
    .update({
      status: "failed",
      provider_response: toJson({
        deliveryUncertain: false,
        error: "Prehliadač potvrdil, že SIP INVITE nebol odoslaný.",
        reason: BROWSER_SIP_INVITE_NOT_SENT,
        stage: "before_invite_send",
      }),
    })
    .eq("id", commandId)
    .eq("organization_id", input.organizationId)
    .eq("requested_by", input.requestedBy)
    .eq("provider", "viptel")
    .eq("command_type", "call.create")
    .eq("status", "accepted")
    .select("id")
    .maybeSingle();
  if (update.error) {
    throw new MutationError("Neodoslaný hovor sa nepodarilo bezpečne uzavrieť.", 500);
  }
  if (update.data) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, command.request_payload);
    return { id: update.data.id, status: "failed" as const };
  }

  const racedCommand = await loadCommand();
  if (isRecordedUnsentBrowserSipInvite(racedCommand.status, racedCommand.provider_response)) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, racedCommand.request_payload);
    return { id: racedCommand.id, status: "failed" as const };
  }
  throw unsafeBrowserSipFailureRace(racedCommand.status, racedCommand.provider_response);
}

export type BrowserSipReconciliationReport = {
  outcome: "rejected" | "ended_before_answer";
  statusCode?: number;
};

export async function reconcileBrowserSipInvite(input: {
  browserReport?: unknown;
  commandId: unknown;
  organizationId: string;
  providerActiveCalls: ViptelActiveCall[];
  providerCapturedAt: unknown;
  requestedBy: string;
}) {
  const commandId = readUuidValue(input.commandId, "Audit odchádzajúceho hovoru");
  const browserReport = readBrowserSipReconciliationReport(input.browserReport);
  const providerCapturedAt = readIso(input.providerCapturedAt);
  if (!providerCapturedAt || !providerSnapshotIsFresh(providerCapturedAt)) {
    throw new MutationError("VIPTel stav pre obnovenie hovoru nie je dostatočne čerstvý.", 409);
  }
  const client = createSupabaseAdminClient();
  const loadCommand = async () => {
    const result = await client
      .from("motorist_telephony_commands")
      .select("*")
      .eq("id", commandId)
      .eq("organization_id", input.organizationId)
      .eq("requested_by", input.requestedBy)
      .eq("provider", "viptel")
      .eq("command_type", "call.create")
      .maybeSingle();
    if (result.error) {
      throw new MutationError("Audit odchádzajúceho hovoru sa nepodarilo bezpečne načítať.", 500);
    }
    if (!result.data) throw new MutationError("Audit odchádzajúceho hovoru sa nenašiel.", 404);
    return result.data;
  };

  const command = await loadCommand();
  const request = verifiedBrowserSipRequest(command, input.organizationId);
  if (command.status === "confirmed_by_event") {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, command.request_payload);
    return { id: command.id, status: "confirmed_by_event" as const };
  }
  if (isRecordedBrowserSipReconciliation(command.status, command.provider_response)) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, command.request_payload);
    return { id: command.id, status: "failed" as const, deliveryUncertain: false };
  }
  if (
    command.status !== "accepted" &&
    !isTimedOutUncertainBrowserSipCommand(command, input.organizationId)
  ) {
    throw unsafeBrowserSipFailureRace(command.status, command.provider_response);
  }

  const callerExtension = numericCommandEndpoint(request.caller);
  const destination = typeof request.destination === "string" && /^\d{1,18}$/.test(request.destination)
    ? request.destination
    : undefined;
  if (!callerExtension || !destination || !command.extension_id || !isUuid(command.extension_id)) {
    throw new MutationError("Audit odchádzajúceho hovoru nemá platné smerovanie.", 409);
  }
  if (input.providerActiveCalls.some((call) => providerCallUsesExtension(call, callerExtension))) {
    throw new MutationError(
      "VIPTel na pracovnom mieste stále eviduje aktívny hovor. Hovor zatiaľ neopakuj.",
      409,
    );
  }

  const activeCallQuery = client
    .from("motorist_calls")
    .select("id, status")
    .eq("organization_id", input.organizationId)
    .eq("provider", "viptel")
    .in("status", ["incoming", "ringing_agent", "answered", "outbound"])
    .or([
      `extension_id.eq.${command.extension_id}`,
      `caller_extension.eq.${callerExtension}`,
      `received_extension.eq.${callerExtension}`,
      `destination_extension.eq.${callerExtension}`,
    ].join(","));
  const reconciliationDeadline = browserSipReconciliationDeadline(
    command.created_at,
    providerCapturedAt,
  );
  const [activeCall, recentCalls] = await Promise.all([
    activeCallQuery.order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client
      .from("motorist_calls")
      .select("id, status, called_number, destination_number, created_at")
      .eq("organization_id", input.organizationId)
      .eq("provider", "viptel")
      .eq("direction", "outbound")
      .eq("caller_extension", callerExtension)
      .gte("created_at", command.created_at)
      .lte("created_at", reconciliationDeadline)
      .order("created_at", { ascending: true })
      .limit(5),
  ]);
  if (activeCall.error || recentCalls.error) {
    throw new MutationError("Hovory pracovného miesta sa nepodarilo bezpečne zosúladiť.", 500);
  }
  if (activeCall.data) {
    throw new MutationError(
      "Pracovné miesto stále eviduje aktívny hovor. Hovor zatiaľ neopakuj.",
      409,
    );
  }
  const recentProviderCall = (recentCalls.data ?? []).find((call) =>
    sameDialNumber(call.destination_number, destination) || sameDialNumber(call.called_number, destination),
  );
  const reconciledAt = new Date().toISOString();
  const next = recentProviderCall
    ? {
        call_id: recentProviderCall.id,
        confirmed_at: reconciledAt,
        provider_response: toJson({
          browserReport,
          confirmation: {
            callId: recentProviderCall.id,
            providerCapturedAt,
            source: BROWSER_SIP_RECONCILED_PROVIDER_CALL,
          },
          deliveryUncertain: false,
        }),
        status: "confirmed_by_event" as const,
      }
    : {
        provider_response: toJson({
          browserReport,
          deliveryUncertain: false,
          error: "Čerstvý VIPTel stav ani call log nepotvrdili nový odchádzajúci hovor.",
          providerCapturedAt,
          reason: BROWSER_SIP_RECONCILED_NO_CALL,
          reconciledAt,
        }),
        status: "failed" as const,
      };
  const updated = await client
    .from("motorist_telephony_commands")
    .update(next)
    .eq("id", command.id)
    .eq("organization_id", input.organizationId)
    .eq("requested_by", input.requestedBy)
    .eq("provider", "viptel")
    .eq("command_type", "call.create")
    .eq("updated_at", command.updated_at)
    .in("status", ["accepted", "failed"])
    .select("id, status")
    .maybeSingle();
  if (updated.error) {
    throw new MutationError("Zosúladený stav hovoru sa nepodarilo bezpečne uložiť.", 500);
  }
  if (updated.data) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, command.request_payload);
    return {
      id: updated.data.id,
      status: updated.data.status,
      ...(updated.data.status === "failed" ? { deliveryUncertain: false } : {}),
    };
  }

  const raced = await loadCommand();
  if (raced.status === "confirmed_by_event") {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, raced.request_payload);
    return { id: raced.id, status: "confirmed_by_event" as const };
  }
  if (isRecordedBrowserSipReconciliation(raced.status, raced.provider_response)) {
    await releaseTerminalCommandAssignmentGuard(client, input.organizationId, raced.request_payload);
    return { id: raced.id, status: "failed" as const, deliveryUncertain: false };
  }
  throw unsafeBrowserSipFailureRace(raced.status, raced.provider_response);
}

export async function acceptTelephonyCommand(
  command: PendingTelephonyCommand,
  providerResponse: unknown,
) {
  const result = await createSupabaseAdminClient()
    .from("motorist_telephony_commands")
    .update({
      provider_response: toJson(providerResponse),
      status: "accepted",
      sent_at: new Date().toISOString(),
    })
    .eq("id", command.id)
    .in("status", ["queued", "sent"])
    .select("status")
    .maybeSingle();

  if (result.error) {
    return { stored: true, status: "queued" as const, warning: result.error.message };
  }

  return result.data
    ? { stored: true, status: "accepted" as const }
    // An event can confirm a fast provider action before its REST response is
    // stored. Never regress confirmed_by_event back to accepted in that race.
    : { stored: true, status: "confirmed_by_event" as const };
}

export async function failTelephonyCommand(
  command: PendingTelephonyCommand,
  error: unknown,
) {
  const client = createSupabaseAdminClient();
  const result = await client
    .from("motorist_telephony_commands")
    .update({
      provider_response: toJson({
        error: error instanceof Error ? error.message : "VIPTel command failed.",
      }),
      status: "failed",
      sent_at: new Date().toISOString(),
    })
    .eq("id", command.id)
    .in("status", ["queued", "sent", "accepted"])
    .select("organization_id, request_payload")
    .maybeSingle();

  if (!result.error && result.data) {
    await releaseTerminalCommandAssignmentGuard(client, result.data.organization_id, result.data.request_payload);
  }

  return result.error
    ? { stored: true, status: "queued" as const, warning: result.error.message }
    : { stored: true, status: "failed" as const };
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function validateDtmfDeliveryReport(report: BrowserDtmfTransferDeliveryReport, plannedToneCount: number) {
  if (report.outcome === "failed" && (report.sentToneCount !== 0 || report.failedToneIndex !== 0)) {
    throw new MutationError("Zlyhanie pred prvým DTMF tónom musí mať nulový počet a index.", 400);
  }
  if (report.outcome === "partial") {
    if (!Number.isInteger(report.sentToneCount) || report.sentToneCount < 1 || report.sentToneCount >= plannedToneCount) {
      throw new MutationError("Čiastočné odoslanie DTMF tónov nemá platný index zlyhania.", 400);
    }
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function readUuid(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : undefined;
}

function readUuidValue(value: unknown, label: string) {
  const parsed = readUuid(value);
  if (!parsed) throw new MutationError(`${label} nemá platný identifikátor.`, 409);
  return parsed;
}

function readNumericEndpoint(value: unknown) {
  return typeof value === "string" && /^\d{1,16}$/.test(value) ? value : undefined;
}

function readProviderUniqueId(value: unknown) {
  return typeof value === "string" && /^[a-z0-9._:-]{1,128}$/i.test(value) ? value : undefined;
}

function requiredProviderUniqueId(value: unknown) {
  const uniqueId = readProviderUniqueId(value);
  if (!uniqueId) {
    throw new MutationError("VIPTel hovor nemá platnú bezpečnú identitu pre prepojenie.", 409);
  }
  return uniqueId;
}

function readSha256(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value : undefined;
}

function readIso(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
    ? value
    : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeDeliveryText(value: string | undefined, limit = 240) {
  const text = value?.trim();
  return text ? text.slice(0, limit) : undefined;
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 64 ? value : undefined;
}

function recoveryInstruction(mode: DtmfTransferMode) {
  return mode === "attended"
    ? "DTMF sekvenciu neopakujte. Overte, či je pôvodný volajúci alebo konzultačný hovor stále aktívny, a použite dohodnutý VIPTel návrat/zrušenie."
    : "DTMF sekvenciu neopakujte. Overte stav pôvodného hovoru vo VIPTel a pokračujte manuálnym bezpečným postupom operátora.";
}

function sameDtmfDelivery(existing: Record<string, unknown>, expected: Record<string, unknown>) {
  return existing.outcome === expected.outcome &&
    existing.sentToneCount === expected.sentToneCount &&
    existing.totalToneCount === expected.totalToneCount &&
    existing.failedToneIndex === expected.failedToneIndex;
}

function isTerminalCallCreateStatus(value: unknown) {
  return value === "failed" || value === "confirmed_by_event";
}

function isRecordedUnsentBrowserSipInvite(status: unknown, providerResponse: unknown) {
  const response = jsonRecord(providerResponse);
  return status === "failed" &&
    response.reason === BROWSER_SIP_INVITE_NOT_SENT &&
    response.deliveryUncertain === false;
}

function isRecordedBrowserSipReconciliation(status: unknown, providerResponse: unknown) {
  const response = jsonRecord(providerResponse);
  return status === "failed" &&
    response.reason === BROWSER_SIP_RECONCILED_NO_CALL &&
    response.deliveryUncertain === false;
}

function verifiedBrowserSipRequest(command: TelephonyCommandRow, organizationId: string) {
  let authority: ReturnType<typeof verifyViptelMutationCommandIntegrity>;
  try {
    authority = verifyViptelMutationCommandIntegrity(command, organizationId);
  } catch {
    throw new MutationError("Audit odchádzajúceho hovoru nemá platnú bezpečnostnú autoritu.", 409);
  }
  const request = jsonRecord(command.request_payload);
  if (
    command.command_type !== "call.create" ||
    authority.executionTarget !== "event_correlation_only" ||
    request.transport !== "browser_sip"
  ) {
    throw new MutationError("Audit nepatrí priamemu hovoru z prehliadača.", 409);
  }
  return request;
}

function isTimedOutUncertainBrowserSipCommand(
  command: TelephonyCommandRow,
  organizationId: string,
) {
  const response = jsonRecord(command.provider_response);
  if (
    command.status !== "failed" ||
    response.deliveryUncertain !== true ||
    response.reason !== BROWSER_SIP_CONFIRMATION_TIMEOUT
  ) {
    return false;
  }
  try {
    verifiedBrowserSipRequest(command, organizationId);
    return true;
  } catch {
    return false;
  }
}

function isRecoverableTimedOutBrowserSipCommand(
  command: TelephonyCommandRow,
  organizationId: string,
  providerSnapshotCapturedAt: string | undefined,
) {
  return Boolean(
    providerSnapshotCapturedAt &&
    providerSnapshotIsFresh(providerSnapshotCapturedAt) &&
    isTimedOutUncertainBrowserSipCommand(command, organizationId),
  );
}

function providerSnapshotIsFresh(value: string) {
  const capturedAt = Date.parse(value);
  const age = Date.now() - capturedAt;
  return Number.isFinite(capturedAt) && age >= -5_000 && age <= 10_000;
}

function browserSipReconciliationDeadline(commandCreatedAt: string, providerCapturedAt: string) {
  const createdAt = Date.parse(commandCreatedAt);
  const capturedAt = Date.parse(providerCapturedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(capturedAt)) {
    throw new MutationError("Audit odchádzajúceho hovoru nemá platné časové údaje.", 409);
  }
  return new Date(Math.min(capturedAt, createdAt + BROWSER_SIP_RECONCILIATION_WINDOW_MS)).toISOString();
}

export function readBrowserSipReconciliationReport(value: unknown): BrowserSipReconciliationReport {
  const report = jsonRecord(value);
  const outcome = report.outcome;
  if (outcome !== "rejected" && outcome !== "ended_before_answer") {
    throw new MutationError("Výsledok SIP hovoru nie je platný.", 400);
  }
  if (outcome === "ended_before_answer" && report.statusCode !== undefined) {
    throw new MutationError("Ukončený SIP hovor nesmie obsahovať stav odmietnutia.", 400);
  }
  if (
    report.statusCode !== undefined &&
    (
      typeof report.statusCode !== "number" ||
      !Number.isInteger(report.statusCode) ||
      report.statusCode < 300 ||
      report.statusCode > 699
    )
  ) {
    throw new MutationError("Stav odmietnutia SIP hovoru nie je platný.", 400);
  }
  return {
    outcome,
    ...(typeof report.statusCode === "number" ? { statusCode: report.statusCode } : {}),
  };
}

function unsafeBrowserSipFailureRace(status: unknown, providerResponse: unknown) {
  const response = jsonRecord(providerResponse);
  if (status === "confirmed_by_event") {
    return new MutationError("VIPTel už tento hovor potvrdil; stav sa nesmie prepísať.", 409);
  }
  if (status === "failed" && response.deliveryUncertain === true) {
    return new MutationError("Stav hovoru je neistý; pred opakovaním ho treba manuálne zosúladiť.", 409);
  }
  return new MutationError("Audit hovoru už nie je možné označiť ako bezpečne neodoslaný.", 409);
}

function deterministicCommandFence(namespace: string, values: readonly string[]) {
  const hash = createHash("sha256");
  hash.update(namespace);
  for (const value of values) {
    hash.update("\0");
    hash.update(value);
  }
  return hash.digest("hex");
}

function deterministicAuditUuid(namespace: string, ...values: string[]) {
  const hex = deterministicCommandFence(`motorist.telephony.audit.${namespace}.v1`, values);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function numericCommandEndpoint(value: unknown) {
  return typeof value === "string" && /^\d{1,8}$/.test(value) ? value : undefined;
}

function isUniqueViolation(error: { code?: string | null; message?: string | null }) {
  return error.code === "23505" || /duplicate key|unique constraint/i.test(error.message ?? "");
}

function callCommandType(value: TelephonyCommandType) {
  return ["call.create", "call.hangup", "call.redirect", "call.transfer.dtmf", "call.transfer.sip_refer"].includes(value);
}

function requiredAssignmentGuard(input: BeginTelephonyCommandInput) {
  const guard = parseAssignmentGuard(input.assignmentGuard);
  if (
    !guard ||
    guard.extensionId !== input.extensionId ||
    guard.profileId !== input.requestedBy
  ) {
    throw new MutationError("Call príkaz nemá platný bezpečnostný snapshot osobnej klapky.", 409);
  }
  return guard;
}
