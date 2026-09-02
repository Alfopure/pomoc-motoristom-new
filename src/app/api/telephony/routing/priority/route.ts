import { serializeViptelError } from "@/lib/integrations/viptel/client";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  bootstrapDispatchQueueCatalog,
  getStoredDispatchRoutingOverview,
  previewOrStartEmptyDispatchRoutingPlan,
  previewOrStartDispatchRoutingPlan,
  recoverDispatchRoutingOperation,
  type DispatchPrioritySlot,
} from "@/server/telephony/dispatch-routing";

export const runtime = "nodejs";

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    return Response.json(
      { ok: true, routing: await getStoredDispatchRoutingOverview(actor) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const body = jsonRecord(await request.json().catch(() => null));
    const action = readString(body.action);

    if (action === "bootstrap") {
      const dryRun = body.dryRun !== false;
      const catalog = await bootstrapDispatchQueueCatalog(actor, dryRun);
      return privateJson({ ok: true, action, dryRun, catalog });
    }

    if (action === "apply") {
      const dryRun = body.dryRun !== false;
      const slots = Array.isArray(body.slots)
        ? body.slots.map((slot) => {
            const record = jsonRecord(slot);
            return { queue: readString(record.queue), extension: readString(record.extension) } as DispatchPrioritySlot;
          })
        : [];
      const fallback = jsonRecord(body.fallback);
      const result = await previewOrStartDispatchRoutingPlan(actor, {
        baseRevision: typeof body.baseRevision === "number" ? body.baseRevision : Number.NaN,
        slots,
        fallback: { queue: fallback.queue, extension: fallback.extension },
        previewDigest: body.previewDigest,
        dryRun,
      });
      return privateJson({ ok: true, action, ...result }, { status: dryRun ? 200 : 202 });
    }

    if (action === "bootstrap-empty") {
      const dryRun = body.dryRun !== false;
      const slots = Array.isArray(body.slots)
        ? body.slots.map((slot) => {
            const record = jsonRecord(slot);
            return { queue: readString(record.queue), extension: readString(record.extension) } as DispatchPrioritySlot;
          })
        : [];
      const result = await previewOrStartEmptyDispatchRoutingPlan(actor, {
        baseRevision: typeof body.baseRevision === "number" ? body.baseRevision : Number.NaN,
        slots,
        previewDigest: body.previewDigest,
        dryRun,
      });
      return privateJson({ ok: true, action, ...result }, { status: dryRun ? 200 : 202 });
    }

    if (action === "resume" || action === "rollback" || action === "reconcile") {
      const routing = await recoverDispatchRoutingOperation(actor, action);
      return privateJson({ ok: true, action, routing }, { status: action === "reconcile" ? 200 : 202 });
    }

    throw new MutationError("Akcia musí byť bootstrap, bootstrap-empty, apply, resume, rollback alebo reconcile.", 400);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return privateJson({ ok: false, error: error.message }, { status: error.status });
  }
  const serialized = serializeViptelError(error);
  return privateJson(
    { ok: false, error: serialized.message, providerStatus: serialized.providerStatus },
    { status: serialized.status },
  );
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
