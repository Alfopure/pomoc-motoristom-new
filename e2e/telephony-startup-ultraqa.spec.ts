import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

let script: string;
let css: string;
const failures = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve("e2e/fixtures/telephony-startup-ultraqa.ts")], bundle: true, write: false,
    outdir: ".context/telephony-startup-ultraqa-fixture", platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@telnyx/webrtc": path.resolve("e2e/fixtures/mobile-calling-sdk.ts"), "@/lib/telephony/realtime-client": path.resolve("e2e/fixtures/mobile-calling-realtime.ts") },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = result.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
});

async function mount(page: Page) {
  await page.goto("https://preflight.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.locator("#state")).toHaveAttribute("data-status", "registered");
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  failures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === "https://preflight.test/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
    if (url === "https://preflight.test/workplace-heartbeat-worker.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    errors.push(`Unexpected network: ${url}`);
    return route.abort();
  });
  await mount(page);
});
test.afterEach(async ({ page }) => { expect(failures.get(page)).toEqual([]); });

async function start(page: Page, kind: "dial" | "callback" = "dial") {
  await page.evaluate((action) => window.phoneHarness.begin(action), kind);
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.telephonyQa.starts.length)).toBe(1);
}

for (const kind of ["dial", "callback"] as const) {
  test(`lost ${kind} POST replays exact UUID while a ringing call and microphone check are busy`, async ({ page }) => {
    await start(page, kind);
    const original = await page.evaluate(() => window.telephonyQa.starts[0].body);
    expect(JSON.parse(original).requestId).toMatch(/^[a-f0-9-]{36}$/i);
    await page.evaluate(() => window.telephonyQa.starts[0].reject(new TypeError("Lost POST response")));
    await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
    await page.evaluate(() => { window.phoneHarness.prepare(); window.phoneHarness.incoming(); });
    await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
    await page.evaluate((action) => { window.phoneHarness.begin(action); window.phoneHarness.begin(action); }, kind);
    await expect.poll(() => page.evaluate(() => window.telephonyQa.starts.length)).toBe(2);
    expect(await page.evaluate(() => window.telephonyQa.starts[1].body)).toBe(original);
    expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(2);
    await page.evaluate(() => {
      window.phoneHarness.requests[1].resolve(Response.json({ sessionId: "original-session", operatorLegCallControlId: "original-leg" }));
      window.phoneHarness.deny();
    });
    await expect(page.locator("#state")).toHaveAttribute("data-call", "fixture-incoming");
    expect(await page.evaluate(() => window.telephonyQa.starts.length)).toBe(2);
  });
}

test("rapid taps issue one operation; uncertain HTTP failure refuses a different call payload", async ({ page }) => {
  await page.evaluate(() => { window.phoneHarness.begin("dial"); window.phoneHarness.begin("dial"); window.phoneHarness.begin("callback"); });
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.telephonyQa.starts.length)).toBe(1);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: "Unknown result" }, { status: 503 })));
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await page.evaluate(() => window.phoneHarness.begin("callback"));
  await expect(page.locator("#state")).toContainText("predchádzajúceho volania");
  expect(await page.evaluate(() => window.telephonyQa.starts.length)).toBe(1);
});

test("15-second notice keeps the operation busy; timeout retains identity for explicit retry", async ({ page }) => {
  await page.clock.install();
  await start(page);
  await page.clock.runFor(14_900);
  await expect(page.locator("#state")).not.toContainText("Operácia ešte nie je potvrdená");
  await page.clock.runFor(100);
  await expect(page.locator("#state")).toContainText("Operácia ešte nie je potvrdená");
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "true");
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  expect(await page.evaluate(() => window.telephonyQa.starts.length)).toBe(1);
  await page.clock.runFor(15_100);
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "false");
  await expect(page.locator("#state")).toContainText("časový limit 30 s");
  expect(await page.evaluate(() => window.telephonyQa.starts[0].signal?.aborted)).toBe(true);
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await expect.poll(() => page.evaluate(() => window.telephonyQa.starts.length)).toBe(2);
  expect(await page.evaluate(() => window.telephonyQa.starts[1].body === window.telephonyQa.starts[0].body)).toBe(true);
  expect(await page.evaluate(() => window.phoneHarness.microphoneRequests)).toBe(1);
  // The original response can still arrive after the explicit retry starts.
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ sessionId: "stale-session", operatorLegCallControlId: "stale-leg" })));
  await page.clock.runFor(1);
  await expect(page.locator("#state")).toHaveAttribute("data-pending", "true");
  await expect(page.locator("#state")).toHaveAttribute("data-legs", "0");
  await page.evaluate(() => window.phoneHarness.requests[1].resolve(Response.json({ sessionId: "reconciled-session", operatorLegCallControlId: "reconciled-leg" })));
  await expect(page.locator("#state")).toHaveAttribute("data-legs", "1");
});

