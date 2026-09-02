import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  WORKPLACE_TAKEOVER_DECISION_SECONDS,
  WORKPLACE_TAKEOVER_HANDOFF_SECONDS,
  WORKPLACE_TAKEOVER_REFUSAL_COOLDOWN_SECONDS,
  WORKPLACE_TAKEOVER_REQUEST_TYPE,
  type WorkplaceTakeoverRequest,
  type WorkplaceTakeoverRequestStatus,
  type WorkplaceTakeoverSnapshot,
} from "@/lib/telephony/workplace-takeover";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  DISPATCH_QUEUE_NUMBERS,
  parseDispatchRoutingState,
  type DispatchQueueNumber,
} from "@/server/telephony/dispatch-routing";
import { configuredPersonalExtensions } from "@/server/telephony/personal-extension-config";
import { providerCallUsesExtension } from "@/server/telephony/provider-call-state";
import {
  requestViptelProviderSnapshot,
  type ViptelProviderSnapshot,
} from "@/server/telephony/provider-snapshot-bridge";
import {
  readWorkplaceLease,
  workplaceLeaseFreshness,
  type WorkplaceLease,
} from "@/server/telephony/workplace-lease";
import { createWorkplaceOperationRepository } from "@/server/telephony/workplace-operation-repository";
import { assertExactWorkplaceProviderState } from "@/server/telephony/workplace-admin-actions";

type AdminClient = SupabaseClient<Database>;
type NotificationRow = Pick<
  Database["public"]["Tables"]["motorist_notifications"]["Row"],
  | "archived_at"
  | "created_at"
  | "dedupe_key"
  | "id"
  | "payload"
  | "read_at"
  | "recipient_profile_id"
  | "status"
  | "updated_at"
>;
type ExtensionRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"],
  "extension" | "id" | "profile_id"
>;

type WorkplaceTakeoverDependencies = {
  client?: AdminClient;
  databaseNow?: () => Promise<string>;
  randomId?: () => string;
  requestProviderSnapshot?: (
    organizationId: string,
    requestedBy: string,
  ) => Promise<Pick<ViptelProviderSnapshot, "activeCalls" | "extensions" | "queueStatuses">>;
};

type TakeoverDecision = "accepted" | "cancelled" | "completed" | "declined" | "pending";

const PROVIDER = "viptel";
const NOTIFICATION_PREFIX = "workplace-takeover:";
const ROW_SELECT = "id, recipient_profile_id, status, payload, dedupe_key, read_at, archived_at, created_at, updated_at";
const MAX_REQUEST_ROWS = 100;

export async function getWorkplaceTakeoverSnapshot(
  actor: MotoristActor,
  dependencies: WorkplaceTakeoverDependencies = {},
): Promise<WorkplaceTakeoverSnapshot> {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const checkedAt = await databaseNow(client, dependencies);
  const [rows, actorExtension] = await Promise.all([
    loadTakeoverRows(client, actor.organizationId),
    loadActorExtension(client, actor.organizationId, actor.profileId),
  ]);
  return buildTakeoverSnapshot(actor, rows, checkedAt, actorExtension?.extension ?? null);
}

