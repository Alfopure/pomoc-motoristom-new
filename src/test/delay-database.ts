import type { FakeOperation, FakeQueryBuilder, FakeSupabase } from "./fake-supabase";

/** One database round trip in a wave count. */
export const WAVE_MS = 25;

export type MeteredRequest = { table: string; operation: FakeOperation; at: number };

export type DatabaseDelay = {
  requests: MeteredRequest[];
  /** First milliseconds (since the meter started) at which each watched condition held. */
  marks: Record<string, number>;
  /** Waves elapsed now, or at an absolute `Date.now()` stamp such as a provider send. */
  waves(at?: number): number;
  /** Checks `predicate` whenever a request completes and records the first time it holds. */
  watch(name: string, predicate: () => boolean): void;
  restore(): void;
};

/**
 * Dependent-wave meter for request-cost tests (call-speed plan S0.3).
 *
 * Every `from()` and `rpc()` request of a `createFakeSupabase` client waits
 * `delayMs` before it executes, including requests that then fail. Under
 * `vi.useFakeTimers()` requests issued together finish together, so elapsed
 * time ÷ delay is the number of dependent waves: the number a real database
 * round trip multiplies. The request count itself is unchanged. This is
 * `intercept` from `participants-latency.test.ts`, for any workflow.
 */
export function delayDatabase(fake: Pick<FakeSupabase, "client">, delayMs = WAVE_MS): DatabaseDelay {
  const began = Date.now();
  const client = fake.client;
  const { from, rpc } = client;
  const requests: MeteredRequest[] = [];
  const marks: Record<string, number> = {};
  const watchers = new Map<string, () => boolean>();
  const check = () => {
    for (const [name, predicate] of watchers) {
      if (!(name in marks) && predicate()) marks[name] = Date.now() - began;
    }
  };
  const hold = (builder: FakeQueryBuilder, request: MeteredRequest): FakeQueryBuilder => {
    const then = builder.then.bind(builder);
    builder.then = (fulfilled, rejected) => {
      request.at = Date.now() - began;
      requests.push(request);
      return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        .then(() => then((value) => { check(); return value; }, (reason) => { check(); throw reason; }))
        .then(fulfilled, rejected);
    };
    return builder;
  };
  client.from = (table) => {
    const builder = from.call(client, table);
    const request: MeteredRequest = { table, operation: "select", at: 0 };
    for (const operation of ["insert", "upsert", "update", "delete"] as const) {
      const verb = builder[operation].bind(builder) as (...args: unknown[]) => FakeQueryBuilder;
      (builder as unknown as Record<string, unknown>)[operation] = (...args: unknown[]) => { request.operation = operation; return verb(...args); };
    }
    return hold(builder, request);
  };
  client.rpc = (name, args) => hold(rpc.call(client, name, args), { table: name, operation: "rpc", at: 0 });
  return {
    requests,
    marks,
    waves: (at = Date.now()) => (at - began) / delayMs,
    watch(name, predicate) { watchers.set(name, predicate); },
    restore() { client.from = from; client.rpc = rpc; },
  };
}
