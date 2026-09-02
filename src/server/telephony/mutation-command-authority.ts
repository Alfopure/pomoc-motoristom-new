import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Database, Json } from "@/lib/supabase/database.types";

type TelephonyCommandRow = Database["public"]["Tables"]["motorist_telephony_commands"]["Row"];

export const VIPTEL_MUTATION_AUTHORITY_KEY = "listenerMutationAuthority";
export const VIPTEL_MUTATION_AUTHORITY_SCHEMA_VERSION = 1;

const PROVIDER = "viptel";
const MIN_AUTHORITY_TOKEN_LENGTH = 32;
const MAX_AUTHORITY_TOKEN_LENGTH = 1024;
const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 4_096;
const CLOCK_SKEW_MS = 5_000;

export const VIPTEL_LISTENER_MUTATION_COMMAND_TYPES = [
  "call.create",
  "call.hangup",
  "call.redirect",
  "queue.add",
  "queue.remove",
  "queue.pause",
  "queue.unpause",
] as const;

export type ViptelListenerMutationCommandType =
  (typeof VIPTEL_LISTENER_MUTATION_COMMAND_TYPES)[number];

export type ViptelMutationAuthorityCommand = Pick<
  TelephonyCommandRow,
  | "call_id"
  | "command_type"
  | "extension_id"
  | "id"
  | "idempotency_key"
  | "organization_id"
  | "provider"
  | "queue_id"
  | "request_payload"
  | "requested_by"
>;

export type VerifiedViptelMutationAuthority = {
  deadlineAt: string;
  executionTarget: ViptelMutationExecutionTarget;
  issuedAt: string;
  payloadHash: string;
  signature: string;
};

export type ViptelMutationExecutionTarget =
  | "event_correlation_only"
  | "listener_rest"
  | "listener_websocket";

type AuthorityInput = {
  callId?: string | null;
  commandId: string;
  commandType: string;
  executionTarget: ViptelMutationExecutionTarget;
  extensionId?: string | null;
  idempotencyKey: string;
  organizationId: string;
  provider?: string;
  queueId?: string | null;
  requestPayload: Record<string, unknown>;
  requestedBy: string;
};

type AuthorityOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
};

export class ViptelMutationAuthorityRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelMutationAuthorityRejected";
  }
}

/**
 * Adds a server-only authority envelope to the JSON that is persisted in the
 * command row. The HMAC covers every provider-relevant column and the complete
 * business payload, while deliberately excluding the envelope itself.
 */
export function authorizeViptelMutationCommand(
  input: AuthorityInput,
  options: AuthorityOptions = {},
): { requestPayload: Json; authority: VerifiedViptelMutationAuthority } {
  assertSupportedCommandType(input.commandType);
  if (Object.hasOwn(input.requestPayload, VIPTEL_MUTATION_AUTHORITY_KEY)) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation payload already contains an authority envelope.");
  }

  const businessPayload = normalizeJsonObject(input.requestPayload);
  const issuedAtDate = options.now ?? new Date();
  if (!Number.isFinite(issuedAtDate.getTime())) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority has an invalid issue time.");
  }
  const issuedAt = issuedAtDate.toISOString();
  const deadlineAt = new Date(issuedAtDate.getTime() + maximumLifetimeMs(input.commandType)).toISOString();
  const payloadHash = sha256(canonicalJson(businessPayload));
  const unsignedAuthority = {
    schemaVersion: VIPTEL_MUTATION_AUTHORITY_SCHEMA_VERSION,
    executionTarget: input.executionTarget,
    issuedAt,
    deadlineAt,
    payloadHash,
  };
  const signature = mutationSignature(
    commandSigningInput(input, businessPayload, unsignedAuthority),
    requiredAuthorityToken(options.env ?? process.env),
  );
  const authority = { ...unsignedAuthority, signature };
  return {
    requestPayload: normalizeJsonObject({
      ...businessPayload,
      [VIPTEL_MUTATION_AUTHORITY_KEY]: authority,
    }) as Json,
    authority,
  };
}

/**
 * Verifies both integrity and freshness. Call this before changing queued to
 * sent, then retain the returned digest in the immutable execution claim.
 */
