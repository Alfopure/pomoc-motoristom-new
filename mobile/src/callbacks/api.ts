import type { MobileCallbackChanged, MobileCallbackRequest, MobileCallbackResolveInput, MobileCallbacks } from "../../../src/lib/mobile-callbacks";
import { MOBILE_CALLBACK_NOTE_LIMIT } from "../../../src/lib/mobile-callbacks";
import { draftDate, draftId } from "../drafts/port";
import { callbackCounts, MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

const invalid = (): never => { throw new MobileApiError("Spätné volania sa nepodarilo overiť. Obnovte zoznam.", 502); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, multiline = false): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
const nullableText = (value: unknown, max: number, multiline = false) => value === null || text(value, max, multiline);
const nullableDate = (value: unknown) => value === null || draftDate(value);
const REQUEST_KEYS = ["id", "number", "name", "status", "origin", "originDetail", "sourceLabel", "lineLabel", "partnerName", "caseId", "claimant", "claimedAt",
  "deadlineAt", "createdAt", "resolvedAt", "notes", "lastCalledAt", "actions"] as const;

/** Strict projection check; actions are server decisions and must agree with state. */
export function callbackRequest(value: unknown, profileId: string): MobileCallbackRequest {
  const item = record(value, REQUEST_KEYS);
  const actions = record(item.actions, ["claim", "takeover", "call", "resolve", "blockedReason"]);
  const live = item.status === "open" || item.status === "scheduled";
  if (!draftId(item.id) || item.id !== item.id.toLowerCase() || !["open", "scheduled", "done", "cancelled"].includes(item.status as string)
    || !["requested", "missed", "manual", "unknown"].includes(item.origin as string)
    || item.number !== null && !(text(item.number, 80) && /^\+?[0-9][0-9 ()-]{1,78}[0-9]$/.test(item.number))
    || !nullableText(item.name, 200) || !nullableText(item.originDetail, 300) || !text(item.sourceLabel, 120)
    || !nullableText(item.lineLabel, 200) || !nullableText(item.partnerName, 200) || item.caseId !== null && !draftId(item.caseId)
    || !nullableDate(item.claimedAt) || !nullableDate(item.deadlineAt) || !draftDate(item.createdAt) || !nullableDate(item.resolvedAt)
    || !nullableText(item.notes, MOBILE_CALLBACK_NOTE_LIMIT, true) || !nullableDate(item.lastCalledAt)
    || !live && item.deadlineAt !== null
    || ["claim", "takeover", "call", "resolve"].some(key => typeof actions[key] !== "boolean") || !nullableText(actions.blockedReason, 300)) return invalid();
  if (item.claimant !== null) {
    const claimant = record(item.claimant, ["id", "name", "mine"]);
    if (!draftId(claimant.id) || !nullableText(claimant.name, 200) || claimant.mine !== (claimant.id === profileId.toLowerCase())) return invalid();
  }
  const claimant = item.claimant as MobileCallbackRequest["claimant"];
  if (!live && (actions.claim || actions.call || actions.resolve) || actions.takeover && (!actions.claim || !claimant || claimant.mine)
    || actions.claim && claimant?.mine || actions.call && item.number === null
    || (actions.blockedReason === null) !== (actions.resolve || actions.claim || actions.call)) return invalid();
  return item as unknown as MobileCallbackRequest;
}

export function createCallbacksApi(config: MobileConfig, profileId: string, organizationId: string, getToken: () => Promise<string | null>, current: () => boolean, transport: MobileTransport = fetch) {
  if (!draftId(profileId) || !draftId(organizationId)) throw new MobileApiError("Účet spätných volaní sa nepodarilo overiť.", 400);
  const assertCurrent = () => { if (!current()) throw new MobileApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte spätné volania znova.", 401); };
  async function send(path: string, init: { method: "GET" | "POST"; body?: object }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, init.method === "GET" ? 12_000 : 20_000);
    try {
      assertCurrent();
      const token = await getToken();
      assertCurrent();
      if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
      if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
      const response = await transport(config.apiOrigin + "/api/mobile/v1/callbacks" + path, {
        method: init.method, credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "X-PM-App-Environment": config.environment, "X-PM-Expected-Organization": organizationId,
          ...(init.body ? { "Content-Type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      if (Number(response.headers.get("content-length")) > 512_000) return invalid();
      const raw = await response.text();
      assertCurrent();
      if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
      if (raw.length > 512_000) return invalid();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return invalid(); }
      if (!response.ok) {
        const error = record(value, Object.hasOwn(value as object ?? {}, "code") ? ["ok", "error", "code"] : ["ok", "error"]);
        throw new MobileApiError(text(error.error, 1000) ? error.error : "Spätné volania sú dočasne nedostupné.", response.status, text(error.code, 100) ? error.code : undefined);
      }
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      throw new MobileApiError(init.method === "GET" ? "Spätné volania sa nepodarilo načítať. Skontrolujte pripojenie a skúste znova."
        : "Spojenie sa prerušilo. Výsledok overte obnovením zoznamu.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  function scoped(body: Record<string, unknown>) {
    if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment || body.profileId !== profileId
      || body.organizationId !== organizationId || !draftDate(body.checkedAt)) return invalid();
  }
  async function change(id: string, action: "claim" | "resolve", input?: MobileCallbackResolveInput): Promise<MobileCallbackChanged> {
    if (!draftId(id)) throw new MobileApiError("Požiadavka na spätné volanie sa nenašla.", 404);
    const selected = id.toLowerCase();
    const body = record(await send("/" + selected + "/" + action, { method: "POST", ...(input ? { body: input } : {}) }),
      ["ok", "apiVersion", "environment", "profileId", "organizationId", "checkedAt", "request"]);
    scoped(body);
    const request = callbackRequest(body.request, profileId);
    if (request.id !== selected) return invalid();
    if (action === "claim" && (request.status !== "scheduled" || !request.claimant?.mine)) return invalid();
    // A note-less resolution keeps the request's earlier note on the server.
    if (action === "resolve" && (request.status !== input?.status || input.notes !== null && request.notes !== input.notes)) return invalid();
    return body as unknown as MobileCallbackChanged;
  }
  return {
    async list(cursor: string | null, signal?: AbortSignal): Promise<MobileCallbacks> {
      if (cursor !== null && !(cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor))) throw new MobileApiError("Zoznam spätných volaní sa zmenil. Obnovte ho od začiatku.", 400);
      const body = record(await send(cursor ? "?cursor=" + cursor : "", { method: "GET" }, signal),
        ["ok", "apiVersion", "environment", "profileId", "organizationId", "checkedAt", "counts", "open", "resolved", "nextCursor", "resetPage"]);
      scoped(body);
      callbackCounts(body.counts);
      if (!Array.isArray(body.open) || body.open.length > 100 || !Array.isArray(body.resolved) || body.resolved.length > 20
        || cursor && body.resolved.length || typeof body.resetPage !== "boolean"
        || body.nextCursor !== null && !(typeof body.nextCursor === "string" && body.nextCursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(body.nextCursor))) return invalid();
      const open = body.open.map(item => callbackRequest(item, profileId)), resolved = body.resolved.map(item => callbackRequest(item, profileId));
      if (open.some(item => item.status !== "open" && item.status !== "scheduled") || resolved.some(item => item.status !== "done" && item.status !== "cancelled")
        || new Set([...open, ...resolved].map(item => item.id)).size !== open.length + resolved.length) return invalid();
      return body as unknown as MobileCallbacks;
    },
    claim: (id: string) => change(id, "claim"),
    async resolve(id: string, input: MobileCallbackResolveInput): Promise<MobileCallbackChanged> {
      const notes = typeof input.notes === "string" ? input.notes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : null;
      if (input.status !== "done" && input.status !== "cancelled" || notes !== null && notes.length > MOBILE_CALLBACK_NOTE_LIMIT) {
        throw new MobileApiError(`Poznámka môže mať najviac ${MOBILE_CALLBACK_NOTE_LIMIT} znakov.`, 400);
      }
      return change(id, "resolve", { status: input.status, notes: notes || null });
    },
  };
}
export type CallbacksApi = ReturnType<typeof createCallbacksApi>;
