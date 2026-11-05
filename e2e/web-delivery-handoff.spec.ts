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
  grant?: CaseHandoff; legacy?: boolean; issueDeliveryFailed?: boolean; loseDeliveryAck?: boolean; missingIssueLink?: boolean; noPhone?: boolean; towOnly?: boolean; drawer?: boolean; loseBranchAck?: boolean;
} = {}) {
  const commands: Record<string, unknown>[] = [], unexpected: string[] = [], errors: string[] = [];
  let grant = options.grant ? structuredClone(options.grant) : null;
  let ackLost = false, branchAckLost = false, memberRemoved = false;
  await page.clock.install({ time: new Date("2026-10-23T08:00:00Z") });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === "/sender" && request.method() === "GET") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><head><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>` });
    }
    if (url.pathname === `/api/cases/${caseId}/work`) return route.fulfill({ json: { actorKey: 'fixture:sender', canOperateTowing: false, pickup: '', destination: '', groups: [], people: [], branches: [], fleet: [], cycles: [] } });
    if (url.pathname === `/api/cases/${caseId}/handoffs`) {
      if (request.method() === "GET") return route.fulfill({ json: {
        preview: published, previewVersion: "c".repeat(64), handoffs: grant ? [grant] : [],
        branches: [{ id: "40000000-0000-4000-8000-000000000001", name: "TEST Žilina" }, { id: "40000000-0000-4000-8000-000000000002", name: "TEST Bratislava" }],
        ...(options.legacy ? {} : { delivery: { members: memberRemoved ? [] : [{ ...member, ...(options.noPhone ? { lastPhone: null } : {}) }] } }),
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
    if (url.pathname === "/api/sms/context" && options.drawer) return route.fulfill({ json: { cases: [], tasks: [], callbackNumber: "", sender: "TEST", repliesEnabled: false } });
    if (url.pathname === "/api/pobocky") {
      if (request.method() === "POST") {
        const command = request.postDataJSON(); commands.push(command);
        if (options.loseBranchAck && !branchAckLost) { branchAckLost = true; return route.abort("failed"); }
        return route.fulfill({ json: { commandId: command.commandId, committedRevision: 1, request: { id: "50000000-0000-4000-8000-000000000001" } } });
      }
      return route.fulfill({ json: {
        actor: { central: true, manage: true, userId: "fixture", leadGroups: [] }, requests: [], totalCount: 0,
        groups: [
          { id: "40000000-0000-4000-8000-000000000001", name: "TEST Žilina", active: true, serviceKinds: ["delivery"], counts: { queued: 0, claimed: 0, active: 0, overdue: 0 }, members: [] },
          { id: "40000000-0000-4000-8000-000000000002", name: "TEST Bratislava", active: true, serviceKinds: options.towOnly ? ["tow"] : ["delivery"], counts: { queued: 0, claimed: 0, active: 0, overdue: 0 }, members: [] },
        ], fleet: [], cycles: [], branches: [], people: [],
      } });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: "Unexpected request in isolated browser regression" } });
  });
  await page.goto(`${origin}/sender?sender=1${options.drawer ? "&drawer=1" : ""}`);
  await page.getByRole("button", { name: /Odovzdať prípad/ }).click();
  await page.getByText("Externý odkaz a pôvodné odovzdania", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Príjemca uvidí" })).toBeVisible();
  await page.addStyleTag({ content: "*{box-sizing:border-box}body{font-family:Arial,sans-serif}" });
  return { commands, unexpected, errors, removeMember: () => { memberRemoved = true; } };
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
  await expect(page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).locator('optgroup[label="Ľudia"] option')).toHaveCount(0);
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


test("app delivery without a recipient phone is enabled and sends no SMS", async ({ page }) => {
  const trace = await boot(page, { noPhone: true });
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption(memberId);
  await expect(page.getByRole("textbox", { name: /^Telefón pristavovača/ })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true })).toBeEnabled();
  await page.screenshot({ path: ".context/handoff-app-no-phone.png", fullPage: true });
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0]).toMatchObject({ action: "issue", recipientMemberId: memberId, recipientPhone: "" });
  expectIsolated(trace);
});

test("branch handoff selects a real branch and creates work without phone or a personal handoff", async ({ page }) => {
  const trace = await boot(page);
  const recipient = page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true });
  expect(await recipient.locator("optgroup").evaluateAll(groups => groups.map(group => group.getAttribute("label")))).toEqual(["Pobočky", "Ľudia"]);
  await recipient.selectOption("branch:40000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("textbox", { name: "Odkiaľ", exact: true })).toHaveValue(published.pickup!.address);
  await page.getByRole("textbox", { name: "Odkiaľ", exact: true }).fill("DEMO miesto prevzatia");
  await page.getByRole("textbox", { name: "Kam", exact: true }).fill("DEMO miesto odovzdania");
  await expect(page.getByRole("textbox", { name: /Telefón/ })).toHaveCount(0);
  await page.screenshot({ path: ".context/handoff-branch-no-phone.png", fullPage: true });
  await page.getByRole("button", { name: "Odoslať", exact: true }).click();
  await expect(page.getByText("Požiadavka bola odoslaná pobočke.", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0]).toMatchObject({ action: "create", expectedRevision: 0, payload: { groupId: "40000000-0000-4000-8000-000000000002", kind: "delivery", caseId } });
  expect(trace.commands[0]).not.toHaveProperty("recipientPhone");
  expectIsolated(trace);
});

test("copyable link without phone remains separate from explicit SMS", async ({ page }) => {
  const trace = await boot(page);
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption("link");
  await page.getByLabel("Stredisko alebo kolega", { exact: true }).fill("Externý kolega");
  await expect(page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu", exact: true }).click();
  await expect(page.getByLabel("Odkaz pre Externý kolega", { exact: true })).toHaveValue(`${origin}/handoff#token=${"a".repeat(43)}`);
  expect(trace.commands).toHaveLength(1);
  expect(trace.commands[0]).not.toHaveProperty("recipientMemberId");
  expectIsolated(trace);
});


