import { GoTrueClient, AuthApiError } from "@supabase/auth-js";
import { describe, expect, it, vi } from "vitest";
import { SessionLogout } from "./logout";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const remoteNotice = "Odhlásenie na tomto zariadení je dokončené. Server ho zatiaľ nepotvrdil.";

describe("mobile logout lifecycle", () => {
  function installedSdk(onRemove: () => void, options: { remoteError?: AuthApiError; sessionError?: AuthApiError; storageFailure?: boolean } = {}) {
    // Exercise the installed SDK's actual event/error order with local transport.
    const sdk = Object.create(GoTrueClient.prototype);
    sdk._useSession = (callback: (value: unknown) => unknown) => callback({ data: { session: { access_token: "MOCK-NOT-A-CREDENTIAL" } }, error: options.sessionError ?? null });
    sdk.admin = { signOut: vi.fn(async () => ({ error: options.remoteError ?? null })) };
    sdk._removeSession = vi.fn(async () => { if (options.storageFailure) throw new Error("MOCK storage failure"); onRemove(); });
    sdk._returnResult = (value: unknown) => value;
    return sdk;
  }
  it("keeps the observed local logout notice after the installed SDK returns remote503", async () => {
    let logout!: SessionLogout;
    const sdk = installedSdk(() => logout.observe("SIGNED_OUT", null), { remoteError: new AuthApiError("MOCK unavailable", 503, "MOCK_UNAVAILABLE") });
    logout = new SessionLogout(() => sdk._signOut({ scope: "local" }));
    logout.observe("SIGNED_IN", "account-a");
    const states: unknown[] = []; logout.subscribe(() => states.push(logout.snapshot()));
    await logout.run(async () => {});
    expect(sdk.admin.signOut).toHaveBeenCalledExactlyOnceWith("MOCK-NOT-A-CREDENTIAL", "local");
    expect(sdk._removeSession).toHaveBeenCalledOnce();
    expect(logout.snapshot()).toEqual({ busy: false, message: remoteNotice });
    expect(states).toContainEqual({ busy: true, message: null });
  });
  it("does not claim removal when the SDK fails to read the session", async () => {
    const sdk = installedSdk(() => {}, { sessionError: new AuthApiError("MOCK read failed", 500, "MOCK_SESSION_READ") });
    const logout = new SessionLogout(() => sdk._signOut({ scope: "local" })); logout.observe("INITIAL_SESSION", "account-a");
    await logout.run(async () => {});
    expect(sdk.admin.signOut).not.toHaveBeenCalled(); expect(sdk._removeSession).not.toHaveBeenCalled();
    expect(logout.snapshot()).toEqual({ busy: false, message: "Odhlásenie sa nepodarilo dokončiť. Skúste znova." });
  });
  it("keeps a failed secure-storage removal distinct from a completed local logout", async () => {
    const sdk = installedSdk(() => {}, { storageFailure: true });
    const logout = new SessionLogout(() => sdk._signOut({ scope: "local" })); logout.observe("SIGNED_IN", "account-a");
    await logout.run(async () => {});
    expect(logout.snapshot().message).toBe("Odhlásenie sa nepodarilo dokončiť. Skúste znova.");
  });
  it("stops before auth when device disconnect fails and permits an explicit retry", async () => {
    const signOut = vi.fn(async () => ({ error: null })); const logout = new SessionLogout(signOut); logout.observe("SIGNED_IN", "account-a");
    await logout.run(async () => { throw new Error("MOCK phone offline"); });
    expect(signOut).not.toHaveBeenCalled(); expect(logout.snapshot().message).toBe("Telefón sa nepodarilo odpojiť. Odhlásenie zopakujte.");
    await logout.run(async () => {}); expect(signOut).toHaveBeenCalledOnce();
  });
  it("never signs out a replacement account after a slow device disconnect", async () => {
    const disconnect = deferred(), signOut = vi.fn(async () => ({ error: null })); const logout = new SessionLogout(signOut);
    logout.observe("SIGNED_IN", "account-a"); const work = logout.run(() => disconnect.promise);
    logout.observe("SIGNED_IN", "account-b"); disconnect.resolve(); await work;
    expect(signOut).not.toHaveBeenCalled(); expect(logout.snapshot()).toEqual({ busy: false, message: null });
  });
  it.each(["account-a", "account-b"])("ignores an old logout's late failure after fresh login as %s", async next => {
    const endpoint = deferred(); let logout!: SessionLogout;
    logout = new SessionLogout(async () => { logout.observe("SIGNED_OUT", null); await endpoint.promise; return { error: new Error("MOCK late503") }; });
    logout.observe("SIGNED_IN", "account-a"); const work = logout.run(async () => {}); await Promise.resolve();
    logout.observe("SIGNED_IN", next); endpoint.resolve(); await work;
    expect(logout.snapshot()).toEqual({ busy: false, message: null });
  });
  it("does not allocate duplicate signOut calls on repeated taps", async () => {
    const disconnect = deferred(), signOut = vi.fn(async () => ({ error: null })); const logout = new SessionLogout(signOut);
    logout.observe("SIGNED_IN", "account-a"); const work = logout.run(() => disconnect.promise);
    await logout.run(async () => {}); disconnect.resolve(); await work; expect(signOut).toHaveBeenCalledOnce();
  });
  it("keeps the same account's token refresh independent from the active logout", async () => {
    const disconnect = deferred(); let logout!: SessionLogout;
    const signOut = vi.fn(async () => { logout.observe("SIGNED_OUT", null); return { error: null }; });
    logout = new SessionLogout(signOut); logout.observe("SIGNED_IN", "account-a");
    const work = logout.run(() => disconnect.promise); logout.observe("TOKEN_REFRESHED", "account-a");
    disconnect.resolve(); await work; expect(signOut).toHaveBeenCalledOnce();
    expect(logout.snapshot()).toEqual({ busy: false, message: null });
  });
  it.each(["disconnect", "auth"])("keeps an installed-session SIGNED_IN confirmation during %s", async stage => {
    const pause = deferred(); let logout!: SessionLogout;
    const sdk = installedSdk(() => logout.observe("SIGNED_OUT", null), { remoteError: new AuthApiError("MOCK unavailable", 503, "MOCK_UNAVAILABLE") });
    logout = new SessionLogout(async () => { if (stage === "auth") await pause.promise; return sdk._signOut({ scope: "local" }); });
    logout.observe("INITIAL_SESSION", "account-a");
    const work = logout.run(async () => { if (stage === "disconnect") await pause.promise; }); await Promise.resolve();
    sdk.storageKey = "MOCK-STORAGE";
    sdk.storage = { getItem: async () => JSON.stringify({ access_token: "MOCK-NOT-A-CREDENTIAL", refresh_token: "MOCK-REFRESH", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "account-a" } }) };
    sdk._debug = () => {};
    sdk._notifyAllSubscribers = vi.fn(async (event: string, session: { user: { id: string } }) => logout.observe(event, session.user.id));
    await sdk._recoverAndRefresh();
    expect(sdk._notifyAllSubscribers).toHaveBeenCalledWith("SIGNED_IN", expect.objectContaining({ user: { id: "account-a" } }));
    expect(logout.snapshot().busy).toBe(true);
    pause.resolve(); await work;
    expect(sdk.admin.signOut).toHaveBeenCalledOnce();
    expect(logout.snapshot()).toEqual({ busy: false, message: remoteNotice });
  });
  it("retains local-removal evidence if notification completes before auth throws", async () => {
    let logout!: SessionLogout;
    logout = new SessionLogout(async () => { logout.observe("SIGNED_OUT", null); throw new Error("MOCK late failure"); });
    logout.observe("SIGNED_IN", "account-a"); await logout.run(async () => {});
    expect(logout.snapshot()).toEqual({ busy: false, message: remoteNotice });
  });
  it("invalidates unrelated session loss and ignores a pending completion after disposal", async () => {
    const endpoint = deferred(); let logout!: SessionLogout;
    logout = new SessionLogout(async () => { await endpoint.promise; return { error: new Error("MOCK late") }; });
    logout.observe("SIGNED_IN", "account-a"); const work = logout.run(async () => {}); await Promise.resolve();
    logout.observe("INITIAL_SESSION", null); endpoint.resolve(); await work;
    expect(logout.snapshot()).toEqual({ busy: false, message: null });
    const delayed = deferred(), disposed = new SessionLogout(async () => { await delayed.promise; return { error: new Error("MOCK pending failure") }; });
    disposed.observe("SIGNED_IN", "account-a"); const pending = disposed.run(async () => {}); await Promise.resolve();
    const listener = vi.fn(); disposed.subscribe(listener); const before = disposed.snapshot(); disposed.dispose(); delayed.resolve(); await pending;
    expect(listener).not.toHaveBeenCalled(); expect(disposed.snapshot()).toBe(before);
  });
});
