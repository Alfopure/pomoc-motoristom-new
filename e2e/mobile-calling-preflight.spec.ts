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

test("answer starts the SDK in the click gesture, acquires microphone once and ignores repeated taps", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prijímam…", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.phoneHarness.answer(); window.phoneHarness.answer(); });
  expect(await page.evaluate(() => [window.phoneHarness.microphoneRequests, window.phoneHarness.sdkAnswers])).toEqual([1, 1]);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(1);
});

test("denied answer permission restores its answer button without losing the registered phone", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await page.evaluate(() => window.phoneHarness.deny());
  await expect(page.getByRole("button", { name: "Prijať", exact: true })).toBeEnabled();
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
  expect(await page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(1);
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
  expect(await page.evaluate(() => window.phoneHarness.sdkAnswers)).toBe(1);
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

test("failed server and SDK hangup keep the active browser call available", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.hangupFailure = true; window.phoneHarness.connected(); });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Ukončenie hovoru zlyhalo." }, { status: 502 })));
  await expect(page.locator("#state")).toHaveText("Ukončenie hovoru zlyhalo.");
  await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(1);
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
    const context = new AudioContext();
    window.phoneHarness.audioContext = context;
    window.phoneHarness.localStream = context.createMediaStreamDestination().stream;
    window.phoneHarness.remoteStream = window.phoneHarness.localStream.clone();
    window.phoneHarness.callState("ringing", "next-incoming");
  });
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "not_active" }, { status: 409 })));
  await expect(page.locator("#state")).toHaveAttribute("data-call", "next-incoming");
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(1);
  expect(await page.evaluate(() => [window.phoneHarness.localStream!.getAudioTracks()[0].readyState,
    window.phoneHarness.remoteStream!.getAudioTracks()[0].readyState])).toEqual(["live", "live"]);
  await page.evaluate(async () => {
    window.phoneHarness.localStream!.getTracks().forEach((track) => track.stop());
    window.phoneHarness.remoteStream!.getTracks().forEach((track) => track.stop());
    await window.phoneHarness.audioContext!.close();
  });
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

test("ending an owned call sends BYE immediately while server confirmation remains pending", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.hangupEndsMedia = true; window.phoneHarness.connected(); });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.getByRole("button", { name: "Zavesiť", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(1);
  await expect(page.locator("#state")).toHaveAttribute("data-call", "");
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hangup"]);
  await page.evaluate(() => {
    window.phoneHarness.calls = [];
    window.phoneHarness.requests[0].resolve(Response.json({ ok: true }));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "");
});

for (const action of ["hold", "supervise"] as const) {
  test(`hangup preempts pending ${action} and its stale result cannot clear termination progress`, async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate((kind) => { window.phoneHarness.begin(kind); window.phoneHarness.begin(kind); }, action);
  await expect(page.locator("#state")).not.toHaveAttribute("data-busy", "");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual([`/api/telephony/calls/fixture/${action}`]);
  await page.getByRole("button", { name: "Zavesiť", exact: true }).click();
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual([`/api/telephony/calls/fixture/${action}`, "/api/telephony/calls/fixture/hangup"]);
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(1);
  await page.evaluate(() => {
    window.phoneHarness.begin("hangup");
    window.phoneHarness.requests[0].resolve(Response.json({ error: "Obsolete hold failure" }, { status: 502 }));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  await expect(page.locator("#state")).not.toContainText("Obsolete");
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  await page.evaluate(() => { window.phoneHarness.calls = []; window.phoneHarness.requests[1].resolve(Response.json({ ok: true })); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
});

}

test("hangup cancels a pickup still waiting for microphone before it can place an operator leg", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.begin("pickup"));
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
  await page.evaluate(() => { window.phoneHarness.begin("hangup"); window.phoneHarness.grant(); });
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hangup"]);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ ok: true })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
});

test("a server action never sends immediate BYE for a different operator leg", async ({ page }) => {
  await page.evaluate(() => {
    window.phoneHarness.connected(false);
    window.phoneHarness.calls[0].legs[0].profileId = "other-operator";
    window.phoneHarness.callState("active");
  });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hangup"));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.phoneHarness.sdkHangups)).toBe(0);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Forbidden" }, { status: 403 })));
  await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
});