export async function requestWorkplaceTakeover(
  actor: MotoristActor,
  requestedExtension: unknown,
  dependencies: WorkplaceTakeoverDependencies = {},
) {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const checkedAt = await databaseNow(client, dependencies);
  const extension = readConfiguredExtension(requestedExtension);
  const target = await loadExtension(client, actor.organizationId, extension);
  if (!target.profile_id) {
    throw new MutationError(`Pracovné miesto ${extension} je už voľné. Môžeš ho rovno obsadiť.`, 409, "workplace_takeover_target_free");
  }
  if (target.profile_id === actor.profileId) {
    throw new MutationError(`Pracovné miesto ${extension} už používaš.`, 409, "workplace_takeover_target_mine");
  }

  const lease = await loadCurrentLease(client, actor.organizationId, target.id);
  requireFreshOwnerLease(lease, target, checkedAt);
  const ownerName = await loadProfileName(client, actor.organizationId, target.profile_id);
  const rows = await loadTakeoverRows(client, actor.organizationId);
  const parsedRows = rows.flatMap((row) => {
    const parsed = parseTakeoverRow(row, checkedAt);
    return parsed ? [{ parsed, row }] : [];
  });
  const actorActiveRequest = parsedRows.find(({ parsed }) =>
    parsed.requesterProfileId === actor.profileId &&
    (parsed.status === "pending" || parsed.status === "accepted"),
  );
  if (actorActiveRequest && actorActiveRequest.parsed.leaseId !== lease.id) {
    throw new MutationError(
      `Najprv dokonči žiadosť o pracovné miesto ${actorActiveRequest.parsed.extension}.`,
      409,
      "workplace_takeover_request_active",
    );
  }

  const dedupeKey = takeoverDedupeKey(lease.id);
  const existing = parsedRows.find(({ row }) => row.dedupe_key === dedupeKey);
  if (existing && (existing.parsed.status === "pending" || existing.parsed.status === "accepted")) {
    if (existing.parsed.requesterProfileId === actor.profileId) {
      return {
        message: existing.parsed.status === "pending"
          ? `${ownerName} už dostal tvoju žiadosť. Čakáme na odpoveď.`
          : existing.parsed.acceptedBy === "timeout"
            ? `Čas na odmietnutie uplynul. Pracovisko ${extension} sa bezpečne odovzdáva.`
            : `${ownerName} prevzatie schválil. Pracovisko sa bezpečne uvoľňuje.`,
        snapshot: buildTakeoverSnapshot(actor, rows, checkedAt),
      };
    }
    throw new MutationError(
      "O toto pracovné miesto už požiadal iný kolega. Počkaj na dokončenie jeho žiadosti.",
      409,
      "workplace_takeover_request_busy",
    );
  }

  const cooldown = existing?.parsed.status === "declined" && existing.parsed.cooldownUntil
    ? existing.parsed.cooldownUntil
    : undefined;
  if (cooldown && Date.parse(cooldown) > Date.parse(checkedAt)) {
    throw new MutationError(
      `Po odmietnutí treba pred ďalšou žiadosťou počkať ${formatCooldownRemaining(cooldown, checkedAt)}.`,
      429,
      "workplace_takeover_cooldown",
    );
  }

  await assertProviderAllowsConsent(client, actor, target, dependencies);

  const requestedAt = checkedAt;
  const expiresAt = addSeconds(requestedAt, WORKPLACE_TAKEOVER_DECISION_SECONDS);
  const requestId = existing?.row.id ?? (dependencies.randomId ?? randomUUID)();
  const payload = takeoverPayload({
    decision: "pending",
    expiresAt,
    extension,
    extensionId: target.id,
    leaseId: lease.id,
    ownerName,
    ownerProfileId: target.profile_id,
    requestedAt,
    requesterName: actor.displayName,
    requesterProfileId: actor.profileId,
  });
  const values = {
    recipient_profile_id: target.profile_id,
    visibility: "private" as const,
    kind: "system" as const,
    severity: "warning" as const,
    title: `${actor.displayName} žiada pracovné miesto ${extension}`,
    body: "Žiadosť môžeš do 30 sekúnd odmietnuť. Bez odmietnutia sa potom začne bezpečné odovzdanie pracoviska.",
    status: "unread" as const,
    delivery_status: "in_app" as const,
    read_at: null,
    archived_at: null,
    payload,
  };

  let stored: NotificationRow | null = null;
  if (existing) {
    const update = await client
      .from("motorist_notifications")
      .update(values)
      .eq("organization_id", actor.organizationId)
      .eq("id", existing.row.id)
      .eq("updated_at", existing.row.updated_at)
      .select(ROW_SELECT)
      .maybeSingle();
    if (update.error) throw new MutationError("Žiadosť o pracovné miesto sa nepodarilo uložiť.", 500);
    stored = update.data as NotificationRow | null;
  } else {
    const insert = await client
      .from("motorist_notifications")
      .insert({
        id: requestId,
        organization_id: actor.organizationId,
        dedupe_key: dedupeKey,
        ...values,
      })
      .select(ROW_SELECT)
      .maybeSingle();
    if (insert.error) {
      if (insert.error.code === "23505") {
        throw new MutationError(
          "O pracovné miesto práve požiadal iný kolega. Obnov stav.",
          409,
          "workplace_takeover_request_race",
        );
      }
      throw new MutationError("Žiadosť o pracovné miesto sa nepodarilo uložiť.", 500);
    }
    stored = insert.data as NotificationRow | null;
  }
  if (!stored) {
    throw new MutationError(
      "Stav pracoviska sa počas žiadosti zmenil. Obnov stav a skús to znova.",
      409,
      "workplace_takeover_request_changed",
    );
  }

  const nextRows = [stored, ...rows.filter((row) => row.id !== stored?.id)];
  return {
    message: `${ownerName} dostal žiadosť. Ak ju do 30 sekúnd neodmietne, začne sa bezpečné odovzdanie.`,
    snapshot: buildTakeoverSnapshot(actor, nextRows, checkedAt),
  };
}

