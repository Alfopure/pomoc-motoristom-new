import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ViptelClient, ViptelQueueAgentAction } from "@/lib/integrations/viptel/client";
import type { Database, Json } from "@/lib/supabase/database.types";
import { sameDialNumber } from "@/lib/telephony/phone";
import {
  AssignmentInterlockRejected,
  releaseTerminalCommandAssignmentGuard,
  revalidateCallCommandAssignment,
} from "./assignment-interlock";
import { telephonyLiveMutationGateStatus } from "./live-mutation-gate";
import {
  type VerifiedViptelMutationAuthority,
  verifyViptelMutationCommandAuthority,
  verifyViptelMutationCommandIntegrity,
  ViptelMutationAuthorityRejected,
} from "./mutation-command-authority";
import {
  advanceDispatchRoutingOperationForConfirmedCommand,
  DispatchRoutingCommandRejected,
  markDispatchRoutingCommandFailed,
  revalidateDispatchQueueCommand,
} from "./dispatch-routing";
import {
  assertViptelProviderSnapshotBridgeEnabled,
  captureViptelProviderSnapshot,
  providerSnapshotRequestExpired,
  signViptelProviderSnapshotResponse,
  verifyViptelProviderSnapshotRequest,
  VIPTEL_PROVIDER_SNAPSHOT_COMMAND,
  VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
  viptelProviderSnapshotBridgeGateStatus,
} from "./provider-snapshot-bridge";
import { normalizeViptelEvent } from "./viptel-events";
import { providerCallUsesExtension } from "./provider-call-state";
import { isSystemFallbackRedirectPayload } from "./fallback-settings";
import { assertFallbackProviderCallStillWaiting } from "./fallback-routing";

type AdminClient = SupabaseClient<Database>;
export type TelephonyCommandRow = Database["public"]["Tables"]["motorist_telephony_commands"]["Row"];
type ProviderSocket = Pick<WebSocket, "readyState" | "send">;
type QueueClient = Pick<ViptelClient, "getQueueStatus" | "listExtensions" | "setQueueAgent"> &
  Partial<Pick<ViptelClient, "listActiveCalls">>;
type DispatchProviderWithFreshness = Pick<QueueClient, "getQueueStatus" | "listExtensions" | "listActiveCalls">;

const PROVIDER = "viptel";
const SOCKET_OPEN = 1;
const PROVIDER_RESPONSE_WINDOW_MS = 8_000;
const UNCONFIRMED_TIMEOUT_MS = 90_000;
const COMMAND_BATCH_LIMIT = 25;
const MUTATION_EXECUTION_CLAIM_ACTION = "telephony.command.listener_execution_claim";
const MUTATION_EXECUTION_CLAIM_SCHEMA_VERSION = 1;
const SNAPSHOT_EXECUTION_CLAIM_ACTION = "telephony.command.provider_snapshot_execution_claim";
const MUTATION_COMMAND_TYPES = [
  "call.create",
  "call.hangup",
  "call.redirect",
  "queue.add",
  "queue.remove",
  "queue.pause",
  "queue.unpause",
] as const;
const SUPPORTED_COMMAND_TYPES = [...MUTATION_COMMAND_TYPES, VIPTEL_PROVIDER_SNAPSHOT_COMMAND] as const;

export type SupportedTelephonyCommandType = (typeof SUPPORTED_COMMAND_TYPES)[number];

export type DispatchResult = {
  commandId: string;
  commandType: SupportedTelephonyCommandType;
  transport: "rest" | "websocket";
};

class ViptelMutationExecutionClaimRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelMutationExecutionClaimRejected";
  }
}

export class ViptelCommandOutbox {
  private pendingWebSocketCommand: { id: string; sentAt: number } | null = null;
  private lastExpirySweepAt = 0;