test("terminal SDK state releases real browser audio tracks before either signalling acknowledgement", async ({ page }) => {
  await page.evaluate(() => {
    const context = new AudioContext();
    window.phoneHarness.audioContext = context;
    window.phoneHarness.localStream = context.createMediaStreamDestination().stream;
    window.phoneHarness.remoteStream = window.phoneHarness.localStream.clone();
    window.phoneHarness.hangupEndsMedia = true;
    window.phoneHarness.holdHangup = true;
    window.phoneHarness.connected();
  });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  expect(await page.evaluate(() => [window.phoneHarness.localStream!.getAudioTracks()[0].readyState,
    window.phoneHarness.remoteStream!.getAudioTracks()[0].readyState])).toEqual(["live", "live"]);
  await page.getByRole("button", { name: "Zavesiť", exact: true }).click();
  expect(await page.evaluate(() => [window.phoneHarness.localStream!.getAudioTracks()[0].readyState,
    window.phoneHarness.remoteStream!.getAudioTracks()[0].readyState])).toEqual(["ended", "ended"]);
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hangup"]);
  await page.evaluate(async () => {
    window.phoneHarness.finishHangup();
    window.phoneHarness.calls = [];
    window.phoneHarness.requests[0].resolve(Response.json({ ok: true }));
    await window.phoneHarness.audioContext!.close();
  });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
});

for (const responseKind of ["session_busy", "transient_failure"] as const) {
  test(`failed exact-leg verification recovers with bounded backoff after ${responseKind}`, async ({ page }) => {
    await page.clock.install();
    await page.evaluate(() => { window.phoneHarness.connected(false); document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
    await page.evaluate((kind) => window.phoneHarness.requests[0].resolve(kind === "session_busy"
      ? Response.json({ reconciled: false, reason: "session_busy", retryAfterMs: 1000 })
      : Response.json({ error: "Dočasná chyba overenia", code: "session_event_deferred" }, { status: 503 })), responseKind);
    await expect(page.locator("#state")).toContainText("Overenie zopakujeme automaticky");
    await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
    await page.getByRole("button", { name: "Stav skončeného hovoru ešte nie je potvrdený. Overenie zopakujeme automaticky.", exact: true }).click();
    await expect(page.locator("#state")).toHaveText("");
    await page.clock.runFor(999);
    await page.evaluate(() => window.phoneHarness.realtimeChange());
    expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
    await page.clock.runFor(1);
    await page.evaluate(() => window.phoneHarness.realtimeChange());
    await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
    expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
      .toEqual(["/api/telephony/calls/fixture/reconcile", "/api/telephony/calls/fixture/reconcile"]);
    await page.evaluate(() => { window.phoneHarness.calls = []; window.phoneHarness.requests[1].resolve(Response.json({ reconciled: true })); });
    await expect(page.locator("#state")).toHaveAttribute("data-server-call", "");
    await expect(page.locator("#state")).toHaveText("");
  });
}

test("repeated foreground hints never overlap exact-leg reconciliation requests", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.connected(false); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => { for (let index = 0; index < 20; index++) document.dispatchEvent(new Event("visibilitychange")); });
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ reconciled: false, reason: "alive" })));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({ reconciled: false, reason: "alive" })));
  await page.evaluate(() => window.phoneHarness.realtimeChange());
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
});

test("a pending own-session control takes priority over missing-media reconciliation", async ({ page }) => {
  await page.evaluate(() => {
    window.phoneHarness.begin("hold");
    window.phoneHarness.connected(false);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold"]);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ ok: true })));
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  expect(await page.evaluate(() => window.phoneHarness.requests[1].url)).toBe("/api/telephony/calls/fixture/reconcile");
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({ reconciled: false, reason: "alive" })));
});

