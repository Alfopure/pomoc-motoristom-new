import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
let script: string, css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/shared-case-workspace.tsx"], outfile: ".context/shared-case-workspace.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
});
async function boot(page: Page) {
  const unexpected: string[] = [];
  page.on("pageerror", error => unexpected.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://shared-case-workspace.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}${css}</style><div id="root"></div><script>${script}</script></html>` });
    unexpected.push(route.request().url()); return route.abort();
  });
  await page.goto("https://shared-case-workspace.test/");
  return unexpected;
}
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const draft = (page: Page) => page.getByRole("textbox", { name: "Pokyny rozpracovanej práce", exact: true });
test("one shared management draft survives overview, work and unrelated tabs", async ({ page }) => {
  const unexpected = await boot(page);
  await expect(page.getByRole("tabpanel", { name: "Prehľad", exact: true })).toBeVisible();
  await draft(page).fill("Ponechať pôvodného príjemcu a termín");
  await tab(page, "Práca a jazdy").click();
  await expect(draft(page)).toHaveValue("Ponechať pôvodného príjemcu a termín");
  await tab(page, "Poznámky a aktivita").click();
  await expect(draft(page)).toBeHidden();
  await tab(page, "Prehľad").click();
  await expect(draft(page)).toHaveValue("Ponechať pôvodného príjemcu a termín");
  await expect(page.locator('[aria-label="Rozpracovaná správa práce"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { sharedWorkspaceLifecycle: { mounts: number; unmounts: number } }).sharedWorkspaceLifecycle)).toEqual({ mounts: 1, unmounts: 0 });
  expect(unexpected).toEqual([]);
});
test("keyboard tabs keep one correctly labelled panel and the same draft", async ({ page }) => {
  const unexpected = await boot(page);
  await draft(page).fill("Rozpracovaná poznámka");
  const overview = tab(page, "Prehľad"), work = tab(page, "Práca a jazdy");
  expect(await overview.getAttribute("aria-controls")).toBe(await work.getAttribute("aria-controls"));
  await overview.focus(); await page.keyboard.press("ArrowRight");
  await expect(work).toBeFocused(); await expect(work).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Práca a jazdy", exact: true })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Prehľad", exact: true })).toHaveCount(0);
  await expect(draft(page)).toHaveValue("Rozpracovaná poznámka");
  await page.keyboard.press("ArrowLeft");
  await expect(overview).toBeFocused(); await expect(page.getByRole("tabpanel", { name: "Prehľad", exact: true })).toBeVisible();
  await expect(draft(page)).toHaveValue("Rozpracovaná poznámka");
  expect(unexpected).toEqual([]);
});
