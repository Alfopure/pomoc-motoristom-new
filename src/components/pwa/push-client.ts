export const PUSH_SETTINGS_EVENT = "pm:push-settings-changed";
export const PUSH_SOUND_KEY = "pm:notification-sound:v1";
let notificationSoundMemory: boolean | undefined;
let pushEnrollmentVersion = 0;
let pushEnrollmentPending = false;

export function pushEnrollmentState() {
  return { version: pushEnrollmentVersion, pending: pushEnrollmentPending };
}

const PUSH_DEVICE_LOCK = "pm:push-device-subscription";

async function withPushDeviceLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks?.request) return navigator.locks.request(PUSH_DEVICE_LOCK, operation);
  return operation();
}

export type PushSupport = "supported" | "install-ios" | "insecure" | "unsupported";
export type PushCategoryPreferences = {
  taskNotificationsEnabled: boolean;
  incomingCallsEnabled: boolean;
  availableCallsEnabled: boolean;
};
export type PushCategory = keyof PushCategoryPreferences;
export const DEFAULT_PUSH_CATEGORIES: PushCategoryPreferences = {
  taskNotificationsEnabled: true,
  incomingCallsEnabled: true,
  availableCallsEnabled: true,
};

export type PushDeviceState = PushCategoryPreferences & {
  support: PushSupport;
  permission: NotificationPermission;
  configured: boolean;
  publicKey: string | null;
  subscription: PushSubscription | null;
  subscribed: boolean;
  soundEnabled: boolean;
  callNotificationsConfigured: boolean;
};

type PushServerState = Partial<PushCategoryPreferences> & {
  configured: boolean;
  publicKey: string | null;
  subscribed?: boolean;
  soundEnabled?: boolean;
  callNotificationsConfigured?: boolean;
};

function serverCategoryPreferences(server: Partial<PushCategoryPreferences>): PushCategoryPreferences {
  return {
    taskNotificationsEnabled: server.taskNotificationsEnabled !== false,
    incomingCallsEnabled: server.incomingCallsEnabled !== false,
    availableCallsEnabled: server.availableCallsEnabled !== false,
  };
}

export function detectPushSupport(scope: {
  secure: boolean;
  ios: boolean;
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
}): PushSupport {
  if (!scope.secure) return "insecure";
  if (scope.ios && !scope.standalone) return "install-ios";
  return scope.serviceWorker && scope.pushManager && scope.notifications ? "supported" : "unsupported";
}

export function browserPushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return detectPushSupport({
    secure: window.isSecureContext,
    ios,
    standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notifications: "Notification" in window,
  });
}

export function readNotificationSound(): boolean {
  if (notificationSoundMemory !== undefined) return notificationSoundMemory;
  try {
    return window.localStorage.getItem(PUSH_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function rememberNotificationSound(enabled: boolean) {
  notificationSoundMemory = enabled;
  try {
    window.localStorage.setItem(PUSH_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    // The setting still applies to the server subscription in private browsing.
  }
}

/** Storage events come from another tab; update memory without writing back. */
export function syncNotificationSoundFromStorage(value: string | null) {
  notificationSoundMemory = value !== "off";
}

export function storeNotificationSound(enabled: boolean) {
  rememberNotificationSound(enabled);
  window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT));
}

export async function pushRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : "Nastavenie upozornení sa nepodarilo uložiť. Skús to znova.");
  }
  return result as T;
}

export async function readPushDeviceState(): Promise<PushDeviceState> {
  const support = browserPushSupport();
  const permission = typeof Notification === "undefined" ? "default" : Notification.permission;
  const registration = support === "supported" ? await navigator.serviceWorker.getRegistration("/") : undefined;
  const subscription = await registration?.pushManager.getSubscription() ?? null;
  const query = subscription ? `?endpoint=${encodeURIComponent(subscription.endpoint)}` : "";
  const server = await pushRequest<PushServerState>(`/api/push/subscriptions${query}`);
  return {
    support,
    permission,
    configured: server.configured,
    publicKey: server.publicKey,
    subscription,
    subscribed: Boolean(subscription && server.subscribed && permission === "granted"),
    soundEnabled: typeof server.soundEnabled === "boolean" && server.subscribed ? server.soundEnabled : readNotificationSound(),
    ...serverCategoryPreferences(server.subscribed ? server : {}),
    // An older API may still support task push. Do not offer call controls
    // until the server explicitly confirms that those preferences can persist.
    callNotificationsConfigured: server.callNotificationsConfigured === true,
  };
}

/** A partial patch cannot overwrite another category changed in another tab. */
export async function updateDevicePushCategory(state: PushDeviceState, category: PushCategory, enabled: boolean): Promise<void> {
  if (!state.subscribed || !state.subscription) throw new Error("Najskôr zapni push upozornenia na tomto zariadení.");
  if (!state.callNotificationsConfigured) {
    throw new Error("Výber typov upozornení ešte nie je pripravený.");
  }
  await withPushDeviceLock(() => pushRequest("/api/push/subscriptions", "PATCH", { endpoint: state.subscription!.endpoint, [category]: enabled }));
  window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT));
}

