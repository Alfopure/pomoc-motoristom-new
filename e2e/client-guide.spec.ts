import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { guideChapters } from "../src/content/guide/chapters";

test.setTimeout(90_000);

test("guide search, chapter links and illustrations work without starting telephony", async ({ page, baseURL }) => {
  const errors: string[] = [];
  const operationalRequests: string[] = [];
  const origin = new URL(baseURL!).origin;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/telephony/") || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      operationalRequests.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    if (url.origin !== origin) return route.abort();
    return route.continue();
  });
  await page.goto("/navod");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Istota pri");
  const search = page.getByRole("searchbox", { name: "Vyhľadať v celom návode" });
  await search.fill("prestavka");
  const results = page.locator(".guide-search-results");
  await expect(results.getByRole("link").first()).toBeVisible();
  await expect(results.locator('a[href*="pauza-a-zastupovanie"]').first()).toBeVisible();
  await results.locator('a[href*="pauza-a-zastupovanie"]').first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pauza");
  const anchor = new URL(page.url()).hash;
  if (anchor) await expect(page.locator(anchor)).toHaveCount(1);

  await page.goto("/navod/plany-zvonenia");
  const zoom = page.getByRole("button", { name: /^Zväčšiť obrázok:/ }).first();
  await zoom.click();
  await expect(page.locator("dialog[open]")).toBeVisible();
  await expect(page.locator("dialog[open] img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(zoom).toBeFocused();
  const legend = page.locator(".guide-shot-legend").filter({ visible: true }).first().getByRole("button").first();
  await legend.click();
  await expect(legend).toHaveAttribute("aria-pressed", "true");
  expect(operationalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("every chapter is reachable and all its illustrations load", async ({ page }) => {
  for (const chapter of guideChapters) {
    const response = await page.goto(`/navod/${chapter.slug}`);
    expect(response?.status(), chapter.slug).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(chapter.title);
    // Native lazy images may be outside the viewport; check their actual files.
    for (const src of await page.locator("main img").evaluateAll(images => images.map(image => (image as HTMLImageElement).src))) {
      expect((await page.request.get(src)).ok(), src).toBe(true);
    }
  }
});

for (const width of [390, 1440]) test(`guide is readable and navigable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  await page.goto("/navod");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(".context/guide-review", { recursive: true });
  await page.screenshot({ path: `.context/guide-review/home-${width}.png`, fullPage: true, animations: "disabled" });
  if (width < 500) {
    const trigger = page.getByRole("button", { name: "Otvoriť navigáciu návodu" });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "Navigácia návodu" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await page.goto("/navod/plany-zvonenia");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.context/guide-review/chapter-${width}.png`, fullPage: true, animations: "disabled" });
});
