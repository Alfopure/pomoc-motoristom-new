import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PUSH_CATEGORIES, decodeApplicationServerKey, detectPushSupport, enableDevicePush, pushEnrollmentState, readNotificationSound, readPushDeviceState, rememberNotificationSound, removeUnownedBrowserPush, revokeDevicePush, syncNotificationSoundFromStorage, updateDevicePushCategory, type PushCategory, type PushDeviceState } from "./push-client";
import { shouldPlayNotificationSound } from "./notification-sound";

afterEach(() => vi.unstubAllGlobals());

const supported = { secure: true, ios: false, standalone: false, serviceWorker: true, pushManager: true, notifications: true };

describe("push device support", () => {
  it("guides an iPhone browser to installation and permits the installed app", () => {
    expect(detectPushSupport({ ...supported, ios: true })).toBe("install-ios");
    expect(detectPushSupport({ ...supported, ios: true, standalone: true })).toBe("supported");
  });

  it("checks secure context and the actual APIs instead of assuming a browser supports push", () => {
    expect(detectPushSupport({ ...supported, secure: false })).toBe("insecure");
    expect(detectPushSupport({ ...supported, pushManager: false })).toBe("unsupported");
    expect(detectPushSupport({ ...supported, notifications: false })).toBe("unsupported");
  });

  it("decodes URL-safe application keys without requiring padding", () => {
    expect([...decodeApplicationServerKey("-_8")]).toEqual([251, 255]);
  });
});

