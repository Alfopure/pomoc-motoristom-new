import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { CallBarScenario } from "./fixtures/mobile-call-bar";

let fixtureScript = "";
let fixtureCss = "";
let appCss = "";

test.beforeAll(async ({ request, baseURL }) => {
  // Render the real component with the app's real Tailwind stylesheet. Every
  // browser request is blocked; callback records cannot place actual calls.
  const bundle = await build({
    entryPoints: ["e2e/fixtures/mobile-call-bar.tsx"], bundle: true, write: false,
    outdir: ".context/mobile-call-bar-fixture", platform: "browser", format: "iife", jsx: "automatic",
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

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: appCss + fixtureCss });
  await page.addScriptTag({ content: fixtureScript });
  await expect(page.getByTestId("phone-bar")).toBeVisible();
});

test("an incoming browser invite can be answered and rejected before the server poll", async ({ page }) => {
  const bar = page.getByTestId("phone-bar");
  await expect(bar.getByText("Peter Novák", { exact: false })).toBeVisible();
  await expect(bar.getByText("Prichádzajúci hovor", { exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Viac", exact: true })).toHaveCount(0);
  for (const name of ["Prijať", "Odmietnuť"]) {
    const control = bar.getByRole("button", { name, exact: true });
    const bounds = await control.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    await control.click();
  }
  expect(await events(page)).toEqual(["answer", "browser-hangup"]);
  await scenario(page, "answering");
  await expect(bar.getByRole("button", { name: "Prijímam…", exact: true })).toBeDisabled();
});

test("local media actions remain usable without a server session", async ({ page }) => {
  await scenario(page, "raw-active");
  const bar = page.getByTestId("phone-bar");
  await bar.getByRole("button", { name: "Stlmiť", exact: true }).click();
  await bar.getByRole("button", { name: "Klávesnica", exact: true }).click();
  const keypad = page.getByRole("region", { name: "Klávesnica počas hovoru", exact: true });
  await expect(keypad).toBeVisible();
  for (const digit of ["1", "0", "#"]) {
    const key = keypad.getByRole("button", { name: digit, exact: true });
    expect((await key.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await key.click();
  }
  await keypad.getByRole("button", { name: "Zavrieť klávesnicu" }).click();
  await expect(bar.getByRole("button", { name: "Klávesnica", exact: true })).toBeFocused();
  await bar.getByRole("button", { name: "Zavesiť", exact: true }).click();
  expect(await events(page)).toEqual(["mute", "dtmf:1", "dtmf:0", "dtmf:#", "browser-hangup"]);
});

test("a stale server call cannot label or hang up a new browser invite", async ({ page }) => {
  await scenario(page, "stale-server");
  const bar = page.getByTestId("phone-bar");
  await expect(bar.getByText("Peter Novák", { exact: false })).toBeVisible();
  await expect(bar.getByText("Stará zákazníčka", { exact: false })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Prepojiť", exact: true })).toHaveCount(0);
  await bar.getByRole("button", { name: "Prijať", exact: true }).click();
  await bar.getByRole("button", { name: "Odmietnuť", exact: true }).click();
  expect(await events(page)).toEqual(["answer", "browser-hangup"]);
});

for (const viewport of [{ width: 320, height: 568, bottom: 0 }, { width: 390, height: 844, bottom: 34 }, { width: 844, height: 390, bottom: 21 }]) {
  test(`call controls and keypad fit ${viewport.width}×${viewport.height}`, async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "Safe-area emulation uses Chromium DevTools.");
    await page.setViewportSize(viewport);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: viewport.bottom } });
    await scenario(page, "active");
    const bar = page.getByTestId("phone-bar");
    const before = await bar.boundingBox();
    // The released recording controls add a status row below the two call rows.
    expect(before!.height).toBeLessThanOrEqual(160);
    await expect(bar.getByRole("button", { name: "Prepojiť", exact: true })).toBeHidden();
    await expect(bar.getByText("Allianz Assistance", { exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "Viac", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Prepojiť", exact: true })).toBeVisible();
    expect((await bar.boundingBox())!.height).toBe(before!.height);
    await bar.getByRole("button", { name: "Zavrieť možnosti hovoru" }).click();
    await bar.getByRole("button", { name: "Klávesnica", exact: true }).click();
    const keypad = page.getByRole("region", { name: "Klávesnica počas hovoru", exact: true });
    await expect(keypad).toBeInViewport({ ratio: 1 });
    const bounds = await keypad.boundingBox();
    const navBounds = await page.getByRole("navigation", { name: "Mobilná navigácia" }).boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(navBounds!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    for (const digit of ["1", "#"]) await keypad.getByRole("button", { name: digit, exact: true }).click();
    await expect(keypad.getByRole("button", { name: "Zavrieť klávesnicu" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`calling-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await expect(keypad).toHaveCount(0);
    await bar.getByRole("button", { name: "Zavesiť", exact: true }).click();
    expect(await events(page)).toContain("server:hangup:fixture-session");
  });
}

test("desktop retains advanced actions and sound recovery is explicit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await scenario(page, "blocked-audio");
  const bar = page.getByTestId("phone-bar");
  for (const name of ["Prepojiť", "Konzultovať", "Do čakárne", "Nový prípad"]) await expect(bar.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Viac", exact: true })).toBeHidden();
  await bar.getByRole("button", { name: "Zapnúť zvuk hovoru", exact: true }).click();
  expect(await events(page)).toEqual(["resume-audio"]);
  await scenario(page, "pending");
  await expect(bar.getByText("Spájam hovor…", { exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Zavesiť", exact: true })).toHaveCount(0);
});

async function scenario(page: Page, value: CallBarScenario) {
  await page.evaluate((next) => window.callBarScenario(next), value);
}

async function events(page: Page) {
  return page.evaluate(() => window.callBarEvents);
}
