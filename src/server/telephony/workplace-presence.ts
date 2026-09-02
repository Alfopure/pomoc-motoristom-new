import "server-only";

import { createHash, createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { workplaceHotdeskCapability } from "@/server/telephony/workplace-capability";
import { WORKPLACE_HEARTBEAT_INTERVAL_MS, type WorkplaceLeaseClientRef } from "@/server/telephony/workplace-lease";
import {
  createWorkplaceOperationRepository,
  type WorkplaceOperationRepository,
  type WorkplacePresenceResult,
} from "@/server/telephony/workplace-operation-repository";

type AdminClient = SupabaseClient<Database>;

export type WorkplaceHeartbeatInput = {
  leaseId: string;
  assignmentGeneration: string;
  browserInstanceId: string;
  leaderEpoch: number;
  leaseVersion: number;
};

export type WorkplaceResumeInput = WorkplaceHeartbeatInput & {
  idempotencyKey: string;
  resumeSecret: string;
};

export type WorkplacePresenceDependencies = {
  client?: AdminClient;
  repository?: WorkplaceOperationRepository;
  resumeSecretKey?: string;
};

export async function heartbeatWorkplaceLease(
  actor: MotoristActor,
  input: WorkplaceHeartbeatInput,
  dependencies: WorkplacePresenceDependencies = {},
) {
  requirePresenceCapability();
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const result = await repository.heartbeat({
    organizationId: actor.organizationId,
    profileId: actor.profileId,
    ...input,
  }).catch(() => {
    throw new MutationError("Prítomnosť pracoviska sa nepodarilo obnoviť.", 502);
  });
  assertPresenceResult(result);
  return { lease: await presenceLeaseRef(client, actor, result) };
}

export async function resumeWorkplaceLease(
  actor: MotoristActor,
  input: WorkplaceResumeInput,
  dependencies: WorkplacePresenceDependencies = {},
) {
  requirePresenceCapability();
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const previousResumeSecretHash = sha256(input.resumeSecret);
  const newResumeSecret = deriveNextResumeSecret(input, previousResumeSecretHash, dependencies);
  const result = await repository.resume({
    organizationId: actor.organizationId,
    leaseId: input.leaseId,
    profileId: actor.profileId,
    assignmentGeneration: input.assignmentGeneration,
    previousResumeSecretHash,
    newResumeSecretHash: sha256(newResumeSecret),
    newBrowserInstanceId: input.browserInstanceId,
    expectedLeaderEpoch: input.leaderEpoch,
    expectedLeaseVersion: input.leaseVersion,
    idempotencyKey: input.idempotencyKey,
  }).catch(() => {
    throw new MutationError("Reláciu pracoviska sa nepodarilo bezpečne presunúť do tohto okna.", 502);
  });
  assertPresenceResult(result);
  return { lease: await presenceLeaseRef(client, actor, result), resumeSecret: newResumeSecret };
}

function deriveNextResumeSecret(
  input: WorkplaceResumeInput,
  previousResumeSecretHash: string,
  dependencies: WorkplacePresenceDependencies,
) {
  const key = dependencies.resumeSecretKey ?? process.env.VIPTEL_WORKPLACE_RESUME_SECRET_KEY?.trim();
  if (!key || key.length < 32) {
    throw new MutationError("Server nemá bezpečný kľúč na obnovenie pracoviska.", 503, "hotdesk_disabled");
  }
  return createHmac("sha256", key)
    .update("motorist.workplace.resume.v2")
    .update("\0")
    .update(input.leaseId)
    .update("\0")
    .update(input.assignmentGeneration)
    .update("\0")
    .update(input.browserInstanceId)
    .update("\0")
    .update(input.idempotencyKey)
    .update("\0")
    .update(String(input.leaderEpoch))
    .update("\0")
    .update(String(input.leaseVersion))
    .update("\0")
    .update(previousResumeSecretHash)
    .digest("base64url");
}

function assertPresenceResult(result: WorkplacePresenceResult) {
  if (result.status === "lease_transitioning") {
    throw new MutationError("Zmena pracovného miesta sa práve dokončuje.", 423, "lease_transitioning");
  }
  if (result.status === "lease_lost") {
    throw new MutationError(
      "Toto pracovné miesto už používa iné okno alebo iný operátor.",
      409,
      "lease_lost",
    );
  }
}

async function presenceLeaseRef(
  client: AdminClient,
  actor: MotoristActor,
  result: WorkplacePresenceResult,
): Promise<WorkplaceLeaseClientRef> {
  if (!result.expiresAt || !result.browserInstanceId) {
    throw new MutationError("Databáza nepotvrdila obnovenú reláciu pracoviska.", 500);
  }
  const lease = await client
    .from("motorist_workplace_leases")
    .select("extension_id")
    .eq("organization_id", actor.organizationId)
    .eq("id", result.leaseId)
    .eq("profile_id", actor.profileId)
    .eq("assignment_generation", result.assignmentGeneration)
    .eq("state", "active")
    .maybeSingle();
  if (lease.error || !lease.data) throw new MutationError("Aktívna relácia pracoviska sa nenašla.", 409, "lease_lost");
  const extension = await client
    .from("motorist_telephony_extensions")
    .select("id, extension")
    .eq("organization_id", actor.organizationId)
    .eq("id", lease.data.extension_id)
    .eq("profile_id", actor.profileId)
    .eq("provider", "viptel")
    .eq("active", true)
    .maybeSingle();
  if (extension.error || !extension.data) {
    throw new MutationError("Pracovné miesto už nepatrí prihlásenému operátorovi.", 409, "lease_lost");
  }
  return {
    leaseId: result.leaseId,
    seatId: extension.data.id,
    extension: extension.data.extension,
    assignmentGeneration: result.assignmentGeneration,
    leaderEpoch: result.leaderEpoch,
    leaseVersion: result.leaseVersion,
    expiresAt: result.expiresAt,
    heartbeatIntervalMs: WORKPLACE_HEARTBEAT_INTERVAL_MS,
  };
}

function requirePresenceCapability() {
  const capability = workplaceHotdeskCapability();
  if (!capability.runtimeEnabled) {
    throw new MutationError("Správa aktívnych relácií pracovísk nie je povolená.", 503, "hotdesk_disabled");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
