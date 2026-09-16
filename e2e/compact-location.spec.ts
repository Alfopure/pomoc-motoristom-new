import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { dispatchCases } from "../src/mock/seed";
import { renderSmsTemplate } from "../src/lib/sms/templates";
import type { SmsPrepareInput } from "../src/lib/sms/contracts";

// Real console, editor, modal and map UI. Every request is intercepted; these
// tests never send an SMS, dial a number, or access a database or map provider.
test.describe.configure({ mode: "default" });
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://compact-location.test";
const revision = "2026-09-16T10:00:00.000Z";
const committedRevision = "2026-09-16T10:10:00.000Z";
const caseId = "case-2026-0517";
const location = { lat: 48.1486, lng: 17.1077, label: "GPS klienta", address: "Pribinova 8, Bratislava", accuracyMeters: 12, submittedAt: "2026-09-16T10:05:00.000Z" };
let script: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(".context/compact-location-browser", { recursive: true });
  const bundle = await build({ entryPoints: ["e2e/fixtures/compact-location.tsx"], outfile: ".context/compact-location-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

async function boot(page: Page, options: { width?: number; received?: boolean; conflict?: boolean; uncertain?: boolean } = {}) {
  await page.setViewportSize({ width: options.width ?? 1366, height: (options.width ?? 1366) < 1024 ? 844 : 768 });
  const evidence = { errors: [] as string[], writes: [] as string[], prepares: [] as SmsPrepareInput[], sends: [] as unknown[], adoptions: [] as Record<string, unknown>[], responseHeaders: [] as string[], reconciliationReads: 0, reconciliationAvailable: false };
  page.on("pageerror", error => evidence.errors.push(error.message));
  await page.route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (request.method() !== "GET") evidence.writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/sms/context") return route.fulfill({ json: { cases: [{ id: caseId, caseNumber: "PM-2026-0517", name: "Testovací klient", phone: "+421900000001", validPhone: true }], tasks: [], sender: "PomocMotor", callbackNumber: "+421900000002", repliesEnabled: false } });
    if (url.pathname === "/api/sms/prepare") {
      const body = request.postDataJSON() as SmsPrepareInput;
      evidence.prepares.push(body);
      const templateContext = { caseNumber: "PM-2026-0517", callbackNumber: "+421900000002", link: `${origin}/l/${"a".repeat(43)}` };
      return route.fulfill({ json: { proof: "isolated-proof", draft: { version: 1, requestId: body.requestId, caseId, caseNumber: "PM-2026-0517", recipientName: "Testovací klient", toNumber: "+421900000001", template: body.template, templateContext, message: body.template === "custom" ? body.message ?? "" : renderSmsTemplate(body.template, templateContext), sender: "PomocMotor" } } });
    }
    if (url.pathname === "/api/sms/send") { evidence.sends.push(request.postDataJSON()); return route.fulfill({ json: { sms: { smsMessageId: "sms-location-1", status: "sent", statusDetail: "sent", reused: false } } }); }
    if (url.pathname === `/api/cases/${caseId}` && request.method() === "PATCH") {
      const body = request.postDataJSON(); evidence.adoptions.push(body); evidence.responseHeaders.push(request.headers()["x-case-response"] ?? "");
      if (options.uncertain) return route.abort("failed");
      if (options.conflict) return route.fulfill({ status: 409, json: { error: "Prípad medzičasom upravil kolega. Obnovte ho pred zmenou polohy." } });
      const original = dispatchCases.find(item => item.id === caseId)!;
      const caseDetail = { ...original, pickup: { ...original.pickup, ...body.pickup }, customerSharedLocation: location, updatedAt: committedRevision };
      return route.fulfill({ json: { committedRevision, mutationId: body.mutationId, caseDetail } });
    }
    if (url.pathname === `/api/cases/${caseId}` && request.method() === "GET" && options.uncertain) {
      evidence.reconciliationReads += 1;
      if (!evidence.reconciliationAvailable) return route.fulfill({ status: 503, json: { error: "Izolovaný výpadok odpovede." } });
      const original = dispatchCases.find(item => item.id === caseId)!;
      return route.fulfill({ json: { caseDetail: { ...original, pickup: { ...original.pickup, ...location }, customerSharedLocation: location, updatedAt: committedRevision } } });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 503, json: { error: "Izolovaný test: neočakávaný zápis." } });
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [], workflowEnabled: true } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/sms") return route.fulfill({ json: { messages: [], hasMore: false } });
    if (url.pathname === "/api/sms/inbox") return route.fulfill({ json: { unreadCount: 0, messages: [], operators: [], hasMore: false } });
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-compact-location" } });
    return route.fulfill({ status: 503, json: { error: "Izolovaný test: služba nedostupná." } });
  });
  await page.goto(origin);
  await page.evaluate(received => { window.compactLocationReceived = received; }, options.received ?? true);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  if ((options.width ?? 1366) < 1024) await page.getByRole("button", { name: "Otvoriť prípad PM-2026-0517", exact: true }).click();
  return evidence;
}

