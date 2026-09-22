import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import { createClient } from "@supabase/supabase-js";

import { ownershipRpc, telephonyDatabaseFetch, UNOWNED_READ_MS } from "./ownership";
import { SessionLeaseLostError } from "./service-errors";

function admin(error: { code?: string; message: string } | null, data: unknown = null) {
  return { rpc: async () => ({ data, error }) } as unknown as SupabaseClient<Database>;
}

describe("ownershipRpc", () => {
  it("returns the payload of a successful call", async () => {
    await expect(ownershipRpc(admin(null, { generation: 3 }), "motorist_session_lease_acquire_v2", {})).resolves.toEqual({ generation: 3 });
  });

  it("turns an ownership refusal into a lost lease", async () => {
    for (const message of ["telephony ownership lost", "writer contract mismatch", "session lease expired"]) {
      await expect(ownershipRpc(admin({ code: "PT409", message }), "motorist_session_lease_renew_v2", {}))
        .rejects.toBeInstanceOf(SessionLeaseLostError);
    }
  });

  it("keeps the SQLSTATE on any other fenced refusal", async () => {
    // A termination committed elsewhere refuses new provider commands with
    // PT409. Callers have to tell that apart from an ordinary failure, and the
    // message alone is not something to match on.
    const refusal = { code: "PT409", message: "telephony termination blocks new provider command" };

    const error = await ownershipRpc(admin(refusal), "motorist_provider_command_prepare_v2", {}).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe("PT409");
    expect((error as Error).message).toContain("telephony termination blocks new provider command");
    expect(error).not.toBeInstanceOf(SessionLeaseLostError);
  });

  it("leaves an ordinary failure without a code", async () => {
    const error = await ownershipRpc(admin({ message: "connection reset" }), "motorist_session_terminate_v2", {}).catch((value: unknown) => value);

    expect((error as Error & { code?: string }).code).toBeUndefined();
    expect((error as Error).message).toContain("connection reset");
  });
});

describe("telephonyDatabaseFetch outside a lease", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const sentInit = (fetch: ReturnType<typeof stubFetch>, index = 0) => fetch.mock.calls[index][1] as RequestInit;

  it("bounds an un-owned PostgREST read", async () => {
    const fetch = stubFetch();
    await telephonyDatabaseFetch("https://x.supabase.co/rest/v1/motorist_job_controls?select=enabled", { method: "GET" });
    const sent = sentInit(fetch);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
    expect(sent.signal?.aborted).toBe(false);
    expect(new Headers(sent.headers).get("x-telephony-writer")).toBe("2");
    expect(new Headers(sent.headers).get("x-telephony-session")).toBeNull();
  });

  it("composes the caller's signal with the read cap", async () => {
    const fetch = stubFetch();
    const controller = new AbortController();
    await telephonyDatabaseFetch("https://x.supabase.co/rest/v1/cases?select=id", { method: "GET", signal: controller.signal });
    const sent = sentInit(fetch);
    expect(sent.signal?.aborted).toBe(false);
    controller.abort();
    expect(sent.signal?.aborted).toBe(true);
  });

  it("surfaces the read cap as an abort so postgrest-js does not retry the read", async () => {
    // undici rejects a fetch aborted by `AbortSignal.timeout` with a
    // `TimeoutError`; postgrest-js treats that as a transient failure and
    // retries a GET three times with 1/2/4 s sleeps, each under a fresh cap.
    // Only an `AbortError` escapes the retry. The stub answers the way undici
    // would the moment the cap fires.
    const timeout = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const fetch = vi.fn(timeout);
    vi.stubGlobal("fetch", fetch);
    const client = createClient<Database>("https://x.supabase.co", "service-key", { global: { fetch: telephonyDatabaseFetch }, auth: { persistSession: false, autoRefreshToken: false } });

    const started = Date.now();
    const result = await client.from("motorist_job_controls").select("enabled");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.error?.message).toContain(`un-owned read exceeded ${UNOWNED_READ_MS} ms`);
    expect(sentInit(fetch).signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves un-owned writes, storage and auth requests without a cap", async () => {
    const fetch = stubFetch();
    await telephonyDatabaseFetch("https://x.supabase.co/rest/v1/x", { method: "PATCH", body: "{}" });
    await telephonyDatabaseFetch("https://x.supabase.co/storage/v1/object/x", { method: "GET" });
    await telephonyDatabaseFetch("https://x.supabase.co/auth/v1/admin/users", { method: "GET" });
    for (const index of [0, 1, 2]) expect(sentInit(fetch, index).signal).toBeUndefined();
    // A caller's own signal still travels unchanged.
    const controller = new AbortController();
    await telephonyDatabaseFetch("https://x.supabase.co/storage/v1/object/x", { method: "GET", signal: controller.signal });
    expect(sentInit(fetch, 3).signal).toBe(controller.signal);
  });
});
