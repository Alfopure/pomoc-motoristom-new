import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";
import { configuredPersonalExtensions } from "@/server/telephony/personal-extension-config";

const AUTHORITY_SCHEMA_VERSION = 1;
const AUTHORITY_KEY_VERSION = "supabase-service-v1";
const AUTHORITY_PAYLOAD_KEY = "workplacePriorityDraftAuthority";
const DRAFT_ACTION = "telephony.workplace.priority.draft";
const DRAFT_ENTITY_TYPE = "motorist_telephony_queues";
const QUEUES = ["601", "602", "603"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MIN_SECRET_LENGTH = 32;

type AdminClient = SupabaseClient<Database>;
type Environment = Readonly<Record<string, string | undefined>>;

export type WorkplaceDraftAuthority = {
  schemaVersion: 1;
  keyVersion: "supabase-service-v1";
  auditId: string;
  draftDigest: string;
  signature: string;
};

export type WorkplaceDraftPayload = {
  schemaVersion: 1;
  baseRevision: number;
  selections: Record<(typeof QUEUES)[number], string | null>;
  selectedBy: Record<(typeof QUEUES)[number], string | null>;
  updatedAt: string;
};

export type SignedWorkplaceDraft = WorkplaceDraftPayload & {
  authority: WorkplaceDraftAuthority;
};

export type WorkplaceDraftAuthorityContext = {
  organizationId: string;
  rootQueueId: string;
};

type WorkplaceDraftAuditProof = WorkplaceDraftAuthority & WorkplaceDraftAuthorityContext;

/**
 * The signing key is domain-derived from the server-only Supabase service
 * credential. That credential is already required by every web/Preview and
 * listener runtime that can read this row, so no new deployment secret or
 * browser-visible configuration is introduced. The versioned envelope leaves
 * room for an explicit future key migration; rotation deliberately fails
 * closed until an old current draft is superseded or re-signed.
 */
export function authorizeWorkplacePriorityDraft(
  value: unknown,
  context: WorkplaceDraftAuthorityContext,
  auditId: string,
  env: Environment = process.env,
): { draft: SignedWorkplaceDraft; auditPayload: Record<string, unknown> } {
  if (!UUID_PATTERN.test(auditId)) {
    throw new MutationError("Serverový dôkaz výberu priorít má neplatný identifikátor.", 500);
  }
  const payload = parseWorkplaceDraftPayload(value);
  const draftDigest = sha256(canonicalJson(payload));
  const unsignedAuthority: Omit<WorkplaceDraftAuthority, "signature"> = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    keyVersion: AUTHORITY_KEY_VERSION,
    auditId,
    draftDigest,
  };
  const signature = signAuthority(payload, context, unsignedAuthority, env);
  const authority = { ...unsignedAuthority, signature };
  return {
    draft: { ...payload, authority },
    auditPayload: {
      [AUTHORITY_PAYLOAD_KEY]: {
        ...authority,
        organizationId: context.organizationId,
        rootQueueId: context.rootQueueId,
      } satisfies WorkplaceDraftAuditProof,
    },
  };
}

export function parseWorkplacePriorityDraft(value: unknown): WorkplaceDraftPayload & {
  authority?: WorkplaceDraftAuthority;
} {
  const payload = parseWorkplaceDraftPayload(value);
  const record = strictRecord(value, "Rozpracovaný výber priorít má neplatný formát.");
  const authority = record.authority === undefined ? undefined : parseAuthority(record.authority);
  return { ...payload, ...(authority ? { authority } : {}) };
}

export function verifyWorkplacePriorityDraftSignature(
  value: unknown,
  context: WorkplaceDraftAuthorityContext,
  env: Environment = process.env,
): WorkplaceDraftAuthority {
  const draft = parseWorkplacePriorityDraft(value);
  if (!draft.authority) {
    throw new MutationError("Aktuálnemu výberu priorít chýba serverový podpis.", 409);
  }
  const payload = withoutAuthority(draft);
  const actualDigest = sha256(canonicalJson(payload));
  if (!safeDigestEqual(draft.authority.draftDigest, actualDigest)) {
    throw new MutationError("Serverový podpis výberu priorít nezodpovedá jeho obsahu.", 409);
  }
  const expectedSignature = signAuthority(payload, context, {
    schemaVersion: draft.authority.schemaVersion,
    keyVersion: draft.authority.keyVersion,
    auditId: draft.authority.auditId,
    draftDigest: draft.authority.draftDigest,
  }, env);
  if (!safeDigestEqual(draft.authority.signature, expectedSignature)) {
    throw new MutationError("Serverový podpis výberu priorít nie je platný.", 409);
  }
  return draft.authority;
}