export async function respondToWorkplaceTakeover(
  actor: MotoristActor,
  requestId: string,
  decision: "accept" | "decline",
  dependencies: WorkplaceTakeoverDependencies = {},
) {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const checkedAt = await databaseNow(client, dependencies);
  const row = await loadTakeoverRow(client, actor.organizationId, requestId);
  const request = parseTakeoverRow(row, checkedAt);
  if (!request) throw new MutationError("Žiadosť o pracovné miesto nie je platná.", 409);
  if (request.ownerProfileId !== actor.profileId || row.recipient_profile_id !== actor.profileId) {
    throw new MutationError("Na túto žiadosť môže odpovedať iba aktuálny používateľ pracoviska.", 403);
  }
  if (request.status === "expired") {
    throw new MutationError("Čas na bezpečné dokončenie odovzdania vypršal. Vytvor novú žiadosť.", 409, "workplace_takeover_request_expired");
  }
  const targetDecision = decision === "accept" ? "accepted" : "declined";
  if (request.status === targetDecision) {
    return {
      message: decision === "accept" ? "Odovzdanie už bolo schválené." : "Žiadosť už bola odmietnutá.",
      snapshot: await getWorkplaceTakeoverSnapshot(actor, { ...dependencies, client }),
    };
  }
  if (request.status !== "pending") {
    throw new MutationError("Táto žiadosť už bola uzavretá.", 409, "workplace_takeover_request_closed");
  }

  const target = await loadExtension(client, actor.organizationId, request.extension);
  if (target.id !== request.extensionId || target.profile_id !== actor.profileId) {
    throw new MutationError("Vlastník pracoviska sa medzitým zmenil. Žiadosť bola zastavená.", 409);
  }
  const lease = await loadCurrentLease(client, actor.organizationId, target.id);
  if (lease.id !== request.leaseId) {
    throw new MutationError("Relácia pracoviska sa medzitým zmenila. Žiadosť bola zastavená.", 409);
  }
  requireFreshOwnerLease(lease, target, checkedAt);
  if (decision === "accept") {
    await assertProviderAllowsConsent(client, actor, target, dependencies);
  }

  const respondedAt = checkedAt;
  const updatedPayload = takeoverPayload({
    ...request,
    decision: targetDecision,
    respondedAt,
    ...(decision === "accept"
      ? { handoffExpiresAt: addSeconds(respondedAt, WORKPLACE_TAKEOVER_HANDOFF_SECONDS) }
      : {}),
  });
  const update = await client
    .from("motorist_notifications")
    .update({
      payload: updatedPayload,
      status: decision === "accept" ? "read" : "archived",
      read_at: decision === "accept" ? respondedAt : null,
      archived_at: decision === "decline" ? respondedAt : null,
    })
    .eq("organization_id", actor.organizationId)
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .eq("status", "unread")
    .select(ROW_SELECT)
    .maybeSingle();
  if (update.error) throw new MutationError("Odpoveď na žiadosť sa nepodarilo uložiť.", 500);
  if (!update.data) {
    throw new MutationError("Na žiadosť už odpovedalo iné okno. Obnov stav.", 409, "workplace_takeover_response_race");
  }
  const rows = await loadTakeoverRows(client, actor.organizationId);
  return {
    message: decision === "accept"
      ? `Odovzdanie pracoviska ${request.extension} je schválené. Teraz ho bezpečne uvoľníme.`
      : `Žiadosť o pracovné miesto ${request.extension} bola odmietnutá.`,
    snapshot: buildTakeoverSnapshot(actor, rows, checkedAt),
  };
}

