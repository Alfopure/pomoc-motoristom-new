import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { DispatchData } from "../src/data/dispatch-types";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/workspace.tsx"], outfile: ".context/workspace-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

const taskId = "00000000-0000-4000-8000-000000000010";
const pushedTaskId = "00000000-0000-4000-8000-000000000011";
const noteId = "00000000-0000-4000-8000-000000000020";
const ownerId = "00000000-0000-4000-8000-000000000002";
const task = { id: taskId, caseId: "", caseIds: [], caseLinks: [], title: "Samostatná testovacia úloha", assignedTo: ownerId, dueAt: "", reminderAt: null, status: "open", priority: "normal", kind: "other", revision: 1, originLocked: false, provenance: "manual", origins: [], updatedAt: "2026-09-10T10:00:00Z" };
type FixtureApi = { archivedCase?: boolean; writesFail: boolean; revoked?: boolean; writes: { path: string; body: Record<string, unknown> }[] };
async function boot(page: Page, width: number, api?: FixtureApi) {
  await page.setViewportSize({ width, height: 900 });
  let revealedPushTask = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://workspace.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (api && (url.pathname.startsWith("/api/notes") || url.pathname.startsWith("/api/tasks"))) {
      if (api.revoked) return route.fulfill({ status: 403, json: { error: "Prístup bol odobratý." } });
      if (route.request().method() !== "GET") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        api.writes.push({ path: url.pathname, body });
        if (api.writesFail) return route.fulfill({ status: 503, json: { error: "Testovací výpadok. Rozpracovaný text zostal zachovaný." } });
        if (url.pathname.endsWith("/messages")) return route.fulfill({ json: { message: { id: "saved-message", taskId, authorProfileId: ownerId, authorName: "Test dispečer", body: body.body, clientMessageId: body.clientMessageId, createdAt: "2026-09-10T10:01:00Z" } } });
        if (url.pathname.startsWith("/api/tasks")) return route.fulfill({ json: { task: { ...task, ...body, revision: 2 } } });
        return route.fulfill({ json: { note: { id: noteId, ownerProfileId: ownerId, title: "Moja testovacia poznámka", body: "Uložený obsah", recipientProfileIds: [], canEdit: true, ...body, revision: 2, updatedAt: "2026-09-10T10:01:00Z" } } });
      }
      if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: revealedPushTask ? [task, { ...task, id: pushedTaskId, title: "Nová úloha z pushu" }] : [task] } });
      if (url.pathname.endsWith("/messages")) return route.fulfill({ json: { messages: [], nextCursor: null } });
      if (url.pathname.startsWith("/api/tasks/")) {
        if (url.pathname.endsWith(pushedTaskId)) revealedPushTask = true;
        return route.fulfill({ json: { task: url.pathname.endsWith(pushedTaskId) ? { ...task, id: pushedTaskId, title: "Nová úloha z pushu" } : task } });
      }
      if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [{ id: noteId, ownerProfileId: ownerId, title: "Moja testovacia poznámka", body: "Uložený obsah", revision: 1, updatedAt: "2026-09-10T10:00:00Z", recipientProfileIds: [], canEdit: true }] } });
      return route.fulfill({ json: { colleagues: [] } });
    }
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (api && url.pathname.startsWith("/api/cases/") && route.request().method() === "PATCH") api.writes.push({ path: url.pathname, body: route.request().postDataJSON() });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-workspace" } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture: service unavailable" } });
  });
  await page.goto(`https://workspace.test/${api ? `?workspace=1${api.archivedCase ? "&archive=1" : ""}` : ""}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  return errors;
}

async function openTools(page: Page, width: number) {
  if (width >= 1024) await page.getByRole("button", { name: "Nástroje", exact: true }).first().click();
  else {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Nástroje", exact: true }).last().click();
  }
}

for (const width of [360, 390, 768, 1024, 1279, 1280, 1440]) {
  test(`widget controls and calculation remain reachable at ${width}px`, async ({ page }) => {
    const errors = await boot(page, width);
    await openTools(page, width);
    const tools = page.getByRole("complementary", { name: "Nástroje", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("region", { name: "Nastavenie widgetov" })).toBeVisible();
    await tools.getByLabel("Kalkulačka", { exact: true }).check();
    await tools.getByRole("button", { name: "Kalkulačka posunúť vyššie" }).click();
    await tools.getByRole("button", { name: "Nastaviť widgety" }).click();
    const calculator = tools.locator('[data-widget="calculator"]');
    await calculator.getByRole("textbox", { name: "Výpočet" }).fill("(70 − 50) × 2 × 0,75");
    await calculator.getByRole("button", { name: "=", exact: true }).click();
    await expect(calculator.locator("output")).toHaveText("30");
    await tools.getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
    await openTools(page, width);
    await expect(calculator.getByRole("textbox", { name: "Výpočet" })).toHaveValue("(70 − 50) × 2 × 0,75");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("desktop side handles restore the previous width and persist widget order", async ({ page }) => {
  const errors = await boot(page, 1440);
  const grid = page.locator(".dispatch-dashboard");
  const width = await grid.evaluate(element => (element as HTMLElement).style.getPropertyValue("--dashboard-left-width"));
  await page.getByRole("button", { name: "Zbaliť panel prípadov" }).click();
  await expect(grid).toHaveAttribute("data-left-collapsed", "true");
  await page.getByRole("button", { name: "Obnoviť panel prípadov" }).click();
  expect(await grid.evaluate(element => (element as HTMLElement).style.getPropertyValue("--dashboard-left-width"))).toBe(width);
  expect(errors).toEqual([]);
});


async function center(page: Page, name: "Poznámky" | "Úlohy") {
  const navigation = page.getByRole("tab", { name, exact: true }).filter({ visible: true });
  if (await navigation.count()) await navigation.first().click();
  else {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).last().click();
  }
}
async function sendTaskPush(page: Page, requestId: string, targetTaskId = taskId) {
  await page.evaluate(({ taskId, requestId }) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "PM_OPEN_NOTIFICATION", url: `/?task=${taskId}`, requestId } })), { taskId: targetTaskId, requestId });
}

test("note, task and chat drafts persist across center/widget/mobile transitions after failed save", async ({ page }) => {
  const api: FixtureApi = { writesFail: true, writes: [] };
  const errors = await boot(page, 1440, api);
  await center(page, "Poznámky");
  const notes = page.getByRole("region", { name: "Osobné poznámky" }).filter({ visible: true });
  await notes.getByRole("button", { name: "Moja testovacia poznámka" }).click();
  await notes.getByLabel("Text poznámky").fill("Súkromný rozpracovaný text — nezahodiť");
  await expect(notes.getByRole("alert")).toContainText("Zmeny nie sú uložené");
  await center(page, "Úlohy");
  const tasks = page.getByRole("region", { name: "Pracovný priestor úloh", exact: true }).filter({ visible: true });
  await tasks.getByRole("button", { name: task.title, exact: true }).click();
  await tasks.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpracovaná samostatná úloha");
  await tasks.getByLabel("Správa k úlohe", { exact: true }).fill("Rozpracovaná tímová správa");
  await tasks.getByRole("button", { name: "Uložiť úlohu", exact: true }).click();
  await expect(tasks.getByRole("alert")).toContainText("Testovací výpadok");
  await openTools(page, 1440);
  await page.getByRole("complementary", { name: "Nástroje", exact: true }).getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await center(page, "Poznámky");
  await expect(notes.getByLabel("Text poznámky")).toHaveValue("Súkromný rozpracovaný text — nezahodiť");
  await center(page, "Úlohy");
  await expect(tasks.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpracovaná samostatná úloha");
  await expect(tasks.getByLabel("Správa k úlohe", { exact: true })).toHaveValue("Rozpracovaná tímová správa");
  await tasks.getByRole("button", { name: "Odoslať správu", exact: true }).click();
  await expect(tasks.getByRole("button", { name: "Overiť a zopakovať odoslanie" })).toBeVisible();
  const firstMessage = api.writes.find(write => write.path.endsWith("/messages"))!;
  api.writesFail = false;
  await tasks.getByRole("button", { name: "Overiť a zopakovať odoslanie" }).click();
  await expect(tasks.getByRole("log", { name: "Správy úlohy" })).toContainText("Rozpracovaná tímová správa");
  expect(api.writes.filter(write => write.path.endsWith("/messages")).map(write => write.body.clientMessageId)).toEqual([firstMessage.body.clientMessageId, firstMessage.body.clientMessageId]);
  expect(errors).toEqual([]);
});

test("task push ACK and duplicate handling preserve dirty note through failed save guard", async ({ page }) => {
  const api: FixtureApi = { writesFail: true, writes: [] };
  const errors = await boot(page, 390, api);
  await center(page, "Poznámky");
  const notes = page.getByRole("region", { name: "Osobné poznámky" }).filter({ visible: true });
  await notes.getByRole("button", { name: "Moja testovacia poznámka" }).click();
  await notes.getByLabel("Text poznámky").fill("Draft pred pushom");
  await expect(notes.getByRole("alert")).toContainText("Zmeny nie sú uložené");
  await sendTaskPush(page, "exact-task-push");
  const guard = page.getByRole("dialog", { name: "Na karte sú neuložené zmeny" });
  await expect(guard).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { fixtureAcknowledgments: unknown[] }).fixtureAcknowledgments)).toContainEqual({ type: "PM_NOTIFICATION_ACK", requestId: "exact-task-push" });
  await guard.getByRole("button", { name: "Uložiť a odísť", exact: true }).click();
  await expect(guard).toBeVisible();
  await expect(notes.getByLabel("Text poznámky")).toHaveValue("Draft pred pushom");
  await guard.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await sendTaskPush(page, "exact-task-push");
  await expect(guard).toBeHidden();
  await sendTaskPush(page, "exact-task-push-second", pushedTaskId);
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pracovný priestor úloh", exact: true }).filter({ visible: true }).getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Nová úloha z pushu");
  expect(errors).toEqual([]);
});

test("a later notification reopens the same task after a different manual selection", async ({ page }) => {
  const errors = await boot(page, 1440, { writesFail: false, writes: [] });
  const tasks = page.getByRole("region", { name: "Pracovný priestor úloh", exact: true }).filter({ visible: true });
  const title = tasks.getByRole("textbox", { name: "Názov úlohy", exact: true });
  await sendTaskPush(page, "repeat-task-first", pushedTaskId);
  await expect(title).toHaveValue("Nová úloha z pushu");
  await tasks.getByRole("button", { name: "Späť na úlohy", exact: true }).click();
  await tasks.getByRole("button", { name: task.title, exact: true }).click();
  await expect(title).toHaveValue(task.title);
  await sendTaskPush(page, "repeat-task-second", pushedTaskId);
  await expect(title).toHaveValue("Nová úloha z pushu");
  expect(errors).toEqual([]);
});

test("desktop center tabs reveal tools while retaining the expanded case editor", async ({ page }) => {
  const errors = await boot(page, 1440, { writesFail: false, writes: [] });
  const editor = page.getByTestId("case-edit-form-main");
  await editor.evaluate(element => { element.setAttribute("data-retained-editor", "yes"); });
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  for (const view of ["Úlohy", "Poznámky"] as const) {
    await expect(page.locator(".dispatch-workspace-shell")).toHaveAttribute("data-workspace-mode", "expanded");
    await page.getByRole("tab", { name: view, exact: true }).click();
    await expect(page.locator(".dispatch-workspace-shell")).toHaveAttribute("data-workspace-mode", "expanded");
    const control = view === "Úlohy"
      ? page.getByRole("region", { name: "Pracovný priestor úloh", exact: true }).getByRole("button", { name: task.title, exact: true })
      : page.getByRole("region", { name: "Osobné poznámky", exact: true }).filter({ visible: true }).getByRole("button", { name: "Moja testovacia poznámka" });
    await control.click({ trial: true });
    await expect(editor).toHaveAttribute("data-retained-editor", "yes");
  }
  expect(errors).toEqual([]);
});

test("successful case completion retains newer typing and saves it to the same case", async ({ page }) => {
  const errors = await boot(page, 1440, { writesFail: false, writes: [] });
  let canonical = await page.evaluate(() => (window as unknown as { workspaceFixtureData: DispatchData }).workspaceFixtureData);
  let release!: () => void;
  const firstResponse = new Promise<void>(resolve => { release = resolve; });
  const writes: { path: string; body: { status?: DispatchData["dispatchCases"][number]["status"]; licensePlate?: string; expectedUpdatedAt?: string } }[] = [];
  await page.route("**/api/cases/*", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "PATCH") return route.fulfill({ json: { dispatchData: canonical } });
    const body = route.request().postDataJSON() as typeof writes[number]["body"];
    writes.push({ path: url.pathname, body });
    if (writes.length === 1) await firstResponse;
    const caseId = url.pathname.split("/")[3];
    const updatedAt = new Date(Date.parse("2026-09-10T11:00:00Z") + writes.length * 1000).toISOString();
    canonical = { ...canonical, source: "supabase", dispatchCases: canonical.dispatchCases.map(item => item.id !== caseId ? item : {
      ...item, updatedAt, status: body.status ?? item.status, vehicle: { ...item.vehicle, licensePlate: body.licensePlate ?? item.vehicle.licensePlate },
    }) };
    return route.fulfill({ json: { dispatchData: canonical, committedRevision: updatedAt } });
  });
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  const plate = editor.getByLabel("EČV", { exact: true });
  await editor.evaluate(element => { element.setAttribute("data-retained-editor", "yes"); });
  await page.getByLabel("Stav prípadu v hlavičke").selectOption("completed_assisted");
  await expect.poll(() => writes.length).toBe(1);
  await plate.fill("NEWER77");
  release();
  await expect(editor).toHaveAttribute("data-retained-editor", "yes");
  await expect(plate).toHaveValue("NEWER77");
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].path).toBe(writes[0].path);
  expect(writes[1].body).toEqual({ licensePlate: "NEWER77", expectedUpdatedAt: "2026-09-10T11:00:01.000Z" });
  await expect(plate).toHaveValue("NEWER77");
  expect(errors).toEqual([]);
});

test("revoked session clears visible private notes and task/chat drafts on resume", async ({ page }) => {
  const api: FixtureApi = { writesFail: true, writes: [] };
  const errors = await boot(page, 390, api);
  await center(page, "Poznámky");
  const notes = page.getByRole("region", { name: "Osobné poznámky" }).filter({ visible: true });
  await notes.getByRole("button", { name: "Moja testovacia poznámka" }).click();
  await notes.getByLabel("Text poznámky").fill("Tajný draft pred odobratím prístupu");
  await center(page, "Úlohy");
  const tasks = page.getByRole("region", { name: "Pracovný priestor úloh", exact: true }).filter({ visible: true });
  await tasks.getByRole("button", { name: task.title, exact: true }).click();
  await tasks.getByLabel("Správa k úlohe", { exact: true }).fill("Draft pre pôvodnú reláciu");
  api.revoked = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(tasks).toContainText("Overujem prístup");
  await expect(page.getByLabel("Správa k úlohe", { exact: true })).toHaveCount(0);
  await center(page, "Poznámky");
  await expect(notes).toContainText("Prístup k poznámkam treba znovu overiť");
  await expect(page.getByLabel("Text poznámky")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("Tajný draft");
  expect(errors).toEqual([]);
});

test("case form draft remains mounted while using notebook and mobile tools", async ({ page }) => {
  const api: FixtureApi = { writesFail: true, writes: [] };
  const errors = await boot(page, 390, api);
  await page.getByRole("button", { name: "Nový prípad", exact: true }).first().click();
  const plate = page.getByLabel("EČV", { exact: true });
  await plate.fill("DRAFT77");
  await center(page, "Poznámky");
  await expect(plate).toHaveValue("DRAFT77");
  await openTools(page, 390);
  await expect(plate).toHaveValue("DRAFT77");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("complementary", { name: "Nástroje", exact: true }).getByRole("button", { name: "Zbaliť nástroje", exact: true }).click();
  await expect(plate).toHaveValue("DRAFT77");
  expect(errors).toEqual([]);
});


test("explicit case discard resets the mounted draft and cannot autosave it after reopening", async ({ page }) => {
  await page.clock.install();
  const api: FixtureApi = { writesFail: true, writes: [] };
  const errors = await boot(page, 390, api);
  await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
  const plate = page.getByLabel("EČV", { exact: true });
  const original = await plate.inputValue();
  await page.getByText("3. Vozidlo a incident", { exact: true }).click();
  await plate.fill("DISCARD77");
  await page.clock.runFor(1_300);
  await expect.poll(() => api.writes.filter(write => write.path.startsWith("/api/cases/")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Nastavenia", exact: true }).last().click();
  const guard = page.getByRole("dialog", { name: "Na karte sú neuložené zmeny" });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  const afterDiscard = api.writes.length;
  await page.getByRole("navigation", { name: "Mobilná navigácia" }).getByRole("button", { name: "Prípady", exact: true }).click();
  await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
  await expect(plate).toHaveValue(original);
  await page.clock.runFor(2_000);
  expect(JSON.stringify(api.writes.slice(afterDiscard))).not.toContain("DISCARD77");
  expect(errors).toEqual([]);
});


test("completed case keeps its dirty editor when mobile map replaces the visible card", async ({ page }) => {
  const api: FixtureApi = { archivedCase: true, writesFail: true, writes: [] };
  const errors = await boot(page, 390, api);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Prípady", exact: true }).last().click();
  await page.getByRole("button", { name: "História (1)", exact: true }).click();
  await page.getByRole("button", { name: "Otvoriť prípad PM-2026-0514", exact: true }).click();
  const plate = page.getByLabel("EČV", { exact: true });
  await page.getByText("3. Vozidlo a incident", { exact: true }).click();
  await plate.fill("ARCHIVE77");
  await page.getByRole("navigation", { name: "Mobilná navigácia" }).getByRole("button", { name: "Mapa", exact: true }).click();
  await expect(plate).toHaveValue("ARCHIVE77");
  await page.getByRole("button", { name: "Skryť mapu a zobraziť prípad", exact: true }).click();
  await expect(page.getByRole("heading", { name: "PM-2026-0514", exact: true })).toBeVisible();
  await expect(plate).toHaveValue("ARCHIVE77");
  expect(errors).toEqual([]);
});
