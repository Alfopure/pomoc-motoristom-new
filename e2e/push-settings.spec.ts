import { expect, test, type Page } from "@playwright/test";
import { buildSync } from "esbuild";

// This uses the real component with isolated browser/service fixtures. The
// intercepted page never loads authenticated dispatch data or a live provider.
const fixtureScript = buildSync({
  stdin: {
    contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { PushNotificationSettings } from "./src/components/pwa/PushNotificationSettings"; createRoot(document.getElementById("root")).render(React.createElement(PushNotificationSettings));',
    resolveDir: process.cwd(),
    sourcefile: "push-settings-fixture.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
}).outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

let fixtureCss = "";
test.beforeAll(async ({ request, baseURL }) => {
  const response = await request.get(baseURL!);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const stylesheets = [...new Set([...html.matchAll(/href="([^"<>]+\.css(?:\?[^"<>]*)?)"/g)].map((match) => match[1].replaceAll("&amp;", "&")))];
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const stylesheet of stylesheets) {
    const response = await request.get(new URL(stylesheet, baseURL).href);
    expect(response.ok()).toBe(true);
    fixtureCss += await response.text();
  }
});

type ApiWrite = { method: string; path: string; body: Record<string, unknown> };

type FixtureOptions = {
  ios?: boolean; standalone?: boolean; grant?: "granted" | "denied";
  configured?: boolean; rejectSubscription?: boolean; legacy?: boolean; rejectCategory?: boolean;
  subscribed?: boolean; savedPreferences?: boolean; waitForReady?: boolean; rejectReads?: boolean;
  beforeRead?: (path: string) => Promise<void>;
};

async function openPushSettings(page: Page, options: FixtureOptions = {}) {
  const server = {
    subscribed: options.subscribed ?? false,
    soundEnabled: options.savedPreferences ?? true,
    mobileEnabled: true,
    pauseEndingEnabled: false,
    categories: {
      taskNotificationsEnabled: options.savedPreferences ?? true,
      incomingCallsEnabled: options.savedPreferences ?? true,
      availableCallsEnabled: options.savedPreferences ?? true,
    },
  };
  const { categories } = server;
  const writes: ApiWrite[] = [];
  await page.addInitScript((fixture) => {
    let permission: NotificationPermission = fixture.subscribed ? "granted" : "default";
    let browserSubscribed = fixture.subscribed ?? false;
    const calls = { permission: 0, subscribe: 0, unsubscribe: 0 };
    Object.defineProperty(window, "__pushFixture", { value: calls });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        get permission() { return permission; },
        requestPermission: async () => { calls.permission += 1; permission = fixture.grant ?? "granted"; return permission; },
      },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: {} });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: fixture.ios ? "iPhone" : "Chrome" });
    Object.defineProperty(navigator, "platform", { configurable: true, value: fixture.ios ? "iPhone" : "Linux" });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: fixture.standalone ?? false });
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture",
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "fixture-key", auth: "fixture-auth" } }; },
      async unsubscribe() { calls.unsubscribe += 1; browserSubscribed = false; return true; },
    };
    const registration = {
      pushManager: {
        getSubscription: async () => browserSubscribed ? subscription : null,
        subscribe: async () => { calls.subscribe += 1; browserSubscribed = true; return subscription; },
      },
      getNotifications: async () => [],
    };
    const serviceWorker = {
      getRegistration: async () => registration,
      register: async () => registration,
      ready: Promise.resolve(registration),
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
    localStorage.clear();
  }, { ios: options.ios, standalone: options.standalone, grant: options.grant, subscribed: options.subscribed });
  await page.route("**/*", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (!["/api/push/subscriptions", "/api/push/test", "/api/push/mobile-calls", "/api/push/pause-ending"].includes(path)) {
      await route.fulfill({ status: 409, json: { error: "Unexpected request blocked by push fixture." } });
      return;
    }
    if (method === "GET") {
      const json = path === "/api/push/mobile-calls"
        ? { enabled: server.mobileEnabled, mobileApps: 1 }
        : path === "/api/push/pause-ending"
          ? { enabled: server.pauseEndingEnabled }
          : { configured: options.configured ?? true, publicKey: "BAEC", subscribed: server.subscribed, soundEnabled: server.soundEnabled, ...(options.legacy ? {} : { ...categories, callNotificationsConfigured: true }) };
      await options.beforeRead?.(path);
      await route.fulfill(options.rejectReads
        ? { status: 503, json: { error: "Testovaný výpadok načítania." } }
        : { status: 200, json });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ method, path, body });
    if (path === "/api/push/mobile-calls" || path === "/api/push/pause-ending") {
      if (path === "/api/push/mobile-calls") server.mobileEnabled = body.enabled as boolean;
      else server.pauseEndingEnabled = body.enabled as boolean;
      await route.fulfill({ status: 200, json: { enabled: body.enabled, mobileApps: 1 } });
      return;
    }
    if (method === "POST" && path === "/api/push/subscriptions") {
      if (options.rejectSubscription) {
        await route.fulfill({ status: 503, json: { error: "Testovaný výpadok uloženia." } });
        return;
      }
      server.subscribed = true;
      server.soundEnabled = body.soundEnabled as boolean;
      for (const key of Object.keys(categories) as Array<keyof typeof categories>) if (typeof body[key] === "boolean") categories[key] = body[key];
    } else if (method === "PATCH") {
      if (options.rejectCategory && Object.keys(categories).some((key) => key in body)) {
        await route.fulfill({ status: 503, json: { error: "Testovaný výpadok nastavenia typu." } });
        return;
      }
      if (typeof body.soundEnabled === "boolean") server.soundEnabled = body.soundEnabled;
      for (const key of Object.keys(categories) as Array<keyof typeof categories>) if (typeof body[key] === "boolean") categories[key] = body[key];
    }
    else if (method === "DELETE") server.subscribed = false;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/push-settings-fixture", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fixtureCss}</style></head><body><div id="root"></div><script>${fixtureScript}</script></body></html>`,
  }));
  await page.goto("/push-settings-fixture");
  if (options.waitForReady !== false) {
    await expect(page.getByText(options.subscribed ? "Zapnuté na tomto zariadení" : "Vypnuté na tomto zariadení", { exact: true })).toBeVisible();
  }
  return { writes, server };
}

