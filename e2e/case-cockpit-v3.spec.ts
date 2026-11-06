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
  await mkdir(".context/case-workspace-browser", { recursive: true });
  const fixture = await build({ entryPoints: ["src/components/dispatch/CaseCockpitPanel.fixture.tsx"], outfile: "case-cockpit-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "isolated-browser-key" }) } });
  script = fixture.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + fixture.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});
async function boot(page: Page, width: number, query = "", workReads: string[] = []) {
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://case-card.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (url.origin === "https://case-card.test" && url.pathname === "/api/sms" && route.request().method() === "GET") return route.fulfill({ json: { messages: [], hasMore: false } });
    if (url.origin === "https://case-card.test" && url.pathname === "/api/sms/context" && route.request().method() === "GET") return route.fulfill({ json: { cases: [{ id: "case-fixture", caseNumber: "TEST-001", name: "Test Klient", phone: "+421900000001", validPhone: true }], tasks: [], sender: "PomocMotor", callbackNumber: "+421900000002", repliesEnabled: false } });
    if (url.origin === "https://case-card.test" && route.request().method() === "GET") {
      const caseQuery = url.searchParams.get("caseId") === "case-fixture";
      if (url.pathname === "/api/operations" && caseQuery) { workReads.push(url.pathname); return route.fulfill({ json: { actor: { canDispatch: true }, operations: [], totalCount: 0, members: [], fleet: [] } }); }
      if (url.pathname === "/api/pobocky" && caseQuery) { workReads.push(url.pathname); return route.fulfill({ json: { actor: { central: true, leadGroups: [] }, requests: [], totalCount: 0, groups: [], branches: [], people: [], cycles: [], fleet: [] } }); }
      if (url.pathname === "/api/towing/workspace" && url.searchParams.get("sourceCaseId") === "case-fixture" && url.searchParams.get("view") === "office") { workReads.push(url.pathname); return route.fulfill({ json: { actor: { capabilities: [] }, orders: [], totalCount: 0, members: [], branches: [], fleet: [] } }); }
      if (url.pathname === "/api/cases/case-fixture/work") return route.fulfill({ json: { actorKey: "fixture:operator", canOperateTowing: true, pickup: "Testovacia nakládka", destination: "Testovací servis", groups: [], people: [], branches: [], fleet: [], cycles: [] } });
      if (url.pathname === "/api/cases/case-fixture/handoffs") return route.fulfill({ json: { preview: { caseNumber: "TEST-001", action: "Odťah a pristavenie", contact: { name: "Test Klient", phone: "+421900000001" }, vehicle: { make: "Škoda", model: "Octavia", plate: "TEST001" }, pickup: { address: "Testovacia nakládka", lat: null, lng: null }, destination: { address: "Testovací servis", lat: null, lng: null } }, previewVersion: "a".repeat(64), handoffs: [], branches: [], delivery: { members: [] } } });
    }
    errors.push(`Unexpected network request: ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`https://case-card.test/${query}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return errors;
}
const sms = (page: Page) => page.locator("[data-case-sms-history]");
const caseTab = (page: Page, name: string | RegExp) => page.locator("[data-case-workspace]").getByRole("tab", { name, exact: typeof name === "string" });
const pdfButton = (page: Page) => page.getByRole("button", { name: "Stiahnuť PDF", exact: true });
const pdfFixture = "%PDF-1.4\n% Isolated case download fixture\n%%EOF";
async function assertOrder(page: Page) {
  const selected = await page.locator('[data-case-workspace] [role="tab"][aria-selected="true"]').getAttribute("id");
  await caseTab(page, /^Úlohy/).click();
  await caseTab(page, "Poznámky a aktivita").click();
  await caseTab(page, "SMS").click();
  const order = await page.evaluate(() => {
    const workspace = document.querySelector("[data-case-workspace]")!;
    const form = document.querySelector('[data-testid="case-edit-form-main"]')!;
    const selectors = ['[data-testid="case-summary"]', '[data-testid="case-tasks"]', '[aria-labelledby="case-notes-heading"]', '[data-case-sms-history]'];
    return Boolean(workspace && form && workspace.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING)
      && selectors.every(selector => workspace.contains(document.querySelector(selector)));
  });
  expect(order).toBe(true);
  await expect(sms(page)).toHaveCount(1);
  if (selected) await page.locator(`[id="${selected}"]`).click();
}
for (const width of [320, 360, 390, 768, 1024, 1279, 1280, 1440]) {
  for (const filled of [false, true]) test(`case sections remain ordered and fit at ${width}px (${filled ? "filled" : "empty"})`, async ({ page }) => {
    const errors = await boot(page, width, `?filled=${filled}`);
    await expect(page.getByTestId("case-summary")).toBeVisible();
    const header = page.getByRole("group", { name: "Stav a priorita prípadu", exact: true });
    await expect(header.getByRole("button", { name: "Stiahnuť PDF", exact: true })).toBeVisible();
    await expect(pdfButton(page)).toHaveCount(1);
    await expect(pdfButton(page)).toBeEnabled();
    await assertOrder(page);
    if (filled && [390, 1280].includes(width)) await page.screenshot({ path: `.context/case-workspace-browser/app-${width === 390 ? "mobile" : "desktop"}.png` });
    const tasks = page.getByTestId("case-tasks");
    await expect(tasks.locator(":scope > summary")).toContainText(filled ? "1 otvorených · 1 po termíne" : "0 otvorených · 0 po termíne");
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toBeHidden();
    await caseTab(page, /^Úlohy/).click();
    await tasks.getByRole("textbox", { name: "Názov novej úlohy" }).fill("Rozpracovaná úloha");
    await tasks.locator(":scope > summary").click();
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toBeHidden();
    await tasks.locator(":scope > summary").click();
    await expect(tasks.getByRole("textbox", { name: "Názov novej úlohy" })).toHaveValue("Rozpracovaná úloha");
    if (filled) {
      await caseTab(page, "Prehľad").click();
      const overview = page.getByRole("tabpanel", { name: "Prehľad", exact: true });
      await overview.getByRole("button", { name: "Zobraziť viac", exact: true }).click();
      await expect(overview).toContainText("KONIEC CELÉHO OPISU");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}
test("collapse and restore retain the same case editor and one SMS tab", async ({ page }) => {
  const errors = await boot(page, 1280);
  await assertOrder(page);
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
test("focused task selects the tasks tab and opens its section", async ({ page }) => {
  const errors = await boot(page, 1280, "?task=task-fixture");
  await expect(caseTab(page, /^Úlohy/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("case-tasks")).toHaveAttribute("open", "");
  await expect(page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("compact GPS action keeps received coordinates separate from the saved incident", async ({ page }) => {
  const errors = await boot(page, 1280);
  await expect(page.getByTestId("case-summary")).toContainText("Dlhá ulica 1, Nitra");
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  expect(await priority.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeLessThanOrEqual(13);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await priority.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  const locationTrigger = page.getByTestId("case-location-trigger");
  expect((await locationTrigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await locationTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Poloha klienta", exact: true });
  await expect(dialog).toBeVisible();
  const gps = dialog.getByRole("region", { name: "Prijatá poloha klienta" });
  await expect(gps).toContainText("48.148600, 17.107700");
  await expect(gps.getByRole("button", { name: "Nahradiť miesto incidentu", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("case-summary")).toContainText("Dlhá ulica 1, Nitra");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test("drawer keeps draft after close and reopen and has one SMS tab", async ({ page }) => {
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
  await caseTab(page, /^Úlohy/).click();
  await page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" }).fill("Po otočení");
  await expect(page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" })).toHaveValue("Po otočení");
  expect(errors).toEqual([]);
});

async function mockCaseSaves(page: Page, options: { conflict?: boolean; fail?: boolean; delayFirst?: Promise<void>; loseFirstResponse?: boolean; failRefresh?: boolean } = {}) {
  const requests: Record<string, unknown>[] = [];
  const receipts = new Map<string, unknown>();
  let canonical = await page.evaluate(() => (window as unknown as { caseCardFixture: Record<string, unknown> }).caseCardFixture);
  await page.route("**/api/cases/case-fixture", async route => {
    expect(route.request().headers()["x-case-response"]).toBe("detail-v2");
    if (route.request().method() === "GET") return options.failRefresh ? route.fulfill({ status: 503, json: { error: "read unavailable" } }) : route.fulfill({ json: { caseDetail: canonical } });
    const input = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(input);
    const receipt = receipts.get(String(input.mutationId));
    if (receipt) return route.fulfill({ json: receipt });
    if (options.conflict) return route.fulfill({ status: 409, json: { error: "Súbežná zmena", code: "CASE_REVISION_CONFLICT" } });
    if (options.fail) return route.fulfill({ status: 400, json: { error: "Uloženie zlyhalo" } });
    if (requests.length === 1 && options.delayFirst) await options.delayFirst;
    const revision = `2026-09-10T11:00:0${requests.length}.000Z`;
    canonical = { ...canonical, updatedAt: revision,
      ...(input.priority ? { priority: input.priority } : {}), ...(input.status ? { status: input.status } : {}),
      ...(input.licensePlate ? { vehicle: { ...(canonical.vehicle as Record<string, unknown>), licensePlate: input.licensePlate } } : {}),
    };
    const result = { committedRevision: revision, mutationId: input.mutationId, ...(options.failRefresh ? { refreshRequired: true } : { caseDetail: canonical }) };
    receipts.set(String(input.mutationId), result);
    if (options.loseFirstResponse && requests.length === 1) return route.abort("failed");
    await route.fulfill({ json: result });
  });
  return requests;
}
test("header PDF downloads the saved case without a needless save", async ({ page }) => {
  const errors = await boot(page, 1280);
  const saves = await mockCaseSaves(page);
  let exports = 0;
  await page.route("**/api/cases/case-fixture/pdf", route => {
    exports++;
    return route.fulfill({ contentType: "application/pdf", body: pdfFixture });
  });
  const downloadEvent = page.waitForEvent("download");
  await pdfButton(page).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("TEST-001.pdf");
  expect(await readFile((await download.path())!, "utf8")).toBe(pdfFixture);
  await expect(pdfButton(page)).toBeEnabled();
  expect(saves).toEqual([]);
  expect(exports).toBe(1);
  expect(errors).toEqual([]);
});

for (const saveAlreadyStarted of [false, true]) {
  test(`header PDF waits for ${saveAlreadyStarted ? "in-flight autosave" : "the pending draft save"} before downloading`, async ({ page }) => {
    const errors = await boot(page, 1280);
    let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const saves = await mockCaseSaves(page, { delayFirst: delay });
    let exports = 0;
    await page.route("**/api/cases/case-fixture/pdf", route => {
      exports++;
      return route.fulfill({ contentType: "application/pdf", body: pdfFixture });
    });
    const priority = page.getByLabel("Priorita prípadu v hlavičke");
    await priority.selectOption("high");
    if (saveAlreadyStarted) await expect.poll(() => saves.length).toBe(1);
    const downloadEvent = page.waitForEvent("download");
    try {
      await expect(pdfButton(page)).toBeEnabled();
      await pdfButton(page).click();
      await expect.poll(() => saves.length).toBe(1);
      await expect(pdfButton(page)).toBeDisabled();
      expect(exports).toBe(0);
      expect(saves[0]).toEqual({ mutationId: expect.any(String), priority: "high", expectedUpdatedAt: "2026-09-10T11:00:00Z" });
    } finally {
      release();
    }
    expect((await downloadEvent).suggestedFilename()).toBe("TEST-001.pdf");
    await expect(pdfButton(page)).toBeEnabled();
    await expect(priority).toHaveValue("high");
    expect(saves).toHaveLength(1);
    expect(exports).toBe(1);
    expect(errors).toEqual([]);
  });
}

test("failed save blocks header PDF and preserves the pending draft", async ({ page }) => {
  const errors = await boot(page, 390);
  const saves = await mockCaseSaves(page, { fail: true });
  let exports = 0;
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await page.route("**/api/cases/case-fixture/pdf", route => {
    exports++;
    return route.fulfill({ contentType: "application/pdf", body: pdfFixture });
  });
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  await priority.selectOption("urgent");
  await pdfButton(page).click();
  await expect(page.getByRole("status").filter({ hasText: "Pred exportom uložte rozpracované zmeny" })).toBeVisible();
  await expect(pdfButton(page)).toBeEnabled();
  await expect(priority).toHaveValue("urgent");
  expect(saves.length).toBeGreaterThan(0);
  expect(exports).toBe(0);
  expect(downloads).toBe(0);
  expect(errors).toEqual([]);
});

test("PDF endpoint failure shows its error and allows retry", async ({ page }) => {
  const errors = await boot(page, 390);
  let exports = 0;
  await page.route("**/api/cases/case-fixture/pdf", route => {
    exports++;
    return exports === 1
      ? route.fulfill({ status: 503, json: { error: "PDF je dočasne nedostupné." } })
      : route.fulfill({ contentType: "application/pdf", body: pdfFixture });
  });
  await pdfButton(page).click();
  await expect(page.getByRole("status").filter({ hasText: "PDF je dočasne nedostupné." })).toBeVisible();
  await expect(pdfButton(page)).toBeEnabled();
  const downloadEvent = page.waitForEvent("download");
  await pdfButton(page).click();
  expect((await downloadEvent).suggestedFilename()).toBe("TEST-001.pdf");
  await expect(pdfButton(page)).toBeEnabled();
  expect(exports).toBe(2);
  expect(errors).toEqual([]);
});

for (const width of [390, 1280]) {
  test(`expanded detail keeps PDF beside case controls at ${width}px`, async ({ page }) => {
    const errors = await boot(page, width, "?view=detail");
    const header = page.getByRole("group", { name: "Stav a priorita prípadu", exact: true });
    await expect(header.getByRole("button", { name: "Stiahnuť PDF", exact: true })).toBeVisible();
    await expect(header.getByLabel("Priorita prípadu v hlavičke")).toBeVisible();
    await expect(page.locator("[data-case-workspace]")).toContainText("TEST-001");
    await expect(pdfButton(page)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.route("**/api/cases/case-fixture/pdf", route => route.fulfill({ contentType: "application/pdf", body: pdfFixture }));
    const downloadEvent = page.waitForEvent("download");
    await pdfButton(page).click();
    expect((await downloadEvent).suggestedFilename()).toBe("TEST-001.pdf");
    expect(errors).toEqual([]);
  });
}

test("header priority shares the editor snapshot and later autosave sends only changed fields", async ({ page }) => {
  const errors = await boot(page, 1280);
  const requests = await mockCaseSaves(page);
  await page.getByLabel("Priorita prípadu v hlavičke").selectOption("high");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByLabel("Priorita prípadu v hlavičke")).toBeEnabled();
  expect(requests[0]).toEqual({ mutationId: expect.any(String), priority: "high", expectedUpdatedAt: "2026-09-10T11:00:00Z" });
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  await editor.getByLabel("EČV", { exact: true }).fill("NEXT123");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ mutationId: expect.any(String), licensePlate: "NEXT123", expectedUpdatedAt: "2026-09-10T11:00:01.000Z" });
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
  expect(requests[1]).toEqual({ mutationId: expect.any(String), licensePlate: "NEWER456", expectedUpdatedAt: "2026-09-10T11:00:01.000Z" });
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
  expect(requests[0]).toEqual({ mutationId: expect.any(String), status: "cancelled", expectedUpdatedAt: "2026-09-10T11:00:00Z" });
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

test("lost commit response reuses one mutation identity and preserves subsequent typing", async ({ page }) => {
  const errors = await boot(page, 1280);
  const requests = await mockCaseSaves(page, { loseFirstResponse: true });
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  await priority.selectOption("urgent");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].mutationId).toEqual(expect.any(String));
  await expect(page.getByRole("button", { name: "Načítať aktuálny stav prípadu" })).toHaveCount(0);
  await expect(priority).toHaveValue("urgent");
  await priority.selectOption("high");
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2].mutationId).not.toBe(requests[0].mutationId);
  expect(requests[2].expectedUpdatedAt).toBe("2026-09-10T11:00:01.000Z");
  expect(errors).toEqual([]);
});
test("committed save with unavailable canonical reads retries only GET and keeps its draft", async ({ page }) => {
  const errors = await boot(page, 390);
  const requests = await mockCaseSaves(page, { failRefresh: true });
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  await priority.selectOption("urgent");
  await expect(page.getByTestId("case-autosave-status")).toContainText("Zmena bola prijatá");
  await page.getByRole("button", { name: "Overiť uložený stav" }).click();
  await expect(page.getByTestId("case-autosave-status")).toContainText("Zmena bola prijatá");
  await expect(page.getByRole("button", { name: "Načítať aktuálny stav prípadu" })).toHaveCount(0);
  await expect(priority).toHaveValue("urgent");
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("equivalent revision keeps the dirty draft while a newer microsecond snapshot reports a conflict", async ({ page }) => {
  const errors = await boot(page, 390);
  const requests = await mockCaseSaves(page, { fail: true });
  const priority = page.getByLabel("Priorita prípadu v hlavičke");
  await priority.selectOption("urgent");
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uloženie zlyhalo");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("case-fixture-snapshot", {
    detail: { updatedAt: "2026-09-10T13:00:00.000000+02:00", priority: "low", nextStep: "Ekvivalentná verzia prípadu" },
  })));
  await expect(page.getByText("Ekvivalentná verzia prípadu", { exact: true })).toBeVisible();
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uloženie zlyhalo");
  await expect(priority).toHaveValue("urgent");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("case-fixture-snapshot", {
    detail: { updatedAt: "2026-09-10T11:00:00.000001Z", priority: "low" },
  })));
  await expect(page.getByTestId("case-autosave-status")).toContainText("Prípad medzitým zmenil iný používateľ");
  await expect(priority).toHaveValue("urgent");
  await expect(page.getByRole("button", { name: "Načítať aktuálny stav prípadu" })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});


test("tab switches retain task, note and mandatory form drafts", async ({ page }) => {
  const errors = await boot(page, 1280);
  // A rejected autosave keeps the form draft pending; switching tabs must not reset it.
  await mockCaseSaves(page, { fail: true });
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByLabel("EČV", { exact: true });
  await plate.fill("RETAIN123");
  await caseTab(page, /^Úlohy/).click();
  const task = page.getByTestId("case-tasks").getByRole("textbox", { name: "Názov novej úlohy" });
  await task.fill("Zavolať klientovi po pristavení");
  await caseTab(page, "Poznámky a aktivita").click();
  const note = page.getByRole("textbox", { name: "Nová poznámka k prípadu" });
  await note.fill("Rozpracovaná interná poznámka");
  await caseTab(page, "SMS").click();
  await expect(sms(page)).toContainText("Zatiaľ žiadne SMS.");
  await caseTab(page, "Prehľad").click();
  await caseTab(page, /^Úlohy/).click();
  await expect(task).toHaveValue("Zavolať klientovi po pristavení");
  await caseTab(page, "Poznámky a aktivita").click();
  await expect(note).toHaveValue("Rozpracovaná interná poznámka");
  await expect(plate).toHaveValue("RETAIN123");
  await expect(sms(page)).toHaveCount(1);
  await assertOrder(page);
  expect(errors).toEqual([]);
});

test("SMS tab opens the existing case-bound composer without sending", async ({ page }) => {
  const errors = await boot(page, 390);
  await caseTab(page, "SMS").click();
  await expect(sms(page)).toContainText("Zatiaľ žiadne SMS.");
  await sms(page).getByRole("button", { name: "Nová SMS", exact: true }).click();
  const composer = page.getByRole("dialog");
  await expect(composer).toBeVisible();
  await expect(composer).toContainText("TEST-001");
  await page.keyboard.press("Escape");
  await expect(composer).toBeHidden();
  await expect(caseTab(page, "SMS")).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("initial overview shows tow and delivery once and keeps one read batch across work tabs", async ({ page }) => {
  const reads: string[] = [];
  const errors = await boot(page, 1440, "?dual=1", reads);
  const work = page.getByRole("region", { name: "Prehľad odťahu a pristavenia", exact: true });
  await expect(work.getByRole("heading", { name: "Odťah", exact: true })).toBeVisible();
  await expect(work.getByRole("heading", { name: "Pristavenie", exact: true })).toBeVisible();
  await expect.poll(() => reads.length).toBe(3);
  await work.evaluate(node => { (window as unknown as { workNode: Element }).workNode = node; });
  await caseTab(page, "Práca a jazdy").click();
  await expect(work).toBeVisible();
  await caseTab(page, "Poznámky a aktivita").click();
  await expect(work).toBeHidden();
  await caseTab(page, "Prehľad").click();
  await expect(work).toBeVisible();
  expect(await work.evaluate(node => (window as unknown as { workNode: Element }).workNode === node)).toBe(true);
  await expect(page.locator('[aria-label="Prehľad odťahu a pristavenia"]')).toHaveCount(1);
  expect(reads.sort()).toEqual(["/api/operations", "/api/pobocky", "/api/towing/workspace"].sort());
  expect(errors).toEqual([]);
});
test("the overview handoff action opens the existing drawer with both requested work types", async ({ page }) => {
  const errors = await boot(page, 1440, "?dual=1");
  await page.getByRole("button", { name: "Odovzdať prácu", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Odovzdať prípad", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("Druh práce", { exact: true })).toHaveCount(2);
  await expect(drawer.getByLabel("Druh práce", { exact: true }).nth(0)).toHaveValue("tow");
  await expect(drawer.getByLabel("Druh práce", { exact: true }).nth(1)).toHaveValue("delivery");
  await drawer.getByRole("button", { name: "Zavrieť odovzdanie" }).click();
  await expect(drawer).toBeHidden();
  expect(errors).toEqual([]);
});
