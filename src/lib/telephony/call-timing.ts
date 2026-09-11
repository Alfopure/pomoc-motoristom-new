export type BrowserCallStep = "click_feedback" | "microphone" | "registration" | "request" | "invite_to_active" | "answer" | "audio_playback";
type TimingResult = { outcome?: "ok" | "failed" | "cancelled"; requestId?: string | null };
export type CallTimingContext = { operationId?: string };

let sequence = 0;
const retained: string[] = [];
const LIMIT = 200;

/** Local DevTools/QA evidence only. No numbers, call IDs, tokens, audio or network uploads. */
export function beginBrowserCallStep(phase: BrowserCallStep, context?: CallTimingContext): (result?: TimingResult) => void {
  if (typeof performance === "undefined") return () => undefined;
  const started = performance.now();
  let finished = false;
  return (result = {}) => {
    if (finished) return;
    finished = true;
    try {
      const name = `motorist.call.${phase}.${++sequence}`;
      const requestId = typeof result.requestId === "string" && /^[a-f0-9-]{36}$/i.test(result.requestId) ? result.requestId : undefined;
      const operationId = context?.operationId && /^[a-f0-9-]{36}$/i.test(context.operationId) ? context.operationId : undefined;
      performance.measure(name, { start: started, end: performance.now(), detail: { phase, outcome: result.outcome ?? "ok", ...(requestId ? { requestId } : {}), ...(operationId ? { operationId } : {}) } });
      retained.push(name);
      if (retained.length > LIMIT) performance.clearMeasures(retained.shift()!);
    } catch { /* User Timing is optional in older embedded browsers. */ }
  };
}
