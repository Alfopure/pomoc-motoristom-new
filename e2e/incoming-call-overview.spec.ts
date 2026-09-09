import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

let script: string;
let appCss = "";
const failures = new WeakMap<Page, string[]>();
test.beforeAll(async ({ request, baseURL }) => {
  const response = await request.get(baseURL!);
  const html = await response.text();
  const sheets = [...new Set([...html.matchAll(/href="([^"<>]+\.css(?:\?[^"<>]*)?)"/g)].map((match) => match[1].replaceAll("&amp;", "&")))];
  expect(sheets.length).toBeGreaterThan(0);
  for (const sheet of sheets) appCss += await (await request.get(new URL(sheet, baseURL).href)).text();
  const bundle = await build({ entryPoints: ["e2e/fixtures/incoming-call-overview.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = bundle.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  failures.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => { errors.push(`Unexpected network: ${route.request().url()}`); return route.abort(); });
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addStyleTag({ content: appCss });
  await page.addScriptTag({ content: script });
  await page.locator("summary").click();
});
test.afterEach(async ({ page }) => { expect(failures.get(page)).toEqual([]); });

test("the external fallback has an accurate destination and a working pickup action", async ({ page }) => {
  await expect(page.getByText("Zvoní na externom telefóne:", { exact: false })).toBeVisible();
  await expect(page.getByText("Hľadá operátora", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Prevziať", exact: true }).click();
  await expect(page.getByRole("status", { name: "Akcie" })).toHaveText("pickup:incoming-session");
  await expect(page.getByRole("button", { name: "Zrušiť", exact: true })).toBeVisible();
});

test("answer and reject belong only to the exact browser invite even with a stale offer first", async ({ page }) => {
  await page.getByRole("combobox").selectOption("offers");
  const rows = page.locator("article");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByRole("button", { name: "Prijať", exact: true })).toHaveCount(0);
  await rows.last().getByRole("button", { name: "Prijať", exact: true }).click();
  await rows.last().getByRole("button", { name: "Odmietnuť", exact: true }).click();
  await expect(page.getByRole("status", { name: "Akcie" })).toHaveText("answer,reject");
  await page.getByRole("combobox").selectOption("answering");
  await expect(rows.last().getByRole("button", { name: "Prijať", exact: true })).toBeDisabled();
});

test("another device is visible despite an old notice and cannot offer pickup before reconnecting", async ({ page }) => {
  await page.getByRole("combobox").selectOption("other-device");
  await expect(page.getByTestId("phone-registration")).toHaveText("Iné okno");
  await expect(page.getByRole("button", { name: "Najprv pripoj telefón", exact: true })).toBeDisabled();
  await page.getByTestId("phone-registration").click();
  await page.getByRole("button", { name: "Prevziať telefón do tohto okna", exact: true }).click();
  await expect(page.getByRole("status", { name: "Akcie" })).toHaveText("takeover");
});

test("an outstanding browser leg blocks a second pickup", async ({ page }) => {
  await page.getByRole("combobox").selectOption("pending");
  await expect(page.getByRole("button", { name: "Pripájanie hovoru…", exact: true })).toBeDisabled();
});

test("an operator recovers only their own reserved offer when this window has no invite", async ({ page }) => {
  await page.getByRole("combobox").selectOption("own-offer-recovery");
  await page.getByRole("button", { name: "Prevziať", exact: true }).click();
  await expect(page.getByRole("status", { name: "Akcie" })).toHaveText("pickup:incoming-session");
  await page.getByRole("combobox").selectOption("other-offer-recovery");
  await expect(page.getByRole("button", { name: "Čakám na zvonenie v tomto okne", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Prevziať", exact: true })).toHaveCount(0);
});


for (const width of [360, 390, 768, 1280]) {
  test(`pickup explains missing availability without hover at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("combobox").selectOption("unavailable");
    const reason = page.getByRole("button", { name: "Najprv sa nastav dostupný", exact: true });
    await expect(reason).toBeDisabled();
    await expect(reason.locator("span")).toBeVisible();
    await page.getByRole("button", { name: "Som dostupný", exact: true }).click();
    await expect(page.getByRole("status", { name: "Akcie" })).toHaveText("available");
  });
}
