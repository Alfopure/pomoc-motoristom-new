import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let script: string;
let fixtureCss: string;
const browserFailures = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("e2e/fixtures/mobile-calling-hook.tsx")], bundle: true, write: false,
    outdir: ".context/mobile-calling-preflight-fixture",
    platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@telnyx/webrtc": path.resolve("e2e/fixtures/mobile-calling-sdk.ts"), "@/lib/telephony/realtime-client": path.resolve("e2e/fixtures/mobile-calling-realtime.ts") },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  fixtureCss = result.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
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
  await page.addStyleTag({ content: fixtureCss });
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

test("answer shows immediate progress during microphone permission and ignores repeated taps", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prijímam…", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.phoneHarness.answer(); window.phoneHarness.answer(); });
  expect(await page.evaluate(() => [window.phoneHarness.microphoneRequests, window.phoneHarness.sdkAnswers])).toEqual([1, 0]);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(1);
});

test("denied answer permission restores its answer button without losing the registered phone", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await page.evaluate(() => window.phoneHarness.deny());
  await expect(page.getByRole("button", { name: "Prijať", exact: true })).toBeEnabled();
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
  expect(await page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(0);
});

test("a replacement invite never inherits the old answer intent while permission is pending", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await page.evaluate(() => {
    window.phoneHarness.callState("hangup");
    window.phoneHarness.callState("ringing", "replacement-incoming");
  });
  await expect(page.getByRole("button", { name: "Prijať", exact: true })).toBeEnabled();
  await page.evaluate(() => window.phoneHarness.grant());
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "ready");
  expect(await page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(0);
  await expect(page.locator("#state")).toHaveAttribute("data-call", "replacement-incoming");
});

for (const hidden of [false, true]) {
  test(`realtime loss cancels the ${hidden ? "hidden" : "visible"} healthy idle timer and immediately restores fallback polling`, async ({ page }) => {
    await page.clock.install();
    await page.evaluate((isHidden) => Object.defineProperty(document, "visibilityState", { configurable: true, value: isHidden ? "hidden" : "visible" }), hidden);
    const fallbackTick = hidden ? 15_100 : 2_100;
    await page.evaluate(() => window.phoneHarness.realtimeStatus("connected"));
    await page.clock.runFor(0);
    const healthy = await page.evaluate(() => window.phoneHarness.activeReads);
    await page.clock.runFor(fallbackTick);
    expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(healthy);
    await page.evaluate(() => window.phoneHarness.realtimeStatus("disconnected"));
    await page.clock.runFor(0);
    const disconnected = await page.evaluate(() => window.phoneHarness.activeReads);
    expect(disconnected).toBe(healthy + 1);
    await page.clock.runFor(fallbackTick);
    expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(disconnected + 1);
    await page.evaluate(() => window.phoneHarness.realtimeStatus("connected"));
    await page.clock.runFor(0);
    const reconnected = await page.evaluate(() => window.phoneHarness.activeReads);
    expect(reconnected).toBe(disconnected + 2);
    await page.clock.runFor(fallbackTick);
    expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(reconnected);
  });
}

test("realtime changes during a snapshot queue one fresh read and leave only one fallback timer", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.realtimeStatus("connected"));
  await page.clock.runFor(0);
  const before = await page.evaluate(() => window.phoneHarness.activeReads);
  await page.evaluate(() => {
    window.phoneHarness.deferActiveReads = true;
    window.phoneHarness.realtimeChange();
    window.phoneHarness.realtimeStatus("disconnected");
    window.phoneHarness.realtimeChange();
  });
  expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(before + 1);
  await page.evaluate(() => {
    window.phoneHarness.deferActiveReads = false;
    window.phoneHarness.resolveActiveRead();
  });
  await page.clock.runFor(0);
  expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(before + 2);
  await page.clock.runFor(2_100);
  expect(await page.evaluate(() => window.phoneHarness.activeReads)).toBe(before + 3);
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

test("rapid dial and callback taps create one request; uncertain failure only allows the same operation", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.begin("dial"); window.phoneHarness.begin("callback"); });
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.stoppedTracks)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Fixture failure" }, { status: 500 })));
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await page.evaluate(() => window.phoneHarness.begin("callback"));
  await expect(page.locator("#state")).toContainText("predchádzajúceho volania");
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.requests[1].body)).toBe(await page.evaluate(() => window.phoneHarness.requests[0].body));
});

test("a definitive 422 refusal clears the operation so a different callback can start", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Invalid destination" }, { status: 422 })));
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await page.evaluate(() => window.phoneHarness.begin("callback"));
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(2);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  const requests = await page.evaluate(() => window.phoneHarness.requests.map((request) => ({ url: request.url, body: JSON.parse(request.body!) })));
  expect(requests[1].url).toBe("/api/telephony/callbacks/fixture/call");
  expect(requests[1].body.requestId).not.toBe(requests[0].body.requestId);
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

for (const outcome of ["success", "call_gone", "not_active"] as const) {
  test(`${outcome} hangup unlocks the matched browser call without an SDK hangup notification`, async ({ page }) => {
    await page.evaluate(() => window.phoneHarness.connected());
    await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
    await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
    await page.evaluate(() => window.phoneHarness.begin("hangup"));
    await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
    await page.evaluate((result) => {
      window.phoneHarness.calls = [];
      window.phoneHarness.requests[0].resolve(result === "success"
        ? Response.json({ ok: true })
        : Response.json({ code: result, error: "Hovor už skončil." }, { status: 409 }));
    }, outcome);
    await expect(page.locator("#state")).toHaveAttribute("data-call", "");
    await expect(page.locator("#state")).toHaveAttribute("data-server-call", "");
    await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
    expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(1);
  });
}

test("a failed hangup keeps the active browser call available", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Ukončenie hovoru zlyhalo." }, { status: 502 })));
  await expect(page.locator("#state")).toHaveText("Ukončenie hovoru zlyhalo.");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(0);
});

test("browser hangup verifies the exact server leg immediately when its webhook is missing", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.callState("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => ({ url: window.phoneHarness.requests[0].url, body: window.phoneHarness.requests[0].body })))
    .toEqual({ url: "/api/telephony/calls/fixture/reconcile", body: JSON.stringify({ callControlId: "incoming-leg" }) });
  await page.evaluate(() => {
    window.phoneHarness.calls = [];
    window.phoneHarness.requests[0].resolve(Response.json({ reconciled: true }));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "");
});

test("a late hangup response cannot clear the next incoming call", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => {
    window.phoneHarness.callState("hangup");
    window.phoneHarness.callState("ringing", "next-incoming");
  });
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "not_active" }, { status: 409 })));
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(0);
});

test("reopening the app verifies a stuck server call once without a previous browser call", async ({ page }) => {
  await page.evaluate(() => {
    window.phoneHarness.connected(false);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.requests[0].url)).toBe("/api/telephony/calls/fixture/reconcile");
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ reconciled: false, reason: "alive" })));
  const reads = await page.evaluate(() => window.phoneHarness.activeReads);
  await expect.poll(() => page.evaluate(() => window.phoneHarness.activeReads)).toBeGreaterThan(reads);
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  // A later foreground check may now confirm that the same leg really ended.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  await page.evaluate(() => {
    window.phoneHarness.calls = [];
    window.phoneHarness.requests[1].resolve(Response.json({ reconciled: true }));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "");
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