/** An expired session can be followed by a different operator on this browser. */
export async function removeUnownedBrowserPush(
  state: Pick<PushDeviceState, "subscription" | "subscribed">,
  observedVersion = pushEnrollmentVersion,
): Promise<boolean> {
  if (!state.subscription || state.subscribed || pushEnrollmentPending || observedVersion !== pushEnrollmentVersion) return false;
  await state.subscription.unsubscribe();
  return true;
}

/** The ownership read and cleanup share the same cross-tab lock as enrollment. */
export async function reconcilePushDeviceState(observedVersion: number, stillMounted: () => boolean = () => true): Promise<PushDeviceState> {
  // Older browsers without cross-tab locking can still explicitly opt in/out.
  // Avoid racing another tab's enrollment with automatic orphan cleanup there.
  if (!navigator.locks?.request) return readPushDeviceState();
  return withPushDeviceLock(async () => {
    const state = await readPushDeviceState();
    if (stillMounted() && await removeUnownedBrowserPush(state, observedVersion)) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const notifications = await registration?.getNotifications();
      notifications?.forEach((notification) => notification.close());
      return { ...state, subscription: null };
    }
    return state;
  });
}

export function decodeApplicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const decoded = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/** Permission must be the first async operation so Safari retains the button gesture. */
export async function enableDevicePush(state: PushDeviceState): Promise<PushSubscription> {
  if (pushEnrollmentPending) throw new Error("Zapínanie upozornení už prebieha.");
  pushEnrollmentPending = true;
  pushEnrollmentVersion += 1;
  try {
    return await subscribeDevicePush(state);
  } finally {
    pushEnrollmentPending = false;
    pushEnrollmentVersion += 1;
    // Recheck only after the browser endpoint and server ownership are settled.
    window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT));
  }
}

async function subscribeDevicePush(state: PushDeviceState): Promise<PushSubscription> {
  if (!state.configured || !state.publicKey) throw new Error("Push upozornenia ešte nie sú pripravené. Kontaktuj správcu.");
  const publicKey = state.publicKey;
  if (browserPushSupport() !== "supported") throw new Error("Tento prehliadač nepodporuje push upozornenia.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Upozornenia sú zablokované. Povoľ ich v nastaveniach stránky alebo aplikácie a skús to znova."
      : "Povolenie nebolo udelené. Push upozornenia zostali vypnuté.");
  }

  return withPushDeviceLock(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    const registration = await waitForServiceWorker();
    let subscription = await registration.pushManager.getSubscription();
    let soundEnabled = state.soundEnabled;
    let categories = serverCategoryPreferences(state);
    let categoriesConfigured = state.callNotificationsConfigured;
    // Recheck inside the device lock: another tab may have enrolled since the
    // settings panel loaded. Never transfer another account's endpoint.
    if (subscription) {
      const owned = await pushRequest<PushServerState>(`/api/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`);
      if (!owned.subscribed) {
        if (!(await subscription.unsubscribe())) throw new Error("Predošlé prihlásenie upozornení sa nepodarilo obnoviť. Skús to znova.");
        subscription = null;
      } else {
        // Another tab may have enrolled this endpoint after the settings read.
        // Preserve its current preferences rather than posting stale defaults.
        categories = serverCategoryPreferences(owned);
        categoriesConfigured = owned.callNotificationsConfigured === true;
        soundEnabled = owned.soundEnabled ?? soundEnabled;
      }
    }
    const created = !subscription;
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(publicKey),
    });
    try {
      await pushRequest("/api/push/subscriptions", "POST", {
        subscription: subscription.toJSON(), soundEnabled,
        ...(categoriesConfigured ? categories : {}),
      });
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => false);
      throw error;
    }
    storeNotificationSound(soundEnabled);
    return subscription;
  });
}

async function waitForServiceWorker(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Aplikácia sa ešte pripravuje. Obnov stránku a skús to znova.")), 12_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Either deletion or browser revocation stops delivery, including when offline. */
export async function revokeDevicePush(
  subscription: Pick<PushSubscription, "endpoint" | "unsubscribe">,
  removeOnServer: (endpoint: string) => Promise<unknown> = (endpoint) => pushRequest("/api/push/subscriptions", "DELETE", { endpoint }),
): Promise<void> {
  let serverRemoved = false;
  try {
    await removeOnServer(subscription.endpoint);
    serverRemoved = true;
  } catch {
    // Revoking at the browser also works if the application server is offline.
  }
  let browserRemoved = false;
  try {
    browserRemoved = await subscription.unsubscribe();
  } catch {
    // Server removal is enough to stop future notifications.
  }
  if (!serverRemoved && !browserRemoved) {
    throw new Error("Upozornenia sa nepodarilo vypnúť. Skontroluj pripojenie a skús to znova.");
  }
}

export async function disableCurrentDevicePush(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  await withPushDeviceLock(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await revokeDevicePush(subscription);
    const notifications = await registration?.getNotifications().catch(() => []);
    notifications?.forEach((notification) => notification.close());
  });
  window.dispatchEvent(new Event(PUSH_SETTINGS_EVENT));
}