  constructor(
    private readonly client: AdminClient,
    private readonly organizationId: string,
    private readonly instanceId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async dispatchNext(socket: ProviderSocket, viptel: QueueClient, now = new Date()): Promise<DispatchResult | null> {
    const mutationEnabled = telephonyLiveMutationGateStatus().enabled;
    const snapshotEnabled = viptelProviderSnapshotBridgeGateStatus().enabled;
    if (!mutationEnabled && !snapshotEnabled) return null;
    await this.sweepUnconfirmed(now);

    if (this.pendingWebSocketCommand) {
      if (now.getTime() - this.pendingWebSocketCommand.sentAt < PROVIDER_RESPONSE_WINDOW_MS) {
        return null;
      }
      // VIPTel success is normally an event, not a generic response. Once the
      // immediate error window passes, event correlation remains active in DB
      // while another command may be sent.
      this.pendingWebSocketCommand = null;
    }

    // Provider-affecting work always wins over read snapshots. If its gate is
    // disabled it is not selected at all, so the independent read bridge can
    // neither execute nor starve a mutation command.
    const queuedMutation = mutationEnabled ? await this.loadOldestQueued([...MUTATION_COMMAND_TYPES]) : null;
    const queuedSnapshot = !queuedMutation && snapshotEnabled
      ? await this.loadOldestQueued([VIPTEL_PROVIDER_SNAPSHOT_COMMAND])
      : null;
    const queued = queuedMutation ?? queuedSnapshot;
    if (!queued) return null;

    const command = queued;
    if (command.command_type !== VIPTEL_PROVIDER_SNAPSHOT_COMMAND) {
      try {
        verifyViptelMutationCommandAuthority(command, this.organizationId, now);
      } catch (error) {
        await this.fail(command.id, {
          error: error instanceof Error ? error.message : "VIPTel mutation authority was rejected.",
          reason: "mutation_authority_rejected",
        });
        return null;
      }
    } else {
      try {
        verifyViptelProviderSnapshotRequest(command, this.organizationId);
      } catch (error) {
        await this.fail(command.id, {
          error: error instanceof Error ? error.message : "VIPTel snapshot request authority was rejected.",
          reason: "snapshot_request_authority_rejected",
        });
        return null;
      }
    }
    if (commandExpired(command, now)) {
      await this.fail(command.id, {
        error: "Príkaz expiroval skôr, než ho listener stihol bezpečne odoslať.",
        reason: "queued_command_expired",
      });
      return null;
    }

    const sentAt = now.toISOString();
    const claimed = await this.client
      .from("motorist_telephony_commands")
      .update({
        status: "sent",
        sent_at: sentAt,
        provider_response: toJson({
          delivery: "claimed",
          listenerInstance: this.instanceId,
          sentAt,
        }),
      })
      .eq("id", command.id)
      .eq("status", "queued")
      .eq("updated_at", command.updated_at)
      .select("*")
      .maybeSingle();
    throwOnError(claimed.error);
    if (!claimed.data) return null;

    const claimedCommand = claimed.data;
    let queueProviderAttempted = false;
    let webSocketProviderAttempted = false;
    try {
      if (claimedCommand.command_type === VIPTEL_PROVIDER_SNAPSHOT_COMMAND) {
        assertViptelProviderSnapshotBridgeEnabled();
        const snapshotAuthority = verifyViptelProviderSnapshotRequest(claimedCommand, this.organizationId);
        if (providerSnapshotRequestExpired(claimedCommand, now)) {
          throw new Error("VIPTel snapshot request expired before provider access.");
        }
        await this.claimSnapshotExecution(claimedCommand, snapshotAuthority.requestHmac, sentAt);
        if (typeof viptel.listActiveCalls !== "function") {
          throw new Error("VIPTel listener cannot build a complete active-call snapshot.");
        }
        const snapshot = await captureViptelProviderSnapshot({
          getQueueStatus: async (queue) => {
            this.assertSnapshotFresh(claimedCommand);
            return viptel.getQueueStatus(queue);
          },
          listActiveCalls: async () => {
            this.assertSnapshotFresh(claimedCommand);
            return viptel.listActiveCalls?.() as ReturnType<NonNullable<QueueClient["listActiveCalls"]>>;
          },
          listExtensions: async () => {
            this.assertSnapshotFresh(claimedCommand);
            return viptel.listExtensions();
          },
        }, () => {
          const capturedAt = this.freshNow();
          // A request that expired while the provider reads were running must
          // never be re-stamped as a fresh, mutation-authorizing snapshot.
          this.assertSnapshotFresh(claimedCommand, capturedAt);
          return capturedAt;
        });
        await this.confirmSnapshot(claimedCommand, sentAt, snapshot);
        return {
          commandId: claimedCommand.id,
          commandType: VIPTEL_PROVIDER_SNAPSHOT_COMMAND,
          transport: "rest",
        };
      }

      // Verify the exact row returned by the queued -> sent CAS. A member can
      // update command rows under the legacy RLS policy, so pre-CAS validation
      // alone would leave a payload-swap window.
      const authority = verifyViptelMutationCommandAuthority(claimedCommand, this.organizationId, now);
      await this.claimMutationExecution(claimedCommand, authority, sentAt);

      if (isQueueCommand(claimedCommand.command_type)) {
        const payload = commandPayload(claimedCommand);
        const queue = requiredNumericString(payload.queue, "queue");
        const extension = requiredNumericString(payload.extension, "extension");
        const action = queueAction(claimedCommand.command_type);
        const guardedViptel: DispatchProviderWithFreshness = {
          getQueueStatus: async (number) => {
            this.assertMutationFresh(claimedCommand);
            return viptel.getQueueStatus(number);
          },
          listExtensions: async () => {
            this.assertMutationFresh(claimedCommand);
            return viptel.listExtensions();
          },
          ...(typeof viptel.listActiveCalls === "function"
            ? {
                listActiveCalls: async () => {
                  this.assertMutationFresh(claimedCommand);
                  return viptel.listActiveCalls?.() as ReturnType<NonNullable<QueueClient["listActiveCalls"]>>;
                },
              }
            : {}),
        };
        await revalidateDispatchQueueCommand(this.client, this.organizationId, claimedCommand, guardedViptel);
        this.assertMutationFresh(claimedCommand);
        queueProviderAttempted = true;
        const providerResponse = await viptel.setQueueAgent(queue, extension, action);
        await this.accept(claimedCommand.id, {
          delivery: "rest",
          listenerInstance: this.instanceId,
          providerResponse: toJson(providerResponse),
          sentAt,
        });
        return { commandId: claimedCommand.id, commandType: claimedCommand.command_type, transport: "rest" };
      }

      if (socket.readyState !== SOCKET_OPEN) {
        throw new Error("VIPTel WebSocket nie je pripojený.");
      }

      const action = buildViptelWebSocketAction(claimedCommand);
      await revalidateCallCommandAssignment(this.client, this.organizationId, claimedCommand);
      if (isSystemFallbackRedirectPayload(claimedCommand.request_payload)) {
        if (typeof viptel.listActiveCalls !== "function") {
          throw new AssignmentInterlockRejected("VIPTel listener nevie overiť čakajúci hovor pred záložným presmerovaním.");
        }
        this.assertMutationFresh(claimedCommand);
        const [activeCalls, extensions, queueStatuses] = await Promise.all([
          viptel.listActiveCalls(),
          viptel.listExtensions(),
          Promise.all(["601", "602", "603"].map((queue) => viptel.getQueueStatus(queue))),
        ]);
        await assertFallbackProviderCallStillWaiting(
          this.client,
          this.organizationId,
          claimedCommand,
          { activeCalls, extensions, queueStatuses },
          this.freshNow(),
        );
      }
      if (claimedCommand.command_type === "call.create") {
        if (typeof viptel.listActiveCalls !== "function") {
          throw new AssignmentInterlockRejected("VIPTel listener nevie overiť aktívne hovory zdrojovej klapky.");
        }
        const sourceExtension = requiredNumericString(
          commandPayload(claimedCommand).caller ?? commandPayload(claimedCommand).from,
          "caller",
        );
        this.assertMutationFresh(claimedCommand);
        const activeCalls = await viptel.listActiveCalls();
        if (activeCalls.some((call) => providerCallUsesExtension(call, sourceExtension))) {
          throw new AssignmentInterlockRejected("VIPTel už na zdrojovej osobnej klapke vedie aktívny hovor.");
        }
      }
      this.assertMutationFresh(claimedCommand);
      socket.send(JSON.stringify(action));
      webSocketProviderAttempted = true;
      const providerSentAt = this.freshNow();
      this.pendingWebSocketCommand = { id: claimedCommand.id, sentAt: providerSentAt.getTime() };
      await this.markSocketSent(claimedCommand.id, action, providerSentAt.toISOString());
      return { commandId: claimedCommand.id, commandType: supportedCommandType(claimedCommand.command_type), transport: "websocket" };
    } catch (error) {
      const deliveryUncertain = (queueProviderAttempted || webSocketProviderAttempted) &&
        !(error instanceof DispatchRoutingCommandRejected);
      await this.fail(claimedCommand.id, {
        error: error instanceof Error ? error.message : "VIPTel príkaz sa nepodarilo odoslať.",
        deliveryUncertain,
        reason: error instanceof DispatchRoutingCommandRejected
          ? "routing_precondition_rejected"
          : error instanceof AssignmentInterlockRejected
            ? "assignment_precondition_rejected"
            : error instanceof ViptelMutationAuthorityRejected || error instanceof ViptelMutationExecutionClaimRejected
              ? "mutation_authority_rejected"
            : "dispatch_failed",
      });
      throw error;
    }
  }

  private freshNow() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("VIPTel listener clock is invalid.");
    }
    return now;
  }

  private assertMutationFresh(command: TelephonyCommandRow) {
    const now = this.freshNow();
    verifyViptelMutationCommandAuthority(command, this.organizationId, now);
    if (commandExpired(command, now)) throw new Error("VIPTel mutation expired before provider access.");
  }

  private assertSnapshotFresh(command: TelephonyCommandRow, now = this.freshNow()) {
    verifyViptelProviderSnapshotRequest(command, this.organizationId);
    if (providerSnapshotRequestExpired(command, now)) {
      throw new Error("VIPTel snapshot request expired before provider access.");
    }
  }

  private async loadOldestQueued(commandTypes: string[]) {
    const result = await this.client
      .from("motorist_telephony_commands")
      .select("*")
      .eq("organization_id", this.organizationId)
      .eq("provider", PROVIDER)
      .eq("status", "queued")
      .in("command_type", commandTypes)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    throwOnError(result.error);
    return result.data;
  }

  private async claimMutationExecution(
    command: TelephonyCommandRow,
    authority: VerifiedViptelMutationAuthority,
    claimedAt: string,
  ) {
    const receipt = {
      schemaVersion: MUTATION_EXECUTION_CLAIM_SCHEMA_VERSION,
      organizationId: this.organizationId,
      commandId: command.id,
      commandType: command.command_type,
      authoritySignature: authority.signature,
      payloadHash: authority.payloadHash,
      claimedAt,
      listenerInstance: this.instanceId,
    };
    const receiptId = deterministicAuditReceiptId(
      "motorist.viptel.listener-mutation-execution-claim.v1",
      this.organizationId,
      command.id,
      authority.signature,
    );
    const inserted = await this.client
      .from("motorist_audit_log")
      .insert({
        id: receiptId,
        organization_id: this.organizationId,
        actor_profile_id: command.requested_by,
        action: MUTATION_EXECUTION_CLAIM_ACTION,
        entity_type: "motorist_telephony_commands",
        entity_id: command.id,
        source: "viptel_listener",
        after_payload: toJson(receipt),
      })
      .select("id")
      .single();
    throwOnError(inserted.error);
    if (!inserted.data) {
      throw new ViptelMutationExecutionClaimRejected("VIPTel mutation execution claim was not persisted.");
    }

    // No schema change is required: the audit table is service-write-only and
    // its primary key is unique. A deterministic receipt ID makes the insert
    // the atomic at-most-once fence; replay fails on the unique constraint and
    // cannot accumulate duplicate audit debris.
    const claims = await this.client
      .from("motorist_audit_log")
      .select("id, after_payload")
      .eq("organization_id", this.organizationId)
      .eq("action", MUTATION_EXECUTION_CLAIM_ACTION)
      .eq("entity_type", "motorist_telephony_commands")
      .eq("entity_id", command.id)
      .limit(2);
    throwOnError(claims.error);
    const rows = claims.data ?? [];
    const stored = asRecord(rows[0]?.after_payload);
    if (
      rows.length !== 1 ||
      rows[0]?.id !== inserted.data.id ||
      stored.schemaVersion !== MUTATION_EXECUTION_CLAIM_SCHEMA_VERSION ||
      stored.organizationId !== this.organizationId ||
      stored.commandId !== command.id ||
      stored.commandType !== command.command_type ||
      stored.authoritySignature !== authority.signature ||
      stored.payloadHash !== authority.payloadHash
    ) {
      throw new ViptelMutationExecutionClaimRejected(
        "VIPTel mutation already has an execution claim or its immutable receipt is inconsistent.",
      );
    }
  }

  private async claimSnapshotExecution(
    command: TelephonyCommandRow,
    requestHmac: string,
    claimedAt: string,
  ) {
    const receipt = {
      schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
      organizationId: this.organizationId,
      commandId: command.id,
      commandType: VIPTEL_PROVIDER_SNAPSHOT_COMMAND,
      requestHmac,
      claimedAt,
      listenerInstance: this.instanceId,
    };
    const receiptId = deterministicAuditReceiptId(
      "motorist.viptel.provider-snapshot-execution-claim.v1",
      this.organizationId,
      command.id,
      requestHmac,
    );
    const inserted = await this.client
      .from("motorist_audit_log")
      .insert({
        id: receiptId,
        organization_id: this.organizationId,
        actor_profile_id: command.requested_by,
        action: SNAPSHOT_EXECUTION_CLAIM_ACTION,
        entity_type: "motorist_telephony_commands",
        entity_id: command.id,
        source: "viptel_listener",
        after_payload: toJson(receipt),
      })
      .select("id")
      .single();
    throwOnError(inserted.error);
    if (!inserted.data) {
      throw new ViptelMutationExecutionClaimRejected("VIPTel snapshot execution claim was not persisted.");
    }
    const claims = await this.client
      .from("motorist_audit_log")
      .select("id, after_payload")
      .eq("organization_id", this.organizationId)
      .eq("action", SNAPSHOT_EXECUTION_CLAIM_ACTION)
      .eq("entity_type", "motorist_telephony_commands")
      .eq("entity_id", command.id)
      .limit(2);
    throwOnError(claims.error);
    const rows = claims.data ?? [];
    const stored = asRecord(rows[0]?.after_payload);
    if (
      rows.length !== 1 ||
      rows[0]?.id !== inserted.data.id ||
      stored.schemaVersion !== VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION ||
      stored.organizationId !== this.organizationId ||
      stored.commandId !== command.id ||
      stored.commandType !== VIPTEL_PROVIDER_SNAPSHOT_COMMAND ||
      stored.requestHmac !== requestHmac
    ) {
      throw new ViptelMutationExecutionClaimRejected(
        "VIPTel snapshot already has an execution claim or its immutable receipt is inconsistent.",
      );
    }
  }

  async handleProviderResponse(payload: unknown) {
    const record = asRecord(payload);
    const code = Number(record.code);
    if (!this.pendingWebSocketCommand || !Number.isFinite(code) || code < 400) return false;

    const commandId = this.pendingWebSocketCommand.id;
    this.pendingWebSocketCommand = null;
    await this.fail(commandId, {
      code,
      error: providerMessage(record, code),
      reason: "provider_rejected",
    });
    return true;
  }

  noteConfirmed(commandIds: string[]) {
    if (this.pendingWebSocketCommand && commandIds.includes(this.pendingWebSocketCommand.id)) {
      this.pendingWebSocketCommand = null;
    }
  }

  private async markSocketSent(commandId: string, action: Record<string, string>, sentAt: string) {
    const result = await this.client
      .from("motorist_telephony_commands")
      .update({
        provider_response: toJson({
          action: action.action,
          delivery: "websocket",
          listenerInstance: this.instanceId,
          sentAt,
        }),
      })
      .eq("id", commandId)
      .eq("status", "sent");
    throwOnError(result.error);
  }

  private async accept(commandId: string, providerResponse: Record<string, unknown>) {
    const result = await this.client
      .from("motorist_telephony_commands")
      .update({ status: "accepted", provider_response: toJson(providerResponse) })
      .eq("id", commandId)
      .eq("status", "sent");
    throwOnError(result.error);
  }

  private async confirmSnapshot(
    command: Pick<TelephonyCommandRow, "id" | "request_payload">,
    sentAt: string,
    snapshot: Awaited<ReturnType<typeof captureViptelProviderSnapshot>>,
  ) {
    const confirmedAt = this.freshNow().toISOString();
    const responseHmac = signViptelProviderSnapshotResponse(command, this.organizationId, snapshot);
    const result = await this.client
      .from("motorist_telephony_commands")
      .update({
        status: "confirmed_by_event",
        confirmed_at: confirmedAt,
        provider_response: toJson({
          schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
          delivery: "listener_rest_read",
          listenerInstance: this.instanceId,
          confirmedAt,
          responseHmac,
          snapshot,
        }),
      })
      .eq("id", command.id)
      .eq("status", "sent")
      .eq("sent_at", sentAt)
      .select("id")
      .maybeSingle();
    throwOnError(result.error);
    if (!result.data) throw new Error("VIPTel snapshot completion lost its sent-state CAS.");
    await releaseTerminalCommandAssignmentGuard(this.client, this.organizationId, command.request_payload);
  }

  private async fail(commandId: string, providerResponse: Record<string, unknown>) {
    const result = await this.client
      .from("motorist_telephony_commands")
      .update({ status: "failed", provider_response: toJson(providerResponse) })
      .eq("id", commandId)
      .in("status", ["queued", "sent", "accepted"])
      .select("id, organization_id, provider, command_type, requested_by, queue_id, extension_id, idempotency_key, request_payload")
      .maybeSingle();
    throwOnError(result.error);
    const failedCommand = result.data;
    if (!failedCommand) return;

    // Keep the routing interlock in place until the parent operation has been
    // durably degraded. This covers failures before claim (invalid authority or
    // queue expiry) as well as failures after a provider dispatch attempt.
    await markDispatchRoutingCommandFailed(
      this.client,
      this.organizationId,
      failedCommand,
      terminalFailureReason(providerResponse),
    );
    await releaseTerminalCommandAssignmentGuard(this.client, this.organizationId, failedCommand.request_payload);
  }

  private async sweepUnconfirmed(now: Date) {
    if (now.getTime() - this.lastExpirySweepAt < 5_000) return;
    this.lastExpirySweepAt = now.getTime();
    const cutoff = new Date(now.getTime() - UNCONFIRMED_TIMEOUT_MS).toISOString();
    const candidates = await this.client
      .from("motorist_telephony_commands")
      .select("id, organization_id, provider, command_type, requested_by, queue_id, extension_id, idempotency_key, status, provider_response, request_payload")
      .eq("organization_id", this.organizationId)
      .eq("provider", PROVIDER)
      .in("status", ["sent", "accepted"])
      .lt("updated_at", cutoff)
      .limit(100);
    throwOnError(candidates.error);
    const ids = (candidates.data ?? [])
      .filter((command) => {
        if (command.status === "sent") return true;
        const providerResponse = asRecord(command.provider_response);
        const request = asRecord(command.request_payload);
        return Boolean(readString(providerResponse.listenerInstance)) || readString(request.transport) === "browser_sip";
      })
      .map((command) => command.id);
    if (ids.length === 0) return;

    const result = await this.client
      .from("motorist_telephony_commands")
      .update({
        status: "failed",
        provider_response: toJson({
          deliveryUncertain: true,
          error: "VIPTel akciu sa nepodarilo potvrdiť udalosťou. Stav treba obnoviť pred opakovaním.",
          reason: "provider_confirmation_timeout",
        }),
      })
      .in("id", ids)
      .in("status", ["sent", "accepted"])
      .lt("updated_at", cutoff)
      .select("id, organization_id, provider, command_type, requested_by, queue_id, extension_id, idempotency_key, status, provider_response, request_payload");
    throwOnError(result.error);
    // Only rows returned by the failed-state CAS are terminal failures owned
    // by this sweep. A provider confirmation may have won after candidates
    // were read; processing the stale candidate snapshot would otherwise
    // degrade its routing operation and release guards after confirmation.
    for (const command of result.data ?? []) {
      await markDispatchRoutingCommandFailed(
        this.client,
        this.organizationId,
        command,
        "VIPTel akciu sa nepodarilo potvrdiť udalosťou.",
      );
      await releaseTerminalCommandAssignmentGuard(this.client, this.organizationId, command.request_payload);
    }
  }
}

