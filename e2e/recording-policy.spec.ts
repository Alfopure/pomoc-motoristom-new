import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { RecordingPolicyDocument, RecordingPolicyResponse } from "../src/lib/telephony/recording-quality";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const origin = "https://recording-policy.test";
const endpoint = "/api/telephony/config/recording-policy";
const labels = ["Nahrávať hovory", "Vytvárať časový prepis", "AI súhrn a zistené údaje", "Návrh hodnotenia operátora"];
let script: string, css: string;

test.beforeAll(async () => {
  await mkdir(".context/recording-policy-browser", { recursive: true });
  const result = await build({ entryPoints: ["e2e/fixtures/recording-policy.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

function policy(): RecordingPolicyDocument {
  return { revision: 4, recordingEnabled: false, transcriptionEnabled: false, analysisEnabled: false, qualityEnabled: false,
    inboundEnabled: false, outboundEnabled: false, audioRetentionDays: 30, transcriptRetentionDays: 30, reviewRetentionDays: 90,
    maxRecordingsPerHour: 10, maxRecordingBytes: 33554432, maxSegmentSeconds: 1800,
    controllerName: "Testovacia organizácia", contactEmail: "privacy@example.test", privacyNoticeUrl: "https://example.test/privacy",
    serviceLegalBasis: "Účel pre izolovanú skúšku", qualityLegalBasis: "Skúšobná kontrola kvality", approvedAt: "2026-10-07T07:56:39Z" };
}

async function boot(page: Page, options: { ready?: Partial<RecordingPolicyResponse["readiness"]>; enabled?: boolean; canEdit?: boolean; width?: number } = {}) {
  const state = { response: { policy: { ...policy(), ...(options.enabled ? { recordingEnabled: true, transcriptionEnabled: true, analysisEnabled: true, qualityEnabled: true, inboundEnabled: true } : {}) },
    canEdit: options.canEdit ?? true, readiness: { recording: true, transcription: false, analysis: false, reasons: [], ...options.ready } } as RecordingPolicyResponse,
    writes: [] as { policy: RecordingPolicyDocument; approvePolicy: boolean }[], errors: [] as string[], conflict: false };
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 });
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { state.errors.push(`External request: ${url.origin}`); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    if (url.pathname === endpoint && req.method() === "GET") return route.fulfill({ json: state.response });
    if (url.pathname === endpoint && req.method() === "PUT") {
      const body = req.postDataJSON(); state.writes.push(body);
      if (state.conflict) return route.fulfill({ status: 409, json: { code: "stale_recording_policy", error: "Nastavenia medzitým zmenil kolega." } });
      state.response.policy = { ...body.policy, revision: state.response.policy.revision + 1, approvedAt: body.approvePolicy ? "2026-10-11T16:00:00Z" : state.response.policy.approvedAt };
      return route.fulfill({ json: state.response });
    }
    state.errors.push(`Unexpected request: ${req.method()} ${url.pathname}`); return route.abort();
  });
  const mount = async () => {
    await page.goto(origin); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
    await expect(page.getByRole("checkbox", { name: labels[0], exact: true })).toBeVisible();
  };
  await mount(); return { state, mount };
}
const feature = (page: Page, index: number) => page.getByRole("checkbox", { name: labels[index], exact: true });
const saveButton = (page: Page) => page.getByRole("button", { name: "Uložiť nahrávanie a kvalitu", exact: true });
const approval = (page: Page) => page.getByRole("checkbox", { name: /Potvrdzujem správnosť/ });

for (const width of [390, 1440]) test(`saves recording without unavailable processing and persists after reload at ${width}px`, async ({ page }) => {
  const { state, mount } = await boot(page, { width });
  await feature(page, 0).check();
  await expect(page.getByText("Nevybrali ste žiadny smer hovoru.", { exact: false })).toBeVisible();
  await page.getByRole("checkbox", { name: "Prichádzajúce hovory", exact: true }).check();
  await expect(feature(page, 1)).toBeDisabled(); await expect(feature(page, 2)).toBeDisabled(); await expect(feature(page, 3)).toBeDisabled();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByText("Pred uložením začiarknite potvrdenie správnosti nastavení.")).toBeVisible();
  await approval(page).check(); await expect(saveButton(page)).toBeEnabled();
  await saveButton(page).click(); await expect(page.getByText("Nastavenia sú uložené.", { exact: false })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ approvePolicy: true, policy: { recordingEnabled: true, transcriptionEnabled: false, analysisEnabled: false, qualityEnabled: false, inboundEnabled: true, outboundEnabled: false, revision: 4 } });
  await mount(); await expect(feature(page, 0)).toBeChecked(); await expect(feature(page, 1)).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `.context/recording-policy-browser/recording-only-${width}.png`, fullPage: true });
  expect(state.errors).toEqual([]);
});

