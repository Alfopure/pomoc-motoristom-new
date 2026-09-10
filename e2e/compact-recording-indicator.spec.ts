import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { CallRecordingDetail, RecordingLiveState } from "../src/lib/telephony/recording-quality";
import { LIVE_LABELS } from "../src/components/dispatch/recordings/recording-presentation";
import type {} from "./fixtures/mobile-call-bar";

const fixtureOrigin = "https://recording-fixture.invalid";
const detailPath = "/api/telephony/calls/fixture-call/recording-detail";
let fixtureScript = "";
let fixtureCss = "";
let appCss = "";

test.beforeAll(async ({ request, baseURL }) => {
  // Use the real PhoneBar and app Tailwind rules, with no live browser API access.
  const bundle = await build({
    entryPoints: ["e2e/fixtures/mobile-call-bar.tsx"], bundle: true, write: false,
    outdir: ".context/compact-recording-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
  });
  fixtureScript = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  fixtureCss = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  const documentResponse = await request.get(baseURL!);
  expect(documentResponse.ok()).toBe(true);
  const html = await documentResponse.text();
  const stylesheets = [...new Set([...html.matchAll(/href="([^"<>]+\.css(?:\?[^"<>]*)?)"/g)].map((match) => match[1].replaceAll("&amp;", "&")))];
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const stylesheet of stylesheets) {
    const response = await request.get(new URL(stylesheet, baseURL).href);
    expect(response.ok()).toBe(true);
    appCss += await response.text();
  }
});

test("off and stopped recorders are refreshed without opening their controls", async ({ page }) => {
  const api = await mount(page, "off");
  const indicator = recordingIndicator(page);
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.off));
  await expectDotColor(indicator, "zinc-400");
  await expect(recordingDot(indicator)).toHaveCSS("animation-name", "none");
  await expect(page.locator('[aria-label="Ovládanie nahrávania"]')).toHaveCount(0);

  for (const state of ["recording", "stopped", "recording"] as const) {
    const previousReads = api.reads();
    api.respond(state);
    await page.clock.fastForward(5_100);
    await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS[state]));
    expect(api.reads()).toBeGreaterThan(previousReads);
    await expectDotColor(indicator, state === "recording" ? "red-500" : "zinc-400");
    await expect(page.getByRole("region", { name: "Možnosti nahrávania", exact: true })).toHaveCount(0);
  }
  expect(api.blockedApiRequests).toEqual([]);
  expect(await page.evaluate(() => window.callBarEvents)).toEqual([]);
});

test("an API failure replaces the red recording claim with amber and polling recovers", async ({ page }) => {
  const api = await mount(page, "recording");
  const indicator = recordingIndicator(page);
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.recording));
  await expectDotColor(indicator, "red-500");

  api.fail();
  await page.clock.fastForward(5_100);
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.unknown));
  await expectDotColor(indicator, "amber-400");
  await expect(recordingDot(indicator)).toHaveCSS("animation-name", "none");
  await expect(page.getByRole("region", { name: "Možnosti nahrávania", exact: true })).toHaveCount(0);

  const failedReads = api.reads();
  api.respond("recording");
  await page.clock.fastForward(5_100);
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.recording));
  await expectDotColor(indicator, "red-500");
  expect(api.reads()).toBeGreaterThan(failedReads);
  expect(api.blockedApiRequests).toEqual([]);
  expect(await page.evaluate(() => window.callBarEvents)).toEqual([]);
});

test("recording controls open only on demand and close without changing the call", async ({ page }) => {
  const api = await mount(page, "recording");
  const bar = page.getByTestId("phone-bar");
  const indicator = recordingIndicator(page);
  const popup = page.getByRole("region", { name: "Možnosti nahrávania", exact: true });
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.recording));
  await expect(indicator.getByText("REC", { exact: true })).toBeVisible();
  await expect(indicator).toHaveAttribute("aria-expanded", "false");
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zastaviť nahrávanie", exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-label="Ovládanie nahrávania"]')).toHaveCount(0);
  const closedHeight = (await bar.boundingBox())!.height;

  await indicator.click();
  await expect(popup).toBeInViewport({ ratio: 1 });
  await expect(indicator).toHaveAttribute("aria-expanded", "true");
  await expect(popup.getByRole("button", { name: "Zastaviť nahrávanie", exact: true })).toBeVisible();
  expect((await bar.boundingBox())!.height).toBe(closedHeight);
  const close = popup.getByRole("button", { name: "Zavrieť možnosti nahrávania", exact: true });
  await expect(close).toBeFocused();
  await close.click();
  await expect(popup).toHaveCount(0);
  await expect(indicator).toBeFocused();

  await indicator.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(indicator).toHaveAttribute("aria-expanded", "false");
  await expect(indicator).toBeFocused();
  await expect(bar.getByRole("button", { name: "Zavesiť", exact: true })).toBeVisible();
  expect(api.blockedApiRequests).toEqual([]);
  expect(await page.evaluate(() => window.callBarEvents)).toEqual([]);
});

