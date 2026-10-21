import { describe, expect, it, vi } from "vitest";
import type { MobilePushPreferences } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import { createPushApi, type PushApi } from "./api";
import { PUSH_DENIED, PUSH_UNAVAILABLE, PushSettings, type PushDevice } from "./settings";
import { PushTapInbox, readPushTap } from "./taps";

const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const ALL: MobilePushPreferences = { tasks: true, task_due: true, cases: true, callbacks_mine: true, callbacks_unclaimed: true };
const PHONE = "00000000-0000-4000-8000-0000000000f1";
const ME = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-0000000000b1";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: ME, checkedAt: "2026-10-21T10:00:00.000Z" };

/** A phone with its keychain; `keychain` can be shared to model the next login on the same phone. */
function device(overrides: Partial<PushDevice> = {}, keychain = { remembered: false, registered: false, preferences: null as Partial<MobilePushPreferences> | null }) {
  const value: PushDevice & { remember: ReturnType<typeof vi.fn> } = {
    platform: "ios", appVersion: "1.0.0", unsupported: () => null,
    permission: vi.fn(async () => "undetermined" as const), request: vi.fn(async () => "granted" as const),
    token: vi.fn(async () => "ExponentPushToken[abcdefghijkl]"), installationId: () => PHONE,
    remembered: () => keychain.remembered, remember: vi.fn((on: boolean) => { keychain.remembered = on; }),
    savedPreferences: () => keychain.preferences, savePreferences: (preferences: MobilePushPreferences) => { keychain.preferences = preferences; },
    registered: () => keychain.registered, markRegistered: (on: boolean) => { keychain.registered = on; },
    ...overrides,
  } as PushDevice & { remember: ReturnType<typeof vi.fn> };
  return value;
}
function server(overrides: Partial<PushApi> = {}): PushApi & { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } {
  return { register: vi.fn(async (body: { preferences?: Partial<MobilePushPreferences> }) => ({ ...ALL, ...body.preferences })), unregister: vi.fn(async () => undefined), ...overrides } as never;
}

describe("push api", () => {
  it("registers with the operator's token and validates the switches", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(json({ ...scope, preferences: { ...ALL, cases: false } }));
    const api = createPushApi(config, async () => "jwt", transport);
    await expect(api.register({ installationId: PHONE, token: "ExponentPushToken[abcdefghijkl]", platform: "ios", appVersion: "1.0.0" })).resolves.toEqual({ ...ALL, cases: false });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/push/register");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt");
    expect(new Headers(init?.headers).get("x-pm-app-environment")).toBe("test");
    transport.mockResolvedValueOnce(json({ ...scope, preferences: { tasks: true } }));
    await expect(api.register({ installationId: PHONE, token: "t", platform: "ios", appVersion: null })).rejects.toMatchObject({ status: 502 });
    // A kind added by a newer server is not shown by this app.
    transport.mockResolvedValueOnce(json({ ...scope, preferences: { ...ALL, sms: true } }));
    await expect(api.register({ installationId: PHONE, token: "t", platform: "ios", appVersion: null })).resolves.toEqual(ALL);
    transport.mockResolvedValueOnce(json({ ...scope, environment: "production", preferences: ALL }));
    await expect(api.register({ installationId: PHONE, token: "t", platform: "ios", appVersion: null })).rejects.toMatchObject({ status: 502 });
  });

  it("keeps the server's reason code and survives a network failure", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValueOnce(json({ ok: false, error: "Upozornenia sa nepodarilo uložiť.", code: "push_unavailable" }, 503))
      .mockRejectedValueOnce(new TypeError("offline"));
    const api = createPushApi(config, async () => "jwt", transport);
    await expect(api.register({ installationId: PHONE, token: "t", platform: "ios", appVersion: null })).rejects.toMatchObject({ status: 503, code: "push_unavailable" });
    await expect(api.unregister(PHONE)).rejects.toMatchObject({ status: 0 });
    await expect(createPushApi(config, async () => null, transport).unregister(PHONE)).rejects.toMatchObject({ status: 401 });
  });
});

