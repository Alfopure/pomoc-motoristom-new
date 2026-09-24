import { expect, test, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { collaborationCard } from "./fixtures/case-collaboration-data";
import type { CaseEditorPresence } from "../src/domain/case-collaboration";
import type { CaseDraftPreview, CaseDraftPreviewSnapshot } from "../src/domain/case-draft-preview";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const SESSION_A = "00000000-0000-4000-8000-000000000101";
const SESSION_B = "00000000-0000-4000-8000-000000000102";
test.use({ launchOptions: {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ["--no-sandbox"],
} });
let script: string, css: string;
test.beforeAll(async () => {
  // Bundle the established fixture: real provider, new-case form and draft activity.
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-collaboration.tsx"], outfile: "case-draft-preview.js", bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", alias: { "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts") },
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  await mkdir(".context/case-draft-preview", { recursive: true });
});

type PresenceBody = { action: "heartbeat" | "leave"; sessionId: string; caseId: string | null };
type Write = { sessionId: string; sequence: number; preview: CaseDraftPreview };
function backend() {
  return {
    editors: [] as CaseEditorPresence[], snapshots: new Map<string, CaseDraftPreviewSnapshot>(),
    reads: [] as string[], writes: [] as Write[], presence: [] as PresenceBody[], pages: [] as Page[],
    errors: [] as string[], creates: [] as Record<string, unknown>[], blockedRequests: [] as string[],
    denied: false, offline: false, draftStatus: 200, draftAvailable: true,
    heartbeatGate: null as Promise<void> | null,
    readOverride: null as ((route: Route, sessionId: string) => Promise<void>) | null,
  };
}
type Backend = ReturnType<typeof backend>;
function snapshot(note: string, sequence = 1): CaseDraftPreviewSnapshot {
  return { available: true, preview: { version: 1, fields: { note } }, sequence, displayName: "Jana", updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString() };
}
function seed(server: Backend, sessionId = SESSION_A, note = "Návrh kolegyne", profileId = "author") {
  server.editors.push({ sessionId, caseId: null, draftId: sessionId, profileId, displayName: "Jana", expiresAt: new Date(Date.now() + 120_000).toISOString() });
  server.snapshots.set(sessionId, snapshot(note));
}
async function broadcast(server: Backend) {
  await Promise.all(server.pages.map(page => page.evaluate(() => (window as unknown as { collaborationBroadcast: () => void }).collaborationBroadcast())));
}
async function boot(page: Page, server: Backend, viewer = "viewer", mobile = false) {
  server.pages.push(page);
  page.on("pageerror", error => server.errors.push(error.message));
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "https://draft-preview.test") { server.blockedRequests.push(request.url()); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    if (server.offline) return route.abort();
    if (url.pathname === "/api/cases/live") {
      if (server.denied) return route.fulfill({ status: 403, json: { error: "Odobratý prístup" } });
      const known = request.postDataJSON().versions;
      return route.fulfill({ json: { available: true, ids: [collaborationCard.id], changes: known[collaborationCard.id] === 1 ? [] : [collaborationCard],
        versions: { [collaborationCard.id]: 1 }, more: false, notifications: [], editors: server.editors } });
    }
    if (url.pathname === "/api/cases/presence") {
      const body = request.postDataJSON() as PresenceBody;
      // Presence broadcasts remain metadata-only; form content uses the authenticated draft endpoint.
      expect(Object.keys(body).sort()).toEqual(["action", "caseId", "sessionId"]);
      server.presence.push(body);
      if (body.action === "heartbeat" && body.caseId === null && server.heartbeatGate) await server.heartbeatGate;
      server.editors = server.editors.filter(item => item.sessionId !== body.sessionId);
      if (body.action === "heartbeat") {
        server.editors.push({ sessionId: body.sessionId, caseId: body.caseId, draftId: body.caseId ? null : body.sessionId, profileId: viewer,
          displayName: viewer.startsWith("author") ? "Jana" : "Peter", expiresAt: new Date(Date.now() + 120_000).toISOString() });
      } else server.snapshots.delete(body.sessionId);
      return route.fulfill({ json: { available: true } });
    }
    const draft = url.pathname.match(/^\/api\/cases\/drafts\/([^/]+)$/);
    if (draft) {
      const sessionId = draft[1];
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        expect(Object.keys(body).sort()).toEqual(["preview", "sequence"]);
        server.writes.push({ sessionId, ...body });
        server.snapshots.set(sessionId, { ...snapshot("", body.sequence), preview: body.preview });
        return route.fulfill({ json: { available: true, sequence: body.sequence } });
      }
      server.reads.push(sessionId);
      if (server.readOverride) return server.readOverride(route, sessionId);
      if (server.draftStatus !== 200) return route.fulfill({ status: server.draftStatus, json: { error: "Draft unavailable" } });
      if (!server.draftAvailable) return route.fulfill({ json: { available: false } });
      const value = server.snapshots.get(sessionId);
      return route.fulfill(value ? { json: value } : { status: 404, json: { error: "Draft ended" } });
    }
    if (url.pathname === "/api/cases" && request.method() === "POST") {
      const body = request.postDataJSON(); server.creates.push(body);
      server.editors = server.editors.filter(item => item.sessionId !== body.editorSessionId);
      server.snapshots.delete(body.editorSessionId);
      return route.fulfill({ json: { caseId: collaborationCard.id, dispatchData: { dispatchCases: [collaborationCard] } } });
    }
    if (url.pathname === `/api/cases/${collaborationCard.id}`) return route.fulfill({ json: { caseDetail: collaborationCard } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture" } });
  });
  await page.goto(`https://draft-preview.test/?viewer=${viewer}`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
}
const activity = (page: Page) => page.getByLabel("Rozpracované nové prípady", { exact: true });
const preview = (page: Page) => page.getByRole("region", { name: "Rozpracovaný prípad – Jana", exact: true });
const newNote = (page: Page) => page.getByLabel("Interná poznámka dispečera", { exact: true });
async function createDraft(page: Page, server: Backend, note = "Klient čaká na odťah") {
  await page.getByRole("button", { name: "Vytvoriť nový prípad", exact: true }).click();
  await newNote(page).fill(note);
  await expect.poll(() => server.writes.some(write => write.preview.fields.note === note)).toBe(true);
  return server.writes.at(-1)!.sessionId;
}
async function openPreview(page: Page, index = 0) {
  await activity(page).getByRole("button").nth(index).click();
  await expect(preview(page).nth(index)).toBeVisible();
}
async function visibility(page: Page, value: "visible" | "hidden") {
  await page.evaluate(state => { Object.defineProperty(document, "visibilityState", { configurable: true, value: state }); document.dispatchEvent(new Event("visibilitychange")); }, value);
}

