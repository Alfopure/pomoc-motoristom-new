import type { MobileCallContext, MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { draftDate, draftId } from "../drafts/port";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

const invalid = (): never => { throw new MobileApiError("Údaje hovoru sa nepodarilo overiť. Obnovte detail.", 502); };
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
const nullableDate = (value: unknown) => value === null || draftDate(value);

export function createCallContextApi(config: MobileConfig, profileId: string, organizationId: string, getToken: () => Promise<string | null>, current: () => boolean, transport: MobileTransport = fetch) {
  if (!draftId(profileId) || !draftId(organizationId)) throw new MobileApiError("Účet hovoru sa nepodarilo overiť.", 400);
  const assertCurrent = () => { if (!current()) throw new MobileApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte detail hovoru znova.", 401); };
  return {
    async read(target: MobileCallContextTarget, signal?: AbortSignal): Promise<MobileCallContext> {
      if (!target || !["call", "session"].includes(target.kind) || !draftId(target.id)) throw new MobileApiError("Neplatný výber hovoru.", 400);
      const selected = { kind: target.kind, id: target.id.toLowerCase() };
      const controller = new AbortController(), abort = () => controller.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 12_000);
      try {
        assertCurrent();
        const token = await getToken();
        assertCurrent();
        if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
        if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
        const response = await transport(config.apiOrigin + "/api/mobile/v1/calls/" + selected.id + "/context?source=" + selected.kind, {
          method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
          headers: { Authorization: "Bearer " + token, Accept: "application/json", "X-PM-App-Environment": config.environment, "X-PM-Expected-Organization": organizationId },
        });
        if (Number(response.headers.get("content-length")) > 64_000) return invalid();
        const raw = await response.text();
        assertCurrent();
        if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
        if (raw.length > 64_000) return invalid();
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return invalid(); }
        if (!response.ok) {
          const error = record(value, Object.hasOwn(value as object ?? {}, "code") ? ["ok", "error", "code"] : ["ok", "error"]);
          throw new MobileApiError(text(error.error, 1000) ? error.error : "Detail hovoru je dočasne nedostupný.", response.status, text(error.code, 100) ? error.code : undefined);
        }
        const body = record(value, ["ok", "apiVersion", "environment", "profileId", "organizationId", "checkedAt", "target", "call", "linkedCase", "linkState"]);
        if (body.ok !== true || body.apiVersion !== 1 || body.environment !== config.environment || body.profileId !== profileId || body.organizationId !== organizationId || !draftDate(body.checkedAt)) return invalid();
        const echo = record(body.target, ["kind", "id"]);
        if (echo.kind !== selected.kind || echo.id !== selected.id) return invalid();
        const call = record(body.call, ["id", "sessionId", "direction", "status", "number", "name", "lineLabel", "operatorName", "startedAt", "answeredAt", "endedAt", "durationSeconds"]);
        if (call.id !== null && !draftId(call.id) || call.sessionId !== null && !draftId(call.sessionId)
          || selected.kind === "call" && call.id !== selected.id || selected.kind === "session" && call.sessionId !== selected.id
          || !["inbound", "outbound", "internal"].includes(call.direction as string) || !text(call.status, 80)
          || !nullableText(call.number, 80) || !nullableText(call.name, 200) || !nullableText(call.lineLabel, 200) || !nullableText(call.operatorName, 200)
          || !draftDate(call.startedAt) || !nullableDate(call.answeredAt) || !nullableDate(call.endedAt)
          || call.durationSeconds !== null && (typeof call.durationSeconds !== "number" || !Number.isSafeInteger(call.durationSeconds) || call.durationSeconds < 0)
          || call.direction === "internal" && call.number !== null) return invalid();
        if (!["linked", "unlinked", "unavailable"].includes(body.linkState as string) || (body.linkState === "linked") !== (body.linkedCase !== null)) return invalid();
        if (body.linkedCase !== null) {
          const item = record(body.linkedCase, ["id", "caseNumber", "status", "statusLabel", "summary", "contactName", "licensePlate", "ownerName"]);
          if (!draftId(item.id) || !text(item.caseNumber, 120) || !text(item.status, 80) || !text(item.statusLabel, 120)
            || typeof item.summary !== "string" || item.summary.length > 2000 || item.summary.includes("\0")
            || !nullableText(item.contactName, 200) || !nullableText(item.licensePlate, 32) || !nullableText(item.ownerName, 200)) return invalid();
        }
        return body as unknown as MobileCallContext;
      } catch (error) {
        if (error instanceof MobileApiError) throw error;
        throw new MobileApiError("Detail hovoru sa nepodarilo načítať. Skontrolujte pripojenie a skúste znova.", 0);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    },
  };
}
export type CallContextApi = ReturnType<typeof createCallContextApi>;
