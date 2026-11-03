import "server-only";

import type { MotoristActor } from "@/server/api-auth";
import type { MobileScope } from "@/lib/mobile-api";
import { HistoryQueryError } from "@/lib/telephony/call-history-query";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment } from "./auth";
import { CallActionError, OperatorDeviceError, PresenceServiceError } from "@/server/telephony/service-errors";

const headers = { "Cache-Control": "private, no-store", Vary: "Authorization, X-PM-App-Environment" };

export function mobileScope(actor: MotoristActor): MobileScope {
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), profileId: actor.profileId, checkedAt: new Date().toISOString() };
}
export function mobileJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}
export function mobileError(error: unknown, fallback: string) {
  const known = error instanceof MutationError || error instanceof CallActionError || error instanceof OperatorDeviceError || error instanceof PresenceServiceError;
  const status = error instanceof HistoryQueryError ? 400 : known ? error.status : 503;
  const message = error instanceof HistoryQueryError || known && status < 500 ? error.message : fallback;
  const code = known && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return Response.json({ ok: false, error: message, ...(code ? { code } : {}) }, {
    status, headers: { ...headers, ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) },
  });
}
