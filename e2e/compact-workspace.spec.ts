import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { WorkspaceTask } from "../src/domain/task-workspace";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const ownerId = "00000000-0000-4000-8000-000000000002";
const note = { id: "00000000-0000-4000-8000-000000000030", ownerProfileId: ownerId, title: "Odovzdanie zmeny", body: "Uložený obsah poznámky", recipientProfileIds: [], canEdit: true, revision: 1, updatedAt: "2026-09-11T08:00:00Z" };
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/compact-workspace.tsx"], outfile: ".context/compact-workspace-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

function fixtureTasks(): WorkspaceTask[] {
  const now = new Date();
  const today = new Date(now); today.setHours(23, 59, 0, 0);
  return [
    ["Overiť meškajúci odťah", new Date(now.getTime() - 86_400_000).toISOString(), "open", "urgent"],
    ["Potvrdiť dnešné odovzdanie vozidla", today.toISOString(), "open", "normal"],
    ["Objednať náhradné vozidlo na ďalší týždeň", new Date(now.getTime() + 7 * 86_400_000).toISOString(), "open", "normal"],
    ["Doplniť podklady od asistenčnej spoločnosti", "", "open", "normal"],
    ["Zákazníkovi potvrdený príchod technika", "", "done", "normal"],
  ].map(([title, dueAt, status, priority], index) => ({
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, caseId: "", title,
    caseIds: index === 1 ? ["case-2026-0516"] : [],
    caseLinks: index === 1 ? [{ caseId: "case-2026-0516", caseNumber: "PM-2026-0516", status: "assigned" }] : [],
    dueAt, status: status as WorkspaceTask["status"], priority: priority as WorkspaceTask["priority"],
    assignedTo: ownerId, reminderAt: null, kind: "other", revision: 1, originLocked: false, provenance: "manual", origins: [], updatedAt: now.toISOString(),
  }));
}

async function boot(page: Page, width: number) {
  await page.setViewportSize({ width, height: width < 1024 ? 844 : 960 });
  const tasks = fixtureTasks();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://compact-workspace.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (route.request().method() !== "GET") return route.fulfill({ status: 503, json: { error: "Testovací výpadok: rozpracované zmeny zostávajú zachované." } });
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks } });
    if (url.pathname.endsWith("/messages")) return route.fulfill({ json: { messages: [], nextCursor: null } });
    if (url.pathname.startsWith("/api/tasks/")) return route.fulfill({ json: { task: tasks.find(task => url.pathname.endsWith(task.id)) } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [note] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-compact-workspace" } });
    return route.fulfill({ status: 503, json: { error: "Izolovaný test: rozpracované zmeny zostávajú vo formulári." } });
  });
  await page.goto("https://compact-workspace.test/");
  await page.evaluate(tasks => { window.compactFixtureTasks = tasks; }, tasks);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  return { errors, tasks };
}

async function center(page: Page, label: "Mapa" | "Úlohy" | "Poznámky" | "Tabuľka") {
  const tab = page.locator(".workspace-center-tabs").getByRole("tab", { name: label, exact: true });
  await tab.click();
}

async function primary(page: Page, label: "Úlohy" | "Poznámky" | "Nástenka") {
  const navigation = page.getByRole("navigation", { name: "Hlavná navigácia", exact: true });
  if (await navigation.isVisible()) {
    const shortcut = navigation.getByRole("button", { name: label, exact: true });
    if (await shortcut.isVisible()) { await shortcut.click(); return; }
    await navigation.getByRole("button", { name: "Menu", exact: true }).click();
  } else {
    const mobile = page.getByRole("navigation", { name: "Mobilná navigácia", exact: true });
    const shortcut = mobile.getByRole("button", { name: label === "Nástenka" ? "Mapa" : label, exact: true });
    if (await shortcut.isVisible()) { await shortcut.click(); return; }
    await mobile.getByRole("button", { name: "Menu", exact: true }).click();
  }
  await page.getByRole("dialog", { name: "Obrazovky aplikácie", exact: true }).getByRole("button", { name: label, exact: true }).click();
}