test("device push can opt in, mute, test and opt out without changing another endpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await openPushSettings(page);
  const push = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  const sound = page.getByRole("switch", { name: "Zvuk upozornení" });
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __pushFixture: { permission: number } }).__pushFixture.permission)).toBe(0);
  await push.click();
  await expect(push).toBeChecked();
  await expect(page.getByText("Zapnuté na tomto zariadení", { exact: true })).toBeVisible();
  await sound.click();
  await expect(sound).not.toBeChecked();
  await page.getByRole("button", { name: "Poslať test", exact: true }).click();
  await expect(page.getByRole("button", { name: /Ďalší test o/ })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Test bol odoslaný");
  await push.click();
  await expect(push).not.toBeChecked();
  expect(writes.map(({ method, path }) => [method, path])).toEqual([
    ["POST", "/api/push/subscriptions"], ["PATCH", "/api/push/subscriptions"], ["POST", "/api/push/test"], ["DELETE", "/api/push/subscriptions"],
  ]);
  expect(writes[1].body).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture", soundEnabled: false });
  expect(writes[3].body).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture" });
});

test("denied permission explains recovery and never saves a subscription", async ({ page }) => {
  const { writes } = await openPushSettings(page, { grant: "denied" });
  const push = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  await push.click();
  await expect(page.getByRole("alert")).toContainText("zablokované");
  await expect(push).not.toBeChecked();
  await expect(push).toBeDisabled();
  expect(writes).toEqual([]);
});

