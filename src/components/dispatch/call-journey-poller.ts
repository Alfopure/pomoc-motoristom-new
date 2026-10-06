import { nextBackoffDelayMs, type TelephonyJsonResult } from "@/lib/telephony/client-request";

export type CallJourneyResource<T> = {
  data: T | null;
  error: string | null;
  observedAt: number | null;
  loading: boolean;
  settled: boolean;
};

const TERMINAL_SETTLE_MS = 30_000;

/** A view-owned poll loop; terminal evidence must remain unchanged across successful reads. */
export function createCallJourneyPoller<T extends { ok: true }>(options: {
  read: (signal: AbortSignal) => Promise<TelephonyJsonResult<T & { error?: string }>>;
  onChange: (resource: CallJourneyResource<T>) => void;
  canPoll: () => boolean;
  intervalMs: number;
  terminalKey?: (data: T) => string | null;
}) {
  let state: CallJourneyResource<T> = { data: null, error: null, observedAt: null, loading: false, settled: false };
  let stopped = false, denied = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let terminal: { key: string; since: number; observations: number } | null = null;

  const publish = (next: CallJourneyResource<T>) => {
    state = next;
    options.onChange(state);
  };
  const resetSettlement = () => {
    terminal = null;
    if (state.settled) publish({ ...state, settled: false });
  };
  const poll = async () => {
    if (stopped || denied || controller || !options.canPoll()) return;
    clearTimeout(timer);
    const active = new AbortController();
    controller = active;
    publish({ ...state, loading: true });
    try {
      const response = await options.read(active.signal);
      if (stopped || active.signal.aborted) return;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        denied = true;
        terminal = null;
        publish({ data: null, error: response.status === 404 ? "Priebeh tohto hovoru nie je dostupný." : "Na zobrazenie tohto hovoru nemáš prístup.", observedAt: null, loading: false, settled: false });
        return;
      }
      if (!response.ok || response.body?.ok !== true) throw new Error(response.body?.error ?? "Priebeh hovoru sa nepodarilo obnoviť.");
      failures = 0;
      const now = Date.now();
      const key = options.terminalKey?.(response.body) ?? null;
      if (key === null || !options.canPoll()) terminal = null;
      else if (terminal?.key === key) terminal.observations++;
      else terminal = { key, since: now, observations: 1 };
      const settled = terminal !== null && terminal.observations >= 2 && now - terminal.since >= TERMINAL_SETTLE_MS;
      publish({ data: response.body, error: null, observedAt: now, loading: false, settled });
    } catch (error) {
      if (!stopped && !active.signal.aborted) {
        failures++;
        // An outage is not evidence that a finished call stopped receiving events.
        terminal = null;
        publish({ ...state, loading: false, settled: false, error: error instanceof Error ? error.message : "Priebeh hovoru sa nepodarilo obnoviť." });
      }
    } finally {
      controller = null;
      if (!stopped && !denied && !state.settled && options.intervalMs > 0 && options.canPoll()) {
        timer = setTimeout(poll, nextBackoffDelayMs({ baseMs: options.intervalMs, maxMs: 30_000, consecutiveFailures: failures }));
      }
    }
  };

  void poll();
  return {
    refresh() {
      if (stopped) return;
      clearTimeout(timer);
      denied = false;
      resetSettlement();
      void poll();
    },
    availabilityChanged() {
      if (stopped) return;
      clearTimeout(timer);
      // Time spent in a hidden tab or offline must not count as verified stability.
      resetSettlement();
      if (!denied) void poll();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
