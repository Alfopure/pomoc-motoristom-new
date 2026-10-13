import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import type { TowingCommand, TowingOrder, TowingWorkspace } from "../src/domain/towing/types";

const driverId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const branchId = "44444444-4444-4444-8444-444444444444";
function fixture(view: "office" | "driver", count = 1): TowingWorkspace {
  const driver = { id: driverId, userId: driverId, organizationId: orgId, displayName: "Testovací vodič", roles: ["driver"] as const, capabilities: ["drive"] as const, active: true, version: 1 };
  const orders: TowingOrder[] = Array.from({ length: count }, (_, index) => ({ id: index ? `${String(index + 10).padStart(8, "0")}-3333-4333-8333-333333333333` : orderId, number: `Z-2026-${String(index + 1).padStart(4, "0")}`, sourceCaseId: null, revision: 1, assignmentGeneration: 1, driverId, workStatus: "in_progress", billingStatus: "not_ready", paymentStatus: "unpriced", fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Škoda Octavia", plate: "TEST01", pickup: "Bratislava, Testovacia 1", destination: "Žilina, Testovací servis", contact: "+421900000001", branchId, startedAt: "2026-10-13T09:00:00Z" }, authorizedCollectionCents: 10000, receivedCents: 0, dueCents: null, reconciliationRequired: false, createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z", attachments: [], ...(view === "office" ? { lines: [], payments: [], documents: [], invoices: [], events: [] } : {}) }));
  return { view, actor: view === "driver" ? { ...driver, roles: [...driver.roles], capabilities: [...driver.capabilities] } : { id: "55555555-5555-4555-8555-555555555555", userId: "55555555-5555-4555-8555-555555555555", organizationId: orgId, displayName: "Testovací správca", roles: ["manager"], capabilities: ["operate", "price", "bill", "cash", "correct", "members", "documents", "report"], active: true, version: 1 }, orders, members: view === "office" ? [{ ...driver, roles: [...driver.roles], capabilities: [...driver.capabilities] }] : [], branches: [{ id: branchId, name: "Testovacia pobočka" }], fleet: [], totalCount: count, summary: { approvedCents: 0, invoicedCents: 0, receivedCents: 0, dueCents: 0 }, cashAccounts: [{ id: "66666666-6666-4666-8666-666666666666", driverId, balanceCents: 0, reservedCents: 0, revision: 1 }, { id: "77777777-7777-4777-8777-777777777777", driverId: null, balanceCents: 0, reservedCents: 0, revision: 1 }], handovers: [], taxConfigured: true, taxRates: ["5"], taxDate: "2026-10-13" };
}

