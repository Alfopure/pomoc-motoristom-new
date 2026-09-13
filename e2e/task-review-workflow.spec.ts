import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { WorkspaceTask } from "../src/domain/task-workspace";
import type { TaskWorkflowCommand } from "../src/domain/task-workflow";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOLVER = "11111111-1111-4111-8111-111111111111", REVIEWER = "22222222-2222-4222-8222-222222222222", OTHER = "33333333-3333-4333-8333-333333333333";
let script: string, css: string;
test.use({ timezoneId: "Europe/Bratislava" });
test.beforeAll(async () => {
  const output = (await build({ entryPoints: ["e2e/fixtures/task-review-workflow.tsx"], bundle: true, write: false, outfile: "fixture.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles;
  script = output.find(file => file.path.endsWith(".js"))!.text;
  css = output.find(file => file.path.endsWith(".css"))!.text + (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
  await mkdir(".context/redesign-v2-task-screenshots", { recursive: true });
});
async function boot(page: Page, width = 1366, height = 768, query = "") {
  const requests: { path: string; method: string; body: Record<string, unknown> | null }[] = [], errors: string[] = [];
  const state = { tasks: [] as WorkspaceTask[], actor: SOLVER, loseOnce: false, rejectOnce: false, workflowEnabled: true, notifications: [] as { taskId: string; recipient: string; cycle: number }[], messages: [] as Record<string, unknown>[], commands: new Map<string, { input: string; committedRevision: number }>() };
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height }); await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://task-review.test") { errors.push(`External request ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div></body></html>' });
    const method = route.request().method(), body = route.request().postData() ? route.request().postDataJSON() : null;
    requests.push({ path: url.pathname, method, body });
    if (!state.tasks.length) state.tasks = await page.evaluate(() => (window as unknown as { taskReviewFixture: { tasks: WorkspaceTask[] } }).taskReviewFixture.tasks);
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: state.tasks, workflowEnabled: state.workflowEnabled } });
    const task = state.tasks.find(task => url.pathname.includes(task.id));
    if (url.pathname.endsWith("/messages")) {
      if (method === "POST") { const message = { id: `message-${state.messages.length}`, taskId: task?.id, authorName: "Testovací kolega", authorProfileId: state.actor, createdAt: "2026-09-12T12:00:00Z", ...body }; state.messages.push(message); return route.fulfill({ json: { message } }); }
      return route.fulfill({ json: { messages: state.messages.filter(message => message.taskId === task?.id), nextCursor: null } });
    }
    if (task && url.pathname.endsWith("/workflow") && method === "POST") {
      const command = body as TaskWorkflowCommand, saved = state.commands.get(command.commandId);
      if (saved) return route.fulfill({ json: { task, commandId: command.commandId, committedRevision: saved.committedRevision } });
      if (state.rejectOnce || task.revision !== command.expectedRevision) { state.rejectOnce = false; return route.fulfill({ status: 409, json: { error: "Úloha sa medzitým zmenila." } }); }
      if (command.action === "submit_review") {
        if (!command.comment?.trim() || !command.reviewerProfileId || [state.actor, task.assignedTo].includes(command.reviewerProfileId)) return route.fulfill({ status: 400, json: { error: "Skontrolujte kontrolóra a výsledok." } });
        task.workflowState = "in_review"; task.reviewerProfileId = command.reviewerProfileId; task.reviewSubmission = command.comment; task.reviewRequestedBy = state.actor; task.reviewRequestedAt = "2026-09-12T12:00:00Z"; task.reviewGeneration = (task.reviewGeneration ?? 0) + 1; task.reviewReturnReason = null;
        state.notifications.push({ taskId: task.id, recipient: command.reviewerProfileId, cycle: task.reviewGeneration });
      } else if (command.action === "approve" || command.action === "return") {
        if (task.workflowState !== "in_review" || task.reviewerProfileId !== state.actor) return route.fulfill({ status: 403, json: { error: "Úlohu môže skontrolovať iba určený kontrolór." } });
        if (command.action === "return") { if (!command.comment?.trim()) return route.fulfill({ status: 400, json: { error: "Doplňte dôvod." } }); task.workflowState = "in_progress"; task.reviewReturnReason = command.comment; }
        else { task.workflowState = "done"; task.status = "done"; task.reviewedBy = state.actor; task.reviewedAt = "2026-09-12T12:00:00Z"; }
      } else if (command.action === "complete") {
        if (task.reviewerProfileId) return route.fulfill({ status: 409, json: { error: "Úloha musí prejsť kontrolou." } });
        task.status = "done"; task.workflowState = "done";
      } else { task.workflowState = command.action === "start" ? "in_progress" : "todo"; task.status = "open"; }
      task.revision++; state.commands.set(command.commandId, { input: JSON.stringify(command), committedRevision: task.revision });
      if (command.comment) state.messages.push({ id: `event-${state.commands.size}`, taskId: task.id, body: command.comment, authorName: "Testovací kolega", authorProfileId: state.actor, createdAt: "2026-09-12T12:00:00Z", clientMessageId: command.commandId });
      if (state.loseOnce) { state.loseOnce = false; return route.abort("failed"); }
      return route.fulfill({ json: { task, commandId: command.commandId, committedRevision: task.revision } });
    }
    if (task && method === "PATCH") { const { expectedRevision, ...patch } = body; if (expectedRevision !== task.revision) return route.fulfill({ status: 409, json: { error: "Súbežná zmena" } }); Object.assign(task, patch, { revision: task.revision + 1 }); return route.fulfill({ json: { task } }); }
    if (task && method === "GET") return route.fulfill({ json: { task } });
    errors.push(`Unexpected ${method} ${url.pathname}`); return route.abort();
  });
  async function load() { const before = requests.filter(request => request.path === "/api/tasks").length; await page.goto(`https://task-review.test/${query}`); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script }); await expect(page.getByRole("button", { name: "Na moju kontrolu" })).toBeVisible(); await expect.poll(() => requests.filter(request => request.path === "/api/tasks").length).toBeGreaterThan(before); await expect(page.getByRole("button", { name: "Obnoviť úlohy" })).toBeEnabled(); }
  async function actor(id: string) { const before = requests.filter(request => request.path === "/api/tasks").length; state.actor = id; await page.getByLabel("Testovacia rola").selectOption(id); await expect.poll(() => requests.filter(request => request.path === "/api/tasks").length).toBeGreaterThan(before); await expect(page.getByRole("button", { name: "Obnoviť úlohy" })).toBeEnabled(); }
  await load();
  return { state, requests, errors, load, actor };
}
const card = (page: Page, id = TASK) => page.locator(`[data-task-id="${id}"]`);
async function sendForReview(page: Page, result = "Vozidlo aj pristavenie sú overené.") {
  await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Poslať na kontrolu", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Poslať na kontrolu" });
  await dialog.getByLabel("Kto má úlohu skontrolovať").selectOption(REVIEWER);
  await dialog.getByLabel("Výsledok a pokyn na kontrolu").fill(result);
  await dialog.getByRole("button", { name: "Odoslať na kontrolu", exact: true }).click();
}

