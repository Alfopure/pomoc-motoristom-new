import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/live-widgets.tsx"], outfile: ".context/live-widgets-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
  css += ".widget-fixture{width:min(340px,100%);padding:4px;margin:0 auto}.widget-fixture .dispatch-widget-host{position:relative;display:flex;width:100%;max-height:calc(100dvh - 80px)}.widget-fixture nav button{min-height:44px;border:1px solid #ccc;padding:4px 8px;font-size:12px}";
});

const fixtureTask = { id: "calendar-task", title: "Pristaviť vozidlo klientovi a overiť podpísaný protokol", caseId: "case-a", caseIds: ["case-a"], caseLinks: [{ caseId: "case-a", caseNumber: "PM-2026-100", status: "open" }], assignedTo: "viewer", dueAt: "2026-09-12T09:00:00.000Z", status: "open", workflowState: "in_review", priority: "urgent", kind: "other", revision: 1, originLocked: false, provenance: "manual", origins: [], updatedAt: "2026-09-12T08:00:00.000Z" };
async function boot(page: Page, width = 1440, production = false) {
  const errors: string[] = [], writes: string[] = [], external: string[] = [];
  await page.setViewportSize({ width, height: width < 768 ? 844 : 768 });
  await page.clock.setFixedTime(new Date("2026-09-12T08:00:00Z"));
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://widgets.test") { external.push(url.origin); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (route.request().method() !== "GET") { writes.push(url.pathname); return route.fulfill({ status: 503, json: { error: "Testovací výpadok — text zostal zachovaný." } }); }
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [fixtureTask, { ...fixtureTask, id: "done-task", title: "Vybavená úloha", status: "done", workflowState: "done" }] } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [{ id: "private-note", title: "Moja poznámka", body: "Pôvodný text poznámky", revision: 1, ownerProfileId: "viewer", recipientProfileIds: [], canEdit: true, updatedAt: "2026-09-12T08:00:00Z" }] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [{ id: "colleague", displayName: "Kolega" }] } });
    return route.fulfill({ status: 503, json: { error: "Neobslúžená testovacia cesta" } });
  });
  await page.goto(`https://widgets.test/${production ? "?production=1" : ""}`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("complementary", { name: "Nástroje" })).toBeVisible();
  return { errors, writes, external };
}

test("calculator keeps its input node across styles and handles selection, syntax, clear and copy refusal", async ({ page }) => {
  const result = await boot(page);
  const calculator = page.locator('[data-widget="calculator"]');
  const input = calculator.getByRole("textbox", { name: "Výpočet" });
  await input.fill("12+345");
  const handle = await input.elementHandle();
  await input.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 6));
  await calculator.getByRole("button", { name: "Vymazať jeden znak alebo výber" }).click();
  await expect(input).toHaveValue("12+");
  await calculator.getByRole("button", { name: "Vymazať jeden znak alebo výber" }).click();
  await expect(input).toHaveValue("12");
  await page.getByRole("button", { name: "Prepnúť vzhľad" }).click();
  await expect(calculator.getByRole("button", { name: "Vymazať jeden znak alebo výber" })).toHaveCount(0);
  expect(await input.evaluate((element, previous) => element === previous, handle)).toBe(true);
  await expect(input).toHaveValue("12");
  await page.getByRole("button", { name: "Prepnúť vzhľad" }).click();
  await input.fill("(70 − 50) × 2 × 0,75");
  await calculator.getByRole("button", { name: "=", exact: true }).click();
  await expect(calculator.locator("output")).toHaveText("30");
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await calculator.getByRole("button", { name: "Kopírovať", exact: true }).click();
  await expect(calculator.locator('p[role="status"]')).toContainText("Kopírovanie nie je dostupné");
  await calculator.getByRole("button", { name: "Vymazať", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(calculator.locator("output")).toHaveCount(0);
  expect(result).toEqual({ errors: [], writes: [], external: [] });
});

