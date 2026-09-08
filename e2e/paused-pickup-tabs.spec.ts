import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

let script: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["e2e/fixtures/paused-pickup-tabs.ts"], bundle: true, write: false, platform: "browser", format: "iife" });
  script = result.outputFiles[0].text;
});

type Scenario = { poll(): void; begin(): Promise<string>; finish(id: string): Promise<void>; expected(id: string): void; invite(id: string): void;
  read(): { events: string[]; sound: boolean; phone: { status: string; sharedTab?: boolean; call: { id: string; active: boolean; ringing: boolean } | null } } };
const read = (page: Page) => page.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.read());

async function initialize(page: Page) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://pickup.test") throw new Error(`Unexpected network ${url.origin}`);
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Paused pickup tabs</title>" });
    if (url.pathname.endsWith("/token")) return route.fulfill({ json: { token: "fixture", expiresAt: new Date(Date.now() + 3600000).toISOString(), deviceSessionId: "fixture-device", sipUsername: "fixture" } });
    if (url.pathname.endsWith("/heartbeat")) return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "" });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  await page.goto("https://pickup.test");
  await page.addScriptTag({ content: script });
  await expect.poll(async () => (await read(page)).phone.status).toBe("registered");
}

test("PU-03 owner presence poll cannot reject a follower's exact paused pickup before its API response", async ({ page, context }) => {
  await initialize(page);
  const follower = await context.newPage(); await initialize(follower);
  await expect.poll(async () => (await read(follower)).phone.sharedTab).toBe(true);
  const request = await follower.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.begin());
  await page.evaluate(() => { const scenario = (window as unknown as { pickupTabs: Scenario }).pickupTabs; scenario.poll(); scenario.invite("exact-pickup"); });
  await expect.poll(async () => (await read(page)).phone.call?.id).toBe("exact-pickup");
  expect((await read(page)).events).not.toContain("hangup:exact-pickup");
  expect((await read(page)).events).not.toContain("answer:exact-pickup");
  expect((await read(page)).sound).toBe(false);
  await follower.evaluate(async id => {
    const scenario = (window as unknown as { pickupTabs: Scenario }).pickupTabs;
    scenario.expected("exact-pickup"); await scenario.finish(id);
  }, request);
  await expect.poll(async () => (await read(page)).events).toContain("answer:exact-pickup");
  expect((await read(page)).events).not.toContain("hangup:exact-pickup");
  expect((await read(page)).sound).toBe(false);
});

test("PU-03 failed follower request releases silent invite and later automatic invites stay blocked", async ({ page, context }) => {
  await initialize(page);
  const follower = await context.newPage(); await initialize(follower);
  const request = await follower.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.begin());
  await page.evaluate(() => { const scenario = (window as unknown as { pickupTabs: Scenario }).pickupTabs; scenario.poll(); scenario.invite("unconfirmed"); });
  await expect.poll(async () => (await read(page)).phone.call?.id).toBe("unconfirmed");
  expect((await read(page)).events).not.toContain("hangup:unconfirmed");
  await follower.evaluate(id => (window as unknown as { pickupTabs: Scenario }).pickupTabs.finish(id), request);
  await expect.poll(async () => (await read(page)).events).toContain("hangup:unconfirmed");
  await page.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.invite("late-automatic"));
  await expect.poll(async () => (await read(page)).events).toContain("hangup:late-automatic");
  expect((await read(page)).events.some(event => event.startsWith("answer:") || event === "sound:start")).toBe(false);
});

test("PU-03 a successful response permits only the exact leg and rejects an unrelated held invite", async ({ page, context }) => {
  await initialize(page);
  const follower = await context.newPage(); await initialize(follower);
  const request = await follower.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.begin());
  await page.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.invite("unrelated-offer"));
  await expect.poll(async () => (await read(page)).phone.call?.id).toBe("unrelated-offer");
  await follower.evaluate(async id => {
    const scenario = (window as unknown as { pickupTabs: Scenario }).pickupTabs;
    scenario.expected("confirmed-pickup"); await scenario.finish(id);
  }, request);
  await expect.poll(async () => (await read(page)).events).toContain("hangup:unrelated-offer");
  expect((await read(page)).events).not.toContain("answer:unrelated-offer");
  await page.evaluate(() => (window as unknown as { pickupTabs: Scenario }).pickupTabs.invite("confirmed-pickup"));
  await expect.poll(async () => (await read(page)).events).toContain("answer:confirmed-pickup");
  expect((await read(page)).sound).toBe(false);
});