test("iPhone browser shows installation guidance", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPushSettings(page, { ios: true });
  await expect(page.getByText(/Na iPhone alebo iPade otvor Zdieľať/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" })).toBeDisabled();
});

test("an installed iPhone PWA can subscribe from the explicit switch", async ({ page }) => {
  const { writes } = await openPushSettings(page, { ios: true, standalone: true });
  const push = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  await push.click();
  await expect(push).toBeChecked();
  expect(writes).toHaveLength(1);
});

test("failed server persistence leaves push disabled and rolls back the browser endpoint", async ({ page }) => {
  await openPushSettings(page, { rejectSubscription: true });
  const push = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  await push.click();
  await expect(page.getByRole("alert")).toHaveText("Testovaný výpadok uloženia.");
  await expect(push).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { __pushFixture: { unsubscribe: number } }).__pushFixture.unsubscribe)).toBe(1);
});

test("task, incoming and available call pushes can be switched independently", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await openPushSettings(page);
  const master = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  const tasks = page.getByRole("switch", { name: "Úlohy a pripomienky" });
  const incoming = page.getByRole("switch", { name: "Prichádzajúce hovory" });
  const available = page.getByRole("switch", { name: "Hovory na prevzatie" });
  for (const name of ["Úlohy a pripomienky", "Prichádzajúce hovory", "Hovory na prevzatie"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  await master.click();
  await expect(incoming).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const category of [tasks, incoming, available]) expect((await category.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("call-push-settings-mobile.png"), fullPage: true });
  await incoming.click();
  await expect(incoming).not.toBeChecked();
  await expect(tasks).toBeChecked();
  await expect(available).toBeChecked();
  await tasks.click();
  await expect(tasks).not.toBeChecked();
  await available.click();
  await expect(available).not.toBeChecked();
  await expect(master).toBeChecked();
  await expect(page.getByRole("switch", { name: "Zvuk upozornení" })).toBeChecked();
  await page.getByRole("button", { name: "Obnoviť stav", exact: true }).click();
  for (const category of [tasks, incoming, available]) await expect(category).not.toBeChecked();
  const endpoint = "https://fcm.googleapis.com/fcm/send/current-device-fixture";
  expect(writes.filter(({ method }) => method === "PATCH").map(({ body }) => body)).toEqual([
    { endpoint, incomingCallsEnabled: false }, { endpoint, taskNotificationsEnabled: false }, { endpoint, availableCallsEnabled: false },
  ]);
  await master.click();
  for (const name of ["Úlohy a pripomienky", "Prichádzajúce hovory", "Hovory na prevzatie"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    await expect(page.getByRole("switch", { name, exact: true })).toHaveCount(0);
  }
});

test("legacy task push stays usable while category setup is unavailable", async ({ page }) => {
  const { writes } = await openPushSettings(page, { legacy: true });
  const master = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  await master.click();
  await expect(master).toBeChecked();
  for (const name of ["Úlohy a pripomienky", "Prichádzajúce hovory", "Hovory na prevzatie"]) await expect(page.getByRole("switch", { name })).toBeDisabled();
  await expect(page.getByText(/Výber typov upozornení ešte nie je pripravený/)).toBeVisible();
  await page.getByRole("switch", { name: "Zvuk upozornení" }).click();
  expect(writes[0].body).toEqual({
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture", keys: { p256dh: "fixture-key", auth: "fixture-auth" } }, soundEnabled: true, clientKind: "web",
  });
  expect(writes[1].body).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture", soundEnabled: false });
});

test("failed category persistence keeps the previous preference visible", async ({ page }) => {
  await openPushSettings(page, { rejectCategory: true });
  await page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" }).click();
  const incoming = page.getByRole("switch", { name: "Prichádzajúce hovory" });
  await expect(incoming).toBeEnabled();
  await incoming.click();
  await expect(page.getByRole("alert")).toHaveText("Testovaný výpadok nastavenia typu.");
  await expect(incoming).toBeChecked();
  await expect(page.getByRole("switch", { name: "Úlohy a pripomienky" })).toBeChecked();
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("delayed initial reads show loading instead of invented switch values", async ({ page }) => {
  const reads = deferred();
  const { writes } = await openPushSettings(page, {
    subscribed: true, savedPreferences: false, waitForReady: false, beforeRead: () => reads.promise,
  });
  await expect(page.getByText("Overujem zariadenie…")).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByTestId("mobile-call-notifications")).toContainText("Načítavam…");
  await expect(page.getByTestId("pause-ending-notifications")).toContainText("Načítavam…");
  for (const name of ["Push upozornenia na tomto zariadení", "Prichádzajúce hovory", "Zvuk upozornení"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  reads.resolve();
  await expect(page.getByRole("switch", { name: "Upozorniť na hovory aj v mobilnej appke" })).toBeChecked();
  for (const name of ["Upozornenie pred koncom pauzy", "Prichádzajúce hovory", "Zvuk upozornení"]) {
    await expect(page.getByRole("switch", { name, exact: true })).not.toBeChecked();
  }
  expect(writes).toEqual([]);
});

test("failed initial reads stay unknown and manual refresh recovers every preference", async ({ page }) => {
  const options: FixtureOptions = { subscribed: true, savedPreferences: false, waitForReady: false, rejectReads: true };
  const { writes } = await openPushSettings(page, options);
  await expect(page.getByRole("alert")).toHaveCount(3);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByText("Stav zariadenia nie je načítaný")).toBeVisible();
  options.rejectReads = false;
  await page.getByRole("button", { name: "Obnoviť stav", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Upozorniť na hovory aj v mobilnej appke" })).toBeChecked();
  await expect(page.getByRole("switch", { name: "Upozornenie pred koncom pauzy" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Prichádzajúce hovory" })).not.toBeChecked();
  expect(writes).toEqual([]);
});

test("focus, visibility and settings events synchronize saved preferences without writes", async ({ page }) => {
  const { writes, server } = await openPushSettings(page, { subscribed: true });
  for (const event of ["focus", "visibilitychange", "pm:push-settings-changed"]) {
    server.categories.incomingCallsEnabled = !server.categories.incomingCallsEnabled;
    server.mobileEnabled = !server.mobileEnabled;
    server.pauseEndingEnabled = !server.pauseEndingEnabled;
    await page.evaluate((name) => (name === "visibilitychange" ? document : window).dispatchEvent(new Event(name)), event);
    await expect(page.getByRole("switch", { name: "Prichádzajúce hovory" })).toHaveAttribute("aria-checked", String(server.categories.incomingCallsEnabled));
    await expect(page.getByRole("switch", { name: "Upozorniť na hovory aj v mobilnej appke" })).toHaveAttribute("aria-checked", String(server.mobileEnabled));
    await expect(page.getByRole("switch", { name: "Upozornenie pred koncom pauzy" })).toHaveAttribute("aria-checked", String(server.pauseEndingEnabled));
  }
  expect(writes).toEqual([]);
});

test("a delayed older device read cannot overwrite the latest saved state", async ({ page }) => {
  const options: FixtureOptions = { subscribed: true };
  const { writes, server } = await openPushSettings(page, options);
  const oldRead = deferred();
  const started = deferred();
  options.beforeRead = async (path) => {
    if (path === "/api/push/subscriptions") { started.resolve(); await oldRead.promise; }
  };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await started.promise;
  options.beforeRead = undefined;
  server.categories.incomingCallsEnabled = false;
  await page.evaluate(() => window.dispatchEvent(new Event("pm:push-settings-changed")));
  const incoming = page.getByRole("switch", { name: "Prichádzajúce hovory" });
  await expect(incoming).not.toBeChecked();
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/push/subscriptions");
  oldRead.resolve();
  await (await oldResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByText("Zapnuté na tomto zariadení", { exact: true })).toBeVisible();
  await expect(incoming).not.toBeChecked();
  expect(writes).toEqual([]);
});

test("disabled master keeps categories inactive across refresh instead of showing default ON", async ({ page }) => {
  const { writes } = await openPushSettings(page, { subscribed: true, savedPreferences: false });
  await page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" }).click();
  for (const refresh of [false, true]) {
    if (refresh) await page.getByRole("button", { name: "Obnoviť stav", exact: true }).click();
    await expect(page.getByText("Vypnuté na tomto zariadení", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Prichádzajúce hovory" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prichádzajúce hovory", exact: true })).toBeDisabled();
  }
  expect(writes.map(({ method }) => method)).toEqual(["DELETE"]);
});
