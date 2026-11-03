import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { HandoffPublished } from "../src/domain/case-handoff";
import { collaborationCard } from "./fixtures/case-collaboration-data";

// Real form, expanded case and existing handoff panel; all traffic is intercepted.
// No application deployment, database, provider or tester phone is contacted.
test.use({ screenshot: "off", trace: "off", launchOptions: {
  ...(existsSync("/usr/bin/google-chrome") ? { executablePath: "/usr/bin/google-chrome" } : {}),
  args: ["--no-sandbox"],
} });

const origin = "https://new-case-handoff.test";
const caseId = collaborationCard.id;
const memberId = "30000000-0000-4000-8000-000000000001";
const member = { id: memberId, displayName: "Peter Pristavovač", lastPhone: "+421907987654" };
const published: HandoffPublished = {
  caseNumber: collaborationCard.caseNumber, action: "Pristavenie vozidla",
  contact: { name: "Klient Test", phone: "+421900000001" },
  vehicle: { make: "Škoda", model: "Octavia", plate: "TEST001" },
  pickup: { address: "Testovacia 1", lat: 48.1, lng: 17.1 },
  destination: { address: "Testovacia 2", lat: 48.2, lng: 17.2 },
  instructions: "Zavolať pri príchode.", scheduledAt: null,
};
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["e2e/fixtures/new-case-handoff.tsx"], outfile: "new-case-handoff.js",
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts") },
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })])
    .process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});

type Failure = "rejected" | "lost-ack" | "committed-error" | "malformed-success";
async function boot(page: Page, options: { failure?: Failure; holdCreate?: boolean } = {}) {
  const creates: Record<string, unknown>[] = [], handoffs: Record<string, unknown>[] = [];
  const errors: string[] = [], unexpected: string[] = [];
  let created = false, uploads = 0;
  let releaseCreate = () => {};
  const createGate = options.holdCreate ? new Promise<void>(resolve => { releaseCreate = resolve; }) : Promise.resolve();
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === "/" && request.method() === "GET") {
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    }
    if (url.pathname === "/api/cases/live") {
      return route.fulfill({ json: { available: true, ids: created ? [caseId] : [], changes: [], versions: created ? { [caseId]: 1 } : {}, more: false, notifications: [], editors: [] } });
    }
    if (url.pathname === "/api/cases/presence") return route.fulfill({ json: { available: true } });
    if (url.pathname === "/api/cases" && request.method() === "POST") {
      creates.push(request.postDataJSON());
      await createGate;
      if (options.failure === "rejected") return route.fulfill({ status: 400, json: { error: "Skúšobné odmietnutie uloženia." } });
      created = true;
      if (options.failure === "lost-ack") return route.abort("failed");
      if (options.failure === "committed-error") return route.fulfill({ status: 409, headers: { "x-operation-committed": "true" }, json: { error: "Uloženie prebehlo; obnovenie prehľadu zlyhalo." } });
      if (options.failure === "malformed-success") return route.fulfill({ json: { caseId } });
      return route.fulfill({ json: { caseId, dispatchData: { dispatchCases: [collaborationCard], partnerDirectory: [] } } });
    }
    if (url.pathname === `/api/cases/${caseId}` && request.method() === "GET") return route.fulfill({ json: { caseDetail: collaborationCard } });
    if (url.pathname === `/api/cases/${caseId}/attachments` && request.method() === "POST") {
      uploads++;
      return route.fulfill({ status: 503, json: { error: "Skúšobné zlyhanie prílohy." } });
    }
    if (url.pathname === `/api/cases/${caseId}/handoffs`) {
      if (request.method() === "GET") return route.fulfill({ json: { preview: published, previewVersion: "c".repeat(64), handoffs: [], delivery: { members: [member] } } });
      const command = request.postDataJSON();
      handoffs.push(command);
      return route.fulfill({ json: {
        commandId: command.commandId, committedRevision: 1,
        handoff: { id: "10000000-0000-4000-8000-000000000001", recipientName: member.displayName, recipientPhone: member.lastPhone,
          status: "offered", revision: 1, publishedVersion: 1, expiresAt: "2099-10-24T08:00:00Z", createdAt: "2026-10-24T07:00:00Z",
          openedAt: null, eta: null, published, events: [], app: { memberId, lastPosition: null } },
        url: `${origin}/handoff#token=${"a".repeat(43)}`, delivery: { memberId, status: "sent" },
      } });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: "Unexpected request in isolated browser regression" } });
  });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("button", { name: "Uložiť a odovzdať", exact: true })).toBeEnabled();
  return { creates, handoffs, errors, unexpected, releaseCreate, uploads: () => uploads };
}

