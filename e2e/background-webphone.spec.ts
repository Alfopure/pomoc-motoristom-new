import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";

let script: string;
let workerScript: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("e2e/fixtures/background-webphone.ts")],
    bundle: true, write: false, platform: "browser", format: "iife",
  });
  script = result.outputFiles[0].text;
  workerScript = await readFile("public/workplace-heartbeat-worker.js", "utf8");
});

test("real browser worker sends heartbeats while hidden-page timers are suspended", async ({ page }) => {
  test.setTimeout(45_000);
  const heartbeats: Array<{ registrationState: string }> = [];
  const failures: string[] = [];
  let workerLoaded = false;
  page.on("pageerror", (error) => failures.push(error.message));
  // The complete scenario runs on a synthetic origin; no provider or database.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://webphone.test") {
      failures.push(`Unexpected network: ${url.origin}`);
      return route.abort();
    }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Background phone fixture</title>" });
    if (url.pathname === "/workplace-heartbeat-worker.js") {
      workerLoaded = true;
      return route.fulfill({ contentType: "text/javascript", body: workerScript });
    }
    if (url.pathname === "/api/telephony/webphone/token") return route.fulfill({ json: {
      token: "fixture", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceSessionId: "fixture-device", sipUsername: "fixture-sip",
    } });
    if (url.pathname === "/api/telephony/devices/heartbeat") {
      heartbeats.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    failures.push(`Unexpected request: ${url.pathname}`);
    return route.abort();
  });
  await page.goto("http://webphone.test");
  await page.addScriptTag({ content: script });
  await expect.poll(() => page.evaluate(() => window.backgroundPhone.getSnapshot().status)).toBe("registered");
  await expect.poll(() => workerLoaded).toBe(true);
  await expect.poll(() => heartbeats.at(-1)?.registrationState).toBe("registered");

  // Pause only the document's timers; the production worker uses its real clock.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  const hiddenCount = heartbeats.length;
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.windowTimerFired = false;
    window.setTimeout(() => { window.windowTimerFired = true; }, 1);
  });
  await expect.poll(() => heartbeats.length).toBeGreaterThan(hiddenCount);
  const beforePulse = heartbeats.length;
  await expect.poll(() => heartbeats.length, { timeout: 35_000, intervals: [500] }).toBeGreaterThan(beforePulse);
  expect(await page.evaluate(() => window.windowTimerFired)).toBe(false);
  expect(heartbeats.slice(beforePulse).every((heartbeat) => heartbeat.registrationState === "registered")).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => heartbeats.at(-1)?.registrationState).toBe("unregistered");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect.poll(() => heartbeats.at(-1)?.registrationState).toBe("registered");
  await page.evaluate(() => window.backgroundPhone.stop());
  expect(failures).toEqual([]);
});