describe("device subscription revocation", () => {
  it("cleans another account's leftover browser endpoint after session expiry without enrolling the new user", async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = { endpoint: "previous-operator", unsubscribe } as unknown as PushSubscription;
    await expect(removeUnownedBrowserPush({ subscription, subscribed: false })).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    unsubscribe.mockClear();
    await expect(removeUnownedBrowserPush({ subscription, subscribed: true })).resolves.toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("deletes precisely the current device before browser unsubscribe", async () => {
    const sequence: string[] = [];
    const remove = vi.fn(async (endpoint: string) => { sequence.push(endpoint); });
    const unsubscribe = vi.fn(async () => { sequence.push("browser"); return true; });
    await revokeDevicePush({ endpoint: "https://push.example/current-device", unsubscribe }, remove);
    expect(remove).toHaveBeenCalledWith("https://push.example/current-device");
    expect(sequence).toEqual(["https://push.example/current-device", "browser"]);
  });

  it("still revokes the browser endpoint when the app server is unavailable", async () => {
    const unsubscribe = vi.fn(async () => true);
    await expect(revokeDevicePush({ endpoint: "current", unsubscribe }, async () => { throw new Error("offline"); })).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("accepts server removal when a browser refuses to unsubscribe", async () => {
    await expect(revokeDevicePush({ endpoint: "current", unsubscribe: async () => false }, async () => undefined)).resolves.toBeUndefined();
  });

  it("does not falsely report disabled when both revocations fail", async () => {
    await expect(revokeDevicePush({ endpoint: "current", unsubscribe: async () => false }, async () => { throw new Error("offline"); })).rejects.toThrow("nepodarilo vypnúť");
  });
});

function browserFixture(options: { permission?: NotificationPermission; existing?: PushSubscription | null; serverResponse?: Record<string, unknown>; serverOk?: boolean } = {}) {
  let currentSubscription = options.existing ?? null;
  const subscription = {
    endpoint: "https://push.example/new-device",
    toJSON: () => ({ endpoint: "https://push.example/new-device", keys: { p256dh: "key", auth: "auth" } }),
    unsubscribe: vi.fn(async () => { currentSubscription = null; return true; }),
  } as unknown as PushSubscription;
  const subscribe = vi.fn(async () => { currentSubscription = subscription; return subscription; });
  const registration = { pushManager: { getSubscription: vi.fn(async () => currentSubscription), subscribe }, getNotifications: async () => [] };
  const register = vi.fn(async () => registration);
  let permission = options.permission ?? "default";
  const requestPermission = vi.fn(async () => { permission = options.permission ?? "granted"; return permission; });
  vi.stubGlobal("Notification", { get permission() { return permission; }, requestPermission });
  vi.stubGlobal("window", {
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    PushManager: {},
    Notification: {},
    localStorage: { getItem: () => null, setItem: vi.fn() },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal("navigator", {
    userAgent: "Chrome", platform: "Linux", maxTouchPoints: 0,
    serviceWorker: { register, ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) },
  });
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>>(async () => ({ ok: options.serverOk ?? true, json: async () => options.serverResponse ?? { ok: true } }));
  vi.stubGlobal("fetch", fetchMock);
  const state: PushDeviceState = {
    support: "supported", permission: "default", configured: true, publicKey: "BAEC", subscription: null, subscribed: false, soundEnabled: true,
    ...DEFAULT_PUSH_CATEGORIES, callNotificationsConfigured: false,
  };
  return { subscription, subscribe, register, requestPermission, fetchMock, state };
}

describe("push opt-in lifecycle", () => {
  it("serializes another tab's ownership read behind subscribe and persistence using the device lock", async () => {
    const fixture = browserFixture();
    let lockTail: Promise<unknown> = Promise.resolve();
    const request = vi.fn((name: string, operation: () => Promise<unknown>) => {
      expect(name).toBe("pm:push-device-subscription");
      const next = lockTail.then(operation);
      lockTail = next.catch(() => undefined);
      return next;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    let serverSaved = false;
    fixture.fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === "POST") {
        await saveGate;
        serverSaved = true;
      }
      return { ok: true, json: async () => ({ configured: true, publicKey: "BAEC", subscribed: serverSaved, soundEnabled: true }) };
    });
    const enrollment = enableDevicePush(fixture.state);
    await vi.waitFor(() => expect(fixture.fetchMock).toHaveBeenCalledOnce());
    // A separately imported module models another tab's independent memory.
    vi.resetModules();
    const otherTab = await import("./push-client");
    const reconciliation = otherTab.reconcilePushDeviceState(otherTab.pushEnrollmentState().version);
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    finishSave();
    await enrollment;
    const state = await reconciliation;
    expect(state.subscribed).toBe(true);
    expect(fixture.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never revokes a new endpoint while its ownership POST is pending or from a stale pre-enrollment GET", async () => {
    const fixture = browserFixture();
    const beforeEnrollment = pushEnrollmentState().version;
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    fixture.fetchMock.mockImplementation(async () => {
      await saveGate;
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const pending = enableDevicePush(fixture.state);
    await vi.waitFor(() => expect(fixture.fetchMock).toHaveBeenCalledOnce());
    expect(pushEnrollmentState().pending).toBe(true);
    await expect(removeUnownedBrowserPush({ subscription: fixture.subscription, subscribed: false }, beforeEnrollment)).resolves.toBe(false);
    expect(fixture.subscription.unsubscribe).not.toHaveBeenCalled();
    finishSave();
    await pending;
    expect(pushEnrollmentState().pending).toBe(false);
    await expect(removeUnownedBrowserPush({ subscription: fixture.subscription, subscribed: false }, beforeEnrollment)).resolves.toBe(false);
    expect(fixture.subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("requests permission directly from the click before service worker registration", async () => {
    const fixture = browserFixture();
    const pending = enableDevicePush(fixture.state);
    expect(fixture.requestPermission).toHaveBeenCalledOnce();
    expect(fixture.register).not.toHaveBeenCalled();
    await pending;
    expect(fixture.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([4, 1, 2]) });
    expect(JSON.parse(fixture.fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({ soundEnabled: true });
  });

  it("permission denial never creates a subscription or server write", async () => {
    const fixture = browserFixture({ permission: "denied" });
    await expect(enableDevicePush(fixture.state)).rejects.toThrow("zablokované");
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back newly created browser subscriptions when persistence fails", async () => {
    const fixture = browserFixture({ serverOk: false, serverResponse: { error: "server offline" } });
    await expect(enableDevicePush(fixture.state)).rejects.toThrow("server offline");
    expect(fixture.subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rotates an endpoint belonging to a previous account before enrolling", async () => {
    const oldUnsubscribe = vi.fn(async () => true);
    const fixture = browserFixture({ existing: { endpoint: "previous-user", unsubscribe: oldUnsubscribe } as unknown as PushSubscription });
    await enableDevicePush(fixture.state);
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(fixture.subscribe).toHaveBeenCalledOnce();
  });

  it("a read verifies server ownership and never automatically enrolls an existing browser subscription", async () => {
    const fixture = browserFixture({
      permission: "granted",
      existing: { endpoint: "previous-user" } as PushSubscription,
      serverResponse: { configured: true, publicKey: "BAEC", subscribed: false },
    });
    const state = await readPushDeviceState();
    expect(state.subscribed).toBe(false);
    expect(fixture.fetchMock).toHaveBeenCalledWith("/api/push/subscriptions?endpoint=previous-user", expect.objectContaining({ method: "GET" }));
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.requestPermission).not.toHaveBeenCalled();
  });
});

describe("notification chime policy", () => {
  const audible = { enabled: true, visible: true, nativePushActive: false, alreadyPlayed: false };
  it("plays once in the foreground without duplicating native push sound", () => {
    expect(shouldPlayNotificationSound(audible)).toBe(true);
    expect(shouldPlayNotificationSound({ ...audible, nativePushActive: true })).toBe(false);
    expect(shouldPlayNotificationSound({ ...audible, alreadyPlayed: true })).toBe(false);
  });
  it("respects disabled sound and background pages", () => {
    expect(shouldPlayNotificationSound({ ...audible, enabled: false })).toBe(false);
    expect(shouldPlayNotificationSound({ ...audible, visible: false })).toBe(false);
  });

  it("adopts another tab's sound preference without echoing a storage write", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { setItem, getItem: () => "on" } });
    rememberNotificationSound(true);
    setItem.mockClear();
    syncNotificationSoundFromStorage("off");
    expect(readNotificationSound()).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    syncNotificationSoundFromStorage("on");
    expect(readNotificationSound()).toBe(true);
  });
});

describe("independent push categories", () => {
  it("reads owned category preferences without making missing legacy fields look disabled", async () => {
    const fixture = browserFixture({
      permission: "granted", existing: { endpoint: "owned-device" } as PushSubscription,
      serverResponse: { configured: true, publicKey: "BAEC", subscribed: true, taskNotificationsEnabled: false, incomingCallsEnabled: true, availableCallsEnabled: false, callNotificationsConfigured: true },
    });
    expect(await readPushDeviceState()).toMatchObject({ subscribed: true, taskNotificationsEnabled: false, incomingCallsEnabled: true, availableCallsEnabled: false, callNotificationsConfigured: true });
    fixture.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ configured: true, publicKey: "BAEC", subscribed: true }) });
    expect(await readPushDeviceState()).toMatchObject({ ...DEFAULT_PUSH_CATEGORIES, callNotificationsConfigured: false });
    fixture.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ configured: true, publicKey: "BAEC", subscribed: false, taskNotificationsEnabled: false, incomingCallsEnabled: false, availableCallsEnabled: false }) });
    expect(await readPushDeviceState()).toMatchObject({ ...DEFAULT_PUSH_CATEGORIES, subscribed: false });
  });

  it.each<PushCategory>(["taskNotificationsEnabled", "incomingCallsEnabled", "availableCallsEnabled"])("patches only %s and the owned endpoint", async (category) => {
    const fixture = browserFixture();
    await updateDevicePushCategory({ ...fixture.state, subscription: fixture.subscription, subscribed: true, callNotificationsConfigured: true }, category, false);
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ endpoint: fixture.subscription.endpoint, [category]: false });
  });

  it("refuses category writes for an unowned endpoint or a legacy API", async () => {
    const fixture = browserFixture();
    await expect(updateDevicePushCategory({ ...fixture.state, subscription: fixture.subscription }, "incomingCallsEnabled", false)).rejects.toThrow("Najskôr zapni");
    await expect(updateDevicePushCategory({ ...fixture.state, subscription: fixture.subscription, subscribed: true }, "taskNotificationsEnabled", false)).rejects.toThrow("Výber typov");
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("enrolls all category choices when supported and preserves the legacy POST shape otherwise", async () => {
    const fixture = browserFixture();
    await enableDevicePush({ ...fixture.state, taskNotificationsEnabled: false, incomingCallsEnabled: true, availableCallsEnabled: false, callNotificationsConfigured: true });
    expect(JSON.parse(fixture.fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      subscription: fixture.subscription.toJSON(), soundEnabled: true, taskNotificationsEnabled: false, incomingCallsEnabled: true, availableCallsEnabled: false,
    });
    const legacy = browserFixture();
    await enableDevicePush(legacy.state);
    expect(JSON.parse(legacy.fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ subscription: legacy.subscription.toJSON(), soundEnabled: true });
  });

  it("does not overwrite another tab's fresh category preferences while reusing its owned endpoint", async () => {
    const fixture = browserFixture({
      permission: "granted",
      existing: { endpoint: "already-owned", toJSON: () => ({ endpoint: "already-owned" }) } as PushSubscription,
      serverResponse: { subscribed: true, callNotificationsConfigured: true, soundEnabled: false, taskNotificationsEnabled: false, incomingCallsEnabled: false, availableCallsEnabled: true },
    });
    await enableDevicePush({ ...fixture.state, callNotificationsConfigured: true });
    expect(fixture.subscribe).not.toHaveBeenCalled();
    const post = fixture.fetchMock.mock.calls.find(([, init]) => init.method === "POST")!;
    expect(JSON.parse(post[1].body as string)).toEqual({ subscription: { endpoint: "already-owned" }, soundEnabled: false, taskNotificationsEnabled: false, incomingCallsEnabled: false, availableCallsEnabled: true });
  });
});