test("full review cycle persists stage, recipients, return reason and approval with existing task data", async ({ page }) => {
  const fixture = await boot(page), before = structuredClone(fixture.state.tasks.find(task => task.id === TASK)!);
  await card(page).getByRole("button", { name: "Začať riešiť úlohu" }).click();
  await expect(page.locator('[data-task-column="in_progress"]').locator(`[data-task-id="${TASK}"]`)).toBeVisible();
  await sendForReview(page); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.state.notifications).toEqual([{ taskId: TASK, recipient: REVIEWER, cycle: 1 }]);
  await fixture.actor(REVIEWER); await page.getByRole("button", { name: "Na moju kontrolu" }).click();
  await card(page).getByRole("button", { name: "Vrátiť na dopracovanie úlohu" }).click();
  let dialog = page.getByRole("dialog", { name: "Vrátiť na dopracovanie" });
  await dialog.getByRole("button", { name: "Vrátiť úlohu", exact: true }).click(); await expect(dialog.getByRole("alert")).toHaveText("Napíšte, čo treba dopracovať.");
  await dialog.getByLabel("Čo treba dopracovať").fill("Doplňte presný čas pristavenia."); await dialog.getByRole("button", { name: "Vrátiť úlohu", exact: true }).click();
  await fixture.actor(SOLVER); await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await expect(page.getByRole("region", { name: "Priebeh a kontrola úlohy" })).toContainText("Doplňte presný čas pristavenia.");
  await expect(page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Vybaviť", exact: true })).toHaveCount(0);
  await page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Poslať na kontrolu", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Poslať na kontrolu" }); await expect(dialog.getByLabel("Kto má úlohu skontrolovať")).toHaveValue(REVIEWER);
  await dialog.getByLabel("Výsledok a pokyn na kontrolu").fill("Pristavenie je potvrdené o 14:30."); await dialog.getByRole("button", { name: "Odoslať na kontrolu" }).click();
  await fixture.actor(REVIEWER); await page.getByRole("button", { name: "Na moju kontrolu" }).click();
  await card(page).getByRole("button", { name: "Schváliť úlohu" }).click();
  await expect(card(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Všetky tímové" }).click(); await page.getByLabel("Zobraziť úlohy").selectOption("done");
  await expect(card(page)).toBeVisible();
  expect(fixture.state.tasks.find(task => task.id === TASK)).toMatchObject({ status: "done", workflowState: "done", reviewedBy: REVIEWER, reviewGeneration: 2, dueAt: before.dueAt, reminderAt: before.reminderAt, assignedTo: before.assignedTo, caseIds: before.caseIds });
  await fixture.load(); await page.getByLabel("Zobraziť úlohy").selectOption("done"); await expect(card(page)).toBeVisible();
  expect(fixture.state.notifications).toHaveLength(2); expect(fixture.errors).toEqual([]);
});

