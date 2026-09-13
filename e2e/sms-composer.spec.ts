import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/postcss";
import { renderSmsTemplate } from "../src/lib/sms/templates";
import type { SmsConversationEntry, SmsHistoryEntry, SmsInboxMessage, SmsPrepareInput } from "../src/lib/sms/contracts";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://sms.test";
let script: string; let css: string;
test.beforeAll(async () => {
  await mkdir(".context/sms-browser", { recursive: true });
  script = (await build({ entryPoints: ["e2e/fixtures/sms-composer.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } })).outputFiles[0].text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, options: { global?: boolean; width?: number; abortSend?: boolean } = {}) {
  const state = { sends: [] as Record<string, unknown>[], prepares: [] as SmsPrepareInput[], errors: [] as string[], history: [] as SmsHistoryEntry[], locationWrites: [] as unknown[], aborted: false,
    inbox: [] as SmsInboxMessage[], conversation: [] as SmsConversationEntry[], inboxWrites: [] as Record<string, unknown>[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 });
  await page.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { state.errors.push(`External request blocked: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/sms/context") return route.fulfill({ json: { cases: [
      { id: "case-1", caseNumber: "PM-123", name: "Klient jeden", phone: "+421905123456", validPhone: true },
      { id: "case-2", caseNumber: "PM-456", name: "Klient dva", phone: "+421905222222", validPhone: true },
      { id: "case-empty", caseNumber: "PM-789", name: "Bez telefónu", phone: "", validPhone: false },
    ], sender: "PomocMotor", callbackNumber: "+421905654321" } });
    if (url.pathname === "/api/sms/prepare") {
      const body = request.postDataJSON() as SmsPrepareInput; state.prepares.push(body);
      const incoming = state.inbox.find((message) => message.id === body.replyToMessageId);
      const context = { caseNumber: body.caseId === "case-1" ? "PM-123" : "PM-456", callbackNumber: body.callbackNumber, etaMinutes: body.etaMinutes, towAddress: body.towAddress, link: `${origin}/l/${"a".repeat(43)}` };
      return route.fulfill({ json: { proof: "mock-proof", draft: { version: 1, requestId: body.requestId, caseId: body.caseId, caseNumber: body.caseId ? context.caseNumber : null,
        recipientName: incoming ? "Odosielateľ prijatej SMS" : body.caseId === "case-2" ? "Klient dva" : body.caseId ? "Klient jeden" : "Ručne zadaný príjemca", toNumber: incoming?.from ?? (body.caseId === "case-2" ? "+421905222222" : body.caseId ? "+421905123456" : body.toNumber), template: body.template, templateContext: context,
        replyToMessageId: incoming?.id, repliesEnabled: Boolean(incoming),
        message: body.template === "custom" ? body.message : renderSmsTemplate(body.template, context), sender: incoming?.to ?? "PomocMotor" } } });
    }
    if (url.pathname === "/api/sms/send") {
      state.sends.push(request.postDataJSON());
      if (options.abortSend && !state.aborted) { state.aborted = true; return route.abort("failed"); }
      return route.fulfill({ json: { sms: { smsMessageId: "sms-1", status: "sent", statusDetail: "sent", reused: state.aborted } } });
    }
    if (url.pathname === "/api/cases/case-1" && request.method() === "PATCH") { state.locationWrites.push(request.postDataJSON()); return route.fulfill({ json: { dispatchData: { source: "supabase" } } }); }
    if (url.pathname === "/api/sms") return route.fulfill({ json: { messages: state.history, hasMore: false } });
    if (url.pathname === "/api/sms/inbox") {
      const unreadCount = state.inbox.filter((message) => message.unread).length;
      if (url.searchParams.get("summary") === "true") return route.fulfill({ json: { unreadCount } });
      const filter = url.searchParams.get("filter");
      return route.fulfill({ json: { unreadCount, hasMore: false, operators: [{ id: "dispatcher", name: "Dispečer jeden" }], messages: state.inbox.filter((message) => filter === "unread" ? message.unread : filter === "unassigned" ? !message.caseId : true) } });
    }
    if (url.pathname.startsWith("/api/sms/inbox/")) {
      const message = state.inbox.find((entry) => entry.id === url.pathname.split("/").at(-1));
      if (!message) return route.fulfill({ status: 404, json: { error: "SMS sa nenašla." } });
      if (request.method() === "PATCH") {
        const body = request.postDataJSON(); state.inboxWrites.push(body);
        if (body.version && body.version !== message.version) return route.fulfill({ status: 409, json: { error: "SMS medzičasom upravil kolega. Obnovte konverzáciu." } });
        if (body.read != null) message.unread = !body.read;
        if (body.caseId !== undefined) { message.caseId = body.caseId; message.caseNumber = body.caseId === "case-1" ? "PM-123" : body.caseId ? "PM-456" : null; }
        const entry = state.conversation.find((item) => item.id === message.id);
        if (entry) { entry.caseId = message.caseId; entry.caseNumber = message.caseNumber; }
        if (body.assignedProfileId !== undefined) { message.assignedProfileId = body.assignedProfileId; message.assignedName = body.assignedProfileId ? "Dispečer jeden" : null; }
        message.version = String(Number(message.version) + 1);
        return route.fulfill({ json: { smsMessageId: message.id } });
      }
      return route.fulfill({ json: { message, messages: state.conversation, hasMore: false } });
    }
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/telephony/directory") return route.fulfill({ json: { contacts: [] } });
    if (request.method() === "GET") return route.fulfill({ status: 404, json: {} });
    state.errors.push(`Unexpected write: ${request.method()} ${url.pathname}`); return route.abort();
  });
  await page.goto(`${origin}/${options.global ? "?global" : ""}`); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  if (options.global) await page.getByRole("button", { name: /SMS/ }).click();
  await expect(page.getByLabel("Prípad SMS")).toBeEnabled();
  return state;
}
for (const width of [390, 1440]) test(`global SMS requires explicit case selection and fits ${width}px`, async ({ page }) => {
  const state = await boot(page, { global: true, width });
  await expect(page.getByLabel("Prípad SMS")).toHaveValue("");
  await page.getByLabel("Šablóna").selectOption("location_request");
  await expect(page.getByRole("button", { name: "Pripraviť náhľad" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Odoslať SMS", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vytvoriť prípad" })).toBeVisible();
  await page.getByLabel("Prípad SMS").selectOption("case-empty");
  await expect(page.getByRole("button", { name: "Pripraviť náhľad" })).toBeDisabled();
  await page.getByLabel("Prípad SMS").selectOption("case-1");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await expect(page.getByText("Overený príjemca: Klient jeden")).toBeVisible();
  await expect(page.getByLabel("Finálny text na odoslanie")).toContainText(`${origin}/l/${"a".repeat(43)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const dialog = page.getByRole("dialog"); expect(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  await page.screenshot({ path: `.context/sms-browser/editor-${width}.png` });
  await page.getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(page.getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  expect(state.sends).toHaveLength(1); expect(state.errors).toEqual([]);
});
test("an open draft keeps its case, recipient and request through refresh, network failure and close", async ({ page }) => {
  const state = await boot(page, { abortSend: true });
  await page.getByLabel("Text správy").fill("Overena sprava.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await page.evaluate(() => (window as unknown as { changeSmsCase(): void }).changeSmsCase());
  await expect(page.getByText("PM-123 · +421905123456", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Finálny text na odoslanie")).toBeDisabled();
  await page.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.getByRole("button", { name: "Otvoriť SMS" }).click();
  await page.getByRole("button", { name: "Overiť tú istú požiadavku" }).click();
  await expect(page.getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  expect(state.sends).toHaveLength(2); expect(state.sends[1]).toEqual(state.sends[0]); expect(state.errors).toEqual([]);
});
test("ETA needs explicit minutes and departure; custom SMS without a case remains in history", async ({ page }) => {
  const state = await boot(page, { global: true });
  await page.getByLabel("Prípad SMS").selectOption("case-1");
  await page.getByLabel("Šablóna").selectOption("eta_update");
  await expect(page.getByRole("button", { name: "Pripraviť náhľad" })).toBeDisabled();
  await page.getByLabel("Aktuálny odhad príchodu (minúty)").fill("25");
  await page.getByRole("checkbox", { name: /Potvrdzujem/ }).check();
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await expect(page.getByLabel("Finálny text na odoslanie")).toContainText("25 min");
  await page.getByRole("button", { name: "Upraviť údaje" }).click();
  await page.getByLabel("Prípad SMS").selectOption("");
  await page.getByRole("button", { name: "Zahodiť koncept a potvrdiť zmenu" }).click();
  await page.getByLabel("Šablóna").selectOption("custom");
  await page.getByLabel("Telefón príjemcu").fill("+421905123456"); await page.getByLabel("Text správy").fill("Vlastna SMS bez pripadu.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click(); await page.getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(page.getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  state.history = [{ id: "sms-1", caseId: null, caseNumber: null, recipientName: "Ručný príjemca", toNumber: "+421905123456", author: "Dispečer", body: "Vlastna SMS bez pripadu.", sender: "PomocMotor", createdAt: "2026-09-07T08:00:00Z", status: "sent", statusDetail: "delivery_unconfirmed", error: null, template: "custom", location: null }];
  await page.getByRole("button", { name: "História SMS", exact: true }).click();
  await expect(page.getByText("Doručenie nepotvrdené", { exact: true })).toBeVisible();
  await expect(page.getByText("Bez prípadu", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("delivery refresh and incident-location adoption work after closing the editor", async ({ page }) => {
  await page.clock.install();
  const state = await boot(page);
  state.history = [{ id: "sms-1", caseId: "case-1", caseNumber: "PM-123", recipientName: "Klient", toNumber: "+421905123456", author: "Dispečer", body: "Test", sender: "PomocMotor", createdAt: "2026-09-07T08:00:00Z", status: "sent", statusDetail: "sent", error: null, template: "custom", location: null }];
  await page.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.getByText("História SMS prípadu", { exact: true }).click();
  await expect(page.getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  state.history[0].status = "delivered"; state.history[0].statusDetail = "delivered";
  await page.clock.fastForward(10_100);
  await expect(page.getByText("Doručená", { exact: true })).toBeVisible();
  expect(state.locationWrites).toHaveLength(0);
  await page.getByRole("button", { name: "Použiť ako miesto incidentu" }).click();
  await expect.poll(() => state.locationWrites.length).toBe(1);
  expect(state.locationWrites[0]).toMatchObject({ pickup: { lat: 48.1, lng: 17.1 } });
  expect(state.errors).toEqual([]);
});

test("a later explicit location quick action opens that template without redirecting an open draft", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as unknown as { changeSmsTemplate(): void }).changeSmsTemplate());
  await expect(page.getByLabel("Šablóna")).toHaveValue("custom");
  await page.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.getByRole("button", { name: "Otvoriť SMS" }).click();
  await expect(page.getByLabel("Šablóna")).toHaveValue("location_request");
});

test("changing a template preserves the draft until explicit discard and invalidates its old request", async ({ page }) => {
  const state = await boot(page, { width: 390 });
  await page.getByLabel("Text správy").fill("Text dohodnutý s klientom A.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  const originalId = state.prepares[0].requestId;
  await page.getByRole("button", { name: "Upraviť údaje" }).click();
  await page.getByLabel("Šablóna").selectOption("location_request");
  await expect(page.getByLabel("Šablóna")).toHaveValue("custom");
  await expect(page.getByLabel("Text správy")).toHaveValue("Text dohodnutý s klientom A.");
  await expect(page.getByRole("button", { name: "Pripraviť náhľad" })).toBeDisabled();
  await page.getByRole("button", { name: "Zachovať rozpracovanú SMS" }).click();
  await expect(page.getByLabel("Text správy")).toHaveValue("Text dohodnutý s klientom A.");
  await page.getByLabel("Šablóna").selectOption("location_request");
  await page.getByRole("button", { name: "Zahodiť koncept a potvrdiť zmenu" }).click();
  await expect(page.getByLabel("Šablóna")).toHaveValue("location_request");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  expect(state.prepares[1]).toMatchObject({ caseId: "case-1", template: "location_request", message: "" });
  expect(state.prepares[1].requestId).not.toBe(originalId);
  expect(state.sends).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("changing the case never carries one client's draft into another recipient", async ({ page }) => {
  const state = await boot(page);
  await page.getByLabel("Text správy").fill("Súkromný pokyn pre klienta A.");
  await page.getByLabel("Prípad SMS").selectOption("case-2");
  await expect(page.getByLabel("Prípad SMS")).toHaveValue("case-1");
  await expect(page.getByLabel("Text správy")).toHaveValue("Súkromný pokyn pre klienta A.");
  await page.getByRole("button", { name: "Zachovať rozpracovanú SMS" }).click();
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await expect(page.getByText("PM-123 · +421905123456", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Upraviť údaje" }).click();
  await page.getByLabel("Prípad SMS").selectOption("case-2");
  await page.getByRole("button", { name: "Zahodiť koncept a potvrdiť zmenu" }).click();
  await expect(page.getByLabel("Text správy")).toHaveValue("");
  await page.getByLabel("Text správy").fill("Nový pokyn iba pre klienta B.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await expect(page.getByText("PM-456 · +421905222222", { exact: true })).toBeVisible();
  expect(state.prepares[1]).toMatchObject({ caseId: "case-2", message: "Nový pokyn iba pre klienta B." });
  expect(state.prepares[1].requestId).not.toBe(state.prepares[0].requestId);
  expect(state.sends).toHaveLength(0); expect(state.errors).toEqual([]);
});

for (const intent of ["case", "template"] as const) test(`reopening from a different ${intent} asks before replacing a normal SMS draft`, async ({ page }) => {
  const state = await boot(page);
  await page.getByLabel("Text správy").fill("Pôvodná rozpracovaná správa.");
  await page.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.evaluate(kind => {
    const fixture = window as unknown as { changeSmsCase(): void; changeSmsTemplate(): void };
    if (kind === "case") fixture.changeSmsCase(); else fixture.changeSmsTemplate();
  }, intent);
  await page.getByRole("button", { name: "Otvoriť SMS" }).click();
  await expect(page.getByLabel("Prípad SMS")).toHaveValue("case-1");
  await expect(page.getByLabel("Šablóna")).toHaveValue("custom");
  await expect(page.getByLabel("Text správy")).toHaveValue("Pôvodná rozpracovaná správa.");
  await page.getByRole("button", { name: "Zachovať rozpracovanú SMS" }).click();
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  expect(state.prepares[0]).toMatchObject({ caseId: "case-1", template: "custom", message: "Pôvodná rozpracovaná správa." });
  await page.getByRole("button", { name: "Zavrieť SMS" }).click();
  await page.getByRole("button", { name: "Otvoriť SMS" }).click();
  await page.getByRole("button", { name: "Zahodiť koncept a potvrdiť zmenu" }).click();
  await expect(page.getByLabel("Prípad SMS")).toHaveValue(intent === "case" ? "case-2" : "case-1");
  await expect(page.getByLabel("Šablóna")).toHaveValue(intent === "template" ? "location_request" : "custom");
  if (intent === "case") await expect(page.getByLabel("Text správy")).toHaveValue("");
  expect(state.sends).toHaveLength(0); expect(state.errors).toEqual([]);
});

function incomingMessage(): SmsInboxMessage {
  return { id: "incoming-1", version: "1", from: "+421905777777", to: "+12025550123", body: "Som pri pumpe.", createdAt: "2026-09-07T10:00:00Z",
    caseId: null, caseNumber: null, assignedProfileId: null, assignedName: null, unread: true, canReply: true, hasMedia: false };
}
for (const width of [390, 1440]) test(`inbound SMS needs explicit assignment and replies to the real sender at ${width}px`, async ({ page }) => {
  const state = await boot(page, { global: true, width });
  state.inbox = [incomingMessage()];
  state.conversation = [{ id: "incoming-1", body: "Som pri pumpe.", direction: "inbound", createdAt: "2026-09-07T10:00:00Z", status: "received", statusDetail: "received_unread", caseId: null, caseNumber: null }];
  await page.getByRole("button", { name: "Prijaté SMS", exact: true }).click();
  await page.getByRole("button", { name: /\+421905777777/ }).click();
  await expect(page.getByLabel("Prípad prijatej SMS")).toHaveValue("");
  expect(state.inboxWrites).toHaveLength(0);
  await page.getByLabel("Prípad prijatej SMS").selectOption("case-1");
  await page.getByLabel("Dispečer prijatej SMS").selectOption("dispatcher");
  await expect(page.getByRole("button", { name: "Napísať odpoveď" })).toBeDisabled();
  await page.getByRole("button", { name: "Uložiť priradenie tejto správy" }).click();
  await expect(page.getByLabel("Prípad prijatej SMS")).toHaveValue("case-1");
  await page.getByRole("button", { name: "Označiť ako prečítanú", exact: true }).click();
  await expect(page.getByRole("button", { name: "Označiť ako neprečítanú", exact: true })).toBeVisible();
  expect(state.inboxWrites).toHaveLength(2);
  expect(await page.getByRole("dialog").evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(false);
  await page.screenshot({ path: `.context/sms-browser/inbox-${width}.png` });
  await page.getByRole("button", { name: "Napísať odpoveď" }).click();
  await expect(page.getByText("Odpoveď na prijatú SMS od +421905777777")).toBeVisible();
  await page.getByLabel("Text správy").fill("Pomoc je na ceste.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await expect(page.getByText("PM-123 · +421905777777", { exact: true })).toBeVisible();
  await expect(page.getByText(/Klient môže odpovedať na toto číslo/)).toBeVisible();
  await page.getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(page.getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0]).toMatchObject({ draft: { toNumber: "+421905777777", sender: "+12025550123", caseId: "case-1", replyToMessageId: "incoming-1" } });
  expect(state.errors).toEqual([]);
});

test("an uncertain previous send cannot be replaced with an inbox reply", async ({ page }) => {
  const state = await boot(page, { abortSend: true }); state.inbox = [incomingMessage()];
  await page.getByLabel("Text správy").fill("Pôvodná SMS.");
  await page.getByRole("button", { name: "Pripraviť náhľad" }).click();
  await page.getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Prijaté SMS", exact: true }).click();
  await page.getByRole("button", { name: /\+421905777777/ }).click();
  await expect(page.getByRole("button", { name: "Napísať odpoveď" })).toBeDisabled();
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByLabel("Finálny text na odoslanie")).toHaveValue("Pôvodná SMS.");
  await expect(page.getByRole("button", { name: "Overiť tú istú požiadavku" })).toBeVisible();
});
