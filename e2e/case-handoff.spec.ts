import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { CaseHandoff, HandoffPublished } from "../src/domain/case-handoff";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;
const id = "10000000-0000-4000-8000-000000000001", caseId = "20000000-0000-4000-8000-000000000001", secret = "a".repeat(43);
const published: HandoffPublished = { caseNumber: "PM-2026-100", action: "Pristavenie vozidla", contact: { name: "Klient Juraj", phone: "+421905123456" }, vehicle: { make: "Škoda", model: "Octavia", plate: "BA123AB" }, pickup: { address: "Dlhá ulica 123, Bratislava, vstup z bočnej ulice pri veľkej budove", lat: 48.1, lng: 17.1 }, destination: { address: "Servis Pri stanici 4", lat: 48.2, lng: 17.2 }, instructions: "Pri príchode zavolať. Prevziať podpísaný protokol.", scheduledAt: "2026-09-12T12:00:00Z" };
const base: CaseHandoff = { id, recipientName: "Peter · stredisko Bratislava", recipientPhone: "+421907987654", status: "offered", revision: 1, publishedVersion: 1, expiresAt: "2026-09-13T12:00:00Z", createdAt: "2026-09-12T08:00:00Z", openedAt: null, eta: null, published, events: [] };
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-handoff.tsx"], outfile: ".context/case-handoff-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, options: { sender?: boolean; existing?: boolean; lostDecision?: boolean; lostIssue?: boolean; width?: number; sessionStatus?: number; frozen?: boolean; server?: { grant: CaseHandoff; active: boolean } } = {}) {
  const errors: string[] = [], external: string[] = [], decisions: Record<string, unknown>[] = [], internal: Record<string, unknown>[] = [], prepares: Record<string, unknown>[] = [], sends: string[] = [], reads: string[] = [];
  const server = options.server ?? { grant: structuredClone(base), active: Boolean(options.existing) };
  let lost = false, otherSession = false, denyInternal = false, publicDenied = 0;
  const sessions: string[] = [];
  const receipts = new Map<string, unknown>();
  await page.setViewportSize({ width: options.width ?? 390, height: 844 });
  await page.clock.install({ time: new Date("2026-09-12T08:00:00Z") });
  if (options.frozen) await page.clock.pauseAt(new Date("2026-09-12T08:00:01Z"));
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "https://handoff.test") { external.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="root"></div><script>${script}</script></body></html>` });
    if (request.method() === "GET") reads.push(url.pathname);
    if (url.pathname === "/api/public/handoffs/session") { sessions.push(request.method()); return options.sessionStatus ? route.fulfill({ status: options.sessionStatus, json: { error: "Dočasne nedostupné" } }) : route.fulfill({ json: { handoff: server.grant } }); }
    if (url.pathname === "/api/public/handoffs/current") {
      expect(url.searchParams.get("handoff")).toBe(id);
      if (publicDenied) return route.fulfill({ status: publicDenied, json: { error: "Odkaz už nie je dostupný." } });
      return otherSession ? route.fulfill({ status: 404, json: { error: "Odkaz nie je dostupný." } }) : route.fulfill({ json: { handoff: server.grant } });
    }
    if (url.pathname === "/api/public/handoffs/commands") {
      const data = request.postDataJSON(); decisions.push(data); expect(data.handoffId).toBe(id);
      if (otherSession) return route.fulfill({ status: 404, json: { error: "Odkaz nie je dostupný." } });
      if (!receipts.has(data.commandId)) {
        const status = ({ accept: "accepted", reject: "rejected", en_route: "en_route", arrived: "arrived", complete: "completed" } as const)[data.action as "accept"] || server.grant.status;
        server.grant = { ...server.grant, revision: server.grant.revision + 1, status, published: ["completed", "rejected"].includes(status) ? null : server.grant.published, events: [], ...(data.eta !== undefined ? { eta: data.eta } : {}) };
        receipts.set(data.commandId, { handoff: server.grant, commandId: data.commandId, committedRevision: server.grant.revision });
      }
      if (options.lostDecision && !lost) { lost = true; return route.abort("failed"); }
      return route.fulfill({ json: receipts.get(data.commandId) });
    }
    if (url.pathname === `/api/cases/${caseId}/handoffs`) {
      if (denyInternal) return route.fulfill({ status: 403, json: { error: "Prístup k prípadu bol zrušený." } });
      if (request.method() === "GET") return route.fulfill({ json: { preview: published, previewVersion: "c".repeat(64), handoffs: server.active ? [server.grant] : [] } });
      const data = request.postDataJSON(); internal.push(data);
      const replay = receipts.has(data.commandId);
      if (!receipts.has(data.commandId)) {
        if (data.action === "issue") { server.active = true; server.grant = { ...base, recipientName: data.recipientName, recipientPhone: data.recipientPhone, published: { ...published, instructions: data.instructions, scheduledAt: data.scheduledAt } }; }
        else server.grant = { ...server.grant, revision: server.grant.revision + 1, published: data.action === "publish" ? { ...published, instructions: data.instructions, scheduledAt: data.scheduledAt } : server.grant.published };
        receipts.set(data.commandId, { handoff: server.grant, commandId: data.commandId, committedRevision: server.grant.revision, ...(data.action === "issue" || data.action === "renew" ? { url: `https://handoff.test/handoff#token=${String.fromCharCode(97 + server.grant.revision).repeat(43)}` } : {}) });
      }
      if (options.lostIssue && !lost) { lost = true; return route.abort("failed"); }
      const receipt = { ...(receipts.get(data.commandId) as Record<string, unknown>) }; if (replay) delete receipt.url;
      return route.fulfill({ json: receipt });
    }
    if (url.pathname === "/api/sms/context") return route.fulfill({ json: { cases: [{ id: caseId, caseNumber: base.published!.caseNumber, name: "Klient Juraj", phone: "+421905123456", validPhone: true }], tasks: [], callbackNumber: "+421900000000", sender: "PomocMotor", repliesEnabled: false } });
    if (url.pathname === "/api/sms/prepare") {
      const data = request.postDataJSON(); prepares.push(data);
      return route.fulfill({ json: { draft: { ...data, requestId: data.requestId, recipientName: "Kolega", toNumber: data.toNumber, sender: "PomocMotor", caseId: null, caseNumber: null }, proof: "fixture-proof" } });
    }
    if (url.pathname === "/api/sms/send") { sends.push(request.postData() || ""); return route.fulfill({ status: 503, json: { error: "Izolovaný test neodosiela SMS." } }); }
    return route.fulfill({ status: 503, json: { error: "Neobslúžená testovacia cesta" } });
  });
  await page.goto(`https://handoff.test/handoff${options.sender ? "?sender=1" : `#token=${secret}`}`);
  return { errors, external, decisions, internal, prepares, sends, reads, sessions, server, denyPublic: (status: number) => { publicDenied = status; }, substituteSession: () => { otherSession = true; }, revokeInternal: () => { denyInternal = true; } };
}

