import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { WorkspaceTask } from "../src/domain/task-workspace";

// Real DispatchConsole + all existing providers; every browser request is intercepted.
// No real data, SMS, telephony, directory or authenticated deployment is contacted.
test.describe.configure({ mode: "default" });
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://live-layout.test";
const ownerId = "00000000-0000-4000-8000-000000000002";
const task: WorkspaceTask = { id: "00000000-0000-4000-8000-000000000010", caseId: "", caseIds: [], caseLinks: [], title: "Overiť odovzdanie vozidla", assignedTo: ownerId, dueAt: "", reminderAt: null, status: "open", workflowVersion: 1, workflowState: "todo", priority: "normal", kind: "other", revision: 1, originLocked: false, provenance: "manual", origins: [], updatedAt: "2026-09-12T08:00:00Z" };
const note = { id: "00000000-0000-4000-8000-000000000020", ownerProfileId: ownerId, title: "Odovzdanie zmeny", body: "Uložené údaje poznámky", recipientProfileIds: [], canEdit: true, revision: 1, updatedAt: "2026-09-12T08:00:00Z" };
let script: string;
let css: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/live-layout-preview.tsx"], outfile: ".context/live-layout-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

async function boot(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  const evidence = { errors: [] as string[], writes: [] as string[], blockedOrigins: [] as string[] };
  page.on("pageerror", error => evidence.errors.push(error.message));
  await page.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { evidence.blockedOrigins.push(url.origin); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (request.method() !== "GET") { evidence.writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 503, json: { error: "Izolovaný výpadok: rozpracované údaje zostávajú zachované." } }); }
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [task], workflowEnabled: true } });
    if (url.pathname.endsWith("/messages")) return route.fulfill({ json: { messages: [], nextCursor: null } });
    if (url.pathname.startsWith("/api/tasks/")) return route.fulfill({ json: { task } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/sms/context") return route.fulfill({ json: { cases: [{ id: "case-2026-0517", caseNumber: "PM-2026-0517", name: "Testovací klient", phone: "+421900000001", validPhone: true }], tasks: [], sender: "PomocMotor", callbackNumber: "+421900000002", repliesEnabled: false } });
    if (url.pathname === "/api/sms/inbox") return route.fulfill({ json: { unreadCount: 2, messages: [], operators: [], hasMore: false } });
    if (url.pathname === "/api/sms") return route.fulfill({ json: { messages: [{ id: "sms-1", caseId: null, caseNumber: null, recipientName: "Testovací kolega", toNumber: "+421900000003", author: "Dispečer", body: "Samostatná odoslaná správa", sender: "PomocMotor", createdAt: "2026-09-12T08:00:00Z", status: "delivered", statusDetail: "delivered", error: null, template: "custom", direction: "outbound", location: null }], hasMore: false } });
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-live-layout-preview" } });
    return route.fulfill({ status: 503, json: { error: "Izolovaný test: služba nedostupná." } });
  });
  await page.goto(origin);
  try { await mount(page); }
  catch (error) { throw new Error(`Console boot failed; browser errors: ${evidence.errors.join("; ")}`, { cause: error }); }
  return evidence;
}

async function mount(page: Page, mode: "modern" | "classic" = "modern") {
  await page.evaluate(tasks => { window.compactFixtureTasks = tasks; }, [task]);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-layout-preview", mode);
}

