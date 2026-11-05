import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { TowingCommand, TowingOrder, TowingWorkspace } from "../src/domain/towing/types";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let javascript: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/workspace.tsx"], outfile: ".context/towing-navigation-fixture.js", bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  javascript = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

const memberId = "00000000-0000-4000-8000-000000000002";
const organizationId = "00000000-0000-4000-8000-000000000001";
const orderId = "33333333-3333-4333-8333-333333333333";
type Access = "none" | "office" | "driver" | "both";
function workspace(view: "office" | "driver", access: Access): TowingWorkspace {
  const order: TowingOrder = {
    id: orderId, number: "Z-2026-0001", sourceCaseId: null, revision: 1, assignmentGeneration: 1, driverId: memberId,
    workStatus: "in_progress", billingStatus: "not_ready", paymentStatus: "unpriced",
    fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Škoda Octavia", plate: "TEST01", pickup: "Bratislava, Testovacia 1",
      destination: "Žilina, Testovací servis", startedAt: "2026-11-05T09:00:00Z", startSource: "manual" },
    authorizedCollectionCents: null, receivedCents: 0, dueCents: null, reconciliationRequired: false,
    createdAt: "2026-11-05T09:00:00Z", updatedAt: "2026-11-05T09:00:00Z", attachments: [], lines: [], payments: [], documents: [], invoices: [], events: [],
  };
  return { actor: { id: memberId, userId: memberId, organizationId, displayName: "Test dispečer", roles: access === "driver" ? ["driver"] : ["manager"],
    capabilities: [...(access !== "driver" ? ["operate", "price", "documents"] as const : []), ...(access === "driver" || access === "both" ? ["drive"] as const : [])], active: true, version: 1 },
    view, orders: [order], members: [], branches: [], fleet: [], cashAccounts: [], handovers: [], taxConfigured: true, taxRates: ["5"], taxDate: "2026-11-05" };
}

async function boot(page: Page, access: Access, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  const state = { commands: [] as TowingCommand[], reads: [] as string[], exitRequests: [] as string[], documentRequests: 0, failCommands: false };
  const fixtures = { office: workspace("office", access), driver: workspace("driver", access) };
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/auth/v1/logout") || route.request().method() === "DELETE" && url.pathname.includes("/push/")) state.exitRequests.push(url.pathname);
    if (url.origin !== "https://towing-navigation.test") return route.abort();
    if (url.pathname === "/") {
      state.documentRequests++;
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    }
    if (url.pathname === "/api/towing/workspace") {
      // The mounted case card checks its own related orders independently of
      // module navigation. It must not stand in for a full workspace read.
      if (url.searchParams.has("sourceCaseId")) return route.fulfill({ status: 403, json: { error: "Syntetický prípad nemá prístup k odťahom." } });
      const view = url.searchParams.get("view") === "driver" ? "driver" : "office";
      state.reads.push(view);
      return route.fulfill({ json: fixtures[view] });
    }
    if (url.pathname === "/api/towing/commands") {
      const command = route.request().postDataJSON() as TowingCommand;
      state.commands.push(command);
      if (state.failCommands) return route.fulfill({ status: 503, json: { error: "Testovací výpadok. Uloženie nie je potvrdené." } });
      for (const fixture of Object.values(fixtures)) {
        const order = fixture.orders[0];
        if (command.type === "update_order") { order.fields = { ...order.fields, ...command.payload.fields as object }; order.revision++; }
      }
      return route.fulfill({ json: { commandId: command.commandId, targetId: command.targetId, revision: fixtures.office.orders[0].revision } });
    }
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "isolated-workspace" } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture: service unavailable" } });
  });
  await page.goto(`https://towing-navigation.test/?towing=${access}`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  return state;
}

async function menu(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).filter({ visible: true }).click();
  return page.getByRole("dialog", { name: "Obrazovky aplikácie" });
}

async function openTowing(page: Page, name = "Kniha odťahov") {
  const dialog = await menu(page);
  await dialog.getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("towing-module-workspace")).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

test("a profile without towing access cannot restore a hidden module from saved shortcuts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("motorist:navigation-pins:v1:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002", '["towing"]');
    localStorage.setItem("motorist:mobile-navigation:v1:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002", '["towing"]');
  });
  const state = await boot(page, "none");
  const dialog = await menu(page);
  await expect(dialog.getByRole("button", { name: /Kniha odťahov|Moje odťahy/ })).toHaveCount(0);
  expect(state.reads).toEqual([]);
});

