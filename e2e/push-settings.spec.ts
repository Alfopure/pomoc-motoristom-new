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

async function openPushSettings(page: Page, options: { ios?: boolean; standalone?: boolean; grant?: "granted" | "denied"; configured?: boolean; rejectSubscription?: boolean; legacy?: boolean; rejectCategory?: boolean } = {}) {
  let subscribed = false;
  let soundEnabled = true;
  const categories = { taskNotificationsEnabled: true, incomingCallsEnabled: true, availableCallsEnabled: true };
  const writes: ApiWrite[] = [];
  await page.addInitScript((fixture) => {
    let permission: NotificationPermission = "default";
    let browserSubscribed = false;
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
  }, options);
  await page.route("**/*", (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path !== "/api/push/subscriptions" && path !== "/api/push/test") {
      await route.fulfill({ status: 409, json: { error: "Unexpected request blocked by push fixture." } });
      return;
    }
    if (method === "GET") {
      await route.fulfill({ status: 200, json: { configured: options.configured ?? true, publicKey: "BAEC", subscribed, soundEnabled, ...(options.legacy ? {} : { ...categories, callNotificationsConfigured: true }) } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ method, path, body });
    if (method === "POST" && path === "/api/push/subscriptions") {
      if (options.rejectSubscription) {
        await route.fulfill({ status: 503, json: { error: "Testovaný výpadok uloženia." } });
        return;
      }
      subscribed = true;
      soundEnabled = body.soundEnabled as boolean;
      for (const key of Object.keys(categories) as Array<keyof typeof categories>) if (typeof body[key] === "boolean") categories[key] = body[key];
    } else if (method === "PATCH") {
      if (options.rejectCategory && Object.keys(categories).some((key) => key in body)) {
        await route.fulfill({ status: 503, json: { error: "Testovaný výpadok nastavenia typu." } });
        return;
      }
      if (typeof body.soundEnabled === "boolean") soundEnabled = body.soundEnabled;
      for (const key of Object.keys(categories) as Array<keyof typeof categories>) if (typeof body[key] === "boolean") categories[key] = body[key];
    }
    else if (method === "DELETE") subscribed = false;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/push-settings-fixture", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fixtureCss}</style></head><body><div id="root"></div><script>${fixtureScript}</script></body></html>`,
  }));
  await page.goto("/push-settings-fixture");
  await expect(page.getByText("Vypnuté na tomto zariadení", { exact: true })).toBeVisible();
  return writes;
}

test("device push can opt in, mute, test and opt out without changing another endpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const writes = await openPushSettings(page);
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
  const writes = await openPushSettings(page, { grant: "denied" });
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
  const writes = await openPushSettings(page, { ios: true, standalone: true });
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
  const writes = await openPushSettings(page);
  const master = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  const tasks = page.getByRole("switch", { name: "Úlohy a pripomienky" });
  const incoming = page.getByRole("switch", { name: "Prichádzajúce hovory" });
  const available = page.getByRole("switch", { name: "Hovory na prevzatie" });
  for (const category of [tasks, incoming, available]) await expect(category).toBeDisabled();
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
  for (const category of [tasks, incoming, available]) await expect(category).toBeDisabled();
});

test("legacy task push stays usable while category setup is unavailable", async ({ page }) => {
  const writes = await openPushSettings(page, { legacy: true });
  const master = page.getByRole("switch", { name: "Push upozornenia na tomto zariadení" });
  await master.click();
  await expect(master).toBeChecked();
  for (const name of ["Úlohy a pripomienky", "Prichádzajúce hovory", "Hovory na prevzatie"]) await expect(page.getByRole("switch", { name })).toBeDisabled();
  await expect(page.getByText(/Výber typov upozornení ešte nie je pripravený/)).toBeVisible();
  await page.getByRole("switch", { name: "Zvuk upozornení" }).click();
  expect(writes[0].body).toEqual({
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/current-device-fixture", keys: { p256dh: "fixture-key", auth: "fixture-auth" } }, soundEnabled: true,
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