test("calendar reads existing deadlines, opens the exact task and clears private content when access is revoked", async ({ page }) => {
  const result = await boot(page);
  const calendar = page.getByRole("region", { name: "Kalendár úloh" });
  await expect(calendar.getByRole("button", { name: new RegExp(fixtureTask.title) })).toBeVisible();
  await expect(calendar.getByRole("button", { name: new RegExp(fixtureTask.title) })).toContainText("Na kontrolu");
  await expect(calendar.getByRole("button", { name: /Vybavená úloha/ })).toHaveCount(0);
  await calendar.getByLabel("Zahrnúť vybavené úlohy").check();
  await expect(calendar.getByRole("button", { name: /Vybavená úloha/ })).toBeVisible();
  await calendar.getByRole("button", { name: new RegExp(fixtureTask.title) }).click();
  await expect(page.getByLabel("Otvorená úloha")).toHaveText("calendar-task:case-a");
  await calendar.locator('[data-calendar-day="2026-09-12"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect(calendar.locator('[data-calendar-day="2026-09-13"]')).toBeFocused();
  await expect(calendar.locator('[data-calendar-day="2026-09-13"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("PageDown");
  await expect(calendar.locator('[data-calendar-day="2026-10-13"]')).toBeFocused();
  await calendar.getByRole("button", { name: "Dnes", exact: true }).click();
  await expect(calendar.getByRole("button", { name: new RegExp(fixtureTask.title) })).toBeVisible();
  await page.getByRole("button", { name: "Zrušiť prístup k úlohám" }).click();
  await expect(page.getByRole("region", { name: "Kalendár úloh" })).toHaveCount(0);
  await expect(page.getByText(fixtureTask.title, { exact: true })).toHaveCount(0);
  expect(result).toEqual({ errors: [], writes: [], external: [] });
});

test("paper notes keep search, sharing and dirty text when style and visibility change", async ({ page }, testInfo) => {
  const result = await boot(page);
  const notes = page.getByRole("region", { name: "Osobné poznámky" });
  await expect(notes.locator(".note-body-preview")).toHaveText("Pôvodný text poznámky");
  await notes.screenshot({ path: testInfo.outputPath("paper-note-overview.png") });
  await notes.getByLabel("Hľadať v mojich a zdieľaných poznámkach").fill("poznámka");
  await notes.getByRole("button", { name: "Moja poznámka" }).click();
  const text = notes.getByLabel("Text poznámky");
  await text.fill("Rozpracovaný text — zachovať aj po prepnutí");
  const handle = await text.elementHandle();
  await notes.locator("summary").click();
  await notes.getByLabel("Kolega", { exact: true }).check();
  await page.getByRole("button", { name: "Prepnúť vzhľad" }).click();
  expect(await text.evaluate((element, previous) => element === previous, handle)).toBe(true);
  await expect(text).toHaveValue("Rozpracovaný text — zachovať aj po prepnutí");
  await expect(notes.getByLabel("Kolega", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Nastaviť widgety" }).click();
  await page.getByRole("region", { name: "Nastavenie widgetov" }).getByLabel("Poznámky", { exact: true }).uncheck();
  await expect(notes).toHaveCount(0);
  await page.getByRole("region", { name: "Nastavenie widgetov" }).getByLabel("Poznámky", { exact: true }).check();
  await expect(notes.getByLabel("Text poznámky")).toHaveValue("Rozpracovaný text — zachovať aj po prepnutí");
  expect(result.errors).toEqual([]); expect(result.external).toEqual([]);
  expect(result.writes.every(url => url.startsWith("/api/notes/"))).toBe(true);
});

test("calculator inserts at the selection and continues from its integrated result", async ({ page }, testInfo) => {
  const result = await boot(page);
  const calculator = page.locator('[data-widget="calculator"]');
  const input = calculator.getByRole("textbox", { name: "Výpočet" });
  await input.fill("12+345");
  await input.evaluate(element => (element as HTMLInputElement).setSelectionRange(3, 6));
  await calculator.getByRole("button", { name: "7", exact: true }).click();
  await expect(input).toHaveValue("12+7");
  await calculator.getByRole("button", { name: "=", exact: true }).click();
  await expect(calculator.locator("output")).toHaveText("19");
  const outputBox = await calculator.locator("output").boundingBox();
  const keypadBox = await calculator.locator(".calculator-keypad").boundingBox();
  expect(outputBox!.y + outputBox!.height).toBeLessThanOrEqual(keypadBox!.y);
  await calculator.getByRole("button", { name: "×", exact: true }).click();
  await calculator.getByRole("button", { name: "2", exact: true }).click();
  await expect(input).toHaveValue("19×2");
  await calculator.getByRole("button", { name: "=", exact: true }).click();
  await expect(calculator.locator("output")).toHaveText("38");
  await calculator.screenshot({ path: testInfo.outputPath("calculator-result.png") });
  await calculator.getByRole("button", { name: "5", exact: true }).click();
  await expect(input).toHaveValue("5");
  await expect(calculator.locator("output")).toHaveCount(0);
  expect(result).toEqual({ errors: [], writes: [], external: [] });
});

test("widget gallery prioritizes a tool and resets only tools while retaining calculator draft", async ({ page }, testInfo) => {
  const result = await boot(page);
  const calculator = page.locator('[data-widget="calculator"]');
  await calculator.getByRole("textbox", { name: "Výpočet" }).fill("89+12");
  await page.getByRole("button", { name: "Upraviť rozloženie pracoviska" }).click();
  await page.getByRole("button", { name: "Prispôsobiť nástroje", exact: true }).click();
  const settings = page.getByRole("region", { name: "Nastavenie widgetov" });
  await expect(settings).toBeVisible();
  await settings.screenshot({ path: testInfo.outputPath("widget-gallery.png") });
  for (let index = 0; index < 3; index++) await settings.getByRole("button", { name: "Kalkulačka posunúť vyššie" }).click();
  await expect(settings.locator("[data-widget-setting]").first()).toHaveAttribute("data-widget-setting", "calculator");
  await settings.getByRole("button", { name: "Obnoviť predvolené widgety" }).click();
  await expect(page.getByLabel("Rozloženie pracoviska", { exact: true })).toHaveText("true:true:notes");
  await expect(settings.getByLabel("Rýchle volanie", { exact: true })).toBeChecked();
  await expect(settings.getByLabel("Úlohy", { exact: true })).toBeChecked();
  await settings.getByLabel("Kalkulačka", { exact: true }).check();
  await expect(calculator.getByRole("textbox", { name: "Výpočet" })).toHaveValue("89+12");
  expect(result).toEqual({ errors: [], writes: [], external: [] });
});

test("production includes the released calendar and calculator while retaining all existing controls", async ({ page }) => {
  const result = await boot(page, 1440, true);
  await page.getByRole("button", { name: "Nastaviť widgety" }).click();
  const settings = page.getByRole("region", { name: "Nastavenie widgetov" });
  await expect(settings.getByRole("checkbox")).toHaveCount(8);
  await expect(settings.getByLabel("Kalendár", { exact: true })).toBeChecked();
  await expect(page.locator('[data-widget="calendar"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Vymazať jeden znak alebo výber" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Kalendár posunúť nižšie" })).toBeDisabled();
  await settings.getByRole("button", { name: "Kalendár posunúť vyššie" }).click();
  await expect(settings.getByRole("button", { name: "Flotila posunúť nižšie" })).toBeDisabled();
  await page.getByRole("button", { name: "Prepnúť vzhľad", exact: true }).click();
  await expect(page.locator("main")).toHaveAttribute("data-layout-preview", "classic");
  await expect(settings.getByLabel("Kalendár", { exact: true })).toBeChecked();
  await expect(page.locator('[data-widget="calendar"]')).toBeVisible();
  expect(result).toEqual({ errors: [], writes: [], external: [] });
});

for (const width of [360, 390, 768, 1280, 1440]) {
  test(`widget controls remain reachable without document overflow at ${width}px`, async ({ page }, testInfo) => {
    const result = await boot(page, width);
    const calendar = page.getByRole("region", { name: "Kalendár úloh" });
    await calendar.getByRole("button", { name: "Nasledujúci mesiac" }).click();
    await calendar.getByRole("button", { name: "Predchádzajúci mesiac" }).click();
    if (width < 768) {
      const sizes = await calendar.locator("[data-calendar-day]").evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      expect(sizes.every(size => size.width >= 44 && size.height >= 44)).toBe(true);
    }
    await page.getByRole("button", { name: "Nastaviť widgety" }).click();
    await page.getByRole("button", { name: "Kalendár posunúť vyššie" }).click();
    await page.getByRole("button", { name: "Nastaviť widgety" }).click();
    await page.locator('[data-widget="calendar"]').getByRole("button", { name: "Kalendár", exact: true }).click();
    await expect(calendar).toBeHidden();
    await page.locator('[data-widget="calendar"]').getByRole("button", { name: "Kalendár", exact: true }).click();
    await expect(calendar).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`widgets-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(result).toEqual({ errors: [], writes: [], external: [] });
  });
}
