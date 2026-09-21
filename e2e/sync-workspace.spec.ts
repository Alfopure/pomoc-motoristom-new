import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { syncCard } from "./fixtures/sync-workspace-data";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://sync-workspace.test";
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/sync-workspace.tsx"], outfile: ".context/sync-followup/workspace.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) }, plugins: [{ name: "isolated-telephony", setup(b) {
      b.onResolve({ filter: /supabase\/browser$/ }, () => ({ path: path.resolve("e2e/fixtures/ustredna-supabase.ts") }));
      b.onResolve({ filter: /^\.\/useTelephonyConsole$/ }, () => ({ path: path.resolve("e2e/fixtures/sync-workspace-telephony.ts") }));
    } }] });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
type Presence = { action: string; caseId: string | null; sessionId: string };
async function boot(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  const api = { reads: 0, fail: false, hold: false, release: () => {}, presence: [] as Presence[], requests: [] as string[], errors: [] as string[] };
  page.on("pageerror", error => api.errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    api.requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === "/api/cases/live") {
      api.reads++;
      if (api.hold) await new Promise<void>(resolve => { api.release = resolve; });
      return route.fulfill(api.fail ? { status: 503, json: { error: "Fixture unavailable" } } : { json: { available: true, ids: [syncCard.id], changes: [syncCard], versions: { [syncCard.id]: 1 }, more: false, editors: [], notifications: [] } });
    }
    if (url.pathname === "/api/cases/presence") { api.presence.push(route.request().postDataJSON()); return route.fulfill({ json: { available: true } }); }
    if (url.pathname === `/api/cases/${syncCard.id}`) return route.fulfill({ json: { caseDetail: syncCard } });
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [] } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/telephony/callbacks") return route.fulfill({ json: { configured: true, checkedAt: new Date().toISOString(), actorProfileId: "00000000-0000-4000-8000-000000000002", actorRole: "manager", openTotal: 125, open: [], resolved: [] } });
    if (url.pathname === "/api/notifications") return route.fulfill({ json: { notifications: [] } });
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/health/live") return route.fulfill({ json: { version: "sync-isolated" } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture" } });
  });
  await page.goto(origin + "/?view=dispatch"); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.locator('[data-testid="dispatch-console"]')).toBeVisible();
  await expect(statusButton(page)).toHaveAttribute("data-state", "current");
  return api;
}
function statusButton(page: Page) { return page.getByRole("button", { name: /^Stav aktualizácií:/ }).filter({ visible: true }); }
async function phoneEvidence(page: Page) {
  return page.evaluate(() => (window as unknown as { syncPhoneEvidence: { mounts: number; cleanups: number; actions: { name: string }[] } }).syncPhoneEvidence);
}
async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Detail prípadu TEST-001", exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
}

