import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { TelephonyTeamOperator } from "../src/lib/telephony/team";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://operator.test";
const now = Date.parse("2026-09-20T07:30:00Z");
const names = ["Alexandra Nováková", "Ján Ondrejčík", "Lucia Kováčová", "Martin Horváth", "Matej Novotný", "Michal Michálek", "Natália Kováčová", "Tester 2"];
const operators: TelephonyTeamOperator[] = names.map((name, index) => ({
  profileId: String(index), name, status: index === 1 ? "paused" : "available", statusSince: new Date(now - 13 * 3600_000).toISOString(),
  online: index < 2, lastOnlineAt: index < 2 ? new Date(now).toISOString() : index === 7 ? null : new Date(now - (index === 2 ? 12 * 60_000 : 3 * 3600_000)).toISOString(),
  answeredToday: 8, talkSecondsToday: 30, availableSecondsToday: 0, pausedSecondsToday: 0,
  lastDeviceContactAt: index < 2 ? new Date(now).toISOString() : index === 7 ? null : new Date(now - (index === 2 ? 12 * 60_000 : 3 * 3600_000)).toISOString(), lastMobileContactAt: null,
}));
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/operator-team.tsx"], outfile: ".context/operator-test.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, width: number, height = 800, response?: () => unknown) {
  await page.setViewportSize({ width, height });
  await page.clock.install({ time: new Date(now) });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="padding:16px;background:#eff2f7"><div id="root"></div></body></html>' });
    if (url.pathname === "/api/telephony/team") {
      const body = response ? response() : { checkedAt: new Date(now).toISOString(), operators };
      return body ? route.fulfill({ json: body }) : route.abort();
    }
    return route.abort();
  });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("operator-card")).toHaveCount(8);
  return errors;
}
for (const [width, height] of [[1440, 800], [1280, 800], [390, 844], [640, 450], [640, 300]]) test(`last-online cards and every popup fit ${width}×${height}`, async ({ page }) => {
  const errors = await boot(page, width, height);
  const cards = page.getByTestId("operator-card");
  await expect(cards.first().getByTestId("operator-last-online")).toHaveText("Online teraz");
  await expect(cards.nth(2).getByTestId("operator-last-online")).toHaveText("Naposledy pred 12 min");
  await expect(cards.nth(4).locator("summary")).toContainText("Offline");
  await expect(cards.nth(4).getByTestId("operator-last-online")).toHaveText("Naposledy pred 3 h");
  await expect(cards.last().getByTestId("operator-last-online")).toHaveText("Bez záznamu pripojenia");
  for (let i = 0; i < 8; i++) {
    const card = cards.nth(i);
    await expect(card.locator("summary")).not.toContainText("dnes");
    const name = await card.locator("summary strong").evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(name.scroll).toBeLessThanOrEqual(name.client);
    await card.locator("summary").click();
    const detail = card.getByTestId("operator-detail");
    await expect(detail).toBeVisible();
    await expect.poll(async () => { const r = await detail.boundingBox(); return r!.x >= 0 && r!.x + r!.width <= width && r!.y >= 0 && r!.y + r!.height <= height; }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.locator("summary").press("Escape");
    await expect(detail).not.toBeVisible();
  }
  await cards.nth(5).locator("summary").click();
  await expect(cards.nth(5).getByTestId("operator-detail")).toContainText("Prijaté hovory dnes");
  await expect(cards.nth(5).getByTestId("operator-detail")).toContainText("30 s");
  await page.screenshot({ path: `.context/operator-last-online-${width}-${height}.png` });
  if (width === 1280) await page.screenshot({ path: ".context/operator-last-online-preview.png", clip: { x: 0, y: 0, width, height: 350 } });
  expect(errors).toEqual([]);
});
test("failed refresh expires online claims and never revives stale availability", async ({ page }) => {
  let reads = 0;
  await boot(page, 1280, 800, () => ++reads === 1 ? { checkedAt: new Date(now).toISOString(), operators } : null);
  await expect(page.getByText("Online teraz", { exact: true })).toHaveCount(2);
  await page.clock.fastForward(31_000);
  await expect(page.getByText("Online teraz", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("operator-last-online").first()).toHaveText("Overuje sa spojenie");
  await expect(page.getByTestId("operator-card").nth(4).locator("summary")).not.toContainText("Dostupný");
});
