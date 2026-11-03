import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import type { CaseHandoff, HandoffPublished } from "../src/domain/case-handoff";

// This suite renders the real sender panel; every request is intercepted before
// it can reach an application, SMS gateway, map provider or other external host.
test.use({ screenshot: "off", trace: "off" });
if (existsSync("/usr/bin/google-chrome")) test.use({ launchOptions: { executablePath: "/usr/bin/google-chrome" } });

const origin = "https://delivery-handoff.test";
const caseId = "20000000-0000-4000-8000-000000000001";
const handoffId = "10000000-0000-4000-8000-000000000001";
const memberId = "30000000-0000-4000-8000-000000000001";
const member = { id: memberId, displayName: "Peter Pristavovač", lastPhone: "+421907987654" };
const published: HandoffPublished = {
  caseNumber: "PM-2026-100", action: "Pristavenie vozidla",
  contact: { name: "Testovací klient", phone: "+421905123456" },
  vehicle: { make: "Škoda", model: "Octavia", plate: "TEST001" },
  pickup: { address: "Testovacia 1", lat: 48.1, lng: 17.1 },
  destination: { address: "Testovacia 2", lat: 48.2, lng: 17.2 },
  instructions: "Zavolať pri príchode.", scheduledAt: null,
};
const base: CaseHandoff = {
  id: handoffId, recipientName: member.displayName, recipientPhone: member.lastPhone,
  status: "offered", revision: 3, publishedVersion: 1,
  expiresAt: "2026-10-24T08:00:00Z", createdAt: "2026-10-23T07:00:00Z",
  openedAt: null, eta: null, published, events: [],
};
const position = { lat: 48.153, lng: 17.109, accuracy: 12, recordedAt: "2026-10-23T07:58:00Z" };
let script: string, css: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["e2e/fixtures/case-handoff.tsx"],
    outfile: ".context/web-delivery-handoff-fixture.js", bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
});

async function boot(page: Page, options: {
  grant?: CaseHandoff; legacy?: boolean; issueDeliveryFailed?: boolean; loseDeliveryAck?: boolean; missingIssueLink?: boolean;
} = {}) {
  const commands: Record<string, unknown>[] = [], unexpected: string[] = [], errors: string[] = [];
  let grant = options.grant ? structuredClone(options.grant) : null;
  let ackLost = false;
  await page.clock.install({ time: new Date("2026-10-23T08:00:00Z") });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === "/sender" && request.method() === "GET") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><head><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>` });
    }
    if (url.pathname === `/api/cases/${caseId}/handoffs`) {
      if (request.method() === "GET") return route.fulfill({ json: {
        preview: published, previewVersion: "c".repeat(64), handoffs: grant ? [grant] : [],
        ...(options.legacy ? {} : { delivery: { members: [member] } }),
      } });
      const command = request.postDataJSON();
      commands.push(command);
      if (command.action === "issue") {
        grant = { ...structuredClone(base), recipientName: command.recipientName, recipientPhone: command.recipientPhone };
        if (command.recipientMemberId && !options.issueDeliveryFailed) grant.app = { memberId, lastPosition: null };
        return route.fulfill({ json: {
          commandId: command.commandId, committedRevision: grant.revision, handoff: grant,
          ...(options.missingIssueLink ? { linkWarning: "link_unavailable" } : { url: `${origin}/handoff#token=${"a".repeat(43)}` }),
          ...(command.recipientMemberId ? { delivery: { memberId, status: options.issueDeliveryFailed ? "failed" : "sent" } } : {}),
        } });
      }
      if (command.action === "deliver" && grant) {
        grant.app = { memberId, lastPosition: null };
        if (options.loseDeliveryAck && !ackLost) { ackLost = true; return route.abort("failed"); }
        return route.fulfill({ json: { commandId: command.commandId, handoffId, memberId, sent: true, currentRevision: grant.revision } });
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: "Unexpected request in isolated browser regression" } });
  });
  await page.goto(`${origin}/sender?sender=1`);
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeVisible();
  return { commands, unexpected, errors };
}

function expectIsolated(trace: Awaited<ReturnType<typeof boot>>) {
  expect(trace.unexpected).toEqual([]);
  expect(trace.errors).toEqual([]);
}

async function selectNewRecipient(page: Page) {
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption(memberId);
  await expect(page.getByRole("textbox", { name: "Pristavovač", exact: true })).toHaveValue(member.displayName);
  await expect(page.getByRole("textbox", { name: /^Telefón pristavovača/ })).toHaveValue(member.lastPhone);
}

test("selected app recipient is issued once with their identity and no SMS request", async ({ page }) => {
  const trace = await boot(page);
  await selectNewRecipient(page);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0]).toMatchObject({ action: "issue", recipientMemberId: memberId, recipientName: member.displayName, recipientPhone: member.lastPhone });
  expectIsolated(trace);
});

