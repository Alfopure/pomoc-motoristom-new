import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import type { ViptelCallSnapshot } from "./viptel-events";
import { normalizeViptelPublicNumber } from "./viptel-line-catalog";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"],
  "extension" | "id" | "profile_id"
>;
type QueueRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_queues"]["Row"],
  "external_id" | "id" | "line_id"
>;
type LineRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_lines"]["Row"],
  "external_id" | "id" | "phone_number"
>;

export type ViptelCorrelationCatalog = {
  extensions: ExtensionRow[];
  queues: QueueRow[];
  lines: LineRow[];
};

export type ViptelCallRelations = {
  direction?: Database["public"]["Tables"]["motorist_calls"]["Row"]["direction"];
  extensionId?: string;
  operatorId?: string;
  queueId?: string;
  lineId?: string;
  queueNumber?: string;
  callerExtension?: string;
  receivedExtension?: string;
  destinationExtension?: string;
};

const CACHE_MS = 60_000;
const SHARED_DISPATCH_QUEUE_NUMBERS = new Set(["601", "602", "603"]);
const catalogCache = new Map<string, { expiresAt: number; value: ViptelCorrelationCatalog }>();

export async function getViptelCorrelationCatalog(
  client: AdminClient,
  organizationId: string,
  options: { fresh?: boolean } = {},
) {
  const cached = catalogCache.get(organizationId);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [extensionsResult, queuesResult, linesResult] = await Promise.all([
    client
      .from("motorist_telephony_extensions")
      .select("id, extension, profile_id")
      .eq("organization_id", organizationId)
      .eq("provider", "viptel")
      .eq("active", true),
    client
      .from("motorist_telephony_queues")
      .select("id, external_id, line_id")
      .eq("organization_id", organizationId)
      .eq("provider", "viptel")
      .eq("active", true),
    client
      .from("motorist_telephony_lines")
      .select("id, external_id, phone_number")
      .eq("organization_id", organizationId)
      .eq("provider", "viptel")
      .eq("active", true),
  ]);

  const error = extensionsResult.error ?? queuesResult.error ?? linesResult.error;
  if (error) {
    throw new Error(`VIPTel call correlation catalog could not be loaded: ${error.message}`);
  }

  const value: ViptelCorrelationCatalog = {
    extensions: extensionsResult.data ?? [],
    queues: queuesResult.data ?? [],
    lines: linesResult.data ?? [],
  };
  catalogCache.set(organizationId, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

export function correlateViptelCall(
  snapshot: ViptelCallSnapshot,
  catalog: ViptelCorrelationCatalog,
): ViptelCallRelations {
  const extensionByNumber = new Map(catalog.extensions.map((row) => [normalizeExtension(row.extension), row]));
  const extensionNumber = (value: string | undefined) => {
    const normalized = normalizeExtension(value);
    return normalized && extensionByNumber.has(normalized) ? normalized : undefined;
  };

  const callerExtension = extensionNumber(snapshot.callerExtension) ?? extensionNumber(snapshot.callerNumber);
  const receivedExtension = extensionNumber(snapshot.receivedExtension) ?? extensionNumber(snapshot.receivedNumber);
  const destinationExtension =
    extensionNumber(snapshot.destinationExtension) ??
    extensionNumber(snapshot.destinationNumber) ??
    extensionNumber(snapshot.calledNumber);
  const inferredDirection =
    callerExtension && (destinationExtension || receivedExtension)
      ? "internal"
      : callerExtension
        ? "outbound"
        : destinationExtension || receivedExtension
          ? "inbound"
          : undefined;
  const effectiveDirection = snapshot.directionAuthoritative === false ? inferredDirection ?? snapshot.direction : snapshot.direction;

  const line = effectiveDirection === "inbound"
    ? findLine(catalog.lines, snapshot.receivedNumber) ?? findLine(catalog.lines, snapshot.calledNumber)
    : undefined;

  let queue = catalog.queues.find((row) => row.external_id === snapshot.queueNumber);
  if (!queue && snapshot.application?.toLowerCase() === "queue" && line) {
    const lineQueues = catalog.queues.filter((row) => row.line_id === line.id);
    queue = lineQueues.length === 1 ? lineQueues[0] : undefined;
  }

  const primaryExtension =
    effectiveDirection === "outbound"
      ? callerExtension ?? receivedExtension ?? destinationExtension
      : effectiveDirection === "internal"
        ? callerExtension ?? destinationExtension ?? receivedExtension
        : destinationExtension ?? receivedExtension ?? callerExtension;
  const extension = primaryExtension ? extensionByNumber.get(primaryExtension) : undefined;

  return {
    direction: inferredDirection,
    extensionId: extension?.id,
    operatorId: extension?.profile_id ?? undefined,
    queueId: queue?.id,
    lineId:
      line?.id ??
      (effectiveDirection === "inbound" && queue && !SHARED_DISPATCH_QUEUE_NUMBERS.has(queue.external_id)
        ? queue.line_id || undefined
        : undefined),
    queueNumber: snapshot.queueNumber ?? queue?.external_id,
    callerExtension,
    receivedExtension,
    destinationExtension,
  };
}

function findLine(lines: LineRow[], value: string | undefined) {
  const normalized = normalizeViptelPublicNumber(value);
  if (!normalized) return undefined;

  const matches = lines.filter(
    (line) =>
      normalizeViptelPublicNumber(line.phone_number) === normalized ||
      normalizeViptelPublicNumber(line.external_id) === normalized,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeExtension(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return /^\d{1,8}$/.test(normalized) ? normalized : "";
}