for (const width of [1440, 1280, 1024, 390, 320]) test(`one compact status and safe call controls at ${width}px`, async ({ page }) => {
  await page.clock.install();
  const api = await boot(page, width, width >= 1024 ? 900 : 844);
  await page.clock.runFor(1000);
  await expect(statusButton(page)).toHaveAttribute("data-state", "current");
  await expect(statusButton(page)).toHaveCount(1);
  const triggerBox = await statusButton(page).boundingBox();
  if (width < 1024) { expect(triggerBox!.width).toBeGreaterThanOrEqual(44); expect(triggerBox!.height).toBeGreaterThanOrEqual(44); }
  else { const nav = await page.getByRole("navigation", { name: "Hlavná navigácia" }).boundingBox(); expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(nav!.x); }
  const account = await page.getByRole("button", { name: "Účet Test dispečer" }).boundingBox();
  const phone = await page.getByTestId("phone-registration").boundingBox();
  expect(account!.x + account!.width).toBeLessThanOrEqual(phone!.x);
  await expect(page.getByText("Aktualizácie sa overujú na pozadí.")).toHaveCount(0);
  const before = await phoneEvidence(page), reads = api.reads;
  await statusButton(page).click();
  await expect(page.getByRole("dialog", { name: /Prípady a upozornenia/ })).toBeVisible();
  await expect(page.getByText("Posledné overenie o", { exact: false })).toBeVisible();
  expect(api.reads).toBe(reads);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-calls", { detail: "busy" })));
  await expect(page.getByTestId("call-tray")).toBeVisible();
  const pop = page.getByRole("dialog", { name: /Prípady a upozornenia/ });
  if (await pop.isVisible()) {
    const tray = await page.getByTestId("call-tray").boundingBox(), box = await pop.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(tray!.y + tray!.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.context/sync-followup/status-${width}.png` });
  const after = await phoneEvidence(page);
  expect(after).toEqual(before);
  expect(api.errors).toEqual([]);
});

test("hidden existing editor leaves presence, keeps its DOM and resumes on return", async ({ page }) => {
  const api = await boot(page); await openEditor(page);
  const note = page.getByLabel("Interná poznámka dispečera", { exact: true });
  await note.fill("Zachovať neuložený text");
  await note.evaluate(node => { Object.assign(node, { retainedSyncDraft: true }); (node as HTMLTextAreaElement).setSelectionRange(3, 3); });
  await expect.poll(() => api.presence.some(item => item.action === "heartbeat" && item.caseId === syncCard.id)).toBe(true);
  const firstSession = api.presence.find(item => item.action === "heartbeat" && item.caseId === syncCard.id)!.sessionId;
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Úlohy", exact: true }).click();
  await expect(note).toBeHidden();
  await expect.poll(() => api.presence.some(item => item.action === "leave" && item.sessionId === firstSession)).toBe(true);
  const count = api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).length;
  await page.clock.install(); await page.clock.runFor(16_000);
  expect(api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id)).toHaveLength(count);
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Nástenka", exact: true }).click();
  await expect(note).toBeVisible(); await expect(note).toHaveValue("Zachovať neuložený text");
  expect(await note.evaluate(node => Boolean((node as HTMLTextAreaElement & { retainedSyncDraft: boolean }).retainedSyncDraft))).toBe(true);
  await expect.poll(() => api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).length).toBeGreaterThan(count);
  expect(api.errors).toEqual([]);
});

test("desktop centre tasks retain a visible cockpit editor while collapsing pauses it", async ({ page }) => {
  const api = await boot(page);
  await page.getByRole("button", { name: /^Klient Test Odťah/ }).click();
  const form = page.getByTestId("case-edit-form-main");
  await expect(form).toBeVisible();
  await expect.poll(() => api.presence.some(item => item.action === "heartbeat" && item.caseId === syncCard.id)).toBe(true);
  const before = api.presence.filter(item => item.action === "leave").length;
  await page.getByRole("tab", { name: "Úlohy", exact: true }).click();
  await expect(form).toBeVisible();
  expect(api.presence.filter(item => item.action === "leave")).toHaveLength(before);
  await page.getByRole("button", { name: "Minimalizovať na spodnú lištu", exact: true }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => api.presence.filter(item => item.action === "leave").length).toBeGreaterThan(before);
});

async function browserVisible(page: Page, visible: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: value ? "visible" : "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}

test("browser visibility leaves an existing session and resumes with a new one and retained draft", async ({ page }) => {
  const api = await boot(page); await openEditor(page);
  await page.clock.install();
  const note = page.getByLabel("Interná poznámka dispečera", { exact: true });
  await note.fill("Zachovať pri prepnutí tabu");
  await note.evaluate(node => { Object.assign(node, { sameEditor: true }); (node as HTMLTextAreaElement).setSelectionRange(4, 4); });
  await expect.poll(() => api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).length).toBeGreaterThan(0);
  const initial = api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).at(-1)!;
  await browserVisible(page, false);
  await expect.poll(() => api.presence.some(item => item.action === "leave" && item.sessionId === initial.sessionId)).toBe(true);
  const count = api.presence.filter(item => item.action === "heartbeat").length;
  await page.clock.runFor(16_000);
  expect(api.presence.filter(item => item.action === "heartbeat")).toHaveLength(count);
  await browserVisible(page, true);
  await expect.poll(() => api.presence.filter(item => item.action === "heartbeat").length).toBeGreaterThan(count);
  expect(api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).at(-1)!.sessionId).not.toBe(initial.sessionId);
  await expect(note).toHaveValue("Zachovať pri prepnutí tabu");
  expect(await note.evaluate(node => (node as HTMLTextAreaElement).selectionStart)).toBe(4);
  expect(await note.evaluate(node => Boolean((node as HTMLTextAreaElement & { sameEditor: boolean }).sameEditor))).toBe(true);
});

for (const width of [390, 320]) test(`mobile tasks show one accessible status and pause the hidden editor at ${width}px`, async ({ page }) => {
  const api = await boot(page, width, 844);
  await page.getByRole("button", { name: "Otvoriť prípad TEST-001", exact: true }).click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await expect.poll(() => api.presence.some(item => item.action === "heartbeat" && item.caseId === syncCard.id)).toBe(true);
  const session = api.presence.filter(item => item.action === "heartbeat" && item.caseId === syncCard.id).at(-1)!;
  await page.getByRole("navigation", { name: "Mobilná navigácia" }).getByRole("button", { name: "Úlohy", exact: true }).click();
  await expect(page.getByTestId("case-edit-form-main")).toBeHidden();
  await expect.poll(() => api.presence.some(item => item.action === "leave" && item.sessionId === session.sessionId)).toBe(true);
  await expect(statusButton(page)).toHaveCount(1);
  const box = await statusButton(page).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
  await statusButton(page).click();
  await expect(page.getByRole("dialog", { name: /Prípady a upozornenia/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.context/sync-followup/tasks-${width}.png` });
});

