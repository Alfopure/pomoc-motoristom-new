import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { DiagnosticIncident, DiagnosticOverview, DiagnosticStoredEvent } from "../src/lib/diagnostics/types";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] } });
const origin = "https://monitor.test";
const now = Date.parse("2026-09-29T12:00:00Z");
const iso = new Date(now).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function incident(n: number, patch: Partial<DiagnosticIncident> = {}): DiagnosticIncident {
  return { id: id(n), firstSeenAt: iso, lastSeenAt: iso, module: "app", operation: null, kind: "ui_error", status: "new", count: 1, buildId: "release-3ae56af", profileId: null, callSessionId: null, caseId: null, classification: "observation", cause: "unknown", evidenceIds: [id(20)], ...patch };
}
const event: DiagnosticStoredEvent = { id: id(20), pageId: id(21), sequence: 2, occurredAt: iso, receivedAt: iso, monotonicMs: 1234, type: "ui_error", module: "app", outcome: "failed", buildId: "release-3ae56af", sampled: false, sampleRate: 1, profileId: null, source: "browser", serverBuild: "release-3ae56af", errorClass: "TypeError", reason: "boundary" };
function overview(): DiagnosticOverview {
  return { checkedAt: iso, enabled: true, environment: "test", coverage: "unknown", since: new Date(now - 86_400_000).toISOString(), until: iso, incidents: [incident(10), incident(11, { kind: "call_interruption", module: "telephony", classification: "candidate", callSessionId: id(30), count: 2 }), incident(12, { kind: "operation", module: "cases", operation: "case.save", status: "resolved" })], nextCursor: null,
    operations: [{ operation: "case.save", sampleRate: .05, samples: 99, failedSamples: 1, p50Ms: 111, p95Ms: 999, insufficientData: false }, { operation: "call.pickup", sampleRate: .05, samples: 120, failedSamples: 2, p50Ms: 270, p95Ms: 630, insufficientData: false }],
    builds: [{ buildId: "release-3ae56af", lastSeenAt: iso, events: 34 }], calls: [{ direction: "inbound", total: 12, answered: 10, unanswered: 1, active: 1, averageWaitSeconds: 15, averageAnsweredToEndSeconds: 135 }, { direction: "outbound", total: 7, answered: 5, unanswered: 2, active: 0, averageWaitSeconds: 0, averageAnsweredToEndSeconds: 60 }, { direction: "internal", total: 2, answered: 0, unanswered: 0, active: 2, averageWaitSeconds: null, averageAnsweredToEndSeconds: null }], storage: null };
}
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/operations-monitor.tsx"], outfile: ".context/operations-monitor.js", bundle: true, write: false, metafile: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  expect(Object.keys(bundle.metafile!.inputs).some(file => /telnyx|coordinated-webphone|useTelephonyConsole|DispatchConsole/.test(file))).toBe(false);
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, options: { failingPolls?: boolean; acknowledge?: boolean; acknowledgeAfter?: number; reportRetryAfter?: number; width?: number; disabled?: boolean; coverage?: "unknown" | "limited"; blocked?: boolean; maintenanceCheckedAt?: string | null } = {}) {
  const requests: string[] = [], errors: string[] = [];
  const counts: Record<string, number> = {};
  const reports: Array<Record<string, unknown>> = [];
  let state = "new";
  await page.setViewportSize({ width: options.width ?? 1440, height: 950 });
  await page.clock.install({ time: new Date(now) });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const key = url.pathname;
    if (key === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    requests.push(url.pathname + url.search); counts[key] = (counts[key] ?? 0) + 1;
    if (key === "/api/diagnostics/events") {
      const events = route.request().postDataJSON().events as Array<Record<string, unknown>>;
      reports.push(...events);
      if (options.acknowledge || (options.acknowledgeAfter !== undefined && counts[key] > options.acknowledgeAfter)) return route.fulfill({ json: { acceptedIds: events.map(item => item.id) } });
      return route.fulfill({ status: options.reportRetryAfter ? 429 : 503, headers: options.reportRetryAfter ? { 'Retry-After': String(options.reportRetryAfter) } : {}, json: { error: "unavailable" } });
    }
    if (key.startsWith("/api/diagnostics/incidents/")) {
      if (route.request().method() === "PATCH") state = route.request().postDataJSON().status;
      return route.fulfill({ json: { incident: incident(Number(key.split("/").pop()!.slice(-2)), { status: state as DiagnosticIncident["status"], callSessionId: id(30), classification: "candidate" }), events: [event], checkedAt: iso } });
    }
    if (key === "/api/diagnostics" && url.searchParams.has("callSessionId")) return route.fulfill({ json: { callSessionId: id(30), checkedAt: iso, events: [event], legs: [{ id: id(31), role: "operator", answeredAt: iso, bridgedAt: iso, endedAt: null }], nextCursor: null, cause: "unknown" } });
    if (options.failingPolls && counts[key] > 1) return route.fulfill({ status: 503, json: { error: "fixture failure" } });
    if (key === "/api/health/live") return route.fulfill({ json: { status: "live", version: "release-3ae56af" } });
    if (key === "/api/health/ready") return route.fulfill({ json: { status: "ready", checkedAt: iso, version: "release-3ae56af" } });
    if (key === "/api/diagnostics") return route.fulfill({ json: { ...overview(), coverage: options.coverage ?? "unknown", ...(options.blocked ? { storage: { chargedBytes: 1024, eventCount: 120, incidentCount: 3, dropped: 0, physicalBytes: 1024, physicalBudgetBytes: 1024, physicalCheckedAt: options.maintenanceCheckedAt === undefined ? iso : options.maintenanceCheckedAt, blocked: true, cleanupBacklog: false } } : {}), ...(options.disabled ? { enabled: false, incidents: [], operations: [], calls: [] } : {}) } });
    return route.abort();
  });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Monitor prevádzky" })).toBeVisible();
  await expect(page.getByText("Posledná kontrola v poriadku", { exact: true })).toHaveCount(2);
  return { requests, counts, errors, reports };
}

