import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
const errors = new WeakMap<Page, string[]>();
const tokens = new WeakMap<Page, number>();
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: [path.resolve("e2e/fixtures/mobile-webphone-recovery.ts")], bundle: true,
    write: false, platform: "browser", format: "iife" });
  script = bundle.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  const failures: string[] = [];
  errors.set(page, failures); tokens.set(page, 0);
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://mobile-recovery.test") { failures.push(`Unexpected origin: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated mobile phone</title>" });
    if (url.pathname === "/workplace-heartbeat-worker.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.pathname === "/api/telephony/webphone/token") {
      const count = tokens.get(page)! + 1; tokens.set(page, count);
      return route.fulfill({ json: { token: `fixture-token-${count}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        deviceSessionId: "fixture-mobile-device", sipUsername: "fixture-mobile" } });
    }
    if (url.pathname === "/api/telephony/devices/heartbeat") return route.fulfill({ json: { ok: true } });
    failures.push(`Unexpected request: ${url.pathname}`); return route.abort();
  });
  await page.goto("https://mobile-recovery.test/");
  await page.clock.install();
  await page.addScriptTag({ content: script });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.mobileRecovery.stop());
  expect(errors.get(page)).toEqual([]);
});

test("a second foreground mobile call reuses SIP, then bounded idle expiry retires it", async ({ page }) => {
  expect(tokens.get(page)).toBe(0);
  await page.evaluate(() => window.mobileRecovery.prepare());
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("registered");
  await page.evaluate(() => { window.mobileRecovery.callState("active"); window.mobileRecovery.callState("hangup"); });
  await page.clock.runFor(30_000);
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect"]);
  await page.evaluate(() => window.mobileRecovery.prepare());
  expect(tokens.get(page)).toBe(1);
  await page.evaluate(() => window.mobileRecovery.callState("active", "second-call"));
  await page.clock.runFor(120_000);
  expect(await page.evaluate(() => window.mobileRecovery.events)).not.toContain("sdk:disconnect");
  await page.evaluate(() => window.mobileRecovery.callState("hangup", "second-call"));
  await page.clock.runFor(119_000);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("registered");
  await page.clock.runFor(1_001);
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("idle");
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect", "sdk:disconnect"]);
});

test("hidden idle releases immediately and becoming visible never registers by itself", async ({ page }) => {
  await page.evaluate(() => window.mobileRecovery.prepare());
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("idle");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(150_000);
  expect(tokens.get(page)).toBe(1);
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect", "sdk:disconnect"]);
});

test("hiding a mobile app preserves active media beyond the standby deadline", async ({ page }) => {
  await page.evaluate(() => window.mobileRecovery.prepare());
  await page.evaluate(() => {
    window.mobileRecovery.callState("active");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(150_000);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().call?.id)).toBe("mobile-call");
  expect(await page.evaluate(() => window.mobileRecovery.events)).not.toContain("sdk:disconnect");
  await page.evaluate(() => window.mobileRecovery.callState("hangup"));
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("idle");
});

test("token-expiry warning bursts refresh the existing SDK without interrupting an active call", async ({ page }) => {
  await page.evaluate(() => {
    window.mobileRecovery.holdLogin();
    return window.mobileRecovery.prepare();
  });
  await page.evaluate(() => {
    window.mobileRecovery.callState("active");
    for (let i = 0; i < 6; i++) window.mobileRecovery.emit("telnyx.warning", { warning: { code: 34001 }, sessionId: "mobile-session" });
  });
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.loginTokens)).toEqual(["fixture-token-2"]);
  expect(tokens.get(page)).toBe(2);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot())).toMatchObject({
    status: "registered", call: { id: "mobile-call", active: true, ringing: false },
  });
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect"]);
  await page.evaluate(() => window.mobileRecovery.finishLogin());
  await page.clock.runFor(61_000);
  await page.evaluate(() => window.mobileRecovery.emit("telnyx.warning", { warning: { code: 34001 } }));
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.loginTokens)).toEqual(["fixture-token-2", "fixture-token-3"]);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().call?.id)).toBe("mobile-call");
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect"]);
});

test("a hidden mobile call survives socket reconnect and same-ID SDK attach replacement", async ({ page }) => {
  await page.evaluate(() => window.mobileRecovery.prepare());
  await page.evaluate(() => {
    window.mobileRecovery.callState("active");
    window.mobileRecovery.callState("recovering");
    window.mobileRecovery.emit("telnyx.socket.close");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(20_000);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot())).toMatchObject({
    status: "reconnecting", call: { id: "mobile-call", ringing: false },
  });
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect"]);
  await page.evaluate(() => {
    window.mobileRecovery.emit("telnyx.socket.open");
    window.mobileRecovery.emit("telnyx.ready");
    window.mobileRecovery.recoverCall();
    window.mobileRecovery.lateRetiredHangup();
  });
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("registered");
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().call)).toMatchObject({ id: "mobile-call", state: "active", active: true, ringing: false });
  expect(tokens.get(page)).toBe(1);
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect"]);
  await page.clock.runFor(90_000);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().call?.id)).toBe("mobile-call");
});

test("an unrecoverable socket has a bounded failure deadline and late ready cannot resurrect it", async ({ page }) => {
  await page.evaluate(() => window.mobileRecovery.prepare());
  await page.evaluate(() => {
    window.mobileRecovery.callState("active");
    window.mobileRecovery.emit("telnyx.socket.close");
  });
  await page.clock.runFor(59_000);
  expect(await page.evaluate(() => window.mobileRecovery.snapshot())).toMatchObject({ status: "reconnecting", call: { id: "mobile-call" } });
  expect(await page.evaluate(() => window.mobileRecovery.events)).not.toContain("sdk:disconnect");
  await page.clock.runFor(1_001);
  await expect.poll(() => page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("failed");
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().call)).toBeNull();
  await page.evaluate(() => window.mobileRecovery.emit("telnyx.ready"));
  expect(await page.evaluate(() => window.mobileRecovery.snapshot().status)).toBe("failed");
  expect(await page.evaluate(() => window.mobileRecovery.events)).toEqual(["sdk:create", "sdk:connect", "sdk:disconnect"]);
  expect(tokens.get(page)).toBe(1);
});
