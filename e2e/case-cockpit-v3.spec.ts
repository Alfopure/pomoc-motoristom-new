import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string;
let css: string;
test.beforeAll(async () => {
  const fixture = await build({ entryPoints: ["src/components/dispatch/CaseCockpitPanel.fixture.tsx"], outfile: "case-cockpit-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "isolated-browser-key" }) } });
  script = fixture.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + fixture.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});
async function boot(page: Page, width: number, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://case-card.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    errors.push(`Unexpected network request: ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`http://case-card.test/${query}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return errors;
}
const sms = (page: Page) => page.locator("summary").filter({ hasText: /^História SMS prípadu$/ });
async function assertOrder(page: Page) {
  const order = await page.evaluate(() => {
    const selectors = ['[data-testid="case-summary"]', '[data-testid="case-tasks"]', '[data-testid="case-edit-form-main"]', '[aria-labelledby="case-notes-heading"]'];
    const nodes = selectors.map(selector => document.querySelector(selector)!);
    const history = [...document.querySelectorAll("summary")].find(node => node.textContent === "História SMS prípadu")!;
    nodes.push(history);
    return nodes.every((node, index) => node && (index === 0 || Boolean(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)));
  });
  expect(order).toBe(true);
  await expect(sms(page)).toHaveCount(1);
}
for (const width of [360, 390, 768, 1024, 1279, 1280]) {
  for (const filled of [false, true]) test(`case sections remain ordered and fit at ${width}px (${filled ? "filled" : "empty"})`, async ({ page }) => {
    const errors = await boot(page, width, `?filled=${filled}`);
    await expect(page.getByTestId("case-summary")).toBeVisible();
    await assertOrder(page);
    const tasks = page.getByTestId("case-tasks");
    await expect(tasks.locator(":scope > summary")).toContainText(filled ? "1 otvorených · 1 po termíne" : "0 otvorených · 0 po termíne");
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toBeHidden();
    await tasks.locator(":scope > summary").click();
    await tasks.getByRole("textbox", { name: "Názov novej úlohy" }).fill("Rozpracovaná úloha");
    await tasks.locator(":scope > summary").click();
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toBeHidden();
    await tasks.locator(":scope > summary").click();
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toHaveValue("Rozpracovaná úloha");
    if (filled) {
      const overview = page.getByTestId("case-summary");
      await overview.getByRole("button", { name: "Zobraziť viac", exact: true }).click();
      await expect(overview).toContainText("KONIEC CELÉHO OPISU");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}
test("collapse and restore retain the same case editor and one final SMS section", async ({ page }) => {
  const errors = await boot(page, 1280);
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByLabel("EČV", { exact: true });
  await plate.fill("KEEP DRAFT");
  await page.getByRole("button", { name: "Minimalizovať na spodnú lištu" }).click();
  await expect(editor).toBeHidden();
  await expect(sms(page)).toHaveCount(1);
  await expect(sms(page)).toBeHidden();
  await page.getByRole("button", { name: "Maximalizovať spodnú lištu" }).click();
  await expect(plate).toHaveValue("KEEP DRAFT");
  await assertOrder(page);
  expect(errors).toEqual([]);
});
test("focused task opens its section while the ordinary case keeps it compact", async ({ page }) => {
  const errors = await boot(page, 1280, "?task=task-fixture");
  await expect(page.getByTestId("case-tasks")).toHaveAttribute("open", "");
  await expect(page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("compact GPS strip keeps the saved incident separate and mobile controls usable", async ({ page }) => {
  const errors = await boot(page, 1280);
  const gps = page.getByRole("region", { name: "Doplnková GPS poloha od klienta" });
  await expect(gps).toContainText("48.1486, 17.1077");
  await expect(page.getByTestId("case-summary")).toContainText("Dlhá ulica 1, Nitra");
  await expect(gps.getByRole("button", { name: "Použiť ako miesto incidentu" })).toBeEnabled();
  expect((await gps.boundingBox())!.height).toBeLessThan(100);
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  expect(await priority.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeLessThanOrEqual(13);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await priority.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  expect((await gps.getByRole("button", { name: "Použiť ako miesto incidentu" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});
test("drawer keeps draft after close and reopen and has only final SMS", async ({ page }) => {
  const errors = await boot(page, 390, "?view=drawer");
  await page.getByRole("button", { name: "Upraviť", exact: true }).click();
  await assertOrder(page);
  const editor = page.getByTestId("case-edit-form-main");
  await editor.getByLabel("EČV", { exact: true }).fill("DRAWER DRAFT");
  await page.getByRole("button", { name: "Zavrieť kartu prípadu" }).click();
  await expect(page.locator('[role="dialog"]')).toHaveAttribute("aria-hidden", "true");
  await page.getByRole("button", { name: "Otvoriť drawer" }).click();
  await expect(editor.getByLabel("EČV", { exact: true })).toHaveValue("DRAWER DRAFT");
  await assertOrder(page);
  expect(errors).toEqual([]);
});
test("collapsed map geocodes addresses and GPS, retains position, and ignores wheel zoom", async ({ page }) => {
  const errors = await boot(page, 390, "?view=location");
  const input = page.getByLabel("Približné miesto alebo GPS súradnice");
  const mapState = () => page.evaluate(() => {
    const state = (window as unknown as { caseCardTest: { maps: { center: unknown; zoom: number; options: { scrollwheel: boolean } }[]; geocodes: unknown[] } }).caseCardTest;
    return { maps: state.maps.map(map => ({ center: map.center, zoom: map.zoom, wheel: map.options.scrollwheel })), geocodes: state.geocodes.length };
  });
  await expect(page.getByTestId("location-picker-map")).toBeHidden();
  await input.fill("Nitra");
  await page.getByRole("button", { name: "Nájsť" }).click();
  await expect(page.getByTestId("selected-point")).toContainText("Nitra, Slovensko");
  expect(await mapState()).toEqual({ maps: [], geocodes: 1 });
  await input.fill("48.1486, 17.1077");
  await input.press("Enter");
  await expect(page.getByTestId("selected-point")).toContainText('"lat":48.1486');
  await page.locator("summary").filter({ hasText: "Mapa miesta incidentu" }).click();
  await expect.poll(async () => (await mapState()).maps.length).toBe(1);
  expect((await mapState()).maps[0]).toEqual({ center: { lat: 48.1486, lng: 17.1077 }, zoom: 14, wheel: false });
  await page.getByTestId("location-picker-map").hover();
  await page.mouse.wheel(0, 100);
  expect((await mapState()).maps[0].zoom).toBe(14);
  await page.locator("summary").filter({ hasText: "Mapa miesta incidentu" }).click();
  await input.fill("49.0, 19.0");
  await input.press("Enter");
  await page.locator("summary").filter({ hasText: "Mapa miesta incidentu" }).click();
  expect((await mapState()).maps).toEqual([{ center: { lat: 49, lng: 19 }, zoom: 14, wheel: false }]);
  expect(errors).toEqual([]);
});
test("case remains usable at 200 percent zoom and after orientation change", async ({ page }) => {
  const errors = await boot(page, 1280);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await assertOrder(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.setViewportSize({ width: 900, height: 390 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByTestId("case-tasks").locator(":scope > summary").click();
  await page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" }).fill("Po otočení");
  await expect(page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" })).toHaveValue("Po otočení");
  expect(errors).toEqual([]);
});

async function mockCaseSaves(page: Page, options: { conflict?: boolean; fail?: boolean; delayFirst?: Promise<void> } = {}) {
  const requests: Record<string, unknown>[] = [];
  let canonical = await page.evaluate(() => (window as unknown as { caseCardFixture: Record<string, unknown> }).caseCardFixture);
  await page.route("**/api/cases/case-fixture", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { dispatchData: { source: "supabase", dispatchCases: [canonical] } } });
    const input = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(input);
    if (options.conflict) return route.fulfill({ status: 409, json: { error: "Súbežná zmena", code: "CASE_REVISION_CONFLICT" } });
    if (options.fail) return route.fulfill({ status: 400, json: { error: "Uloženie zlyhalo" } });
    if (requests.length === 1 && options.delayFirst) await options.delayFirst;
    const revision = `2026-09-10T11:00:0${requests.length}.000Z`;
    canonical = { ...canonical, updatedAt: revision,
      ...(input.priority ? { priority: input.priority } : {}), ...(input.status ? { status: input.status } : {}),
      ...(input.licensePlate ? { vehicle: { ...(canonical.vehicle as Record<string, unknown>), licensePlate: input.licensePlate } } : {}),
    };
    await route.fulfill({ json: { committedRevision: revision, dispatchData: { source: "supabase", dispatchCases: [canonical] } } });
  });
  return requests;
}
test("header priority shares the editor snapshot and later autosave sends only changed fields", async ({ page }) => {
  const errors = await boot(page, 1280);
  const requests = await mockCaseSaves(page);
  await page.getByLabel("Priorita prípadu v hlavičke").selectOption("high");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByLabel("Priorita prípadu v hlavičke")).toBeEnabled();
  expect(requests[0]).toEqual({ priority: "high", expectedUpdatedAt: "2026-09-10T11:00:00Z" });
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  await editor.getByLabel("EČV", { exact: true }).fill("NEXT123");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ licensePlate: "NEXT123", expectedUpdatedAt: "2026-09-10T11:00:01.000Z" });
  await expect(page.getByLabel("Priorita prípadu v hlavičke")).toHaveValue("high");
  expect(errors).toEqual([]);
});
test("delayed acknowledgement preserves newer typing and serializes its revision", async ({ page }) => {
  const errors = await boot(page, 1280);
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  const requests = await mockCaseSaves(page, { delayFirst: delay });
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByLabel("EČV", { exact: true });
  await plate.fill("FIRST123");
  await expect.poll(() => requests.length).toBe(1);
  await plate.fill("NEWER456");
  release();
  await expect(plate).toHaveValue("NEWER456");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ licensePlate: "NEWER456", expectedUpdatedAt: "2026-09-10T11:00:01.000Z" });
  await expect(plate).toHaveValue("NEWER456");
  expect(errors).toEqual([]);
});
test("foreign revision conflict keeps the draft and offers an explicit canonical reload", async ({ page }) => {
  const errors = await boot(page, 390);
  const requests = await mockCaseSaves(page, { conflict: true });
  await page.getByLabel("Priorita prípadu v hlavičke").selectOption("urgent");
  await expect.poll(() => requests.length).toBe(1);
  const reload = page.getByRole("button", { name: "Načítať aktuálny stav prípadu" });
  await expect(reload).toBeVisible();
  await expect(page.getByLabel("Priorita prípadu v hlavičke")).toHaveValue("urgent");
  await reload.click();
  await expect(page.getByLabel("Priorita prípadu v hlavičke")).toHaveValue("normal");
  await expect(reload).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});
test("failed status change leaves the case mounted and the pending draft available", async ({ page }) => {
  const errors = await boot(page, 390);
  const requests = await mockCaseSaves(page, { fail: true });
  await page.getByLabel("Stav prípadu v hlavičke").selectOption("cancelled");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uloženie zlyhalo");
  await expect(page.getByLabel("Stav prípadu v hlavičke")).toHaveValue("cancelled");
  expect(requests[0]).toEqual({ status: "cancelled", expectedUpdatedAt: "2026-09-10T11:00:00Z" });
  expect(errors).toEqual([]);
});

test("native call blocks unreachable numbers and presents the shared verification error", async ({ page }) => {
  const errors = await boot(page, 390, "?filled=true");
  let lookups = 0;
  await page.route("**/api/telephony/callback-target?*", route => { lookups++; return route.fulfill({ json: { target: { originalNumber: "+421905111111", dialNumber: null, status: "blocked", verificationId: null } } }); });
  await expect(page.getByRole("link", { name: "Volať cez mobil" })).toHaveCount(0);
  await page.getByRole("button", { name: "Volať cez mobil" }).click();
  await expect(page.getByRole("alert")).toContainText("V kontakte najprv overte náhradné číslo");
  expect(lookups).toBe(1); expect(page.url()).toContain("case-card.test"); expect(errors).toEqual([]);
});

test("native call requires confirmation of the resolved alternative and respects cancellation", async ({ page }) => {
  const errors = await boot(page, 390, "?filled=true");
  await page.route("**/api/telephony/callback-target?*", route => route.fulfill({ json: { target: { originalNumber: "+421905111111", dialNumber: "+421905222222", status: "verified_alternative", verificationId: "verified-target", sourceName: "Ústredňa", targetName: "Overený dispečing" } } }));
  const dialog = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "Volať cez mobil" }).click({ noWaitAfter: true });
  const confirmation = await dialog;
  expect(confirmation.message()).toContain("Overený dispečing"); await confirmation.dismiss();
  await expect(page.getByRole("button", { name: "Volať cez mobil" })).toBeEnabled();
  expect(page.url()).toContain("case-card.test"); expect(errors).toEqual([]);
});
