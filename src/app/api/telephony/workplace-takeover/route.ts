import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import {
  cancelWorkplaceTakeover,
  completeWorkplaceTakeover,
  getWorkplaceTakeoverSnapshot,
  requestWorkplaceTakeover,
  respondToWorkplaceTakeover,
} from "@/server/telephony/workplace-takeover-service";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const actor = await requireTelephonyActor();
    return Response.json(
      { ok: true, takeover: await getWorkplaceTakeoverSnapshot(actor) },
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
    const action = string(body.action);
    assertTelephonyLiveMutationEnabled(`workplace.takeover_request.${action}`);

    const response = action === "request"
      ? await requestWorkplaceTakeover(actor, body.extension)
      : action === "respond"
        ? await respondToWorkplaceTakeover(
            actor,
            readUuid(body.requestId),
            readDecision(body.decision),
          )
        : action === "cancel"
          ? await cancelWorkplaceTakeover(actor, readUuid(body.requestId))
          : action === "complete"
            ? await completeWorkplaceTakeover(actor, readUuid(body.requestId))
            : (() => {
                throw new MutationError("Vyber platnú akciu žiadosti o pracovné miesto.", 400);
              })();
    return Response.json({ ok: true, ...response }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

function readDecision(value: unknown) {
  if (value === "accept" || value === "decline") return value;
  throw new MutationError("Vyber, či chceš pracovné miesto odovzdať alebo žiadosť odmietnuť.", 400);
}

function readUuid(value: unknown) {
  const normalized = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new MutationError("Žiadosť nemá platný identifikátor.", 400);
  }
  return normalized;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorResponse(error: unknown) {
  const mutationError = error instanceof MutationError ? error : undefined;
  return Response.json(
    {
      ok: false,
      error: mutationError?.message ?? "Žiadosť o pracovné miesto sa nepodarilo spracovať.",
      ...(mutationError?.code ? { code: mutationError.code } : {}),
    },
    {
      status: mutationError?.status ?? 500,
      headers: NO_STORE_HEADERS,
    },
  );
}
