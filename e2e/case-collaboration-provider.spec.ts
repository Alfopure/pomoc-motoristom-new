import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { collaborationCard } from "./fixtures/case-collaboration-data";

test.use({ launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] } });
let script: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/case-collaboration-provider.tsx"], bundle: true, write: false, minify: true, platform: "browser", format: "iife", jsx: "automatic",
    alias: {
      "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts"),
      // Exercise the same production React build that Next ships to browsers.
      react: path.resolve("node_modules/next/dist/compiled/react"),
      "react-dom": path.resolve("node_modules/next/dist/compiled/react-dom"),
    }, define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles[0].text;
});
async function boot(page: Page, mode: string) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://collaboration.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
    if (url.pathname === "/api/cases/live") return route.fulfill({ json: {
      available: true, ids: [collaborationCard.id], changes: [collaborationCard], versions: { [collaborationCard.id]: 1 },
      notifications: [{ id: "notification-fixture" }], editors: [], more: false,
    } });
    return route.abort();
  });
  await page.goto(`https://collaboration.test/?mode=${mode}`);
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("access")).toHaveText("ready");
  return errors;
}
const observe = (page: Page) => page.evaluate(() => window.caseProviderObservation);
for (const mode of ["equal", "newer", "array-only"]) {
  test(`a ${mode} revision update settles and retains the mounted draft`, async ({ page }) => {
    const errors = await boot(page, mode);
    const input = page.getByLabel("Rozpísaný text");
    await input.fill("Zachovať draft");
    await input.evaluate(node => { Object.assign(node, { retained: true }); (node as HTMLInputElement).setSelectionRange(4, 4); });
    await page.getByRole("button", { name: "Súbežná aktualizácia" }).click();
    await page.waitForTimeout(100);
    const result = await observe(page);
    expect([...errors, ...result.failures]).toEqual([]);
    expect(result.renders).toBeLessThan(12);
    expect(result.stalePublishes).toBe(0);
    expect(result.cases[0]).toMatchObject(mode === "array-only" ? collaborationCard : {
      mainNote: "Úplný detail", jobTypes: ["replacement_vehicle"], customerDetails: { firstName: "Detail" },
      updatedAt: mode === "newer" ? "2026-09-19T11:00:01Z" : collaborationCard.updatedAt,
      vehicle: collaborationCard.vehicle, tasks: [{ id: "task-fixture", title: "Zachovať úlohu" }],
    });
    await expect(input).toHaveValue("Zachovať draft");
    expect(await input.evaluate(node => Boolean((node as HTMLInputElement & { retained?: boolean }).retained))).toBe(true);
    expect(await input.evaluate(node => (node as HTMLInputElement).selectionStart)).toBe(4);
  });
}
for (const mode of ["state-revoke", "cases-revoke"]) {
  test(`${mode} clears access without publishing data from the revoked snapshot`, async ({ page }) => {
    const errors = await boot(page, mode);
    await page.getByRole("button", { name: "Súbežná aktualizácia" }).click();
    await expect(page.getByTestId("access")).toHaveText("denied");
    const result = await observe(page);
    expect([...errors, ...result.failures]).toEqual([]);
    expect(result.cases).toEqual([]);
    expect(result.notifications).toEqual([]);
    expect(result.publications.filter(item => item.denied && item.ids.length)).toEqual([]);
    if (mode === "state-revoke") expect(result.publications.every(item => item.ids.length === 0)).toBe(true);
  });
}
test("a snapshot replaced inside the state callback is published on the next render", async ({ page }) => {
  const errors = await boot(page, "state-change");
  await page.getByRole("button", { name: "Súbežná aktualizácia" }).click();
  await expect.poll(async () => (await observe(page)).cases[0]?.mainNote).toBe("Detail z callbacku");
  const result = await observe(page);
  expect([...errors, ...result.failures]).toEqual([]);
  expect(result.stalePublishes).toBe(0);
  expect(result.renders).toBeLessThan(12);
});
