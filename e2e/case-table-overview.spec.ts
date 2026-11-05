import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
test.use({ launchOptions: { executablePath: process.env.DIAGNOSTICS_CHROMIUM_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] } });
let script = "", css = "";
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-table-overview.tsx"], outfile: ".context/case-table-overview.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("https://case-table-overview.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}${css}</style><div id="root"></div><script>${script}</script></html>` }));
  await page.goto("https://case-table-overview.test/");
}
test("opens the exact case and preserves the sort callback", async ({ page }) => {
  await boot(page);
  await page.getByRole("table").getByText("PM-TEST-0002", { exact: true }).click();
  await expect(page.getByLabel("Otvorený prípad")).toHaveText("fixture-case-1");
  await page.getByRole("columnheader").getByRole("button", { name: "Upravené", exact: true }).click();
  await expect(page.getByLabel("Radenie")).toHaveText("updatedAt:asc");
});
test("column visibility remains stored after reload", async ({ page }) => {
  await boot(page);
  await page.getByText(/^Stĺpce \(/).click();
  await page.getByRole("checkbox", { name: "Pobočka", exact: true }).check();
  await page.reload();
  await expect(page.getByRole("table").getByRole("columnheader").filter({ hasText: "Pobočka" })).toBeVisible();
});

test("compact rows show more cases and expose sort direction to assistive technology", async ({ page }) => {
  await boot(page);
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveCount(7);
  const row = table.locator("tbody tr").first();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(52);
  const visible = await table.locator("tbody tr").evaluateAll(rows => rows.filter(row => { const r = row.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }).length);
  expect(visible).toBeGreaterThanOrEqual(14);
  await expect(table.getByRole("columnheader").filter({ hasText: "Upravené" })).toHaveAttribute("aria-sort", "descending");
  await table.getByRole("button", { name: "Upravené", exact: true }).click();
  await expect(table.getByRole("columnheader").filter({ hasText: "Upravené" })).toHaveAttribute("aria-sort", "ascending");
  await expect(row.locator('[data-column="caseNumber"] span').last()).toHaveAttribute("title", /Porucha vozidla/);
});

test("column order, search and reset work without hiding case identity", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: /^Stĺpce/ }).click();
  await expect(page.getByRole("checkbox", { name: "Prípad", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Pobočka", exact: true }).check();
  await page.getByRole("button", { name: "Posunúť Pobočka doľava", exact: true }).click();
  await page.reload();
  const labels = await page.getByRole("table").getByRole("columnheader").allTextContents();
  expect(labels.slice(-2)).toEqual(["Pobočka", "Upravené"]);
  await page.getByRole("button", { name: /^Stĺpce/ }).click();
  await page.getByRole("textbox", { name: "Nájsť stĺpec" }).fill("pobocka");
  await expect(page.getByRole("region", { name: "Nastavenie stĺpcov" }).getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "Obnoviť základ", exact: true }).click();
  await expect(page.getByRole("table").getByRole("columnheader")).toHaveCount(7);
  await page.getByRole("textbox", { name: "Nájsť stĺpec" }).press("Escape");
  await expect(page.getByRole("button", { name: /^Stĺpce/ })).toBeFocused();
});

test("case action is keyboard reachable and remains within the table", async ({ page }) => {
  await boot(page);
  const button = page.getByRole("table").getByRole("button", { name: "Otvoriť prípad PM-TEST-0003", exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Otvorený prípad")).toHaveText("fixture-case-2");
  await expect(button).toBeFocused();
  await expect(page).toHaveURL("https://case-table-overview.test/");
});

for (const width of [1024, 768, 390, 320]) test(`long data and column controls stay inside ${width}px`, async ({ page }) => {
  await boot(page, width);
  await expect(page.getByRole("button", { name: /^Stĺpce/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  if (width >= 768) await expect(page.getByRole("table")).toBeVisible();
  else {
    await expect(page.getByRole("button", { name: "Otvoriť prípad PM-TEST-0001", exact: true })).toBeVisible();
    expect((await page.getByRole("button", { name: /^Stĺpce/ }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: /^Stĺpce/ }).click();
  await expect(page.getByRole("textbox", { name: "Nájsť stĺpec" })).toBeVisible();
  if (width < 768) expect((await page.getByRole("button", { name: "Zavrieť nastavenie stĺpcov", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `.context/case-table-columns-${width}.png` });
  await page.getByRole("button", { name: "Zavrieť nastavenie stĺpcov", exact: true }).click();
  await page.screenshot({ path: `.context/case-table-${width}.png` });
});

test("blocked local storage keeps column changes usable for this session", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("Storage blocked"); }; });
  await boot(page);
  await page.getByRole("button", { name: /^Stĺpce/ }).click();
  await page.getByRole("checkbox", { name: "Pobočka", exact: true }).check();
  await expect(page.getByRole("table").getByRole("columnheader").filter({ hasText: "Pobočka" })).toBeVisible();
});

for (const width of [1440, 1024]) test(`column settings remain scrollable in a short split panel at ${width}px`, async ({ page }) => {
  await boot(page, width);
  await page.getByRole("region", { name: "Tabuľkový prehľad prípadov" }).evaluate(element => {
    const parent = element.parentElement!;
    parent.style.height = "165px";
    parent.style.minHeight = "0";
  });
  await page.getByRole("button", { name: /^Stĺpce/ }).click();
  const panel = page.getByRole("region", { name: "Nastavenie stĺpcov" });
  const bounds = await panel.boundingBox();
  const root = await page.getByRole("region", { name: "Tabuľkový prehľad prípadov" }).boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(root!.y + root!.height + 1);
  await panel.getByRole("checkbox", { name: "Posledná poznámka", exact: true }).scrollIntoViewIfNeeded();
  await panel.getByRole("checkbox", { name: "Posledná poznámka", exact: true }).check();
  await expect(panel.getByRole("checkbox", { name: "Posledná poznámka", exact: true })).toBeChecked();
  await panel.getByRole("button", { name: "Zavrieť nastavenie stĺpcov", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Stĺpce/ })).toHaveAttribute("aria-expanded", "false");
});