export function verifyViptelMutationCommandAuthority(
  command: ViptelMutationAuthorityCommand,
  expectedOrganizationId: string,
  now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): VerifiedViptelMutationAuthority {
  return verifyAuthority(command, expectedOrganizationId, now, env, true);
}

/** Integrity-only verification for delayed provider-event correlation. */
export function verifyViptelMutationCommandIntegrity(
  command: ViptelMutationAuthorityCommand,
  expectedOrganizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): VerifiedViptelMutationAuthority {
  return verifyAuthority(command, expectedOrganizationId, new Date(0), env, false);
}

function verifyAuthority(
  command: ViptelMutationAuthorityCommand,
  expectedOrganizationId: string,
  now: Date,
  env: Readonly<Record<string, string | undefined>>,
  enforceFreshness: boolean,
): VerifiedViptelMutationAuthority {
  assertSupportedCommandType(command.command_type);
  if (command.organization_id !== expectedOrganizationId || command.provider !== PROVIDER) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority belongs to another provider or organization.");
  }
  if (!command.requested_by) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority has no requesting profile.");
  }

  const storedPayload = normalizeJsonObject(command.request_payload);
  const envelope = jsonRecord(storedPayload[VIPTEL_MUTATION_AUTHORITY_KEY]);
  const allowedKeys = ["deadlineAt", "executionTarget", "issuedAt", "payloadHash", "schemaVersion", "signature"];
  if (
    Object.keys(envelope).length !== allowedKeys.length ||
    Object.keys(envelope).some((key) => !allowedKeys.includes(key)) ||
    envelope.schemaVersion !== VIPTEL_MUTATION_AUTHORITY_SCHEMA_VERSION ||
    !isExecutionTarget(envelope.executionTarget)
  ) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority envelope is missing or malformed.");
  }

  const issuedAt = strictIsoDate(envelope.issuedAt, "issue time");
  const deadlineAt = strictIsoDate(envelope.deadlineAt, "deadline");
  const executionTarget = envelope.executionTarget;
  const issuedMs = Date.parse(issuedAt);
  const deadlineMs = Date.parse(deadlineAt);
  const lifetimeMs = deadlineMs - issuedMs;
  if (lifetimeMs <= 0 || lifetimeMs > maximumLifetimeMs(command.command_type)) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority lifetime is invalid.");
  }
  if (enforceFreshness) {
    const requiredTarget = command.command_type.startsWith("queue.") ? "listener_rest" : "listener_websocket";
    if (executionTarget !== requiredTarget) {
      throw new ViptelMutationAuthorityRejected("VIPTel mutation is not authorized for listener execution.");
    }
    if (!Number.isFinite(now.getTime()) || issuedMs > now.getTime() + CLOCK_SKEW_MS || now.getTime() > deadlineMs) {
      throw new ViptelMutationAuthorityRejected("VIPTel mutation authority is expired or not yet valid.");
    }
  }

  const signature = readHexDigest(envelope.signature, "signature");
  const storedPayloadHash = readHexDigest(envelope.payloadHash, "payload hash");
  const businessPayload = { ...storedPayload };
  delete businessPayload[VIPTEL_MUTATION_AUTHORITY_KEY];
  const payloadHash = sha256(canonicalJson(businessPayload));
  if (!safeDigestEqual(storedPayloadHash, payloadHash)) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation business payload hash does not match.");
  }

  const expectedSignature = mutationSignature(
    commandSigningInput({
      callId: command.call_id,
      commandId: command.id,
      commandType: command.command_type,
      executionTarget,
      extensionId: command.extension_id,
      idempotencyKey: command.idempotency_key,
      organizationId: command.organization_id,
      provider: command.provider,
      queueId: command.queue_id,
      requestPayload: businessPayload,
      requestedBy: command.requested_by,
    }, businessPayload, {
      schemaVersion: VIPTEL_MUTATION_AUTHORITY_SCHEMA_VERSION,
      executionTarget,
      issuedAt,
      deadlineAt,
      payloadHash,
    }),
    requiredAuthorityToken(env),
  );
  if (!safeDigestEqual(signature, expectedSignature)) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation authority signature is invalid.");
  }
  return { deadlineAt, executionTarget, issuedAt, payloadHash, signature };
}

