import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string;
let css: string;
test.beforeAll(async () => {
  await mkdir(".context/route-planner-browser", { recursive: true });
  script = (await build({ entryPoints: ["e2e/fixtures/route-planner.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "browser-test-key" }) } })).outputFiles[0].text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

async function boot(page: Page, width = 1440, widget = false) {
  const state = { requests: [] as Record<string, unknown>[], errors: [] as string[], fail: false, delay: 0 };
  page.on("pageerror", error => { state.errors.push(error.message); console.error(error.message); });
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://route-planner.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (url.origin === "http://route-planner.test" && url.pathname === "/api/maps/route") {
      state.requests.push(route.request().postDataJSON());
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      return route.fulfill({ status: state.fail ? 502 : 200, json: state.fail ? { error: "Medzi zadanými miestami sa nenašla prejazdná cesta." } : { distanceMeters: 420123, durationSeconds: 15300, encodedPolyline: "test", calculatedAt: new Date().toISOString(), provider: "google-routes" } });
    }
    state.errors.push(`Unexpected request: ${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.goto(`http://route-planner.test/${widget ? "?widget=1" : ""}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  if (widget) await expect(page.getByRole("region", { name: "Plánovač trasy" })).toBeVisible();
  else await expect(page.getByRole("button", { name: "Plánovač", exact: true })).toBeVisible();
  return state;
}

async function select(page: Page, label: string, query: string) {
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.fill(query);
  await input.press("Enter");
  await expect(input).toHaveValue(new RegExp(query));
  await expect(page.getByText("Načítavam miesto…")).toHaveCount(0);
}

async function mapState(page: Page) {
  return page.evaluate(() => {
    const state = (window as unknown as { routePlannerTest: { markers: { map: unknown; title: string }[]; polylines: { map: unknown }[]; autocompleteOptions: Record<string, unknown>[]; clickableIcons: boolean } }).routePlannerTest;
    return { markers: state.markers.filter(marker => marker.map).map(marker => marker.title), polylines: state.polylines.filter(polyline => polyline.map).length, restricted: state.autocompleteOptions.some(options => Boolean(options.includedRegionCodes)), clickableIcons: state.clickableIcons };
  });
}

test("selecting a prediction accepts Google's displayed address without cancelling its own lookup", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await page.locator('gmp-place-autocomplete[aria-label="Odkiaľ"]').evaluate(node => {
    (node as HTMLElement).dataset.delay = "50";
    (node as HTMLElement).dataset.selectionInput = "true";
  });
  await select(page, "Odkiaľ", "Bratislava");
  await select(page, "Kam", "Praha");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeEnabled();
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests).toEqual([{ origin: { lat: 48.1486, lng: 17.1077 }, destination: { lat: 50.0755, lng: 14.4378 }, intermediates: [] }]);
  expect(state.errors).toEqual([]);
});

for (const failure of ["conversion", "fetch", "coordinates"]) test(`place ${failure} failure finishes loading without inventing a point and permits retry`, async ({ page }) => {
  const state = await boot(page, 390, true);
  await select(page, "Odkiaľ", "Bratislava");
  const element = page.locator('gmp-place-autocomplete[aria-label="Kam"]');
  await element.evaluate((node, mode) => { (node as HTMLElement).dataset.placeFailure = mode; }, failure);
  const input = page.getByRole("textbox", { name: "Kam", exact: true });
  await input.fill("Praha"); await input.press("Enter");
  await expect(page.getByRole("status")).toContainText(failure === "coordinates" ? "Vyberte miesto s platnou polohou" : "Miesto sa nepodarilo načítať");
  await expect(page.getByText("Načítavam miesto…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  expect(state.requests).toEqual([]);
  await element.evaluate(node => { delete (node as HTMLElement).dataset.placeFailure; });
  await select(page, "Kam", "Praha");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeEnabled();
  expect(state.errors).toEqual([]);
});

test("a timed out place lookup allows a new selection and cannot replace it when it finally resolves", async ({ page }) => {
  const state = await boot(page, 1440, true);
  await select(page, "Odkiaľ", "Bratislava");
  await page.clock.install();
  const element = page.locator('gmp-place-autocomplete[aria-label="Kam"]');
  await element.evaluate(node => { (node as HTMLElement).dataset.delay = "30000"; });
  const input = page.getByRole("textbox", { name: "Kam", exact: true });
  await input.fill("Praha"); await input.press("Enter");
  await expect(page.getByText("Načítavam miesto…")).toBeVisible();
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("status")).toContainText("Načítanie miesta trvá príliš dlho");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  await element.evaluate(node => { (node as HTMLElement).dataset.delay = "0"; });
  await select(page, "Kam", "Wien");
  await page.clock.fastForward(30_000);
  await expect(input).toHaveValue("Wien, Österreich");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests).toEqual([{ origin: { lat: 48.1486, lng: 17.1077 }, destination: { lat: 48.2082, lng: 16.3738 }, intermediates: [] }]);
  expect(state.errors).toEqual([]);
});

test("hiding a pending place lookup clears its loading notice and rejects the late answer", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await select(page, "Odkiaľ", "Bratislava");
  await page.clock.install();
  await page.locator('gmp-place-autocomplete[aria-label="Kam"]').evaluate(node => { (node as HTMLElement).dataset.delay = "5000"; });
  const input = page.getByRole("textbox", { name: "Kam", exact: true });
  await input.fill("Praha"); await input.press("Enter");
  await expect(page.getByText("Načítavam miesto…")).toBeVisible();
  await page.getByRole("button", { name: "Nástroj bez mapy", exact: true }).click();
  await page.clock.fastForward(6_000);
  await page.getByRole("button", { name: "Mapa skúšky", exact: true }).click();
  await expect(page.getByText("Načítavam miesto…")).toHaveCount(0);
  await expect(input).toHaveValue("Praha, Česko");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  await select(page, "Kam", "Praha");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeEnabled();
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`international route is independent from fleet and branches at ${width}px`, async ({ page }) => {
  const state = await boot(page, width);
  await expect.poll(async () => (await mapState(page)).markers).toContain("Testovacia pobočka");
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await expect(page.getByRole("button", { name: "Odťahovky", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await mapState(page)).markers.length).toBe(0);
  await select(page, "Odkiaľ", "Bratislava");
  await select(page, "Kam", "Praha");
  await page.getByRole("button", { name: "Pridať bod prejazdu" }).click();
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  await select(page, "Bod prejazdu 1", "Wien");
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  await expect(page.getByText("4 h 15 min", { exact: true })).toBeVisible();
  expect(state.requests).toEqual([{ origin: { lat: 48.1486, lng: 17.1077 }, destination: { lat: 50.0755, lng: 14.4378 }, intermediates: [{ lat: 48.2082, lng: 16.3738 }] }]);
  expect(await mapState(page)).toEqual({ markers: ["1. Bratislava, Slovensko", "2. Wien, Österreich", "3. Praha, Česko"], polylines: 1, restricted: false, clickableIcons: false });
  const panel = page.getByRole("region", { name: "Plánovač trasy" });
  expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/route-planner-browser/route-${width}.png` });
  await page.getByRole("button", { name: "Prepočítať podľa dopravy" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  await page.getByRole("button", { name: "Zavrieť plánovač trasy" }).click();
  expect((await mapState(page)).polylines).toBe(0);
  await expect.poll(async () => (await mapState(page)).markers).toContain("Testovacia pobočka");
  expect(state.errors).toEqual([]);
});

test("waypoints reorder, reverse and remove, while editing invalidates stale results", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await select(page, "Odkiaľ", "Bratislava"); await select(page, "Kam", "Praha");
  await page.getByRole("button", { name: "Pridať bod prejazdu" }).click(); await select(page, "Bod prejazdu 1", "Wien");
  await page.getByRole("button", { name: "Pridať bod prejazdu" }).click(); await select(page, "Bod prejazdu 2", "Brno");
  await page.getByRole("button", { name: "Posunúť bod 2 vyššie" }).click();
  await expect(page.getByRole("textbox", { name: "Bod prejazdu 1", exact: true })).toHaveValue("Brno, Česko");
  await page.getByRole("button", { name: "Otočiť trasu" }).click();
  await expect(page.getByRole("textbox", { name: "Odkiaľ", exact: true })).toHaveValue("Praha, Česko");
  await expect(page.getByRole("textbox", { name: "Bod prejazdu 1", exact: true })).toHaveValue("Wien, Österreich");
  await page.getByRole("button", { name: "Odstrániť bod 2" }).click();
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests[0]).toEqual({ origin: { lat: 50.0755, lng: 14.4378 }, destination: { lat: 48.1486, lng: 17.1077 }, intermediates: [{ lat: 48.2082, lng: 16.3738 }] });
  await page.getByRole("textbox", { name: "Kam", exact: true }).fill("unfinished address");
  await expect(page.getByText("420,1 km", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  expect((await mapState(page)).polylines).toBe(0);
  expect(state.errors).toEqual([]);
});

test("late place and route responses are discarded; errors allow retry and clearing removes overlays", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await select(page, "Odkiaľ", "Bratislava");
  const destination = page.getByRole("textbox", { name: "Kam", exact: true });
  await page.locator('gmp-place-autocomplete[aria-label="Kam"]').evaluate(node => { (node as HTMLElement).dataset.delay = "300"; });
  await destination.fill("Praha"); await destination.press("Enter"); await destination.fill("new query");
  await page.waitForTimeout(350);
  await expect(destination).toHaveValue("new query");
  await expect(page.getByRole("button", { name: "Vypočítať trasu" })).toBeDisabled();
  await select(page, "Kam", "Praha");
  state.delay = 300;
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await destination.fill("Wien");
  await page.waitForTimeout(350);
  await expect(page.getByText("420,1 km", { exact: true })).toHaveCount(0);
  await select(page, "Kam", "Wien"); state.fail = true; state.delay = 0;
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByRole("alert")).toContainText("nenašla prejazdná cesta");
  state.fail = false;
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByText("420,1 km", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Viac ovládania mapy" }).click();
  await page.getByRole("button", { name: "Vyčistiť mapu" }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" })).toHaveCount(0);
  expect((await mapState(page)).markers).toEqual([]);
  expect((await mapState(page)).polylines).toBe(0);
  expect(state.errors).toEqual([]);
});

test("foreign map searches work and a late search cannot overlay the route planner", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Hľadať miesto", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Hľadať miesto", exact: true });
  await input.fill("Wien"); await input.press("Enter");
  await expect.poll(async () => (await mapState(page)).markers).toContain("Wien, Österreich");
  await page.locator('gmp-place-autocomplete[aria-label="Hľadať miesto"]').evaluate(node => { (node as HTMLElement).dataset.delay = "300"; });
  await input.fill("Praha"); await input.press("Enter");
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await page.waitForTimeout(350);
  expect((await mapState(page)).markers).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const width of [390, 1440]) test(`map and map-free widget preserve one route and raw input at ${width}px`, async ({ page }) => {
  const state = await boot(page, width);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await select(page, "Odkiaľ", "Bratislava");
  await page.getByRole("textbox", { name: "Kam", exact: true }).fill("Praha unfinished");
  await page.getByRole("button", { name: "Nástroj bez mapy", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Odkiaľ", exact: true })).toHaveValue("Bratislava, Slovensko");
  await expect(page.getByRole("textbox", { name: "Kam", exact: true })).toHaveValue("Praha unfinished");
  expect(state.requests).toEqual([]);
  await select(page, "Kam", "Praha");
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" }).getByText("420,1 km", { exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "Plánovač trasy" });
  expect(await panel.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
  if (width === 390) {
    expect(await page.getByRole("button", { name: "Pridať bod prejazdu" }).evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    expect(await page.getByRole("textbox", { name: "Kam", exact: true }).evaluate(node => getComputedStyle(node).fontSize)).toBe("16px");
  }
  await page.getByRole("button", { name: "Mapa skúšky", exact: true }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" }).getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  await page.getByRole("button", { name: "Zavrieť plánovač trasy" }).click();
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" }).getByText("420,1 km", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test("branches and focus remain keyboard-accessible under More", async ({ page }) => {
  const state = await boot(page, 390);
  await expect(page.getByRole("button", { name: "Pobočky", exact: true })).not.toBeVisible();
  const more = page.getByRole("button", { name: "Viac ovládania mapy" });
  await more.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Pobočky", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Focus mapa", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pobočky", exact: true }).click();
  await expect.poll(async () => (await mapState(page)).markers).not.toContain("Testovacia pobočka");
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]);
});


test("map-free planner calculates without creating a map or changing its viewport", async ({ page }) => {
  const state = await boot(page, 390, true);
  const readMapActivity = () => page.evaluate(() => {
    const state = (window as unknown as { routePlannerTest: { mapCreations: number; viewportChanges: number } }).routePlannerTest;
    return { mapCreations: state.mapCreations, viewportChanges: state.viewportChanges };
  });
  expect(await readMapActivity()).toEqual({ mapCreations: 0, viewportChanges: 0 });
  await select(page, "Odkiaľ", "Bratislava"); await select(page, "Kam", "Praha");
  expect(state.requests).toEqual([]);
  await page.getByRole("button", { name: "Vypočítať trasu" }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" }).getByText("420,1 km", { exact: true })).toBeVisible();
  expect(await readMapActivity()).toEqual({ mapCreations: 0, viewportChanges: 0 });
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]);
});
