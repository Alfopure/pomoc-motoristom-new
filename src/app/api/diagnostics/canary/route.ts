import { timingSafeEqual } from "node:crypto";
import { TEST_APP_ORIGIN } from "@/lib/app-environment";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { captureServerError } from "@/server/diagnostics/server-errors";
import { BROWSER_CANARY_COOKIE, BROWSER_CANARY_MAX_AGE_SECONDS, canaryDeploymentEnabled, createBrowserCanaryPermit } from "@/server/diagnostics/canary-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let attempts: number[] = [];
let total = 0;

function machineAuthorized(request: Request): boolean {
  const secret = process.env.DIAGNOSTICS_TEST_CANARY_TOKEN;
  const supplied = request.headers.get("authorization");
  if (!secret || secret.length < 32 || secret.length > 256 || !supplied?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(supplied.slice(7));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Fixed observation only: never accepts error text, identities, provider IDs or SQL. */
function canaryError(): Error {
  return Object.assign(new Error("Diagnostic canary"), { code: "DIAGNOSTIC_TEST_CANARY" });
}

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!canaryDeploymentEnabled()) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== TEST_APP_ORIGIN) return Response.json({ error: "forbidden" }, { status: 403, headers });
  try {
    if (!machineAuthorized(request)) {
      // A supplied invalid bearer never falls through to cookie authentication.
      if (request.headers.has("authorization")) return Response.json({ error: "unauthorized" }, { status: 401, headers });
      assertSameOriginRequest(request);
      await requireDefaultMotoristActor(["admin"]);
    }
  } catch (error) {
    return Response.json({ error: "forbidden" }, { status: error instanceof MutationError && error.status === 401 ? 401 : 403, headers });
  }
  const now = Date.now();
  attempts = attempts.filter(at => at > now - 60_000);
  // Per warm instance; high-entropy temporary token is the authorization boundary.
  if (attempts.length >= 3 || total >= 20) return Response.json({ error: "rate_limited" }, { status: 429, headers });
  attempts.push(now); total++;
  const receipt = await captureServerError(canaryError(), { source: "canary", route: "/api/diagnostics/canary", status: 500 });
  const response = Response.json(receipt, { status: receipt.accepted ? 200 : 503, headers });
  const permit = receipt.accepted ? createBrowserCanaryPermit() : null;
  if (permit) response.headers.set("Set-Cookie", `${BROWSER_CANARY_COOKIE}=${permit}; Path=/diagnostics/canary; Max-Age=${BROWSER_CANARY_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  return response;
}
