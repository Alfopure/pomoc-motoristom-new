import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { dispatchCases } from "../src/mock/seed";

// Real DispatchConsole/CaseDetail and SMS history, with every request intercepted.
// No provider, authenticated deployment, database, SMS or phone call is contacted.
const origin = "https://case-sms-history.test";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(".context/sms-history-browser", { recursive: true });
  const bundle = await build({ entryPoints: ["e2e/fixtures/compact-location.tsx"], outfile: ".context/sms-history-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

async function boot(page: Page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  const evidence = { errors: [] as string[], duplicateKeys: [] as string[], writes: [] as string[], adoptions: [] as unknown[], counts: [] as { step: string; histories: number; editors: number }[] };
  page.on("pageerror", error => evidence.errors.push(error.message));
  page.on("console", message => { if (/same key|unique .key.|duplicate key/i.test(message.text())) evidence.duplicateKeys.push(message.text()); });
  await page.route("**/*", route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (request.method() !== "GET") evidence.writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/sms/context") return route.fulfill({ json: { cases: dispatchCases.map(item => ({ id: item.id, caseNumber: item.caseNumber, name: item.contact.name, phone: item.contact.phone, validPhone: true })), tasks: [], sender: "PomocMotor", callbackNumber: "+421900000002", repliesEnabled: false } });
    if (url.pathname.startsWith("/api/cases/") && request.method() === "PATCH") {
      const body = request.postDataJSON(); evidence.adoptions.push(body);
      const original = dispatchCases.find(item => item.id === url.pathname.split("/").at(-1))!;
      const committedRevision = "2026-09-16T10:10:00.000Z";
      return route.fulfill({ json: { mutationId: body.mutationId, committedRevision, caseDetail: { ...original, pickup: { ...original.pickup, ...body.pickup }, customerSharedLocation: { lat: 48.1486, lng: 17.1077, label: "GPS klienta", address: "Pribinova 8, Bratislava", accuracyMeters: 12, submittedAt: "2026-09-16T10:05:00.000Z" }, updatedAt: committedRevision } } });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 503, json: { error: "Unexpected isolated write" } });
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [], workflowEnabled: true } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/sms") return route.fulfill({ json: { messages: [], hasMore: false } });
    if (url.pathname === "/api/sms/inbox") return route.fulfill({ json: { unreadCount: 0, messages: [], operators: [], hasMore: false } });
    if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-compact-location" } });
    return route.fulfill({ status: 503, json: { error: "Isolated unavailable service" } });
  });
  await page.goto(origin);
  await page.evaluate(() => { window.compactLocationReceived = true; });
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  return evidence;
}

async function countCards(page: Page, evidence: Awaited<ReturnType<typeof boot>>, step: string) {
  evidence.counts.push({ step, histories: await page.locator("[data-case-sms-history]").count(), editors: await page.getByTestId("case-edit-form-main").count() });
}

async function selectCase(page: Page, caseNumber: string) {
  const row = page.getByTestId("dispatch-case-list").locator(`[data-case-number="${caseNumber}"]`);
  await row.getByRole("button", { name: caseNumber, exact: true }).click();
  await expect(row).toHaveAttribute("data-case-selected", "true");
}

test("case switches and same-case modal updates retain one SMS history and one editor", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  await countCards(page, evidence, "initial expanded case");
  for (let index = 0; index < 6; index += 1) {
    const caseNumber = index % 2 ? "PM-2026-0517" : "PM-2026-0516";
    await selectCase(page, caseNumber);
    await countCards(page, evidence, `case ${caseNumber} switch ${index + 1}`);
    await page.getByTestId("case-location-trigger").filter({ visible: true }).click();
    await expect(page.getByRole("dialog", { name: "Poloha klienta", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await countCards(page, evidence, `case ${caseNumber} after modal ${index + 1}`);
  }
  await page.screenshot({ path: ".context/sms-history-browser/case-after-switches.png", fullPage: true });
  await writeFile(".context/sms-history-browser/switches-evidence.json", JSON.stringify(evidence, null, 2));
  expect(evidence.counts.map(entry => entry.histories)).toEqual(evidence.counts.map(() => 1));
  expect(evidence.counts.map(entry => entry.editors)).toEqual(evidence.counts.map(() => 1));
  expect(evidence.duplicateKeys).toEqual([]);
  expect(evidence.errors).toEqual([]); expect(evidence.writes).toEqual([]);
});

test("same-case saved GPS revision does not duplicate history or replace the editor with orphan cards", async ({ page }) => {
  const evidence = await boot(page);
  await page.getByRole("button", { name: "Maximalizovať kokpit", exact: true }).click();
  await countCards(page, evidence, "before same-case save");
  await page.getByTestId("case-location-trigger").filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Poloha klienta", exact: true });
  await dialog.getByRole("button", { name: "Nahradiť miesto incidentu", exact: true }).click();
  await dialog.getByRole("button", { name: "Potvrdiť nahradenie", exact: true }).click();
  await expect(dialog).toContainText("Miesto incidentu bolo nahradené");
  await page.keyboard.press("Escape");
  await countCards(page, evidence, "after committed revision and editor reset");
  await page.locator("[data-case-sms-history]").last().locator("summary").click();
  await expect(page.locator("[data-case-sms-history]").last()).toContainText("Zatiaľ žiadne SMS.");
  await countCards(page, evidence, "history refreshed");
  await writeFile(".context/sms-history-browser/update-evidence.json", JSON.stringify(evidence, null, 2));
  expect(evidence.counts.map(entry => entry.histories)).toEqual(evidence.counts.map(() => 1));
  expect(evidence.counts.map(entry => entry.editors)).toEqual(evidence.counts.map(() => 1));
  expect(evidence.duplicateKeys).toEqual([]);
  expect(evidence.errors).toEqual([]); expect(evidence.adoptions).toHaveLength(1);
  expect(evidence.writes).toEqual(["PATCH /api/cases/case-2026-0517"]);
});
