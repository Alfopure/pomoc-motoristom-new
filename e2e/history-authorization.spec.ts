import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script = "", css = "";
const origin = "https://history-authorization.test";
const call = { id: "00000000-0000-4000-8000-000000000901", status: "ended", direction: "inbound", callerNumber: "+421900000001", callerName: "Súkromný zákazník A", calledNumber: "+421900000002", lineLabel: "Testovacia linka", startedAt: "2026-09-19T08:00:00Z", endedAt: "2026-09-19T08:02:13Z", durationSeconds: 133, waitSeconds: 0, recordingStatus: "not_requested", transcriptStatus: "not_requested", history: [] };
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/callback-unified.tsx"], bundle: true, write: false, outfile: ".context/history-authorization.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  css += (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
async function boot(page: Page, options: { initialStatus?: number; searchAvailable?: boolean } = {}) {
  const state = { status: options.initialStatus ?? 200, rows: [call], reads: 0 };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-09-19T10:00:00Z") });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/telephony/calls/history") { state.reads += 1; return route.fulfill({ status: state.status, json: state.status === 200 ? { searchAvailable: options.searchAvailable ?? true, calls: state.rows, nextCursor: null, filters: { lines: [], operators: [] } } : { error: state.status === 403 ? "Prístup odobratý" : "Dočasne nedostupné" } }); }
    if (url.pathname === "/api/telephony/callbacks") return route.fulfill({ json: { configured: true, checkedAt: new Date().toISOString(), actorProfileId: "operator", actorRole: "dispatcher", openTotal: 0, open: [], resolved: [] } });
    if (url.pathname === "/api/telephony/team") return route.fulfill({ json: { checkedAt: new Date().toISOString(), operators: [] } });
    return route.fulfill({ status: 503, json: { error: "Izolovaný test" } });
  });
  await page.goto(origin); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect.poll(() => state.reads).toBe(1);
  return { state, errors, panel: page.getByTestId("call-center-history") };
}
test("changing filters while offline cannot cancel the existing authorization deadline", async ({ page }) => {
  const { state, panel, errors } = await boot(page);
  await expect(panel.getByText(call.callerName, { exact: true }).filter({ visible: true })).toBeVisible();
  state.status = 503;
  await page.clock.runFor(10_000);
  await panel.getByRole("searchbox").fill("iný zákazník"); await page.clock.runFor(350);
  await expect.poll(() => state.reads).toBeGreaterThan(1);
  await panel.getByRole("button", { name: "Skúsiť znova" }).click();
  await page.clock.runFor(19_700);
  await expect(panel.getByTestId("call-history-row")).toHaveCount(0);
  await expect(panel.getByText(call.callerName, { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("a queued new-data page cannot restore private callers after a 403", async ({ page }) => {
  const { state, panel, errors } = await boot(page);
  await expect(panel.getByTestId("call-history-row")).toHaveCount(1);
  state.rows = [{ ...call, id: "00000000-0000-4000-8000-000000000902", callerName: "Súkromný zákazník B" }, call];
  await page.clock.runFor(25_100);
  await expect(panel.getByRole("button", { name: "Nové zmeny v histórii · zobraziť" })).toBeVisible();
  state.status = 403;
  await page.clock.runFor(25_100);
  await expect(panel.getByTestId("call-history-row")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Nové zmeny v histórii · zobraziť" })).toHaveCount(0);
  await expect(panel.getByText(/Súkromný zákazník/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("initial bootstrap call rows stay hidden until history authorization succeeds", async ({ page }) => {
  const { panel, errors } = await boot(page, { initialStatus: 403 });
  await expect(panel.getByTestId("call-history-row")).toHaveCount(0);
  await expect(panel.getByText("Prístup odobratý", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});
test("schema capability fallback shows authorized recent calls without pretending full search", async ({ page }) => {
  const { panel, errors } = await boot(page, { searchAvailable: false });
  await expect(panel.getByTestId("call-history-row")).toHaveCount(1);
  await expect(panel.getByRole("searchbox")).toBeDisabled();
  await expect(panel.getByText("Vyhľadávanie v celej histórii zatiaľ nie je dostupné. Zobrazené sú posledné hovory.")).toBeVisible();
  await expect(panel.getByLabel("Dĺžka hovoru 2:13")).toBeVisible();
  await expect(panel.getByText("Ukončený", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(errors).toEqual([]);
});
