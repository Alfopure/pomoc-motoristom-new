import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { defaultAnnouncementConfig } from "../src/lib/telephony/announcements";
import type { AnnouncementLine } from "../src/components/dispatch/settings/announcements-client";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://announcements.test";
const endpoint = "/api/telephony/config/announcements";
let script: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(".context/recording-status-browser", { recursive: true });
  const result = await build({ entryPoints: ["e2e/fixtures/recording-announcements.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

async function boot(page: Page, { width = 1440, canEdit = true, conflict = false } = {}) {
  const legacy = defaultAnnouncementConfig();
  delete legacy.recordingStatusAnnouncements;
  const state = {
    lines: [
      { id: "00000000-0000-4000-8000-000000000201", label: "Hlavná linka", phoneNumber: "+421900000111", revision: "2026-09-07T12:00:00.000Z", config: legacy },
      { id: "00000000-0000-4000-8000-000000000202", label: "Druhá linka", phoneNumber: "+421900000222", revision: "2026-09-07T12:00:00.000Z", config: { ...defaultAnnouncementConfig(), recordingStatusAnnouncements: true } },
    ] as AnnouncementLine[],
    writes: [] as { lineId: string; config: AnnouncementLine["config"] }[],
    errors: [] as string[], conflict,
  };
  await page.setViewportSize({ width, height: 950 });
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", async route => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== origin) { state.errors.push(`External request blocked: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/" && req.method() === "GET") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (url.pathname === endpoint && req.method() === "GET") return route.fulfill({ json: { lines: state.lines, canEdit, generationAvailable: true } });
    if (url.pathname === endpoint && req.method() === "PUT") {
      const body = req.postDataJSON(); state.writes.push(body);
      const line = state.lines.find(item => item.id === body.lineId);
      if (!canEdit) return route.fulfill({ status: 403, json: { error: "Nemáte oprávnenie." } });
      if (!line || state.conflict || line.revision !== body.revision) return route.fulfill({ status: 409, json: { error: "Linku medzitým upravil kolega.", code: "stale_document" } });
      line.config = body.config; line.revision = new Date(Date.parse(line.revision) + 1000).toISOString();
      return route.fulfill({ json: line });
    }
    if (url.pathname === `${endpoint}/generate` && req.method() === "POST") {
      const body = req.postDataJSON();
      await new Promise(resolve => setTimeout(resolve, 150));
      return route.fulfill({ json: { text: body.text, language: body.language, voiceId: body.voiceId, audioUrl: `${origin}/generated.mp3` } });
    }
    if (req.method() === "GET") return route.fulfill({ status: 404, body: "" });
    state.errors.push(`Unexpected write: ${req.method()} ${url.pathname}`); return route.abort();
  });
  const mount = async () => {
    await page.goto(origin); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
    await page.getByRole("group", { name: "Kategórie hlášok" }).getByRole("button", { name: /^Nahrávanie/ }).click();
    await expect(page.getByRole("switch", { name: "Hlášky o zmenách nahrávania" })).toBeVisible();
  };
  await mount();
  return { state, mount };
}

for (const width of [390, 1440]) test(`recording status preference saves and reloads per line across languages at ${width}px`, async ({ page }) => {
  const { state, mount } = await boot(page, { width });
  const toggle = page.getByRole("switch", { name: "Hlášky o zmenách nahrávania" });
  const save = page.getByRole("button", { name: "Uložiť hlášky a jazyk" });
  await expect(toggle).not.toBeChecked(); await expect(save).toBeDisabled();
  const offCard = page.locator("article").filter({ has: page.getByLabel("Potvrdenie vypnutia nahrávania", { exact: true }) });
  const initialCard = page.locator("article").filter({ has: page.getByLabel("Nahrávanie a kontrola kvality", { exact: true }) });
  await expect(offCard.getByText("Vypnuté v hovoroch", { exact: true })).toBeVisible();
  await expect(initialCard.getByText("Používa sa v hovoroch", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/recording-status-browser/settings-${width}.png`, fullPage: true });
  await toggle.evaluate(element => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: `.context/recording-status-browser/toggle-${width}.png` });
  await toggle.check(); await expect(save).toBeEnabled();
  await page.getByRole("combobox", { name: /^Jazyk hovoru/ }).selectOption("en");
  await expect(toggle).toBeChecked(); await save.click(); await expect(save).toBeDisabled();
  expect(state.writes[0].config.recordingStatusAnnouncements).toBe(true);
  await mount(); await expect(toggle).toBeChecked();
  await toggle.uncheck(); await save.click(); await expect(save).toBeDisabled();
  await mount(); await expect(toggle).not.toBeChecked();
  await page.getByRole("combobox", { name: /^Telefónna linka/ }).selectOption(state.lines[1].id);
  await expect(toggle).toBeChecked();
  expect(state.lines[0].config.recordingStatusAnnouncements).toBe(false);
  expect(state.lines[1].config.recordingStatusAnnouncements).toBe(true);
  expect(state.errors).toEqual([]);
});

test("read-only viewers can inspect status without changing preferences", async ({ page }) => {
  const { state } = await boot(page, { canEdit: false, width: 390 });
  await expect(page.getByRole("switch", { name: "Hlášky o zmenách nahrávania" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Uložiť hlášky a jazyk" })).toBeDisabled();
  expect(state.writes).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("generation and stale saves retain a disabled preference and its draft", async ({ page }) => {
  const { state } = await boot(page, { conflict: true });
  const toggle = page.getByRole("switch", { name: "Hlášky o zmenách nahrávania" });
  const card = page.locator("article").filter({ has: page.getByLabel("Potvrdenie vypnutia nahrávania", { exact: true }) });
  await card.getByRole("button", { name: "Pregenerovať nahrávku" }).click();
  await expect(page.getByText("Nahrávka je pripravená na vypočutie a uloženie. Hláška zostáva v hovoroch vypnutá.", { exact: true })).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const save = page.getByRole("button", { name: "Uložiť hlášky a jazyk" });
  await save.click(); await expect(page.getByText("Linku medzitým upravil kolega.", { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked(); await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Načítať aktuálnu verziu linky" }).click();
  await expect(save).toBeEnabled(); await expect(toggle).toBeChecked();
  state.conflict = false; await save.click(); await expect(save).toBeDisabled();
  expect(state.lines[0].config.recordingStatusAnnouncements).toBe(true);
  expect(state.errors).toEqual([]);
});