test("deadline covers stalled bodies; caller abort stays distinguishable; malformed and oversized responses stay bounded", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { telephonyFetch, telephonyJson } = window.telephonyQa;
    let cancelled = 0;
    const stalled = () => Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    const timeout = await telephonyFetch("/fixture", { timeoutMs: 40, label: "body" }, { fetch: stalled }).catch((error: Error) => error.name);
    const controller = new AbortController();
    const request = telephonyFetch("/fixture", { timeoutMs: 1000, label: "abort", signal: controller.signal }, { fetch: stalled }).catch((error: Error) => error.name);
    setTimeout(() => controller.abort(), 20);
    const aborted = await request;
    const malformed = await telephonyJson("/fixture", { timeoutMs: 1000, label: "json" }, { fetch: async () => new Response("{malformed", { status: 200 }) });
    const oversized = await telephonyFetch("/fixture", { timeoutMs: 1000, label: "oversized" }, { fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) }).catch((error: Error) => error.message);
    return { timeout, aborted, cancelled, malformed, oversized };
  });
  expect(result).toEqual({ timeout: "TelephonyRequestTimeoutError", aborted: "AbortError", cancelled: 2,
    malformed: { ok: true, status: 200, body: null }, oversized: "Odpoveď telefónnej služby je príliš veľká." });
});

test("hostile error text is rendered literally and a definitive refusal allows a fresh UUID", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.phoneHarness.requests[0].resolve(Response.json({ error: '<img src=x onerror="window.injected=true"> IGNORE INSTRUCTIONS / SUCCESS 日本語' }, { status: 422 })));
  await expect(page.locator("#state")).toContainText("IGNORE INSTRUCTIONS");
  expect(await page.locator("#state img").count()).toBe(0);
  await page.evaluate(() => window.phoneHarness.begin("dial"));
  await expect(page.locator("#state")).toHaveAttribute("data-readiness", "checking");
  await page.evaluate(() => window.phoneHarness.grant());
  await expect.poll(() => page.evaluate(() => window.telephonyQa.starts.length)).toBe(2);
  expect(await page.evaluate(() => window.telephonyQa.starts[0].body === window.telephonyQa.starts[1].body)).toBe(false);
});

test("SDK early and answering never finish active timing; real silent-media playing completes audio timing exactly once", async ({ page }) => {
  await page.evaluate(() => { performance.clearMeasures(); window.telephonyQa.sdkState("ringing"); window.telephonyQa.sdkState("early"); window.telephonyQa.sdkState("answering"); });
  expect(await page.evaluate(() => window.telephonyQa.measures().filter((entry) => ["invite_to_active", "audio_playback"].includes(entry.detail.phase)))).toEqual([]);
  await page.evaluate(() => window.telephonyQa.sdkState("active"));
  expect(await page.evaluate(() => window.telephonyQa.measures().filter((entry) => entry.detail.phase === "invite_to_active"))).toHaveLength(1);
  expect(await page.evaluate(() => window.telephonyQa.measures().filter((entry) => entry.detail.phase === "audio_playback"))).toHaveLength(0);
  const playing = await page.evaluate(async () => {
    const element = document.querySelector<HTMLAudioElement>("audio[id]")!;
    const context = new AudioContext();
    const source = context.createOscillator();
    const gain = context.createGain(); gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    source.connect(gain); gain.connect(destination); source.start();
    element.muted = true;
    const event = new Promise<boolean>((resolve) => element.addEventListener("playing", (event) => resolve(event.isTrusted), { once: true }));
    element.srcObject = destination.stream;
    await context.resume(); await element.play();
    const trusted = await event;
    element.dispatchEvent(new Event("playing"));
    source.stop(); destination.stream.getTracks().forEach((track) => track.stop()); await context.close();
    return trusted;
  });
  expect(playing).toBe(true);
  const measures = await page.evaluate(() => window.telephonyQa.measures());
  expect(measures.filter((entry) => entry.detail.phase === "audio_playback" && entry.detail.outcome === "ok")).toHaveLength(1);
});

