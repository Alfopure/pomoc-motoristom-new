import { expect, test } from "@playwright/test";
import { build } from "esbuild";

const sessionId = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";
let script = "";
let css = "";

test.beforeAll(async ({ request, baseURL }) => {
  const result = await build({ entryPoints: ["e2e/fixtures/call-notification-focus.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = result.outputFiles[0].text;
  const response = await request.get(baseURL!);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  const stylesheets = [...new Set([...html.matchAll(/href="([^"<>]+\.css(?:\?[^"<>]*)?)"/g)].map((match) => match[1].replaceAll("&amp;", "&")))];
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const stylesheet of stylesheets) {
    const response = await request.get(new URL(stylesheet, baseURL).href);
    expect(response.ok()).toBe(true);
    css += await response.text();
  }
});

test.beforeEach(async ({ page }) => {
  // The real component uses local callbacks; no request can place a call or
  // invoke the active-call endpoint's server-side expiry processing.
  await page.route("**/*", (route) => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("call-notification-focus")).toBeVisible();
});

test("waiting push stays passive until an explicit pickup and fits a narrow mobile screen", async ({ page }, testInfo) => {
  const card = page.getByTestId("call-notification-focus");
  await expect(card).toHaveAttribute("data-session-id", sessionId);
  expect(await page.evaluate(() => window.callPushEvents)).toEqual([]);
  const pickup = card.getByRole("button", { name: "Prevziať čakajúci hovor" });
  expect((await pickup.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("call-push-waiting-mobile.png") });
  await pickup.click();
  expect(await page.evaluate(() => window.callPushEvents)).toEqual([`pickup:${sessionId}`]);
});

test("incoming push answers only its browser invite and never another call with the same number", async ({ page }) => {
  await page.evaluate(() => window.callPushScenario("incoming"));
  await page.getByRole("button", { name: "Prijať tento hovor" }).click();
  expect(await page.evaluate(() => window.callPushEvents)).toEqual(["answer"]);
  await page.evaluate(() => window.callPushScenario("other-call"));
  await expect(page.getByRole("button", { name: "Prijať tento hovor" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("iný hovor");
});

test("taken, ended and stale calls remove actions while preserving refresh", async ({ page }) => {
  for (const [scenario, message] of [["taken", "vybavuje Jana"], ["ended", "už nie je dostupný"], ["stale", "nepodarilo načítať"]] as const) {
    await page.evaluate((value) => window.callPushScenario(value), scenario);
    await expect(page.getByRole("status")).toContainText(message);
    await expect(page.getByRole("button", { name: "Prevziať čakajúci hovor" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prijať tento hovor" })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Obnoviť stav" }).click();
  expect(await page.evaluate(() => window.callPushEvents)).toEqual(["refresh"]);
});

test("internal, consultation and conference invites remain answerable without a queue offer", async ({ page }) => {
  for (const scenario of ["internal", "consulting", "conference"] as const) {
    await page.evaluate((value) => window.callPushScenario(value), scenario);
    await expect(page.getByRole("status")).toContainText("zvoní na tomto telefóne");
    await page.getByRole("button", { name: "Prijať tento hovor" }).click();
  }
  expect(await page.evaluate(() => window.callPushEvents)).toEqual(["answer", "answer", "answer"]);
  await page.evaluate(() => window.callPushScenario("consulting-other-call"));
  await expect(page.getByRole("button", { name: "Prijať tento hovor" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("iný hovor");
  await page.evaluate(() => window.callPushScenario("taken-stale-invite"));
  await expect(page.getByRole("button", { name: "Prijať tento hovor" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("vybavuje Jana");
});
