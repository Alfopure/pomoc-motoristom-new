import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { WorkspaceTask } from "../src/domain/task-workspace";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;
test.beforeAll(async () => {
  const output = (await build({ entryPoints: ["e2e/fixtures/task-workspace.tsx"], bundle: true, write: false, outfile: "fixture.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles;
  script = output.find(file => file.path.endsWith(".js"))!.text;
  css = output.find(file => file.path.endsWith(".css"))!.text + (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, width = 390, legacy = false) {
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [], errors: string[] = [];
  const state = { tasks: [] as WorkspaceTask[], failSave: false, failNetworkOnce: false, holdSave: null as Promise<void> | null, failMessageOnce: false, messages: [] as Record<string, unknown>[] };
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.clock.setFixedTime(new Date("2026-09-11T12:00:00Z"));
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://task-workspace.test") { errors.push(`External request ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    const method = route.request().method(), body = route.request().postData() ? route.request().postDataJSON() : null;
    requests.push({ method, path: url.pathname, body });
    if (!state.tasks.length) state.tasks = await page.evaluate(() => (window as unknown as { taskWorkspaceFixture: { tasks: WorkspaceTask[] } }).taskWorkspaceFixture.tasks);
    if (url.pathname === "/api/tasks" && method === "GET") return route.fulfill({ json: { tasks: state.tasks } });
    if (url.pathname === "/api/tasks" && method === "POST") { const task = { ...state.tasks[0], ...body, id: "55555555-5555-4555-8555-555555555555", caseId: body.caseIds[0] ?? "", caseIds: body.caseIds, caseLinks: [], revision: 1 }; state.tasks.push(task); return route.fulfill({ status: 201, json: { task } }); }
    if (url.pathname.endsWith("/messages")) {
      if (method === "GET") return route.fulfill({ json: { messages: state.messages, nextCursor: null } });
      if (state.failMessageOnce) { state.failMessageOnce = false; return route.fulfill({ status: 503, json: { error: "Potvrdenie správy nie je dostupné" } }); }
      const message = { id: "message-1", taskId: url.pathname.split("/")[3], authorName: "Operátor", authorProfileId: "operator", createdAt: "2026-09-10T11:00:00Z", ...body }; state.messages.push(message); return route.fulfill({ status: 201, json: { message } });
    }
    const task = state.tasks.find(item => url.pathname.includes(item.id));
    if (task && method === "PATCH") {
      if (state.holdSave) await state.holdSave;
      if (state.failNetworkOnce) { state.failNetworkOnce = false; return route.abort("failed"); }
      if (state.failSave) return route.fulfill({ status: 409, json: { error: "Súbežná zmena" } });
      const { expectedRevision, ...patch } = body;
      if (expectedRevision !== task.revision) return route.fulfill({ status: 409, json: { error: "Súbežná zmena" } });
      Object.assign(task, patch, { revision: task.revision + 1 }); return route.fulfill({ json: { task } });
    }
    if (task && method === "GET") return route.fulfill({ json: { task } });
    if (task && url.pathname.endsWith("/links")) { const caseId = String(body?.caseId); task.caseIds = task.caseIds.filter(id => id !== caseId); task.caseLinks = task.caseLinks.filter(link => link.caseId !== caseId); task.revision++; return route.fulfill({ json: { task } }); }
    if (task && method === "DELETE") { state.tasks = state.tasks.filter(item => item.id !== task.id); return route.fulfill({ json: { deleted: true } }); }
    errors.push(`Unexpected ${method} ${url.pathname}`); return route.abort();
  });
  await page.goto(`https://task-workspace.test/${legacy ? "?legacy=true" : ""}`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  return { state, requests, errors };
}
for (const width of [360,390,768,1024,1279,1280]) test(`task and chat drafts share identity across views at ${width}px`, async ({ page }) => {
  const { errors } = await boot(page,width);
  await page.getByRole("button",{name:"Samostatná úloha",exact:true}).click();
  await page.getByRole("textbox",{name:"Názov úlohy",exact:true}).fill("Zachovaný názov");
  await page.getByRole("textbox",{name:"Správa k úlohe",exact:true}).fill("Zachovaný chat");
  await page.getByRole("button",{name:"Prepnúť zobrazenie"}).click();
  await expect(page.getByRole("textbox",{name:"Názov úlohy",exact:true})).toHaveValue("Zachovaný názov");
  await expect(page.getByRole("textbox",{name:"Správa k úlohe",exact:true})).toHaveValue("Zachovaný chat");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false); expect(errors).toEqual([]);
});
test("new task can stay standalone and its draft survives switching views",async({page})=>{
  const {requests,errors}=await boot(page);
  await page.getByRole("button",{name:"Nová úloha",exact:true}).click();
  await page.getByRole("textbox",{name:"Názov úlohy",exact:true}).fill("Bez prípadu");
  await page.getByRole("button",{name:"Prepnúť zobrazenie"}).click();
  await expect(page.getByRole("textbox",{name:"Názov úlohy",exact:true})).toHaveValue("Bez prípadu");
  await page.getByRole("button",{name:"Vytvoriť úlohu",exact:true}).click();
  await expect.poll(()=>requests.filter(request=>request.method==="POST"&&request.path==="/api/tasks").length).toBe(1);
  expect(requests.find(request=>request.method==="POST"&&request.path==="/api/tasks")?.body?.caseIds).toEqual([]); expect(errors).toEqual([]);
});
test("failed edit stays visible and editable",async({page})=>{
  const {state,errors}=await boot(page);state.failSave=true;
  await page.getByRole("button",{name:"Samostatná úloha",exact:true}).click();
  await page.getByRole("textbox",{name:"Názov úlohy",exact:true}).fill("Neuložený text");
  await page.getByRole("button",{name:"Uložiť úlohu",exact:true}).click();
  await expect(page.getByText("Súbežná zmena",{exact:true})).toBeVisible();
  await expect(page.getByRole("textbox",{name:"Názov úlohy",exact:true})).toHaveValue("Neuložený text");expect(errors).toEqual([]);
});
test("task chat retry retains message identity",async({page})=>{
  const {state,requests,errors}=await boot(page);state.failMessageOnce=true;
  await page.getByRole("button",{name:"Samostatná úloha",exact:true}).click();
  await page.getByRole("textbox",{name:"Správa k úlohe",exact:true}).fill("Dôležitá správa");
  await page.getByRole("button",{name:"Odoslať správu",exact:true}).click();
  await page.getByRole("button",{name:"Overiť a zopakovať odoslanie"}).click();
  await expect(page.getByRole("log")).toContainText("Dôležitá správa");
  const sends=requests.filter(request=>request.method==="POST"&&request.path.endsWith("/messages"));expect(sends).toHaveLength(2);expect(sends[1].body).toEqual(sends[0].body);expect(errors).toEqual([]);
});
test("shared task shows every case and distinguishes unlink from full delete",async({page})=>{
  const {requests,errors}=await boot(page);
  await page.getByRole("button",{name:"Úloha pre dva prípady",exact:true}).click();
  const links=page.getByRole("region",{name:"Prípady úlohy"});
  await expect(links).toContainText("CASE-001");await expect(links).toContainText("CASE-002");
  await expect(links.getByRole("button",{name:"Pôvodná väzba je povinná"})).toBeDisabled();
  await links.getByRole("button",{name:"Odpojiť tento prípad"}).click();
  await expect(links.getByRole("heading")).toHaveText("Pripojené prípady (1)");
  expect(requests.find(request=>request.method==="DELETE")?.path).toContain("/links");
  await page.getByRole("button",{name:"Vymazať celú úlohu",exact:true}).click();
  await expect(page.getByRole("alert",{name:"Potvrdenie vymazania celej úlohy"})).toContainText("zo všetkých 1 prípadov");expect(errors).toEqual([]);
});
test("legacy gate avoids workspace APIs and failed edit remains in its form",async({page})=>{
  const {requests,errors}=await boot(page,1280,true);
  await expect(page.getByRole("button",{name:"Úloha pre dva prípady",exact:true})).toHaveCount(1);
  await page.getByRole("button",{name:"Upraviť",exact:true}).click();
  const title=page.getByRole("textbox",{name:"Názov úlohy Úloha pre dva prípady",exact:true});
  await title.fill("Legacy draft po chybe");
  await page.getByRole("button",{name:"Uložiť",exact:true}).click();
  await expect(title).toHaveValue("Legacy draft po chybe");
  await expect(page.getByText("Simulované zlyhanie",{exact:true})).toBeVisible();
  expect(requests).toEqual([]);expect(errors).toEqual([]);
});
test("task and chat editors remain accessible at 200 percent zoom after rotation",async({page})=>{
  const {errors}=await boot(page,1280);
  await page.getByRole("button",{name:"Samostatná úloha",exact:true}).click();
  await page.evaluate(()=>{document.documentElement.style.zoom="2";});
  await page.setViewportSize({width:900,height:390});
  await page.getByRole("textbox",{name:"Správa k úlohe",exact:true}).fill("Po otočení zariadenia");
  await expect(page.getByRole("textbox",{name:"Správa k úlohe",exact:true})).toHaveValue("Po otočení zariadenia");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);expect(errors).toEqual([]);
});

const standaloneId = "11111111-1111-4111-8111-111111111111";
const standaloneTitle = "Samostatná úloha";
const taskHandle = (page: Page, title = standaloneTitle) => page.getByRole("button", { name: `Presunúť úlohu ${title}`, exact: true });
const taskColumn = (page: Page, column: string) => page.locator(`[data-task-column="${column}"]`);
const cardIn = (page: Page, column: string) => taskColumn(page, column).locator(`[data-task-id="${standaloneId}"]`);

async function pointerDrag(page: Page, source: Locator, target: Locator, cancel = false) {
  const start = await source.boundingBox(), end = await target.boundingBox();
  expect(start).not.toBeNull(); expect(end).not.toBeNull();
  const x = start!.x + start!.width / 2, y = start!.y + start!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y, { steps: 3 });
  await page.mouse.move(end!.x + end!.width / 2, end!.y + Math.min(end!.height / 2, 150), { steps: 16 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

test("pointer drops complete an empty column and reopen by the preserved due date after refresh", async ({ page }) => {
  const { state, requests, errors } = await boot(page, 1440);
  await expect(cardIn(page, "overdue")).toBeVisible();
  await expect(taskColumn(page, "done").locator("[data-task-id]")).toHaveCount(0);
  await pointerDrag(page, taskHandle(page), taskColumn(page, "done"));
  await expect(cardIn(page, "done")).toBeVisible();
  expect(requests.filter(request => request.method === "PATCH").map(request => request.body)).toEqual([{ status: "done", expectedRevision: 1 }]);
  expect(state.tasks.find(task => task.id === standaloneId)?.dueAt).toBe("2026-09-10T10:00:00Z");
  await page.getByRole("button", { name: "Obnoviť úlohy", exact: true }).click();
  await expect.poll(() => requests.filter(request => request.method === "GET" && request.path === "/api/tasks").length).toBeGreaterThan(0);
  await expect(cardIn(page, "done")).toBeVisible();
  // Dropping onto a time category reopens the task without silently rescheduling it.
  await pointerDrag(page, page.getByRole("button", { name: standaloneTitle, exact: true }), taskColumn(page, "scheduled"));
  await expect(cardIn(page, "overdue")).toBeVisible();
  await expect(cardIn(page, "scheduled")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Detail úlohy", exact: true })).toHaveCount(0);
  expect(requests.filter(request => request.method === "PATCH").map(request => request.body)).toEqual([
    { status: "done", expectedRevision: 1 }, { status: "open", expectedRevision: 2 },
  ]);
  expect(state.tasks.find(task => task.id === standaloneId)?.dueAt).toBe("2026-09-10T10:00:00Z");
  expect(errors).toEqual([]);
});

test("invalid time-column drops, Escape, and opening the title never write a status", async ({ page }) => {
  const { requests, errors } = await boot(page, 1440);
  await pointerDrag(page, taskHandle(page), taskColumn(page, "today"));
  await expect(cardIn(page, "overdue")).toBeVisible();
  await pointerDrag(page, taskHandle(page), taskColumn(page, "done"), true);
  await expect(cardIn(page, "overdue")).toBeVisible();
  await page.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue(standaloneTitle);
  expect(requests.filter(request => request.method === "PATCH")).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) test(`keyboard dragging completes and reopens tasks at ${width}px`, async ({ page }) => {
  const { requests, errors } = await boot(page, width);
  await taskHandle(page).focus();
  // KeyboardSensor attaches its document listener on the next task. A real
  // press/release lets that listener mount before the following arrow key.
  await page.keyboard.press("Space", { delay: 20 });
  await expect(taskColumn(page, "done")).toHaveAttribute("data-drop-allowed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(taskColumn(page, "done")).toHaveAttribute("data-drop-over", "true");
  await page.keyboard.press("Space");
  await expect(cardIn(page, "done")).toBeVisible();
  await expect(taskHandle(page)).toBeFocused();
  await expect(taskHandle(page)).toBeInViewport();
  await page.keyboard.press("Space", { delay: 20 });
  await expect(taskColumn(page, "undated")).toHaveAttribute("data-drop-allowed", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(taskColumn(page, "undated")).toHaveAttribute("data-drop-over", "true");
  await page.keyboard.press("Space");
  await expect(cardIn(page, "overdue")).toBeVisible();
  expect(requests.filter(request => request.method === "PATCH").map(request => request.body?.status)).toEqual(["done", "open"]);
  expect(errors).toEqual([]);
});

test("sidebar status buttons work with the open and done filters", async ({ page }) => {
  const { requests, errors } = await boot(page, 390);
  await page.getByRole("button", { name: "Prepnúť zobrazenie", exact: true }).click();
  await expect(taskHandle(page)).toHaveCount(0);
  await page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true }).click();
  await expect(page.getByRole("button", { name: standaloneTitle, exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Zobraziť úlohy", exact: true }).selectOption("done");
  await page.getByRole("button", { name: `Otvoriť znova úlohu ${standaloneTitle}`, exact: true }).click();
  await expect(page.getByRole("button", { name: standaloneTitle, exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Zobraziť úlohy", exact: true }).selectOption("all");
  await expect(page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true })).toBeVisible();
  expect(requests.filter(request => request.method === "PATCH").map(request => request.body)).toEqual([
    { status: "done", expectedRevision: 1 }, { status: "open", expectedRevision: 2 },
  ]);
  expect(errors).toEqual([]);
});

test("unsaved task drafts disable dragging and quick status changes", async ({ page }) => {
  const { requests, errors } = await boot(page, 1440);
  await page.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await page.getByRole("textbox", { name: "Názov úlohy", exact: true }).fill("Rozpracovaný názov");
  await page.getByRole("textbox", { name: "Správa k úlohe", exact: true }).fill("Rozpracovaný chat");
  await page.getByRole("button", { name: "Späť na úlohy", exact: true }).click();
  await expect(taskHandle(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true })).toBeDisabled();
  await pointerDrag(page, taskHandle(page), taskColumn(page, "done"));
  await expect(cardIn(page, "overdue")).toBeVisible();
  await page.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Názov úlohy", exact: true })).toHaveValue("Rozpracovaný názov");
  await expect(page.getByRole("textbox", { name: "Správa k úlohe", exact: true })).toHaveValue("Rozpracovaný chat");
  expect(requests.filter(request => request.method === "PATCH")).toEqual([]);
  expect(errors).toEqual([]);
});

test("a rejected status drop preserves the card and chat draft until the conflict is reloaded", async ({ page }) => {
  const { state, requests, errors } = await boot(page, 1440);
  await page.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await page.getByRole("textbox", { name: "Správa k úlohe", exact: true }).fill("Správa zostáva po konflikte");
  await page.getByRole("button", { name: "Späť na úlohy", exact: true }).click();
  state.failSave = true;
  await pointerDrag(page, taskHandle(page), taskColumn(page, "done"));
  await expect(page.getByText("Súbežná zmena", { exact: true })).toBeVisible();
  await expect(cardIn(page, "overdue")).toBeVisible();
  await expect(cardIn(page, "done")).toHaveCount(0);
  await expect(taskHandle(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Správa k úlohe", exact: true })).toHaveValue("Správa zostáva po konflikte");
  state.failSave = false;
  await page.getByRole("button", { name: "Načítať aktuálnu úlohu a nahradiť draft", exact: true }).click();
  await page.getByRole("button", { name: "Späť na úlohy", exact: true }).click();
  await page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true }).click();
  await expect(cardIn(page, "done")).toBeVisible();
  expect(requests.filter(request => request.method === "PATCH").map(request => request.body)).toEqual([
    { status: "done", expectedRevision: 1 }, { status: "done", expectedRevision: 1 },
  ]);
  expect(errors).toEqual([]);
});

test("pending saves disable repeat actions and network failure keeps the task available for retry", async ({ page }) => {
  const { state, requests, errors } = await boot(page, 1440);
  let releaseSave!: () => void;
  state.holdSave = new Promise<void>(resolve => { releaseSave = resolve; });
  state.failNetworkOnce = true;
  try {
    await pointerDrag(page, taskHandle(page), taskColumn(page, "done"));
    await expect.poll(() => requests.filter(request => request.method === "PATCH").length).toBe(1);
    await expect(taskHandle(page)).toBeDisabled();
    await expect(taskHandle(page, "Úloha pre dva prípady")).toBeDisabled();
    await expect(page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true })).toBeDisabled();
  } finally { state.holdSave = null; releaseSave(); }
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(cardIn(page, "overdue")).toBeVisible();
  await expect(taskHandle(page)).toBeEnabled();
  await page.getByRole("button", { name: `Vybaviť úlohu ${standaloneTitle}`, exact: true }).click();
  await expect(cardIn(page, "done")).toBeVisible();
  expect(requests.filter(request => request.method === "PATCH")).toHaveLength(2);
  expect(errors).toEqual([]);
});

test.describe("touch task dragging", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a mobile touch drag scrolls horizontally to the done column", async ({ page, context }) => {
    const { requests, errors } = await boot(page, 390);
    const handle = taskHandle(page);
    await expect(handle).toHaveCSS("touch-action", "none");
    const start = (await handle.boundingBox())!;
    const board = page.getByRole("region", { name: "Tabuľa úloh", exact: true });
    const bounds = (await board.boundingBox())!;
    const x = start.x + start.width / 2, y = start.y + start.height / 2;
    const session = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) => session.send("Input.dispatchTouchEvent", {
      type, touchPoints: point ? [{ ...point, id: 1, radiusX: 2, radiusY: 2, force: 1 }] : [],
    });
    try {
      await touch("touchStart", { x, y });
      await touch("touchMove", { x: x + 15, y });
      await touch("touchMove", { x: bounds.x + bounds.width - 18, y });
      await expect.poll(() => taskColumn(page, "done").evaluate(element => element.getBoundingClientRect().x), { timeout: 10_000 }).toBeLessThan(290);
      const done = (await taskColumn(page, "done").boundingBox())!;
      await touch("touchMove", { x: Math.min(done.x + done.width / 2, bounds.x + bounds.width - 30), y });
      await touch("touchEnd");
      await expect(cardIn(page, "done")).toBeVisible();
      expect(await board.evaluate(element => element.scrollLeft)).toBeGreaterThan(500);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(requests.filter(request => request.method === "PATCH").map(request => request.body)).toEqual([{ status: "done", expectedRevision: 1 }]);
      expect(errors).toEqual([]);
    } finally { await session.detach(); }
  });
});