function commandSigningInput(
  input: Omit<AuthorityInput, "requestPayload"> & { requestPayload?: Record<string, unknown> },
  businessPayload: Record<string, unknown>,
  authority: {
    schemaVersion: number;
    executionTarget: ViptelMutationExecutionTarget;
    issuedAt: string;
    deadlineAt: string;
    payloadHash: string;
  },
) {
  return {
    domain: "motorist.viptel.listener-mutation-command.v1",
    schemaVersion: authority.schemaVersion,
    executionTarget: authority.executionTarget,
    issuedAt: authority.issuedAt,
    deadlineAt: authority.deadlineAt,
    payloadHash: authority.payloadHash,
    command: {
      id: input.commandId,
      organizationId: input.organizationId,
      provider: input.provider ?? PROVIDER,
      commandType: input.commandType,
      requestedBy: input.requestedBy,
      callId: input.callId ?? null,
      queueId: input.queueId ?? null,
      extensionId: input.extensionId ?? null,
      idempotencyKey: input.idempotencyKey,
      requestPayload: businessPayload,
    },
  };
}

function mutationSignature(value: unknown, token: string) {
  return createHmac("sha256", token).update(canonicalJson(value)).digest("hex");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredAuthorityToken(env: Readonly<Record<string, string | undefined>>) {
  const token = env.VIPTEL_LIVE_MUTATION_TOKEN?.trim();
  if (!token || token.length < MIN_AUTHORITY_TOKEN_LENGTH || token.length > MAX_AUTHORITY_TOKEN_LENGTH) {
    throw new ViptelMutationAuthorityRejected("VIPTel live-mutation authority is missing or invalid.");
  }
  return token;
}

function maximumLifetimeMs(commandType: string) {
  return commandType.startsWith("queue.") ? 5 * 60_000 : 60_000;
}

function assertSupportedCommandType(value: string): asserts value is ViptelListenerMutationCommandType {
  if (!(VIPTEL_LISTENER_MUTATION_COMMAND_TYPES as readonly string[]).includes(value)) {
    throw new ViptelMutationAuthorityRejected(`Unsupported VIPTel listener mutation command: ${value}`);
  }
}

function isExecutionTarget(value: unknown): value is ViptelMutationExecutionTarget {
  return value === "event_correlation_only" || value === "listener_rest" || value === "listener_websocket";
}

function strictIsoDate(value: unknown, label: string) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new ViptelMutationAuthorityRejected(`VIPTel mutation authority ${label} is invalid.`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) {
    throw new ViptelMutationAuthorityRejected(`VIPTel mutation authority ${label} is not canonical.`);
  }
  return normalized;
}

function readHexDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ViptelMutationAuthorityRejected(`VIPTel mutation authority ${label} is invalid.`);
  }
  return value;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  let normalized: unknown;
  try {
    normalized = JSON.parse(JSON.stringify(value));
  } catch {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation payload is not JSON serializable.");
  }
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation payload must be a JSON object.");
  }
  // Canonicalization applies tighter depth/node controls; this early check
  // avoids spending CPU on obviously oversized member-controlled DB values.
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_CANONICAL_BYTES) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation payload exceeds the authority size limit.");
  }
  return normalized as Record<string, unknown>;
}

function canonicalJson(value: unknown) {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new ViptelMutationAuthorityRejected("VIPTel mutation payload exceeds canonicalization limits.");
    }
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number" && Number.isFinite(candidate)) return JSON.stringify(candidate);
    if (Array.isArray(candidate)) return `[${candidate.map((item) => visit(item, depth + 1)).join(",")}]`;
    if (candidate && typeof candidate === "object") {
      return `{${Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => `${JSON.stringify(key)}:${visit(nested, depth + 1)}`)
        .join(",")}}`;
    }
    throw new ViptelMutationAuthorityRejected("VIPTel mutation payload contains a non-JSON value.");
  };
  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_BYTES) {
    throw new ViptelMutationAuthorityRejected("VIPTel mutation canonical payload exceeds the size limit.");
  }
  return serialized;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