async function style(page: Page, mode: "modern" | "classic") {
  await page.getByRole("region", { name: "Náhľad rozhrania", exact: true }).getByRole("button", { name: mode === "modern" ? "Nový vzhľad" : "Pôvodný vzhľad", exact: true }).click();
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-layout-preview", mode);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function tools(page: Page) {
  const toolbar = page.locator(".workspace-toolbar").getByRole("button", { name: "Nástroje", exact: true });
  if (await toolbar.isVisible()) await toolbar.click();
  else {
    await page.getByRole("navigation", { name: "Mobilná navigácia", exact: true }).getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("dialog", { name: "Obrazovky aplikácie", exact: true }).getByRole("button", { name: "Nástroje", exact: true }).click();
  }
}
async function drag(page: Page, locator: Locator, dx: number, dy = 0) {
  const box = (await locator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

test("both styles retain every case-row field, five filters, all sidebar sorts and table columns", async ({ page }) => {
  const evidence = await boot(page);
  const list = page.getByTestId("dispatch-case-list");
  const preservedRows = () => list.locator("[data-case-number]").evaluateAll(elements => elements.map(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".case-list-client").forEach(extra => extra.remove());
    return copy.textContent;
  }));
  const originalRows = await preservedRows();
  await expect(list.locator(".case-list-client").first()).toBeVisible();
  expect(originalRows.length).toBeGreaterThan(1);
  const assistance = list.locator('[data-case-number="PM-2026-0516"]');
  await expect(assistance).toContainText("Europe Assistance");
  await expect(assistance).toContainText("BA-771XM");
  await expect(assistance).toContainText("BMW");
  await expect(assistance).toContainText("Mango");
  const search = list.getByRole("textbox");
  await search.fill("PM20260516");
  await expect(list.locator("[data-case-number]")).toHaveCount(1);
  await list.getByRole("button", { name: "Filtre", exact: true }).click();
  for (const label of ["Stav", "Priorita", "Operátor", "Zdroj", "Asistenčná služba"]) await expect(list.getByRole("combobox", { name: label, exact: true })).toBeVisible();
  await list.getByRole("combobox", { name: "Zdroj", exact: true }).selectOption("assistance");
  const sort = list.getByRole("combobox", { name: "Zoradiť prípady", exact: true });
  await sort.selectOption("openTasks");
  await style(page, "classic");
  await expect(search).toHaveValue("PM20260516");
  await expect(list.getByRole("combobox", { name: "Zdroj", exact: true })).toHaveValue("assistance");
  await expect(sort).toHaveValue("openTasks");
  await list.getByRole("button", { name: "Vyčistiť", exact: true }).click();
  await expect(list.locator("[data-case-number]")).toHaveCount(originalRows.length);
  for (const mode of ["classic", "modern"] as const) {
    await style(page, mode);
    for (const key of ["priority", "updatedAt", "openTasks"]) { await sort.selectOption(key); await expect(sort).toHaveValue(key); }
    expect((await preservedRows()).sort()).toEqual([...originalRows].sort());
  }
  await page.locator(".workspace-center-tabs").getByRole("tab", { name: "Tabuľka", exact: true }).click();
  const upper = page.locator(".dispatch-workspace-upper");
  await upper.locator("summary").filter({ hasText: "Stĺpce" }).click();
  await expect(upper.getByRole("checkbox")).toHaveCount(18);
  const branch = upper.getByRole("checkbox", { name: "Pobočka", exact: true });
  await branch.check();
  await style(page, "classic");
  await expect(branch).toBeChecked();
  await noOverflow(page);
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});

