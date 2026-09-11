import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
const browserFailures = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("e2e/fixtures/mobile-calling-hook.tsx")], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@telnyx/webrtc": path.resolve("e2e/fixtures/mobile-calling-sdk.ts"), "@/lib/telephony/realtime-client": path.resolve("e2e/fixtures/mobile-calling-realtime.ts") },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  // No app login, real microphone, provider socket or API write is permitted.
  const failures: string[] = [];
  browserFailures.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/*", (route) => {
    if (route.request().url() === "https://preflight.test/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
    if (route.request().url() === "https://preflight.test/workplace-heartbeat-worker.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    failures.push(`Unexpected network: ${route.request().url()}`); return route.abort();
  });
  // Match the deployed secure context (UUIDs/Web Locks) while intercepting all
  // requests. about:blank omits these browser APIs and hides coordinator paths.
  await page.goto("https://preflight.test/");
  await page.addScriptTag({ content: script });
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
});

test.afterEach(async ({ page }) => {
  expect(browserFailures.get(page)).toEqual([]);
});

test("refused microphone prevents the call and keeps registration", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
  await page.evaluate(() => window.phoneHarness.deny());
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
  await expect(page.locator("#state")).toContainText("zablokovaný");
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(0);
});

test("browser media transitions refresh customer state immediately without waiting for a poll", async ({ page }) => {
  for (const state of ["ringing", "active", "hangup"] as const) {
    const [before, after] = await page.evaluate((next) => {
      const before = window.phoneHarness.activeReads;
      window.phoneHarness.callState(next);
      return [before, window.phoneHarness.activeReads];
    }, state);
    expect(after).toBeGreaterThan(before);
    // Let the snapshot settle before emitting the next independent transition.
    await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(0);
});

test("rapid dial and callback taps create just one request; failure unlocks retry", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.begin("dial"); window.phoneHarness.begin("callback"); });
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.stoppedTracks)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Fixture failure" }, { status: 500 })));
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await page.evaluate(() => window.phoneHarness.begin("callback"));
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(2);
});

test("accepted dial stays guarded until its browser invite arrives", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ sessionId: "fixture-session", operatorLegCallControlId: "fixture-leg" })));
  await expect(page.locator("#state")).toHaveAttribute("data-legs", "1");
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "true");
  await page.evaluate(() => window.phoneHarness.begin("callback"));
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
});

test("incoming call during permission takes priority without an outbound POST", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.begin("dial"); window.phoneHarness.incoming(); window.phoneHarness.grant(); });
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await expect(page.locator("#state")).toHaveAttribute("data-ringing", "true");
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(0);
});

test("explicit microphone check releases capture and never places a call", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.prepare());
  await page.evaluate(() => window.phoneHarness.grant());
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "ready");
  expect(await page.evaluate(() => window.phoneHarness.stoppedTracks)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(0);
});

for (const kind of ["pickup", "supervise"] as const) {
  test(`${kind} shares microphone and duplicate-call protection with dialing`, async ({ page }) => {
    await page.evaluate((action) => { window.phoneHarness.begin(action); window.phoneHarness.begin("dial"); }, kind);
    expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
    await page.evaluate(() => window.phoneHarness.grant());
    await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
    expect(await page.evaluate(() => window.phoneHarness.requests[0].url)).toContain(`/${kind}`);
  });
}

for (const code of ["call_gone", "not_active"]) {
  test(`a ${code} hangup does not leave a false telephony error on the next incoming call`, async ({ page }) => {
    await page.evaluate(() => window.phoneHarness.begin("hangup"));
    await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
    await page.evaluate((errorCode) => window.phoneHarness.requests[0].resolve(Response.json({ error: "Hovor už medzitým skončil.", code: errorCode }, { status: 409 })), code);
    await page.evaluate(() => window.phoneHarness.incoming());
    await expect(page.locator("#state")).toHaveAttribute("data-ringing", "true");
    await expect(page.locator("#state")).toHaveText("");
  });
}

test("a real call-control failure remains visible", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Ukončenie hovoru zlyhalo.", code: "command_failed" }, { status: 502 })));
  await expect(page.locator("#state")).toHaveText("Ukončenie hovoru zlyhalo.");
});


test("temporary hold 503 preserves configuration, server reason, polling and hangup", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  const before = await page.evaluate(() => window.phoneHarness.activeReads);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Prebieha zmena nahrávania. Zopakujte akciu o chvíľu.", code: "rejected" }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-configured", "true");
  await expect(page.locator("#state")).toContainText("Prebieha zmena nahrávania");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.activeReads)).toBeGreaterThan(before);
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  expect(await page.evaluate(() => window.phoneHarness.requests[1].url)).toContain("/hangup");
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({ ok: true })));
});