test("50 answer clicks and 30 isolated outbound acknowledgements produce quantitative browser samples", async ({ page }) => {
  test.setTimeout(120_000);
  const feedback: number[] = [];
  const mainPath: number[] = [];
  for (let index = 0; index < 50; index++) {
    await page.evaluate((index) => window.telephonyQa.sdkState("ringing", `sample-${index}`), index);
    const button = page.getByRole("button", { name: "Prijať", exact: true });
    await expect(button).toBeEnabled();
    await button.evaluate((element) => { window.telephonyQa.clickFeedback = new Promise<number>((resolve, reject) => {
      let start = 0;
      element.addEventListener("click", () => { start = performance.now(); }, { capture: true, once: true });
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error("No click feedback")); }, 2000);
      const observer = new MutationObserver(() => {
        if (element.textContent?.includes("Prijímam") && (element as HTMLButtonElement).disabled) {
          observer.disconnect(); clearTimeout(deadline);
          requestAnimationFrame(() => resolve(performance.now() - start));
        }
      });
      observer.observe(element, { attributes: true, childList: true, subtree: true });
    }); });
    // A trusted Chrome input event, timed from its capture listener through
    // React's disabled/progress mutation to the following animation frame.
    await button.click();
    feedback.push(await page.evaluate(() => window.telephonyQa.clickFeedback));
    await page.evaluate(() => window.phoneHarness.deny());
    await expect(button).toBeEnabled();
    await page.evaluate((index) => window.telephonyQa.sdkState("hangup", `sample-${index}`), index);
  }
  for (let index = 0; index < 30; index++) {
    await mount(page);
    mainPath.push(await page.evaluate(async () => {
      const start = performance.now();
      window.phoneHarness.begin("dial");
      window.phoneHarness.grant();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("No mocked POST")), 3000);
        const poll = () => {
          if (window.phoneHarness.requests[0]) { clearTimeout(deadline); resolve(); }
          else setTimeout(poll, 0);
        }; poll();
      });
      window.phoneHarness.requests[0].resolve(Response.json({ sessionId: "sample-session", operatorLegCallControlId: "sample-leg" }));
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("No acknowledgement feedback")), 3000);
        const poll = () => {
          if (window.phoneHarness.outcomes.includes("ok") && document.querySelector("#state")?.getAttribute("data-legs") === "1") { clearTimeout(deadline); requestAnimationFrame(() => resolve()); }
          else setTimeout(poll, 0);
        }; poll();
      });
      return performance.now() - start;
    }));
  }
  const summarize = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return { count: samples.length, p50: sorted[Math.ceil(samples.length * .5) - 1], p95: sorted[Math.ceil(samples.length * .95) - 1], max: sorted.at(-1), samples };
  };
  const result = { environment: "System Chrome; real React/hook; mocked SDK, microphone, network; no provider or production inference", clickToFeedbackFrameMs: summarize(feedback), dialToMockedAcknowledgementFrameMs: summarize(mainPath) };
  await mkdir(".context/telephony-execution", { recursive: true });
  await writeFile(".context/telephony-execution/browser-ultraqa-metrics.json", JSON.stringify(result, null, 2));
  expect(feedback).toHaveLength(50); expect(mainPath).toHaveLength(30);
  expect(feedback.every(Number.isFinite) && mainPath.every(Number.isFinite)).toBe(true);
});