test("recipient removal during polling preserves app intent and blocks a stale assignment", async ({ page }) => {
  const trace = await boot(page, { noPhone: true });
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption(memberId);
  trace.removeMember();
  await page.clock.runFor(35_000);
  await expect(page.getByRole("alert")).toContainText("Vybraný pristavovač už nie je dostupný");
  await expect(page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Vytvoriť odkaz pre kolegu", exact: true })).toHaveCount(0);
  expect(trace.commands).toHaveLength(0);
  expectIsolated(trace);
});


test("an existing active personal handoff still allows selecting a branch and returning to its history", async ({ page }) => {
  const trace = await boot(page, { grant: base });
  const recipient = page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true });
  await recipient.selectOption("branch:40000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("button", { name: "Odoslať", exact: true })).toBeEnabled();
  await recipient.selectOption("existing");
  await expect(page.locator(".handoff-grant")).toContainText(member.displayName);
  expect(trace.commands).toHaveLength(0);
  expectIsolated(trace);
});

test("a branch handling only towing submits towing instead of the delivery default", async ({ page }) => {
  const trace = await boot(page, { towOnly: true });
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption("branch:40000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("region", { name: "Pobočky", exact: true }).getByRole("combobox", { name: "Druh práce", exact: true })).toHaveValue("tow");
  await page.getByRole("button", { name: "Odoslať", exact: true }).click();
  await expect(page.getByText("Požiadavka bola odoslaná pobočke.", { exact: true })).toBeVisible();
  expect(trace.commands[0]).toMatchObject({ action: "create", payload: { kind: "tow", groupId: "40000000-0000-4000-8000-000000000002" } });
  expectIsolated(trace);
});


test("drawer traps focus, closes with Escape and restores its recipient draft", async ({ page }) => {
  const trace = await boot(page, { drawer: true, noPhone: true });
  const dialog = page.getByRole("dialog", { name: "Odovzdať prípad", exact: true });
  await expect(dialog).toBeVisible();
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption(memberId);
  await expect(page.getByRole("textbox", { name: /^Telefón pristavovača/ })).toHaveValue("");
  await page.getByRole("textbox", { name: "Pokyny pre kolegu", exact: true }).fill("Počkať pri recepcii.");
  await page.getByRole("button", { name: "Zavrieť odovzdanie", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Odovzdať prípad", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Odovzdať prípad", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true })).toHaveValue(memberId);
  await expect(page.getByRole("textbox", { name: "Pokyny pre kolegu", exact: true })).toHaveValue("Počkať pri recepcii.");
  await expect(page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true })).toBeEnabled();
  expect(trace.commands).toHaveLength(0);
  expectIsolated(trace);
});

