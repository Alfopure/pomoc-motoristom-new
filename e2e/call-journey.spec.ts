import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { RoutingDocument } from "../src/server/telephony/config-service";
import type { IncomingFlow } from "../src/lib/telephony/incoming-flow";
import { incomingFlowSignature, type CallJourney } from "../src/lib/telephony/call-journey";
import { DEFAULT_OPERATOR_SETTINGS } from "../src/lib/telephony/operator-settings";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flow: IncomingFlow = { version: 1, steps: [
  { id: id(501), type: "ring", seconds: 25, people: [{ profileId: id(101), application: true, personalNumber: "+421900000001" }] },
  { id: id(502), type: "wait", minutes: 5, policy: { mode: "callback", intervalSeconds: 30 } },
], ending: "callback_prompt" };
function documentFixture(): RoutingDocument {
  return { organizationId: id(1), routingVersion: 55, snapshotId: "fixture", settings: null,
    capabilities: { defaultInboundCallMode: "ring_first", ownedMobileRouting: true, unifiedIncomingFlow: true },
    limits: { destinationAllowlist: ["SK"], maxRingFanout: 8, maxConcurrentLegs: 9 },
    operators: [{ profileId: id(101), displayName: "Michal Ukážkový", role: "dispatcher", active: true, accessStatus: "active", settings: { ...DEFAULT_OPERATOR_SETTINGS, defaultMobileNumber: "+421900000001" }, device: null }],
    lines: [{ id: id(201), phoneNumber: "+421232408774", label: "TEST linka", partnerName: null, telnyxNumberId: null, ringPlanId: null, ivrMenuId: null, businessHoursId: null, environment: "development", active: true, inboundCallMode: "ring_first", incomingFlow: structuredClone(flow) }],
    groups: [], plans: [], businessHours: [], pauseReasons: [], pauseReasonsInUse: [], ivrMenus: [] };
}
function journey(n: number, wait: boolean, now: number): CallJourney {
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString(), sid = id(n);
  return { version: 1, sessionId: sid, callId: id(n + 500), lineId: id(201), direction: "inbound", callerNumber: `+42190000000${n - 300}`, calledNumber: "+421232408774", phase: "routing", sessionState: wait ? "waiting" : "ringing", sessionVersion: 1, asOf: at(0), customerActive: true, sessionActive: true, startedAt: at(wait ? -110 : -18), answeredAt: null, endedAt: null,
    flow: { source: "incoming_flow", signature: incomingFlowSignature(flow) }, currentOccurrenceId: `${sid}:${wait ? 1 : 0}`, coverage: "complete", truncated: false, events: [], callback: null,
    occurrences: [{ id: `${sid}:0`, executionIndex: 0, sourceStepId: id(501), kind: "ring", label: "Michal", state: wait ? "completed" : "active", startedAt: at(wait ? -106 : -14), endedAt: wait ? at(-81) : null, configuredSeconds: 25, timingBasis: "observed_transition", reason: wait ? "all_offers_finished" : null, endpoints: [
      { id: `${sid}:web`, profileId: id(101), displayName: "Michal Ukážkový", channel: "web", number: null, state: wait ? "no_answer" : "offered", reason: null, offeredAt: at(wait ? -106 : -14), answeredAt: null, endedAt: wait ? at(-81) : null },
      { id: `${sid}:mobile`, profileId: id(101), displayName: "Michal Ukážkový", channel: "mobile_app", number: null, state: "skipped", reason: "no_device", offeredAt: null, answeredAt: null, endedAt: null },
    ] }, { id: `${sid}:1`, executionIndex: 1, sourceStepId: id(502), kind: "wait", label: "Čakáreň", state: wait ? "active" : "pending", startedAt: wait ? at(-81) : null, endedAt: null, configuredSeconds: 300, timingBasis: wait ? "observed_transition" : "unknown", reason: null, endpoints: [] }] };
}

let script: string, css: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["e2e/fixtures/call-journey.tsx"], bundle: true, write: false, outdir: "e2e/.journey-build", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = result.outputFiles.find(file => file.path.endsWith(".css"))!.text;
});

