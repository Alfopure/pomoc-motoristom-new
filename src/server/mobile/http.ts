import "server-only";

import type { MotoristActor } from "@/server/api-auth";
import type { MobileScope } from "@/lib/mobile-api";
import { HistoryQueryError } from "@/lib/telephony/call-history-query";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment } from "./auth";

const headers = { "Cache-Control": "private, no-store", Vary: "Authorization, X-PM-App-Environment" };

export function mobileScope(actor: MotoristActor): MobileScope {
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), profileId: actor.profileId, checkedAt: new Date().toISOString() };
}
export function mobileJson(body: unknown) {
  return Response.json(body, { headers });
}
export function mobileError(error: unknown, fallback: string) {
  const status = error instanceof HistoryQueryError ? 400 : error instanceof MutationError ? error.status : 503;
  const message = error instanceof HistoryQueryError || error instanceof MutationError ? error.message : fallback;
  return Response.json({ ok: false, error: message }, {
    status, headers: { ...headers, ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) },
  });
}