test("status transitions preserve layout and respect reduced motion, focus and Escape", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install(); const api = await boot(page); await page.clock.runFor(1000);
  await expect(statusButton(page)).toHaveAttribute("data-state", "current");
  const before = await statusButton(page).boundingBox();
  api.hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(statusButton(page)).toHaveAttribute("data-state", "updating");
  expect(await statusButton(page).locator("svg").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  expect(await statusButton(page).boundingBox()).toEqual(before);
  await statusButton(page).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(statusButton(page)).toBeFocused();
  api.fail = true; api.release();
  await expect(statusButton(page)).toHaveAttribute("data-state", "error");
  api.hold = false; api.fail = false;
  await statusButton(page).click(); await page.getByRole("button", { name: "Skúsiť znova", exact: true }).click();
  await expect(statusButton(page)).toHaveAttribute("data-state", "current");
  expect(await statusButton(page).boundingBox()).toEqual(before);
});

test.describe("200 percent layout zoom (1440 physical / 720 CSS pixels)", () => {
  test.use({ deviceScaleFactor: 2 });
  test("status fits the visible viewport and closes when calls leave no room", async ({ page }) => {
    await boot(page, 720, 450);
    await statusButton(page).click();
    await expect(page.getByRole("dialog", { name: /Prípady a upozornenia/ })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture-calls", { detail: "busy" })));
    await expect(page.getByTestId("call-tray")).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Prípady a upozornenia/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: ".context/sync-followup/zoom-200.png" });
  });
});


test("an open new draft keeps its existence across page and browser visibility changes", async ({ page }) => {
  const api = await boot(page);
  await page.getByRole("button", { name: "Nový prípad", exact: true }).filter({ visible: true }).click();
  const form = page.getByTestId("case-form-main"); await expect(form).toBeVisible();
  await form.evaluate(node => Object.assign(node, { sameDraft: true }));
  await expect.poll(() => api.presence.some(item => item.action === "heartbeat" && item.caseId === null)).toBe(true);
  const draft = api.presence.find(item => item.action === "heartbeat" && item.caseId === null)!;
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Úlohy", exact: true }).click();
  await expect(form).toBeHidden();
  await browserVisible(page, false); await browserVisible(page, true);
  expect(api.presence.some(item => item.action === "leave" && item.sessionId === draft.sessionId)).toBe(false);
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Nástenka", exact: true }).click();
  await expect(form).toBeVisible();
  expect(await form.evaluate(node => Boolean((node as HTMLElement & { sameDraft: boolean }).sameDraft))).toBe(true);
});