export async function requireLatestWorkplacePriorityDraftAuthority(
  client: AdminClient,
  value: unknown,
  context: WorkplaceDraftAuthorityContext,
  expectedAuditId?: string,
  env: Environment = process.env,
) {
  const authority = verifyWorkplacePriorityDraftSignature(value, context, env);
  if (expectedAuditId && authority.auditId !== expectedAuditId) {
    throw new MutationError("Výber priorít nezodpovedá autorizovanej verzii operácie.", 409);
  }
  const latest = await client
    .from("motorist_audit_log")
    .select("id, action, entity_id, after_payload, created_at")
    .eq("organization_id", context.organizationId)
    .eq("action", DRAFT_ACTION)
    .eq("entity_type", DRAFT_ENTITY_TYPE)
    .eq("entity_id", context.rootQueueId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (latest.error) {
    throw new MutationError("Serverový pôvod výberu priorít sa nepodarilo overiť.", 500);
  }
  const row = latest.data?.[0];
  if (!row || row.id !== authority.auditId || row.action !== DRAFT_ACTION || row.entity_id !== context.rootQueueId) {
    throw new MutationError("Výber priorít nezodpovedá najnovšiemu serverovému dôkazu.", 409);
  }
  const proof = parseAuditProof(jsonRecord(row.after_payload)[AUTHORITY_PAYLOAD_KEY]);
  if (
    proof.organizationId !== context.organizationId ||
    proof.rootQueueId !== context.rootQueueId ||
    proof.auditId !== row.id ||
    proof.schemaVersion !== authority.schemaVersion ||
    proof.keyVersion !== authority.keyVersion ||
    !safeDigestEqual(proof.draftDigest, authority.draftDigest) ||
    !safeDigestEqual(proof.signature, authority.signature)
  ) {
    throw new MutationError("Najnovší serverový dôkaz výberu priorít je neplatný.", 409);
  }
  return authority;
}

export function workplaceDraftAuthorityId(value: unknown) {
  return parseWorkplacePriorityDraft(value).authority?.auditId;
}

function parseWorkplaceDraftPayload(value: unknown): WorkplaceDraftPayload {
  const record = strictRecord(value, "Rozpracovaný výber priorít má neplatný formát.");
  const allowedTopLevel = new Set(["schemaVersion", "baseRevision", "selections", "selectedBy", "updatedAt", "authority"]);
  if (Object.keys(record).some((key) => !allowedTopLevel.has(key))) {
    throw new MutationError("Rozpracovaný výber priorít má neplatný formát.", 409);
  }
  if (
    record.schemaVersion !== 1 ||
    !Number.isInteger(record.baseRevision) ||
    (record.baseRevision as number) < 0 ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    new Date(record.updatedAt).toISOString() !== record.updatedAt
  ) {
    throw new MutationError("Rozpracovaný výber priorít má neplatný formát.", 409);
  }
  const selections = strictRecord(record.selections, "Rozpracovaný výber priorít má neplatné pracovné miesta.");
  const selectedBy = strictRecord(record.selectedBy, "Rozpracovaný výber priorít má neplatných držiteľov.");
  if (!hasExactQueueKeys(selections) || !hasExactQueueKeys(selectedBy)) {
    throw new MutationError("Rozpracovaný výber musí obsahovať presne priority 601, 602 a 603.", 409);
  }
  const allowedExtensions = new Set(configuredPersonalExtensions());
  const parsedSelections = {} as WorkplaceDraftPayload["selections"];
  const parsedSelectedBy = {} as WorkplaceDraftPayload["selectedBy"];
  const seen = new Set<string>();
  for (const queue of QUEUES) {
    const extension = selections[queue];
    const profileId = selectedBy[queue];
    if (
      extension !== null &&
      (typeof extension !== "string" || !allowedExtensions.has(extension) || seen.has(extension))
    ) {
      throw new MutationError("Rozpracovaný výber priorít obsahuje neplatné alebo duplicitné pracovné miesto.", 409);
    }
    if (
      (extension === null && profileId !== null) ||
      (extension !== null && (typeof profileId !== "string" || !profileId.trim() || profileId.length > 128))
    ) {
      throw new MutationError(`Rozpracovaná priorita ${queue} má neplatného držiteľa.`, 409);
    }
    if (typeof extension === "string") seen.add(extension);
    parsedSelections[queue] = typeof extension === "string" ? extension : null;
    parsedSelectedBy[queue] = typeof profileId === "string" ? profileId : null;
  }
  return {
    schemaVersion: 1,
    baseRevision: record.baseRevision as number,
    selections: parsedSelections,
    selectedBy: parsedSelectedBy,
    updatedAt: record.updatedAt,
  };
}

function parseAuthority(value: unknown): WorkplaceDraftAuthority {
  const record = strictRecord(value, "Serverový podpis výberu priorít má neplatný formát.");
  if (
    !hasExactKeys(record, ["schemaVersion", "keyVersion", "auditId", "draftDigest", "signature"]) ||
    record.schemaVersion !== AUTHORITY_SCHEMA_VERSION ||
    record.keyVersion !== AUTHORITY_KEY_VERSION ||
    typeof record.auditId !== "string" ||
    !UUID_PATTERN.test(record.auditId) ||
    typeof record.draftDigest !== "string" ||
    !HEX_DIGEST_PATTERN.test(record.draftDigest) ||
    typeof record.signature !== "string" ||
    !HEX_DIGEST_PATTERN.test(record.signature)
  ) {
    throw new MutationError("Serverový podpis výberu priorít má neplatný formát.", 409);
  }
  return {
    schemaVersion: 1,
    keyVersion: AUTHORITY_KEY_VERSION,
    auditId: record.auditId,
    draftDigest: record.draftDigest,
    signature: record.signature,
  };
}

function parseAuditProof(value: unknown): WorkplaceDraftAuditProof {
  const record = strictRecord(value, "Serverový dôkaz výberu priorít má neplatný formát.");
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "keyVersion",
      "auditId",
      "draftDigest",
      "signature",
      "organizationId",
      "rootQueueId",
    ]) ||
    typeof record.organizationId !== "string" ||
    typeof record.rootQueueId !== "string"
  ) {
    throw new MutationError("Serverový dôkaz výberu priorít má neplatný formát.", 409);
  }
  return {
    ...parseAuthority({
      schemaVersion: record.schemaVersion,
      keyVersion: record.keyVersion,
      auditId: record.auditId,
      draftDigest: record.draftDigest,
      signature: record.signature,
    }),
    organizationId: record.organizationId,
    rootQueueId: record.rootQueueId,
  };
}

