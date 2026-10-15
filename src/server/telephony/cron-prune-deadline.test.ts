import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { createTelephonyHarness } from "@/test/telephony-harness";
import { LEDGER_PRUNE_BATCH_SIZE, LEDGER_PRUNE_BUDGET_MS, pruneWebhookLedger } from "./cron-jobs";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.useRealTimers(); });

describe("ledger retention transport deadline", () => {
  it.each(["read", "delete"] as const)("aborts a stalled %s within the shared deadline and never starts another mutation", async stalled => {
    vi.useFakeTimers();
    const h = createTelephonyHarness();
    let release!: (response: Response) => void;
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("motorist_job_controls")) return json({ enabled: true });
      if (init?.method === "GET" && stalled === "delete") return json([{ event_id: "processed-old" }]);
      return new Promise(resolve => { release = resolve; }); // Deliberately ignores AbortSignal.
    });
    const admin = createClient<Database>("https://isolated-db.test", "local-fixture", {
      global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const pending = pruneWebhookLedger({ ...h.deps, admin });
    await vi.advanceTimersByTimeAsync(LEDGER_PRUNE_BUDGET_MS);
    expect(await pending).toMatchObject({ status: "failed", detail: { reason: "deadline_exceeded", deleted: 0, payloadsCleared: 0 } });
    const calls = transport.mock.calls;
    expect(calls).toHaveLength(stalled === "delete" ? 3 : 2);
    expect(new URL(String(calls[1][0])).searchParams.get("limit")).toBe(String(LEDGER_PRUNE_BATCH_SIZE + 1));
    expect(calls.at(-1)![1]?.signal?.aborted).toBe(true);
    // Even an ambiguous write completing after cancellation must not continue
    // into the payload pass or be retried by the cron caller.
    release(json([{ event_id: "processed-old" }]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport).toHaveBeenCalledTimes(stalled === "delete" ? 3 : 2);
    expect(calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