test("existing offered handoff is delivered without creating a second handoff", async ({ page }) => {
  const trace = await boot(page, { grant: base });
  await page.getByRole("combobox", { name: `Pristavovač pre ${member.displayName}`, exact: true }).selectOption(memberId);
  await page.getByRole("button", { name: "Poslať do aplikácie pristavovača", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0]).toMatchObject({ action: "deliver", handoffId, expectedRevision: 3, recipientMemberId: memberId });
  expectIsolated(trace);
});

test("successful app assignment with an unavailable link preserves success without offering URL sharing", async ({ page }) => {
  const trace = await boot(page, { missingIssueLink: true });
  await selectNewRecipient(page);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Odovzdanie je pridelené v aplikácii pristavovača.");
  await expect(page.getByRole("alert")).toContainText("Odkaz sa nepodarilo načítať.");
  await expect(page.getByRole("alert")).toContainText("skúste získať rovnaký odkaz znova");
  await expect(page.getByText("Odkaz môžete zdieľať aj samostatne.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Odkaz pre / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Kopírovať", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Otvoriť SMS pre kolegu", exact: true })).toHaveCount(0);
  expect(trace.commands.map(command => command.action)).toEqual(["issue"]);
  expectIsolated(trace);
});

test("committed issue with failed assignment retries assignment using the original command identity", async ({ page }) => {
  const trace = await boot(page, { issueDeliveryFailed: true });
  await selectNewRecipient(page);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands.map(command => command.action)).toEqual(["issue", "deliver"]);
  expect(trace.commands[1]).toMatchObject({ commandId: trace.commands[0].commandId, handoffId, expectedRevision: 3, recipientMemberId: memberId });
  expectIsolated(trace);
});

test("lost delivery acknowledgement replays the identical assignment command", async ({ page }) => {
  const trace = await boot(page, { grant: base, loseDeliveryAck: true });
  await page.getByRole("combobox", { name: `Pristavovač pre ${member.displayName}`, exact: true }).selectOption(memberId);
  await page.getByRole("button", { name: "Poslať do aplikácie pristavovača", exact: true }).click();
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(2);
  expect(trace.commands[1]).toEqual(trace.commands[0]);
  expectIsolated(trace);
});

test("missing delivery capability preserves manual recipient and link issuance", async ({ page }) => {
  const trace = await boot(page, { legacy: true });
  await expect(page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true })).toHaveCount(0);
  await page.getByLabel("Stredisko alebo kolega", { exact: true }).fill("Externý kolega");
  await page.getByRole("textbox", { name: /^Telefón príjemcu odkazu/ }).fill(member.lastPhone);
  await page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu", exact: true }).click();
  await expect(page.getByLabel("Odkaz pre Externý kolega", { exact: true })).toHaveValue(`${origin}/handoff#token=${"a".repeat(43)}`);
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0].recipientMemberId).toBeUndefined();
  expectIsolated(trace);
});

test("active app handoff shows recorded GPS accuracy and a location map", async ({ page }) => {
  const trace = await boot(page, { grant: { ...base, status: "en_route", app: { memberId, lastPosition: position } } });
  const map = page.getByRole("link").filter({ hasText: /poloh|map/i });
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute("href", /48\.153.*17\.109/);
  await expect(page.locator(".handoff-grant")).toContainText(/12\s*m/);
  await expect(page.locator(".handoff-grant")).toContainText("pred 2 min");
  await expect(page.locator(".handoff-grant")).toContainText(/07:58|9:58|09:58/);
  expectIsolated(trace);
});

test("GPS map disappears when the displayed handoff expires without another server read", async ({ page }) => {
  const trace = await boot(page, { grant: {
    ...base, status: "en_route", expiresAt: "2026-10-23T08:00:10Z",
    app: { memberId, lastPosition: position },
  } });
  const map = page.getByRole("link", { name: "Ukázať pristavovača na mape" });
  await expect(map).toBeVisible();
  await page.clock.runFor(11_000);
  await expect(map).toHaveCount(0);
  expectIsolated(trace);
});

for (const state of ["completed", "expired"] as const) test(`${state} app handoff hides its historical GPS map`, async ({ page }) => {
  const trace = await boot(page, { grant: {
    ...base, status: state === "completed" ? "completed" : "en_route",
    ...(state === "expired" ? { expiresAt: "2026-10-23T07:59:00Z" } : {}),
    app: { memberId, lastPosition: position },
  } });
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  await expect(page.getByRole("link").filter({ hasText: /poloh|map/i })).toHaveCount(0);
  await expect(page.locator(".handoff-grant")).not.toContainText(/12\s*m/);
  expectIsolated(trace);
});
