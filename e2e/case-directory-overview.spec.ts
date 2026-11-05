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
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-directory-overview.tsx"], outfile: ".context/case-directory-overview.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("https://case-directory-overview.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}${css}</style><div id="root"></div><script>${script}</script></html>` }));
  await page.goto("https://case-directory-overview.test/");
  await expect(page.getByRole("region", { name: "Prehľad prípadov", exact: true })).toBeVisible();
}
test("quick scopes expose historical cases without opening the advanced filters", async ({ page }) => {
  await boot(page);
  const group = page.getByRole("group", { name: "Rozsah prípadov" });
  await expect(group.getByRole("button", { name: /^Všetky/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Pobočka", { exact: true })).toBeHidden();
  await group.getByRole("button", { name: /^História/ }).click();
  await expect(page.getByRole("table").getByText("PM-DIR-002", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("PM-DIR-001", { exact: true })).toHaveCount(0);
  await group.getByRole("button", { name: /^Aktívne/ }).click();
  await expect(page.getByRole("table").getByText("PM-DIR-001", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("PM-DIR-002", { exact: true })).toHaveCount(0);
});
test("search clear restores results and keeps keyboard focus", async ({ page }) => {
  await boot(page);
  const search = page.getByRole("searchbox", { name: "Hľadať prípady v adresári" });
  await search.fill("PM-DIR-002");
  await expect(page.getByRole("table").getByText("PM-DIR-001", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Vymazať hľadanie prípadov" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(page.getByRole("table").getByText("PM-DIR-001", { exact: true })).toBeVisible();
  await search.fill("nenájdený prípad");
  await page.getByRole("button", { name: "Vyčistiť hľadanie a filtre" }).click();
  await expect(search).toHaveValue("");
});
test("branch, combined job type and local date range intersect; reset clears the selection", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: /^Filtre/ }).click();
  await page.getByLabel("Pobočka", { exact: true }).selectOption("ba");
  await page.getByLabel("Druh práce", { exact: true }).selectOption("replacement_vehicle");
  await page.getByLabel("Založené od", { exact: true }).fill("2026-11-06");
  await page.getByLabel("Založené do", { exact: true }).fill("2026-11-06");
  await expect(page.getByRole("table").getByText("PM-DIR-001", { exact: true })).toBeVisible();
  await expect(page.getByRole("table").getByText("PM-DIR-002", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("table").getByText("PM-DIR-003", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filtre (4)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vyčistiť", exact: true }).click();
  await expect(page.getByLabel("Pobočka", { exact: true })).toHaveValue("all");
  await expect(page.getByLabel("Založené od", { exact: true })).toHaveValue("");
  await expect(page.getByRole("table").getByText("PM-DIR-003", { exact: true })).toBeVisible();
});
test("sorting direction and creating a case use the existing callbacks", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Zoradiť adresár prípadov").selectOption("caseNumber");
  await page.getByRole("button", { name: "Zoradiť vzostupne", exact: true }).click();
  await expect(page.getByLabel("Stav prehľadu")).toContainText('"sort":{"key":"caseNumber","direction":"asc"}');
  await page.getByRole("button", { name: "Nový prípad", exact: true }).click();
  await expect(page.getByLabel("Stav prehľadu")).toContainText('"created":1');
});
for (const width of [320, 390, 768, 1024]) test(`filters remain inside ${width}px`, async ({ page }) => {
  await boot(page, width);
  await page.getByRole("button", { name: /^Filtre/ }).click();
  await expect(page.getByLabel("Založené do", { exact: true })).toBeVisible();
  const size = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
});
