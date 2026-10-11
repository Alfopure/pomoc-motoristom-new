import type { MobileConsole, MobileHistory, MobileMe, MobileScope } from "../../../src/lib/mobile-api";
import type { MobileConfig } from "./config";

export class MobileApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

// The query cache is scoped to the authenticated user and environment. A
// failed background refresh must not disconnect an already-authorized call.
// Auth, scope and malformed-contract failures still revoke cached access.
export function usableMobileIdentity(data: MobileMe | undefined, error: unknown): MobileMe | null {
  if (!data) return null;
  if (!error) return data;
  return error instanceof MobileApiError && (error.status === 0
    || error.status >= 500 && error.status <= 599 && error.status !== 502) ? data : null;
}
type TokenGetter = () => Promise<string | null>;
export type MobileTransport = (url: string, init: RequestInit) => Promise<Response>;
type HistoryFilter = { category: "all" | "missed" | "received" | "outbound"; q: string; cursor?: string | null };
const contractError = () => new MobileApiError("Odpoveď aplikácie sa nepodarilo overiť. Skúste obnoviť údaje.", 502);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string"; }
function nullableText(value: unknown): boolean { return value === null || text(value); }
function scope(value: unknown, config: MobileConfig, profileId?: string): MobileScope {
  const body = object(value);
  if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment
    || !text(body.profileId) || !text(body.checkedAt) || !Number.isFinite(Date.parse(body.checkedAt))
    || profileId && body.profileId !== profileId) throw contractError();
  return body as MobileScope;
}
function capabilities(value: unknown) {
  const data = object(value);
  // M1 exposes no calling actions. A backend toggle cannot activate them.
  if (data.voice !== false || data.presenceWrite !== false) throw contractError();
}
function callFields(value: unknown) {
  const call = object(value);
  if (!text(call.id) || !["inbound", "outbound", "internal"].includes(String(call.direction))
    || !nullableText(call.number) || !nullableText(call.name) || !text(call.startedAt)) throw contractError();
  return call;
}

export function createMobileApi(config: MobileConfig, getToken: TokenGetter, transport: MobileTransport = fetch) {
  async function read(path: string, signal?: AbortSignal): Promise<unknown> {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihlásenie vypršalo. Prihláste sa znova.", 401);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 12_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/" + path, {
        method: "GET", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json" },
      });
      let body: unknown;
      try { body = await response.json(); } catch { throw contractError(); }
      if (!response.ok) {
        const error = object(body).error;
        throw new MobileApiError(text(error) ? error : "Údaje sa nepodarilo načítať.", response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof MobileApiError || signal?.aborted) throw error;
      throw new MobileApiError("Nepodarilo sa spojiť s aplikáciou. Skontrolujte pripojenie a skúste znova.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return {
    me: async (signal?: AbortSignal): Promise<MobileMe> => {
      const body = object(await read("me", signal));
      scope(body, config);
      const profile = object(body.profile);
      if (profile.id !== body.profileId || !text(profile.displayName) || !nullableText(profile.email)
        || !["dispatcher", "senior_dispatcher", "manager", "admin"].includes(String(profile.role))) throw contractError();
      capabilities(body.capabilities);
      return body as MobileMe;
    },
    console: async (profileId: string, signal?: AbortSignal): Promise<MobileConsole> => {
      const body = object(await read("console", signal));
      scope(body, config, profileId);
      const presence = object(body.presence);
      if (!["available", "paused", "offline", "ringing", "on_call", "after_call_work"].includes(String(presence.status)) || !nullableText(presence.since)
        || !Array.isArray(body.activeCalls) || body.activeCalls.length > 100) throw contractError();
      for (const value of body.activeCalls) {
        const call = callFields(value);
        if (!text(call.state) || !nullableText(call.lineLabel)) throw contractError();
      }
      capabilities(body.capabilities);
      return body as MobileConsole;
    },
    history: async (profileId: string, filter: HistoryFilter, signal?: AbortSignal): Promise<MobileHistory> => {
      const params = new URLSearchParams({ category: filter.category, q: filter.q, limit: "25" });
      if (filter.cursor) params.set("cursor", filter.cursor);
      const body = object(await read("calls/history?" + params.toString(), signal));
      scope(body, config, profileId);
      if (!Array.isArray(body.calls) || body.calls.length > 100 || !nullableText(body.nextCursor)) throw contractError();
      for (const value of body.calls) {
        const call = callFields(value);
        if (!text(call.status) || !text(call.lineLabel) || !nullableText(call.operatorName)
          || !nullableText(call.answeredAt) || !nullableText(call.endedAt)
          || !(call.durationSeconds === null || typeof call.durationSeconds === "number" && Number.isFinite(call.durationSeconds) && call.durationSeconds >= 0)) throw contractError();
      }
      return body as MobileHistory;
    },
  };
}
export type MobileApi = ReturnType<typeof createMobileApi>;