test("turning off prerequisites disables dependents and remains saveable", async ({ page }) => {
  const { state } = await boot(page, { enabled: true, ready: { transcription: true, analysis: true } });
  await feature(page, 1).uncheck(); await expect(feature(page, 0)).toBeChecked();
  for (const index of [1, 2, 3]) await expect(feature(page, index)).not.toBeChecked();
  await expect(saveButton(page)).toBeEnabled(); await saveButton(page).click();
  await expect(page.getByText("Nastavenia sú uložené.", { exact: false })).toBeVisible();
  expect(state.writes[0]).toMatchObject({ approvePolicy: false, policy: { recordingEnabled: true, transcriptionEnabled: false, analysisEnabled: false, qualityEnabled: false } });
  await feature(page, 0).uncheck(); await saveButton(page).click();
  await expect.poll(() => state.writes.length).toBe(2); expect(state.writes[1].policy.recordingEnabled).toBe(false);
});

test("all processing can be enabled in dependency order when every service is ready", async ({ page }) => {
  const { state } = await boot(page, { ready: { transcription: true, analysis: true } });
  for (const index of [1, 2, 3]) await expect(feature(page, index)).toBeDisabled();
  for (const index of [0, 1, 2, 3]) await feature(page, index).check();
  await page.getByRole("checkbox", { name: "Prichádzajúce hovory", exact: true }).check();
  await approval(page).check(); await saveButton(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ approvePolicy: true, policy: { recordingEnabled: true, transcriptionEnabled: true, analysisEnabled: true, qualityEnabled: true } });
});

test("an already enabled unavailable feature can be switched off with a reason next to save", async ({ page }) => {
  const { state } = await boot(page, { enabled: true });
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.locator("#recording-policy-save-blockers")).toContainText("Služba prepisu ešte nie je");
  await expect(feature(page, 1)).toBeEnabled(); await feature(page, 1).uncheck();
  await expect(saveButton(page)).toBeEnabled(); await saveButton(page).click();
  await expect.poll(() => state.writes.length).toBe(1); expect(state.writes[0].policy.recordingEnabled).toBe(true);
  expect(state.writes[0].policy.transcriptionEnabled).toBe(false);
});

test("readiness refresh preserves edits and never bypasses missing recording capability", async ({ page }) => {
  const { state } = await boot(page, { ready: { recording: false } });
  await expect(feature(page, 0)).toBeDisabled(); await expect(feature(page, 0)).toHaveAccessibleDescription(/nie je.*pripravené/);
  await page.getByLabel("Prevádzkovateľ", { exact: true }).fill("Upravená testovacia organizácia");
  state.response.readiness.recording = true;
  await page.getByRole("button", { name: "Obnoviť dostupnosť", exact: true }).click();
  await expect(feature(page, 0)).toBeEnabled(); await expect(page.getByLabel("Prevádzkovateľ", { exact: true })).toHaveValue("Upravená testovacia organizácia");
  await feature(page, 0).check(); await expect(saveButton(page)).toBeDisabled(); await approval(page).check();
  await saveButton(page).click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ approvePolicy: true, policy: { recordingEnabled: true, controllerName: "Upravená testovacia organizácia" } });
});

test("conflict keeps the draft and requires approval after reloading", async ({ page }) => {
  const { state } = await boot(page); await feature(page, 0).check(); await approval(page).check(); state.conflict = true;
  await saveButton(page).click(); await expect(page.getByText("Nastavenia medzitým zmenil kolega.", { exact: true })).toBeVisible();
  await expect(feature(page, 0)).toBeChecked(); await expect(saveButton(page)).toBeDisabled();
  state.response.policy.revision = 5; state.conflict = false;
  await page.getByRole("button", { name: "Načítať verziu a zachovať úpravy" }).click();
  await expect(approval(page)).not.toBeChecked(); await expect(feature(page, 0)).toBeChecked();
  await approval(page).check(); await saveButton(page).click(); await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({ approvePolicy: true, policy: { recordingEnabled: true, revision: 5 } });
});

test("read-only access cannot enable or save recording", async ({ page }) => {
  const { state } = await boot(page, { canEdit: false });
  for (const index of [0, 1, 2, 3]) await expect(feature(page, index)).toBeDisabled();
  await expect(saveButton(page)).toBeDisabled(); expect(state.writes).toEqual([]);
});
