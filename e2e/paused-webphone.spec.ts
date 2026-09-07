import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve("e2e/fixtures/paused-webphone.ts")], bundle: true, write: false, platform: "browser", format: "iife" });
  script = bundle.outputFiles[0].text;
});

test("PA-01/02/10 paused sound sink, precise invite cancellation and refresh preserve explicit pickup", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://pause.test") throw new Error(`Unexpected network ${url.origin}`);
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Paused phone</title>" });
    if (url.pathname.endsWith("/token")) return route.fulfill({ json: { token: "fixture", expiresAt: new Date(Date.now() + 3600000).toISOString(), deviceSessionId: "device", sipUsername: "fixture" } });
    if (url.pathname.endsWith("/heartbeat")) return route.fulfill({ json: { ok: true } });
    if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: "" });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  await page.goto("http://pause.test"); await page.addScriptTag({ content: script });
  const read = () => page.evaluate(() => (window as unknown as { pauseScenario: { read(): { events: string[]; sound: boolean; ready: number; status: string; phone: { status: string; call: { id: string; ringing: boolean } | null; callError?: string } } } }).pauseScenario.read());
  await expect.poll(async () => (await read()).phone.status).toBe("registered");
  await page.evaluate(() => (window as unknown as { pauseScenario: { invite(id: string, fail?: boolean): void } }).pauseScenario.invite("automatic-own", true));
  await expect.poll(async () => (await read()).sound).toBe(true);
  await page.evaluate(() => (window as unknown as { pauseScenario: { pause(): void } }).pauseScenario.pause());
  await expect.poll(async () => (await read()).events).toContain("hangup:automatic-own");
  expect(await read()).toMatchObject({ sound: false, ready: 0, status: "paused", phone: { call: { id: "automatic-own", ringing: false } } });
  expect((await read()).phone.callError).toContain("ešte dokončuje");
  await page.evaluate(() => (window as unknown as { pauseScenario: { restart(): void } }).pauseScenario.restart());
  await expect.poll(async () => (await read()).phone.status).toBe("registered");
  await page.evaluate(() => (window as unknown as { pauseScenario: { invite(id: string): void } }).pauseScenario.invite("late-automatic"));
  await expect.poll(async () => (await read()).events).toContain("hangup:late-automatic");
  expect((await read()).events.filter((event) => event === "sound:start")).toHaveLength(1);
  await page.evaluate(() => {
    const scenario = (window as unknown as { pauseScenario: { pickup(id: string): void; invite(id: string): void } }).pauseScenario;
    scenario.pickup("explicit-pickup"); scenario.invite("explicit-pickup");
  });
  await expect.poll(async () => (await read()).events).toContain("answer:explicit-pickup");
  expect((await read()).events).not.toContain("hangup:explicit-pickup");
  expect((await read()).ready).toBe(0);
});