test("real unsaved form edits reach a second page as read-only fields and clearing removes text", async ({ page, context }) => {
  const server = backend(); await boot(page, server, "author");
  const second = await context.newPage(); await boot(second, server);
  await createDraft(page, server); await broadcast(server); await openPreview(second);
  await expect(preview(second)).toContainText("Klient čaká na odťah");
  await expect(preview(second).locator("input,textarea,select,button,[contenteditable=true]")).toHaveCount(0);
  await page.getByLabel("Meno", { exact: true }).fill("Testovací klient");
  await page.getByLabel("Značka", { exact: true }).fill("Škoda");
  await expect(preview(second)).toContainText("Testovací klient"); await expect(preview(second)).toContainText("Škoda");
  await newNote(page).fill("");
  await expect.poll(() => server.writes.at(-1)?.preview.fields.note).toBe("");
  await expect(preview(second)).not.toContainText("Klient čaká na odťah");
  expect(server.creates).toEqual([]); expect(server.errors).toEqual([]); expect(server.blockedRequests).toEqual([]);
  await activity(second).screenshot({ path: ".context/case-draft-preview/desktop.png" });
});

test("same author can have distinct drafts while their own drafts remain hidden", async ({ page }) => {
  const server = backend(); seed(server, SESSION_A, "Prvý klient"); seed(server, SESSION_B, "Druhý klient");
  seed(server, "00000000-0000-4000-8000-000000000103", "Vlastný návrh", "viewer");
  await boot(page, server); await expect(activity(page).getByRole("button")).toHaveCount(2);
  await openPreview(page); await activity(page).getByRole("button").nth(1).click();
  await expect(preview(page).nth(0)).toContainText("Prvý klient"); await expect(preview(page).nth(1)).toContainText("Druhý klient");
  expect(new Set(server.reads)).toEqual(new Set([SESSION_A, SESSION_B]));
});