async function setup(page: Page) {
  const state = {
    deny: false, fail: false, advanced: false, reads: 0, listReads: 0, detailReads: 0, writes: 0,
    missing: [] as number[], truncated: [] as number[], missingNames: [] as number[], ended: [] as number[], lateEvent: false,
    doc: documentFixture(), at: await page.evaluate(() => Date.now()),
  };
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#18181b;font:13px/1.6 Arial,sans-serif}main{max-width:1100px;margin:auto;padding:20px}button,input{font:inherit}button{background:none;border:0;cursor:pointer}p,h1,h2,h3,h4{margin:0}svg{flex-shrink:0}@media(max-width:560px){main{padding:12px}}</style><div id="root"></div></html>' });
    if (url.pathname.endsWith("/config/incoming-flow")) { state.writes++; return route.fulfill({ json: { document: state.doc } }); }
    if (url.pathname.includes("/journey")) {
      state.reads++;
      const list = url.pathname.endsWith("/journeys");
      if (list) state.listReads++; else state.detailReads++;
      if (state.deny) return route.fulfill({ status: 403, json: { error: "Forbidden" } });
      if (state.fail) return route.fulfill({ status: 503, json: { error: "Obnovenie sa nepodarilo." } });
      const now = await page.evaluate(() => Date.now());
      const calls = [journey(301, state.advanced, state.at), journey(302, false, state.at), journey(303, true, state.at)].map(call => {
        const ended = state.ended.some(n => call.sessionId === id(n));
        return { ...call, asOf: new Date(now).toISOString(), ...(ended ? {
          phase: "ended" as const, sessionState: "ended", sessionActive: false, customerActive: false,
          endedAt: new Date(state.at).toISOString(), currentOccurrenceId: null,
          occurrences: call.occurrences.map(occurrence => ({ ...occurrence, state: occurrence.state === "pending" ? "not_reached" as const : "completed" as const, endedAt: occurrence.startedAt ? new Date(state.at).toISOString() : null })),
          events: state.lateEvent ? [{ id: "late-evidence", at: new Date(state.at).toISOString(), kind: "hangup", label: "Oneskorené potvrdenie ukončenia" }] : [],
        } : {}) };
      });
      if (list) return route.fulfill({ json: { ok: true, checkedAt: new Date(now).toISOString(), calls: calls.filter(call => !state.missing.some(n => call.sessionId === id(n))).map(call => ({
        ...call, truncated: state.truncated.some(n => call.sessionId === id(n)),
        occurrences: call.occurrences.map(occurrence => ({ ...occurrence, endpoints: occurrence.endpoints.map(endpoint => ({ ...endpoint, displayName: state.missingNames.some(n => call.sessionId === id(n)) ? null : endpoint.displayName })) })),
      })), truncated: false } });
      const target = url.pathname.split("/calls/")[1].split("/")[0];
      return route.fulfill({ json: { ok: true, journey: calls.find(call => call.sessionId === target) ?? calls[0] } });
    }
    errors.push(`Unexpected request: ${url.pathname}`); return route.abort();
  });
  await page.goto("http://routing.test/");
  await page.evaluate(document => { (window as unknown as { __journeyDocument: RoutingDocument }).__journeyDocument = document; }, state.doc);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return { state, errors };
}

async function freezeClock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
}

async function openMonitor(page: Page) {
  await page.getByRole("button", { name: "Sledovať hovory", exact: true }).click();
  const monitor = page.getByRole("region", { name: "Hovory v uloženom postupe" });
  await expect(monitor.getByRole("button", { name: "+421 900 000 001: Michal" })).toBeVisible();
  await expect(monitor.getByRole("region", { name: "Priebeh hovoru", exact: true })).toContainText("+421 900 000 001");
  return monitor;
}

async function nextRefresh(page: Page, kind: "list" | "detail") {
  const response = page.waitForResponse(response => {
    const path = new URL(response.url()).pathname;
    return kind === "list" ? path.endsWith("/journeys") : path.endsWith("/journey");
  });
  await page.clock.runFor(5_000);
  await (await response).finished();
  // Drain response-processing microtasks before advancing the mocked clock again.
  await page.evaluate(() => {});
}

test("monitor shares one read per refresh with its selected detail and changing selection does not fetch", async ({ page }, testInfo) => {
  await freezeClock(page);
  const { state, errors } = await setup(page);
  const monitor = await openMonitor(page);
  expect({ list: state.listReads, detail: state.detailReads }).toEqual({ list: 1, detail: 0 });
  await monitor.getByRole("button", { name: "+421 900 000 003: Čakáreň" }).click();
  await expect(monitor.getByRole("region", { name: "Priebeh hovoru", exact: true })).toContainText("+421 900 000 003");
  expect(state.reads).toBe(1);
  for (let reads = 2; reads <= 4; reads++) {
    await nextRefresh(page, "list");
    await expect.poll(() => state.listReads).toBe(reads);
    await expect(monitor.getByRole("region", { name: "Priebeh hovoru", exact: true })).toContainText("+421 900 000 003");
  }
  expect(state.detailReads).toBe(0);
  await testInfo.attach("monitor-request-counts", { contentType: "application/json", body: JSON.stringify({ elapsedMs: 15_000, listRequests: state.listReads, detailRequests: state.detailReads, requestsPerRefresh: 1 }) });
  expect(errors).toEqual([]);
});

