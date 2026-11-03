import type { MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import type { VoiceDiagnosticEvent } from "./diagnostics";

export type DiagnosticsUploadResult = { status: number; code?: string };
export type DiagnosticsUploader = { request(): void; dispose(): void;
  /** Logout: sends what is pending now if it can, then forgets the whole ring. */
  finish(): Promise<void> };
/** The operator whose events the ring holds; the ring is one per device, not per account. */
export type DiagnosticsOwner = { id: string; load(): Promise<string | null>; save(id: string): Promise<void> };
type Options = {
  events: () => Promise<VoiceDiagnosticEvent[]>; clear: (upToId: number) => Promise<void>;
  send: (events: VoiceDiagnosticEvent[]) => Promise<DiagnosticsUploadResult>; owner?: DiagnosticsOwner;
  /** The shortest time between two uploads, the wait after a trigger for its trailing events,
   * and the most a logout waits for its upload. */
  interval?: number; settle?: number; finishWithin?: number; now?: () => number;
};
const BATCH = 100, BATCH_CHARACTERS = 48_000, BATCHES = 3, EVERYTHING = Number.MAX_SAFE_INTEGER;

/** Uploads the native device-log ring a moment after a trigger (a call ended, a refused push,
 * the app came forward), at most once per interval. Events are forgotten only after a 2xx;
 * anything else waits for the next trigger, a rate limit for one more interval. A server with
 * the upload switched off stops it. Another operator's leftovers are forgotten unsent. */
export function createDiagnosticsUploader({ events, clear, send, owner, interval = 30_000, settle = 2_000, finishWithin = 4_000, now = Date.now }: Options): DiagnosticsUploader {
  let last = Number.NEGATIVE_INFINITY, timer: ReturnType<typeof setTimeout> | null = null, busy: Promise<void> | null = null,
    again = false, stopped = false, claimed = false;
  async function claim() {
    if (claimed || !owner) return;
    const previous = await owner.load();
    if (previous !== owner.id) {
      if (previous !== null) await clear(EVERYTHING);
      await owner.save(owner.id);
    }
    claimed = true;
  }
  async function sendPending() {
    await claim();
    let pending = await events();
    for (let count = 0; count < BATCHES && pending.length; count += 1) {
      const batch: VoiceDiagnosticEvent[] = [];
      let characters = 0;
      for (const event of pending.slice(0, BATCH)) {
        characters += JSON.stringify(event).length + 1;
        if (batch.length && characters > BATCH_CHARACTERS) break;
        batch.push(event);
      }
      const result = await send(batch);
      if (result.code === "voice_diagnostics_disabled") { stopped = true; return; }
      if (result.status === 429) { last = now() + interval; return; }
      if (result.status < 200 || result.status > 299) return;
      await clear(batch[batch.length - 1].id);
      pending = pending.slice(batch.length);
    }
  }
  async function upload() {
    timer = null;
    if (stopped) return;
    if (busy) { again = true; return; }
    last = now();
    busy = sendPending().catch(() => { /* The ring keeps the events for the next trigger. */ });
    await busy; busy = null;
    if (again) { again = false; request(); }
  }
  function request() {
    if (stopped || timer) return;
    timer = setTimeout(() => { void upload(); }, Math.max(settle, last + interval - now()));
  }
  async function finish() {
    const work = (async () => { await busy; if (!stopped) await sendPending(); })().catch(() => {});
    await Promise.race([work, new Promise(resolve => setTimeout(resolve, finishWithin))]);
    // The next operator to sign in on this phone never uploads these events.
    await clear(EVERYTHING).catch(() => {});
  }
  return { request, finish, dispose: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
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