test("no preview publication occurs before the draft heartbeat is acknowledged", async ({ page }) => {
  const server = backend(); let acknowledge!: () => void;
  server.heartbeatGate = new Promise(resolve => { acknowledge = resolve; });
  await page.clock.install(); await boot(page, server, "author");
  await page.getByRole("button", { name: "Vytvoriť nový prípad", exact: true }).click(); await newNote(page).fill("Čakám na potvrdenie");
  await expect.poll(() => server.presence.some(body => body.action === "heartbeat" && body.caseId === null)).toBe(true);
  await page.clock.fastForward(2_000); expect(server.writes).toEqual([]);
  acknowledge();
  await expect.poll(() => server.writes.some(write => write.preview.fields.note === "Čakám na potvrdenie")).toBe(true);
});

test("typing coalesces writes and keeps sequences increasing without losing the latest text", async ({ page }) => {
  const server = backend(); await boot(page, server, "author"); await createDraft(page, server, "Začiatok");
  const initial = server.writes.length;
  await newNote(page).fill(""); await newNote(page).pressSequentially("Postupne písaná poznámka", { delay: 15 });
  await expect.poll(() => server.writes.at(-1)?.preview.fields.note).toBe("Postupne písaná poznámka");
  expect(server.writes.length - initial).toBeLessThanOrEqual(2);
  const sequences = server.writes.map(write => write.sequence);
  expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1])).toBe(true);
});

test("author resumes hidden, offline, and suspended sessions after acknowledgment with increasing sequences", async ({ page }) => {
  const server = backend(); await page.clock.install(); await boot(page, server, "author");
  const sessionId = await createDraft(page, server, "Pôvodný rozpracovaný text");
  for (const scenario of ["hidden", "offline unchanged", "offline edited", "suspended"] as const) {
    const previous = server.writes.at(-1)!; let acknowledge!: () => void;
    const heartbeats = server.presence.filter(body => body.caseId === null && body.action === "heartbeat").length;
    server.heartbeatGate = new Promise(resolve => { acknowledge = resolve; });
    if (scenario === "hidden") await visibility(page, "hidden");
    else if (scenario !== "suspended") {
      server.offline = true;
      await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); window.dispatchEvent(new Event("offline")); });
    }
    if (scenario === "offline edited") await newNote(page).fill("Text upravený bez spojenia");
    await page.clock.fastForward(65_000);
    expect(server.writes.at(-1)).toEqual(previous);
    if (scenario === "hidden") await visibility(page, "visible");
    else if (scenario !== "suspended") {
      server.offline = false;
      await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); window.dispatchEvent(new Event("online")); });
    }
    await expect.poll(() => server.presence.filter(body => body.caseId === null && body.action === "heartbeat").length, { message: `${scenario}: returning to a visible online form must renew presence` }).toBeGreaterThan(heartbeats);
    await page.clock.fastForward(1_000); expect(server.writes.at(-1)).toEqual(previous);
    acknowledge(); server.heartbeatGate = null;
    await expect.poll(() => server.writes.at(-1)?.sequence).toBeGreaterThan(previous.sequence);
    expect(server.writes.at(-1)?.sessionId).toBe(sessionId);
    expect(server.writes.at(-1)?.preview.fields.note).toBe(scenario === "offline edited" ? "Text upravený bez spojenia" : previous.preview.fields.note);
  }
});

