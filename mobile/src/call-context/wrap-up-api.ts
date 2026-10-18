import type { MobileCallCaseInput, MobileCallCaseLinked, MobileCallOutcomeInput, MobileCallOutcomeSaved, MobileCallWrapUp } from "../../../src/lib/mobile-call-wrap-up";
import { MOBILE_CALL_NOTE_LIMIT, MOBILE_CALL_OUTCOMES } from "../../../src/lib/mobile-call-wrap-up";
import { draftDate, draftId } from "../drafts/port";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

const invalid = (): never => { throw new MobileApiError("Údaje po hovore sa nepodarilo overiť. Obnovte detail.", 502); };
const labels = new Map<string, string>(MOBILE_CALL_OUTCOMES.map(item => [item.value, item.label]));
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, multiline = false): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= max
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value);
}
const nullableText = (value: unknown, max: number, multiline = false) => value === null || text(value, max, multiline);
const lower = (value: unknown): value is string => draftId(value) && value === value.toLowerCase();

export function createCallWrapUpApi(config: MobileConfig, profileId: string, organizationId: string, getToken: () => Promise<string | null>, current: () => boolean, transport: MobileTransport = fetch) {
  if (!draftId(profileId) || !draftId(organizationId)) throw new MobileApiError("Účet hovoru sa nepodarilo overiť.", 400);
  const assertCurrent = () => { if (!current()) throw new MobileApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte detail hovoru znova.", 401); };
  async function send(path: string, body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, body ? 20_000 : 12_000);
    try {
      assertCurrent();
      const token = await getToken();
      assertCurrent();
      if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
      if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
      const response = await transport(config.apiOrigin + "/api/mobile/v1/calls/" + path, {
        method: body ? "POST" : "GET", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "X-PM-App-Environment": config.environment, "X-PM-Expected-Organization": organizationId,
          ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      assertCurrent();
      if (controller.signal.aborted) throw new MobileApiError("Požiadavka bola zrušená.", 0);
      if (raw.length > 64_000) return invalid();
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return invalid(); }
      if (!response.ok) {
        const error = record(value, Object.hasOwn(value as object ?? {}, "code") ? ["ok", "error", "code"] : ["ok", "error"]);
        throw new MobileApiError(text(error.error, 1000) ? error.error : "Údaje po hovore sú dočasne nedostupné.", response.status, text(error.code, 100) ? error.code : undefined);
      }
      const scope = value as Record<string, unknown>;
      if (scope.ok !== true || scope.apiVersion !== 1 || scope.environment !== config.environment || scope.profileId !== profileId
        || scope.organizationId !== organizationId || !draftDate(scope.checkedAt)) return invalid();
      return scope;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      throw new MobileApiError(body ? "Spojenie sa prerušilo. Výsledok overte obnovením detailu." : "Údaje po hovore sa nepodarilo načítať. Skontrolujte pripojenie.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const scopeKeys = ["ok", "apiVersion", "environment", "profileId", "organizationId", "checkedAt"] as const;
  return {
    async read(callId: string, signal?: AbortSignal): Promise<MobileCallWrapUp> {
      if (!draftId(callId)) throw new MobileApiError("Hovor sa nenašiel.", 404);
      const id = callId.toLowerCase();
      const body = record(await send(id + "/wrap-up", undefined, signal),
        [...scopeKeys, "callId", "number", "linkedCaseId", "linkedCase", "outcome", "callbackScheduling", "suggestions", "matchesAvailable"]);
      if (body.callId !== id || body.number !== null && !(text(body.number, 80) && /^\+?[0-9][0-9 ()-]{1,78}[0-9]$/.test(body.number))
        || body.linkedCaseId !== null && !lower(body.linkedCaseId)
        || !["queue", "case_task", "unavailable"].includes(body.callbackScheduling as string) || typeof body.matchesAvailable !== "boolean"
        || body.callbackScheduling === "case_task" && body.linkedCaseId === null) return invalid();
      if (body.linkedCase !== null) {
        const item = record(body.linkedCase, ["id", "caseNumber", "statusLabel"]);
        if (item.id !== body.linkedCaseId || !text(item.caseNumber, 120) || !text(item.statusLabel, 120)) return invalid();
      }
      if (body.outcome !== null) {
        const item = record(body.outcome, ["value", "label", "note", "callbackMinutes", "at"]);
        if (typeof item.value !== "string" || labels.get(item.value) !== item.label || !nullableText(item.note, MOBILE_CALL_NOTE_LIMIT, true)
          || item.callbackMinutes !== null && !(item.value === "callback" && Number.isSafeInteger(item.callbackMinutes) && (item.callbackMinutes as number) > 0)
          || item.at !== null && !draftDate(item.at)) return invalid();
      }
      if (!Array.isArray(body.suggestions) || body.suggestions.length > 5 || !body.matchesAvailable && body.suggestions.length) return invalid();
      const seen = new Set<string>();
      for (const value of body.suggestions) {
        const item = record(value, ["caseId", "caseNumber", "statusLabel", "open", "contactName", "reason"]);
        if (!lower(item.caseId) || seen.has(item.caseId) || item.caseId === body.linkedCaseId || !text(item.caseNumber, 120) || !text(item.statusLabel, 120)
          || typeof item.open !== "boolean" || !nullableText(item.contactName, 200) || !["contact", "previous_call"].includes(item.reason as string)) return invalid();
        seen.add(item.caseId);
      }
      return body as unknown as MobileCallWrapUp;
    },
    async saveOutcome(callId: string, input: MobileCallOutcomeInput): Promise<MobileCallOutcomeSaved> {
      const note = typeof input.note === "string" ? input.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
      if (!draftId(callId) || !draftId(input.mutationId) || !labels.has(input.outcome) || note.length > MOBILE_CALL_NOTE_LIMIT
        || (input.outcome === "callback" ? !(Number.isSafeInteger(input.callbackMinutes) && (input.callbackMinutes as number) >= 5 && (input.callbackMinutes as number) <= 1440) : input.callbackMinutes !== null)) {
        throw new MobileApiError("Výsledok hovoru nie je úplný.", 400);
      }
      const id = callId.toLowerCase(), mutationId = input.mutationId.toLowerCase();
      const body = record(await send(id + "/outcome", { mutationId, outcome: input.outcome, note: note || null, callbackMinutes: input.callbackMinutes }),
        [...scopeKeys, "callId", "mutationId", "replayed"]);
      if (body.callId !== id || body.mutationId !== mutationId || typeof body.replayed !== "boolean") return invalid();
      return body as unknown as MobileCallOutcomeSaved;
    },
    async linkCase(callId: string, input: MobileCallCaseInput): Promise<MobileCallCaseLinked> {
      if (!draftId(callId) || !draftId(input.caseId) || input.expectedCaseId !== null && !draftId(input.expectedCaseId)) throw new MobileApiError("Neplatné priradenie hovoru.", 400);
      const id = callId.toLowerCase(), caseId = input.caseId.toLowerCase();
      const body = record(await send(id + "/case", { caseId, expectedCaseId: input.expectedCaseId?.toLowerCase() ?? null }), [...scopeKeys, "callId", "caseId", "changed"]);
      if (body.callId !== id || body.caseId !== caseId || typeof body.changed !== "boolean") return invalid();
      return body as unknown as MobileCallCaseLinked;
    },
  };
}
export type CallWrapUpApi = ReturnType<typeof createCallWrapUpApi>;