test("style changes keep the same unsaved case editor and selected workspace", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByRole("textbox", { name: "EČV", exact: true });
  // Freeze the ordinary autosave debounce: this assertion isolates actions
  // caused by switching appearance from the existing timed draft saver.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await plate.fill("PRESERVE777");
  await editor.evaluate(element => element.setAttribute("data-parity-instance", "same-editor"));
  for (const mode of ["classic", "modern", "classic", "modern"] as const) {
    await style(page, mode);
    await expect(plate).toHaveValue("PRESERVE777");
    await expect(editor).toHaveAttribute("data-parity-instance", "same-editor");
    await expect(page.locator(".dispatch-workspace-shell")).toHaveAttribute("data-workspace-mode", "expanded");
  }
  // A visual toggle never invokes a save; failed-save tests cover save semantics separately.
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("side widths, collapse/restore and lower-panel resize survive the style switch", async ({ page }) => {
  const evidence = await boot(page, 1366, 768);
  const grid = page.locator(".dispatch-dashboard");
  const left = page.getByRole("separator", { name: "Zmeniť šírku stĺpca prípadov", exact: true });
  const right = page.getByRole("separator", { name: "Zmeniť šírku stĺpca úloh a upozornení", exact: true });
  const leftBefore = Number(await left.getAttribute("aria-valuenow"));
  await left.press("ArrowLeft");
  expect(Number(await left.getAttribute("aria-valuenow"))).toBe(leftBefore - 10);
  await drag(page, left, 22);
  const width = await left.getAttribute("aria-valuenow");
  const rightBefore = Number(await right.getAttribute("aria-valuenow"));
  await right.press("ArrowRight");
  expect(Number(await right.getAttribute("aria-valuenow"))).toBe(rightBefore - 10);
  const rightWidth = await right.getAttribute("aria-valuenow");
  await page.getByRole("button", { name: "Zbaliť panel prípadov", exact: true }).click();
  await style(page, "classic");
  await expect(grid).toHaveAttribute("data-left-collapsed", "true");
  await page.getByRole("button", { name: "Obnoviť panel prípadov", exact: true }).click();
  await expect(left).toHaveAttribute("aria-valuenow", width!);
  await expect(right).toHaveAttribute("aria-valuenow", rightWidth!);
  await page.getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
  await style(page, "modern");
  await expect(grid).toHaveAttribute("data-right-collapsed", "true");
  await tools(page);
  await expect(right).toHaveAttribute("aria-valuenow", rightWidth!);
  const lower = page.getByRole("separator", { name: "Potiahnuť a zmeniť výšku spodnej lišty", exact: true });
  const heightBefore = Number(await lower.getAttribute("aria-valuenow"));
  await lower.press("ArrowUp");
  expect(Number(await lower.getAttribute("aria-valuenow"))).toBeGreaterThan(heightBefore);
  await drag(page, lower, 0, -28);
  const savedHeight = await lower.getAttribute("aria-valuenow");
  await style(page, "classic");
  await expect(lower).toHaveAttribute("aria-valuenow", savedHeight!);
  await noOverflow(page);
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});

test("widget calculation and a note draft survive hiding and appearance changes", async ({ page }) => {
  const evidence = await boot(page);
  await tools(page);
  const host = page.getByRole("complementary", { name: "Nástroje", exact: true });
  if (!await host.getByLabel("Kalkulačka", { exact: true }).isVisible()) await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
  await host.getByLabel("Kalkulačka", { exact: true }).check();
  await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
  const calc = host.locator('[data-widget="calculator"]');
  await calc.getByRole("textbox", { name: "Výpočet", exact: true }).fill("(70 − 50) × 2 × 0,75");
  await calc.getByRole("button", { name: "=", exact: true }).click();
  await expect(calc.locator("output")).toHaveText("30");
  await style(page, "classic");
  await expect(calc.getByRole("textbox", { name: "Výpočet", exact: true })).toHaveValue("(70 − 50) × 2 × 0,75");
  await calc.getByRole("button", { name: "Kalkulačka", exact: true }).click();
  await style(page, "modern");
  await calc.getByRole("button", { name: "Kalkulačka", exact: true }).click();
  await expect(calc.locator("output")).toHaveText("30");
  await host.getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
  await page.locator(".workspace-center-tabs").getByRole("tab", { name: "Poznámky", exact: true }).click();
  const notebook = page.locator(".dispatch-workspace-upper").getByRole("region", { name: "Osobné poznámky", exact: true });
  await notebook.getByRole("button", { name: note.title }).click();
  await notebook.getByLabel("Text poznámky").fill("Rozpracované odovzdanie bez straty");
  await style(page, "classic");
  await expect(notebook.getByLabel("Text poznámky")).toHaveValue("Rozpracované odovzdanie bez straty");
  await style(page, "modern");
  await expect(notebook.getByLabel("Text poznámky")).toHaveValue("Rozpracované odovzdanie bez straty");
  expect(evidence.errors).toEqual([]);
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1024, 768], [1280, 720], [1366, 768], [1440, 900]] as const) {
  test(`complete console keeps its working space at ${width}x${height}`, async ({ page }, testInfo) => {
    const evidence = await boot(page, width, height);
    for (const mode of ["modern", "classic"] as const) {
      await style(page, mode);
      await expect(page.getByTestId("dispatch-case-list")).toBeVisible();
      await noOverflow(page);
      if (width >= 1024) {
        if (mode === "modern") {
          const contrast = await page.getByTestId("telephony-not-configured").evaluate(element => {
            const luminance = (color: string) => {
              const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
              return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
            };
            const computed = getComputedStyle(element);
            const foreground = luminance(computed.color), background = luminance(computed.backgroundColor);
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
        }
        const center = page.locator(".dispatch-map-workspace");
        const bounds = (await center.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(475);
        expect(bounds.height).toBeGreaterThan(380);
        const tabs = page.locator(".workspace-center-tabs");
        await tabs.getByRole("tab", { name: "Úlohy", exact: true }).click();
        await expect(page.locator(".dispatch-workspace-upper").getByRole("region", { name: "Tabuľa úloh", exact: true })).toBeVisible();
        const upper = (await page.locator(".dispatch-workspace-upper").boundingBox())!;
        const lower = (await page.locator(".dispatch-workspace-panel").boundingBox())!;
        expect(upper.y + upper.height).toBeLessThanOrEqual(lower.y + 1);
        expect(lower.height).toBeGreaterThan(96);
        if (mode === "modern") await page.screenshot({ path: testInfo.outputPath(`tasks-with-case-${width}x${height}.png`), fullPage: true });
        await tabs.getByRole("tab", { name: "Mapa", exact: true }).click();
      }
      await page.screenshot({ path: testInfo.outputPath(`console-${mode}-${width}x${height}.png`), fullPage: true });
    }
    await tools(page);
    const host = page.getByRole("complementary", { name: "Nástroje", exact: true });
    await expect(host.getByRole("button", { name: "Zbaliť nástroje", exact: true })).toBeVisible();
    if (!await host.getByLabel("Kalkulačka", { exact: true }).isVisible()) await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
  await host.getByLabel("Kalkulačka", { exact: true }).check();
    await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
    const calc = host.locator('[data-widget="calculator"]');
    await calc.getByRole("textbox", { name: "Výpočet", exact: true }).fill("4 × 5");
    await calc.getByRole("button", { name: "=", exact: true }).click();
    await expect(calc.locator("output")).toHaveText("20");
    await noOverflow(page);
    if (width === 390 || width === 1440) {
      await style(page, "modern");
      await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
      await host.getByLabel("Poznámky", { exact: true }).check();
      await host.getByLabel("Kalendár", { exact: true }).check();
      const moveCalculator = host.getByRole("button", { name: "Kalkulačka posunúť vyššie", exact: true });
      for (let move = 0; move < 8 && await moveCalculator.isEnabled(); move++) await moveCalculator.click();
      await host.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
      for (const [id, label] of [["phone", "Rýchle volanie"], ["tasks", "Úlohy"]] as const) {
        const toggle = host.locator(`[data-widget="${id}"]`).getByRole("button", { name: label, exact: true });
        if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
      }
      await calc.scrollIntoViewIfNeeded();
      await expect(calc.locator("output")).toHaveText("20");
      await page.screenshot({ path: testInfo.outputPath(`personal-tools-${width}x${height}.png`), fullPage: true });
      const calendar = host.getByRole("region", { name: "Kalendár úloh", exact: true });
      await host.getByRole("button", { name: "Otvoriť nástroj Kalendár", exact: true }).click();
      const calendarWidget = host.locator('[data-widget="calendar"]');
      const scrollBounds = (await host.locator(".widget-host-scroll").boundingBox())!;
      await expect.poll(async () => (await calendarWidget.boundingBox())!.y).toBeGreaterThanOrEqual(scrollBounds.y);
      await expect(calendarWidget.getByRole("button", {name:"Kalendár", exact:true})).toBeInViewport();
      await expect(calendar.getByRole("button", { name: "Nasledujúci mesiac", exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`calendar-in-console-${width}x${height}.png`), fullPage: true });
    }
    await host.getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
    expect(evidence.errors).toEqual([]);
    expect(evidence.writes).toEqual([]);
  });
}

test("modern SMS opens outgoing composition despite unread history and retains standalone messages", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Otvoriť SMS", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "SMS", exact: true });
  await expect(dialog.getByRole("button", { name: "Napísať SMS", exact: true })).toHaveAttribute("aria-pressed", "true");
  const selectedCase = dialog.getByLabel("Prípad SMS", { exact: true });
  await expect(selectedCase).toBeEnabled();
  await selectedCase.selectOption("");
  await expect(dialog.getByLabel("Telefón príjemcu", { exact: true })).toBeVisible();
  await dialog.getByLabel("Telefón príjemcu", { exact: true }).fill("+421900000010");
  await dialog.getByRole("button", { name: "Odoslané SMS", exact: true }).click();
  await expect(dialog.getByText("Samostatná odoslaná správa", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Bez prípadu", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Napísať SMS", exact: true }).click();
  await expect(dialog.getByLabel("Telefón príjemcu", { exact: true })).toHaveValue("+421900000010");
  await dialog.getByRole("button", { name: "Zavrieť SMS", exact: true }).click();
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});

test("task and chat drafts retain identity when appearance changes", async ({ page }) => {
  const evidence = await boot(page);
  await page.locator(".workspace-center-tabs").getByRole("tab", { name: "Úlohy", exact: true }).click();
  const tasks = page.locator(".dispatch-workspace-upper").getByRole("region", { name: "Pracovný priestor úloh", exact: true });
  await tasks.getByRole("button", { name: task.title, exact: true }).click();
  await tasks.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpracovaná úloha zostane");
  await tasks.getByLabel("Správa k úlohe", { exact: true }).fill("Rozpracovaná správa zostane");
  await tasks.evaluate(element => element.setAttribute("data-parity-instance", "same-tasks"));
  await style(page, "classic");
  await expect(tasks).toHaveAttribute("data-parity-instance", "same-tasks");
  await expect(tasks.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpracovaná úloha zostane");
  await expect(tasks.getByLabel("Správa k úlohe", { exact: true })).toHaveValue("Rozpracovaná správa zostane");
  await style(page, "modern");
  await expect(tasks).toHaveAttribute("data-parity-instance", "same-tasks");
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});

test("appearance reload keeps existing panel preferences and tolerates invalid preference data", async ({ page }) => {
  const evidence = await boot(page);
  const left = page.getByRole("separator", { name: "Zmeniť šírku stĺpca prípadov", exact: true });
  await left.press("ArrowLeft");
  const width = await left.getAttribute("aria-valuenow");
  await page.getByRole("button", { name: "Zbaliť panel prípadov", exact: true }).click();
  await page.evaluate(() => localStorage.setItem("unrelated-preference", "preserve"));
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => !key.startsWith("motorist:layout-preview:"))));
  await style(page, "classic");
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => !key.startsWith("motorist:layout-preview:"))))).toEqual(before);
  await page.reload();
  await mount(page, "classic");
  await expect(page.locator(".dispatch-dashboard")).toHaveAttribute("data-left-collapsed", "true");
  await page.getByRole("button", { name: "Obnoviť panel prípadov", exact: true }).click();
  await expect(left).toHaveAttribute("aria-valuenow", width!);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith("motorist:layout-preview:"))!;
    localStorage.setItem(key, "broken-json-not-a-mode");
  });
  await page.reload();
  await mount(page);
  expect(await page.evaluate(() => localStorage.getItem("unrelated-preference"))).toBe("preserve");
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});