test("office towing is in the module menu, absent from account menu, and pinnable", async ({ page }) => {
  const state = await boot(page, "office");
  expect(state.reads).toEqual([]);
  await page.getByRole("button", { name: /^Účet / }).click();
  const account = page.getByRole("dialog", { name: "Používateľský účet" });
  await expect(account.getByRole("link", { name: /Zákazky odťahovej služby|Kniha odťahov|Moje odťahy/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Účet / }).click();
  const dialog = await menu(page);
  await dialog.getByRole("button", { name: "Pripnúť Kniha odťahov", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).filter({ visible: true }).click();
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Kniha odťahov", exact: true }).click();
  await expect(page.getByTestId("towing-module-workspace")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("motorist:navigation-pins:v1:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002")!))).toContain("towing");
});

test("a driver sees only the own-towing module and never loads the office workspace", async ({ page }) => {
  const state = await boot(page, "driver");
  await openTowing(page, "Moje odťahy");
  await expect(page.getByRole("heading", { name: "Moje zákazky", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pohľady odťahov" })).toHaveCount(0);
  expect(state.reads).toEqual(["driver"]);
});

for (const width of [390, 1440]) {
  test(`embedded towing shares the application header and fits at ${width}px`, async ({ page }) => {
    await boot(page, "office", width);
    await openTowing(page);
    const towingRegion = page.getByTestId("towing-module-workspace");
    await expect(towingRegion.getByRole("heading", { name: "Zákazky", exact: true })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(towingRegion.locator("main")).toHaveCount(0);
    await expect(towingRegion.getByRole("navigation", { name: "Rozhrania" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: /^Účet / })).toBeVisible();
    await page.screenshot({ path: `.context/towing-integration/module-${width}.png`, fullPage: true });
  });
}

test("the towing module can be pinned to the mobile footer", async ({ page }) => {
  await boot(page, "office", 390);
  const dialog = await menu(page);
  await dialog.getByRole("button", { name: /Odobrať zo spodnej lišty.*Prípady/ }).click();
  await dialog.getByRole("button", { name: /Pridať do spodnej lišty.*Kniha odťahov/ }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).filter({ visible: true }).click();
  const footer = page.getByRole("navigation", { name: "Mobilná navigácia" });
  await footer.getByRole("button", { name: "Kniha odťahov", exact: true }).click();
  await expect(page.getByTestId("towing-module-workspace")).toBeVisible();
});

test("unsaved towing work survives leaving the module and returning", async ({ page }) => {
  await boot(page, "office");
  await openTowing(page);
  const towingRegion = page.getByTestId("towing-module-workspace");
  await towingRegion.getByRole("button", { name: "Otvoriť Z-2026-0001", exact: true }).click();
  await towingRegion.getByLabel("Poznámka vodiča", { exact: true }).fill("Vozidlo čaká na odovzdanie, tento text zachovať.");
  await page.getByRole("button", { name: "Nástenka", exact: true }).click();
  await expect(towingRegion).toBeHidden();
  await openTowing(page);
  await expect(towingRegion.getByLabel("Poznámka vodiča", { exact: true })).toHaveValue("Vozidlo čaká na odovzdanie, tento text zachovať.");
});

test("an unconfirmed towing command retains its identity through module navigation", async ({ page }) => {
  const state = await boot(page, "office");
  state.failCommands = true;
  await openTowing(page);
  const towingRegion = page.getByTestId("towing-module-workspace");
  await towingRegion.getByRole("button", { name: "Otvoriť Z-2026-0001", exact: true }).click();
  await towingRegion.getByLabel("Poznámka vodiča", { exact: true }).fill("Uloženie sa musí dať bezpečne zopakovať.");
  await towingRegion.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(towingRegion.getByRole("alert").filter({ hasText: "Testovací výpadok" })).toBeVisible();
  await page.getByRole("button", { name: "Nástenka", exact: true }).click();
  await openTowing(page);
  state.failCommands = false;
  await towingRegion.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(towingRegion.getByRole("status").filter({ hasText: "Údaje zákazky sú uložené" })).toBeVisible();
  expect(state.commands.map(command => command.commandId)).toHaveLength(2);
  expect(state.commands[1].commandId).toBe(state.commands[0].commandId);
});

test("a combined member loads own work only when selected and preserves office edits", async ({ page }) => {
  const state = await boot(page, "both");
  await openTowing(page);
  const towingRegion = page.getByTestId("towing-module-workspace");
  await towingRegion.getByRole("button", { name: "Otvoriť Z-2026-0001", exact: true }).click();
  await towingRegion.getByLabel("Poznámka vodiča", { exact: true }).fill("Kancelársky rozpracovaný text.");
  expect(state.reads.every(view => view === "office")).toBe(true);
  const views = towingRegion.getByRole("navigation", { name: "Pohľady odťahov" });
  await views.getByRole("button", { name: "Moje odťahy", exact: true }).click();
  await expect(towingRegion.getByRole("heading", { name: "Moje zákazky", exact: true })).toBeVisible();
  expect(state.reads).toContain("driver");
  await views.getByRole("button", { name: "Kancelária", exact: true }).click();
  await expect(towingRegion.getByLabel("Poznámka vodiča", { exact: true })).toHaveValue("Kancelársky rozpracovaný text.");
});

for (const action of ["Odhlásiť sa", "Obnoviť aplikáciu"]) {
  test(`hidden towing edits block ${action} and return the user to the preserved work`, async ({ page }) => {
    const state = await boot(page, "office");
    await openTowing(page);
    const towingRegion = page.getByTestId("towing-module-workspace");
    await towingRegion.getByRole("button", { name: "Otvoriť Z-2026-0001", exact: true }).click();
    await towingRegion.getByLabel("Poznámka vodiča", { exact: true }).fill("Rozpracovaný odťah sa pri odchode nesmie stratiť.");
    await page.getByRole("button", { name: "Nástenka", exact: true }).click();
    await expect(towingRegion).toBeHidden();
    const warnings: string[] = [];
    page.on("dialog", async dialog => { warnings.push(dialog.message()); await dialog.accept(); });
    await page.getByRole("button", { name: /^Účet / }).click();
    await page.getByRole("dialog", { name: "Používateľský účet" }).getByRole("button", { name: new RegExp(`^${action}`) }).click();
    await expect.poll(() => warnings).toContain("V odťahoch máte neuložené údaje alebo nepotvrdený zápis. Najprv ich uložte alebo dokončite v Knihe odťahov.");
    await expect(towingRegion).toBeVisible();
    await expect(towingRegion.getByLabel("Poznámka vodiča", { exact: true })).toHaveValue("Rozpracovaný odťah sa pri odchode nesmie stratiť.");
    expect(state.exitRequests).toEqual([]);
    expect(state.documentRequests).toBe(1);
  });
}

test("a confirmed retry releases the refresh guard after towing edits are saved", async ({ page }) => {
  const state = await boot(page, "office");
  state.failCommands = true;
  await openTowing(page);
  const towingRegion = page.getByTestId("towing-module-workspace");
  await towingRegion.getByRole("button", { name: "Otvoriť Z-2026-0001", exact: true }).click();
  await towingRegion.getByLabel("Poznámka vodiča", { exact: true }).fill("Potvrdené údaje možno bezpečne opustiť.");
  await towingRegion.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(towingRegion.getByRole("alert").filter({ hasText: "Testovací výpadok" })).toBeVisible();
  state.failCommands = false;
  await towingRegion.getByRole("button", { name: "Uložiť údaje", exact: true }).click();
  await expect(towingRegion.getByRole("status").filter({ hasText: "Údaje zákazky sú uložené" })).toBeVisible();
  await expect(towingRegion.getByRole("button", { name: "Uložiť údaje", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Nástenka", exact: true }).click();
  const warnings: string[] = [];
  page.on("dialog", async dialog => { warnings.push(dialog.message()); await dialog.accept(); });
  await page.getByRole("button", { name: /^Účet / }).click();
  await page.getByRole("dialog", { name: "Používateľský účet" }).getByRole("button", { name: "Obnoviť aplikáciu", exact: true }).click();
  await expect.poll(() => state.documentRequests).toBe(2);
  expect(warnings).toEqual([]);
});
