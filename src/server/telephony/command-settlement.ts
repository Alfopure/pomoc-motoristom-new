import { AsyncLocalStorage } from "node:async_hooks";

import type { CallSessionState } from "@/lib/supabase/database.types";

/**
 * A provider command of a media-first control (hold, unhold, park with
 * recording frozen off) that the provider accepted, the journal recorded and
 * the entry's cursor checkpointed as done (call-speed S7a.5). `last` marks the
 * entry's final command; `state` is the staged state the control committed.
 */
export type CommandSettled = {
  eventId: string;
  last: boolean;
  state: CallSessionState;
  commands: Array<{ kind: string; ok: boolean; error: string | null }>;
};

const observers = new AsyncLocalStorage<(settled: CommandSettled) => void>();

/**
 * Runs `work` and tells `observer` about every command its runs settle. The
 * observer only watches: it cannot delay, fail or reorder the work, which keeps
 * its lease and continues exactly as it would unobserved.
 */
export function observeCommandSettlement<T>(observer: (settled: CommandSettled) => void, work: () => Promise<T>): Promise<T> {
  return observers.run(observer, work);
}

/** Builds the report only when someone is watching. */
export function reportCommandSettled(settled: () => CommandSettled): void {
  const observer = observers.getStore();
  if (!observer) return;
  try { observer(settled()); }
  catch { /* Observation only. */ }
}