function ordinarySave(page: Page) { return page.getByRole("button", { name: /^Uložiť (kartu|rozpracované)$/ }); }
function expectIsolated(trace: Awaited<ReturnType<typeof boot>>) {
  expect(trace.unexpected).toEqual([]);
  expect(trace.errors).toEqual([]);
}

test("ordinary save creates once and keeps the existing handoff panel collapsed", async ({ page }) => {
  const trace = await boot(page);
  await ordinarySave(page).click();
  await expect(page.getByRole("button", { name: /Odovzdať prípad/ })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeHidden();
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(0);
  expectIsolated(trace);
});

test("save and handoff opens the real recipient/preview but sends nothing until explicit confirmation", async ({ page }) => {
  const trace = await boot(page);
  await page.getByRole("button", { name: "Uložiť a odovzdať", exact: true }).click();
  await expect(page.getByRole("button", { name: /Odovzdať prípad/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeVisible();
  await expect(page.locator(".handoff-share-preview")).toContainText("TEST001");
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption(memberId);
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(0);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(1);
  expect(trace.handoffs[0]).toMatchObject({ action: "issue", recipientMemberId: memberId });
  expectIsolated(trace);
});

test("rejected case creation never opens or sends a handoff", async ({ page }) => {
  const trace = await boot(page, { failure: "rejected" });
  await page.getByRole("button", { name: "Uložiť a odovzdať", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Skúšobné odmietnutie uloženia.");
  await expect(ordinarySave(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: /Odovzdať prípad/ })).toHaveCount(0);
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(0);
  expectIsolated(trace);
});

for (const failure of ["lost-ack", "committed-error", "malformed-success"] as const) test(`${failure} disables both save paths instead of creating another case`, async ({ page }) => {
  const trace = await boot(page, { failure });
  await page.getByRole("button", { name: "Uložiť a odovzdať", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Výsledok uloženia nie je potvrdený.");
  await expect(page.getByRole("button", { name: "Uložiť a odovzdať", exact: true })).toBeDisabled();
  await expect(ordinarySave(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: /Odovzdať prípad/ })).toHaveCount(0);
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(0);
  expectIsolated(trace);
});

test("attachment failure preserves the known saved case and opens its single handoff", async ({ page }) => {
  const trace = await boot(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "priloha.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8bkAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Uložiť a odovzdať", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Prípad je uložený, ale prílohy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeVisible();
  expect(trace.creates).toHaveLength(1);
  expect(trace.uploads()).toBe(1);
  expect(trace.handoffs).toHaveLength(0);
  expectIsolated(trace);
});

test("rapid clicks across both save paths stay within one in-flight create", async ({ page }) => {
  const trace = await boot(page, { holdCreate: true });
  await page.getByRole("button", { name: "Uložiť a odovzdať", exact: true }).evaluate(button => {
    const ordinary = [...document.querySelectorAll("button")].find(item => /^Uložiť (kartu|rozpracované)$/.test(item.textContent?.trim() ?? ""));
    (button as HTMLButtonElement).click();
    ordinary?.click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => trace.creates.length).toBe(1);
  await expect(page.getByRole("button", { name: "Uložiť a odovzdať", exact: true })).toBeDisabled();
  trace.releaseCreate();
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeVisible();
  expect(trace.creates).toHaveLength(1);
  expect(trace.handoffs).toHaveLength(0);
  expectIsolated(trace);
});