test("review submission rejects missing values and excludes self and assigned solver", async ({ page }) => {
  const fixture = await boot(page);
  await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Poslať na kontrolu", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: "Riešiteľ Peter" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Odoslať na kontrolu" }).click(); await expect(dialog.getByRole("alert")).toContainText("Vyberte iného");
  await dialog.getByLabel("Kto má úlohu skontrolovať").selectOption(REVIEWER);
  await dialog.getByRole("button", { name: "Odoslať na kontrolu" }).click(); await expect(dialog.getByRole("alert")).toContainText("Doplňte výsledok");
  expect(fixture.requests.filter(request => request.path.endsWith("/workflow"))).toEqual([]);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); expect(fixture.errors).toEqual([]);
});

test("lost response retries one command and produces one review notification", async ({ page }) => {
  const fixture = await boot(page); fixture.state.loseOnce = true;
  await sendForReview(page);
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "Overiť pôvodný pokus" })).toBeEnabled();
  await expect(dialog.getByLabel("Výsledok a pokyn na kontrolu")).toBeDisabled();
  await dialog.getByRole("button", { name: "Overiť pôvodný pokus" }).click(); await expect(dialog).toHaveCount(0);
  const commands = fixture.requests.filter(request => request.path.endsWith("/workflow")); expect(commands).toHaveLength(2); expect(commands[1].body).toEqual(commands[0].body);
  expect(fixture.state.notifications).toHaveLength(1); expect(fixture.errors).toEqual([]);
});

test("a review draft retains its original revision when polling observes a colleague edit", async ({ page }) => {
  const fixture = await boot(page);
  await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Poslať na kontrolu", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByLabel("Kto má úlohu skontrolovať").selectOption(REVIEWER); await dialog.getByLabel("Výsledok a pokyn na kontrolu").fill("Rozpísaný výsledok na kontrolu.");
  const current = fixture.state.tasks.find(task => task.id === TASK)!; current.title = "Zmenené kolegom počas písania"; current.revision++;
  const reads = fixture.requests.filter(request => request.path === "/api/tasks").length;
  await page.clock.fastForward(30_000); await expect.poll(() => fixture.requests.filter(request => request.path === "/api/tasks").length).toBeGreaterThan(reads);
  await expect(dialog).toContainText("Zmenené kolegom počas písania");
  await dialog.getByRole("button", { name: "Odoslať na kontrolu", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Úloha sa medzitým zmenila."); await expect(dialog.getByLabel("Výsledok a pokyn na kontrolu")).toHaveValue("Rozpísaný výsledok na kontrolu.");
  expect(fixture.requests.find(request => request.path.endsWith("/workflow"))?.body?.expectedRevision).toBe(1);
  expect(current).toMatchObject({ workflowState: "todo", reviewerProfileId: null, revision: 2 }); expect(fixture.state.notifications).toEqual([]); expect(fixture.errors).toEqual([]);
});

test("unassigned colleague cannot see approval controls and review remains a visible state", async ({ page }) => {
  const fixture = await boot(page); await sendForReview(page); await expect(page.getByRole("dialog")).toHaveCount(0);
  await fixture.actor(OTHER);
  await expect(card(page)).toContainText("Na kontrolu"); await expect(card(page)).toContainText("Kontrolór Jana");
  await expect(card(page).getByRole("button", { name: "Schváliť úlohu" })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Vybaviť úlohu" })).toHaveCount(0);
  await page.getByRole("button", { name: "Na moju kontrolu" }).click(); await expect(card(page)).toHaveCount(0); expect(fixture.errors).toEqual([]);
});

test("keyboard board movement changes work stage without changing the date or reminder", async ({ page }) => {
  const fixture = await boot(page), before = structuredClone(fixture.state.tasks.find(task => task.id === TASK)!);
  await card(page).getByRole("button", { name: "Presunúť úlohu" }).focus();
  await page.keyboard.press("Space", { delay: 20 }); await expect(page.locator('[data-task-column="in_progress"]')).toHaveAttribute("data-drop-allowed", "true");
  await page.keyboard.press("ArrowRight"); await expect(page.locator('[data-task-column="in_progress"]')).toHaveAttribute("data-drop-over", "true"); await page.keyboard.press("Space");
  await expect(page.locator('[data-task-column="in_progress"]').locator(`[data-task-id="${TASK}"]`)).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Presunúť úlohu" })).toBeFocused();
  expect(fixture.state.tasks.find(task => task.id === TASK)).toMatchObject({ workflowState: "in_progress", dueAt: before.dueAt, reminderAt: before.reminderAt }); expect(fixture.errors).toEqual([]);
});

test("pointer drop to review opens a real review request and cancellation makes no mutation", async ({ page }) => {
  const fixture = await boot(page);
  const handle = await card(page).getByRole("button", { name: "Presunúť úlohu" }).boundingBox();
  const target = await page.locator('[data-task-column="in_review"]').boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2); await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 10, handle!.y + handle!.height / 2, { steps: 3 });
  await expect(page.locator('[data-task-column="in_review"]')).toHaveAttribute("data-drop-allowed", "true");
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 90, { steps: 12 });
  await expect(page.locator('[data-task-column="in_review"]')).toHaveAttribute("data-drop-over", "true"); await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "Poslať na kontrolu" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path.endsWith("/workflow"))).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "Zrušiť", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(fixture.state.tasks.find(task => task.id === TASK)?.workflowState).toBe("todo"); expect(fixture.errors).toEqual([]);
});

