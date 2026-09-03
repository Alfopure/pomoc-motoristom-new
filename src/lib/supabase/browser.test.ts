import { describe, expect, it, vi } from "vitest";

import { attachSupabaseRealtimeAuth, type RealtimeAuthClient } from "./browser";

function createFakeClient(session: { access_token?: string | null } | null) {
  const setAuth = vi.fn();
  const listeners: Array<(event: string, session: { access_token?: string | null } | null) => void> = [];
  const client: RealtimeAuthClient = {
    realtime: { setAuth },
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
      onAuthStateChange: (callback) => {
        listeners.push(callback);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };
  return { client, setAuth, listeners };
}

describe("realtime auth on the browser client", () => {
  it("pushes the current access token to the socket", async () => {
    const { client, setAuth } = createFakeClient({ access_token: "jwt-1" });
    attachSupabaseRealtimeAuth(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(setAuth).toHaveBeenCalledWith("jwt-1");
  });

  it("rotates the token on every auth event, so a private channel is not closed mid-shift", async () => {
    const { client, setAuth, listeners } = createFakeClient({ access_token: "jwt-1" });
    attachSupabaseRealtimeAuth(client);
    await Promise.resolve();

    listeners[0]?.("TOKEN_REFRESHED", { access_token: "jwt-2" });
    expect(setAuth).toHaveBeenLastCalledWith("jwt-2");

    listeners[0]?.("SIGNED_OUT", null);
    expect(setAuth).toHaveBeenLastCalledWith(null);
  });

  it("attaches once per client and survives a missing session", async () => {
    const { client, setAuth, listeners } = createFakeClient(null);
    attachSupabaseRealtimeAuth(client);
    attachSupabaseRealtimeAuth(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(listeners).toHaveLength(1);
    expect(setAuth).toHaveBeenCalledWith(null);
  });
});
