import { serializeViptelError, type ViptelExtension } from "@/lib/integrations/viptel/client";
import type { TelephonyExtensionSnapshot } from "@/lib/telephony/presence";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import {
  listTelephonyExtensionAssignments,
  refreshTelephonyPresence,
} from "@/server/telephony-extensions";
import {
  getStoredDispatchRoutingOverview,
  resolvePlannedDispatchQueue,
} from "@/server/telephony/dispatch-routing";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import { readLatestConfirmedViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };
const STORED_PROVIDER_SNAPSHOT_MAX_AGE_MS = 30_000;

/**
 * Stored presence is the safe default for page load and polling. It performs
 * only database reads and deliberately does not contact VIPTel or synchronize
 * provider state back into production-backed tables.
 */
export async function GET() {
  try {
    const actor = await requireTelephonyActor();
    const [storedExtensions, routing, confirmedProviderSnapshot] = await Promise.all([
      listTelephonyExtensionAssignments(actor),
      getStoredDispatchRoutingOverview(actor),
      readLatestConfirmedViptelProviderSnapshot(actor.organizationId, {
        maxAgeMs: STORED_PROVIDER_SNAPSHOT_MAX_AGE_MS,
      }),
    ]);
    const extensions = confirmedProviderSnapshot
      ? mergeProviderExtensionFacts(
          storedExtensions,
          confirmedProviderSnapshot.extensions,
          confirmedProviderSnapshot.capturedAt,
        )
      : storedExtensions;
    const waitingByQueue = new Map(routing.waitingCalls.map((waiting) => [waiting.queue, waiting.count]));
    const membershipsByQueue = new Map<string, typeof routing.actualMemberships>();

    for (const membership of routing.actualMemberships) {
      const current = membershipsByQueue.get(membership.queue) ?? [];
      current.push(membership);
      membershipsByQueue.set(membership.queue, current);
    }

    const storedQueues = routing.catalog.queues
      .filter((queue) => Boolean(queue.id))
      .map((queue) => ({ id: queue.queue, name: queue.label }));
    const hasCompleteStoredComponents =
      storedQueues.length === 3 &&
      extensions.length > 0 &&
      storedQueues.every((queue) => Boolean(routing.waitingCalls.find((waiting) => waiting.queue === queue.id)?.capturedAt));
    const storedCheckedAt = hasCompleteStoredComponents
      ? completeStoredTimestamp([
          ...extensions.map((extension) => extension.lastSyncedAt),
          ...routing.actualMemberships.map((membership) => membership.lastSyncedAt),
          ...storedQueues.map((queue) => routing.waitingCalls.find((waiting) => waiting.queue === queue.id)?.capturedAt),
        ])
      : new Date(0).toISOString();
    const storedQueueStatuses = storedQueues.map((queue) => ({
      queue: queue.id,
      members: (membershipsByQueue.get(queue.id) ?? []).map((membership) => ({
        extension: membership.extension,
        paused: membership.paused,
        inUse: membership.inUse,
        dynamic: true,
        callsTaken: 0,
      })),
      waitingCalls: waitingByQueue.get(queue.id) ?? 0,
    }));
    const storedQueueNames = new Map<string, string>(storedQueues.map((queue) => [queue.id, queue.name]));
    const checkedAt = confirmedProviderSnapshot?.capturedAt ?? storedCheckedAt;
    const queues = confirmedProviderSnapshot
      ? confirmedProviderSnapshot.queues.map((queue) => ({
          ...queue,
          name: storedQueueNames.get(queue.id) ?? queue.name,
        }))
      : storedQueues;
    const queueStatuses = confirmedProviderSnapshot?.queueStatuses ?? storedQueueStatuses;
    const routingResolution = await resolveActorRouting(actor, extensions);

    return Response.json(
      {
        ok: true,
        source: "stored",
        ...routingResolution,
        snapshot: {
          actorProfileId: actor.profileId,
          canManageAssignments: actor.role === "manager" || actor.role === "admin",
          checkedAt,
          extensions,
          queues,
          queueStatuses,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      { ok: false, error: "Uložený stav klapiek a radov sa nepodarilo načítať." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    assertTelephonyLiveMutationEnabled("presence.sync");
    const requireNewCapture = new URL(request.url).searchParams.get("fresh") === "1";
    const snapshot = requireNewCapture
      ? await refreshTelephonyPresence(actor, { requireNewCapture: true })
      : await refreshTelephonyPresence(actor);
    const routingResolution = await resolveActorRouting(actor, snapshot.extensions);

    return Response.json(
      { ok: true, source: "provider_refresh", ...routingResolution, snapshot },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    const serialized = serializeViptelError(error);
    return Response.json(
      {
        ok: false,
        error: serialized.message,
        providerStatus: serialized.providerStatus,
      },
      { status: serialized.status, headers: NO_STORE_HEADERS },
    );
  }
}

function completeStoredTimestamp(values: Array<string | undefined>) {
  if (values.length === 0) return new Date(0).toISOString();
  let oldest = Number.POSITIVE_INFINITY;

  for (const value of values) {
    if (!value) return new Date(0).toISOString();
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return new Date(0).toISOString();
    if (parsed < oldest) oldest = parsed;
  }

  return new Date(oldest).toISOString();
}

function mergeProviderExtensionFacts(
  storedExtensions: TelephonyExtensionSnapshot[],
  providerExtensions: ViptelExtension[],
  capturedAt: string,
) {
  const providerByNumber = new Map(providerExtensions.map((extension) => [extension.extension, extension]));

  return storedExtensions.map((stored) => {
    const provider = providerByNumber.get(stored.extension);
    if (!provider) return stored;

    return {
      ...stored,
      displayName: provider.name,
      outboundCid: provider.outboundCid,
      callForwarding: normalizeProviderForwarding(provider.callForwarding),
      registered: provider.isRegistered,
      viptelPhoneActive: provider.isViptelPhoneActive,
      allowedChanges: provider.allowedChanges,
      lastSyncedAt: capturedAt,
    };
  });
}

function normalizeProviderForwarding(value: ViptelExtension["callForwarding"]) {
  if (value === undefined || value === "") return undefined;
  return typeof value === "boolean" ? String(value) : value;
}

async function resolveActorRouting(actor: MotoristActor, extensions: TelephonyExtensionSnapshot[]) {
  const ownedExtensions = extensions.filter(
    (extension) => extension.active && extension.profileId === actor.profileId,
  );
  if (ownedExtensions.length === 0) {
    return {
      actorRouting: null,
      routingDiagnostic: "Prihlásený operátor nemá priradenú aktívnu osobnú klapku.",
    };
  }
  if (ownedExtensions.length > 1) {
    return {
      actorRouting: null,
      routingDiagnostic: "Prihlásený operátor má viac aktívnych klapiek; dostupnosť zostala bezpečne uzamknutá.",
    };
  }

  try {
    const routing = await resolvePlannedDispatchQueue(actor.organizationId, ownedExtensions[0].extension);
    return {
      actorRouting: { queue: routing.queue, revision: routing.revision },
      routingDiagnostic: null,
    };
  } catch (error) {
    return {
      actorRouting: null,
      routingDiagnostic: error instanceof MutationError
        ? error.message
        : "Zaradenie osobnej klapky v pláne 601–603 sa nepodarilo overiť.",
    };
  }
}