describe("push settings", () => {
  it("asks only after the operator switches notifications on, then remembers the choice", async () => {
    const phone = device(), api = server();
    const settings = new PushSettings(phone, api);
    await settings.resume();
    expect(phone.permission).not.toHaveBeenCalled();
    expect(settings.snapshot().status).toBe("off");
    await settings.enable();
    expect(phone.request).toHaveBeenCalledOnce();
    expect(api.register).toHaveBeenCalledWith({ installationId: PHONE, token: "ExponentPushToken[abcdefghijkl]", platform: "ios", appVersion: "1.0.0" });
    expect(settings.snapshot()).toMatchObject({ status: "on", preferences: ALL, message: null, busy: false });
    expect(phone.remembered()).toBe(true);
    expect(phone.registered()).toBe(true);
  });

  it("explains a refusal and finds the permission again after Settings", async () => {
    const phone = device({ request: vi.fn(async () => "denied" as const) }), api = server();
    const settings = new PushSettings(phone, api);
    await settings.enable();
    expect(settings.snapshot()).toMatchObject({ status: "denied", message: PUSH_DENIED });
    expect(api.register).not.toHaveBeenCalled();
    phone.permission = vi.fn(async () => "granted" as const);
    await settings.enable();
    expect(settings.snapshot().status).toBe("on");
  });

  it("refreshes a remembered phone quietly and not too often", async () => {
    let now = 0;
    const phone = device({ permission: vi.fn(async () => "granted" as const) }), api = server();
    phone.remember(true);
    phone.markRegistered(true);
    const settings = new PushSettings(phone, api, () => now);
    await settings.resume();
    await settings.resume();
    expect(api.register).toHaveBeenCalledOnce();
    now += 7 * 3_600_000;
    api.register.mockRejectedValueOnce(new MobileApiError("offline", 0));
    await settings.resume();
    expect(settings.snapshot()).toMatchObject({ status: "on", message: null });
    expect(phone.request).not.toHaveBeenCalled();
  });

  it("shows when the environment has notifications switched off", async () => {
    const phone = device({ permission: vi.fn(async () => "granted" as const) });
    const settings = new PushSettings(phone, server({ register: vi.fn(async () => { throw new MobileApiError("x", 503, "push_unavailable"); }) }));
    await settings.enable();
    expect(settings.snapshot()).toMatchObject({ status: "unavailable", message: PUSH_UNAVAILABLE });
    expect(phone.remembered()).toBe(false);
  });

  it("changes one switch and returns it when saving fails", async () => {
    const phone = device({ permission: vi.fn(async () => "granted" as const) }), api = server();
    const settings = new PushSettings(phone, api);
    await settings.enable();
    await settings.set("callbacks_unclaimed", false);
    expect(api.register).toHaveBeenLastCalledWith(expect.objectContaining({ preferences: { callbacks_unclaimed: false } }));
    expect(settings.snapshot().preferences).toEqual({ ...ALL, callbacks_unclaimed: false });
    api.register.mockRejectedValueOnce(new MobileApiError("down", 503));
    await settings.set("tasks", false);
    expect(settings.snapshot()).toMatchObject({ preferences: { ...ALL, callbacks_unclaimed: false }, saving: null, message: "Nastavenie sa nepodarilo uložiť. Skúste to znova." });
  });

  it("switches off on this phone", async () => {
    const phone = device({ permission: vi.fn(async () => "granted" as const) }), api = server();
    const settings = new PushSettings(phone, api);
    await settings.enable();
    await settings.disable();
    expect(api.unregister).toHaveBeenCalledWith(PHONE);
    expect(settings.snapshot()).toMatchObject({ status: "off", preferences: null });
    expect(phone.remembered()).toBe(false);
    expect(phone.registered()).toBe(false);
  });

  it("logout removes the registration and the next login starts with the same switches", async () => {
    const keychain = { remembered: false, registered: false, preferences: null as Partial<MobilePushPreferences> | null };
    const api = server();
    const first = new PushSettings(device({ permission: vi.fn(async () => "granted" as const) }, keychain), api);
    await first.enable();
    await first.set("callbacks_unclaimed", false);
    await first.forget();
    expect(api.unregister).toHaveBeenCalledWith(PHONE);
    expect(keychain).toMatchObject({ remembered: true, registered: false });
    // After logout this instance registers nothing again.
    await first.enable();
    expect(api.register).toHaveBeenCalledTimes(2);
    const next = new PushSettings(device({ permission: vi.fn(async () => "granted" as const) }, keychain), api);
    await next.resume();
    expect(api.register).toHaveBeenLastCalledWith(expect.objectContaining({ preferences: { ...ALL, callbacks_unclaimed: false } }));
    expect(next.snapshot().preferences).toEqual({ ...ALL, callbacks_unclaimed: false });
  });

  it("a logout that did not reach the server is cleaned up at the next start", async () => {
    const keychain = { remembered: false, registered: false, preferences: null as Partial<MobilePushPreferences> | null };
    const api = server();
    const first = new PushSettings(device({ permission: vi.fn(async () => "granted" as const) }, keychain), api);
    await first.enable();
    api.unregister.mockRejectedValueOnce(new MobileApiError("offline", 0));
    await expect(first.forget()).resolves.toBeUndefined();
    expect(keychain.registered).toBe(true);
    // Another account signs in on the phone without notifications: the old registration goes.
    const other = new PushSettings(device({}, { remembered: false, registered: keychain.registered, preferences: null }), api);
    await other.resume();
    expect(api.unregister).toHaveBeenCalledTimes(2);
    expect(other.snapshot().status).toBe("off");
  });

  it("logout waits for a registration on its way, so it cannot come back", async () => {
    let finish: (value: MobilePushPreferences) => void = () => undefined;
    const api = server({ register: vi.fn(() => new Promise<MobilePushPreferences>(resolve => { finish = resolve; })) });
    const settings = new PushSettings(device({ permission: vi.fn(async () => "granted" as const) }), api);
    const enabling = settings.enable();
    await vi.waitFor(() => expect(api.register).toHaveBeenCalled());
    expect(settings.snapshot().busy).toBe(true);
    const leaving = settings.forget();
    expect(api.unregister).not.toHaveBeenCalled();
    finish(ALL);
    await enabling; await leaving;
    expect(api.unregister).toHaveBeenCalledOnce();
    expect(api.unregister.mock.invocationCallOrder[0]).toBeGreaterThan(api.register.mock.invocationCallOrder[0]);
  });

  it("treats a permission the system forgot as off, not as refused", async () => {
    const phone = device({ permission: vi.fn(async () => "undetermined" as const) }), api = server();
    phone.remember(true);
    const settings = new PushSettings(phone, api);
    await settings.resume();
    expect(settings.snapshot()).toMatchObject({ status: "off", message: null });
    expect(phone.remembered()).toBe(false);
    expect(api.register).not.toHaveBeenCalled();
  });

  it("gives up on a token request that never answers", async () => {
    vi.useFakeTimers();
    try {
      const phone = device({ permission: vi.fn(async () => "granted" as const), token: vi.fn(() => new Promise<string>(() => undefined)) }), api = server();
      const settings = new PushSettings(phone, api);
      const enabling = settings.enable();
      await vi.advanceTimersByTimeAsync(15_000);
      await enabling;
      expect(settings.snapshot()).toMatchObject({ status: "error", busy: false, message: "Telefón sa nepodarilo prihlásiť na odber notifikácií. Skontrolujte pripojenie a skúste znova." });
      expect(api.register).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("does nothing where notifications cannot work", async () => {
    const phone = device({ unsupported: () => "Notifikácie fungujú iba v aplikácii v telefóne." }), api = server();
    const settings = new PushSettings(phone, api);
    await settings.enable();
    await settings.resume();
    expect(settings.snapshot()).toMatchObject({ status: "unsupported", message: "Notifikácie fungujú iba v aplikácii v telefóne." });
    expect(phone.permission).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
  });
});

describe("notification taps", () => {
  const response = (data: unknown, identifier = "n1") => ({ actionIdentifier: "default", notification: { request: { identifier, content: { data } } } });

  it("reads only known targets", () => {
    expect(readPushTap(response({ kind: "task", id: TASK.toUpperCase(), profileId: ME }))).toEqual({ key: "n1", profileId: ME, target: { kind: "task", id: TASK } });
    expect(readPushTap(response({ kind: "callbacks", profileId: ME }))).toEqual({ key: "n1", profileId: ME, target: { kind: "callbacks" } });
    for (const data of [null, {}, { kind: "task", id: "x", profileId: ME }, { kind: "sms", profileId: ME }, { kind: "case", id: TASK }, { kind: "case", id: TASK, profileId: "me" }]) {
      expect(readPushTap(response(data))).toBeNull();
    }
    expect(readPushTap(null)).toBeNull();
  });

  it("opens each tap once and only for its own operator", () => {
    const inbox = new PushTapInbox(), notify = vi.fn();
    inbox.subscribe(notify);
    inbox.receive(response({ kind: "case", id: TASK, profileId: ME }));
    expect(notify).toHaveBeenCalledOnce();
    expect(inbox.take(ME)).toEqual({ kind: "case", id: TASK });
    inbox.receive(response({ kind: "case", id: TASK, profileId: ME }));
    expect(inbox.snapshot()).toBeNull();
    inbox.receive(response({ kind: "task", id: TASK, profileId: ME }, "n2"));
    expect(inbox.take("00000000-0000-4000-8000-000000000002")).toBeNull();
    expect(inbox.snapshot()).toBeNull();
  });
});
