import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { collaborationCard } from "./fixtures/case-collaboration-data";
import type { DispatchCase } from "../src/domain/types";

const origin = "https://compact-case-form.test";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");

test.use({ launchOptions: {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  args: ["--no-sandbox"],
} });

let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["e2e/fixtures/case-collaboration.tsx"],
    outfile: "compact-case-form.js",
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts") },
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })])
    .process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css
    + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});

async function boot(page: Page) {
  const pageErrors: string[] = [];
  let card = structuredClone(collaborationCard);
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    if (url.pathname === "/api/cases/live") {
      return route.fulfill({ json: { available: true, ids: [collaborationCard.id], changes: [], versions: { [collaborationCard.id]: 1 }, more: false, notifications: [], editors: [] } });
    }
    if (url.pathname === "/api/cases/presence") return route.fulfill({ json: { available: true } });
    if (url.pathname === `/api/cases/${collaborationCard.id}`) {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as { jobTypes?: DispatchCase["jobTypes"]; mutationId?: string };
        card = { ...card, jobTypes: body.jobTypes ?? card.jobTypes, updatedAt: new Date().toISOString() };
        return route.fulfill({ json: { caseDetail: card, committedRevision: card.updatedAt, mutationId: body.mutationId } });
      }
      return route.fulfill({ json: { caseDetail: card } });
    }
    return route.fulfill({ status: 503, json: { error: "Isolated fixture" } });
  });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  return pageErrors;
}

async function assertCompactForm(page: Page, form: Locator, width: number) {
  await expect(form.getByLabel("Meno", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Priezvisko", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Telefón", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Rola", exact: true })).toHaveCount(0);

  await form.getByRole("checkbox", { name: "Odťah", exact: true }).check();
  const places = form.locator(".google-place-autocomplete-host");
  await expect(places).toHaveCount(2);
  await expect(places.nth(0).locator("..")).toContainText("Miesto incidentu");
  await expect(places.nth(1).locator("..")).toContainText("Cieľ odťahu");
  await expect(form.getByText("Mapa miesta incidentu", { exact: true })).toBeVisible();

  const method = form.getByLabel("Spôsob platby", { exact: true });
  await expect(method).toBeVisible();
  expect(await method.evaluate(node => (node as HTMLSelectElement).required)).toBe(true);
  const paymentSummary = form.locator("summary").filter({ hasText: "Stav platby" }).first();
  const status = form.getByLabel("Stav platby", { exact: true });
  if (!await status.isVisible()) await paymentSummary.click();
  await expect(status).toBeVisible();
  expect(await status.evaluate(node => (node as HTMLSelectElement).required)).toBe(false);
  await paymentSummary.click();
  await expect(status).toBeHidden();

  const plate = form.getByLabel("EČV", { exact: true });
  const vin = form.getByLabel("VIN", { exact: true });
  await expect(plate).toBeVisible();
  await expect(vin).toBeVisible();
  const plateBox = (await plate.boundingBox())!;
  const vinBox = (await vin.boundingBox())!;
  if (width >= 800) {
    expect(Math.abs(plateBox.y - vinBox.y)).toBeLessThan(3);
    expect(plateBox.width).toBeLessThan(vinBox.width);
    if (width === 800) {
      const makeBox = (await form.getByLabel("Značka", { exact: true }).boundingBox())!;
      const modelBox = (await form.getByLabel("Model", { exact: true }).boundingBox())!;
      expect(Math.abs(makeBox.y - plateBox.y)).toBeLessThan(3);
      expect(Math.abs(modelBox.y - makeBox.y)).toBeLessThan(3);
    }
  } else {
    expect(vinBox.y).toBeGreaterThan(plateBox.y + plateBox.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

test("new and edit case forms keep compact contacts, structured places and optional payment status at both panel widths", async ({ page }) => {
  const errors = await boot(page);
  const edit = page.getByTestId("case-edit-form-main");
  await assertCompactForm(page, edit, 1280);
  await page.setViewportSize({ width: 800, height: 900 });
  await assertCompactForm(page, edit, 800);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertCompactForm(page, edit, 390);

  await page.getByRole("button", { name: "Vytvoriť nový prípad", exact: true }).click();
  const fresh = page.getByTestId("case-form-main");
  await expect(fresh).toBeVisible();
  if (process.env.CAPTURE_COMPACT_FORM === "1") {
    await mkdir(".context", { recursive: true });
    await page.screenshot({ path: ".context/compact-case-form-new-390.png", fullPage: true });
  }
  await assertCompactForm(page, fresh, 390);
  await page.setViewportSize({ width: 800, height: 900 });
  await fresh.getByRole("checkbox", { name: "Odťah", exact: true }).uncheck();
  if (process.env.CAPTURE_COMPACT_FORM === "1") await page.screenshot({ path: ".context/compact-case-form-new-800.png", fullPage: true });
  await assertCompactForm(page, fresh, 800);
  await page.setViewportSize({ width: 1280, height: 900 });
  await assertCompactForm(page, fresh, 1280);
  await fresh.getByRole("button", { name: "Ďalší kontakt" }).click();
  await expect(fresh.locator("summary").filter({ hasText: "Rola: Iný" })).toBeVisible();
  expect(errors).toEqual([]);
});