let javascript = ""; let css = "";
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { TowingWorkspace } from './src/components/towing/TowingWorkspace'; createRoot(document.getElementById('root')).render(<TowingWorkspace view={window.__fixture.view} initialData={window.__fixture} />);`, resolveDir: path.resolve("."), loader: "tsx" }, bundle: true, banner: { js: "var process={env:{}};" }, jsx: "automatic", write: false, outfile: "towing-harness.js", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  javascript = result.outputFiles.find(file => file.path.endsWith(".js"))!.text; css = result.outputFiles.find(file => file.path.endsWith(".css"))!.text;
});

async function mount(page: Page, workspace: TowingWorkspace, handle?: (command: TowingCommand) => { status?: number; error?: string; abort?: boolean }, options?: { emailStatus?: string }) {
  const commands: TowingCommand[] = []; const queries: URL[] = []; page.on("pageerror", error => console.error("Harness browser:", error.message));
  await page.route("https://towing-ui.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html lang="sk"><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/towing/workspace") { queries.push(url); return route.fulfill({ json: workspace }); }
    if (url.pathname === "/api/towing/commands") {
      const command = route.request().postDataJSON() as TowingCommand; commands.push(command);
      const failure = handle?.(command);
      if (failure?.error) return route.fulfill({ status: failure.status ?? 422, json: { error: failure.error } });
      const order = workspace.orders.find(item => item.id === command.targetId);
      if (command.type === "create_order") { workspace.orders.push({ ...fixture("office").orders[0], id: command.targetId, fields: command.payload.fields as TowingOrder["fields"], workStatus: "draft", driverId: null }); workspace.totalCount = workspace.orders.length; }
      if (order && command.type === "update_order") { order.fields = { ...order.fields, ...command.payload.fields as object }; order.revision++; }
      if (order && command.type === "receive_payment" && !order.payments?.some(payment => payment.receiptId === command.payload.receiptId)) { const amount = command.payload.amountCents as number; order.receivedCents += amount; order.payments = [...order.payments ?? [], { id: command.commandId, receiptId: command.payload.receiptId as string, amountCents: amount, method: "cash", driverId, createdAt: "2026-10-13T10:00:00Z" }]; } // Cash updates its own aggregate, not the operational revision.
      if (order && command.type === "submit") { workspace.orders = workspace.orders.filter(item => item.id !== order.id); workspace.totalCount = workspace.orders.length; }
      if (failure?.abort) return route.abort("failed");
      return route.fulfill({ json: { commandId: command.commandId, targetId: command.targetId, revision: order?.revision ?? 1, ...(command.type === "reconcile_receipt" ? { result: { reconciliationStatus: command.payload.receiptId ? "resolved" : "open" } } : {}) } });
    }
    if (url.pathname.includes("/attachments")) { const order = workspace.orders[0]; order.attachments.push({ id: "88888888-8888-4888-8888-888888888888", kind: "work", name: "test.png", mimeType: "image/png", size: 10, status: "ready", createdAt: "2026-10-13T10:00:00Z" }); order.revision++; return route.fulfill({ json: { commandId: /name="commandId"\r\n\r\n([^\r\n]+)/.exec(route.request().postDataBuffer()!.toString("utf8"))?.[1], targetId: order.id, revision: order.revision } }); }
    if (url.pathname.endsWith("/email")) return route.fulfill({ json: { result: { status: options?.emailStatus ?? "accepted" } } });
    if (url.pathname.endsWith("/reports")) return route.fulfill({ json: { from: url.searchParams.get("from"), to: url.searchParams.get("to"), performance: { count: 3, amountCents: 15000 }, invoices: { count: 2, amountCents: 10000 }, receipts: { count: 4, amountCents: 7500 }, daily: [{ date: "2026-10-13", performanceCents: 15000, invoicedCents: 10000, receivedCents: 7500 }] } });
    return route.fulfill({ status: 404, json: { error: "Not fixture endpoint" } });
  });
  await page.goto("https://towing-ui.test/");
  await page.evaluate(value => { (window as unknown as { __fixture: TowingWorkspace }).__fixture = value; }, workspace);
  await page.addStyleTag({ content: `*{box-sizing:border-box} body{margin:0} ${css}` }); await page.addScriptTag({ content: javascript });
  await expect(page.getByRole("heading", { name: workspace.view === "driver" ? "Moje zákazky" : "Zákazky", exact: true })).toBeVisible();
  return { commands, queries };
}

test("driver at 360px edits, receives cash and completes only after server acknowledgement", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const workspace = fixture("driver", 5); const { commands } = await mount(page, workspace);
  await expect(page.getByRole("button", { name: "Otvoriť zákazku" })).toHaveCount(5);
  await expect(page.getByRole("link", { name: "Kancelária" })).toHaveCount(0);
  await page.getByRole("button", { name: "Otvoriť zákazku" }).first().click();
  await page.getByLabel("Poznámka vodiča", { exact: true }).fill("Vozidlo prevzaté, kľúče v servise.");
  await page.getByLabel("Skutočný koniec").fill("2026-10-13T11:00");
  await expect(page.getByRole("button", { name: "Dokončiť a odovzdať" })).toBeDisabled();
  await page.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Údaje zákazky sú uložené");
  await page.getByRole("tab", { name: "Úhrady", exact: true }).click();
  await page.getByLabel("Prijatá suma (€)", { exact: true }).fill("30,50");
  await page.getByRole("checkbox", { name: /Potvrdzujem skutočne prijatú úhradu/ }).check();
  await page.getByRole("button", { name: "Zaevidovať prijatú úhradu" }).click();
  await expect(page.getByRole("status").first()).toContainText("Úhrada bola potvrdená");
  await page.getByRole("tab", { name: /Fotografie/ }).click();
  await page.getByLabel("Fotografia alebo súbor").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6A2sAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Nahrať a potvrdiť" }).click();
  await expect(page.getByRole("status").first()).toContainText("Súbor je uložený");
  await page.getByRole("tab", { name: "Údaje", exact: true }).click();
  await page.getByRole("button", { name: "Dokončiť a odovzdať" }).click();
  await expect(page.getByRole("heading", { name: "Moje zákazky", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Otvoriť zákazku" })).toHaveCount(4);
  const submit = commands.find(command => command.type === "submit")!;
  expect(submit.payload.receiptIds).toEqual([commands.find(command => command.type === "receive_payment")!.payload.receiptId]);
  expect(commands.find(command => command.type === "update_order")!.payload.fields).not.toHaveProperty("officeNotes");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".context/towing-driver-360.png", fullPage: true });
});

test("409 retains entered work and retry uses the same command UUID", async ({ page }) => {
  const workspace = fixture("driver"); let failed = true;
  const { commands } = await mount(page, workspace, command => command.type === "update_order" && failed ? { status: 409, error: "Údaje medzičasom niekto zmenil." } : {});
  await page.getByRole("button", { name: "Otvoriť zákazku" }).click();
  await page.getByLabel("Poznámka vodiča", { exact: true }).fill("Nepotvrdený obsah zostáva vo formulári.");
  await page.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Údaje medzičasom");
  await expect(page.getByLabel("Poznámka vodiča", { exact: true })).toHaveValue("Nepotvrdený obsah zostáva vo formulári.");
  await expect(page.getByRole("status").filter({ hasText: "Údaje zákazky sú uložené" })).toHaveCount(0);
  failed = false; await page.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Údaje zákazky sú uložené");
  expect(commands[0].commandId).toBe(commands[1].commandId);
});

test("office saves an incomplete draft and applies combined filters server-side", async ({ page }) => {
  const workspace = fixture("office"); const { commands, queries } = await mount(page, workspace);
  await page.getByRole("button", { name: "Nová zákazka" }).click();
  await page.getByLabel("Predmet", { exact: true }).selectOption("machine");
  await page.getByLabel("Opis predmetu").fill("Testovací stroj bez EČV a VIN");
  await page.getByRole("button", { name: "Uložiť návrh zákazky" }).click();
  await expect(page.getByRole("status").first()).toContainText("Návrh zákazky je uložený");
  const create = commands.find(command => command.type === "create_order")!;
  expect(create.expectedRevision).toBeUndefined(); expect(create.payload.fields).toMatchObject({ subjectType: "machine", pickup: "" });
  await page.getByLabel("Stav výkonu", { exact: true }).selectOption("draft");
  await page.getByLabel("Pobočka", { exact: true }).selectOption(branchId);
  await page.getByRole("button", { name: "Použiť filtre" }).click();
  await expect.poll(() => queries.at(-1)?.searchParams.get("workStatus")).toBe("draft");
  expect(queries.at(-1)?.searchParams.get("branchId")).toBe(branchId);
  await page.screenshot({ path: ".context/towing-office.png", fullPage: true });
});

test("two acknowledged equal cash receipts have distinct IDs; a lost acknowledgement retries the original ID", async ({ page }) => {
  const workspace = fixture("driver"); let loseAck = true;
  const { commands } = await mount(page, workspace, command => command.type === "receive_payment" && loseAck ? { abort: true } : {});
  await page.getByRole("button", { name: "Otvoriť zákazku" }).click();
  await page.getByRole("tab", { name: "Úhrady", exact: true }).click();
  const amount = page.getByLabel("Prijatá suma (€)", { exact: true });
  await amount.fill("25.00"); await page.getByRole("checkbox", { name: /Potvrdzujem skutočne prijatú úhradu/ }).check();
  await page.getByRole("button", { name: "Zaevidovať prijatú úhradu" }).click();
  await expect(page.getByRole("alert")).toContainText("Uloženie zatiaľ nie je potvrdené");
  await expect(amount).toHaveValue("25.00");
  loseAck = false; await page.getByRole("button", { name: "Zaevidovať prijatú úhradu" }).click();
  await expect(amount).toHaveValue("");
  await amount.fill("25.00"); await page.getByRole("checkbox", { name: /Potvrdzujem skutočne prijatú úhradu/ }).check();
  await page.getByRole("button", { name: "Zaevidovať prijatú úhradu" }).click();
  await expect(amount).toHaveValue("");
  const receipts = commands.filter(command => command.type === "receive_payment");
  expect(receipts).toHaveLength(3); expect(receipts[0].commandId).toBe(receipts[1].commandId); expect(receipts[0].payload.receiptId).toBe(receipts[1].payload.receiptId); expect(receipts[2].payload.receiptId).not.toBe(receipts[1].payload.receiptId);
  expect(workspace.orders[0].receivedCents).toBe(5000); expect(workspace.orders[0].payments).toHaveLength(2);
});

test("loading a newer server revision preserves work and requires explicit comparison", async ({ page }) => {
  const workspace = fixture("driver"); let failed = true;
  const { commands } = await mount(page, workspace, command => { if (command.type === "update_order" && failed) { workspace.orders[0].fields.driverNotes = "Novšie serverové údaje"; workspace.orders[0].revision = 2; return { status: 409, error: "Údaje sa zmenili." }; } return {}; });
  await page.getByRole("button", { name: "Otvoriť zákazku" }).click();
  await page.getByLabel("Poznámka vodiča", { exact: true }).fill("Moje lokálne údaje");
  await page.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await page.getByRole("button", { name: "Načítať aktuálne údaje" }).click();
  await expect(page.getByLabel("Poznámka vodiča", { exact: true })).toHaveValue("Moje lokálne údaje");
  await expect(page.getByRole("button", { name: "Uložiť údaje", exact: true })).toBeDisabled();
  await page.getByText("Aktuálne údaje zo servera (verzia 2)", { exact: true }).click();
  await expect(page.getByText("Novšie serverové údaje", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Údaje som porovnal(a), zachovať moje úpravy" }).click();
  failed = false; await page.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(page.getByRole("status").first()).toContainText("Údaje zákazky sú uložené");
  expect(commands[1].expectedRevision).toBe(2);
});

test("unknown email response never claims provider acceptance", async ({ page }) => {
  const workspace = fixture("office"); workspace.orders[0].documents = [{ id: "99999999-9999-4999-8999-999999999999", version: 1, kind: "work", status: "ready", snapshot: {}, snapshotHash: "test", createdAt: "2026-10-13T10:00:00Z" }];
  await mount(page, workspace, undefined, { emailStatus: "unknown" });
  await page.getByRole("button", { name: "Otvoriť Z-2026-0001" }).click(); await page.getByRole("tab", { name: "Doklady", exact: true }).click();
  await page.getByText("Poslať konkrétnu verziu e-mailom", { exact: true }).click();
  await page.getByLabel("Verzia PDF", { exact: true }).selectOption("99999999-9999-4999-8999-999999999999"); await page.getByLabel("Výslovne potvrdený príjemca").fill("tester@example.test"); await page.getByRole("checkbox", { name: /Potvrdzujem adresu príjemcu/ }).check();
  await page.getByRole("button", { name: "Odoslať vybranú verziu" }).click();
  await expect(page.getByRole("alert")).toContainText("neznámy alebo nepotvrdený"); await expect(page.getByLabel("Výslovne potvrdený príjemca")).toHaveValue("tester@example.test"); await expect(page.getByText("Poskytovateľ prijal e-mail.", { exact: false })).toHaveCount(0);
});

test("manager records an unknown receipt exception without inventing a receipt UUID", async ({ page }) => {
  const workspace = fixture("office"); const { commands } = await mount(page, workspace);
  await page.getByRole("button", { name: "Hotovosť", exact: true }).click();
  await page.getByLabel("Vybrať zákazku z prehľadu").selectOption(orderId);
  await page.getByLabel("Skutočne prijatá suma (€)", { exact: true }).fill("10.00"); await page.getByLabel("Pôvodný čas prijatia").fill("2026-10-13T10:00"); await page.getByLabel("Dôvod manuálneho overenia").fill("Stratený identifikátor zariadenia"); await page.getByLabel("Overené podklady / referencia dôkazu").fill("Testovací príjmový podklad 001"); await page.getByRole("checkbox", { name: /Overil\(a\) som skutočne prijatú hotovosť/ }).check();
  await page.getByRole("button", { name: "Zaevidovať výnimku bez platby" }).click();
  await expect(page.getByRole("status").first()).toContainText("Finančný zápis sa nevytvoril");
  const reconcile = commands.find(command => command.type === "reconcile_receipt")!; expect(reconcile.payload).not.toHaveProperty("receiptId"); expect(reconcile.targetId).toBe(orderId);
  expect(workspace.orders[0].receivedCents).toBe(0);
});
