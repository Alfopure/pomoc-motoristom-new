import type { MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import type { VoiceDiagnosticEvent } from "./diagnostics";

export type DiagnosticsUploadResult = { status: number; code?: string };
export type DiagnosticsUploader = { request(): void; dispose(): void };
type Options = {
  events: () => Promise<VoiceDiagnosticEvent[]>; clear: (upToId: number) => Promise<void>;
  send: (events: VoiceDiagnosticEvent[]) => Promise<DiagnosticsUploadResult>;
  /** The shortest time between two uploads, and the wait after a trigger for its trailing events. */
  interval?: number; settle?: number; now?: () => number;
};
const BATCH = 100, BATCH_CHARACTERS = 48_000, BATCHES = 3;

/** Uploads the native device-log ring a moment after a trigger (a call ended, a refused push,
 * the app came forward), at most once per interval. Events are forgotten only after a 2xx;
 * anything else waits for the next trigger. A server with the upload switched off stops it. */
export function createDiagnosticsUploader({ events, clear, send, interval = 30_000, settle = 2_000, now = Date.now }: Options): DiagnosticsUploader {
  let last = Number.NEGATIVE_INFINITY, timer: ReturnType<typeof setTimeout> | null = null, busy = false, again = false, stopped = false;
  async function upload() {
    timer = null;
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true; last = now();
    try {
      let pending = await events();
      for (let count = 0; count < BATCHES && pending.length && !stopped; count += 1) {
        const batch: VoiceDiagnosticEvent[] = [];
        let characters = 0;
        for (const event of pending.slice(0, BATCH)) {
          characters += JSON.stringify(event).length + 1;
          if (batch.length && characters > BATCH_CHARACTERS) break;
          batch.push(event);
        }
        const result = await send(batch);
        if (result.code === "voice_diagnostics_disabled") { stopped = true; return; }
        if (result.status < 200 || result.status > 299) return;
        await clear(batch[batch.length - 1].id);
        pending = pending.slice(batch.length);
      }
    } catch { /* The ring keeps the events for the next trigger. */ }
    finally { busy = false; if (again) { again = false; request(); } }
  }
  function request() {
    if (stopped || timer) return;
    timer = setTimeout(() => { void upload(); }, Math.max(settle, last + interval - now()));
  }
  return { request, dispose: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

/** Posts one batch for the signed-in operator; the status is 0 when nothing was sent. */
export function voiceDiagnosticsSender(config: MobileConfig, getToken: () => Promise<string | null>, deviceSession: () => Promise<string | null>,
  build: string | null, transport: MobileTransport = fetch) {
  return async (events: VoiceDiagnosticEvent[]): Promise<DiagnosticsUploadResult> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const token = await getToken();
      if (!token) return { status: 0 };
      const response = await transport(config.apiOrigin + "/api/mobile/v1/diagnostics/voice", { method: "POST", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceSession: await deviceSession(), build, events }) });
      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : undefined;
      return { status: response.status, ...(code ? { code } : {}) };
    } catch { return { status: 0 }; }
    finally { clearTimeout(timer); }
  };
}