test("denied browser storage still permits appearance switches and ordinary controls", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Storage denied", "SecurityError"); } }));
  const evidence = await boot(page, 1280, 720);
  await style(page, "classic");
  await style(page, "modern");
  await page.getByTestId("dispatch-case-list").getByRole("textbox").fill("PM20260516");
  await expect(page.getByTestId("dispatch-case-list").locator("[data-case-number]")).toHaveCount(1);
  await noOverflow(page);
  expect(evidence.errors).toEqual([]);
  expect(evidence.writes).toEqual([]);
});


test("layout presets and quick tools preserve the selected case and widths", async ({ page }) => {
  const evidence = await boot(page, 1366, 768);
  const left = page.getByRole("separator", { name: "Zmeniť šírku stĺpca prípadov", exact: true });
  const width = await left.getAttribute("aria-valuenow");
  const lower = page.getByRole("separator", { name: "Potiahnuť a zmeniť výšku spodnej lišty", exact: true });
  for (const [name, value] of [["Viac prípadu", 68], ["Viac mapy", 34], ["Vyvážené", 50]] as const) {
    await page.getByLabel("Rozloženie pracovnej plochy", { exact: true }).click();
    await page.getByRole("button", { name: new RegExp(name) }).click();
    await expect(lower).toHaveAttribute("aria-valuenow", String(value));
    await expect(left).toHaveAttribute("aria-valuenow", width!);
  }
  const host = page.getByRole("complementary", { name: "Nástroje", exact: true });
  await host.getByRole("button", { name: "Otvoriť nástroj Kalendár", exact: true }).click();
  await expect(host.locator('[data-widget="calendar"]')).toBeVisible();
  await expect(host.locator('[data-widget="calendar"]')).toHaveAttribute("data-collapsed", "false");
  await expect(left).toHaveAttribute("aria-valuenow", width!);
  await noOverflow(page);
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("text proposals require explicit field selection and detect changed drafts", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByRole("textbox", { name: "EČV", exact: true });
  const originalPlate = await plate.inputValue();
  const importer = page.getByTestId("case-text-import");
  await importer.locator("summary").click();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const source = "EČV: IMPORT123\nMiesto: Nová ulica 12, Bratislava";
  await importer.getByLabel("Pôvodný text", { exact: true }).fill(source);
  await importer.getByRole("button", { name: "Navrhnúť údaje", exact: true }).click();
  await expect(importer.getByRole("button", { name: "Vložiť vybrané údaje (0)", exact: true })).toBeDisabled();
  await expect(plate).toHaveValue(originalPlate);
  await importer.getByRole("checkbox", { name: "EČV", exact: true }).check();
  await plate.fill("MANUAL777");
  await expect(importer.getByRole("alert")).toContainText("medzitým zmenili");
  await expect(importer.getByRole("button", { name: "Vložiť vybrané údaje (1)", exact: true })).toBeDisabled();
  await importer.getByRole("button", { name: "Navrhnúť údaje", exact: true }).click();
  await importer.getByRole("checkbox", { name: "EČV", exact: true }).check();
  await importer.getByRole("button", { name: "Vložiť vybrané údaje (1)", exact: true }).click();
  await expect(plate).toHaveValue("IMPORT123");
  await expect(importer.getByLabel("Pôvodný text", { exact: true })).toHaveValue(source);
  await expect(importer.getByRole("status")).toContainText("Vložené polia: 1");
  await style(page, "classic"); await style(page, "modern");
  await expect(importer.getByLabel("Pôvodný text", { exact: true })).toHaveValue(source);
  expect(evidence.writes).toEqual([]);
  expect(evidence.errors).toEqual([]);
});


test("imported manual address clears stale coordinates and retains unchecked case fields in autosave", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const importer = page.getByTestId("case-text-import");
  await importer.locator("summary").click();
  await importer.getByLabel("Pôvodný text", { exact: true }).fill("Miesto: Nová ulica 12, Bratislava\nEČV: UNCHECKED");
  await importer.getByRole("button", { name: "Navrhnúť údaje", exact: true }).click();
  await importer.getByRole("checkbox", { name: "Miesto incidentu", exact: true }).check();
  const request = page.waitForRequest(request => request.method() === "PATCH" && request.url().endsWith("/api/cases/case-2026-0517"));
  await importer.getByRole("button", { name: "Vložiť vybrané údaje (1)", exact: true }).click();
  const payload = (await request).postDataJSON();
  expect(payload.pickup).toBeNull();
  expect(payload.manualPickupAddress).toBe("Nová ulica 12, Bratislava");
  // Existing autosave sends only changed fields, so unchecked values are omitted.
  expect(payload).not.toHaveProperty("licensePlate");
  expect(payload).not.toHaveProperty("destination");
  expect(payload.mutationId).toBeTruthy();
  expect(evidence.errors).toEqual([]);
});


test("original imported text can be preserved as an exact file without case writes", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const importer = page.getByTestId("case-text-import"); await importer.locator("summary").click();
  const source = "EČV: ABC123\nPôvodný neoznačený text so všetkými podrobnosťami.\n";
  await importer.getByLabel("Pôvodný text", { exact: true }).fill(source);
  const download = page.waitForEvent("download");
  await importer.getByRole("button", { name: "Stiahnuť pôvodný text", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("podklad-pripadu.txt");
  expect(await readFile((await file.path())!, "utf8")).toBe(source);
  expect(evidence.writes).toEqual([]); expect(evidence.errors).toEqual([]);
});
