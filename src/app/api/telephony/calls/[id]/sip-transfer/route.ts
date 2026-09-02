import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { MutationError } from "@/server/motorist-mutations";
import { readWorkplaceLeaseFence, requireTelephonyActor } from "@/server/telephony-access";
import { enqueueBrowserSipReferTransferCommand } from "@/server/telephony/call-commands";
import {
  recordBrowserSipReferTransferDelivery,
  type BrowserSipReferDeliveryReport,
} from "@/server/telephony/telephony-commands";

export const runtime = "nodejs";
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type TransferBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  commandId?: unknown;
  destinationNumber?: unknown;
  destinationProfileId?: unknown;
  error?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
  outcome?: unknown;
  sipStatus?: unknown;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = await request.json().catch(() => null) as TransferBody | null;
    if (!body) throw new MutationError("Údaje SIP prepojenia musia byť platný JSON objekt.", 400);
    const { id } = await context.params;
    const leaseFence = body.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    const command = await enqueueBrowserSipReferTransferCommand(actor, id, {
      destinationNumber: body.destinationNumber,
      destinationProfileId: body.destinationProfileId,
    }, leaseFence);
    return Response.json({
      ok: true,
      command: { id: command.id, status: "accepted" },
      authorizedTarget: command.authorizedTarget,
      authorizedViptelUniqueId: command.authorizedViptelUniqueId,
    }, { status: 202, headers: NO_STORE_HEADERS });
  } catch (error) {
    return transferErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = await request.json().catch(() => null) as TransferBody | null;
    const { id } = await context.params;
    const callId = requiredUuid(id, "Hovor");
    const commandId = requiredUuid(body?.commandId, "Audit prepojenia");
    const command = await recordBrowserSipReferTransferDelivery({
      callId,
      commandId,
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      report: deliveryReport(body),
    });
    return Response.json({ ok: true, command }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return transferErrorResponse(error);
  }
}

function deliveryReport(body: TransferBody | null): BrowserSipReferDeliveryReport {
  if (
    body?.outcome === "accepted" &&
    typeof body.sipStatus === "number" &&
    Number.isInteger(body.sipStatus) &&
    body.sipStatus >= 200 &&
    body.sipStatus < 300
  ) return { outcome: "accepted", sipStatus: body.sipStatus };
  if (body?.outcome === "failed") {
    return {
      outcome: "failed",
      error: typeof body.error === "string" ? body.error.trim().slice(0, 240) : undefined,
    };
  }
  throw new MutationError("Výsledok SIP prepojenia nie je platný.", 400);
}

function requiredUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return value.trim();
}

function transferErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json(
      { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status, headers: NO_STORE_HEADERS },
    );
  }
  const serialized = serializeViptelError(error);
  return Response.json({ ok: false, error: serialized.message }, { status: serialized.status, headers: NO_STORE_HEADERS });
}
