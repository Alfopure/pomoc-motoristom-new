import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
test.use({ launchOptions: { executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] } });
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-status-search.tsx"], outfile: ".context/case-status-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});
async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://cases.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    return route.fulfill({ status: 200, json: { ok: true, available: false, configured: false, enabled: false, calls: [], events: [], contacts: [], favorites: [], devices: [], notices: [] } });
  });
  await page.goto("https://cases.test/"); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  return page.getByTestId("dispatch-case-list");
}
test("board searches every status even after selecting active and normalizes plate separators", async ({ page }) => {
  const list = await boot(page);
  await expect(list.locator("[data-case-number]")).toHaveCount(1);
  await list.getByRole("button", { name: "Filtre", exact: true }).click();
  await list.getByLabel("Stav", { exact: true }).selectOption("active");
  await list.getByRole("textbox").fill("qa-123 ab");
  await expect(list.locator('[data-case-number="PM-2026-9002"]')).toBeVisible();
  await expect(list.getByLabel("Stav", { exact: true })).toHaveValue("all");
  await expect(list.getByLabel("Stav", { exact: true })).toBeDisabled();
  await expect(list.getByText("Vyhľadáva sa vo všetkých stavoch.")).toBeVisible();
  await list.getByRole("textbox").fill("Spoločný kontakt");
  await expect(list.locator("[data-case-number]")).toHaveCount(2);
  await page.screenshot({ path: ".context/case-status-search.png", fullPage: true });
  await list.getByRole("textbox").fill("");
  await expect(list.getByLabel("Stav", { exact: true })).toHaveValue("active");
  await expect(list.getByLabel("Stav", { exact: true })).toBeEnabled();
  await expect(list.locator("[data-case-number]")).toHaveCount(1);
});

test("search temporarily widens selected statuses and clearing it restores the selection", async ({ page }) => {
  const list = await boot(page);
  await list.getByRole("button", { name: "Filtre", exact: true }).click();
  await list.getByLabel("Stav", { exact: true }).selectOption("selected");
  await list.getByRole("checkbox", { name: "Vybavené", exact: true }).check();
  await expect(list.locator("[data-case-number]")).toHaveCount(1);
  await list.getByRole("checkbox", { name: "Zrušené", exact: true }).check();
  await expect(list.locator("[data-case-number]")).toHaveCount(2);
  await list.getByRole("textbox").fill("9001");
  await expect(list.locator('[data-case-number="PM-2026-9001"]')).toBeVisible();
  await expect(list.getByLabel("Stav", { exact: true })).toHaveValue("all");
  await list.getByRole("textbox").fill("");
  await expect(list.getByLabel("Stav", { exact: true })).toHaveValue("selected");
  await expect(list.getByRole("checkbox", { name: "Vybavené", exact: true })).toBeChecked();
  await expect(list.getByRole("checkbox", { name: "Zrušené", exact: true })).toBeChecked();
  await expect(list.locator("[data-case-number]")).toHaveCount(2);
});