test("recipient sees one mobile case, explicitly accepts and progresses, preserving grant binding on reload", async ({ page }, info) => {
  const trace = await boot(page);
  await expect(page.getByRole("heading", { name: "PM-2026-100" })).toBeVisible();
  expect(page.url()).toBe(`https://handoff.test/handoff?handoff=${id}`);
  expect(trace.decisions).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("mobile-offered.png"), fullPage: true });
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Vyrážam na cestu" })).toBeVisible();
  await page.getByRole("button", { name: "Vyrážam na cestu" }).click();
  await page.getByRole("button", { name: "Som na mieste" }).click();
  await page.getByRole("button", { name: "Potvrdiť dokončenie" }).click();
  await expect(page.getByText("Údaje klienta sa už nezobrazujú.", { exact: false })).toBeVisible();
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  expect(trace.decisions.map(item => item.action)).toEqual(["accept", "en_route", "arrived", "complete"]);
  expect(trace.errors).toEqual([]); expect(trace.external).toEqual([]);
});

test("lost decision response retains reason and repeats the same command only once", async ({ page }) => {
  const trace = await boot(page, { lostDecision: true });
  await page.getByRole("button", { name: "Odmietnuť", exact: true }).click();
  await expect(page.getByRole("button", { name: "Potvrdiť odmietnutie" })).toBeDisabled();
  await page.getByLabel("Dôvod odmietnutia").fill("Všetky vozidlá máme obsadené.");
  await page.getByRole("button", { name: "Potvrdiť odmietnutie" }).click();
  await expect(page.getByLabel("Dôvod odmietnutia")).toHaveValue("Všetky vozidlá máme obsadené.");
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky" }).click();
  await expect(page.getByText("Odmietnutie je zaznamenané.", { exact: true })).toBeVisible();
  expect(trace.decisions).toHaveLength(2); expect(trace.decisions[1]).toEqual(trace.decisions[0]);
  expect(trace.errors).toEqual([]); expect(trace.external).toEqual([]);
});