export async function cancelWorkplaceTakeover(
  actor: MotoristActor,
  requestId: string,
  dependencies: WorkplaceTakeoverDependencies = {},
) {
  return finishRequesterTakeover(actor, requestId, "cancelled", dependencies);
}

export async function completeWorkplaceTakeover(
  actor: MotoristActor,
  requestId: string,
  dependencies: WorkplaceTakeoverDependencies = {},
) {
  return finishRequesterTakeover(actor, requestId, "completed", dependencies);
}

/**
 * An accepted handoff temporarily reserves a newly released seat for its
 * requester. The normal fenced claim still performs the ownership change.
 */
export async function assertWorkplaceTakeoverReservation(
  actor: MotoristActor,
  requestedExtension: unknown,
  dependencies: WorkplaceTakeoverDependencies = {},
) {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const checkedAt = await databaseNow(client, dependencies);
  const extension = readConfiguredExtension(requestedExtension);
  const target = await loadExtension(client, actor.organizationId, extension);
  // The consenting owner may need to reclaim the same fenced lease in this
  // browser before the normal safe release can complete.
  if (target.profile_id === actor.profileId) return;
  const rows = await loadTakeoverRows(client, actor.organizationId);
  const reservations = rows
    .map((row) => parseTakeoverRow(row, checkedAt))
    .filter((request): request is WorkplaceTakeoverRequest =>
      Boolean(request && request.extension === extension && request.status === "accepted"),
    );
  if (reservations.length > 1) {
    throw new MutationError("Pracovné miesto má nejednoznačnú rezerváciu odovzdania. Kontaktuj správcu.", 409);
  }
  const reservation = reservations[0];
  if (reservation && reservation.requesterProfileId !== actor.profileId) {
    throw new MutationError(
      `Pracovné miesto ${extension} je krátko rezervované pre kolegu, ktorému vlastník schválil odovzdanie.`,
      409,
      "workplace_takeover_reserved",
    );
  }
}

async function finishRequesterTakeover(
  actor: MotoristActor,
  requestId: string,
  decision: "cancelled" | "completed",
  dependencies: WorkplaceTakeoverDependencies,
) {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const checkedAt = await databaseNow(client, dependencies);
  const row = await loadTakeoverRow(client, actor.organizationId, requestId);
  const request = parseTakeoverRow(row, checkedAt);
  if (!request || request.requesterProfileId !== actor.profileId) {
    throw new MutationError("Túto žiadosť môže uzavrieť iba jej autor.", 403);
  }
  if (decision === "cancelled" && request.status !== "pending") {
    throw new MutationError("Schválenú alebo uzavretú žiadosť už nemožno zrušiť.", 409);
  }
  if (decision === "completed") {
    if (request.status !== "accepted") {
      if (request.status === "completed") {
        return {
          message: `Pracovné miesto ${request.extension} už bolo odovzdané.`,
          snapshot: await getWorkplaceTakeoverSnapshot(actor, { ...dependencies, client }),
        };
      }
      throw new MutationError("Odovzdanie ešte nebolo schválené.", 409);
    }
    const target = await loadExtension(client, actor.organizationId, request.extension);
    if (target.id !== request.extensionId || target.profile_id !== actor.profileId) {
      throw new MutationError("Server ešte nepotvrdil, že pracovné miesto patrí žiadateľovi.", 409);
    }
  }
  const respondedAt = checkedAt;
  const update = await client
    .from("motorist_notifications")
    .update({
      payload: takeoverPayload({ ...request, decision, respondedAt }),
      status: "archived",
      archived_at: respondedAt,
    })
    .eq("organization_id", actor.organizationId)
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .select(ROW_SELECT)
    .maybeSingle();
  if (update.error) throw new MutationError("Žiadosť sa nepodarilo uzavrieť.", 500);
  if (!update.data) throw new MutationError("Žiadosť medzitým zmenilo iné okno. Obnov stav.", 409);
  const rows = await loadTakeoverRows(client, actor.organizationId);
  return {
    message: decision === "completed"
      ? `Pracovné miesto ${request.extension} je úspešne odovzdané.`
      : `Žiadosť o pracovné miesto ${request.extension} je zrušená.`,
    snapshot: buildTakeoverSnapshot(actor, rows, checkedAt),
  };
}