test("hidden monitor makes no requests and resumes one shared read when visible", async ({ page }) => {
  await freezeClock(page);
  const { state, errors } = await setup(page);
  await openMonitor(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(30_000);
  expect(state.reads).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => state.listReads).toBe(2);
  await page.clock.runFor(5_000);
  await expect.poll(() => state.listReads).toBe(3);
  expect(state.detailReads).toBe(0);
  expect(errors).toEqual([]);
});

for (const fallback of ["missing", "truncated", "missingNames"] as const) {
  test(`monitor independently refreshes selected detail when the batch is ${fallback}`, async ({ page }) => {
    await freezeClock(page);
    const { state, errors } = await setup(page);
    const monitor = await openMonitor(page);
    await monitor.getByRole("button", { name: "+421 900 000 003: Čakáreň" }).click();
    state[fallback] = [303];
    await nextRefresh(page, "detail");
    await expect.poll(() => state.detailReads).toBe(1);
    await expect(monitor.getByRole("region", { name: "Priebeh hovoru", exact: true })).toContainText("+421 900 000 003");
    await expect(monitor).not.toContainText("Zobrazuje sa len časť záznamov.");
    if (fallback === "missingNames") {
      const detail = monitor.getByRole("region", { name: "Priebeh hovoru", exact: true });
      await detail.getByText("Komu a kam sa volalo", { exact: false }).click();
      await expect(detail.getByText("Michal Ukážkový", { exact: true })).toHaveCount(2);
    }
    state[fallback] = [];
    await nextRefresh(page, "list");
    await expect.poll(() => state.listReads).toBe(3);
    const readsAfterRecovery = state.detailReads;
    await nextRefresh(page, "list");
    await expect.poll(() => state.listReads).toBe(4);
    expect(state.detailReads).toBe(readsAfterRecovery);
    expect(errors).toEqual([]);
  });
}

test("monitor retains selected evidence after a transient failure and clears it after access is denied", async ({ page }) => {
  await freezeClock(page);
  const { state, errors } = await setup(page);
  const monitor = await openMonitor(page);
  await monitor.getByRole("button", { name: "+421 900 000 003: Čakáreň" }).click();
  const detail = monitor.getByRole("region", { name: "Priebeh hovoru", exact: true });
  state.fail = true;
  await page.clock.runFor(5_000);
  await expect(monitor).toContainText("Obnovenie sa nepodarilo.");
  await expect(detail).toContainText("+421 900 000 003");
  const times = await detail.locator("time").allTextContents();
  await page.clock.runFor(1_000);
  expect(await detail.locator("time").allTextContents()).toEqual(times);
  state.fail = false; state.deny = true;
  await monitor.getByRole("button", { name: "Obnoviť", exact: true }).first().click();
  await expect(monitor).toContainText("nemáš prístup");
  await expect(monitor).not.toContainText("+421 900");
  expect(state.detailReads).toBe(0);
  expect(errors).toEqual([]);
});

test("monitor keeps the last selected call after it ends and stops fetching its settled detail", async ({ page }) => {
  await freezeClock(page);
  const { state, errors } = await setup(page);
  const monitor = await openMonitor(page);
  state.ended = [301]; state.missing = [301];
  await page.clock.runFor(5_000);
  const detail = monitor.getByRole("region", { name: "Priebeh hovoru", exact: true });
  await expect(detail).toContainText("Ukončený hovor");
  await expect(detail).toContainText("+421 900 000 001");
  await expect(monitor.getByRole("button", { name: "+421 900 000 002: Michal" })).toBeVisible();
  for (let reads = 2; reads <= 7; reads++) {
    await nextRefresh(page, "detail");
    await expect.poll(() => state.detailReads).toBe(reads);
  }
  const settledReads = state.detailReads;
  for (let i = 0; i < 3; i++) {
    const beforeList = state.listReads;
    await nextRefresh(page, "list");
    await expect.poll(() => state.listReads).toBe(beforeList + 1);
    expect(state.detailReads).toBe(settledReads);
  }
  await expect(detail).toContainText("+421 900 000 001");
  await expect(detail).toContainText("Ukončený hovor");
  expect(errors).toEqual([]);
});