test("another tab's session cannot decide the displayed case and removes stale private fields", async ({ page }) => {
  const trace = await boot(page);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  trace.substituteSession();
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await expect(page.getByRole("alert")).toContainText("Odkaz nie je dostupný");
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  expect(trace.decisions[0].handoffId).toBe(id);
  expect(trace.errors).toEqual([]);
});

test("sender issues explicitly, keeps uncertain command through style changes, and prepares colleague standalone SMS", async ({ page }, info) => {
  const trace = await boot(page, { sender: true, lostIssue: true, width: 1280 });
  expect(trace.reads).toHaveLength(0);
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await page.getByLabel("Stredisko alebo kolega").fill("Peter · Bratislava");
  await page.getByLabel("Telefón príjemcu odkazu").fill("+421907987654");
  await page.getByLabel("Pokyny pre kolegu", { exact: true }).fill("Zavolať pri príchode.");
  await page.screenshot({ path: info.outputPath("sender-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu" }).click();
  await page.getByRole("button", { name: "Prepnúť vzhľad" }).click();
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky" }).click();
  expect(trace.internal).toHaveLength(2); expect(trace.internal[1]).toEqual(trace.internal[0]);
  await expect(page.getByRole("status")).toContainText("Tajný odkaz sa z prvej odpovede nepodarilo obnoviť");
  await page.getByRole("button", { name: "Obnoviť odkaz", exact: true }).click();
  await page.getByRole("button", { name: "Otvoriť SMS pre kolegu" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Telefón príjemcu", { exact: true })).toHaveValue("+421907987654");
  await expect(dialog.getByLabel("Prípad SMS")).toHaveValue(""); await expect(dialog.getByLabel("Prípad SMS")).toBeDisabled();
  await expect(dialog.getByLabel("Text správy", { exact: false }).first()).toHaveValue(/handoff#token=[a-z]{43}/);
  await dialog.getByRole("button", { name: /Pripraviť náhľad/ }).click();
  await expect(dialog.getByText("+421907987654", { exact: false }).last()).toBeVisible();
  expect(trace.prepares).toHaveLength(1); expect(trace.prepares[0]).toMatchObject({ caseId: null, toNumber: "+421907987654", template: "custom" });
  expect(trace.sends).toHaveLength(0); expect(trace.errors).toEqual([]); expect(trace.external).toEqual([]);
});

test("existing publication fields survive refresh and local edits survive reload of context", async ({ page }) => {
  const trace = await boot(page, { sender: true, existing: true, width: 768 });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  const instructions = page.getByLabel("Pokyny pre kolegu", { exact: true });
  await expect(instructions).toHaveValue(published.instructions!);
  await expect(page.getByLabel("Dohodnutý čas", { exact: true })).not.toHaveValue("");
  await instructions.fill("Môj rozpracovaný pokyn");
  await page.clock.runFor(1000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => trace.reads.length).toBe(2);
  await expect(instructions).toHaveValue("Môj rozpracovaný pokyn");
  await page.getByRole("button", { name: "Zverejniť tento výber údajov" }).click();
  expect(trace.internal[0]).toMatchObject({ action: "publish", instructions: "Môj rozpracovaný pokyn", scheduledAt: new Date(published.scheduledAt!).toISOString() });
  expect(trace.errors).toEqual([]); expect(trace.external).toEqual([]);
});

test("renewing a link keeps the existing SMS draft and requires explicit append", async ({ page }) => {
  const trace = await boot(page, { sender: true, existing: true, width: 1280 });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await page.getByRole("button", { name: "Obnoviť odkaz", exact: true }).click();
  await page.getByRole("button", { name: "Otvoriť SMS pre kolegu" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Text správy", { exact: false }).first().fill("Môj pôvodný rozpracovaný text");
  await dialog.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.getByRole("button", { name: "Obnoviť odkaz", exact: true }).click();
  await page.getByRole("button", { name: "Otvoriť SMS pre kolegu" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Text správy", { exact: false }).first()).toHaveValue("Môj pôvodný rozpracovaný text");
  await expect(dialog.getByText("Máte rozpracovanú SMS.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Pripojiť odkaz a nastaviť príjemcu" }).click();
  await expect(dialog.getByLabel("Text správy", { exact: false }).first()).toHaveValue(/Môj pôvodný rozpracovaný text\n.*handoff#token=/);
  expect(trace.sends).toHaveLength(0); expect(trace.errors).toEqual([]);
});

test("background read never blocks a command and its delayed response cannot replace the receipt", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, String(input).endsWith("/handoffs") && (!init?.method || init.method === "GET") ? { ...init, signal: undefined } : init);
  });
  const trace = await boot(page, { sender: true, existing: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue(published.instructions!);
  let count = 0, release: (() => Promise<void>) | undefined;
  await page.route(`https://handoff.test/api/cases/${caseId}/handoffs`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    count++;
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: { preview: published, previewVersion: "c".repeat(64), handoffs: [{ ...base, revision: 99, publishedVersion: 99 }] } }).catch(() => {}); resolve(); }; });
  });
  await page.clock.runFor(33_100);
  await expect.poll(() => count).toBe(1);
  await expect(page.getByRole("button", { name: "Zverejniť tento výber údajov" })).toBeEnabled();
  await page.getByRole("button", { name: "Zverejniť tento výber údajov" }).click();
  await expect.poll(() => trace.internal.length).toBe(1);
  await release!();
  await expect(page.getByText(/verzia údajov 99/)).toHaveCount(0);
  expect(trace.internal[0].expectedRevision).toBe(1);
  expect(trace.errors).toEqual([]);
});

test("revoked internal case access clears displayed private data and the bearer link", async ({ page }) => {
  const trace = await boot(page, { sender: true, existing: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await page.getByRole("button", { name: "Obnoviť odkaz", exact: true }).click();
  await expect(page.getByRole("button", { name: "Otvoriť SMS pre kolegu" })).toBeVisible();
  trace.revokeInternal();
  await page.getByRole("button", { name: "Zverejniť tento výber údajov" }).click();
  await expect(page.getByRole("alert")).toContainText("Prístup k prípadu bol zrušený");
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Otvoriť SMS pre kolegu" })).toHaveCount(0);
  expect(trace.errors).toEqual([]);
});

for (const width of [360, 390, 768, 1366]) test(`public card preserves readable content without page overflow at ${width}px`, async ({ page }) => {
  const trace = await boot(page, { width });
  await expect(page.getByRole("button", { name: "Prijať prípad" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const size = await page.getByRole("button", { name: "Prijať prípad" }).boundingBox(); expect(size!.height).toBeGreaterThanOrEqual(44);
  expect(trace.errors).toEqual([]); expect(trace.external).toEqual([]);
});


test("two clients see an accepted handoff automatically while preserving sender drafts within the read budget", async ({ page, browser }) => {
  const server = { grant: structuredClone(base), active: true };
  const sender = await boot(page, { sender: true, server });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  const instructions = page.getByLabel("Pokyny pre kolegu", { exact: true });
  await expect(instructions).toHaveValue(published.instructions!);
  await instructions.fill("Rozpracovaný miestny pokyn");
  await page.getByLabel("Dohodnutý čas", { exact: true }).fill("2026-09-12T16:30");
  await page.getByRole("textbox", { name: "Dôvod zrušenia", exact: true }).fill("Rozpracovaný dôvod");
  const recipientPage = await browser.newPage();
  const recipient = await boot(recipientPage, { server });
  await recipientPage.getByRole("button", { name: "Prijať prípad" }).click();
  await expect(recipientPage.getByRole("button", { name: "Vyrážam na cestu" })).toBeVisible();
  await page.clock.runFor(33_100);
  await expect(page.locator(".handoff-status")).toHaveText("Prijaté");
  await expect(instructions).toHaveValue("Rozpracovaný miestny pokyn");
  await expect(page.getByLabel("Dohodnutý čas", { exact: true })).toHaveValue("2026-09-12T16:30");
  await expect(page.getByRole("textbox", { name: "Dôvod zrušenia", exact: true })).toHaveValue("Rozpracovaný dôvod");
  await page.clock.runFor(26_000);
  expect(sender.reads.length).toBeLessThanOrEqual(3);
  expect(sender.internal).toHaveLength(0);
  expect(recipient.decisions).toHaveLength(1);
  expect(recipient.sessions).toEqual(["POST"]);
  expect([...sender.external, ...recipient.external, ...sender.errors, ...recipient.errors]).toEqual([]);
  await recipientPage.close();
});

test("recipient GET refresh preserves ETA and comment and never repeats the session exchange", async ({ page }) => {
  const trace = await boot(page);
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await page.getByLabel("Nový odhad príchodu (voliteľné)").fill("2026-09-12T11:15");
  await page.getByLabel("Poznámka k priebehu").fill("Miestny rozpracovaný komentár");
  trace.server.grant = { ...trace.server.grant, publishedVersion: 2, published: { ...published, instructions: "Nové zverejnené pokyny" } };
  await page.clock.runFor(33_100);
  await expect(page.getByText("Nové zverejnené pokyny", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Nový odhad príchodu (voliteľné)")).toHaveValue("2026-09-12T11:15");
  await expect(page.getByLabel("Poznámka k priebehu")).toHaveValue("Miestny rozpracovaný komentár");
  expect(trace.sessions).toEqual(["POST"]);
  expect(trace.decisions).toHaveLength(1);
  expect(trace.reads).toEqual(["/api/public/handoffs/current"]);
  expect(trace.external).toEqual([]);
});

test("successful automatic GET preserves an uncertain command error and its original idempotency payload", async ({ page }) => {
  const trace = await boot(page, { lostDecision: true });
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const originalError = await page.getByRole("alert").textContent();
  await page.clock.runFor(33_100);
  await expect.poll(() => trace.reads.length).toBe(1);
  await expect(page.getByRole("alert")).toHaveText(originalError!);
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky" }).click();
  expect(trace.decisions).toHaveLength(2);
  expect(trace.decisions[1]).toEqual(trace.decisions[0]);
  expect(trace.sessions).toHaveLength(1);
});

for (const status of [401, 403, 404, 410]) test(`public GET ${status} clears private data and stops reads without exchanging a new session`, async ({ page }) => {
  const trace = await boot(page);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  trace.denyPublic(status);
  await page.clock.runFor(33_100);
  await expect(page.getByRole("alert")).toContainText("Odkaz už nie je dostupný");
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  await page.clock.runFor(130_000);
  expect(trace.reads).toHaveLength(1);
  expect(trace.sessions).toHaveLength(1);
  expect(trace.decisions).toHaveLength(0);
});

test("recipient expiry clears the card and stops polling", async ({ page }) => {
  const trace = await boot(page);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  trace.server.grant = { ...trace.server.grant, expiresAt: "2026-09-12T08:00:20Z" };
  await page.clock.runFor(33_100);
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Platnosť odkazu skončila");
  await page.clock.runFor(130_000);
  expect(trace.reads).toHaveLength(1);
});

test("hidden sender stops reads and coalesces a burst on return while keeping its draft", async ({ page }) => {
  const trace = await boot(page, { sender: true, existing: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue(published.instructions!);
  await page.getByLabel("Pokyny pre kolegu", { exact: true }).fill("Zachovaný pokyn");
  await page.getByRole("button", { name: "Prepnúť aktívny panel" }).click();
  await page.clock.runFor(130_000);
  expect(trace.reads).toHaveLength(1);
  await page.getByRole("button", { name: "Prepnúť aktívny panel" }).click();
  await page.evaluate(() => { for (let i = 0; i < 20; i++) { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); } });
  await page.clock.runFor(250);
  await expect.poll(() => trace.reads.length).toBe(2);
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue("Zachovaný pokyn");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(130_000);
  expect(trace.reads).toHaveLength(2);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(250);
  await expect.poll(() => trace.reads.length).toBe(3);
  expect(trace.internal).toHaveLength(0);
});

test("read failures back off to 60 then 120 seconds without blocking commands", async ({ page }) => {
  const trace = await boot(page, { sender: true, existing: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue(published.instructions!);
  let failedReads = 0;
  await page.route(`https://handoff.test/api/cases/${caseId}/handoffs`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    failedReads++;
    return route.fulfill({ status: 503, json: { error: "Dočasná chyba čítania" } });
  });
  await page.clock.runFor(33_100);
  await expect(page.getByRole("alert")).toContainText("Dočasná chyba čítania");
  await expect(page.getByRole("button", { name: "Zverejniť tento výber údajov" })).toBeEnabled();
  await page.clock.runFor(59_000); expect(failedReads).toBe(1);
  await page.clock.runFor(2_000); await expect.poll(() => failedReads).toBe(2);
  await page.clock.runFor(119_000); expect(failedReads).toBe(2);
  await page.clock.runFor(2_000); await expect.poll(() => failedReads).toBe(3);
  expect(trace.internal).toHaveLength(0);
});


test("late ignored-abort response cannot restore recipient data after a newer revoked read", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, String(input).includes("/api/public/handoffs/current") ? { ...init, signal: undefined } : init);
  });
  const trace = await boot(page);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  let reads = 0, release: (() => Promise<void>) | undefined;
  await page.route("https://handoff.test/api/public/handoffs/current?**", async route => {
    if (++reads > 1) return route.fulfill({ status: 403, json: { error: "Prístup bol odobratý" } });
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: { handoff: base } }).catch(() => {}); resolve(); }; });
  });
  await page.clock.runFor(33_100);
  await expect.poll(() => reads).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(250);
  await expect(page.getByRole("alert")).toContainText("Prístup bol odobratý");
  await release!();
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  await page.clock.runFor(130_000);
  expect(reads).toBe(2);
  expect(trace.sessions).toHaveLength(1);
  expect(trace.decisions).toHaveLength(0);
});

test("failed initial session exchange is never replayed automatically", async ({ page }) => {
  const trace = await boot(page, { sessionStatus: 503 });
  await expect(page.getByRole("alert")).toContainText("Otvorte znovu pôvodný odkaz");
  await page.clock.runFor(180_000);
  expect(trace.sessions).toEqual(["POST"]);
  expect(trace.decisions).toHaveLength(0);
  expect(trace.reads).toHaveLength(0);
});

test("sender keeps an uncertain issue error and command intact after successful context polling", async ({ page }) => {
  const trace = await boot(page, { sender: true, lostIssue: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await page.getByLabel("Stredisko alebo kolega").fill("Peter");
  await page.getByLabel("Telefón príjemcu odkazu").fill("+421907987654");
  await page.getByLabel("Pokyny pre kolegu", { exact: true }).fill("Miestne pokyny");
  await page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const issueError = await page.getByRole("alert").textContent();
  await page.clock.runFor(33_100);
  await expect.poll(() => trace.reads.length).toBe(2);
  await expect(page.getByRole("alert")).toHaveText(issueError!);
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue("Miestne pokyny");
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky" }).click();
  expect(trace.internal).toHaveLength(2);
  expect(trace.internal[1]).toEqual(trace.internal[0]);
});

test("next background read is scheduled after completion and concurrent resume events do not duplicate it", async ({ page }) => {
  await boot(page, { sender: true, existing: true });
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await expect(page.getByLabel("Pokyny pre kolegu", { exact: true })).toHaveValue(published.instructions!);
  let reads = 0, release: (() => Promise<void>) | undefined;
  await page.route(`https://handoff.test/api/cases/${caseId}/handoffs`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    const reply = () => route.fulfill({ json: { preview: published, previewVersion: "c".repeat(64), handoffs: [{ ...base, publishedVersion: 3 }] } });
    if (reads > 1) return reply();
    await new Promise<void>(resolve => { release = async () => { await reply(); resolve(); }; });
  });
  await page.clock.runFor(33_100); await expect.poll(() => reads).toBe(1);
  await page.clock.runFor(10_000);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event("focus")); });
  await page.clock.runFor(250); expect(reads).toBe(1);
  await release!(); await expect(page.getByText(/verzia údajov 3/)).toBeVisible();
  await page.clock.runFor(29_000); expect(reads).toBe(1);
  await page.clock.runFor(4_100); await expect.poll(() => reads).toBe(2);
});