function buildTakeoverSnapshot(
  actor: MotoristActor,
  rows: NotificationRow[],
  checkedAt: string,
  actorExtension?: string | null,
): WorkplaceTakeoverSnapshot {
  const requests = rows
    .map((row) => parseTakeoverRow(row, checkedAt))
    .filter((request): request is WorkplaceTakeoverRequest => Boolean(request));
  const active = (request: WorkplaceTakeoverRequest) =>
    request.status === "pending" || request.status === "accepted";
  const incoming = requests.find((request) =>
    request.ownerProfileId === actor.profileId && active(request) &&
    (request.status !== "accepted" || actorExtension === undefined || actorExtension === request.extension),
  );
  const outgoing = requests.find((request) => request.requesterProfileId === actor.profileId && active(request)) ??
    requests.find((request) => request.requesterProfileId === actor.profileId);
  const cooldowns = requests
    .filter((request) => request.status === "declined" && request.cooldownUntil)
    .map((request) => ({ extension: request.extension, until: request.cooldownUntil as string }))
    .filter((cooldown) => Date.parse(cooldown.until) > Date.parse(checkedAt));
  return {
    checkedAt,
    cooldowns,
    ...(incoming ? { incoming } : {}),
    ...(outgoing ? { outgoing } : {}),
  };
}

function parseTakeoverRow(row: NotificationRow, checkedAt: string): WorkplaceTakeoverRequest | undefined {
  const payload = jsonRecord(row.payload);
  if (payload.type !== WORKPLACE_TAKEOVER_REQUEST_TYPE || payload.schemaVersion !== 1) return undefined;
  const requestId = uuid(payload.requestId) ?? uuid(row.id);
  const extensionId = uuid(payload.extensionId);
  const leaseId = uuid(payload.leaseId);
  const requesterProfileId = uuid(payload.requesterProfileId);
  const ownerProfileId = uuid(payload.ownerProfileId);
  const extension = configuredPersonalExtensions().includes(string(payload.extension))
    ? string(payload.extension)
    : undefined;
  const requesterName = shortText(payload.requesterName);
  const ownerName = shortText(payload.ownerName);
  const requestedAt = timestamp(payload.requestedAt);
  const expiresAt = timestamp(payload.expiresAt);
  const decision = takeoverDecision(payload.decision);
  const respondedAt = timestamp(payload.respondedAt);
  const handoffExpiresAt = timestamp(payload.handoffExpiresAt);
  if (
    !requestId || !extensionId || !leaseId || !requesterProfileId || !ownerProfileId ||
    !extension || !requesterName || !ownerName || !requestedAt || !expiresAt || !decision
  ) return undefined;
  const now = Date.parse(checkedAt);
  const autoAccepted = decision === "pending" && Date.parse(expiresAt) <= now;
  const effectiveRespondedAt = autoAccepted ? expiresAt : respondedAt;
  const effectiveHandoffExpiresAt = autoAccepted
    ? addSeconds(expiresAt, WORKPLACE_TAKEOVER_HANDOFF_SECONDS)
    : handoffExpiresAt;
  const handoffExpired = (decision === "accepted" || autoAccepted) &&
    (!effectiveHandoffExpiresAt || Date.parse(effectiveHandoffExpiresAt) <= now);
  const status: WorkplaceTakeoverRequestStatus = handoffExpired
    ? "expired"
    : autoAccepted ? "accepted" : decision;
  const cooldownUntil = decision === "declined" && respondedAt
    ? addSeconds(respondedAt, WORKPLACE_TAKEOVER_REFUSAL_COOLDOWN_SECONDS)
    : undefined;
  return {
    requestId,
    extensionId,
    extension,
    leaseId,
    requesterProfileId,
    requesterName,
    ownerProfileId,
    ownerName,
    requestedAt,
    expiresAt,
    status,
    ...(effectiveRespondedAt ? { respondedAt: effectiveRespondedAt } : {}),
    ...(effectiveHandoffExpiresAt ? { handoffExpiresAt: effectiveHandoffExpiresAt } : {}),
    ...(status === "accepted" ? { acceptedBy: autoAccepted ? "timeout" as const : "owner" as const } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
  };
}

async function assertProviderAllowsConsent(
  client: AdminClient,
  actor: MotoristActor,
  target: ExtensionRow,
  dependencies: WorkplaceTakeoverDependencies,
) {
  const expectedQueue = await loadExpectedQueue(client, actor.organizationId, target.extension);
  let snapshot: Pick<ViptelProviderSnapshot, "activeCalls" | "extensions" | "queueStatuses">;
  try {
    snapshot = dependencies.requestProviderSnapshot
      ? await dependencies.requestProviderSnapshot(actor.organizationId, actor.profileId)
      : await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
          maxAgeMs: 2_000,
          requireNewCapture: true,
        });
  } catch {
    throw new MutationError(
      "Živý stav VIPTel sa nepodarilo overiť. Žiadosť by nebola bezpečná, preto sa nič nezmenilo.",
      502,
    );
  }
  assertExactWorkplaceProviderState(target.extension, expectedQueue, snapshot, {
    allowOffline: true,
    allowPaused: true,
    allowRegistered: true,
  });
  const requesterExtension = await loadActorExtension(client, actor.organizationId, actor.profileId);
  if (
    requesterExtension && requesterExtension.extension !== target.extension &&
    snapshot.activeCalls.some((call) => providerCallUsesExtension(call, requesterExtension.extension))
  ) {
    throw new MutationError("Najprv ukonči svoj prebiehajúci hovor. Počas hovoru nemožno meniť pracovisko.", 409);
  }
}

