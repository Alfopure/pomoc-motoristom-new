import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { collaborationCard } from "./fixtures/case-collaboration-data";
import type { CaseEditorPresence } from "../src/domain/case-collaboration";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
test.use({ launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] } });
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-collaboration.tsx"], outfile: "case-collaboration.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts") }, define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});
function backend() { return { card: structuredClone(collaborationCard), revision: 1, editors: [] as CaseEditorPresence[], denied: false, offline: false, writes: 0, reads: 0, pages: [] as Page[] }; }
type Backend = ReturnType<typeof backend>;
async function broadcast(server: Backend) { await Promise.all(server.pages.map(page => page.evaluate(() => (window as unknown as { collaborationBroadcast: () => void }).collaborationBroadcast()))); }
async function boot(page: Page, server: Backend, viewer = "viewer") {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); server.pages.push(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://collaboration.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    if (server.offline) return route.abort();
    if (url.pathname === "/api/cases/live") {
      server.reads++;
      if (server.offline) return route.abort();
      if (server.denied) return route.fulfill({ status: 403, json: { error: "Odobratý prístup" } });
      const known = route.request().postDataJSON().versions;
      return route.fulfill({ json: { available: true, ids: [server.card.id], changes: known[server.card.id] === server.revision ? [] : [server.card], versions: { [server.card.id]: server.revision }, more: false, notifications: [], editors: server.editors } });
    }
    if (url.pathname === "/api/cases/presence") {
      const body = route.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["action", "caseId", "sessionId"]);
      server.editors = server.editors.filter(item => item.sessionId !== body.sessionId);
      if (body.action === "heartbeat") server.editors.push({ sessionId: body.sessionId, caseId: body.caseId, draftId: body.caseId ? null : body.sessionId, displayName: viewer === "author" ? "Jana" : "Peter", profileId: viewer, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      await route.fulfill({ json: { available: true } }); return;
    }
    if (url.pathname === `/api/cases/${server.card.id}` && route.request().method() === "PATCH") {
      server.writes++; const body = route.request().postDataJSON();
      if (body.expectedUpdatedAt !== server.card.updatedAt) return route.fulfill({ status: 409, json: { code: "CASE_REVISION_CONFLICT" } });
      server.card = { ...server.card, mainNote: body.note ?? server.card.mainNote, updatedAt: new Date(Date.now()).toISOString() }; server.revision++;
      await route.fulfill({ json: { caseDetail: server.card, committedRevision: server.card.updatedAt, mutationId: body.mutationId } });
      await broadcast(server); return;
    }
    if (url.pathname === `/api/cases/${server.card.id}`) return route.fulfill({ json: { caseDetail: server.card } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture" } });
  });
  await page.goto(`https://collaboration.test/?viewer=${viewer}`); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  return errors;
}
test("a saved edit reaches a second clean editor without reload or remount", async ({ page, context }) => {
  const server = backend(); const errors = await boot(page, server, "author"); const second = await context.newPage(); const errors2 = await boot(second, server);
  const secondNote = second.getByLabel("Interná poznámka dispečera", { exact: true });
  await secondNote.evaluate(node => Object.assign(node, { retainedInput: true }));
  await page.getByLabel("Interná poznámka dispečera", { exact: true }).fill("Uložená zmena kolegyne");
  await expect(secondNote).toHaveValue("Uložená zmena kolegyne");
  expect(await secondNote.evaluate(node => Boolean((node as HTMLTextAreaElement & { retainedInput?: boolean }).retainedInput))).toBe(true);
  expect(server.writes).toBe(1); expect([...errors, ...errors2]).toEqual([]);
});
test("remote save preserves dirty text and cursor and shows a comparison", async ({ page }) => {
  const server = backend(); await boot(page, server);
  const note = page.getByLabel("Interná poznámka dispečera", { exact: true });
  await note.fill("Môj rozpísaný text"); await note.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 4));
  server.card = { ...server.card, mainNote: "Zmena kolegyne", updatedAt: "2026-09-19T12:00:00Z" }; server.revision++;
  await broadcast(server);
  await expect(page.getByText("Porovnať s uloženými údajmi", { exact: true })).toBeVisible();
  await expect(note).toHaveValue("Môj rozpísaný text"); expect(await note.evaluate(node => (node as HTMLTextAreaElement).selectionStart)).toBe(4);
  await page.waitForTimeout(1400); expect(server.writes).toBe(0);
});
test("new-case activity carries no unsaved PII and cancellation removes it", async ({ page, context }) => {
  const server = backend(); await boot(page, server, "author"); const second = await context.newPage(); await boot(second, server);
  await page.getByRole("button", { name: "Vytvoriť nový prípad", exact: true }).click();
  await expect.poll(() => server.editors.some(item => item.profileId === "author" && item.caseId === null)).toBe(true);
  await broadcast(server); await expect(second.getByLabel("Rozpracované nové prípady")).toContainText("Jana má otvorený návrh prípadu");
  await page.getByRole("button", { name: "Zrušiť", exact: true }).click();
  await expect.poll(() => server.editors.some(item => item.profileId === "author" && item.caseId === null)).toBe(false);
  await broadcast(server); await expect(second.getByLabel("Rozpracované nové prípady")).toHaveCount(0);
});
test("revocation clears visible data and offline expiry hides a mounted dirty editor", async ({ page }) => {
  const server = backend(); await page.clock.install(); await boot(page, server);
  const note = page.getByLabel("Interná poznámka dispečera", { exact: true }); await note.fill("Zachovať môj draft");
  server.offline = true; await page.clock.fastForward(30_100); await expect(note).toBeHidden();
  server.offline = false; await page.evaluate(() => window.dispatchEvent(new Event("online"))); await expect(note).toBeVisible(); await expect(note).toHaveValue("Zachovať môj draft");
  server.denied = true; await broadcast(server); await page.clock.fastForward(550); await expect(page.getByTestId("case-edit-form-main")).toHaveCount(0);
});
