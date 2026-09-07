import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/postcss";
import { emptyDirectoryDraft, type DirectoryEntry } from "../src/lib/directory";

// Use the PostCSS dependency already owned by the installed Tailwind plugin.
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");

let script: string;
let css: string;
const at = "2026-09-07T08:00:00.000Z";
const ids = { firm: "11111111-1111-4111-8111-111111111111", branch: "22222222-2222-4222-8222-222222222222", person: "33333333-3333-4333-8333-333333333333", assistance: "44444444-4444-4444-8444-444444444444" };
function fixtures(): DirectoryEntry[] {
  return [
    { ...emptyDirectoryDraft("company"), id: ids.firm, updatedAt: at, name: "Sever Assistance", ico: "11698055", phone: "+421 901 222 333", email: "dispecing@example.test", address: "Dlhá 12, Žilina", website: "example.test", note: "Dispečing nonstop. Fakturáciu vybavuje pani Nováková.", focus: "towing", contactIds: [ids.person] },
    { ...emptyDirectoryDraft("branch"), id: ids.branch, updatedAt: at, name: "Pobočka Žilina", phone: "+421 901 333 444", address: "Dlhá 12, Žilina", availableReplacementCars: 6, parentId: ids.firm, location: { label: "Pobočka Žilina", address: "Dlhá 12, Žilina", lat: 49.2, lng: 18.7, provider: "manual" } },
    { ...emptyDirectoryDraft("contact"), id: ids.person, updatedAt: at, name: "Žofia Nováková", phone: "+421 901 234 567", email: "zofia@example.test", note: "Fakturácia a odovzdanie dokladov." },
    { ...emptyDirectoryDraft("assistance"), id: ids.assistance, updatedAt: at, name: "Asistencia Európa", phone: "+421 901 555 666", email: "asistencia@example.test" },
  ];
}