test("the inline LED keeps the bar compact at 320, 390 and 1440 pixels and respects reduced motion", async ({ page }, testInfo) => {
  const api = await mount(page, "recording");
  const bar = page.getByTestId("phone-bar");
  const indicator = recordingIndicator(page);
  const dot = recordingDot(indicator);
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.recording));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(dot).toHaveCSS("animation-name", "pulse");

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
    await expect(indicator).toBeInViewport({ ratio: 1 });
    await expect(bar.getByRole("button", { name: "Zavesiť", exact: true })).toBeInViewport({ ratio: 1 });
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(width < 1024 ? 112 : 64);
    const indicatorBounds = (await indicator.boundingBox())!;
    const dotBounds = (await dot.boundingBox())!;
    expect(indicatorBounds.width).toBeLessThanOrEqual(64);
    expect(indicatorBounds.height).toBeLessThanOrEqual(32);
    expect(dotBounds.width).toBe(8);
    expect(dotBounds.height).toBe(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`compact-recording-${width}.png`) });
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(dot).toHaveCSS("animation-name", "none");
  await expectDotColor(indicator, "red-500");
  await expect(indicator).toHaveAccessibleName(new RegExp(LIVE_LABELS.recording));
  expect(api.blockedApiRequests).toEqual([]);
  expect(await page.evaluate(() => window.callBarEvents)).toEqual([]);
});

function recordingIndicator(page: Page) {
  return page.getByTestId("phone-bar").getByRole("button").filter({ has: page.getByText("REC", { exact: true }) });
}

function recordingDot(indicator: Locator) {
  return indicator.locator('span[aria-hidden="true"]').first();
}

async function expectDotColor(indicator: Locator, color: "zinc-400" | "amber-400" | "red-500") {
  // Compare rendered colors, including Tailwind's OKLCH normalization in Chromium.
  await expect.poll(() => recordingDot(indicator).evaluate((dot, token) => {
    const reference = document.createElement("span");
    reference.style.backgroundColor = `var(--color-${token})`;
    document.body.append(reference);
    const expected = getComputedStyle(reference).backgroundColor;
    const actual = getComputedStyle(dot).backgroundColor;
    reference.remove();
    return actual === expected && actual !== "rgba(0, 0, 0, 0)";
  }, color)).toBe(true);
}

async function mount(page: Page, initialState: RecordingLiveState) {
  let liveState = initialState;
  let responseStatus = 200;
  let reads = 0;
  const blockedApiRequests: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.origin === fixtureOrigin && url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="root"></div></body></html>' });
    } else if (request.method() === "GET" && url.origin === fixtureOrigin && url.pathname === detailPath) {
      reads += 1;
      await route.fulfill({ status: responseStatus, contentType: "application/json", headers: { "cache-control": "no-store" },
        body: JSON.stringify(responseStatus === 200 ? detail(liveState) : { error: "Fixture temporarily unavailable", code: "unavailable" }),
      });
    } else {
      // Fonts may fall back locally. Every other API or mutation is unexpected
      // and blocked; even an accidental stop/call/SMS cannot leave this fixture.
      if (url.pathname.startsWith("/api/") || request.method() !== "GET") blockedApiRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort();
    }
  });
  // A real (intercepted) origin is required for relative recording API URLs.
  await page.goto(fixtureOrigin);
  await page.addStyleTag({ content: appCss + fixtureCss });
  await page.addScriptTag({ content: fixtureScript });
  await expect(page.getByTestId("phone-bar")).toBeVisible();
  await page.evaluate(() => window.callBarScenario("active"));
  return {
    respond(state: RecordingLiveState) { liveState = state; responseStatus = 200; },
    fail() { responseStatus = 503; },
    reads: () => reads,
    blockedApiRequests,
  };
}

function detail(liveState: RecordingLiveState): CallRecordingDetail {
  return {
    callId: "fixture-call", sourceRevision: 1, access: "full", state: "pending", stateReason: null,
    liveState, suppressed: false, segments: [], gaps: [],
    transcript: { status: "pending", language: null, spans: [] }, analysis: null, metrics: null,
    capabilities: { canReview: false, canAppeal: false, canCorrect: false, canDelete: false, canControl: true, canRetry: false },
  };
}
