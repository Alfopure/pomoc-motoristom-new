import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
let css: string;
const browserFailures = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("e2e/fixtures/hangup-confirmation-hook.ts")], bundle: true, write: false,
    outdir: ".context/hangup-confirmation-fixture", platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@telnyx/webrtc": path.resolve("e2e/fixtures/mobile-calling-sdk.ts"), "@/lib/telephony/realtime-client": path.resolve("e2e/fixtures/mobile-calling-realtime.ts") },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = result.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserFailures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === "https://hangup.test/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
    if (url === "https://hangup.test/workplace-heartbeat-worker.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    errors.push(`Unexpected network: ${url}`);
    return route.abort();
  });
  await page.goto("https://hangup.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
});
test.afterEach(async ({ page }) => { expect(browserFailures.get(page)).toEqual([]); });

async function hangup(page: Page) {
  await page.getByRole("button", { name: "Zavesiť", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).toHaveText("Ukončuje sa…");
}

test("accepted 202 retains the real hook's busy state and browser call until a fresh active read confirms absence", async ({ page }) => {
  await hangup(page);
  await page.evaluate(() => window.hangupHarness.commands[0].resolve(Response.json({ ok: true, terminationPending: true }, { status: 202 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
  await expect(page.locator("#state")).toHaveText("Ukončuje sa…");
  await page.evaluate(() => { window.phoneHarness.begin("hangup"); window.phoneHarness.begin("hold"); });
  expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
  await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.refresh(); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "");
  await expect(page.locator("#state")).toHaveText("");
});

test("an absent pre-click read and local BYE do not confirm the accepted server termination", async ({ page }) => {
  await page.evaluate(() => {
    window.hangupHarness.deferReads = true;
    window.phoneHarness.calls = [];
    window.hangupHarness.refresh();
  });
  await expect.poll(() => page.evaluate(() => window.hangupHarness.reads.length)).toBe(1);
  await hangup(page);
  await page.evaluate(() => {
    window.phoneHarness.callState("hangup");
    window.hangupHarness.commands[0].resolve(Response.json({ ok: true, terminationPending: true }, { status: 202 }));
    window.hangupHarness.reads[0].resolve(Response.json(window.hangupHarness.reads[0].payload));
  });
  await expect.poll(() => page.evaluate(() => window.hangupHarness.reads.length)).toBe(2);
  await expect(page.locator("#state")).toHaveAttribute("data-call", "");
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).toHaveText("Ukončuje sa…");
  await page.evaluate(() => window.hangupHarness.reads[1].resolve(Response.json(window.hangupHarness.reads[1].payload)));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveText("");
});

test("authoritative end clears its own in-flight progress and ignores a late session_busy response", async ({ page }) => {
  await hangup(page);
  await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.refresh(); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveText("");
  await page.evaluate(() => window.hangupHarness.commands[0].resolve(Response.json({ code: "session_busy", error: "Prebieha iná zmena hovoru." }, { status: 503 })));
  await page.clock.runFor(2000);
  await expect(page.locator("#state")).toHaveText("");
  expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
});

test("a failed snapshot cannot complete a 202; retrying reads recover without replaying hangup", async ({ page }) => {
  await page.evaluate(() => { window.hangupHarness.deferReads = true; });
  await hangup(page);
  await page.evaluate(() => window.hangupHarness.commands[0].resolve(Response.json({ ok: true, terminationPending: true }, { status: 202 })));
  await expect.poll(() => page.evaluate(() => window.hangupHarness.reads.length)).toBeGreaterThan(0);
  await page.evaluate(() => window.hangupHarness.reads[0].resolve(Response.json({ error: "Snapshot unavailable" }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
  await expect(page.locator("#state")).toHaveText("Ukončuje sa…");
  await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.deferReads = false; window.hangupHarness.refresh(); });
  // A refresh coalesced behind the failed read can itself already be waiting.
  await page.evaluate(() => { for (const read of window.hangupHarness.reads.slice(1)) read.resolve(Response.json(window.hangupHarness.snapshot())); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveText("");
  expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
});

for (const failure of ["http", "transport"] as const) {
  test(`a real ${failure} error while still active stays visible, refreshes and later clears only after fresh evidence`, async ({ page }) => {
    await hangup(page);
    const before = await page.evaluate(() => window.phoneHarness.activeReads);
    await page.evaluate((kind) => {
      if (kind === "http") window.hangupHarness.commands[0].resolve(Response.json({ error: "Provider unavailable", code: "command_failed" }, { status: 503 }));
      else window.hangupHarness.commands[0].reject(new TypeError("Connection lost"));
    }, failure);
    await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
    await expect(page.locator("#state")).toHaveText(failure === "http" ? "Provider unavailable" : "Connection lost");
    await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
    await expect.poll(() => page.evaluate(() => window.phoneHarness.activeReads)).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
    await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.refresh(); });
    await expect(page.locator("#state")).toHaveText("");
    await expect(page.locator("#state")).toHaveAttribute("data-call", "");
  });
}

test("the old hangup's late 503 cannot erase the next incoming call or its newer operation notice", async ({ page }) => {
  await hangup(page);
  await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.refresh(); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await page.evaluate(() => { window.phoneHarness.callState("ringing", "next-incoming"); window.phoneHarness.begin("hold"); });
  await expect.poll(() => page.evaluate(() => window.hangupHarness.commands.length)).toBe(2);
  await page.evaluate(() => window.hangupHarness.commands[1].resolve(Response.json({ error: "New call operation failed" }, { status: 502 })));
  await expect(page.locator("#state")).toHaveText("New call operation failed");
  await page.evaluate(() => window.hangupHarness.commands[0].resolve(Response.json({ code: "session_busy", error: "Old busy error" }, { status: 503 })));
  await page.clock.runFor(2000);
  await expect(page.locator("#state")).toHaveText("New call operation failed");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(2);
});

test("snapshot confirmation clears only hangup progress while preserving a concurrent new-call notice", async ({ page }) => {
  await hangup(page);
  await page.evaluate(() => {
    window.hangupHarness.commands[0].resolve(Response.json({ ok: true, terminationPending: true }, { status: 202 }));
    window.phoneHarness.callState("hangup");
    window.phoneHarness.callState("ringing", "next-incoming");
    // Dial is refused locally because the new invite is ringing; its notice
    // is independent of the previous session's accepted termination.
    window.phoneHarness.begin("dial");
  });
  const notice = await page.locator("#state").textContent();
  expect(notice).toBeTruthy();
  expect(notice).not.toBe("Ukončuje sa…");
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await page.evaluate(() => { window.phoneHarness.calls = []; window.hangupHarness.refresh(); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveText(notice!);
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  expect(await page.evaluate(() => window.hangupHarness.commands.length)).toBe(1);
});