export function deterministicAuditReceiptId(
  domain: string,
  organizationId: string,
  commandId: string,
  authoritySignature: string,
) {
  const hex = createHash("sha256")
    .update(`${domain}\0${organizationId}\0${commandId}\0${authoritySignature}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function confirmTelephonyCommandsFromViptelEvent(
  client: AdminClient,
  organizationId: string,
  payload: unknown,
  options: { callId?: string | null; eventFingerprint?: string; receivedAt?: string } = {},
) {
  const event = normalizeViptelEvent(payload, options.receivedAt);
  const commandTypes = commandTypesForEvent(event.eventType);
  if (commandTypes.length === 0) return [];

  const candidates = await client
    .from("motorist_telephony_commands")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("status", ["sent", "accepted", "confirmed_by_event"])
    .in("command_type", commandTypes)
    .order("created_at", { ascending: false })
    .limit(COMMAND_BATCH_LIMIT);
  throwOnError(candidates.error);

  const receivedAt = options.receivedAt ?? new Date().toISOString();
  const matching = (candidates.data ?? []).find((command) => {
    if (!commandIsWithinConfirmationWindow(command, receivedAt)) return false;
    try {
      const authority = verifyViptelMutationCommandIntegrity(command, organizationId);
      const request = commandPayload(command);
      if (readString(request.transport) === "browser_sip") {
        if (authority.executionTarget !== "event_correlation_only" || command.status !== "accepted") return false;
      } else {
        const expectedTarget = isQueueCommand(command.command_type) ? "listener_rest" : "listener_websocket";
        if (authority.executionTarget !== expectedTarget) return false;
      }
    } catch {
      return false;
    }
    return commandMatchesViptelEvent(command, payload);
  });
  if (!matching) return [];

  if (matching.status === "confirmed_by_event") {
    await advanceOrDegradeConfirmedRoutingCommand(client, organizationId, matching);
    await releaseTerminalCommandAssignmentGuard(client, organizationId, matching.request_payload);
    return [matching.id];
  }

  const providerResponse = {
    ...asRecord(matching.provider_response),
    confirmation: {
      eventFingerprint: options.eventFingerprint,
      eventType: event.eventType,
      receivedAt,
    },
  };
  const result = await client
    .from("motorist_telephony_commands")
    .update({
      call_id: options.callId ?? matching.call_id,
      confirmed_at: receivedAt,
      provider_response: toJson(providerResponse),
      status: "confirmed_by_event",
    })
    .eq("id", matching.id)
    .in("status", ["sent", "accepted"])
    .select("id")
    .maybeSingle();
  throwOnError(result.error);
  if (!result.data) return [];
  await advanceOrDegradeConfirmedRoutingCommand(client, organizationId, matching);
  await releaseTerminalCommandAssignmentGuard(client, organizationId, matching.request_payload);
  return [result.data.id];
}

async function advanceOrDegradeConfirmedRoutingCommand(
  client: AdminClient,
  organizationId: string,
  command: TelephonyCommandRow,
) {
  try {
    await advanceDispatchRoutingOperationForConfirmedCommand(client, organizationId, command);
  } catch (error) {
    await markDispatchRoutingCommandFailed(
      client,
      organizationId,
      command,
      `Potvrdený krok sa nepodarilo posunúť: ${error instanceof Error ? error.message : "neznáma chyba"}`,
    ).catch(() => undefined);
  }
}

export function buildViptelWebSocketAction(command: TelephonyCommandRow): Record<string, string> {
  const payload = commandPayload(command);
  if (command.command_type === "call.create") {
    const action: Record<string, string> = {
      action: "call.create",
      from: requiredNumericString(payload.caller ?? payload.from, "caller"),
      to: requiredDialString(payload.destination ?? payload.to, "destination"),
      call_random_id: providerCorrelationId(payload.callRandomId ?? command.idempotency_key),
    };
    const callerId = optionalDialString(payload.requestedCallerId ?? payload.callerId);
    if (callerId) action.caller_id = callerId;
    return action;
  }

  if (command.command_type === "call.hangup") {
    return {
      action: "call.hangup",
      unique_id: requiredUniqueId(payload.uniqueId ?? payload.unique_id),
    };
  }

  if (command.command_type === "call.redirect") {
    return {
      action: "call.redirect",
      unique_id: requiredUniqueId(payload.uniqueId ?? payload.unique_id),
      destination: requiredNumericString(payload.destinationExtension ?? payload.destination, "destination"),
    };
  }

  throw new Error(`Unsupported VIPTel WebSocket command: ${command.command_type}`);
}

export function commandMatchesViptelEvent(command: TelephonyCommandRow, payload: unknown) {
  const event = normalizeViptelEvent(payload);
  const raw = eventRecord(payload);
  const request = commandPayload(command);

  if (command.command_type === "call.create") {
    if (readString(request.transport) === "browser_sip") {
      const caller = readString(request.caller ?? request.from);
      const destination = readString(request.destination ?? request.to);
      return (
        event.eventType === "call.begin" &&
        [event.callerExtension, event.callerNumber]
          .some((value) => sameDialNumber(exactEndpoint(value), exactEndpoint(caller))) &&
        [event.calledNumber, event.destinationNumber].some((value) => sameDialNumber(value, destination))
      );
    }
    const expected = providerCorrelationId(request.callRandomId ?? command.idempotency_key);
    return event.eventType === "call.create_response" && readString(raw.call_random_id) === expected;
  }

  if (command.command_type === "call.hangup") {
    const confirmationUniqueIds = new Set([
      readString(request.uniqueId ?? request.unique_id),
      ...readStringArray(request.confirmationUniqueIds),
    ].filter((value): value is string => Boolean(value)));
    return event.eventType === "call.end" && Boolean(event.uniqueId && confirmationUniqueIds.has(event.uniqueId));
  }

  if (command.command_type === "call.redirect") {
    const uniqueId = readString(request.uniqueId ?? request.unique_id);
    const destination = readString(request.destinationExtension ?? request.destination);
    if (!uniqueId || !destination) return false;
    const confirmationUniqueIds = new Set([
      uniqueId,
      ...readStringArray(request.confirmationUniqueIds),
    ]);
    return (
      event.eventType === "call.begin" &&
      [event.uniqueId, event.fromQueueUniqueId]
        .some((value) => Boolean(value && confirmationUniqueIds.has(value))) &&
      [event.calledNumber, event.destinationNumber, event.destinationExtension]
        .some((value) => sameDialNumber(value, destination))
    );
  }

  if (isQueueCommand(command.command_type)) {
    return (
      event.eventType === command.command_type &&
      readString(raw.queue) === readString(request.queue) &&
      readString(raw.member ?? raw.extension) === readString(request.extension)
    );
  }

  return false;
}

function commandTypesForEvent(eventType: string): string[] {
  if (eventType === "call.create_response") return ["call.create"];
  if (eventType === "call.end") return ["call.hangup"];
  if (eventType === "call.begin") return ["call.redirect", "call.create"];
  if (["queue.add", "queue.remove", "queue.pause", "queue.unpause"].includes(eventType)) return [eventType];
  return [];
}

function commandIsWithinConfirmationWindow(command: TelephonyCommandRow, receivedAt: string) {
  const created = Date.parse(command.created_at);
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(created) || !Number.isFinite(received)) return true;
  const elapsed = received - created;
  return elapsed >= -5_000 && elapsed <= 5 * 60_000;
}

function commandExpired(command: TelephonyCommandRow, now: Date) {
  if (command.command_type === VIPTEL_PROVIDER_SNAPSHOT_COMMAND) {
    try {
      return providerSnapshotRequestExpired(command, now);
    } catch {
      return true;
    }
  }
  const createdAt = Date.parse(command.created_at);
  if (!Number.isFinite(createdAt)) return true;
  const maxAge = isQueueCommand(command.command_type) ? 5 * 60_000 : 45_000;
  return now.getTime() - createdAt > maxAge;
}

function isQueueCommand(commandType: string): commandType is `queue.${ViptelQueueAgentAction}` {
  return ["queue.add", "queue.remove", "queue.pause", "queue.unpause"].includes(commandType);
}

function supportedCommandType(value: string): SupportedTelephonyCommandType {
  if ((SUPPORTED_COMMAND_TYPES as readonly string[]).includes(value)) return value as SupportedTelephonyCommandType;
  throw new Error(`Unsupported telephony command: ${value}`);
}

function queueAction(commandType: `queue.${ViptelQueueAgentAction}`): ViptelQueueAgentAction {
  return commandType.slice("queue.".length) as ViptelQueueAgentAction;
}

function commandPayload(command: TelephonyCommandRow) {
  return asRecord(command.request_payload);
}

function eventRecord(payload: unknown) {
  const root = asRecord(payload);
  const nested = asRecord(root.data ?? root.payload ?? root.event_data);
  return Object.keys(nested).length > 0 ? nested : root;
}

function providerCorrelationId(value: unknown) {
  const normalized = readString(value)?.replace(/[^a-z0-9]/gi, "").slice(0, 64);
  if (!normalized) throw new Error("VIPTel call correlation id is missing.");
  return normalized;
}

function requiredNumericString(value: unknown, field: string) {
  const text = readString(value);
  if (!text || !/^\d{1,18}$/.test(text)) throw new Error(`VIPTel ${field} must be numeric.`);
  return text;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = readString(item);
        return text ? [text] : [];
      })
    : [];
}

function requiredDialString(value: unknown, field: string) {
  const text = optionalDialString(value);
  if (!text) throw new Error(`VIPTel ${field} is missing or invalid.`);
  return text;
}

function optionalDialString(value: unknown) {
  const text = readString(value);
  return text && /^\+?\d{1,20}$/.test(text) ? text : undefined;
}

function requiredUniqueId(value: unknown) {
  const text = readString(value);
  if (!text || !/^[a-z0-9._:-]{1,128}$/i.test(text)) throw new Error("VIPTel unique_id is missing or invalid.");
  return text;
}

function providerMessage(record: Record<string, unknown>, code: number) {
  const message = readString(record.message ?? record.detail);
  return message ? `VIPTel odmietol príkaz (${code}): ${message.slice(0, 240)}` : `VIPTel odmietol príkaz s kódom ${code}.`;
}

function terminalFailureReason(providerResponse: Record<string, unknown>) {
  return readString(providerResponse.error) ?? "VIPTel príkaz skončil terminálnym zlyhaním.";
}

function exactEndpoint(value: string | undefined) {
  return value?.trim().replace(/^sip:/i, "").split("@")[0];
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}