test("a command receipt arriving after local expiry cannot restore private data", async ({ page }) => {
  const server = { grant: { ...structuredClone(base), expiresAt: "2026-09-12T08:00:06Z" }, active: true };
  await boot(page, { server });
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  let release: (() => Promise<void>) | undefined;
  await page.route("https://handoff.test/api/public/handoffs/commands", async route => {
    const command = route.request().postDataJSON();
    await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: { handoff: { ...server.grant, revision: 2, status: "accepted" }, commandId: command.commandId, committedRevision: 2 } }); resolve(); }; });
  });
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.clock.runFor(7_000);
  await expect(page.getByRole("alert")).toContainText("Platnosť odkazu skončila");
  await release!();
  await expect(page.getByText("Klient Juraj", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vyrážam na cestu" })).toHaveCount(0);
});


test("a hide and return within the read cooldown re-arms both refresh and the next poll", async ({ page }) => {
  const trace = await boot(page, { frozen: true });
  await page.clock.runFor(250);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  trace.server.grant = { ...trace.server.grant, publishedVersion: 2 };
  // The clock stays frozen at the successful exchange, deterministically inside 500 ms.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    for (let i = 0; i < 20; i++) { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); }
  });
  await page.clock.runFor(750);
  await expect(page.getByText(/verzia údajov 2/)).toBeVisible();
  expect(trace.reads).toHaveLength(1);
  trace.server.grant = { ...trace.server.grant, publishedVersion: 3 };
  await page.clock.runFor(33_100);
  await expect(page.getByText(/verzia údajov 3/)).toBeVisible();
  expect(trace.reads).toHaveLength(2);
  expect(trace.sessions).toHaveLength(1);
  expect(trace.decisions).toHaveLength(0);
});