for (const checkedAt of [null, new Date(now - 600_000).toISOString()]) test(`separates ${checkedAt === null ? "unknown" : "stale"} maintenance from quota even while app and database respond`, async ({ page }) => {
  const io = await boot(page, { blocked: true, maintenanceCheckedAt: checkedAt });
  await expect(page.getByText(checkedAt === null ? "Údržba diagnostiky neoverená" : "Údržba diagnostiky mešká", { exact: true })).toBeVisible();
  await expect(page.getByText("Obmedzený kvótou", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Posledná kontrola v poriadku", { exact: true })).toHaveCount(2);
  expect(io.requests.some(url => /telephony\/(cron|health|calls)/.test(url))).toBe(false);
});

test("loads evidence only on click, filters evidence and confirms status changes", async ({ page }) => {
  const io = await boot(page);
  expect(io.requests.some(url => url.includes("incidents/") || url.includes("callSessionId"))).toBe(false);
  await page.getByRole("combobox", { name: "Dôkazy", exact: true }).selectOption("candidate");
  await expect(page.getByRole("button", { name: /^Detail incidentu/ })).toHaveCount(1);
  await page.getByRole("button", { name: `Detail incidentu ${id(11)}` }).click();
  const detail = page.getByRole("region", { name: "Detail incidentu" });
  await expect(detail.getByText("Prvý výskyt", { exact: false })).toBeVisible();
  expect(io.requests.some(url => url.includes("callSessionId"))).toBe(false);
  await detail.getByRole("combobox", { name: "Stav incidentu", exact: true }).selectOption("acknowledged");
  await expect(detail.getByRole("combobox", { name: "Stav incidentu", exact: true })).toHaveValue("acknowledged");
  await detail.getByRole("button", { name: /Diagnostika hovoru/ }).click();
  await expect(page.getByText("Vetvy hovoru · serverové údaje")).toBeVisible();
  expect(io.requests.filter(url => url.includes("callSessionId"))).toHaveLength(1);
  expect(io.requests.some(url => /webphone|devices|calls\/active/.test(url))).toBe(false);
  expect(io.errors).toEqual([]);
});

test("keeps low-sample percentiles and unknown call durations truthful", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Odozvy úkonov", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "Uloženie prípadu" });
  await expect(row).toContainText("Nedostatok vzoriek");
  await expect(row).not.toContainText("999 ms");
  await expect(page.getByRole("row").filter({ hasText: "Prijatie hovoru" })).toContainText("630 ms");
  await page.getByRole("button", { name: "Hovory", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Prichádzajúce" })).toContainText("2 min 15 s");
  await expect(page.getByRole("row").filter({ hasText: "Interné" })).toContainText("Nezistené");
  await expect(page.getByText("bez vzorkovania", { exact: false })).toBeVisible();
});

for (const gap of ["limited", "blocked"] as const) test(`hides percentiles even above 100 samples when collection is ${gap}`, async ({ page }) => {
  await boot(page, gap === "limited" ? { coverage: "limited" } : { blocked: true });
  await page.getByRole("button", { name: "Odozvy úkonov", exact: true }).click();
  await expect(page.getByText("Percentily sú skryté", { exact: false })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Prijatie hovoru" });
  await expect(row).toContainText("120");
  await expect(row).toContainText("Neúplné merania");
  await expect(row).not.toContainText("630 ms");
});

test("manual refresh cannot accelerate live or database health checks", async ({ page }) => {
  const io = await boot(page);
  const refresh = page.getByRole("button", { name: "Obnoviť", exact: true });
  for (let i = 0; i < 8; i++) { await expect(refresh).toBeEnabled(); await refresh.click(); }
  expect(io.counts["/api/health/live"]).toBe(1);
  expect(io.counts["/api/health/ready"]).toBe(1);
  await page.clock.fastForward(61_000);
  await expect.poll(() => io.counts["/api/health/live"]).toBe(2);
  await expect(refresh).toBeEnabled(); await refresh.click();
  expect(io.counts["/api/health/live"]).toBe(2);
  expect(io.counts["/api/health/ready"]).toBe(1);
  await page.clock.fastForward(240_000);
  await expect.poll(() => io.counts["/api/health/ready"]).toBe(2);
});

test("expires successful observations despite failed refreshes; ready has its own ten-minute lease", async ({ page }) => {
  await boot(page, { failingPolls: true });
  await page.clock.fastForward(180_000);
  await expect(page.getByText("Zastarané overenie", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Posledná kontrola v poriadku", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Prehľad je zastaraný.", { exact: false })).toBeVisible();
  await page.clock.fastForward(430_000);
  await expect(page.getByText("Zastarané overenie", { exact: true })).toHaveCount(2);
});

test("stops every monitor poll while hidden and resumes without acquiring a phone", async ({ page }) => {
  const io = await boot(page);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const before = io.requests.length;
  await page.clock.fastForward(660_000);
  expect(io.requests.length).toBe(before);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => io.counts["/api/health/ready"]).toBe(2);
  expect(io.requests.every(url => /^\/api\/(diagnostics|health\/)/.test(url))).toBe(true);
});

test("reports without a call and confirms only a durable ACK", async ({ page }) => {
  const io = await boot(page, { acknowledge: true });
  await page.getByRole("button", { name: "Nahlásiť problém", exact: true }).click();
  await expect(page.getByText("Hlásenie bolo prijaté.", { exact: true })).toBeVisible();
  expect(io.reports).toHaveLength(1);
  expect(io.reports[0].type).toBe("user_report");
  expect(io.reports[0].callSessionId).toBeUndefined();
});
test("never presents an unavailable collector as an accepted report", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Nahlásiť problém", exact: true }).click();
  await expect(page.getByText("Prijatie zatiaľ nie je potvrdené.", { exact: false })).toBeVisible();
  await expect(page.getByText("Hlásenie bolo prijaté.", { exact: true })).toHaveCount(0);
});
test("updates a delayed report confirmation without creating another report", async ({ page }) => {
  const io = await boot(page, { acknowledgeAfter: 1 });
  const button = page.getByRole('button', { name: 'Nahlásiť problém', exact: true });
  await button.click();
  await expect(page.getByText('Prijatie zatiaľ nie je potvrdené.', { exact: false })).toBeVisible();
  await expect(button).toBeDisabled();
  await page.clock.runFor(10_000);
  await expect(page.getByText('Hlásenie bolo prijaté.', { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  expect(io.reports).toHaveLength(2);
  expect(new Set(io.reports.map(report => report.id)).size).toBe(1);
  expect(io.errors).toEqual([]);
});
test("keeps a rate-limited report pending until Retry-After and durable acceptance", async ({ page }) => {
  const io = await boot(page, { acknowledgeAfter: 1, reportRetryAfter: 20 });
  await page.getByRole('button', { name: 'Nahlásiť problém', exact: true }).click();
  await expect(page.getByText('Prijatie zatiaľ nie je potvrdené.', { exact: false })).toBeVisible();
  await page.clock.runFor(15_000);
  expect(io.reports).toHaveLength(1);
  await page.clock.runFor(10_000);
  await expect(page.getByText('Hlásenie bolo prijaté.', { exact: true })).toBeVisible();
  expect(new Set(io.reports.map(report => report.id)).size).toBe(1);
});
for (const width of [1440, 390]) test(`monitor is readable at ${width}px without layout overflow`, async ({ page }) => {
  const io = await boot(page, { width });
  await expect(page.getByRole("button", { name: /^Detail incidentu/ })).toHaveCount(3);
  await page.screenshot({ path: `.context/ralph-monitor/monitor-${width}.png`, fullPage: true });
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right })).slice(0,12) }));
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
  expect(io.errors).toEqual([]);
});
test("disabled collection states its coverage gap even with an empty list", async ({ page }) => {
  await boot(page, { disabled: true });
  await expect(page.getByText("Zber diagnostiky je vypnutý.", { exact: false })).toBeVisible();
  await expect(page.getByText("Externé HTTP kontroly nenakonfigurované.")).toBeVisible();
});