test("closed, offscreen, and hidden-tab previews do no reads and resume when visible", async ({ page }) => {
  const server = backend(); seed(server); await page.clock.install(); await boot(page, server);
  await page.clock.fastForward(4_000); expect(server.reads).toEqual([]);
  await openPreview(page); await expect(preview(page)).toContainText("Návrh kolegyne");
  await activity(page).getByRole("button").click(); const closed = server.reads.length;
  await page.clock.fastForward(4_000); expect(server.reads).toHaveLength(closed);
  await openPreview(page); await expect(preview(page)).toContainText("Návrh kolegyne");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await expect(preview(page)).toHaveCount(0);
  const offscreen = server.reads.length; await page.clock.fastForward(4_000); expect(server.reads).toHaveLength(offscreen);
  await activity(page).scrollIntoViewIfNeeded(); await expect(preview(page)).toContainText("Návrh kolegyne");
  await visibility(page, "hidden"); await expect(preview(page)).not.toContainText("Návrh kolegyne");
  const hidden = server.reads.length; await page.clock.fastForward(4_000); expect(server.reads).toHaveLength(hidden);
  await visibility(page, "visible"); await expect(preview(page)).toContainText("Návrh kolegyne");
});

test("lower sequence responses never replace a newer draft", async ({ page }) => {
  const server = backend(); seed(server); server.snapshots.set(SESSION_A, snapshot("Novšia verzia", 5));
  await boot(page, server); await openPreview(page); await expect(preview(page)).toContainText("Novšia verzia");
  const reads = server.reads.length; server.snapshots.set(SESSION_A, snapshot("Oneskorená stará verzia", 4));
  await expect.poll(() => server.reads.length).toBeGreaterThan(reads);
  await expect(preview(page)).toContainText("Novšia verzia"); await expect(preview(page)).not.toContainText("Oneskorená stará verzia");
  server.snapshots.set(SESSION_A, { ...snapshot("", 0), preview: null });
  await expect(preview(page)).toContainText("Čakám na prvé vyplnené údaje"); await expect(preview(page)).not.toContainText("Novšia verzia");
  server.snapshots.set(SESSION_A, snapshot("Znovu publikovaný návrh", 6)); await expect(preview(page)).toContainText("Znovu publikovaný návrh");
});

test("a late response from a closed preview cannot replace the reopened snapshot", async ({ page }) => {
  const server = backend(); seed(server); let held: Route | undefined;
  server.readOverride = async route => { held = route; };
  await boot(page, server); await openPreview(page); await expect.poll(() => Boolean(held)).toBe(true);
  await activity(page).getByRole("button").click(); server.readOverride = null; server.snapshots.set(SESSION_A, snapshot("Aktuálny obsah", 2));
  await openPreview(page); await expect(preview(page)).toContainText("Aktuálny obsah");
  await held!.fulfill({ json: snapshot("Oneskorený obsah", 1) }).catch(() => {});
  await expect(preview(page)).toContainText("Aktuálny obsah"); await expect(preview(page)).not.toContainText("Oneskorený obsah");
});

for (const action of ["cancel", "save"] as const) {
  test(`${action} ends the author session and removes the open preview on a second page`, async ({ page, context }) => {
    const server = backend(); await boot(page, server, "author"); const second = await context.newPage(); await boot(second, server);
    const sessionId = await createDraft(page, server); await broadcast(server); await openPreview(second);
    await expect(preview(second)).toContainText("Klient čaká na odťah");
    await page.getByRole("button", { name: action === "cancel" ? "Zrušiť" : "Uložiť rozpracované", exact: true }).click();
    await expect.poll(() => server.editors.some(item => item.sessionId === sessionId)).toBe(false);
    await broadcast(server); await expect(activity(second)).toHaveCount(0); expect(server.snapshots.has(sessionId)).toBe(false);
    if (action === "save") expect(server.creates[0].editorSessionId).toBe(sessionId);
    else expect(server.creates).toEqual([]);
  });
}

