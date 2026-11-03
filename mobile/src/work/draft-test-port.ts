import { vi } from "vitest";
import { DraftNotSentError, type DraftPort } from "../drafts/port";
export const jsonCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
export function memoryPort(saved: unknown = null) {
  const record = { payload: saved, live: true, settled: true, finishOk: true, reject: false, writes: [] as object[] };
  const port: DraftPort = {
    load: () => record.payload,
    changed: vi.fn(payload => { record.payload = jsonCopy(payload); record.settled = true; }),
    prepare: vi.fn(async payload => {
      if (!record.live) throw new DraftNotSentError();
      const value = typeof payload === "function" ? payload() : payload;
      record.payload = jsonCopy(value); record.writes.push(jsonCopy(value)); record.settled = true;
      return { finish: vi.fn(async outcome => { record.writes.push(jsonCopy(outcome)); if (!record.finishOk) { record.settled = false; return false; } record.payload = jsonCopy(outcome); return true; }) };
    }),
    current: () => record.live, settled: () => record.settled,
    acceptsScope: value => { const v = value as Record<string, unknown>; return v?.ok === true && v.apiVersion === 1 && v.environment === "test" && typeof v.profileId === "string" && v.profileId.endsWith("0001"); },
    reject: vi.fn(() => { record.reject = true; record.live = false; }),
  };
  return { port, record };
}
