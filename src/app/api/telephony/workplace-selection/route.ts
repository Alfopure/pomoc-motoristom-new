import { MutationError } from "@/server/motorist-mutations";
import { readWorkplaceLeaseFence, requireTelephonyActor } from "@/server/telephony-access";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import {
  getWorkplaceSelection,
  mutateWorkplaceSelection,
  type WorkplaceMutationAction,
} from "@/server/telephony/workplace-selection";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const actor = await requireTelephonyActor();
    return Response.json(
      { ok: true, workplace: await getWorkplaceSelection(actor) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = jsonRecord(await request.json().catch(() => null));
    const action = readAction(body.action, body);
    assertTelephonyLiveMutationEnabled(`workplace.${action.action}`);
    const response = await mutateWorkplaceSelection(actor, action);
    return Response.json(
      { ok: true, ...response },
      { status: response.result.state === "pending" ? 202 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function readAction(value: unknown, body: Record<string, unknown>): WorkplaceMutationAction {
  if (value === "select_seat") {
    return {
      action: value,
      extension: body.extension,
      browserInstanceId: readUuid(body.browserInstanceId, "Relácia prehliadača"),
      idempotencyKey: readUuid(body.idempotencyKey, "Identifikátor požiadavky"),
      ...(body.expectedVersion === undefined
        ? {}
        : { expectedVersion: readOpaqueVersion(body.expectedVersion) }),
    };
  }
  if (value === "leave_seat") {
    return {
      action: value,
      browserInstanceId: readUuid(body.browserInstanceId, "Relácia prehliadača"),
      idempotencyKey: readUuid(body.idempotencyKey, "Identifikátor požiadavky"),
      ...(body.expectedVersion === undefined
        ? {}
        : { expectedVersion: readOpaqueVersion(body.expectedVersion) }),
    };
  }
  if (value === "confirm_seat_change" || value === "cancel_seat_change") {
    return {
      action: value,
      browserInstanceId: readUuid(body.browserInstanceId, "Relácia prehliadača"),
      idempotencyKey: readUuid(body.idempotencyKey, "Identifikátor požiadavky"),
      operationId: readUuid(body.operationId, "Rozpracovaná zmena"),
      ...(value === "confirm_seat_change" && body.browserDisconnectOutcome !== undefined
        ? { browserDisconnectOutcome: readBrowserDisconnectOutcome(body.browserDisconnectOutcome) }
        : {}),
    };
  }
  if (value === "claim_seat") return { action: value, extension: body.extension };
  if (value === "release_seat") return { action: value };
  if (value === "takeover_seat") return { action: value, extension: body.extension };
  if (value === "release_occupied_seat") return { action: value, extension: body.extension };
  if (value === "claim_priority") return {
    action: value,
    queue: body.queue,
    ...(body.leaseId === undefined ? {} : { leaseFence: readWorkplaceLeaseFence(body) }),
  };
  if (value === "recover_priority") return {
    action: value,
    operationId: readUuid(body.operationId, "Rozpracovaná zmena poradia"),
    leaseFence: readWorkplaceLeaseFence(body),
  };
  if (value === "release_priority") return {
    action: value,
    ...(body.leaseId === undefined ? {} : { leaseFence: readWorkplaceLeaseFence(body) }),
  };
  throw new MutationError(
    "Vyber platnú akciu pracovného miesta alebo poradia zvonenia.",
    400,
  );
}

function errorResponse(error: unknown) {
  const mutationError = error instanceof MutationError ? error : undefined;
  return Response.json(
    {
      ok: false,
      error: mutationError?.message ?? "Výber pracoviska sa nepodarilo spracovať.",
      ...(mutationError?.code ? { code: mutationError.code } : {}),
    },
    {
      status: mutationError?.status ?? 500,
      headers: NO_STORE_HEADERS,
    },
  );
}

function readUuid(value: unknown, label: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return normalized;
}

function readOpaqueVersion(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(normalized)) {
    throw new MutationError("Verzia pracoviska nie je platná.", 400);
  }
  return normalized;
}

function readBrowserDisconnectOutcome(value: unknown) {
  if (value === "accepted" || value === "not_connected") return value;
  throw new MutationError("Potvrdenie odpojenia telefónu nie je platné.", 400);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