test("focus and online bursts while a command pauses reading do not lose the post-command timer", async ({ page }) => {
  const trace = await boot(page);
  await expect(page.getByText("Klient Juraj", { exact: true })).toBeVisible();
  let release: (() => Promise<void>) | undefined;
  await page.route("https://handoff.test/api/public/handoffs/commands", async route => {
    const command = route.request().postDataJSON();
    await new Promise<void>(resolve => { release = async () => {
      trace.server.grant = { ...trace.server.grant, status: "accepted", revision: 2 };
      await route.fulfill({ json: { handoff: trace.server.grant, commandId: command.commandId, committedRevision: 2 } }); resolve();
    }; });
  });
  await page.getByRole("button", { name: "Prijať prípad" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); } });
  await page.clock.runFor(1000);
  expect(trace.reads).toHaveLength(0);
  await release!();
  await expect(page.getByRole("button", { name: "Vyrážam na cestu" })).toBeVisible();
  trace.server.grant = { ...trace.server.grant, publishedVersion: 2 };
  await page.clock.runFor(33_100);
  await expect(page.getByText(/verzia údajov 2/)).toBeVisible();
  expect(trace.reads).toHaveLength(1);
  await page.clock.runFor(33_100);
  await expect.poll(() => trace.reads.length).toBe(2);
  expect(trace.sessions).toHaveLength(1);
});