test("drawer preserves the command identity across closing an unconfirmed app assignment", async ({ page }) => {
  const trace = await boot(page, { drawer: true, issueDeliveryFailed: true });
  await selectNewRecipient(page);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await expect(page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Zavrieť odovzdanie", exact: true }).click();
  await page.getByRole("button", { name: "Odovzdať prípad", exact: true }).click();
  await page.getByRole("button", { name: "Overiť výsledok tej istej požiadavky", exact: true }).click();
  await expect(page.getByText("V aplikácii", { exact: true })).toBeVisible();
  expect(trace.commands.map(command => command.action)).toEqual(["issue", "deliver"]);
  expect(trace.commands[1].commandId).toBe(trace.commands[0].commandId);
  expectIsolated(trace);
});

test("drawer gives nested SMS its own focus and Escape without closing the parent", async ({ page }) => {
  const trace = await boot(page, { drawer: true });
  await selectNewRecipient(page);
  await page.getByRole("button", { name: "Odovzdať do aplikácie", exact: true }).click();
  await page.getByRole("button", { name: "Otvoriť SMS pre kolegu", exact: true }).click();
  const sms = page.getByRole("dialog", { name: "SMS", exact: true });
  await expect(sms).toBeVisible();
  await expect(sms).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sms).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Odovzdať prípad", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Otvoriť SMS pre kolegu", exact: true })).toBeFocused();
  expect(trace.commands).toHaveLength(1);
  expectIsolated(trace);
});

test("drawer fits a narrow screen and can route a branch request without a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trace = await boot(page, { drawer: true });
  await page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true }).selectOption("branch:40000000-0000-4000-8000-000000000002");
  await page.getByRole("button", { name: "Odoslať", exact: true }).click();
  await expect(page.getByText("Požiadavka bola odoslaná pobočke.", { exact: true })).toBeVisible();
  const bounds = await page.getByRole("dialog", { name: "Odovzdať prípad", exact: true }).boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(trace.commands[0]).toMatchObject({ action: "create", payload: { groupId: "40000000-0000-4000-8000-000000000002" } });
  expect(trace.commands[0]).not.toHaveProperty("recipientPhone");
  expectIsolated(trace);
});


test("drawer can close a failed branch request and retry the same command after reopening", async ({ page }) => {
  const trace = await boot(page, { drawer: true, loseBranchAck: true });
  const dialog = page.getByRole("dialog", { name: "Odovzdať prípad", exact: true });
  const recipient = page.getByRole("combobox", { name: "Príjemca odovzdania", exact: true });
  await recipient.selectOption("branch:40000000-0000-4000-8000-000000000002");
  await page.getByRole("button", { name: "Odoslať", exact: true }).click();
  await expect(page.getByRole("button", { name: "Zopakovať ten istý príkaz", exact: true })).toBeEnabled();
  await expect(recipient).toBeDisabled();
  await expect(page.getByRole("button", { name: "Zavrieť odovzdanie", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Odovzdať prípad", exact: true }).click();
  await expect(recipient).toHaveValue("branch:40000000-0000-4000-8000-000000000002");
  await expect(recipient).toBeDisabled();
  await page.getByRole("button", { name: "Zopakovať ten istý príkaz", exact: true }).click();
  await expect(page.getByText("Príkaz bol overený.", { exact: true })).toBeVisible();
  expect(trace.commands).toHaveLength(2);
  expect(trace.commands[1]).toEqual(trace.commands[0]);
  expectIsolated(trace);
});
