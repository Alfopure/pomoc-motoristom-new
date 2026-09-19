import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
import type {} from "./fixtures/call-tray";
let script = "", css = "";
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/call-tray.tsx"], bundle: true, write: false, outdir: ".context/call-tray-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await page.waitForFunction(() => Boolean(window.trayScenario));
});
for (const width of [390, 1280]) for (const own of [false, true]) test(`three total bars and accessible overflow at ${width}px, own=${own}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  for (const offers of [0, 1, 3, 4, 10]) {
    await page.evaluate((scenario) => window.trayScenario(scenario), { offers, own });
    await expect(page.getByTestId("call-tray-offer")).toHaveCount(offers);
    if (!offers) { await expect(page.getByTestId("call-tray")).toHaveCount(own ? 1 : 0); continue; }
    const viewport = page.locator(`[aria-label="Zvoniace hovory: ${offers}"]`);
    const geometry = await viewport.evaluate((node) => ({ height: node.clientHeight, scrollHeight: node.scrollHeight, rowHeight: node.children[0].getBoundingClientRect().height }));
    expect(geometry.height).toBeLessThanOrEqual((own ? 2 : 3) * geometry.rowHeight);
    if (offers > (own ? 2 : 3)) { await viewport.focus(); await page.keyboard.press("End"); await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0); }
    if (own) await expect(page.getByTestId("phone-bar")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
test("answer selects the exact session and leg; waiting, IVR and colleague pickup leave the tray", async ({ page }) => {
  await page.evaluate(() => window.trayScenario({ offers: 4, selected: 2 }));
  const selected = page.locator('[data-session-id="session-2"]');
  await selected.getByRole("button", { name: "Prijať", exact: true }).click();
  await selected.getByRole("button", { name: "Odmietnuť tento hovor", exact: true }).click();
  expect(await page.evaluate(() => window.trayEvents)).toEqual(["answer:session-2:control-2", "reject:session-2:control-2"]);
  for (const phase of ["waiting", "colleague", "ivr"] as const) {
    await page.evaluate((phase) => window.trayScenario({ offers: 4, selected: 2, phase }), phase);
    await expect(selected).toHaveCount(0); await expect(page.getByTestId("call-tray-offer")).toHaveCount(3);
  }
});