test("repeated session contention retains the failed action and registered status after one bounded retry", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({
    error: "Prebieha iná zmena hovoru. Akcia nebola prijatá.", code: "session_busy", retryAfterMs: 1000,
  }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({
    error: "Prebieha iná zmena hovoru. Akcia nebola prijatá.", code: "session_busy", retryAfterMs: 1000,
  }, { status: 503 })));
  await expect(page.locator("#state")).toContainText("Akcia nebola prijatá");
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
  const status = page.getByTestId("phone-registration");
  await expect(status).toContainText("Registrované");
  await expect(status).toContainText("Upozornenie k akcii");
  await expect(status).not.toContainText("Chyba telefónie");
  await status.click();
  await expect(page.getByRole("dialog", { name: "Stav telefónu a dostupnosť" }).getByRole("alert"))
    .toContainText("Akcia nebola prijatá");
  await page.clock.runFor(10_000);
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold", "/api/telephony/calls/fixture/hold"]);
});

test("an actual SDK microphone failure is identified as a call error while registration stays connected", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.incoming());
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  await page.evaluate(() => window.phoneHarness.deny());
  await expect(page.getByTestId("phone-registration")).toContainText("Registrované");
  await expect(page.getByTestId("phone-registration")).toContainText("Chyba hovoru");
  await page.getByTestId("phone-registration").click();
  await expect(page.getByRole("dialog", { name: "Stav telefónu a dostupnosť" }).getByRole("alert"))
    .toContainText("Mikrofón je zablokovaný");
});


test("a proven not-started control retries once with the same payload and stays pending until acceptance", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "session_busy", retryAfterMs: 1000 }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.clock.runFor(999);
  expect(await page.evaluate(() => window.phoneHarness.requests.length)).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => page.evaluate(() => window.phoneHarness.requests.length)).toBe(2);
  expect(await page.evaluate(() => window.phoneHarness.requests.map(({ url, body }) => ({ url, body }))))
    .toEqual([{ url: "/api/telephony/calls/fixture/hold", body: "{}" }, { url: "/api/telephony/calls/fixture/hold", body: "{}" }]);
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({ ok: true })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).toHaveText("");
});

test("hangup preempts a waiting safe hold retry without sending another hold", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "session_busy", retryAfterMs: 1000 }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.getByRole("button", { name: "Zavesiť", exact: true }).click();
  await page.clock.runFor(1500);
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hangup");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold", "/api/telephony/calls/fixture/hangup"]);
  await page.evaluate(() => { window.phoneHarness.calls = []; window.phoneHarness.requests[1].resolve(Response.json({ ok: true })); });
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
});

test("a replacement browser call cancels the previous call's waiting retry", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "session_busy", retryAfterMs: 1000 }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.evaluate(() => { window.phoneHarness.callState("hangup"); window.phoneHarness.callState("ringing", "new-incoming"); });
  await page.clock.runFor(1500);
  await expect(page.locator("#state")).toHaveAttribute("data-call", "new-incoming");
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold"]);
});


test("closing the console cancels an otherwise safe waiting control retry", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ code: "session_busy", retryAfterMs: 1000 }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "hold");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
    window.phoneHarness.unmount();
  });
  await page.clock.runFor(1500);
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold"]);
});


test("a late first generic control failure cannot label a replacement call as failed", async ({ page }) => {
  await page.evaluate(() => window.phoneHarness.connected());
  await expect(page.locator("#state")).toHaveAttribute("data-server-call", "fixture");
  await page.evaluate(() => window.phoneHarness.begin("hold"));
  await page.evaluate(() => {
    window.phoneHarness.callState("hangup");
    window.phoneHarness.callState("ringing", "replacement-after-first-post");
    window.phoneHarness.requests[0].resolve(Response.json({ error: "Old session failure", code: "session_event_deferred" }, { status: 503 }));
  });
  await expect(page.locator("#state")).toHaveAttribute("data-call", "replacement-after-first-post");
  await expect(page.locator("#state")).toHaveAttribute("data-busy", "");
  await expect(page.locator("#state")).not.toContainText("Old session failure");
  await expect(page.getByTestId("phone-registration")).not.toContainText("Upozornenie k akcii");
  expect(await page.evaluate(() => window.phoneHarness.requests.map((request) => request.url)))
    .toEqual(["/api/telephony/calls/fixture/hold"]);
});