async function loadExpectedQueue(
  client: AdminClient,
  organizationId: string,
  extension: string,
): Promise<DispatchQueueNumber | null> {
  const result = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, metadata")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null);
  if (result.error || result.data?.length !== 1) {
    throw new MutationError("Poradie pracoviska sa nepodarilo jednoznačne overiť.", 409);
  }
  const routing = parseDispatchRoutingState(result.data[0]?.metadata);
  return DISPATCH_QUEUE_NUMBERS.find((queue) => routing.currentPlan[queue] === extension) ?? null;
}

async function loadTakeoverRows(client: AdminClient, organizationId: string): Promise<NotificationRow[]> {
  const result = await client
    .from("motorist_notifications")
    .select(ROW_SELECT)
    .eq("organization_id", organizationId)
    .eq("kind", "system")
    .like("dedupe_key", `${NOTIFICATION_PREFIX}%`)
    .order("updated_at", { ascending: false })
    .limit(MAX_REQUEST_ROWS);
  if (result.error) throw new MutationError("Žiadosti o pracoviská sa nepodarilo načítať.", 500);
  return (result.data ?? []) as NotificationRow[];
}

async function loadTakeoverRow(client: AdminClient, organizationId: string, requestId: string): Promise<NotificationRow> {
  const result = await client
    .from("motorist_notifications")
    .select(ROW_SELECT)
    .eq("organization_id", organizationId)
    .eq("id", requestId)
    .eq("kind", "system")
    .like("dedupe_key", `${NOTIFICATION_PREFIX}%`)
    .maybeSingle();
  if (result.error) throw new MutationError("Žiadosť o pracovné miesto sa nepodarilo načítať.", 500);
  if (!result.data) throw new MutationError("Žiadosť o pracovné miesto už neexistuje.", 404);
  return result.data as NotificationRow;
}

async function loadExtension(client: AdminClient, organizationId: string, extension: string): Promise<ExtensionRow> {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("extension", extension)
    .eq("active", true)
    .maybeSingle();
  if (result.error || !result.data) throw new MutationError("Pracovné miesto sa nepodarilo jednoznačne načítať.", 409);
  return result.data;
}

async function loadActorExtension(client: AdminClient, organizationId: string, profileId: string) {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("profile_id", profileId)
    .eq("active", true)
    .maybeSingle();
  if (result.error) throw new MutationError("Pracovisko žiadateľa sa nepodarilo overiť.", 409);
  return result.data as ExtensionRow | null;
}