function signAuthority(
  payload: WorkplaceDraftPayload,
  context: WorkplaceDraftAuthorityContext,
  authority: Omit<WorkplaceDraftAuthority, "signature">,
  env: Environment,
) {
  const key = createHmac("sha256", requiredServiceSecret(env))
    .update("motorist.telephony.workplace-draft.key-derivation.v1")
    .digest();
  return createHmac("sha256", key).update(canonicalJson({
    domain: "motorist.telephony.workplace-priority-draft.v1",
    ...context,
    ...authority,
    draft: payload,
  })).digest("hex");
}

function requiredServiceSecret(env: Environment) {
  const secret = [env.SUPABASE_SECRET_KEY, env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => value && value.trim().length > 0)
    ?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new MutationError("Serverový kľúč pre podpis výberu priorít chýba alebo je neplatný.", 503);
  }
  return secret;
}

function withoutAuthority(value: WorkplaceDraftPayload & { authority?: WorkplaceDraftAuthority }): WorkplaceDraftPayload {
  return {
    schemaVersion: value.schemaVersion,
    baseRevision: value.baseRevision,
    selections: { ...value.selections },
    selectedBy: { ...value.selectedBy },
    updatedAt: value.updatedAt,
  };
}

function hasExactQueueKeys(value: Record<string, unknown>) {
  return hasExactKeys(value, [...QUEUES]);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function strictRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError(message, 409);
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string) {
  if (!HEX_DIGEST_PATTERN.test(left) || !HEX_DIGEST_PATTERN.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new MutationError("Výber priorít nie je platný JSON.", 409);
}