async function openTools(page: Page) {
  const trigger = page.locator(".workspace-toolbar").getByRole("button", { name: "Nástroje", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  else {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Nástroje", exact: true }).last().click();
  }
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("center tabs replace only the map area and retain the case and side panels", async ({ page }, testInfo) => {
  const { errors, tasks } = await boot(page, 1440);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByLabel("EČV", { exact: true });
  await plate.fill("KEEP777");
  await editor.evaluate(element => { element.setAttribute("data-draft-instance", "retained"); });
  const cases = page.getByTestId("dispatch-case-list");
  const tools = page.getByRole("complementary", { name: "Nástroje", exact: true });
  const caseListWidth = (await cases.boundingBox())!.width;
  const toolsWidth = (await tools.boundingBox())!.width;
  await center(page, "Úlohy");
  const upper = page.locator(".dispatch-workspace-upper");
  const casePanel = page.locator(".dispatch-workspace-panel");
  const board = upper.getByRole("region", { name: "Tabuľa úloh", exact: true });
  await expect(board).toBeVisible();
  await board.getByRole("button", { name: tasks[0].title, exact: true }).click({ trial: true });
  for (const label of ["Úlohy", "Poznámky", "Tabuľka", "Mapa"] as const) {
    await center(page, label);
    await expect(upper).toBeVisible();
    await expect(casePanel).toBeVisible();
    const upperBounds = (await upper.boundingBox())!;
    const caseBounds = (await casePanel.boundingBox())!;
    expect(upperBounds.height).toBeGreaterThanOrEqual(260);
    expect(upperBounds.y + upperBounds.height).toBeLessThanOrEqual(caseBounds.y + 1);
    expect(caseBounds.height).toBeGreaterThan(96);
    await expect(cases).toBeVisible();
    await expect(tools).toBeVisible();
    expect((await cases.boundingBox())!.width).toBeCloseTo(caseListWidth, 0);
    expect((await tools.boundingBox())!.width).toBeCloseTo(toolsWidth, 0);
    await expect(plate).toHaveValue("KEEP777");
    await expect(editor).toHaveAttribute("data-draft-instance", "retained");
    if (label === "Úlohy") await page.screenshot({ path: testInfo.outputPath("center-tasks-with-case-1440.png"), fullPage: true });
  }
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

for (const width of [390, 1024, 1440]) {
  test(`Tools visibly opens and closes at ${width}px`, async ({ page }) => {
    const { errors } = await boot(page, width);
    if (width < 1024) await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
    const tools = page.getByRole("complementary", { name: "Nástroje", exact: true });
    const trigger = page.locator(".workspace-toolbar").getByRole("button", { name: "Nástroje", exact: true });
    await openTools(page);
    await expect(tools).toBeVisible();
    // Desktop has a persistent quick-widget dock. This click must visibly open
    // its catalog even when that dock was already on screen.
    await expect(tools.locator('[aria-label="Nastavenie widgetov"]')).toBeVisible();
    if (width >= 1024) await expect(page.locator(".workspace-toolbar").getByRole("button", { name: "Nástroje", exact: true })).toHaveAttribute("aria-expanded", "true");
    await tools.getByLabel("Kalkulačka", { exact: true }).check();
    await tools.getByRole("button", { name: "Nastaviť widgety", exact: true }).click();
    const calculator = tools.locator('[data-widget="calculator"]');
    await calculator.getByRole("textbox", { name: "Výpočet" }).fill("21 × 2");
    await calculator.getByRole("button", { name: "=", exact: true }).click();
    await expect(calculator.locator("output")).toHaveText("42");
    if (width >= 1280) await page.locator(".workspace-toolbar").getByRole("button", { name: "Nástroje", exact: true }).click();
    else await tools.getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
    await expect(tools).toBeHidden();
    await openTools(page);
    await expect(calculator.getByRole("textbox", { name: "Výpočet" })).toHaveValue("21 × 2");
    await page.keyboard.press("Escape");
    await expect(tools).toBeHidden();
    await expect(trigger).toBeFocused();
    await expectNoPageOverflow(page);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440, 1920]) {
  test(`compact workspace and task board fit ${width}px`, async ({ page }, testInfo) => {
    const { errors, tasks } = await boot(page, width);
    if (width < 1024) await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
    else await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
    await expect(page.getByRole("region", { name: "Doplnková GPS poloha od klienta", exact: true }).filter({ visible: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`), fullPage: true });
    await expectNoPageOverflow(page);
    await primary(page, "Úlohy");
    const taskPage = page.getByTestId("standalone-tasks-page");
    await expect(taskPage).toBeVisible();
    await expect(page.locator(".dispatch-dashboard")).toBeHidden();
    const board = taskPage.getByRole("region", { name: "Tabuľa úloh", exact: true });
    await expect(board).toBeVisible();
    const columns = ["Po termíne", "Dnes", "Naplánované", "Bez termínu", "Vybavené"];
    for (const [index, column] of columns.entries()) {
      await expect(board.getByRole("region", { name: column, exact: true }).getByRole("button", { name: tasks[index].title, exact: true })).toBeVisible();
    }
    if (width < 1024) {
      await expect(taskPage.getByRole("heading", { name: "Úlohy", exact: true })).toBeVisible();
      const navigation = page.getByRole("navigation", { name: "Mobilná navigácia", exact: true });
      await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(navigation.getByRole("button", { name: "Úlohy", exact: true })).toHaveAttribute("aria-current", "page");
    }
    await page.screenshot({ path: testInfo.outputPath(`tasks-${width}.png`), fullPage: true });
    await expectNoPageOverflow(page);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`center tools and standalone pages preserve case, task and note drafts at ${width}px`, async ({ page }) => {
    const { errors, tasks } = await boot(page, width);
    if (width < 1024) await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
    else await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
    const editor = page.getByTestId("case-edit-form-main");
    await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
    const plate = editor.getByLabel("EČV", { exact: true });
    await plate.fill("NAV777");
    await editor.evaluate(element => { element.setAttribute("data-draft-instance", "navigation-retained"); });

    const upper = page.locator(".dispatch-workspace-upper");
    await center(page, "Poznámky");
    await expect(page.getByTestId("standalone-notes-page")).toBeHidden();
    const centerNotes = upper.getByRole("region", { name: "Osobné poznámky", exact: true });
    await centerNotes.getByRole("button", { name: note.title }).click();
    await centerNotes.getByLabel("Text poznámky").fill("Rozpracované odovzdanie — ponechať pri zmene obrazovky");
    await centerNotes.getByRole("button", { name: "Uložiť", exact: true }).click();
    await expect(centerNotes.getByRole("alert")).toContainText("Zmeny nie sú uložené");

    await center(page, "Úlohy");
    await expect(page.getByTestId("standalone-tasks-page")).toBeHidden();
    const centerTasks = upper.getByRole("region", { name: "Pracovný priestor úloh", exact: true });
    await centerTasks.getByRole("button", { name: tasks[0].title, exact: true }).click();
    await centerTasks.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpracovaná úloha z mapovej plochy");
    await centerTasks.getByLabel("Správa k úlohe", { exact: true }).fill("Rozpracovaná správa ostáva pri zmene pohľadu");
    await centerTasks.getByRole("button", { name: "Uložiť úlohu", exact: true }).click();
    await expect(centerTasks.getByRole("alert")).toContainText("Testovací výpadok");

    await primary(page, "Úlohy");
    const taskPage = page.getByTestId("standalone-tasks-page");
    await expect(taskPage).toBeVisible();
    await expect(page.locator(".dispatch-dashboard")).toBeHidden();
    await expect(page.locator(".workspace-center-tabs").getByRole("tab", { name: "Úlohy", exact: true, includeHidden: true })).toHaveAttribute("aria-selected", "true");
    await expect(taskPage.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpracovaná úloha z mapovej plochy");
    await expect(taskPage.getByLabel("Správa k úlohe", { exact: true })).toHaveValue("Rozpracovaná správa ostáva pri zmene pohľadu");
    await taskPage.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpracovaná úloha zo samostatnej stránky");

    await primary(page, "Poznámky");
    const notePage = page.getByTestId("standalone-notes-page");
    await expect(notePage).toBeVisible();
    await expect(taskPage).toBeHidden();
    await expect(notePage.getByLabel("Text poznámky")).toHaveValue("Rozpracované odovzdanie — ponechať pri zmene obrazovky");
    await notePage.getByLabel("Text poznámky").fill("Odovzdanie doplnené na samostatnej stránke");

    await primary(page, "Nástenka");
    await expect(page.locator(".dispatch-dashboard")).toBeVisible();
    await expect(notePage).toBeHidden();
    await center(page, "Úlohy");
    await expect(centerTasks.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpracovaná úloha zo samostatnej stránky");
    await expect(centerTasks.getByLabel("Správa k úlohe", { exact: true })).toHaveValue("Rozpracovaná správa ostáva pri zmene pohľadu");
    await center(page, "Poznámky");
    await expect(centerNotes.getByLabel("Text poznámky")).toHaveValue("Odovzdanie doplnené na samostatnej stránke");
    await expect(plate).toHaveValue("NAV777");
    await expect(editor).toHaveAttribute("data-draft-instance", "navigation-retained");
    await expect(page.getByRole("dialog", { name: /neuložené zmeny|Rozpracovaný prípad/ })).toHaveCount(0);
    await expectNoPageOverflow(page);
    expect(errors).toEqual([]);
  });

  test(`opening a linked case from the task editor reveals that case at ${width}px`, async ({ page }) => {
    const { errors, tasks } = await boot(page, width);
    if (width < 1024) await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
    else await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
    await center(page, "Úlohy");
    const board = page.getByRole("region", { name: "Tabuľa úloh", exact: true }).filter({ visible: true });
    await board.getByRole("button", { name: tasks[1].title, exact: true }).click();
    await page.getByRole("region", { name: "Prípady úlohy", exact: true }).filter({ visible: true }).getByRole("button", { name: "PM-2026-0516", exact: true }).click();
    await expect(page.locator(".workspace-center-tabs").getByRole("tab", { name: "Mapa", exact: true })).toHaveAttribute("aria-selected", "true");
    if (width >= 1024) await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
    const editor = page.getByTestId("case-edit-form-main");
    await expect(editor).toBeVisible();
    await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
    await expect(editor.getByLabel("EČV", { exact: true })).toHaveValue("BA-771XM");
    if (width < 1024) await expect(page.getByRole("heading", { name: "PM-2026-0516", level: 1, exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    expect(errors).toEqual([]);
  });
}
