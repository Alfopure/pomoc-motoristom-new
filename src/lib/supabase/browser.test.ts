import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { afterRealtimeAuth, attachSupabaseRealtimeAuth, REALTIME_AUTH_READY_MAX_MS, type RealtimeAuthClient } from "./browser";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function createFakeClient(setAuthResult: Promise<unknown> = Promise.resolve()) {
  const setAuth = vi.fn(() => setAuthResult);
  const listeners: Array<(event: string, session: { access_token?: string | null } | null) => void> = [];
  const client: RealtimeAuthClient = {
    realtime: { setAuth },
    auth: {
      onAuthStateChange: (callback) => {
        listeners.push(callback);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  return { client, setAuth, listeners };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe("realtime auth on the browser client", () => {
  it("lets the socket read the current session instead of pinning a token", async () => {
    const { client, setAuth } = createFakeClient();
    attachSupabaseRealtimeAuth(client);
    await flush();
    expect(setAuth).toHaveBeenCalledTimes(1);
    expect(setAuth.mock.calls[0]).toEqual([]);
  });

  it("hands the socket back to the session callback after every auth event", async () => {
    const { client, setAuth, listeners } = createFakeClient();
    attachSupabaseRealtimeAuth(client);
    await flush();

    listeners[0]?.("TOKEN_REFRESHED", { access_token: "jwt-2" });
    listeners[0]?.("SIGNED_OUT", null);
    expect(setAuth).toHaveBeenCalledTimes(3);
    expect(setAuth.mock.calls.every((args) => args.length === 0)).toBe(true);
  });

  it("attaches once per client", async () => {
    const { client, setAuth, listeners } = createFakeClient();
    attachSupabaseRealtimeAuth(client);
    attachSupabaseRealtimeAuth(client);
    await flush();
    expect(listeners).toHaveLength(1);
    expect(setAuth).toHaveBeenCalledTimes(1);
  });

  it("keeps the real socket on the refreshing callback after supabase-js pins a refreshed token", async () => {
    const supabase = createClient("http://127.0.0.1:1", "sb_publishable_test", { auth: { persistSession: false, autoRefreshToken: false } });
    let current = "jwt-1";
    vi.spyOn(supabase.auth, "getSession").mockImplementation(async () => ({ data: { session: { access_token: current } }, error: null }) as never);
    let listener: ((event: string, session: { access_token?: string | null } | null) => void) | undefined;
    vi.spyOn(supabase.auth, "onAuthStateChange").mockImplementation(((callback: typeof listener) => {
      listener = callback;
      return { data: { subscription: { id: "test", callback, unsubscribe() {} } } };
    }) as never);
    const realtime = supabase.realtime as unknown as { _isManualToken(): boolean; accessTokenValue: string | null; setAuth(token?: string | null): Promise<void> };

    attachSupabaseRealtimeAuth(supabase as unknown as RealtimeAuthClient);
    await flush();
    expect(realtime.accessTokenValue).toBe("jwt-1");
    expect(realtime._isManualToken()).toBe(false);

    // What supabase-js's own listener does on TOKEN_REFRESHED, before ours runs.
    current = "jwt-2";
    await realtime.setAuth("jwt-2");
    expect(realtime._isManualToken()).toBe(true);
    listener?.("TOKEN_REFRESHED", { access_token: "jwt-2" });
    await flush();
    expect(realtime._isManualToken()).toBe(false);
    expect(realtime.accessTokenValue).toBe("jwt-2");
    supabase.realtime.disconnect();
  });
});

describe("private channel joins", () => {
  it("waits for the restored session before joining", async () => {
    let finish!: () => void;
    const { client } = createFakeClient(new Promise<void>((resolve) => { finish = resolve; }));
    attachSupabaseRealtimeAuth(client);
    const join = vi.fn();

    afterRealtimeAuth(client, join);
    await flush();
    expect(join).not.toHaveBeenCalled();

    finish();
    await flush();
    expect(join).toHaveBeenCalledTimes(1);

    // Once the token is on the socket, later joins are immediate.
    const later = vi.fn();
    afterRealtimeAuth(client, later);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("drops the join of a component that unmounted while waiting", async () => {
    let finish!: () => void;
    const { client } = createFakeClient(new Promise<void>((resolve) => { finish = resolve; }));
    attachSupabaseRealtimeAuth(client);
    const join = vi.fn();
    const cancel = afterRealtimeAuth(client, join);
    cancel();
    finish();
    await flush();
    expect(join).not.toHaveBeenCalled();
  });

  it("joins anyway when the session read does not settle", async () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(new Promise<void>(() => {}));
    attachSupabaseRealtimeAuth(client);
    const join = vi.fn();
    afterRealtimeAuth(client, join);
    await vi.advanceTimersByTimeAsync(REALTIME_AUTH_READY_MAX_MS - 1);
    expect(join).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("joins at once for a client it does not manage", () => {
    const join = vi.fn();
    afterRealtimeAuth({}, join);
    expect(join).toHaveBeenCalledTimes(1);
  });
});
