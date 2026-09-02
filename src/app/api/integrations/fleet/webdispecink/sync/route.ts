import { loadDispatchData } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { syncWebdispecinkFleet } from "@/server/webdispecink-sync";
import { serializeWebdispecinkError } from "@/lib/integrations/webdispecink/client";

export const runtime = "nodejs";

type SyncBody = {
  mode?: unknown;
};

export async function GET(request: Request) {
  try {
    authorizeWebdispecinkCron(request);

    if (!isWebdispecinkSyncEnabled()) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: "WebDispečink sync je vypnutý cez WEBDISPECINK_SYNC_ENABLED.",
      });
    }

    const summary = await syncWebdispecinkFleet({ mode: "positions" });

    return Response.json({ ok: true, summary });
  } catch (error) {
    return handleWebdispecinkSyncError(error);
  }
}

export async function POST(request: Request) {
  try {
    await authorizeWebdispecinkSync(request);

    if (!isWebdispecinkSyncEnabled()) {
      throw new MutationError("WebDispečink sync je vypnutý cez WEBDISPECINK_SYNC_ENABLED.", 503);
    }

    const body = (await request.json().catch(() => ({}))) as SyncBody;
    const mode = typeof body.mode === "string" ? body.mode : undefined;
    const summary = await syncWebdispecinkFleet({ mode: mode as "catalog" | "positions" | "full" | undefined });
    const dispatchData = await loadDispatchData();

    return Response.json({ ok: true, summary, dispatchData });
  } catch (error) {
    return handleWebdispecinkSyncError(error);
  }
}

function authorizeWebdispecinkCron(request: Request) {
  if (hasValidSyncToken(request)) {
    return;
  }

  throw new MutationError("WebDispečink cron token je neplatný alebo chýba.", 401);
}

async function authorizeWebdispecinkSync(request: Request) {
  if (hasValidSyncToken(request)) {
    return;
  }

  assertSameOriginRequest(request);
  await requireDefaultMotoristOrgRole(["manager", "admin"]);
}

function hasValidSyncToken(request: Request) {
  const configuredTokens = [process.env.WEBDISPECINK_SYNC_TOKEN, process.env.CRON_SECRET]
    .map((token) => token?.trim())
    .filter((token): token is string => Boolean(token && !token.startsWith("replace-with") && token !== "TODO"));

  if (configuredTokens.length === 0) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const headerToken = request.headers.get("x-webdispecink-sync-token")?.trim() ?? "";

  return configuredTokens.includes(bearer) || configuredTokens.includes(headerToken);
}

function isWebdispecinkSyncEnabled() {
  const value = process.env.WEBDISPECINK_SYNC_ENABLED?.trim().toLowerCase();

  return !value || !["0", "false", "off", "disabled"].includes(value);
}

function handleWebdispecinkSyncError(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status });
  }

  const serialized = serializeWebdispecinkError(error);
  console.error("WebDispecink fleet sync failed:", serialized.message);

  return Response.json(
    {
      ok: false,
      error: serialized.message,
      providerStatus: serialized.providerStatus,
      providerResponseSummary: serialized.providerResponseSummary,
    },
    { status: serialized.status },
  );
}