test("draft access revocation clears the viewer and stops polling", async ({ page }) => {
  const server = backend(); seed(server); await page.clock.install(); await boot(page, server); await openPreview(page);
  await expect(preview(page)).toContainText("Návrh kolegyne"); server.draftStatus = 403;
  await page.clock.fastForward(2_100); await expect(preview(page)).toContainText("Prístup k návrhu už nie je dostupný");
  await expect(preview(page)).not.toContainText("Návrh kolegyne");
  const reads = server.reads.length; await page.clock.fastForward(5_000); expect(server.reads).toHaveLength(reads);
});

test("case access revocation removes all draft previews", async ({ page }) => {
  const server = backend(); seed(server); await boot(page, server); await openPreview(page); await expect(preview(page)).toContainText("Návrh kolegyne");
  server.denied = true; await broadcast(server); await expect(activity(page)).toHaveCount(0);
  await expect(page.getByTestId("case-edit-form-main")).toHaveCount(0);
});

test("temporary read errors expire the stale snapshot and recover with fresh data", async ({ page }) => {
  const server = backend(); seed(server); await page.clock.install(); await boot(page, server); await openPreview(page);
  await expect(preview(page)).toContainText("Návrh kolegyne"); server.draftStatus = 503;
  await page.clock.fastForward(2_100); await expect(preview(page)).toContainText("Čakám na spojenie"); await expect(preview(page)).toContainText("Návrh kolegyne");
  await page.clock.fastForward(13_100); await expect(preview(page)).not.toContainText("Návrh kolegyne");
  server.draftStatus = 200; server.snapshots.set(SESSION_A, snapshot("Obnovený náhľad", 2));
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await expect(preview(page)).toContainText("Obnovený náhľad");
});

test("offline hides the preview immediately and reconnect requests current data", async ({ page }) => {
  const server = backend(); seed(server); await page.clock.install(); await boot(page, server); await openPreview(page);
  await expect(preview(page)).toContainText("Návrh kolegyne");
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); window.dispatchEvent(new Event("offline")); });
  await expect(preview(page)).not.toContainText("Návrh kolegyne"); const reads = server.reads.length;
  await page.clock.fastForward(4_000); expect(server.reads).toHaveLength(reads);
  server.snapshots.set(SESSION_A, snapshot("Po opätovnom pripojení", 2));
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); window.dispatchEvent(new Event("online")); });
  await expect(preview(page)).toContainText("Po opätovnom pripojení");
});

test("unavailable draft service gives a clear message and no repeated reads", async ({ page }) => {
  const server = backend(); seed(server); server.draftAvailable = false; await page.clock.install(); await boot(page, server); await openPreview(page);
  await expect(preview(page)).toContainText("Živý náhľad zatiaľ nie je dostupný"); const reads = server.reads.length;
  await page.clock.fastForward(5_000); expect(server.reads).toHaveLength(reads);
});

test("mobile preview wraps long values and has a 44px keyboard-operable toggle", async ({ page }) => {
  const server = backend(); seed(server, SESSION_A, "VeľmiDlháPoznámkaBezMedzier".repeat(25));
  server.snapshots.set(SESSION_A, { ...snapshot(""), preview: { version: 1, fields: {
    note: "VeľmiDlháPoznámkaBezMedzier".repeat(25), contacts: "Testovací klient · +421900000001", plate: "TEST001", pickup: "Bratislava, testovacia adresa 1",
  } } });
  await boot(page, server, "viewer", true); const toggle = activity(page).getByRole("button");
  await toggle.focus(); await page.keyboard.press("Enter"); await expect(preview(page)).toContainText("Testovací klient");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const size = await toggle.boundingBox(); expect(size!.height).toBeGreaterThanOrEqual(44); expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(await activity(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await preview(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await activity(page).screenshot({ path: ".context/case-draft-preview/mobile.png" });
  await page.keyboard.press("Space"); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(server.errors).toEqual([]);
});
