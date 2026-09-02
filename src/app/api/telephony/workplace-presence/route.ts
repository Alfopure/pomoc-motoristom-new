import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import {
  heartbeatWorkplaceLease,
  resumeWorkplaceLease,
  type WorkplaceHeartbeatInput,
} from "@/server/telephony/workplace-presence";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = record(await request.json().catch(() => null));
    const input = readPresenceInput(body);
    const response = body.action === "resume"
      ? await resumeWorkplaceLease(actor, {
          ...input,
          idempotencyKey: readUuid(body.idempotencyKey, "Identifikátor obnovenia"),
          resumeSecret: readResumeSecret(body.resumeSecret),
        })
      : await heartbeatWorkplaceLease(actor, input);
    return Response.json({ ok: true, ...response }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const expected = error instanceof MutationError;
    return Response.json({
      ok: false,
      error: expected ? error.message : "Prítomnosť pracoviska sa nepodarilo spracovať.",
      ...(expected && error.code ? { code: error.code } : {}),
    }, { status: expected ? error.status : 500, headers: NO_STORE_HEADERS });
  }
}

function readPresenceInput(body: Record<string, unknown>): WorkplaceHeartbeatInput {
  if (body.action !== undefined && body.action !== "heartbeat" && body.action !== "resume") {
    throw new MutationError("Akcia prítomnosti nie je platná.", 400);
  }
  return {
    leaseId: readUuid(body.leaseId, "Relácia pracoviska"),
    assignmentGeneration: readUuid(body.assignmentGeneration, "Generácia pracoviska"),
    browserInstanceId: readUuid(body.browserInstanceId, "Okno prehliadača"),
    leaderEpoch: readPositiveInteger(body.leaderEpoch, "Generácia okna"),
    leaseVersion: readPositiveInteger(body.leaseVersion, "Verzia relácie"),
  };
}

function readUuid(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return normalized.toLowerCase();
}

function readPositiveInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new MutationError(`${label} nie je platná.`, 400);
  }
  return value;
}

function readResumeSecret(value: unknown) {
  const secret = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(secret)) throw new MutationError("Obnovovací kľúč nie je platný.", 400);
  return secret;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationError("Údaje prítomnosti musia byť JSON objekt.", 400);
  }
  return value as Record<string, unknown>;
}