test.beforeAll(async () => {
  await mkdir(".context/directory-browser", { recursive: true });
  const result = await build({ entryPoints: ["e2e/fixtures/directory.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = result.outputFiles[0].text;
  const resultCss = await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") });
  css = resultCss.css;
});

async function boot(page: Page, options: { canEdit?: boolean; entries?: DirectoryEntry[]; width?: number; failPatch?: number; delay?: number } = {}) {
  const state = { entries: options.entries ?? fixtures(), writes: [] as { method: string; path: string; body: Record<string, unknown> }[], failures: options.failPatch ?? 0, postCount: 0, errors: [] as string[] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 });
  await page.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== "http://directory.test") { state.errors.push(`External request blocked: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/directory" && request.method() === "GET") return route.fulfill({ json: { canEdit: options.canEdit ?? true, entries: state.entries } });
    if (url.pathname.startsWith("/api/directory") && ["POST", "PATCH"].includes(request.method())) {
      const body = request.postDataJSON(); state.writes.push({ method: request.method(), path: url.pathname, body });
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (request.method() === "PATCH" && state.failures-- > 0) return route.fulfill({ status: 409, json: { error: "Záznam medzitým upravil kolega. Obnovte údaje a skontrolujte zmeny." } });
      const id = request.method() === "POST" ? `55555555-5555-4555-8555-${String(++state.postCount).padStart(12, "0")}` : url.pathname.split("/").at(-1)!;
      const previous = state.entries.find(entry => entry.id === id);
      if (request.method() === "PATCH" && body.expectedUpdatedAt !== previous?.updatedAt) return route.fulfill({ status: 409, json: { error: "Chýba aktuálna verzia." } });
      const entry = { ...previous, ...body, id, updatedAt: new Date(Date.parse(at) + state.writes.length * 1000).toISOString() } as DirectoryEntry;
      delete (entry as unknown as Record<string, unknown>).expectedUpdatedAt;
      state.entries = [...state.entries.filter(item => item.id !== id), entry];
      return route.fulfill({ json: { entry, refreshRequired: false, dispatchData: { source: "supabase" } } });
    }
    if (url.pathname === "/api/integrations/swhouse/replacement-vehicles") return route.fulfill({ json: { source: "swhouse", availabilityByBranch: { [ids.branch]: 3 } } });
    if (url.pathname === "/api/partner-directory/backfill-assistance" && request.method() === "POST") {
      state.writes.push({ method: "POST", path: url.pathname, body: {} });
      state.entries.push({ ...emptyDirectoryDraft("assistance"), id: "imported", updatedAt: at, name: "Importovaná asistencia" });
      return route.fulfill({ json: { created: ["Importovaná asistencia"], dispatchData: { source: "supabase" } } });
    }
    if (request.method() === "GET") return route.fulfill({ status: 404, json: {} });
    state.errors.push(`Unmocked write blocked: ${request.method()} ${url.pathname}`); return route.abort();
  });
  await page.goto("http://directory.test/"); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Adresár", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Adresár", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Otvoriť / }).first()).toBeVisible();
  return state;
}

for (const width of [1440, 390]) test(`unified directory navigation, relationships and readable layout at ${width}px`, async ({ page }) => {
  const state = await boot(page, { width });
  await expect(page.getByRole("navigation", { name: "Sekcie nastavení" }).getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /Otvoriť / })).toHaveCount(4);
  await page.getByRole("button", { name: /^Pobočky 1$/ }).click();
  await expect(page.getByRole("button", { name: /Otvoriť / })).toHaveCount(1);
  await page.getByLabel("Hľadať v adresári").fill("zilina");
  await expect(page.getByRole("button", { name: "Otvoriť Pobočka Žilina" })).toBeVisible();
  await page.getByRole("button", { name: /^Všetko 4$/ }).click();
  await page.getByLabel("Hľadať v adresári").fill("0901234567");
  await expect(page.getByRole("button", { name: /Otvoriť / })).toHaveCount(1);
  await page.getByRole("button", { name: "Vymazať hľadanie" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/directory-browser/directory-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "Otvoriť Sever Assistance" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Sever Assistance", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Žofia Nováková/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Pobočka Žilina/ })).toBeVisible();
  expect(await dialog.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
  expect((await dialog.boundingBox())!.y).toBe(0);
  await page.screenshot({ path: `.context/directory-browser/detail-${width}.png` });
  await dialog.getByRole("button", { name: /Pobočka Žilina/ }).click();
  await expect(dialog.getByText("3 náhradných vozidiel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("company create, edit, existing contact link, archive and restore persist after reload", async ({ page }) => {
  const state = await boot(page);
  await page.getByRole("button", { name: "Pridať záznam", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Názov", exact: true }).fill("Nový servis");
  await dialog.getByLabel("Telefón", { exact: true }).fill("+421901987654");
  await dialog.getByLabel("Adresa", { exact: true }).fill("Hlavná 14, Trnava");
  await dialog.getByLabel("Zameranie").selectOption("garage");
  await dialog.getByLabel("Interná poznámka").fill("Servis po dohode.");
  await dialog.getByRole("checkbox", { name: /Žofia/ }).check();
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Nový servis", exact: true })).toBeVisible();
  const saved = state.entries.find(entry => entry.name === "Nový servis")!;
  expect(saved.contactIds).toEqual([ids.person]);
  await dialog.getByRole("button", { name: "Upraviť záznam" }).click();
  await dialog.getByLabel("E-mail", { exact: true }).fill("servis@example.test");
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "servis@example.test", exact: true })).toBeVisible();
  expect(state.writes[1].body.expectedUpdatedAt).toBe(saved.updatedAt);
  await dialog.getByRole("button", { name: "Do archívu" }).click();
  await dialog.getByRole("button", { name: "Archivovať", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Obnoviť z archívu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Stav záznamov").selectOption("archived");
  await page.getByRole("button", { name: "Otvoriť Nový servis" }).click();
  await dialog.getByRole("button", { name: "Obnoviť z archívu" }).click();
  await expect(dialog.getByText("Aktívny záznam", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Stav záznamov").selectOption("active");
  await page.getByRole("button", { name: "Obnoviť adresár" }).click();
  await expect(page.getByRole("button", { name: "Otvoriť Nový servis" })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("new person from an owner is created once and linked; a failed link keeps the saved contact", async ({ page }) => {
  const state = await boot(page, { failPatch: 1, width: 390 });
  await page.getByRole("button", { name: "Otvoriť Sever Assistance" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Nová osoba" }).click();
  await dialog.getByLabel("Meno a priezvisko").fill("Ján Nový");
  await dialog.getByLabel("Telefón", { exact: true }).fill("+421901444555");
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Ján Nový", exact: true })).toBeVisible();
  expect(state.writes.filter(write => write.method === "POST")).toHaveLength(1);
  expect(state.entries.find(entry => entry.id === ids.firm)?.contactIds).toEqual([ids.person]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toContainText("kontakt je uložený");
  await page.getByRole("button", { name: "Otvoriť Sever Assistance" }).click();
  await dialog.getByRole("button", { name: "Nová osoba" }).click();
  await dialog.getByLabel("Meno a priezvisko").fill("Eva Nová");
  await dialog.getByLabel("E-mail", { exact: true }).fill("eva@example.test");
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Sever Assistance", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Eva Nová/ })).toBeVisible();
  expect(state.writes.filter(write => write.method === "POST")).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test("branch edits keep the original position and use the parent company, while new branches accept a manual map point", async ({ page }) => {
  const state = await boot(page, { width: 390 });
  await page.getByRole("button", { name: "Otvoriť Pobočka Žilina" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Upraviť záznam" }).click();
  await dialog.getByLabel("Telefón", { exact: true }).fill("+421901111999");
  await dialog.getByLabel("Ručná dostupnosť náhradných vozidiel").fill("9");
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByText("+421901111999", { exact: true })).toBeVisible();
  expect(state.writes[0].body.location).toEqual(fixtures()[1].location);
  expect(state.writes[0].body.parentId).toBe(ids.firm);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pridať záznam", exact: true }).click();
  await dialog.getByRole("button", { name: "Pobočka", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Názov", exact: true }).fill("Pobočka Trnava");
  await dialog.getByLabel("Firma / asistenčná spoločnosť").selectOption(ids.firm);
  await dialog.getByRole("button", { name: "Zadať adresu a polohu ručne" }).click();
  await dialog.getByRole("textbox", { name: "Adresa pobočky", exact: true }).fill("Hlavná 1, Trnava");
  await dialog.getByLabel("Zemepisná šírka").fill("48.3774");
  await dialog.getByLabel("Zemepisná dĺžka").fill("17.5872");
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Pobočka Trnava", exact: true })).toBeVisible();
  expect(state.entries.find(entry => entry.name === "Pobočka Trnava")?.location).toMatchObject({ lat: 48.3774, lng: 17.5872, provider: "manual" });
  expect(state.errors).toEqual([]);
});

test("stale saves preserve drafts, slow saves block double submission, and Escape protects unsaved changes", async ({ page }) => {
  const state = await boot(page, { failPatch: 1, delay: 250 });
  await page.getByRole("button", { name: "Otvoriť Sever Assistance" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Upraviť záznam" }).click();
  await dialog.getByRole("textbox", { name: "Názov", exact: true }).fill("Moje neuložené zmeny");
  await page.keyboard.press("Escape");
  await expect(dialog.getByText("Máte neuložené zmeny.")).toBeVisible();
  await dialog.getByRole("button", { name: "Pokračovať v úprave" }).click();
  await dialog.getByRole("button", { name: "Uložiť záznam", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Ukladám…" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("medzitým upravil kolega");
  await expect(dialog.getByRole("textbox", { name: "Názov", exact: true })).toHaveValue("Moje neuložené zmeny");
  expect(state.writes).toHaveLength(1);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Zahodiť zmeny" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Otvoriť Sever Assistance" })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("read-only users browse and dial a known number without access to mutations", async ({ page }) => {
  const state = await boot(page, { canEdit: false });
  await expect(page.getByRole("button", { name: "Pridať záznam", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Otvoriť Žofia Nováková" }).click();
  await expect(page.getByRole("button", { name: "Upraviť záznam" })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Zavolať", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-called", "+421 901 234 567");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("pagination, archived search, import and hostile labels stay usable", async ({ page }) => {
  const many = Array.from({ length: 31 }, (_, index) => ({ ...fixtures()[0], id: `fixture-${index}`, name: `Firma ${index + 1}`, contactIds: [], active: true }));
  const hostile = { ...fixtures()[0], id: "hostile", name: '<img src=x onerror="alert(1)">', website: "javascript:alert(1)", active: false };
  const state = await boot(page, { entries: [...many, hostile] });
  await expect(page.getByRole("button", { name: /Otvoriť / })).toHaveCount(25);
  await page.getByRole("button", { name: "Nasledujúca strana adresára" }).click();
  await expect(page.getByRole("button", { name: /Otvoriť / })).toHaveCount(6);
  await page.getByLabel("Stav záznamov").selectOption("archived");
  await page.getByRole("button", { name: `Otvoriť ${hostile.name}`, exact: true }).click();
  await expect(page.getByRole("dialog").locator("img")).toHaveCount(0);
  await expect(page.getByRole("dialog").locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByLabel("Stav záznamov").selectOption("active");
  await page.getByRole("button", { name: "Prevziať z prípadov", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("pribudlo 1");
  await page.getByLabel("Hľadať v adresári").fill("Importovaná");
  await expect(page.getByRole("button", { name: "Otvoriť Importovaná asistencia" })).toBeVisible();
  expect(state.writes).toHaveLength(1); expect(state.errors).toEqual([]);
});