async function loadCurrentLease(client: AdminClient, organizationId: string, extensionId: string): Promise<WorkplaceLease> {
  const result = await client
    .from("motorist_workplace_leases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("extension_id", extensionId)
    .in("state", ["active", "ending"])
    .maybeSingle();
  if (result.error) throw new MutationError("Relácia pracoviska sa nepodarila overiť.", 500);
  const lease = readWorkplaceLease(result.data);
  if (!lease) throw new MutationError("Pracovisko nemá platnú aktívnu reláciu. Obnov stav.", 409);
  return lease;
}

function requireFreshOwnerLease(lease: WorkplaceLease, target: ExtensionRow, checkedAt: string) {
  if (lease.profileId !== target.profile_id || lease.extensionId !== target.id) {
    throw new MutationError("Vlastník a relácia pracoviska si nezodpovedajú. Obnov stav.", 409);
  }
  if (workplaceLeaseFreshness(lease, checkedAt) !== "fresh") {
    throw new MutationError(
      "Operátor už nie je online. Obnov stav a použi bežné bezpečné prevzatie offline pracoviska.",
      409,
      "workplace_takeover_owner_offline",
    );
  }
}

async function loadProfileName(client: AdminClient, organizationId: string, profileId: string) {
  const result = await client
    .from("motorist_profiles")
    .select("display_name")
    .eq("organization_id", organizationId)
    .eq("id", profileId)
    .eq("active", true)
    .maybeSingle();
  if (result.error || !result.data?.display_name) throw new MutationError("Meno používateľa pracoviska sa nepodarilo načítať.", 409);
  return result.data.display_name;
}

async function databaseNow(client: AdminClient, dependencies: WorkplaceTakeoverDependencies) {
  return dependencies.databaseNow
    ? dependencies.databaseNow()
    : createWorkplaceOperationRepository(client).databaseNow();
}

function takeoverPayload(input: {
  decision: TakeoverDecision;
  expiresAt: string;
  extension: string;
  extensionId: string;
  leaseId: string;
  ownerName: string;
  ownerProfileId: string;
  requestedAt: string;
  requesterName: string;
  requesterProfileId: string;
  respondedAt?: string;
  handoffExpiresAt?: string;
}): Json {
  return {
    type: WORKPLACE_TAKEOVER_REQUEST_TYPE,
    schemaVersion: 1,
    decision: input.decision,
    expiresAt: input.expiresAt,
    extension: input.extension,
    extensionId: input.extensionId,
    leaseId: input.leaseId,
    ownerName: input.ownerName,
    ownerProfileId: input.ownerProfileId,
    requestedAt: input.requestedAt,
    requesterName: input.requesterName,
    requesterProfileId: input.requesterProfileId,
    ...(input.respondedAt ? { respondedAt: input.respondedAt } : {}),
    ...(input.handoffExpiresAt ? { handoffExpiresAt: input.handoffExpiresAt } : {}),
  } as Json;
}

function takeoverDedupeKey(leaseId: string) {
  return `${NOTIFICATION_PREFIX}${leaseId}`;
}

function readConfiguredExtension(value: unknown) {
  const extension = string(value);
  if (!configuredPersonalExtensions().includes(extension)) {
    throw new MutationError("Vyber platné pracovné miesto.", 400);
  }
  return extension;
}

function addSeconds(value: string, seconds: number) {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

function formatCooldownRemaining(until: string, checkedAt: string) {
  const seconds = Math.max(1, Math.ceil((Date.parse(until) - Date.parse(checkedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} min ${remainder} s` : `${remainder} s`;
}

function takeoverDecision(value: unknown): TakeoverDecision | undefined {
  return value === "accepted" || value === "cancelled" || value === "completed" || value === "declined" || value === "pending"
    ? value
    : undefined;
}

function jsonRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function shortText(value: unknown) {
  const result = string(value);
  return result && result.length <= 160 ? result : undefined;
}

function uuid(value: unknown) {
  const result = string(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)
    ? result
    : undefined;
}

function timestamp(value: unknown) {
  const result = string(value);
  return result && Number.isFinite(Date.parse(result)) ? new Date(result).toISOString() : undefined;
}