test("date filters and shared task/chat drafts remain usable in the new board", async ({ page }) => {
  const fixture = await boot(page);
  await page.getByRole("combobox", { name: "Termín", exact: true }).selectOption("overdue"); await expect(card(page)).toHaveCount(0); await expect(page.getByRole("button", { name: "Potvrdiť detaily s klientom", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Termín", exact: true }).selectOption("all"); await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await page.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpísaný nový názov"); await page.getByRole("textbox", { name: "Správa k úlohe", exact: true }).fill("Rozpísaný komentár");
  await page.getByRole("button", { name: "Prepnúť pracovný pohľad" }).click();
  await expect(page.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpísaný nový názov"); await expect(page.getByRole("textbox", { name: "Správa k úlohe", exact: true })).toHaveValue("Rozpísaný komentár");
  await expect(page.getByRole("region", { name: "Prípady úlohy" })).toContainText("PM-2026-101"); await expect(page.getByRole("region", { name: "Prípady úlohy" })).toContainText("PM-2026-102");
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]); expect(fixture.errors).toEqual([]);
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1280, 720], [1366, 768]]) test(`workflow board and review form remain usable at ${width}x${height}`, async ({ page }) => {
  const fixture = await boot(page, width, height);
  await expect(page.locator('[data-task-column="todo"]')).toBeVisible(); await expect(page.locator('[data-task-column="in_review"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/redesign-v2-task-screenshots/board-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "Overiť pristavenie vozidla", exact: true }).click();
  await page.getByRole("region", { name: "Priebeh a kontrola úlohy" }).getByRole("button", { name: "Poslať na kontrolu", exact: true }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog.getByLabel("Kto má úlohu skontrolovať")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/redesign-v2-task-screenshots/review-${width}.png`, fullPage: true });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); expect(fixture.errors).toEqual([]);
});

for (const [panelWidth, widget] of [[700, false], [320, true]] as const) test(`compact ${widget ? "widget" : "embedded board"} exposes task actions at 300px height and retains collapsed filters`, async ({ page }) => {
  const fixture = await boot(page, 1366, 768, `?compact=true&panelHeight=300&panelWidth=${panelWidth}${widget ? "&widget=true" : ""}`);
  const panel = page.getByRole("region", { name: widget ? "Widget úloh" : "Pracovný priestor úloh", exact: true });
  const action = card(page).getByRole("button", { name: "Začať riešiť úlohu" });
  await expect(action).toBeInViewport();
  const panelBounds = await panel.boundingBox(), actionBounds = await action.boundingBox();
  expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height);
  await expect(panel.getByRole("combobox", { name: "Termín", exact: true })).toBeHidden();
  await panel.getByRole("button", { name: "Filtre úloh", exact: true }).click();
  await panel.getByRole("combobox", { name: "Termín", exact: true }).selectOption("overdue");
  await panel.getByRole("button", { name: "Filtre úloh · 1 aktívne" }).click();
  await expect(panel.getByRole("combobox", { name: "Termín", exact: true })).toBeHidden(); await expect(card(page)).toHaveCount(0);
  await panel.getByRole("button", { name: "Filtre úloh · 1 aktívne" }).click();
  await expect(panel.getByRole("combobox", { name: "Termín", exact: true })).toHaveValue("overdue");
  await panel.getByRole("combobox", { name: "Termín", exact: true }).selectOption("all"); await panel.getByRole("button", { name: "Filtre úloh", exact: true }).click();
  await expect(action).toBeInViewport(); await page.screenshot({ path: `.context/redesign-v2-task-screenshots/compact-${panelWidth}x300.png`, fullPage: true });
  expect(fixture.requests.filter(request => request.method !== "GET")).toEqual([]); expect(fixture.errors).toEqual([]);
});