const trigger = (page: Page) => page.getByTestId("case-location-trigger").filter({ visible: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Poloha klienta", exact: true });

for (const width of [320, 390, 1366]) test(`compact GPS action and received dialog fit ${width}px without writes`, async ({ page }) => {
  const evidence = await boot(page, { width });
  await expect(page.getByTestId("case-text-import")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Doplnková GPS poloha od klienta" })).toHaveCount(0);
  await expect(trigger(page)).toHaveAccessibleName("Poloha prijatá");
  const header = page.locator(".case-cockpit-heading");
  const headerBounds = (await header.boundingBox())!;
  const actionBounds = (await trigger(page).boundingBox())!;
  expect(actionBounds.x).toBeGreaterThanOrEqual(headerBounds.x);
  expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(headerBounds.x + headerBounds.width);
  expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(headerBounds.y + headerBounds.height);
  expect(await trigger(page).evaluate(node => node.previousElementSibling?.textContent)).toContain("SMS");
  if (width === 1366) await page.screenshot({ path: ".context/compact-location-browser/header-1366.png" });
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
  const received = dialog(page).getByRole("region", { name: "Prijatá poloha klienta", exact: true });
  await expect(received).toContainText(location.address);
  await expect(received).toContainText("12 m");
  await expect(received).toContainText("48.1486");
  await expect(dialog(page).getByRole("link", { name: "Otvoriť GPS", exact: true })).toHaveAttribute("href", /query=48.1486,17.1077/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const bounds = (await dialog(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  await page.keyboard.press("Tab");
  expect(await dialog(page).evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: `.context/compact-location-browser/received-${width}.png` });
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(evidence.writes).toEqual([]); expect(evidence.errors).toEqual([]);
});

test("requesting a location prepares its existing SMS template and requires explicit send", async ({ page }) => {
  const evidence = await boot(page, { received: false });
  await expect(trigger(page)).toHaveAccessibleName("Vyžiadať polohu");
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("region", { name: "Prijatá poloha klienta" })).toHaveCount(0);
  expect(evidence.writes).toEqual([]);
  await dialog(page).getByRole("button", { name: "Pripraviť náhľad", exact: true }).click();
  await expect(dialog(page).getByLabel("Finálny text na odoslanie")).toContainText(`${origin}/l/`);
  expect(evidence.prepares).toHaveLength(1); expect(evidence.prepares[0]).toMatchObject({ caseId, template: "location_request" });
  expect(evidence.sends).toHaveLength(0); expect(evidence.adoptions).toHaveLength(0);
  await dialog(page).getByRole("button", { name: "Odoslať SMS", exact: true }).click();
  await expect(dialog(page).getByText("Odoslaná operátorovi", { exact: true })).toBeVisible();
  expect(evidence.sends).toHaveLength(1); expect(evidence.adoptions).toHaveLength(0); expect(evidence.errors).toEqual([]);
});

test("showing received GPS reveals the existing map without changing the case or saved layout", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const preferenceBefore = await page.evaluate(() => localStorage.getItem("motorist:workspace:v3:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002"));
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Zobraziť na mape", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".workspace-center-tabs").getByRole("tab", { name: "Mapa", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dispatch-workspace-shell")).toHaveAttribute("data-workspace-mode", "split");
  await expect(page.locator(".dispatch-workspace-upper")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("motorist:workspace:v3:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002"))).toBe(preferenceBefore);
  expect(evidence.writes).toEqual([]); expect(evidence.errors).toEqual([]);
});

