import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import { createClient } from "@supabase/supabase-js";

import { assertOwnership, ownershipRpc, sessionOwnership, telephonyDatabaseFetch, SESSION_LEASE_MS, SESSION_WORK_MS, UNOWNED_READ_MS, type Ownership } from "./ownership";
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

describe("database work under a session lease", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function owner(now = Date.now()): Ownership {
    return {
      admin: createClient<Database>("https://x.supabase.co", "service-key", {
        global: { fetch: telephonyDatabaseFetch }, auth: { persistSession: false, autoRefreshToken: false },
      }),
      sessionId: "session", organizationId: "org", token: "token", generation: 7,
      contract: 2, acquiredAt: now, deadline: now + SESSION_WORK_MS,
    };
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

  it("keeps the lease alive through slow reads before staging the control", async () => {
    let now = Date.now();
    let expires = now + SESSION_LEASE_MS;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const owned = owner(now);
    const renewals: number[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-telephony-session")).toBe(owned.sessionId);
      expect(headers.get("x-telephony-token")).toBe(owned.token);
      expect(headers.get("x-telephony-generation")).toBe(String(owned.generation));
      if (String(input).endsWith("/rpc/motorist_session_lease_renew_v2")) {
        const valid = now < expires;
        if (valid) { renewals.push(now); expires = now + SESSION_LEASE_MS; }
        return json(valid);
      }
      if (String(input).endsWith("/rpc/motorist_stage_transition_v1")) {
        // Model the same lease fence that rejected the real cancel-consult:
        // without renewal the read sequence consumes 20 s of a 15 s lease.
        return json({ applied: now < expires });
      }
      now += 4_000;
      return json([]);
    });
    vi.stubGlobal("fetch", fetch);

    const result = await sessionOwnership.run(owned, async () => {
      for (let i = 0; i < 5; i++) await owned.admin.from("motorist_call_sessions").select("id");
      return ownershipRpc(owned.admin, "motorist_stage_transition_v1", {});
    });

    expect(result).toEqual({ applied: true });
    expect(renewals).toHaveLength(2);
    expect(now - owned.acquiredAt).toBe(20_000);
    expect(fetch).toHaveBeenCalledTimes(8); // Five reads, two renewals, one stage.
  });

  it("shares a pending renewal across parallel reads and the provider guard", async () => {
    const owned = owner(Date.now() - 6_000);
    let respond!: (value: Response) => void;
    const renewing = new Promise<Response>((resolve) => { respond = resolve; });
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/rpc/motorist_session_lease_renew_v2")) { began(); return renewing; }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetch);

    await sessionOwnership.run(owned, async () => {
      const requests = [0, 1, 2].map(() => telephonyDatabaseFetch("https://x.supabase.co/rest/v1/motorist_call_sessions"));
      requests.push(assertOwnership().then(() => new Response()));
      await started;
      expect(fetch).toHaveBeenCalledTimes(1);
      respond(json(true));
      await Promise.all(requests);
    });

    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("adds no renewal to a fast control", async () => {
    const owned = owner();
    const fetch = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal("fetch", fetch);

    await sessionOwnership.run(owned, async () => {
      await telephonyDatabaseFetch(new URL("https://x.supabase.co/rest/v1/motorist_call_sessions"));
      await telephonyDatabaseFetch(new Request("https://x.supabase.co/rest/v1/rpc/motorist_stage_transition_v1", { method: "POST", body: "{}" }));
      await assertOwnership();
    });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["GET", "PATCH"])("does not send a %s after the lease is lost", async (method) => {
    const owned = owner(Date.now() - 6_000);
    const fetch = vi.fn().mockResolvedValue(json(false));
    vi.stubGlobal("fetch", fetch);

    await expect(sessionOwnership.run(owned, () => telephonyDatabaseFetch("https://x.supabase.co/rest/v1/motorist_call_sessions", { method })))
      .rejects.toBeInstanceOf(SessionLeaseLostError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/rpc\/motorist_session_lease_renew_v2$/);
  });

  it("does not renew or send work past the session deadline", async () => {
    const owned = { ...owner(), deadline: Date.now() - 1 };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(sessionOwnership.run(owned, () => telephonyDatabaseFetch("https://x.supabase.co/rest/v1/motorist_call_sessions")))
      .rejects.toBeInstanceOf(SessionLeaseLostError);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the work deadline again after a slow renewal", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const owned = owner(now - SESSION_WORK_MS + 1_000);
    const fetch = vi.fn(async () => { now += 2_000; return json(true); });
    vi.stubGlobal("fetch", fetch);

    await expect(sessionOwnership.run(owned, () => telephonyDatabaseFetch("https://x.supabase.co/rest/v1/motorist_call_sessions")))
      .rejects.toBeInstanceOf(SessionLeaseLostError);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["motorist_provider_command_result_v2", "motorist_provider_command_result_batch_v2"])("retains late immutable acceptance through %s after lease expiry", async (rpc) => {
    const owned = { ...owner(Date.now() - SESSION_LEASE_MS - 1_000), deadline: Date.now() + 4_000 };
    const fetch = vi.fn().mockResolvedValue(json(true));
    vi.stubGlobal("fetch", fetch);

    await expect(sessionOwnership.run(owned, () => ownershipRpc(owned.admin, rpc, {}))).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe(`https://x.supabase.co/rest/v1/rpc/${rpc}`);
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get("x-telephony-token")).toBe(owned.token);
    expect(headers.get("x-telephony-generation")).toBe(String(owned.generation));
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