test("ended detail settles only after stable final evidence and can be manually refreshed", async ({ page }, testInfo) => {
  await freezeClock(page);
  const { state, errors } = await setup(page);
  state.ended = [301];
  await page.getByRole("button", { name: "Priebeh", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Ukončený hovor");
  expect(state.detailReads).toBe(1);
  for (let reads = 2; reads <= 4; reads++) {
    await nextRefresh(page, "detail");
    await expect.poll(() => state.detailReads).toBe(reads);
  }
  state.lateEvent = true;
  await nextRefresh(page, "detail");
  await expect(dialog).toContainText("Udalosti hovoru (1)");
  expect(state.detailReads).toBe(5);
  for (let reads = 6; reads <= 11; reads++) {
    await nextRefresh(page, "detail");
    await expect.poll(() => state.detailReads).toBe(reads);
  }
  const settledReads = state.detailReads;
  await page.clock.runFor(60_000);
  expect(state.detailReads).toBe(settledReads);
  await expect(dialog).not.toContainText("Údaje sa neobnovujú.");
  await dialog.getByRole("button", { name: /Obnoviť/ }).click();
  await expect.poll(() => state.detailReads).toBe(settledReads + 1);
  await expect(dialog).toContainText("Ukončený hovor");
  await testInfo.attach("terminal-request-counts", { contentType: "application/json", body: JSON.stringify({ finalEvidenceAtMs: 20_000, stableSettlingMs: 30_000, settledReads, nextMinuteAutomaticReads: 0, manualRefreshReads: 1 }) });
  expect(errors).toEqual([]);
});

test("saved flow shows concurrent calls and preserves draft settings while following confirmed transitions", async ({ page }) => {
  const { state, errors } = await setup(page);
  await page.getByRole("button", { name: "Hudba", exact: true }).click();
  await expect(page.getByText("Neuložené zmeny: 1 linka")).toBeVisible();
  const addTop = await page.getByRole("button", { name: "Pridať ďalší krok", exact: true }).boundingBox();
  const endingTop = await page.getByRole("heading", { name: /Až na konci:/ }).boundingBox();
  expect(addTop!.y).toBeLessThan(endingTop!.y);
  await page.getByRole("button", { name: "Sledovať hovory", exact: true }).click();
  await expect(page.getByText("Sleduješ uložený postup.", { exact: false })).toBeVisible();
  const live = page.getByRole("region", { name: "Hovory v uloženom postupe" });
  const route = live.getByRole("region", { name: "Aktuálne uložený postup" });
  await expect(route.getByRole("button")).toHaveCount(3);
  if (process.env.JOURNEY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.JOURNEY_SCREENSHOT_DIR}/journey-test-desktop.png`, fullPage: true });
  const first = route.getByRole("button", { name: "+421 900 000 001: Michal" });
  await first.focus();
  await page.waitForTimeout(1200);
  await expect(first).toBeFocused();
  state.advanced = true;
  await expect(route.getByRole("button", { name: "+421 900 000 001: Čakáreň" })).toBeVisible({ timeout: 8000 });
  await expect(route.getByRole("button", { name: "+421 900 000 002: Michal" })).toBeVisible();
  await page.getByRole("button", { name: /^Nastavenie/ }).click();
  await expect(page.getByRole("button", { name: "Hudba", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(state.writes).toBe(0); expect(errors).toEqual([]);
});

test("failed refresh retains confirmed evidence, freezes timers, and denied refresh removes private caller data", async ({ page }) => {
  const { state, errors } = await setup(page);
  await page.getByRole("button", { name: "Priebeh", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("+421 900 000 001");
  await dialog.getByText("Komu a kam sa volalo", { exact: false }).click();
  await expect(dialog).toContainText("Aplikácia nie je pripojená");
  state.fail = true;
  await expect(dialog).toContainText("Posledný stav o", { timeout: 8000 });
  const times = await dialog.locator("time").allTextContents();
  await page.waitForTimeout(1200);
  expect(await dialog.locator("time").allTextContents()).toEqual(times);
  state.fail = false; state.deny = true;
  await dialog.getByRole("button", { name: "Obnoviť" }).click();
  await expect(dialog).not.toContainText("+421 900 000 001");
  await expect(dialog).toContainText("nemáš prístup");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile monitor, endpoint detail and wait controls fit 320px with reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { errors } = await setup(page);
  await page.getByRole("button", { name: "Hudba a informácia", exact: true }).click();
  await expect(page.getByText("Hudba medzi hláškami")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.JOURNEY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.JOURNEY_SCREENSHOT_DIR}/journey-test-mobile-settings.png`, fullPage: true });
  await page.getByRole("button", { name: "Sledovať hovory", exact: true }).click();
  await expect(page.getByRole("button", { name: "+421 900 000 003: Čakáreň" })).toBeVisible();
  await page.getByRole("button", { name: "+421 900 000 003: Čakáreň" }).click();
  await expect(page.getByRole("region", { name: "Priebeh hovoru", exact: true })).toContainText("+421 900 000 003");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.JOURNEY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.JOURNEY_SCREENSHOT_DIR}/journey-test-mobile.png`, fullPage: true });
  expect(errors).toEqual([]);
});