test("replacement shows old and new place and commits only after explicit confirmation with a revision", async ({ page }) => {
  const evidence = await boot(page);
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await expect(dialog(page)).toContainText("Pôvodné miesto");
  await expect(dialog(page)).toContainText("Hlavná 12, Vráble");
  await expect(dialog(page)).toContainText("Nové miesto");
  expect(evidence.adoptions).toHaveLength(0);
  await dialog(page).getByRole("button", { name: "Zrušiť", exact: true }).click();
  await expect(dialog(page).getByRole("button", { name: "Potvrdiť nahradenie", exact: true })).toHaveCount(0);
  expect(evidence.adoptions).toHaveLength(0);
  await dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Potvrdiť nahradenie", exact: true }).click();
  await expect.poll(() => evidence.adoptions.length).toBe(1);
  expect(evidence.adoptions[0]).toMatchObject({ expectedUpdatedAt: revision, pickup: { lat: location.lat, lng: location.lng, address: location.address } });
  expect(evidence.adoptions[0].mutationId).toEqual(expect.any(String));
  expect(evidence.responseHeaders).toEqual(["detail-v2"]);
  await expect(dialog(page)).toContainText("Miesto incidentu bolo nahradené");
  await dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await expect(dialog(page).getByRole("group", { name: "Potvrdenie zmeny miesta incidentu" }).locator("dl > div").first().locator("dd")).toHaveText(location.address);
  expect(evidence.adoptions).toHaveLength(1);
  expect(evidence.sends).toHaveLength(0); expect(evidence.errors).toEqual([]);
});

test("a conflicting replacement keeps the dialog and received GPS for recovery", async ({ page }) => {
  const evidence = await boot(page, { conflict: true });
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Potvrdiť nahradenie", exact: true }).click();
  await expect(dialog(page)).toContainText("Prípad sa medzičasom zmenil");
  await expect(dialog(page)).toContainText(location.address);
  expect(evidence.adoptions).toHaveLength(1); expect(evidence.adoptions[0].expectedUpdatedAt).toBe(revision);
  await page.keyboard.press("Escape");
  await trigger(page).click();
  await expect(dialog(page)).toContainText(location.address);
  expect(evidence.adoptions).toHaveLength(1); expect(evidence.errors).toEqual([]);
});

test("unsaved case edits disable GPS replacement and survive opening the map", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  const editor = page.getByTestId("case-edit-form-main");
  await editor.locator("summary").filter({ hasText: "3. Vozidlo a incident" }).click();
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const plate = editor.getByRole("textbox", { name: "EČV", exact: true });
  await plate.fill("KEEPDRAFT");
  await trigger(page).click();
  await expect(dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true })).toBeDisabled();
  await dialog(page).getByRole("button", { name: "Zobraziť na mape", exact: true }).click();
  await expect(plate).toHaveValue("KEEPDRAFT");
  await expect(page.locator(".dispatch-workspace-upper")).toBeVisible();
  expect(evidence.writes).toEqual([]); expect(evidence.errors).toEqual([]);
});


test("an uncertain replacement verifies its result with GET instead of repeating the write", async ({ page }) => {
  const evidence = await boot(page, { uncertain: true });
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Potvrdiť nahradenie", exact: true }).click();
  await expect(dialog(page).getByRole("button", { name: "Overiť uloženie", exact: true })).toBeEnabled();
  expect(evidence.adoptions).toHaveLength(1);
  expect(evidence.reconciliationReads).toBeGreaterThan(0);
  await dialog(page).getByRole("button", { name: "História SMS", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Poloha a žiadosť", exact: true }).click();
  await expect(dialog(page).getByRole("button", { name: "Overiť uloženie", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await trigger(page).click();
  await expect(dialog(page).getByRole("button", { name: "Overiť uloženie", exact: true })).toBeEnabled();
  evidence.reconciliationAvailable = true;
  await dialog(page).getByRole("button", { name: "Overiť uloženie", exact: true }).click();
  await expect(dialog(page)).toContainText("Miesto incidentu bolo nahradené");
  expect(evidence.adoptions).toHaveLength(1);
  expect(evidence.reconciliationReads).toBeGreaterThan(1);
  expect(evidence.errors).toEqual([]);
});
