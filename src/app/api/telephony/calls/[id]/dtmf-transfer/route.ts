import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { buildDtmfTransferPlan, type DtmfTransferMode } from "@/lib/telephony/dtmf-transfer";
import { MutationError } from "@/server/motorist-mutations";
import { readWorkplaceLeaseFence, requireTelephonyActor } from "@/server/telephony-access";
import { enqueueBrowserDtmfTransferCommand } from "@/server/telephony/call-commands";
import {
  recordBrowserDtmfTransferDelivery,
  type BrowserDtmfTransferDeliveryReport,
} from "@/server/telephony/telephony-commands";

export const runtime = "nodejs";

type BeginBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  destination?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
  mode?: unknown;
};

type DeliveryBody = {
  commandId?: unknown;
  error?: unknown;
  failedToneIndex?: unknown;
  outcome?: unknown;
  sentToneCount?: unknown;
};

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const parsedBody = await request.json().catch(() => undefined);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new MutationError("Údaje DTMF prepojenia musia byť platný JSON objekt.", 400);
    }
    const body = parsedBody as BeginBody;
    const { id } = await context.params;
    const plan = beginPlan(body);
    const leaseFence = body.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    const command = await enqueueBrowserDtmfTransferCommand(actor, id, plan.mode, plan.target, leaseFence);

    return Response.json(
      {
        ok: true,
        command: {
          confirmationModel: "unconfirmed",
          id: command.id,
          status: "accepted",
        },
        authorizedViptelUniqueId: command.authorizedViptelUniqueId,
        tonePlan: command.tonePlan,
      },
      { status: 202, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = (await request.json().catch(() => null)) as DeliveryBody | null;
    const { id } = await context.params;
    const callId = requiredUuid(id, "Hovor");
    const commandId = requiredUuid(body?.commandId, "Audit prepojenia");
    const report = deliveryReport(body);
    const command = await recordBrowserDtmfTransferDelivery({
      callId,
      commandId,
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      report,
    });

    return Response.json(
      {
        ok: true,
        command: {
          confirmationModel: "unconfirmed",
          id: command.id,
          status: command.status,
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return transferErrorResponse(error);
  }
}

function deliveryReport(body: DeliveryBody | null): BrowserDtmfTransferDeliveryReport {
  if (body?.outcome === "complete") return { outcome: "complete" };

  if (body?.outcome === "failed") {
    if (body.sentToneCount !== 0 || body.failedToneIndex !== 0) {
      throw new MutationError("Zlyhanie pred prvým tónom musí mať nulový počet aj index.", 400);
    }
    return {
      outcome: "failed",
      sentToneCount: 0,
      failedToneIndex: 0,
      error: optionalError(body.error),
    };
  }

  if (body?.outcome === "partial") {
    if (
      typeof body.sentToneCount !== "number" ||
      !Number.isInteger(body.sentToneCount) ||
      body.sentToneCount < 1 ||
      body.sentToneCount > 64
    ) {
      throw new MutationError("Počet odoslaných tónov nie je platný.", 400);
    }
    return {
      outcome: "partial",
      sentToneCount: body.sentToneCount,
      error: optionalError(body.error),
    };
  }

  throw new MutationError("Výsledok DTMF prepojenia nie je platný.", 400);
}

function beginPlan(body: BeginBody) {
  try {
    return buildDtmfTransferPlan(body.mode as DtmfTransferMode, body.destination);
  } catch (error) {
    throw new MutationError(
      error instanceof Error ? error.message : "Cieľ prepojenia nie je platný.",
      400,
    );
  }
}

function requiredUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return value.trim();
}

function optionalError(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : undefined;
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
